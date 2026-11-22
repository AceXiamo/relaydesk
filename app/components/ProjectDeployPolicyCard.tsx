import { useEffect, useState } from "react";
import { Icon } from "./Icon.tsx";
import { Button, Select, Switch, useToast } from "./ui.tsx";
import { LocalAgentModelCombobox } from "./LocalAgentModelPicker.tsx";
import { resolveLocalTaskAgent } from "~/lib/model-catalog.ts";
import { api, ClientApiError } from "~/lib/api.ts";
import { DEPLOY_MODE_DESCRIPTIONS, DEPLOY_MODE_LABELS } from "~/lib/format.ts";
import type { ChatRuntime, DeployMode, ProjectDeployPolicy, ProjectDetail, ProjectExecutionRoutingResponse } from "~/lib/types.ts";

interface ProjectDeployPolicyCardProps {
  project: ProjectDetail;
  onPolicyUpdated: (policy: ProjectDeployPolicy) => void;
  onEditDeployDoc?: () => void;
  onOpenReleases?: () => void;
}

const DEPLOY_MODE_OPTIONS: Array<{
  mode: DeployMode;
  icon: string;
  badge?: string;
}> = [
  { mode: "none", icon: "ban", badge: "默认" },
  { mode: "manual", icon: "hand" },
  { mode: "immediate", icon: "zap" },
  { mode: "scheduled", icon: "calendar-clock" },
];

const COMMON_TIMEZONES = [
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
];

