import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { prefersReducedMotion } from "~/lib/detent.ts";
import {
  SidebarAccounts,
  useSidebarAccounts,
  type SidebarAccountList,
} from "./SidebarAccounts.tsx";
import { Icon } from "./Icon.tsx";
import { MorphIcon, RollingNumber } from "./MotionPrimitives.tsx";
import { Kbd, LivePulseDot } from "./ui.tsx";
import type {
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
  authStatus: AuthStatusPayload | null;
  online: boolean;
  dark: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onSelectProject: (id: string) => void;
  onSelectView: (view: WorkspaceView) => void;
  onNewProject: () => void;
  onOpenCommand: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
}

interface NavItemDef {
  id: WorkspaceView;
  label: string;
  icon: string;
  count?: number;
  pulse?: boolean;
  alertCount?: number;
  alertTitle?: string;
  badge?: string;
}

interface SidebarPanelProps {
  isMobile: boolean;
  collapsed: boolean;
  projects: ProjectSummary[];
  currentProject: ProjectDetail | null;
  view: WorkspaceView;
  authStatus: AuthStatusPayload | null;
  online: boolean;
  dark: boolean;
  accounts: SidebarAccountList;
  onReloadAccounts: () => void;
  navItems: NavItemDef[];
  spaceItems: NavItemDef[];
  configItems: NavItemDef[];
  tasksLength: number;
  onToggleCollapse?: () => void;
  onCloseMobile: () => void;
  onSelectProject: (id: string) => void;
  onSelectView: (view: WorkspaceView) => void;
  onNewProject: () => void;
  onOpenCommand: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
}

