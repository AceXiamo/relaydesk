import { useMemo, useRef } from "react";
import { Icon } from "./Icon.tsx";
import {
  Button,
  DeliveryModeBadge,
  EmptyState,
  Kbd,
  LivePulseDot,
  OwnerChip,
  PriorityBadge,
  ResolutionBadge,
  Select,
  SourceBadge,
  StatusBadge,
  type SelectOption,
} from "./ui.tsx";
import {
  PRIORITY_WEIGHT,
  STATUS_LABELS,
  STATUS_ORDER,
  formatRelativeTime,
  taskCode,
} from "~/lib/format.ts";
import type {
  ProjectDetail,
  TaskRecord,
  TaskSource,
  TaskStatus,
  WorkspaceView,
} from "~/lib/types.ts";

export type SortMode = "updated" | "priority" | "number";
export type CockpitFilter = "" | "auto_pending" | "attention";

interface TaskQueueViewProps {
  project: ProjectDetail | null;
  tasks: TaskRecord[];
  view: WorkspaceView;
  selectedTaskId: string | null;
  search: string;
  statusFilter: TaskStatus | "";
  sourceFilter: TaskSource | "";
  cockpitFilter?: CockpitFilter;
  sortMode: SortMode;
  loading: boolean;
  automationBusy?: boolean;
  onSearchChange: (q: string) => void;
  onStatusFilterChange: (s: TaskStatus | "") => void;
  onSourceFilterChange: (s: TaskSource | "") => void;
  onCockpitFilterChange?: (f: CockpitFilter) => void;
  onSortModeChange: (m: SortMode) => void;
  onClearFilters: () => void;
  onSelectTask: (id: string) => void;
  onQuickAction: (
    task: TaskRecord,
    action: "claim" | "ready" | "done",
  ) => Promise<void>;
  onReopenTask: (task: TaskRecord) => Promise<void>;
  onToggleAutomation: (paused: boolean) => Promise<void>;
  onNewFeedback: () => void;
  onNewProject: () => void;
  onRefresh: () => void;
  onNavigateView: (view: WorkspaceView) => void;
  onOpenSkillSetup?: () => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

const VIEW_META: Record<
  Exclude<WorkspaceView, "sources" | "settings">,
  { title: string; subtitle: string; emptyTitle: string; emptyDesc: string }
> = {
  queue: {
    title: "全部任务",
    subtitle: "所有反馈自动进入流水线，由服务端预筛与 Local Agent 自主研判、修复并交付。",
    emptyTitle: "当前队列为空",
    emptyDesc: "新建一条反馈，或前往「收集入口」嵌入反馈组件与 Telegram 机器人。",
  },
  triage: {
    title: "待整理",
    subtitle: "新入库的反馈会由服务端 AI 预筛并由 Local Agent 自动认领，无需人工逐条转状态。",
    emptyTitle: "没有待整理的新反馈",
    emptyDesc: "所有新反馈都已被自动分流或交付闭环。",
  },
  mine: {
    title: "我的任务",
    subtitle: "你主动接手或认领跟进的任务。",
    emptyTitle: "你还没有认领任何任务",
    emptyDesc: "需要人工介入时，在任务行点击「我来处理」即可将任务归入这里。",
  },
  agents: {
    title: "Agent 执行",
    subtitle: "本机 Coding Agent 正在自主执行或持有租约的任务。",
    emptyTitle: "当前没有活跃的 Local Agent 任务",
    emptyDesc: "新反馈入库后会自动由本机 Agent 定时巡检领取，也可前往「设置」配置 1:1 定时任务。",
  },
  review: {
    title: "待验收",
    subtitle: "「仅提交验收」模式下完成改动、等待你确认闭环的任务。",
    emptyTitle: "没有待验收的任务",
    emptyDesc: "当交付模式设为「仅提交验收」时，Agent 完成修复后会出现在这里。",
  },
};

const COCKPIT_FILTER_LABELS: Record<Exclude<CockpitFilter, "">, string> = {
  auto_pending: "自动待消费",
  attention: "异常 / 待看",
};

function isAutoPendingTask(t: TaskRecord): boolean {
  return (
    !t.merged_into &&
    (t.status === "triage" || t.status === "ready") &&
    t.owner === "none" &&
    t.attempts < 3
  );
}

function isAttentionTask(t: TaskRecord): boolean {
  return (
    !t.merged_into &&
    (t.status === "waiting" || t.status === "review" || t.status === "handoff")
  );
}

interface DeliveryRefChip {
  label: string;
  icon: "git-pull-request" | "git-commit-horizontal";
  isPr: boolean;
  href?: string;
}

function formatDeliveryRef(raw: string | null | undefined): DeliveryRefChip | null {
  const ref = raw?.trim();
  if (!ref) return null;

  const prUrlMatch = ref.match(/\/pull\/(\d+)/i);
  if (prUrlMatch) {
    return {
      label: `PR #${prUrlMatch[1]}`,
      icon: "git-pull-request",
      isPr: true,
      href: ref,
    };
  }

  const prTextMatch = ref.match(/^(?:pr\s*)?#(\d+)$/i);
  if (prTextMatch) {
    return {
      label: `PR #${prTextMatch[1]}`,
      icon: "git-pull-request",
      isPr: true,
    };
  }

  const commitUrlMatch = ref.match(/\/commit\/([0-9a-f]{7,40})/i);
  if (commitUrlMatch) {
    return {
      label: commitUrlMatch[1].slice(0, 7),
      icon: "git-commit-horizontal",
      isPr: false,
      href: ref,
    };
  }

  if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    return {
      label: ref.slice(0, 7),
      icon: "git-commit-horizontal",
      isPr: false,
    };
  }

  const href = /^https?:\/\//i.test(ref) ? ref : undefined;
  return {
    label: ref.length > 18 ? `${ref.slice(0, 17)}…` : ref,
    icon: "git-commit-horizontal",
    isPr: false,
    href,
  };
}

export function filterTasksForView(
  tasks: TaskRecord[],
  view: WorkspaceView,
  search: string,
  statusFilter: TaskStatus | "",
  sourceFilter: TaskSource | "",
  sortMode: SortMode,
  cockpitFilter: CockpitFilter = "",
): TaskRecord[] {
  const q = search.trim().toLowerCase();
  const base = tasks.filter((t) => {
    if (t.merged_into) return false;
    if (view === "triage" && t.status !== "triage") return false;
    if (view === "mine" && !(t.owner === "human" && t.status !== "done")) return false;
    if (view === "agents" && t.owner !== "agent") return false;
    if (view === "review" && t.status !== "review") return false;
    if (view === "queue" && cockpitFilter === "auto_pending" && !isAutoPendingTask(t)) {
      return false;
    }
    if (view === "queue" && cockpitFilter === "attention" && !isAttentionTask(t)) {
      return false;
    }
    if (statusFilter && t.status !== statusFilter) return false;
    if (sourceFilter && t.source !== sourceFilter) return false;
    if (q) {
      const hay =
        `${taskCode(t.number)} ${t.title} ${t.body} ${t.requirements} ${t.delivery_ref}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return [...base].sort((a, b) => {
    if (sortMode === "priority") {
      const diff = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
      if (diff !== 0) return diff;
      return b.number - a.number;
    }
    if (sortMode === "number") {
      return b.number - a.number;
    }
    return b.updated_at.localeCompare(a.updated_at) || b.number - a.number;
  });
}

export function TaskQueueView({
  project,
  tasks,
  view,
  selectedTaskId,
  search,
  statusFilter,
  sourceFilter,
  cockpitFilter = "",
  sortMode,
  loading,
  automationBusy = false,
  onSearchChange,
  onStatusFilterChange,
  onSourceFilterChange,
  onCockpitFilterChange,
  onSortModeChange,
  onClearFilters,
  onSelectTask,
  onQuickAction,
  onReopenTask,
  onToggleAutomation,
  onNewFeedback,
  onNewProject,
  onRefresh,
  onNavigateView,
  onOpenSkillSetup,
  searchInputRef,
}: TaskQueueViewProps) {
  const busyIdRef = useRef<string | null>(null);

  const visibleTasks = useMemo(
    () =>
      filterTasksForView(
        tasks,
        view,
        search,
        statusFilter,
        sourceFilter,
        sortMode,
        cockpitFilter,
      ),
    [tasks, view, search, statusFilter, sourceFilter, sortMode, cockpitFilter],
  );

  const metrics = useMemo(() => {
    const active = tasks.filter((t) => !t.merged_into);
    return {
      autoPending: active.filter(isAutoPendingTask).length,
      agent: active.filter((t) => t.owner === "agent").length,
      shipped: active.filter((t) => t.status === "done" && t.resolution === "shipped").length,
      dismissed: active.filter((t) => t.status === "done" && t.resolution === "dismissed")
        .length,
      attention: active.filter(isAttentionTask).length,
    };
  }, [tasks]);

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-lg w-full">
          <EmptyState
            icon="folder-git-2"
            title="欢迎使用 Relaydesk"
            description="先创建一个项目并绑定 GitHub 仓库，即可启用嵌入式反馈组件、Telegram 群收集器与本机 Coding Agent 全自动迭代流水线。"
            action={
              <div className="flex items-center gap-2.5">
                <Button variant="primary" icon="plus" onClick={onNewProject}>
                  创建第一个项目
                </Button>
                <Button
                  variant="secondary"
                  icon="sparkles"
                  onClick={() => onNavigateView("settings")}
                >
                  配置 GitHub 连接
                </Button>
              </div>
            }
          />
        </div>
      </div>
    );
  }

  const paused = project.automation_paused;
  const meta =
    VIEW_META[view as Exclude<WorkspaceView, "sources" | "settings">] ??
    VIEW_META.queue;
  const hasFilters = Boolean(
    search.trim() || statusFilter || sourceFilter || (view === "queue" && cockpitFilter),
  );

  const triggerQuick = async (
    e: React.MouseEvent,
    task: TaskRecord,
    action: "claim" | "ready" | "done" | "reopen",
  ) => {
    e.stopPropagation();
    if (busyIdRef.current === task.id) return;
    busyIdRef.current = task.id;
    try {
      if (action === "reopen") {
        await onReopenTask(task);
      } else {
        await onQuickAction(task, action);
      }
    } finally {
      busyIdRef.current = null;
    }
  };

  const handleSkillLink = () => {
    if (onOpenSkillSetup) {
      onOpenSkillSetup();
    } else {
      onNavigateView("settings");
    }
  };

  const telemetryCards = [
    {
      key: "auto_pending" as const,
      label: "自动待消费",
      count: metrics.autoPending,
      subtitle: paused ? "已暂停" : "无需人工干预，下轮自动领取",
      icon: "zap",
      active: cockpitFilter === "auto_pending",
      pulse: false,
      accentText: paused
        ? "text-amber-600 dark:text-amber-400"
        : "text-indigo-600 dark:text-indigo-400",
      accentBg: paused ? "bg-amber-500/10" : "bg-indigo-500/10",
      activeRing:
        "border-indigo-500/55 ring-1 ring-indigo-500/25 bg-indigo-500/[0.05] dark:bg-indigo-500/[0.08]",
      onClick: () => {
        if (!onCockpitFilterChange) return;
        const next = cockpitFilter === "auto_pending" ? "" : "auto_pending";
        onCockpitFilterChange(next);
        if (next) onStatusFilterChange("");
      },
    },
    {
      key: "agent" as const,
      label: "Agent 执行中",
      count: metrics.agent,
      subtitle: metrics.agent > 0 ? "本机 Agent 持有租约运行中" : "空闲中，等待定时巡检",
      icon: "terminal",
      active: false,
      pulse: metrics.agent > 0,
      accentText: "text-amber-600 dark:text-amber-400",
      accentBg: "bg-amber-500/10",
      activeRing:
        "border-amber-500/55 ring-1 ring-amber-500/25 bg-amber-500/[0.05]",
      onClick: () => onNavigateView("agents"),
    },
    {
      key: "shipped" as const,
      label: "已自动交付",
      count: metrics.shipped,
      subtitle:
        metrics.dismissed > 0
          ? `含 ${metrics.dismissed} 条自动过滤噪音`
          : "验证通过后自动推送闭环",
      icon: "check-circle-2",
      active: statusFilter === "done" && !cockpitFilter,
      pulse: false,
      accentText: "text-emerald-600 dark:text-emerald-400",
      accentBg: "bg-emerald-500/10",
      activeRing:
        "border-emerald-500/55 ring-1 ring-emerald-500/25 bg-emerald-500/[0.05] dark:bg-emerald-500/[0.08]",
      onClick: () => {
        onCockpitFilterChange?.("");
        onStatusFilterChange(statusFilter === "done" ? "" : "done");
      },
    },
    {
      key: "attention" as const,
      label: "异常 / 待看",
      count: metrics.attention,
      subtitle: metrics.attention > 0 ? "重试超限或待补充" : "流水线健康，暂无异常",
      icon: "alert-triangle",
      active: cockpitFilter === "attention",
      pulse: false,
      accentText:
        metrics.attention > 0
          ? "text-rose-600 dark:text-rose-400"
          : "text-[var(--text-muted)]",
      accentBg:
        metrics.attention > 0 ? "bg-rose-500/10" : "bg-[var(--surface-subtle)]",
      activeRing:
        "border-rose-500/55 ring-1 ring-rose-500/25 bg-rose-500/[0.05] dark:bg-rose-500/[0.08]",
      onClick: () => {
        if (!onCockpitFilterChange) return;
        const next = cockpitFilter === "attention" ? "" : "attention";
        onCockpitFilterChange(next);
        if (next) onStatusFilterChange("");
      },
    },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      {/* Page Header */}
      <header className="shrink-0 px-5 lg:px-7 py-4 border-b border-[var(--border-subtle)] bg-[var(--surface-canvas)]">
        {/* Autonomous Pipeline Control Bar */}
        <div
          className={`mb-3.5 px-3.5 py-2 rounded-xl border flex flex-wrap items-center justify-between gap-2.5 transition-colors duration-200 ${
            paused
              ? "border-amber-500/25 bg-amber-500/[0.045] dark:bg-amber-500/[0.06]"
              : "border-emerald-500/20 bg-emerald-500/[0.035] dark:bg-emerald-500/[0.05]"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            <div className="inline-flex items-center gap-2 min-w-0">
              <LivePulseDot tone={paused ? "amber" : "emerald"} active={!paused} />
              <span
                className={`text-[12.5px] font-semibold tracking-tight ${
                  paused
                    ? "text-amber-700 dark:text-amber-300"
                    : "text-emerald-700 dark:text-emerald-300"
                }`}
              >
                {paused ? "自动执行已暂停" : "全自动迭代运行中"}
              </span>
            </div>

            <span
              aria-hidden="true"
              className="hidden sm:inline-block w-px h-3.5 bg-[var(--border-strong)]/70"
            />

            <DeliveryModeBadge mode={project.delivery_mode} compact />

            {metrics.agent > 0 && (
              <button
                type="button"
                onClick={() => onNavigateView("agents")}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/12 text-amber-700 dark:text-amber-300 border border-amber-500/20 hover:bg-amber-500/20 transition-colors cursor-pointer"
              >
                <LivePulseDot tone="amber" active />
                {metrics.agent} 个 Agent 执行中
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={handleSkillLink}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-card)]/80 hover:bg-[var(--surface-card)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] transition-all duration-150 cursor-pointer"
            >
              <Icon name="terminal" size={12.5} className="text-indigo-500" />
              配置 Skill
            </button>

            <button
              type="button"
              disabled={automationBusy}
              onClick={() => void onToggleAutomation(!paused)}
              className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium border transition-all duration-150 cursor-pointer disabled:opacity-50 ${
                paused
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white border-transparent shadow-2xs"
                  : "bg-[var(--surface-card)] text-[var(--text-secondary)] hover:text-amber-700 dark:hover:text-amber-300 border-[var(--border-subtle)] hover:border-amber-500/40"
              }`}
            >
              {automationBusy ? (
                <Icon name="loader-2" size={12.5} className="animate-spin" />
              ) : (
                <Icon name={paused ? "zap" : "pause-circle"} size={12.5} />
              )}
              {paused ? "恢复自动执行" : "暂停自动执行"}
            </button>
          </div>
        </div>

        {/* Title Row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-[18px] font-semibold tracking-tight text-[var(--text-primary)]">
                {meta.title}
              </h1>
              <span className="text-xs font-mono tabular-nums px-2 py-0.5 rounded-full bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-[var(--border-subtle)]">
                {visibleTasks.length}
              </span>
            </div>
            <p className="text-[13px] text-[var(--text-muted)] mt-0.5 truncate">
              {meta.subtitle}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon="refresh-cw"
              onClick={onRefresh}
              loading={loading}
              title="刷新队列"
            >
              刷新
            </Button>
            <Button variant="primary" size="sm" icon="plus" onClick={onNewFeedback}>
              新建反馈
              <span className="hidden sm:inline-flex ml-1 opacity-75">
                <Kbd>N</Kbd>
              </span>
            </Button>
          </div>
        </div>

        {/* Interactive Telemetry Strip (KPI Cards on Queue view) */}
        {view === "queue" && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mt-3.5">
            {telemetryCards.map((card) => (
              <button
                key={card.key}
                type="button"
                onClick={card.onClick}
                className={`group relative flex flex-col justify-between px-3.5 py-2.5 rounded-xl border text-left transition-all duration-150 ease-out cursor-pointer ${
                  card.active
                    ? `${card.activeRing} shadow-2xs`
                    : "border-[var(--border-subtle)] bg-[var(--surface-card)] hover:border-[var(--border-strong)] hover:-translate-y-[1px] hover:shadow-[var(--rd-shadow-sm)]"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--text-muted)]">
                      <span className="truncate">{card.label}</span>
                      {card.pulse && <LivePulseDot tone="amber" active />}
                    </div>
                    <div
                      className={`text-[21px] font-semibold font-mono tabular-nums leading-tight mt-0.5 ${
                        card.key === "shipped" && card.count > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : card.key === "attention" && card.count > 0
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-[var(--text-primary)]"
                      }`}
                    >
                      {card.count}
                    </div>
                  </div>
                  <div
                    className={`w-8 h-8 rounded-lg ${card.accentBg} ${card.accentText} flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform duration-150`}
                  >
                    <Icon name={card.icon} size={15} />
                  </div>
                </div>
                <div className="mt-1.5 text-[11px] text-[var(--text-muted)] truncate">
                  {card.subtitle}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Filter Bar */}
        <div className="flex flex-wrap items-center gap-2 mt-3.5">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Icon
              name="search"
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none"
            />
            <input
              ref={searchInputRef}
              type="search"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="搜索标题、正文、交付引用或 RD-001…"
              className="w-full h-8.5 pl-8.5 pr-10 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 transition"
            />
            {!search && (
              <span className="hidden sm:inline-flex absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                <Kbd>/</Kbd>
              </span>
            )}
          </div>

          {view === "queue" && cockpitFilter && (
            <button
              type="button"
              onClick={() => onCockpitFilterChange?.("")}
              className="inline-flex items-center gap-1.5 h-8.5 px-2.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 text-[12px] font-medium hover:bg-indigo-500/15 transition cursor-pointer"
            >
              <Icon name="filter" size={12} />
              {COCKPIT_FILTER_LABELS[cockpitFilter]}
              <Icon name="x" size={12} className="opacity-75" />
            </button>
          )}

          {view === "queue" && (
            <Select<TaskStatus | "">
              ariaLabel="按状态筛选"
              size="sm"
              minMenuWidth={152}
              value={statusFilter}
              onChange={(val) => {
                onCockpitFilterChange?.("");
                onStatusFilterChange(val);
              }}
              options={
                [
                  {
                    value: "",
                    label: "全部状态",
                    icon: "list-filter",
                  },
                  ...STATUS_ORDER.map((s) => ({
                    value: s,
                    label: STATUS_LABELS[s],
                    dotClassName:
                      s === "triage"
                        ? "bg-zinc-400"
                        : s === "ready"
                          ? "bg-indigo-500 dark:bg-indigo-400"
                          : s === "working"
                            ? "bg-amber-500 dark:bg-amber-400"
                            : s === "handoff"
                              ? "bg-violet-500 dark:bg-violet-400"
                              : s === "waiting"
                                ? "bg-rose-500 dark:bg-rose-400"
                                : s === "review"
                                  ? "bg-emerald-500 dark:bg-emerald-400"
                                  : "bg-zinc-400 dark:bg-zinc-500",
                  })),
                ] satisfies SelectOption<TaskStatus | "">[]
              }
            />
          )}

          <Select<TaskSource | "">
            ariaLabel="按来源筛选"
            size="sm"
            minMenuWidth={150}
            value={sourceFilter}
            onChange={(val) => onSourceFilterChange(val)}
            options={
              [
                { value: "", label: "全部来源", icon: "layers" },
                { value: "widget", label: "应用组件", icon: "message-square" },
                { value: "bot", label: "群聊 Bot", icon: "bot" },
                { value: "console", label: "手动录入", icon: "pen-line" },
              ] satisfies SelectOption<TaskSource | "">[]
            }
          />

          <Select<SortMode>
            ariaLabel="排序方式"
            size="sm"
            minMenuWidth={144}
            leadingIcon="arrow-up-down"
            value={sortMode}
            onChange={(val) => onSortModeChange(val)}
            options={
              [
                { value: "updated", label: "最近更新" },
                { value: "priority", label: "按优先级" },
                { value: "number", label: "按编号" },
              ] satisfies SelectOption<SortMode>[]
            }
          />

          {hasFilters && (
            <Button variant="ghost" size="xs" icon="x" onClick={onClearFilters}>
              清空筛选
            </Button>
          )}
        </div>
      </header>

      {/* Task Rows */}
      <div className="flex-1 overflow-y-auto rd-scroll">
        {visibleTasks.length === 0 ? (
          <div className="py-16 px-6">
            <EmptyState
              icon={hasFilters ? "search" : "inbox"}
              title={hasFilters ? "没有匹配筛选条件的任务" : meta.emptyTitle}
              description={
                hasFilters
                  ? "试试放宽搜索关键词或重置状态与来源筛选。"
                  : meta.emptyDesc
              }
              action={
                hasFilters ? (
                  <Button variant="secondary" size="sm" onClick={onClearFilters}>
                    清空筛选
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      icon="plus"
                      onClick={onNewFeedback}
                    >
                      新建反馈
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="plug"
                      onClick={() => onNavigateView("sources")}
                    >
                      接入收集入口
                    </Button>
                  </div>
                )
              }
            />
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {visibleTasks.map((task) => {
              const selected = task.id === selectedTaskId;
              const isAgentActive = task.owner === "agent";
              const canReopen =
                (task.status === "done" ||
                  task.status === "waiting" ||
                  task.status === "review") &&
                !task.merged_into &&
                task.owner === "none";
              const canQuickDone =
                task.status === "review" && task.owner !== "agent";
              const canQuickClaim =
                task.owner === "none" && task.status !== "done" && !canQuickDone;
              const deliveryChip = formatDeliveryRef(task.delivery_ref);

              return (
                <div
                  key={task.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectTask(task.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectTask(task.id);
                    }
                  }}
                  className={`group relative flex items-center gap-3 px-5 lg:px-7 py-3 transition-colors duration-150 cursor-pointer outline-none focus-visible:bg-[var(--surface-hover)] ${
                    selected
                      ? "bg-indigo-500/[0.06] dark:bg-indigo-500/[0.1]"
                      : isAgentActive
                        ? "bg-amber-500/[0.025] hover:bg-amber-500/[0.055]"
                        : "hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {/* Subtle left accent bar */}
                  <span
                    aria-hidden="true"
                    className={`absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full transition-all duration-150 ${
                      selected
                        ? "bg-indigo-500 opacity-100"
                        : isAgentActive
                          ? "bg-amber-500/80 opacity-100"
                          : "bg-[var(--border-strong)] opacity-0 group-hover:opacity-75"
                    }`}
                  />

                  {/* Priority */}
                  <div className="shrink-0 w-[56px] flex items-center">
                    <PriorityBadge priority={task.priority} />
                  </div>

                  {/* Code */}
                  <span className="shrink-0 w-[64px] text-[12px] font-mono tabular-nums text-[var(--text-muted)]">
                    {taskCode(task.number)}
                  </span>

                  {/* Main title + high-signal metadata */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`text-[13.5px] font-medium truncate transition-colors duration-150 ${
                          task.status === "done"
                            ? "text-[var(--text-muted)] line-through decoration-[var(--border-strong)]"
                            : "text-[var(--text-primary)]"
                        }`}
                      >
                        {task.title}
                      </span>

                      {task.resolution && (
                        <ResolutionBadge
                          resolution={task.resolution}
                          triagedBy={task.triaged_by}
                          compact
                          className="shrink-0"
                        />
                      )}

                      {deliveryChip &&
                        (deliveryChip.href ? (
                          <a
                            href={deliveryChip.href}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title={`交付记录：${task.delivery_ref}`}
                            className={`shrink-0 inline-flex items-center gap-1 text-[10.5px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                              deliveryChip.isPr
                                ? "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20 hover:bg-violet-500/18"
                                : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20 hover:bg-emerald-500/18"
                            }`}
                          >
                            <Icon name={deliveryChip.icon} size={11} />
                            {deliveryChip.label}
                          </a>
                        ) : (
                          <span
                            title={`交付记录：${task.delivery_ref}`}
                            className={`shrink-0 inline-flex items-center gap-1 text-[10.5px] font-mono px-1.5 py-0.5 rounded border ${
                              deliveryChip.isPr
                                ? "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20"
                                : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20"
                            }`}
                          >
                            <Icon name={deliveryChip.icon} size={11} />
                            {deliveryChip.label}
                          </span>
                        ))}

                      {task.attempts > 0 && task.status !== "done" && (
                        <span
                          title={
                            task.attempts >= 3
                              ? "已达到自动重试上限，需人工检查或重新入队"
                              : `Agent 已尝试 ${task.attempts} 次（上限 3 次）`
                          }
                          className={`shrink-0 inline-flex items-center gap-0.5 text-[10.5px] font-mono tabular-nums px-1.5 py-0.5 rounded border ${
                            task.attempts >= 3
                              ? "bg-rose-500/12 text-rose-600 dark:text-rose-400 border-rose-500/25 font-medium"
                              : "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20"
                          }`}
                        >
                          <Icon name="alert-triangle" size={10.5} />
                          重试 {task.attempts}/3
                        </span>
                      )}

                      {task.requirements && (
                        <span
                          title="已填写执行要求"
                          className="shrink-0 inline-flex items-center gap-0.5 text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] text-[var(--text-muted)]"
                        >
                          <Icon name="file-text" size={11} />
                          要求
                        </span>
                      )}
                      {(task.merged_count ?? 0) > 0 && (
                        <span
                          title={`已合并 ${task.merged_count} 条重复反馈`}
                          className="shrink-0 inline-flex items-center gap-0.5 text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] text-[var(--text-muted)]"
                        >
                          <Icon name="git-merge" size={11} />
                          {task.merged_count}
                        </span>
                      )}
                      {(task.message_count ?? 0) > 0 && (
                        <span
                          title={`${task.message_count} 条讨论`}
                          className="shrink-0 inline-flex items-center gap-0.5 text-[10.5px] font-mono text-[var(--text-muted)]"
                        >
                          <Icon name="message-square" size={11} />
                          {task.message_count}
                        </span>
                      )}
                    </div>
                    {task.body && task.body !== task.title && (
                      <p className="text-[12px] text-[var(--text-muted)] truncate mt-0.5">
                        {task.body.replace(/\s+/g, " ")}
                      </p>
                    )}
                  </div>

                  {/* Hover quick actions */}
                  <div className="hidden xl:flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
                    {canReopen && (
                      <button
                        type="button"
                        onClick={(e) => void triggerQuick(e, task, "reopen")}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-medium border border-[var(--border-subtle)] bg-[var(--surface-card)] text-indigo-600 dark:text-indigo-400 hover:border-indigo-500/50 hover:bg-indigo-500/[0.06] transition cursor-pointer"
                      >
                        <Icon name="refresh-cw" size={11} />
                        重新入队
                      </button>
                    )}
                    {canQuickDone && (
                      <button
                        type="button"
                        onClick={(e) => void triggerQuick(e, task, "done")}
                        className="px-2 py-1 rounded-md text-[11.5px] font-medium border border-[var(--border-subtle)] bg-[var(--surface-card)] text-emerald-600 dark:text-emerald-400 hover:border-emerald-500/50 hover:bg-emerald-500/[0.06] transition cursor-pointer"
                      >
                        验收通过
                      </button>
                    )}
                    {canQuickClaim && (
                      <button
                        type="button"
                        onClick={(e) => void triggerQuick(e, task, "claim")}
                        className="px-2 py-1 rounded-md text-[11.5px] font-medium border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition cursor-pointer"
                      >
                        我来处理
                      </button>
                    )}
                  </div>

                  {/* Status + Owner + Source + Updated */}
                  <div className="shrink-0 flex items-center gap-2.5">
                    <StatusBadge status={task.status} />
                    <div className="hidden md:block">
                      <OwnerChip owner={task.owner} lastSeen={task.last_seen} />
                    </div>
                    <div className="hidden sm:block">
                      <SourceBadge source={task.source} />
                    </div>
                    <time
                      className="w-10 text-right text-[11.5px] font-mono tabular-nums text-[var(--text-muted)]"
                      title={task.updated_at}
                    >
                      {formatRelativeTime(task.updated_at)}
                    </time>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
