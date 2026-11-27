import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readGithubConnections, type StoredGithubConnection } from "./github.ts";
import type {
  AgentProjectInfo,
  ProjectReposSyncStatus,
  RepoMirrorEntry,
} from "../app/lib/types.ts";

const execFileAsync = promisify(execFile);

export const REPO_SYNC_TTL_MS = 5 * 60 * 1000;
const MAX_SYNCED_REPOS = 5;
const GIT_TIMEOUT_MS = 30_000;
const MAX_LIST_ENTRIES = 120;
const MAX_SEARCH_MATCHES = 40;
const MAX_READ_LINES = 150;
const MAX_READ_BYTES = 12_000;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".react-router",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "coverage",
  "target",
  "vendor",
  ".idea",
  ".vscode",
]);

const SENSITIVE_BASENAME_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|sqlite|sqlite3|db)$/i,
  /(^|[._-])(secret|secrets|credential|credentials|private[_-]?key)([._-]|$)/i,
];

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".svg",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".lock",
]);

export interface ReadyRepoRoot {
  repo: string;
  dir: string;
  realDir: string;
  commit: string;
}

interface SyncMeta {
  synced_at: string;
  repos: Record<string, { commit: string; branch?: string; updated_at: string; error?: string }>;
}

const inFlightSyncs = new Map<string, Promise<ProjectReposSyncStatus>>();

export function isSensitivePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return false;
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") return true;
    if (IGNORED_DIRS.has(seg)) return true;
    for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
      if (pattern.test(seg)) return true;
    }
  }
  return false;
}

function isBinaryFilename(name: string): boolean {
  const idx = name.lastIndexOf(".");
  if (idx === -1) return false;
  return BINARY_EXTENSIONS.has(name.slice(idx).toLowerCase());
}

export function sanitizeRepoDirName(repo: string): string {
  const clean = repo.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean) || clean.includes("..")) {
    throw new Error(`Invalid repository slug: ${repo}`);
  }
  return clean.replace("/", "__");
}

export function getProjectReposDir(
  dbPath: string,
  projectId: string,
  baseDirOverride?: string,
): string | null {
  const safeProject = projectId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeProject) return null;
  if (baseDirOverride) {
    return join(resolve(baseDirOverride), safeProject);
  }
  if (dbPath === ":memory:") return null;
  return join(dirname(resolve(dbPath)), "repos", safeProject);
}

function readSyncMeta(projectDir: string): SyncMeta | null {
  const metaPath = join(projectDir, ".sync-meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<SyncMeta>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      synced_at: typeof parsed.synced_at === "string" ? parsed.synced_at : "",
      repos: parsed.repos && typeof parsed.repos === "object" ? parsed.repos : {},
    };
  } catch {
    return null;
  }
}

function writeSyncMeta(projectDir: string, meta: SyncMeta): void {
  try {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, ".sync-meta.json"), JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // ignore metadata write errors
  }
}

function resolveGithubTokenForRepo(
  connections: StoredGithubConnection[],
  repo: string,
): string | null {
  if (connections.length === 0) return null;
  const owner = repo.split("/")[0]?.toLowerCase() ?? "";
  for (const conn of connections) {
    if (conn.scope_owner && conn.scope_owner.login.toLowerCase() === owner) {
      return conn.token;
    }
  }
  for (const conn of connections) {
    if (conn.owners.some((o) => o.login.toLowerCase() === owner)) {
      return conn.token;
    }
  }
  return connections[0]?.token ?? null;
}

async function runGit(
  args: string[],
  options: { cwd?: string; token?: string | null; timeoutMs?: number } = {},
): Promise<string> {
  const finalArgs: string[] = [];
  if (options.token) {
    const basic = Buffer.from(`x-access-token:${options.token}`, "utf8").toString("base64");
    finalArgs.push("-c", `http.extraheader=AUTHORIZATION: basic ${basic}`);
  }
  finalArgs.push(...args);
  const { stdout } = await execFileAsync("git", finalArgs, {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      GCM_INTERACTIVE: "never",
    },
  });
  return stdout.trim();
}

