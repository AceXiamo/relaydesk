import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectCliSettingsCard } from "./ProjectCliSettingsCard.tsx";
import { ProjectRoutingCard } from "./ProjectRoutingCard.tsx";
import { UtilityAiSettingsCard } from "./UtilityAiSettingsCard.tsx";
import { LocalAgentsSettingsCard } from "./LocalAgentsSettingsCard.tsx";
import { Icon } from "./Icon.tsx";
import {
  GithubOwnerAvatar,
  GithubRepoPicker,
  parseManualRepoInput,
} from "./GithubRepoPicker.tsx";
import {
  Button,
  CopyButton,
  DeliveryModeBadge,
  EmptyState,
  LivePulseDot,
  Switch,
  useToast,
} from "./ui.tsx";
import { api } from "~/lib/api.ts";
import {
  DELIVERY_MODE_DESCRIPTIONS,
  DELIVERY_MODE_LABELS,
} from "~/lib/format.ts";
import type {
  DeliveryMode,
  GithubConnectionSummary,
  GithubInspectPayload,
  GithubOwnerInfo,
  ProjectDetail,
  ProjectReposSyncStatus,
  R2ConfigStatus,
  R2TestResult,
} from "~/lib/types.ts";

interface SettingsViewProps {
  mode: "settings" | "sources";
  project: ProjectDetail | null;
  githubConnections: GithubConnectionSummary[];
  onGithubConnectionsUpdated: (connections: GithubConnectionSummary[]) => void;
  onProjectUpdated: (project: ProjectDetail) => void;
  onNewProject: () => void;
}

const VALID_OWNER_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const DELIVERY_MODE_OPTIONS: Array<{
  mode: DeliveryMode;
  icon: string;
  badge?: string;
}> = [
  { mode: "direct_push", icon: "zap", badge: "默认" },
  { mode: "pr_automerge", icon: "git-merge" },
  { mode: "review_only", icon: "file-check-2" },
];

const SKILL_INSTALL_COMMAND = [
  "# Clone or link Relaydesk skill into Claude Code & Codex",
  "mkdir -p ~/.claude/skills ~/.codex/skills",
  "ln -sfn /path/to/relaydesk/skills/relaydesk ~/.claude/skills/relaydesk",
  "ln -sfn /path/to/relaydesk/skills/relaydesk ~/.codex/skills/relaydesk",
].join("\n");

const SKILL_WAKEUP_PROMPT =
  "Use the relaydesk skill to autonomously handle at most 1 task in this workspace. If NOOP, PAUSED, or BUSY, reply with that exact word and stop immediately.";

function maskAgentKey(key: string): string {
  if (!key) return "••••••••";
  if (key.length <= 10) return "••••••••••";
  return `${key.slice(0, 6)}${"•".repeat(Math.min(14, key.length - 10))}${key.slice(-4)}`;
}

function buildSkillInitPrompt(
  project: ProjectDetail,
  origin: string,
  repos: string[],
  keyText: string,
): string {
  const repoLines = repos.length ? repos.join(", ") : project.repo;
  return [
    "请使用 relaydesk skill 为当前工作目录初始化 Relaydesk 全自动迭代接入，并配置本项目专属的 1:1 定时任务。",
    "",
    "项目接入参数：",
    `- Project Name: ${project.name}`,
    `- Server URL: ${origin}`,
    `- Project ID: ${project.id}`,
    `- Agent Key: ${keyText}`,
    `- Bound Repos: ${repoLines}`,
    `- Delivery Mode: ${project.delivery_mode}`,
    "",
    "请按顺序帮我完成：",
    "1. 扫描当前工作目录及一级子目录中的 git 仓库，核对与上方 Bound Repos 的映射关系；若有缺失仓库请提示我补充路径或确认 clone。",
    `2. 运行 \`node ~/.claude/skills/relaydesk/scripts/relaydesk.mjs init --url "${origin}" --project "${project.id}" --key "${keyText}" --delivery "${project.delivery_mode}"\`（Codex 环境使用 \`~/.codex/skills/relaydesk/scripts/relaydesk.mjs\`），将密钥安全写入本机 \`~/.config/relaydesk/projects/${project.id}.json\`（0600 权限，不进 git），并在工作目录生成不含密钥的 \`.relaydesk.json\`。`,
    "3. 运行 `check` 命令验证服务端连通性、自动化开关状态和本地子仓库映射。",
    "4. 通过对话引导我为当前工作目录创建一条专属的 1:1 定时自动任务（建议每 10–15 分钟巡检一次），定时任务触发 Prompt 请严格使用以下极简指令：",
    `   ${SKILL_WAKEUP_PROMPT}`,
  ].join("\n");
}

function buildManualInitCli(
  project: ProjectDetail,
  origin: string,
  keyText: string,
): string {
  return [
    "node ~/.claude/skills/relaydesk/scripts/relaydesk.mjs init \\",
    `  --url '${origin}' \\`,
    `  --project '${project.id}' \\`,
    `  --key '${keyText}' \\`,
    `  --delivery '${project.delivery_mode}'`,
  ].join("\n");
}

