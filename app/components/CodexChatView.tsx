import { splitInlineThinkContent, STOP_LABELS } from "~/lib/chat-content.ts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "~/lib/api.ts";
import { messagesWithTurn, type ProjectChatStreams, type TurnTrace } from "~/lib/chat-streams.ts";
import { formatRelativeTime } from "~/lib/format.ts";
import {
  resolveActiveLocalAgent,
  resolveCatalogForTarget,
  resolveDefaultModelForTarget,
} from "~/lib/model-catalog.ts";
import type {
  ChatContextRef,
  ChatMessageRecord,
  ChatReasoningEffort,
  ChatRuntime,
  ChatRuntimeInfo,
  ChatSandboxMode,
  ChatSessionRecord,
  ProjectDetail,
  TaskRecord,
  WorkspaceDatabaseEntry,
  WorkspaceFileEntry,
  WorkspaceSummary,
} from "~/lib/types.ts";
import {
  FollowUpList,
  PromptBar,
  ThinkingTrace,
  ToolChipsGroup,
  type QuickPromptItem,
  type RichPromptEditorHandle,
  type TraceEntry,
} from "./agent-chat/AgentPrimitives.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { Button, EmptyState, LivePulseDot, useToast } from "./ui.tsx";

interface CodexChatViewProps {
  streams: ProjectChatStreams;
  project: ProjectDetail | null;
  tasks: TaskRecord[];
  pendingContext?: {
    ref?: ChatContextRef;
    prompt?: string;
    enableNetwork?: boolean;
    sandboxMode?: ChatSandboxMode;
  } | null;
  onConsumePendingContext?: () => void;
  onNewProject: () => void;
  onOpenWorkspace: () => void;
  onOpenCliSettings: () => void;
  onOpenRoutingSettings?: () => void;
  onTaskCreated: (task: TaskRecord) => void;
  mainSidebarCollapsed?: boolean;
  onExpandMainSidebar?: () => void;
}

const STARTER_PROMPTS: QuickPromptItem[] = [
  {
    icon: "folder-open",
    title: "盘点项目空间上下文",
    subtitle: "总览 files/ 目录、HANDBOOK.md 与已同步代码仓库",
    prompt: "请先查看当前项目空间 files/ 目录、HANDBOOK.md 以及已同步的仓库，给我一份精简的项目上下文总览。",
  },
  {
    icon: "database",
    title: "分析数据库结构与核心数据",
    subtitle: "检查 SQLite 或外部数据源的表结构、行数与关键分布",
    prompt: "请检查项目空间里的 SQLite 数据库或已配置数据源，列出每张表的结构、行数和核心数据分布。",
  },
  {
    icon: "code-2",
    title: "结合代码仓库定位核心模块",
    subtitle: "浏览 repos/ 目录，识别入口架构与潜在风险点",
    prompt: "请浏览 repos/ 下已同步的绑定仓库结构，指出核心入口模块以及常见风险点。",
  },
  {
    icon: "book-open",
    title: "起草或优化项目手册",
    subtitle: "整理目录结构、验证命令与日常排查约定（HANDBOOK.md）",
    prompt: "请结合现有项目文件和代码仓库，帮我整理一份结构清晰的 HANDBOOK.md 草案（包含目录结构、验证命令与排查约定）。",
  },
];

function buildContextualFollowUps(msg: ChatMessageRecord): QuickPromptItem[] {
  const hasTools = msg.events.length > 0;
  const hasCode = msg.content.includes("```");
  const list: QuickPromptItem[] = [];
  if (hasTools) {
    list.push({
      icon: "file-text",
      title: "展开关键证据与文件位置",
      prompt: "请把刚才分析中涉及的关键文件路径、行号或数据查询结果整理成简明对照表。",
    });
  }
  if (hasCode) {
    list.push({
      icon: "shield-check",
      title: "补充边界情况与验证步骤",
      prompt: "请检查上述方案有哪些边界情况或风险，并给出可直接执行的验证命令。",
    });
  }
  list.push({
    icon: "layers",
    title: "整理为可执行的下一步清单",
    prompt: "请把上面的结论浓缩成一份按优先级排序的行动清单（含改动范围和验收标准）。",
  });
  return list.slice(0, 2);
}

type TimeGroupKey = "今天" | "昨天" | "最近 7 天" | "更早";

function getTimeGroup(iso: string): TimeGroupKey {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "更早";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const oneDay = 86_400_000;
  if (ts >= startOfToday) return "今天";
  if (ts >= startOfToday - oneDay) return "昨天";
  if (ts >= startOfToday - 7 * oneDay) return "最近 7 天";
  return "更早";
}