function isValidSyncBranchName(value: string): boolean {
  if (!value || value.length > 120 || value.startsWith("-")) return false;
  if (/[\x00-\x1f\x7f\s~^:?*[\]\\]/.test(value)) return false;
  if (value === "@" || value.startsWith("/") || value.endsWith("/")) return false;
  if (value.startsWith(".") || value.endsWith(".") || value.includes("..") || value.includes("//") || value.includes("@{")) {
    return false;
  }
  return value.split("/").every((part) => Boolean(part) && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function validateSyncBranch(branch?: string): string | undefined {
  if (branch === undefined) return undefined;
  const trimmed = branch.trim();
  if (!trimmed) return undefined;
  if (!isValidSyncBranchName(trimmed)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  return trimmed;
}

async function readHeadCommit(repoDir: string): Promise<string> {
  try {
    return await runGit(["rev-parse", "--short", "HEAD"], { cwd: repoDir, timeoutMs: 5000 });
  } catch {
    return "";
  }
}

async function readHeadBranch(repoDir: string): Promise<string> {
  try {
    return await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repoDir, timeoutMs: 5000 });
  } catch {
    return readHeadBranchSync(repoDir);
  }
}

export function readHeadBranchSync(repoDir: string): string {
  try {
    const headFile = join(repoDir, ".git", "HEAD");
    if (!existsSync(headFile)) return "";
    const head = readFileSync(headFile, "utf8").trim();
    if (head.startsWith("ref:")) {
      const refName = head.slice(4).trim();
      if (refName.startsWith("refs/heads/")) {
        return refName.slice("refs/heads/".length);
      }
    }
    return "";
  } catch {
    return "";
  }
}

function readHeadCommitSync(repoDir: string): string {
  try {
    const headFile = join(repoDir, ".git", "HEAD");
    if (!existsSync(headFile)) return "";
    const head = readFileSync(headFile, "utf8").trim();
    if (head.startsWith("ref:")) {
      const refPath = join(repoDir, ".git", head.slice(4).trim());
      if (existsSync(refPath)) {
        return readFileSync(refPath, "utf8").trim().slice(0, 8);
      }
      const packed = join(repoDir, ".git", "packed-refs");
      if (existsSync(packed)) {
        const refName = head.slice(4).trim();
        for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
          if (line.endsWith(` ${refName}`)) {
            return line.split(" ")[0]?.slice(0, 8) ?? "";
          }
        }
      }
      return "";
    }
    return head.slice(0, 8);
  } catch {
    return "";
  }
}

export function collectReadyRepos(
  dbPath: string,
  project: Pick<AgentProjectInfo, "id" | "repos">,
  baseDirOverride?: string,
): ReadyRepoRoot[] {
  const projectDir = getProjectReposDir(dbPath, project.id, baseDirOverride);
  if (!projectDir || !existsSync(projectDir)) return [];
  const results: ReadyRepoRoot[] = [];
  for (const repo of project.repos.slice(0, MAX_SYNCED_REPOS)) {
    let slug: string;
    try {
      slug = sanitizeRepoDirName(repo);
    } catch {
      continue;
    }
    const dir = join(projectDir, slug);
    if (!existsSync(dir)) continue;
    try {
      const realDir = realpathSync(dir);
      results.push({
        repo,
        dir,
        realDir,
        commit: readHeadCommitSync(dir),
      });
    } catch {
      // ignore invalid directory
    }
  }
  return results;
}

export function getProjectReposStatus(
  dbPath: string,
  project: Pick<AgentProjectInfo, "id" | "repos" | "widget_code_context">,
  baseDirOverride?: string,
): ProjectReposSyncStatus {
  const projectDir = getProjectReposDir(dbPath, project.id, baseDirOverride);
  const meta = projectDir ? readSyncMeta(projectDir) : null;
  const syncing = inFlightSyncs.has(project.id);
  const repos: RepoMirrorEntry[] = project.repos.slice(0, MAX_SYNCED_REPOS).map((repo) => {
    let dir = "";
    try {
      if (projectDir) dir = join(projectDir, sanitizeRepoDirName(repo));
    } catch {
      dir = "";
    }
    const ready = Boolean(dir && existsSync(dir));
    const repoMeta = meta?.repos?.[repo];
    const branch = (ready ? readHeadBranchSync(dir) : "") || repoMeta?.branch || "";
    return {
      repo,
      ready,
      ...(branch ? { branch } : {}),
      commit: (ready ? readHeadCommitSync(dir) : "") || repoMeta?.commit || "",
      updated_at: repoMeta?.updated_at ?? null,
      ...(repoMeta?.error ? { error: repoMeta.error } : {}),
    };
  });
  return {
    project_id: project.id,
    enabled: Boolean(project.widget_code_context),
    syncing,
    synced_at: meta?.synced_at ?? null,
    repos,
  };
}

