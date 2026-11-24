import type { ChatSessionRecord } from "../../lib/types.ts";

type Reading = Pick<ChatSessionRecord, "context_used_tokens" | "context_window_tokens"> & Partial<Pick<ChatSessionRecord, "runtime">>;
const tokens = new Intl.NumberFormat("en-US");

export function ContextUsageLabel({ session }: { session?: Reading | null }) {
  const used = session?.context_used_tokens, capacity = session?.context_window_tokens;
  const known = used != null && Number.isSafeInteger(used) && used >= 0;
  const hasWindow = capacity != null && Number.isSafeInteger(capacity) && capacity > 0;
  const ratio = known && hasWindow ? used / capacity : undefined;
  const percent = ratio === undefined ? "" : ratio > 0 && ratio < 0.01 ? "<1%" : `${Math.round(ratio * 100)}%`;
  return (
    <div className="flex flex-wrap justify-end gap-x-1.5 px-3 pt-2 text-[11px] leading-4 tabular-nums text-[var(--text-muted)]"
      title={session?.runtime === "claude"
        ? "Claude 最近一次调用的输入 token（含缓存），不是累计计费用量。"
        : "Harness 最近一次上报的上下文用量，不是会话累计计费 token。"}>
      <span>上下文</span>
      {known ? <>
        <span className="text-[var(--text-secondary)]">{tokens.format(used)}{hasWindow && ` / ${tokens.format(capacity)}`} tokens</span>
        {percent && <span>· {percent}</span>}
      </> : <span>用量未上报</span>}
    </div>
  );
}