function buildSnippets(project: ProjectDetail) {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-relaydesk.example";
  return {
    origin,
    widget: `<script defer src="${origin}/widget.js" data-project="${project.id}" data-key="${project.intake_key}"></script>`,
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
  githubConnections,
  onGithubConnectionsUpdated,
  onProjectUpdated,
  onNewProject,
}: SettingsViewProps) {
  const toast = useToast();
  const githubConfigured = githubConnections.length > 0;

  // GitHub multi-PAT state
  const [ghToken, setGhToken] = useState("");
  const [ghLabel, setGhLabel] = useState("");
  const [ghLabelAutoFilled, setGhLabelAutoFilled] = useState(false);
  const [ghScope, setGhScope] = useState<GithubOwnerInfo | null>(null);
  const [ghInspecting, setGhInspecting] = useState(false);
  const [ghInspectResult, setGhInspectResult] = useState<GithubInspectPayload | null>(null);
  const [ghInspectError, setGhInspectError] = useState("");
  const [ghCustomOrgOpen, setGhCustomOrgOpen] = useState(false);
  const [ghCustomOrgInput, setGhCustomOrgInput] = useState("");
  const [editingGhId, setEditingGhId] = useState<string | null>(null);
  const [addingGhKey, setAddingGhKey] = useState(false);
  const [showGhToken, setShowGhToken] = useState(false);
  const [savingGh, setSavingGh] = useState(false);
  const [busyGhId, setBusyGhId] = useState<string | null>(null);
  const inspectSeqRef = useRef(0);
  const lastAutoInspectedTokenRef = useRef("");

  // Project settings form
  const projectReposList = useMemo(
    () => (project ? (project.repos?.length ? project.repos : [project.repo]) : []),
    [project],
  );
  const [projName, setProjName] = useState(project?.name ?? "");
  const [projRepos, setProjRepos] = useState<string[]>(projectReposList);
  const [projRepoDraft, setProjRepoDraft] = useState("");
  const [projInstructions, setProjInstructions] = useState(
    project?.agent_instructions ?? "",
  );
  const [projPaused, setProjPaused] = useState(project?.automation_paused ?? false);
  const [projDeliveryMode, setProjDeliveryMode] = useState<DeliveryMode>(
    project?.delivery_mode ?? "direct_push",
  );
  const [projWidgetCodeContext, setProjWidgetCodeContext] = useState<boolean>(
    project?.widget_code_context ?? true,
  );
  const [savingProject, setSavingProject] = useState(false);

  // R2 object storage settings
  const [r2Config, setR2Config] = useState<R2ConfigStatus | null>(null);
  const [r2AccountId, setR2AccountId] = useState("");
  const [r2Bucket, setR2Bucket] = useState("");
  const [r2PublicUrl, setR2PublicUrl] = useState("");
  const [r2AccessKeyId, setR2AccessKeyId] = useState("");
  const [r2SecretKey, setR2SecretKey] = useState("");
  const [showR2Secret, setShowR2Secret] = useState(false);
  const [savingR2, setSavingR2] = useState(false);
  const [testingR2, setTestingR2] = useState(false);
  const [r2TestResult, setR2TestResult] = useState<R2TestResult | null>(null);
  const [r2TestError, setR2TestError] = useState("");

  // Project container repo mirror status (for widget code context)
  const [repoMirrorStatus, setRepoMirrorStatus] = useState<ProjectReposSyncStatus | null>(null);
  const [syncingRepos, setSyncingRepos] = useState(false);
  const [togglingCodeCtx, setTogglingCodeCtx] = useState(false);

  // Skill onboarding UI state
  const [showPromptKey, setShowPromptKey] = useState(false);
  const [showAdvancedSkill, setShowAdvancedSkill] = useState(false);

  // Origins form (sources view)
  const [originsList, setOriginsList] = useState<string[]>(
    project?.allowed_origins ?? [],
  );
  const [newOrigin, setNewOrigin] = useState("");
  const [savingOrigins, setSavingOrigins] = useState(false);

  useEffect(() => {
    if (project) {
      const nextRepos = project.repos?.length ? project.repos : [project.repo];
      setProjName(project.name);
      setProjRepos(nextRepos);
      setProjRepoDraft("");
      setProjInstructions(project.agent_instructions);
      setProjPaused(project.automation_paused);
      setProjDeliveryMode(project.delivery_mode);
      setProjWidgetCodeContext(project.widget_code_context ?? true);
      setOriginsList(project.allowed_origins);
    }
  }, [
    project?.id,
    project?.name,
    project?.repo,
    project?.repos,
    project?.agent_instructions,
    project?.automation_paused,
    project?.delivery_mode,
    project?.widget_code_context,
    project?.allowed_origins,
  ]);

  useEffect(() => {
    let active = true;
    api
      .getR2Config()
      .then((cfg) => {
        if (!active) return;
        setR2Config(cfg);
        setR2AccountId(cfg.account_id);
        setR2Bucket(cfg.bucket);
        setR2PublicUrl(cfg.public_url);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!project?.id) {
      setRepoMirrorStatus(null);
      return;
    }
    let active = true;
    api
      .getProjectReposStatus(project.id)
      .then((st) => {
        if (active) setRepoMirrorStatus(st);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [project?.id, project?.repos, project?.widget_code_context]);

  const handleSelectScopeOwner = useCallback(
    (nextScope: GithubOwnerInfo | null) => {
      setGhScope(nextScope);
      if (nextScope) {
        const autoName =
          nextScope.type === "Organization"
            ? nextScope.login
            : `@${nextScope.login}`;
        if (!ghLabel.trim() || ghLabelAutoFilled) {
          setGhLabel(autoName);
          setGhLabelAutoFilled(true);
        }
      } else if (ghLabelAutoFilled) {
        setGhLabel("");
        setGhLabelAutoFilled(false);
      }
    },
    [ghLabel, ghLabelAutoFilled],
  );

  const runInspectGithub = useCallback(
    async (
      opts: { token?: string; id?: string },
      options?: { autoApplySuggestion?: boolean; silent?: boolean },
    ) => {
      const seq = ++inspectSeqRef.current;
      setGhInspecting(true);
      setGhInspectError("");
      try {
        const res = await api.inspectGithub(opts);
        if (seq !== inspectSeqRef.current) return;
        setGhInspectResult(res);
        if (options?.autoApplySuggestion && res.suggested_scope) {
          setGhScope((prev) => {
            if (prev) return prev;
            const suggested = res.suggested_scope;
            if (suggested) {
              const autoName =
                suggested.type === "Organization"
                  ? suggested.login
                  : `@${suggested.login}`;
              setGhLabel((cur) => {
                if (!cur.trim()) {
                  setGhLabelAutoFilled(true);
                  return autoName;
                }
                return cur;
              });
            }
            return suggested;
          });
        }
      } catch (err) {
        if (seq !== inspectSeqRef.current) return;
        const msg = err instanceof Error ? err.message : "检测 Token 可用组织失败";
        setGhInspectError(msg);
        if (!options?.silent) {
          toast.error(msg);
        }
      } finally {
        if (seq === inspectSeqRef.current) {
          setGhInspecting(false);
        }
      }
    },
    [toast],
  );

  // Auto-inspect when user pastes a full GitHub token in the form
  useEffect(() => {
    const trimmed = ghToken.trim();
    if (
      !trimmed ||
      trimmed === lastAutoInspectedTokenRef.current ||
      trimmed.length < 24 ||
      !/^(?:github_pat_|ghp_|gho_)[A-Za-z0-9_]+$/.test(trimmed)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      lastAutoInspectedTokenRef.current = trimmed;
      void runInspectGithub(
        { token: trimmed },
        { autoApplySuggestion: !editingGhId, silent: true },
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [editingGhId, ghToken, runInspectGithub]);

  const handleApplyCustomScopeOrg = () => {
    const cleaned = ghCustomOrgInput.trim().replace(/^@/, "").split("/")[0] ?? "";
    if (!VALID_OWNER_LOGIN_RE.test(cleaned)) {
      toast.error("组织名格式不正确，仅支持字母、数字与连字符。");
      return;
    }
    handleSelectScopeOwner({ login: cleaned, type: "Organization" });
    setGhCustomOrgInput("");
    setGhCustomOrgOpen(false);
  };

  const ghScopeCandidates = useMemo(() => {
    const map = new Map<string, GithubOwnerInfo>();
    for (const c of ghInspectResult?.candidates ?? []) {
      map.set(`${c.type}:${c.login.toLowerCase()}`, c);
    }
    if (ghScope) {
      const key = `${ghScope.type}:${ghScope.login.toLowerCase()}`;
      if (!map.has(key)) {
        map.set(key, ghScope);
      }
    }
    return Array.from(map.values());
  }, [ghInspectResult, ghScope]);

  const handleConnectGithub = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedToken = ghToken.trim();
    if (!editingGhId && !trimmedToken) return;
    setSavingGh(true);
    try {
      const res = await api.connectGithub({
        ...(trimmedToken ? { token: trimmedToken } : {}),
        label: ghLabel.trim() || undefined,
        id: editingGhId ?? undefined,
        scope_owner: ghScope
          ? { login: ghScope.login, type: ghScope.type }
          : null,
      });
      const wasEditing = Boolean(editingGhId);
      setGhToken("");
      setGhLabel("");
      setGhLabelAutoFilled(false);
      setGhScope(null);
      setGhInspectResult(null);
      setGhInspectError("");
      setGhCustomOrgOpen(false);
      setGhCustomOrgInput("");
      lastAutoInspectedTokenRef.current = "";
      setEditingGhId(null);
      setAddingGhKey(false);
      setShowGhToken(false);
      onGithubConnectionsUpdated(res.connections ?? []);
      const summaryParts: string[] = [];
      if (res.connection?.label) summaryParts.push(res.connection.label);
      else if (res.viewer?.login) summaryParts.push(`@${res.viewer.login}`);
      if (typeof res.org_count === "number" && res.org_count > 0) {
        summaryParts.push(`${res.org_count} 个组织`);
      }
      if (typeof res.repo_count === "number") {
        summaryParts.push(`${res.repo_count} 个仓库`);
      }
      toast.success(
        summaryParts.length > 0
          ? `${wasEditing ? "GitHub Key 已更新" : "GitHub Key 已添加"}（${summaryParts.join(" · ")}）`
          : "GitHub Key 已保存",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "GitHub Key 验证失败");
    } finally {
      setSavingGh(false);
    }
  };

  const handleRefreshGithubKey = async (conn: GithubConnectionSummary) => {
    setBusyGhId(conn.id);
    try {
      const res = await api.refreshGithubConnection(conn.id);
      onGithubConnectionsUpdated(res.connections ?? []);
      toast.success(
        `已同步「${res.connection?.label ?? conn.label}」（${res.repo_count ?? res.connection?.repo_count ?? 0} 个仓库）`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "同步 GitHub Key 失败");
    } finally {
      setBusyGhId(null);
    }
  };

  const handleRemoveGithubKey = async (conn: GithubConnectionSummary) => {
    setBusyGhId(conn.id);
    try {
      const res = await api.disconnectGithub(conn.id);
      if (editingGhId === conn.id) {
        setEditingGhId(null);
        setGhLabel("");
        setGhLabelAutoFilled(false);
        setGhToken("");
        setGhScope(null);
        setGhInspectResult(null);
        setGhInspectError("");
      }
      onGithubConnectionsUpdated(res.connections ?? []);
      toast.info(`已移除 GitHub Key「${conn.label}」`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "移除失败");
    } finally {
      setBusyGhId(null);
    }
  };

  const startEditGithubKey = (conn: GithubConnectionSummary) => {
    setEditingGhId(conn.id);
    setGhLabel(conn.id === "legacy" ? "" : conn.label);
    setGhLabelAutoFilled(false);
    setGhToken("");
    setGhScope(conn.scope_owner ?? null);
    setGhInspectResult(null);
    setGhInspectError("");
    setGhCustomOrgOpen(false);
    setGhCustomOrgInput("");
    lastAutoInspectedTokenRef.current = "";
    setAddingGhKey(true);
    setShowGhToken(false);
    void runInspectGithub(
      { id: conn.id },
      { autoApplySuggestion: false, silent: true },
    );
  };

  const cancelGithubForm = () => {
    inspectSeqRef.current += 1;
    setEditingGhId(null);
    setAddingGhKey(false);
    setGhLabel("");
    setGhLabelAutoFilled(false);
    setGhToken("");
    setGhScope(null);
    setGhInspectResult(null);
    setGhInspectError("");
    setGhInspecting(false);
    setGhCustomOrgOpen(false);
    setGhCustomOrgInput("");
    lastAutoInspectedTokenRef.current = "";
    setShowGhToken(false);
  };

  const effectiveProjRepos = useMemo(() => {
    const draftParsed = parseManualRepoInput(projRepoDraft);
    if (!draftParsed) return projRepos;
    if (projRepos.some((r) => r.toLowerCase() === draftParsed.toLowerCase())) {
      return projRepos;
    }
    return [...projRepos, draftParsed];
  }, [projRepoDraft, projRepos]);

  const handleSaveProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;
    if (effectiveProjRepos.length === 0) {
      toast.error("请至少绑定一个 GitHub 仓库");
      return;
    }
    setSavingProject(true);
    try {
      const { project: updated } = await api.updateProject(project.id, {
        name: projName.trim(),
        repo: effectiveProjRepos[0],
        repos: effectiveProjRepos,
        agent_instructions: projInstructions,
        automation_paused: projPaused,
        delivery_mode: projDeliveryMode,
        widget_code_context: projWidgetCodeContext,
      });
      setProjRepoDraft("");
      onProjectUpdated(updated);
      toast.success(`项目配置已保存（已绑定 ${updated.repos.length} 个仓库）`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存项目配置失败");
    } finally {
      setSavingProject(false);
    }
  };

  const handleSaveR2 = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingR2(true);
    setR2TestError("");
    try {
      const updated = await api.saveR2Config({
        account_id: r2AccountId.trim(),
        bucket: r2Bucket.trim(),
        public_url: r2PublicUrl.trim(),
        access_key_id: r2AccessKeyId.trim() || undefined,
        secret_access_key: r2SecretKey.trim() || undefined,
      });
      setR2Config(updated);
      setR2AccessKeyId("");
      setR2SecretKey("");
      toast.success("Cloudflare R2 图床配置已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存 R2 配置失败");
    } finally {
      setSavingR2(false);
    }
  };

  const handleTestR2 = async () => {
    setTestingR2(true);
    setR2TestResult(null);
    setR2TestError("");
    try {
      const res = await api.testR2Config({
        account_id: r2AccountId.trim() || undefined,
        bucket: r2Bucket.trim() || undefined,
        public_url: r2PublicUrl.trim() || undefined,
        access_key_id: r2AccessKeyId.trim() || undefined,
        secret_access_key: r2SecretKey.trim() || undefined,
      });
      setR2TestResult(res);
      toast.success(`R2 连接正常（${res.latency_ms}ms）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "R2 连接测试失败";
      setR2TestError(msg);
      toast.error(msg);
    } finally {
      setTestingR2(false);
    }
  };

  const handleClearR2 = async () => {
    setSavingR2(true);
    try {
      const updated = await api.disconnectR2Config();
      setR2Config(updated);
      setR2AccountId(updated.account_id);
      setR2Bucket(updated.bucket);
      setR2PublicUrl(updated.public_url);
      setR2AccessKeyId("");
      setR2SecretKey("");
      setR2TestResult(null);
      setR2TestError("");
      toast.info("已清除工作区 R2 配置");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "清除 R2 配置失败");
    } finally {
      setSavingR2(false);
    }
  };

  const handleToggleWidgetCodeContext = async (enabled: boolean) => {
    if (!project) return;
    setTogglingCodeCtx(true);
    setProjWidgetCodeContext(enabled);
    try {
      const { project: updated } = await api.updateProject(project.id, {
        widget_code_context: enabled,
      });
      onProjectUpdated(updated);
      toast.success(enabled ? "已开启收集组件只读代码上下文" : "已关闭收集组件代码上下文");
    } catch (err) {
      setProjWidgetCodeContext(!enabled);
      toast.error(err instanceof Error ? err.message : "更新设置失败");
    } finally {
      setTogglingCodeCtx(false);
    }
  };

  const handleSyncProjectRepos = async () => {
    if (!project) return;
    setSyncingRepos(true);
    try {
      const st = await api.syncProjectRepos(project.id);
      setRepoMirrorStatus(st);
      const failed = st.repos.filter((r) => r.error);
      if (failed.length > 0) {
        toast.error(`同步完成，但 ${failed.length} 个仓库拉取失败：${failed[0].error}`);
      } else {
        toast.success(`已同步 ${st.repos.length} 个仓库最新代码`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "同步仓库代码失败");
    } finally {
      setSyncingRepos(false);
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
  const skillInitPromptReal =
    project && snippets
      ? buildSkillInitPrompt(project, snippets.origin, projectReposList, project.agent_key)
      : "";
  const skillInitPromptPreview =
    project && snippets
      ? buildSkillInitPrompt(
          project,
          snippets.origin,
          projectReposList,
          showPromptKey ? project.agent_key : maskAgentKey(project.agent_key),
        )
      : "";
  const manualInitCliReal =
    project && snippets
      ? buildManualInitCli(project, snippets.origin, project.agent_key)
      : "";
  const manualInitCliPreview =
    project && snippets
      ? buildManualInitCli(
          project,
          snippets.origin,
          showPromptKey ? project.agent_key : maskAgentKey(project.agent_key),
        )
      : "";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-5 lg:px-8 py-6 space-y-6">
        {/* Header */}
        <header className="pb-4 border-b border-[var(--border-subtle)]">
          <h1 className="text-[19px] font-semibold tracking-tight text-[var(--text-primary)]">
            {mode === "settings" ? "设置" : "收集入口"}
          </h1>
          <p className="text-[13px] text-[var(--text-muted)] mt-1">
            {mode === "settings"
              ? "管理项目 CLI、GitHub 连接、截图存储和 Local Agent 接入。"
              : "将嵌入式反馈组件与 Telegram 群聊机器人接入当前项目的反馈队列。"}
          </p>
        </header>

        {mode === "settings" && (
          <>
            {project && <ProjectCliSettingsCard key={project.id} projectId={project.id} projectName={project.name} />}
            {project && <ProjectRoutingCard key={`routing-${project.id}`} projectId={project.id} projectName={project.name} />}

            <LocalAgentsSettingsCard />
            <UtilityAiSettingsCard />

            {/* 1.5 Cloudflare R2 Screenshot Storage */}
            <form
              onSubmit={handleSaveR2}
              className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs"
            >
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-amber-500/12 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                    <Icon name="cloud" size={16} />
                  </div>
                  <div>
                    <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                      Cloudflare R2 截图图床
                    </h2>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      用于托管收集组件的自由框选截屏与粘贴图片，自动返回自定义公开域名链接。
                    </p>
                  </div>
                </div>
                {r2Config && (
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium ${
                      r2Config.configured
                        ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                        : "bg-[var(--surface-subtle)] text-[var(--text-muted)]"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        r2Config.configured ? "bg-emerald-500" : "bg-zinc-400"
                      }`}
                    />
                    {r2Config.configured
                      ? `${r2Config.source === "workspace" ? "已配置" : "环境变量"} · ${r2Config.bucket}`
                      : "未配置"}
                  </span>
                )}
              </div>

              <div className="p-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <label className="block space-y-1.5">
                    <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                      Cloudflare Account ID
                    </span>
                    <input
                      type="text"
                      required
                      value={r2AccountId}
                      onChange={(e) => setR2AccountId(e.target.value)}
                      placeholder="例如 2492b541649a..."
                      spellCheck={false}
                      className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                      R2 Bucket 名称
                    </span>
                    <input
                      type="text"
                      required
                      value={r2Bucket}
                      onChange={(e) => setR2Bucket(e.target.value)}
                      placeholder="relaydesk"
                      spellCheck={false}
                      className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                    />
                  </label>
                </div>

                <label className="block space-y-1.5">
                  <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                    公开访问域名 (Custom Domain)
                  </span>
                  <input
                    type="url"
                    required
                    value={r2PublicUrl}
                    onChange={(e) => setR2PublicUrl(e.target.value)}
                    placeholder="https://relaydesk-r2.acexiamo.com"
                    spellCheck={false}
                    className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                  />
                  <span className="block text-[11.5px] text-[var(--text-muted)]">
                    上传后的截图将以 <code className="font-mono">{r2PublicUrl || "https://relaydesk-r2.acexiamo.com"}/uploads/...</code> 嵌进反馈单并供 AI 多模态读取。
                  </span>
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <label className="block space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                        Access Key ID
                      </span>
                      {r2Config?.has_credentials && (
                        <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                          {r2Config.access_key_preview}
                        </span>
                      )}
                    </div>
                    <input
                      type="text"
                      value={r2AccessKeyId}
                      onChange={(e) => setR2AccessKeyId(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={
                        r2Config?.has_credentials
                          ? "已保存，留空保持不变"
                          : "R2 S3 Access Key ID"
                      }
                      className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                      Secret Access Key
                    </span>
                    <div className="relative">
                      <input
                        type={showR2Secret ? "text" : "password"}
                        value={r2SecretKey}
                        onChange={(e) => setR2SecretKey(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={
                          r2Config?.has_credentials
                            ? "已保存，留空保持不变"
                            : "R2 S3 Secret Access Key"
                        }
                        className="w-full h-9.5 pl-3 pr-10 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                      />
                      <button
                        type="button"
                        onClick={() => setShowR2Secret((v) => !v)}
                        aria-label={showR2Secret ? "隐藏密钥" : "显示密钥"}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer p-1"
                      >
                        <Icon name={showR2Secret ? "eye-off" : "eye"} size={15} />
                      </button>
                    </div>
                  </label>
                </div>

                {r2TestResult && (
                  <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/8 text-[12.5px] text-emerald-700 dark:text-emerald-300">
                    <Icon name="check-circle-2" size={15} className="shrink-0" />
                    <span>
                      R2 写入连通正常 · Bucket <strong className="font-mono">{r2TestResult.bucket}</strong> ·
                      延迟 <strong className="font-mono">{r2TestResult.latency_ms}ms</strong>
                    </span>
                  </div>
                )}
                {r2TestError && (
                  <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-rose-500/30 bg-rose-500/8 text-[12.5px] text-rose-600 dark:text-rose-400">
                    <Icon name="alert-circle" size={15} className="shrink-0" />
                    <span>{r2TestError}</span>
                  </div>
                )}
              </div>

              <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                <div>
                  {r2Config?.source === "workspace" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon="trash-2"
                      onClick={() => void handleClearR2()}
                      disabled={savingR2}
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
                    loading={testingR2}
                    disabled={!r2Bucket.trim() || !r2PublicUrl.trim()}
                    onClick={() => void handleTestR2()}
                  >
                    测试写入
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    icon="check"
                    loading={savingR2}
                  >
                    保存 R2 配置
                  </Button>
                </div>
              </div>
            </form>

            {/* 2. GitHub PAT Connections (Multi-Key) */}
            <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs">
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-zinc-500/12 text-[var(--text-primary)] flex items-center justify-center">
                    <Icon name="github" size={16} />
                  </div>
                  <div>
                    <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                      GitHub 连接
                    </h2>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      支持配置多个 Personal Access Token（个人账号与不同组织可分别配置），选仓时自动聚合。
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
                  {githubConfigured
                    ? `已配置 ${githubConnections.length} 个 Key`
                    : "未连接"}
                </span>
              </div>

              {/* Configured Keys List */}
              {githubConnections.length > 0 && (
                <div className="divide-y divide-[var(--border-subtle)]">
                  {githubConnections.map((conn) => {
                    const primaryOwner = conn.owners[0] ?? conn.viewer;
                    const isBusy = busyGhId === conn.id;
                    const isEditing = editingGhId === conn.id;
                    const tokenTypeLabel =
                      conn.token_type === "fine_grained"
                        ? "Fine-grained"
                        : conn.token_type === "classic"
                          ? "Classic"
                          : "PAT";

                    return (
                      <div
                        key={conn.id}
                        className={`px-5 py-3.5 flex items-start justify-between gap-3 transition ${
                          isEditing ? "bg-indigo-500/[0.04]" : ""
                        }`}
                      >
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <div className="mt-0.5 shrink-0">
                            {primaryOwner ? (
                              <GithubOwnerAvatar
                                login={primaryOwner.login}
                                type={primaryOwner.type}
                                avatarUrl={primaryOwner.avatar_url}
                                size="md"
                              />
                            ) : (
                              <span className="w-7 h-7 rounded-lg bg-[var(--surface-subtle)] text-[var(--text-muted)] inline-flex items-center justify-center">
                                <Icon name="key-round" size={14} />
                              </span>
                            )}
                          </div>

                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
                                {conn.label}
                              </span>
                              <span className="text-[10.5px] font-medium px-1.5 py-0.5 rounded-md bg-[var(--surface-subtle)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                                {tokenTypeLabel}
                              </span>
                              {conn.scope_owner && (
                                <span className="inline-flex items-center gap-1 text-[10.5px] font-medium px-1.5 py-0.5 rounded-md bg-indigo-500/12 text-indigo-600 dark:text-indigo-400">
                                  <Icon
                                    name={
                                      conn.scope_owner.type === "Organization"
                                        ? "building-2"
                                        : "user"
                                    }
                                    size={10.5}
                                  />
                                  {conn.scope_owner.type === "Organization"
                                    ? "锁定组织"
                                    : "锁定账号"}
                                </span>
                              )}
                              <code className="text-[11px] font-mono text-[var(--text-muted)]">
                                {conn.token_preview}
                              </code>
                            </div>

                            {/* Accessible Owner Chips + Repo Count */}
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {conn.owners.length > 0 ? (
                                conn.owners.map((owner) => (
                                  <span
                                    key={`${conn.id}:${owner.type}:${owner.login}`}
                                    className="inline-flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-md bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]"
                                  >
                                    <GithubOwnerAvatar
                                      login={owner.login}
                                      type={owner.type}
                                      avatarUrl={owner.avatar_url}
                                      size="xs"
                                    />
                                    <span className="font-mono">{owner.login}</span>
                                    {owner.type === "Organization" && (
                                      <span className="text-[9.5px] px-1 rounded bg-indigo-500/12 text-indigo-600 dark:text-indigo-400">
                                        组织
                                      </span>
                                    )}
                                  </span>
                                ))
                              ) : conn.token_type === "fine_grained" && conn.id !== "legacy" ? (
                                <span className="text-[11.5px] text-amber-600 dark:text-amber-400">
                                  当前可访问 0 个仓库（请确认已勾选仓库范围、授予 Metadata: Read-only 且组织已批准）
                                </span>
                              ) : (
                                <span className="text-[11.5px] text-[var(--text-muted)]">
                                  点击右侧刷新以同步账号与组织信息
                                </span>
                              )}

                              {conn.repo_count > 0 && (
                                <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
                                  · {conn.repo_count} 个仓库
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => void handleRefreshGithubKey(conn)}
                            disabled={isBusy || savingGh}
                            title="重新验证并同步组织与仓库"
                            aria-label={`同步 ${conn.label}`}
                            className="w-7.5 h-7.5 inline-flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer disabled:opacity-40"
                          >
                            <Icon
                              name="refresh-cw"
                              size={13.5}
                              className={isBusy ? "animate-spin" : ""}
                            />
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditGithubKey(conn)}
                            disabled={isBusy || savingGh}
                            title="编辑归属组织、备注或替换 Token"
                            aria-label={`编辑 ${conn.label}`}
                            className={`w-7.5 h-7.5 inline-flex items-center justify-center rounded-lg transition cursor-pointer disabled:opacity-40 ${
                              isEditing
                                ? "bg-indigo-500/12 text-indigo-600 dark:text-indigo-400"
                                : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                            }`}
                          >
                            <Icon name="pen-line" size={13.5} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRemoveGithubKey(conn)}
                            disabled={isBusy || savingGh}
                            title="移除此 Key"
                            aria-label={`移除 ${conn.label}`}
                            className="w-7.5 h-7.5 inline-flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer disabled:opacity-40"
                          >
                            <Icon name="trash-2" size={13.5} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Add / Replace Key Form */}
              {(!githubConfigured || addingGhKey || editingGhId) ? (
                <form
                  onSubmit={handleConnectGithub}
                  className={
                    githubConfigured
                      ? "border-t border-[var(--border-subtle)] bg-[var(--surface-subtle)]/35"
                      : ""
                  }
                >
                  <div className="p-5 space-y-4">
                    {editingGhId && (
                      <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-indigo-600 dark:text-indigo-400">
                        <span className="inline-flex items-center gap-1.5">
                          <Icon name="pen-line" size={13.5} />
                          编辑 GitHub Key（可直接调整归属组织或备注，Token 留空则保持不变）
                        </span>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                      <label className="block space-y-1.5 sm:col-span-4">
                        <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                          备注名称{" "}
                          <span className="text-[var(--text-muted)] font-normal">(可选)</span>
                        </span>
                        <input
                          type="text"
                          value={ghLabel}
                          onChange={(e) => {
                            setGhLabel(e.target.value);
                            setGhLabelAutoFilled(false);
                          }}
                          maxLength={80}
                          placeholder="留空自动识别账号/组织"
                          className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                        />
                      </label>

                      <div className="block space-y-1.5 sm:col-span-8">
                        <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                          Personal Access Token{" "}
                          {editingGhId && (
                            <span className="text-[var(--text-muted)] font-normal">
                              (留空保持现有 Token)
                            </span>
                          )}
                        </span>
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1 min-w-0">
                            <input
                              type={showGhToken ? "text" : "password"}
                              value={ghToken}
                              onChange={(e) => setGhToken(e.target.value)}
                              required={!editingGhId}
                              autoFocus={addingGhKey && !editingGhId}
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={
                                editingGhId
                                  ? "如需替换请粘贴新 Token，否则留空"
                                  : "github_pat_... 或 ghp_..."
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
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            icon="search"
                            loading={ghInspecting}
                            disabled={!ghToken.trim() && !editingGhId}
                            onClick={() =>
                              void runInspectGithub(
                                ghToken.trim()
                                  ? { token: ghToken.trim() }
                                  : { id: editingGhId ?? undefined },
                                { autoApplySuggestion: false },
                              )
                            }
                          >
                            读取组织
                          </Button>
                        </div>
                      </div>
                    </div>

                    {/* Manual Organization / Account Scope Selector */}
                    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)]/70 p-3.5 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                            Key 归属范围
                          </span>
                          {ghScope ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-md bg-indigo-500/12 text-indigo-600 dark:text-indigo-400">
                              已锁定：{ghScope.type === "Organization" ? "组织" : "个人"}{" "}
                              <code className="font-mono">{ghScope.login}</code>
                            </span>
                          ) : (
                            <span className="text-[11px] text-[var(--text-muted)]">
                              自动识别（全部可访问）
                            </span>
                          )}
                        </div>
                        {ghInspecting && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                            <Icon name="loader-2" size={12} className="animate-spin" />
                            正在读取可用账号与组织…
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleSelectScopeOwner(null)}
                          className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12px] font-medium border transition cursor-pointer ${
                            ghScope === null
                              ? "border-indigo-500 bg-indigo-600 text-white shadow-2xs"
                              : "border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                          }`}
                        >
                          <Icon name="layers" size={12.5} />
                          <span>全部可访问（自动）</span>
                        </button>

                        {ghScopeCandidates.map((cand) => {
                          const isSelected =
                            ghScope?.type === cand.type &&
                            ghScope?.login.toLowerCase() === cand.login.toLowerCase();
                          const isOrg = cand.type === "Organization";
                          return (
                            <button
                              key={`${cand.type}:${cand.login}`}
                              type="button"
                              onClick={() => handleSelectScopeOwner(cand)}
                              className={`inline-flex items-center gap-1.5 h-8 pl-1.5 pr-2.5 rounded-lg text-[12px] font-medium border transition cursor-pointer ${
                                isSelected
                                  ? "border-indigo-500 bg-indigo-600 text-white shadow-2xs"
                                  : "border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                              }`}
                            >
                              <GithubOwnerAvatar
                                login={cand.login}
                                type={cand.type}
                                avatarUrl={cand.avatar_url}
                                size="xs"
                                onActivePill={isSelected}
                              />
                              <span className="font-mono">{cand.login}</span>
                              <span
                                className={`text-[10px] px-1 rounded ${
                                  isSelected
                                    ? "bg-white/20 text-white"
                                    : isOrg
                                      ? "bg-indigo-500/12 text-indigo-600 dark:text-indigo-400"
                                      : "bg-[var(--surface-subtle)] text-[var(--text-muted)]"
                                }`}
                              >
                                {isOrg ? "组织" : "个人"}
                              </span>
                            </button>
                          );
                        })}

                        {ghCustomOrgOpen ? (
                          <div className="inline-flex items-center gap-1 h-8 pl-2 pr-1 rounded-lg border border-indigo-500 bg-[var(--surface-card)]">
                            <Icon name="building-2" size={12.5} className="text-indigo-500" />
                            <input
                              type="text"
                              autoFocus
                              value={ghCustomOrgInput}
                              onChange={(e) => setGhCustomOrgInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  handleApplyCustomScopeOrg();
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  setGhCustomOrgOpen(false);
                                  setGhCustomOrgInput("");
                                }
                              }}
                              placeholder="输入组织名"
                              className="w-28 bg-transparent text-[12px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={handleApplyCustomScopeOrg}
                              disabled={!ghCustomOrgInput.trim()}
                              aria-label="确认组织名"
                              className="p-1 rounded text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/15 disabled:opacity-40 cursor-pointer"
                            >
                              <Icon name="check" size={12.5} />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setGhCustomOrgOpen(false);
                                setGhCustomOrgInput("");
                              }}
                              aria-label="取消"
                              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                            >
                              <Icon name="x" size={12.5} />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setGhCustomOrgOpen(true)}
                            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg text-[12px] font-medium border border-dashed border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
                          >
                            <Icon name="plus" size={12.5} />
                            <span>手动输入组织名</span>
                          </button>
                        )}
                      </div>

                      {ghInspectError && (
                        <p className="text-[11.5px] text-rose-600 dark:text-rose-400">
                          {ghInspectError}
                        </p>
                      )}

                      <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                        添加组织 Fine-grained PAT 时，强烈建议直接点击对应组织（或手动输入组织名）锁定归属，这样会直接拉取该组织的私有与公开仓库，不会被个人公开仓库干扰。
                      </p>
                    </div>
                  </div>

                  <div className="px-5 py-3 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex items-center justify-end gap-2">
                    {githubConfigured && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={cancelGithubForm}
                        disabled={savingGh}
                      >
                        取消
                      </Button>
                    )}
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      icon={editingGhId ? "check" : "plus"}
                      loading={savingGh}
                      disabled={!editingGhId && !ghToken.trim()}
                    >
                      {editingGhId ? "验证并保存修改" : "验证并添加 Key"}
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="px-5 py-3 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11.5px] text-[var(--text-muted)]">
                    Fine-grained PAT 仅限单个账号或组织？继续添加其它账号/组织的 Key 即可自动合并。
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon="plus"
                    onClick={() => {
                      setEditingGhId(null);
                      setGhLabel("");
                      setGhLabelAutoFilled(false);
                      setGhToken("");
                      setGhScope(null);
                      setGhInspectResult(null);
                      setGhInspectError("");
                      setGhCustomOrgOpen(false);
                      setGhCustomOrgInput("");
                      lastAutoInspectedTokenRef.current = "";
                      setAddingGhKey(true);
                    }}
                  >
                    添加 GitHub Key
                  </Button>
                </div>
              )}
            </section>
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
              <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                    <Icon name="git-branch" size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)] truncate">
                        项目配置 · {project.name}
                      </h2>
                      <span
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                          projPaused
                            ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20"
                            : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20"
                        }`}
                      >
                        <LivePulseDot
                          tone={projPaused ? "amber" : "emerald"}
                          active={!projPaused}
                        />
                        {projPaused ? "已暂停" : "全自动运行中"}
                      </span>
                    </div>
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
                  values={projRepos}
                  onChange={setProjRepos}
                  draftValue={projRepoDraft}
                  onDraftChange={setProjRepoDraft}
                  githubConfigured={githubConfigured}
                  githubConnections={githubConnections}
                  defaultExpanded={false}
                />

                {/* Automation Switch */}
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/70 p-3.5 space-y-3.5">
                  <Switch
                    checked={!projPaused}
                    onChange={(enabled) => setProjPaused(!enabled)}
                    label="启用全自动迭代"
                    description="开启后，本机 Agent 定时巡检时会自动领取并闭环处理新反馈；暂停后所有巡检会立即返回 PAUSED，不消耗本地 Agent Token。"
                  />
                  <div className="border-t border-[var(--border-subtle)] pt-3.5">
                    <Switch
                      checked={projWidgetCodeContext}
                      onChange={setProjWidgetCodeContext}
                      label="允许收集组件 AI 查阅绑定仓库代码（只读沙箱）"
                      description="开启后，服务端会在容器内浅克隆本项目绑定仓库并按 5 分钟 TTL 后台刷新，访客咨询功能用法时由 AI 助手直接查代码秒答（禁止泄露原始源码与敏感文件）。"
                    />
                  </div>
                </div>

                {/* Default Delivery Mode Segmented Selector */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                      默认交付方式
                    </span>
                    <DeliveryModeBadge mode={projDeliveryMode} compact />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {DELIVERY_MODE_OPTIONS.map((opt) => {
                      const active = projDeliveryMode === opt.mode;
                      return (
                        <button
                          key={opt.mode}
                          type="button"
                          onClick={() => setProjDeliveryMode(opt.mode)}
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
                              {DELIVERY_MODE_LABELS[opt.mode]}
                            </span>
                            {opt.badge && (
                              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
                                {opt.badge}
                              </span>
                            )}
                          </div>
                          <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                            {DELIVERY_MODE_DESCRIPTIONS[opt.mode]}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label className="block space-y-1.5">
                  <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                    Agent 项目级指令
                  </span>
                  <textarea
                    rows={4}
                    maxLength={8000}
                    value={projInstructions}
                    onChange={(e) => setProjInstructions(e.target.value)}
                    placeholder="例如：提交交付前务必运行 pnpm test 与 pnpm typecheck，不要修改数据库迁移脚本。"
                    className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3 text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500"
                  />
                  <span className="block text-[11.5px] text-[var(--text-muted)]">
                    每次派发任务给本机 Local Agent 时都会附带这段指令。
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

            {/* 4. Local Agent Skill · 1:1 Scheduled Task Onboarding */}
            {snippets && (
              <section
                id="relaydesk-skill-setup"
                className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs scroll-mt-6"
              >
                <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/12 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                      <Icon name="terminal" size={16} />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                        Local Agent Skill · 1:1 定时任务接入
                      </h2>
                      <p className="text-[12px] text-[var(--text-muted)]">
                        每个项目一个工作目录（聚合全部子仓库）+ 一条专属 1:1 定时任务，全程在 Claude Code / Codex 对话中完成。
                      </p>
                    </div>
                  </div>
                  <DeliveryModeBadge mode={project.delivery_mode} compact />
                </div>

                <div className="p-5 space-y-5">
                  {/* Step 1: Global Skill Install */}
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-[var(--surface-subtle)] border border-[var(--border-strong)] text-[11px] font-mono font-semibold text-[var(--text-primary)] inline-flex items-center justify-center shrink-0">
                          1
                        </span>
                        <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                          全局安装 Skill
                        </h3>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] text-[var(--text-muted)]">
                          仅需一次
                        </span>
                      </div>
                      <CopyButton
                        value={SKILL_INSTALL_COMMAND}
                        label="复制安装命令"
                        copiedLabel="命令已复制"
                        size="xs"
                      />
                    </div>
                    <p className="text-[12px] leading-relaxed text-[var(--text-muted)] pl-7">
                      本仓库内置 Skill 位于{" "}
                      <code className="font-mono text-[var(--text-secondary)]">
                        skills/relaydesk/
                      </code>
                      。将下方路径替换为本机 Relaydesk 目录后执行一次，即可同时接入 Claude Code 与 Codex。
                    </p>
                    <pre className="ml-7 p-3.5 rounded-xl bg-zinc-950 text-zinc-100 text-[12px] font-mono leading-relaxed overflow-x-auto border border-zinc-800">
                      {SKILL_INSTALL_COMMAND}
                    </pre>
                  </div>

                  {/* Step 2: Highlighted One-Click Init Prompt */}
                  <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/[0.04] dark:bg-indigo-500/[0.06] p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[11px] font-mono font-semibold inline-flex items-center justify-center shrink-0">
                          2
                        </span>
                        <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                          一键复制本项目 Init 引导 Prompt
                        </h3>
                        <span className="text-[10.5px] font-medium px-1.5 py-0.5 rounded-md bg-indigo-500/15 text-indigo-700 dark:text-indigo-300">
                          核心步骤
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setShowPromptKey((v) => !v)}
                          className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-card)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] transition cursor-pointer"
                        >
                          <Icon name={showPromptKey ? "eye-off" : "eye"} size={12.5} />
                          {showPromptKey ? "隐藏密钥" : "显示密钥"}
                        </button>
                        <CopyButton
                          value={skillInitPromptReal}
                          label="复制 Init Prompt"
                          copiedLabel="Prompt 已复制"
                          size="xs"
                          className="!bg-[var(--rd-accent)] !text-white !border-transparent hover:!bg-[var(--rd-accent-hover)] shadow-xs"
                        />
                      </div>
                    </div>

                    <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
                      在本机对应项目的工作目录（可包含该项目绑定的全部子仓库文件夹）打开{" "}
                      <strong className="font-semibold text-[var(--text-primary)]">
                        Claude Code
                      </strong>{" "}
                      或{" "}
                      <strong className="font-semibold text-[var(--text-primary)]">
                        Codex
                      </strong>
                      ，直接粘贴下方 Prompt，Agent 会自动扫描本地子仓库、安全写入本机密钥（不进 git），并引导你通过对话为该项目创建专属 1:1 定时自动任务。
                    </p>

                    <pre className="p-3.5 rounded-xl bg-zinc-950 text-zinc-100 text-[12px] font-mono leading-relaxed whitespace-pre-wrap break-words overflow-x-auto border border-zinc-800 max-h-72 overflow-y-auto rd-scroll">
                      {skillInitPromptPreview}
                    </pre>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[var(--text-muted)]">
                      <span className="inline-flex items-center gap-1.5">
                        <Icon name="lock" size={12} className="text-emerald-500" />
                        {showPromptKey
                          ? "当前预览显示真实 Agent Key，注意防止录屏泄露。"
                          : "预览默认隐藏 Agent Key，点击「复制 Init Prompt」时自动带入真实密钥。"}
                      </span>
                      <span className="font-mono text-[11px]">
                        已包含 {projectReposList.length} 个绑定仓库
                      </span>
                    </div>
                  </div>

                  {/* Step 3: Collapsible Advanced Reference */}
                  <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedSkill((v) => !v)}
                      aria-expanded={showAdvancedSkill}
                      className="w-full px-4 py-3 flex items-center justify-between gap-2 text-left hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-5 h-5 rounded-full bg-[var(--surface-card)] border border-[var(--border-subtle)] text-[11px] font-mono font-semibold text-[var(--text-muted)] inline-flex items-center justify-center shrink-0">
                          3
                        </span>
                        <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                          高级参考：手动 CLI 命令、极简唤醒 Prompt 与密钥隔离说明
                        </span>
                      </div>
                      <Icon
                        name={showAdvancedSkill ? "chevron-down" : "chevron-right"}
                        size={15}
                        className="text-[var(--text-muted)] shrink-0"
                      />
                    </button>

                    {showAdvancedSkill && (
                      <div className="px-4 pb-4 pt-2 border-t border-[var(--border-subtle)] space-y-4">
                        {/* Manual CLI */}
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[12px] font-medium text-[var(--text-primary)]">
                              手动 Init CLI 命令
                            </span>
                            <div className="flex items-center gap-1.5">
                              <CopyButton
                                value={manualInitCliReal}
                                label="复制 CLI 命令"
                                copiedLabel="CLI 已复制"
                                size="xs"
                              />
                              <CopyButton
                                value={project.agent_key}
                                label="复制 Agent Key"
                                copiedLabel="Agent Key 已复制"
                                size="xs"
                                variant="subtle"
                              />
                            </div>
                          </div>
                          <pre className="p-3 rounded-xl bg-zinc-950 text-zinc-100 text-[12px] font-mono leading-relaxed overflow-x-auto border border-zinc-800">
                            {manualInitCliPreview}
                          </pre>
                        </div>

                        {/* Ultra-short Wake-up Prompt */}
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[12px] font-medium text-[var(--text-primary)]">
                                极简固定唤醒 Prompt
                              </span>
                              <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                                ~25 tokens
                              </span>
                            </div>
                            <CopyButton
                              value={SKILL_WAKEUP_PROMPT}
                              label="复制唤醒 Prompt"
                              copiedLabel="已复制"
                              size="xs"
                            />
                          </div>
                          <pre className="p-3 rounded-xl bg-zinc-950 text-zinc-100 text-[12px] font-mono leading-relaxed whitespace-pre-wrap break-words border border-zinc-800">
                            {SKILL_WAKEUP_PROMPT}
                          </pre>
                        </div>

                        {/* Secret Isolation Note */}
                        <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3.5 py-2.5 flex items-start gap-2 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                          <Icon
                            name="shield-check"
                            size={14}
                            className="text-emerald-500 mt-0.5 shrink-0"
                          />
                          <span>
                            <strong className="font-medium text-[var(--text-primary)]">
                              密钥隔离机制：
                            </strong>
                            Agent Key 保存在本机{" "}
                            <code className="font-mono text-[var(--text-secondary)]">
                              ~/.config/relaydesk/projects/{project.id}.json
                            </code>
                            （权限 <code className="font-mono">0600</code>），项目工作目录生成的{" "}
                            <code className="font-mono text-[var(--text-secondary)]">
                              ./.relaydesk.json
                            </code>{" "}
                            仅存项目 ID 与本地子仓库映射，不含任何敏感凭证，可安全置于工作区。
                          </span>
                        </div>
                      </div>
                    )}
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

              {/* Widget Snippet & Capabilities */}
              <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs">
                <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                      <Icon name="code-2" size={16} />
                    </div>
                    <div>
                      <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                        应用内 AI 反馈组件
                      </h2>
                      <p className="text-[12px] text-[var(--text-muted)]">
                        粘贴到应用 HTML 的 <code className="font-mono">&lt;body&gt;</code> 内即可收集反馈。访客可手动提单；如需对话，请在项目 CLI 设置中启用公开 AI。
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        r2Config?.configured
                          ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                          : "bg-amber-500/12 text-amber-700 dark:text-amber-300"
                      }`}
                    >
                      <Icon name="camera" size={11} />
                      {r2Config?.configured ? `截屏 R2 · ${r2Config.bucket}` : "截屏图床未配置"}
                    </span>
                  </div>
                </div>
                <div className="p-5 space-y-4">
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

                  {/* Container Code Context Mirror Panel */}
                  <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/70 p-4 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex-1 min-w-[220px]">
                        <Switch
                          checked={projWidgetCodeContext}
                          disabled={togglingCodeCtx}
                          onChange={(v) => void handleToggleWidgetCodeContext(v)}
                          label="组件 AI 代码上下文（容器内只读仓库镜像）"
                          description="开启后，访客在组件中咨询「怎么用/为什么报错」时，服务端 Agent 可只读查阅下方绑定仓库代码并当场解答；首次对话或满 5 分钟自动后台拉取最新代码。"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        icon="refresh-cw"
                        loading={syncingRepos}
                        disabled={!projWidgetCodeContext || projectReposList.length === 0}
                        onClick={() => void handleSyncProjectRepos()}
                      >
                        立即同步代码
                      </Button>
                    </div>

                    {projWidgetCodeContext && (
                      <div className="space-y-1.5 pt-1 border-t border-[var(--border-subtle)]">
                        {(repoMirrorStatus?.repos ?? projectReposList.map((r) => ({
                          repo: r,
                          ready: false,
                          commit: "",
                          updated_at: null,
                          error: undefined as string | undefined,
                        }))).map((entry) => (
                          <div
                            key={entry.repo}
                            className="flex flex-wrap items-center justify-between gap-2 text-[12px] px-2.5 py-1.5 rounded-lg bg-[var(--surface-card)] border border-[var(--border-subtle)]"
                          >
                            <span className="inline-flex items-center gap-2 font-mono text-[var(--text-primary)]">
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${
                                  entry.error
                                    ? "bg-rose-500"
                                    : entry.ready
                                      ? "bg-emerald-500"
                                      : "bg-zinc-400"
                                }`}
                              />
                              {entry.repo}
                            </span>
                            <span className="text-[11px] font-mono text-[var(--text-muted)]">
                              {entry.error
                                ? `同步失败: ${entry.error.slice(0, 64)}`
                                : entry.ready
                                  ? `已就绪${entry.commit ? ` · ${entry.commit}` : ""}`
                                  : "尚未拉取（首次对话时自动克隆）"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
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
