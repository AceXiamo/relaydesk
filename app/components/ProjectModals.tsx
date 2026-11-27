import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { SegmentedDetent } from "./MotionPrimitives.tsx";
import {
  DEFAULT_BRANCH_PREFIX,
  DeliveryBranchFields,
  validateGitRefInput,
} from "./DeliveryBranchFields.tsx";
import { GithubRepoPicker, parseManualRepoInput } from "./GithubRepoPicker.tsx";
import { Button, Kbd, Modal, PriorityBadge, StatusBadge, useToast } from "./ui.tsx";
import { api } from "~/lib/api.ts";
import {
  DELIVERY_MODE_LABELS,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  taskCode,
} from "~/lib/format.ts";
import type {
  DeliveryMode,
  GithubConnectionSummary,
  ProjectDetail,
  ProjectSummary,
  TaskPriority,
  TaskRecord,
  WorkspaceView,
} from "~/lib/types.ts";

/* ── Create Project Modal ───────────────────────────────────────────────── */

interface CreateProjectModalProps {
  open: boolean;
  githubConfigured: boolean;
  githubConnections?: GithubConnectionSummary[];
  onClose: () => void;
  onCreated: (project: ProjectDetail) => void;
  onOpenGithubSettings?: () => void;
}

export function CreateProjectModal({
  open,
  githubConfigured,
  githubConnections = [],
  onClose,
  onCreated,
  onOpenGithubSettings,
}: CreateProjectModalProps) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [nameAutoFilled, setNameAutoFilled] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const [repoDraft, setRepoDraft] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("direct_push");
  const [targetBranch, setTargetBranch] = useState("");
  const [branchPrefix, setBranchPrefix] = useState(DEFAULT_BRANCH_PREFIX);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setNameAutoFilled(false);
      setRepos([]);
      setRepoDraft("");
      setDeliveryMode("direct_push");
      setTargetBranch("");
      setBranchPrefix(DEFAULT_BRANCH_PREFIX);
    }
  }, [open]);

  const effectiveRepos = useMemo(() => {
    const draftParsed = parseManualRepoInput(repoDraft);
    if (!draftParsed) return repos;
    if (repos.some((r) => r.toLowerCase() === draftParsed.toLowerCase())) {
      return repos;
    }
    return [...repos, draftParsed];
  }, [repoDraft, repos]);

  const handleReposChange = (
    nextRepos: string[],
    meta?: { pickedFromGithub?: boolean; latestRepo?: string },
  ) => {
    setRepos(nextRepos);
    if (meta?.pickedFromGithub && nextRepos.length > 0) {
      const target = nextRepos[0];
      const shortName = target.split("/").pop()?.trim() ?? "";
      if (shortName && (!name.trim() || nameAutoFilled)) {
        setName(shortName);
        setNameAutoFilled(true);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || effectiveRepos.length === 0) return;
    const targetBranchErr = validateGitRefInput(targetBranch, 120);
    if (targetBranchErr) {
      toast.error(`目标分支格式无效：${targetBranchErr}`);
      return;
    }
    const branchPrefixErr = validateGitRefInput(branchPrefix, 64);
    if (branchPrefixErr) {
      toast.error(`工作分支前缀格式无效：${branchPrefixErr}`);
      return;
    }
    setSubmitting(true);
    try {
      const { project } = await api.createProject({
        name: name.trim(),
        repo: effectiveRepos[0],
        repos: effectiveRepos,
        delivery_mode: deliveryMode,
        target_branch: targetBranch.trim(),
        branch_prefix: branchPrefix.trim() || DEFAULT_BRANCH_PREFIX,
      });
      toast.success(`项目「${project.name}」已创建（绑定 ${project.repos.length} 个仓库）`);
      onCreated(project);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建项目失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建项目"
      subtitle="每个项目支持绑定一个或多个 GitHub 仓库（支持个人与组织），并拥有独立的反馈队列与密钥。"
      maxWidth="lg"
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form="rd-create-project-form"
            variant="primary"
            size="sm"
            icon="plus"
            loading={submitting}
            disabled={!name.trim() || effectiveRepos.length === 0}
          >
            创建项目
          </Button>
        </>
      }
    >
      <form
        id="rd-create-project-form"
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <GithubRepoPicker
          values={repos}
          onChange={handleReposChange}
          draftValue={repoDraft}
          onDraftChange={setRepoDraft}
          githubConfigured={githubConfigured}
          githubConnections={githubConnections}
          defaultExpanded={githubConfigured}
          onOpenGithubSettings={
            onOpenGithubSettings
              ? () => {
                  onClose();
                  onOpenGithubSettings();
                }
              : undefined
          }
        />

        <label className="block space-y-1.5">
          <span className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
              项目名称
            </span>
            {nameAutoFilled && (
              <span className="text-[11px] text-indigo-600 dark:text-indigo-400">
                已按仓库名自动填充，可修改
              </span>
            )}
          </span>
          <input
            type="text"
            required
            autoFocus={!githubConfigured}
            maxLength={100}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameAutoFilled(false);
            }}
            placeholder="例如：Relaydesk Web Console"
            className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
          />
        </label>

        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
              代码交付配置
            </span>
            <SegmentedDetent<DeliveryMode>
              size="xs"
              ariaLabel="选择代码交付模式"
              value={deliveryMode}
              onChange={setDeliveryMode}
              options={(["direct_push", "pr_automerge", "review_only"] as DeliveryMode[]).map(
                (mode) => ({
                  value: mode,
                  label: DELIVERY_MODE_LABELS[mode],
                }),
              )}
            />
          </div>

          <DeliveryBranchFields
            repo={effectiveRepos[0] ?? null}
            githubConfigured={githubConfigured}
            deliveryMode={deliveryMode}
            targetBranch={targetBranch}
            onTargetBranchChange={setTargetBranch}
            branchPrefix={branchPrefix}
            onBranchPrefixChange={setBranchPrefix}
            compact
          />
        </div>
      </form>
    </Modal>
  );
}

