import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "~/lib/api.ts";
import { resolveLocalTaskAgent } from "~/lib/model-catalog.ts";
import type {
  BridgeAgentSummary,
  ChatReasoningEffort,
  ChatRuntime,
  FeedbackAgentSettings,
  ProjectSummary,
} from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import {
  adaptSelectionForRuntimeSwitch,
  LocalAgentEffortSelect,
  LocalAgentModelCombobox,
  runtimeLabel,
} from "./LocalAgentModelPicker.tsx";
import { Button, LivePulseDot, Select, Switch, cn, useToast, type SelectOption } from "./ui.tsx";

interface FeedbackAgentSettingsCardProps {
  project: ProjectSummary;
  onOpenGlobalAgents?: () => void;
}

const MAX_PROMPT_CHARS = 12000;

const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `你是本产品的反馈支持与故障排查助手。
- 优先结合项目代码与用户截图，判断遇到的是「使用/配置问题」还是「真实产品缺陷」。
- 属于用法或配置问题时，给出直接、清晰的操作步骤，无需引导提单。
- 信息不足时，先针对缺失的页面、操作步骤或报错追问 1-2 个具体问题。
- 确认为真实 Bug 或功能缺口时，总结现象、复现步骤与排查结论，并生成工单草稿由用户确认提交。
- 面向终端用户表达，不输出原始源码、内部路径或任何敏感信息。`;

