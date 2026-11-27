import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import { formatRelativeTime, taskCode } from "~/lib/format.ts";
import type {
  ProjectDetail,
  RepoBranchDetailPayload,
  RepoBranchItem,
  RepoBranchesOverviewPayload,
  RepoBranchMergeStatus,
  RepoGitGraphCommit,
  RepoGitGraphPayload,
  RepoGitGraphRef,
  RepoMirrorEntry,
  TaskRecord,
} from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { SegmentedDetent } from "./MotionPrimitives.tsx";
import { RepoGitGraph } from "./RepoGitGraph.tsx";
import {
  Button,
  CopyButton,
  DeliveryModeBadge,
  EmptyState,
  LivePulseDot,
  PriorityBadge,
  StatusBadge,
} from "./ui.tsx";

type ViewMode = "graph" | "list";
type BranchFilter = "all" | "unmerged" | "merged" | "remote" | "local_only" | "pr" | "task";

interface RepoBranchesPanelProps {
  project: ProjectDetail;
  repo: string;
  mirror: RepoMirrorEntry | null;
  repoSyncing: boolean;
  overview: RepoBranchesOverviewPayload | null;
  overviewLoading: boolean;
  overviewError: string;
  graph?: RepoGitGraphPayload | null;
  graphLoading?: boolean;
  graphError?: string;
  tasks?: TaskRecord[];
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

function branchMergeStatusBadge(
  status: RepoBranchMergeStatus | undefined,
  ahead: number | null | undefined,
  behind: number | null | undefined,
): { text: string; className: string } | null {
  switch (status) {
    case "base":
      return {
        text: "基线",
        className: "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300 border-indigo-500/25",
      };
    case "merged":
      return {
        text: "已合并",
        className: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
      };
    case "ahead":
      return {
        text: `未合并 +${ahead ?? "?"}`,
        className: "bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/25",
      };
    case "diverged":
      return {
        text: `分歧 +${ahead ?? "?"}/-${behind ?? "?"}`,
        className: "bg-rose-500/12 text-rose-700 dark:text-rose-300 border-rose-500/25",
      };
    default:
      return null;
  }
}

function enrichCommitsWithOverview(
  commits: RepoGitGraphCommit[],
  branches: RepoBranchItem[],
): RepoGitGraphCommit[] {
  if (commits.length === 0) return [];
  const branchByName = new Map<string, RepoBranchItem>();
  for (const b of branches) {
    branchByName.set(b.name, b);
  }

  return commits.map((commit) => {
    const mergedRefs = new Map<string, RepoGitGraphRef>();
    for (const ref of commit.refs) {
      const key = ref.kind === "tag" ? `tag:${ref.name}` : `branch:${ref.name}`;
      const existing = mergedRefs.get(key);
      const branch = ref.kind === "tag" ? undefined : branchByName.get(ref.name);
      const enriched: RepoGitGraphRef = {
        ...ref,
        ...(existing?.is_head || ref.is_head ? { is_head: true } : {}),
        ...(existing?.kind === "local" ? { kind: "local" } : {}),
        ...(branch
          ? {
              is_default: branch.is_default,
              is_target: branch.is_target,
              merge_status: branch.merge_status,
              ahead_of_base: branch.ahead_of_base,
              behind_base: branch.behind_base,
              ...(branch.open_pr ? { open_pr_number: branch.open_pr.number } : {}),
              ...(branch.linked_tasks.length > 0
                ? { linked_task_numbers: branch.linked_tasks.map((t) => t.number) }
                : {}),
            }
          : {}),
      };
      mergedRefs.set(key, enriched);
    }

    const refs = Array.from(mergedRefs.values()).sort((a, b) => {
      if (Boolean(a.is_head) !== Boolean(b.is_head)) return a.is_head ? -1 : 1;
      if (Boolean(a.is_default) !== Boolean(b.is_default)) return a.is_default ? -1 : 1;
      if (Boolean(a.is_target) !== Boolean(b.is_target)) return a.is_target ? -1 : 1;
      if (a.kind !== b.kind) {
        if (a.kind === "tag") return 1;
        if (b.kind === "tag") return -1;
        return a.kind === "local" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return {
      ...commit,
      refs,
    };
  });
}

function extractCommitTaskNumbers(commit: RepoGitGraphCommit): number[] {
  const nums = new Set<number>();
  const scanText = (text: string) => {
    const re = /\brd-(\d+)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > 0) nums.add(n);
    }
  };
  scanText(commit.message);
  for (const ref of commit.refs) {
    scanText(ref.name);
    for (const num of ref.linked_task_numbers ?? []) {
      if (Number.isFinite(num) && num > 0) nums.add(num);
    }
  }
  return Array.from(nums).sort((a, b) => a - b);
}

function buildBranchDiscussPrompt(repo: string, branch: RepoBranchItem, compareBase: string): string {
  const lines = [
    `请帮我结合仓库 \`${repo}\` 的分支 \`${branch.name}\`（对比基线 \`${compareBase}\`）进行分析：`,
    `- 来源状态：${sourceLabel(branch.source)}${branch.sha ? ` · 最新提交 \`${branch.sha.slice(0, 7)}\`` : ""}`,
  ];
  if (branch.merge_status === "merged") {
    lines.push(`- 合并状态：已全部合并进 \`${compareBase}\``);
  } else if (branch.merge_status === "ahead") {
    lines.push(`- 合并状态：未合并（领先 \`${compareBase}\` ${branch.ahead_of_base ?? "?"} 个提交）`);
  } else if (branch.merge_status === "diverged") {
    lines.push(
      `- 合并状态：与 \`${compareBase}\` 分歧（领先 +${branch.ahead_of_base ?? "?"} · 落后 -${branch.behind_base ?? "?"}）`,
    );
  }
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

function buildCommitDiscussPrompt(
  repo: string,
  commit: RepoGitGraphCommit,
  taskNums: number[],
): string {
  const firstLine = commit.message.split("\n")[0]?.trim() || commit.short_sha;
  const lines = [
    `请帮我查看仓库 \`${repo}\` 的提交 \`${commit.short_sha}\`（${firstLine}）：`,
    `- 完整 SHA：\`${commit.sha}\``,
    `- 提交模式：${commit.parents.length >= 2 ? `合并提交（${commit.parents.length} 个父节点）` : "普通提交"}`,
  ];
  if (commit.refs.length > 0) {
    lines.push(`- 挂载分支：${commit.refs.map((r) => `\`${r.name}\``).join("、")}`);
  }
  if (taskNums.length > 0) {
    lines.push(`- 关联工单：${taskNums.map((n) => taskCode(n)).join("、")}`);
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
  graph = null,
  graphLoading = false,
  graphError = "",
  tasks = [],
  mobilePane,
  onMobilePaneChange,
  onRefresh,
  onBrowseBranchCode,
  onSelectTask,
  onOpenChatWithContext,
}: RepoBranchesPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const [compactGraph, setCompactGraph] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BranchFilter>("all");
  const [inspectorMode, setInspectorMode] = useState<"branch" | "commit">("branch");
  const [selectedBranchName, setSelectedBranchName] = useState("");
  const [selectedCommitSha, setSelectedCommitSha] = useState("");
  const [detail, setDetail] = useState<RepoBranchDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const detailCacheRef = useRef<Map<string, RepoBranchDetailPayload>>(new Map());
  const detailSeqRef = useRef(0);

  useEffect(() => {
    setQuery("");
    setFilter("all");
    setInspectorMode("branch");
    setSelectedBranchName("");
    setSelectedCommitSha("");
    setDetail(null);
    setDetailError("");
    detailCacheRef.current.clear();
  }, [project.id, repo]);

  useEffect(() => {
    if (overviewLoading) return;
    detailCacheRef.current.clear();
  }, [overview?.fetched_at, overviewLoading]);

  const branches = overview?.branches ?? [];
  const compareBase = overview?.compare_base ?? graph?.base_branch ?? "";

  const enrichedGraphCommits = useMemo(
    () => enrichCommitsWithOverview(graph?.commits ?? [], branches),
    [graph?.commits, branches],
  );

  const commitBySha = useMemo(() => {
    const map = new Map<string, RepoGitGraphCommit>();
    for (const c of enrichedGraphCommits) {
      map.set(c.sha, c);
    }
    return map;
  }, [enrichedGraphCommits]);

  const baseFirstParentSet = useMemo(
    () => new Set(graph?.base_first_parent_shas ?? []),
    [graph?.base_first_parent_shas],
  );

  const tasksByNumber = useMemo(() => {
    const map = new Map<number, TaskRecord>();
    for (const t of tasks) {
      if (!t.merged_into) map.set(t.number, t);
    }
    return map;
  }, [tasks]);

  const filteredBranches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return branches.filter((b) => {
      if (filter === "unmerged" && b.merge_status !== "ahead" && b.merge_status !== "diverged") {
        return false;
      }
      if (filter === "merged" && b.merge_status !== "merged") return false;
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

  const groupedBranches = useMemo(() => {
    const baseGroup: RepoBranchItem[] = [];
    const unmergedGroup: RepoBranchItem[] = [];
    const mergedGroup: RepoBranchItem[] = [];
    const unknownGroup: RepoBranchItem[] = [];

    for (const b of filteredBranches) {
      if (b.merge_status === "base" || (compareBase && b.name === compareBase)) {
        baseGroup.push(b);
      } else if (b.merge_status === "ahead" || b.merge_status === "diverged") {
        unmergedGroup.push(b);
      } else if (b.merge_status === "merged") {
        mergedGroup.push(b);
      } else {
        unknownGroup.push(b);
      }
    }

    return [
      { id: "base", label: "基线主干", items: baseGroup },
      { id: "unmerged", label: "未合并分支", items: unmergedGroup },
      { id: "merged", label: "已合并分支", items: mergedGroup },
      { id: "unknown", label: "状态待定", items: unknownGroup },
    ].filter((g) => g.items.length > 0);
  }, [filteredBranches, compareBase]);

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

  const selectedCommit = useMemo(
    () => (inspectorMode === "commit" ? commitBySha.get(selectedCommitSha) ?? null : null),
    [inspectorMode, commitBySha, selectedCommitSha],
  );

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

  const mergedCount =
    overview?.counts.merged ?? branches.filter((b) => b.merge_status === "merged").length;
  const unmergedCount =
    overview?.counts.unmerged ??
    branches.filter((b) => b.merge_status === "ahead" || b.merge_status === "diverged").length;

  const counts = {
    total: overview?.counts.total ?? branches.length,
    remote: overview?.counts.remote ?? branches.filter((b) => b.source !== "local").length,
    local_only: overview?.counts.local_only ?? branches.filter((b) => b.source === "local").length,
    with_pr: overview?.counts.with_pr ?? branches.filter((b) => Boolean(b.open_pr)).length,
    with_task: overview?.counts.with_task ?? branches.filter((b) => b.linked_tasks.length > 0).length,
    merged: mergedCount,
    unmerged: unmergedCount,
  };

  const filterTabs: Array<{ id: BranchFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: counts.total },
    { id: "unmerged", label: "未合并", count: counts.unmerged },
    { id: "merged", label: "已合并", count: counts.merged },
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

  const selectBranch = useCallback(
    (branchName: string) => {
      setSelectedBranchName(branchName);
      setInspectorMode("branch");
      onMobilePaneChange("detail");
    },
    [onMobilePaneChange],
  );

  const selectCommit = useCallback(
    (commit: RepoGitGraphCommit) => {
      setSelectedCommitSha(commit.sha);
      setInspectorMode("commit");
      onMobilePaneChange("detail");
    },
    [onMobilePaneChange],
  );

  const hasActiveInspector = Boolean(selectedCommit || selectedBranch);

  if (!repo) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <EmptyState
          icon="folder-git-2"
          title="尚未绑定 GitHub 仓库"
          description="请先在项目设置中绑定至少一个 GitHub 仓库，随后即可在此查看分支树形拓扑、合并状态、本机工作区与关联工单。"
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Top Delivery, Merge Overview & Local Workdir Strip */}
      <div className="shrink-0 px-3.5 sm:px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]/55 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {/* Delivery baseline & merge counters */}
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <DeliveryModeBadge mode={overview?.delivery_mode ?? project.delivery_mode} compact />
            <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--text-secondary)] px-2 py-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)]">
              <Icon name="git-branch" size={11.5} className="text-[var(--text-muted)]" />
              <span>基线分支：</span>
              <code className="font-mono text-[var(--text-primary)]">
                {compareBase ||
                  (overview?.default_branch ? `默认 (${overview.default_branch})` : "仓库默认")}
              </code>
            </span>
            <span className="hidden lg:inline-flex items-center gap-1 text-[11.5px] text-[var(--text-secondary)] px-2 py-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)]">
              <span>工作分支：</span>
              <code className="font-mono text-[var(--text-primary)]">
                {(overview?.branch_prefix || project.branch_prefix || "relaydesk")}/rd-*
              </code>
            </span>

            {/* Clickable merge status summary pills */}
            <button
              type="button"
              onClick={() => {
                setViewMode("list");
                setFilter("unmerged");
                setInspectorMode("branch");
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/12 text-amber-700 dark:text-amber-300 border border-amber-500/25 hover:bg-amber-500/20 transition-colors cursor-pointer tabular-nums"
            >
              <span>未合并</span>
              <span className="font-mono font-semibold">{counts.unmerged}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode("list");
                setFilter("merged");
                setInspectorMode("branch");
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 hover:bg-emerald-500/20 transition-colors cursor-pointer tabular-nums"
            >
              <span>已合并</span>
              <span className="font-mono font-semibold">{counts.merged}</span>
            </button>
            {counts.with_pr > 0 && (
              <button
                type="button"
                onClick={() => {
                  setViewMode("list");
                  setFilter("pr");
                  setInspectorMode("branch");
                }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/25 hover:bg-indigo-500/18 transition-colors cursor-pointer tabular-nums"
              >
                <Icon name="git-pull-request" size={10.5} />
                <span>有 PR</span>
                <span className="font-mono font-semibold">{counts.with_pr}</span>
              </button>
            )}

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

        {(overviewError ||
          overview?.remote_error ||
          overview?.prs_unavailable ||
          graphError ||
          localWorkdir?.error) && (
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            {(overviewError || overview?.remote_error) && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20">
                <Icon name="alert-triangle" size={12.5} />
                <span>{overviewError || overview?.remote_error}</span>
              </span>
            )}
            {graphError && !overviewError && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20">
                <Icon name="alert-triangle" size={12.5} />
                <span>拓扑加载提示：{graphError}</span>
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
        {/* Left: Graph Topology or Grouped Branch List */}
        <div
          className={`${
            mobilePane === "detail" && hasActiveInspector ? "hidden md:flex" : "flex"
          } ${
            viewMode === "graph"
              ? "w-full md:w-[440px] lg:w-[520px] xl:w-[580px]"
              : "w-full md:w-[360px] lg:w-[400px]"
          } shrink-0 md:border-r border-[var(--border-subtle)] bg-[var(--surface-card)] flex-col min-h-0`}
        >
          <div className="shrink-0 p-2.5 border-b border-[var(--border-subtle)] space-y-2">
            {/* View Mode Toggle & Compact Toggle */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SegmentedDetent<ViewMode>
                size="xs"
                ariaLabel="分支展示模式"
                value={viewMode}
                onChange={(next) => {
                  setViewMode(next);
                  if (next === "list") setInspectorMode("branch");
                }}
                options={[
                  {
                    value: "graph",
                    label: "拓扑图",
                    icon: "git-merge",
                  },
                  {
                    value: "list",
                    label: "分支清单",
                    icon: "git-branch",
                    badge: counts.total || undefined,
                  },
                ]}
              />

              {viewMode === "graph" && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-pressed={compactGraph}
                    onClick={() => setCompactGraph((v) => !v)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors cursor-pointer rd-press ${
                      compactGraph
                        ? "bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 border-indigo-500/25"
                        : "bg-[var(--surface-subtle)] text-[var(--text-secondary)] border-[var(--border-subtle)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    <Icon name="chevrons-up-down" size={11} />
                    <span>精简分支树</span>
                  </button>
                  {graph && graph.commits.length > 0 && (
                    <span className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-[var(--border-subtle)]">
                      {graph.source === "local" ? "本机 Git" : "GitHub 远端"}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Search bar */}
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

            {/* Filter pills in List mode */}
            {viewMode === "list" && (
              <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
                {filterTabs.map((item) => {
                  const active = filter === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setFilter(item.id);
                        setInspectorMode("branch");
                      }}
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
            )}
          </div>

          {viewMode === "graph" ? (
            <>
              <RepoGitGraph
                commits={enrichedGraphCommits}
                baseFirstParentShas={graph?.base_first_parent_shas ?? []}
                baseBranch={compareBase}
                compact={compactGraph}
                loading={graphLoading}
                error={graphError}
                searchQuery={query}
                selectedBranchName={selectedBranchName}
                selectedCommitSha={selectedCommitSha}
                inspectorMode={inspectorMode}
                onSelectCommit={selectCommit}
                onSelectBranch={selectBranch}
                onRefresh={onRefresh}
              />
              {graph?.truncated && enrichedGraphCommits.length > 0 && (
                <div className="shrink-0 px-3 py-1.5 border-t border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                  <span>已展示最近 {enrichedGraphCommits.length} 个拓扑提交</span>
                  <button
                    type="button"
                    onClick={() => setViewMode("list")}
                    className="text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                  >
                    在分支清单查看全部分支 ({counts.total})
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 overflow-y-auto rd-scroll p-2 space-y-3">
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
                groupedBranches.map((group) => (
                  <div key={group.id} className="space-y-1">
                    <div className="px-2 py-1 flex items-center justify-between text-[11px] font-semibold text-[var(--text-muted)]">
                      <span>{group.label}</span>
                      <span className="font-mono tabular-nums">{group.items.length}</span>
                    </div>
                    {group.items.map((branch) => {
                      const active =
                        inspectorMode === "branch" && selectedBranch?.name === branch.name;
                      const mergeBadge = branchMergeStatusBadge(
                        branch.merge_status,
                        branch.ahead_of_base,
                        branch.behind_base,
                      );
                      return (
                        <button
                          key={branch.name}
                          type="button"
                          onClick={() => selectBranch(branch.name)}
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
                            {mergeBadge && (
                              <span
                                className={`px-1.5 py-0.5 rounded border text-[10px] font-medium tabular-nums ${mergeBadge.className}`}
                              >
                                {mergeBadge.text}
                              </span>
                            )}
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
                    })}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Right: Dual-Mode Inspector (Commit Node OR Branch Detail) */}
        <div
          className={`${
            mobilePane === "detail" && hasActiveInspector ? "flex" : "hidden md:flex"
          } flex-1 flex-col min-w-0 min-h-0 bg-[var(--surface-canvas)]`}
        >
          {selectedCommit ? (() => {
            const lines = selectedCommit.message.split("\n");
            const firstLine = lines[0]?.trim() || "(无提交说明)";
            const bodyText = lines.slice(1).join("\n").trim();
            const taskNumbers = extractCommitTaskNumbers(selectedCommit);
            const isBaseCommit = baseFirstParentSet.has(selectedCommit.sha);
            const isMergeCommit = selectedCommit.parents.length >= 2;

            return (
              <>
                <div className="shrink-0 px-3.5 sm:px-5 py-3 border-b border-[var(--border-subtle)] bg-[var(--surface-card)] flex flex-wrap items-center justify-between gap-2.5">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <button
                        type="button"
                        onClick={() => onMobilePaneChange("list")}
                        className="md:hidden inline-flex items-center gap-1 h-7 px-2 -ml-1 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] cursor-pointer"
                      >
                        <Icon name="arrow-left" size={13.5} />
                        <span>返回</span>
                      </button>
                      <Icon
                        name={isMergeCommit ? "git-merge" : "git-commit-horizontal"}
                        size={15}
                        className="text-indigo-500 shrink-0"
                      />
                      <code className="font-mono text-[12.5px] font-semibold px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[var(--text-primary)]">
                        {selectedCommit.short_sha}
                      </code>
                      {isMergeCommit && (
                        <span className="px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-violet-500/12 text-violet-700 dark:text-violet-300 border border-violet-500/25">
                          合并提交 · {selectedCommit.parents.length} 父节点
                        </span>
                      )}
                      {isBaseCommit && compareBase && (
                        <span className="px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-indigo-500/12 text-indigo-700 dark:text-indigo-300 border border-indigo-500/25">
                          主干提交 ({compareBase})
                        </span>
                      )}
                    </div>
                    <h2 className="text-[13.5px] sm:text-[14px] font-semibold text-[var(--text-primary)] break-words">
                      {firstLine}
                    </h2>
                    <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
                      <span>
                        {selectedCommit.author_login
                          ? `@${selectedCommit.author_login} (${selectedCommit.author_name})`
                          : selectedCommit.author_name || "未知作者"}
                      </span>
                      {selectedCommit.date && (
                        <>
                          <span>·</span>
                          <span className="inline-flex items-center gap-1">
                            <Icon name="clock" size={11} />
                            <span>{formatRelativeTime(selectedCommit.date)}</span>
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    {selectedBranch && (
                      <Button
                        size="xs"
                        variant="ghost"
                        icon="git-branch"
                        onClick={() => setInspectorMode("branch")}
                      >
                        返回分支详情
                      </Button>
                    )}
                    <CopyButton
                      value={selectedCommit.sha}
                      label="复制 SHA"
                      copiedLabel="已复制"
                      size="xs"
                    />
                    <Button
                      size="xs"
                      variant="primary"
                      icon="sparkles"
                      onClick={() =>
                        onOpenChatWithContext(
                          undefined,
                          buildCommitDiscussPrompt(repo, selectedCommit, taskNumbers),
                        )
                      }
                    >
                      在 Codex 中讨论
                    </Button>
                    {selectedCommit.html_url && (
                      <a
                        href={selectedCommit.html_url}
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
                  {/* Full SHA & Message Body */}
                  <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3.5 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
                      <span className="text-[var(--text-muted)]">完整提交哈希</span>
                      <code className="font-mono text-[var(--text-primary)] break-all">
                        {selectedCommit.sha}
                      </code>
                    </div>
                    {bodyText && (
                      <pre className="pt-2 border-t border-[var(--border-subtle)]/70 whitespace-pre-wrap break-words font-sans text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                        {bodyText}
                      </pre>
                    )}
                  </section>

                  {/* Branch / Tag Refs on this Commit */}
                  {selectedCommit.refs.length > 0 && (
                    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
                      <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
                        <span className="text-[12px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5">
                          <Icon name="git-branch" size={13.5} className="text-indigo-500" />
                          挂载分支与标签 ({selectedCommit.refs.length})
                        </span>
                      </div>
                      <div className="p-3 flex flex-wrap gap-2">
                        {selectedCommit.refs.map((ref) => {
                          const mergeBadge =
                            ref.kind === "tag"
                              ? null
                              : branchMergeStatusBadge(
                                  ref.merge_status,
                                  ref.ahead_of_base,
                                  ref.behind_base,
                                );
                          if (ref.kind === "tag") {
                            return (
                              <span
                                key={`inspector-tag:${ref.name}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] font-mono text-[12px] text-[var(--text-secondary)]"
                              >
                                <Icon name="layers" size={12} />
                                <span>{ref.name}</span>
                              </span>
                            );
                          }
                          return (
                            <button
                              key={`inspector-branch:${ref.name}`}
                              type="button"
                              onClick={() => selectBranch(ref.name)}
                              className="inline-flex flex-wrap items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] hover:border-indigo-500/40 hover:bg-indigo-500/[0.06] transition-colors cursor-pointer"
                            >
                              <Icon
                                name={ref.is_head ? "monitor" : "git-branch"}
                                size={12}
                                className="text-indigo-500"
                              />
                              <span className="font-mono text-[12px] font-medium text-[var(--text-primary)]">
                                {ref.name}
                              </span>
                              {mergeBadge && (
                                <span
                                  className={`px-1.5 py-0.5 rounded border text-[10px] font-medium tabular-nums ${mergeBadge.className}`}
                                >
                                  {mergeBadge.text}
                                </span>
                              )}
                              {ref.open_pr_number && (
                                <span className="font-mono text-[10.5px] text-emerald-600 dark:text-emerald-400">
                                  PR #{ref.open_pr_number}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {/* Parent Commits Tree Lineage */}
                  <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
                    <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5">
                        <Icon name="git-merge" size={13.5} className="text-indigo-500" />
                        父节点血缘 ({selectedCommit.parents.length})
                      </span>
                    </div>
                    {selectedCommit.parents.length === 0 ? (
                      <div className="p-3.5 text-[12px] text-[var(--text-muted)]">
                        根提交（无父节点）
                      </div>
                    ) : (
                      <div className="divide-y divide-[var(--border-subtle)]/70">
                        {selectedCommit.parents.map((pSha, idx) => {
                          const parentCommit = commitBySha.get(pSha);
                          const parentSubject =
                            parentCommit?.message.split("\n")[0]?.trim() || "";
                          const roleLabel =
                            idx === 0
                              ? isMergeCommit
                                ? "主线父提交 (P1)"
                                : "父提交"
                              : `合入分支父提交 (P${idx + 1})`;
                          return (
                            <div
                              key={pSha}
                              className="px-3.5 py-2.5 flex items-center justify-between gap-2.5"
                            >
                              <div className="min-w-0 flex-1 space-y-0.5">
                                <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                                  <span>{roleLabel}</span>
                                </div>
                                {parentCommit ? (
                                  <button
                                    type="button"
                                    onClick={() => selectCommit(parentCommit)}
                                    className="w-full text-left flex items-center gap-2 text-[12.5px] text-[var(--text-primary)] hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors cursor-pointer"
                                  >
                                    <code className="shrink-0 font-mono text-[11.5px] px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] border border-[var(--border-subtle)]">
                                      {parentCommit.short_sha}
                                    </code>
                                    <span className="truncate font-medium">
                                      {parentSubject || parentCommit.short_sha}
                                    </span>
                                  </button>
                                ) : (
                                  <div className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                                    <code className="font-mono text-[11.5px] px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] border border-[var(--border-subtle)]">
                                      {pSha.slice(0, 7)}
                                    </code>
                                    <span className="text-[11px] text-[var(--text-muted)]">
                                      超出当前图谱窗口
                                    </span>
                                  </div>
                                )}
                              </div>
                              <CopyButton value={pSha} label="复制" copiedLabel="已复制" size="xs" />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/* Parsed Linked Tasks from Commit Message / Refs */}
                  {taskNumbers.length > 0 && (
                    <section className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
                      <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)]">
                        <span className="text-[12px] font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5">
                          <Icon name="layers" size={13.5} className="text-sky-500" />
                          识别关联工单 ({taskNumbers.length})
                        </span>
                      </div>
                      <div className="divide-y divide-[var(--border-subtle)]/70">
                        {taskNumbers.map((num) => {
                          const task = tasksByNumber.get(num);
                          if (!task) {
                            return (
                              <div
                                key={num}
                                className="px-3.5 py-2.5 flex items-center gap-2 text-[12px]"
                              >
                                <span className="font-mono font-semibold text-sky-600 dark:text-sky-400">
                                  {taskCode(num)}
                                </span>
                                <span className="text-[var(--text-muted)]">提交引用</span>
                              </div>
                            );
                          }
                          return (
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
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )}
                </div>
              </>
            );
          })() : !selectedBranch ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <EmptyState
                icon="git-branch"
                title="选择分支或提交查看详情"
                description="点击左侧树形拓扑图中的提交节点或分支胶囊，即可查看合并状态、父节点血缘、代码差异与关联工单。"
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
                      <span>返回</span>
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
                {/* Prominent Merge Status Card */}
                {compareBase && (
                  <section
                    className={`rounded-xl border px-3.5 py-3 flex flex-wrap items-center justify-between gap-2.5 ${
                      selectedBranch.merge_status === "merged"
                        ? "border-emerald-500/25 bg-emerald-500/[0.06]"
                        : selectedBranch.merge_status === "ahead"
                          ? "border-amber-500/25 bg-amber-500/[0.06]"
                          : selectedBranch.merge_status === "diverged"
                            ? "border-rose-500/25 bg-rose-500/[0.06]"
                            : "border-[var(--border-subtle)] bg-[var(--surface-card)]"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Icon
                        name={
                          selectedBranch.merge_status === "merged"
                            ? "check-circle-2"
                            : selectedBranch.merge_status === "diverged"
                              ? "alert-triangle"
                              : "git-merge"
                        }
                        size={16}
                        className={
                          selectedBranch.merge_status === "merged"
                            ? "text-emerald-600 dark:text-emerald-400 shrink-0"
                            : selectedBranch.merge_status === "ahead"
                              ? "text-amber-600 dark:text-amber-400 shrink-0"
                              : selectedBranch.merge_status === "diverged"
                                ? "text-rose-600 dark:text-rose-400 shrink-0"
                                : "text-indigo-500 shrink-0"
                        }
                      />
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                          {selectedBranch.merge_status === "base" || selectedBranch.name === compareBase
                            ? `当前即交付基线分支 (${compareBase})`
                            : selectedBranch.merge_status === "merged"
                              ? `已全部合并进 ${compareBase}`
                              : selectedBranch.merge_status === "ahead"
                                ? `尚未合并到 ${compareBase}（领先 ${selectedBranch.ahead_of_base ?? "?"} 个提交）`
                                : selectedBranch.merge_status === "diverged"
                                  ? `与 ${compareBase} 分歧（领先 +${selectedBranch.ahead_of_base ?? "?"} · 落后 -${selectedBranch.behind_base ?? "?"}）`
                                  : `正在对比基线 ${compareBase}`}
                        </div>
                        <div className="text-[11.5px] text-[var(--text-muted)]">
                          {selectedBranch.merge_status === "merged"
                            ? selectedBranch.behind_base
                              ? `全部提交已合入基线；基线后续新增 ${selectedBranch.behind_base} 个提交`
                              : "该分支的所有提交均已成为基线祖先"
                            : selectedBranch.merge_status === "ahead" ||
                                selectedBranch.merge_status === "diverged"
                              ? selectedBranch.open_pr
                                ? `已开启 PR #${selectedBranch.open_pr.number} 等待合并`
                                : "尚有独有提交未合入基线"
                              : selectedBranch.merge_status === "base"
                                ? "其他分支均以此基线对比是否已合并"
                                : "展开下方对比详情或刷新以获取合并计数"}
                        </div>
                      </div>
                    </div>
                  </section>
                )}

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
                      {detail.commits.map((commit) => {
                        const graphMatch = commitBySha.get(commit.sha);
                        return (
                          <div
                            key={commit.sha}
                            className="px-3.5 py-2.5 flex items-start justify-between gap-3 hover:bg-[var(--surface-hover)]/60 transition-colors"
                          >
                            <div className="min-w-0 flex-1 space-y-0.5">
                              {graphMatch ? (
                                <button
                                  type="button"
                                  onClick={() => selectCommit(graphMatch)}
                                  className="text-left text-[12.5px] font-medium text-[var(--text-primary)] hover:text-indigo-600 dark:hover:text-indigo-400 truncate block w-full cursor-pointer"
                                >
                                  {commit.message}
                                </button>
                              ) : (
                                <div className="text-[12.5px] font-medium text-[var(--text-primary)] truncate">
                                  {commit.message}
                                </div>
                              )}
                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
                                <span>
                                  {commit.author_login
                                    ? `@${commit.author_login}`
                                    : commit.author_name || "未知作者"}
                                </span>
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
                        );
                      })}
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
