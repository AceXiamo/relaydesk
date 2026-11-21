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
  ChatToolEvent,
  ProjectDetail,
  TaskRecord,
  WorkspaceDatabaseEntry,
  WorkspaceFileEntry,
  WorkspaceSummary,
} from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { Select } from "./Select.tsx";
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

const STARTER_PROMPTS = [
  {
    icon: "folder-open",
    title: "盘点项目空间资料",
    prompt: "请先查看当前项目空间 files/ 目录、HANDBOOK.md 以及已同步的仓库，给我一份精简的项目上下文总览。",
  },
  {
    icon: "database",
    title: "分析 SQLite 数据表",
    prompt: "请检查项目空间里的 SQLite 数据库，列出每张表的结构、行数和核心数据分布。",
  },
  {
    icon: "code-2",
    title: "结合代码定位问题",
    prompt: "请浏览 repos/ 下已同步的绑定仓库结构，指出核心入口模块以及常见风险点。",
  },
  {
    icon: "book-open",
    title: "起草/优化项目手册",
    prompt: "请结合现有项目文件和代码仓库，帮我整理一份结构清晰的 HANDBOOK.md 草案（包含目录结构、验证命令与排查约定）。",
  },
];

function ToolTimeline({ events }: { events: ChatToolEvent[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (!events.length) return null;
  return (
    <div className="mb-3 space-y-1.5">
      {events.map((ev) => {
        const expanded = expandedId === ev.id;
        return (
          <div
            key={ev.id}
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] overflow-hidden text-[12px]"
          >
            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : ev.id)}
              className="w-full px-3 py-1.5 flex items-center justify-between gap-2 text-left hover:bg-[var(--surface-hover)] cursor-pointer"
            >
              <span className="flex items-center gap-2 min-w-0">
                {ev.status === "running" ? (
                  <Icon name="loader-2" size={13} className="animate-spin text-indigo-500" />
                ) : ev.status === "error" ? (
                  <Icon name="x-circle" size={13} className="text-rose-500" />
                ) : (
                  <Icon name="check-circle-2" size={13} className="text-emerald-500" />
                )}
                <span className="text-[11px] font-mono uppercase px-1.5 py-0.2 rounded bg-[var(--surface-card)] text-[var(--text-muted)] shrink-0">
                  {ev.tool}
                </span>
                <span className="font-mono text-[12px] text-[var(--text-secondary)] truncate">
                  {ev.summary}
                </span>
              </span>
              {ev.output && (
                <Icon
                  name={expanded ? "chevron-down" : "chevron-right"}
                  size={13}
                  className="text-[var(--text-muted)] shrink-0"
                />
              )}
            </button>
            {expanded && ev.output && (
              <pre className="px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--surface-card)] font-mono text-[11.5px] leading-relaxed text-[var(--text-secondary)] overflow-x-auto max-h-56 whitespace-pre-wrap">
                {ev.output}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"files" | "databases" | "tasks">("files");
  const [draftRuntime, setDraftRuntime] = useState<ChatRuntime>("codex");
  const [draftSandboxMode, setDraftSandboxMode] = useState<ChatSandboxMode>("read-only");
  const [draftNetworkAccess, setDraftNetworkAccess] = useState(false);

  // Streaming state
  const [streaming, setStreaming] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const [reasoningLine, setReasoningLine] = useState("");
  const [convertingMsgId, setConvertingMsgId] = useState<string | null>(null);

  const abortCtrlRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const prevProjectIdRef = useRef<string | null>(projectId);
  const pendingEnableNetworkRef = useRef(false);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pickerOpen]);

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
    if (prevProjectIdRef.current !== projectId) {
      setAttachments([]);
      setInput("");
      prevProjectIdRef.current = projectId;
    }
    if (!projectId) return;
    void loadContextCatalog();
    void loadSessions();
  }, [projectId, loadContextCatalog, loadSessions]);

  // Consume context handed over from Project Space ("在 Codex 中讨论此文件" / "在 Codex 中连库排查")
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
    api
      .getCodexChatSession(projectId, activeSessionId)
      .then((res) => {
        if (!active) return;
        setActiveSession(res.session);
        setMessages(res.messages);
        setTitleDraft(res.session.title);
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
  }, [projectId, activeSessionId, toast]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streaming, statusLine]);

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
    if (!window.confirm("确定删除该对话会话及所有消息吗？")) return;
    try {
      await api.deleteCodexChatSession(projectId, sessionId);
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

  const handleSend = async (promptOverride?: string) => {
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

    const currentAttachments = [...attachments];
    if (!promptOverride) {
      setInput("");
      setAttachments([]);
    }
    setStreaming(true);
    setStatusLine("正在连接项目空间与 CLI…");
    setReasoningLine("");

    const tempUserId = `tmp-u-${Date.now()}`;
    const tempAssistantId = `tmp-a-${Date.now()}`;
    const now = new Date().toISOString();

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
    const controller = new AbortController();
    abortCtrlRef.current = controller;

    try {
      await api.streamCodexChatMessage(
        projectId,
        session.id,
        { content: text, attachments: currentAttachments },
        (ev) => {
          if (ev.type === "session") {
            realAssistantId = ev.assistant_message_id;
            setActiveSession(ev.session);
            setTitleDraft(ev.session.title);
            setSessions((prev) =>
              prev.map((s) => (s.id === ev.session.id ? { ...s, ...ev.session } : s)),
            );
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id === tempUserId) return ev.user_message;
                if (m.id === tempAssistantId) return { ...m, id: realAssistantId };
                return m;
              }),
            );
          } else if (ev.type === "status") {
            setStatusLine(ev.message);
          } else if (ev.type === "reasoning") {
            setReasoningLine(ev.text);
          } else if (ev.type === "tool") {
            setStatusLine(`执行工具：${ev.event.summary}`);
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
            setReasoningLine("");
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
      // Refresh workspace file count in case Codex wrote files in workspace-write mode.
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
      setReasoningLine("");
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
    setReasoningLine("");
  };

  const handleConvertToTask = async (msg: ChatMessageRecord) => {
    if (!projectId || convertingMsgId) return;
    setConvertingMsgId(msg.id);
    try {
      const firstLine = msg.content
        .split(/\r?\n/)
        .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
        .find(Boolean);
      const title = (firstLine || activeSession?.title || "Codex 对话转工单").slice(0, 80);
      const res = await api.createTask(projectId, {
        title,
        body: `来自 Codex 网页对话「${activeSession?.title ?? "未命名"}」：\n\n${msg.content}`,
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

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <EmptyState
          icon="sparkles"
          title="尚未选择项目"
          description="创建或选择一个项目后，即可在网页端直接与 Codex / Claude 对话。"
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

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden bg-[var(--surface-canvas)]">
      {/* Left Sessions Sidebar */}
      {sidebarOpen && (
        <aside className="w-[264px] shrink-0 border-r border-[var(--border-subtle)] bg-[var(--surface-card)] flex flex-col min-h-0">
          <div className="p-3 border-b border-[var(--border-subtle)] flex items-center gap-1.5">
            <Button
              variant="primary"
              size="sm"
              icon="plus"
              className="flex-1"
              onClick={() => void handleNewSession()}
            >
              新建对话
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon="panel-left-close"
              title="收起会话列表"
              onClick={() => setSidebarOpen(false)}
            />
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sessionsLoading ? (
              <div className="p-5 text-center text-[12px] text-[var(--text-muted)]">加载会话…</div>
            ) : sessions.length === 0 ? (
              <div className="p-5 text-center text-[12px] text-[var(--text-muted)] leading-relaxed">
                暂无历史会话，点击上方「新建对话」或在右侧直接输入即可开始。
              </div>
            ) : (
              sessions.map((s) => {
                const active = s.id === activeSessionId;
                return (
                  <div
                    key={s.id}
                    onClick={() => {
                      if (!streaming) setActiveSessionId(s.id);
                    }}
                    className={`group rounded-xl px-2.5 py-2 transition-colors cursor-pointer ${
                      active
                        ? "bg-indigo-500/12 text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-[12.5px] font-medium truncate">{s.title}</span>
                      <button
                        type="button"
                        title="删除会话"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteSession(s.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-muted)] hover:text-rose-500 cursor-pointer"
                      >
                        <Icon name="trash-2" size={12} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-1.5 mt-1 text-[10.5px] text-[var(--text-muted)]">
                      <span className="inline-flex items-center gap-1 font-mono uppercase">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            s.runtime === "codex" ? "bg-emerald-500" : "bg-amber-500"
                          }`}
                        />
                        {s.runtime}
                        {s.runtime === "codex" && s.network_access && (
                          <span title="已允许联网">
                            <Icon name="wifi" size={10} className="text-emerald-500 ml-0.5" />
                          </span>
                        )}
                      </span>
                      <span>{formatRelativeTime(s.updated_at)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Local CLI Status Footer */}
          <div className="p-3 border-t border-[var(--border-subtle)] bg-[var(--surface-subtle)] space-y-2 text-[11.5px]">
            <div className="flex items-center justify-between">
              <span className="font-medium text-[var(--text-secondary)]">本机 CLI 引擎</span>
              <button
                type="button"
                onClick={onOpenCliSettings}
                className="text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
              >
                CLI 设置
              </button>
            </div>
            <div className="space-y-1">
              {(["codex", "claude"] as const).map((rt) => {
                const mode = runtimeInfo?.auth_mode[rt] ?? "unavailable";
                return (
                  <div key={rt} className="flex items-center justify-between text-[11px]">
                    <span className="font-mono text-[var(--text-secondary)]">
                      {rt === "codex" ? "Codex CLI" : "Claude Code"}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 ${
                        mode === "unavailable"
                          ? "text-[var(--text-muted)]"
                          : "text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      <LivePulseDot
                        tone={mode === "unavailable" ? "zinc" : "emerald"}
                        active={mode !== "unavailable"}
                      />
                      {mode === "project_key"
                        ? "项目密钥"
                        : mode === "local_cli"
                          ? "本机登录态"
                          : "未检测到"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      )}

      {/* Main Chat Column */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Top Toolbar */}
        <header className="shrink-0 px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--surface-card)] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {!sidebarOpen && (
              <Button
                variant="ghost"
                size="xs"
                icon="panel-left-open"
                title="展开会话列表"
                onClick={() => setSidebarOpen(true)}
              />
            )}
            <div className="w-7 h-7 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
              <Icon name="sparkles" size={15} />
            </div>
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
                className="text-[14px] font-semibold text-[var(--text-primary)] truncate hover:text-indigo-600 dark:hover:text-indigo-400 transition cursor-pointer"
                title={activeSession ? "点击重命名会话" : undefined}
              >
                {activeSession ? activeSession.title : `Codex 工作台 · ${project.name}`}
              </button>
            )}
            {activeSession?.external_session_id && (
              <span
                title={`已绑定连续线程：${activeSession.external_session_id}`}
                className="hidden sm:inline-flex items-center gap-1 text-[10.5px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              >
                <Icon name="link-2" size={10} />
                多轮连续
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="w-[132px]">
              <Select<ChatRuntime>
                ariaLabel="选择对话运行工具"
                fullWidth
                disabled={streaming}
                value={currentRuntime}
                options={[
                  { value: "codex", label: "Codex CLI" },
                  { value: "claude", label: "Claude Code" },
                ]}
                onChange={(rt) => {
                  setDraftRuntime(rt);
                  if (activeSession && rt !== activeSession.runtime) {
                    void handleUpdateSession({ runtime: rt });
                  }
                }}
              />
            </div>
            <div className="w-[144px]">
              <Select<ChatSandboxMode>
                ariaLabel="选择沙箱权限"
                fullWidth
                disabled={streaming}
                value={currentSandboxMode}
                options={[
                  { value: "read-only", label: "只读探索" },
                  { value: "workspace-write", label: "可写项目空间" },
                ]}
                onChange={(mode) => {
                  setDraftSandboxMode(mode);
                  if (activeSession && mode !== activeSession.sandbox_mode) {
                    void handleUpdateSession({ sandbox_mode: mode });
                  }
                }}
              />
            </div>
            {currentRuntime === "codex" ? (
              <button
                type="button"
                disabled={streaming}
                onClick={() => {
                  const next = !currentNetworkAccess;
                  setDraftNetworkAccess(next);
                  if (activeSession && next !== activeSession.network_access) {
                    void handleUpdateSession({ network_access: next });
                  }
                }}
                title={
                  currentNetworkAccess
                    ? "已为当前 Codex 会话放开沙箱联网（透传 sandbox_workspace_write.network_access=true），可直连外部数据库或网络；点击关闭"
                    : "Codex 沙箱默认断网；点击开启以允许连接外部数据源（PG/MySQL/Redis 等）或访问网络"
                }
                className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium border transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  currentNetworkAccess
                    ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/18"
                    : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]"
                }`}
              >
                <Icon name={currentNetworkAccess ? "wifi" : "wifi-off"} size={13} />
                <span>{currentNetworkAccess ? "允许联网" : "沙箱断网"}</span>
              </button>
            ) : (
              <span
                title="Claude Code 运行时直接复用宿主机网络环境，可直接连接已配置的外部数据源"
                className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11.5px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-muted)]"
              >
                <Icon name="wifi" size={12} className="text-emerald-500" />
                宿主机网络
              </span>
            )}
            <Button size="xs" variant="secondary" icon="folder-open" onClick={onOpenWorkspace}>
              项目空间
            </Button>
          </div>
        </header>

        {/* Messages Thread */}
        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="max-w-3xl mx-auto space-y-5">
            {messagesLoading ? (
              <div className="py-16 text-center text-[13px] text-[var(--text-muted)] flex items-center justify-center gap-2">
                <Icon name="loader-2" size={15} className="animate-spin text-indigo-500" />
                正在加载会话消息…
              </div>
            ) : messages.length === 0 ? (
              <div className="py-8 space-y-6">
                <div className="text-center space-y-2">
                  <div className="w-12 h-12 rounded-2xl bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mx-auto">
                    <Icon name="sparkles" size={24} />
                  </div>
                  <h2 className="text-[17px] font-semibold text-[var(--text-primary)]">
                    与 {currentRuntime === "codex" ? "Codex" : "Claude"} 直接协作 · {project.name}
                  </h2>
                  <p className="text-[13px] text-[var(--text-muted)] max-w-lg mx-auto leading-relaxed">
                    对话工作区已自动挂载当前项目空间的文件、SQLite 数据库、项目手册与已同步仓库。支持实时工具调用流式展示、多轮续聊与一键转工单。
                  </p>
                </div>

                {/* Mounted Space Pills */}
                {workspaceSummary && (
                  <div className="flex flex-wrap items-center justify-center gap-2 text-[12px]">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-secondary)]">
                      <Icon name="folder-open" size={13} className="text-indigo-500" />
                      {workspaceSummary.files_count} 个空间文件
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-secondary)]">
                      <Icon name="database" size={13} className="text-emerald-500" />
                      {workspaceSummary.databases_count} 个数据库
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-secondary)]">
                      <Icon name="book-open" size={13} className="text-amber-500" />
                      手册{workspaceSummary.handbook_exists ? "已挂载" : "未填写"}
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-secondary)]">
                      <Icon name="folder-git-2" size={13} className="text-indigo-500" />
                      {workspaceSummary.repos_status.repos.filter((r) => r.ready).length} 个已同步仓库
                    </span>
                  </div>
                )}

                {currentAuthMode === "unavailable" && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-[12.5px] text-amber-700 dark:text-amber-300 flex items-center justify-between gap-3">
                    <span>
                      当前服务器未检测到本机 <code className="font-mono">{currentRuntime}</code> 可执行文件，请安装对应 CLI 或切换运行工具。
                    </span>
                    <Button size="xs" variant="secondary" onClick={onOpenCliSettings}>
                      查看设置
                    </Button>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {STARTER_PROMPTS.map((item) => (
                    <button
                      key={item.title}
                      type="button"
                      disabled={streaming || currentAuthMode === "unavailable"}
                      onClick={() => void handleSend(item.prompt)}
                      className="text-left p-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:border-indigo-500/50 hover:bg-[var(--surface-hover)] transition space-y-1 cursor-pointer disabled:opacity-50"
                    >
                      <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                        <Icon name={item.icon} size={14} className="text-indigo-500" />
                        {item.title}
                      </div>
                      <p className="text-[12px] text-[var(--text-muted)] line-clamp-2 leading-relaxed">
                        {item.prompt}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg) => {
                const isUser = msg.role === "user";
                return (
                  <div
                    key={msg.id}
                    className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}
                  >
                    {!isUser && (
                      <div className="w-7 h-7 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0 mt-0.5">
                        <Icon name="bot" size={15} />
                      </div>
                    )}
                    <div
                      className={`min-w-0 ${
                        isUser
                          ? "max-w-[82%] rounded-2xl rounded-tr-sm bg-indigo-600 text-white px-4 py-2.5 shadow-2xs"
                          : "flex-1 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3.5 shadow-2xs"
                      }`}
                    >
                      {isUser ? (
                        <div className="space-y-2">
                          {msg.attachments.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {msg.attachments.map((att) => (
                                <span
                                  key={`${att.kind}:${att.ref}`}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/15 text-[11px] font-mono"
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
                                  />
                                  {att.label}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap break-words">
                            {msg.content}
                          </div>
                        </div>
                      ) : (
                        <div>
                          <ToolTimeline events={msg.events} />
                          {msg.content ? (
                            <MarkdownContent content={msg.content} />
                          ) : msg.status === "streaming" ? (
                            <div className="flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
                              <Icon name="loader-2" size={14} className="animate-spin text-indigo-500" />
                              <span>{statusLine || "正在生成回复…"}</span>
                            </div>
                          ) : null}

                          {msg.status === "streaming" && reasoningLine && (
                            <div className="mt-2 px-2.5 py-1.5 rounded-lg bg-[var(--surface-subtle)] text-[11.5px] text-[var(--text-muted)] italic">
                              {reasoningLine}
                            </div>
                          )}

                          {msg.status !== "streaming" && msg.content && (
                            <div className="mt-3 pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2 text-[11.5px] text-[var(--text-muted)]">
                              <span>
                                {msg.status === "aborted"
                                  ? "已中止"
                                  : msg.status === "error"
                                    ? "执行异常"
                                    : formatRelativeTime(msg.created_at)}
                              </span>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(msg.content);
                                    toast.success("已复制回答内容");
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] cursor-pointer"
                                >
                                  <Icon name="copy" size={12} />
                                  复制
                                </button>
                                <button
                                  type="button"
                                  disabled={convertingMsgId === msg.id}
                                  onClick={() => void handleConvertToTask(msg)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-indigo-500/10 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer"
                                >
                                  <Icon
                                    name={convertingMsgId === msg.id ? "loader-2" : "plus"}
                                    size={12}
                                    className={convertingMsgId === msg.id ? "animate-spin" : ""}
                                  />
                                  转为工单
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
          <div className="max-w-3xl mx-auto space-y-2">
            {/* Attached Context Chips */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {attachments.map((att) => (
                  <span
                    key={`${att.kind}:${att.ref}`}
                    className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-lg border border-indigo-500/30 bg-indigo-500/8 text-[11.5px] font-mono text-indigo-600 dark:text-indigo-300"
                  >
                    <Icon
                      name={
                        att.kind === "database"
                          ? "database"
                          : att.kind === "task"
                            ? "inbox"
                            : "file-text"
                      }
                      size={12}
                    />
                    <span className="max-w-[200px] truncate">{att.label}</span>
                    <button
                      type="button"
                      onClick={() => toggleAttachment(att)}
                      className="p-0.5 rounded hover:bg-indigo-500/15 cursor-pointer"
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="relative rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/15 transition">
              <textarea
                ref={composerRef}
                rows={2}
                value={input}
                disabled={streaming}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={`向 ${currentRuntime === "codex" ? "Codex" : "Claude"} 提问，或引用项目空间文件 / 数据库 / 任务…（Enter 发送，Shift+Enter 换行）`}
                className="w-full px-3.5 pt-3 pb-2 bg-transparent text-[13.5px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-none focus:outline-none max-h-44"
              />

              <div className="px-2.5 pb-2 flex items-center justify-between gap-2">
                <div className="relative flex items-center gap-1.5" ref={pickerRef}>
                  <button
                    type="button"
                    disabled={streaming}
                    onClick={() => setPickerOpen((v) => !v)}
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
                  >
                    <Icon name="at-sign" size={13} />
                    引用上下文
                  </button>

                  {pickerOpen && (
                    <div className="absolute left-0 bottom-9 z-30 w-[340px] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-lg overflow-hidden">
                      <div className="flex border-b border-[var(--border-subtle)] text-[12px]">
                        {(
                          [
                            { id: "files", label: `文件 (${workspaceFiles.length})` },
                            { id: "databases", label: `数据库 (${workspaceDatabases.length})` },
                            { id: "tasks", label: `工单 (${openTasks.length})` },
                          ] as const
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setPickerTab(t.id)}
                            className={`flex-1 py-2 font-medium transition cursor-pointer ${
                              pickerTab === t.id
                                ? "text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500"
                                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                            }`}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      <div className="max-h-56 overflow-y-auto p-1.5 space-y-0.5">
                        {pickerTab === "files" &&
                          (workspaceFiles.length === 0 ? (
                            <div className="p-4 text-center text-[12px] text-[var(--text-muted)]">
                              项目空间暂无文件
                            </div>
                          ) : (
                            workspaceFiles.map((f) => {
                              const ref: ChatContextRef = {
                                kind: "file",
                                label: f.path,
                                ref: f.path,
                              };
                              const checked = attachments.some(
                                (a) => a.kind === "file" && a.ref === f.path,
                              );
                              return (
                                <button
                                  key={f.path}
                                  type="button"
                                  onClick={() => toggleAttachment(ref)}
                                  className="w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 text-left text-[12px] hover:bg-[var(--surface-hover)] cursor-pointer"
                                >
                                  <span className="font-mono truncate text-[var(--text-primary)]">
                                    {f.path}
                                  </span>
                                  {checked && (
                                    <Icon name="check" size={13} className="text-indigo-500 shrink-0" />
                                  )}
                                </button>
                              );
                            })
                          ))}

                        {pickerTab === "databases" &&
                          (workspaceDatabases.length === 0 ? (
                            <div className="p-4 text-center text-[12px] text-[var(--text-muted)]">
                              暂无项目数据库
                            </div>
                          ) : (
                            workspaceDatabases.map((db) => {
                              const refPath = db.file_path
                                ? `files/${db.file_path}`
                                : db.env_var
                                  ? `$${db.env_var}`
                                  : db.host_preview || db.name;
                              const ref: ChatContextRef = {
                                kind: "database",
                                label: db.name,
                                ref: refPath,
                              };
                              const checked = attachments.some(
                                (a) => a.kind === "database" && a.ref === refPath,
                              );
                              return (
                                <button
                                  key={db.id}
                                  type="button"
                                  onClick={() => toggleAttachment(ref)}
                                  className="w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 text-left text-[12px] hover:bg-[var(--surface-hover)] cursor-pointer"
                                >
                                  <span className="min-w-0 truncate text-[var(--text-primary)]">
                                    {db.name}{" "}
                                    <span className="text-[11px] font-mono text-[var(--text-muted)]">
                                      ({db.kind}
                                      {db.source === "external" && db.env_var
                                        ? ` · $${db.env_var}`
                                        : ""}
                                      )
                                    </span>
                                  </span>
                                  {checked && (
                                    <Icon name="check" size={13} className="text-indigo-500 shrink-0" />
                                  )}
                                </button>
                              );
                            })
                          ))}

                        {pickerTab === "tasks" &&
                          (openTasks.length === 0 ? (
                            <div className="p-4 text-center text-[12px] text-[var(--text-muted)]">
                              暂无进行中的工单
                            </div>
                          ) : (
                            openTasks.map((t) => {
                              const ref: ChatContextRef = {
                                kind: "task",
                                label: `RD-${t.number} ${t.title}`,
                                ref: t.id,
                              };
                              const checked = attachments.some(
                                (a) => a.kind === "task" && a.ref === t.id,
                              );
                              return (
                                <button
                                  key={t.id}
                                  type="button"
                                  onClick={() => toggleAttachment(ref)}
                                  className="w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 text-left text-[12px] hover:bg-[var(--surface-hover)] cursor-pointer"
                                >
                                  <span className="truncate text-[var(--text-primary)]">
                                    <span className="font-mono text-[var(--text-muted)] mr-1">
                                      RD-{t.number}
                                    </span>
                                    {t.title}
                                  </span>
                                  {checked && (
                                    <Icon name="check" size={13} className="text-indigo-500 shrink-0" />
                                  )}
                                </button>
                              );
                            })
                          ))}
                      </div>
                    </div>
                  )}

                  {streaming && statusLine && (
                    <span className="text-[11.5px] text-[var(--text-muted)] truncate max-w-[320px]">
                      {statusLine}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {streaming ? (
                    <Button
                      size="xs"
                      variant="danger"
                      icon="square"
                      onClick={() => void handleAbort()}
                    >
                      停止生成
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      variant="primary"
                      icon="send"
                      disabled={!input.trim() || currentAuthMode === "unavailable"}
                      onClick={() => void handleSend()}
                    >
                      发送
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
