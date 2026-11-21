import { useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon.tsx";
import { Button, Switch, useToast } from "./ui.tsx";
import { api } from "~/lib/api.ts";
import type {
  AiConfigStatus,
  AiNodeId,
  AiNodeRoute,
  AiProfileSummary,
  AiTestResult,
} from "~/lib/types.ts";

interface AiSettingsCardProps {
  aiConfig: AiConfigStatus | null;
  onAiConfigUpdated: (cfg: AiConfigStatus) => void;
}

const LLM_PRESETS = [
  {
    id: "openai",
    label: "OpenAI 官方",
    suggestedName: "OpenAI 官方",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    suggestedName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    suggestedName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5.4",
  },
  {
    id: "ollama",
    label: "Ollama 本地",
    suggestedName: "Ollama 本地",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen3:8b",
  },
];

interface AiNodeMeta {
  id: AiNodeId;
  title: string;
  badge?: string;
  badgeTone?: "violet" | "indigo" | "emerald";
  icon: string;
  description: string;
  modelPlaceholder: string;
}

const AI_NODES: AiNodeMeta[] = [
  {
    id: "prescreen",
    title: "噪音预筛节点",
    icon: "shield-check",
    description: "新反馈入库自动预检，过滤明显测试与垃圾反馈；推荐低成本快速模型。",
    modelPlaceholder: "如 deepseek-chat / gpt-4o-mini",
  },
  {
    id: "widget",
    title: "收集组件 AI 助手",
    icon: "bot",
    description: "嵌入站点访客对话、截屏看图与只读代码排查；推荐性价比多模态模型。",
    modelPlaceholder: "如 gpt-4o-mini / deepseek-chat",
  },
  {
    id: "operator",
    title: "控制台任务对话",
    badge: "支持对话内切模型",
    badgeTone: "indigo",
    icon: "message-square",
    description: "在任务详情抽屉中与你讨论需求、分析方案或起草验收标准，可随时在聊天栏临时切换模型。",
    modelPlaceholder: "如 gpt-5.4 / deepseek-chat",
  },
  {
    id: "pr_audit",
    title: "PR 审查 / 审计节点",
    badge: "审计节点",
    badgeTone: "violet",
    icon: "git-pull-request",
    description: "针对 PR 代码改动进行质量审查、回归与安全风险审计；建议独立配置高阶推理模型（如官方 OpenAI 赠额 GPT）。",
    modelPlaceholder: "独立指定 PR 审计 Model Name，如 gpt-5.4 / gpt-6.2-astra",
  },
];

function emptyRoutes(): Record<AiNodeId, AiNodeRoute> {
  return {
    prescreen: { profile_id: "", model: "" },
    widget: { profile_id: "", model: "" },
    operator: { profile_id: "", model: "" },
    pr_audit: { profile_id: "", model: "" },
  };
}

function routesEqual(
  a: Record<AiNodeId, AiNodeRoute>,
  b: Record<AiNodeId, AiNodeRoute>,
): boolean {
  return (["prescreen", "widget", "operator", "pr_audit"] as AiNodeId[]).every(
    (id) => a[id].profile_id === b[id].profile_id && a[id].model.trim() === b[id].model.trim(),
  );
}

export function AiSettingsCard({ aiConfig, onAiConfigUpdated }: AiSettingsCardProps) {
  const toast = useToast();
  const isWorkspace = aiConfig?.source === "workspace";
  const profiles = useMemo(() => aiConfig?.profiles ?? [], [aiConfig?.profiles]);
  const workspaceProfiles = useMemo(
    () => (isWorkspace ? profiles : []),
    [isWorkspace, profiles],
  );
  const activeProfile = useMemo(
    () =>
      profiles.find((p) => p.id === aiConfig?.active_profile_id) ??
      profiles[0] ??
      null,
    [profiles, aiConfig?.active_profile_id],
  );

  // Add / Edit Profile form state
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formKey, setFormKey] = useState("");
  const [formSetActive, setFormSetActive] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);

  // Test feedback banner
  const [testBanner, setTestBanner] = useState<
    | { ok: true; label: string; result: AiTestResult }
    | { ok: false; label: string; error: string }
    | null
  >(null);

  // Node routes & intake toggle
  const [draftRoutes, setDraftRoutes] = useState<Record<AiNodeId, AiNodeRoute>>(
    () => aiConfig?.node_routes ?? emptyRoutes(),
  );
  const [intakeEnabled, setIntakeEnabled] = useState(aiConfig?.intake_enabled ?? false);
  const [savingRoutes, setSavingRoutes] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);

  const editingProfile: AiProfileSummary | null = useMemo(
    () => (editingId ? workspaceProfiles.find((p) => p.id === editingId) ?? null : null),
    [editingId, workspaceProfiles],
  );

  useEffect(() => {
    if (!aiConfig) return;
    setDraftRoutes(aiConfig.node_routes ?? emptyRoutes());
    setIntakeEnabled(aiConfig.intake_enabled);
  }, [aiConfig]);

  // Auto-open add form when nothing is configured in workspace yet
  useEffect(() => {
    if (aiConfig && !aiConfig.configured && !formOpen && !editingId) {
      setFormOpen(true);
      setFormSetActive(true);
    }
  }, [aiConfig, formOpen, editingId]);

  const savedRoutes = aiConfig?.node_routes ?? emptyRoutes();
  const routesDirty = Boolean(
    isWorkspace &&
      (!routesEqual(draftRoutes, savedRoutes) ||
        intakeEnabled !== Boolean(aiConfig?.intake_enabled)),
  );

  const openAddForm = () => {
    setEditingId(null);
    setFormName("");
    setFormBaseUrl("");
    setFormModel("");
    setFormKey("");
    setShowKey(false);
    setFormSetActive(workspaceProfiles.length === 0);
    setFormOpen(true);
    setTestBanner(null);
  };

  const openEditForm = (profile: AiProfileSummary) => {
    setEditingId(profile.id);
    setFormName(profile.name);
    setFormBaseUrl(profile.base_url);
    setFormModel(profile.model);
    setFormKey("");
    setShowKey(false);
    setFormSetActive(profile.id === aiConfig?.active_profile_id);
    setFormOpen(true);
    setTestBanner(null);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingId(null);
    setFormKey("");
    setShowKey(false);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    setTestBanner(null);
    try {
      const updated = await api.saveAiProfile({
        id: editingId ?? undefined,
        name: formName.trim() || undefined,
        base_url: formBaseUrl.trim(),
        model: formModel.trim(),
        api_key: formKey.trim() || undefined,
        set_active: formSetActive,
        intake_enabled: workspaceProfiles.length === 0 ? intakeEnabled : undefined,
      });
      onAiConfigUpdated(updated);
      closeForm();
      toast.success(editingId ? "模型配置已更新" : "新模型配置已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存模型配置失败");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleClearProfileKey = async (profile: AiProfileSummary) => {
    setSavingProfile(true);
    try {
      const updated = await api.saveAiProfile({
        id: profile.id,
        name: profile.name,
        base_url: profile.base_url,
        model: profile.model,
        clear_api_key: true,
      });
      setFormKey("");
      onAiConfigUpdated(updated);
      toast.info(`已清除「${profile.name}」的 API Key`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "清除密钥失败");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSelectActive = async (profile: AiProfileSummary) => {
    setBusyProfileId(profile.id);
    try {
      const updated = await api.selectAiProfile(profile.id);
      onAiConfigUpdated(updated);
      toast.success(`已切换默认模型为「${profile.name}」(${profile.model})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "切换默认模型失败");
    } finally {
      setBusyProfileId(null);
    }
  };

  const handleDeleteProfile = async (profile: AiProfileSummary) => {
    setBusyProfileId(profile.id);
    try {
      const updated = await api.deleteAiProfile(profile.id);
      if (editingId === profile.id) {
        closeForm();
      }
      onAiConfigUpdated(updated);
      toast.info(`已删除模型配置「${profile.name}」`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除模型配置失败");
    } finally {
      setBusyProfileId(null);
    }
  };

  const handleTest = async (
    key: string,
    label: string,
    payload: {
      profile_id?: string;
      node?: AiNodeId;
      base_url?: string;
      model?: string;
      api_key?: string;
    },
  ) => {
    setTestingKey(key);
    setTestBanner(null);
    try {
      const result = await api.testAiConfig(payload);
      setTestBanner({ ok: true, label, result });
      toast.success(`${label} 连通正常（${result.latency_ms}ms）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "连接测试失败";
      setTestBanner({ ok: false, label, error: msg });
      toast.error(msg);
    } finally {
      setTestingKey(null);
    }
  };

  const handleSaveRoutes = async () => {
    setSavingRoutes(true);
    try {
      const updated = await api.saveAiRoutes({
        intake_enabled: intakeEnabled,
        node_routes: draftRoutes,
      });
      onAiConfigUpdated(updated);
      toast.success("节点模型路由与助手设置已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存节点路由失败");
    } finally {
      setSavingRoutes(false);
    }
  };

  const handleClearAll = async () => {
    setClearingAll(true);
    setTestBanner(null);
    try {
      const updated = await api.disconnectAiConfig();
      onAiConfigUpdated(updated);
      setEditingId(null);
      setFormOpen(true);
      toast.info("已清除全部工作区模型配置");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "清除失败");
    } finally {
      setClearingAll(false);
    }
  };

  const updateRouteField = (
    nodeId: AiNodeId,
    field: "profile_id" | "model",
    value: string,
  ) => {
    setDraftRoutes((prev) => ({
      ...prev,
      [nodeId]: {
        ...prev[nodeId],
        [field]: value,
      },
    }));
  };

  return (
    <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <Icon name="sparkles" size={16} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
              AI 模型管理与节点路由 (LLM)
            </h2>
            <p className="text-[12px] text-[var(--text-muted)]">
              支持添加多个 OpenAI 兼容模型随时切换，并为噪音预筛、访客助手、对话与 PR 审计节点独立指定模型。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {aiConfig && (
            <span
              className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium px-2.5 py-1 rounded-full ${
                aiConfig.configured
                  ? isWorkspace
                    ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                    : "bg-indigo-500/12 text-indigo-600 dark:text-indigo-400"
                  : "bg-[var(--surface-subtle)] text-[var(--text-muted)]"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  aiConfig.configured ? "bg-emerald-500" : "bg-zinc-400"
                }`}
              />
              {aiConfig.configured
                ? isWorkspace
                  ? `已配 ${workspaceProfiles.length} 个模型 · 默认 ${aiConfig.model}`
                  : `环境变量 · ${aiConfig.model}`
                : "未配置（直通 Local Agent 终裁）"}
            </span>
          )}
          <Button
            type="button"
            variant="secondary"
            size="xs"
            icon="plus"
            onClick={openAddForm}
          >
            新增模型
          </Button>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Test status banner */}
        {testBanner && (
          <div
            className={`flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl border text-[12.5px] ${
              testBanner.ok
                ? "border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300"
                : "border-rose-500/30 bg-rose-500/8 text-rose-600 dark:text-rose-400"
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Icon
                name={testBanner.ok ? "check-circle-2" : "alert-circle"}
                size={15}
                className="shrink-0"
              />
              <span className="truncate">
                {testBanner.ok ? (
                  <>
                    <strong>{testBanner.label}</strong> 连接正常 · 模型{" "}
                    <strong className="font-mono">{testBanner.result.model}</strong> · 延迟{" "}
                    <strong className="font-mono">{testBanner.result.latency_ms}ms</strong> · 回复：
                    “{testBanner.result.reply_preview}”
                  </>
                ) : (
                  <>
                    <strong>{testBanner.label}</strong> 测试失败：{testBanner.error}
                  </>
                )}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setTestBanner(null)}
              aria-label="关闭提示"
              className="p-0.5 opacity-70 hover:opacity-100 cursor-pointer shrink-0"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        )}

        {/* Section 1: Saved Model Profiles */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[12.5px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
              <Icon name="cpu" size={14} className="text-indigo-500" />
              <span>已配置模型（点击切换默认）</span>
            </div>
            {workspaceProfiles.length > 0 && (
              <span className="text-[11.5px] text-[var(--text-muted)]">
                密钥以 <code className="font-mono">0600</code> 保存在服务端{" "}
                <code className="font-mono">.ai-config.json</code>
              </span>
            )}
          </div>

          {profiles.length > 0 ? (
            <div className="space-y-2">
              {profiles.map((profile) => {
                const isActive = profile.id === aiConfig?.active_profile_id;
                const isEnv = aiConfig?.source === "env";
                const isBusy = busyProfileId === profile.id;
                const isTesting = testingKey === `profile:${profile.id}`;
                return (
                  <div
                    key={profile.id}
                    className={`rounded-xl border px-3.5 py-3 transition ${
                      isActive
                        ? "border-indigo-500/45 bg-indigo-500/[0.045] dark:bg-indigo-500/[0.08]"
                        : "border-[var(--border-subtle)] bg-[var(--surface-elevated)]"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2.5">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
                            {profile.name}
                          </span>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[11.5px] font-mono text-[var(--text-primary)]">
                            {profile.model}
                          </span>
                          {isActive && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-500/14 text-indigo-600 dark:text-indigo-300">
                              <Icon name="check" size={11} />
                              当前默认
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--text-muted)] font-mono">
                          <span className="truncate max-w-[340px]">{profile.base_url}</span>
                          {profile.has_api_key ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                              <Icon name="key-round" size={11} />
                              {profile.api_key_preview}
                            </span>
                          ) : (
                            <span>免密钥</span>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                        {!isEnv && !isActive && (
                          <Button
                            type="button"
                            variant="secondary"
                            size="xs"
                            icon="check"
                            loading={isBusy}
                            onClick={() => void handleSelectActive(profile)}
                          >
                            设为默认
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          icon="zap"
                          loading={isTesting}
                          onClick={() =>
                            void handleTest(`profile:${profile.id}`, profile.name, {
                              profile_id: isEnv ? undefined : profile.id,
                            })
                          }
                        >
                          测连通
                        </Button>
                        {!isEnv && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              icon="pen-line"
                              onClick={() => openEditForm(profile)}
                            >
                              编辑
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              icon="trash-2"
                              loading={isBusy}
                              onClick={() => void handleDeleteProfile(profile)}
                            >
                              删除
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 px-4 py-3 text-[12.5px] text-[var(--text-muted)]">
              尚未添加模型配置。可以在下方直接添加 OpenAI 官方（Pro/Business 赠额）、DeepSeek 或任意 OpenAI 兼容服务商。
            </div>
          )}
        </div>

        {/* Add / Edit Model Profile Form */}
        {formOpen && (
          <form
            onSubmit={handleSaveProfile}
            className="rounded-xl border border-indigo-500/35 bg-[var(--surface-elevated)] p-4 space-y-4"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Icon name={editingId ? "pen-line" : "plus"} size={14} className="text-indigo-500" />
                <span>{editingId ? `编辑模型配置 · ${editingProfile?.name ?? ""}` : "新增模型配置"}</span>
              </div>
              {workspaceProfiles.length > 0 && (
                <button
                  type="button"
                  onClick={closeForm}
                  className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                >
                  收起
                </button>
              )}
            </div>

            {/* Quick Provider Presets */}
            <div>
              <span className="block text-[11.5px] font-medium text-[var(--text-secondary)] mb-1.5">
                快速填充服务商预设
              </span>
              <div className="flex flex-wrap gap-1.5">
                {LLM_PRESETS.map((preset) => {
                  const active = formBaseUrl.trim() === preset.baseUrl;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setFormBaseUrl(preset.baseUrl);
                        if (!formModel.trim()) setFormModel(preset.defaultModel);
                        if (!formName.trim()) setFormName(preset.suggestedName);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[12px] font-medium border transition cursor-pointer ${
                        active
                          ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
                          : "border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Name + Model */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <label className="block space-y-1.5">
                <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                  配置名称
                </span>
                <input
                  type="text"
                  maxLength={60}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="例如 OpenAI 官方 Pro 赠额 / DeepSeek 日常"
                  className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                  默认模型名称 (Model)
                </span>
                <input
                  type="text"
                  required
                  maxLength={160}
                  value={formModel}
                  onChange={(e) => setFormModel(e.target.value)}
                  placeholder="gpt-5.4 / gpt-4o-mini / deepseek-chat"
                  spellCheck={false}
                  className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                />
              </label>
            </div>

            {/* Base URL + API Key */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <label className="block space-y-1.5">
                <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                  API Base URL
                </span>
                <input
                  type="url"
                  required
                  value={formBaseUrl}
                  onChange={(e) => setFormBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  spellCheck={false}
                  className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                />
                <span className="block text-[11px] text-[var(--text-muted)]">
                  将请求 <code className="font-mono">/chat/completions</code>，远程需 HTTPS。
                </span>
              </label>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="ai-profile-api-key"
                    className="text-[12.5px] font-medium text-[var(--text-primary)]"
                  >
                    API Key
                  </label>
                  {editingProfile?.has_api_key && (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                        已保存 {editingProfile.api_key_preview}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleClearProfileKey(editingProfile)}
                        className="text-[11px] text-[var(--text-muted)] hover:text-rose-500 cursor-pointer"
                      >
                        清除密钥
                      </button>
                    </div>
                  )}
                </div>
                <div className="relative">
                  <input
                    id="ai-profile-api-key"
                    type={showKey ? "text" : "password"}
                    value={formKey}
                    onChange={(e) => setFormKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      editingProfile?.has_api_key
                        ? "留空保持现有密钥不变；输入新值覆盖"
                        : "sk-...（本机 Ollama 可留空）"
                    }
                    className="w-full h-9.5 pl-3 pr-10 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer p-1"
                  >
                    <Icon name={showKey ? "eye-off" : "eye"} size={15} />
                  </button>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <label className="inline-flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={formSetActive}
                  onChange={(e) => setFormSetActive(e.target.checked)}
                  className="rounded border-[var(--border-strong)] text-indigo-600 focus:ring-indigo-500"
                />
                <span>保存后设为当前默认模型</span>
              </label>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon="zap"
                  loading={testingKey === "form"}
                  disabled={!formBaseUrl.trim() || !formModel.trim()}
                  onClick={() =>
                    void handleTest("form", formName.trim() || formModel.trim(), {
                      profile_id: editingId ?? undefined,
                      base_url: formBaseUrl.trim(),
                      model: formModel.trim(),
                      api_key: formKey.trim() || undefined,
                    })
                  }
                >
                  测试连接
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  icon="check"
                  loading={savingProfile}
                >
                  {editingId ? "保存修改" : "添加模型"}
                </Button>
              </div>
            </div>
          </form>
        )}

        {/* Section 2: Per-Node Model Routing */}
        <div className="space-y-3 pt-1 border-t border-[var(--border-subtle)]">
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <div>
              <h3 className="text-[13px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Icon name="sliders-horizontal" size={14} className="text-indigo-500" />
                <span>节点独立模型分配</span>
              </h3>
              <p className="text-[11.5px] text-[var(--text-muted)] mt-0.5">
                为不同工作流节点单独绑定模型配置，或直接覆写独立的 Model Name（例如 PR 审计节点单独使用高阶 GPT 模型）。
              </p>
            </div>
            {routesDirty && (
              <span className="text-[11.5px] font-medium text-amber-600 dark:text-amber-400">
                有未保存的路由修改
              </span>
            )}
          </div>

          <div className="space-y-2.5">
            {AI_NODES.map((nodeMeta) => {
              const route = draftRoutes[nodeMeta.id] ?? { profile_id: "", model: "" };
              const chosenProfile =
                (route.profile_id
                  ? profiles.find((p) => p.id === route.profile_id)
                  : null) ?? activeProfile;
              const effectiveModel = route.model.trim() || chosenProfile?.model || "";
              const isTestingNode = testingKey === `node:${nodeMeta.id}`;
              const isAudit = nodeMeta.id === "pr_audit";

              return (
                <div
                  key={nodeMeta.id}
                  className={`rounded-xl border p-3.5 space-y-3 ${
                    isAudit
                      ? "border-violet-500/30 bg-violet-500/[0.035] dark:bg-violet-500/[0.06]"
                      : "border-[var(--border-subtle)] bg-[var(--surface-elevated)]"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                          isAudit
                            ? "bg-violet-500/14 text-violet-600 dark:text-violet-300"
                            : "bg-[var(--surface-subtle)] text-[var(--text-secondary)]"
                        }`}
                      >
                        <Icon name={nodeMeta.icon} size={14} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                            {nodeMeta.title}
                          </span>
                          {nodeMeta.badge && (
                            <span
                              className={`text-[10.5px] font-medium px-1.5 py-0.5 rounded-full ${
                                nodeMeta.badgeTone === "violet"
                                  ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
                                  : "bg-indigo-500/12 text-indigo-600 dark:text-indigo-300"
                              }`}
                            >
                              {nodeMeta.badge}
                            </span>
                          )}
                        </div>
                        <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed mt-0.5">
                          {nodeMeta.description}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {effectiveModel && (
                        <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--surface-card)] border border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-secondary)]">
                          {chosenProfile?.name ? `${chosenProfile.name} · ` : ""}
                          {effectiveModel}
                        </span>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        icon="zap"
                        disabled={!chosenProfile || !effectiveModel}
                        loading={isTestingNode}
                        onClick={() =>
                          void handleTest(`node:${nodeMeta.id}`, nodeMeta.title, {
                            profile_id:
                              aiConfig?.source === "env" ? undefined : chosenProfile?.id,
                            model: effectiveModel,
                          })
                        }
                      >
                        测连通
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <label className="block space-y-1">
                      <span className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                        模型配置 (Provider)
                      </span>
                      <select
                        disabled={!isWorkspace}
                        value={route.profile_id}
                        onChange={(e) =>
                          updateRouteField(nodeMeta.id, "profile_id", e.target.value)
                        }
                        className="w-full h-9 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[12.5px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                      >
                        <option value="">
                          跟随默认模型
                          {activeProfile
                            ? `（${activeProfile.name} · ${activeProfile.model}）`
                            : ""}
                        </option>
                        {workspaceProfiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}（默认 {p.model}）
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="block space-y-1">
                      <span className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                        独立 Model Name（可选覆写）
                      </span>
                      <input
                        type="text"
                        disabled={!isWorkspace}
                        maxLength={160}
                        spellCheck={false}
                        value={route.model}
                        onChange={(e) =>
                          updateRouteField(nodeMeta.id, "model", e.target.value)
                        }
                        placeholder={
                          chosenProfile
                            ? `留空使用 ${chosenProfile.model}；${nodeMeta.modelPlaceholder}`
                            : nodeMeta.modelPlaceholder
                        }
                        className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[12.5px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Widget AI Intake Toggle */}
          <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)]">
            <Switch
              id="ai-intake-toggle"
              checked={intakeEnabled}
              onChange={setIntakeEnabled}
              disabled={!isWorkspace}
              label="允许收集组件启用 AI 对话助手（Agent）"
              description="开启后，访客可在嵌入组件中与「收集组件 AI 助手」节点配置的模型实时流式对话、附带截屏看图排查，并将真实 Bug/建议整理为一键提单卡。"
            />
          </div>
        </div>
      </div>

      {/* Card Footer */}
      <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
        <div>
          {isWorkspace && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon="trash-2"
              loading={clearingAll}
              onClick={() => void handleClearAll()}
            >
              清除全部配置
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            icon="check"
            disabled={!isWorkspace}
            loading={savingRoutes}
            onClick={() => void handleSaveRoutes()}
          >
            保存节点路由
          </Button>
        </div>
      </div>
    </section>
  );
}