export function ProjectDeployPolicyCard({
  project,
  onPolicyUpdated,
  onEditDeployDoc,
  onOpenReleases,
}: ProjectDeployPolicyCardProps) {
  const toast = useToast();
  const [mode, setMode] = useState<DeployMode>(project.deploy_policy.mode);
  const [windowStart, setWindowStart] = useState(project.deploy_policy.window_start);
  const [windowEnd, setWindowEnd] = useState(project.deploy_policy.window_end);
  const [timezone, setTimezone] = useState(project.deploy_policy.timezone);
  const [allowUrgent, setAllowUrgent] = useState(
    project.deploy_policy.allow_urgent_override,
  );
  const [docPath, setDocPath] = useState(project.deploy_policy.doc_path);
  const [runtime, setRuntime] = useState<ChatRuntime | null>(project.deploy_policy.runtime ?? null);
  const [model, setModel] = useState(project.deploy_policy.model ?? "");
  const [routing, setRouting] = useState<ProjectExecutionRoutingResponse | null>(null);
  const [routingError, setRoutingError] = useState(false);
  const releaseAgent = runtime && routing ? resolveLocalTaskAgent({
    agents: routing.agents,
    effectivePriority: routing.effective_priority,
    projectId: project.id,
    runtime,
  }).agent : null;
  const [saving, setSaving] = useState(false);
  const [deployDocExists, setDeployDocExists] = useState<boolean | null>(null);

  useEffect(() => {
    setRuntime(project.deploy_policy.runtime ?? null);
    setModel(project.deploy_policy.model ?? "");
    setMode(project.deploy_policy.mode);
    setWindowStart(project.deploy_policy.window_start);
    setWindowEnd(project.deploy_policy.window_end);
    setTimezone(project.deploy_policy.timezone);
    setAllowUrgent(project.deploy_policy.allow_urgent_override);
    setDocPath(project.deploy_policy.doc_path);
  }, [project.id, project.deploy_policy]);

  useEffect(() => {
    let active = true;
    api.getProjectExecutionRouting(project.id)
      .then((res) => { if (active) setRouting(res); })
      .catch(() => { if (active) setRoutingError(true); });
    api
      .getWorkspaceDeployDoc(project.id)
      .then((res) => {
        if (active) setDeployDocExists(res.deploy_doc.exists);
      })
      .catch(() => {
        if (active) setDeployDocExists(null);
      });
    return () => {
      active = false;
    };
  }, [project.id]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.updateProjectDeployPolicy(project.id, {
        mode,
        runtime,
        model: model || null,
        window_start: windowStart,
        window_end: windowEnd,
        timezone: timezone.trim() || "Asia/Shanghai",
        allow_urgent_override: allowUrgent,
        doc_path: docPath.trim(),
      });
      onPolicyUpdated(res.deploy_policy);
      toast.success("生产部署策略已保存");
    } catch (err) {
      toast.error(
        err instanceof ClientApiError ? err.message : "保存部署策略失败",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      id="relaydesk-deploy-policy"
      onSubmit={(e) => void handleSave(e)}
      className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs scroll-mt-6"
    >
      <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
            <Icon name="rocket" size={15} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
              生产部署策略（Release Pipeline）
            </h2>
            <p className="text-[12px] text-[var(--text-muted)]">
              解耦「代码交付」与「生产发布」：由 Release Agent 读取部署文档，按策略自动或手动统一发版。
            </p>
          </div>
        </div>
        {onOpenReleases && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            icon="history"
            onClick={onOpenReleases}
          >
            查看发布队列
          </Button>
        )}
      </div>

      <div className="p-5 space-y-5">
        {/* Deploy Mode 4-option selector */}
        <div className="space-y-2">
          <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
            发布触发模式
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {DEPLOY_MODE_OPTIONS.map((opt) => {
              const active = mode === opt.mode;
              return (
                <button
                  key={opt.mode}
                  type="button"
                  onClick={() => setMode(opt.mode)}
                  aria-pressed={active}
                  className={`group flex flex-col items-start gap-1.5 p-3 rounded-xl border text-left transition-all duration-150 cursor-pointer ${
                    active
                      ? "border-indigo-500/60 bg-indigo-500/[0.07] ring-1 ring-indigo-500/20 shadow-2xs"
                      : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  <div className="w-full flex items-center justify-between gap-1.5">
                    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)]">
                      <Icon
                        name={opt.icon}
                        size={13.5}
                        className={
                          active
                            ? "text-indigo-600 dark:text-indigo-400"
                            : "text-[var(--text-muted)] group-hover:text-[var(--text-primary)]"
                        }
                      />
                      {DEPLOY_MODE_LABELS[opt.mode]}
                    </span>
                    {opt.badge && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] text-[var(--text-muted)]">
                        {opt.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                    {DEPLOY_MODE_DESCRIPTIONS[opt.mode]}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid items-start gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-xs text-[var(--text-secondary)]">发布 Agent Harness</p>
            <Select<ChatRuntime | "inherit">
              ariaLabel="发布 Agent Harness"
              fullWidth
              size="sm"
              value={runtime ?? "inherit"}
              disabled={saving}
              options={[
                { value: "inherit", label: "跟随任务 Harness 和模型" },
                { value: "codex", label: "Codex CLI" },
                { value: "claude", label: "Claude Code" },
              ]}
              onChange={(value) => {
                const nextRuntime = value === "inherit" ? null : value;
                if (nextRuntime !== runtime) {
                  setRuntime(nextRuntime);
                  setModel("");
                }
              }}
            />
          </div>
          {runtime && (
            <div className="space-y-1.5">
              <p className="text-xs text-[var(--text-secondary)]">发布 Agent 模型</p>
              <LocalAgentModelCombobox
                key={runtime}
                runtime={runtime}
                agent={releaseAgent}
                model={model}
                fullWidth
                ariaLabel="发布 Agent 模型"
                disabled={saving || !routing}
                onChange={setModel}
              />
              {routingError && <p className="text-xs text-[var(--text-muted)]">读取节点模型失败，请刷新重试。</p>}
            </div>
          )}
        </div>

        {/* Scheduled Window Settings */}
        {mode === "scheduled" && (
          <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-4 space-y-4">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-[var(--text-primary)]">
              <Icon name="calendar-clock" size={14} className="text-violet-500" />
              低峰发布窗口设置
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block space-y-1">
                <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                  窗口开始时间
                </span>
                <input
                  type="time"
                  value={windowStart}
                  onChange={(e) => setWindowStart(e.target.value)}
                  className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] font-mono text-[13px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                  窗口结束时间
                </span>
                <input
                  type="time"
                  value={windowEnd}
                  onChange={(e) => setWindowEnd(e.target.value)}
                  className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] font-mono text-[13px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                  时区（IANA）
                </span>
                <input
                  type="text"
                  list="rd-deploy-timezones"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="Asia/Shanghai"
                  className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] font-mono text-[12.5px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
                />
                <datalist id="rd-deploy-timezones">
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </label>
            </div>
            <p className="text-[11.5px] text-[var(--text-muted)]">
              支持跨午夜窗口（例如 <code className="font-mono">22:00</code> –{" "}
              <code className="font-mono">06:00</code>），调度器每分钟检查一次并在当前队列空闲后合并发布。
            </p>

            <div className="pt-2 border-t border-violet-500/15 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-[var(--text-primary)]">
                  允许紧急任务（urgent）穿透窗口期
                </div>
                <p className="text-[11.5px] text-[var(--text-muted)]">
                  开启后，若待发布队列包含 <code className="font-mono">urgent</code> 优先级任务，将在队列空闲后立即发版。
                </p>
              </div>
              <Switch
                checked={allowUrgent}
                onChange={setAllowUrgent}
              />
            </div>
          </div>
        )}

        {/* Deploy Documentation Reference & Status */}
        {mode !== "none" && (
          <div className="space-y-3">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2">
                  <Icon
                    name={
                      deployDocExists || docPath.trim()
                        ? "check-circle-2"
                        : "alert-triangle"
                    }
                    size={14}
                    className={
                      deployDocExists || docPath.trim()
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-amber-600 dark:text-amber-400"
                    }
                  />
                  <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                    项目空间部署文档（DEPLOY.md）
                  </span>
                  <span
                    className={`text-[10.5px] px-1.5 py-0.5 rounded-full font-medium ${
                      deployDocExists
                        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    }`}
                  >
                    {deployDocExists ? "已配置" : "未创建"}
                  </span>
                </div>
                <p className="text-[11.5px] text-[var(--text-muted)]">
                  Release Agent 启动时会按「下方自定义路径 → 项目空间 DEPLOY.md → HANDBOOK.md → 仓库文档」顺序查找部署流程；找不到明确文档时会自动阻塞以防误操作。
                </p>
              </div>
              {onEditDeployDoc && (
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  icon="file-text"
                  onClick={onEditDeployDoc}
                  className="shrink-0"
                >
                  {deployDocExists ? "编辑 DEPLOY.md" : "前往编写 DEPLOY.md"}
                </Button>
              )}
            </div>

            <label className="block space-y-1.5">
              <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                自定义部署文档路径（可选）
              </span>
              <input
                type="text"
                value={docPath}
                onChange={(e) => setDocPath(e.target.value)}
                placeholder="留空则优先读取项目空间 DEPLOY.md；可填写仓库内相对路径，如 docs/DEPLOY.md"
                className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] font-mono text-[12.5px] text-[var(--text-primary)] placeholder:font-sans placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500"
              />
            </label>
          </div>
        )}
      </div>

      <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex justify-end">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          保存部署策略
        </Button>
      </div>
    </form>
  );
}
