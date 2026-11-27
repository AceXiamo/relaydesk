import {
  DEFAULT_BRANCH_PREFIX,
  isValidGitRefName,
} from "./store.ts";
import type { GithubRepoBranchOverview } from "./github.ts";
import type {
  AgentProjectInfo,
  RepoBranchItem,
  RepoBranchLinkedTask,
  RepoBranchPullRequest,
  RepoBranchesOverviewPayload,
  RepoLocalWorkdirStatus,
  RepoMirrorEntry,
  TaskRecord,
} from "../app/lib/types.ts";

export function isSafeGitBranchQuery(value: string): boolean {
  return Boolean(value && value.length <= 160 && !value.startsWith("-") && isValidGitRefName(value));
}

function encodeRefPath(ref: string): string {
  return ref
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBranchTaskNumbers(branchName: string): Set<number> {
  const nums = new Set<number>();
  const re = /(?:^|[/._-])rd-(\d+)(?=$|[/._-])/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(branchName)) !== null) {
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > 0) {
      nums.add(n);
    }
  }
  return nums;
}

export function matchTasksForBranch(
  tasks: ReadonlyArray<TaskRecord>,
  branchName: string,
  sha: string,
  openPr: RepoBranchPullRequest | null,
  opts: { isBaseBranch: boolean },
): RepoBranchLinkedTask[] {
  const branchNums = extractBranchTaskNumbers(branchName);
  const branchLower = branchName.toLowerCase();
  const shaClean = sha.trim().toLowerCase();
  const short7 = shaClean.length >= 7 ? shaClean.slice(0, 7) : "";
  const prPathRe = openPr ? new RegExp(`/pull/${openPr.number}(?:\\b|$)`, "i") : null;
  const prTextRe = openPr ? new RegExp(`\\bPR\\s*#?${openPr.number}\\b`, "i") : null;
  const shaBoundaryRe =
    !opts.isBaseBranch && short7
      ? new RegExp(`(?:^|[^a-f0-9])${escapeRegExp(short7)}(?:$|[^a-f0-9])`, "i")
      : null;

  const matched: TaskRecord[] = [];
  for (const task of tasks) {
    if (task.merged_into) continue;

    let hit = branchNums.has(task.number);
    const ref = (task.delivery_ref || "").trim();
    const refLower = ref.toLowerCase();

    if (!hit && refLower) {
      if (refLower.startsWith(`${branchLower}@`)) {
        const refSha = refLower.slice(branchLower.length + 1).trim();
        if (!opts.isBaseBranch) {
          hit = true;
        } else if (
          refSha.length >= 6 &&
          shaClean.length >= 6 &&
          (shaClean.startsWith(refSha) || refSha.startsWith(shaClean.slice(0, 7)))
        ) {
          hit = true;
        }
      } else if (!opts.isBaseBranch && refLower === branchLower) {
        hit = true;
      }
    }

    if (!hit && openPr && ref) {
      if ((prPathRe && prPathRe.test(ref)) || (prTextRe && prTextRe.test(ref))) {
        hit = true;
      }
    }

    if (!hit && shaBoundaryRe && ref && shaBoundaryRe.test(ref)) {
      hit = true;
    }

    if (hit) {
      matched.push(task);
    }
  }

  matched.sort(
    (a, b) => b.updated_at.localeCompare(a.updated_at) || b.number - a.number,
  );

  return matched.slice(0, 5).map((task) => ({
    id: task.id,
    number: task.number,
    title: task.title,
    status: task.status,
    priority: task.priority,
    delivery_ref: task.delivery_ref,
  }));
}

export interface MergeRepoBranchesInput {
  repo: string;
  project: Pick<
    AgentProjectInfo,
    "repo" | "repos" | "delivery_mode" | "target_branch" | "branch_prefix"
  >;
  githubConfigured: boolean;
  remoteOverview: GithubRepoBranchOverview | null;
  remoteError?: string;
  mirror: RepoMirrorEntry | null;
  localWorkdir: RepoLocalWorkdirStatus | null;
  tasks: ReadonlyArray<TaskRecord>;
  fetchedAt?: string;
}