export async function syncProjectRepos(
  dbPath: string,
  project: Pick<AgentProjectInfo, "id" | "repos" | "widget_code_context">,
  options: { baseDirOverride?: string; repo?: string; branch?: string } = {},
): Promise<ProjectReposSyncStatus> {
  const requestedBranch = validateSyncBranch(options.branch);
  const requestedRepoRaw = options.repo?.trim() || "";
  const scopedRepos = project.repos.slice(0, MAX_SYNCED_REPOS);
  let matchedRepo: string | undefined;
  if (requestedRepoRaw) {
    matchedRepo = scopedRepos.find((r) => r.toLowerCase() === requestedRepoRaw.toLowerCase());
    if (!matchedRepo) {
      throw new Error("Specified repository is not bound to this project");
    }
  }

  const existingPromise = inFlightSyncs.get(project.id);
  if (existingPromise && !matchedRepo && !requestedBranch) {
    return existingPromise;
  }
  while (inFlightSyncs.has(project.id)) {
    await inFlightSyncs.get(project.id)!.catch(() => undefined);
  }

  const task = (async (): Promise<ProjectReposSyncStatus> => {
    const projectDir = getProjectReposDir(dbPath, project.id, options.baseDirOverride);
    if (!projectDir) {
      return getProjectReposStatus(dbPath, project, options.baseDirOverride);
    }
    mkdirSync(projectDir, { recursive: true });
    const connections = readGithubConnections(dbPath);
    const targetRepos = matchedRepo ? [matchedRepo] : scopedRepos;
    const expectedDirs = new Set<string>();
    const prevMeta = readSyncMeta(projectDir);
    const nextReposMeta: SyncMeta["repos"] = matchedRepo
      ? { ...(prevMeta?.repos ?? {}) }
      : {};

    for (const repo of targetRepos) {
      let slug: string;
      try {
        slug = sanitizeRepoDirName(repo);
      } catch {
        continue;
      }
      expectedDirs.add(slug);
      const repoDir = join(projectDir, slug);
      const token = resolveGithubTokenForRepo(connections, repo);
      const remoteUrl = `https://github.com/${repo}.git`;
      try {
        if (existsSync(join(repoDir, ".git"))) {
          if (requestedBranch) {
            await runGit(
              [
                "fetch",
                "--depth",
                "1",
                "origin",
                "--",
                `refs/heads/${requestedBranch}:refs/remotes/origin/${requestedBranch}`,
              ],
              { cwd: repoDir, token },
            );
            await runGit(["checkout", "-f", "-B", requestedBranch, "FETCH_HEAD"], {
              cwd: repoDir,
            });
          } else {
            const currentBranch = readHeadBranchSync(repoDir);
            let syncedCurrentBranch = false;
            if (currentBranch && isValidSyncBranchName(currentBranch)) {
              try {
                await runGit(
                  [
                    "fetch",
                    "--depth",
                    "1",
                    "origin",
                    "--",
                    `refs/heads/${currentBranch}:refs/remotes/origin/${currentBranch}`,
                  ],
                  { cwd: repoDir, token },
                );
                await runGit(["reset", "--hard", "FETCH_HEAD"], { cwd: repoDir });
                syncedCurrentBranch = true;
              } catch {
                syncedCurrentBranch = false;
              }
            }
            if (!syncedCurrentBranch) {
              await runGit(["fetch", "--depth", "1", "origin"], {
                cwd: repoDir,
                token,
              });
              await runGit(["reset", "--hard", "FETCH_HEAD"], { cwd: repoDir });
            }
          }
        } else {
          if (existsSync(repoDir)) {
            rmSync(repoDir, { recursive: true, force: true });
          }
          if (requestedBranch) {
            await runGit(
              [
                "clone",
                "--depth",
                "1",
                "--single-branch",
                "--branch",
                requestedBranch,
                "--",
                remoteUrl,
                repoDir,
              ],
              { token },
            );
          } else {
            await runGit(["clone", "--depth", "1", "--single-branch", "--", remoteUrl, repoDir], {
              token,
            });
          }
        }
        const commit = await readHeadCommit(repoDir);
        const branch = (await readHeadBranch(repoDir)) || readHeadBranchSync(repoDir) || requestedBranch || "";
        nextReposMeta[repo] = {
          commit,
          ...(branch ? { branch } : {}),
          updated_at: new Date().toISOString(),
        };
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
                .replace(/basic [A-Za-z0-9+/=]+/gi, "basic ***")
                .replace(/https?:\/\/[^@\s]+@/gi, "https://***@")
                .slice(0, 240)
            : "Git sync failed";
        const fallbackBranch =
          readHeadBranchSync(repoDir) || prevMeta?.repos?.[repo]?.branch || "";
        nextReposMeta[repo] = {
          commit: prevMeta?.repos?.[repo]?.commit ?? readHeadCommitSync(repoDir),
          ...(fallbackBranch ? { branch: fallbackBranch } : {}),
          updated_at: prevMeta?.repos?.[repo]?.updated_at ?? "",
          error: message,
        };
      }
    }

    // Prune unbound repo directories only during full project sync
    if (!matchedRepo) {
      try {
        for (const entry of readdirSync(projectDir)) {
          if (entry === ".sync-meta.json") continue;
          if (!expectedDirs.has(entry)) {
            rmSync(join(projectDir, entry), { recursive: true, force: true });
          }
        }
      } catch {
        // ignore cleanup error
      }
    }

    writeSyncMeta(projectDir, {
      synced_at: new Date().toISOString(),
      repos: nextReposMeta,
    });
    return getProjectReposStatus(dbPath, project, options.baseDirOverride);
  })();

  inFlightSyncs.set(project.id, task);
  try {
    return await task;
  } finally {
    inFlightSyncs.delete(project.id);
  }
}

