import { useCallback, useEffect, useState } from "react";
import { DeployGateEvaluationRow } from "./DeployGateSection.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import {
  Button,
  DeployStatusBadge,
  EmptyState,
  LivePulseDot,
  PriorityBadge,
  ReleaseStatusBadge,
  ReleaseTriggerBadge,
  useToast,
} from "./ui.tsx";
import { api, ClientApiError } from "~/lib/api.ts";
import {
  DEPLOY_MODE_DESCRIPTIONS,
  DEPLOY_MODE_LABELS,
  formatDateTime,
  formatRelativeTime,
  releaseCode,
  taskCode,
} from "~/lib/format.ts";
import type {
  ProjectDeployPolicy,
  ProjectDetail,
  ReleaseRecord,
  TaskRecord,
} from "~/lib/types.ts";
import type { DeployGateEvaluation } from "~/lib/portal-types.ts";

interface ReleasesViewProps {
  project: ProjectDetail | null;
  onNewProject: () => void;
  onOpenReleaseSession: (sessionId: string) => void;
  onSelectTask: (taskId: string) => void;
  onEditDeployDoc: () => void;
  onOpenDeploySettings: () => void;
  onMutated?: () => void;
}

export function ReleasesView({
  project,
  onNewProject,
  onOpenReleaseSession,
  onSelectTask,
  onEditDeployDoc,
  onOpenDeploySettings,
  onMutated,
}: ReleasesViewProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [releases, setReleases] = useState<ReleaseRecord[]>([]);
  const [pendingTasks, setPendingTasks] = useState<TaskRecord[]>([]);
  const [failedTasks, setFailedTasks] = useState<TaskRecord[]>([]);
  const [activeRelease, setActiveRelease] = useState<ReleaseRecord | null>(null);
  const [gateEvaluations, setGateEvaluations] = useState<DeployGateEvaluation[]>([]);
  const [policy, setPolicy] = useState<ProjectDeployPolicy | null>(
    project?.deploy_policy ?? null,
  );
  const [deployDocExists, setDeployDocExists] = useState<boolean>(false);
  const [triggering, setTriggering] = useState(false);
  const [reverifyingId, setReverifyingId] = useState<string | null>(null);
  const [showAdvancedTrigger, setShowAdvancedTrigger] = useState(false);
  const [triggerPrompt, setTriggerPrompt] = useState("");
  const [forceEmpty, setForceEmpty] = useState(false);
  const [expandedReleaseId, setExpandedReleaseId] = useState<string | null>(null);

  const projectId = project?.id ?? null;

  const load = useCallback(
    async (silent = false) => {
      if (!projectId) {
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const [res, gatesRes] = await Promise.all([
          api.listProjectReleases(projectId, 50),
          api.listProjectDeployGates(projectId).catch(() => ({ evaluations: [] })),
        ]);
        setReleases(res.releases);
        setPendingTasks(res.pending_tasks);
        setFailedTasks(res.failed_tasks);
        setActiveRelease(res.active_release);
        setPolicy(res.deploy_policy);
        setDeployDocExists(res.deploy_doc_exists);
        setGateEvaluations(gatesRes.evaluations ?? []);
      } catch (err) {
        if (!silent) {
          toast.error(
            err instanceof ClientApiError ? err.message : "加载发布历史失败，请稍后重试",
          );
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [projectId, toast],
  );

  useEffect(() => {
    setPolicy(project?.deploy_policy ?? null);
    void load(false);
  }, [project?.id, project?.deploy_policy, load]);

  // Poll gently while a release is actively running or an AI gate is evaluating.
  const hasEvaluatingGate = gateEvaluations.some((g) => g.status === "evaluating");
  useEffect(() => {
    if (!activeRelease && !hasEvaluatingGate) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [activeRelease, hasEvaluatingGate, load]);

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--surface-canvas)] p-6">
        <EmptyState
          icon="rocket"
          title="尚未选择项目"
          description="创建或选择一个项目后，即可配置部署策略并查看生产发布历史。"
          action={
            <Button variant="primary" size="sm" icon="plus" onClick={onNewProject}>
              新建项目
            </Button>
          }
        />
      </div>
    );
  }

  const effectivePolicy = policy ?? project.deploy_policy;
  const queuedCount = pendingTasks.length + failedTasks.length;
  const pendingTaskIds = new Set(pendingTasks.map((t) => t.id));
  const escalatedPendingGates = gateEvaluations.filter(
    (g) => g.status === "escalated" && (queuedCount > 0 ? pendingTaskIds.has(g.task_id) : false),
  );

  const handleTrigger = async (force = forceEmpty) => {
    setTriggering(true);
    try {
      const res = await api.triggerProjectRelease(project.id, {
        force,
        prompt: triggerPrompt.trim() || undefined,
      });
      toast.success(`已启动发布 ${releaseCode(res.release.number)}，正在打开实时发布会话`);
      setTriggerPrompt("");
      setForceEmpty(false);
      setShowAdvancedTrigger(false);
      onMutated?.();
      await load(true);
      if (res.session?.id) {
        onOpenReleaseSession(res.session.id);
      }
    } catch (err) {
      toast.error(
        err instanceof ClientApiError
          ? err.message
          : "无法启动发布，请检查在线本机节点与项目状态",
      );
    } finally {
      setTriggering(false);
    }
  };

  const handleReverify = async (rel: ReleaseRecord) => {
    setReverifyingId(rel.id);
    try {
      const res = await api.reverifyProjectRelease(project.id, rel.id);
      toast.success(`已对 ${releaseCode(res.release.number)} 发起重新验收（仅检查，不重新部署）`);
      onMutated?.();
      await load(true);
      if (res.session?.id) {
        onOpenReleaseSession(res.session.id);
      }
    } catch (err) {
      toast.error(
        err instanceof ClientApiError
          ? err.message
          : "无法发起重新验收，请检查在线本机节点与项目状态",
      );
    } finally {
      setReverifyingId(null);
    }
  };

  return (
    <div className="flex-1 min-w-0 h-full overflow-y-auto bg-[var(--surface-canvas)]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-7 space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
                <Icon name="rocket" size={16} />
              </div>
              <h1 className="text-lg sm:text-xl font-semibold tracking-tight text-[var(--text-primary)] truncate">
                生产发布（Releases）
              </h1>
            </div>
            <p className="mt-1.5 text-xs sm:text-sm text-[var(--text-secondary)]">
              将「代码交付」与「生产发布」解耦：已交付任务汇总到待发布队列，由 Release Agent 按部署文档统一发布并验收。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load(false)}
              disabled={loading}
              icon="refresh-cw"
            >
              刷新
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onEditDeployDoc}
              icon="file-text"
            >
              编辑 DEPLOY.md
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={triggering}
              disabled={Boolean(activeRelease) || (queuedCount === 0 && !forceEmpty)}
              onClick={() => void handleTrigger(queuedCount === 0 ? true : forceEmpty)}
              icon="rocket"
            >
              {activeRelease
                ? activeRelease.status === "verifying"
                  ? `${releaseCode(activeRelease.number)} 待验收`
                  : `${releaseCode(activeRelease.number)} 发布中`
                : queuedCount > 0
                  ? `立即发布 (${queuedCount})`
                  : "立即发布"}
            </Button>
            <button
              type="button"
              onClick={() => setShowAdvancedTrigger((v) => !v)}
              title="自定义发布说明或强制空发布"
              aria-label="自定义发布说明或强制空发布"
              className="inline-flex items-center justify-center h-8 px-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
            >
              <Icon name="sliders-horizontal" size={13} />
            </button>
          </div>
        </div>

        {/* Advanced manual trigger panel */}
        {showAdvancedTrigger && (
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                手动触发选项
              </span>
              <button
                type="button"
                onClick={() => setShowAdvancedTrigger(false)}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                收起
              </button>
            </div>
            <textarea
              value={triggerPrompt}
              onChange={(e) => setTriggerPrompt(e.target.value)}
              rows={2}
              placeholder="可选：给 Release Agent 的附加发布说明（例如指定回归验证项或特殊注意事项）…"
              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-canvas)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={forceEmpty}
                  onChange={(e) => setForceEmpty(e.target.checked)}
                  className="rounded border-[var(--border-subtle)] accent-indigo-600"
                />
                <span>无待发布任务时仍强制发布当前最新代码（Force Release）</span>
              </label>
              <Button
                variant="primary"
                size="sm"
                loading={triggering}
                disabled={Boolean(activeRelease) || (queuedCount === 0 && !forceEmpty)}
                onClick={() => void handleTrigger(forceEmpty)}
                icon="rocket"
              >
                确认触发发布
              </Button>
            </div>
          </div>
        )}

        {/* Escalated AI Deploy Gate manual approval banner */}
        {escalatedPendingGates.length > 0 && !activeRelease && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.06] px-4 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 animate-rd-portal-in">
            <div className="flex items-start sm:items-center gap-3 min-w-0">
              <LivePulseDot tone="rose" active />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    有 {escalatedPendingGates.length} 条即时发布申请已转人工确认
                  </span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-rose-500/12 text-rose-700 dark:text-rose-300 font-medium">
                    AI 门禁 · escalated
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                  来自「{escalatedPendingGates[0]?.requested_by_label || "反馈成员"}」的申请因风险面或活跃度校验条件不足未自动放行，请查看下方评估记录后决定是否手动发布。
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="primary"
                size="sm"
                icon="rocket"
                loading={triggering}
                disabled={queuedCount === 0}
                onClick={() => void handleTrigger(false)}
              >
                人工确认并发布 ({queuedCount})
              </Button>
            </div>
          </div>
        )}

        {/* Active release live banner */}
        {activeRelease && (
          <div
            className={
              activeRelease.status === "verifying"
                ? "rounded-xl border border-sky-500/30 bg-sky-500/[0.06] px-4 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                : "rounded-xl border border-indigo-500/30 bg-indigo-500/[0.06] px-4 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
            }
          >
            <div className="flex items-start sm:items-center gap-3 min-w-0">
              <LivePulseDot
                tone={activeRelease.status === "verifying" ? "emerald" : "indigo"}
                active={activeRelease.status === "running"}
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    {releaseCode(activeRelease.number)}{" "}
                    {activeRelease.status === "verifying"
                      ? "等待重新验收（部署可能已在远端完成）"
                      : "正在部署生产环境"}
                  </span>
                  <ReleaseStatusBadge status={activeRelease.status} compact />
                  <ReleaseTriggerBadge trigger={activeRelease.trigger} />
                  {activeRelease.target_sha && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-hover)] text-[var(--text-secondary)]">
                      <Icon name="git-commit-horizontal" size={11} />
                      {activeRelease.target_sha.slice(0, 12)}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                  包含 {activeRelease.task_snapshot.length} 个任务 · 开始于{" "}
                  {formatRelativeTime(activeRelease.created_at)}
                  {activeRelease.status === "verifying"
                    ? "，关联任务已保留归属；点击「重新验收」将沿用原发布单仅执行健康与版本核验，不会重复部署。"
                    : "，期间已自动锁定本项目其他自动派发。"}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {activeRelease.status === "verifying" && (
                <Button
                  variant="primary"
                  size="sm"
                  loading={reverifyingId === activeRelease.id}
                  disabled={Boolean(reverifyingId)}
                  onClick={() => void handleReverify(activeRelease)}
                  icon="shield-check"
                >
                  重新验收
                </Button>
              )}
              {activeRelease.session_id && (
                <Button
                  variant={activeRelease.status === "verifying" ? "secondary" : "primary"}
                  size="sm"
                  onClick={() => onOpenReleaseSession(activeRelease.session_id!)}
                  icon="terminal"
                >
                  {activeRelease.status === "verifying" ? "查看发布会话" : "查看实时发布会话"}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Policy & deploy doc summary strip */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 flex flex-col justify-between gap-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  当前部署策略
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    {DEPLOY_MODE_LABELS[effectivePolicy.mode]}
                  </span>
                  {effectivePolicy.mode === "scheduled" && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono bg-violet-500/10 text-violet-700 dark:text-violet-300 border border-violet-500/20">
                      <Icon name="calendar-clock" size={11} />
                      {effectivePolicy.window_start}–{effectivePolicy.window_end} (
                      {effectivePolicy.timezone})
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {DEPLOY_MODE_DESCRIPTIONS[effectivePolicy.mode]}
                </p>
                {effectivePolicy.mode === "scheduled" && (
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    紧急任务穿透：
                    {effectivePolicy.allow_urgent_override
                      ? "已开启（urgent 立即发版）"
                      : "已关闭"}
                  </p>
                )}
                {(effectivePolicy.mode === "scheduled" ||
                  effectivePolicy.mode === "manual") && (
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    AI 门禁即时发布：
                    {effectivePolicy.allow_ai_immediate_deploy
                      ? effectivePolicy.allow_widget_deploy_request
                        ? "已开启（独立面板 + Widget 访客）"
                        : "已开启（仅独立面板授权链接）"
                      : "未开启"}
                  </p>
                )}
              </div>
              <Button variant="ghost" size="xs" onClick={onOpenDeploySettings}>
                配置
              </Button>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 flex flex-col justify-between gap-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  部署文档（文档驱动）
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {deployDocExists || effectivePolicy.doc_path ? (
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                      <Icon name="check-circle-2" size={14} />
                      {effectivePolicy.doc_path
                        ? `已指定 ${effectivePolicy.doc_path}`
                        : "已配置项目空间 DEPLOY.md"}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-300">
                      <Icon name="alert-triangle" size={14} />
                      尚未编写 DEPLOY.md
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {deployDocExists || effectivePolicy.doc_path
                    ? "Release Agent 将优先读取部署文档执行构建、发布与健康检查，不会凭空臆测线上命令。"
                    : "建议在项目空间编写 DEPLOY.md（或在设置中指定仓库内文档路径）；若缺失部署指引，Release Agent 会自动阻塞以保安全。"}
                </p>
              </div>
              <Button variant="ghost" size="xs" onClick={onEditDeployDoc}>
                {deployDocExists ? "编辑" : "创建"}
              </Button>
            </div>
          </div>
        </div>

        {/* Pending & failed deploy queue */}
        <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Icon name="layers" size={14} className="text-[var(--text-muted)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                待发布队列
              </h2>
              <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-[var(--surface-hover)] text-[var(--text-secondary)]">
                {pendingTasks.length} 待发布
              </span>
              {failedTasks.length > 0 && (
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-700 dark:text-rose-300">
                  {failedTasks.length} 上次失败
                </span>
              )}
            </div>
            {failedTasks.length > 0 && pendingTasks.length === 0 && (
              <span className="text-[11px] text-rose-600 dark:text-rose-400">
                已熔断自动重试，请排查后手动点击「立即发布」
              </span>
            )}
          </div>

          {queuedCount === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
              {effectivePolicy.mode === "none"
                ? "当前部署策略为「不管理部署」，已交付任务不会进入待发布队列。"
                : "目前没有等待发版的任务，生产环境已与最新已交付任务同步。"}
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border-subtle)]">
              {[...pendingTasks, ...failedTasks].map((task) => (
                <li
                  key={task.id}
                  onClick={() => onSelectTask(task.id)}
                  className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-mono text-[var(--text-muted)] shrink-0">
                      {taskCode(task.number)}
                    </span>
                    <PriorityBadge priority={task.priority} showLabel={false} />
                    <span className="text-sm text-[var(--text-primary)] truncate">
                      {task.title}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {task.delivery_ref && (
                      <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-hover)] text-[var(--text-secondary)] max-w-[180px] truncate">
                        {task.delivery_ref}
                      </span>
                    )}
                    <DeployStatusBadge
                      status={task.deploy_status}
                      releaseNumber={task.release_number}
                      compact
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* AI Deploy Gate Pre-flight Evaluations */}
        {gateEvaluations.length > 0 && (
          <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Icon
                  name="sparkles"
                  size={14}
                  className="text-indigo-600 dark:text-indigo-400"
                />
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  AI 门禁评估记录（Deploy Gate）
                </h2>
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-[var(--surface-hover)] text-[var(--text-secondary)] tabular-nums">
                  {gateEvaluations.length}
                </span>
              </div>
              <span className="text-[11px] text-[var(--text-muted)]">
                只读预检线上活跃度与变更风险面 · 内部证据仅管理员可见
              </span>
            </div>
            <div className="p-3.5 space-y-2.5">
              {gateEvaluations.slice(0, 12).map((evaluation) => (
                <DeployGateEvaluationRow
                  key={evaluation.id}
                  evaluation={evaluation}
                  onSelectTask={onSelectTask}
                  onTriggerRelease={
                    evaluation.status === "escalated" &&
                    !activeRelease &&
                    queuedCount > 0 &&
                    pendingTaskIds.has(evaluation.task_id)
                      ? () => void handleTrigger(false)
                      : undefined
                  }
                  triggeringRelease={triggering}
                />
              ))}
            </div>
          </section>
        )}

        {/* Release history */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon name="history" size={14} className="text-[var(--text-muted)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                发布历史（{releases.length}）
              </h2>
            </div>
          </div>

          {loading && releases.length === 0 ? (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-6 py-12 text-center text-xs text-[var(--text-muted)]">
              正在加载发布记录…
            </div>
          ) : releases.length === 0 ? (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)]">
              <EmptyState
                icon="rocket"
                title="暂无生产发布记录"
                description="启用部署策略并在任务交付后，所有自动与手动发布（REL-xxx）都会记录在这里，并可回看完整的 Release Agent 执行会话。"
                compact
              />
            </div>
          ) : (
            <div className="space-y-3">
              {releases.map((rel) => {
                const isExpanded = expandedReleaseId === rel.id;
                return (
                  <article
                    key={rel.id}
                    className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden"
                  >
                    <div className="px-4 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold font-mono text-[var(--text-primary)]">
                            {releaseCode(rel.number)}
                          </span>
                          <ReleaseStatusBadge status={rel.status} compact />
                          <ReleaseTriggerBadge trigger={rel.trigger} />
                          {rel.verification_context?.corrected_at && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">
                              已重新验收修正
                            </span>
                          )}
                          {(rel.deploy_ref || rel.target_sha) && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-hover)] text-[var(--text-secondary)] max-w-[220px] truncate">
                              <Icon name="git-commit-horizontal" size={11} />
                              {rel.deploy_ref || rel.target_sha.slice(0, 12)}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
                          <span title={formatDateTime(rel.created_at)}>
                            发起于 {formatRelativeTime(rel.created_at)}
                          </span>
                          {rel.finished_at && (
                            <span title={formatDateTime(rel.finished_at)}>
                              · 完成于 {formatDateTime(rel.finished_at)}
                            </span>
                          )}
                          <span>· 包含 {rel.task_snapshot.length} 个任务</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {(rel.status === "verifying" ||
                          rel.status === "failed" ||
                          rel.status === "blocked") && (
                          <Button
                            variant={rel.status === "verifying" ? "primary" : "secondary"}
                            size="xs"
                            loading={reverifyingId === rel.id}
                            disabled={
                              Boolean(reverifyingId) || activeRelease?.status === "running"
                            }
                            onClick={() => void handleReverify(rel)}
                            icon="shield-check"
                          >
                            重新验收
                          </Button>
                        )}
                        {rel.summary && (
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() =>
                              setExpandedReleaseId(isExpanded ? null : rel.id)
                            }
                          >
                            {isExpanded ? "收起详情" : "发布总结"}
                          </Button>
                        )}
                        {rel.session_id && (
                          <Button
                            variant="secondary"
                            size="xs"
                            onClick={() => onOpenReleaseSession(rel.session_id!)}
                            icon="terminal"
                          >
                            查看发布会话
                          </Button>
                        )}
                      </div>
                    </div>

                    {rel.task_snapshot.length > 0 && (
                      <div className="px-4 pb-3 flex flex-wrap gap-1.5">
                        {rel.task_snapshot.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => onSelectTask(t.id)}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-canvas)] hover:bg-[var(--surface-hover)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer max-w-full"
                          >
                            <span className="font-mono text-[11px] text-[var(--text-muted)]">
                              {taskCode(t.number)}
                            </span>
                            <span className="truncate max-w-[220px]">{t.title}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    {rel.summary && (isExpanded || rel.status !== "succeeded") && (
                      <div className="px-4 py-3 border-t border-[var(--border-subtle)] bg-[var(--surface-canvas)]/60 text-xs">
                        <MarkdownContent content={rel.summary} />
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
