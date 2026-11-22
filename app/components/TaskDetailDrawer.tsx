import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectChatStreams } from "~/lib/chat-streams.ts";
import { TaskAgentSessionPanel } from "./TaskAgentSessionPanel.tsx";
import { RichPromptEditor, type RichPromptEditorHandle } from "./agent-chat/RichPromptEditor.tsx";
import { CliRunStatus, useCliRuns } from "./CliRunStatus.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownContent, hasMarkdownSyntax } from "./MarkdownContent.tsx";
import {
  Button,
  CopyButton,
  DeliveryModeBadge,
  Kbd,
  LivePulseDot,
  Modal,
  OwnerChip,
  PriorityBadge,
  ResolutionBadge,
  Select,
  SourceBadge,
  StatusBadge,
  useToast,
  type SelectOption,
} from "./ui.tsx";
import { api, ClientApiError } from "~/lib/api.ts";
import {
  AUTHOR_LABELS,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  STATUS_LABELS,
  STATUS_ORDER,
  formatDateTime,
  formatEventBody,
  formatRelativeTime,
  taskCode,
} from "~/lib/format.ts";
import type {
  ProjectExecutionRoutingResponse,
  CliRun,
  DiscussMode,
  ProjectDetail,
  TaskDetailPayload,
  TaskMessage,
  TaskPriority,
  TaskRecord,
  TaskStatus,
} from "~/lib/types.ts";

interface TaskDetailDrawerProps {
  detail: TaskDetailPayload | null;
  loading: boolean;
  allTasks: TaskRecord[];
  project?: ProjectDetail | null;
  canGoBack: boolean;
  onGoBack: () => void;
  onClose: () => void;
  onOpenRelated: (taskId: string) => void;
  onRefreshTask: (taskId: string) => Promise<void>;
  onOpenCliSettings: () => void;
  streams: ProjectChatStreams;
  onRefreshTasks: () => void;
  routing?: ProjectExecutionRoutingResponse;
  initialTab?: "details" | "agent";
}

type TimelineSegment =
  | { type: "comment"; message: TaskMessage }
  | {
      type: "event_single";
      message: TaskMessage;
      header: string;
      detail: string | null;
    }
  | { type: "event_group"; id: string; messages: TaskMessage[] };

function splitEventBody(rawBody: string): {
  header: string;
  detail: string | null;
} {
  const formatted = formatEventBody(rawBody);
  const idx = formatted.indexOf("\n");
  if (idx === -1) {
    return { header: formatted, detail: null };
  }
  const header = formatted.slice(0, idx).trim();
  const rest = formatted.slice(idx + 1).trim();
  return {
    header: header || formatted,
    detail: rest || null,
  };
}

function eventDotColor(rawBody: string): string {
  const lower = rawBody.toLowerCase();
  if (
    lower.includes("shipped") ||
    lower.includes("promoted to ready") ||
    lower.includes("submitted task for review")
  ) {
    return "bg-emerald-500 dark:bg-emerald-400";
  }
  if (
    lower.includes("claimed") ||
    lower.includes("dispatched") ||
    lower.includes("handoff") ||
    lower.includes("handed over") ||
    lower.includes("without changing task status")
  ) {
    return "bg-amber-500 dark:bg-amber-400";
  }
  if (
    lower.includes("stale") ||
    lower.includes("needs assistance") ||
    lower.includes("revoked") ||
    lower.includes("interrupted") ||
    lower.includes("failed") ||
    lower.includes("stopped") ||
    lower.includes("restarted")
  ) {
    return "bg-rose-500 dark:bg-rose-400";
  }
  if (lower.includes("reopened") || lower.includes("triaged") || lower.includes("followed up")) {
    return "bg-indigo-500 dark:bg-indigo-400";
  }
  return "bg-zinc-400 dark:bg-zinc-500";
}

