import type { ChatStreamEvent } from "../../app/lib/types.ts";
import type { RunChatTurnResult } from "../../server/codex-chat.ts";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export type ChatRpc = (type: "workspace.fetch" | "workspace.push" | "task.rpc" | "delegate.rpc", payload: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>;
interface Transport {
  open(): boolean;
  emit(event: unknown, result?: RunChatTurnResult): void;
  rpc: ChatRpc;
}

// Holds one CLI execution, never a prompt or a queue of operations to retry.
// Streaming text is a bounded snapshot. The terminal result contains the canonical tool history.
export class ChatLink {
  private transport?: Transport;
  private timer?: NodeJS.Timeout;
  private terminal?: RunChatTurnResult;
  private settled = false;
  private readonly receipt = latch();
  private available = latch();
  private text = "";
  private subagents = new Map<string, Extract<ChatStreamEvent, { type: "tool" }>>();
  private thread?: string;
  private usage?: Extract<ChatStreamEvent, { type: "context_usage" }>;
  private readonly graceMs: number;
  private readonly abort: AbortController;
  constructor(transport: Transport, graceMs: number, abort: AbortController) {
    this.graceMs = graceMs;
    this.abort = abort;
    this.transport = transport;
  }
  event(event: ChatStreamEvent) {
    if (this.settled) return;
    if (event.type === "context_usage") this.usage = event;
    if (event.type === "tool" && event.event.subagent && (this.subagents.has(event.event.id) || this.subagents.size < 1000)) {
      this.subagents.set(event.event.id, event);
    }
    if (event.type === "text_delta") this.text = (this.text + event.delta).slice(0, 120_000);
    if (event.type === "text_replace") this.text = event.text.slice(0, 120_000);
    if (event.type === "status" && event.external_session_id !== undefined) this.thread = event.external_session_id;
    if (this.transport?.open()) this.transport.emit(event);
  }
  detach() {
    if (this.settled || !this.transport) return;
    this.transport = undefined;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.cancel(), this.graceMs).unref();
  }
  attach(transport: Transport) {
    if (this.settled) return;
    clearTimeout(this.timer);
    this.transport = transport;
    this.available.resolve();
    this.available = latch();
    if (this.usage) transport.emit(this.usage);
    if (this.terminal) this.sendTerminal();
    else {
      transport.emit({ type: "text_replace", text: this.text });
      for (const snapshot of this.subagents.values()) transport.emit(snapshot);
      if (this.thread !== undefined) transport.emit({ type: "status", message: "已接回本机 CLI 会话", external_session_id: this.thread });
    }
  }
  waitForConnection = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!this.transport?.open() && !this.settled) {
      const cancelled = latch();
      const abort = () => cancelled.resolve();
      signal.addEventListener("abort", abort, { once: true });
      try { await Promise.race([this.available.promise, cancelled.promise]); }
      finally { signal.removeEventListener("abort", abort); }
    }
    signal.throwIfAborted();
    if (this.settled || !this.transport?.open()) throw new Error("Bridge connection unavailable");
  };
  rpc: ChatRpc = async (type, payload, signal) => {
    if (!this.transport?.open()) await this.waitForConnection(signal);
    signal.throwIfAborted();
    if (!this.transport?.open()) throw new Error("Bridge connection unavailable");
    // Once dispatched, an RPC may already have committed. Never retry it on a different socket.
    return this.transport.rpc(type, payload, signal);
  };
  private sendTerminal() {
    if (!this.terminal || !this.transport?.open()) return;
    this.transport.emit({ type: this.terminal.status === "error" ? "error" : "done" }, this.terminal);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.cancel(), this.graceMs).unref();
  }
  finish(result: RunChatTurnResult) {
    if (!this.settled) { this.terminal = result; this.sendTerminal(); }
    return this.receipt.promise;
  }
  received() {
    if (!this.terminal) return;
    this.close();
  }
  cancel() {
    this.abort.abort();
    this.close();
  }
  private close() {
    clearTimeout(this.timer);
    this.settled = true;
    this.transport = undefined;
    this.available.resolve();
    this.receipt.resolve();
  }
}