export async function ensureProjectRepos(
  dbPath: string,
  project: Pick<AgentProjectInfo, "id" | "repos" | "widget_code_context">,
  options: {
    force?: boolean;
    baseDirOverride?: string;
    onColdSync?: () => void;
  } = {},
): Promise<ReadyRepoRoot[]> {
  if (!project.widget_code_context || project.repos.length === 0) {
    return [];
  }
  const projectDir = getProjectReposDir(dbPath, project.id, options.baseDirOverride);
  if (!projectDir) return [];

  const cached = collectReadyRepos(dbPath, project, options.baseDirOverride);
  const meta = readSyncMeta(projectDir);
  const lastSyncMs = meta?.synced_at ? Date.parse(meta.synced_at) : 0;
  const isStale = !lastSyncMs || Date.now() - lastSyncMs > REPO_SYNC_TTL_MS;

  if (cached.length > 0 && !options.force) {
    if (isStale && !inFlightSyncs.has(project.id)) {
      // Refresh in background without blocking the user's conversation turn
      void syncProjectRepos(dbPath, project, {
        baseDirOverride: options.baseDirOverride,
      }).catch(() => {});
    }
    return cached;
  }

  options.onColdSync?.();
  await syncProjectRepos(dbPath, project, {
    baseDirOverride: options.baseDirOverride,
  });
  return collectReadyRepos(dbPath, project, options.baseDirOverride);
}

// ============================================================================
// Read-Only Code Sandbox Tools
// ============================================================================

function selectRepos(roots: ReadyRepoRoot[], repoFilter?: string): ReadyRepoRoot[] {
  if (!repoFilter?.trim()) return roots;
  const target = repoFilter.trim().toLowerCase();
  const matched = roots.filter(
    (r) =>
      r.repo.toLowerCase() === target ||
      r.repo.split("/")[1]?.toLowerCase() === target,
  );
  return matched.length > 0 ? matched : roots;
}

function resolveSafeInsideRepo(root: ReadyRepoRoot, relInput: string): {
  absPath: string;
  relPath: string;
} | null {
  let cleaned = relInput.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  while (cleaned.startsWith("./")) cleaned = cleaned.slice(2);
  if (cleaned === ".") cleaned = "";
  if (cleaned && isSensitivePath(cleaned)) return null;
  const candidate = resolve(root.realDir, cleaned || ".");
  if (candidate !== root.realDir && !candidate.startsWith(root.realDir + sep)) {
    return null;
  }
  if (!existsSync(candidate)) return null;
  let realTarget: string;
  try {
    realTarget = realpathSync(candidate);
  } catch {
    return null;
  }
  if (realTarget !== root.realDir && !realTarget.startsWith(root.realDir + sep)) {
    return null;
  }
  if (realTarget !== candidate) return null; // Do not follow symlinks, even inside the repo.
  const relPath = relative(root.realDir, realTarget).replace(/\\/g, "/");
  if (relPath && isSensitivePath(relPath)) return null;
  return { absPath: realTarget, relPath };
}