export function FeedbackAgentSettingsCard({
  project,
  onOpenGlobalAgents,
}: FeedbackAgentSettingsCardProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);

  const [saved, setSaved] = useState<FeedbackAgentSettings | null>(null);
  const [agents, setAgents] = useState<BridgeAgentSummary[]>([]);
  const [effectivePriority, setEffectivePriority] = useState<string[]>([]);

  const [enabled, setEnabled] = useState(false);
  const [executionTarget, setExecutionTarget] = useState("auto");
  const [runtime, setRuntime] = useState<ChatRuntime>("codex");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ChatReasoningEffort>("default");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const reqSeq = useRef(0);

  const loadAll = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoadError("");
    try {
      const [settings, routingRes] = await Promise.all([
        api.getProjectFeedbackAgent(project.id),
        api.getProjectExecutionRouting(project.id).catch(() => null),
      ]);
      if (seq !== reqSeq.current) return;
      setSaved(settings);
      setEnabled(Boolean(settings.enabled));
      setExecutionTarget(settings.execution_target || "auto");
      setRuntime(settings.runtime === "claude" || settings.runtime === "agy" ? settings.runtime : "codex");
      setModel(settings.model || "");
      setReasoningEffort(settings.reasoning_effort || "default");
      setSystemPrompt(settings.system_prompt || "");
      if (routingRes) {
        setAgents(routingRes.agents);
        setEffectivePriority(routingRes.effective_priority);
      }
    } catch (err) {
      if (seq !== reqSeq.current) return;
      setLoadError(
        err instanceof Error ? err.message : "无法读取反馈诊断 Agent 配置，请稍后重试。",
      );
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    setLoading(true);
    setSaveError(null);
    void loadAll();
  }, [loadAll]);

  const localOnlyPriority = useMemo(
    () => effectivePriority.filter((item) => item.startsWith("local:")),
    [effectivePriority],
  );

  const resolvedPreview = useMemo(
    () =>
      resolveLocalTaskAgent({
        agents,
        effectivePriority: localOnlyPriority,
        projectId: project.id,
        executionTarget,
        runtime,
      }),
    [agents, localOnlyPriority, project.id, executionTarget, runtime],
  );

  const activeAgent = useMemo(() => {
    if (executionTarget.startsWith("local:")) {
      const id = executionTarget.slice("local:".length);
      return agents.find((a) => a.id === id) ?? null;
    }
    return resolvedPreview.agent;
  }, [agents, executionTarget, resolvedPreview.agent]);

  const targetOptions = useMemo<Array<SelectOption<string>>>(() => {
    const autoAgent = resolveLocalTaskAgent({
      agents,
      effectivePriority: localOnlyPriority,
      projectId: project.id,
      executionTarget: "auto",
      runtime,
    }).agent;

    const opts: Array<SelectOption<string>> = [
      {
        value: "auto",
        label: autoAgent
          ? `跟随项目本机优先级（${autoAgent.name}）`
          : "跟随项目本机优先级（自动）",
        description: autoAgent?.online
          ? "自动选择当前在线且已绑定目录的优先电脑"
          : "当前无在线且已绑定目录的本机节点",
      },
    ];

    for (const agent of agents) {
      const binding = agent.bindings.find((b) => b.project_id === project.id);
      const boundOk = Boolean(binding?.enabled && binding?.path_ok);
      const statusText = !agent.online
        ? "离线"
        : boundOk
          ? "在线 · 已绑定"
          : "在线 · 未绑定目录";
      opts.push({
        value: `local:${agent.id}`,
        label: agent.name,
        badge: statusText,
        description: binding?.workdir || "尚未绑定本项目本地目录",
      });
    }

    if (
      executionTarget.startsWith("local:") &&
      !opts.some((o) => o.value === executionTarget)
    ) {
      opts.push({
        value: executionTarget,
        label: executionTarget.slice("local:".length),
        badge: "已移除或离线",
      });
    }

    return opts;
  }, [agents, localOnlyPriority, project.id, runtime, executionTarget]);

  const runtimeOptions = useMemo<Array<SelectOption<ChatRuntime>>>(() => {
    const list: ChatRuntime[] = ["codex", "claude", "agy"];
    return list.map((rt) => {
      const info = activeAgent?.runtimes?.[rt];
      let badge: string | undefined;
      if (activeAgent) {
        badge = info?.available ? "已安装" : "未检测到";
      }
      return {
        value: rt,
        label: runtimeLabel(rt),
        badge,
        description:
          info?.default_model
            ? `默认模型：${info.default_model}`
            : `本机 ${runtimeLabel(rt)}`,
      };
    });
  }, [activeAgent]);

  const isDirty = useMemo(() => {
    if (!saved) return false;
    return (
      enabled !== Boolean(saved.enabled) ||
      executionTarget !== (saved.execution_target || "auto") ||
      runtime !== (saved.runtime === "claude" || saved.runtime === "agy" ? saved.runtime : "codex") ||
      model.trim() !== (saved.model || "").trim() ||
      reasoningEffort !== (saved.reasoning_effort || "default") ||
      systemPrompt.trim() !== (saved.system_prompt || "").trim()
    );
  }, [saved, enabled, executionTarget, runtime, model, reasoningEffort, systemPrompt]);

  const handleTargetChange = (nextTarget: string) => {
    setExecutionTarget(nextTarget);
    setSaveError(null);
    const nextAgent =
      nextTarget.startsWith("local:")
        ? agents.find((a) => `local:${a.id}` === nextTarget) ?? null
        : resolveLocalTaskAgent({
            agents,
            effectivePriority: localOnlyPriority,
            projectId: project.id,
            executionTarget: "auto",
            runtime,
          }).agent;
    const adapted = adaptSelectionForRuntimeSwitch({
      nextRuntime: runtime,
      agent: nextAgent,
      currentModel: model,
      currentEffort: reasoningEffort,
    });
    setModel(adapted.model);
    setReasoningEffort(adapted.effort);
  };

  const handleRuntimeChange = (nextRuntime: ChatRuntime) => {
    if (nextRuntime === runtime) return;
    setRuntime(nextRuntime);
    setSaveError(null);
    const nextAgent =
      executionTarget.startsWith("local:")
        ? agents.find((a) => `local:${a.id}` === executionTarget) ?? null
        : resolveLocalTaskAgent({
            agents,
            effectivePriority: localOnlyPriority,
            projectId: project.id,
            executionTarget: "auto",
            runtime: nextRuntime,
          }).agent;
    const adapted = adaptSelectionForRuntimeSwitch({
      nextRuntime,
      agent: nextAgent,
      currentModel: model,
      currentEffort: reasoningEffort,
    });
    setModel(adapted.model);
    setReasoningEffort(adapted.effort);
  };

  const handleReset = () => {
    if (!saved) return;
    setEnabled(Boolean(saved.enabled));
    setExecutionTarget(saved.execution_target || "auto");
    setRuntime(saved.runtime === "claude" || saved.runtime === "agy" ? saved.runtime : "codex");
    setModel(saved.model || "");
    setReasoningEffort(saved.reasoning_effort || "default");
    setSystemPrompt(saved.system_prompt || "");
    setSaveError(null);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateProjectFeedbackAgent(project.id, {
        enabled,
        execution_target: executionTarget,
        runtime,
        model: model.trim(),
        reasoning_effort: reasoningEffort,
        system_prompt: systemPrompt.trim(),
      });
      setSaved(updated);
      setEnabled(Boolean(updated.enabled));
      setExecutionTarget(updated.execution_target || "auto");
      setRuntime(updated.runtime === "claude" || updated.runtime === "agy" ? updated.runtime : "codex");
      setModel(updated.model || "");
      setReasoningEffort(updated.reasoning_effort || "default");
      setSystemPrompt(updated.system_prompt || "");
      if (updated.enabled && !updated.available) {
        toast.info("配置已保存，但当前本机节点暂不在线");
      } else {
        toast.success("反馈诊断 Agent 配置已保存");
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "保存反馈 Agent 配置失败，请重试。";
      setSaveError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const statusPill = useMemo(() => {
    if (loading || !saved) return null;
    if (!saved.enabled) {
      return {
        label: "未启用",
        dotTone: "zinc" as const,
        pulse: false,
        className:
          "border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-muted)]",
      };
    }
    if (saved.available && saved.resolved_agent) {
      return {
        label: `在线 · ${saved.resolved_agent.name}`,
        dotTone: "emerald" as const,
        pulse: true,
        className:
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      };
    }
    return {
      label: saved.unavailable_reason || "本机节点离线",
      dotTone: "amber" as const,
      pulse: false,
      className:
        "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    };
  }, [loading, saved]);

  const noLocalAgents = !loading && agents.length === 0;

  return (
    <form
      id="relaydesk-feedback-agent"
      onSubmit={(e) => void handleSave(e)}
      className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs scroll-mt-6"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
            <Icon name="message-square-text" size={15} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
              反馈诊断 Agent
            </h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
              通过你接入的本机节点在只读沙箱内回答使用问题、排查疑似缺陷，确认后再生成工单。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {statusPill && (
            <span
              data-testid="feedback-agent-status-pill"
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium border max-w-[260px] truncate",
                statusPill.className,
              )}
              title={statusPill.label}
            >
              <LivePulseDot tone={statusPill.dotTone} active={statusPill.pulse} />
              <span className="truncate">{statusPill.label}</span>
            </span>
          )}
          {onOpenGlobalAgents && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              icon="monitor"
              onClick={onOpenGlobalAgents}
            >
              本机节点
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="p-6 flex items-center justify-center gap-2 text-[12.5px] text-[var(--text-muted)]">
          <Icon name="loader-2" size={14} className="animate-spin" />
          <span>正在加载反馈诊断配置…</span>
        </div>
      ) : loadError ? (
        <div className="p-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12.5px] text-rose-600 dark:text-rose-400">
            <Icon name="alert-circle" size={15} />
            <span>{loadError}</span>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            icon="refresh-cw"
            onClick={() => void loadAll()}
          >
            重试
          </Button>
        </div>
      ) : (
        <div className="p-5 space-y-5">
          {/* Master switch */}
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3.5">
            <Switch
              checked={enabled}
              disabled={saving}
              onChange={(next) => {
                setEnabled(next);
                setSaveError(null);
              }}
              label="启用反馈对话诊断（Portal & Widget）"
              description="开启后访客优先进入流式诊断对话；当所选本机节点离线时，反馈入口会如实提示离线并暂停接受在线诊断。"
            />
          </div>

          {noLocalAgents && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5 text-[12px] text-amber-900 dark:text-amber-200">
              <span>尚未接入任何本机节点。请先在全局设置连接你的电脑并绑定本项目目录。</span>
              {onOpenGlobalAgents && (
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  icon="monitor"
                  onClick={onOpenGlobalAgents}
                >
                  去连接电脑
                </Button>
              )}
            </div>
          )}

          {/* Local Bridge Node + Harness + Model + Effort */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/40 p-4">
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-[var(--text-secondary)]">
                执行节点（我的电脑）
              </p>
              <Select<string>
                ariaLabel="反馈诊断执行节点"
                fullWidth
                size="sm"
                value={executionTarget}
                disabled={saving}
                options={targetOptions}
                onChange={handleTargetChange}
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-[var(--text-secondary)]">
                Harness（本机工具）
              </p>
              <Select<ChatRuntime>
                ariaLabel="反馈诊断 Harness"
                fullWidth
                size="sm"
                value={runtime}
                disabled={saving}
                options={runtimeOptions}
                onChange={handleRuntimeChange}
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-[var(--text-secondary)]">
                模型（LLM）
              </p>
              <LocalAgentModelCombobox
                runtime={runtime}
                agent={activeAgent}
                model={model}
                currentEffort={reasoningEffort}
                disabled={saving}
                direction="down"
                size="sm"
                fullWidth
                ariaLabel="反馈诊断模型"
                onChange={(nextModel, nextEffort) => {
                  setModel(nextModel);
                  setReasoningEffort(nextEffort);
                  setSaveError(null);
                }}
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-[var(--text-secondary)]">
                推理强度
              </p>
              <LocalAgentEffortSelect
                runtime={runtime}
                agent={activeAgent}
                model={model}
                value={reasoningEffort}
                disabled={saving}
                size="sm"
                fullWidth
                ariaLabel="反馈诊断推理强度"
                onChange={(next) => {
                  setReasoningEffort(next);
                  setSaveError(null);
                }}
              />
            </div>
          </div>

          {/* System Prompt */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="feedback-agent-system-prompt"
                className="text-[12.5px] font-medium text-[var(--text-primary)]"
              >
                System Prompt
              </label>
              <div className="flex items-center gap-2.5">
                {!systemPrompt.trim() && (
                  <button
                    type="button"
                    onClick={() => {
                      setSystemPrompt(DEFAULT_SYSTEM_PROMPT_TEMPLATE);
                      setSaveError(null);
                    }}
                    className="text-[11.5px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                  >
                    填入推荐模板
                  </button>
                )}
                <span className="text-[11px] font-mono tabular-nums text-[var(--text-muted)]">
                  {systemPrompt.length} / {MAX_PROMPT_CHARS}
                </span>
              </div>
            </div>

            <textarea
              id="feedback-agent-system-prompt"
              data-testid="feedback-agent-system-prompt"
              rows={5}
              maxLength={MAX_PROMPT_CHARS}
              disabled={saving}
              value={systemPrompt}
              onChange={(e) => {
                setSystemPrompt(e.target.value);
                setSaveError(null);
              }}
              placeholder="定义产品背景、语气与分诊准则（留空则使用内置的通用分诊提示词）…"
              className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3 text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 disabled:opacity-60"
            />
            <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              运行在所选电脑的只读沙箱内（支持查阅代码与查看用户截图；无文件写入、无外网、无数据库/运维权限）。
            </p>
          </div>

          {saveError && (
            <div
              role="alert"
              className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-[12px] text-rose-700 dark:text-rose-300 flex items-center gap-2"
            >
              <Icon name="alert-circle" size={14} className="shrink-0" />
              <span>{saveError}</span>
            </div>
          )}
        </div>
      )}

      {!loading && !loadError && (
        <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11.5px] text-[var(--text-muted)]">
            {isDirty
              ? "有未保存的更改"
              : saved?.enabled && saved.available && saved.resolved_agent
                ? `当前由 ${saved.resolved_agent.name}（${runtimeLabel(saved.runtime)}${saved.resolved_agent.model ? ` · ${saved.resolved_agent.model}` : ""}）承接`
                : saved?.enabled
                  ? `当前暂不可用：${saved.unavailable_reason || "本机节点离线"}`
                  : "已关闭，反馈入口将展示人工提单模式"}
          </span>
          <div className="flex items-center gap-2">
            {isDirty && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={handleReset}
              >
                撤销修改
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon="check"
              loading={saving}
              disabled={!isDirty}
            >
              保存配置
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
