import type { api } from "./api.ts";
import type { ChatContextRef, ChatMessageRecord, ChatSessionRecord, ChatStreamEvent } from "./types.ts";
import type { TraceEntry } from "../components/agent-chat/AgentPrimitives.tsx";

type Transport = Pick<typeof api, "streamCodexChatMessage" | "abortCodexChatSession" | "getCodexChatSession">;
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
}

interface Run {
  turn: Turn;
  registered: boolean;
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
  const ids = new Set(overlay.map(m => m.id));
  return [...history.filter(m => !ids.has(m.id)), ...overlay];
}

// One instance per project in the console. Views subscribe without owning the fetch.
export class ProjectChatStreams {
  private selectedId: string | null | undefined;
  private turns = new Map<string, Turn>();
  private runs = new Map<string, Run>();
  private listeners = new Set<() => void>();
  private taskUpdatedHandler?: (ev: { task_id?: string; action: string }) => void;

  constructor(private readonly transport: Transport) {}

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
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(id: string, turn?: Turn) {
    this.turns = new Map(this.turns);
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

  takeUnsent(id: string) {
    const turn = this.turns.get(id);
    if (turn?.running || !turn?.pending) return;
    this.publish(id, { ...turn, pending: undefined });
    return turn.pending;
  }

  // The caller supplies the run it saw. A stale click must never interrupt its successor.
  send(session: ChatSessionRecord, content: string, attachments: ChatContextRef[], expectedRunId?: string): Promise<void> | null {
    const run = this.runs.get(session.id);
    if (!run) {
      const last = this.turns.get(session.id);
      if (last?.pending || (session.status === "running" && !last) || (last && expectedRunId && last.runId !== expectedRunId)) return null;
      return this.start(session, userMessage(session.id, content, attachments), last ? this.completed(last) : []);
    }
    if (expectedRunId !== run.turn.runId || run.turn.stopping) return null;
    const completion = new Promise<void>((resolve, reject) => { run.queued = { resolve, reject }; });
    this.update(run, { pending: userMessage(session.id, content, attachments), stopping: "follow_up" });
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
    const turn = { ...run.turn, assistant, session, running: false, stopping: undefined, statusLine: "",
      trace: { ...run.turn.trace, durationMs: Date.now() - run.turn.trace.startedAt } };
    this.runs.delete(session.id);
    run.retryStop?.();
    if (saved && turn.pending && run.queued) {
      // Consume before publishing the successor, independent of abort ACK, EOF or React mounting.
      void this.start(session, turn.pending, this.completed(turn)).then(run.queued.resolve, run.queued.reject);
    } else {
      this.publish(session.id, turn);
      run.queued?.reject(new Error("未能确认上一轮已保存，追问未发送"));
    }
  }

  // Adopt a run from GET only when the user interacts with it. No session-wide abort fallback.
  observe(session: ChatSessionRecord, history: ChatMessageRecord[]) {
    if (!session.active_run_id || session.status !== "running" || this.turns.has(session.id)) return;
    const assistant = history.at(-1), user = history.at(-2);
    if (assistant?.role !== "assistant" || assistant.status !== "streaming" || user?.role !== "user") return;
    const run: Run = { registered: true, turn: { runId: session.active_run_id, session, user, assistant, previous: [],
      running: true, statusLine: "正在等待回复完成", trace: { startedAt: Date.parse(assistant.created_at), entries: [] } } };
    this.runs.set(session.id, run);
    this.publish(session.id, run.turn);
    void this.waitForHistory(run);
  }

  private async waitForHistory(run: Run) {
    const { session, assistant } = run.turn;
    try {
      while (this.current(run)) {
        const res = await this.transport.getCodexChatSession(session.project_id, session.id);
        const saved = res.messages.find(m => m.id === assistant.id && m.status !== "streaming");
        if (saved && res.session.status !== "running") {
          this.finish(run, saved, res.session, true);
          return true;
        }
        if (res.session.active_run_id !== run.turn.runId) throw new Error("会话状态已变化，请重新打开对话");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      this.fail(run, err instanceof Error ? err.message : "读取回复状态失败");
    }
  }

  private fail(run: Run, error: string) {
    const { assistant, session } = run.turn;
    this.finish(run, { ...assistant, status: "error", content: assistant.content || error }, { ...session, status: "error" }, false);
  }

  private async start(session: ChatSessionRecord, user: ChatMessageRecord, previous: MessagePair[]) {
    const runId = newRunId();
    const startedAt = Date.now();
    const run: Run = { registered: false, turn: {
      session, runId, previous, running: true, statusLine: "正在连接项目空间与 CLI", user,
      assistant: { ...user, id: `tmp-a-${runId}`, role: "assistant", content: "", attachments: [], status: "streaming" },
      trace: { startedAt, entries: [] },
    } };
    this.runs.set(session.id, run);
    this.publish(session.id, run.turn);
    let error = "";
    const onEvent = (ev: ChatStreamEvent) => {
      if (!this.current(run)) return;
      const { assistant, trace } = run.turn;
      const update = (patch: Partial<Turn>) => this.update(run, patch);
      switch (ev.type) {
        case "session": {
          run.registered = true;
          update({ session: ev.session, user: ev.user_message, assistant: { ...assistant, id: ev.assistant_message_id } });
          run.retryStop?.();
          run.retryStop = undefined;
          break;
        }
        case "session_updated": update({ session: ev.session }); break;
        case "task_updated": this.taskUpdatedHandler?.({ task_id: ev.task_id, action: ev.action }); break;
        case "reasoning":
        case "status": {
          const kind = ev.type;
          const text = ev.type === "status" ? ev.message.trim() : ev.text;
          if (!text) break;
          const entries = [...trace.entries];
          const last = entries.at(-1);
          if (kind === "reasoning" && last?.kind === kind) entries[entries.length - 1] = { ...last, text: last.text + text };
          else if (kind !== "status" || last?.kind !== kind || last.text !== text) {
            entries.push({ id: `tr-${startedAt}-${entries.length}`, kind, text: text.trimStart() });
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
          error = ev.error;
          if (ev.message && ev.message.id === assistant.id && ev.message.status !== "streaming") {
            this.finish(run, ev.message, { ...run.turn.session, status: "error" }, true);
          } else this.fail(run, error);
          break;
      }
    };
    try {
      await this.transport.streamCodexChatMessage(session.project_id, session.id,
        { run_id: runId, content: user.content, attachments: user.attachments }, onEvent);
      if (this.current(run)) throw new Error("回复连接已中断");
    } catch (err) {
      if (this.current(run)) {
        error = err instanceof Error ? err.message : "发送失败";
        if (run.registered && run.turn.stopping) {
          // A disconnected reader is not a save barrier. Reconcile the exact assistant via GET.
          if (await this.waitForHistory(run)) error = "";
        } else this.fail(run, error);
      }
    }
    if (error) throw new Error(error);
  }
}
