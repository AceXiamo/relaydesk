import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import { formatRelativeTime, taskCode } from "~/lib/format.ts";
import type {
  ProjectDetail,
  RepoBranchDetailPayload,
  RepoBranchItem,
  RepoBranchesOverviewPayload,
  RepoMirrorEntry,
} from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import {
  Button,
  CopyButton,
  DeliveryModeBadge,
  EmptyState,
  LivePulseDot,
  PriorityBadge,
  StatusBadge,
} from "./ui.tsx";

type BranchFilter = "all" | "remote" | "local_only" | "pr" | "task";

interface RepoBranchesPanelProps {
  project: ProjectDetail;
  repo: string;
  mirror: RepoMirrorEntry | null;
  repoSyncing: boolean;
  overview: RepoBranchesOverviewPayload | null;
  overviewLoading: boolean;
  overviewError: string;
  mobilePane: "list" | "detail";
  onMobilePaneChange: (pane: "list" | "detail") => void;
  onRefresh: () => void;
  onBrowseBranchCode: (branch: string) => void;
  onSelectTask?: (taskId: string) => void;
  onOpenChatWithContext: (
    ref?: { kind: "repo_file"; label: string; ref: string; repo?: string },
    initialPrompt?: string,
  ) => void;
}

function fileStatusBadge(status: string): { code: string; className: string } {
  switch (status.toLowerCase()) {
    case "added":
      return {
        code: "A",
        className: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
      };
    case "removed":
    case "deleted":
      return {
        code: "D",
        className: "bg-rose-500/12 text-rose-700 dark:text-rose-300 border-rose-500/25",
      };
    case "renamed":
      return {
        code: "R",
        className: "bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/25",
      };
    default:
      return {
        code: "M",
        className: "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300 border-indigo-500/25",
      };
  }
}

function sourceLabel(source: RepoBranchItem["source"]): string {
  if (source === "both") return "远端 & 本机";
  if (source === "local") return "仅本机";
  return "GitHub 远端";
}

function buildBranchDiscussPrompt(repo: string, branch: RepoBranchItem, compareBase: string): string {
  const lines = [
    `请帮我结合仓库 \`${repo}\` 的分支 \`${branch.name}\`（对比基线 \`${compareBase}\`）进行分析：`,
    `- 来源状态：${sourceLabel(branch.source)}${branch.sha ? ` · 最新提交 \`${branch.sha.slice(0, 7)}\`` : ""}`,
  ];
  if (branch.open_pr) {
    lines.push(
      `- 关联 PR：#${branch.open_pr.number} ${branch.open_pr.title}（目标 \`${branch.open_pr.base_ref}\`）`,
    );
  }
  if (branch.linked_tasks.length > 0) {
    lines.push(
      `- 关联工单：${branch.linked_tasks.map((t) => `${taskCode(t.number)} ${t.title}`).join("；")}`,
    );
  }
  return lines.join("\n");
}

