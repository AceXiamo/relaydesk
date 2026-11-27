import type { RepoGitGraphCommit } from "~/lib/types.ts";

export const GIT_GRAPH_LANE_COLORS = [
  "#6366f1", // Lane 0: indigo (base trunk)
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ec4899", // pink
  "#0ea5e9", // sky
  "#8b5cf6", // violet
  "#f97316", // orange
  "#14b8a6", // teal
] as const;

export interface GitGraphPassingLane {
  col: number;
  colorIndex: number;
}

export interface GitGraphEdge {
  fromCol: number;
  toCol: number;
  colorIndex: number;
  isMergeParent?: boolean;
}

export interface GitGraphLayoutRow {
  rowIndex: number;
  commit: RepoGitGraphCommit;
  col: number;
  colorIndex: number;
  isMerge: boolean;
  isBaseTrunk: boolean;
  isHead: boolean;
  passingLanes: GitGraphPassingLane[];
  topEdges: GitGraphEdge[];
  bottomEdges: GitGraphEdge[];
  maxActiveCol: number;
}

export interface GitGraphLayout {
  rows: GitGraphLayoutRow[];
  maxLane: number;
}

export type GitGraphDisplayItem =
  | { kind: "commit"; row: GitGraphLayoutRow }
  | {
      kind: "collapsed";
      key: string;
      count: number;
      col: number;
      colorIndex: number;
      passingLanes: GitGraphPassingLane[];
      commits: RepoGitGraphCommit[];
    };

export function computeGitGraphLayout(
  commits: ReadonlyArray<RepoGitGraphCommit>,
  baseFirstParentShas: ReadonlyArray<string>,
): GitGraphLayout {
  if (commits.length === 0) {
    return { rows: [], maxLane: 0 };
  }

  const baseSet = new Set(baseFirstParentShas);
  const reserveLaneZero = baseSet.size > 0;
  const lanes: Array<string | null> = [];
  const laneColors: number[] = [];
  let branchColorSeq = 0;

  const nextBranchColor = () => {
    const idx = 1 + (branchColorSeq % (GIT_GRAPH_LANE_COLORS.length - 1));
    branchColorSeq += 1;
    return idx;
  };

  const ensureLaneSlots = (targetLen: number) => {
    while (lanes.length < targetLen) {
      lanes.push(null);
      laneColors.push(0);
    }
  };

  const allocFreeLane = (minCol: number): number => {
    ensureLaneSlots(minCol);
    for (let i = minCol; i < lanes.length; i += 1) {
      if (lanes[i] === null) return i;
    }
    lanes.push(null);
    laneColors.push(0);
    return lanes.length - 1;
  };

  const trimTrailingNulls = () => {
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      laneColors.pop();
    }
  };

  const rows: GitGraphLayoutRow[] = [];
  let maxLane = 0;

  for (let rowIndex = 0; rowIndex < commits.length; rowIndex += 1) {
    const commit = commits[rowIndex];
    const isBaseTrunk = baseSet.has(commit.sha);
    const matchingCols: number[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] === commit.sha) {
        matchingCols.push(i);
      }
    }

    let col: number;
    if (isBaseTrunk && (matchingCols.includes(0) || lanes[0] === null || lanes.length === 0)) {
      ensureLaneSlots(1);
      col = 0;
    } else if (matchingCols.length > 0) {
      col = matchingCols[0];
    } else {
      col = allocFreeLane(reserveLaneZero && !isBaseTrunk ? 1 : 0);
    }

    const matchingSet = new Set(matchingCols);
    const passingLanes: GitGraphPassingLane[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (i === col || matchingSet.has(i) || lanes[i] === null) continue;
      passingLanes.push({ col: i, colorIndex: laneColors[i] ?? 0 });
    }

    const nodeColor =
      col === 0 || isBaseTrunk
        ? 0
        : matchingSet.has(col) && (laneColors[col] ?? 0) !== 0
          ? laneColors[col]!
          : nextBranchColor();
    laneColors[col] = nodeColor;

    const topEdges: GitGraphEdge[] = [];
    for (const incomingCol of matchingCols) {
      topEdges.push({
        fromCol: incomingCol,
        toCol: col,
        colorIndex: incomingCol === col ? nodeColor : (laneColors[incomingCol] ?? nodeColor),
      });
      if (incomingCol !== col) {
        lanes[incomingCol] = null;
      }
    }

    const parents = commit.parents.filter(Boolean);
    const bottomEdges: GitGraphEdge[] = [];
    if (parents.length === 0) {
      lanes[col] = null;
    } else {
      const p0 = parents[0];
      const existingP0Col = lanes.findIndex((sha, idx) => idx !== col && sha === p0);
      if (existingP0Col !== -1 && !isBaseTrunk) {
        lanes[col] = null;
        bottomEdges.push({
          fromCol: col,
          toCol: existingP0Col,
          colorIndex: nodeColor,
        });
      } else {
        lanes[col] = p0;
        laneColors[col] = nodeColor;
        bottomEdges.push({
          fromCol: col,
          toCol: col,
          colorIndex: nodeColor,
        });
      }

      for (let pIdx = 1; pIdx < parents.length; pIdx += 1) {
        const pSha = parents[pIdx];
        const existingCol = lanes.findIndex((sha) => sha === pSha);
        if (existingCol !== -1) {
          bottomEdges.push({
            fromCol: col,
            toCol: existingCol,
            colorIndex: laneColors[existingCol] || nextBranchColor(),
            isMergeParent: true,
          });
        } else {
          const targetCol = allocFreeLane(1);
          const edgeColor = nextBranchColor();
          lanes[targetCol] = pSha;
          laneColors[targetCol] = edgeColor;
          bottomEdges.push({
            fromCol: col,
            toCol: targetCol,
            colorIndex: edgeColor,
            isMergeParent: true,
          });
        }
      }
    }

    let rowMaxCol = col;
    for (const p of passingLanes) rowMaxCol = Math.max(rowMaxCol, p.col);
    for (const e of topEdges) rowMaxCol = Math.max(rowMaxCol, e.fromCol, e.toCol);
    for (const e of bottomEdges) rowMaxCol = Math.max(rowMaxCol, e.fromCol, e.toCol);
    maxLane = Math.max(maxLane, rowMaxCol);

    rows.push({
      rowIndex,
      commit,
      col,
      colorIndex: nodeColor,
      isMerge: parents.length >= 2,
      isBaseTrunk,
      isHead: commit.refs.some((r) => r.is_head),
      passingLanes,
      topEdges,
      bottomEdges,
      maxActiveCol: rowMaxCol,
    });

    trimTrailingNulls();
  }

  return { rows, maxLane };
}

