import { useEffect, useState } from "react";
import { Icon } from "./Icon.tsx";
import { GithubRepoPicker } from "./GithubRepoPicker.tsx";
import { Button, CopyButton, EmptyState, Switch, useToast } from "./ui.tsx";
import { api } from "~/lib/api.ts";
import type { AiConfigStatus, AiTestResult, ProjectDetail } from "~/lib/types.ts";

interface SettingsViewProps {
  mode: "settings" | "sources";
  project: ProjectDetail | null;
  aiConfig: AiConfigStatus | null;
  githubConfigured: boolean;
  onAiConfigUpdated: (cfg: AiConfigStatus) => void;
  onGithubStatusUpdated: (configured: boolean) => void;
  onProjectUpdated: (project: ProjectDetail) => void;
  onNewProject: () => void;
}

const LLM_PRESETS = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    modelPlaceholder: "gpt-4o-mini",
    defaultModel: "gpt-4o-mini",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    modelPlaceholder: "anthropic/claude-sonnet-4.5",
    defaultModel: "anthropic/claude-sonnet-4.5",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    modelPlaceholder: "deepseek-chat",
    defaultModel: "deepseek-chat",
  },
  {
    id: "ollama",
    label: "Ollama 本地",
    baseUrl: "http://127.0.0.1:11434/v1",
    modelPlaceholder: "qwen3:8b",
    defaultModel: "qwen3:8b",
  },
];

function buildSnippets(project: ProjectDetail) {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-relaydesk.example";
  const repoDir = project.repo.split("/").pop() || "repo";
  return {
    widget: `<script defer src="${origin}/widget.js" data-project="${project.id}" data-key="${project.intake_key}"></script>`,
    agent: [
      `export RELAYDESK_URL='${origin}'`,
      `export RELAYDESK_PROJECT='${project.id}'`,
      `read -rsp 'Agent key: ' RELAYDESK_AGENT_KEY; echo`,
      `export RELAYDESK_AGENT_KEY`,
      `python3 agent/relay.py --repo ~/src/${repoDir} -- codex exec --sandbox workspace-write -`,
    ].join("\n"),
    bot: [
      `export RELAY_URL='${origin}'`,
      `export RELAY_PROJECT='${project.id}'`,
      `read -rsp 'Bot key: ' RELAY_BOT_KEY; echo`,
      `export RELAY_BOT_KEY`,
      `read -rsp 'Telegram bot token: ' TELEGRAM_BOT_TOKEN; echo`,
      `export TELEGRAM_BOT_TOKEN`,
      `export TELEGRAM_CHAT_IDS='替换为群聊 ID'`,
      `python3 integrations/telegram.py`,
    ].join("\n"),
  };
}