export function listRepoFiles(
  roots: ReadyRepoRoot[],
  params: { repo?: string; dir?: string; max_depth?: number } = {},
): { entries: string[]; truncated: boolean } {
  const targets = selectRepos(roots, params.repo);
  const maxDepth = Math.min(Math.max(Number(params.max_depth) || 2, 1), 4);
  const entries: string[] = [];
  let truncated = false;

  const walk = (root: ReadyRepoRoot, currentAbs: string, depth: number) => {
    if (entries.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      return;
    }
    let dirents;
    try {
      dirents = readdirSync(currentAbs, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const d of dirents) {
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      if (d.isSymbolicLink()) continue;
      const nextAbs = join(currentAbs, d.name);
      const rel = relative(root.realDir, nextAbs).replace(/\\/g, "/");
      if (isSensitivePath(rel)) continue;
      const prefix = targets.length > 1 ? `${root.repo}:` : "";
      if (d.isDirectory()) {
        entries.push(`${prefix}${rel}/`);
        if (depth < maxDepth) {
          walk(root, nextAbs, depth + 1);
        }
      } else if (d.isFile()) {
        entries.push(`${prefix}${rel}`);
      }
    }
  };

  for (const root of targets) {
    const start = resolveSafeInsideRepo(root, params.dir ?? "");
    if (!start) continue;
    try {
      if (!statSync(start.absPath).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(root, start.absPath, 1);
  }

  return { entries, truncated };
}

function searchRepoNodeFallback(
  root: ReadyRepoRoot,
  queryLower: string,
  globSuffix: string | null,
  matches: Array<{ repo: string; path: string; line: number; text: string }>,
): boolean {
  let truncated = false;
  const walk = (dirAbs: string, depth: number) => {
    if (depth > 8 || matches.length >= MAX_SEARCH_MATCHES) {
      if (matches.length >= MAX_SEARCH_MATCHES) truncated = true;
      return;
    }
    let dirents;
    try {
      dirents = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (matches.length >= MAX_SEARCH_MATCHES) {
        truncated = true;
        return;
      }
      if (d.isSymbolicLink()) continue;
      const nextAbs = join(dirAbs, d.name);
      const rel = relative(root.realDir, nextAbs).replace(/\\/g, "/");
      if (isSensitivePath(rel)) continue;
      if (d.isDirectory()) {
        walk(nextAbs, depth + 1);
        continue;
      }
      if (!d.isFile() || isBinaryFilename(d.name)) continue;
      if (globSuffix && !d.name.toLowerCase().endsWith(globSuffix)) continue;
      try {
        const st = statSync(nextAbs);
        if (st.size > MAX_SEARCH_FILE_BYTES) continue;
        const raw = readFileSync(nextAbs, "utf8");
        if (raw.includes("\0")) continue;
        const lines = raw.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            matches.push({
              repo: root.repo,
              path: rel,
              line: i + 1,
              text: lines[i].trim().slice(0, 200),
            });
            if (matches.length >= MAX_SEARCH_MATCHES) {
              truncated = true;
              return;
            }
          }
        }
      } catch {
        // skip unreadable file
      }
    }
  };
  walk(root.realDir, 0);
  return truncated;
}

export async function searchRepoCode(
  roots: ReadyRepoRoot[],
  params: { query: string; repo?: string; glob?: string },
): Promise<{
  matches: Array<{ repo: string; path: string; line: number; text: string }>;
  truncated: boolean;
}> {
  const query = params.query.trim().slice(0, 120);
  if (!query) return { matches: [], truncated: false };
  const targets = selectRepos(roots, params.repo);
  const matches: Array<{ repo: string; path: string; line: number; text: string }> = [];
  let truncated = false;

  const safeGlob =
    params.glob && /^[A-Za-z0-9*._/?-]+$/.test(params.glob.trim())
      ? params.glob.trim().slice(0, 60)
      : undefined;

  for (const root of targets) {
    if (matches.length >= MAX_SEARCH_MATCHES) {
      truncated = true;
      break;
    }
    const rgArgs = [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--fixed-strings",
      "--ignore-case",
      "--max-filesize",
      "256K",
      "--max-count",
      "12",
      "--glob",
      "!.git/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!.env*",
      "--glob",
      "!*.lock",
    ];
    if (safeGlob) {
      rgArgs.push("--glob", safeGlob);
    }
    rgArgs.push("--", query, ".");

    try {
      const { stdout } = await execFileAsync("rg", rgArgs, {
        cwd: root.realDir,
        timeout: 8000,
        maxBuffer: 512 * 1024,
      });
      for (const rawLine of stdout.split(/\r?\n/)) {
        if (!rawLine) continue;
        const firstColon = rawLine.indexOf(":");
        if (firstColon === -1) continue;
        const secondColon = rawLine.indexOf(":", firstColon + 1);
        if (secondColon === -1) continue;
        const fileRel = rawLine.slice(0, firstColon).replace(/^\.\//, "");
        if (isSensitivePath(fileRel)) continue;
        const lineNum = Number(rawLine.slice(firstColon + 1, secondColon)) || 1;
        const text = rawLine.slice(secondColon + 1).trim().slice(0, 200);
        matches.push({ repo: root.repo, path: fileRel, line: lineNum, text });
        if (matches.length >= MAX_SEARCH_MATCHES) {
          truncated = true;
          break;
        }
      }
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      // rg exit code 1 means "no matches"
      if (code === 1) continue;
      // Fallback to Node search when rg is unavailable or fails
      const suffix = safeGlob?.startsWith("*.") ? safeGlob.slice(1).toLowerCase() : null;
      if (searchRepoNodeFallback(root, query.toLowerCase(), suffix, matches)) {
        truncated = true;
      }
    }
  }

  return { matches, truncated };
}

export function readRepoFile(
  roots: ReadyRepoRoot[],
  params: { repo?: string; path: string; start_line?: number; end_line?: number },
): {
  repo: string;
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  content: string;
  error?: string;
} {
  const targets = selectRepos(roots, params.repo);
  const rawPath = (params.path ?? "").trim();
  if (!rawPath) {
    return {
      repo: targets[0]?.repo ?? "",
      path: "",
      start_line: 1,
      end_line: 1,
      total_lines: 0,
      content: "",
      error: "File path is required",
    };
  }
  if (isBinaryFilename(basename(rawPath))) {
    return {
      repo: targets[0]?.repo ?? "",
      path: rawPath,
      start_line: 1,
      end_line: 1,
      total_lines: 0,
      content: "",
      error: "Access to this file is restricted",
    };
  }

  for (const root of targets) {
    const resolved = resolveSafeInsideRepo(root, rawPath);
    if (!resolved) continue;
    try {
      const st = lstatSync(resolved.absPath);
      if (!st.isFile()) continue;
      if (st.size > 512 * 1024) {
        return {
          repo: root.repo,
          path: resolved.relPath,
          start_line: 1,
          end_line: 1,
          total_lines: 0,
          content: "",
          error: "File is too large to read directly; use search_code to locate specific lines",
        };
      }
      const raw = readFileSync(resolved.absPath, "utf8");
      if (raw.includes("\0")) {
        return {
          repo: root.repo,
          path: resolved.relPath,
          start_line: 1,
          end_line: 1,
          total_lines: 0,
          content: "",
          error: "Binary file cannot be read",
        };
      }
      const lines = raw.split(/\r?\n/);
      const start = Math.max(1, Math.floor(Number(params.start_line) || 1));
      const requestedEnd = Math.floor(Number(params.end_line) || start + MAX_READ_LINES - 1);
      const end = Math.min(lines.length, Math.max(start, Math.min(requestedEnd, start + MAX_READ_LINES - 1)));
      const slice = lines
        .slice(start - 1, end)
        .map((line, idx) => `${start + idx}: ${line}`)
        .join("\n")
        .slice(0, MAX_READ_BYTES);
      return {
        repo: root.repo,
        path: resolved.relPath,
        start_line: start,
        end_line: end,
        total_lines: lines.length,
        content: slice,
      };
    } catch {
      continue;
    }
  }

  return {
    repo: targets[0]?.repo ?? "",
    path: rawPath,
    start_line: 1,
    end_line: 1,
    total_lines: 0,
    content: "",
    error: "File not found in bound repositories",
  };
}
