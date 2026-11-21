import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import { formatRelativeTime } from "~/lib/format.ts";
import type {
  ChatContextRef,
  ChatMessageRecord,
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
  type TraceEntry,
} from "./agent-chat/AgentPrimitives.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { Button, EmptyState, LivePulseDot, useToast } from "./ui.tsx";

interface CodexChatViewProps {
  project: ProjectDetail | null;
  tasks: TaskRecord[];
  pendingContext?: {
    ref?: ChatContextRef;
    prompt?: string;
    enableNetwork?: boolean;
  } | null;
  onConsumePendingContext?: () => void;
  onNewProject: () => void;
  onOpenWorkspace: () => void;
  onOpenCliSettings: () => void;
  onTaskCreated: (task: TaskRecord) => void;
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

interface TurnTraceState {
  startedAt: number;
  durationMs?: number;
  entries: TraceEntry[];
}

export function CodexChatView({
  project,
  tasks,
  pendingContext,
  onConsumePendingContext,
  onNewProject,
  onOpenWorkspace,
  onOpenCliSettings,
  onTaskCreated,
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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<ChatSessionRecord | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // Composer state
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatContextRef[]>([]);
  const [draftRuntime, setDraftRuntime] = useState<ChatRuntime>("codex");
  const [draftSandboxMode, setDraftSandboxMode] = useState<ChatSandboxMode>("read-only");
  const [draftNetworkAccess, setDraftNetworkAccess] = useState(false);

  // Streaming & trace state
  const [streaming, setStreaming] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const [turnTraces, setTurnTraces] = useState<Record<string, TurnTraceState>>({});
  const [convertingMsgId, setConvertingMsgId] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  // Smart scroll tracking
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const isNearBottomRef = useRef(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const abortCtrlRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const prevProjectIdRef = useRef<string | null>(projectId);
  const pendingEnableNetworkRef = useRef(false);

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
      setRuntimeInfo(rt);
      setDraftRuntime(rt.project_cli.runtime);
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
      setSessions(res.sessions);
      setActiveSessionId((curr) =>
        curr && res.sessions.some((s) => s.id === curr) ? curr : (res.sessions[0]?.id ?? null),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载对话列表失败");
    } finally {
      setSessionsLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => {
    abortCtrlRef.current?.abort();
    setStreaming(false);
    setActiveSessionId(null);
    setActiveSession(null);
    setMessages([]);
    setTurnTraces({});
    setConfirmDeleteId(null);
    if (prevProjectIdRef.current !== projectId) {
      setAttachments([]);
      setInput("");
      setSessionSearch("");
      prevProjectIdRef.current = projectId;
    }
    if (!projectId) return;
    void loadContextCatalog();
    void loadSessions();
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
    onConsumePendingContext?.();
    window.setTimeout(() => composerRef.current?.focus(), 40);
  }, [pendingContext, onConsumePendingContext]);

  useEffect(() => {
    if (!projectId || !activeSession || !pendingEnableNetworkRef.current) return;
    pendingEnableNetworkRef.current = false;
    if (activeSession.network_access) return;
    void api
      .updateCodexChatSession(projectId, activeSession.id, { network_access: true })
      .then((res) => {
        setActiveSession(res.session);
        setSessions((prev) =>
          prev.map((s) => (s.id === res.session.id ? { ...s, ...res.session } : s)),
        );
      })
      .catch(() => {
        // non-fatal
      });
  }, [projectId, activeSession]);

  useEffect(() => {
    if (!projectId || !activeSessionId) {
      setActiveSession(null);
      setMessages([]);
      return;
    }
    let active = true;
    setMessagesLoading(true);
    setConfirmDeleteId(null);
    api
      .getCodexChatSession(projectId, activeSessionId)
      .then((res) => {
        if (!active) return;
        setActiveSession(res.session);
        setMessages(res.messages);
        setTitleDraft(res.session.title);
        isNearBottomRef.current = true;
        window.setTimeout(() => scrollToBottom("auto"), 30);
      })
      .catch((err) => {
        if (active) toast.error(err instanceof Error ? err.message : "读取会话记录失败");
      })
      .finally(() => {
        if (active) setMessagesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, activeSessionId, toast, scrollToBottom]);

  // Smooth smart auto-scroll during streaming or new messages
  const lastMsg = messages[messages.length - 1];
  const scrollSignal = `${messages.length}:${lastMsg?.content.length ?? 0}:${lastMsg?.events.length ?? 0}:${statusLine}`;
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom(streaming ? "auto" : "smooth");
    }
  }, [scrollSignal, streaming, scrollToBottom]);

  const handleNewSession = useCallback(
    async (opts?: {
      runtime?: ChatRuntime;
      sandbox_mode?: ChatSandboxMode;
      network_access?: boolean;
    }) => {
      if (!projectId) return null;
      try {
        const res = await api.createCodexChatSession(projectId, opts);
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
      }
    },
    [projectId, toast],
  );

  const handleDeleteSession = async (sessionId: string) => {
    if (!projectId) return;
    try {
      await api.deleteCodexChatSession(projectId, sessionId);
      setConfirmDeleteId(null);
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== sessionId);
        if (activeSessionId === sessionId) {
          setActiveSessionId(next[0]?.id ?? null);
        }
        return next;
      });
      toast.success("已删除会话");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除会话失败");
    }
  };

  const handleUpdateSession = async (patch: {
    title?: string;
    runtime?: ChatRuntime;
    model?: string;
    sandbox_mode?: ChatSandboxMode;
    network_access?: boolean;
  }) => {
    if (!projectId || !activeSession) return;
    try {
      const res = await api.updateCodexChatSession(projectId, activeSession.id, patch);
      setActiveSession(res.session);
      setSessions((prev) => prev.map((s) => (s.id === res.session.id ? { ...s, ...res.session } : s)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新会话设置失败");
    }
  };

  const handleSend = async (promptOverride?: string, attachmentsOverride?: ChatContextRef[]) => {
    if (!projectId || streaming) return;
    const text = (promptOverride ?? input).trim();
    if (!text) return;

    let session = activeSession;
    if (!session) {
      session = await handleNewSession({
        runtime: draftRuntime,
        sandbox_mode: draftSandboxMode,
        network_access: draftNetworkAccess,
      });
      if (!session) return;
    }

    const currentAttachments = attachmentsOverride ?? [...attachments];
    if (!promptOverride) {
      setInput("");
      setAttachments([]);
    }
    isNearBottomRef.current = true;
    setStreaming(true);
    setStatusLine("正在连接项目空间与 CLI");

    const startedAt = Date.now();
    const tempUserId = `tmp-u-${startedAt}`;
    const tempAssistantId = `tmp-a-${startedAt}`;
    const now = new Date().toISOString();

    setTurnTraces((prev) => ({
      ...prev,
      [tempAssistantId]: { startedAt, entries: [] },
    }));

    setMessages((prev) => [
      ...prev,
      {
        id: tempUserId,
        session_id: session!.id,
        role: "user",
        content: text,
        events: [],
        attachments: currentAttachments,
        status: "done",
        created_at: now,
      },
      {
        id: tempAssistantId,
        session_id: session!.id,
        role: "assistant",
        content: "",
        events: [],
        attachments: [],
        status: "streaming",
        created_at: now,
      },
    ]);

    let realAssistantId = tempAssistantId;
    let traceSeq = 0;
    const controller = new AbortController();
    abortCtrlRef.current = controller;

    const appendTrace = (msgId: string, kind: "status" | "reasoning", entryText: string) => {
      const clean = entryText.trim();
      if (!clean) return;
      traceSeq += 1;
      const entryId = `tr-${startedAt}-${traceSeq}`;
      setTurnTraces((prev) => {
        const curr = prev[msgId] ?? { startedAt, entries: [] };
        const last = curr.entries[curr.entries.length - 1];
        // Merge consecutive reasoning deltas cleanly into the same reasoning block
        if (kind === "reasoning" && last && last.kind === "reasoning" && clean.length < 180) {
          const updatedLast = { ...last, text: `${last.text}${clean}` };
          return {
            ...prev,
            [msgId]: { ...curr, entries: [...curr.entries.slice(0, -1), updatedLast] },
          };
        }
        if (last && last.kind === kind && last.text === clean) return prev;
        return {
          ...prev,
          [msgId]: { ...curr, entries: [...curr.entries, { id: entryId, kind, text: clean }] },
        };
      });
    };

    try {
      await api.streamCodexChatMessage(
        projectId,
        session.id,
        { content: text, attachments: currentAttachments },
        (ev) => {
          if (ev.type === "session") {
            const oldId = realAssistantId;
            realAssistantId = ev.assistant_message_id;
            setActiveSession(ev.session);
            setTitleDraft(ev.session.title);
            setSessions((prev) =>
              prev.map((s) => (s.id === ev.session.id ? { ...s, ...ev.session } : s)),
            );
            setTurnTraces((prev) => {
              const carried = prev[oldId] ?? { startedAt, entries: [] };
              const next = { ...prev, [realAssistantId]: carried };
              if (oldId !== realAssistantId) delete next[oldId];
              return next;
            });
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id === tempUserId) return ev.user_message;
                if (m.id === tempAssistantId) return { ...m, id: realAssistantId };
                return m;
              }),
            );
          } else if (ev.type === "status") {
            setStatusLine(ev.message);
            appendTrace(realAssistantId, "status", ev.message);
          } else if (ev.type === "reasoning") {
            setStatusLine("正在深度推理");
            appendTrace(realAssistantId, "reasoning", ev.text);
          } else if (ev.type === "tool") {
            setStatusLine(`执行工具 · ${ev.event.tool}`);
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== realAssistantId) return m;
                const exists = m.events.some((e) => e.id === ev.event.id);
                const nextEvents = exists
                  ? m.events.map((e) => (e.id === ev.event.id ? ev.event : e))
                  : [...m.events, ev.event];
                return { ...m, events: nextEvents };
              }),
            );
          } else if (ev.type === "text_delta") {
            setStatusLine("正在生成回复");
            setMessages((prev) =>
              prev.map((m) =>
                m.id === realAssistantId ? { ...m, content: m.content + ev.delta } : m,
              ),
            );
          } else if (ev.type === "text_replace") {
            setMessages((prev) =>
              prev.map((m) => (m.id === realAssistantId ? { ...m, content: ev.text } : m)),
            );
          } else if (ev.type === "done") {
            setTurnTraces((prev) => {
              const curr = prev[realAssistantId];
              if (!curr) return prev;
              return {
                ...prev,
                [realAssistantId]: { ...curr, durationMs: Date.now() - curr.startedAt },
              };
            });
            setActiveSession(ev.session);
            setSessions((prev) =>
              prev.map((s) =>
                s.id === ev.session.id
                  ? {
                      ...s,
                      ...ev.session,
                      last_message_preview: ev.message.content.slice(0, 120),
                    }
                  : s,
              ),
            );
            setMessages((prev) =>
              prev.map((m) => (m.id === realAssistantId ? ev.message : m)),
            );
          } else if (ev.type === "error") {
            toast.error(ev.error);
            setTurnTraces((prev) => {
              const curr = prev[realAssistantId];
              if (!curr) return prev;
              return {
                ...prev,
                [realAssistantId]: { ...curr, durationMs: Date.now() - curr.startedAt },
              };
            });
            if (ev.message) {
              setMessages((prev) =>
                prev.map((m) => (m.id === realAssistantId ? ev.message! : m)),
              );
            } else {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === realAssistantId
                    ? { ...m, status: "error", content: m.content || `执行失败：${ev.error}` }
                    : m,
                ),
              );
            }
          }
        },
        controller.signal,
      );
      if (session.sandbox_mode === "workspace-write") {
        void loadContextCatalog();
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        const msg = err instanceof Error ? err.message : "发送失败";
        toast.error(msg);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === realAssistantId
              ? { ...m, status: "error", content: m.content || `请求失败：${msg}` }
              : m,
          ),
        );
      }
    } finally {
      abortCtrlRef.current = null;
      setStreaming(false);
      setStatusLine("");
    }
  };

  const handleAbort = async () => {
    abortCtrlRef.current?.abort();
    if (projectId && activeSession) {
      try {
        await api.abortCodexChatSession(projectId, activeSession.id);
      } catch {
        // ignore
      }
    }
    setStreaming(false);
    setStatusLine("");
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
    const filtered = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            (s.last_message_preview?.toLowerCase().includes(q) ?? false),
        )
      : sessions;

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
  }, [sessions, sessionSearch]);

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

  const currentRuntime: ChatRuntime = activeSession?.runtime ?? draftRuntime;
  const currentSandboxMode: ChatSandboxMode = activeSession?.sandbox_mode ?? draftSandboxMode;
  const currentNetworkAccess: boolean = activeSession?.network_access ?? draftNetworkAccess;
  const currentAuthMode = runtimeInfo?.auth_mode[currentRuntime] ?? "unavailable";
  const activeConfiguredModel =
    runtimeInfo?.project_cli.runtime === currentRuntime && runtimeInfo.project_cli.model
      ? runtimeInfo.project_cli.model
      : "";
  const readyReposCount = workspaceSummary
    ? workspaceSummary.repos_status.repos.filter((r) => r.ready).length
    : 0;

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden bg-[var(--surface-canvas)]">
      {/* Left Sessions Sidebar (Beautiful UI Sidebar Nav style) */}
      {sidebarOpen && (
        <aside className="w-[256px] shrink-0 border-r border-[var(--border-subtle)] bg-[var(--surface-sidebar)] flex flex-col min-h-0">
          {/* Sidebar Header */}
          <div className="px-2.5 pt-2.5 pb-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleNewSession()}
              className="flex-1 h-8 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] hover:border-[var(--border-strong)] text-[12.5px] font-medium text-[var(--text-primary)] inline-flex items-center justify-center gap-1.5 shadow-[var(--rd-shadow-sm)] transition-colors cursor-pointer"
            >
              <Icon name="plus" size={14} />
              <span>新建对话</span>
            </button>
            <button
              type="button"
              title="收起会话列表"
              aria-label="收起会话列表"
              onClick={() => setSidebarOpen(false)}
              className="h-8 w-8 rounded-lg inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
            >
              <Icon name="panel-left-close" size={15} />
            </button>
          </div>

          {/* Search Sessions */}
          {sessions.length > 0 && (
            <div className="px-2.5 pb-2">
              <div className="flex items-center gap-1.5 h-7 px-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)]/70 focus-within:border-[var(--border-strong)] focus-within:bg-[var(--surface-card)] transition-colors">
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
                    className="text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
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
            ) : sessions.length === 0 ? (
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
                    const active = s.id === activeSessionId;
                    const confirming = confirmDeleteId === s.id;
                    return (
                      <div
                        key={s.id}
                        onClick={() => {
                          if (!streaming && !confirming) setActiveSessionId(s.id);
                        }}
                        className={`group rounded-lg px-2 py-1.5 transition-colors cursor-pointer ${
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
                                className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-600 hover:text-white text-[10.5px] font-medium transition cursor-pointer"
                              >
                                删除
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-1 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              title="删除会话"
                              aria-label="删除会话"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(s.id);
                              }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-muted)] hover:text-rose-500 transition-opacity cursor-pointer shrink-0"
                            >
                              <Icon name="trash-2" size={12} />
                            </button>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-1.5 mt-0.5 pl-3 text-[10.5px] text-[var(--text-muted)]">
                          <span className="font-mono uppercase text-[10px]">
                            {s.runtime}
                            {s.runtime === "codex" && s.network_access ? " · 联网" : ""}
                          </span>
                          <span>{formatRelativeTime(s.updated_at)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Compact Engine Status Card */}
          <div className="p-2.5 border-t border-[var(--border-subtle)]">
            <button
              type="button"
              onClick={onOpenCliSettings}
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
        </aside>
      )}

      {/* Main Agent Column */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">
        {/* Clean Minimal Top Header */}
        <header className="shrink-0 h-12 px-4 border-b border-[var(--border-subtle)] bg-[var(--surface-canvas)]/90 backdrop-blur-sm flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {!sidebarOpen && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  title="展开会话列表"
                  aria-label="展开会话列表"
                  onClick={() => setSidebarOpen(true)}
                  className="h-7 w-7 rounded-lg inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
                >
                  <Icon name="panel-left-open" size={15} />
                </button>
                <button
                  type="button"
                  title="新建对话"
                  aria-label="新建对话"
                  onClick={() => void handleNewSession()}
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
          className="flex-1 overflow-y-auto rd-scroll px-4 pt-6 pb-8"
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
                  disabled={streaming || currentAuthMode === "unavailable"}
                  onSelect={(p) => void handleSend(p)}
                />
              </div>
            ) : (
              <div className="space-y-7">
                {messages.map((msg, idx) => {
                  const isUser = msg.role === "user";
                  const isLastMessage = idx === messages.length - 1;
                  const isStreamingMsg = msg.status === "streaming";
                  const trace = turnTraces[msg.id];
                  const prevUserMsg =
                    !isUser && idx > 0 && messages[idx - 1]?.role === "user"
                      ? messages[idx - 1]
                      : null;

                  if (isUser) {
                    return (
                      <div key={msg.id} className="flex justify-end animate-fade-up">
                        <div className="max-w-[82%] space-y-1.5 flex flex-col items-end">
                          {msg.attachments.length > 0 && (
                            <div className="flex flex-wrap justify-end gap-1.5">
                              {msg.attachments.map((att) => (
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
                          <div className="rounded-2xl rounded-br-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-4 py-2.5 text-[13.5px] leading-[1.6] text-[var(--text-primary)] whitespace-pre-wrap break-words shadow-[var(--rd-shadow-sm)]">
                            {msg.content}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // Editorial Borderless Assistant Turn
                  const followUps =
                    isLastMessage &&
                    !streaming &&
                    msg.status === "done" &&
                    msg.content &&
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
                          {currentRuntime === "codex" ? "Codex" : "Claude"}
                        </span>
                        {activeConfiguredModel && (
                          <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
                            {activeConfiguredModel}
                          </span>
                        )}
                        {!isStreamingMsg && (
                          <span className="text-[11px] text-[var(--text-muted)] ml-auto">
                            {msg.status === "aborted"
                              ? "已中止"
                              : msg.status === "error"
                                ? "执行异常"
                                : formatRelativeTime(msg.created_at)}
                          </span>
                        )}
                      </div>

                      {/* Thinking / Live Loading Trace */}
                      <ThinkingTrace
                        active={isStreamingMsg && (!msg.content || msg.events.some((e) => e.status === "running"))}
                        statusLabel={statusLine || "正在思考"}
                        entries={trace?.entries ?? []}
                        startedAt={trace?.startedAt}
                        durationMs={trace?.durationMs}
                      />

                      {/* Compact Tool Chips */}
                      <ToolChipsGroup events={msg.events} isStreaming={isStreamingMsg} />

                      {/* Streamed Markdown Prose */}
                      {msg.content && (
                        <div
                          className={
                            msg.status === "error"
                              ? "rounded-xl border border-rose-500/25 bg-rose-500/6 px-3.5 py-2.5 text-[13px] text-rose-700 dark:text-rose-300"
                              : "text-[14px] leading-[1.7] text-[var(--text-primary)]"
                          }
                        >
                          <MarkdownContent content={msg.content} />
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
                              disabled={streaming || currentAuthMode === "unavailable"}
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
                          disabled={streaming || currentAuthMode === "unavailable"}
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
          <div className="pointer-events-none absolute inset-x-0 bottom-[132px] flex justify-center z-20 animate-fade-in">
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
        <div className="shrink-0 px-4 pt-2 pb-4 bg-gradient-to-t from-[var(--surface-canvas)] via-[var(--surface-canvas)]/95 to-transparent">
          <div className="max-w-[740px] mx-auto">
            <PromptBar
              input={input}
              onInputChange={setInput}
              attachments={attachments}
              onToggleAttachment={toggleAttachment}
              workspaceFiles={workspaceFiles}
              workspaceDatabases={workspaceDatabases}
              openTasks={openTasks}
              runtime={currentRuntime}
              runtimeInfo={runtimeInfo}
              sandboxMode={currentSandboxMode}
              networkAccess={currentNetworkAccess}
              streaming={streaming}
              statusLine={statusLine}
              authUnavailable={currentAuthMode === "unavailable"}
              textareaRef={composerRef}
              onChangeRuntime={(rt) => {
                setDraftRuntime(rt);
                if (activeSession && rt !== activeSession.runtime) {
                  void handleUpdateSession({ runtime: rt });
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
              onNewSession={() => void handleNewSession()}
              onSend={(override) => void handleSend(override)}
              onAbort={() => void handleAbort()}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
