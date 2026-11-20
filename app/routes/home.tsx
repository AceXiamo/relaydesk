import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MetaFunction } from "react-router";
import { Icon } from "~/components/Icon.tsx";
import {
  CommandPaletteModal,
  CreateFeedbackModal,
  CreateProjectModal,
} from "~/components/ProjectModals.tsx";
import { SettingsView } from "~/components/SettingsView.tsx";
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
import type {
  AiConfigStatus,
  AuthStatusPayload,
  GithubConnectionSummary,
  ProjectDetail,
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
  "sources",
  "settings",
]);

function readInitialView(): WorkspaceView {
  if (typeof window === "undefined") return "queue";
  const hash = window.location.hash.replace(/^#/, "") as WorkspaceView;
  return VALID_VIEWS.has(hash) ? hash : "queue";
}

function ConsoleWorkspace() {
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectDetail | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [view, setView] = useState<WorkspaceView>("queue");
  const [aiConfig, setAiConfig] = useState<AiConfigStatus | null>(null);
  const [githubConnections, setGithubConnections] = useState<GithubConnectionSummary[]>([]);
  const githubConfigured = githubConnections.length > 0;
  const [authStatus, setAuthStatus] = useState<AuthStatusPayload | null>(null);
  const [online, setOnline] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "">("");
  const [sourceFilter, setSourceFilter] = useState<TaskSource | "">("");
  const [cockpitFilter, setCockpitFilter] = useState<CockpitFilter>("");
  const [sortMode, setSortMode] = useState<SortMode>("updated");

  // Detail Drawer & Stack
  const [detail, setDetail] = useState<TaskDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailStack, setDetailStack] = useState<string[]>([]);

  // Modals & UI chrome
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [dark, setDark] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const projectIdRef = useRef<string | null>(null);
  projectIdRef.current = currentProject?.id ?? null;

  useEffect(() => {
    setView(readInitialView());
    setDark(document.documentElement.classList.contains("dark"));
    const onHash = () => setView(readInitialView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
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
    changeView("settings");
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        document
          .getElementById("relaydesk-skill-setup")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 60);
    }
  }, [changeView]);

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
        const [auth, projRes, aiRes, ghRes] = await Promise.all([
          api.getAuthStatus(),
          api.listProjects(),
          api.getAiConfig().catch(() => null),
          api
            .getGithubStatus()
            .catch(() => ({ configured: false, connections: [] as GithubConnectionSummary[] })),
        ]);
        setAuthStatus(auth);
        setProjects(projRes.projects);
        setAiConfig(aiRes);
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

  const refreshTasks = useCallback(async () => {
    const pid = projectIdRef.current;
    if (!pid) return;
    setRefreshing(true);
    try {
      const { tasks: nextTasks } = await api.listTasks(pid);
      if (projectIdRef.current === pid) {
        setTasks(nextTasks);
        setOnline(true);
      }
    } catch {
      setOnline(false);
    } finally {
      setRefreshing(false);
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
      setDetail(payload);
    },
    [refreshTasks],
  );

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
      <div className="h-screen flex items-center justify-center bg-[var(--surface-canvas)] text-[var(--text-muted)]">
        <div className="flex items-center gap-2.5 text-sm">
          <Icon name="loader-2" size={16} className="animate-spin text-indigo-500" />
          正在载入 Relaydesk 工作台…
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="h-screen flex items-center justify-center p-6 bg-[var(--surface-canvas)]">
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
    <div className="h-screen flex overflow-hidden bg-[var(--surface-canvas)] text-[var(--text-primary)]">
      <Sidebar
        projects={projects}
        currentProject={currentProject}
        tasks={tasks}
        view={view}
        aiConfig={aiConfig}
        authStatus={authStatus}
        online={online}
        dark={dark}
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
        {/* Mobile Top Bar */}
        <div className="lg:hidden shrink-0 flex items-center justify-between px-4 h-12 border-b border-[var(--border-subtle)] bg-[var(--surface-sidebar)]">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text-primary)] cursor-pointer"
          >
            <Icon name="menu" size={18} />
            <span>{currentProject?.name ?? "Relaydesk"}</span>
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <Icon name="search" size={16} />
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <Icon name={dark ? "sun" : "moon"} size={16} />
            </button>
          </div>
        </div>

        {/* Main Workspace View */}
        {view === "settings" || view === "sources" ? (
          <SettingsView
            mode={view}
            project={currentProject}
            aiConfig={aiConfig}
            githubConnections={githubConnections}
            onAiConfigUpdated={setAiConfig}
            onGithubConnectionsUpdated={setGithubConnections}
            onProjectUpdated={(updated) => {
              setCurrentProject(updated);
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
        project={currentProject}
        detail={detail}
        loading={detailLoading}
        allTasks={tasks}
        aiConfig={aiConfig}
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
        onOpenAiSettings={() => {
          setDetail(null);
          setDetailStack([]);
          changeView("settings");
        }}
      />

      {/* Modals */}
      <CreateProjectModal
        open={projectModalOpen}
        githubConfigured={githubConfigured}
        githubConnections={githubConnections}
        onClose={() => setProjectModalOpen(false)}
        onOpenGithubSettings={() => changeView("settings")}
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
