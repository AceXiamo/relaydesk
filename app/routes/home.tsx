import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MetaFunction } from "react-router";
import { ProjectChatStreams } from "~/lib/chat-streams.ts";
import { AgentExecutionView } from "~/components/AgentExecutionView.tsx";
import { CodexChatView } from "~/components/CodexChatView.tsx";
import { Icon } from "~/components/Icon.tsx";
import {
  CommandPaletteModal,
  CreateFeedbackModal,
  CreateProjectModal,
} from "~/components/ProjectModals.tsx";
import {
  ProjectWorkspaceView,
  type WorkspaceTab,
} from "~/components/ProjectWorkspaceView.tsx";
import { ReleasesView } from "~/components/ReleasesView.tsx";
import { SettingsView, type SettingsTab } from "~/components/SettingsView.tsx";
import { Sidebar } from "~/components/Sidebar.tsx";
import { TaskDetailDrawer } from "~/components/TaskDetailDrawer.tsx";
import {
  TaskQueueView,
  filterTasksForView,
  type CockpitFilter,
  type SortMode,
} from "~/components/TaskQueueView.tsx";
import { Button, ToastProvider, useToast } from "~/components/ui.tsx";
import { api } from "~/lib/api.ts";
import { releaseCode } from "~/lib/format.ts";
import type {
  AuthStatusPayload,
  ChatContextRef,
  ChatSandboxMode,
  GithubConnectionSummary,
  ProjectDetail,
  ProjectExecutionRoutingResponse,
  ProjectSummary,
  TaskDetailPayload,
  TaskRecord,
  TaskSource,
  TaskStatus,
  WorkspaceView,
} from "~/lib/types.ts";

export const meta: MetaFunction = () => [
  { title: "Relaydesk · 反馈与 Agent 队列工作台" },
  {
    name: "description",
    content: "集中整理应用与群聊反馈，高效派发给开发者与本机 Coding Agent。",
  },
];

const VALID_VIEWS = new Set<WorkspaceView>([
  "queue",
  "triage",
  "mine",
  "agents",
  "review",
  "releases",
  "workspace",
  "chat",
  "sources",
  "settings",
]);

const MOBILE_VIEW_LABELS: Record<WorkspaceView, string> = {
  queue: "全部任务",
  triage: "待整理",
  mine: "我的任务",
  agents: "Agent 执行",
  review: "待验收",
  releases: "生产发布",
  workspace: "项目空间",
  chat: "Codex 对话",
  sources: "收集入口",
  settings: "设置",
};

