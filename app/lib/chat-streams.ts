import type { api } from "./api.ts";
import type { ChatContextRef, ChatMessageRecord, ChatSessionRecord, ChatStreamEvent } from "./types.ts";
import type { TraceEntry } from "../components/agent-chat/AgentPrimitives.tsx";

type Transport = Pick<typeof api, "streamCodexChatMessage" | "abortCodexChatSession">;

export interface TurnTrace {
  startedAt: number;
  durationMs?: number;
  entries: TraceEntry[];
}

interface Turn {
  session: ChatSessionRecord;
  user: ChatMessageRecord;
  assistant: ChatMessageRecord;
  trace: TurnTrace;
  statusLine: string;
  running: boolean;
}

export function messagesWithTurn(history: ChatMessageRecord[], turn?: Turn) {
  if (!turn) return history;
  return [...history.filter(m => m.id !== turn.user.id && m.id !== turn.assistant.id), turn.user, turn.assistant];
}

// One instance per project in the console. Views subscribe without owning the fetch.
export class ProjectChatStreams {
  private selectedId: string | null | undefined;
  private turns = new Map<string, Turn>();
  private controllers = new Map<string, AbortController>();
  private stopping = new Map<string, Promise<unknown>>();
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

  // A history response may only retire the exact finished turn it was requested for.
  retire(id: string, expected?: Turn) {
    if (expected && !expected.running && this.turns.get(id) === expected) this.publish(id);
  }

  async send(session: ChatSessionRecord, content: string, attachments: ChatContextRef[]) {
    const id = session.id;
    if (this.controllers.has(id)) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const startedAt = Date.now();
    const base = { session_id: id, created_at: new Date(startedAt).toISOString(), events: [], attachments: [] };
    let turn: Turn = {
      session, running: true, statusLine: "正在连接项目空间与 CLI",
      user: { ...base, id: `tmp-u-${startedAt}`, role: "user", content, attachments, status: "done" },
      assistant: { ...base, id: `tmp-a-${startedAt}`, role: "assistant", content: "", status: "streaming" },
      trace: { startedAt, entries: [] },
    };
    const update = (patch: Partial<Turn>) => {
      turn = { ...turn, ...patch };
      this.publish(id, turn);
    };
    this.publish(id, turn);
    let error = "";
    const onEvent = (ev: ChatStreamEvent) => {
      const { assistant, trace } = turn;
      switch (ev.type) {
        case "session":
          update({ session: ev.session, user: ev.user_message, assistant: { ...assistant, id: ev.assistant_message_id } });
          break;
        case "session_updated": update({ session: ev.session }); break;
        case "task_updated":
          this.taskUpdatedHandler?.({ task_id: ev.task_id, action: ev.action });
          break;
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
        case "done": update({ assistant: ev.message, session: ev.session }); break;
        case "error":
          error = ev.error;
          update({ assistant: ev.message ?? { ...assistant, status: "error", content: assistant.content || `执行失败：${error}` } });
          break;
      }
    };
    try {
      await this.transport.streamCodexChatMessage(session.project_id, id, { content, attachments }, onEvent, controller.signal);
      if (turn.assistant.status === "streaming" && !controller.signal.aborted) error = "回复连接已中断";
    } catch (err) {
      if (!controller.signal.aborted) error = err instanceof Error ? err.message : "发送失败";
    } finally {
      // Keep the session locked until an explicit abort request can no longer affect its next turn.
      await this.stopping.get(id);
      this.controllers.delete(id);
      this.stopping.delete(id);
      let assistant = turn.assistant;
      if (assistant.status === "streaming") {
        assistant = { ...assistant, status: controller.signal.aborted ? "aborted" : "error", content: assistant.content || error };
      }
      update({
        running: false,
        assistant,
        statusLine: "",
        session: {
          ...turn.session,
          status: assistant.status === "error" ? "error" : "idle",
          last_message_preview: assistant.content.slice(0, 120),
        },
        trace: { ...turn.trace, durationMs: Date.now() - startedAt },
      });
    }
    if (error) throw new Error(error);
  }

  abort(id: string) {
    const controller = this.controllers.get(id);
    const turn = this.turns.get(id);
    if (!controller || !turn || controller.signal.aborted) return;
    this.stopping.set(id, this.transport.abortCodexChatSession(turn.session.project_id, id).catch(() => undefined));
    controller.abort();
  }
}
