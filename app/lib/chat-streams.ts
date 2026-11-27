import { ClientApiError, type api } from "./api.ts";
import type { ChatContextRef, ChatMessageRecord, ChatSessionRecord, ChatStreamEvent } from "./types.ts";
import type { TraceEntry } from "../components/agent-chat/AgentPrimitives.tsx";

type Transport = Pick<typeof api, "streamCodexChatMessage" | "abortCodexChatSession" | "getCodexChatSession">
  & Partial<Pick<typeof api, "subscribeCodexChatStream">>;
type StopRequest = "user_stop" | "follow_up";

export interface TurnTrace {
  startedAt: number;
  durationMs?: number;
  entries: TraceEntry[];
}

interface MessagePair {
  user: ChatMessageRecord;
  assistant: ChatMessageRecord;
  trace: TurnTrace;
}

interface Turn extends MessagePair {
  runId: string;
  session: ChatSessionRecord;
  previous: MessagePair[];
  pending?: ChatMessageRecord;
  stopping?: StopRequest;
  stopFailed?: boolean;
  statusLine: string;
  running: boolean;
  submitting?: boolean;
  saved?: boolean;
}

interface Run {
  turn: Turn;
  registered: boolean;
  onAccepted?: () => void;
  awaitingPair?: boolean;
  error?: string;
  retryStop?: () => void;
  queued?: { resolve: () => void; reject: (err: Error) => void };
}

function newRunId() {
  return crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
}

function userMessage(id: string, content: string, attachments: ChatContextRef[]): ChatMessageRecord {
  return { id: `tmp-u-${newRunId()}`, session_id: id, role: "user", content, attachments: [...attachments],
    status: "done", events: [], created_at: new Date().toISOString() };
}

export function messagesWithTurn(history: ChatMessageRecord[], turn?: Turn) {
  if (!turn) return history;
  const overlay = [...turn.previous, turn].flatMap(pair => [pair.user, pair.assistant]);
  if (turn.pending) overlay.push(turn.pending);
  const pending = new Map(overlay.map(message => [message.id, message]));
  const merged = history.map(message => {
    const replacement = pending.get(message.id);
    pending.delete(message.id);
    return replacement ?? message;
  });
  return [...merged, ...pending.values()];
}

// One instance per project in the console. Views subscribe without owning the fetch.
export class ProjectChatStreams {
  private selectedId: string | null | undefined;
  private turns = new Map<string, Turn>();
  private chatTurns = new Map<string, Turn>();
  private resumeAfterDraft = new Map<string, Awaited<ReturnType<Transport["getCodexChatSession"]>>>();
  private runs = new Map<string, Run>();
  private listeners = new Set<() => void>();
  private taskUpdatedHandler?: (ev: { task_id?: string; action: string }) => void;

  private activityListeners = new Map<string, Set<() => void>>();

  constructor(private readonly transport: Transport) {}

  subscribeTaskActivity(taskId: string, listener: () => void) {
    const listeners = this.activityListeners.get(taskId) ?? new Set();
    this.activityListeners.set(taskId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.activityListeners.delete(taskId);
    };
  }

  private taskActivity(task_id: string | undefined, action: string) {
    const listeners = task_id && this.activityListeners.get(task_id);
    if (listeners && listeners.size) {
      for (const listener of listeners) listener();
    } else this.taskUpdatedHandler?.({ task_id, action });
  }

  setTaskUpdatedHandler(handler?: (ev: { task_id?: string; action: string }) => void) {
    this.taskUpdatedHandler = handler;
  }

  selection = () => this.selectedId;
  select = (id: string | null) => {
    if (id === this.selectedId) return;
    this.selectedId = id;
    for (const listener of this.listeners) listener();
  };
  snapshot = () => this.turns;
  chatSnapshot = () => this.chatTurns;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(id: string, turn?: Turn) {
    this.turns = new Map(this.turns);
    if (turn ? turn.session.kind !== "task" : this.chatTurns.has(id)) {
      this.chatTurns = new Map(this.chatTurns);
      if (turn) this.chatTurns.set(id, turn);
      else this.chatTurns.delete(id);
    }
    if (turn) this.turns.set(id, turn);
    else this.turns.delete(id);
    for (const listener of this.listeners) listener();
  }

  private current(run: Run) { return this.runs.get(run.turn.session.id) === run; }
  private update(run: Run, patch: Partial<Turn>) {
    if (!this.current(run)) return;
    run.turn = { ...run.turn, ...patch };
    this.publish(run.turn.session.id, run.turn);
  }