/* ── Create Feedback Modal ──────────────────────────────────────────────── */

interface CreateFeedbackModalProps {
  open: boolean;
  projectId: string | null;
  onClose: () => void;
  onCreated: (task: TaskRecord) => void;
}

export function CreateFeedbackModal({
  open,
  projectId,
  onClose,
  onCreated,
}: CreateFeedbackModalProps) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setBody("");
      setPriority("normal");
    }
  }, [open]);

  const submit = async () => {
    if (!projectId || !body.trim()) return;
    setSubmitting(true);
    try {
      const { task } = await api.createTask(projectId, {
        title: title.trim() || undefined,
        body: body.trim(),
        priority,
      });
      toast.success(`已创建反馈 ${taskCode(task.number)}`);
      onCreated(task);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建反馈失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建反馈"
      subtitle="录入用户反馈或自查问题，默认进入「待整理」队列。"
      maxWidth="md"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <label className="block space-y-1.5">
          <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
            标题 <span className="text-[var(--text-muted)] font-normal">(可选，留空自动提取首行)</span>
          </span>
          <input
            type="text"
            autoFocus
            maxLength={180}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="简述问题或需求…"
            className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
            反馈内容
          </span>
          <textarea
            required
            rows={5}
            maxLength={24000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="记录复现步骤、用户原话、预期表现…"
            className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3 text-[13px] leading-relaxed text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
          />
        </label>

        <div className="space-y-1.5">
          <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
            优先级
          </span>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {PRIORITY_ORDER.map((p) => {
              const active = priority === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`flex items-center justify-center gap-1.5 py-2.5 sm:py-2 px-2 rounded-lg border text-[12.5px] font-medium transition-[transform,border-color,background-color] duration-150 ease-[var(--ease-out)] active:scale-[0.97] cursor-pointer ${
                    active
                      ? "border-indigo-500 bg-indigo-500/10 text-[var(--text-primary)] shadow-[var(--rd-shadow-sm)]"
                      : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  <PriorityBadge priority={p} />
                  {PRIORITY_LABELS[p]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <span className="hidden sm:inline-flex items-center gap-1 text-[11.5px] text-[var(--text-muted)]">
            <Kbd>⌘</Kbd> + <Kbd>Enter</Kbd> 快速提交
          </span>
          <div className="flex gap-2 ml-auto">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={!body.trim()}
            >
              创建反馈
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/* ── Command Palette (⌘K) ───────────────────────────────────────────────── */

interface CommandPaletteProps {
  open: boolean;
  projects: ProjectSummary[];
  tasks: TaskRecord[];
  dark: boolean;
  onClose: () => void;
  onSelectView: (v: WorkspaceView) => void;
  onSelectProject: (id: string) => void;
  onSelectTask: (id: string) => void;
  onNewFeedback: () => void;
  onNewProject: () => void;
  onToggleTheme: () => void;
}

export function CommandPaletteModal({
  open,
  projects,
  tasks,
  dark,
  onClose,
  onSelectView,
  onSelectProject,
  onSelectTask,
  onNewFeedback,
  onNewProject,
  onToggleTheme,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      const rafId = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(rafId);
    }
  }, [open]);

  const q = query.trim().toLowerCase();

  const actions = useMemo(() => {
    const items = [
      { id: "new-feedback", label: "新建反馈", icon: "plus", shortcut: "N", run: onNewFeedback },
      { id: "new-project", label: "新建项目", icon: "folder-git-2", run: onNewProject },
      { id: "view-workspace", label: "打开项目空间（文件、数据库、手册）", icon: "folder-open", run: () => onSelectView("workspace") },
      { id: "view-chat", label: "打开 Codex 网页对话", icon: "sparkles", run: () => onSelectView("chat") },
      {
        id: "settings",
        label: "打开设置",
        icon: "settings",
        run: () => onSelectView("settings"),
      },
      { id: "sources", label: "查看收集入口与嵌入脚本", icon: "plug", run: () => onSelectView("sources") },
      { id: "view-queue", label: "切换到全部任务", icon: "layers", run: () => onSelectView("queue") },
      { id: "view-triage", label: "切换到待整理", icon: "inbox", run: () => onSelectView("triage") },
      { id: "view-agents", label: "切换到 Agent 执行", icon: "terminal", run: () => onSelectView("agents") },
      { id: "view-review", label: "切换到待验收", icon: "file-check-2", run: () => onSelectView("review") },
      {
        id: "toggle-theme",
        label: dark ? "切换为浅色主题" : "切换为深色主题",
        icon: dark ? "sun" : "moon",
        run: onToggleTheme,
      },
    ];
    if (!q) return items;
    return items.filter((i) => i.label.toLowerCase().includes(q));
  }, [q, dark, onNewFeedback, onNewProject, onSelectView, onToggleTheme]);

  const matchedTasks = useMemo(() => {
    const openTasks = tasks.filter((t) => !t.merged_into);
    if (!q) return openTasks.slice(0, 5);
    return openTasks
      .filter((t) =>
        `${taskCode(t.number)} ${t.title} ${t.body}`.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [tasks, q]);

  const matchedProjects = useMemo(() => {
    if (!q) return projects;
    return projects.filter((p) =>
      `${p.name} ${p.repo} ${(p.repos ?? []).join(" ")}`.toLowerCase().includes(q),
    );
  }, [projects, q]);

  const flatRunners = useMemo(() => {
    const list: Array<() => void> = [];
    for (const item of actions) list.push(item.run);
    for (const t of matchedTasks) list.push(() => onSelectTask(t.id));
    if (matchedProjects.length > 1) {
      for (const p of matchedProjects) list.push(() => onSelectProject(p.id));
    }
    return list;
  }, [actions, matchedTasks, matchedProjects, onSelectTask, onSelectProject]);

  const safeActiveIndex =
    flatRunners.length > 0 ? Math.min(activeIndex, flatRunners.length - 1) : -1;

  useEffect(() => {
    if (!open || safeActiveIndex < 0) return;
    optionRefs.current[safeActiveIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, safeActiveIndex]);

  if (!open) return null;

  const tasksOffset = actions.length;
  const projectsOffset = actions.length + matchedTasks.length;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4">
      <div
        className="fixed inset-0 bg-black/45 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="快速命令"
        className="relative z-10 w-full max-w-lg rounded-2xl border border-[var(--border-subtle)] bg-[var(--rd-plate)] shadow-[var(--rd-shadow-lg)] overflow-hidden"
      >
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-[var(--border-subtle)]">
          <Icon name="search" size={16} className="text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
                return;
              }
              if (flatRunners.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % flatRunners.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => (i - 1 + flatRunners.length) % flatRunners.length);
              } else if (e.key === "Home") {
                e.preventDefault();
                setActiveIndex(0);
              } else if (e.key === "End") {
                e.preventDefault();
                setActiveIndex(flatRunners.length - 1);
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const runner = flatRunners[safeActiveIndex];
                if (runner) {
                  onClose();
                  runner();
                }
              }
            }}
            placeholder="搜索命令、任务编号或切换项目…"
            className="flex-1 bg-transparent text-[14px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
          <Kbd>ESC</Kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto rd-scroll p-2 space-y-3">
          {actions.length > 0 && (
            <div>
              <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
                快捷操作
              </div>
              {actions.map((item, idx) => {
                const isSelected = safeActiveIndex === idx;
                return (
                  <button
                    key={item.id}
                    ref={(el) => {
                      optionRefs.current[idx] = el;
                    }}
                    type="button"
                    data-command-active={isSelected ? "true" : undefined}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => {
                      onClose();
                      item.run();
                    }}
                    className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-[13px] transition-colors cursor-pointer ${
                      isSelected
                        ? "bg-indigo-500/12 text-[var(--text-primary)]"
                        : "text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon
                        name={item.icon}
                        size={15}
                        className={isSelected ? "text-indigo-500" : "text-[var(--text-muted)]"}
                      />
                      {item.label}
                    </span>
                    {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                  </button>
                );
              })}
            </div>
          )}

          {matchedTasks.length > 0 && (
            <div>
              <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
                任务
              </div>
              {matchedTasks.map((t, idx) => {
                const flatIdx = tasksOffset + idx;
                const isSelected = safeActiveIndex === flatIdx;
                return (
                  <button
                    key={t.id}
                    ref={(el) => {
                      optionRefs.current[flatIdx] = el;
                    }}
                    type="button"
                    data-command-active={isSelected ? "true" : undefined}
                    onMouseEnter={() => setActiveIndex(flatIdx)}
                    onClick={() => {
                      onClose();
                      onSelectTask(t.id);
                    }}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-[13px] transition-colors cursor-pointer ${
                      isSelected
                        ? "bg-indigo-500/12 text-[var(--text-primary)]"
                        : "text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-[11.5px] text-[var(--text-muted)] shrink-0">
                        {taskCode(t.number)}
                      </span>
                      <span className="truncate">{t.title}</span>
                    </span>
                    <StatusBadge status={t.status} resolution={t.resolution} compact />
                  </button>
                );
              })}
            </div>
          )}

          {matchedProjects.length > 1 && (
            <div>
              <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
                切换项目
              </div>
              {matchedProjects.map((p, idx) => {
                const flatIdx = projectsOffset + idx;
                const isSelected = safeActiveIndex === flatIdx;
                return (
                  <button
                    key={p.id}
                    ref={(el) => {
                      optionRefs.current[flatIdx] = el;
                    }}
                    type="button"
                    data-command-active={isSelected ? "true" : undefined}
                    onMouseEnter={() => setActiveIndex(flatIdx)}
                    onClick={() => {
                      onClose();
                      onSelectProject(p.id);
                    }}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-[13px] transition-colors cursor-pointer ${
                      isSelected
                        ? "bg-indigo-500/12 text-[var(--text-primary)]"
                        : "text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Icon
                        name="folder-git-2"
                        size={14}
                        className={isSelected ? "text-indigo-500" : "text-[var(--text-muted)]"}
                      />
                      <span className="truncate">{p.name}</span>
                    </span>
                    <span className="text-[11.5px] font-mono text-[var(--text-muted)] shrink-0">
                      {p.repo}
                      {(p.repos?.length ?? 1) > 1 ? ` +${p.repos.length - 1}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {actions.length === 0 && matchedTasks.length === 0 && matchedProjects.length === 0 && (
            <div className="py-8 text-center text-[13px] text-[var(--text-muted)]">
              没有找到匹配项
            </div>
          )}
        </div>

        <div className="hidden sm:flex items-center justify-between px-4 py-2 border-t border-[var(--border-subtle)] bg-[var(--rd-tray)]/75 text-[11px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span>选择</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>↵</Kbd>
              <span>执行</span>
            </span>
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>ESC</Kbd>
            <span>关闭</span>
          </span>
        </div>
      </div>
    </div>
  );
}
