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
  GithubConnectionSummary,
  GithubOwnerInfo,
  GithubRepoItem,
  GithubRepoWarning,
  GithubReposPayload,
  GithubTokenType,
} from "../app/lib/types.ts";

export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubError";
  }
}

export interface StoredGithubConnection {
  id: string;
  label: string;
  token: string;
  token_type: GithubTokenType;
  viewer: GithubOwnerInfo | null;
  owners: GithubOwnerInfo[];
  repo_count: number;
  created_at: string;
  updated_at: string;
}

interface StoredGithubFile {
  version: 1;
  connections: StoredGithubConnection[];
}

export const MAX_GITHUB_CONNECTIONS = 20;

export function githubTokenPath(dbPath: string): string {
  return join(dirname(dbPath), ".github-token");
}

export function githubTokensPath(dbPath: string): string {
  return join(dirname(dbPath), ".github-tokens.json");
}

export function detectGithubTokenType(token: string): GithubTokenType {
  if (token.startsWith("github_pat_")) return "fine_grained";
  if (token.startsWith("ghp_") || token.startsWith("gho_")) return "classic";
  return "other";
}

export function maskGithubToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("github_pat_") && trimmed.length > 16) {
    return `github_pat_••••${trimmed.slice(-4)}`;
  }
  if ((trimmed.startsWith("ghp_") || trimmed.startsWith("gho_")) && trimmed.length > 10) {
    return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
  }
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function toGithubConnectionSummary(
  conn: StoredGithubConnection,
): GithubConnectionSummary {
  return {
    id: conn.id,
    label: conn.label,
    token_preview: maskGithubToken(conn.token),
    token_type: conn.token_type,
    viewer: conn.viewer,
    owners: conn.owners,
    repo_count: conn.repo_count,
    created_at: conn.created_at,
    updated_at: conn.updated_at,
  };
}

function normalizeStoredOwner(raw: unknown): GithubOwnerInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.login !== "string" || !obj.login.trim()) return null;
  const avatarUrl = normalizeAvatarUrl(obj.avatar_url);
  return {
    login: obj.login.trim(),
    type: obj.type === "Organization" ? "Organization" : "User",
    ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
  };
}

function normalizeStoredConnection(raw: unknown): StoredGithubConnection | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const token = typeof obj.token === "string" ? obj.token.trim() : "";
  if (!token) return null;
  const id =
    typeof obj.id === "string" && obj.id.trim()
      ? obj.id.trim()
      : `gh_${randomBytes(6).toString("hex")}`;
  const tokenType: GithubTokenType =
    obj.token_type === "fine_grained" ||
    obj.token_type === "classic" ||
    obj.token_type === "other"
      ? obj.token_type
      : detectGithubTokenType(token);
  const viewer = normalizeStoredOwner(obj.viewer);
  const owners = Array.isArray(obj.owners)
    ? obj.owners
        .map((item) => normalizeStoredOwner(item))
        .filter((item): item is GithubOwnerInfo => item !== null)
    : [];
  const label =
    typeof obj.label === "string" && obj.label.trim()
      ? obj.label.trim().slice(0, 80)
      : inferConnectionLabel(viewer, owners);
  const now = new Date().toISOString();
  return {
    id,
    label,
    token,
    token_type: tokenType,
    viewer,
    owners,
    repo_count:
      typeof obj.repo_count === "number" && Number.isFinite(obj.repo_count) && obj.repo_count >= 0
        ? Math.floor(obj.repo_count)
        : 0,
    created_at:
      typeof obj.created_at === "string" && obj.created_at ? obj.created_at : now,
    updated_at:
      typeof obj.updated_at === "string" && obj.updated_at ? obj.updated_at : now,
  };
}

export function inferConnectionLabel(
  viewer: GithubOwnerInfo | null,
  owners: GithubOwnerInfo[],
): string {
  const orgs = owners.filter((o) => o.type === "Organization");
  const users = owners.filter((o) => o.type === "User");

  if (orgs.length === 1 && users.length === 0) {
    return orgs[0].login;
  }
  if (orgs.length > 1 && users.length === 0) {
    return `${orgs[0].login} 等 ${orgs.length} 个组织`;
  }
  if (users.length > 0) {
    return `@${users[0].login}`;
  }
  if (viewer?.login) {
    return `@${viewer.login}`;
  }
  return "GitHub Key";
}

