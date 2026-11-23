import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  effortLabels,
  resolveActiveLocalAgent,
  resolveCatalogForTarget,
  resolveDefaultModelForTarget,
  validCatalogId,
} from "~/lib/model-catalog.ts";
import type {
  ChatContextRef,
  ChatReasoningEffort,
  ModelCatalogItem,
  ChatRuntime,
  ChatRuntimeInfo,
  ChatSandboxMode,
  ChatToolEvent,
  TaskRecord,
  WorkspaceDatabaseEntry,
  WorkspaceFileEntry,
} from "~/lib/types.ts";
import { Icon } from "../Icon.tsx";
import { Select, type SelectOption } from "../Select.tsx";
import { LivePulseDot } from "../ui.tsx";
import { RichPromptEditor, type RichPromptEditorHandle } from "./RichPromptEditor.tsx";

export type { RichPromptEditorHandle };

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, ms) / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${mins}m ${rem.toFixed(1)}s`;
}

/* -------------------------------------------------------------------------- */
/* 01. PixelGridLoader (Beautiful UI Loading State)                           */
/* -------------------------------------------------------------------------- */

// 3x3 pixel matrix with staggered wave delays (Drive pattern)
const DRIVE_DELAYS: Array<number | null> = [0, 110, 220, 110, 220, 330, 220, 330, 440];
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT_DELAYS: Array<number | null> = Array.from({ length: 9 }, (_, i) => {
  const idx = ORBIT_ORDER.indexOf(i);
  return idx === -1 ? null : idx * 105;
});

export function PixelGridMatrix({
  variant = "drive",
  className,
}: {
  variant?: "drive" | "orbit";
  className?: string;
}) {
  const delays = variant === "orbit" ? ORBIT_DELAYS : DRIVE_DELAYS;
  const dur = variant === "orbit" ? 900 : 680;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 grid-cols-[repeat(3,3.5px)] gap-[1.5px]",
        className,
      )}
    >
      {delays.map((delay, idx) => (
        <span
          key={idx}
          className="size-[3.5px] rounded-[1px] bg-[var(--text-primary)]"
          style={{
            opacity: delay === null ? 0.08 : 0.16,
            animation:
              delay === null
                ? "none"
                : `rd-pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

