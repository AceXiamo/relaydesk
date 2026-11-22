import type { ChatMessageRecord } from "./types.ts";

export const STOP_LABELS: Record<NonNullable<ChatMessageRecord["stop_reason"]>, string> = {
  user_stop: "已手动停止",
  follow_up: "已停止，继续追问",
  queue_timeout: "排队超时",
  idle_timeout: "长时间无响应，已停止",
  total_timeout: "回复超时，已停止",
};

export function splitInlineThinkContent(raw: string): {
  thinkingBlocks: string[];
  visibleContent: string;
  hasOpenThink: boolean;
} {
  if (!raw || !raw.includes("<think>")) {
    return { thinkingBlocks: [], visibleContent: raw, hasOpenThink: false };
  }
  const thinkingBlocks: string[] = [];
  let hasOpenThink = false;
  let visible = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
    const cleaned = inner.trim();
    if (cleaned) thinkingBlocks.push(cleaned);
    return "";
  });
  const openIdx = visible.toLowerCase().indexOf("<think>");
  if (openIdx !== -1) {
    hasOpenThink = true;
    const partial = visible.slice(openIdx + "<think>".length).trim();
    if (partial) thinkingBlocks.push(partial);
    visible = visible.slice(0, openIdx);
  }
  return {
    thinkingBlocks,
    visibleContent: visible.trimStart(),
    hasOpenThink,
  };
}