function readInitialView(): WorkspaceView {
  if (typeof window === "undefined") return "queue";
  const hash = window.location.hash.replace(/^#/, "") as WorkspaceView;
  return VALID_VIEWS.has(hash) ? hash : "queue";
}

function ConsoleWorkspace() {
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectDetail | null>(null);
  const [chatProjects] = useState(() => new Map<string, ProjectChatStreams>());
  const chatStreams = useMemo(() => {
    const id = currentProject?.id ?? "";
    let streams = chatProjects.get(id);
    if (!streams) {
      streams = new ProjectChatStreams(api);
      chatProjects.set(id, streams);
    }
    return streams;
  }, [chatProjects, currentProject?.id]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [view, setView] = useState<WorkspaceView>("queue");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("project");
  const [githubConnections, setGithubConnections] = useState<GithubConnectionSummary[]>([]);
  const githubConfigured = githubConnections.length > 0;
  const [authStatus, setAuthStatus] = useState<AuthStatusPayload | null>(null);
  const [online, setOnline] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [deployBusy, setDeployBusy] = useState(false);
  const [pendingWorkspaceTab, setPendingWorkspaceTab] = useState<WorkspaceTab | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "">("");
  const [sourceFilter, setSourceFilter] = useState<TaskSource | "">("");
  const [cockpitFilter, setCockpitFilter] = useState<CockpitFilter>("");
  const [sortMode, setSortMode] = useState<SortMode>("updated");

  // Detail Drawer & Stack
  const [detail, setDetail] = useState<TaskDetailPayload | null>(null);
  const [executionRouting, setExecutionRouting] = useState<ProjectExecutionRoutingResponse>();
  const routingProject = view === "agents" || detail ? currentProject?.id : undefined;
  useEffect(() => {
    setExecutionRouting(undefined);
    if (!routingProject) return;
    let active = true;
    const load = async () => {
      try {
        const routing = await api.getProjectExecutionRouting(routingProject);
        if (active) setExecutionRouting(routing);
      } catch { if (active) setExecutionRouting(undefined); }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 20000);
    return () => { active = false; window.clearInterval(timer); };
  }, [routingProject]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailStack, setDetailStack] = useState<string[]>([]);

  // Modals & UI chrome
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dark, setDark] = useState(false);
  const [pendingChatContext, setPendingChatContext] = useState<{
    ref?: ChatContextRef;
    prompt?: string;
    enableNetwork?: boolean;
    sandboxMode?: ChatSandboxMode;
    sessionId?: string;
  } | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const projectIdRef = useRef<string | null>(null);
  projectIdRef.current = currentProject?.id ?? null;

  useEffect(() => {
    setView(readInitialView());
    setDark(document.documentElement.classList.contains("dark"));
    try {
      setSidebarCollapsed(localStorage.getItem("relaydesk.sidebar_collapsed") === "1");
    } catch {
      // ignore storage errors
    }
    const onHash = () => setView(readInitialView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("relaydesk.sidebar_collapsed", next ? "1" : "0");
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const changeView = useCallback((next: WorkspaceView) => {
    setView(next);
    if (next !== "queue") {
      setCockpitFilter("");
    }
    if (typeof window !== "undefined") {
      const targetHash = next === "queue" ? "" : `#${next}`;
      if (window.location.hash !== targetHash) {
        window.history.replaceState(null, "", targetHash || window.location.pathname);
      }
    }
  }, []);

  const openSkillSetup = useCallback(() => {
    setSettingsTab("project");
    changeView("settings");
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        document
          .getElementById("relaydesk-skill-setup")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 60);
    }
  }, [changeView]);

  const openCliSettings = useCallback(() => {
    setSettingsTab("project");
    changeView("settings");
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        document
          .getElementById("relaydesk-project-cli")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 60);
    }
  }, [changeView]);

  const openRoutingSettings = useCallback(() => {
    setSettingsTab("project");
    changeView("settings");
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        document
          .getElementById("relaydesk-project-routing")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 60);
    }
  }, [changeView]);

  const openGlobalSettings = useCallback(() => {
    setSettingsTab("global");
    changeView("settings");
  }, [changeView]);

  const openDeploySettings = useCallback(() => {
    setSettingsTab("project");
    changeView("settings");
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        document
          .getElementById("relaydesk-deploy-policy")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 60);
    }
  }, [changeView]);

  const openEditDeployDoc = useCallback(() => {
    setPendingWorkspaceTab("deploy");
    changeView("workspace");
  }, [changeView]);

  const openReleaseSession = useCallback(
    (sessionId: string) => {
      setPendingChatContext({ sessionId });
      changeView("chat");
    },
    [changeView],
  );

  const toggleTheme = useCallback(() => {
    setDark((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("dark", next);
      try {
        localStorage.setItem("relaydesk.theme", next ? "dark" : "light");
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const loadProject = useCallback(async (projectId: string) => {
    const [{ project }, { tasks: nextTasks }] = await Promise.all([
      api.getProject(projectId),
      api.listTasks(projectId),
    ]);
    setCurrentProject(project);
    setProjects((prev) =>
      prev.map((p) =>
        p.id === project.id
          ? {
              ...p,
              name: project.name,
              repo: project.repo,
              repos: project.repos,
              automation_paused: project.automation_paused,
              delivery_mode: project.delivery_mode,
            }
          : p,
      ),
    );
    setTasks(nextTasks);
    try {
      localStorage.setItem("relaydesk.project", project.id);
    } catch {
      // ignore
    }
  }, []);

  const boot = useCallback(
    async (preferredProjectId?: string) => {
      setBootError(null);
      try {
        const [auth, projRes, ghRes] = await Promise.all([
          api.getAuthStatus(),
          api.listProjects(),
          api
            .getGithubStatus()
            .catch(() => ({ configured: false, connections: [] as GithubConnectionSummary[] })),
        ]);
        setAuthStatus(auth);
        setProjects(projRes.projects);
        setGithubConnections(ghRes.connections ?? []);
        setOnline(true);

        const savedId =
          preferredProjectId ||
          (typeof window !== "undefined"
            ? localStorage.getItem("relaydesk.project")
            : null);
        const chosen =
          projRes.projects.find((p) => p.id === savedId) ?? projRes.projects[0];
        if (chosen) {
          await loadProject(chosen.id);
        } else {
          setCurrentProject(null);
          setTasks([]);
        }
      } catch (err) {
        setOnline(false);
        setBootError(err instanceof Error ? err.message : "无法连接到 Relaydesk 服务");
      } finally {
        setBooting(false);
      }
    },
    [loadProject],
  );

  useEffect(() => {
    void boot();
  }, [boot]);

  const taskRefreshSequence = useRef(0);
  const refreshTasks = useCallback(async () => {
    const request = ++taskRefreshSequence.current;
    const pid = projectIdRef.current;
    if (!pid) return;
    setRefreshing(true);
    try {
      const { tasks: nextTasks } = await api.listTasks(pid);
      if (projectIdRef.current === pid && request === taskRefreshSequence.current) {
        setTasks(nextTasks);
        setDetail(current => {
          const updated = current && nextTasks.find(t => t.id === current.task.id);
          return current && updated && updated.version >= current.task.version ? { ...current, task: { ...current.task, ...updated } } : current;
        });
        setOnline(true);
      }
    } catch {
      if (projectIdRef.current === pid && request === taskRefreshSequence.current) setOnline(false);
    } finally {
      if (request === taskRefreshSequence.current) setRefreshing(false);
    }
  }, []);

  // Poll every 20s when visible
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && projectIdRef.current) {
        void refreshTasks();
      }
    }, 20_000);
    const onFocus = () => {
      if (projectIdRef.current) void refreshTasks();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshTasks]);

  const openTaskDetail = useCallback(
    async (taskId: string, pushHistory = false) => {
      if (pushHistory && detail?.task.id && detail.task.id !== taskId) {
        setDetailStack((stack) => [...stack, detail.task.id]);
      } else if (!pushHistory) {
        setDetailStack([]);
      }
      setDetailLoading(true);
      try {
        const payload = await api.getTaskDetail(taskId);
        setDetail(payload);
        setOnline(true);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "无法加载任务详情");
      } finally {
        setDetailLoading(false);
      }
    },
    [detail?.task.id, toast],
  );

  const handleRefreshTask = useCallback(
    async (taskId: string) => {
      await refreshTasks();
      const payload = await api.getTaskDetail(taskId);
      setDetail((current) => current?.task.id === taskId ? payload : current);
    },
    [refreshTasks],
  );

  const detailTaskIdRef = useRef<string | null>(null);
  detailTaskIdRef.current = detail?.task.id ?? null;

  useEffect(() => {
    chatStreams.setTaskUpdatedHandler(({ task_id }) => {
      void refreshTasks();
      if (task_id && detailTaskIdRef.current === task_id) {
        void api
          .getTaskDetail(task_id)
          .then((payload) => {
            setDetail((curr) => (curr?.task.id === task_id ? payload : curr));
          })
          .catch(() => undefined);
      }
    });
    return () => chatStreams.setTaskUpdatedHandler(undefined);
  }, [chatStreams, refreshTasks]);

  const handleQuickAction = useCallback(
    async (task: TaskRecord, action: "claim" | "ready" | "done") => {
      try {
        if (action === "claim") {
          await api.taskAction(task.id, { action: "claim", version: task.version });
          toast.success("已认领任务");
        } else if (action === "ready") {
          await api.taskAction(task.id, {
            action: "status",
            status: "ready",
            version: task.version,
          });
          toast.success("已移入待处理队列");
        } else {
          await api.taskAction(task.id, {
            action: "status",
            status: "done",
            version: task.version,
          });
          toast.success("已验收完成");
        }
        await refreshTasks();
        if (detail?.task.id === task.id) {
          const payload = await api.getTaskDetail(task.id);
          setDetail(payload);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "操作失败");
      }
    },
    [detail?.task.id, refreshTasks, toast],
  );

  const handleReopenTask = useCallback(
    async (task: TaskRecord) => {
      try {
        await api.taskAction(task.id, {
          action: "reopen",
          version: task.version,
        });
        toast.success("已重新放回自动执行队列");
        await refreshTasks();
        if (detail?.task.id === task.id) {
          const payload = await api.getTaskDetail(task.id);
          setDetail(payload);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "重新入队失败");
      }
    },
    [detail?.task.id, refreshTasks, toast],
  );

  const handleToggleAutomation = useCallback(
    async (paused: boolean) => {
      if (!currentProject || automationBusy) return;
      setAutomationBusy(true);
      try {
        const { project: updated } = await api.updateProject(currentProject.id, {
          automation_paused: paused,
        });
        setCurrentProject(updated);
        setProjects((prev) =>
          prev.map((p) =>
            p.id === updated.id
              ? {
                  ...p,
                  automation_paused: updated.automation_paused,
                  delivery_mode: updated.delivery_mode,
                }
              : p,
          ),
        );
        toast.success(paused ? "已暂停本项目自动执行" : "已恢复全自动迭代");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "更新自动执行状态失败");
      } finally {
        setAutomationBusy(false);
      }
    },
    [automationBusy, currentProject, toast],
  );

  const handleTriggerRelease = useCallback(async () => {
    if (!currentProject || deployBusy) return;
    setDeployBusy(true);
    try {
      const res = await api.triggerProjectRelease(currentProject.id, {});
      toast.success(`已启动生产发布 ${releaseCode(res.release.number)}`);
      await refreshTasks();
      if (res.session?.id) {
        openReleaseSession(res.session.id);
      } else {
        changeView("releases");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "无法启动生产发布");
    } finally {
      setDeployBusy(false);
    }
  }, [changeView, currentProject, deployBusy, openReleaseSession, refreshTasks, toast]);

  const visibleTasks = useMemo(
    () =>
      filterTasksForView(
        tasks,
        view,
        search,
        statusFilter,
        sourceFilter,
        sortMode,
        cockpitFilter,
      ),
    [tasks, view, search, statusFilter, sourceFilter, sortMode, cockpitFilter],
  );

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen((o) => !o);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebarCollapsed();
        return;
      }

      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if (e.key === "Escape") {
        if (commandOpen) setCommandOpen(false);
        else if (detail) {
          setDetail(null);
          setDetailStack([]);
        }
        return;
      }

      if (inEditable || projectModalOpen || feedbackModalOpen || commandOpen) {
        return;
      }

      if (e.key === "/" && view !== "settings" && view !== "sources") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (currentProject) setFeedbackModalOpen(true);
        else setProjectModalOpen(true);
      } else if (
        (e.key === "j" || e.key === "k") &&
        view !== "agents" &&
        view !== "settings" &&
        view !== "sources" &&
        visibleTasks.length > 0
      ) {
        e.preventDefault();
        const idx = detail
          ? visibleTasks.findIndex((t) => t.id === detail.task.id)
          : -1;
        const nextIdx =
          e.key === "j"
            ? Math.min(visibleTasks.length - 1, idx + 1)
            : Math.max(0, idx <= 0 ? 0 : idx - 1);
        const nextTask = visibleTasks[nextIdx];
        if (nextTask) void openTaskDetail(nextTask.id, false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    commandOpen,
    currentProject,
    detail,
    feedbackModalOpen,
    openTaskDetail,
    projectModalOpen,
    toggleSidebarCollapsed,
    view,
    visibleTasks,
  ]);

  const handleLogout = async () => {
    try {
      await api.logout();
      window.location.replace("/login");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "退出失败");
    }
  };

  if (booting) {
    return (
      <div className="h-dvh flex items-center justify-center bg-[var(--surface-canvas)] text-[var(--text-muted)]">
        <div className="flex items-center gap-2.5 text-sm">
          <Icon name="loader-2" size={16} className="animate-spin text-indigo-500" />
          正在载入 Relaydesk 工作台…
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="h-dvh flex items-center justify-center p-6 bg-[var(--surface-canvas)]">
        <div className="max-w-md w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 text-center space-y-4">
          <div className="w-11 h-11 rounded-xl bg-rose-500/12 text-rose-500 flex items-center justify-center mx-auto">
            <Icon name="wifi-off" size={20} />
          </div>
          <div>
            <h1 className="text-base font-semibold text-[var(--text-primary)]">
              无法连接 Relaydesk 服务
            </h1>
            <p className="text-[13px] text-[var(--text-muted)] mt-1">{bootError}</p>
          </div>
          <Button variant="primary" size="sm" icon="refresh-cw" onClick={() => void boot()}>
            重试连接
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-dvh flex overflow-hidden bg-[var(--surface-canvas)] text-[var(--text-primary)]">
      <Sidebar
        projects={projects}
        currentProject={currentProject}
        tasks={tasks}
        view={view}
        authStatus={authStatus}
        online={online}
        dark={dark}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapsed}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        onSelectProject={(id) => {
          setDetail(null);
          setDetailStack([]);
          setSearch("");
          setStatusFilter("");
          setSourceFilter("");
          setCockpitFilter("");
          void loadProject(id);
        }}
        onSelectView={changeView}
        onNewProject={() => setProjectModalOpen(true)}
        onOpenCommand={() => setCommandOpen(true)}
        onToggleTheme={toggleTheme}
        onLogout={() => void handleLogout()}
      />

      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Desktop Collapsed Sidebar Expand Strip (non-chat views or empty project) */}
        {sidebarCollapsed && !(view === "chat" && currentProject) && (
          <div className="hidden lg:flex shrink-0 items-center justify-between px-4 h-10 border-b border-[var(--border-subtle)] bg-[var(--surface-sidebar)]/85">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={toggleSidebarCollapsed}
                title="展开左侧导航栏 (⌘B)"
                aria-label="展开左侧导航栏"
                className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
              >
                <Icon name="panel-left-open" size={14} />
                <span>展开侧边栏</span>
              </button>
              {currentProject && (
                <>
                  <span className="h-3.5 w-px bg-[var(--border-subtle)]" />
                  <span className="text-[12px] font-medium text-[var(--text-muted)] truncate">
                    {currentProject.name}
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setCommandOpen(true)}
                title="快速命令 (⌘K)"
                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
              >
                <Icon name="search" size={14} />
              </button>
              <button
                type="button"
                onClick={toggleTheme}
                title={dark ? "切换浅色主题" : "切换深色主题"}
                className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
              >
                <Icon name={dark ? "sun" : "moon"} size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Mobile Top Bar */}
        <div className="lg:hidden shrink-0 rd-safe-pt border-b border-[var(--border-subtle)] bg-[var(--surface-sidebar)]">
          <div className="flex items-center justify-between gap-2 px-2 h-13">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="打开导航菜单"
              className="inline-flex items-center gap-2 min-w-0 flex-1 h-10 px-2 rounded-lg text-left text-[var(--text-primary)] active:bg-[var(--surface-hover)] transition cursor-pointer"
            >
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--surface-card)] border border-[var(--border-subtle)] shrink-0">
                <Icon name="menu" size={17} />
              </span>
              <span className="min-w-0 flex flex-col">
                <span className="text-[13.5px] font-semibold leading-tight truncate">
                  {currentProject?.name ?? "Relaydesk"}
                </span>
                <span className="text-[11px] text-[var(--text-muted)] leading-tight truncate">
                  {MOBILE_VIEW_LABELS[view]}
                </span>
              </span>
            </button>
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                onClick={() =>
                  currentProject ? setFeedbackModalOpen(true) : setProjectModalOpen(true)
                }
                aria-label={currentProject ? "新建反馈" : "新建项目"}
                title={currentProject ? "新建反馈" : "新建项目"}
                className="inline-flex items-center justify-center w-10 h-10 rounded-lg text-indigo-600 dark:text-indigo-400 hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover)] transition cursor-pointer"
              >
                <Icon name="plus" size={19} />
              </button>
              <button
                type="button"
                onClick={() => setCommandOpen(true)}
                aria-label="搜索与快速命令"
                title="搜索与快速命令"
                className="inline-flex items-center justify-center w-10 h-10 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover)] transition cursor-pointer"
              >
                <Icon name="search" size={17} />
              </button>
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={dark ? "切换浅色主题" : "切换深色主题"}
                title={dark ? "切换浅色主题" : "切换深色主题"}
                className="inline-flex items-center justify-center w-10 h-10 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover)] transition cursor-pointer"
              >
                <Icon name={dark ? "sun" : "moon"} size={17} />
              </button>
            </div>
          </div>
        </div>

        {/* Main Workspace View */}
        {view === "workspace" ? (
          <ProjectWorkspaceView
            project={currentProject}
            initialTab={pendingWorkspaceTab}
            onConsumeInitialTab={() => setPendingWorkspaceTab(null)}
            onNewProject={() => setProjectModalOpen(true)}
            onOpenChatWithContext={(ref, prompt, opts) => {
              if (ref || prompt || opts?.enableNetwork) {
                setPendingChatContext({
                  ref,
                  prompt,
                  ...(opts?.enableNetwork ? { enableNetwork: true } : {}),
                });
              }
              changeView("chat");
            }}
          />
        ) : view === "releases" ? (
          <ReleasesView
            project={currentProject}
            onNewProject={() => setProjectModalOpen(true)}
            onOpenReleaseSession={openReleaseSession}
            onSelectTask={(id) => void openTaskDetail(id, false)}
            onEditDeployDoc={openEditDeployDoc}
            onOpenDeploySettings={openDeploySettings}
            onMutated={() => void refreshTasks()}
          />
        ) : view === "chat" ? (
          <CodexChatView
            key={currentProject?.id}
            streams={chatStreams}
            project={currentProject}
            tasks={tasks}
            pendingContext={pendingChatContext}
            onConsumePendingContext={() => setPendingChatContext(null)}
            onNewProject={() => setProjectModalOpen(true)}
            onOpenWorkspace={() => changeView("workspace")}
            onOpenCliSettings={openCliSettings}
            onOpenRoutingSettings={openRoutingSettings}
            mainSidebarCollapsed={sidebarCollapsed}
            onExpandMainSidebar={toggleSidebarCollapsed}
            onTaskCreated={(task) => {
              void refreshTasks();
              void openTaskDetail(task.id, false);
            }}
          />
        ) : view === "agents" ? (
          <AgentExecutionView key={currentProject?.id} project={currentProject} tasks={tasks} routing={executionRouting}
            streams={chatStreams} onOpenTaskDetail={taskId => void openTaskDetail(taskId, false)}
            onRefreshTasks={refreshTasks} onOpenRoutingSettings={openRoutingSettings} />
        ) : view === "settings" || view === "sources" ? (
          <SettingsView
            mode={view}
            project={currentProject}
            githubConnections={githubConnections}
            onGithubConnectionsUpdated={setGithubConnections}
            activeTab={settingsTab}
            onTabChange={setSettingsTab}
            onEditDeployDoc={openEditDeployDoc}
            onOpenReleases={() => changeView("releases")}
            onProjectUpdated={(updated) => {
              setCurrentProject((current) => current?.id === updated.id ? updated : current);
              setProjects((prev) =>
                prev.map((p) =>
                  p.id === updated.id
                    ? {
                        ...p,
                        name: updated.name,
                        repo: updated.repo,
                        repos: updated.repos,
                        automation_paused: updated.automation_paused,
                        delivery_mode: updated.delivery_mode,
                        deploy_policy: updated.deploy_policy,
                      }
                    : p,
                ),
              );
            }}
            onNewProject={() => setProjectModalOpen(true)}
          />
        ) : (
          <TaskQueueView
            project={currentProject}
            tasks={tasks}
            view={view}
            selectedTaskId={detail?.task.id ?? null}
            search={search}
            statusFilter={statusFilter}
            sourceFilter={sourceFilter}
            cockpitFilter={cockpitFilter}
            sortMode={sortMode}
            loading={refreshing}
            automationBusy={automationBusy}
            deployBusy={deployBusy}
            onSearchChange={setSearch}
            onStatusFilterChange={setStatusFilter}
            onSourceFilterChange={setSourceFilter}
            onCockpitFilterChange={setCockpitFilter}
            onSortModeChange={setSortMode}
            onClearFilters={() => {
              setSearch("");
              setStatusFilter("");
              setSourceFilter("");
              setCockpitFilter("");
            }}
            onSelectTask={(id) => void openTaskDetail(id, false)}
            onQuickAction={handleQuickAction}
            onReopenTask={handleReopenTask}
            onToggleAutomation={handleToggleAutomation}
            onTriggerRelease={handleTriggerRelease}
            onNewFeedback={() =>
              currentProject ? setFeedbackModalOpen(true) : setProjectModalOpen(true)
            }
            onNewProject={() => setProjectModalOpen(true)}
            onRefresh={() => void refreshTasks()}
            onNavigateView={changeView}
            onOpenSkillSetup={openSkillSetup}
            searchInputRef={searchInputRef}
          />
        )}
      </div>

      {/* Task Detail Slide-Over Drawer */}
      <TaskDetailDrawer
        key={detail?.task.id}
        project={currentProject}
        detail={detail}
        loading={detailLoading}
        allTasks={tasks}
        canGoBack={detailStack.length > 0}
        onGoBack={() => {
          const prev = detailStack[detailStack.length - 1];
          setDetailStack((s) => s.slice(0, -1));
          if (prev) void openTaskDetail(prev, false);
        }}
        onClose={() => {
          setDetail(null);
          setDetailStack([]);
        }}
        onOpenRelated={(id) => void openTaskDetail(id, true)}
        onRefreshTask={handleRefreshTask}
        onOpenCliSettings={() => {
          setDetail(null);
          setDetailStack([]);
          openCliSettings();
        }}
        onOpenReleases={() => {
          setDetail(null);
          setDetailStack([]);
          changeView("releases");
        }}
        streams={chatStreams}
        routing={executionRouting}
        onRefreshTasks={refreshTasks}
      />

      {/* Modals */}
      <CreateProjectModal
        open={projectModalOpen}
        githubConfigured={githubConfigured}
        githubConnections={githubConnections}
        onClose={() => setProjectModalOpen(false)}
        onOpenGithubSettings={openGlobalSettings}
        onCreated={(proj) => {
          setProjects((prev) => [
            ...prev,
            {
              id: proj.id,
              name: proj.name,
              repo: proj.repo,
              repos: proj.repos,
              automation_paused: proj.automation_paused,
              delivery_mode: proj.delivery_mode,
              deploy_policy: proj.deploy_policy,
              pending_deploy_count: proj.pending_deploy_count ?? 0,
              widget_code_context: proj.widget_code_context,
              created_at: proj.created_at,
            },
          ]);
          setCurrentProject(proj);
          setTasks([]);
          try {
            localStorage.setItem("relaydesk.project", proj.id);
          } catch {
            // ignore
          }
        }}
      />

      <CreateFeedbackModal
        open={feedbackModalOpen}
        projectId={currentProject?.id ?? null}
        onClose={() => setFeedbackModalOpen(false)}
        onCreated={(task) => {
          void refreshTasks();
          void openTaskDetail(task.id, false);
        }}
      />

      <CommandPaletteModal
        open={commandOpen}
        projects={projects}
        tasks={tasks}
        dark={dark}
        onClose={() => setCommandOpen(false)}
        onSelectView={changeView}
        onSelectProject={(id) => {
          setDetail(null);
          void loadProject(id);
        }}
        onSelectTask={(id) => void openTaskDetail(id, false)}
        onNewFeedback={() =>
          currentProject ? setFeedbackModalOpen(true) : setProjectModalOpen(true)
        }
        onNewProject={() => setProjectModalOpen(true)}
        onToggleTheme={toggleTheme}
      />
    </div>
  );
}

export default function HomeRoute() {
  return (
    <ToastProvider>
      <ConsoleWorkspace />
    </ToastProvider>
  );
}
