import { useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeTime } from "~/lib/format.ts";
import {
  buildDisplayGraphItems,
  computeGitGraphLayout,
  GIT_GRAPH_LANE_COLORS,
  type GitGraphLayoutRow,
} from "~/lib/git-graph-layout.ts";
import type {
  RepoBranchMergeStatus,
  RepoGitGraphCommit,
  RepoGitGraphRef,
} from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { EmptyState } from "./ui.tsx";

export interface RepoGitGraphProps {
  commits: RepoGitGraphCommit[];
  baseFirstParentShas: string[];
  baseBranch: string;
  compact: boolean;
  loading?: boolean;
  error?: string;
  searchQuery?: string;
  selectedBranchName?: string;
  selectedCommitSha?: string;
  inspectorMode: "branch" | "commit";
  onSelectCommit: (commit: RepoGitGraphCommit) => void;
  onSelectBranch: (branchName: string) => void;
  onRefresh?: () => void;
}

const ROW_HEIGHT = 54;
const COLLAPSED_HEIGHT = 32;
const LANE_WIDTH = 18;
const PADDING_X = 12;

function laneColor(colorIndex: number): string {
  return GIT_GRAPH_LANE_COLORS[Math.abs(colorIndex) % GIT_GRAPH_LANE_COLORS.length]!;
}

function laneX(col: number, laneWidth: number = LANE_WIDTH): number {
  return PADDING_X + col * laneWidth + laneWidth / 2;
}

export function commitMatchesQuery(commit: RepoGitGraphCommit, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return false;
  if (commit.sha.toLowerCase().includes(q)) return true;
  if (commit.short_sha.toLowerCase().includes(q)) return true;
  if (commit.message.toLowerCase().includes(q)) return true;
  if (commit.author_name.toLowerCase().includes(q)) return true;
  if (commit.author_login?.toLowerCase().includes(q)) return true;
  for (const ref of commit.refs) {
    if (ref.name.toLowerCase().includes(q)) return true;
    if (ref.open_pr_number && (`#${ref.open_pr_number}`.includes(q) || `pr #${ref.open_pr_number}`.includes(q))) {
      return true;
    }
    if (
      ref.linked_task_numbers?.some(
        (num) => `rd-${num}`.includes(q) || `rd-${String(num).padStart(3, "0")}`.includes(q),
      )
    ) {
      return true;
    }
  }
  return false;
}