function isStraightCollapsibleRow(
  row: GitGraphLayoutRow,
  totalRows: number,
  matchCommit?: (commit: RepoGitGraphCommit) => boolean,
): boolean {
  if (row.rowIndex === 0 || row.rowIndex === totalRows - 1) return false;
  if (row.commit.refs.length > 0) return false;
  if (row.isMerge) return false;
  if (row.topEdges.length !== 1 || row.bottomEdges.length !== 1) return false;
  const top = row.topEdges[0];
  const bot = row.bottomEdges[0];
  if (top.fromCol !== row.col || top.toCol !== row.col) return false;
  if (bot.fromCol !== row.col || bot.toCol !== row.col) return false;
  if (matchCommit?.(row.commit)) return false;
  return true;
}

function rowLaneSignature(row: GitGraphLayoutRow): string {
  const pass = row.passingLanes.map((p) => `${p.col}:${p.colorIndex}`).join(",");
  return `${row.col}:${row.colorIndex}|${pass}`;
}

export function buildDisplayGraphItems(
  rows: ReadonlyArray<GitGraphLayoutRow>,
  expandedRunKeys: ReadonlySet<string>,
  options: {
    compact: boolean;
    matchCommit?: (commit: RepoGitGraphCommit) => boolean;
  },
): GitGraphDisplayItem[] {
  if (!options.compact || rows.length === 0) {
    return rows.map((row) => ({ kind: "commit", row }));
  }

  const items: GitGraphDisplayItem[] = [];
  let i = 0;
  while (i < rows.length) {
    const first = rows[i];
    if (!isStraightCollapsibleRow(first, rows.length, options.matchCommit)) {
      items.push({ kind: "commit", row: first });
      i += 1;
      continue;
    }

    const sig = rowLaneSignature(first);
    let j = i + 1;
    while (
      j < rows.length &&
      isStraightCollapsibleRow(rows[j], rows.length, options.matchCommit) &&
      rowLaneSignature(rows[j]) === sig
    ) {
      j += 1;
    }

    const runLen = j - i;
    const key = `run:${first.commit.sha}:${rows[j - 1].commit.sha}`;
    if (runLen >= 3 && !expandedRunKeys.has(key)) {
      items.push({
        kind: "collapsed",
        key,
        count: runLen,
        col: first.col,
        colorIndex: first.colorIndex,
        passingLanes: first.passingLanes,
        commits: rows.slice(i, j).map((r) => r.commit),
      });
    } else {
      for (let k = i; k < j; k += 1) {
        items.push({ kind: "commit", row: rows[k] });
      }
    }
    i = j;
  }

  return items;
}