export function RepoBranchesPanel({
  project,
  repo,
  mirror,
  repoSyncing,
  overview,
  overviewLoading,
  overviewError,
  mobilePane,
  onMobilePaneChange,
  onRefresh,
  onBrowseBranchCode,
  onSelectTask,
  onOpenChatWithContext,
}: RepoBranchesPanelProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BranchFilter>("all");
  const [selectedBranchName, setSelectedBranchName] = useState("");
  const [detail, setDetail] = useState<RepoBranchDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const detailCacheRef = useRef<Map<string, RepoBranchDetailPayload>>(new Map());
  const detailSeqRef = useRef(0);

  useEffect(() => {
    setQuery("");
    setFilter("all");
    setSelectedBranchName("");
    setDetail(null);
    setDetailError("");
    detailCacheRef.current.clear();
  }, [project.id, repo]);

  useEffect(() => {
    if (overviewLoading) return;
    detailCacheRef.current.clear();
  }, [overview?.fetched_at, overviewLoading]);

  const branches = overview?.branches ?? [];

  const filteredBranches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return branches.filter((b) => {
      if (filter === "remote" && b.source === "local") return false;
      if (filter === "local_only" && b.source !== "local") return false;
      if (filter === "pr" && !b.open_pr) return false;
      if (filter === "task" && b.linked_tasks.length === 0) return false;
      if (!q) return true;
      if (b.name.toLowerCase().includes(q)) return true;
      if (b.sha.toLowerCase().includes(q)) return true;
      if (b.subject.toLowerCase().includes(q)) return true;
      if (b.open_pr && (`#${b.open_pr.number}`.includes(q) || b.open_pr.title.toLowerCase().includes(q))) {
        return true;
      }
      if (
        b.linked_tasks.some(
          (t) =>
            taskCode(t.number).toLowerCase().includes(q) ||
            `rd-${t.number}`.includes(q) ||
            t.title.toLowerCase().includes(q),
        )
      ) {
        return true;
      }
      return false;
    });
  }, [branches, filter, query]);

  useEffect(() => {
    if (branches.length === 0) {
      setSelectedBranchName("");
      return;
    }
    const stillVisible = filteredBranches.some((b) => b.name === selectedBranchName);
    if (stillVisible) return;
    const stillInAll = branches.some((b) => b.name === selectedBranchName);
    if (stillInAll && filteredBranches.length === 0) return;
    const preferred =
      filteredBranches.find((b) => b.is_local_current) ??
      filteredBranches.find((b) => b.is_default) ??
      filteredBranches[0] ??
      branches[0];
    setSelectedBranchName(preferred?.name ?? "");
  }, [branches, filteredBranches, selectedBranchName]);

  const selectedBranch = useMemo(
    () => branches.find((b) => b.name === selectedBranchName) ?? null,
    [branches, selectedBranchName],
  );

  const compareBase = overview?.compare_base ?? "";
  const detailSource: "remote" | "local" =
    selectedBranch?.source === "local" ? "local" : "remote";

  const loadDetail = useCallback(
    async (
      branchName: string,
      source: "remote" | "local",
      base: string,
      signal?: AbortSignal,
    ) => {
      if (!project.id || !repo || !branchName) return;
      const cacheKey = `${repo}:${branchName}:${source}:${base}`;
      const cached = detailCacheRef.current.get(cacheKey);
      if (cached) {
        setDetail(cached);
        setDetailLoading(false);
        setDetailError("");
        return;
      }
      const seq = ++detailSeqRef.current;
      setDetailLoading(true);
      setDetailError("");
      try {
        const res = await api.getWorkspaceRepoBranchDetail(
          project.id,
          {
            repo,
            branch: branchName,
            source,
            base: base && base !== branchName ? base : undefined,
          },
          signal,
        );
        if (seq !== detailSeqRef.current) return;
        detailCacheRef.current.set(cacheKey, res);
        setDetail(res);
      } catch (err) {
        if (seq !== detailSeqRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setDetail(null);
        setDetailError(err instanceof Error ? err.message : "加载分支提交与差异失败");
      } finally {
        if (seq === detailSeqRef.current) {
          setDetailLoading(false);
        }
      }
    },
    [project.id, repo],
  );

  useEffect(() => {
    if (!selectedBranch) {
      setDetail(null);
      setDetailError("");
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadDetail(selectedBranch.name, detailSource, compareBase, controller.signal);
    return () => controller.abort();
  }, [selectedBranch, detailSource, compareBase, loadDetail]);

  const counts = overview?.counts ?? {
    total: branches.length,
    remote: branches.filter((b) => b.source !== "local").length,
    local_only: branches.filter((b) => b.source === "local").length,
    with_pr: branches.filter((b) => Boolean(b.open_pr)).length,
    with_task: branches.filter((b) => b.linked_tasks.length > 0).length,
  };

  const filterTabs: Array<{ id: BranchFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: counts.total },
    { id: "remote", label: "远端", count: counts.remote },
    { id: "local_only", label: "仅本机", count: counts.local_only },
    { id: "pr", label: "有 PR", count: counts.with_pr },
    { id: "task", label: "关联工单", count: counts.with_task },
  ];

  const localWorkdir = overview?.local_workdir ?? null;
  const localMismatch = Boolean(
    localWorkdir?.remote_repo &&
      repo &&
      localWorkdir.remote_repo.toLowerCase() !== repo.toLowerCase(),
  );

  if (!repo) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <EmptyState
          icon="folder-git-2"
          title="尚未绑定 GitHub 仓库"
          description="请先在项目设置中绑定至少一个 GitHub 仓库，随后即可在此查看远端分支、本机工作区状态与关联工单。"
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Top Delivery & Local Workdir Strip */}
      <div className="shrink-0 px-3.5 sm:px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]/55 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {/* Delivery baseline summary */}
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <DeliveryModeBadge mode={overview?.delivery_mode ?? project.delivery_mode} compact />
            <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--text-secondary)] px-2 py-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)]">
              <Icon name="git-branch" size={11.5} className="text-[var(--text-muted)]" />
              <span>目标分支：</span>
              <code className="font-mono text-[var(--text-primary)]">
                {overview?.target_branch ||
                  (overview?.default_branch ? `默认 (${overview.default_branch})` : "仓库默认")}
              </code>
            </span>
            <span className="hidden sm:inline-flex items-center gap-1 text-[11.5px] text-[var(--text-secondary)] px-2 py-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)]">
              <span>工作分支：</span>
              <code className="font-mono text-[var(--text-primary)]">
                {(overview?.branch_prefix || project.branch_prefix || "relaydesk")}/rd-*
              </code>
            </span>
            {overview?.html_url && (
              <a
                href={overview.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                <Icon name="github" size={12.5} />
                <span className="hidden md:inline">GitHub</span>
                <Icon name="external-link" size={11} />
              </a>
            )}
          </div>

          {/* Local Bridge workdir status */}
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            {localWorkdir ? (
              <div
                title={`本机节点：${localWorkdir.agent_name} · 目录：${localWorkdir.workdir}`}
                className="inline-flex flex-wrap items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)]"
              >
                <LivePulseDot
                  tone={localWorkdir.has_dirty_files ? "amber" : "emerald"}
                  active
                />
                <Icon name="monitor" size={12} className="text-[var(--text-muted)]" />
                <span className="font-medium text-[var(--text-primary)]">
                  {localWorkdir.agent_name}
                </span>
                <span className="text-[var(--border-strong)]">·</span>
                <code className="font-mono text-[11.5px] text-indigo-600 dark:text-indigo-400">
                  {localWorkdir.detached
                    ? `HEAD @ ${localWorkdir.head_sha || "detached"}`
                    : localWorkdir.current_branch || "未检出"}
                </code>
                {!localWorkdir.detached && localWorkdir.head_sha && (
                  <span className="font-mono text-[11px] text-[var(--text-muted)]">
                    @{localWorkdir.head_sha}
                  </span>
                )}
                {localWorkdir.has_dirty_files ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10.5px] font-medium bg-amber-500/12 text-amber-700 dark:text-amber-300 border border-amber-500/20 tabular-nums">
                    {localWorkdir.detailed
                      ? `未提交 (${localWorkdir.staged_count + localWorkdir.unstaged_count + localWorkdir.untracked_count})`
                      : "工作区有未提交改动"}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10.5px] font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">
                    工作区干净
                  </span>
                )}
                {localMismatch && (
                  <span className="text-[11px] text-amber-600 dark:text-amber-400">
                    （当前指向 {localWorkdir.remote_repo}）
                  </span>
                )}
              </div>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-muted)]">
                <Icon name="monitor" size={12} />
                本机工作区未在线绑定
              </span>
            )}
          </div>
        </div>

        {(overviewError || overview?.remote_error || overview?.prs_unavailable || localWorkdir?.error) && (
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            {(overviewError || overview?.remote_error) && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20">
                <Icon name="alert-triangle" size={12.5} />
                <span>{overviewError || overview?.remote_error}</span>
              </span>
            )}
            {overview?.prs_unavailable && !overview?.remote_error && (
              <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
                <Icon name="alert-circle" size={12} />
                <span>未能读取开放 PR（可能缺少 Pull requests 权限）</span>
              </span>
            )}
            {localWorkdir?.error && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <Icon name="alert-circle" size={12} />
                <span>本机检查提示：{localWorkdir.error}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Main Split Pane */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left: Branch List */}
        <div
          className={`${
            mobilePane === "detail" && selectedBranch ? "hidden md:flex" : "flex"
          } w-full md:w-[360px] lg:w-[400px] shrink-0 md:border-r border-[var(--border-subtle)] bg-[var(--surface-card)] flex-col min-h-0`}
        >
          <div className="shrink-0 p-2.5 border-b border-[var(--border-subtle)] space-y-2">
            <div className="relative flex items-center">
              <Icon
                name="search"
                size={13.5}
                className="absolute left-2.5 text-[var(--text-muted)] pointer-events-none"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索分支、PR、RD 工单或提交…"
                className="w-full h-8.5 pl-8 pr-7 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500"
              />
              {query && (
                <button
                  type="button"
                  aria-label="清空搜索"
                  onClick={() => setQuery("")}
                  className="absolute right-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                >
                  <Icon name="x" size={13} />
                </button>
              )}
            </div>

            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
              {filterTabs.map((item) => {
                const active = filter === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setFilter(item.id)}
                    aria-pressed={active}
                    className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer rd-press ${
                      active
                        ? "bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 border border-indigo-500/25"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] border border-transparent"
                    }`}
                  >
                    <span>{item.label}</span>
                    <span className="font-mono text-[10px] tabular-nums opacity-80">
                      {item.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto rd-scroll p-2 space-y-1">
            {overviewLoading && branches.length === 0 ? (
              <div className="py-12 flex items-center justify-center gap-2 text-[12.5px] text-[var(--text-muted)]">
                <Icon name="loader-2" size={14} className="animate-spin text-indigo-500" />
                <span>正在拉取分支列表…</span>
              </div>
            ) : filteredBranches.length === 0 ? (
              <div className="p-6 text-center space-y-2">
                <p className="text-[12.5px] text-[var(--text-muted)]">
                  {branches.length === 0
                    ? overview?.github_configured
                      ? "未读取到分支信息，请点击右上角「刷新分支」。"
                      : "尚未配置 GitHub Key，且当前无本机在线分支数据。"
                    : "没有匹配的分支"}
                </p>
                {branches.length === 0 && (
                  <Button size="xs" variant="secondary" icon="refresh-cw" onClick={onRefresh}>
                    刷新分支
                  </Button>
                )}
                {branches.length > 0 && (query || filter !== "all") && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    重置筛选
                  </Button>
                )}
              </div>
            ) : (
              filteredBranches.map((branch) => {
                const active = selectedBranch?.name === branch.name;
                return (
                  <button
                    key={branch.name}
                    type="button"
                    onClick={() => {
                      setSelectedBranchName(branch.name);
                      onMobilePaneChange("detail");
                    }}
                    className={`w-full text-left rounded-xl px-2.5 py-2 border transition-colors cursor-pointer ${
                      active
                        ? "bg-indigo-500/10 border-indigo-500/30 shadow-2xs"
                        : "border-transparent hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <Icon
                          name="git-branch"
                          size={13.5}
                          className={
                            branch.is_local_current || active
                              ? "text-indigo-500"
                              : branch.open_pr
                                ? "text-emerald-500"
                                : "text-[var(--text-muted)]"
                          }
                        />
                        <span className="font-mono text-[12.5px] font-medium text-[var(--text-primary)] truncate">
                          {branch.name}
                        </span>
                      </div>
                      {branch.committed_at && (
                        <span className="shrink-0 text-[10.5px] text-[var(--text-muted)] tabular-nums">
                          {formatRelativeTime(branch.committed_at)}
                        </span>
                      )}
                    </div>

                    {/* Status badges row */}
                    <div className="flex flex-wrap items-center gap-1 mt-1.5">
                      {branch.is_default && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-500/12 text-indigo-600 dark:text-indigo-300">
                          默认
                        </span>
                      )}
                      {branch.is_target && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/12 text-violet-600 dark:text-violet-300">
                          目标
                        </span>
                      )}
                      {branch.is_local_current && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
                          本机当前
                        </span>
                      )}
                      {branch.source === "local" && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/12 text-amber-700 dark:text-amber-300">
                          仅本机
                        </span>
                      )}
                      {branch.is_mirror_branch && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--surface-subtle)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                          镜像
                        </span>
                      )}
                      {branch.protected && (
                        <span
                          title="受保护分支"
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--surface-subtle)] text-[var(--text-muted)]"
                        >
                          <Icon name="lock" size={9.5} />
                          保护
                        </span>
                      )}
                      {branch.sha && (
                        <code className="font-mono text-[10.5px] text-[var(--text-muted)] px-1">
                          {branch.sha.slice(0, 7)}
                        </code>
                      )}
                      {(branch.ahead !== null && branch.ahead > 0) ||
                      (branch.behind !== null && branch.behind > 0) ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono tabular-nums text-[var(--text-muted)]">
                          {branch.ahead ? `↑${branch.ahead}` : ""}
                          {branch.behind ? `↓${branch.behind}` : ""}
                        </span>
                      ) : null}
                      {branch.upstream_gone && (
                        <span className="text-[10px] text-rose-500 font-medium">
                          远端已删
                        </span>
                      )}
                      {branch.open_pr && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">
                          <Icon name="git-pull-request" size={10} />
                          PR #{branch.open_pr.number}
                          {branch.open_pr.draft ? " · Draft" : ""}
                        </span>
                      )}
                      {branch.linked_tasks.map((t) => (
                        <span
                          key={t.id}
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/20"
                        >
                          {taskCode(t.number)}
                        </span>
                      ))}
                    </div>

                    {branch.subject && (
                      <div className="mt-1 text-[11.5px] text-[var(--text-muted)] truncate">
                        {branch.subject}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Branch Detail Inspector */}
        <div
          className={`${
            mobilePane === "detail" && selectedBranch ? "flex" : "hidden md:flex"
          } flex-1 flex-col min-w-0 min-h-0 bg-[var(--surface-canvas)]`}
        >
          {!selectedBranch ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <EmptyState
                icon="git-branch"
                title="选择分支查看详情"
                description="从左侧列表选择一个分支，即可查看最近提交、相对于基线的代码差异、关联 PR 与工单。"
              />
            </div>
          ) : (
            <>
              <div className="shrink-0 px-3.5 sm:px-5 py-3 border-b border-[var(--border-subtle)] bg-[var(--surface-card)] flex flex-wrap items-center justify-between gap-2.5">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                    <button
                      type="button"
                      onClick={() => onMobilePaneChange("list")}
                      className="md:hidden inline-flex items-center gap-1 h-7 px-2 -ml-1 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Icon name="arrow-left" size={13.5} />
                      <span>列表</span>
                    </button>
                    <Icon name="git-branch" size={15} className="text-indigo-500 shrink-0" />
                    <h2 className="font-mono text-[13.5px] sm:text-[14px] font-semibold text-[var(--text-primary)] truncate">
                      {selectedBranch.name}
                    </h2>
                    {selectedBranch.is_default && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10.5px] font-medium bg-indigo-500/12 text-indigo-600 dark:text-indigo-300">
                        默认分支
                      </span>
                    )}
                    {selectedBranch.is_target && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10.5px] font-medium bg-violet-500/12 text-violet-600 dark:text-violet-300">
                        目标分支
                      </span>
                    )}
                    {selectedBranch.is_local_current && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10.5px] font-medium bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
                        本机当前
                      </span>
                    )}
                    {selectedBranch.protected && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10.5px] font-medium bg-[var(--surface-subtle)] text-[var(--text-muted)]">
                        <Icon name="lock" size={10} />
                        受保护
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
                    <span>{sourceLabel(selectedBranch.source)}</span>
                    {selectedBranch.sha && (
                      <>
                        <span>·</span>
                        <code className="font-mono text-[var(--text-secondary)]">
                          {selectedBranch.sha.slice(0, 7)}
                        </code>
                      </>
                    )}
                    {selectedBranch.upstream && (
                      <>
                        <span>·</span>
                        <span className="font-mono">
                          上游 {selectedBranch.upstream}
                          {selectedBranch.upstream_gone ? "（已删除）" : ""}
                        </span>
                      </>
                    )}
                    {selectedBranch.is_mirror_branch && mirror?.commit && (
                      <>
                        <span>·</span>
                        <span className="text-indigo-600 dark:text-indigo-400">
                          服务端镜像当前分支
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  <CopyButton
                    value={selectedBranch.name}
                    label="复制分支"
                    copiedLabel="已复制"
                    size="xs"
                  />
                  {selectedBranch.source !== "local" && (
                    <Button
                      size="xs"
                      variant="secondary"
                      icon="code-2"
                      loading={repoSyncing}
                      onClick={() => onBrowseBranchCode(selectedBranch.name)}
                    >
                      {selectedBranch.is_mirror_branch ? "浏览源码" : "浏览此分支源码"}
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="primary"
                    icon="sparkles"
                    onClick={() =>
                      onOpenChatWithContext(
                        undefined,
                        buildBranchDiscussPrompt(repo, selectedBranch, compareBase),
                      )
                    }
                  >
                    在 Codex 中讨论
                  </Button>
                  {selectedBranch.github_url && (
                    <a
                      href={selectedBranch.github_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] text-[11.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      <Icon name="github" size={12.5} />
                      <span>GitHub</span>
                      <Icon name="external-link" size={11} />
                    </a>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto rd-scroll p-4 sm:p-5 space-y-4">
                {/* Open PR Card */}
                {selectedBranch.open_pr && (
                  <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] p-3.5 flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Icon name="git-pull-request" size={14} className="text-emerald-600 dark:text-emerald-400" />
                        <span className="font-mono text-[12px] font-semibold text-emerald-700 dark:text-emerald-300">
                          PR #{selectedBranch.open_pr.number}
                        </span>
                        {selectedBranch.open_pr.draft && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--surface-subtle)] text-[var(--text-muted)]">
                            Draft
                          </span>
                        )}
                        <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                          {selectedBranch.open_pr.title}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
                        <span className="font-mono">
                          {selectedBranch.name} → {selectedBranch.open_pr.base_ref}
                        </span>
                        {selectedBranch.open_pr.author && (
                          <span>· @{selectedBranch.open_pr.author}</span>
                        )}
                        {selectedBranch.open_pr.updated_at && (
                          <span>· 更新于 {formatRelativeTime(selectedBranch.open_pr.updated_at)}</span>
                        )}
                      </div>
                    </div>
                    <a
                      href={selectedBranch.open_pr.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-emerald-500/30 bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] text-[11.5px] font-medium text-emerald-700 dark:text-emerald-300 transition-colors shrink-0"
                    >
                      <span>查看 PR</span>
                      <Icon name="external-link" size={11} />
                    </a>
                  </div>
                )}

                {/* Linked Tasks Card */}
                {selectedBranch.linked_tasks.length > 0 && (
                  <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
                    <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5">
                        <Icon name="layers" size={13.5} className="text-sky-500" />
                        关联工单 ({selectedBranch.linked_tasks.length})
                      </span>
                    </div>
                    <div className="divide-y divide-[var(--border-subtle)]/70">
                      {selectedBranch.linked_tasks.map((task) => (
                        <button
                          key={task.id}
                          type="button"
                          onClick={() => onSelectTask?.(task.id)}
                          className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span className="font-mono text-[11.5px] font-semibold text-indigo-600 dark:text-indigo-400 shrink-0">
                              {taskCode(task.number)}
                            </span>
                            <StatusBadge status={task.status} compact />
                            <PriorityBadge priority={task.priority} showLabel={false} />
                            <span className="text-[12.5px] text-[var(--text-primary)] truncate">
                              {task.title}
                            </span>
                          </div>
                          {task.delivery_ref && (
                            <code className="hidden sm:inline font-mono text-[11px] text-[var(--text-muted)] max-w-[180px] truncate shrink-0">
                              {task.delivery_ref}
                            </code>
                          )}
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {/* Comparison Summary */}
                {compareBase && (
                  <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3.5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 text-[12px]">
                        <Icon name="git-merge" size={14} className="text-indigo-500" />
                        <span className="font-medium text-[var(--text-primary)]">
                          对比基线 <code className="font-mono">{compareBase}</code>
                        </span>
                        {selectedBranch.name === compareBase ? (
                          <span className="px-2 py-0.5 rounded-full text-[11px] bg-[var(--surface-subtle)] text-[var(--text-muted)]">
                            当前即交付基线分支
                          </span>
                        ) : detail?.compare ? (
                          <>
                            <span
                              className={`px-2 py-0.5 rounded-full text-[11px] font-medium tabular-nums ${
                                detail.compare.status === "identical"
                                  ? "bg-[var(--surface-subtle)] text-[var(--text-muted)]"
                                  : detail.compare.status === "ahead"
                                    ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                                    : detail.compare.status === "behind"
                                      ? "bg-amber-500/12 text-amber-700 dark:text-amber-300"
                                      : "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300"
                              }`}
                            >
                              {detail.compare.status === "identical"
                                ? "与基线一致"
                                : detail.compare.status === "ahead"
                                  ? `领先 +${detail.compare.ahead_by}`
                                  : detail.compare.status === "behind"
                                    ? `落后 -${detail.compare.behind_by}`
                                    : `领先 +${detail.compare.ahead_by} · 落后 -${detail.compare.behind_by}`}
                            </span>
                            {detail.compare.files_count > 0 && (
                              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-mono tabular-nums text-[var(--text-muted)]">
                                <span>{detail.compare.files_count} 文件</span>
                                <span className="text-emerald-600 dark:text-emerald-400">
                                  +{detail.compare.additions}
                                </span>
                                <span className="text-rose-600 dark:text-rose-400">
                                  -{detail.compare.deletions}
                                </span>
                              </span>
                            )}
                          </>
                        ) : detailLoading ? (
                          <span className="text-[11.5px] text-[var(--text-muted)]">计算差异中…</span>
                        ) : (
                          <span className="text-[11.5px] text-[var(--text-muted)]">暂无差异对比</span>
                        )}
                      </div>
                      {detail?.compare?.html_url && (
                        <a
                          href={detail.compare.html_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          <span>在 GitHub 对比</span>
                          <Icon name="external-link" size={11} />
                        </a>
                      )}
                    </div>
                  </section>
                )}

                {/* Recent Commits */}
                <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
                  <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5">
                      <Icon name="git-commit-horizontal" size={14} className="text-indigo-500" />
                      最近提交
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        detailCacheRef.current.clear();
                        void loadDetail(selectedBranch.name, detailSource, compareBase);
                      }}
                      className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                    >
                      <Icon
                        name="refresh-cw"
                        size={11}
                        className={detailLoading ? "animate-spin" : ""}
                      />
                      <span>刷新</span>
                    </button>
                  </div>

                  {detailLoading ? (
                    <div className="p-6 flex items-center justify-center gap-2 text-[12.5px] text-[var(--text-muted)]">
                      <Icon name="loader-2" size={14} className="animate-spin text-indigo-500" />
                      <span>正在加载最近提交…</span>
                    </div>
                  ) : detailError ? (
                    <div className="p-4 text-[12.5px] text-rose-500 flex items-center gap-2">
                      <Icon name="alert-circle" size={14} />
                      <span>{detailError}</span>
                    </div>
                  ) : !detail || detail.commits.length === 0 ? (
                    <div className="p-6 text-center text-[12.5px] text-[var(--text-muted)]">
                      暂无可展示的提交记录
                    </div>
                  ) : (
                    <div className="divide-y divide-[var(--border-subtle)]/70">
                      {detail.commits.map((commit) => (
                        <div
                          key={commit.sha}
                          className="px-3.5 py-2.5 flex items-start justify-between gap-3 hover:bg-[var(--surface-hover)]/60 transition-colors"
                        >
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="text-[12.5px] font-medium text-[var(--text-primary)] truncate">
                              {commit.message}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
                              <span>{commit.author_login ? `@${commit.author_login}` : commit.author_name || "未知作者"}</span>
                              {commit.date && (
                                <>
                                  <span>·</span>
                                  <span className="inline-flex items-center gap-1">
                                    <Icon name="clock" size={10.5} />
                                    {formatRelativeTime(commit.date)}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {commit.html_url ? (
                              <a
                                href={commit.html_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] hover:border-[var(--border-strong)] font-mono text-[11px] text-[var(--text-secondary)]"
                              >
                                <span>{commit.short_sha}</span>
                                <Icon name="arrow-up-right" size={10.5} />
                              </a>
                            ) : (
                              <code className="px-2 py-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] font-mono text-[11px] text-[var(--text-secondary)]">
                                {commit.short_sha}
                              </code>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Changed Files List */}
                {detail?.compare && detail.compare.files.length > 0 && (
                  <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
                    <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
                      <span className="text-[12px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5">
                        <Icon name="file-code-2" size={13.5} className="text-indigo-500" />
                        变更文件 ({detail.compare.files_count})
                      </span>
                      {detail.compare.files_count > detail.compare.files.length && (
                        <span className="text-[11px] text-[var(--text-muted)]">
                          展示前 {detail.compare.files.length} 项
                        </span>
                      )}
                    </div>
                    <div className="divide-y divide-[var(--border-subtle)]/70">
                      {detail.compare.files.map((file) => {
                        const badge = fileStatusBadge(file.status);
                        return (
                          <div
                            key={file.filename}
                            className="px-3.5 py-2 flex items-center justify-between gap-2.5 text-[12px]"
                          >
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <span
                                className={`shrink-0 inline-flex items-center justify-center w-5 h-5 rounded border font-mono text-[10.5px] font-semibold ${badge.className}`}
                              >
                                {badge.code}
                              </span>
                              <span className="font-mono text-[11.5px] text-[var(--text-primary)] truncate">
                                {file.filename}
                              </span>
                            </div>
                            <div className="shrink-0 flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
                              {file.additions > 0 && (
                                <span className="text-emerald-600 dark:text-emerald-400">
                                  +{file.additions}
                                </span>
                              )}
                              {file.deletions > 0 && (
                                <span className="text-rose-600 dark:text-rose-400">
                                  -{file.deletions}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