function mergeStatusBadge(
  status: RepoBranchMergeStatus | undefined,
  ahead: number | null | undefined,
  behind: number | null | undefined,
): { text: string; className: string } | null {
  switch (status) {
    case "base":
      return {
        text: "基线",
        className: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30",
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

function refPillAppearance(
  ref: RepoGitGraphRef,
  activeBranchName: string | undefined,
): string {
  const isSelected = Boolean(activeBranchName && ref.kind !== "tag" && ref.name === activeBranchName);
  if (isSelected) {
    return "bg-indigo-600 text-white border-indigo-600 shadow-2xs";
  }
  if (ref.kind === "tag") {
    return "bg-[var(--surface-subtle)] text-[var(--text-secondary)] border-[var(--border-subtle)]";
  }
  if (ref.is_head) {
    return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
  }
  if (ref.is_default || ref.is_target || ref.merge_status === "base") {
    return "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300 border-indigo-500/25";
  }
  if (ref.merge_status === "merged") {
    return "bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300 border-emerald-500/20";
  }
  if (ref.merge_status === "ahead" || ref.merge_status === "diverged") {
    return "bg-amber-500/[0.08] text-amber-700 dark:text-amber-300 border-amber-500/25";
  }
  return "bg-[var(--surface-subtle)] text-[var(--text-primary)] border-[var(--border-subtle)]";
}

function CommitGraphSvg({
  row,
  railWidth,
  laneWidth,
  selected,
}: {
  row: GitGraphLayoutRow;
  railWidth: number;
  laneWidth: number;
  selected: boolean;
}) {
  const cy = ROW_HEIGHT / 2;
  const cx = laneX(row.col, laneWidth);
  const nodeStroke = laneColor(row.colorIndex);

  return (
    <svg
      width={railWidth}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${railWidth} ${ROW_HEIGHT}`}
      className="shrink-0 block select-none"
      aria-hidden="true"
    >
      {/* Passing lanes from rows above to rows below */}
      {row.passingLanes.map((lane) => {
        const x = laneX(lane.col, laneWidth);
        return (
          <line
            key={`pass-${lane.col}`}
            x1={x}
            y1={0}
            x2={x}
            y2={ROW_HEIGHT}
            stroke={laneColor(lane.colorIndex)}
            strokeWidth={lane.col === 0 ? 2.5 : 2}
            strokeLinecap="round"
            opacity={0.85}
          />
        );
      })}

      {/* Incoming edges from upper half */}
      {row.topEdges.map((edge, idx) => {
        const x1 = laneX(edge.fromCol, laneWidth);
        const x2 = laneX(edge.toCol, laneWidth);
        const color = laneColor(edge.colorIndex);
        const width = edge.fromCol === 0 && edge.toCol === 0 && row.isBaseTrunk ? 2.5 : 2;
        if (edge.fromCol === edge.toCol) {
          return (
            <line
              key={`top-${idx}`}
              x1={x1}
              y1={0}
              x2={x2}
              y2={cy}
              stroke={color}
              strokeWidth={width}
            />
          );
        }
        return (
          <path
            key={`top-${idx}`}
            d={`M ${x1} 0 C ${x1} ${cy * 0.58}, ${x2} ${cy * 0.42}, ${x2} ${cy}`}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
          />
        );
      })}

      {/* Outgoing edges toward parent commits */}
      {row.bottomEdges.map((edge, idx) => {
        const x1 = laneX(edge.fromCol, laneWidth);
        const x2 = laneX(edge.toCol, laneWidth);
        const color = laneColor(edge.colorIndex);
        const width = edge.fromCol === 0 && edge.toCol === 0 && row.isBaseTrunk ? 2.5 : 2;
        if (edge.fromCol === edge.toCol) {
          return (
            <line
              key={`bot-${idx}`}
              x1={x1}
              y1={cy}
              x2={x2}
              y2={ROW_HEIGHT}
              stroke={color}
              strokeWidth={width}
            />
          );
        }
        return (
          <path
            key={`bot-${idx}`}
            d={`M ${x1} ${cy} C ${x1} ${cy + (ROW_HEIGHT - cy) * 0.44}, ${x2} ${
              cy + (ROW_HEIGHT - cy) * 0.56
            }, ${x2} ${ROW_HEIGHT}`}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
          />
        );
      })}

      {/* Active selection ring */}
      {selected && (
        <circle
          cx={cx}
          cy={cy}
          r={9}
          fill="none"
          stroke={nodeStroke}
          strokeWidth={1.5}
          opacity={0.45}
        />
      )}

      {/* Commit node */}
      {row.isMerge ? (
        <>
          <circle
            cx={cx}
            cy={cy}
            r={6.25}
            fill="var(--surface-card)"
            stroke={nodeStroke}
            strokeWidth={2.4}
          />
          <circle cx={cx} cy={cy} r={2.4} fill={nodeStroke} />
        </>
      ) : row.isHead ? (
        <>
          <circle
            cx={cx}
            cy={cy}
            r={6.25}
            fill={nodeStroke}
            stroke="var(--surface-card)"
            strokeWidth={1.8}
          />
          <circle cx={cx} cy={cy} r={2.1} fill="#ffffff" />
        </>
      ) : row.isBaseTrunk ? (
        <circle
          cx={cx}
          cy={cy}
          r={4.8}
          fill={nodeStroke}
          stroke="var(--surface-card)"
          strokeWidth={1.6}
        />
      ) : (
        <circle
          cx={cx}
          cy={cy}
          r={4.4}
          fill="var(--surface-card)"
          stroke={nodeStroke}
          strokeWidth={2.2}
        />
      )}
    </svg>
  );
}

export function RepoGitGraph({
  commits,
  baseFirstParentShas,
  baseBranch,
  compact,
  loading = false,
  error = "",
  searchQuery = "",
  selectedBranchName,
  selectedCommitSha,
  inspectorMode,
  onSelectCommit,
  onSelectBranch,
  onRefresh,
}: RepoGitGraphProps) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    setExpandedKeys(new Set());
  }, [baseBranch, commits.length > 0 ? commits[0]?.sha : ""]);

  const layout = useMemo(
    () => computeGitGraphLayout(commits, baseFirstParentShas),
    [commits, baseFirstParentShas],
  );

  const trimmedQuery = searchQuery.trim();
  const hasSearch = trimmedQuery.length > 0;

  const matchedShas = useMemo(() => {
    if (!hasSearch) return new Set<string>();
    const set = new Set<string>();
    for (const c of commits) {
      if (commitMatchesQuery(c, trimmedQuery)) set.add(c.sha);
    }
    return set;
  }, [commits, hasSearch, trimmedQuery]);

  const items = useMemo(
    () =>
      buildDisplayGraphItems(layout.rows, expandedKeys, {
        compact,
        matchCommit: (c) =>
          (inspectorMode === "commit" && c.sha === selectedCommitSha) || matchedShas.has(c.sha),
      }),
    [layout.rows, expandedKeys, compact, inspectorMode, selectedCommitSha, matchedShas],
  );

  useEffect(() => {
    if (inspectorMode !== "commit" || !selectedCommitSha) return;
    const el = rowRefs.current.get(selectedCommitSha);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [inspectorMode, selectedCommitSha]);

  if (loading && commits.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 p-8 text-[12.5px] text-[var(--text-muted)]">
        <Icon name="loader-2" size={14} className="animate-spin text-indigo-500" />
        <span>正在构建分支拓扑图…</span>
      </div>
    );
  }

  if (error && commits.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2.5 p-8 text-center">
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-amber-600 dark:text-amber-400">
          <Icon name="alert-triangle" size={14} />
          <span>{error}</span>
        </span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] text-[12px] font-medium text-[var(--text-primary)] cursor-pointer"
          >
            <Icon name="refresh-cw" size={12} />
            <span>重试加载</span>
          </button>
        )}
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <EmptyState
          icon="git-merge"
          title="暂无提交拓扑记录"
          description="尚未读取到仓库提交图谱；请确认仓库已绑定 GitHub Key 或本地 Bridge 在线。"
        />
      </div>
    );
  }

  const laneCount = Math.max(2, layout.maxLane + 1);
  const effectiveLaneWidth =
    laneCount > 10 ? Math.max(10, Math.floor((220 - PADDING_X * 2) / laneCount)) : LANE_WIDTH;
  const railWidth = PADDING_X * 2 + laneCount * effectiveLaneWidth;

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden rd-scroll divide-y divide-[var(--border-subtle)]/40">
      {hasSearch && matchedShas.size === 0 && (
        <div className="px-3 py-2 bg-amber-500/[0.06] border-b border-amber-500/20 text-[11.5px] text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
          <Icon name="search" size={12} />
          <span>未找到包含「{trimmedQuery}」的提交或分支</span>
        </div>
      )}

      {items.map((item) => {
        if (item.kind === "collapsed") {
          const lineColor = laneColor(item.colorIndex);
          const ownX = laneX(item.col, effectiveLaneWidth);
          return (
            <button
              key={item.key}
              type="button"
              onClick={() =>
                setExpandedKeys((prev) => {
                  const next = new Set(prev);
                  next.add(item.key);
                  return next;
                })
              }
              className="w-full h-[32px] flex items-center hover:bg-[var(--surface-hover)]/70 transition-colors text-left cursor-pointer group"
            >
              <svg
                width={railWidth}
                height={COLLAPSED_HEIGHT}
                viewBox={`0 0 ${railWidth} ${COLLAPSED_HEIGHT}`}
                className="shrink-0 block select-none"
                aria-hidden="true"
              >
                {item.passingLanes.map((lane) => {
                  const x = laneX(lane.col, effectiveLaneWidth);
                  return (
                    <line
                      key={`cpass-${lane.col}`}
                      x1={x}
                      y1={0}
                      x2={x}
                      y2={COLLAPSED_HEIGHT}
                      stroke={laneColor(lane.colorIndex)}
                      strokeWidth={lane.col === 0 ? 2.5 : 2}
                      opacity={0.85}
                    />
                  );
                })}
                <line
                  x1={ownX}
                  y1={0}
                  x2={ownX}
                  y2={COLLAPSED_HEIGHT}
                  stroke={lineColor}
                  strokeWidth={2}
                  strokeDasharray="3 3"
                  opacity={0.75}
                />
                <circle
                  cx={ownX}
                  cy={COLLAPSED_HEIGHT / 2}
                  r={2.5}
                  fill="var(--surface-card)"
                  stroke={lineColor}
                  strokeWidth={1.6}
                />
              </svg>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium text-[var(--text-muted)] group-hover:text-[var(--text-primary)] bg-[var(--surface-subtle)] border border-[var(--border-subtle)] tabular-nums">
                <Icon name="chevrons-up-down" size={11} />
                <span>展开 {item.count} 个中间提交</span>
              </span>
            </button>
          );
        }

        const { row } = item;
        const { commit } = row;
        const firstLine = commit.message.split("\n")[0]?.trim() || "(无提交说明)";
        const isCommitSelected = inspectorMode === "commit" && selectedCommitSha === commit.sha;
        const isBranchSelected =
          inspectorMode === "branch" &&
          Boolean(selectedBranchName) &&
          commit.refs.some((r) => r.kind !== "tag" && r.name === selectedBranchName);
        const isMatched = hasSearch && matchedShas.has(commit.sha);
        const dimmed = hasSearch && !isMatched;

        return (
          <div
            key={commit.sha}
            ref={(el) => {
              if (el) rowRefs.current.set(commit.sha, el);
              else rowRefs.current.delete(commit.sha);
            }}
            role="button"
            tabIndex={0}
            aria-selected={isCommitSelected || isBranchSelected}
            onClick={() => onSelectCommit(commit)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectCommit(commit);
              }
            }}
            className={`h-[54px] pr-2.5 flex items-center gap-1.5 transition-colors cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 ${
              isCommitSelected
                ? "bg-indigo-500/12"
                : isBranchSelected
                  ? "bg-indigo-500/[0.06]"
                  : isMatched
                    ? "bg-indigo-500/[0.05] hover:bg-indigo-500/10"
                    : "hover:bg-[var(--surface-hover)]/75"
            } ${dimmed ? "opacity-45" : ""}`}
          >
            <CommitGraphSvg
              row={row}
              railWidth={railWidth}
              laneWidth={effectiveLaneWidth}
              selected={isCommitSelected}
            />

            <div className="min-w-0 flex-1 flex flex-col justify-center gap-0.5">
              {/* Top line: ref capsules + commit summary */}
              <div className="flex items-center gap-1.5 min-w-0">
                {commit.refs.map((ref) => {
                  const statusBadge =
                    ref.kind === "tag"
                      ? null
                      : mergeStatusBadge(ref.merge_status, ref.ahead_of_base, ref.behind_base);
                  const pillCls = refPillAppearance(
                    ref,
                    inspectorMode === "branch" ? selectedBranchName : undefined,
                  );

                  if (ref.kind === "tag") {
                    return (
                      <span
                        key={`tag:${ref.name}`}
                        className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10px] font-medium ${pillCls}`}
                      >
                        <Icon name="layers" size={9.5} />
                        <span>{ref.name}</span>
                      </span>
                    );
                  }

                  return (
                    <button
                      key={`branch:${ref.name}`}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectBranch(ref.name);
                      }}
                      title={`查看分支 ${ref.name}`}
                      className={`shrink-0 inline-flex items-center gap-1 max-w-[230px] px-1.5 py-0.5 rounded border text-[10.5px] font-medium transition-colors cursor-pointer ${pillCls}`}
                    >
                      <Icon name={ref.is_head ? "monitor" : "git-branch"} size={10} />
                      <span className="font-mono truncate">{ref.name}</span>
                      {ref.is_head && (
                        <span className="text-[9.5px] opacity-85 shrink-0">本机</span>
                      )}
                      {statusBadge && (
                        <span
                          className={`shrink-0 px-1 py-0 rounded border text-[9.5px] leading-[14px] tabular-nums ${
                            selectedBranchName === ref.name && inspectorMode === "branch"
                              ? "bg-white/20 text-white border-white/30"
                              : statusBadge.className
                          }`}
                        >
                          {statusBadge.text}
                        </span>
                      )}
                      {ref.open_pr_number && (
                        <span
                          className={`shrink-0 inline-flex items-center gap-0.5 font-mono text-[9.5px] ${
                            selectedBranchName === ref.name && inspectorMode === "branch"
                              ? "text-white/90"
                              : "text-emerald-600 dark:text-emerald-400"
                          }`}
                        >
                          PR#{ref.open_pr_number}
                        </span>
                      )}
                    </button>
                  );
                })}

                <span
                  className={`min-w-0 flex-1 truncate text-[12px] ${
                    row.isMerge || commit.refs.length > 0 || row.isBaseTrunk
                      ? "font-medium text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)]"
                  }`}
                >
                  {firstLine}
                </span>
              </div>

              {/* Bottom line: merge badge, short sha, author, date, linked tasks */}
              <div className="flex items-center gap-2 min-w-0 text-[10.5px] text-[var(--text-muted)]">
                {row.isMerge && (
                  <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0 rounded bg-violet-500/12 text-violet-700 dark:text-violet-300 border border-violet-500/25 font-medium text-[9.5px] leading-[15px]">
                    <Icon name="git-merge" size={9.5} />
                    <span>合并</span>
                  </span>
                )}
                <code className="shrink-0 font-mono text-[10.5px] text-[var(--text-secondary)]">
                  {commit.short_sha}
                </code>
                <span className="truncate">
                  {commit.author_login ? `@${commit.author_login}` : commit.author_name || "未知"}
                </span>
                {commit.date && (
                  <span className="shrink-0 tabular-nums">{formatRelativeTime(commit.date)}</span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