export function PixelGridLoader({
  label = "正在思考",
  startedAt,
  variant = "drive",
  className,
}: {
  label?: string;
  startedAt?: number;
  variant?: "drive" | "orbit";
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const mountStartRef = useRef(startedAt ?? Date.now());

  useEffect(() => {
    if (startedAt) mountStartRef.current = startedAt;
  }, [startedAt]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = formatElapsed(now - mountStartRef.current);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("inline-flex items-center gap-2.5 select-none", className)}
    >
      <PixelGridMatrix variant={variant} />
      <span className="rd-shimmer-text text-[13px] font-medium leading-tight">
        {label}
      </span>
      <span className="font-mono text-[11.5px] text-[var(--text-muted)] tabular-nums">
        {elapsed}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 02. ThinkingTrace (Beautiful UI Expandable Thinking)                       */
/* -------------------------------------------------------------------------- */

export interface TraceEntry {
  id: string;
  kind: "status" | "reasoning" | "tool";
  text: string;
}

export function ThinkingTrace({
  active,
  autoExpand = true,
  statusLabel,
  entries,
  startedAt,
  durationMs,
}: {
  active: boolean;
  autoExpand?: boolean;
  statusLabel: string;
  entries: TraceEntry[];
  startedAt?: number;
  durationMs?: number;
}) {
  // null = follow automatic lifecycle (open while actively reasoning, collapse once settled);
  // explicit user click always overrides so the trace can be collapsed or expanded at any time.
  const [userPref, setUserPref] = useState<"expanded" | "collapsed" | null>(null);

  const hasEntries = entries.length > 0;
  const hasReasoning = entries.some((e) => e.kind === "reasoning");
  if (!active && !hasEntries) return null;

  const isOpen = hasEntries && (userPref !== null ? userPref === "expanded" : active && autoExpand && hasReasoning);

  const settledSummary = durationMs
    ? `已思考 ${formatElapsed(durationMs)}`
    : hasReasoning
      ? "深度思考过程"
      : entries.length > 0
        ? `推理过程 · ${entries.length} 条记录`
        : "已完成推理";

  const handleToggle = () => {
    if (!hasEntries) return;
    setUserPref(isOpen ? "collapsed" : "expanded");
  };

  return (
    <div className="mb-2.5">
      <button
        type="button"
        onClick={handleToggle}
        disabled={!hasEntries}
        aria-expanded={isOpen}
        className={cn(
          "group inline-flex items-center gap-2 py-1 pr-2 rounded-lg text-left transition-colors",
          hasEntries
            ? "hover:bg-[var(--surface-hover)] px-1.5 -ml-1.5 cursor-pointer"
            : "cursor-default",
        )}
      >
        {active ? (
          <PixelGridLoader
            label={statusLabel || "正在思考"}
            startedAt={startedAt}
            variant="drive"
          />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors">
            <Icon name="sparkles" size={12} className="text-[var(--text-muted)] opacity-80" />
            <span>{settledSummary}</span>
          </span>
        )}
        {hasEntries && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]">
            <span className={cn("transition-opacity", isOpen ? "opacity-80" : "opacity-0 group-hover:opacity-100")}>
              {isOpen ? "收起" : "展开"}
            </span>
            <Icon
              name="chevron-down"
              size={13}
              className={cn(
                "text-[var(--text-muted)] transition-transform duration-200",
                isOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </span>
        )}
      </button>

      {isOpen && (
        <div className="mt-1.5 ml-1 pl-3 pr-1 border-l border-[var(--border-subtle)] space-y-1.5 max-h-72 overflow-y-auto rd-scroll animate-fade-in">
          {entries.map((item) => (
            <div
              key={item.id}
              className={cn(
                "text-[12px] leading-relaxed",
                item.kind === "reasoning"
                  ? "text-[var(--text-secondary)] whitespace-pre-wrap break-words"
                  : "text-[var(--text-muted)] font-mono text-[11.5px]",
              )}
            >
              {item.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 05. ToolChipsGroup (Beautiful UI Compact Tool Chips)                       */
/* -------------------------------------------------------------------------- */

interface ParsedToolMeta {
  icon: string;
  verb: string;
  target: string;
  mono: boolean;
}

function parseToolMeta(ev: ChatToolEvent): ParsedToolMeta {
  const rawTool = ev.tool.toLowerCase();
  const summary = ev.summary.trim();

  // Strip leading "ToolName: " prefix from Claude Code events
  const cleaned = summary.replace(new RegExp(`^${ev.tool}\\s*:\\s*`, "i"), "").trim();

  if (rawTool === "read") {
    return { icon: "file-text", verb: "读取", target: cleaned || summary, mono: true };
  }
  if (rawTool === "edit" || rawTool === "write" || rawTool === "file_change") {
    const target = cleaned.replace(/^文件变更：\s*/, "");
    return { icon: "pen-line", verb: rawTool === "write" ? "写入" : "编辑", target: target || "工作区文件", mono: true };
  }
  if (rawTool === "bash" || rawTool === "shell") {
    return { icon: "terminal", verb: "执行", target: cleaned || summary, mono: true };
  }
  if (rawTool === "grep" || rawTool === "glob" || rawTool === "search") {
    return { icon: "search", verb: rawTool === "glob" ? "查找文件" : "搜索", target: cleaned || summary, mono: true };
  }
  return { icon: "wrench", verb: ev.tool, target: cleaned && cleaned !== ev.tool ? cleaned : "", mono: true };
}

function renderOutputLines(output: string) {
  const lines = output.split(/\r?\n/);
  const looksLikeDiff = lines.some((l) => l.startsWith("+++ ") || l.startsWith("--- ") || l.startsWith("@@ "));
  if (!looksLikeDiff) {
    return (
      <pre className="m-0 font-mono text-[11.5px] leading-[1.55] text-[var(--text-secondary)] whitespace-pre-wrap break-words">
        {output}
      </pre>
    );
  }
  return (
    <pre className="m-0 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap break-words">
      {lines.map((line, idx) => {
        const tone = line.startsWith("+") && !line.startsWith("+++")
          ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/8 block -mx-3 px-3"
          : line.startsWith("-") && !line.startsWith("---")
            ? "text-rose-600 dark:text-rose-400 bg-rose-500/8 block -mx-3 px-3"
            : line.startsWith("@@")
              ? "text-indigo-600 dark:text-indigo-400 block"
              : "text-[var(--text-secondary)] block";
        return (
          <span key={idx} className={tone}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

export function ToolChipsGroup({
  events,
  isStreaming = false,
}: {
  events: ChatToolEvent[];
  isStreaming?: boolean;
}) {
  const [groupOpen, setGroupOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (!events.length) return null;

  const runningCount = events.filter((e) => e.status === "running").length;
  const errorCount = events.filter((e) => e.status === "error").length;

  const MAX_COLLAPSED_ITEMS = 4;
  const shouldTruncate = !isStreaming && !showAll && events.length > MAX_COLLAPSED_ITEMS;
  const visibleEvents = shouldTruncate ? events.slice(0, MAX_COLLAPSED_ITEMS) : events;
  const hiddenCount = events.length - visibleEvents.length;

  const toggleItem = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopyOutput = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 1500);
  };

  const headerText = runningCount > 0
    ? `正在执行工具 (${events.length - runningCount}/${events.length})`
    : `已调用 ${events.length} 个工具`;

  return (
    <div className="mb-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)]/70 dark:bg-[var(--surface-card)]/50 overflow-hidden">
      {/* Compact Group Header */}
      <button
        type="button"
        onClick={() => setGroupOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between gap-2 text-left hover:bg-[var(--surface-hover)]/70 transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2 min-w-0">
          {runningCount > 0 ? (
            <PixelGridMatrix variant="orbit" />
          ) : errorCount > 0 ? (
            <Icon name="alert-circle" size={13} className="text-rose-500" />
          ) : (
            <Icon name="terminal" size={13} className="text-[var(--text-muted)]" />
          )}
          <span className={cn("text-[12px] font-medium", runningCount > 0 ? "rd-shimmer-text" : "text-[var(--text-secondary)]")}>
            {headerText}
          </span>
          {errorCount > 0 && (
            <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">
              {errorCount} 失败
            </span>
          )}
        </span>
        <Icon
          name="chevron-down"
          size={13}
          className={cn(
            "text-[var(--text-muted)] transition-transform duration-200 shrink-0",
            groupOpen ? "rotate-180" : "rotate-0",
          )}
        />
      </button>

      {groupOpen && (
        <div className="border-t border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]/60">
          {visibleEvents.map((ev) => {
            const meta = parseToolMeta(ev);
            const hasDetail = Boolean(ev.output || ev.exit_code !== undefined);
            const isOpen = expandedIds.has(ev.id);

            return (
              <div key={ev.id} className="text-[12px]">
                <button
                  type="button"
                  onClick={() => hasDetail && toggleItem(ev.id)}
                  disabled={!hasDetail}
                  className={cn(
                    "w-full px-3 py-1.5 flex items-center justify-between gap-2 text-left transition-colors",
                    hasDetail ? "hover:bg-[var(--surface-hover)]/60 cursor-pointer" : "cursor-default",
                  )}
                >
                  <span className="flex items-center gap-2 min-w-0 flex-1">
                    {ev.status === "running" ? (
                      <Icon name="loader-2" size={12} className="animate-spin text-indigo-500 shrink-0" />
                    ) : ev.status === "error" ? (
                      <Icon name="x-circle" size={12} className="text-rose-500 shrink-0" />
                    ) : (
                      <Icon name={meta.icon} size={12} className="text-[var(--text-muted)] shrink-0" />
                    )}
                    <span className="text-[12px] font-medium text-[var(--text-secondary)] shrink-0">
                      {meta.verb}
                    </span>
                    {meta.target && (
                      <span
                        className={cn(
                          "px-1.5 py-0.5 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-primary)] truncate min-w-0 max-w-full sm:max-w-[440px]",
                          meta.mono ? "font-mono text-[11px]" : "text-[11.5px]",
                        )}
                        title={meta.target}
                      >
                        {meta.target}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {typeof ev.exit_code === "number" && ev.exit_code !== 0 && (
                      <span className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-600 dark:text-rose-400">
                        exit {ev.exit_code}
                      </span>
                    )}
                    {ev.status === "done" && !hasDetail && (
                      <Icon name="check" size={11} className="text-emerald-500" />
                    )}
                    {hasDetail && (
                      <Icon
                        name="chevron-right"
                        size={12}
                        className={cn(
                          "text-[var(--text-muted)] transition-transform duration-150",
                          isOpen && "rotate-90",
                        )}
                      />
                    )}
                  </span>
                </button>

                {isOpen && hasDetail && (
                  <div className="px-3 py-2 bg-[var(--surface-subtle)]/75 dark:bg-[#0d0f13]/80 border-t border-[var(--border-subtle)]/70 animate-fade-in">
                    <div className="flex items-center justify-between gap-2 mb-1.5 text-[11px] text-[var(--text-muted)]">
                      <span className="font-mono truncate">{ev.summary}</span>
                      {ev.output && (
                        <button
                          type="button"
                          onClick={() => handleCopyOutput(ev.id, ev.output!)}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition cursor-pointer shrink-0"
                        >
                          <Icon name={copiedId === ev.id ? "check" : "copy"} size={11} />
                          {copiedId === ev.id ? "已复制" : "复制输出"}
                        </button>
                      )}
                    </div>
                    {ev.output ? (
                      <div className="max-h-56 overflow-auto rd-scroll">
                        {renderOutputLines(ev.output)}
                      </div>
                    ) : (
                      <div className="text-[11px] font-mono text-[var(--text-muted)]">
                        （无输出{typeof ev.exit_code === "number" ? `，退出码 ${ev.exit_code}` : ""}）
                      </div>
                    )}
                  </div>
                )}

                {ev.images && ev.images.length > 0 && (
                  <div className="px-3 pb-2.5 pt-1 flex flex-wrap gap-2">
                    {ev.images.map((img, idx) => (
                      <a
                        key={`${ev.id}-img-${idx}`}
                        href={img.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block group"
                      >
                        <img
                          src={img.url}
                          alt={img.alt || `${ev.tool} 图片`}
                          loading="lazy"
                          className="max-h-64 w-auto max-w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] object-contain shadow-2xs group-hover:border-indigo-500/50 transition-colors"
                        />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full px-3 py-1.5 text-left text-[11.5px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]/60 transition-colors cursor-pointer"
            >
              +{hiddenCount} 更多工具调用
            </button>
          )}
          {!isStreaming && showAll && events.length > MAX_COLLAPSED_ITEMS && (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="w-full px-3 py-1.5 text-left text-[11.5px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]/60 transition-colors cursor-pointer"
            >
              收起多余工具调用
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 03. FollowUpList (Beautiful UI Streaming Text Follow-ups / Starters)       */
/* -------------------------------------------------------------------------- */

export interface QuickPromptItem {
  icon: string;
  title: string;
  subtitle?: string;
  prompt: string;
}

export function FollowUpList({
  heading,
  items,
  disabled,
  compact = false,
  onSelect,
}: {
  heading?: string;
  items: QuickPromptItem[];
  disabled?: boolean;
  compact?: boolean;
  onSelect: (prompt: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className={cn("space-y-1.5", compact ? "mt-3" : "mt-1")}>
      {heading && (
        <div className="text-[11.5px] font-medium text-[var(--text-muted)] px-1">
          {heading}
        </div>
      )}
      <div className="divide-y divide-[var(--border-subtle)]/70 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)]/70 overflow-hidden">
        {items.map((item) => (
          <button
            key={item.title}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(item.prompt)}
            className={cn(
              "group w-full flex items-center justify-between gap-3 text-left transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50 cursor-pointer",
              compact ? "px-3 py-2" : "px-3.5 py-2.5",
            )}
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <span className="mt-0.5 text-[var(--text-muted)] group-hover:text-indigo-500 transition-colors shrink-0">
                <Icon name={item.icon} size={14} />
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                  {item.title}
                </div>
                {item.subtitle && (
                  <div className="text-[11.5px] text-[var(--text-muted)] truncate mt-0.5">
                    {item.subtitle}
                  </div>
                )}
              </div>
            </div>
            <Icon
              name="arrow-right"
              size={13}
              className="text-[var(--text-muted)] opacity-50 group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:text-[var(--text-primary)] transition-all shrink-0"
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 08. PromptBar (Beautiful UI Prompt Bar with @ sources, / commands & pills) */
/* -------------------------------------------------------------------------- */

export interface SlashCommandItem {
  id: string;
  command: string;
  label: string;
  description: string;
  icon: string;
  prompt?: string;
  action?: "new_session" | "open_workspace";
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "overview",
    command: "/overview",
    label: "盘点项目上下文",
    description: "总览项目空间 files/、HANDBOOK.md 与已同步仓库",
    icon: "folder-open",
    prompt: "请先查看当前项目空间 files/ 目录、HANDBOOK.md 以及已同步的仓库，给我一份精简的项目上下文总览。",
  },
  {
    id: "db",
    command: "/db",
    label: "检查数据库结构",
    description: "分析项目空间 SQLite 或已配置数据源的表结构与核心数据",
    icon: "database",
    prompt: "请检查项目空间里的数据库配置与 SQLite 文件，列出核心表结构、数据量及需要注意的异常点。",
  },
  {
    id: "repos",
    command: "/repos",
    label: "梳理仓库架构",
    description: "浏览 repos/ 下已同步代码库的入口模块与风险点",
    icon: "code-2",
    prompt: "请浏览 repos/ 下已同步的绑定仓库结构，指出核心入口模块、关键依赖以及常见风险点。",
  },
  {
    id: "handbook",
    command: "/handbook",
    label: "起草项目手册",
    description: "结合现有资料生成或优化 HANDBOOK.md 维护约定",
    icon: "book-open",
    prompt: "请结合现有项目文件和代码仓库，帮我整理一份结构清晰的 HANDBOOK.md 草案（包含目录结构、验证命令与排查约定）。",
  },
  {
    id: "workspace",
    command: "/workspace",
    label: "打开项目空间",
    description: "前往文件、数据库与手册管理页",
    icon: "layers",
    action: "open_workspace",
  },
  {
    id: "new",
    command: "/new",
    label: "开启新会话",
    description: "保留当前设置并新建一条空白对话",
    icon: "plus",
    action: "new_session",
  },
];

interface MentionEntry {
  key: string;
  kind: "file" | "database" | "task";
  title: string;
  subtitle?: string;
  ref: ChatContextRef;
}

const effortLevels = ["off", "low", "medium", "high", "max"] as const;
const effortOptionMeta: Record<
  ChatReasoningEffort,
  { description: string; badge?: string; dotClassName: string }
> = {
  default: { description: "跟随模型或项目默认设定", dotClassName: "bg-zinc-400" },
  off: { description: "关闭深度思考，响应最快", badge: "Off", dotClassName: "bg-slate-400" },
  low: { description: "轻量推理，适合简单问答", badge: "Low", dotClassName: "bg-sky-400" },
  medium: { description: "均衡推理质量与响应速度", badge: "Med", dotClassName: "bg-indigo-400" },
  high: { description: "深度严谨推理，适合复杂排查", badge: "High", dotClassName: "bg-violet-500" },
  max: { description: "最高推理预算，攻克复杂难题", badge: "Max", dotClassName: "bg-amber-500" },
};
const contextSize = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

interface ExecutionTargetSelectProps {
  projectId?: string;
  runtime: ChatRuntime;
  runtimeInfo: ChatRuntimeInfo | null;
  executionTarget: string;
  disabled: boolean;
  onChangeExecutionTarget: (target: string) => void;
  onOpenChange?: () => void;
}

function ExecutionTargetSelect({
  projectId,
  runtime,
  runtimeInfo,
  executionTarget,
  disabled,
  onChangeExecutionTarget,
  onOpenChange,
}: ExecutionTargetSelectProps) {
  const activeLocalAgent = useMemo(
    () => resolveActiveLocalAgent(runtimeInfo, projectId, executionTarget, runtime),
    [runtimeInfo, projectId, executionTarget, runtime],
  );

  const targetOptions = useMemo<Array<SelectOption<string>>>(() => {
    const agents = runtimeInfo?.agents ?? [];
    const autoPreview = activeLocalAgent
      ? `将优先由本机「${activeLocalAgent.name}」承接`
      : runtimeInfo?.local_clis[runtime]
        ? "当前无可用本机节点，将由云端执行"
        : "按项目优先级自动路由";
    const list: Array<SelectOption<string>> = [
      {
        value: "auto",
        label: "自动路由",
        triggerLabel: activeLocalAgent ? `自动 · ${activeLocalAgent.name}` : "自动",
        description: autoPreview,
        icon: "sparkles",
        badge: "推荐",
      },
    ];
    for (const agent of agents) {
      const binding = projectId ? agent.bindings.find((b) => b.project_id === projectId) : undefined;
      const runtimeReady = Boolean(agent.runtimes[runtime]?.available);
      const bindingReady = Boolean(binding?.enabled && binding?.path_ok);
      const statusText = !agent.online
        ? "离线"
        : !bindingReady
          ? "未绑定/禁用本项目目录"
          : !runtimeReady
            ? `未安装 ${runtime}`
            : `就绪 · 并发 ${agent.active_runs}/${agent.max_concurrency}`;
      list.push({
        value: `local:${agent.id}`,
        label: agent.name,
        triggerLabel: agent.name,
        description: binding?.workdir ? `${statusText} · ${binding.workdir}` : statusText,
        dotClassName: agent.online && bindingReady && runtimeReady ? "bg-emerald-500" : "bg-zinc-400",
        badge: agent.online ? "本机" : "离线",
        group: "本机执行节点",
      });
    }
    list.push({
      value: "cloud",
      label: "云端执行器",
      triggerLabel: "云端",
      description: runtimeInfo?.local_clis[runtime]
        ? "在 Relaydesk 服务端隔离工作区运行"
        : `服务端未检测到 ${runtime} CLI`,
      icon: "cloud",
      group: "云端",
    });
    return list;
  }, [runtimeInfo, projectId, runtime, activeLocalAgent]);

  return (
    <Select
      value={executionTarget}
      onChange={(next) => {
        onOpenChange?.();
        onChangeExecutionTarget(next);
      }}
      options={targetOptions}
      disabled={disabled}
      size="xs"
      variant="default"
      minMenuWidth={256}
      maxMenuWidth={320}
      leadingIcon={
        executionTarget === "cloud"
          ? "cloud"
          : executionTarget.startsWith("local:")
            ? "monitor"
            : "sparkles"
      }
      leadingIconClassName={
        activeLocalAgent ? "text-emerald-500" : "text-[var(--text-muted)]"
      }
      ariaLabel="执行节点"
      className="!bg-[var(--surface-card)]/90 max-w-[200px] sm:max-w-[260px]"
    />
  );
}

interface ModelControlsProps {
  projectId?: string;
  runtime: ChatRuntime;
  runtimeInfo: ChatRuntimeInfo | null;
  model: string;
  effort: ChatReasoningEffort;
  executionTarget?: string;
  onChangeModel: (runtime: ChatRuntime, model: string, effort: ChatReasoningEffort) => void;
  onChangeEffort: (effort: ChatReasoningEffort) => void;
  onChangeExecutionTarget?: (target: string) => void;
}

function ModelControls({
  projectId,
  runtime,
  runtimeInfo,
  model,
  effort,
  executionTarget = "auto",
  onChangeModel,
  onChangeEffort,
  open,
  setOpen,
  disabled,
  onOpenCliSettings,
}: ModelControlsProps & {
  open: boolean;
  setOpen: (open: boolean) => void;
  disabled: boolean;
  onOpenCliSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const settings = runtimeInfo?.project_cli;
  const activeLocalAgent = useMemo(
    () => resolveActiveLocalAgent(runtimeInfo, projectId, executionTarget, runtime),
    [runtimeInfo, projectId, executionTarget, runtime],
  );
  const strictTargetCatalog = useMemo(
    () =>
      resolveCatalogForTarget({
        runtime,
        activeLocalAgent,
        projectCli: settings,
        includeSelectedFallback: false,
      }),
    [runtime, activeLocalAgent, settings],
  );
  const catalog = useMemo(
    () =>
      resolveCatalogForTarget({
        runtime,
        activeLocalAgent,
        projectCli: settings,
        selectedModel: model,
        includeSelectedFallback: true,
      }),
    [runtime, activeLocalAgent, settings, model],
  );
  const strictCatalogIds = useMemo(
    () => new Set(strictTargetCatalog.map((item) => item.id)),
    [strictTargetCatalog],
  );
  const current = catalog.find((item) => item.id === model);
  const levels = current?.effort_levels ?? effortLevels;
  const adjustable = current?.supports_effort !== false && levels.length > 0;
  const displayedEffort =
    adjustable && (effort === "default" || levels.includes(effort)) ? effort : "default";
  const configuredModel = resolveDefaultModelForTarget(runtime, activeLocalAgent, settings);
  const search = query.trim();
  const matches = catalog.filter((item) =>
    `${item.id} ${item.label ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const exact = matches.find((item) => item.id === search);
  const options: ModelCatalogItem[] = validCatalogId(search)
    ? [exact ?? { runtime, id: search, label: "使用自定义模型" }, ...matches.filter((item) => item !== exact)]
    : matches;
  if (!search && !configuredModel) options.push({ runtime, id: "", label: "使用 CLI 默认模型" });
  const selectedIndex = Math.min(index, options.length - 1);
  const ready = activeLocalAgent
    ? Boolean(activeLocalAgent.online && activeLocalAgent.runtimes[runtime]?.available)
    : Boolean(runtimeInfo && runtimeInfo.auth_mode[runtime] !== "unavailable");

  const effortOptions = useMemo<Array<SelectOption<ChatReasoningEffort>>>(() => {
    const targetDefaultEffort = activeLocalAgent
      ? activeLocalAgent.runtimes[runtime]?.default_effort
      : settings?.runtime === runtime
        ? settings.default_effort
        : undefined;
    const defaultBadge =
      targetDefaultEffort && targetDefaultEffort !== "default"
        ? `${activeLocalAgent ? "节点" : "项目"}：${effortLabels[targetDefaultEffort]}`
        : undefined;
    const list: Array<SelectOption<ChatReasoningEffort>> = [
      {
        value: "default",
        label: effortLabels.default,
        triggerLabel: effortLabels.default,
        description: effortOptionMeta.default.description,
        badge: defaultBadge,
        dotClassName: effortOptionMeta.default.dotClassName,
      },
    ];
    for (const level of levels) {
      list.push({
        value: level,
        label: effortLabels[level],
        triggerLabel: effortLabels[level],
        description: effortOptionMeta[level].description,
        badge: effortOptionMeta[level].badge,
        dotClassName: effortOptionMeta[level].dotClassName,
      });
    }
    return list;
  }, [levels, runtime, settings, activeLocalAgent]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, runtime]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const choose = (rt: ChatRuntime, id: string, closeAfter: boolean) => {
    const targetAgent = resolveActiveLocalAgent(runtimeInfo, projectId, executionTarget, rt);
    const nextCatalog =
      rt === runtime
        ? catalog
        : resolveCatalogForTarget({
            runtime: rt,
            activeLocalAgent: targetAgent,
            projectCli: settings,
            selectedModel: id,
            includeSelectedFallback: true,
          });
    const entry = nextCatalog.find((item) => item.id === id);
    const nextEffort =
      entry?.supports_effort === false ||
      (effort !== "default" && entry?.effort_levels && !entry.effort_levels.includes(effort))
        ? "default"
        : effort;
    if (rt !== runtime || id !== model || effort !== nextEffort) onChangeModel(rt, id, nextEffort);
    setQuery("");
    setIndex(0);
    if (closeAfter) close();
  };
  const pillClass =
    "inline-flex items-center gap-1.5 h-7 px-2 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50 cursor-pointer min-w-0";
  return (
    <div
      className="contents"
      onBlur={(e) => {
        if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (open && e.key === "Escape" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          close();
        }
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`切换运行工具与模型：${model || "CLI 默认"}`}
        className={cn(pillClass, open && "bg-[var(--surface-hover)]")}
        onClick={() => {
          setQuery("");
          setIndex(0);
          setOpen(!open);
        }}
      >
        <LivePulseDot tone={ready ? "emerald" : "zinc"} active={!!ready} />
        <span className="shrink-0">{runtime === "codex" ? "Codex" : "Claude"}</span>
        <span className="max-w-[88px] sm:max-w-[200px] truncate font-mono text-[11px] text-[var(--text-muted)]">
          {current?.label || model || "默认模型"}
        </span>
        <Icon name="chevron-down" size={11} className="shrink-0" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="选择运行工具与模型"
          className="absolute left-0 right-0 sm:right-auto sm:w-[360px] bottom-full mb-2 z-30 max-h-[55dvh] sm:max-h-none flex flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--rd-shadow-lg)] overflow-hidden animate-popover-in-up"
        >
          <div className="flex gap-1 p-1.5 border-b border-[var(--border-subtle)]">
            {(["claude", "codex"] as const).map((rt) => (
              <button
                key={rt}
                type="button"
                disabled={disabled}
                aria-pressed={runtime === rt}
                onClick={() => {
                  if (runtime === rt) return;
                  const nextAgent = resolveActiveLocalAgent(
                    runtimeInfo,
                    projectId,
                    executionTarget,
                    rt,
                  );
                  const nextDefault = resolveDefaultModelForTarget(rt, nextAgent, settings);
                  choose(rt, nextDefault, false);
                }}
                className={cn(
                  "flex-1 rounded-lg px-2 py-1.5 text-[12px] font-medium transition-colors cursor-pointer",
                  runtime === rt
                    ? "bg-[var(--surface-hover)] text-[var(--text-primary)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                )}
              >
                {rt === "claude" ? "Claude Code" : "Codex CLI"}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 text-[11px] text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1.5 min-w-0 truncate">
              {activeLocalAgent ? (
                <>
                  <LivePulseDot
                    tone={activeLocalAgent.online ? "emerald" : "zinc"}
                    active={activeLocalAgent.online}
                  />
                  <span className="truncate">本机目录 · {activeLocalAgent.name}</span>
                </>
              ) : (
                <>
                  <Icon name="cloud" size={11} className="shrink-0" />
                  <span className="truncate">云端项目目录</span>
                </>
              )}
            </span>
            <span className="font-mono text-[10.5px] shrink-0 tabular-nums">
              {strictTargetCatalog.length} 个模型
            </span>
          </div>
          <label className="mx-3 flex items-center gap-2 py-2 text-[var(--text-muted)]">
            <Icon name="search" size={14} />
            <input
              ref={inputRef}
              role="combobox"
              aria-label="搜索或输入模型 ID"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined}
              value={query}
              maxLength={160}
              placeholder="搜索或输入模型 ID…"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] focus:outline-none"
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              onKeyDown={(e) => {
                if (disabled || e.nativeEvent.isComposing || !options.length) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  choose(runtime, options[selectedIndex].id, true);
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const next =
                    (selectedIndex + options.length + (e.key === "ArrowDown" ? 1 : -1)) % options.length;
                  setIndex(next);
                  document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" });
                }
              }}
            />
            <kbd className="hidden sm:inline font-mono text-[10px]">↑↓ ↵</kbd>
          </label>
          <div
            role="listbox"
            id={listId}
            aria-label="可选模型"
            className="max-h-[min(30dvh,16rem)] sm:max-h-[min(38vh,16rem)] overflow-y-auto rd-scroll px-1.5 pb-1.5"
          >
            {activeLocalAgent && strictTargetCatalog.length === 0 && !search && (
              <p className="px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">
                该本机节点尚未上报 {runtime} 模型，可直接输入自定义 ID 或使用 CLI 默认模型。
              </p>
            )}
            {!options.length && (
              <p className="px-2.5 py-2 text-xs text-[var(--text-muted)]">
                无匹配模型。自定义 ID 须使用可见 ASCII 字符，不能含空格或以连字符开头。
              </p>
            )}
            {options.map((item, i) => {
              const showSeparateLabel = Boolean(item.label && item.label !== item.id);
              const isOutOfCatalogCurrent = Boolean(
                item.id && item.id === model && !strictCatalogIds.has(item.id),
              );
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={model === item.id}
                  id={`${listId}-${i}`}
                  key={item.id}
                  tabIndex={-1}
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(runtime, item.id, true)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left cursor-pointer",
                    selectedIndex === i && "bg-[var(--surface-hover)]",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    {showSeparateLabel && (
                      <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                        {item.label}
                      </span>
                    )}
                    {item.id && (
                      <span
                        title={item.id}
                        className={cn(
                          "block truncate font-mono",
                          showSeparateLabel
                            ? "text-[11.5px] text-[var(--text-secondary)]"
                            : "text-[12px] font-medium text-[var(--text-primary)]",
                        )}
                      >
                        {item.id}
                      </span>
                    )}
                  </span>
                  {item.context_window && (
                    <span
                      title={`${item.context_window.toLocaleString()} 个上下文 token`}
                      className="rounded border border-[var(--border-subtle)] px-1 font-mono text-[10px] text-[var(--text-muted)] shrink-0"
                    >
                      {contextSize.format(item.context_window)}
                    </span>
                  )}
                  {isOutOfCatalogCurrent && (
                    <span className="rounded bg-amber-500/12 px-1 py-0.5 text-[10px] text-amber-700 dark:text-amber-300 shrink-0">
                      当前会话
                    </span>
                  )}
                  {(configuredModel ? item.id === configuredModel : item.is_default) && (
                    <span className="text-[10px] text-[var(--text-muted)] shrink-0">默认</span>
                  )}
                  {item.id === model && <Icon name="check" size={13} className="text-indigo-500 shrink-0" />}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              close();
              onOpenCliSettings();
            }}
            className="flex w-full items-center gap-1.5 border-t border-[var(--border-subtle)] px-3 py-2 text-[11.5px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] cursor-pointer"
          >
            <Icon name="sliders-horizontal" size={12} /> 项目模型设置
          </button>
        </div>
      )}
      <Select
        value={displayedEffort}
        onChange={(next) => {
          setOpen(false);
          onChangeEffort(next);
        }}
        options={effortOptions}
        disabled={!adjustable || disabled}
        size="xs"
        variant="default"
        minMenuWidth={268}
        maxMenuWidth={300}
        leadingIcon="sparkles"
        leadingIconClassName={
          displayedEffort !== "default" && displayedEffort !== "off"
            ? "text-indigo-500"
            : "text-[var(--text-muted)]"
        }
        ariaLabel={adjustable ? "思考强度" : "该模型不支持调节思考强度"}
        className={cn(
          "!border-transparent !bg-transparent hover:!bg-[var(--surface-hover)] hover:!border-[var(--border-subtle)] !px-2 shrink-0",
          displayedEffort !== "default" &&
            displayedEffort !== "off" &&
            "!bg-indigo-500/8 !text-indigo-700 dark:!text-indigo-300",
        )}
      />
    </div>
  );
}

export interface PromptBarProps extends ModelControlsProps {
  input: string;
  onInputChange: (value: string) => void;
  attachments: ChatContextRef[];
  onToggleAttachment: (ref: ChatContextRef) => void;
  onUploadImages?: (files: File[]) => void;
  uploadingImages?: boolean;
  workspaceFiles: WorkspaceFileEntry[];
  workspaceDatabases: WorkspaceDatabaseEntry[];
  openTasks: TaskRecord[];
  settingsBusy: boolean;
  sandboxMode: ChatSandboxMode;
  networkAccess: boolean;
  streaming: boolean;
  sendBlocked: boolean;
  stopBlocked: boolean;
  statusLine: string;
  authUnavailable: boolean;
  composerRef: React.RefObject<RichPromptEditorHandle | null>;
  onChangeSandboxMode: (mode: ChatSandboxMode) => void;
  onToggleNetworkAccess: () => void;
  onOpenCliSettings: () => void;
  onOpenWorkspace: () => void;
  onNewSession: () => void;
  onSend: (promptOverride?: string) => void;
  onAbort: () => void;
}

export function PromptBar({
  projectId,
  input,
  onInputChange,
  attachments,
  onToggleAttachment,
  onUploadImages,
  uploadingImages = false,
  workspaceFiles,
  workspaceDatabases,
  openTasks,
  runtime,
  runtimeInfo,
  sandboxMode,
  networkAccess,
  streaming,
  sendBlocked,
  stopBlocked,
  statusLine,
  authUnavailable,
  composerRef,
  model,
  effort,
  executionTarget,
  settingsBusy,
  onChangeModel,
  onChangeEffort,
  onChangeExecutionTarget,
  onChangeSandboxMode,
  onToggleNetworkAccess,
  onOpenCliSettings,
  onOpenWorkspace,
  onNewSession,
  onSend,
  onAbort,
}: PromptBarProps) {
  const [popover, setPopover] = useState<"none" | "mention" | "slash" | "runtime">("none");
  const [mentionTab, setMentionTab] = useState<"all" | "files" | "databases" | "tasks">("all");
  const [mentionQuery, setMentionQuery] = useState("");
  const [slashQuery, setSlashQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [dragOverImage, setDragOverImage] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Close popovers on outside click
  useEffect(() => {
    if (popover === "none") return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setPopover("none");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [popover]);

  // Flatten mention catalog
  const allMentions = useMemo<MentionEntry[]>(() => {
    const items: MentionEntry[] = [];
    for (const f of workspaceFiles) {
      items.push({
        key: `file:${f.path}`,
        kind: "file",
        title: f.path,
        subtitle: "项目文件",
        ref: { kind: "file", label: f.path, ref: f.path },
      });
    }
    for (const db of workspaceDatabases) {
      const refPath = db.file_path
        ? `files/${db.file_path}`
        : db.env_var
          ? `$${db.env_var}`
          : db.host_preview || db.name;
      items.push({
        key: `db:${db.id}`,
        kind: "database",
        title: db.name,
        subtitle: `${db.kind}${db.source === "external" && db.env_var ? ` · $${db.env_var}` : ""}`,
        ref: { kind: "database", label: db.name, ref: refPath },
      });
    }
    for (const t of openTasks) {
      items.push({
        key: `task:${t.id}`,
        kind: "task",
        title: `RD-${t.number} ${t.title}`,
        subtitle: "进行中工单",
        ref: { kind: "task", label: `RD-${t.number} ${t.title}`, ref: t.id },
      });
    }
    return items;
  }, [workspaceFiles, workspaceDatabases, openTasks]);

  const filteredMentions = useMemo(() => {
    const q = mentionQuery.trim().toLowerCase();
    return allMentions.filter((item) => {
      if (mentionTab === "files" && item.kind !== "file") return false;
      if (mentionTab === "databases" && item.kind !== "database") return false;
      if (mentionTab === "tasks" && item.kind !== "task") return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        (item.subtitle?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [allMentions, mentionTab, mentionQuery]);

  const filteredSlash = useMemo(() => {
    const q = slashQuery.trim().toLowerCase();
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter(
      (c) =>
        c.command.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [slashQuery]);

  const handleChange = (val: string) => {
    onInputChange(val);

    // Detect inline "/" at start of message
    if (val.startsWith("/") && !val.includes("\n") && !val.includes(" ")) {
      setPopover("slash");
      setSlashQuery(val.slice(1));
      setActiveIndex(0);
      return;
    }

    // Detect inline "@query" at the end of input
    const mentionMatch = val.match(/(?:^|\s)@([^\s@]*)$/);
    if (mentionMatch) {
      setPopover("mention");
      setMentionQuery(mentionMatch[1] ?? "");
      setActiveIndex(0);
      return;
    }

    if (popover === "slash" || popover === "mention") {
      setPopover("none");
      setMentionQuery("");
      setSlashQuery("");
    }
  };

  const pickMention = (entry: MentionEntry) => {
    onToggleAttachment(entry.ref);
    // Strip trailing @query token if triggered inline
    if (/(?:^|\s)@([^\s@]*)$/.test(input)) {
      const cleaned = input.replace(/(^|\s)@([^\s@]*)$/, "$1").trimEnd();
      onInputChange(cleaned ? `${cleaned} ` : "");
    }
    setMentionQuery("");
    setPopover("none");
    composerRef.current?.focus();
  };

  const pickSlash = (cmd: SlashCommandItem) => {
    setPopover("none");
    setSlashQuery("");
    if (cmd.action === "new_session") {
      onInputChange("");
      onNewSession();
      return;
    }
    if (cmd.action === "open_workspace") {
      onInputChange("");
      onOpenWorkspace();
      return;
    }
    if (cmd.prompt && !sendBlocked && !settingsBusy && !uploadingImages && !authUnavailable) {
      onInputChange("");
      onSend(cmd.prompt);
    }
  };

  const handleInterceptKeyDown = (e: React.KeyboardEvent<HTMLElement>): boolean => {
    if (popover === "mention" && filteredMentions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filteredMentions.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filteredMentions.length) % filteredMentions.length);
        return true;
      }
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const chosen = filteredMentions[activeIndex % filteredMentions.length];
        if (chosen) pickMention(chosen);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPopover("none");
        return true;
      }
    }

    if (popover === "slash" && filteredSlash.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filteredSlash.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filteredSlash.length) % filteredSlash.length);
        return true;
      }
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const chosen = filteredSlash[activeIndex % filteredSlash.length];
        if (chosen) pickSlash(chosen);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPopover("none");
        return true;
      }
    }

    return false;
  };

  const hasImageAttachment = attachments.some((a) => a.kind === "image");
  const canSend =
    !sendBlocked &&
    !settingsBusy &&
    !uploadingImages &&
    (Boolean(input.trim()) || hasImageAttachment) &&
    !authUnavailable;

  const handleSubmitFromEditor = () => {
    if (canSend) {
      onSend();
    }
  };

  return (
    <div ref={barRef} className="relative">
      {/* Mention Popover (@) */}
      {popover === "mention" && (
        <div className="absolute left-0 right-0 sm:right-auto sm:w-[380px] bottom-full mb-2 z-30 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--rd-shadow-lg)] overflow-hidden animate-popover-in-up">
          <div className="px-2.5 py-2 border-b border-[var(--border-subtle)] flex items-center gap-2 bg-[var(--surface-subtle)]/50">
            <Icon name="search" size={13} className="text-[var(--text-muted)] shrink-0" />
            <input
              value={mentionQuery}
              onChange={(e) => {
                setMentionQuery(e.target.value);
                setActiveIndex(0);
              }}
              placeholder="筛选文件、数据库或工单…"
              className="flex-1 bg-transparent text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
            <span className="hidden sm:inline text-[10.5px] font-mono text-[var(--text-muted)]">↑↓ ↵</span>
          </div>
          <div className="flex border-b border-[var(--border-subtle)] text-[11.5px] px-1.5 pt-1 gap-0.5 overflow-x-auto no-scrollbar whitespace-nowrap">
            {(
              [
                { id: "all", label: `全部 (${allMentions.length})` },
                { id: "files", label: `文件 (${workspaceFiles.length})` },
                { id: "databases", label: `数据库 (${workspaceDatabases.length})` },
                { id: "tasks", label: `工单 (${openTasks.length})` },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setMentionTab(t.id);
                  setActiveIndex(0);
                }}
                className={cn(
                  "px-2 py-1.5 rounded-t-md font-medium transition cursor-pointer shrink-0",
                  mentionTab === t.id
                    ? "text-[var(--text-primary)] border-b-2 border-indigo-500"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="max-h-[45dvh] sm:max-h-56 overflow-y-auto rd-scroll p-1.5 space-y-0.5">
            {filteredMentions.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-[var(--text-muted)]">
                未找到匹配的上下文资源
              </div>
            ) : (
              filteredMentions.slice(0, 30).map((entry, idx) => {
                const checked = attachments.some(
                  (a) => a.kind === entry.ref.kind && a.ref === entry.ref.ref,
                );
                const highlighted = idx === activeIndex % filteredMentions.length;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => pickMention(entry)}
                    className={cn(
                      "w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 text-left text-[12px] transition-colors cursor-pointer",
                      highlighted ? "bg-[var(--surface-hover)]" : "hover:bg-[var(--surface-hover)]",
                    )}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Icon
                        name={
                          entry.kind === "database"
                            ? "database"
                            : entry.kind === "task"
                              ? "inbox"
                              : "file-text"
                        }
                        size={13}
                        className="text-[var(--text-muted)] shrink-0"
                      />
                      <span className="min-w-0">
                        <span className={cn("block truncate text-[var(--text-primary)]", entry.kind === "file" && "font-mono text-[11.5px]")}>
                          {entry.title}
                        </span>
                        {entry.subtitle && (
                          <span className="block text-[10.5px] text-[var(--text-muted)] truncate">
                            {entry.subtitle}
                          </span>
                        )}
                      </span>
                    </span>
                    {checked && (
                      <Icon name="check" size={13} className="text-indigo-500 shrink-0" />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Slash Command Popover (/) */}
      {popover === "slash" && (
        <div className="absolute left-0 right-0 sm:right-auto sm:w-[360px] bottom-full mb-2 z-30 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--rd-shadow-lg)] overflow-hidden animate-popover-in-up">
          <div className="px-3 py-1.5 border-b border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)] bg-[var(--surface-subtle)]/50">
            <span>快捷指令</span>
            <span className="hidden sm:inline font-mono">↑↓ ↵</span>
          </div>
          <div className="max-h-[45dvh] sm:max-h-60 overflow-y-auto rd-scroll p-1.5 space-y-0.5">
            {filteredSlash.length === 0 ? (
              <div className="py-5 text-center text-[12px] text-[var(--text-muted)]">
                无匹配指令
              </div>
            ) : (
              filteredSlash.map((cmd, idx) => {
                const highlighted = idx === activeIndex % filteredSlash.length;
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => pickSlash(cmd)}
                    className={cn(
                      "w-full px-2.5 py-2 rounded-lg flex items-start gap-2.5 text-left transition-colors cursor-pointer",
                      highlighted ? "bg-[var(--surface-hover)]" : "hover:bg-[var(--surface-hover)]",
                    )}
                  >
                    <Icon name={cmd.icon} size={14} className="text-indigo-500 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[12px] font-medium text-[var(--text-primary)]">
                          {cmd.command}
                        </span>
                        <span className="text-[12px] text-[var(--text-secondary)]">
                          {cmd.label}
                        </span>
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
                        {cmd.description}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Outer Execution Environment Bar (above composer card) */}
      <div className="mb-2 px-0.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {onChangeExecutionTarget && (
            <ExecutionTargetSelect
              projectId={projectId}
              runtime={runtime}
              runtimeInfo={runtimeInfo}
              executionTarget={executionTarget ?? "auto"}
              disabled={streaming || settingsBusy}
              onChangeExecutionTarget={onChangeExecutionTarget}
              onOpenChange={() => setPopover("none")}
            />
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Sandbox Mode Toggle Pill */}
          <button
            type="button"
            disabled={streaming || settingsBusy}
            onClick={() =>
              onChangeSandboxMode(sandboxMode === "read-only" ? "workspace-write" : "read-only")
            }
            title={
              sandboxMode === "workspace-write"
                ? "当前允许编辑项目空间文件；点击切回只读探索"
                : "当前为只读探索模式；点击切为可写项目空间"
            }
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[11.5px] font-medium transition-colors cursor-pointer disabled:opacity-50",
              sandboxMode === "workspace-write"
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/18"
                : "border-[var(--border-subtle)] bg-[var(--surface-card)]/90 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]",
            )}
          >
            <Icon
              name={sandboxMode === "workspace-write" ? "pen-line" : "shield-check"}
              size={12}
            />
            <span>{sandboxMode === "workspace-write" ? "可写空间" : "只读"}</span>
          </button>

          {/* Codex Network Toggle Pill */}
          {runtime === "codex" && (
            <button
              type="button"
              disabled={streaming || settingsBusy}
              onClick={onToggleNetworkAccess}
              title={
                networkAccess
                  ? "已放开 Codex 沙箱联网，可直连外部数据库或网络；点击关闭"
                  : "Codex 沙箱默认断网；点击允许联网"
              }
              className={cn(
                "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[11.5px] font-medium transition-colors cursor-pointer disabled:opacity-50",
                networkAccess
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/18"
                  : "border-[var(--border-subtle)] bg-[var(--surface-card)]/90 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]",
              )}
            >
              <Icon name={networkAccess ? "wifi" : "wifi-off"} size={12} />
              <span className="hidden sm:inline">{networkAccess ? "联网" : "断网"}</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Composer Card */}
      <div
        onDragOver={(e) => {
          if (!onUploadImages) return;
          if (Array.from(e.dataTransfer.types ?? []).includes("Files")) {
            e.preventDefault();
            if (!dragOverImage) setDragOverImage(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDragOverImage(false);
          }
        }}
        onDrop={(e) => {
          setDragOverImage(false);
          if (!onUploadImages) return;
          const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"));
          if (files.length > 0) {
            e.preventDefault();
            onUploadImages(files);
          }
        }}
        className={cn(
          "rounded-2xl border bg-[var(--surface-elevated)] shadow-[var(--rd-shadow-md)] focus-within:border-[var(--border-strong)] focus-within:ring-2 focus-within:ring-[var(--rd-ring)]/40 transition-all",
          dragOverImage
            ? "border-indigo-500 ring-2 ring-indigo-500/30"
            : "border-[var(--border-subtle)]",
        )}
      >
        {/* Attached Context Chips inside Composer */}
        {attachments.length > 0 && (
          <div className="px-3 pt-2.5 pb-0.5 flex flex-wrap items-center gap-1.5">
            {attachments.map((att) =>
              att.kind === "image" && projectId ? (
                <div
                  key={`${att.kind}:${att.ref}`}
                  className="relative group inline-flex items-center rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-1 animate-fade-in"
                >
                  <a
                    href={`/api/projects/${encodeURIComponent(projectId)}/workspace/file?path=${encodeURIComponent(att.ref)}&inline=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                  >
                    <img
                      src={`/api/projects/${encodeURIComponent(projectId)}/workspace/file?path=${encodeURIComponent(att.ref)}&inline=1`}
                      alt={att.label}
                      className="h-12 w-12 rounded-lg object-cover bg-[var(--surface-card)]"
                    />
                  </a>
                  <button
                    type="button"
                    aria-label={`移除 ${att.label}`}
                    onClick={() => onToggleAttachment(att)}
                    className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-[var(--surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] flex items-center justify-center shadow-xs transition cursor-pointer"
                  >
                    <Icon name="x" size={10} />
                  </button>
                </div>
              ) : (
                <span
                  key={`${att.kind}:${att.ref}`}
                  className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-[7px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[11.5px] font-mono text-[var(--text-secondary)] animate-fade-in"
                >
                  <Icon
                    name={
                      att.kind === "database"
                        ? "database"
                        : att.kind === "task"
                          ? "inbox"
                          : "file-text"
                    }
                    size={11}
                    className="text-indigo-500 shrink-0"
                  />
                  <span className="max-w-[200px] truncate">{att.label}</span>
                  <button
                    type="button"
                    aria-label={`移除 ${att.label}`}
                    onClick={() => onToggleAttachment(att)}
                    className="p-0.5 rounded hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition cursor-pointer"
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ),
            )}
          </div>
        )}

        {/* Rich Markdown Composer (auto-converts `inline` & ```code blocks```) */}
        <RichPromptEditor
          ref={composerRef}
          value={input}
          onChange={handleChange}
          onSubmit={handleSubmitFromEditor}
          onInterceptKeyDown={handleInterceptKeyDown}
          onPasteImages={onUploadImages}
          placeholder={`向 ${runtime === "codex" ? "Codex" : "Claude"} 提问，支持粘贴/拖入图片、\`代码\`、@ 引用、/ 快捷指令…`}
        />

        {/* Inner Bottom Action Pill Bar */}
        <div className="px-2 sm:px-2.5 pb-2 pt-0.5 flex items-center justify-between gap-1.5 sm:gap-2">
          <div className="flex items-center gap-0.5 sm:gap-1 min-w-0 flex-1">
            {onUploadImages && (
              <>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    if (files.length > 0) onUploadImages(files);
                  }}
                />
                <button
                  type="button"
                  disabled={uploadingImages}
                  onClick={() => imageInputRef.current?.click()}
                  title="上传图片（也支持粘贴或拖入）"
                  aria-label="上传图片"
                  className={cn(
                    "inline-flex items-center justify-center gap-1 h-8 w-8 sm:w-auto sm:h-7 sm:px-2 rounded-lg text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-50 shrink-0",
                    hasImageAttachment
                      ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
                  )}
                >
                  <Icon
                    name={uploadingImages ? "loader-2" : "image"}
                    size={14}
                    className={uploadingImages ? "animate-spin" : ""}
                  />
                  <span className="hidden sm:inline">{uploadingImages ? "上传中" : "图片"}</span>
                </button>
              </>
            )}
            {/* @ Mention Button */}
            <button
              type="button"
              onClick={() => {
                setPopover((p) => (p === "mention" ? "none" : "mention"));
                setActiveIndex(0);
              }}
              title="引用项目空间文件、数据库或工单 (@)"
              className={cn(
                "inline-flex items-center justify-center gap-1 h-8 px-2 sm:h-7 rounded-lg text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-50 shrink-0",
                popover === "mention" || attachments.length > 0
                  ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
              )}
            >
              <Icon name="at-sign" size={14} />
              <span className="hidden sm:inline">引用</span>
              {attachments.length > 0 && (
                <span className="font-mono text-[10.5px] px-1 rounded bg-indigo-500/15">
                  {attachments.length}
                </span>
              )}
            </button>

            {/* / Slash Command Button */}
            <button
              type="button"
              onClick={() => {
                setPopover((p) => (p === "slash" ? "none" : "slash"));
                setSlashQuery("");
                setActiveIndex(0);
              }}
              title="快捷指令 (/)"
              className={cn(
                "inline-flex items-center justify-center h-8 w-8 sm:h-7 sm:w-7 rounded-lg text-[12px] font-mono font-medium transition-colors cursor-pointer disabled:opacity-50 shrink-0",
                popover === "slash"
                  ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
              )}
            >
              /
            </button>

            <span className="h-3.5 w-px bg-[var(--border-subtle)] mx-0.5 shrink-0" />

            <ModelControls
              projectId={projectId}
              runtime={runtime}
              runtimeInfo={runtimeInfo}
              model={model}
              effort={effort}
              executionTarget={executionTarget}
              onChangeModel={onChangeModel}
              onChangeEffort={onChangeEffort}
              onChangeExecutionTarget={onChangeExecutionTarget}
              open={popover === "runtime"}
              setOpen={(open) => setPopover(open ? "runtime" : "none")}
              disabled={streaming || settingsBusy}
              onOpenCliSettings={onOpenCliSettings}
            />
          </div>

          {/* Right Side: Streaming hint + Send/Stop Pill */}
          <div className="flex items-center gap-2 shrink-0">
            {streaming && statusLine ? (
              <span className="hidden md:inline text-[11.5px] text-[var(--text-muted)] truncate max-w-[180px]">
                {statusLine}
              </span>
            ) : (
              <span className="hidden md:inline text-[11px] text-[var(--text-muted)] select-none whitespace-nowrap">
                Enter 发送 · Shift+Enter 换行
              </span>
            )}

            {streaming && (
              <button
                type="button"
                disabled={stopBlocked}
                onClick={onAbort}
                title="停止生成"
                aria-label="停止生成"
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-rose-500/12 text-rose-600 dark:text-rose-400 border border-rose-500/25 enabled:hover:bg-rose-600 enabled:hover:text-white text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Icon name="square" size={10} />
                <span>停止</span>
              </button>
            )}
            <button
              type="button"
              disabled={!canSend}
              onClick={() => onSend()}
              title={streaming ? "停止当前回复并发送追问" : "发送消息"}
              aria-label={streaming ? "停止当前回复并发送追问" : "发送消息"}
              className={cn(
                "inline-flex items-center justify-center h-7 w-7 rounded-full transition-all",
                canSend
                  ? "bg-[var(--rd-ink)] text-[var(--rd-surface)] hover:opacity-90 shadow-xs cursor-pointer"
                  : "bg-[var(--surface-subtle)] text-[var(--text-muted)] opacity-60 cursor-not-allowed",
              )}
            >
              <Icon name="arrow-up" size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