export function SettingsView({
  mode,
  project,
  aiConfig,
  githubConfigured,
  onAiConfigUpdated,
  onGithubStatusUpdated,
  onProjectUpdated,
  onNewProject,
}: SettingsViewProps) {
  const toast = useToast();

  // AI / LLM settings form
  const [aiBaseUrl, setAiBaseUrl] = useState(aiConfig?.base_url ?? "");
  const [aiModel, setAiModel] = useState(aiConfig?.model ?? "");
  const [aiKey, setAiKey] = useState("");
  const [showAiKey, setShowAiKey] = useState(false);
  const [aiIntakeEnabled, setAiIntakeEnabled] = useState(
    aiConfig?.intake_enabled ?? false,
  );
  const [savingAi, setSavingAi] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<AiTestResult | null>(null);
  const [aiTestError, setAiTestError] = useState<string>("");

  // GitHub PAT form
  const [ghToken, setGhToken] = useState("");
  const [showGhToken, setShowGhToken] = useState(false);
  const [savingGh, setSavingGh] = useState(false);

  // Project settings form
  const [projName, setProjName] = useState(project?.name ?? "");
  const [projRepo, setProjRepo] = useState(project?.repo ?? "");
  const [projInstructions, setProjInstructions] = useState(
    project?.agent_instructions ?? "",
  );
  const [savingProject, setSavingProject] = useState(false);

  // Origins form (sources view)
  const [originsList, setOriginsList] = useState<string[]>(
    project?.allowed_origins ?? [],
  );
  const [newOrigin, setNewOrigin] = useState("");
  const [savingOrigins, setSavingOrigins] = useState(false);

  useEffect(() => {
    if (aiConfig) {
      setAiBaseUrl(aiConfig.base_url);
      setAiModel(aiConfig.model);
      setAiIntakeEnabled(aiConfig.intake_enabled);
    }
  }, [aiConfig]);

  useEffect(() => {
    if (project) {
      setProjName(project.name);
      setProjRepo(project.repo);
      setProjInstructions(project.agent_instructions);
      setOriginsList(project.allowed_origins);
    }
  }, [project?.id, project?.name, project?.repo, project?.agent_instructions, project?.allowed_origins]);

  const handleSaveAi = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAi(true);
    setAiTestError("");
    try {
      const updated = await api.saveAiConfig({
        base_url: aiBaseUrl.trim(),
        model: aiModel.trim(),
        api_key: aiKey.trim() || undefined,
        intake_enabled: aiIntakeEnabled,
      });
      setAiKey("");
      onAiConfigUpdated(updated);
      toast.success("LLM 配置已保存到服务端");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存 LLM 配置失败");
    } finally {
      setSavingAi(false);
    }
  };

  const handleTestAi = async () => {
    setTestingAi(true);
    setAiTestResult(null);
    setAiTestError("");
    try {
      const result = await api.testAiConfig({
        base_url: aiBaseUrl.trim() || undefined,
        model: aiModel.trim() || undefined,
        api_key: aiKey.trim() || undefined,
      });
      setAiTestResult(result);
      toast.success(`连接成功（${result.latency_ms}ms）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "连接测试失败";
      setAiTestError(msg);
      toast.error(msg);
    } finally {
      setTestingAi(false);
    }
  };

  const handleClearAi = async () => {
    setSavingAi(true);
    setAiTestResult(null);
    setAiTestError("");
    try {
      const updated = await api.disconnectAiConfig();
      setAiKey("");
      setAiBaseUrl(updated.base_url);
      setAiModel(updated.model);
      setAiIntakeEnabled(updated.intake_enabled);
      onAiConfigUpdated(updated);
      toast.info("已清除工作区 LLM 配置");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "清除失败");
    } finally {
      setSavingAi(false);
    }
  };

  const handleClearAiKeyOnly = async () => {
    if (!aiBaseUrl.trim() || !aiModel.trim()) return;
    setSavingAi(true);
    try {
      const updated = await api.saveAiConfig({
        base_url: aiBaseUrl.trim(),
        model: aiModel.trim(),
        clear_api_key: true,
        intake_enabled: aiIntakeEnabled,
      });
      setAiKey("");
      onAiConfigUpdated(updated);
      toast.info("已清除已保存的 API Key");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setSavingAi(false);
    }
  };

  const handleConnectGithub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ghToken.trim()) return;
    setSavingGh(true);
    try {
      const res = await api.connectGithub(ghToken.trim());
      setGhToken("");
      onGithubStatusUpdated(true);
      const summaryParts: string[] = [];
      if (res.viewer?.login) summaryParts.push(`@${res.viewer.login}`);
      if (typeof res.org_count === "number" && res.org_count > 0) {
        summaryParts.push(`${res.org_count} 个组织`);
      }
      if (typeof res.repo_count === "number") {
        summaryParts.push(`${res.repo_count} 个仓库`);
      }
      toast.success(
        summaryParts.length > 0
          ? `GitHub 已连接（${summaryParts.join(" · ")}）`
          : "GitHub 连接已保存",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "GitHub 连接失败");
    } finally {
      setSavingGh(false);
    }
  };

  const handleDisconnectGithub = async () => {
    setSavingGh(true);
    try {
      await api.disconnectGithub();
      onGithubStatusUpdated(false);
      toast.info("已断开 GitHub 连接");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "断开失败");
    } finally {
      setSavingGh(false);
    }
  };

  const handleSaveProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setSavingProject(true);
    try {
      const { project: updated } = await api.updateProject(project.id, {
        name: projName.trim(),
        repo: projRepo.trim(),
        agent_instructions: projInstructions,
      });
      onProjectUpdated(updated);
      toast.success("项目配置已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存项目配置失败");
    } finally {
      setSavingProject(false);
    }
  };

  const handleAddOrigin = async () => {
    if (!project) return;
    const candidate = newOrigin.trim().replace(/\/+$/, "");
    if (!candidate) return;
    if (originsList.includes(candidate)) {
      setNewOrigin("");
      return;
    }
    const next = [...originsList, candidate];
    setSavingOrigins(true);
    try {
      const { project: updated } = await api.updateProject(project.id, {
        allowed_origins: next,
      });
      setOriginsList(updated.allowed_origins);
      setNewOrigin("");
      onProjectUpdated(updated);
      toast.success("已添加允许来源");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "来源格式不正确");
    } finally {
      setSavingOrigins(false);
    }
  };

  const handleRemoveOrigin = async (originToRemove: string) => {
    if (!project) return;
    const next = originsList.filter((o) => o !== originToRemove);
    setSavingOrigins(true);
    try {
      const { project: updated } = await api.updateProject(project.id, {
        allowed_origins: next,
      });
      setOriginsList(updated.allowed_origins);
      onProjectUpdated(updated);
      toast.info("已移除来源");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "移除失败");
    } finally {
      setSavingOrigins(false);
    }
  };

  const snippets = project ? buildSnippets(project) : null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-5 lg:px-8 py-6 space-y-6">
        {/* Header */}
        <header className="pb-4 border-b border-[var(--border-subtle)]">
          <h1 className="text-[19px] font-semibold tracking-tight text-[var(--text-primary)]">
            {mode === "settings" ? "设置与 LLM 配置" : "收集入口"}
          </h1>
          <p className="text-[13px] text-[var(--text-muted)] mt-1">
            {mode === "settings"
              ? "配置工作区 AI 大模型（API Key / Base URL / Model）、GitHub 仓库授权，以及当前项目的 Local Agent 接入。"
              : "将嵌入式反馈组件与 Telegram 群聊机器人接入当前项目的反馈队列。"}
          </p>
        </header>

        {mode === "settings" && (
          <>
            {/* 1. AI / LLM Configuration Card (Workspace-wide) */}
            <form
              onSubmit={handleSaveAi}
              className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs"
            >
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                    <Icon name="sparkles" size={16} />
                  </div>
                  <div>
                    <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                      AI 助手与 LLM 配置
                    </h2>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      用于任务讨论助手与可选的反馈组件追问，支持任何 OpenAI 兼容接口。
                    </p>
                  </div>
                </div>
                {aiConfig && (
                  <span
                    className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium px-2.5 py-1 rounded-full ${
                      aiConfig.configured
                        ? aiConfig.source === "workspace"
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
                      ? aiConfig.source === "workspace"
                        ? `工作区已配置 · ${aiConfig.model}`
                        : `环境变量 · ${aiConfig.model}`
                      : "未配置（本地规则模式）"}
                  </span>
                )}
              </div>

              <div className="p-5 space-y-4">
                {/* Quick Provider Presets */}
                <div>
                  <span className="block text-[12px] font-medium text-[var(--text-secondary)] mb-2">
                    快速选择服务商预设
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {LLM_PRESETS.map((preset) => {
                      const active = aiBaseUrl.trim() === preset.baseUrl;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            setAiBaseUrl(preset.baseUrl);
                            if (!aiModel.trim()) setAiModel(preset.defaultModel);
                          }}
                          className={`px-2.5 py-1 rounded-lg text-[12px] font-medium border transition cursor-pointer ${
                            active
                              ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
                              : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Base URL & Model */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <label className="block space-y-1.5">
                    <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                      API Base URL
                    </span>
                    <input
                      type="url"
                      required
                      value={aiBaseUrl}
                      onChange={(e) => setAiBaseUrl(e.target.value)}
                      placeholder="https://api.openai.com/v1"
                      spellCheck={false}
                      className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                    />
                    <span className="block text-[11px] text-[var(--text-muted)]">
                      将请求 <code className="font-mono">/chat/completions</code>，远程需 HTTPS。
                    </span>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                      模型名称 (Model)
                    </span>
                    <input
                      type="text"
                      required
                      value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)}
                      placeholder="gpt-4o-mini / deepseek-chat / qwen3:8b"
                      spellCheck={false}
                      className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                    />
                    <span className="block text-[11px] text-[var(--text-muted)]">
                      填写服务商支持的完整 Model ID。
                    </span>
                  </label>
                </div>

                {/* API Key */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="ai-api-key"
                      className="text-[12.5px] font-medium text-[var(--text-primary)]"
                    >
                      API Key
                    </label>
                    {aiConfig?.has_api_key && (
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                          <Icon name="key-round" size={11} />
                          已保存 {aiConfig.api_key_preview}
                        </span>
                        {aiConfig.source === "workspace" && (
                          <button
                            type="button"
                            onClick={() => void handleClearAiKeyOnly()}
                            className="text-[11px] text-[var(--text-muted)] hover:text-rose-500 cursor-pointer"
                          >
                            清除密钥
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      id="ai-api-key"
                      type={showAiKey ? "text" : "password"}
                      value={aiKey}
                      onChange={(e) => setAiKey(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={
                        aiConfig?.has_api_key
                          ? "已配置密钥，留空则保持不变；输入新值将覆盖"
                          : "sk-...（本机 Ollama 等免鉴权服务可留空）"
                      }
                      className="w-full h-9.5 pl-3 pr-10 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAiKey((v) => !v)}
                      aria-label={showAiKey ? "隐藏 API Key" : "显示 API Key"}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer p-1"
                    >
                      <Icon name={showAiKey ? "eye-off" : "eye"} size={15} />
                    </button>
                  </div>
                  <p className="text-[11.5px] text-[var(--text-muted)]">
                    密钥以 <code className="font-mono">0600</code> 权限保存在服务端数据目录的{" "}
                    <code className="font-mono">.ai-config.json</code> 中，不会下发给前端浏览器。
                  </p>
                </div>

                {/* Intake Toggle */}
                <div className="p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)]">
                  <Switch
                    id="ai-intake-toggle"
                    checked={aiIntakeEnabled}
                    onChange={setAiIntakeEnabled}
                    label="允许反馈组件使用 LLM 追问"
                    description="开启后，访客在嵌入组件填写初步描述时，将调用上述模型生成一句针对性追问（仅发送访客当前描述，不含内部任务数据）。"
                  />
                </div>

                {/* Live test status */}
                {aiTestResult && (
                  <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/8 text-[12.5px] text-emerald-700 dark:text-emerald-300">
                    <Icon name="check-circle-2" size={15} className="shrink-0" />
                    <span>
                      连接正常 · 模型 <strong className="font-mono">{aiTestResult.model}</strong> ·
                      延迟 <strong className="font-mono">{aiTestResult.latency_ms}ms</strong> · 回复：
                      “{aiTestResult.reply_preview}”
                    </span>
                  </div>
                )}
                {aiTestError && (
                  <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-rose-500/30 bg-rose-500/8 text-[12.5px] text-rose-600 dark:text-rose-400">
                    <Icon name="alert-circle" size={15} className="shrink-0" />
                    <span>{aiTestError}</span>
                  </div>
                )}
              </div>

              <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                <div>
                  {aiConfig?.source === "workspace" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon="trash-2"
                      onClick={() => void handleClearAi()}
                      disabled={savingAi}
                    >
                      清除配置
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon="zap"
                    loading={testingAi}
                    disabled={!aiBaseUrl.trim() || !aiModel.trim()}
                    onClick={() => void handleTestAi()}
                  >
                    测试连接
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    icon="check"
                    loading={savingAi}
                  >
                    保存 AI 配置
                  </Button>
                </div>
              </div>
            </form>

            {/* 2. GitHub PAT Connection */}
            <form
              onSubmit={handleConnectGithub}
              className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs"
            >
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-zinc-500/12 text-[var(--text-primary)] flex items-center justify-center">
                    <Icon name="github" size={16} />
                  </div>
                  <div>
                    <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                      GitHub 连接
                    </h2>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      工作区共用此连接，用于创建或编辑项目时快速选择仓库。
                    </p>
                  </div>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium px-2.5 py-1 rounded-full ${
                    githubConfigured
                      ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                      : "bg-[var(--surface-subtle)] text-[var(--text-muted)]"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      githubConfigured ? "bg-emerald-500" : "bg-zinc-400"
                    }`}
                  />
                  {githubConfigured ? "已连接" : "未连接"}
                </span>
              </div>

              <div className="p-5 space-y-3">
                <label className="block space-y-1.5">
                  <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                    Personal Access Token（支持个人与组织仓库）
                  </span>
                  <div className="relative">
                    <input
                      type={showGhToken ? "text" : "password"}
                      value={ghToken}
                      onChange={(e) => setGhToken(e.target.value)}
                      required
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={
                        githubConfigured
                          ? "输入新的 Token 以替换当前连接"
                          : "github_pat_... 或 ghp_...（含组织权限可自动拉取组织仓库）"
                      }
                      className="w-full h-9.5 pl-3 pr-10 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                    />
                    <button
                      type="button"
                      onClick={() => setShowGhToken((v) => !v)}
                      aria-label={showGhToken ? "隐藏 Token" : "显示 Token"}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer p-1"
                    >
                      <Icon name={showGhToken ? "eye-off" : "eye"} size={15} />
                    </button>
                  </div>
                  <span className="block text-[11.5px] text-[var(--text-muted)]">
                    支持 Classic PAT（<code className="font-mono">repo</code> /{" "}
                    <code className="font-mono">read:org</code>）与 Fine-grained PAT（个人或组织{" "}
                    <code className="font-mono">Metadata: Read-only</code>）。
                  </span>
                </label>
              </div>

              <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex items-center justify-between gap-2">
                <div>
                  {githubConfigured && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon="unlink"
                      onClick={() => void handleDisconnectGithub()}
                      disabled={savingGh}
                    >
                      断开连接
                    </Button>
                  )}
                </div>
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  loading={savingGh}
                  disabled={!ghToken.trim()}
                >
                  保存连接
                </Button>
              </div>
            </form>
          </>
        )}

        {/* Project-specific cards */}
        {!project ? (
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-8">
            <EmptyState
              compact
              icon="folder-git-2"
              title="先创建一个项目"
              description="每个项目拥有独立的 GitHub 仓库绑定、嵌入组件密钥和 Local Agent 派单队列。"
              action={
                <Button variant="primary" size="sm" icon="plus" onClick={onNewProject}>
                  创建项目
                </Button>
              }
            />
          </div>
        ) : mode === "settings" ? (
          <>
            {/* 3. Project Configuration */}
            <form
              onSubmit={handleSaveProject}
              className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs"
            >
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                    <Icon name="git-branch" size={16} />
                  </div>
                  <div>
                    <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                      项目配置 · {project.name}
                    </h2>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      项目 ID：<code className="font-mono">{project.id}</code>
                    </p>
                  </div>
                </div>
                <CopyButton
                  value={project.id}
                  label="复制 ID"
                  copiedLabel="已复制"
                  size="xs"
                />
              </div>

              <div className="p-5 space-y-4">
                <label className="block space-y-1.5">
                  <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                    项目名称
                  </span>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={projName}
                    onChange={(e) => setProjName(e.target.value)}
                    className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                  />
                </label>

                <GithubRepoPicker
                  value={projRepo}
                  onChange={(next) => setProjRepo(next)}
                  githubConfigured={githubConfigured}
                  defaultExpanded={false}
                />

                <label className="block space-y-1.5">
                  <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                    Agent 项目级指令
                  </span>
                  <textarea
                    rows={4}
                    maxLength={8000}
                    value={projInstructions}
                    onChange={(e) => setProjInstructions(e.target.value)}
                    placeholder="例如：提交验收前务必运行 pnpm test 与 pnpm typecheck，不要修改数据库迁移脚本。"
                    className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3 text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500"
                  />
                  <span className="block text-[11.5px] text-[var(--text-muted)]">
                    每次派发任务给本机执行器时都会附带这段指令。
                  </span>
                </label>
              </div>

              <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex justify-end">
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  loading={savingProject}
                >
                  保存项目配置
                </Button>
              </div>
            </form>

            {/* 4. Local Agent Integration */}
            {snippets && (
              <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs">
                <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-amber-500/12 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                    <Icon name="terminal" size={16} />
                  </div>
                  <div>
                    <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                      连接 Local Agent 执行器
                    </h2>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      在开发机的 Relaydesk 目录运行，将 <code className="font-mono">--repo</code> 改为本机仓库路径。
                    </p>
                  </div>
                </div>
                <div className="p-5 space-y-3">
                  <pre className="p-3.5 rounded-xl bg-zinc-950 text-zinc-100 text-[12px] font-mono leading-relaxed overflow-x-auto border border-zinc-800">
                    {snippets.agent}
                  </pre>
                  <div className="flex flex-wrap items-center gap-2">
                    <CopyButton
                      value={snippets.agent}
                      label="复制启动命令"
                      copiedLabel="命令已复制"
                    />
                    <CopyButton
                      value={project.agent_key}
                      label="复制 Agent Key"
                      copiedLabel="Agent Key 已复制"
                      variant="subtle"
                    />
                  </div>
                </div>
              </section>
            )}
          </>
        ) : (
          /* Sources Mode */
          snippets && (
            <>
              {/* Allowed Origins */}
              <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs">
                <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                    <Icon name="shield-check" size={16} />
                  </div>
                  <div>
                    <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                      允许嵌入的网站来源 (CORS)
                    </h2>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      限制哪些网站可以向当前项目提交反馈。留空时仅建议用于本机调试。
                    </p>
                  </div>
                </div>
                <div className="p-5 space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={newOrigin}
                      onChange={(e) => setNewOrigin(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleAddOrigin();
                        }
                      }}
                      placeholder="https://app.example.com"
                      className="flex-1 h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500"
                    />
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      icon="plus"
                      loading={savingOrigins}
                      disabled={!newOrigin.trim()}
                      onClick={() => void handleAddOrigin()}
                    >
                      添加来源
                    </Button>
                  </div>

                  {originsList.length === 0 ? (
                    <p className="text-[12.5px] text-[var(--text-muted)]">
                      当前未限制来源（任意带有效 Intake Key 的页面均可提交）。生产环境建议至少登记你的正式域名。
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {originsList.map((origin) => (
                        <span
                          key={origin}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[12.5px] font-mono text-[var(--text-primary)]"
                        >
                          {origin}
                          <button
                            type="button"
                            onClick={() => void handleRemoveOrigin(origin)}
                            aria-label={`移除 ${origin}`}
                            className="text-[var(--text-muted)] hover:text-rose-500 cursor-pointer"
                          >
                            <Icon name="x" size={13} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* Widget Snippet */}
              <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs">
                <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                    <Icon name="code-2" size={16} />
                  </div>
                  <div>
                    <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                      应用内反馈组件
                    </h2>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      粘贴到应用 HTML 的 <code className="font-mono">&lt;body&gt;</code> 内即可启用右下角悬浮反馈浮窗，支持自动跟随深浅主题。
                    </p>
                  </div>
                </div>
                <div className="p-5 space-y-3">
                  <pre className="p-3.5 rounded-xl bg-zinc-950 text-zinc-100 text-[12px] font-mono leading-relaxed overflow-x-auto border border-zinc-800">
                    {snippets.widget}
                  </pre>
                  <div className="flex flex-wrap items-center gap-2">
                    <CopyButton
                      value={snippets.widget}
                      label="复制嵌入脚本"
                      copiedLabel="脚本已复制"
                    />
                  </div>
                </div>
              </section>

              {/* Telegram Bot Snippet */}
              <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs">
                <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-sky-500/12 text-sky-600 dark:text-sky-400 flex items-center justify-center">
                    <Icon name="bot" size={16} />
                  </div>
                  <div>
                    <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                      Telegram 群聊机器人
                    </h2>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      在群聊中发送 <code className="font-mono">/feedback 内容</code> 或回复某条消息发送 <code className="font-mono">/feedback</code> 即可收录到本队列。
                    </p>
                  </div>
                </div>
                <div className="p-5 space-y-3">
                  <pre className="p-3.5 rounded-xl bg-zinc-950 text-zinc-100 text-[12px] font-mono leading-relaxed overflow-x-auto border border-zinc-800">
                    {snippets.bot}
                  </pre>
                  <div className="flex flex-wrap items-center gap-2">
                    <CopyButton
                      value={snippets.bot}
                      label="复制启动命令"
                      copiedLabel="命令已复制"
                    />
                    <CopyButton
                      value={project.bot_key}
                      label="复制 Bot Key"
                      copiedLabel="Bot Key 已复制"
                      variant="subtle"
                    />
                  </div>
                </div>
              </section>
            </>
          )
        )}
      </div>
    </div>
  );
}