function writeConnectionsFile(
  dbPath: string,
  connections: StoredGithubConnection[],
): void {
  const path = githubTokensPath(dbPath);
  const legacyPath = githubTokenPath(dbPath);
  if (connections.length === 0) {
    try {
      unlinkSync(path);
    } catch {
      // ignore if absent
    }
    try {
      unlinkSync(legacyPath);
    } catch {
      // ignore if absent
    }
    return;
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.github-tokens.${randomBytes(8).toString("hex")}.tmp`);
  const payload: StoredGithubFile = {
    version: 1,
    connections,
  };
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), {
      mode: 0o600,
      encoding: "utf8",
    });
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
  // Remove legacy single-token file once migrated to .github-tokens.json
  try {
    unlinkSync(legacyPath);
  } catch {
    // ignore if absent
  }
}

export function readGithubConnections(dbPath: string): StoredGithubConnection[] {
  if (dbPath === ":memory:") return [];
  const multiPath = githubTokensPath(dbPath);
  if (existsSync(multiPath)) {
    try {
      const raw = JSON.parse(readFileSync(multiPath, "utf8")) as Partial<StoredGithubFile>;
      if (raw && Array.isArray(raw.connections)) {
        return raw.connections
          .map((item) => normalizeStoredConnection(item))
          .filter((item): item is StoredGithubConnection => item !== null);
      }
    } catch {
      return [];
    }
  }
  const legacyPath = githubTokenPath(dbPath);
  if (existsSync(legacyPath)) {
    const legacyToken = readFileSync(legacyPath, "utf8").trim();
    if (legacyToken) {
      const now = new Date().toISOString();
      return [
        {
          id: "legacy",
          label: "默认连接",
          token: legacyToken,
          token_type: detectGithubTokenType(legacyToken),
          viewer: null,
          owners: [],
          repo_count: 0,
          created_at: now,
          updated_at: now,
        },
      ];
    }
  }
  return [];
}

export function listGithubConnectionSummaries(
  dbPath: string,
): GithubConnectionSummary[] {
  return readGithubConnections(dbPath).map(toGithubConnectionSummary);
}

export function hasGithubToken(dbPath: string): boolean {
  return readGithubConnections(dbPath).length > 0;
}

export function readGithubToken(dbPath: string): string | null {
  return readGithubConnections(dbPath)[0]?.token ?? null;
}

export function upsertGithubConnection(
  dbPath: string,
  input: {
    id?: string;
    label?: string;
    token: string;
    viewer: GithubOwnerInfo | null;
    owners: GithubOwnerInfo[];
    repo_count: number;
  },
): { connection: StoredGithubConnection; connections: StoredGithubConnection[] } {
  const existing = readGithubConnections(dbPath);
  const now = new Date().toISOString();
  const token = input.token.trim();
  const tokenType = detectGithubTokenType(token);

  let targetIdx = -1;
  if (input.id) {
    targetIdx = existing.findIndex((c) => c.id === input.id);
  }
  if (targetIdx === -1) {
    targetIdx = existing.findIndex((c) => c.token === token);
  }

  const resolvedLabel =
    (input.label ?? "").trim().slice(0, 80) ||
    inferConnectionLabel(input.viewer, input.owners);

  let saved: StoredGithubConnection;
  let next: StoredGithubConnection[];

  if (targetIdx >= 0) {
    const prev = existing[targetIdx];
    const nextId = prev.id === "legacy" ? `gh_${randomBytes(6).toString("hex")}` : prev.id;
    saved = {
      id: nextId,
      label: (input.label ?? "").trim().slice(0, 80) || (prev.id === "legacy" ? resolvedLabel : prev.label || resolvedLabel),
      token,
      token_type: tokenType,
      viewer: input.viewer,
      owners: input.owners,
      repo_count: input.repo_count,
      created_at: prev.created_at,
      updated_at: now,
    };
    next = existing.map((item, idx) => (idx === targetIdx ? saved : item));
  } else {
    if (existing.length >= MAX_GITHUB_CONNECTIONS) {
      throw new GithubError(`最多支持配置 ${MAX_GITHUB_CONNECTIONS} 个 GitHub Key。`);
    }
    saved = {
      id: `gh_${randomBytes(6).toString("hex")}`,
      label: resolvedLabel,
      token,
      token_type: tokenType,
      viewer: input.viewer,
      owners: input.owners,
      repo_count: input.repo_count,
      created_at: now,
      updated_at: now,
    };
    next = [...existing, saved];
  }

  writeConnectionsFile(dbPath, next);
  return { connection: saved, connections: next };
}

export function removeGithubConnection(
  dbPath: string,
  id?: string,
): StoredGithubConnection[] {
  if (!id) {
    writeConnectionsFile(dbPath, []);
    return [];
  }
  const existing = readGithubConnections(dbPath);
  const next = existing.filter((c) => c.id !== id);
  writeConnectionsFile(dbPath, next);
  return next;
}

export function saveGithubToken(dbPath: string, token: string): void {
  upsertGithubConnection(dbPath, {
    token,
    viewer: null,
    owners: [],
    repo_count: 0,
  });
}

export function deleteGithubToken(dbPath: string): void {
  removeGithubConnection(dbPath);
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
  options: { includeViewerOnlyIfPresent?: boolean } = {},
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

  const viewerKey = viewer?.login.toLowerCase();
  const hasViewerRepo = Boolean(
    viewerKey && repos.some((r) => r.owner.toLowerCase() === viewerKey),
  );
  const hasOrgScopedReposOrOrgs =
    repos.some((r) => r.owner_type === "Organization") || orgList.length > 0;

  if (viewer) {
    // For Fine-grained PATs scoped exclusively to an organization, /user still returns
    // the creator's personal account even though the token has zero access to personal repos.
    // Only include viewer as an accessible owner if they own at least one returned repo,
    // or if no org scope was detected.
    const shouldIncludeViewer =
      !options.includeViewerOnlyIfPresent ||
      hasViewerRepo ||
      !hasOrgScopedReposOrOrgs;
    if (shouldIncludeViewer) {
      upsert(viewer);
    }
  }
  for (const org of orgList) upsert(org);
  for (const repo of repos) {
    upsert({
      login: repo.owner,
      type: repo.owner_type,
      ...(repo.owner_avatar ? { avatar_url: repo.owner_avatar } : {}),
    });
  }

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
  const isFineGrained = detectGithubTokenType(token) === "fine_grained";

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
        { includeViewerOnlyIfPresent: isFineGrained },
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
            { includeViewerOnlyIfPresent: isFineGrained },
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
  const owners = mergeOwners(meta.viewer, meta.orgs, items, {
    includeViewerOnlyIfPresent: isFineGrained,
  });

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

function collectCachedOwners(
  connections: StoredGithubConnection[],
): GithubOwnerInfo[] {
  const list: GithubOwnerInfo[] = [];
  for (const conn of connections) {
    for (const owner of conn.owners) {
      list.push(owner);
    }
  }
  return list;
}

function annotateItems(
  items: GithubRepoItem[],
  conn: StoredGithubConnection,
): GithubRepoItem[] {
  return items.map((item) => ({
    ...item,
    connection_id: conn.id,
    connection_label: conn.label,
  }));
}

export async function fetchGithubRepositoriesAcrossConnections(
  connections: StoredGithubConnection[],
  opts: FetchGithubReposOptions & { connectionId?: string } = {},
): Promise<GithubReposPayload> {
  const page = opts.page ?? 1;
  const owner = (opts.owner ?? "all").trim() || "all";

  if (connections.length === 0) {
    throw new GithubError("请先在设置中添加至少一个 GitHub Key。");
  }

  const allCachedOwners = collectCachedOwners(connections);
  const primaryViewer = connections.find((c) => c.viewer)?.viewer ?? null;

  // Target a single explicit connection
  if (opts.connectionId) {
    const target = connections.find((c) => c.id === opts.connectionId);
    if (!target) {
      throw new GithubError("未找到指定的 GitHub Key 配置。");
    }
    const res = await fetchGithubRepositories(target.token, opts);
    const items = annotateItems(res.items, target);
    return {
      ...res,
      items,
      repos: items.map((r) => r.full_name),
    };
  }

  // Single-connection fast path
  if (connections.length === 1) {
    const only = connections[0];
    const res = await fetchGithubRepositories(only.token, opts);
    const items = annotateItems(res.items, only);
    const owners = mergeOwners(res.viewer ?? only.viewer, [...allCachedOwners, ...res.owners], items, {
      includeViewerOnlyIfPresent: only.token_type === "fine_grained",
    });
    return {
      ...res,
      items,
      repos: items.map((r) => r.full_name),
      owners,
    };
  }

  // Multiple connections: choose candidate connections when filtering by a specific owner
  let candidates = connections;
  let remaining: StoredGithubConnection[] = [];
  if (owner !== "all") {
    const ownerLower = owner.toLowerCase();
    const matched = connections.filter((c) =>
      c.owners.some((o) => o.login.toLowerCase() === ownerLower),
    );
    if (matched.length > 0) {
      candidates = matched;
      const matchedIds = new Set(matched.map((c) => c.id));
      remaining = connections.filter((c) => !matchedIds.has(c.id));
    }
  }

  const queryBatch = async (batch: StoredGithubConnection[]) => {
    const settled = await Promise.allSettled(
      batch.map(async (conn) => ({
        conn,
        payload: await fetchGithubRepositories(conn.token, opts),
      })),
    );
    const ok: Array<{ conn: StoredGithubConnection; payload: GithubReposPayload }> = [];
    const warnings: GithubRepoWarning[] = [];
    for (let i = 0; i < settled.length; i += 1) {
      const outcome = settled[i];
      const conn = batch[i];
      if (outcome.status === "fulfilled") {
        ok.push(outcome.value);
      } else {
        const message =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : "GitHub 请求失败";
        warnings.push({
          connection_id: conn.id,
          label: conn.label,
          error: message,
        });
      }
    }
    return { ok, warnings };
  };

  let { ok, warnings } = await queryBatch(candidates);

  // If targeted connections failed or returned empty for a specific owner, try remaining keys
  if (
    owner !== "all" &&
    remaining.length > 0 &&
    (ok.length === 0 || ok.every((entry) => entry.payload.items.length === 0))
  ) {
    const fallback = await queryBatch(remaining);
    if (fallback.ok.length > 0) {
      ok = [...ok, ...fallback.ok];
      // Clear warnings from the targeted batch only if fallback succeeded and we didn't want spurious errors
      warnings = [...warnings, ...fallback.warnings];
    }
  }

  if (ok.length === 0) {
    const firstErr = warnings[0]?.error || "所有已配置的 GitHub Key 均无法读取仓库。";
    throw new GithubError(firstErr);
  }

  const mergedItems = dedupeAndSortRepos(
    ok.flatMap((entry) => annotateItems(entry.payload.items, entry.conn)),
  );
  const fetchedOwners = ok.flatMap((entry) => entry.payload.owners);
  const viewer = ok.find((entry) => entry.payload.viewer)?.payload.viewer ?? primaryViewer;
  const mergedOwners = mergeOwners(viewer, [...allCachedOwners, ...fetchedOwners], mergedItems, {
    includeViewerOnlyIfPresent: true,
  });
  const more = ok.some((entry) => entry.payload.more);

  // When searching a specific owner across multiple keys (e.g. a custom org),
  // expected 403/404 errors from keys belonging to OTHER owners are not real failures
  // as long as at least one key returned matching repos.
  const surfaceWarnings =
    owner === "all" && warnings.length > 0 ? warnings : undefined;

  return {
    repos: mergedItems.map((r) => r.full_name),
    items: mergedItems,
    viewer,
    owners: mergedOwners,
    owner,
    page,
    more,
    ...(surfaceWarnings ? { warnings: surfaceWarnings } : {}),
  };
}
