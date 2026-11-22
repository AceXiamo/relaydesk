import type { ChatMessageRecord } from "../app/lib/types.ts";

// Keep the immediately preceding request intact (up to the API's 16k limit),
// even when a long partial answer or tool output follows it.
export function formatChatHistory(messages: ChatMessageRecord[]): string {
  const blocks: string[] = [];
  let remaining = 32_000;
  for (const msg of [...messages].reverse()) {
    const label = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "System";
    const refs = msg.attachments.map((a) => `${a.kind}: ${a.ref}`).join(", ");
    const tools = msg.events.map((e) => `${e.tool} (${e.status})`).join(", ");
    const body = [msg.content, refs && `Attachments: ${refs}`, tools && `Tools: ${tools}`].filter(Boolean).join("\n");
    const block = `[${label}]: ${body.slice(0, Math.min(remaining, msg.role === "user" ? 16_000 : 4_000))}`;
    blocks.unshift(block);
    remaining -= block.length + 1;
    if (remaining <= 0) break;
  }
  return blocks.join("\n");
}