function SidebarPanel({
  isMobile,
  collapsed,
  projects,
  currentProject,
  view,
  authStatus,
  online,
  dark,
  accounts,
  onReloadAccounts,
  navItems,
  spaceItems,
  configItems,
  tasksLength,
  onToggleCollapse,
  onCloseMobile,
  onSelectProject,
  onSelectView,
  onNewProject,
  onOpenCommand,
  onToggleTheme,
  onLogout,
}: SidebarPanelProps) {
  const isRail = !isMobile && collapsed;
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({
    left: 70,
    top: 64,
  });

  const switcherRef = useRef<HTMLDivElement>(null);
  const switcherMenuRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const itemRefs = useRef<Map<WorkspaceView, HTMLButtonElement>>(new Map());
  const hasMeasuredNavRef = useRef(false);
  const [navIndicator, setNavIndicator] = useState<{
    top: number;
    height: number;
    animate: boolean;
  }>({ top: 0, height: 0, animate: false });

  useEffect(() => {
    if (isMobile) return;
    const raf = window.requestAnimationFrame(() => setMotionEnabled(true));
    return () => window.cancelAnimationFrame(raf);
  }, [isMobile]);

  const measureNav = useCallback(() => {
    const navEl = navRef.current;
    const activeBtn = itemRefs.current.get(view);
    if (!navEl || !activeBtn || activeBtn.offsetHeight <= 0) return;

    let top = 0;
    let cursor: HTMLElement | null = activeBtn;
    while (cursor && cursor !== navEl) {
      top += cursor.offsetTop;
      cursor = cursor.offsetParent as HTMLElement | null;
    }
    const height = activeBtn.offsetHeight;
    const animate = hasMeasuredNavRef.current && !prefersReducedMotion();
    hasMeasuredNavRef.current = true;

    setNavIndicator((prev) => {
      if (prev.top === top && prev.height === height && prev.animate === animate) {
        return prev;
      }
      return { top, height, animate };
    });
  }, [view]);

  useLayoutEffect(() => {
    measureNav();
    const navEl = navRef.current;
    if (!navEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureNav());
    observer.observe(navEl);
    return () => observer.disconnect();
  }, [measureNav, isRail, projects.length, tasksLength]);

  const updateSwitcherPosition = useCallback(() => {
    const el = switcherRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuPos({
      left: rect.right + 10,
      top: Math.max(12, Math.min(window.innerHeight - 280, rect.top)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!switcherOpen || !isRail) return;
    updateSwitcherPosition();
    const onReposition = () => updateSwitcherPosition();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [switcherOpen, isRail, updateSwitcherPosition]);

  useEffect(() => {
    if (!switcherOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        switcherRef.current?.contains(target) ||
        switcherMenuRef.current?.contains(target)
      ) {
        return;
      }
      setSwitcherOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSwitcherOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [switcherOpen]);

  const selectView = (next: WorkspaceView) => {
    onSelectView(next);
    onCloseMobile();
  };

  const renderProjectMenuContent = () => (
    <>
      <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
        项目列表 ({projects.length})
      </div>
      <div className="max-h-56 overflow-y-auto px-1 space-y-0.5">
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
                className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left transition-colors duration-150 cursor-pointer ${
                  active
                    ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
                    : "text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[13px] font-medium truncate">{p.name}</span>
                    <span
                      title={p.automation_paused ? "自动执行已暂停" : "全自动运行中"}
                      className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9.5px] font-medium leading-none ${
                        p.automation_paused
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      <LivePulseDot
                        tone={p.automation_paused ? "amber" : "emerald"}
                        active={!p.automation_paused}
                      />
                      {p.automation_paused ? "暂停" : "自动"}
                    </span>
                  </div>
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
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[13px] font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition-colors duration-150 cursor-pointer"
        >
          <Icon name="plus" size={14} />
          新建项目
        </button>
      </div>
    </>
  );

  const renderNavSection = (title: string, items: NavItemDef[], showRailDivider: boolean) => (
    <div>
      <div className="relative h-6 flex items-center px-2.5">
        <span
          className={`text-[11px] font-medium tracking-wide text-[var(--text-muted)] whitespace-nowrap transition-opacity duration-150 ${
            isRail ? "opacity-0 pointer-events-none" : "opacity-100 delay-75"
          }`}
        >
          {title}
        </span>
        {showRailDivider && (
          <span
            aria-hidden="true"
            data-rail-divider=""
            className={`absolute left-[10px] w-5 h-px bg-[var(--border-subtle)] transition-opacity duration-150 ${
              isRail ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
          />
        )}
      </div>
      <div className="space-y-0.5">
        {items.map((item) => {
          const active = view === item.id;
          const tooltipParts = [item.label];
          if ((item.count ?? 0) > 0) tooltipParts.push(`${item.count}`);
          if ((item.alertCount ?? 0) > 0 && item.alertTitle) tooltipParts.push(item.alertTitle);
          const railTooltip = tooltipParts.join(" · ");

          return (
            <button
              key={item.id}
              ref={(el) => {
                if (el) itemRefs.current.set(item.id, el);
                else itemRefs.current.delete(item.id);
              }}
              type="button"
              onClick={() => selectView(item.id)}
              title={isRail ? railTooltip : undefined}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              className={`group relative z-10 h-8 w-full flex items-center rounded-lg text-[13px] transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.985] cursor-pointer ${
                active
                  ? navIndicator.height > 0
                    ? "text-[var(--text-primary)] font-medium"
                    : "bg-[var(--surface-active)] text-[var(--text-primary)] font-medium shadow-2xs"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]/75 hover:text-[var(--text-primary)]"
              }`}
            >
              {navIndicator.height === 0 && (
                <span
                  aria-hidden="true"
                  className={`absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-r-full transition-opacity duration-150 ${
                    active
                      ? "bg-indigo-500 opacity-100"
                      : "bg-[var(--border-strong)] opacity-0 group-hover:opacity-60"
                  }`}
                />
              )}
              <span className="w-10 h-8 shrink-0 inline-flex items-center justify-center relative">
                <Icon
                  name={item.icon}
                  size={15}
                  className={`transition-colors duration-150 ${
                    active
                      ? "text-indigo-500"
                      : "text-[var(--text-muted)] group-hover:text-[var(--text-primary)]"
                  }`}
                />
                {isRail && (
                  <>
                    {(item.alertCount ?? 0) > 0 ? (
                      <span
                        aria-hidden="true"
                        className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-rose-500 ring-2 ring-[var(--surface-sidebar)]"
                      />
                    ) : item.pulse ? (
                      <span aria-hidden="true" className="absolute top-1.5 right-1.5 flex">
                        <LivePulseDot tone="amber" active />
                      </span>
                    ) : (item.count ?? 0) > 0 ? (
                      <span
                        aria-hidden="true"
                        className="absolute top-1 right-0.5 min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-mono font-semibold leading-none inline-flex items-center justify-center bg-[var(--surface-card)] border border-[var(--border-subtle)] text-[var(--text-secondary)] shadow-2xs tabular-nums"
                      >
                        {item.count! > 99 ? "99+" : item.count}
                      </span>
                    ) : null}
                  </>
                )}
              </span>

              <span
                className={`flex-1 min-w-0 flex items-center justify-between pr-2.5 overflow-hidden whitespace-nowrap transition-opacity duration-150 ${
                  isRail ? "opacity-0 pointer-events-none" : "opacity-100 delay-75"
                }`}
              >
                <span className="truncate">{item.label}</span>
                <span className="flex items-center gap-1 shrink-0 ml-2">
                  {(item.alertCount ?? 0) > 0 && (
                    <span
                      title={item.alertTitle}
                      className="inline-flex items-center gap-0.5 text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-rose-500/12 text-rose-600 dark:text-rose-400 font-medium"
                    >
                      <Icon name="alert-triangle" size={10} />
                      {item.alertCount}
                    </span>
                  )}
                  {(item.count ?? 0) > 0 && (
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] font-mono tabular-nums px-1.5 py-0.5 rounded-md transition-colors duration-150 ${
                        item.pulse
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium"
                          : active
                            ? "bg-[var(--surface-card)] text-[var(--text-primary)] shadow-2xs"
                            : "text-[var(--text-muted)]"
                      }`}
                    >
                      {item.pulse && <LivePulseDot tone="amber" active />}
                      <RollingNumber value={item.count!} />
                    </span>
                  )}
                  {item.badge && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 font-medium">
                      {item.badge}
                    </span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const hasCompactAccounts =
    accounts === "loading" || accounts === "error" || accounts.length > 0;

  return (
    <aside
      data-collapsed={isRail ? "true" : "false"}
      style={!isMobile && !motionEnabled ? { transitionDuration: "0ms" } : undefined}
      className={`flex flex-col h-full shrink-0 bg-[var(--surface-sidebar)] border-r border-[var(--border-subtle)] select-none rd-safe-pt ${
        isMobile
          ? "w-[min(272px,84vw)]"
          : `rd-sidebar-shell ${isRail ? "lg:w-[60px]" : "lg:w-[252px]"}`
      }`}
    >
      {/* Brand header */}
      <div className="flex items-center justify-between px-4 h-13 border-b border-[var(--border-subtle)] overflow-hidden shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative w-7 h-7 shrink-0">
            <img
              src="/logo.png"
              alt="Relaydesk"
              title={isRail ? `Relaydesk · ${online ? "已同步" : "连接中断"}` : undefined}
              className="w-7 h-7 rounded-lg shadow-xs ring-1 ring-black/10 dark:ring-white/15 object-cover"
            />
            <span
              aria-hidden="true"
              className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-[var(--surface-sidebar)] transition-opacity duration-150 ${
                online ? "bg-emerald-500" : "bg-rose-500 animate-pulse"
              } ${isRail ? "opacity-100" : "opacity-0 pointer-events-none"}`}
            />
          </div>
          <div
            className={`min-w-0 whitespace-nowrap transition-opacity duration-150 ${
              isRail ? "opacity-0 pointer-events-none" : "opacity-100 delay-75"
            }`}
          >
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
        <div
          aria-hidden={isRail || undefined}
          className={`flex items-center gap-0.5 shrink-0 transition-opacity duration-150 ${
            isRail ? "opacity-0 pointer-events-none" : "opacity-100 delay-75"
          }`}
        >
          <button
            type="button"
            tabIndex={isRail ? -1 : undefined}
            onClick={onOpenCommand}
            title="快速命令 (⌘K)"
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press cursor-pointer"
          >
            <Icon name="search" size={14} />
          </button>
          <button
            type="button"
            tabIndex={isRail ? -1 : undefined}
            onClick={onToggleTheme}
            title={dark ? "切换浅色主题" : "切换深色主题"}
            aria-label={dark ? "切换浅色主题" : "切换深色主题"}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press cursor-pointer"
          >
            <MorphIcon name="moon" activeName="sun" active={dark} size={14} rotate />
          </button>
          {onToggleCollapse && !isMobile && (
            <button
              type="button"
              tabIndex={isRail ? -1 : undefined}
              onClick={onToggleCollapse}
              title="收起左侧导航栏 (⌘B)"
              aria-label="收起左侧导航栏"
              className="hidden lg:inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press cursor-pointer"
            >
              <Icon name="panel-left-close" size={14} />
            </button>
          )}
          {isMobile && (
            <button
              type="button"
              onClick={onCloseMobile}
              title="关闭导航"
              aria-label="关闭导航"
              className="lg:hidden inline-flex items-center justify-center w-10 h-10 -mr-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press cursor-pointer"
            >
              <Icon name="x" size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Project Switcher */}
      <div className="px-2.5 pt-3 pb-2 shrink-0" ref={switcherRef}>
        <div className="relative">
          <button
            type="button"
            aria-expanded={switcherOpen}
            aria-haspopup="menu"
            aria-label={currentProject ? `切换项目 (${currentProject.name})` : "选择或创建项目"}
            title={
              isRail
                ? currentProject
                  ? `${currentProject.name} (${currentProject.automation_paused ? "暂停" : "自动"})`
                  : "选择或创建项目"
                : undefined
            }
            onClick={() => {
              if (!switcherOpen && isRail) updateSwitcherPosition();
              setSwitcherOpen((o) => !o);
            }}
            className="group w-full flex items-center justify-between gap-2 px-[7px] py-2 rounded-xl border border-[var(--border-subtle)] rd-plate hover:border-[var(--border-strong)] transition-[border-color,box-shadow,transform] duration-150 ease-[var(--ease-out)] rd-press text-left cursor-pointer overflow-hidden"
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <div className="relative w-6 h-6 rounded-md bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                <Icon name="folder-git-2" size={14} />
                {currentProject && (
                  <span
                    aria-hidden="true"
                    className={`absolute -top-0.5 -right-0.5 flex transition-opacity duration-150 ${
                      isRail ? "opacity-100" : "opacity-0 pointer-events-none"
                    }`}
                  >
                    <LivePulseDot
                      tone={currentProject.automation_paused ? "amber" : "emerald"}
                      active={!currentProject.automation_paused}
                    />
                  </span>
                )}
              </div>
              <div
                className={`min-w-0 flex-1 whitespace-nowrap transition-opacity duration-150 ${
                  isRail ? "opacity-0 pointer-events-none" : "opacity-100 delay-75"
                }`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[13px] font-medium text-[var(--text-primary)] truncate leading-tight">
                    {currentProject ? currentProject.name : "选择或创建项目"}
                  </span>
                  {currentProject && (
                    <span
                      title={
                        currentProject.automation_paused
                          ? "全自动迭代已暂停"
                          : "全自动迭代运行中"
                      }
                      className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium leading-none border ${
                        currentProject.automation_paused
                          ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20"
                          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20"
                      }`}
                    >
                      <LivePulseDot
                        tone={currentProject.automation_paused ? "amber" : "emerald"}
                        active={!currentProject.automation_paused}
                      />
                      {currentProject.automation_paused ? "暂停" : "自动"}
                    </span>
                  )}
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
              className={`text-[var(--text-muted)] group-hover:text-[var(--text-primary)] transition-[color,opacity] duration-150 shrink-0 ${
                isRail ? "opacity-0 pointer-events-none" : "opacity-100 delay-75"
              }`}
            />
          </button>

          {switcherOpen && !isRail && (
            <div
              ref={switcherMenuRef}
              role="menu"
              style={{ transformOrigin: "top center" }}
              className="absolute left-0 right-0 mt-1.5 z-40 rounded-xl border border-[var(--border-strong)]/80 bg-[var(--rd-plate)]/98 backdrop-blur-md shadow-[var(--rd-shadow-lg)] py-1.5 animate-popover-in"
            >
              {renderProjectMenuContent()}
            </div>
          )}

          {switcherOpen &&
            isRail &&
            typeof document !== "undefined" &&
            createPortal(
              <div
                ref={switcherMenuRef}
                role="menu"
                style={{ left: menuPos.left, top: menuPos.top, transformOrigin: "top left" }}
                className="fixed z-50 w-[252px] rounded-xl border border-[var(--border-strong)]/80 bg-[var(--rd-plate)]/98 backdrop-blur-md shadow-[var(--rd-shadow-lg)] py-1.5 animate-popover-in"
              >
                {renderProjectMenuContent()}
              </div>,
              document.body,
            )}
        </div>
      </div>

      {/* Navigation */}
      <nav
        ref={navRef}
        className="relative flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-2 space-y-4"
      >
        {navIndicator.height > 0 && (
          <div
            aria-hidden="true"
            style={{
              height: `${navIndicator.height}px`,
              transform: `translate3d(0, ${navIndicator.top}px, 0)`,
              transition: navIndicator.animate
                ? "transform 240ms var(--ease-spring-snappy), height 220ms var(--ease-out)"
                : "none",
            }}
            className="pointer-events-none absolute top-0 left-2.5 right-2.5 rounded-lg bg-[var(--surface-active)] shadow-2xs"
          >
            <span className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-r-full bg-indigo-500" />
          </div>
        )}

        {renderNavSection("反馈队列", navItems, false)}
        {renderNavSection("空间与对话", spaceItems, true)}
        {renderNavSection("接入与配置", configItems, true)}
      </nav>

      {/* Footer */}
      <div className="border-t border-[var(--border-subtle)] overflow-hidden shrink-0 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        {isRail ? (
          <div data-rail-footer="" className="w-[59px] pt-2.5 flex flex-col items-center gap-2">
            <SidebarAccounts
              accounts={accounts}
              onRetry={onReloadAccounts}
              compact
            />
            {hasCompactAccounts && (
              <span aria-hidden="true" className="w-5 h-px bg-[var(--border-subtle)]" />
            )}
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  onCloseMobile();
                  onOpenCommand();
                }}
                aria-label="快速命令面板"
                title="快速命令面板 (⌘K)"
                className="w-10 h-8 rounded-lg inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press cursor-pointer"
              >
                <Icon name="command" size={15} />
              </button>
              <button
                type="button"
                onClick={onToggleTheme}
                aria-label={dark ? "切换浅色主题" : "切换深色主题"}
                title={dark ? "切换浅色主题" : "切换深色主题"}
                className="w-10 h-8 rounded-lg inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press cursor-pointer"
              >
                <MorphIcon name="moon" activeName="sun" active={dark} size={15} rotate />
              </button>
              {authStatus?.mode === "wallet" && (
                <button
                  type="button"
                  onClick={onLogout}
                  aria-label="退出登录"
                  title="退出登录"
                  className="w-10 h-8 rounded-lg inline-flex items-center justify-center text-[var(--text-muted)] hover:text-rose-500 hover:bg-[var(--surface-hover)] transition-colors rd-press cursor-pointer"
                >
                  <Icon name="log-out" size={15} />
                </button>
              )}
              {onToggleCollapse && (
                <button
                  type="button"
                  onClick={onToggleCollapse}
                  aria-label="展开左侧导航栏"
                  title="展开左侧导航栏 (⌘B)"
                  className="w-10 h-8 rounded-lg inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press cursor-pointer"
                >
                  <Icon name="panel-left-open" size={15} />
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="p-2.5 pb-0 space-y-2 min-w-[231px]">
            <SidebarAccounts accounts={accounts} onRetry={onReloadAccounts} />
            <button
              type="button"
              onClick={() => {
                onCloseMobile();
                onOpenCommand();
              }}
              className="w-full flex items-center justify-between px-2.5 py-2 lg:py-1.5 rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
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
        )}
      </div>
    </aside>
  );
}

