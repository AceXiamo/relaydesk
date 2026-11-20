import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  GithubOwnerInfo,
  GithubRepoItem,
  GithubReposPayload,
} from "../app/lib/types.ts";

export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubError";
  }
}

export function githubTokenPath(dbPath: string): string {
  return join(dirname(dbPath), ".github-token");
}

export function hasGithubToken(dbPath: string): boolean {
  return existsSync(githubTokenPath(dbPath));
}

export function readGithubToken(dbPath: string): string | null {
  const path = githubTokenPath(dbPath);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim() || null;
}

export function saveGithubToken(dbPath: string, token: string): void {
  const path = githubTokenPath(dbPath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.github-token.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, token, { mode: 0o600, encoding: "utf8" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

export function deleteGithubToken(dbPath: string): void {
  const path = githubTokenPath(dbPath);
  try {
    unlinkSync(path);
  } catch {
    // ignore if absent
  }
}

interface RawGithubUser {
  login?: string;
  type?: string;
  avatar_url?: string;
}

interface RawGithubRepo {
  full_name?: string;
  name?: string;
  private?: boolean;
  archived?: boolean;
  description?: string | null;
  updated_at?: string;
  pushed_at?: string;
  owner?: RawGithubUser;
}

export interface FetchGithubReposOptions {
  page?: number;
  owner?: string;
  ownerType?: "User" | "Organization";
  apiBase?: string;
}

const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

function getGithubApiBase(override?: string): string {
  const raw = override || process.env.RELAYDESK_GITHUB_API_BASE || DEFAULT_GITHUB_API_BASE;
  return raw.replace(/\/+$/, "");
}

async function githubRequest<T>(
  token: string,
  path: string,
  apiBase: string,
): Promise<{ status: number; ok: boolean; data: T | null; link: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Relaydesk",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    const link = response.headers.get("link") ?? "";
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch {
      data = null;
    }
    return { status: response.status, ok: response.ok, data, link };
  } catch (err) {
    if (err instanceof GithubError) throw err;
    throw new GithubError("无法连接 GitHub API，请检查网络后重试。");
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAvatarUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return undefined;
    if (
      parsed.hostname === "avatars.githubusercontent.com" &&
      !parsed.searchParams.has("s")
    ) {
      parsed.searchParams.set("s", "64");
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeRepo(raw: RawGithubRepo): GithubRepoItem | null {
  if (!raw || typeof raw.full_name !== "string" || !raw.full_name.includes("/")) {
    return null;
  }
  const [fallbackOwner, fallbackName] = raw.full_name.split("/");
  const owner =
    typeof raw.owner?.login === "string" && raw.owner.login
      ? raw.owner.login
      : fallbackOwner;
  const name =
    typeof raw.name === "string" && raw.name ? raw.name : fallbackName;
  const ownerType: "User" | "Organization" =
    raw.owner?.type === "Organization" ? "Organization" : "User";
  const ownerAvatar = normalizeAvatarUrl(raw.owner?.avatar_url);

  return {
    full_name: raw.full_name,
    name,
    owner,
    owner_type: ownerType,
    ...(ownerAvatar ? { owner_avatar: ownerAvatar } : {}),
    private: Boolean(raw.private),
    archived: Boolean(raw.archived),
    description:
      typeof raw.description === "string" ? raw.description.trim().slice(0, 240) : "",
    updated_at:
      typeof raw.pushed_at === "string" && raw.pushed_at
        ? raw.pushed_at
        : typeof raw.updated_at === "string"
          ? raw.updated_at
          : "",
  };
}

function dedupeAndSortRepos(items: GithubRepoItem[]): GithubRepoItem[] {
  const map = new Map<string, GithubRepoItem>();
  for (const item of items) {
    const key = item.full_name.toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
    } else if (item.updated_at > existing.updated_at) {
      map.set(key, item);
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at) || a.full_name.localeCompare(b.full_name),
  );
}

function mergeOwners(
  viewer: GithubOwnerInfo | null,
  orgList: GithubOwnerInfo[],
  repos: GithubRepoItem[],
): GithubOwnerInfo[] {
  const map = new Map<string, GithubOwnerInfo>();

  const upsert = (info: GithubOwnerInfo) => {
    const key = info.login.toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, info);
    } else {
      map.set(key, {
        login: existing.login,
        type:
          existing.type === "Organization" || info.type === "Organization"
            ? "Organization"
            : "User",
        avatar_url: existing.avatar_url || info.avatar_url,
      });
    }
  };

  if (viewer) upsert(viewer);
  for (const org of orgList) upsert(org);
  for (const repo of repos) {
    upsert({
      login: repo.owner,
      type: repo.owner_type,
      ...(repo.owner_avatar ? { avatar_url: repo.owner_avatar } : {}),
    });
  }

  const viewerKey = viewer?.login.toLowerCase();
  return Array.from(map.values()).sort((a, b) => {
    if (viewerKey && a.login.toLowerCase() === viewerKey) return -1;
    if (viewerKey && b.login.toLowerCase() === viewerKey) return 1;
    if (a.type !== b.type) return a.type === "Organization" ? -1 : 1;
    return a.login.localeCompare(b.login);
  });
}

async function fetchViewerAndOrgs(
  token: string,
  apiBase: string,
): Promise<{ viewer: GithubOwnerInfo | null; orgs: GithubOwnerInfo[] }> {
  const [userRes, orgsRes] = await Promise.all([
    githubRequest<RawGithubUser>(token, "/user", apiBase).catch(() => null),
    githubRequest<RawGithubUser[]>(token, "/user/orgs?per_page=100", apiBase).catch(
      () => null,
    ),
  ]);

  let viewer: GithubOwnerInfo | null = null;
  if (userRes?.ok && userRes.data && typeof userRes.data.login === "string") {
    const avatarUrl = normalizeAvatarUrl(userRes.data.avatar_url);
    viewer = {
      login: userRes.data.login,
      type: userRes.data.type === "Organization" ? "Organization" : "User",
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
    };
  }

  const orgs: GithubOwnerInfo[] = [];
  if (orgsRes?.ok && Array.isArray(orgsRes.data)) {
    for (const raw of orgsRes.data) {
      if (raw && typeof raw.login === "string" && raw.login) {
        const avatarUrl = normalizeAvatarUrl(raw.avatar_url);
        orgs.push({
          login: raw.login,
          type: "Organization",
          ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
        });
      }
    }
  }

  return { viewer, orgs };
}

export async function fetchGithubRepositories(
  token: string,
  pageOrOptions: number | FetchGithubReposOptions = 1,
): Promise<GithubReposPayload> {
  const opts: FetchGithubReposOptions =
    typeof pageOrOptions === "number" ? { page: pageOrOptions } : pageOrOptions;
  const page = opts.page ?? 1;
  const requestedOwner = (opts.owner ?? "all").trim();
  const owner = requestedOwner || "all";
  const apiBase = getGithubApiBase(opts.apiBase);

  // Best-effort fetch of viewer & org list on page 1 so the UI always knows available orgs
  const metaPromise =
    page === 1
      ? fetchViewerAndOrgs(token, apiBase)
      : Promise.resolve({ viewer: null, orgs: [] as GithubOwnerInfo[] });

  // Specific organization selected -> query /orgs/{org}/repos directly,
  // with fallback to /user/repos filtered by owner for Fine-grained PATs
  // that allow repository metadata on an org without /orgs/{org}/repos access.
  if (owner !== "all" && opts.ownerType === "Organization") {
    const [orgRes, meta] = await Promise.all([
      githubRequest<RawGithubRepo[]>(
        token,
        `/orgs/${encodeURIComponent(owner)}/repos?type=all&sort=updated&per_page=100&page=${page}`,
        apiBase,
      ),
      metaPromise,
    ]);

    if (orgRes.ok && Array.isArray(orgRes.data)) {
      const items = dedupeAndSortRepos(
        orgRes.data
          .map((r) => normalizeRepo(r))
          .filter((r): r is GithubRepoItem => r !== null),
      );
      const owners = mergeOwners(
        meta.viewer,
        [...meta.orgs, { login: owner, type: "Organization" }],
        items,
      );
      return {
        repos: items.map((r) => r.full_name),
        items,
        viewer: meta.viewer,
        owners,
        owner,
        page,
        more: orgRes.link.includes('rel="next"'),
      };
    }

    if (orgRes.status === 403 || orgRes.status === 404) {
      const fallbackRes = await githubRequest<RawGithubRepo[]>(
        token,
        `/user/repos?affiliation=organization_member,collaborator,owner&sort=updated&per_page=100&page=${page}`,
        apiBase,
      );
      if (fallbackRes.ok && Array.isArray(fallbackRes.data)) {
        const targetLower = owner.toLowerCase();
        const filtered = dedupeAndSortRepos(
          fallbackRes.data
            .map((r) => normalizeRepo(r))
            .filter(
              (r): r is GithubRepoItem =>
                r !== null && r.owner.toLowerCase() === targetLower,
            ),
        );
        if (filtered.length > 0 || page > 1) {
          const owners = mergeOwners(
            meta.viewer,
            [...meta.orgs, { login: owner, type: "Organization" }],
            filtered,
          );
          return {
            repos: filtered.map((r) => r.full_name),
            items: filtered,
            viewer: meta.viewer,
            owners,
            owner,
            page,
            more: fallbackRes.link.includes('rel="next"'),
          };
        }
      }
      if (orgRes.status === 404) {
        throw new GithubError(`未找到组织「${owner}」，或当前 Token 无权访问。`);
      }
      throw new GithubError(
        `GitHub 拒绝访问组织「${owner}」，请检查 Token 是否已授权该组织及 SSO。`,
      );
    }

    if (orgRes.status === 401) {
      throw new GithubError("GitHub Token 无效或已过期，请重新配置。");
    }
    throw new GithubError(`GitHub 返回 ${orgRes.status}，请稍后重试。`);
  }

  // Personal account or All accessible repositories
  const affiliation =
    owner !== "all" && opts.ownerType === "User"
      ? "owner"
      : "owner,collaborator,organization_member";

  const [userReposRes, meta] = await Promise.all([
    githubRequest<RawGithubRepo[]>(
      token,
      `/user/repos?affiliation=${affiliation}&sort=updated&per_page=100&page=${page}`,
      apiBase,
    ),
    metaPromise,
  ]);

  if (userReposRes.status === 401 || userReposRes.status === 403) {
    throw new GithubError("GitHub 拒绝了请求，请检查 Token、组织授权和 API 配额。");
  }
  if (!userReposRes.ok || !Array.isArray(userReposRes.data)) {
    throw new GithubError(`GitHub 返回 ${userReposRes.status}，请稍后重试。`);
  }

  let items = userReposRes.data
    .map((r) => normalizeRepo(r))
    .filter((r): r is GithubRepoItem => r !== null);

  let more = userReposRes.link.includes('rel="next"');

  // If filtering specifically for a personal user, keep matching owner entries
  if (owner !== "all" && opts.ownerType === "User") {
    const targetLower = owner.toLowerCase();
    items = items.filter((r) => r.owner.toLowerCase() === targetLower);
  }

  // On page 1 of "all", also pull first page of each org's repos (up to 6 orgs)
  // so organization repositories appear immediately even if the user has many personal repos
  // or org visibility requires /orgs/{org}/repos.
  if (owner === "all" && page === 1 && meta.orgs.length > 0) {
    const orgsToPrefetch = meta.orgs.slice(0, 6);
    const orgResponses = await Promise.all(
      orgsToPrefetch.map((org) =>
        githubRequest<RawGithubRepo[]>(
          token,
          `/orgs/${encodeURIComponent(org.login)}/repos?type=all&sort=updated&per_page=50&page=1`,
          apiBase,
        ).catch(() => null),
      ),
    );
    for (const res of orgResponses) {
      if (res?.ok && Array.isArray(res.data)) {
        for (const raw of res.data) {
          const parsed = normalizeRepo(raw);
          if (parsed) items.push(parsed);
        }
      }
    }
  }

  // When a specific non-typed owner is passed, fallback to filtering by owner name
  if (owner !== "all" && !opts.ownerType) {
    const targetLower = owner.toLowerCase();
    items = items.filter((r) => r.owner.toLowerCase() === targetLower);
  }

  items = dedupeAndSortRepos(items);
  const owners = mergeOwners(meta.viewer, meta.orgs, items);

  return {
    repos: items.map((r) => r.full_name),
    items,
    viewer: meta.viewer,
    owners,
    owner,
    page,
    more,
  };
}