  retire(id: string, expected?: Turn) {
    if (expected && !expected.running && this.turns.get(id) === expected) this.publish(id);
  }

  syncSession(session: ChatSessionRecord) {
    const turn = this.turns.get(session.id);
    if (!turn || turn.running || turn.session === session) return;
    this.publish(session.id, { ...turn, session });
  }

  takeUnsent(id: string) {
    const turn = this.turns.get(id);
    if (turn?.running || !turn?.pending) return;
    this.publish(id, { ...turn, pending: undefined });
    const latest = this.resumeAfterDraft.get(id);
    if (latest) {
      this.resumeAfterDraft.delete(id);
      this.observe(latest.session, latest.messages);
    }
    return turn.pending;
  }

  // The caller supplies the run it saw. A stale click must never interrupt its successor.
  send(session: ChatSessionRecord, content: string, attachments: ChatContextRef[], expectedRunId?: string, onAccepted?: () => void): Promise<void> | null {
    const run = this.runs.get(session.id);
    if (!run) {
      const last = this.turns.get(session.id);
      if (last?.pending || (session.status === "running" && !last) || (last && expectedRunId && last.runId !== expectedRunId)) return null;
      return this.start(session, userMessage(session.id, content, attachments), last, onAccepted);
    }
    if (expectedRunId !== run.turn.runId || run.turn.stopping) return null;
    const completion = new Promise<void>((resolve, reject) => { run.queued = { resolve, reject }; });
    this.update(run, { pending: userMessage(session.id, content, attachments), stopping: "follow_up" });
    onAccepted?.();
    void this.requestStop(run, "follow_up").catch(() => {
      // Even if the stop POST fails, natural completion can still release the follow-up.
      this.update(run, { stopFailed: true });
    });
    return completion;
  }

  abort(id: string, expectedRunId: string) {
    const run = this.runs.get(id);
    if (!run || run.turn.runId !== expectedRunId || run.turn.stopping) return;
    this.update(run, { stopping: "user_stop" });
    return this.requestStop(run, "user_stop").catch(err => {
      if (!this.current(run)) return;
      this.update(run, { stopping: undefined });
      throw err;
    });
  }

  private async requestStop(run: Run, reason: StopRequest) {
    const { session, runId } = run.turn;
    const post = () => this.transport.abortCodexChatSession(session.project_id, session.id, runId, reason);
    const early = !run.registered;
    const { aborted } = await post();
    if (!early || aborted || !this.current(run)) return;
    // The stop may have overtaken the messages POST. Retry once, after registration.
    if (run.registered) await post();
    else await new Promise<void>((resolve, reject) => {
      run.retryStop = () => { if (this.current(run)) void post().then(() => resolve(), reject); else resolve(); };
    });
  }

  private completed(turn: Turn): MessagePair[] {
    const { user, assistant, trace } = turn;
    return [...turn.previous, { user, assistant, trace }];
  }

  private finish(run: Run, assistant: ChatMessageRecord, session: ChatSessionRecord, saved: boolean) {
    if (!this.current(run)) return;
    const turn = { ...run.turn, assistant, session, running: false, submitting: false, saved, stopping: undefined, statusLine: "",
      trace: { ...run.turn.trace, durationMs: Date.now() - run.turn.trace.startedAt } };
    this.runs.delete(session.id);
    run.retryStop?.();
    if (saved && assistant.status !== "error" && turn.pending && run.queued) {
      // Consume before publishing the successor, independent of abort ACK, EOF or React mounting.
      void this.start(session, turn.pending, turn).then(run.queued.resolve, run.queued.reject);
    } else {
      this.publish(session.id, turn);
      run.queued?.reject(new Error(saved ? "上一轮执行失败，追问未发送" : "未能确认上一轮已保存，追问未发送"));
    }
    if (session.task_id) this.taskActivity(session.task_id, "turn_finished");
  }