export function Sidebar({
  projects,
  currentProject,
  tasks,
  view,
  authStatus,
  online,
  dark,
  collapsed = false,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
  onSelectProject,
  onSelectView,
  onNewProject,
  onOpenCommand,
  onToggleTheme,
  onLogout,
}: SidebarProps) {
  const { accounts, reload: reloadAccounts } = useSidebarAccounts();

  const openTasks = tasks.filter((t) => !t.merged_into);
  const waitingCount = openTasks.filter(
    (t) => t.status === "waiting" || t.status === "handoff",
  ).length;
  const pendingDeployCount = openTasks.filter(
    (t) => t.deploy_status === "pending" || t.deploy_status === "deploying",
  ).length;
  const deployingCount = openTasks.filter((t) => t.deploy_status === "deploying").length;
  const failedDeployCount = openTasks.filter((t) => t.deploy_status === "failed").length;
  const counts: Record<WorkspaceView, number> = {
    queue: openTasks.filter((t) => t.status !== "done").length,
    triage: openTasks.filter((t) => t.status === "triage").length,
    mine: openTasks.filter((t) => t.owner === "human" && t.status !== "done").length,
    agents: openTasks.filter((t) => t.owner === "agent" || t.agent_session_status === "running").length,
    review: openTasks.filter((t) => t.status === "review").length,
    releases: pendingDeployCount,
    workspace: 0,
    chat: 0,
    sources: 0,
    settings: 0,
  };

  const navItems: NavItemDef[] = [
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
    {
      id: "review",
      label: "待验收",
      icon: "file-check-2",
      count: counts.review,
      alertCount: waitingCount,
      alertTitle: `${waitingCount} 条待补充或交接异常`,
    },
    {
      id: "releases",
      label: "生产发布",
      icon: "rocket",
      count: counts.releases,
      pulse: deployingCount > 0,
      alertCount: failedDeployCount,
      alertTitle: `${failedDeployCount} 条上次发布失败待排查`,
    },
  ];

  const spaceItems: NavItemDef[] = [
    { id: "workspace", label: "项目空间", icon: "folder-open" },
    { id: "chat", label: "Codex 对话", icon: "sparkles", badge: "CLI" },
  ];

  const configItems: NavItemDef[] = [
    { id: "sources", label: "收集入口", icon: "plug" },
    {
      id: "settings",
      label: "设置",
      icon: "settings",
    },
  ];

  const sharedProps = {
    projects,
    currentProject,
    view,
    authStatus,
    online,
    dark,
    accounts,
    onReloadAccounts: reloadAccounts,
    navItems,
    spaceItems,
    configItems,
    tasksLength: tasks.length,
    onToggleCollapse,
    onCloseMobile,
    onSelectProject,
    onSelectView,
    onNewProject,
    onOpenCommand,
    onToggleTheme,
    onLogout,
  };

  return (
    <>
      <div className="hidden lg:flex h-full shrink-0">
        <SidebarPanel {...sharedProps} isMobile={false} collapsed={collapsed} />
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/45 backdrop-blur-[2px]"
            onClick={onCloseMobile}
          />
          <div className="relative z-10 h-full animate-slide-in-left">
            <SidebarPanel {...sharedProps} isMobile={true} collapsed={false} />
          </div>
        </div>
      )}
    </>
  );
}
