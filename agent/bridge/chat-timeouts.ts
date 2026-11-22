export type ChatTimeoutReason = "queue_timeout" | "idle_timeout" | "total_timeout";

export const chatTimeoutMessage: Record<ChatTimeoutReason, string> = {
  queue_timeout: "等待项目执行锁超时，本轮未开始执行。",
  idle_timeout: "本轮长时间没有执行进展，已自动停止。",
  total_timeout: "本轮执行已达到总时限，已自动停止。",
};

function duration(key: string, fallback: number) {
  const raw = process.env[key]?.trim();
  const ms = Number(raw);
  return raw && Number.isSafeInteger(ms) && ms > 0 && ms <= 2_147_483_647 ? ms : fallback;
}

// The first progress notification marks the acquisition of the workspace lock.
// Transport heartbeats never call progress. A zero total budget means unlimited.
export function chatWatchdog(onTimeout: (reason: ChatTimeoutReason) => void) {
  const queueMs = duration("RELAYDESK_CHAT_QUEUE_TIMEOUT_MS", 480_000);
  const idleMs = duration("RELAYDESK_CHAT_IDLE_TIMEOUT_MS", 480_000);
  const totalMs = duration("RELAYDESK_CHAT_TOTAL_TIMEOUT_MS", 0);
  let running = false;
  let closed = false;
  let total: NodeJS.Timeout | undefined;
  let timer = setTimeout(() => expire("queue_timeout"), queueMs).unref();

  function close() {
    closed = true;
    clearTimeout(timer);
    clearTimeout(total);
  }
  function expire(reason: ChatTimeoutReason) {
    if (closed) return;
    close();
    onTimeout(reason);
  }
  function progress() {
    if (closed) return;
    if (running) {
      timer.refresh();
      return;
    }
    running = true;
    clearTimeout(timer);
    timer = setTimeout(() => expire("idle_timeout"), idleMs).unref();
    if (totalMs) total = setTimeout(() => expire("total_timeout"), totalMs).unref();
  }
  return { progress, close };
}
