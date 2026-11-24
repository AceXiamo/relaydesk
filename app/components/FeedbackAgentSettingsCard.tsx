import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ClientApiError } from "~/lib/api.ts";
import { builtinModels } from "~/lib/model-catalog.ts";
import type {
  ChatRuntime,
  FeedbackAgentSettings,
  ModelCatalogItem,
  ProjectCliStatus,
  ProjectDetail,
} from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { Button, LivePulseDot, Switch, cn, useToast } from "./ui.tsx";

interface FeedbackAgentSettingsCardProps {
  project: ProjectDetail;
}

const RUNTIME_OPTIONS: Array<{
  id: ChatRuntime;
  label: string;
  vendor: string;
  desc: string;
  icon: string;
}> = [
  {
    id: "codex",
    label: "Codex CLI",
    vendor: "OpenAI / 兼容网关",
    desc: "隔离运行 Codex CLI 执行多轮预诊与使用解答",
    icon: "terminal",
  },
  {
    id: "claude",
    label: "Claude Code",
    vendor: "Anthropic / 兼容网关",
    desc: "隔离运行 Claude Code 执行多轮预诊与使用解答",
    icon: "sparkles",
  },
];

const PUBLIC_GUIDE_MAX = 12000;

export function FeedbackAgentSettingsCard({ project }: FeedbackAgentSettingsCardProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);

  const [saved, setSaved] = useState<FeedbackAgentSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [runtime, setRuntime] = useState<ChatRuntime>("codex");
  const [model, setModel] = useState("");
  const [publicGuide, setPublicGuide] = useState("");

  const [cliStatus, setCliStatus] = useState<ProjectCliStatus | null>(null);
  const reqSeqRef = useRef(0);

  const loadSettings = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setLoadError(null);
    setSaveMessage(null);
    try {
      const [agentCfg, cliCfg] = await Promise.all([
        api.getProjectFeedbackAgent(project.id),
        api.getProjectCliConfig(project.id).catch(() => null),
      ]);
      if (seq !== reqSeqRef.current) return;
      const normalized: FeedbackAgentSettings = {
        enabled: Boolean(agentCfg.enabled),
        available:
          typeof agentCfg.available === "boolean" ? agentCfg.available : undefined,
        runtime: agentCfg.runtime === "claude" ? "claude" : "codex",
        model: typeof agentCfg.model === "string" ? agentCfg.model : "",
        public_guide:
          typeof agentCfg.public_guide === "string" ? agentCfg.public_guide : "",
      };
      setSaved(normalized);
      setEnabled(normalized.enabled);
      setRuntime(normalized.runtime);
      setModel(normalized.model);
      setPublicGuide(normalized.public_guide);
      setCliStatus(cliCfg);
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      setLoadError(
        err instanceof ClientApiError
          ? err.message
          : "无法加载反馈诊断 Agent 配置，请稍后重试。",
      );
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const suggestedModels = useMemo(() => {
    const list: ModelCatalogItem[] = [];
    const seen = new Set<string>();
    for (const item of cliStatus?.models ?? []) {
      if (item.runtime === runtime && item.id && !seen.has(item.id)) {
        seen.add(item.id);
        list.push(item);
      }
    }
    if (cliStatus?.runtime === runtime && cliStatus.model && !seen.has(cliStatus.model)) {
      seen.add(cliStatus.model);
      list.push({ id: cliStatus.model, runtime, label: `${cliStatus.model}（项目云端）` });
    }
    for (const item of builtinModels) {
      if (item.runtime === runtime && !seen.has(item.id)) {
        seen.add(item.id);
        list.push(item);
      }
    }
    return list;
  }, [cliStatus, runtime]);

  const dirty = useMemo(() => {
    if (!saved) return false;
    return (
      enabled !== saved.enabled ||
      runtime !== saved.runtime ||
      model.trim() !== saved.model.trim() ||
      publicGuide !== saved.public_guide
    );
  }, [saved, enabled, runtime, model, publicGuide]);

  const cliMismatchWarning = useMemo(() => {
    if (!cliStatus) return null;
    if (!cliStatus.configured) {
      return `当前项目尚未在「项目 CLI 配置」中保存云端 API 密钥；反馈诊断需要相同运行时（${runtime === "claude" ? "Claude Code" : "Codex CLI"}）的项目云端密钥与受信任端点。`;
    }
    if (cliStatus.runtime !== runtime) {
      return `当前「项目 CLI 配置」的云端运行时为 ${cliStatus.runtime === "claude" ? "Claude Code" : "Codex CLI"}，与此处选择的 ${runtime === "claude" ? "Claude Code" : "Codex CLI"} 不一致；启用前需确保相同运行时已配置云端密钥。`;
    }
    return null;
  }, [cliStatus, runtime]);

  const handleRuntimeSwitch = (nextRuntime: ChatRuntime) => {
    if (nextRuntime === runtime) return;
    setRuntime(nextRuntime);
    setSaveMessage(null);
    // Clear model only if it belonged to the previous runtime's built-in catalog
    const prevKnown = builtinModels.some(
      (m) => m.runtime === runtime && m.id === model.trim(),
    );
    if (prevKnown) {
      setModel("");
    }
  };

  const handleReset = () => {
    if (!saved) return;
    setEnabled(saved.enabled);
    setRuntime(saved.runtime);
    setModel(saved.model);
    setPublicGuide(saved.public_guide);
    setSaveMessage(null);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || loadError) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const updated = await api.updateProjectFeedbackAgent(project.id, {
        enabled,
        runtime,
        model: model.trim(),
        public_guide: publicGuide,
      });
      const normalized: FeedbackAgentSettings = {
        enabled: Boolean(updated.enabled),
        available:
          typeof updated.available === "boolean" ? updated.available : undefined,
        runtime: updated.runtime === "claude" ? "claude" : "codex",
        model: typeof updated.model === "string" ? updated.model : "",
        public_guide:
          typeof updated.public_guide === "string" ? updated.public_guide : "",
      };
      setSaved(normalized);
      setEnabled(normalized.enabled);
      setRuntime(normalized.runtime);
      setModel(normalized.model);
      setPublicGuide(normalized.public_guide);
      if (normalized.enabled && normalized.available === false) {
        setSaveMessage({
          tone: "ok",
          text: "配置意图已保存（当前执行器未就绪，入口将继续保持人工提单）。",
        });
        toast.info("反馈 Agent 配置已保存，但当前执行器尚未就绪");
      } else {
        setSaveMessage({ tone: "ok", text: "反馈 Agent 配置已保存。" });
        toast.success("反馈 Agent 配置已保存");
      }
    } catch (err) {
      const msg =
        err instanceof ClientApiError
          ? err.message
          : "保存反馈 Agent 配置失败，请重试。";
      setSaveMessage({ tone: "error", text: msg });
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const scrollToProjectCli = () => {
    document
      .getElementById("relaydesk-project-cli")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const statusPill = useMemo(() => {
    if (loading || !saved) return null;
    if (saved.enabled && saved.available === true) {
      return {
        label: "运行就绪",
        dotTone: "emerald" as const,
        pulse: true,
        className:
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      };
    }
    if (saved.enabled && saved.available === false) {
      return {
        label: "已启用，但执行器不可用",
        dotTone: "amber" as const,
        pulse: false,
        className:
          "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-300",
      };
    }
    if (saved.enabled) {
      return {
        label: "已开启",
        dotTone: "indigo" as const,
        pulse: true,
        className:
          "border-indigo-500/25 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
      };
    }
    return {
      label: "未启用 · 人工提单",
      dotTone: "zinc" as const,
      pulse: false,
      className:
        "border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-muted)]",
    };
  }, [loading, saved]);

  return (
    <form
      id="relaydesk-feedback-agent"
      onSubmit={(e) => void handleSave(e)}
      className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs scroll-mt-6"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
            <Icon name="message-square-code" size={15} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
                反馈诊断 Agent（Portal &amp; Widget）
              </h2>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-medium border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-secondary)]">
                独立于任务 / 发布配置
              </span>
            </div>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
              为独立反馈面板与嵌入组件配置专属 Harness、模型和公开产品使用说明；不复用任务开发与生产发布的运行时及本机 Bridge 节点。
            </p>
          </div>
        </div>

        {statusPill && (
          <span
            data-testid="feedback-agent-status-pill"
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium border shrink-0",
              statusPill.className,
            )}
          >
            <LivePulseDot tone={statusPill.dotTone} active={statusPill.pulse} />
            <span>{statusPill.label}</span>
          </span>
        )}
      </div>

      {loading ? (
        <div className="p-6 flex items-center justify-center gap-2 text-[12.5px] text-[var(--text-muted)]">
          <Icon name="loader-2" size={14} className="animate-spin" />
          <span>正在探测反馈诊断配置与执行器状态…</span>
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
            onClick={() => void loadSettings()}
          >
            重试加载
          </Button>
        </div>
      ) : (
        <div className="p-5 space-y-5">
          {/* Honest runtime availability callout when enabled but unavailable */}
          {saved?.enabled && saved.available === false && (
            <div
              role="alert"
              data-testid="feedback-agent-unavailable-banner"
              className="rounded-xl border border-amber-500/35 bg-amber-500/[0.08] p-3.5 space-y-2 animate-rd-msg-in"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-900 dark:text-amber-200">
                  <Icon name="alert-triangle" size={14} className="shrink-0" />
                  <span>已启用，但当前隔离反馈执行器不可用</span>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  icon="arrow-down"
                  onClick={scrollToProjectCli}
                >
                  检查项目 CLI 密钥
                </Button>
              </div>
              <p className="text-[12px] leading-relaxed text-amber-900/85 dark:text-amber-200/85">
                你的启用开关意图已保存，但服务端实时探测未满足真实 CLI 隔离运行条件（需要独立反馈执行器、与所选运行时匹配的「项目 CLI 配置」云端 API 密钥，以及官方或部署端 allowlist 的受信任 HTTPS 网关；仅接入本机 Bridge 不会用于公开反馈诊断）。在条件就绪前，Portal 与 Widget 将自动保持人工提单模式，绝不伪造诊断结果。
              </p>
            </div>
          )}

          {/* Master toggle */}
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3.5">
            <Switch
              checked={enabled}
              disabled={saving}
              onChange={(next) => {
                setEnabled(next);
                setSaveMessage(null);
              }}
              label="启用多轮反馈诊断 Agent"
              description="开启且执行器可用时，独立反馈面板与网站组件默认进入连续对话预诊：使用问题直接解答不提单、证据不足继续追问、仅在疑似故障时生成可编辑草稿并由用户显式确认提单。关闭或不可用时自动回退人工提单。"
            />
          </div>

          {/* Dedicated Harness + Model */}
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                  专属 Harness（隔离 CLI 运行时）
                </span>
                <span className="text-[11px] text-[var(--text-muted)]">
                  独立于任务路由与发布策略
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {RUNTIME_OPTIONS.map((opt) => {
                  const active = runtime === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      data-testid={`feedback-agent-runtime-${opt.id}`}
                      aria-pressed={active}
                      disabled={saving}
                      onClick={() => handleRuntimeSwitch(opt.id)}
                      className={cn(
                        "group flex flex-col items-start gap-1 p-3 rounded-xl border text-left transition-all duration-150 cursor-pointer disabled:opacity-55",
                        active
                          ? "border-indigo-500/60 bg-indigo-500/[0.07] ring-1 ring-indigo-500/20 shadow-2xs"
                          : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]",
                      )}
                    >
                      <div className="w-full flex items-center justify-between gap-2">
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
                          {opt.label}
                        </span>
                        <span className="text-[10.5px] text-[var(--text-muted)]">
                          {opt.vendor}
                        </span>
                      </div>
                      <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                        {opt.desc}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <label className="block space-y-1.5">
                <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                  专属模型（LLM Model ID）
                </span>
                <input
                  type="text"
                  data-testid="feedback-agent-model"
                  value={model}
                  disabled={saving}
                  maxLength={160}
                  spellCheck={false}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setSaveMessage(null);
                  }}
                  placeholder={
                    runtime === "claude"
                      ? "例如：claude-sonnet-4-6（留空则使用该运行时默认模型）"
                      : "例如：gpt-5.4（留空则使用该运行时默认模型）"
                  }
                  className="w-full h-9.5 px-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] font-mono text-[12.5px] text-[var(--text-primary)] placeholder:font-sans placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 transition-all"
                />
              </label>
              {suggestedModels.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-[var(--text-muted)]">推荐模型：</span>
                  {suggestedModels.slice(0, 6).map((item) => {
                    const selected = model.trim() === item.id;
                    return (
                      <button
                        key={`${item.runtime}:${item.id}`}
                        type="button"
                        disabled={saving}
                        onClick={() => {
                          setModel(item.id);
                          setSaveMessage(null);
                        }}
                        className={cn(
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-mono transition-colors cursor-pointer",
                          selected
                            ? "border-indigo-500/50 bg-indigo-500/12 text-indigo-700 dark:text-indigo-300"
                            : "border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]",
                        )}
                      >
                        <span>{item.id}</span>
                      </button>
                    );
                  })}
                  {model.trim() && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setModel("");
                        setSaveMessage(null);
                      }}
                      className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] underline underline-offset-2 cursor-pointer ml-1"
                    >
                      恢复默认
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Runtime prerequisites info note */}
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/75 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)] space-y-1">
              <div className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                <Icon name="shield-check" size={13} className="text-indigo-500 shrink-0" />
                <span>执行隔离与密钥说明</span>
              </div>
              <p>
                反馈诊断由服务端独立 CLI 执行器隔离运行，需满足：已部署反馈执行器、在下方「项目 CLI 配置」保存与所选 Harness 一致的云端 API 密钥，并使用官方地址或部署端 allowlist 的受信任 HTTPS 网关。本机 Bridge 节点仅用于研发任务/发布，不参与公开反馈预诊。
              </p>
              {cliMismatchWarning && (
                <p className="text-amber-700 dark:text-amber-300 flex flex-wrap items-center gap-2 pt-0.5">
                  <span>{cliMismatchWarning}</span>
                  <button
                    type="button"
                    onClick={scrollToProjectCli}
                    className="underline underline-offset-2 font-medium hover:opacity-80 cursor-pointer"
                  >
                    前往项目 CLI 配置
                  </button>
                </p>
              )}
            </div>
          </div>

          {/* Public Product Usage Guide */}
          <div className="space-y-1.5 pt-1 border-t border-[var(--border-subtle)]">
            <div className="flex items-center justify-between gap-2 pt-2">
              <label
                htmlFor="feedback-agent-public-guide"
                className="text-[12.5px] font-medium text-[var(--text-primary)]"
              >
                公开产品使用说明（Public Guide）
              </label>
              <span className="text-[11px] font-mono text-[var(--text-muted)] tabular-nums">
                {publicGuide.length} / {PUBLIC_GUIDE_MAX}
              </span>
            </div>
            <textarea
              id="feedback-agent-public-guide"
              data-testid="feedback-agent-guide"
              rows={6}
              maxLength={PUBLIC_GUIDE_MAX}
              disabled={saving}
              value={publicGuide}
              onChange={(e) => {
                setPublicGuide(e.target.value);
                setSaveMessage(null);
              }}
              placeholder={
                "填写可向外部反馈者公开的产品使用说明、常见问题排查与功能边界，例如：\n- 导出 CSV 入口位于「报表 → 右上角更多菜单」\n- 免费版单次最多导出 5,000 行，超过请筛选时间范围\n- 如遇 500 报错或页面白屏，请引导收集操作步骤与出现时间再生成故障草稿"
              }
              className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3 text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 transition-all"
            />
            <p className="text-[11.5px] text-[var(--text-muted)]">
              此内容仅用于指导反馈 Agent 识别使用疑问并给出自助解答。请勿在此填写内部 API 密钥、管理后台路径、数据库结构或未公开的内部信息。
            </p>
          </div>
        </div>
      )}

      {/* Footer */}
      {!loading && !loadError && (
        <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2.5">
          <span
            role="status"
            className={cn(
              "text-[12px]",
              saveMessage?.tone === "error"
                ? "text-rose-600 dark:text-rose-400"
                : "text-[var(--text-secondary)]",
            )}
          >
            {saveMessage?.text ??
              (dirty ? "有未保存的更改" : "独立作用于反馈面板与嵌入组件")}
          </span>
          <div className="flex items-center gap-2">
            {dirty && (
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
              disabled={!dirty || saving}
            >
              保存反馈 Agent 配置
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
