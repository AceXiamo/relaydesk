import { useEffect, useState } from "react";
import { Icon } from "./Icon.tsx";
import {
  Button,
  CopyButton,
  Modal,
  OwnerChip,
  PriorityBadge,
  SourceBadge,
  StatusBadge,
  useToast,
} from "./ui.tsx";
import { api } from "~/lib/api.ts";
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
  AiConfigStatus,
  TaskDetailPayload,
  TaskPriority,
  TaskRecord,
  TaskStatus,
} from "~/lib/types.ts";

interface TaskDetailDrawerProps {
  detail: TaskDetailPayload | null;
  loading: boolean;
  allTasks: TaskRecord[];
  aiConfig: AiConfigStatus | null;
  canGoBack: boolean;
  onGoBack: () => void;
  onClose: () => void;
  onOpenRelated: (taskId: string) => void;
  onRefreshTask: (taskId: string) => Promise<void>;
  onOpenAiSettings: () => void;
}

export function TaskDetailDrawer({
  detail,
  loading,
  allTasks,
  aiConfig,
  canGoBack,
  onGoBack,
  onClose,
  onOpenRelated,
  onRefreshTask,
  onOpenAiSettings,
}: TaskDetailDrawerProps) {
  const toast = useToast();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [editingReq, setEditingReq] = useState(false);
  const [reqDraft, setReqDraft] = useState("");
  const [comment, setComment] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);

  const task = detail?.task ?? null;

  useEffect(() => {
    setEditingReq(false);
    setReqDraft(task?.requirements ?? "");
    setComment("");
    setMergeOpen(false);
    setMergeTarget("");
  }, [task?.id]);

  useEffect(() => {
    if (!editingReq) {
      setReqDraft(task?.requirements ?? "");
    }
  }, [task?.requirements, editingReq]);

  if (!detail && !loading) return null;

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
  };

  const handleSendMessage = async (askAssistant: boolean) => {
    if (!task) return;
    const text = comment.trim();
    if (!text) return;
    setBusyAction(askAssistant ? "discuss" : "comment");
    try {
      if (askAssistant) {
        await api.discussTask(task.id, text);
        toast.success("项目助手已回复");
      } else {
        await api.addTaskMessage(task.id, text);
        toast.success("备注已添加");
      }
      setComment("");
      await onRefreshTask(task.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "发送失败");
    } finally {
      setBusyAction(null);
    }
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
          className="relative z-10 w-full max-w-[620px] h-full flex flex-col bg-[var(--surface-elevated)] border-l border-[var(--border-subtle)] shadow-2xl animate-slide-in-right"
        >
          {/* Sticky Header */}
          <div className="shrink-0 flex items-center justify-between gap-2 px-5 h-13 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2 min-w-0">
              {canGoBack && (
                <button
                  type="button"
                  onClick={onGoBack}
                  className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1.5 py-1 rounded-md hover:bg-[var(--surface-hover)] cursor-pointer"
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
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {task && (
                <span className="text-[11px] text-[var(--text-muted)] hidden sm:inline">
                  更新于 {formatRelativeTime(task.updated_at)}
                </span>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭任务详情"
                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          </div>

          {/* Drawer Body */}
          {loading && !task ? (
            <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-muted)] gap-2">
              <Icon name="loader-2" size={16} className="animate-spin" />
              正在加载任务详情…
            </div>
          ) : task ? (
            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
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

              {/* Merged banner */}
              {task.merged_into && (
                <div className="flex items-center justify-between gap-3 p-3.5 rounded-xl border border-indigo-500/30 bg-indigo-500/8">
                  <div className="flex items-center gap-2.5 text-[13px] text-[var(--text-primary)]">
                    <Icon name="git-merge" size={16} className="text-indigo-500 shrink-0" />
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

              {/* Workflow & Properties Bar */}
              {!task.merged_into && (
                <section className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-[var(--text-muted)]">
                      流转与归属
                    </span>
                    {task.owner === "agent" && (
                      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-amber-600 dark:text-amber-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                        Agent 最近同步 · {formatDateTime(task.last_seen)}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Ownership CTA */}
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
                            "已释放认领",
                          )
                        }
                      >
                        释放认领
                      </Button>
                    ) : task.status !== "done" ? (
                      <Button
                        variant="primary"
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
                        我来处理
                      </Button>
                    ) : null}

                    {/* Status instant selector */}
                    {task.owner !== "agent" && (
                      <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                        <span>状态</span>
                        <select
                          aria-label="修改任务状态"
                          value={task.status}
                          disabled={busyAction !== null}
                          onChange={(e) =>
                            void runAction(
                              "status",
                              {
                                action: "status",
                                version: task.version,
                                status: e.target.value as TaskStatus,
                              },
                              `状态已更新为「${STATUS_LABELS[e.target.value as TaskStatus]}」`,
                            )
                          }
                          className="h-8 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[12.5px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500 cursor-pointer"
                        >
                          {availableStatuses.map((s) => (
                            <option key={s} value={s}>
                              {STATUS_LABELS[s]}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    {/* Priority instant selector */}
                    <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                      <span>优先级</span>
                      <select
                        aria-label="修改优先级"
                        value={task.priority}
                        disabled={busyAction !== null}
                        onChange={(e) =>
                          void runAction(
                            "priority",
                            {
                              action: "priority",
                              version: task.version,
                              priority: e.target.value as TaskPriority,
                            },
                            `优先级已调整为「${PRIORITY_LABELS[e.target.value as TaskPriority]}」`,
                          )
                        }
                        className="h-8 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[12.5px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500 cursor-pointer"
                      >
                        {PRIORITY_ORDER.map((p) => (
                          <option key={p} value={p}>
                            {PRIORITY_LABELS[p]}
                          </option>
                        ))}
                      </select>
                    </label>
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
                <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[13.5px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap break-words">
                  {task.body || "未填写详细描述"}
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
                        onClick={() => setEditingReq(true)}
                      >
                        {task.requirements ? "编辑要求" : "补充要求"}
                      </Button>
                    )}
                  </div>

                  {editingReq ? (
                    <form onSubmit={handleSaveReq} className="space-y-2.5">
                      <textarea
                        value={reqDraft}
                        onChange={(e) => setReqDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                            e.preventDefault();
                            void handleSaveReq(e);
                          }
                        }}
                        rows={5}
                        maxLength={24000}
                        placeholder="写明具体改动范围、边界条件与验收标准，Local Agent 将严格按此执行…"
                        className="w-full rounded-xl border border-indigo-500/50 bg-[var(--surface-card)] p-3 text-[13px] leading-relaxed text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                      />
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => {
                            setEditingReq(false);
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
                    </form>
                  ) : (
                    <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[13px] leading-relaxed whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                      {task.requirements || (
                        <span className="text-[var(--text-muted)]">
                          暂无单独确认的执行要求。点击右上角「补充要求」即可编写。
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
                        <Icon name="git-merge" size={12} className="text-indigo-500" />
                        <span className="font-mono text-[11.5px] text-[var(--text-muted)]">
                          {taskCode(m.number)}
                        </span>
                        <span className="truncate max-w-[220px]">{m.title}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Discussion Thread & AI Assistant */}
              <section className="space-y-3 pt-1">
                <div className="flex items-center justify-between">
                  <h3 className="text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    动态与讨论 ({detail?.messages.length ?? 0})
                  </h3>
                  {aiConfig && (
                    <button
                      type="button"
                      onClick={onOpenAiSettings}
                      className={`inline-flex items-center gap-1.5 text-[11.5px] px-2 py-0.5 rounded-full transition cursor-pointer ${
                        aiConfig.configured
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/15"
                          : "bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/15"
                      }`}
                    >
                      <Icon name="sparkles" size={11} />
                      {aiConfig.configured
                        ? `AI 助手 · ${aiConfig.model}`
                        : "未配置 LLM · 点此设置 API Key"}
                    </button>
                  )}
                </div>

                {/* Timeline */}
                <div className="space-y-2.5">
                  {(detail?.messages ?? []).length === 0 ? (
                    <p className="text-[13px] text-[var(--text-muted)] py-2">
                      还没有讨论记录。
                    </p>
                  ) : (
                    detail?.messages.map((m) => {
                      if (m.kind === "event") {
                        return (
                          <div
                            key={m.id}
                            className="flex items-start gap-2.5 text-[12px] text-[var(--text-muted)] py-0.5"
                          >
                            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[var(--border-strong)] shrink-0" />
                            <div className="flex-1 min-w-0">
                              <span className="font-medium text-[var(--text-secondary)]">
                                {AUTHOR_LABELS[m.author] ?? m.author}
                              </span>
                              <span className="mx-1.5">·</span>
                              <span className="whitespace-pre-wrap break-words">
                                {formatEventBody(m.body)}
                              </span>
                            </div>
                            <time className="shrink-0 text-[11px] font-mono tabular-nums opacity-75">
                              {formatRelativeTime(m.created_at)}
                            </time>
                          </div>
                        );
                      }

                      const isAssistant = m.author === "assistant";
                      return (
                        <article
                          key={m.id}
                          className={`p-3.5 rounded-xl border text-[13px] ${
                            isAssistant
                              ? "border-indigo-500/25 bg-indigo-500/[0.06]"
                              : "border-[var(--border-subtle)] bg-[var(--surface-card)]"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 mb-1.5">
                            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-primary)]">
                              <Icon
                                name={
                                  isAssistant
                                    ? "sparkles"
                                    : m.author === "agent"
                                      ? "terminal"
                                      : "user"
                                }
                                size={13}
                                className={
                                  isAssistant ? "text-indigo-500" : "text-[var(--text-muted)]"
                                }
                              />
                              {AUTHOR_LABELS[m.author] ?? m.author}
                            </span>
                            <time className="text-[11px] font-mono text-[var(--text-muted)]">
                              {formatDateTime(m.created_at)}
                            </time>
                          </div>
                          <p className="leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap break-words">
                            {m.body}
                          </p>
                        </article>
                      );
                    })
                  )}
                </div>

                {/* Composer */}
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 space-y-2.5 focus-within:border-indigo-500/60 transition">
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void handleSendMessage(false);
                      }
                    }}
                    rows={3}
                    maxLength={8000}
                    placeholder="写下备注，或向项目助手提问（例如：帮我起草验收标准 / 总结这条反馈）…"
                    className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-[var(--border-subtle)]">
                    <span className="text-[11px] text-[var(--text-muted)]">
                      ⌘/Ctrl + Enter 发送备注
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        icon="send"
                        disabled={!comment.trim() || busyAction !== null}
                        loading={busyAction === "comment"}
                        onClick={() => void handleSendMessage(false)}
                      >
                        添加备注
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="xs"
                        icon="sparkles"
                        disabled={!comment.trim() || busyAction !== null}
                        loading={busyAction === "discuss"}
                        onClick={() => void handleSendMessage(true)}
                      >
                        询问项目助手
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
                        <select
                          required
                          value={mergeTarget}
                          onChange={(e) => setMergeTarget(e.target.value)}
                          className="w-full h-9 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
                        >
                          <option value="">选择要并入的主任务…</option>
                          {eligibleMergeTargets.map((o) => (
                            <option key={o.id} value={o.id}>
                              {taskCode(o.number)} {o.title}
                            </option>
                          ))}
                        </select>
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
          强制接手会立即撤销当前 Local Agent 的回写租约并将任务归属给你。若本机执行器只是暂时断网，其进程可能仍在后台运行，请记得在本机检查。
        </p>
      </Modal>
    </>
  );
}
