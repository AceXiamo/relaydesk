import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { Button, Kbd, Modal, PriorityBadge, StatusBadge, useToast } from "./ui.tsx";
import { api } from "~/lib/api.ts";
import { PRIORITY_LABELS, PRIORITY_ORDER, taskCode } from "~/lib/format.ts";
import type {
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
  onClose: () => void;
  onCreated: (project: ProjectDetail) => void;
}

export function CreateProjectModal({
  open,
  githubConfigured,
  onClose,
  onCreated,
}: CreateProjectModalProps) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setRepo("");
    }
  }, [open]);

  const loadRepos = async () => {
    setLoadingRepos(true);
    try {
      const res = await api.listGithubRepos(1);
      setRepos(res.repos);
      if (res.repos.length === 0) toast.info("未读取到可访问仓库");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "读取仓库失败");
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const { project } = await api.createProject({
        name: name.trim(),
        repo: repo.trim(),
      });
      toast.success(`项目「${project.name}」已创建`);
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
      subtitle="每个项目绑定一个 GitHub 仓库，并拥有独立的反馈队列与密钥。"
      maxWidth="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
            项目名称
          </span>
          <input
            type="text"
            required
            autoFocus
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：Relaydesk Web Console"
            className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
          />
        </label>

        <div className="space-y-2">
          <label className="block space-y-1.5">
            <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
              GitHub 仓库
            </span>
            <input
              type="text"
              required
              maxLength={200}
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repository 或完整 GitHub 地址"
              className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
            />
          </label>

          {githubConfigured && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="xs"
                icon="github"
                loading={loadingRepos}
                onClick={() => void loadRepos()}
              >
                从 GitHub 选择仓库
              </Button>
              {repos.length > 0 && (
                <select
                  aria-label="选择已授权仓库"
                  value={repos.includes(repo) ? repo : ""}
                  onChange={(e) => {
                    if (e.target.value) {
                      setRepo(e.target.value);
                      if (!name.trim()) {
                        setName(e.target.value.split("/").pop() ?? "");
                      }
                    }
                  }}
                  className="h-8 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[12.5px] font-mono text-[var(--text-primary)]"
                >
                  <option value="">选择仓库…</option>
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={submitting}>
            创建项目
          </Button>
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
          <div className="grid grid-cols-4 gap-2">
            {PRIORITY_ORDER.map((p) => {
              const active = priority === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg border text-[12.5px] font-medium transition cursor-pointer ${
                    active
                      ? "border-indigo-500 bg-indigo-500/10 text-[var(--text-primary)]"
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
          <span className="text-[11.5px] text-[var(--text-muted)]">
            <Kbd>⌘</Kbd> + <Kbd>Enter</Kbd> 快速提交
          </span>
          <div className="flex gap-2">
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const q = query.trim().toLowerCase();

  const actions = useMemo(() => {
    const items = [
      { id: "new-feedback", label: "新建反馈", icon: "plus", shortcut: "N", run: onNewFeedback },
      { id: "new-project", label: "新建项目", icon: "folder-git-2", run: onNewProject },
      {
        id: "llm-settings",
        label: "配置 LLM API Key 与模型",
        icon: "sparkles",
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
      `${p.name} ${p.repo}`.toLowerCase().includes(q),
    );
  }, [projects, q]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4">
      <div
        className="fixed inset-0 bg-black/45 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="快速命令"
        className="relative z-10 w-full max-w-lg rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] shadow-2xl overflow-hidden animate-modal-in"
      >
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-[var(--border-subtle)]">
          <Icon name="search" size={16} className="text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            placeholder="搜索命令、任务编号或切换项目…"
            className="flex-1 bg-transparent text-[14px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
          <Kbd>ESC</Kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2 space-y-3">
          {actions.length > 0 && (
            <div>
              <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
                快捷操作
              </div>
              {actions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onClose();
                    item.run();
                  }}
                  className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-[13px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
                >
                  <span className="flex items-center gap-2.5">
                    <Icon name={item.icon} size={15} className="text-[var(--text-muted)]" />
                    {item.label}
                  </span>
                  {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                </button>
              ))}
            </div>
          )}

          {matchedTasks.length > 0 && (
            <div>
              <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
                任务
              </div>
              {matchedTasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    onClose();
                    onSelectTask(t.id);
                  }}
                  className="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-[13px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-[11.5px] text-[var(--text-muted)] shrink-0">
                      {taskCode(t.number)}
                    </span>
                    <span className="truncate">{t.title}</span>
                  </span>
                  <StatusBadge status={t.status} compact />
                </button>
              ))}
            </div>
          )}

          {matchedProjects.length > 1 && (
            <div>
              <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
                切换项目
              </div>
              {matchedProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onClose();
                    onSelectProject(p.id);
                  }}
                  className="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-[13px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Icon name="folder-git-2" size={14} className="text-[var(--text-muted)]" />
                    <span className="truncate">{p.name}</span>
                  </span>
                  <span className="text-[11.5px] font-mono text-[var(--text-muted)]">
                    {p.repo}
                  </span>
                </button>
              ))}
            </div>
          )}

          {actions.length === 0 && matchedTasks.length === 0 && matchedProjects.length === 0 && (
            <div className="py-8 text-center text-[13px] text-[var(--text-muted)]">
              没有找到匹配项
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