function buildTimelineSegments(messages: TaskMessage[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let pendingSingleEvents: TaskMessage[] = [];

  const flushEvents = () => {
    if (pendingSingleEvents.length === 0) return;
    if (pendingSingleEvents.length === 1) {
      const only = pendingSingleEvents[0]!;
      const { header } = splitEventBody(only.body);
      segments.push({
        type: "event_single",
        message: only,
        header,
        detail: null,
      });
    } else {
      segments.push({
        type: "event_group",
        id: `trace-${pendingSingleEvents[0]!.id}-${pendingSingleEvents[pendingSingleEvents.length - 1]!.id}`,
        messages: pendingSingleEvents,
      });
    }
    pendingSingleEvents = [];
  };

  for (const m of messages) {
    if (m.kind === "event") {
      const { header, detail } = splitEventBody(m.body);
      if (detail) {
        flushEvents();
        segments.push({
          type: "event_single",
          message: m,
          header,
          detail,
        });
      } else {
        pendingSingleEvents.push(m);
      }
    } else {
      flushEvents();
      segments.push({ type: "comment", message: m });
    }
  }

  flushEvents();
  return segments;
}

function formatDeliveryRefLabel(ref: string): string {
  const trimmed = ref.trim();
  const prMatch = /\/pull\/(\d+)(?:[/?#]|$)/i.exec(trimmed);
  if (prMatch?.[1]) {
    return `PR #${prMatch[1]}`;
  }
  const commitMatch = /\/commit\/([0-9a-f]{7,40})(?:[/?#]|$)/i.exec(trimmed);
  if (commitMatch?.[1]) {
    return `commit ${commitMatch[1].slice(0, 7)}`;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const compactPath = `${parsed.host}${parsed.pathname}`.replace(/\/$/, "");
      return compactPath.length > 36
        ? `${compactPath.slice(0, 34)}…`
        : compactPath;
    } catch {
      return trimmed.length > 36 ? `${trimmed.slice(0, 34)}…` : trimmed;
    }
  }
  return trimmed.length > 32 ? `${trimmed.slice(0, 30)}…` : trimmed;
}

interface PromptSuggestion {
  label: string;
  text: string;
  mode: "comment" | "assistant";
}

function getPromptSuggestions(status: TaskStatus): PromptSuggestion[] {
  if (status === "done" || status === "review") {
    return [
      {
        label: "返工调整",
        text: "需要返工调整：\n- ",
        mode: "comment",
      },
      {
        label: "补充验收标准",
        text: "请补充以下验收标准并重新验证：\n- [ ] ",
        mode: "comment",
      },
    ];
  }
  if (status === "waiting") {
    return [
      {
        label: "补充说明并继续",
        text: "补充信息如下，请继续自动处理：\n",
        mode: "comment",
      },
      {
        label: "梳理当前阻塞点",
        text: "请帮我总结当前的阻塞点以及我需要确认的关键信息。",
        mode: "assistant",
      },
    ];
  }
  return [
    {
      label: "总结并起草验收标准",
      text: "请总结这条反馈的核心诉求，并起草清晰的验收标准清单。",
      mode: "assistant",
    },
    {
      label: "判断是否为有效反馈",
      text: "请结合项目背景判断这条反馈是否有效、是否属于重复需求，并建议优先级。",
      mode: "assistant",
    },
  ];
}

export function TaskDetailDrawer({
  detail,
  loading,
  allTasks,
  project,
  canGoBack,
  onGoBack,
  onClose,
  onOpenRelated,
  onRefreshTask,
  onOpenCliSettings,
  streams,
  onRefreshTasks,
  routing,
  initialTab = "details",
}: TaskDetailDrawerProps) {
  const toast = useToast();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [editingReq, setEditingReq] = useState(false);
  const [reqEditTab, setReqEditTab] = useState<"write" | "preview">("write");
  const [reqDraft, setReqDraft] = useState("");
  const [comment, setComment] = useState("");
  const [autoReopen, setAutoReopen] = useState(true);
  const [discussTarget, setDiscussTarget] = useState<DiscussMode>("operator");
  const [submittedRun, setSubmittedRun] = useState<CliRun | null>(null);
  const [expandedTraces, setExpandedTraces] = useState<Record<string, boolean>>(
    {},
  );
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  const [tab, setTab] = useState(initialTab);
  const commentInputRef = useRef<RichPromptEditorHandle | null>(null);

  const task = detail?.task ?? null;
  const { runs, notice } = useCliRuns({
    projectId: task?.project_id,
    taskId: task?.id,
    submitted: submittedRun,
    onRefreshTask,
  });
  const cliBusy = runs.some((run) => run.status === "queued" || run.status === "running");

  useEffect(() => {
    setEditingReq(false);
    setReqEditTab("write");
    setReqDraft(task?.requirements ?? "");
    setComment("");
    setAutoReopen(true);
    setDiscussTarget("operator");
    setExpandedTraces({});
    setMergeOpen(false);
    setMergeTarget("");
  }, [task?.id]);

  useEffect(() => {
    setAutoReopen(true);
  }, [task?.status]);

  useEffect(() => {
    if (!editingReq) {
      setReqDraft(task?.requirements ?? "");
    }
  }, [task?.requirements, editingReq]);

  const timelineSegments = useMemo(
    () => buildTimelineSegments(detail?.messages ?? []),
    [detail?.messages],
  );

  if (!detail && !loading) return null;

  const canReopenTask = Boolean(
    task &&
      !task.merged_into &&
      task.owner === "none" &&
      (task.status === "done" ||
        task.status === "waiting" ||
        task.status === "review"),
  );

  const showTelemetryBanner = Boolean(
    task &&
      (task.resolution ||
        task.delivery_ref ||
        task.attempts > 0 ||
        task.triaged_by ||
        canReopenTask),
  );

  const isAgentWorking = Boolean(
    task && (task.owner === "agent" || task.agent_session_status === "running"),
  );

  const isDeliveryUrl = Boolean(
    task?.delivery_ref && /^https?:\/\//i.test(task.delivery_ref.trim()),
  );
  const hasGithubPrRef = Boolean(
    task?.delivery_ref && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(task.delivery_ref.trim()),
  );


  const promptSuggestions: PromptSuggestion[] = task
    ? hasGithubPrRef
      ? [
          {
            label: "AI 审计 PR",
            text: "请结合任务需求与改动内容审计当前 PR，评估正确性、边界与回归风险，并给出是否建议合并的结论。",
            mode: "assistant",
          },
          ...getPromptSuggestions(task.status),
        ]
      : getPromptSuggestions(task.status)
    : [];

  const runAction = async (
    label: string,
    payload: Parameters<typeof api.taskAction>[1],
    successMsg?: string,
  ) => {
    if (!task) return;
    setBusyAction(label);
    try {
      await api.taskAction(task.id, payload);
      await onRefreshTask(task.id);
      if (successMsg) toast.success(successMsg);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveReq = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task) return;
    await runAction(
      "requirements",
      { action: "requirements", version: task.version, body: reqDraft },
      "执行要求已保存",
    );
    setEditingReq(false);
    setReqEditTab("write");
  };

  const handleSendMessage = async (askAssistant: boolean) => {
    if (!task) return;
    const text = comment.trim();
    if (!text) return;
    setBusyAction(askAssistant ? "discuss" : "comment");
    try {
      if (askAssistant) {
        const res = await api.discussTask(task.id, text, discussTarget);
        if (res.queued && res.run?.id) {
          setSubmittedRun({ ...res.run, mode: res.node });
          setComment("");
          toast.success("已加入项目 CLI 队列");
          return;
        }
        toast.error("服务端未确认 CLI 请求已入队，请先查看运行状态。");
        return;
      } else {
        const res = await api.addTaskMessage(
          task.id,
          text,
          canReopenTask ? { reopen: autoReopen } : undefined,
        );
        if (res.reopened) {
          toast.success(
            routing?.routing.auto_dispatch_tasks
              ? "已发送评论，将携带新说明唤醒 Local Agent"
              : "已发送评论并重新推入自动队列",
          );
        } else {
          toast.success("评论已发送");
        }
      }
      setComment("");
      await onRefreshTask(task.id);
      onRefreshTasks();
    } catch (err) {
      if (askAssistant) {
        toast.error(err instanceof ClientApiError && err.status === 409
          ? `CLI 请求未入队：${err.message}`
          : "无法确认 CLI 请求已入队，请先查看运行状态。");
      } else {
        toast.error(err instanceof Error ? err.message : "发送失败");
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleApplySuggestion = (suggestion: PromptSuggestion) => {
    if (suggestion.label === "AI 审计 PR") {
      setDiscussTarget("pr_audit");
    }
    setComment(suggestion.text);
    window.requestAnimationFrame(() => {
      commentInputRef.current?.focus();
    });
  };

  const handleMerge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task || !mergeTarget) return;
    await runAction(
      "merge",
      { action: "merge", version: task.version, target_id: mergeTarget },
      "已合并到主任务",
    );
    setMergeOpen(false);
  };

  const toggleTrace = (traceId: string) => {
    setExpandedTraces((prev) => ({ ...prev, [traceId]: !prev[traceId] }));
  };

  const eligibleMergeTargets = task
    ? allTasks.filter(
        (o) =>
          o.id !== task.id &&
          !o.merged_into &&
          o.status !== "done" &&
          o.owner !== "agent",
      )
    : [];

  const availableStatuses = STATUS_ORDER.filter(
    (s) => s !== "handoff" && (s !== "working" || task?.owner === "human"),
  );

  return (
    <>
      <div className="fixed inset-0 z-40 flex justify-end">
        <div
          className="fixed inset-0 bg-black/30 dark:bg-black/55 backdrop-blur-[1px] transition-opacity"
          onClick={onClose}
        />

        <aside
          role="dialog"
          aria-label="任务详情"
          className="relative z-10 w-full max-w-[640px] h-full flex flex-col bg-[var(--surface-elevated)] border-l border-[var(--border-subtle)] shadow-2xl animate-slide-in-right"
        >
          {/* Sticky Header */}
          <div className="shrink-0 flex items-center justify-between gap-2 px-5 h-13 border-b border-[var(--border-subtle)] bg-[var(--surface-elevated)]/95 backdrop-blur-sm">
            <div className="flex items-center gap-2 min-w-0">
              {canGoBack && (
                <button
                  type="button"
                  onClick={onGoBack}
                  className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1.5 py-1 rounded-md hover:bg-[var(--surface-hover)] cursor-pointer transition-colors"
                >
                  <Icon name="arrow-left" size={13} />
                  返回
                </button>
              )}
              {task && (
                <>
                  <span className="text-[12.5px] font-mono font-medium text-[var(--text-secondary)]">
                    {taskCode(task.number)}
                  </span>
                  <CopyButton
                    value={taskCode(task.number)}
                    label=""
                    copiedLabel=""
                    size="xs"
                    variant="ghost"
                  />
                  {project?.delivery_mode && (
                    <DeliveryModeBadge
                      mode={project.delivery_mode}
                      compact
                      className="hidden sm:inline-flex"
                    />
                  )}
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {task && (
                <span className="text-[11px] font-mono tabular-nums text-[var(--text-muted)] hidden sm:inline">
                  更新于 {formatRelativeTime(task.updated_at)}
                </span>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭任务详情"
                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer rd-focus-ring"
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>

          {task && <nav aria-label="任务视图" className="flex gap-4 border-b border-[var(--border-subtle)] px-5">
            {([ ["details", "任务详情"], ["agent", "Agent 执行会话"] ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)} className={`rd-focus-ring inline-flex cursor-pointer items-center gap-2 border-b-2 py-2.5 text-sm ${tab === value ? "border-[var(--rd-accent)] font-medium text-[var(--text-primary)]" : "border-transparent text-[var(--text-muted)]"}`}>
              {label}{value === "agent" && isAgentWorking && <LivePulseDot active tone="emerald" />}
            </button>)}
          </nav>}
          {/* Drawer Body */}
          {loading && !task ? (
            <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)] gap-2">
              <Icon name="loader-2" size={16} className="animate-spin" />
              正在加载任务详情…
            </div>
          ) : task && tab === "agent" ? (
            <TaskAgentSessionPanel task={task} streams={streams} routing={routing} paused={project?.automation_paused} onTaskUpdated={() => { void onRefreshTask(task.id).catch(err => toast.error(err instanceof Error ? err.message : "刷新任务失败")); }} />
          ) : task ? (
            <div className="flex-1 overflow-y-auto rd-scroll px-5 py-5 space-y-5">
              {isAgentWorking && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-3 py-2">
                <span className="inline-flex items-center gap-2 text-xs"><LivePulseDot active tone="emerald" />Agent 正在处理任务</span>
                <Button size="xs" variant="secondary" onClick={() => setTab("agent")}>查看实时执行 / 插话</Button>
              </div>}
              {/* Title & Meta */}
              <div>
                <h2 className="text-[18px] font-semibold tracking-tight text-[var(--text-primary)] leading-snug">
                  {task.title}
                </h2>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <StatusBadge status={task.status} />
                  <PriorityBadge priority={task.priority} showLabel />
                  <OwnerChip owner={task.owner} lastSeen={task.last_seen} />
                  <SourceBadge source={task.source} />
                </div>
              </div>

              {/* Autonomous Telemetry & Delivery Summary Strip */}
              {showTelemetryBanner && (
                <section
                  className={`relative overflow-hidden rounded-xl border px-3.5 py-2.5 rd-hairline-glow transition-colors ${
                    task.resolution === "shipped"
                      ? "border-emerald-500/25 bg-emerald-500/[0.05] dark:bg-emerald-500/[0.07]"
                      : task.attempts >= 3
                        ? "border-rose-500/25 bg-rose-500/[0.05] dark:bg-rose-500/[0.07]"
                        : "border-[var(--border-subtle)] bg-[var(--surface-card)]"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2.5">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <ResolutionBadge
                        resolution={task.resolution}
                        triagedBy={task.triaged_by}
                      />

                      {task.triaged_by && !task.resolution && (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border border-indigo-500/20 bg-indigo-500/8 text-indigo-700 dark:text-indigo-300">
                          <Icon name="sparkles" size={11} />
                          <span>
                            {task.triaged_by === "server_ai"
                              ? "AI 预筛通过"
                              : task.triaged_by === "local_agent"
                                ? "Agent 已整理"
                                : `预筛：${task.triaged_by}`}
                          </span>
                        </span>
                      )}

                      {task.delivery_ref && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-elevated)] pl-2 pr-1 py-0.5 max-w-full">
                          {isDeliveryUrl ? (
                            <a
                              href={task.delivery_ref.trim()}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={task.delivery_ref}
                              className="inline-flex items-center gap-1 text-[11.5px] font-mono text-indigo-600 dark:text-indigo-400 hover:underline truncate max-w-[240px]"
                            >
                              <Icon name="external-link" size={11} />
                              <span className="truncate">
                                {formatDeliveryRefLabel(task.delivery_ref)}
                              </span>
                            </a>
                          ) : (
                            <span
                              title={task.delivery_ref}
                              className="inline-flex items-center gap-1 text-[11.5px] font-mono text-[var(--text-secondary)] truncate max-w-[240px]"
                            >
                              <Icon
                                name="git-branch"
                                size={11}
                                className="text-[var(--text-muted)]"
                              />
                              <span className="truncate">
                                {formatDeliveryRefLabel(task.delivery_ref)}
                              </span>
                            </span>
                          )}
                          <CopyButton
                            value={task.delivery_ref}
                            label=""
                            copiedLabel=""
                            size="xs"
                            variant="ghost"
                            className="h-5 px-1"
                          />
                        </span>
                      )}

                      {task.attempts > 0 && (
                        <span
                          title={`自动执行累计尝试 ${task.attempts} 次（上限 3 次）`}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11.5px] font-mono tabular-nums font-medium border ${
                            task.attempts >= 3
                              ? "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25"
                              : "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25"
                          }`}
                        >
                          <Icon
                            name={
                              task.attempts >= 3 ? "alert-triangle" : "refresh-cw"
                            }
                            size={11}
                          />
                          <span>尝试 {task.attempts}/3</span>
                        </span>
                      )}
                    </div>

                    {canReopenTask && (
                      <Button
                        variant="secondary"
                        size="xs"
                        icon="refresh-cw"
                        loading={busyAction === "reopen"}
                        disabled={busyAction !== null}
                        onClick={() =>
                          void runAction(
                            "reopen",
                            { action: "reopen", version: task.version },
                            "已重新推入自动执行队列",
                          )
                        }
                      >
                        重新入队返工
                      </Button>
                    )}
                  </div>
                </section>
              )}

              {/* Merged banner */}
              {task.merged_into && (
                <div className="flex items-center justify-between gap-3 p-3.5 rounded-xl border border-indigo-500/30 bg-indigo-500/8">
                  <div className="flex items-center gap-2.5 text-[13px] text-[var(--text-primary)]">
                    <Icon
                      name="git-merge"
                      size={16}
                      className="text-indigo-500 shrink-0"
                    />
                    <span>此反馈已并入主任务，请在主任务继续流转。</span>
                  </div>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => onOpenRelated(task.merged_into!)}
                  >
                    打开主任务
                  </Button>
                </div>
              )}

              {/* Workflow & Human-on-the-loop Properties Bar */}
              {!task.merged_into && (
                <section className="relative p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] rd-hairline-glow space-y-3">
                  {isAgentWorking && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 top-0 h-[2px] overflow-hidden rounded-t-xl bg-amber-500/15"
                    >
                      <div className="h-full w-1/2 bg-gradient-to-r from-transparent via-amber-500/80 to-transparent animate-rd-shimmer" />
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-[var(--text-muted)]">
                      自动执行与人工介入
                    </span>
                    {task.owner === "agent" ? (
                      <span className="inline-flex items-center gap-1.5 text-[11.5px] font-mono tabular-nums text-amber-600 dark:text-amber-400">
                        <LivePulseDot tone="amber" active={isAgentWorking} />
                        <span>
                          {task.status === "handoff"
                            ? "等待交接"
                            : "Agent 自动执行中"}
                          {" · "}
                          {formatDateTime(task.last_seen)}
                        </span>
                      </span>
                    ) : task.owner === "none" &&
                      (task.status === "triage" || task.status === "ready") ? (
                      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-emerald-600 dark:text-emerald-400">
                        <LivePulseDot tone="emerald" active />
                        <span>
                          {routing?.routing.auto_dispatch_tasks
                            ? "事件直派已开启，空闲 Local Agent 将自动接单"
                            : "自动队列巡检中，无需手动流转"}
                        </span>
                      </span>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {!isAgentWorking && <Button size="sm" variant="primary" icon="terminal" disabled={busyAction !== null} loading={busyAction === "dispatch"} onClick={async () => {
                      setBusyAction("dispatch");
                      try {
                        const { session } = await api.dispatchTaskToAgent(task.id);
                        streams.observe(session, []);
                        setTab("agent");
                        onRefreshTasks();
                      } catch (err) { toast.error(err instanceof Error ? err.message : "分配任务失败"); }
                      finally { setBusyAction(null); }
                    }}>{task.agent_session_id ? "继续分配 Local Agent" : "分配给 Local Agent"}</Button>}
                    {!isAgentWorking && task.agent_session_id && (
                      <Button size="sm" variant="secondary" icon="message-square" onClick={() => setTab("agent")}>
                        查看执行会话
                      </Button>
                    )}

                    {/* Optional Human Intervention CTA */}
                    {task.owner === "agent" ? (
                      task.status === "handoff" ? (
                        <Button
                          variant="danger"
                          size="sm"
                          icon="shield-alert"
                          loading={busyAction === "force_takeover"}
                          onClick={() => setForceConfirmOpen(true)}
                        >
                          强制接手
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon="hand"
                          loading={busyAction === "takeover"}
                          onClick={() =>
                            void runAction(
                              "takeover",
                              { action: "takeover", version: task.version },
                              "已向 Local Agent 发送交接请求",
                            )
                          }
                        >
                          请求接手
                        </Button>
                      )
                    ) : task.owner === "human" ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="user"
                        loading={busyAction === "release"}
                        onClick={() =>
                          void runAction(
                            "release",
                            { action: "release", version: task.version },
                            "已释放认领，交回自动队列",
                          )
                        }
                      >
                        交回自动队列
                      </Button>
                    ) : task.status !== "done" ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="user-check"
                        loading={busyAction === "claim"}
                        onClick={() =>
                          void runAction(
                            "claim",
                            { action: "claim", version: task.version },
                            "已认领任务",
                          )
                        }
                      >
                        人工接手
                      </Button>
                    ) : null}

                    {/* Status instant selector */}
                    {task.owner !== "agent" && (
                      <div className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                        <span>状态</span>
                        <Select<TaskStatus>
                          ariaLabel="修改任务状态"
                          size="sm"
                          variant="elevated"
                          minMenuWidth={148}
                          className="h-8"
                          value={task.status}
                          disabled={busyAction !== null}
                          onChange={(nextStatus) =>
                            void runAction(
                              "status",
                              {
                                action: "status",
                                version: task.version,
                                status: nextStatus,
                              },
                              `状态已更新为「${STATUS_LABELS[nextStatus]}」`,
                            )
                          }
                          options={
                            availableStatuses.map((s) => ({
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
                            })) satisfies SelectOption<TaskStatus>[]
                          }
                        />
                      </div>
                    )}

                    {/* Priority instant selector */}
                    <div className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      <span>优先级</span>
                      <Select<TaskPriority>
                        ariaLabel="修改优先级"
                        size="sm"
                        variant="elevated"
                        minMenuWidth={136}
                        className="h-8"
                        value={task.priority}
                        disabled={busyAction !== null}
                        onChange={(nextPriority) =>
                          void runAction(
                            "priority",
                            {
                              action: "priority",
                              version: task.version,
                              priority: nextPriority,
                            },
                            `优先级已调整为「${PRIORITY_LABELS[nextPriority]}」`,
                          )
                        }
                        options={
                          PRIORITY_ORDER.map((p) => ({
                            value: p,
                            label: PRIORITY_LABELS[p],
                            icon:
                              p === "urgent"
                                ? "alert-triangle"
                                : p === "high"
                                  ? "signal-high"
                                  : p === "normal"
                                    ? "signal-medium"
                                    : "signal-low",
                            iconClassName:
                              p === "urgent"
                                ? "text-rose-600 dark:text-rose-400"
                                : p === "high"
                                  ? "text-amber-600 dark:text-amber-400"
                                  : p === "normal"
                                    ? "text-zinc-500 dark:text-zinc-300"
                                    : "text-zinc-400 dark:text-zinc-500",
                          })) satisfies SelectOption<TaskPriority>[]
                        }
                      />
                    </div>
                  </div>

                  {task.owner === "agent" && task.status === "handoff" && (
                    <p className="text-[12px] text-[var(--text-muted)]">
                      正在等待本机执行器停止并回传工作现场。如执行器已离线，可使用「强制接手」。
                    </p>
                  )}
                </section>
              )}

              {/* Original Feedback */}
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    原始反馈
                  </h3>
                  {/^https?:\/\//i.test(task.source_url || "") && (
                    <a
                      href={task.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[12px] text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      查看来源页面
                      <Icon name="external-link" size={12} />
                    </a>
                  )}
                </div>
                <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] rd-hairline-glow text-[13px] leading-[1.65] text-[var(--text-primary)]">
                  {task.body ? (
                    hasMarkdownSyntax(task.body) ? (
                      <MarkdownContent content={task.body} />
                    ) : (
                      <p className="whitespace-pre-wrap break-words m-0">
                        {task.body}
                      </p>
                    )
                  ) : (
                    <span className="text-[var(--text-muted)]">
                      未填写详细描述
                    </span>
                  )}
                </div>
              </section>

              {/* Execution Requirements */}
              {!task.merged_into && (
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                      执行要求与验收标准
                    </h3>
                    {!editingReq && (
                      <Button
                        variant="ghost"
                        size="xs"
                        icon="pen-line"
                        onClick={() => {
                          setReqEditTab("write");
                          setEditingReq(true);
                        }}
                      >
                        {task.requirements ? "编辑要求" : "补充约束"}
                      </Button>
                    )}
                  </div>

                  {editingReq ? (
                    <form
                      onSubmit={handleSaveReq}
                      className="rounded-xl border border-indigo-500/45 bg-[var(--surface-card)] overflow-hidden shadow-[var(--rd-shadow-sm)]"
                    >
                      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]/70">
                        <div className="inline-flex items-center gap-1 rounded-lg bg-[var(--surface-elevated)] p-0.5 border border-[var(--border-subtle)]">
                          <button
                            type="button"
                            onClick={() => setReqEditTab("write")}
                            className={`px-2 py-0.5 rounded-md text-[11.5px] font-medium transition-colors cursor-pointer ${
                              reqEditTab === "write"
                                ? "bg-[var(--surface-active)] text-[var(--text-primary)]"
                                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                            }`}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => setReqEditTab("preview")}
                            className={`px-2 py-0.5 rounded-md text-[11.5px] font-medium transition-colors cursor-pointer ${
                              reqEditTab === "preview"
                                ? "bg-[var(--surface-active)] text-[var(--text-primary)]"
                                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                            }`}
                          >
                            预览
                          </button>
                        </div>
                        <span className="text-[11px] text-[var(--text-muted)]">
                          支持 Markdown 与任务清单
                        </span>
                      </div>

                      {reqEditTab === "write" ? (
                        <textarea
                          value={reqDraft}
                          onChange={(e) => setReqDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (
                              (e.metaKey || e.ctrlKey) &&
                              e.key === "Enter" &&
                              !e.nativeEvent.isComposing
                            ) {
                              e.preventDefault();
                              void handleSaveReq(e);
                            }
                          }}
                          rows={6}
                          maxLength={24000}
                          placeholder="写明具体改动范围、边界条件与验收标准（支持 - [ ] 清单与代码块），Local Agent 将按此执行…"
                          className="w-full resize-y bg-transparent p-3 text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                        />
                      ) : (
                        <div className="min-h-[120px] p-3.5 bg-[var(--surface-card)]">
                          {reqDraft.trim() ? (
                            <MarkdownContent content={reqDraft} />
                          ) : (
                            <p className="text-[12.5px] text-[var(--text-muted)] m-0">
                              暂无内容可预览。
                            </p>
                          )}
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--surface-subtle)]/40">
                        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                          <Kbd>⌘/Ctrl</Kbd>
                          <span>+</span>
                          <Kbd>Enter</Kbd>
                          <span>保存</span>
                        </span>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => {
                              setEditingReq(false);
                              setReqEditTab("write");
                              setReqDraft(task.requirements);
                            }}
                          >
                            取消
                          </Button>
                          <Button
                            type="submit"
                            variant="primary"
                            size="xs"
                            loading={busyAction === "requirements"}
                          >
                            保存要求
                          </Button>
                        </div>
                      </div>
                    </form>
                  ) : (
                    <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] rd-hairline-glow text-[13px] text-[var(--text-secondary)]">
                      {task.requirements ? (
                        <MarkdownContent content={task.requirements} />
                      ) : (
                        <span className="text-[var(--text-muted)] leading-relaxed block">
                          暂未设置额外约束，Agent 将直接依据原始反馈与项目指令自主执行；如需限定范围可随时点击右上角补充。
                        </span>
                      )}
                    </div>
                  )}
                </section>
              )}

              {/* Merged / Linked Feedback */}
              {(detail?.merged.length ?? 0) > 0 && (
                <section className="space-y-2">
                  <h3 className="text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    关联的合并反馈 ({detail?.merged.length})
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {detail?.merged.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => onOpenRelated(m.id)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:border-[var(--border-strong)] text-[12.5px] text-[var(--text-primary)] transition cursor-pointer"
                      >
                        <Icon
                          name="git-merge"
                          size={12}
                          className="text-indigo-500"
                        />
                        <span className="font-mono text-[11.5px] text-[var(--text-muted)]">
                          {taskCode(m.number)}
                        </span>
                        <span className="truncate max-w-[220px]">
                          {m.title}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Discussion Thread & Activity Trace */}
              <section className="space-y-3 pt-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    动态与讨论 ({detail?.messages.length ?? 0})
                  </h3>
                  <div className="flex flex-wrap justify-end items-center gap-2">
                    <Select<DiscussMode>
                      ariaLabel="选择项目 CLI 讨论模式"
                      size="xs"
                      variant="pill"
                      align="end"
                      value={discussTarget}
                      onChange={setDiscussTarget}
                      options={[
                        {
                          value: "operator",
                          label: "项目 CLI · 任务讨论",
                          description: "回答项目问题，在临时工作区验证想法。",
                          icon: "terminal",
                        },
                        { value: "pr_audit", label: "项目 CLI · PR 审计", icon: "git-pull-request" },
                      ]}
                    />
                    <button type="button" onClick={onOpenCliSettings} className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer">CLI 设置</button>
                  </div>
                </div>

                {/* Timeline */}
                <div className="space-y-2.5">
                  {timelineSegments.length === 0 ? (
                    <p className="text-[13px] text-[var(--text-muted)] py-2">
                      还没有动态与讨论记录。
                    </p>
                  ) : (
                    timelineSegments.map((segment) => {
                      if (segment.type === "event_group") {
                        const expanded = Boolean(expandedTraces[segment.id]);
                        const firstMsg = segment.messages[0]!;
                        const lastMsg =
                          segment.messages[segment.messages.length - 1]!;
                        const dotColors = segment.messages
                          .slice(-4)
                          .map((m) => eventDotColor(m.body));

                        return (
                          <div
                            key={segment.id}
                            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/55 overflow-hidden transition-colors"
                          >
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={() => toggleTrace(segment.id)}
                              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]/60 transition-colors cursor-pointer rd-focus-ring"
                            >
                              <span className="inline-flex items-center gap-2 min-w-0">
                                <span
                                  aria-hidden="true"
                                  className="inline-flex items-center -space-x-0.5 shrink-0"
                                >
                                  {dotColors.map((dotClass, idx) => (
                                    <span
                                      key={idx}
                                      className={`w-2 h-2 rounded-full ring-2 ring-[var(--surface-elevated)] ${dotClass}`}
                                    />
                                  ))}
                                </span>
                                <span className="font-medium text-[var(--text-secondary)] truncate">
                                  流水线轨迹 · {segment.messages.length} 条状态记录
                                </span>
                              </span>
                              <span className="inline-flex items-center gap-1.5 shrink-0">
                                <time className="text-[11px] font-mono tabular-nums opacity-75">
                                  {formatRelativeTime(firstMsg.created_at) ===
                                  formatRelativeTime(lastMsg.created_at)
                                    ? formatRelativeTime(lastMsg.created_at)
                                    : `${formatRelativeTime(firstMsg.created_at)} – ${formatRelativeTime(lastMsg.created_at)}`}
                                </time>
                                <Icon
                                  name={
                                    expanded ? "chevron-down" : "chevron-right"
                                  }
                                  size={13}
                                />
                              </span>
                            </button>

                            {expanded && (
                              <div className="px-3 pb-2.5 pt-1 border-t border-[var(--border-subtle)]/80 space-y-1.5">
                                {segment.messages.map((m, idx) => {
                                  const isLast =
                                    idx === segment.messages.length - 1;
                                  return (
                                    <div
                                      key={m.id}
                                      className="relative flex items-start gap-2.5 text-[12px] text-[var(--text-muted)] py-0.5"
                                    >
                                      <div className="relative flex flex-col items-center pt-1.5 shrink-0">
                                        <span
                                          className={`w-1.5 h-1.5 rounded-full ${eventDotColor(m.body)}`}
                                        />
                                        {!isLast && (
                                          <span
                                            aria-hidden="true"
                                            className="w-px h-4 bg-[var(--border-subtle)] mt-1"
                                          />
                                        )}
                                      </div>
                                      <div className="flex-1 min-w-0 leading-snug">
                                        <span className="font-medium text-[var(--text-secondary)]">
                                          {AUTHOR_LABELS[m.author] ?? m.author}
                                        </span>
                                        <span className="mx-1.5 opacity-60">
                                          ·
                                        </span>
                                        <span className="break-words">
                                          {formatEventBody(m.body)}
                                        </span>
                                      </div>
                                      <time
                                        title={formatDateTime(m.created_at)}
                                        className="shrink-0 text-[11px] font-mono tabular-nums opacity-75"
                                      >
                                        {formatRelativeTime(m.created_at)}
                                      </time>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      }

                      if (segment.type === "event_single") {
                        const { message: m, header, detail: eventDetail } =
                          segment;
                        return (
                          <div
                            key={m.id}
                            className="space-y-1.5 py-0.5"
                          >
                            <div className="flex items-start gap-2.5 text-[12px] text-[var(--text-muted)]">
                              <span
                                className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${eventDotColor(m.body)}`}
                              />
                              <div className="flex-1 min-w-0 leading-snug">
                                <span className="font-medium text-[var(--text-secondary)]">
                                  {AUTHOR_LABELS[m.author] ?? m.author}
                                </span>
                                <span className="mx-1.5 opacity-60">·</span>
                                <span className="break-words">{header}</span>
                              </div>
                              <time
                                title={formatDateTime(m.created_at)}
                                className="shrink-0 text-[11px] font-mono tabular-nums opacity-75"
                              >
                                {formatRelativeTime(m.created_at)}
                              </time>
                            </div>
                            {eventDetail && (
                              <div className="ml-4 pl-3 pr-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/55">
                                <MarkdownContent
                                  content={eventDetail}
                                  compact
                                />
                              </div>
                            )}
                          </div>
                        );
                      }

                      const m = segment.message;
                      const isAssistant = m.author === "assistant";
                      const isAgent = m.author === "agent";

                      return (
                        <article
                          key={m.id}
                          className={`p-3.5 rounded-xl border text-[13px] rd-hairline-glow ${
                            isAssistant
                              ? "border-indigo-500/25 bg-indigo-500/[0.05] dark:bg-indigo-500/[0.08]"
                              : isAgent
                                ? "border-[var(--border-subtle)] bg-[var(--surface-card)]"
                                : "border-[var(--border-subtle)] bg-[var(--surface-card)]"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 mb-2">
                            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-primary)]">
                              <span
                                className={`inline-flex items-center justify-center w-5 h-5 rounded-md border ${
                                  isAssistant
                                    ? "bg-indigo-500/12 border-indigo-500/25 text-indigo-600 dark:text-indigo-400"
                                    : isAgent
                                      ? "bg-cyan-500/10 border-cyan-500/25 text-cyan-700 dark:text-cyan-300"
                                      : "bg-[var(--surface-subtle)] border-[var(--border-subtle)] text-[var(--text-muted)]"
                                }`}
                              >
                                <Icon
                                  name={
                                    isAssistant
                                      ? "sparkles"
                                      : isAgent
                                        ? "terminal"
                                        : "user"
                                  }
                                  size={12}
                                />
                              </span>
                              <span>{AUTHOR_LABELS[m.author] ?? m.author}</span>
                              {isAgent && (
                                <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-[var(--border-subtle)]">
                                  执行汇报
                                </span>
                              )}
                            </span>
                            <time
                              title={formatDateTime(m.created_at)}
                              className="text-[11px] font-mono tabular-nums text-[var(--text-muted)]"
                            >
                              {formatDateTime(m.created_at)}
                            </time>
                          </div>
                          <MarkdownContent content={m.body} />
                        </article>
                      );
                    })
                  )}
                </div>

                <CliRunStatus runs={runs} notice={notice} />

                {/* Beautiful UI-inspired Prompt Bar Composer */}
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] rd-hairline-glow overflow-hidden focus-within:border-indigo-500/60 focus-within:ring-2 focus-within:ring-indigo-500/12 transition-all">
                  {/* Context-aware quick suggestion chips */}
                  {promptSuggestions.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 pb-1">
                      <span className="text-[11px] text-[var(--text-muted)] mr-0.5 select-none">
                        快捷指令
                      </span>
                      {promptSuggestions.map((chip) => (
                        <button
                          key={chip.label}
                          type="button"
                          onClick={() => handleApplySuggestion(chip)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11.5px] font-medium border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/80 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer rd-focus-ring"
                        >
                          <Icon
                            name={
                              chip.mode === "assistant" ? "sparkles" : "zap"
                            }
                            size={10}
                            className={
                              chip.mode === "assistant"
                                ? "text-indigo-500"
                                : "text-emerald-500"
                            }
                          />
                          <span>{chip.label}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  <RichPromptEditor
                    ref={commentInputRef}
                    value={comment}
                    disabled={busyAction !== null}
                    ariaLabel="任务评论输入框"
                    submitMode="mod-enter"
                    placeholder={
                      canReopenTask
                        ? "输入返工要求、补充说明或验收意见（支持 `行内代码` 与 ``` 代码块）…"
                        : "输入评论补充上下文，或直接向项目 CLI 提问（支持 `行内代码` 与 ``` 代码块）…"
                    }
                    onChange={(next) => setComment(next.slice(0, 8000))}
                    onSubmit={() => void handleSendMessage(false)}
                    className="w-full px-3 py-2 min-h-[72px] max-h-[220px] overflow-y-auto rd-scroll cursor-text"
                  />

                  {/* Comment-to-Wakeup Indicator & Footer Controls */}
                  <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--surface-subtle)]/45">
                    <div className="flex flex-wrap items-center gap-2">
                      {canReopenTask ? (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={autoReopen}
                          title="开启后，发送评论将自动唤醒 Local Agent 并把评论内容直接带入执行会话"
                          onClick={() => setAutoReopen((v) => !v)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium border transition-all cursor-pointer rd-focus-ring ${
                            autoReopen
                              ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                              : "bg-[var(--surface-elevated)] text-[var(--text-muted)] border-[var(--border-subtle)] hover:text-[var(--text-primary)]"
                          }`}
                        >
                          <LivePulseDot
                            tone={autoReopen ? "emerald" : "zinc"}
                            active={autoReopen}
                          />
                          <span>
                            {autoReopen
                              ? "发送后自动唤醒 Agent"
                              : "仅留存评论（不唤醒）"}
                          </span>
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                          <Kbd>⌘/Ctrl</Kbd>
                          <span>+</span>
                          <Kbd>Enter</Kbd>
                          <span>发送</span>
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 ml-auto">
                      {canReopenTask && (
                        <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] mr-1">
                          <Kbd>⌘/Ctrl</Kbd>
                          <span>+</span>
                          <Kbd>Enter</Kbd>
                        </span>
                      )}
                      <Button
                        type="button"
                        variant={
                          canReopenTask && autoReopen ? "primary" : "secondary"
                        }
                        size="xs"
                        icon="send"
                        disabled={!comment.trim() || busyAction !== null}
                        loading={busyAction === "comment"}
                        onClick={() => void handleSendMessage(false)}
                      >
                        发送评论
                      </Button>
                      <Button
                        type="button"
                        variant={
                          canReopenTask && autoReopen ? "secondary" : "primary"
                        }
                        size="xs"
                        icon={discussTarget === "pr_audit" ? "git-pull-request" : "sparkles"}
                        disabled={!comment.trim() || busyAction !== null || cliBusy}
                        loading={busyAction === "discuss"}
                        onClick={() => void handleSendMessage(true)}
                      >
                        {discussTarget === "pr_audit" ? "发起 PR 审计" : "询问项目 CLI"}
                      </Button>
                    </div>
                  </div>
                </div>
              </section>

              {/* Merge duplicate */}
              {!task.merged_into &&
                task.owner !== "agent" &&
                eligibleMergeTargets.length > 0 && (
                  <section className="pt-2 border-t border-[var(--border-subtle)]">
                    <button
                      type="button"
                      onClick={() => setMergeOpen((o) => !o)}
                      className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition cursor-pointer"
                    >
                      <Icon name="git-merge" size={14} />
                      合并重复反馈到其他主任务
                      <Icon
                        name={mergeOpen ? "chevron-down" : "chevron-right"}
                        size={13}
                      />
                    </button>
                    {mergeOpen && (
                      <form
                        onSubmit={handleMerge}
                        className="mt-3 p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] space-y-3"
                      >
                        <Select
                          ariaLabel="选择要并入的主任务"
                          fullWidth
                          size="md"
                          variant="elevated"
                          maxMenuWidth={560}
                          placeholder="选择要并入的主任务…"
                          value={mergeTarget}
                          onChange={setMergeTarget}
                          options={
                            eligibleMergeTargets.map((o) => ({
                              value: o.id,
                              label: o.title,
                              triggerLabel: `${taskCode(o.number)} ${o.title}`,
                              badge: taskCode(o.number),
                              icon: "git-merge",
                            })) satisfies SelectOption[]
                          }
                        />
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11.5px] text-[var(--text-muted)]">
                            本单将关闭，原文和讨论会保留在主任务的关联反馈中。
                          </span>
                          <Button
                            type="submit"
                            variant="secondary"
                            size="xs"
                            loading={busyAction === "merge"}
                            disabled={!mergeTarget}
                          >
                            确认合并
                          </Button>
                        </div>
                      </form>
                    )}
                  </section>
                )}
            </div>
          ) : null}
        </aside>
      </div>

      {/* Force Takeover Confirmation Modal */}
      <Modal
        open={forceConfirmOpen}
        onClose={() => setForceConfirmOpen(false)}
        title="确认强制接手任务？"
        maxWidth="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setForceConfirmOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={busyAction === "force_takeover"}
              onClick={async () => {
                if (!task) return;
                setForceConfirmOpen(false);
                await runAction(
                  "force_takeover",
                  { action: "force_takeover", version: task.version },
                  "已强制接手并撤销旧 Agent 租约",
                );
              }}
            >
              确认强制接手
            </Button>
          </div>
        }
      >
        <p className="text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
          强制接手会立即撤销当前 Local
          Agent 的回写租约并将任务归属给你。若本机执行器只是暂时断网，其进程可能仍在后台运行，请记得在本机检查。
        </p>
      </Modal>
    </>
  );
}