export function mergeRepoBranches(input: MergeRepoBranchesInput): RepoBranchesOverviewPayload {
  const canonicalRepo = input.remoteOverview?.repo || input.repo;
  const repoHtmlUrl =
    input.remoteOverview?.html_url || `https://github.com/${canonicalRepo}`;
  const defaultBranch = input.remoteOverview?.default_branch || "";
  const targetBranch = (input.project.target_branch || "").trim();
  const branchPrefix = (input.project.branch_prefix || "").trim() || DEFAULT_BRANCH_PREFIX;

  const projectRepoCount = input.project.repos?.length || (input.project.repo ? 1 : 0);
  const localMatchesRepo = Boolean(
    input.localWorkdir &&
      (input.localWorkdir.remote_repo
        ? input.localWorkdir.remote_repo.toLowerCase() === input.repo.toLowerCase() ||
          input.localWorkdir.remote_repo.toLowerCase() === canonicalRepo.toLowerCase()
        : projectRepoCount <= 1),
  );

  const mirrorBranch = input.mirror?.ready ? input.mirror.branch || "" : "";
  const compareBase =
    targetBranch ||
    defaultBranch ||
    (localMatchesRepo ? input.localWorkdir?.current_branch : "") ||
    "main";

  type DraftItem = {
    name: string;
    source: "both" | "remote" | "local";
    is_local_current: boolean;
    protected: boolean;
    remote_sha: string;
    local_sha: string;
    committed_at: string;
    author: string;
    subject: string;
    upstream: string;
    ahead: number | null;
    behind: number | null;
    upstream_gone: boolean;
  };

  const map = new Map<string, DraftItem>();

  for (const rb of input.remoteOverview?.branches ?? []) {
    map.set(rb.name, {
      name: rb.name,
      source: "remote",
      is_local_current: false,
      protected: rb.protected,
      remote_sha: rb.sha,
      local_sha: "",
      committed_at: "",
      author: "",
      subject: "",
      upstream: "",
      ahead: null,
      behind: null,
      upstream_gone: false,
    });
  }

  if (localMatchesRepo && input.localWorkdir) {
    for (const lb of input.localWorkdir.branches) {
      const existing = map.get(lb.name);
      if (existing) {
        existing.source = "both";
        existing.is_local_current = lb.current;
        existing.local_sha = lb.sha;
        existing.committed_at = lb.committed_at;
        existing.author = lb.author;
        existing.subject = lb.subject;
        existing.upstream = lb.upstream;
        existing.ahead = lb.ahead;
        existing.behind = lb.behind;
        existing.upstream_gone = lb.upstream_gone;
      } else {
        map.set(lb.name, {
          name: lb.name,
          source: "local",
          is_local_current: lb.current,
          protected: false,
          remote_sha: "",
          local_sha: lb.sha,
          committed_at: lb.committed_at,
          author: lb.author,
          subject: lb.subject,
          upstream: lb.upstream,
          ahead: lb.ahead,
          behind: lb.behind,
          upstream_gone: lb.upstream_gone,
        });
      }
    }

    if (
      !input.localWorkdir.detailed &&
      !input.localWorkdir.detached &&
      input.localWorkdir.current_branch
    ) {
      const curName = input.localWorkdir.current_branch;
      const existing = map.get(curName);
      if (existing) {
        existing.source = "both";
        existing.is_local_current = true;
        if (!existing.local_sha) existing.local_sha = input.localWorkdir.head_sha || "";
      } else {
        map.set(curName, {
          name: curName,
          source: "local",
          is_local_current: true,
          protected: false,
          remote_sha: "",
          local_sha: input.localWorkdir.head_sha || "",
          committed_at: "",
          author: "",
          subject: "",
          upstream: "",
          ahead: null,
          behind: null,
          upstream_gone: false,
        });
      }
    }
  }

  const branches: RepoBranchItem[] = [];
  for (const draft of map.values()) {
    const isDefault = Boolean(defaultBranch && draft.name === defaultBranch);
    const isTarget = Boolean(targetBranch && draft.name === targetBranch);
    const isMirrorBranch = Boolean(mirrorBranch && draft.name === mirrorBranch);
    const openPr = input.remoteOverview?.pulls_by_branch[draft.name] ?? null;
    const sha = draft.remote_sha || draft.local_sha || "";
    const isBaseBranch = isDefault || isTarget || draft.name === compareBase;
    const linkedTasks = matchTasksForBranch(
      input.tasks,
      draft.name,
      sha,
      openPr,
      { isBaseBranch },
    );
    const githubUrl =
      draft.source === "local" ? "" : `${repoHtmlUrl}/tree/${encodeRefPath(draft.name)}`;

    branches.push({
      name: draft.name,
      source: draft.source,
      is_default: isDefault,
      is_target: isTarget,
      is_mirror_branch: isMirrorBranch,
      is_local_current: draft.is_local_current,
      protected: draft.protected,
      remote_sha: draft.remote_sha,
      local_sha: draft.local_sha,
      sha,
      committed_at: draft.committed_at,
      author: draft.author,
      subject: draft.subject,
      upstream: draft.upstream,
      ahead: draft.ahead,
      behind: draft.behind,
      upstream_gone: draft.upstream_gone,
      open_pr: openPr,
      linked_tasks: linkedTasks,
      github_url: githubUrl,
    });
  }

  branches.sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    if (a.is_target !== b.is_target) return a.is_target ? -1 : 1;
    if (a.is_local_current !== b.is_local_current) return a.is_local_current ? -1 : 1;
    const aHasPr = Boolean(a.open_pr);
    const bHasPr = Boolean(b.open_pr);
    if (aHasPr !== bHasPr) return aHasPr ? -1 : 1;
    if (a.open_pr && b.open_pr && a.open_pr.updated_at !== b.open_pr.updated_at) {
      return b.open_pr.updated_at.localeCompare(a.open_pr.updated_at);
    }
    const aHasActiveTask = a.linked_tasks.some((t) => t.status !== "done");
    const bHasActiveTask = b.linked_tasks.some((t) => t.status !== "done");
    if (aHasActiveTask !== bHasActiveTask) return aHasActiveTask ? -1 : 1;
    if (a.committed_at !== b.committed_at) {
      if (!a.committed_at) return 1;
      if (!b.committed_at) return -1;
      return b.committed_at.localeCompare(a.committed_at);
    }
    return a.name.localeCompare(b.name);
  });

  return {
    repo: canonicalRepo,
    html_url: repoHtmlUrl,
    ...(input.remoteOverview ? { private: input.remoteOverview.private } : {}),
    default_branch: defaultBranch,
    target_branch: targetBranch,
    branch_prefix: branchPrefix,
    delivery_mode: input.project.delivery_mode,
    compare_base: compareBase,
    github_configured: input.githubConfigured,
    ...(input.remoteError ? { remote_error: input.remoteError } : {}),
    ...(input.remoteOverview?.prs_unavailable ? { prs_unavailable: true } : {}),
    mirror: input.mirror,
    local_workdir: input.localWorkdir,
    branches,
    counts: {
      total: branches.length,
      remote: branches.filter((b) => b.source !== "local").length,
      local_only: branches.filter((b) => b.source === "local").length,
      with_pr: branches.filter((b) => Boolean(b.open_pr)).length,
      with_task: branches.filter((b) => b.linked_tasks.length > 0).length,
    },
    fetched_at: input.fetchedAt || new Date().toISOString(),
  };
}