  observe(session: ChatSessionRecord, history: ChatMessageRecord[]) {
    const runId = session.active_run_id;
    const last = this.turns.get(session.id);
    if (!runId || session.status !== "running") return;
    const assistant = history.at(-1), user = history.at(-2);
    const hasPair = assistant?.role === "assistant" && assistant.status === "streaming" && user?.role === "user";
    const active = this.runs.get(session.id);
    if (active?.awaitingPair && active.turn.runId === runId && hasPair) {
      // A task history GET can arrive after dispatch but before the first stream frame.
      active.awaitingPair = false;
      this.update(active, { user, assistant });
    }
    if (active || (last?.runId === runId && last.saved) || last?.pending || (!hasPair && !this.transport.subscribeCodexChatStream)) return;
    // Dispatch returns the run ID before the client has received either message.
    const initialUser = hasPair ? user : userMessage(session.id, "", []);
    const initialAssistant: ChatMessageRecord = hasPair ? assistant : {
      ...initialUser, id: `tmp-a-${runId}`, role: "assistant", status: "streaming",
    };
    const run: Run = { registered: true, awaitingPair: !hasPair, turn: {
      runId, session, user: initialUser, assistant: initialAssistant, previous: [],
      running: true, statusLine: "正在连接执行会话", trace: { startedAt: Date.parse(initialAssistant.created_at) || Date.now(), entries: [] },
    } };
    this.runs.set(session.id, run);
    this.publish(session.id, run.turn);
    void this.follow(run);
  }

  private async subscribeRun(run: Run) {
    const { session } = run.turn;
    if (this.transport.subscribeCodexChatStream) {
      const controller = new AbortController();
      try {
        await this.transport.subscribeCodexChatStream(session.project_id, session.id, ev => {
          if (controller.signal.aborted || !this.current(run)) return;
          if (ev.type === "snapshot" && ev.run_id !== run.turn.runId) {
            // Another client started a successor between the history GET and subscription.
            controller.abort();
            return;
          }
          this.onEvent(run, ev);
        }, controller.signal);
      } catch {
        // Reconcile even if the connection closed before the snapshot arrived.
      }
    }
  }

  private async follow(run: Run) {
    if (this.transport.subscribeCodexChatStream) await this.subscribeRun(run);
    if (this.current(run)) await this.waitForHistory(run);
  }

