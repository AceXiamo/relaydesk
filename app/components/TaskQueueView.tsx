import { useMemo, useRef } from "react";
import { Icon } from "./Icon.tsx";
import {
  Button,
  EmptyState,
  Kbd,
  OwnerChip,
  PriorityBadge,
  SourceBadge,
  StatusBadge,
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

interface TaskQueueViewProps {
  project: ProjectDetail | null;
  tasks: TaskRecord[];
  view: WorkspaceView;
  selectedTaskId: string | null;
  search: string;
  statusFilter: TaskStatus | "";
  sourceFilter: TaskSource | "";
  sortMode: SortMode;
  loading: boolean;
  onSearchChange: (q: string) => void;
  onStatusFilterChange: (s: TaskStatus | "") => void;
  onSourceFilterChange: (s: TaskSource | "") => void;
  onSortModeChange: (m: SortMode) => void;
  onClearFilters: () => void;
  onSelectTask: (id: string) => void;
  onQuickAction: (
    task: TaskRecord,
    action: "claim" | "ready" | "done",
  ) => Promise<void>;
  onNewFeedback: () => void;
  onNewProject: () => void;
  onRefresh: () => void;
  onNavigateView: (view: WorkspaceView) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

const VIEW_META: Record<
  Exclude<WorkspaceView, "sources" | "settings">,
  { title: string; subtitle: string; emptyTitle: string; emptyDesc: string }
> = {
  queue: {
    title: "全部任务",
    subtitle: "统一管理应用组件、群聊机器人与手动录入的反馈队列。",
    emptyTitle: "当前队列为空",
    emptyDesc: "新建一条反馈，或前往「收集入口」嵌入反馈组件与 Telegram 机器人。",
  },
  triage: {
    title: "待整理",
    subtitle: "新进入的反馈先在这里核对原话、补充要求，再决定交给自己或 Local Agent。",
    emptyTitle: "没有待整理的新反馈",
    emptyDesc: "所有新反馈都已经分流完毕。",
  },
  mine: {
    title: "我的任务",
    subtitle: "你当前认领并正在跟进的任务。",
    emptyTitle: "你还没有认领任何任务",
    emptyDesc: "在任务列表中点击「我来处理」即可将任务归入这里。",
  },
  agents: {
    title: "Agent 执行",
    subtitle: "正在由本机 Coding Agent 持有租约执行或等待交接的任务。",
    emptyTitle: "当前没有活跃的 Local Agent 任务",
    emptyDesc: "将任务状态设为「待处理」并保持未认领，本机执行器会自动按优先级领取。",
  },
  review: {
    title: "待验收",
    subtitle: "执行完成后等待你检查改动并关闭的任务。",
    emptyTitle: "没有待验收的任务",
    emptyDesc: "Agent 提交验收后，任务会出现在这里。",
  },
};

export function filterTasksForView(
  tasks: TaskRecord[],
  view: WorkspaceView,
  search: string,
  statusFilter: TaskStatus | "",
  sourceFilter: TaskSource | "",
  sortMode: SortMode,
): TaskRecord[] {
  const q = search.trim().toLowerCase();
  const base = tasks.filter((t) => {
    if (t.merged_into) return false;
    if (view === "triage" && t.status !== "triage") return false;
    if (view === "mine" && !(t.owner === "human" && t.status !== "done")) return false;
    if (view === "agents" && t.owner !== "agent") return false;
    if (view === "review" && t.status !== "review") return false;
    if (statusFilter && t.status !== statusFilter) return false;
    if (sourceFilter && t.source !== sourceFilter) return false;
    if (q) {
      const hay = `${taskCode(t.number)} ${t.title} ${t.body} ${t.requirements}`.toLowerCase();
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
  sortMode,
  loading,
  onSearchChange,
  onStatusFilterChange,
  onSourceFilterChange,
  onSortModeChange,
  onClearFilters,
  onSelectTask,
  onQuickAction,
  onNewFeedback,
  onNewProject,
  onRefresh,
  onNavigateView,
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
      ),
    [tasks, view, search, statusFilter, sourceFilter, sortMode],
  );

  const metrics = useMemo(() => {
    const active = tasks.filter((t) => !t.merged_into);
    return {
      triage: active.filter((t) => t.status === "triage").length,
      ready: active.filter((t) => t.status === "ready" && t.owner === "none").length,
      agent: active.filter((t) => t.owner === "agent").length,
      review: active.filter((t) => t.status === "review").length,
    };
  }, [tasks]);

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-lg w-full">
          <EmptyState
            icon="folder-git-2"
            title="欢迎使用 Relaydesk"
            description="先创建一个项目并绑定 GitHub 仓库，即可启用嵌入式反馈组件、Telegram 群收集器和本机 Coding Agent 派单队列。"
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
                  配置 LLM 与 GitHub
                </Button>
              </div>
            }
          />
        </div>
      </div>
    );
  }

  const meta =
    VIEW_META[view as Exclude<WorkspaceView, "sources" | "settings">] ??
    VIEW_META.queue;
  const hasFilters = Boolean(search.trim() || statusFilter || sourceFilter);

  const triggerQuick = async (
    e: React.MouseEvent,
    task: TaskRecord,
    action: "claim" | "ready" | "done",
  ) => {
    e.stopPropagation();
    if (busyIdRef.current === task.id) return;
    busyIdRef.current = task.id;
    try {
      await onQuickAction(task, action);
    } finally {
      busyIdRef.current = null;
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      {/* Page Header */}
      <header className="shrink-0 px-5 lg:px-7 py-4 border-b border-[var(--border-subtle)] bg-[var(--surface-canvas)]">
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

        {/* KPI Cards on Queue view */}
        {view === "queue" && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-4">
            {[
              {
                key: "triage" as const,
                label: "待整理",
                count: metrics.triage,
                icon: "inbox",
                active: statusFilter === "triage",
                onClick: () =>
                  onStatusFilterChange(statusFilter === "triage" ? "" : "triage"),
                accent: "text-zinc-600 dark:text-zinc-300",
              },
              {
                key: "ready" as const,
                label: "待 Agent 领取",
                count: metrics.ready,
                icon: "zap",
                active: statusFilter === "ready",
                onClick: () =>
                  onStatusFilterChange(statusFilter === "ready" ? "" : "ready"),
                accent: "text-indigo-600 dark:text-indigo-400",
              },
              {
                key: "agent" as const,
                label: "Agent 执行中",
                count: metrics.agent,
                icon: "terminal",
                active: false,
                onClick: () => onNavigateView("agents"),
                accent: "text-amber-600 dark:text-amber-400",
              },
              {
                key: "review" as const,
                label: "待验收",
                count: metrics.review,
                icon: "file-check-2",
                active: statusFilter === "review",
                onClick: () =>
                  onStatusFilterChange(statusFilter === "review" ? "" : "review"),
                accent: "text-emerald-600 dark:text-emerald-400",
              },
            ].map((card) => (
              <button
                key={card.key}
                type="button"
                onClick={card.onClick}
                className={`group flex items-center justify-between px-3.5 py-2.5 rounded-xl border text-left transition cursor-pointer ${
                  card.active
                    ? "border-indigo-500/60 bg-indigo-500/8 shadow-2xs"
                    : "border-[var(--border-subtle)] bg-[var(--surface-card)] hover:border-[var(--border-strong)]"
                }`}
              >
                <div>
                  <div className="text-[11.5px] text-[var(--text-muted)]">
                    {card.label}
                  </div>
                  <div className="text-[20px] font-semibold font-mono tabular-nums text-[var(--text-primary)] leading-tight mt-0.5">
                    {card.count}
                  </div>
                </div>
                <div
                  className={`w-8 h-8 rounded-lg bg-[var(--surface-subtle)] flex items-center justify-center ${card.accent} group-hover:scale-105 transition`}
                >
                  <Icon name={card.icon} size={16} />
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
              placeholder="搜索标题、正文或 RD-001…"
              className="w-full h-8.5 pl-8.5 pr-10 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 transition"
            />
            {!search && (
              <span className="hidden sm:inline-flex absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                <Kbd>/</Kbd>
              </span>
            )}
          </div>

          {view === "queue" && (
            <select
              aria-label="按状态筛选"
              value={statusFilter}
              onChange={(e) =>
                onStatusFilterChange(e.target.value as TaskStatus | "")
              }
              className="h-8.5 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[12.5px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500 cursor-pointer"
            >
              <option value="">全部状态</option>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          )}

          <select
            aria-label="按来源筛选"
            value={sourceFilter}
            onChange={(e) =>
              onSourceFilterChange(e.target.value as TaskSource | "")
            }
            className="h-8.5 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[12.5px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500 cursor-pointer"
          >
            <option value="">全部来源</option>
            <option value="widget">应用组件</option>
            <option value="bot">群聊 Bot</option>
            <option value="console">手动录入</option>
          </select>

          <select
            aria-label="排序方式"
            value={sortMode}
            onChange={(e) => onSortModeChange(e.target.value as SortMode)}
            className="h-8.5 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[12.5px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500 cursor-pointer"
          >
            <option value="updated">最近更新</option>
            <option value="priority">按优先级</option>
            <option value="number">按编号</option>
          </select>

          {hasFilters && (
            <Button variant="ghost" size="xs" icon="x" onClick={onClearFilters}>
              清空筛选
            </Button>
          )}
        </div>
      </header>

      {/* Task Rows */}
      <div className="flex-1 overflow-y-auto">
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
              const canQuickReady =
                task.status === "triage" && task.owner !== "agent";
              const canQuickClaim =
                task.owner === "none" && task.status !== "done";
              const canQuickDone =
                task.status === "review" && task.owner !== "agent";

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
                  className={`group relative flex items-center gap-3 px-5 lg:px-7 py-3 transition cursor-pointer outline-none focus-visible:bg-[var(--surface-hover)] ${
                    selected
                      ? "bg-indigo-500/[0.06] dark:bg-indigo-500/[0.09]"
                      : "hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {selected && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-indigo-500" />
                  )}

                  {/* Priority */}
                  <div className="shrink-0 w-[56px] flex items-center">
                    <PriorityBadge priority={task.priority} />
                  </div>

                  {/* Code */}
                  <span className="shrink-0 w-[64px] text-[12px] font-mono tabular-nums text-[var(--text-muted)]">
                    {taskCode(task.number)}
                  </span>

                  {/* Main title + secondary metadata */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`text-[13.5px] font-medium truncate ${
                          task.status === "done"
                            ? "text-[var(--text-muted)] line-through"
                            : "text-[var(--text-primary)]"
                        }`}
                      >
                        {task.title}
                      </span>
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
                  <div className="hidden xl:flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
                    {canQuickReady && (
                      <button
                        type="button"
                        onClick={(e) => void triggerQuick(e, task, "ready")}
                        className="px-2 py-1 rounded-md text-[11.5px] font-medium border border-[var(--border-subtle)] bg-[var(--surface-card)] text-indigo-600 dark:text-indigo-400 hover:border-indigo-500/50 transition cursor-pointer"
                      >
                        设为待处理
                      </button>
                    )}
                    {canQuickDone && (
                      <button
                        type="button"
                        onClick={(e) => void triggerQuick(e, task, "done")}
                        className="px-2 py-1 rounded-md text-[11.5px] font-medium border border-[var(--border-subtle)] bg-[var(--surface-card)] text-emerald-600 dark:text-emerald-400 hover:border-emerald-500/50 transition cursor-pointer"
                      >
                        验收通过
                      </button>
                    )}
                    {canQuickClaim && !canQuickDone && (
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
