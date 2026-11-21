import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatContextRef,
  ChatRuntime,
  ChatRuntimeInfo,
  ChatSandboxMode,
  ChatToolEvent,
  TaskRecord,
  WorkspaceDatabaseEntry,
  WorkspaceFileEntry,
} from "~/lib/types.ts";
import { Icon } from "../Icon.tsx";
import { LivePulseDot } from "../ui.tsx";

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
  kind: "status" | "reasoning";
  text: string;
}

export function ThinkingTrace({
  active,
  statusLabel,
  entries,
  startedAt,
  durationMs,
}: {
  active: boolean;
  statusLabel: string;
  entries: TraceEntry[];
  startedAt?: number;
  durationMs?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  // Auto-collapse once settled if user didn't open it explicitly
  const hasEntries = entries.length > 0;
  if (!active && !hasEntries) return null;

  const settledSummary = durationMs
    ? `已思考 ${formatElapsed(durationMs)}`
    : entries.length > 0
      ? `推理过程 · ${entries.length} 条记录`
      : "已完成推理";

  return (
    <div className="mb-2.5">
      <button
        type="button"
        onClick={() => hasEntries && setExpanded((v) => !v)}
        disabled={!hasEntries && !active}
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
          <Icon
            name="chevron-down"
            size={13}
            className={cn(
              "text-[var(--text-muted)] transition-transform duration-200",
              expanded ? "rotate-180" : "rotate-0",
            )}
          />
        )}
      </button>

      {hasEntries && (expanded || (active && entries.some((e) => e.kind === "reasoning"))) && (
        <div className="mt-1.5 ml-1 pl-3 border-l border-[var(--border-subtle)] space-y-1.5 animate-fade-in">
          {(expanded ? entries : entries.slice(-2)).map((item) => (
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
                          "px-1.5 py-0.5 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-primary)] truncate max-w-[440px]",
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

export interface PromptBarProps {
  input: string;
  onInputChange: (value: string) => void;
  attachments: ChatContextRef[];
  onToggleAttachment: (ref: ChatContextRef) => void;
  workspaceFiles: WorkspaceFileEntry[];
  workspaceDatabases: WorkspaceDatabaseEntry[];
  openTasks: TaskRecord[];
  runtime: ChatRuntime;
  runtimeInfo: ChatRuntimeInfo | null;
  sandboxMode: ChatSandboxMode;
  networkAccess: boolean;
  streaming: boolean;
  statusLine: string;
  authUnavailable: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onChangeRuntime: (rt: ChatRuntime) => void;
  onChangeSandboxMode: (mode: ChatSandboxMode) => void;
  onToggleNetworkAccess: () => void;
  onOpenCliSettings: () => void;
  onOpenWorkspace: () => void;
  onNewSession: () => void;
  onSend: (promptOverride?: string) => void;
  onAbort: () => void;
}

export function PromptBar({
  input,
  onInputChange,
  attachments,
  onToggleAttachment,
  workspaceFiles,
  workspaceDatabases,
  openTasks,
  runtime,
  runtimeInfo,
  sandboxMode,
  networkAccess,
  streaming,
  statusLine,
  authUnavailable,
  textareaRef,
  onChangeRuntime,
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
  const barRef = useRef<HTMLDivElement>(null);

  // Auto-resize textarea smoothly
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, 44), 184);
    el.style.height = `${next}px`;
  }, [input, textareaRef]);

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
    textareaRef.current?.focus();
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
    if (cmd.prompt) {
      onInputChange("");
      onSend(cmd.prompt);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (popover === "mention" && filteredMentions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filteredMentions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filteredMentions.length) % filteredMentions.length);
        return;
      }
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const chosen = filteredMentions[activeIndex % filteredMentions.length];
        if (chosen) pickMention(chosen);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPopover("none");
        return;
      }
    }

    if (popover === "slash" && filteredSlash.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filteredSlash.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filteredSlash.length) % filteredSlash.length);
        return;
      }
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const chosen = filteredSlash[activeIndex % filteredSlash.length];
        if (chosen) pickSlash(chosen);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPopover("none");
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!streaming && input.trim() && !authUnavailable) {
        onSend();
      }
    }
  };

  const activeModel =
    runtimeInfo?.project_cli.runtime === runtime && runtimeInfo.project_cli.model
      ? runtimeInfo.project_cli.model
      : "";
  const runtimeMode = runtimeInfo?.auth_mode[runtime] ?? "unavailable";
  const canSend = !streaming && Boolean(input.trim()) && !authUnavailable;

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
            <span className="text-[10.5px] font-mono text-[var(--text-muted)]">↑↓ ↵</span>
          </div>
          <div className="flex border-b border-[var(--border-subtle)] text-[11.5px] px-1.5 pt-1 gap-0.5">
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
                  "px-2 py-1.5 rounded-t-md font-medium transition cursor-pointer",
                  mentionTab === t.id
                    ? "text-[var(--text-primary)] border-b-2 border-indigo-500"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="max-h-56 overflow-y-auto rd-scroll p-1.5 space-y-0.5">
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
            <span className="font-mono">↑↓ ↵</span>
          </div>
          <div className="max-h-60 overflow-y-auto rd-scroll p-1.5 space-y-0.5">
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

      {/* Runtime / Model Popover */}
      {popover === "runtime" && (
        <div className="absolute left-0 sm:left-20 bottom-full mb-2 z-30 w-[260px] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--rd-shadow-lg)] overflow-hidden animate-popover-in-up">
          <div className="px-3 py-1.5 border-b border-[var(--border-subtle)] text-[11px] font-medium text-[var(--text-muted)] bg-[var(--surface-subtle)]/50">
            选择对话运行引擎
          </div>
          <div className="p-1.5 space-y-0.5">
            {(
              [
                {
                  id: "claude" as const,
                  name: "Claude Code",
                  desc: "Anthropic 兼容端点 · 工具链稳定",
                },
                {
                  id: "codex" as const,
                  name: "Codex CLI",
                  desc: "OpenAI Responses API · 沙箱隔离",
                },
              ]
            ).map((opt) => {
              const mode = runtimeInfo?.auth_mode[opt.id] ?? "unavailable";
              const isSelected = runtime === opt.id;
              const optModel =
                runtimeInfo?.project_cli.runtime === opt.id && runtimeInfo.project_cli.model
                  ? runtimeInfo.project_cli.model
                  : "";
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={streaming}
                  onClick={() => {
                    onChangeRuntime(opt.id);
                    setPopover("none");
                  }}
                  className={cn(
                    "w-full px-2.5 py-2 rounded-lg flex items-start justify-between gap-2 text-left transition-colors cursor-pointer",
                    isSelected ? "bg-indigo-500/10" : "hover:bg-[var(--surface-hover)]",
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-primary)]">
                      <LivePulseDot
                        tone={mode === "unavailable" ? "zinc" : "emerald"}
                        active={mode !== "unavailable"}
                      />
                      <span>{opt.name}</span>
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5 truncate">
                      {optModel ? `模型：${optModel}` : opt.desc}
                    </div>
                  </div>
                  {isSelected && <Icon name="check" size={14} className="text-indigo-500 mt-0.5 shrink-0" />}
                </button>
              );
            })}
          </div>
          <div className="border-t border-[var(--border-subtle)] p-1.5">
            <button
              type="button"
              onClick={() => {
                setPopover("none");
                onOpenCliSettings();
              }}
              className="w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5">
                <Icon name="sliders-horizontal" size={12} />
                配置 API 地址与自定义模型
              </span>
              <Icon name="chevron-right" size={12} className="text-[var(--text-muted)]" />
            </button>
          </div>
        </div>
      )}

      {/* Main Composer Card */}
      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] shadow-[var(--rd-shadow-md)] focus-within:border-[var(--border-strong)] focus-within:ring-2 focus-within:ring-[var(--rd-ring)]/40 transition-all">
        {/* Attached Context Chips inside Composer */}
        {attachments.length > 0 && (
          <div className="px-3 pt-2.5 pb-0.5 flex flex-wrap items-center gap-1.5">
            {attachments.map((att) => (
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
            ))}
          </div>
        )}

        {/* Auto-growing Prompt Textarea */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          disabled={streaming}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`向 ${runtime === "codex" ? "Codex" : "Claude"} 提问，输入 @ 引用文件/数据库，或 / 使用快捷指令…`}
          className="w-full px-3.5 pt-3 pb-2 bg-transparent text-[13.5px] leading-[1.55] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-none focus:outline-none max-h-[184px] rd-scroll"
        />

        {/* Bottom Action Pill Bar */}
        <div className="px-2.5 pb-2 pt-0.5 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            {/* @ Mention Button */}
            <button
              type="button"
              disabled={streaming}
              onClick={() => {
                setPopover((p) => (p === "mention" ? "none" : "mention"));
                setActiveIndex(0);
              }}
              title="引用项目空间文件、数据库或工单 (@)"
              className={cn(
                "inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-50",
                popover === "mention" || attachments.length > 0
                  ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
              )}
            >
              <Icon name="at-sign" size={13} />
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
              disabled={streaming}
              onClick={() => {
                setPopover((p) => (p === "slash" ? "none" : "slash"));
                setSlashQuery("");
                setActiveIndex(0);
              }}
              title="快捷指令 (/)"
              className={cn(
                "inline-flex items-center justify-center h-7 w-7 rounded-lg text-[12px] font-mono font-medium transition-colors cursor-pointer disabled:opacity-50",
                popover === "slash"
                  ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
              )}
            >
              /
            </button>

            <span className="h-3.5 w-px bg-[var(--border-subtle)] mx-0.5" />

            {/* Compact Runtime / Model Pill */}
            <button
              type="button"
              disabled={streaming}
              onClick={() => setPopover((p) => (p === "runtime" ? "none" : "runtime"))}
              className={cn(
                "inline-flex items-center gap-1.5 h-7 px-2 rounded-lg text-[12px] font-medium transition-colors cursor-pointer disabled:opacity-50",
                popover === "runtime"
                  ? "bg-[var(--surface-hover)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
              )}
              title="切换 CLI 运行工具与模型"
            >
              <LivePulseDot
                tone={runtimeMode === "unavailable" ? "zinc" : "emerald"}
                active={runtimeMode !== "unavailable"}
              />
              <span>{runtime === "codex" ? "Codex" : "Claude"}</span>
              {activeModel && (
                <span className="hidden md:inline font-mono text-[11px] text-[var(--text-muted)] max-w-[120px] truncate">
                  · {activeModel}
                </span>
              )}
              <Icon name="chevron-down" size={11} className="text-[var(--text-muted)]" />
            </button>

            {/* Sandbox Mode Toggle Pill */}
            <button
              type="button"
              disabled={streaming}
              onClick={() =>
                onChangeSandboxMode(sandboxMode === "read-only" ? "workspace-write" : "read-only")
              }
              title={
                sandboxMode === "workspace-write"
                  ? "当前允许编辑项目空间文件；点击切回只读探索"
                  : "当前为只读探索模式；点击切为可写项目空间"
              }
              className={cn(
                "inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[11.5px] font-medium transition-colors cursor-pointer disabled:opacity-50",
                sandboxMode === "workspace-write"
                  ? "bg-amber-500/12 text-amber-700 dark:text-amber-300 hover:bg-amber-500/18"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
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
                disabled={streaming}
                onClick={onToggleNetworkAccess}
                title={
                  networkAccess
                    ? "已放开 Codex 沙箱联网，可直连外部数据库或网络；点击关闭"
                    : "Codex 沙箱默认断网；点击允许联网"
                }
                className={cn(
                  "inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[11.5px] font-medium transition-colors cursor-pointer disabled:opacity-50",
                  networkAccess
                    ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/18"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
                )}
              >
                <Icon name={networkAccess ? "wifi" : "wifi-off"} size={12} />
                <span className="hidden sm:inline">{networkAccess ? "联网" : "断网"}</span>
              </button>
            )}
          </div>

          {/* Right Side: Streaming hint + Send/Stop Pill */}
          <div className="flex items-center gap-2 ml-auto">
            {streaming && statusLine ? (
              <span className="hidden md:inline text-[11.5px] text-[var(--text-muted)] truncate max-w-[200px]">
                {statusLine}
              </span>
            ) : (
              <span className="hidden sm:inline text-[11px] text-[var(--text-muted)] select-none">
                Enter 发送 · Shift+Enter 换行
              </span>
            )}

            {streaming ? (
              <button
                type="button"
                onClick={onAbort}
                title="停止生成"
                aria-label="停止生成"
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-rose-500/12 text-rose-600 dark:text-rose-400 border border-rose-500/25 hover:bg-rose-600 hover:text-white hover:border-rose-600 text-[12px] font-medium transition-colors cursor-pointer"
              >
                <Icon name="square" size={10} />
                <span>停止</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={!canSend}
                onClick={() => onSend()}
                title="发送消息"
                aria-label="发送消息"
                className={cn(
                  "inline-flex items-center justify-center h-7 w-7 rounded-full transition-all",
                  canSend
                    ? "bg-[var(--rd-ink)] text-[var(--rd-surface)] hover:opacity-90 shadow-xs cursor-pointer"
                    : "bg-[var(--surface-subtle)] text-[var(--text-muted)] opacity-60 cursor-not-allowed",
                )}
              >
                <Icon name="arrow-up" size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
