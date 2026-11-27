import { describe, expect, it } from "vitest";
import {
  buildDisplayGraphItems,
  computeGitGraphLayout,
} from "../app/lib/git-graph-layout.ts";
import type { RepoGitGraphCommit } from "../app/lib/types.ts";

function makeCommit(
  sha: string,
  parents: string[],
  overrides: Partial<RepoGitGraphCommit> = {},
): RepoGitGraphCommit {
  return {
    sha,
    short_sha: sha.slice(0, 7),
    parents,
    message: `commit ${sha}`,
    author_name: "Alice",
    date: "2026-11-27T12:00:00Z",
    refs: [],
    ...overrides,
  };
}

describe("git graph layout engine", () => {
  it("pins base first-parent commits to lane 0, assigns side branches to lane >= 1, and connects 2-parent merge edges", () => {
    // Topology (child before parent):
    //   m2 (main, parents: [c3, f2])  <- merge commit on trunk
    //   c3 (parents: [c1])            <- trunk
    //   f2 (feat/x, parents: [f1])    <- feature branch head
    //   f1 (parents: [c1])            <- branched off c1
    //   c1 (parents: [])              <- common base
    const commits: RepoGitGraphCommit[] = [
      makeCommit("m2", ["c3", "f2"], {
        message: "Merge pull request #12 from feat/x",
        refs: [{ name: "main", kind: "remote", is_default: true, merge_status: "base" }],
      }),
      makeCommit("c3", ["c1"]),
      makeCommit("f2", ["f1"], {
        refs: [{ name: "feat/x", kind: "remote", merge_status: "merged" }],
      }),
      makeCommit("f1", ["c1"]),
      makeCommit("c1", []),
    ];

    const layout = computeGitGraphLayout(commits, ["m2", "c3", "c1"]);
    const bySha = new Map(layout.rows.map((r) => [r.commit.sha, r]));

    expect(bySha.get("m2")!.col).toBe(0);
    expect(bySha.get("m2")!.colorIndex).toBe(0);
    expect(bySha.get("m2")!.isBaseTrunk).toBe(true);
    expect(bySha.get("m2")!.isMerge).toBe(true);
    expect(bySha.get("m2")!.bottomEdges).toHaveLength(2);
    expect(bySha.get("m2")!.bottomEdges[0]).toMatchObject({ fromCol: 0, toCol: 0 });
    expect(bySha.get("m2")!.bottomEdges[1]).toMatchObject({
      fromCol: 0,
      toCol: 1,
      isMergeParent: true,
    });

    expect(bySha.get("c3")!.col).toBe(0);
    expect(bySha.get("c3")!.passingLanes.map((p) => p.col)).toContain(1);

    expect(bySha.get("f2")!.col).toBe(1);
    expect(bySha.get("f2")!.isBaseTrunk).toBe(false);
    expect(bySha.get("f2")!.colorIndex).toBeGreaterThanOrEqual(1);
    expect(bySha.get("f2")!.passingLanes.map((p) => p.col)).toContain(0);

    expect(bySha.get("f1")!.col).toBe(1);
    // f1's first parent c1 is already awaited on lane 0, so edge curves back to col 0
    expect(bySha.get("f1")!.bottomEdges).toEqual([
      expect.objectContaining({ fromCol: 1, toCol: 0 }),
    ]);

    expect(bySha.get("c1")!.col).toBe(0);
    // f1 already merged back into lane 0 on its bottomEdge, leaving only lane 0 entering c1
    expect(bySha.get("c1")!.topEdges.map((e) => e.fromCol)).toEqual([0]);
  });

  it("allocates separate lanes for active unmerged feature branches alongside trunk", () => {
    const commits: RepoGitGraphCommit[] = [
      makeCommit("u2", ["u1"], {
        refs: [{ name: "feat/wip", kind: "local", is_head: true, merge_status: "ahead", ahead_of_base: 2 }],
      }),
      makeCommit("u1", ["c1"]),
      makeCommit("c2", ["c1"], {
        refs: [{ name: "main", kind: "remote", is_default: true, merge_status: "base" }],
      }),
      makeCommit("c1", []),
    ];

    const layout = computeGitGraphLayout(commits, ["c2", "c1"]);
    const bySha = new Map(layout.rows.map((r) => [r.commit.sha, r]));

    expect(bySha.get("u2")!.col).toBeGreaterThanOrEqual(1);
    expect(bySha.get("u1")!.col).toBe(bySha.get("u2")!.col);
    expect(bySha.get("c2")!.col).toBe(0);
    expect(bySha.get("c1")!.col).toBe(0);
    expect(bySha.get("c1")!.topEdges.length).toBe(2);
  });

  it("collapses runs of >= 3 straight commits in compact mode and honors expanded keys & search matches", () => {
    const commits: RepoGitGraphCommit[] = [
      makeCommit("c5", ["c4"], {
        refs: [{ name: "main", kind: "remote", is_default: true }],
      }),
      makeCommit("c4", ["c3"]),
      makeCommit("c3", ["c2"]),
      makeCommit("c2", ["c1"]),
      makeCommit("c1", ["c0"]),
      makeCommit("c0", []),
    ];

    const layout = computeGitGraphLayout(
      commits,
      commits.map((c) => c.sha),
    );

    const collapsed = buildDisplayGraphItems(layout.rows, new Set(), { compact: true });
    expect(collapsed).toHaveLength(3);
    expect(collapsed[0]).toMatchObject({ kind: "commit", row: { commit: { sha: "c5" } } });
    expect(collapsed[1]).toMatchObject({ kind: "collapsed", count: 4 });
    expect(collapsed[2]).toMatchObject({ kind: "commit", row: { commit: { sha: "c0" } } });

    const collapsedKey = collapsed[1].kind === "collapsed" ? collapsed[1].key : "";
    const expanded = buildDisplayGraphItems(layout.rows, new Set([collapsedKey]), {
      compact: true,
    });
    expect(expanded).toHaveLength(6);
    expect(expanded.every((i) => i.kind === "commit")).toBe(true);

    // Search/selection match keeps c3 uncollapsed while collapsing nothing short (< 3)
    const matched = buildDisplayGraphItems(layout.rows, new Set(), {
      compact: true,
      matchCommit: (c) => c.sha === "c3",
    });
    expect(matched.some((i) => i.kind === "commit" && i.row.commit.sha === "c3")).toBe(true);
    expect(matched.some((i) => i.kind === "collapsed")).toBe(false);
  });
});
