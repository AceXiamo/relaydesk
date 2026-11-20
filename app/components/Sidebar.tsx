import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { Kbd } from "./ui.tsx";
import type {
  AiConfigStatus,
  AuthStatusPayload,
  ProjectDetail,
  ProjectSummary,
  TaskRecord,
  WorkspaceView,
} from "~/lib/types.ts";

interface SidebarProps {
  projects: ProjectSummary[];
  currentProject: ProjectDetail | null;
  tasks: TaskRecord[];
  view: WorkspaceView;
  aiConfig: AiConfigStatus | null;
  authStatus: AuthStatusPayload | null;
  online: boolean;
  dark: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onSelectProject: (id: string) => void;
  onSelectView: (view: WorkspaceView) => void;
  onNewProject: () => void;
  onOpenCommand: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
}

export function Sidebar({
  projects,
  currentProject,
  tasks,
  view,
  aiConfig,
  authStatus,
  online,
  dark,
  mobileOpen,
  onCloseMobile,
  onSelectProject,
  onSelectView,
  onNewProject,
  onOpenCommand,
  onToggleTheme,
  onLogout,
}: SidebarProps) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!switcherOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [switcherOpen]);

  const openTasks = tasks.filter((t) => !t.merged_into);
  const counts: Record<WorkspaceView, number> = {
    queue: openTasks.filter((t) => t.status !== "done").length,
    triage: openTasks.filter((t) => t.status === "triage").length,
    mine: openTasks.filter((t) => t.owner === "human" && t.status !== "done").length,
    agents: openTasks.filter((t) => t.owner === "agent").length,
    review: openTasks.filter((t) => t.status === "review").length,
    sources: 0,
    settings: 0,
  };

  const navItems: Array<{
    id: WorkspaceView;
    label: string;
    icon: string;
    count?: number;
    pulse?: boolean;
  }> = [
    { id: "queue", label: "全部任务", icon: "layers", count: counts.queue },
    { id: "triage", label: "待整理", icon: "inbox", count: counts.triage },
    { id: "mine", label: "我的任务", icon: "user-check", count: counts.mine },
    {
      id: "agents",
      label: "Agent 执行",
      icon: "terminal",
      count: counts.agents,
      pulse: counts.agents > 0,
    },
    { id: "review", label: "待验收", icon: "file-check-2", count: counts.review },
  ];

  const configItems: Array<{
    id: WorkspaceView;
    label: string;
    icon: string;
    badge?: string;
    badgeTone?: "emerald" | "amber";
  }> = [
    { id: "sources", label: "收集入口", icon: "plug" },
    {
      id: "settings",
      label: "设置与 LLM",
      icon: "settings",
      badge: aiConfig ? (aiConfig.configured ? "LLM" : "未配 AI") : undefined,
      badgeTone: aiConfig?.configured ? "emerald" : "amber",
    },
  ];

  const selectView = (next: WorkspaceView) => {
    onSelectView(next);
    onCloseMobile();
  };

  const content = (
    <aside className="flex flex-col h-full w-[252px] shrink-0 bg-[var(--surface-sidebar)] border-r border-[var(--border-subtle)] select-none">
      {/* Brand header */}
      <div className="flex items-center justify-between px-3.5 h-13 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <img
            src="/logo.png"
            alt="Relaydesk"
            className="w-7 h-7 rounded-lg shadow-xs ring-1 ring-black/10 dark:ring-white/15 shrink-0 object-cover"
          />
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold tracking-tight text-[var(--text-primary)] leading-none">
              Relaydesk
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  online ? "bg-emerald-500" : "bg-rose-500 animate-pulse"
                }`}
              />
              <span className="text-[11px] text-[var(--text-muted)] leading-none">
                {online ? "已同步" : "连接中断"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenCommand}
            title="快速命令 (⌘K)"
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
          >
            <Icon name="search" size={14} />
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            title={dark ? "切换浅色主题" : "切换深色主题"}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
          >
            <Icon name={dark ? "sun" : "moon"} size={14} />
          </button>
        </div>
      </div>

      {/* Project Switcher */}
      <div className="px-2.5 pt-3 pb-2" ref={switcherRef}>
        <div className="relative">
          <button
            type="button"
            onClick={() => setSwitcherOpen((o) => !o)}
            className="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:border-[var(--border-strong)] transition text-left cursor-pointer shadow-2xs"
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 rounded-md bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                <Icon name="folder-git-2" size={14} />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-[var(--text-primary)] truncate leading-tight">
                  {currentProject ? currentProject.name : "选择或创建项目"}
                </div>
                <div
                  className="text-[11px] font-mono text-[var(--text-muted)] truncate leading-tight mt-0.5"
                  title={
                    currentProject
                      ? (currentProject.repos?.length
                          ? currentProject.repos
                          : [currentProject.repo]
                        ).join(", ")
                      : undefined
                  }
                >
                  {currentProject
                    ? `${currentProject.repo}${
                        (currentProject.repos?.length ?? 1) > 1
                          ? ` +${currentProject.repos.length - 1}`
                          : ""
                      }`
                    : "尚无项目"}
                </div>
              </div>
            </div>
            <Icon
              name="chevrons-up-down"
              size={14}
              className="text-[var(--text-muted)] shrink-0"
            />
          </button>

          {switcherOpen && (
            <div className="absolute left-0 right-0 mt-1.5 z-40 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] shadow-lg py-1.5 animate-fade-in">
              <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
                项目列表 ({projects.length})
              </div>
              <div className="max-h-56 overflow-y-auto px-1">
                {projects.length === 0 ? (
                  <div className="px-2.5 py-3 text-xs text-[var(--text-muted)] text-center">
                    还没有项目
                  </div>
                ) : (
                  projects.map((p) => {
                    const active = p.id === currentProject?.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          onSelectProject(p.id);
                          setSwitcherOpen(false);
                          onCloseMobile();
                        }}
                        className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left transition cursor-pointer ${
                          active
                            ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
                            : "text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium truncate">{p.name}</div>
                          <div
                            className="text-[11px] font-mono text-[var(--text-muted)] truncate"
                            title={(p.repos?.length ? p.repos : [p.repo]).join(", ")}
                          >
                            {p.repo}
                            {(p.repos?.length ?? 1) > 1 ? ` +${p.repos.length - 1}` : ""}
                          </div>
                        </div>
                        {active && <Icon name="check" size={14} className="shrink-0" />}
                      </button>
                    );
                  })
                )}
              </div>
              <div className="mt-1 pt-1 border-t border-[var(--border-subtle)] px-1">
                <button
                  type="button"
                  onClick={() => {
                    setSwitcherOpen(false);
                    onNewProject();
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[13px] font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition cursor-pointer"
                >
                  <Icon name="plus" size={14} />
                  新建项目
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-2 space-y-5">
        <div>
          <div className="px-2.5 pb-1.5 text-[11px] font-medium tracking-wide text-[var(--text-muted)]">
            反馈队列
          </div>
          <div className="space-y-0.5">
            {navItems.map((item) => {
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectView(item.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[13px] transition cursor-pointer ${
                    active
                      ? "bg-[var(--surface-active)] text-[var(--text-primary)] font-medium shadow-2xs"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Icon
                      name={item.icon}
                      size={15}
                      className={active ? "text-indigo-500" : "text-[var(--text-muted)]"}
                    />
                    <span className="truncate">{item.label}</span>
                  </span>
                  {(item.count ?? 0) > 0 && (
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] font-mono tabular-nums px-1.5 py-0.5 rounded-md ${
                        item.pulse
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium"
                          : active
                            ? "bg-[var(--surface-card)] text-[var(--text-primary)]"
                            : "text-[var(--text-muted)]"
                      }`}
                    >
                      {item.pulse && (
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                      )}
                      {item.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="px-2.5 pb-1.5 text-[11px] font-medium tracking-wide text-[var(--text-muted)]">
            接入与配置
          </div>
          <div className="space-y-0.5">
            {configItems.map((item) => {
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectView(item.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[13px] transition cursor-pointer ${
                    active
                      ? "bg-[var(--surface-active)] text-[var(--text-primary)] font-medium shadow-2xs"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Icon
                      name={item.icon}
                      size={15}
                      className={active ? "text-indigo-500" : "text-[var(--text-muted)]"}
                    />
                    <span className="truncate">{item.label}</span>
                  </span>
                  {item.badge && (
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${
                        item.badgeTone === "emerald"
                          ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                          : "bg-amber-500/12 text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Footer */}
      <div className="p-2.5 border-t border-[var(--border-subtle)] space-y-2">
        <button
          type="button"
          onClick={onOpenCommand}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <Icon name="command" size={13} />
            快速命令面板
          </span>
          <Kbd>⌘K</Kbd>
        </button>

        {authStatus?.mode === "wallet" && (
          <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[var(--surface-card)] border border-[var(--border-subtle)]">
            <div className="flex items-center gap-1.5 min-w-0">
              <Icon name="wallet" size={13} className="text-indigo-500 shrink-0" />
              <span className="text-[11px] font-mono text-[var(--text-secondary)] truncate">
                {authStatus.address
                  ? `${authStatus.address.slice(0, 6)}…${authStatus.address.slice(-4)}`
                  : "管理员钱包"}
              </span>
            </div>
            <button
              type="button"
              onClick={onLogout}
              title="退出登录"
              className="text-[var(--text-muted)] hover:text-rose-500 transition cursor-pointer p-0.5"
            >
              <Icon name="log-out" size={13} />
            </button>
          </div>
        )}
      </div>
    </aside>
  );

  return (
    <>
      <div className="hidden lg:flex h-full">{content}</div>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/45 backdrop-blur-[2px]"
            onClick={onCloseMobile}
          />
          <div className="relative z-10 h-full animate-slide-in-left">{content}</div>
        </div>
      )}
    </>
  );
}