export function CodexChatView({
  streams,
  project,
  tasks,
  pendingContext,
  onConsumePendingContext,
  onNewProject,
  onOpenWorkspace,
  onOpenCliSettings,
  onOpenRoutingSettings,
  onTaskCreated,
  mainSidebarCollapsed = false,
  onExpandMainSidebar,
}: CodexChatViewProps) {
  const toast = useToast();
  const projectId = project?.id ?? null;

  const [runtimeInfo, setRuntimeInfo] = useState<ChatRuntimeInfo | null>(null);
  const [workspaceSummary, setWorkspaceSummary] = useState<WorkspaceSummary | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [workspaceDatabases, setWorkspaceDatabases] = useState<WorkspaceDatabaseEntry[]>([]);

  const [sessions, setSessions] = useState<ChatSessionRecord[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const activeSessionId = useSyncExternalStore(streams.subscribe, streams.selection, streams.selection) ?? null;
  const setActiveSessionId = streams.select;
  const turns = useSyncExternalStore(streams.subscribe, streams.chatSnapshot, streams.chatSnapshot);
  const turn = activeSessionId ? turns.get(activeSessionId) : undefined;
  const [loadedSession, setActiveSession] = useState<ChatSessionRecord | null>(null);
  const activeSession = turn?.session ?? (loadedSession?.id === activeSessionId ? loadedSession : null);
  const [history, setMessages] = useState<ChatMessageRecord[]>([]);
  const messages = messagesWithTurn(history[0]?.session_id === activeSessionId ? history : [], turn);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titlingSessionId, setTitlingSessionId] = useState<string | null>(null);

  // Composer state
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatContextRef[]>([]);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [draftRuntime, setDraftRuntime] = useState<ChatRuntime | null>(null);
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState<ChatReasoningEffort>("default");
  const [draftTarget, setDraftTarget] = useState<ChatSessionRecord["execution_target"]>("auto");
  const [savingSettings, setSavingSettings] = useState(false);
  const [draftSandboxMode, setDraftSandboxMode] = useState<ChatSandboxMode>("read-only");
  const [draftNetworkAccess, setDraftNetworkAccess] = useState(false);

  // Streaming & trace state
  const streaming = turn ? turn.running : activeSession?.status === "running";
  const runId = streaming ? turn?.runId ?? activeSession?.active_run_id : undefined;
  const sendBlocked = Boolean(turn?.stopping || turn?.pending || (streaming && !runId));
  const statusLine = turn?.stopping
    ? turn.stopFailed ? "未能停止，等待当前回复结束" : "正在停止当前回复"
    : turn?.statusLine ?? (streaming ? "正在等待回复完成" : "");
  const creatingForSend = useRef(false);
  const [turnTraces, setTurnTraces] = useState<Record<string, TurnTrace>>({});
  const [convertingMsgId, setConvertingMsgId] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  // Smart scroll tracking
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const isNearBottomRef = useRef(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<RichPromptEditorHandle | null>(null);
  const prevProjectIdRef = useRef<string | null>(projectId);
  const pendingEnableNetworkRef = useRef(false);
  const pendingSandboxModeRef = useRef<ChatSandboxMode | null>(null);
  const [grantingDbSecrets, setGrantingDbSecrets] = useState(false);
  const justCreatedId = useRef<string | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  const handleThreadScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distance < 96;
    isNearBottomRef.current = near;
    setShowScrollBottom(!near && el.scrollHeight > el.clientHeight + 120);
  }, []);

  const loadContextCatalog = useCallback(async () => {
    if (!projectId) return;
    try {
      const [rt, summary, filesRes, dbsRes] = await Promise.all([
        api.getCodexChatRuntime(projectId),
        api.getWorkspaceSummary(projectId),
        api.listWorkspaceFiles(projectId),
        api.listWorkspaceDatabases(projectId),
      ]);
      if (prevProjectIdRef.current !== projectId) return;
      setRuntimeInfo(rt);
      setWorkspaceSummary(summary);
      setWorkspaceFiles(filesRes.files.filter((f) => f.type === "file"));
      setWorkspaceDatabases(dbsRes.databases);
    } catch {
      // ignore non-fatal background refresh
    }
  }, [projectId]);

  const loadSessions = useCallback(async () => {
    if (!projectId) return;
    setSessionsLoading(true);
    try {
      const res = await api.listCodexChatSessions(projectId);
      if (prevProjectIdRef.current !== projectId) return;
      setSessions(res.sessions);
      const selected = streams.selection();
      setActiveSessionId(selected === null || res.sessions.some(s => s.id === selected)
        ? selected ?? null : res.sessions[0]?.id ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载对话列表失败");
    } finally {
      if (prevProjectIdRef.current === projectId) setSessionsLoading(false);
    }
  }, [projectId, streams, setActiveSessionId, toast]);

  useEffect(() => {
    if (!projectId) return;
    prevProjectIdRef.current = projectId;
    void loadContextCatalog();
    void loadSessions();
    return () => { prevProjectIdRef.current = null; };
  }, [projectId, loadContextCatalog, loadSessions]);

  // Consume context handed over from Project Space
  useEffect(() => {
    if (!pendingContext) return;
    if (pendingContext.ref) {
      setAttachments((prev) =>
        prev.some((a) => a.kind === pendingContext.ref!.kind && a.ref === pendingContext.ref!.ref)
          ? prev
          : [...prev, pendingContext.ref!],
      );
    }
    if (pendingContext.prompt) {
      setInput(pendingContext.prompt);
    }
    if (pendingContext.enableNetwork) {
      setDraftNetworkAccess(true);
      pendingEnableNetworkRef.current = true;
    }
    if (pendingContext.sandboxMode) {
      setDraftSandboxMode(pendingContext.sandboxMode);
      pendingSandboxModeRef.current = pendingContext.sandboxMode;
    }
    onConsumePendingContext?.();
    window.setTimeout(() => composerRef.current?.focus(), 40);
  }, [pendingContext, onConsumePendingContext]);

  useEffect(() => {
    if (!projectId || !activeSession) return;
    const patch: Parameters<typeof api.updateCodexChatSession>[2] = {};
    if (pendingEnableNetworkRef.current) {
      pendingEnableNetworkRef.current = false;
      if (!activeSession.network_access) patch.network_access = true;
    }
    if (pendingSandboxModeRef.current) {
      const nextMode = pendingSandboxModeRef.current;
      pendingSandboxModeRef.current = null;
      if (activeSession.sandbox_mode !== nextMode) patch.sandbox_mode = nextMode;
    }
    if (Object.keys(patch).length === 0) return;
    void api
      .updateCodexChatSession(projectId, activeSession.id, patch)
      .then((res) => {
        streams.syncSession(res.session);
        setActiveSession(res.session);
        setSessions((prev) =>
          prev.map((s) => (s.id === res.session.id ? { ...s, ...res.session } : s)),
        );
      })
      .catch(() => {
        // non-fatal
      });
  }, [projectId, activeSession, streams]);

  useEffect(() => {
    if (!projectId || !activeSessionId) {
      setActiveSession(null);
      setMessages([]);
      setMessagesLoading(false);
      return;
    }
    // A fresh session is already loaded; a redundant GET could erase the first streaming turn.
    if (justCreatedId.current === activeSessionId) {
      justCreatedId.current = null;
      setMessagesLoading(false);
      return;
    }
    const requestedTurn = streams.snapshot().get(activeSessionId);
    let active = true;
    setMessagesLoading(true);
    setConfirmDeleteId(null);
    let timer: ReturnType<typeof setTimeout>;
    const readHistory = () => api
      .getCodexChatSession(projectId, activeSessionId)
      .then((res) => {
        if (!active) return;
        setActiveSession(res.session);
        setMessages(res.messages);
        setSessions(prev => prev.map(s => s.id === res.session.id ? { ...s, ...res.session } : s));
        if (requestedTurn && !requestedTurn.running && !requestedTurn.pending && streams.snapshot().get(activeSessionId) === requestedTurn) {
          setTurnTraces(prev => ({ ...prev, ...Object.fromEntries([...requestedTurn.previous, requestedTurn].map(t => [t.assistant.id, t.trace])) }));
          streams.retire(activeSessionId, requestedTurn);
        } else if (res.session.status !== "running") {
          streams.syncSession(res.session);
        }
        // Another tab owns the SSE connection. Only the terminal result is persisted.
        if (res.session.status === "running" && !streams.snapshot().has(activeSessionId)) {
          timer = setTimeout(readHistory, 1500);
        }
        setTitleDraft(res.session.title);
        isNearBottomRef.current = true;
        window.setTimeout(() => scrollToBottom("auto"), 30);
      })
      .catch((err) => {
        if (!active) return;
        setActiveSessionId(null);
        toast.error(err instanceof Error ? err.message : "读取会话记录失败");
      })
      .finally(() => {
        if (active) setMessagesLoading(false);
      });
    void readHistory();
    return () => {
      clearTimeout(timer);
      active = false;
    };
  }, [projectId, activeSessionId, streams, setActiveSessionId, toast, scrollToBottom]);

  useEffect(() => {
    if (!turn || turn.running || turn.pending || messagesLoading || loadedSession?.id !== turn.session.id) return;
    setActiveSession(turn.session);
    setSessions(prev => prev.map(s => s.id === turn.session.id ? { ...s, ...turn.session } : s));
    setMessages(prev => messagesWithTurn(prev, turn));
    setTurnTraces(prev => ({ ...prev, ...Object.fromEntries([...turn.previous, turn].map(t => [t.assistant.id, t.trace])) }));
    streams.retire(turn.session.id, turn);
  }, [turn, loadedSession, messagesLoading, streams]);

  // Smooth smart auto-scroll during streaming or new messages
  const lastMsg = messages[messages.length - 1];
  const scrollSignal = `${messages.length}:${lastMsg?.content.length ?? 0}:${lastMsg?.events.length ?? 0}:${statusLine}`;
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom(streaming ? "auto" : "smooth");
    }
  }, [scrollSignal, streaming, scrollToBottom]);

  const currentRuntime = activeSession?.runtime ?? draftRuntime ?? runtimeInfo?.project_cli.runtime ?? "codex";
  const currentTarget = activeSession?.execution_target || draftTarget || "auto";
  const activeLocalAgent = useMemo(
    () => resolveActiveLocalAgent(runtimeInfo, projectId ?? undefined, currentTarget, currentRuntime),
    [runtimeInfo, projectId, currentTarget, currentRuntime],
  );
  const activeLocalBinding = useMemo(
    () =>
      activeLocalAgent && projectId
        ? activeLocalAgent.bindings.find((b) => b.project_id === projectId) ?? null
        : null,
    [activeLocalAgent, projectId],
  );
  const attachedExternalDbs = useMemo(
    () =>
      attachments
        .filter((att) => att.kind === "database")
        .map((att) =>
          workspaceDatabases.find(
            (db) =>
              db.source === "external" &&
              (db.id === att.ref || db.env_var === att.ref || db.host_preview === att.ref || db.name === att.label),
          ),
        )
        .filter((db): db is WorkspaceDatabaseEntry => Boolean(db)),
    [attachments, workspaceDatabases],
  );
  const showDbSecretWarning =
    attachedExternalDbs.length > 0 &&
    Boolean(activeLocalAgent) &&
    activeLocalBinding !== null &&
    !activeLocalBinding.allow_datasource_secrets;

  const handleGrantLocalDbSecrets = async () => {
    if (!projectId || !activeLocalAgent || grantingDbSecrets) return;
    setGrantingDbSecrets(true);
    try {
      await api.updateProjectAgentBinding(projectId, activeLocalAgent.id, {
        allow_datasource_secrets: true,
      });
      await loadContextCatalog();
      toast.success(`已为「${activeLocalAgent.name}」开启数据源凭证授权`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "开启数据源凭证授权失败");
    } finally {
      setGrantingDbSecrets(false);
    }
  };

  const currentModel = activeSession?.model ?? draftModel;
  const currentEffort = activeSession ? activeSession.reasoning_effort ?? "default" : draftEffort;
  const targetDefaultModel = resolveDefaultModelForTarget(
    currentRuntime,
    activeLocalAgent,
    runtimeInfo?.project_cli,
  );
  const activeConfiguredModel = currentModel || targetDefaultModel;
  const currentSandboxMode = activeSession?.sandbox_mode ?? draftSandboxMode;
  const currentNetworkAccess = activeSession?.network_access ?? draftNetworkAccess;
  const showReadOnlyDbReadyHint =
    attachedExternalDbs.length > 0 &&
    currentSandboxMode === "read-only" &&
    (!activeLocalAgent || Boolean(activeLocalBinding?.allow_datasource_secrets));
  const settingsBusy = savingSettings || sessionsLoading || messagesLoading || !!(activeSessionId && activeSession?.id !== activeSessionId);

  const startDraft = () => {
    if (settingsBusy) return;
    setDraftRuntime(currentRuntime);
    setDraftModel(currentModel);
    setDraftEffort(currentEffort);
    setDraftTarget(activeSession?.execution_target ?? draftTarget);
    setDraftSandboxMode(currentSandboxMode);
    setDraftNetworkAccess(currentNetworkAccess);
    setActiveSessionId(null);
    setActiveSession(null);
    setMessages([]);
    setEditingTitle(false);
    composerRef.current?.focus();
  };

  const createDraftSession = async () => {
    if (!projectId || streaming || settingsBusy) return null;
    setSavingSettings(true);
    try {
      const res = await api.createCodexChatSession(projectId, {
        runtime: currentRuntime,
        model: activeConfiguredModel,
        reasoning_effort: currentEffort,
        execution_target: draftTarget,
        sandbox_mode: currentSandboxMode,
        network_access: currentNetworkAccess,
      });
      if (prevProjectIdRef.current !== projectId) {
        if (streams.selection() == null) streams.select(res.session.id);
        return res.session;
      }
      justCreatedId.current = res.session.id;
      setSessions((prev) => [res.session, ...prev]);
      setActiveSessionId(res.session.id);
      setActiveSession(res.session);
      setMessages([]);
      setTitleDraft(res.session.title);
      window.setTimeout(() => composerRef.current?.focus(), 40);
      return res.session;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建对话失败");
      return null;
    } finally {
      setSavingSettings(false);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!projectId) return;
    try {
      await api.deleteCodexChatSession(projectId, sessionId);
      setConfirmDeleteId(null);
      streams.retire(sessionId, streams.snapshot().get(sessionId));
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      if (streams.selection() === sessionId) setActiveSessionId(sessions.find(s => s.id !== sessionId)?.id ?? null);
      toast.success("已删除会话");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除会话失败");
    }
  };

  const handleUpdateSession = async (patch: Parameters<typeof api.updateCodexChatSession>[2]) => {
    if (!projectId || !activeSession || settingsBusy) return;
    setSavingSettings(true);
    try {
      const res = await api.updateCodexChatSession(projectId, activeSession.id, patch);
      streams.syncSession(res.session);
      setActiveSession((curr) => curr?.id === res.session.id ? res.session : curr);
      setSessions((prev) => prev.map((s) => (s.id === res.session.id ? { ...s, ...res.session } : s)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新会话设置失败");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleUploadImages = async (files: File[]) => {
    if (!projectId || uploadingImages || files.length === 0) return;
    const MIME_EXT: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif",
    };
    const remainingSlots = Math.max(0, 8 - attachments.length);
    if (remainingSlots === 0) {
      toast.error("单条消息最多附带 8 个引用/图片");
      return;
    }
    const candidates = files.slice(0, remainingSlots);
    setUploadingImages(true);
    try {
      const uploaded: ChatContextRef[] = [];
      for (const file of candidates) {
        const mime = file.type.toLowerCase();
        const ext = MIME_EXT[mime];
        if (!ext) {
          toast.error(`不支持的图片格式：${file.name || mime || "未知"}`);
          continue;
        }
        if (file.size > 10 * 1024 * 1024) {
          toast.error(`图片过大（上限 10MB）：${file.name}`);
          continue;
        }
        const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const relPath = `_chat_images/${unique}.${ext}`;
        await api.uploadWorkspaceFile(projectId, relPath, file);
        uploaded.push({
          kind: "image",
          label: file.name || `image.${ext}`,
          ref: relPath,
          mime,
        });
      }
      if (uploaded.length > 0) {
        setAttachments((prev) => [...prev, ...uploaded].slice(0, 8));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传图片失败");
    } finally {
      setUploadingImages(false);
    }
  };

  const handleSend = async (promptOverride?: string, attachmentsOverride?: ChatContextRef[]) => {
    if (!projectId || sendBlocked || settingsBusy || uploadingImages || creatingForSend.current || currentAuthMode === "unavailable") return;
    const rawText = (promptOverride ?? input).trim();
    const currentAttachments = attachmentsOverride ?? [...attachments];
    if (!rawText && !currentAttachments.some((att) => att.kind === "image")) return;
    const text = rawText || "请查看附带的图片";

    let session = activeSession;
    if (!session) {
      creatingForSend.current = true;
      try { session = await createDraftSession(); }
      finally { creatingForSend.current = false; }
      if (!session) return;
    }

    if (streaming && !turn) streams.observe(session, history);
    const completion = streams.send(session, text, currentAttachments, runId);
    if (!completion) return;
    if (!promptOverride) {
      setInput("");
      setAttachments([]);
      requestAnimationFrame(() => composerRef.current?.focus());
    }
    isNearBottomRef.current = true;
    try {
      await completion;
      if (session.sandbox_mode === "workspace-write") void loadContextCatalog();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "发送失败");
    }
  };

  const restoreUnsent = () => {
    if (!turn?.pending || turn.running) return;
    const queued = turn.pending;
    const merged = [...queued.attachments, ...attachments.filter(a => !queued.attachments.some(b => b.kind === a.kind && b.ref === a.ref))];
    if (merged.length > 8) {
      toast.error("合并后超过 8 个附件，请先移除部分草稿附件");
      return;
    }
    if (!streams.takeUnsent(turn.session.id)) return;
    setInput(prev => [queued.content, prev].filter(Boolean).join("\n\n"));
    setAttachments(merged);
    composerRef.current?.focus();
  };

  const handleAbort = async () => {
    if (!activeSession || !runId) return;
    if (!turn) streams.observe(activeSession, history);
    try {
      await streams.abort(activeSession.id, runId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "停止回复失败");
    }
  };

  const handleRegenerateTitle = async (sessionId: string) => {
    if (!projectId || titlingSessionId) return;
    setTitlingSessionId(sessionId);
    try {
      const res = await api.regenerateCodexChatSessionTitle(projectId, sessionId);
      setSessions((prev) =>
        prev.map((s) => (s.id === res.session.id ? { ...s, ...res.session } : s)),
      );
      setActiveSession((curr) =>
        curr?.id === res.session.id ? { ...curr, ...res.session } : curr,
      );
      if (activeSession?.id === res.session.id) {
        setTitleDraft(res.session.title);
      }
      toast.success(res.generated ? "已用模型优化会话标题" : "已整理会话标题");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "生成标题失败");
    } finally {
      setTitlingSessionId(null);
    }
  };

  const handleConvertToTask = async (msg: ChatMessageRecord) => {
    if (!projectId || convertingMsgId) return;
    setConvertingMsgId(msg.id);
    try {
      const firstLine = msg.content
        .split(/\r?\n/)
        .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
        .find(Boolean);
      const title = (firstLine || activeSession?.title || "Agent 对话转工单").slice(0, 80);
      const res = await api.createTask(projectId, {
        title,
        body: `来自网页对话「${activeSession?.title ?? "未命名"}」：\n\n${msg.content}`,
        priority: "normal",
        skip_prescreen: true,
      });
      toast.success(`已转为工单 RD-${res.task.number}`);
      onTaskCreated(res.task);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "转工单失败");
    } finally {
      setConvertingMsgId(null);
    }
  };

  const handleCopyMessage = (msgId: string, content: string) => {
    void navigator.clipboard?.writeText(content);
    setCopiedMsgId(msgId);
    toast.success("已复制回答内容");
    window.setTimeout(() => setCopiedMsgId((curr) => (curr === msgId ? null : curr)), 1600);
  };

  const toggleAttachment = (ref: ChatContextRef) => {
    setAttachments((prev) => {
      const exists = prev.some((a) => a.kind === ref.kind && a.ref === ref.ref);
      return exists ? prev.filter((a) => !(a.kind === ref.kind && a.ref === ref.ref)) : [...prev, ref];
    });
  };

  const openTasks = useMemo(
    () => tasks.filter((t) => !t.merged_into && t.status !== "done").slice(0, 25),
    [tasks],
  );

  // Filter & group sessions by time for Sidebar Nav
  const groupedSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase();
    const records = new Map(sessions.map(s => [s.id, s]));
    for (const [id, turn] of turns) records.set(id, { ...records.get(id), ...turn.session });
    const rows = Array.from(records.values());
    const filtered = q
      ? rows.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            (s.last_message_preview?.toLowerCase().includes(q) ?? false),
        )
      : rows;

    const groups: Array<{ label: TimeGroupKey; items: ChatSessionRecord[] }> = [];
    const map = new Map<TimeGroupKey, ChatSessionRecord[]>();
    const order: TimeGroupKey[] = ["今天", "昨天", "最近 7 天", "更早"];

    for (const s of filtered) {
      const key = getTimeGroup(s.updated_at);
      const bucket = map.get(key);
      if (bucket) bucket.push(s);
      else map.set(key, [s]);
    }
    for (const key of order) {
      const items = map.get(key);
      if (items && items.length > 0) {
        groups.push({ label: key, items });
      }
    }
    return groups;
  }, [sessions, sessionSearch, turns]);

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <EmptyState
          icon="sparkles"
          title="尚未选择项目"
          description="创建或选择一个项目后，即可在网页端直接与 Claude Code / Codex 协作对话。"
          action={
            <Button variant="primary" icon="plus" onClick={onNewProject}>
              新建项目
            </Button>
          }
        />
      </div>
    );
  }

  const currentAgents = runtimeInfo?.agents ?? [];
  const hasReadyLocalForCurrent = (() => {
    const checkAgent = (agentId: string) => {
      const agent = currentAgents.find((a) => a.id === agentId);
      if (!agent?.online || !agent.runtimes[currentRuntime]?.available) return false;
      const binding = agent.bindings.find((b) => b.project_id === project.id);
      return Boolean(binding?.enabled && binding?.path_ok);
    };
    if (currentTarget.startsWith("local:")) return checkAgent(currentTarget.slice("local:".length));
    if (currentTarget === "cloud") return false;
    return currentAgents.some((a) => checkAgent(a.id));
  })();
  const currentAuthMode =
    currentTarget === "cloud"
      ? (runtimeInfo?.auth_mode[currentRuntime] ?? "unavailable")
      : hasReadyLocalForCurrent
        ? "local_cli"
        : currentTarget.startsWith("local:")
          ? "unavailable"
          : (runtimeInfo?.auth_mode[currentRuntime] ?? "unavailable");
  const resolvedTargetLabel = (() => {
    const resolved = activeSession?.resolved_target;
    if (!resolved) return null;
    if (resolved === "cloud") return "云端";
    if (resolved.startsWith("local:")) {
      const id = resolved.slice("local:".length);
      const name = currentAgents.find((a) => a.id === id)?.name;
      return name ? `本机 · ${name}` : "本机节点";
    }
    return null;
  })();
  const readyReposCount = workspaceSummary
    ? workspaceSummary.repos_status.repos.filter((r) => r.ready).length
    : 0;

  const renderSidebarInner = (isMobileOverlay: boolean) => (
    <>
      {/* Sidebar Header */}
      <div className={`px-2.5 pt-2.5 pb-2 flex items-center gap-1.5 ${isMobileOverlay ? "rd-safe-pt" : ""}`}>
        {!isMobileOverlay && mainSidebarCollapsed && onExpandMainSidebar && (
          <button
            type="button"
            title="展开主导航栏 (⌘B)"
            aria-label="展开主导航栏"
            onClick={onExpandMainSidebar}
            className="hidden lg:inline-flex h-8 w-8 shrink-0 rounded-lg items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
          >
            <Icon name="panel-left-open" size={15} />
          </button>
        )}
        <button
          type="button"
          disabled={settingsBusy}
          onClick={() => {
            startDraft();
            setMobileSessionsOpen(false);
          }}
          className="flex-1 h-9 lg:h-8 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] hover:border-[var(--border-strong)] text-[12.5px] font-medium text-[var(--text-primary)] inline-flex items-center justify-center gap-1.5 shadow-[var(--rd-shadow-sm)] transition-colors cursor-pointer"
        >
          <Icon name="plus" size={14} />
          <span>新建对话</span>
        </button>
        <button
          type="button"
          title="收起会话列表"
          aria-label="收起会话列表"
          onClick={() => (isMobileOverlay ? setMobileSessionsOpen(false) : setSidebarOpen(false))}
          className="h-9 w-9 lg:h-8 lg:w-8 rounded-lg inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
        >
          <Icon name={isMobileOverlay ? "x" : "panel-left-close"} size={15} />
        </button>
      </div>

      {/* Search Sessions */}
      {sessions.length > 0 && (
        <div className="px-2.5 pb-2">
          <div className="flex items-center gap-1.5 h-8 lg:h-7 px-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)]/70 focus-within:border-[var(--border-strong)] focus-within:bg-[var(--surface-card)] transition-colors">
            <Icon name="search" size={12} className="text-[var(--text-muted)] shrink-0" />
            <input
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
              placeholder="搜索会话…"
              className="flex-1 min-w-0 bg-transparent text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
            {sessionSearch && (
              <button
                type="button"
                onClick={() => setSessionSearch("")}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer p-1"
              >
                <Icon name="x" size={11} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Grouped Session List */}
      <div className="flex-1 overflow-y-auto rd-scroll px-2 pb-2 space-y-3">
        {sessionsLoading ? (
          <div className="py-8 text-center text-[12px] text-[var(--text-muted)]">加载会话…</div>
        ) : sessions.length === 0 && turns.size === 0 ? (
          <div className="px-3 py-8 text-center text-[12px] text-[var(--text-muted)] leading-relaxed">
            暂无历史对话，点击上方「新建对话」或在右侧直接输入即可开始。
          </div>
        ) : groupedSessions.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
            未找到匹配的会话
          </div>
        ) : (
          groupedSessions.map((group) => (
            <div key={group.label} className="space-y-0.5">
              <div className="px-2 pt-1 pb-0.5 text-[10.5px] font-medium text-[var(--text-muted)] tracking-wide">
                {group.label}
              </div>
              {group.items.map((s) => {
                const rowTurn = turns.get(s.id);
                const active = s.id === activeSessionId;
                const confirming = confirmDeleteId === s.id;
                return (
                  <div
                    key={s.id}
                    onClick={() => {
                      if (!savingSettings && !confirming) {
                        setEditingTitle(false);
                        setActiveSessionId(s.id);
                        setMobileSessionsOpen(false);
                      }
                    }}
                    className={`group rounded-lg px-2 py-2 lg:py-1.5 transition-colors cursor-pointer ${
                      active
                        ? "bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--rd-shadow-sm)] ring-1 ring-[var(--border-subtle)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            s.runtime === "codex" ? "bg-emerald-500" : "bg-amber-500"
                          }`}
                        />
                        <span className="text-[12.5px] font-medium truncate">{s.title}</span>
                      </span>

                      {confirming ? (
                        <span
                          className="inline-flex items-center gap-1 shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => void handleDeleteSession(s.id)}
                            className="px-2 py-1 lg:px-1.5 lg:py-0.5 rounded bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-600 hover:text-white text-[11px] lg:text-[10.5px] font-medium transition cursor-pointer"
                          >
                            删除
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-1.5 py-1 lg:px-1 lg:py-0.5 rounded text-[11px] lg:text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-0.5 shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            title="AI 重新总结标题"
                            aria-label="AI 重新总结标题"
                            disabled={titlingSessionId === s.id}
                            onClick={() => void handleRegenerateTitle(s.id)}
                            className={`p-1.5 lg:p-0.5 rounded text-[var(--text-muted)] hover:text-indigo-500 transition-opacity cursor-pointer shrink-0 ${
                              titlingSessionId === s.id
                                ? "opacity-100"
                                : "opacity-75 lg:opacity-0 lg:group-hover:opacity-100"
                            }`}
                          >
                            <Icon
                              name={titlingSessionId === s.id ? "loader-2" : "sparkles"}
                              size={12}
                              className={titlingSessionId === s.id ? "animate-spin text-indigo-500" : ""}
                            />
                          </button>
                          <button
                            type="button"
                            title="删除会话"
                            aria-label="删除会话"
                            disabled={rowTurn?.running}
                            onClick={() => setConfirmDeleteId(s.id)}
                            className="opacity-75 lg:opacity-0 lg:group-hover:opacity-100 p-1.5 lg:p-0.5 rounded text-[var(--text-muted)] hover:text-rose-500 transition-opacity cursor-pointer shrink-0"
                          >
                            <Icon name="trash-2" size={12} />
                          </button>
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-1.5 mt-0.5 pl-3 text-[10.5px] text-[var(--text-muted)]">
                      <span className="font-mono uppercase text-[10px]">
                        {s.runtime}
                        {s.runtime === "codex" && s.network_access ? " · 联网" : ""}
                      </span>
                      <span>{rowTurn?.running || (active && streaming) ? "回复中" : formatRelativeTime(s.updated_at)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* Compact Engine Status Card */}
      <div className="p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] border-t border-[var(--border-subtle)]">
        <button
          type="button"
          onClick={() => {
            setMobileSessionsOpen(false);
            onOpenCliSettings();
          }}
          className="w-full p-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]/60 transition-colors text-left space-y-1.5 cursor-pointer"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--text-primary)]">
              <LivePulseDot
                tone={currentAuthMode === "unavailable" ? "zinc" : "emerald"}
                active={currentAuthMode !== "unavailable"}
              />
              {currentRuntime === "codex" ? "Codex CLI" : "Claude Code"}
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
              <Icon name="settings" size={11} />
              配置
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
            <span className="font-mono truncate">
              {activeConfiguredModel ||
                (currentAuthMode === "project_key"
                  ? "项目密钥已就绪"
                  : currentAuthMode === "local_cli"
                    ? "本机登录态"
                    : "未检测到 CLI")}
            </span>
          </div>
        </button>
      </div>
    </>
  );

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden bg-[var(--surface-canvas)] relative">
      {/* Desktop Left Sessions Sidebar */}
      {sidebarOpen && (
        <aside className="hidden lg:flex w-[256px] shrink-0 border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)] flex-col min-h-0">
          {renderSidebarInner(false)}
        </aside>
      )}

      {/* Mobile Overlay Sessions Drawer (< lg, collapsed by default) */}
      {mobileSessionsOpen && (
        <div
          className="fixed inset-0 z-40 lg:hidden flex bg-[var(--rd-backdrop)] backdrop-blur-[1px] animate-fade-in"
          onClick={() => setMobileSessionsOpen(false)}
        >
          <aside
            className="w-[min(288px,86vw)] h-full border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)] flex flex-col min-h-0 shadow-[var(--rd-shadow-lg)] animate-drawer-in-left"
            onClick={(e) => e.stopPropagation()}
          >
            {renderSidebarInner(true)}
          </aside>
        </div>
      )}

      {/* Main Agent Column */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">
        {/* Clean Minimal Top Header */}
        <header className="shrink-0 h-12 sm:h-13 px-3 sm:px-4 border-b border-[var(--border-subtle)] bg-[var(--surface-canvas)]/90 backdrop-blur-sm flex items-center justify-between gap-2 sm:gap-3">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            {/* Mobile (< lg) session drawer toggle + quick new chat */}
            <div className="flex lg:hidden items-center gap-1 shrink-0">
              <button
                type="button"
                title="打开会话列表"
                aria-label="打开会话列表"
                onClick={() => setMobileSessionsOpen(true)}
                className="h-9 w-9 rounded-lg inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
              >
                <Icon name="messages-square" size={16} />
              </button>
              <button
                type="button"
                title="新建对话"
                aria-label="新建对话"
                disabled={settingsBusy}
                onClick={startDraft}
                className="h-9 w-9 rounded-lg inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
              >
                <Icon name="plus" size={16} />
              </button>
            </div>

            {/* Desktop (>= lg) collapsed sidebar expand controls */}
            {!sidebarOpen && (
              <div className="hidden lg:flex items-center gap-1 shrink-0">
                {mainSidebarCollapsed && onExpandMainSidebar && (
                  <button
                    type="button"
                    title="展开主导航栏 (⌘B)"
                    aria-label="展开主导航栏"
                    onClick={onExpandMainSidebar}
                    className="inline-flex h-7 w-7 rounded-lg items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
                  >
                    <Icon name="panel-left-open" size={15} />
                  </button>
                )}
                <button
                  type="button"
                  title="展开会话列表"
                  aria-label="展开会话列表"
                  onClick={() => setSidebarOpen(true)}
                  className="h-7 w-7 rounded-lg inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
                >
                  <Icon name={mainSidebarCollapsed ? "messages-square" : "panel-left-open"} size={15} />
                </button>
                <button
                  type="button"
                  title="新建对话"
                  aria-label="新建对话"
                  disabled={settingsBusy}
                  onClick={startDraft}
                  className="h-7 w-7 rounded-lg inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
                >
                  <Icon name="plus" size={15} />
                </button>
              </div>
            )}

            {activeSession && editingTitle ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  setEditingTitle(false);
                  if (titleDraft.trim() && titleDraft.trim() !== activeSession.title) {
                    void handleUpdateSession({ title: titleDraft.trim() });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setEditingTitle(false);
                    if (titleDraft.trim() && titleDraft.trim() !== activeSession.title) {
                      void handleUpdateSession({ title: titleDraft.trim() });
                    }
                  } else if (e.key === "Escape") {
                    setEditingTitle(false);
                    setTitleDraft(activeSession.title);
                  }
                }}
                className="h-7 px-2 rounded-md border border-indigo-500 bg-[var(--surface-elevated)] text-[13.5px] font-semibold text-[var(--text-primary)] focus:outline-none"
              />
            ) : (
              <button
                type="button"
                disabled={!activeSession}
                onClick={() => {
                  if (activeSession) {
                    setTitleDraft(activeSession.title);
                    setEditingTitle(true);
                  }
                }}
                className="text-[13.5px] font-semibold text-[var(--text-primary)] truncate hover:text-indigo-600 dark:hover:text-indigo-400 transition cursor-pointer"
                title={activeSession ? "点击重命名会话" : undefined}
              >
                {activeSession ? activeSession.title : `Agent 工作台 · ${project.name}`}
              </button>
            )}

            {resolvedTargetLabel && (
              <span
                title={`上次实际执行节点：${resolvedTargetLabel}`}
                className="hidden sm:inline-flex items-center gap-1 text-[10.5px] font-medium px-1.5 py-0.5 rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 shrink-0"
              >
                <Icon
                  name={activeSession?.resolved_target?.startsWith("local:") ? "monitor" : "cloud"}
                  size={10}
                />
                {resolvedTargetLabel}
              </span>
            )}

            {activeSession?.external_session_id && (
              <span
                title={`已绑定连续线程：${activeSession.external_session_id}`}
                className="hidden sm:inline-flex items-center gap-1 text-[10.5px] font-mono px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 shrink-0"
              >
                <Icon name="link-2" size={10} />
                多轮连续
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {workspaceSummary && (
              <button
                type="button"
                onClick={onOpenWorkspace}
                title="查看和管理项目空间文件、数据库与手册"
                className="hidden md:inline-flex items-center gap-2 h-7 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] hover:border-[var(--border-strong)] text-[11.5px] text-[var(--text-secondary)] transition-colors cursor-pointer"
              >
                <span className="inline-flex items-center gap-1">
                  <Icon name="folder-open" size={12} className="text-[var(--text-muted)]" />
                  {workspaceSummary.files_count}
                </span>
                <span className="text-[var(--border-strong)]">·</span>
                <span className="inline-flex items-center gap-1">
                  <Icon name="database" size={12} className="text-[var(--text-muted)]" />
                  {workspaceSummary.databases_count}
                </span>
                <span className="text-[var(--border-strong)]">·</span>
                <span className="inline-flex items-center gap-1">
                  <Icon name="folder-git-2" size={12} className="text-[var(--text-muted)]" />
                  {readyReposCount}
                </span>
                <span className="text-[var(--text-muted)] ml-0.5">项目空间</span>
              </button>
            )}
            <Button
              size="xs"
              variant="ghost"
              icon="folder-open"
              onClick={onOpenWorkspace}
              className="md:hidden"
            >
              空间
            </Button>
          </div>
        </header>

        {/* Scrollable Conversation Thread */}
        <div
          ref={scrollContainerRef}
          onScroll={handleThreadScroll}
          className="flex-1 overflow-y-auto rd-scroll px-3 sm:px-4 pt-4 sm:pt-6 pb-6 sm:pb-8"
        >
          <div className="max-w-[740px] mx-auto">
            {messagesLoading ? (
              <div className="py-20 flex items-center justify-center">
                <div className="inline-flex items-center gap-2.5 text-[13px] text-[var(--text-muted)]">
                  <Icon name="loader-2" size={14} className="animate-spin text-[var(--text-muted)]" />
                  <span>正在加载会话记录…</span>
                </div>
              </div>
            ) : messages.length === 0 ? (
              <div className="pt-8 pb-4 space-y-7 animate-fade-up">
                {/* Hero Header */}
                <div className="space-y-2.5">
                  <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[11.5px] text-[var(--text-secondary)]">
                    <LivePulseDot
                      tone={currentAuthMode === "unavailable" ? "zinc" : "emerald"}
                      active={currentAuthMode !== "unavailable"}
                    />
                    <span className="font-medium">
                      {currentRuntime === "codex" ? "Codex CLI" : "Claude Code"}
                    </span>
                    {activeConfiguredModel && (
                      <span className="font-mono text-[11px] text-[var(--text-muted)]">
                        {activeConfiguredModel}
                      </span>
                    )}
                  </div>
                  <h2 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                    {project.name}
                  </h2>
                  <p className="text-[13.5px] text-[var(--text-muted)] max-w-xl leading-relaxed">
                    工作区已挂载项目文件、数据库、手册与已同步代码仓库。输入{" "}
                    <kbd className="rd-kbd">@</kbd> 引用具体资源，或输入{" "}
                    <kbd className="rd-kbd">/</kbd> 调用快捷指令。
                  </p>
                </div>

                {/* Compact Context Bar */}
                {workspaceSummary && (
                  <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    <button
                      type="button"
                      onClick={onOpenWorkspace}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] transition cursor-pointer"
                    >
                      <Icon name="folder-open" size={12} className="text-indigo-500" />
                      <span>{workspaceSummary.files_count} 个文件</span>
                    </button>
                    <button
                      type="button"
                      onClick={onOpenWorkspace}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] transition cursor-pointer"
                    >
                      <Icon name="database" size={12} className="text-emerald-500" />
                      <span>{workspaceSummary.databases_count} 个数据库</span>
                    </button>
                    <button
                      type="button"
                      onClick={onOpenWorkspace}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] transition cursor-pointer"
                    >
                      <Icon name="book-open" size={12} className="text-amber-500" />
                      <span>手册{workspaceSummary.handbook_exists ? "已挂载" : "未填写"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={onOpenWorkspace}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] transition cursor-pointer"
                    >
                      <Icon name="folder-git-2" size={12} className="text-indigo-500" />
                      <span>{readyReposCount} 个同步仓库</span>
                    </button>
                  </div>
                )}

                {currentAuthMode === "unavailable" && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-3.5 py-3 text-[12.5px] text-amber-700 dark:text-amber-300 flex items-center justify-between gap-3">
                    <span>
                      当前服务器未检测到本机 <code className="font-mono">{currentRuntime}</code> 可执行文件，请在下方切换引擎或检查 CLI 设置。
                    </span>
                    <Button size="xs" variant="secondary" onClick={onOpenCliSettings}>
                      CLI 设置
                    </Button>
                  </div>
                )}

                {/* Sleek List-Style Starter Prompts (Beautiful UI style) */}
                <FollowUpList
                  heading="快速开始"
                  items={STARTER_PROMPTS}
                  disabled={streaming || settingsBusy || currentAuthMode === "unavailable"}
                  onSelect={(p) => void handleSend(p)}
                />
              </div>
            ) : (
              <div className="space-y-7">
                {messages.map((msg, idx) => {
                  const isUser = msg.role === "user";
                  const isLastMessage = idx === messages.length - 1;
                  const isStreamingMsg = msg.status === "streaming";
                  const trace = turn?.assistant.id === msg.id ? turn.trace : turnTraces[msg.id] ?? turn?.previous.find(t => t.assistant.id === msg.id)?.trace;
                  const prevUserMsg =
                    !isUser && idx > 0 && messages[idx - 1]?.role === "user"
                      ? messages[idx - 1]
                      : null;

                  if (isUser) {
                    const hasBlockMarkdown =
                      msg.content.includes("```") ||
                      msg.content.includes("\n") ||
                      msg.content.length > 80;
                    return (
                      <div key={msg.id} className="flex justify-end animate-fade-up">
                        <div
                          className={`space-y-1.5 flex flex-col items-end ${
                            hasBlockMarkdown ? "max-w-[88%] min-w-0" : "max-w-[82%] min-w-0"
                          }`}
                        >
                          {msg.attachments.length > 0 && (() => {
                            const imageAtts = msg.attachments.filter((att) => att.kind === "image");
                            const refAtts = msg.attachments.filter((att) => att.kind !== "image");
                            return (
                              <div className="flex flex-col items-end gap-1.5">
                                {imageAtts.length > 0 && (
                                  <div className="flex flex-wrap justify-end gap-1.5">
                                    {imageAtts.map((att) => {
                                      const imgUrl = `/api/projects/${encodeURIComponent(project.id)}/workspace/file?path=${encodeURIComponent(att.ref)}&inline=1`;
                                      return (
                                        <a
                                          key={`${att.kind}:${att.ref}`}
                                          href={imgUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="block group"
                                        >
                                          <img
                                            src={imgUrl}
                                            alt={att.label}
                                            loading="lazy"
                                            className="max-h-52 w-auto max-w-[260px] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] object-contain shadow-2xs group-hover:border-indigo-500/50 transition-colors"
                                          />
                                        </a>
                                      );
                                    })}
                                  </div>
                                )}
                                {refAtts.length > 0 && (
                                  <div className="flex flex-wrap justify-end gap-1.5">
                                    {refAtts.map((att) => (
                                      <span
                                        key={`${att.kind}:${att.ref}`}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[6px] border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[11px] font-mono text-[var(--text-secondary)]"
                                      >
                                        <Icon
                                          name={
                                            att.kind === "database"
                                              ? "database"
                                              : att.kind === "task"
                                                ? "inbox"
                                                : "file-text"
                                          }
                                          size={11}
                                          className="text-indigo-500"
                                        />
                                        <span className="max-w-[220px] truncate">{att.label}</span>
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                          <div className="w-full rounded-2xl rounded-br-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-4 py-2.5 text-[13.5px] leading-[1.6] text-[var(--text-primary)] shadow-[var(--rd-shadow-sm)] overflow-hidden">
                            <MarkdownContent
                              content={msg.content}
                              projectId={project.id}
                              compact
                              preserveLineBreaks
                              className="text-[13.5px]"
                            />
                          </div>
                          {turn?.pending?.id === msg.id && (
                            <div role="status" className="flex items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
                              {turn.running ? "待发送 · 上一轮保存后自动发送" : "未发送 · 未能确认上一轮已保存"}
                              {!turn.running && (
                                <button type="button" className="underline" onClick={restoreUnsent}>放回输入框</button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }

                  const { thinkingBlocks, visibleContent, hasOpenThink } = splitInlineThinkContent(
                    msg.content,
                  );
                  const mergedTraceEntries: TraceEntry[] = [
                    ...(trace?.entries ?? []),
                    ...thinkingBlocks.map((text, tIdx) => ({
                      id: `inline-think-${msg.id}-${tIdx}`,
                      kind: "reasoning" as const,
                      text,
                    })),
                  ];

                  // Editorial Borderless Assistant Turn
                  const followUps =
                    isLastMessage &&
                    !streaming &&
                    msg.status === "done" &&
                    visibleContent &&
                    !input.trim()
                      ? buildContextualFollowUps(msg)
                      : [];

                  return (
                    <article key={msg.id} className="group/msg space-y-1 animate-fade-up">
                      {/* Minimal Turn Meta Header */}
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="w-5 h-5 rounded-md bg-[var(--surface-subtle)] border border-[var(--border-subtle)] inline-flex items-center justify-center text-[var(--text-secondary)]">
                          <Icon name="sparkles" size={11} />
                        </span>
                        <span className="text-[12px] font-semibold text-[var(--text-primary)]">
                          {isStreamingMsg ? (currentRuntime === "codex" ? "Codex" : "Claude") : "助手"}
                        </span>
                        {isStreamingMsg && activeConfiguredModel && (
                          <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
                            {activeConfiguredModel}
                          </span>
                        )}
                        {!isStreamingMsg && (
                          <span className="text-[11px] text-[var(--text-muted)] ml-auto">
                            {msg.stop_reason ? STOP_LABELS[msg.stop_reason] : msg.status === "aborted"
                              ? "已中止"
                              : msg.status === "error"
                                ? "执行异常"
                                : formatRelativeTime(msg.created_at)}
                          </span>
                        )}
                      </div>

                      {/* Thinking / Live Loading Trace */}
                      <ThinkingTrace
                        active={
                          isStreamingMsg &&
                          (hasOpenThink ||
                            !visibleContent ||
                            msg.events.some((e) => e.status === "running"))
                        }
                        statusLabel={hasOpenThink ? "正在深度推理" : statusLine || "正在思考"}
                        entries={mergedTraceEntries}
                        startedAt={trace?.startedAt}
                        durationMs={trace?.durationMs}
                      />

                      {/* Compact Tool Chips */}
                      <ToolChipsGroup events={msg.events} isStreaming={isStreamingMsg} />

                      {/* Streamed Markdown Prose */}
                      {visibleContent && (
                        <div
                          className={
                            msg.status === "error"
                              ? "rounded-xl border border-rose-500/25 bg-rose-500/6 px-3.5 py-2.5 text-[13px] text-rose-700 dark:text-rose-300"
                              : "text-[14px] leading-[1.7] text-[var(--text-primary)]"
                          }
                        >
                          <MarkdownContent content={visibleContent} projectId={project.id} />
                          {isStreamingMsg && (
                            <span
                              aria-hidden="true"
                              className="inline-block w-[2px] h-[14px] ml-0.5 align-middle bg-[var(--text-primary)] rd-caret-blink"
                            />
                          )}
                        </div>
                      )}

                      {/* Clean Action Row */}
                      {!isStreamingMsg && msg.content && (
                        <div className="pt-2 flex items-center gap-1 text-[11.5px] text-[var(--text-muted)]">
                          <button
                            type="button"
                            onClick={() => handleCopyMessage(msg.id, msg.content)}
                            className="inline-flex items-center gap-1 h-7 px-2 rounded-md hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                          >
                            <Icon
                              name={copiedMsgId === msg.id ? "check" : "copy"}
                              size={12}
                              className={copiedMsgId === msg.id ? "text-emerald-500" : ""}
                            />
                            <span>{copiedMsgId === msg.id ? "已复制" : "复制"}</span>
                          </button>

                          {prevUserMsg && (
                            <button
                              type="button"
                              disabled={streaming || settingsBusy || currentAuthMode === "unavailable"}
                              onClick={() =>
                                void handleSend(prevUserMsg.content, prevUserMsg.attachments)
                              }
                              className="inline-flex items-center gap-1 h-7 px-2 rounded-md hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50 cursor-pointer"
                            >
                              <Icon name="refresh-cw" size={12} />
                              <span>重试</span>
                            </button>
                          )}

                          <button
                            type="button"
                            disabled={convertingMsgId === msg.id}
                            onClick={() => void handleConvertToTask(msg)}
                            className="inline-flex items-center gap-1 h-7 px-2 rounded-md hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors cursor-pointer"
                          >
                            <Icon
                              name={convertingMsgId === msg.id ? "loader-2" : "plus"}
                              size={12}
                              className={convertingMsgId === msg.id ? "animate-spin" : ""}
                            />
                            <span>转为工单</span>
                          </button>
                        </div>
                      )}

                      {/* Contextual Follow-up Suggestions */}
                      {followUps.length > 0 && (
                        <FollowUpList
                          heading="继续追问"
                          items={followUps}
                          compact
                          disabled={streaming || settingsBusy || currentAuthMode === "unavailable"}
                          onSelect={(p) => void handleSend(p)}
                        />
                      )}
                    </article>
                  );
                })}
              </div>
            )}
            <div ref={bottomRef} className="h-4" />
          </div>
        </div>

        {/* Floating Scroll-to-Bottom Pill */}
        {showScrollBottom && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[152px] sm:bottom-[168px] flex justify-center z-20 animate-fade-in">
            <button
              type="button"
              onClick={() => {
                isNearBottomRef.current = true;
                setShowScrollBottom(false);
                scrollToBottom("smooth");
              }}
              className="pointer-events-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)]/95 backdrop-blur-sm text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] shadow-[var(--rd-shadow-md)] transition cursor-pointer"
            >
              <Icon name="arrow-down" size={13} />
              <span>回到底部</span>
            </button>
          </div>
        )}

        {/* Bottom Floating Prompt Bar */}
        <div className="shrink-0 px-2.5 sm:px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-4 bg-gradient-to-t from-[var(--surface-canvas)] via-[var(--surface-canvas)]/95 to-transparent">
          <div className="max-w-[740px] mx-auto space-y-2">
            {showDbSecretWarning && activeLocalAgent && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon name="shield-alert" size={14} className="shrink-0 text-amber-500" />
                  <span className="leading-snug">
                    本机节点「{activeLocalAgent.name}」尚未开启「允许数据源凭证」，只读查库工具暂无法连接
                    {attachedExternalDbs.map((d) => `「${d.name}」`).join("、")}。
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="xs"
                    variant="secondary"
                    icon="key-round"
                    loading={grantingDbSecrets}
                    onClick={() => void handleGrantLocalDbSecrets()}
                  >
                    一键开启授权
                  </Button>
                  {onOpenRoutingSettings && (
                    <Button size="xs" variant="ghost" onClick={onOpenRoutingSettings}>
                      节点设置
                    </Button>
                  )}
                </div>
              </div>
            )}
            {showReadOnlyDbReadyHint && (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-1.5 text-[11.5px] text-emerald-700 dark:text-emerald-300">
                <Icon name="shield-check" size={13} className="shrink-0 text-emerald-500" />
                <span>
                  只读排查已就绪：将通过 Relaydesk MCP 安全只读查询
                  {attachedExternalDbs.map((d) => `「${d.name}」`).join("、")}，不会修改本地代码或写入数据库。
                </span>
              </div>
            )}
            <PromptBar
              projectId={project.id}
              input={input}
              onInputChange={setInput}
              attachments={attachments}
              onToggleAttachment={toggleAttachment}
              onUploadImages={(files) => void handleUploadImages(files)}
              uploadingImages={uploadingImages}
              workspaceFiles={workspaceFiles}
              workspaceDatabases={workspaceDatabases}
              openTasks={openTasks}
              runtime={currentRuntime}
              runtimeInfo={runtimeInfo}
              sandboxMode={currentSandboxMode}
              networkAccess={currentNetworkAccess}
              streaming={streaming}
              sendBlocked={sendBlocked}
              stopBlocked={!runId || Boolean(turn?.stopping)}
              statusLine={statusLine}
              authUnavailable={currentAuthMode === "unavailable"}
              composerRef={composerRef}
              model={activeConfiguredModel}
              effort={currentEffort}
              executionTarget={currentTarget}
              settingsBusy={settingsBusy}
              onChangeModel={(rt, model, effort) => {
                if (activeSession) {
                  void handleUpdateSession({
                    ...(rt !== currentRuntime && { runtime: rt }),
                    model,
                    ...(effort !== currentEffort && { reasoning_effort: effort }),
                  });
                } else {
                  setDraftRuntime(rt);
                  setDraftModel(model);
                  setDraftEffort(effort);
                }
              }}
              onChangeEffort={(effort) => {
                if (activeSession) void handleUpdateSession({ reasoning_effort: effort });
                else setDraftEffort(effort);
              }}
              onChangeExecutionTarget={(target) => {
                const nextLocalAgent = resolveActiveLocalAgent(
                  runtimeInfo,
                  project.id,
                  target,
                  currentRuntime,
                );
                const nextCatalog = resolveCatalogForTarget({
                  runtime: currentRuntime,
                  activeLocalAgent: nextLocalAgent,
                  projectCli: runtimeInfo?.project_cli,
                  includeSelectedFallback: false,
                });
                const modelStillValid =
                  !currentModel || nextCatalog.some((item) => item.id === currentModel);
                const nextModel = modelStillValid
                  ? currentModel
                  : resolveDefaultModelForTarget(
                      currentRuntime,
                      nextLocalAgent,
                      runtimeInfo?.project_cli,
                    );
                const nextEntry = nextCatalog.find((item) => item.id === nextModel);
                const nextEffort =
                  nextEntry?.supports_effort === false ||
                  (currentEffort !== "default" &&
                    nextEntry?.effort_levels &&
                    !nextEntry.effort_levels.includes(currentEffort))
                    ? "default"
                    : currentEffort;

                setDraftTarget(target);
                if (!modelStillValid) setDraftModel(nextModel);
                if (nextEffort !== currentEffort) setDraftEffort(nextEffort);

                if (activeSession) {
                  const patch: Parameters<typeof api.updateCodexChatSession>[2] = {};
                  if (target !== activeSession.execution_target) patch.execution_target = target;
                  if (!modelStillValid && nextModel !== activeSession.model) patch.model = nextModel;
                  if (nextEffort !== currentEffort) patch.reasoning_effort = nextEffort;
                  if (Object.keys(patch).length > 0) {
                    void handleUpdateSession(patch);
                  }
                }
              }}
              onChangeSandboxMode={(mode) => {
                setDraftSandboxMode(mode);
                if (activeSession && mode !== activeSession.sandbox_mode) {
                  void handleUpdateSession({ sandbox_mode: mode });
                }
              }}
              onToggleNetworkAccess={() => {
                const next = !currentNetworkAccess;
                setDraftNetworkAccess(next);
                if (activeSession && next !== activeSession.network_access) {
                  void handleUpdateSession({ network_access: next });
                }
              }}
              onOpenCliSettings={onOpenCliSettings}
              onOpenWorkspace={onOpenWorkspace}
              onNewSession={startDraft}
              onSend={(override) => void handleSend(override)}
              onAbort={() => void handleAbort()}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