  private async waitForHistory(run: Run) {
    const { session } = run.turn;
    let retryMs = 500;
    try {
      while (this.current(run)) {
        let res: Awaited<ReturnType<Transport["getCodexChatSession"]>>;
        try {
          res = await this.transport.getCodexChatSession(session.project_id, session.id);
        } catch (err) {
          // A missing network response is not evidence that the CLI stopped. Only retry reads.
          if (!(err instanceof TypeError || (err instanceof ClientApiError && err.status >= 500))) throw err;
          this.update(run, { statusLine: "连接暂时中断，正在重新获取本轮进度…" });
          await new Promise(resolve => setTimeout(resolve, retryMs));
          retryMs = Math.min(10_000, retryMs * 2);
          continue;
        }
        retryMs = 500;
        if (!this.current(run)) return;
        const candidate = res.messages.at(-1), user = res.messages.at(-2);
        const knownPair = !run.awaitingPair;
        if (run.awaitingPair && candidate?.role === "assistant" && user?.role === "user" &&
            (res.session.active_run_id === run.turn.runId || res.session.status !== "running")) {
          run.awaitingPair = false;
          this.update(run, { user, assistant: candidate });
        }
        const saved = res.messages.find(m => m.id === run.turn.assistant.id && m.status !== "streaming");
        if (saved && res.session.status !== "running") {
          // The history tail is enough to display, but not proof that an unknown/older turn
          // owns a pending follow-up. Preserve the draft rather than steering its successor.
          const safeToContinue = !run.queued || (knownPair && candidate?.id === saved.id);
          if (saved.status === "error") run.error = saved.error_reason || "本轮执行失败";
          this.finish(run, saved, res.session, safeToContinue);
          return true;
        }
        if (res.session.active_run_id !== run.turn.runId) {
          // Never release a queued follow-up into a different active run.
          if (run.turn.pending) this.resumeAfterDraft.set(session.id, res);
          this.fail(run, "执行轮次已变化，插话尚未发送");
          if (!run.turn.pending) this.observe(res.session, res.messages);
          return;
        }
        await this.subscribeRun(run);
        if (this.current(run)) await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      this.fail(run, err instanceof Error ? err.message : "读取回复状态失败");
    }
  }

  private fail(run: Run, error: string) {
    run.error = error;
    const { assistant, session } = run.turn;
    this.finish(run, { ...assistant, status: "error", error_reason: error }, { ...session, status: "error" }, false);
  }

  private onEvent(run: Run, ev: ChatStreamEvent) {
    if (!this.current(run)) return;
    const { assistant, trace, session } = run.turn;
    const update = (patch: Partial<Turn>) => this.update(run, patch);
    switch (ev.type) {
      case "snapshot": {
        if (ev.run_id !== run.turn.runId || ev.session.id !== session.id) return;
        run.awaitingPair = false;
        const entries: TraceEntry[] = [];
        if (ev.reasoning.trim()) entries.push({ id: `reason-${ev.run_id}`, kind: "reasoning", text: ev.reasoning });
        for (const tool of ev.assistant_message.events) {
          entries.push({ id: `tool-${tool.id}`, kind: "tool", text: tool.summary || tool.tool });
        }
        update({ session: ev.session, user: ev.user_message, assistant: ev.assistant_message,
          statusLine: ev.status_line, trace: { startedAt: ev.started_at, entries } });
        break;
      }
      case "session": {
        run.registered = true;
        run.onAccepted?.();
        run.onAccepted = undefined;
        update({ submitting: false, session: ev.session, user: ev.user_message, assistant: { ...assistant, id: ev.assistant_message_id, runtime: ev.session.runtime } });
        run.retryStop?.();
        run.retryStop = undefined;
        break;
      }
      case "context_usage": update({ session: { ...session, context_used_tokens: ev.usage.used_tokens, context_window_tokens: ev.usage.window_tokens ?? null } }); break;
      case "session_updated": update({ session: ev.session }); break;
      case "task_updated": this.taskActivity(ev.task_id ?? session.task_id ?? undefined, ev.action); break;
      case "reasoning":
      case "status": {
        const kind = ev.type;
        const text = ev.type === "status" ? ev.message.trim() : ev.text;
        if (!text) break;
        const entries = [...trace.entries];
        const last = entries.at(-1);
        if (kind === "reasoning" && last?.kind === kind) entries[entries.length - 1] = { ...last, text: last.text + text };
        else if (kind !== "status" || last?.kind !== kind || last.text !== text) {
          entries.push({ id: `tr-${trace.startedAt}-${entries.length}`, kind, text: text.trimStart() });
        }
        update({ statusLine: kind === "status" ? text : "正在深度推理", trace: { ...trace, entries } });
        break;
      }
      case "tool": {
        const events = assistant.events.some(e => e.id === ev.event.id)
          ? assistant.events.map(e => e.id === ev.event.id ? ev.event : e) : [...assistant.events, ev.event];
        update({ statusLine: `执行工具 · ${ev.event.tool}`, assistant: { ...assistant, events } });
        break;
      }
      case "text_delta": update({ statusLine: "正在生成回复", assistant: { ...assistant, content: assistant.content + ev.delta } }); break;
      case "text_replace": update({ assistant: { ...assistant, content: ev.text } }); break;
      case "done":
        if (ev.session.id === session.id && ev.message.session_id === session.id && ev.message.status !== "streaming" &&
            (!run.registered || ev.message.id === assistant.id)) this.finish(run, ev.message, ev.session, true);
        break;
      case "error":
        run.error = ev.error;
        if (ev.message && ev.message.id === assistant.id && ev.message.status !== "streaming") {
          this.finish(run, { ...ev.message, error_reason: ev.message.error_reason || ev.error }, { ...run.turn.session, status: "error" }, true);
        } else this.fail(run, ev.error);
        break;
    }
  }

  private async start(session: ChatSessionRecord, user: ChatMessageRecord, prior?: Turn, onAccepted?: () => void) {
    const runId = newRunId();
    const startedAt = Date.now();
    const run: Run = { registered: false, onAccepted, turn: {
      session, runId, previous: prior ? this.completed(prior) : [], running: true, submitting: true, statusLine: "正在连接项目空间与 CLI", user,
      assistant: { ...user, id: `tmp-a-${runId}`, role: "assistant", content: "", attachments: [], status: "streaming" },
      trace: { startedAt, entries: [] },
    } };
    this.runs.set(session.id, run);
    this.publish(session.id, run.turn);
    try {
      await this.transport.streamCodexChatMessage(session.project_id, session.id,
        { run_id: runId, content: user.content, attachments: user.attachments }, ev => this.onEvent(run, ev));
      if (this.current(run)) throw new Error("回复连接已中断");
    } catch (err) {
      if (this.current(run)) {
        // A rejected POST never created a turn. Restore the prior transcript (and any queued draft).
        if (!run.registered && err instanceof ClientApiError && err.status >= 400 && err.status < 500) {
          this.runs.delete(session.id);
          this.publish(session.id, prior);
          run.retryStop?.();
          run.queued?.reject(err);
          throw err;
        }
        if (run.registered) {
          this.update(run, { statusLine: "回复连接中断，正在重新连接本轮执行…" });
          await this.waitForHistory(run);
        } else {
          run.error = err instanceof Error ? err.message : "发送失败";
          this.fail(run, run.error);
        }
      }
    }
    if (run.error) throw new Error(run.error);
  }
}
