import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { redactSecrets } from "./cli-stream-parser.ts";
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors.ts";
import {
  collectReadyRepos,
  getProjectReposDir,
  getProjectReposStatus,
  isSensitivePath,
  readRepoFile,
} from "./repo-workspace.ts";
import type {
  AgentProjectInfo,
  WorkspaceDatabaseEntry,
  WorkspaceDatabaseKind,
  WorkspaceDbClientInfo,
  WorkspaceFileDetail,
  WorkspaceFileEntry,
  WorkspaceHandbook,
  WorkspaceQueryResult,
  WorkspaceRepoFileEntry,
  WorkspaceSqliteSchema,
  WorkspaceSummary,
} from "../app/lib/types.ts";

const MAX_WORKSPACE_FILES = 500;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MiB
const MAX_TEXT_WRITE_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024; // 512 KiB
const MAX_HANDBOOK_BYTES = 64 * 1024; // 64 KiB
const MAX_WORKSPACE_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MiB
const MAX_DATASOURCES_BYTES = 128 * 1024;
const MAX_QUERY_ROWS = 200;

const SQLITE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db"]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".woff",
  ".woff2",
  ".ttf",
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
  ".sqlite",
  ".sqlite3",
  ".db",
  ".parquet",
  ".xlsx",
  ".docx",
  ".pptx",
]);

interface StoredDatasource {
  id: string;
  name: string;
  kind: WorkspaceDatabaseKind;
  env_var?: string;
  read_only: boolean;
  host_preview: string;
  connection_url: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

const ALLOWED_DATASOURCE_KINDS = new Set<WorkspaceDatabaseKind>([
  "sqlite",
  "postgres",
  "mysql",
  "redis",
  "mongodb",
  "other",
]);

const DB_CLIENT_SPECS: Array<{
  id: WorkspaceDbClientInfo["id"];
  label: string;
  kinds: WorkspaceDatabaseKind[];
  install_hint_darwin: string;
  install_hint_linux: string;
}> = [
  {
    id: "psql",
    label: "PostgreSQL CLI (psql)",
    kinds: ["postgres"],
    install_hint_darwin: "brew install libpq && brew link --force libpq",
    install_hint_linux: "sudo apt-get install -y postgresql-client",
  },
  {
    id: "mysql",
    label: "MySQL CLI (mysql)",
    kinds: ["mysql"],
    install_hint_darwin: "brew install mysql-client",
    install_hint_linux: "sudo apt-get install -y default-mysql-client",
  },
  {
    id: "sqlite3",
    label: "SQLite CLI (sqlite3)",
    kinds: ["sqlite"],
    install_hint_darwin: "brew install sqlite",
    install_hint_linux: "sudo apt-get install -y sqlite3",
  },
  {
    id: "redis-cli",
    label: "Redis CLI (redis-cli)",
    kinds: ["redis"],
    install_hint_darwin: "brew install redis",
    install_hint_linux: "sudo apt-get install -y redis-tools",
  },
  {
    id: "mongosh",
    label: "MongoDB Shell (mongosh)",
    kinds: ["mongodb"],
    install_hint_darwin: "brew install mongosh",
    install_hint_linux: "npm install -g mongosh",
  },
];

const DB_CLIENTS_CACHE_TTL_MS = 30_000;
let dbClientsCache: { checkedAt: number; clients: WorkspaceDbClientInfo[] } | null = null;

function resolveLocalBinary(binName: string): string | null {
  const res = spawnSync("which", [binName], { encoding: "utf8", timeout: 2000 });
  if (res.status === 0) {
    const found = res.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (found && existsSync(found)) return found;
  }
  return null;
}

export function detectLocalDbClients(forceRefresh = false): WorkspaceDbClientInfo[] {
  const now = Date.now();
  if (!forceRefresh && dbClientsCache && now - dbClientsCache.checkedAt < DB_CLIENTS_CACHE_TTL_MS) {
    return dbClientsCache.clients;
  }
  const isMac = process.platform === "darwin";
  const clients: WorkspaceDbClientInfo[] = DB_CLIENT_SPECS.map((spec) => {
    const binPath = resolveLocalBinary(spec.id);
    return {
      id: spec.id,
      label: spec.label,
      kinds: spec.kinds,
      installed: Boolean(binPath),
      ...(binPath ? { bin_path: binPath } : {}),
      install_hint: isMac ? spec.install_hint_darwin : spec.install_hint_linux,
    };
  });
  dbClientsCache = { checkedAt: now, clients };
  return clients;
}

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

export function getProjectWorkspaceRoot(
  dbPath: string,
  projectId: string,
  create = false,
): string {
  if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(projectId)) {
    throw new ApiError(400, "Invalid project ID");
  }
  if (dbPath === ":memory:") {
    throw new ApiError(409, "Project workspace requires a persistent data directory");
  }
  const baseRoot = join(dirname(resolve(dbPath)), "workspaces");
  const projectRoot = join(baseRoot, projectId);
  if (create) {
    mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(projectRoot, "files"), { recursive: true, mode: 0o700 });
  }
  return projectRoot;
}

export function getProjectFilesDir(
  dbPath: string,
  projectId: string,
  create = false,
): string {
  const root = getProjectWorkspaceRoot(dbPath, projectId, create);
  const filesDir = join(root, "files");
  if (create) {
    mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  }
  return filesDir;
}

export function normalizeWorkspaceRelPath(rawPath: string): string {
  const trimmed = String(rawPath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (!trimmed) {
    throw new ApiError(400, "文件路径不能为空");
  }
  if (trimmed.length > 240 || /[\0\r\n]/.test(trimmed)) {
    throw new ApiError(400, "文件路径不合法");
  }
  const segments = trimmed.split("/");
  if (segments.length > 10) {
    throw new ApiError(400, "目录层级过深（最多 10 层）");
  }
  for (const seg of segments) {
    if (
      !seg ||
      seg === "." ||
      seg === ".." ||
      seg.startsWith(".relaydesk") ||
      /[\x00-\x1f\x7f]/.test(seg)
    ) {
      throw new ApiError(400, `不合法的路径片段：${seg || "(empty)"}`);
    }
  }
  return segments.join("/");
}

function resolveInsideFilesDir(
  filesDir: string,
  relPath: string,
): { absPath: string; relPath: string } {
  const cleanRel = normalizeWorkspaceRelPath(relPath);
  const realRoot = existsSync(filesDir) ? realpathSync(filesDir) : resolve(filesDir);
  const target = resolve(realRoot, cleanRel);
  if (target !== realRoot && !target.startsWith(realRoot + sep)) {
    throw new ApiError(400, "路径越界");
  }

  // Verify no existing ancestor is a symlink escaping filesDir.
  let probe = target;
  while (probe !== realRoot) {
    if (existsSync(probe)) {
      const lst = lstatSync(probe);
      if (lst.isSymbolicLink()) {
        throw new ApiError(400, "不允许通过符号链接访问工作区外路径");
      }
      const realProbe = realpathSync(probe);
      if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
        throw new ApiError(400, "路径越界");
      }
      break;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  return { absPath: target, relPath: cleanRel };
}

export function isSqliteFileName(name: string): boolean {
  return SQLITE_EXTENSIONS.has(extname(name).toLowerCase());
}

export function isProbablyTextFile(name: string, sample?: Buffer): boolean {
  const ext = extname(name).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (sample && sample.includes(0)) return false;
  return true;
}

function scanWorkspaceTree(
  filesDir: string,
): { entries: WorkspaceFileEntry[]; totalBytes: number; fileCount: number } {
  if (!existsSync(filesDir)) {
    return { entries: [], totalBytes: 0, fileCount: 0 };
  }
  const realRoot = realpathSync(filesDir);
  const entries: WorkspaceFileEntry[] = [];
  let totalBytes = 0;
  let fileCount = 0;

  const walk = (dir: string, depth: number) => {
    if (depth > 10 || entries.length >= MAX_WORKSPACE_FILES) return;
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const item of items) {
      if (entries.length >= MAX_WORKSPACE_FILES) break;
      if (item.name.startsWith(".relaydesk") || item.isSymbolicLink()) continue;
      const abs = join(dir, item.name);
      const rel = relative(realRoot, abs).replace(/\\/g, "/");
      if (item.isDirectory()) {
        let updatedAt = new Date().toISOString();
        try {
          updatedAt = statSync(abs).mtime.toISOString();
        } catch {
          // ignore
        }
        entries.push({
          path: rel,
          name: item.name,
          type: "dir",
          size: 0,
          updated_at: updatedAt,
          ext: "",
          is_text: false,
          is_sqlite: false,
        });
        walk(abs, depth + 1);
      } else if (item.isFile()) {
        let size = 0;
        let updatedAt = new Date().toISOString();
        try {
          const st = statSync(abs);
          size = st.size;
          updatedAt = st.mtime.toISOString();
        } catch {
          continue;
        }
        totalBytes += size;
        fileCount += 1;
        const ext = extname(item.name).toLowerCase();
        entries.push({
          path: rel,
          name: item.name,
          type: "file",
          size,
          updated_at: updatedAt,
          ext,
          is_text: isProbablyTextFile(item.name),
          is_sqlite: isSqliteFileName(item.name),
        });
      }
    }
  };

  walk(realRoot, 0);
  return { entries, totalBytes, fileCount };
}

export function listWorkspaceFiles(
  dbPath: string,
  projectId: string,
): { files: WorkspaceFileEntry[]; total_bytes: number; file_count: number } {
  if (dbPath === ":memory:") {
    return { files: [], total_bytes: 0, file_count: 0 };
  }
  const filesDir = getProjectFilesDir(dbPath, projectId, false);
  const { entries, totalBytes, fileCount } = scanWorkspaceTree(filesDir);
  return { files: entries, total_bytes: totalBytes, file_count: fileCount };
}

export function readWorkspaceFile(
  dbPath: string,
  projectId: string,
  relPath: string,
): WorkspaceFileDetail {
  const filesDir = getProjectFilesDir(dbPath, projectId, false);
  const { absPath, relPath: cleanRel } = resolveInsideFilesDir(filesDir, relPath);
  if (!existsSync(absPath)) {
    throw new ApiError(404, "文件不存在");
  }
  const st = lstatSync(absPath);
  if (!st.isFile()) {
    throw new ApiError(400, "目标不是文件");
  }
  const name = basename(cleanRel);
  const ext = extname(name).toLowerCase();
  const isSqlite = isSqliteFileName(name);
  const raw = readFileSync(absPath);
  const sample = raw.subarray(0, Math.min(raw.length, 4096));
  const isText = isProbablyTextFile(name, sample);
  if (!isText) {
    return {
      path: cleanRel,
      name,
      type: "file",
      size: st.size,
      updated_at: st.mtime.toISOString(),
      ext,
      is_text: false,
      is_sqlite: isSqlite,
    };
  }
  const truncated = raw.length > MAX_TEXT_PREVIEW_BYTES;
  const slice = truncated ? raw.subarray(0, MAX_TEXT_PREVIEW_BYTES) : raw;
  return {
    path: cleanRel,
    name,
    type: "file",
    size: st.size,
    updated_at: st.mtime.toISOString(),
    ext,
    is_text: true,
    is_sqlite: false,
    content: slice.toString("utf8"),
    truncated,
  };
}

export function readWorkspaceFileDownload(
  dbPath: string,
  projectId: string,
  relPath: string,
): { buffer: Buffer; name: string; ext: string } {
  const filesDir = getProjectFilesDir(dbPath, projectId, false);
  const { absPath, relPath: cleanRel } = resolveInsideFilesDir(filesDir, relPath);
  if (!existsSync(absPath)) {
    throw new ApiError(404, "文件不存在");
  }
  const st = lstatSync(absPath);
  if (!st.isFile()) {
    throw new ApiError(400, "目标不是文件");
  }
  return {
    buffer: readFileSync(absPath),
    name: basename(cleanRel),
    ext: extname(cleanRel).toLowerCase(),
  };
}

function assertWorkspaceQuota(filesDir: string, incomingBytes: number, existingPath?: string, requireCompleteScan = false) {
  const { entries, totalBytes, fileCount } = scanWorkspaceTree(filesDir);
  // The listing counts directories towards its cap. Never authorize an untrusted
  // upload from an incomplete view of existing files and total disk usage.
  if (requireCompleteScan && entries.length >= MAX_WORKSPACE_FILES && fileCount !== entries.length) {
    throw new ApiError(413, "项目空间目录条目已达上限");
  }
  let existingSize = 0;
  let isNewFile = true;
  if (existingPath && existsSync(existingPath)) {
    try {
      const st = lstatSync(existingPath);
      if (st.isFile()) {
        existingSize = st.size;
        isNewFile = false;
      }
    } catch {
      // ignore
    }
  }
  if (isNewFile && fileCount >= MAX_WORKSPACE_FILES) {
    throw new ApiError(400, `项目空间文件数量已达上限（最多 ${MAX_WORKSPACE_FILES} 个）`);
  }
  if (totalBytes - existingSize + incomingBytes > MAX_WORKSPACE_TOTAL_BYTES) {
    throw new ApiError(413, "项目空间总容量超出上限（最大 200 MB）");
  }
}

export function writeWorkspaceTextFile(
  dbPath: string,
  projectId: string,
  relPath: string,
  content: string,
): WorkspaceFileDetail {
  if (typeof content !== "string") {
    throw new ApiError(400, "文件内容必须为文本");
  }
  const buf = Buffer.from(content, "utf8");
  if (buf.length > MAX_TEXT_WRITE_BYTES) {
    throw new ApiError(413, "文本文件超出大小限制（最大 2 MB）");
  }
  const filesDir = getProjectFilesDir(dbPath, projectId, true);
  const { absPath, relPath: cleanRel } = resolveInsideFilesDir(filesDir, relPath);
  if (existsSync(absPath) && lstatSync(absPath).isDirectory()) {
    throw new ApiError(400, "该路径已存在同名文件夹");
  }
  assertWorkspaceQuota(filesDir, buf.length, absPath);
  mkdirSync(dirname(absPath), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(absPath), `.relaydesk-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, absPath);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return readWorkspaceFile(dbPath, projectId, cleanRel);
}

export function createWorkspaceDirectory(
  dbPath: string,
  projectId: string,
  relPath: string,
): WorkspaceFileEntry {
  const filesDir = getProjectFilesDir(dbPath, projectId, true);
  const { absPath, relPath: cleanRel } = resolveInsideFilesDir(filesDir, relPath);
  if (existsSync(absPath)) {
    const st = lstatSync(absPath);
    if (!st.isDirectory()) {
      throw new ApiError(409, "该路径已存在同名文件");
    }
  } else {
    mkdirSync(absPath, { recursive: true, mode: 0o700 });
  }
  const st = statSync(absPath);
  return {
    path: cleanRel,
    name: basename(cleanRel),
    type: "dir",
    size: 0,
    updated_at: st.mtime.toISOString(),
    ext: "",
    is_text: false,
    is_sqlite: false,
  };
}

export function uploadWorkspaceFile(
  dbPath: string,
  projectId: string,
  relPath: string,
  buffer: Buffer,
): WorkspaceFileDetail {
  if (!Buffer.isBuffer(buffer)) {
    throw new ApiError(400, "上传数据无效");
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, "上传文件超出限制（最大 20 MB）");
  }
  const filesDir = getProjectFilesDir(dbPath, projectId, true);
  const { absPath, relPath: cleanRel } = resolveInsideFilesDir(filesDir, relPath);
  if (existsSync(absPath) && lstatSync(absPath).isDirectory()) {
    throw new ApiError(400, "该路径已存在同名文件夹");
  }
  assertWorkspaceQuota(filesDir, buffer.length, absPath);
  mkdirSync(dirname(absPath), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(absPath), `.relaydesk-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, buffer, { mode: 0o600 });
    renameSync(tmp, absPath);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return readWorkspaceFile(dbPath, projectId, cleanRel);
}

export function deleteWorkspaceFile(
  dbPath: string,
  projectId: string,
  relPath: string,
): { deleted: string } {
  const filesDir = getProjectFilesDir(dbPath, projectId, false);
  const { absPath, relPath: cleanRel } = resolveInsideFilesDir(filesDir, relPath);
  if (!existsSync(absPath)) {
    throw new ApiError(404, "文件或目录不存在");
  }
  rmSync(absPath, { recursive: true, force: true });
  return { deleted: cleanRel };
}

/* -------------------------------------------------------------------------- */
/* Project Handbook (HANDBOOK.md)                                             */
/* -------------------------------------------------------------------------- */

export function readWorkspaceHandbook(
  dbPath: string,
  projectId: string,
): WorkspaceHandbook {
  if (dbPath === ":memory:") {
    return { content: "", exists: false, size: 0, updated_at: null };
  }
  const root = getProjectWorkspaceRoot(dbPath, projectId, false);
  const handbookPath = join(root, "HANDBOOK.md");
  if (!existsSync(handbookPath)) {
    return { content: "", exists: false, size: 0, updated_at: null };
  }
  const st = lstatSync(handbookPath);
  if (!st.isFile()) {
    throw new ApiError(500, "Handbook file is invalid");
  }
  const content = readFileSync(handbookPath, "utf8");
  return {
    content,
    exists: true,
    size: st.size,
    updated_at: st.mtime.toISOString(),
  };
}

export function writeWorkspaceHandbook(
  dbPath: string,
  projectId: string,
  content: string,
): WorkspaceHandbook {
  if (typeof content !== "string") {
    throw new ApiError(400, "手册内容必须为文本");
  }
  const buf = Buffer.from(content, "utf8");
  if (buf.length > MAX_HANDBOOK_BYTES) {
    throw new ApiError(413, "项目手册超出 64 KiB 限制");
  }
  const root = getProjectWorkspaceRoot(dbPath, projectId, true);
  const handbookPath = join(root, "HANDBOOK.md");
  const tmp = join(root, `.handbook-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, handbookPath);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const st = statSync(handbookPath);
  return {
    content,
    exists: true,
    size: st.size,
    updated_at: st.mtime.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Project Databases & Data Sources                                           */
/* -------------------------------------------------------------------------- */

function datasourcesFilePath(dbPath: string, projectId: string, create: boolean): string | null {
  if (dbPath === ":memory:") {
    if (create) throw new ApiError(409, "Datasources require a persistent data directory");
    return null;
  }
  const root = getProjectWorkspaceRoot(dbPath, projectId, create);
  return join(root, "datasources.json");
}

function readStoredDatasources(dbPath: string, projectId: string): StoredDatasource[] {
  const path = datasourcesFilePath(dbPath, projectId, false);
  if (!path || !existsSync(path)) return [];
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return [];
    throw new ApiError(500, "Unable to read datasources configuration");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_DATASOURCES_BYTES) {
      throw new ApiError(500, "Datasources configuration is invalid");
    }
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StoredDatasource =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as StoredDatasource).id === "string" &&
        typeof (item as StoredDatasource).name === "string",
    );
  } finally {
    closeSync(fd);
  }
}

function saveStoredDatasources(
  dbPath: string,
  projectId: string,
  list: StoredDatasource[],
): void {
  const path = datasourcesFilePath(dbPath, projectId, true)!;
  const serialized = JSON.stringify(list, null, 2);
  if (Buffer.byteLength(serialized) > MAX_DATASOURCES_BYTES) {
    throw new ApiError(400, "数据源配置超出大小限制");
  }
  const tmp = join(dirname(path), `.datasources-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, serialized, { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

const ENV_VAR_PREFIX = "RELAYDESK_DB_";
const CODEX_FILTERED_ENV_WORDS = /(KEY|SECRET|TOKEN)/i;

function sanitizeEnvSuffix(raw: string): string {
  return raw
    .trim()
    .replace(/^RELAYDESK_DB_/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

function allocateDatasourceEnvVar(
  name: string,
  kind: WorkspaceDatabaseKind,
  used: Set<string>,
  requested?: string,
): string {
  const tryCandidate = (suffix: string): string | null => {
    if (!suffix || CODEX_FILTERED_ENV_WORDS.test(suffix)) return null;
    const base = `${ENV_VAR_PREFIX}${suffix}`;
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    for (let i = 2; i <= 99; i++) {
      const next = `${base}_${i}`;
      if (!used.has(next)) {
        used.add(next);
        return next;
      }
    }
    return null;
  };

  if (requested && requested.trim()) {
    const reqSuffix = sanitizeEnvSuffix(requested);
    if (!reqSuffix) {
      throw new ApiError(400, "环境变量后缀仅支持英文字母、数字和下划线");
    }
    if (CODEX_FILTERED_ENV_WORDS.test(reqSuffix)) {
      throw new ApiError(400, "环境变量名请避免包含 KEY / SECRET / TOKEN，以免被 Codex 沙箱自动过滤");
    }
    const candidate = `${ENV_VAR_PREFIX}${reqSuffix}`;
    if (used.has(candidate)) {
      throw new ApiError(409, `环境变量 ${candidate} 已被其他数据源使用`);
    }
    used.add(candidate);
    return candidate;
  }

  const fromName = sanitizeEnvSuffix(name);
  const picked = tryCandidate(fromName);
  if (picked) return picked;

  const kindTag = kind.toUpperCase().replace(/[^A-Z0-9]+/g, "_") || "EXT";
  for (let i = 1; i <= 99; i++) {
    const fallback = `${ENV_VAR_PREFIX}${kindTag}_${i}`;
    if (!used.has(fallback)) {
      used.add(fallback);
      return fallback;
    }
  }
  const uniqueFallback = `${ENV_VAR_PREFIX}${randomUUID().slice(0, 8).toUpperCase()}`;
  used.add(uniqueFallback);
  return uniqueFallback;
}

function resolveDatasourceEnvVars(list: StoredDatasource[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const item of list) {
    if (
      item.env_var &&
      /^RELAYDESK_DB_[A-Z0-9_]{1,40}$/.test(item.env_var) &&
      !CODEX_FILTERED_ENV_WORDS.test(item.env_var) &&
      !used.has(item.env_var)
    ) {
      used.add(item.env_var);
      map.set(item.id, item.env_var);
    }
  }
  for (const item of list) {
    if (!map.has(item.id)) {
      const assigned = allocateDatasourceEnvVar(item.name, item.kind, used);
      map.set(item.id, assigned);
    }
  }
  return map;
}

function extractConnectionSecrets(rawUrl: string): string[] {
  const trimmed = rawUrl.trim();
  if (!trimmed) return [];
  const secrets = new Set<string>();
  if (trimmed.length >= 6) {
    secrets.add(trimmed);
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.password && parsed.password.length >= 4) {
      secrets.add(parsed.password);
      try {
        const decoded = decodeURIComponent(parsed.password);
        if (decoded && decoded.length >= 4) secrets.add(decoded);
      } catch {
        // ignore invalid percent encoding
      }
    }
  } catch {
    // Also check libpq / DSN key=value password syntax
    const match = trimmed.match(/(?:^|\s)password\s*=\s*(?:'([^']+)'|"([^"]+)"|(\S+))/i);
    const pwd = match?.[1] || match?.[2] || match?.[3];
    if (pwd && pwd.length >= 4) {
      secrets.add(pwd);
    }
  }
  return Array.from(secrets);
}

function redactConnectionPreview(rawUrl: string, kind: WorkspaceDatabaseKind): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  if (kind === "sqlite") {
    return trimmed.slice(0, 120);
  }
  try {
    const url = new URL(trimmed);
    const dbPart = url.pathname && url.pathname !== "/" ? url.pathname : "";
    const portPart = url.port ? `:${url.port}` : "";
    return `${url.protocol}//${url.hostname}${portPart}${dbPart}`;
  } catch {
    return `${kind}://(custom)`;
  }
}

function encodeFileDbId(relPath: string): string {
  return "file:" + Buffer.from(relPath, "utf8").toString("base64url");
}

function decodeFileDbId(dbId: string): string | null {
  if (!dbId.startsWith("file:")) return null;
  try {
    const rel = Buffer.from(dbId.slice(5), "base64url").toString("utf8");
    return normalizeWorkspaceRelPath(rel);
  } catch {
    return null;
  }
}

function countSqliteTables(absPath: string): number {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(absPath, { readOnly: true });
    const row = db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { cnt?: number } | undefined;
    return Number(row?.cnt ?? 0);
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

export function listWorkspaceDatabases(
  dbPath: string,
  projectId: string,
): WorkspaceDatabaseEntry[] {
  if (dbPath === ":memory:") return [];
  const filesDir = getProjectFilesDir(dbPath, projectId, false);
  const { entries } = scanWorkspaceTree(filesDir);
  return listDatabasesForFiles(dbPath, projectId, filesDir, entries);
}

function listDatabasesForFiles(dbPath: string, projectId: string, filesDir: string, entries: WorkspaceFileEntry[]): WorkspaceDatabaseEntry[] {
  const results: WorkspaceDatabaseEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "file" && entry.is_sqlite) {
      const abs = join(filesDir, entry.path);
      results.push({
        id: encodeFileDbId(entry.path),
        name: entry.name,
        kind: "sqlite",
        source: "workspace_file",
        file_path: entry.path,
        read_only: true,
        queryable: true,
        size: entry.size,
        table_count: countSqliteTables(abs),
        host_preview: `files/${entry.path}`,
        has_connection_url: false,
        notes: "项目空间内 SQLite 文件，支持在线浏览表结构、只读 SQL 查询以及 Codex 直接分析。",
        updated_at: entry.updated_at,
      });
    }
  }

  const configured = readStoredDatasources(dbPath, projectId);
  const envVarMap = resolveDatasourceEnvVars(configured);
  for (const item of configured) {
    results.push({
      id: item.id,
      name: item.name,
      kind: item.kind,
      source: "external",
      env_var: envVarMap.get(item.id),
      read_only: item.read_only,
      queryable: false,
      host_preview: item.host_preview,
      has_connection_url: Boolean(item.connection_url),
      notes: item.notes,
      updated_at: item.updated_at,
    });
  }
  return results;
}

export function createWorkspaceSqliteDatabase(
  dbPath: string,
  projectId: string,
  payload: { name: string; init_sql?: string },
): WorkspaceDatabaseEntry {
  const rawName = String(payload.name ?? "").trim();
  if (!rawName || rawName.length > 64) {
    throw new ApiError(400, "请输入 1-64 字符的数据库名称");
  }
  const safeBase = rawName
    .replace(/\.(sqlite3|sqlite|db)$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safeBase) {
    throw new ApiError(400, "数据库名称需包含字母或数字");
  }
  const relPath = `databases/${safeBase}.sqlite`;
  const filesDir = getProjectFilesDir(dbPath, projectId, true);
  const { absPath } = resolveInsideFilesDir(filesDir, relPath);
  if (existsSync(absPath)) {
    throw new ApiError(409, `数据库文件 ${relPath} 已存在`);
  }
  assertWorkspaceQuota(filesDir, 64 * 1024);
  mkdirSync(dirname(absPath), { recursive: true, mode: 0o700 });

  const initSql = typeof payload.init_sql === "string" ? payload.init_sql.trim() : "";
  if (initSql.length > 100_000) {
    throw new ApiError(400, "初始化 SQL 过长（最多 100 KB）");
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(absPath);
    db.exec("PRAGMA journal_mode = DELETE;");
    if (initSql) {
      db.exec(initSql);
    }
  } catch (err) {
    try {
      db?.close();
    } catch {
      // ignore
    }
    try {
      unlinkSync(absPath);
    } catch {
      // ignore
    }
    throw new ApiError(
      400,
      `初始化 SQL 执行失败：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }

  const st = statSync(absPath);
  return {
    id: encodeFileDbId(relPath),
    name: basename(relPath),
    kind: "sqlite",
    source: "workspace_file",
    file_path: relPath,
    read_only: true,
    queryable: true,
    size: st.size,
    table_count: countSqliteTables(absPath),
    host_preview: `files/${relPath}`,
    has_connection_url: false,
    notes: "项目空间内 SQLite 文件，支持在线浏览表结构、只读 SQL 查询以及 Codex 直接分析。",
    updated_at: st.mtime.toISOString(),
  };
}

export function addWorkspaceExternalDatasource(
  dbPath: string,
  projectId: string,
  payload: {
    name: string;
    kind: WorkspaceDatabaseKind;
    env_var?: string;
    connection_url?: string;
    read_only?: boolean;
    notes?: string;
  },
): WorkspaceDatabaseEntry {
  const name = String(payload.name ?? "").trim().slice(0, 80);
  if (!name) throw new ApiError(400, "请输入数据源名称");
  const kind = payload.kind;
  if (!ALLOWED_DATASOURCE_KINDS.has(kind)) {
    throw new ApiError(400, "不支持的数据源类型");
  }
  const connectionUrl = typeof payload.connection_url === "string" ? payload.connection_url.trim() : "";
  if (connectionUrl.length > 2048) {
    throw new ApiError(400, "连接串过长");
  }
  const notes = typeof payload.notes === "string" ? payload.notes.trim().slice(0, 8000) : "";
  const readOnly = payload.read_only !== false;

  const list = readStoredDatasources(dbPath, projectId);
  if (list.length >= 20) {
    throw new ApiError(400, "单个项目最多配置 20 个外部数据源");
  }
  const existingEnvVars = new Set(resolveDatasourceEnvVars(list).values());
  const envVar = allocateDatasourceEnvVar(name, kind, existingEnvVars, payload.env_var);
  const now = new Date().toISOString();
  const record: StoredDatasource = {
    id: `ext_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    name,
    kind,
    env_var: envVar,
    read_only: readOnly,
    host_preview: redactConnectionPreview(connectionUrl, kind),
    connection_url: connectionUrl,
    notes,
    created_at: now,
    updated_at: now,
  };
  list.push(record);
  saveStoredDatasources(dbPath, projectId, list);

  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    source: "external",
    env_var: record.env_var,
    read_only: record.read_only,
    queryable: false,
    host_preview: record.host_preview,
    has_connection_url: Boolean(record.connection_url),
    notes: record.notes,
    updated_at: record.updated_at,
  };
}

export function updateWorkspaceExternalDatasource(
  dbPath: string,
  projectId: string,
  dbId: string,
  patch: {
    name?: string;
    kind?: WorkspaceDatabaseKind;
    env_var?: string;
    connection_url?: string;
    clear_connection_url?: boolean;
    read_only?: boolean;
    notes?: string;
  },
): WorkspaceDatabaseEntry {
  const list = readStoredDatasources(dbPath, projectId);
  const idx = list.findIndex((item) => item.id === dbId);
  if (idx === -1) {
    throw new ApiError(404, "外部数据源不存在");
  }
  const current = list[idx];
  const name =
    patch.name !== undefined ? String(patch.name).trim().slice(0, 80) : current.name;
  if (!name) throw new ApiError(400, "请输入数据源名称");

  const kind = patch.kind !== undefined ? patch.kind : current.kind;
  if (!ALLOWED_DATASOURCE_KINDS.has(kind)) {
    throw new ApiError(400, "不支持的数据源类型");
  }

  let connectionUrl = current.connection_url;
  if (patch.clear_connection_url === true) {
    connectionUrl = "";
  } else if (typeof patch.connection_url === "string" && patch.connection_url.trim()) {
    const nextUrl = patch.connection_url.trim();
    if (nextUrl.length > 2048) throw new ApiError(400, "连接串过长");
    connectionUrl = nextUrl;
  }

  const readOnly =
    typeof patch.read_only === "boolean" ? patch.read_only : current.read_only;
  const notes =
    patch.notes !== undefined
      ? String(patch.notes).trim().slice(0, 8000)
      : current.notes;

  const others = list.filter((item) => item.id !== dbId);
  const otherEnvVars = new Set(resolveDatasourceEnvVars(others).values());
  let envVar = current.env_var;
  if (typeof patch.env_var === "string" && patch.env_var.trim()) {
    envVar = allocateDatasourceEnvVar(name, kind, otherEnvVars, patch.env_var);
  } else if (!envVar || !/^RELAYDESK_DB_[A-Z0-9_]{1,40}$/.test(envVar) || otherEnvVars.has(envVar)) {
    envVar = allocateDatasourceEnvVar(name, kind, otherEnvVars);
  }

  const updated: StoredDatasource = {
    ...current,
    name,
    kind,
    env_var: envVar,
    read_only: readOnly,
    connection_url: connectionUrl,
    host_preview: redactConnectionPreview(connectionUrl, kind),
    notes,
    updated_at: new Date().toISOString(),
  };
  list[idx] = updated;
  saveStoredDatasources(dbPath, projectId, list);

  return {
    id: updated.id,
    name: updated.name,
    kind: updated.kind,
    source: "external",
    env_var: updated.env_var,
    read_only: updated.read_only,
    queryable: false,
    host_preview: updated.host_preview,
    has_connection_url: Boolean(updated.connection_url),
    notes: updated.notes,
    updated_at: updated.updated_at,
  };
}

/**
 * Server-only runtime environment variables and secret values for external datasources.
 * Never expose this return value to HTTP responses or frontend state.
 */
export function getWorkspaceDatasourceRuntimeEnv(
  dbPath: string,
  projectId: string,
): {
  env: Record<string, string>;
  secrets: string[];
  pgReadOnlyEnforced: boolean;
} {
  if (dbPath === ":memory:") {
    return { env: {}, secrets: [], pgReadOnlyEnforced: false };
  }
  const configured = readStoredDatasources(dbPath, projectId);
  const envVarMap = resolveDatasourceEnvVars(configured);
  const env: Record<string, string> = {};
  const secretSet = new Set<string>();
  let hasPostgresWithUrl = false;
  let allPostgresReadOnly = true;

  for (const item of configured) {
    const url = item.connection_url.trim();
    if (!url) continue;
    const varName = envVarMap.get(item.id);
    if (varName) {
      env[varName] = url;
    }
    for (const s of extractConnectionSecrets(url)) {
      secretSet.add(s);
    }
    if (item.kind === "postgres") {
      hasPostgresWithUrl = true;
      if (!item.read_only) {
        allPostgresReadOnly = false;
      }
    }
  }

  const pgReadOnlyEnforced = hasPostgresWithUrl && allPostgresReadOnly;
  return {
    env,
    secrets: Array.from(secretSet),
    pgReadOnlyEnforced,
  };
}

export function deleteWorkspaceDatabase(
  dbPath: string,
  projectId: string,
  dbId: string,
): { deleted: string } {
  const fileRel = decodeFileDbId(dbId);
  if (fileRel) {
    deleteWorkspaceFile(dbPath, projectId, fileRel);
    return { deleted: dbId };
  }
  const list = readStoredDatasources(dbPath, projectId);
  const next = list.filter((item) => item.id !== dbId);
  if (next.length === list.length) {
    throw new ApiError(404, "数据源不存在");
  }
  saveStoredDatasources(dbPath, projectId, next);
  return { deleted: dbId };
}

function resolveSqliteDbPath(dbPath: string, projectId: string, dbId: string): { absPath: string; relPath: string } {
  const relPath = decodeFileDbId(dbId);
  if (!relPath) {
    throw new ApiError(400, "仅项目空间内的 SQLite 文件支持在线表结构浏览和 SQL 查询");
  }
  const filesDir = getProjectFilesDir(dbPath, projectId, false);
  const resolved = resolveInsideFilesDir(filesDir, relPath);
  if (!existsSync(resolved.absPath) || !lstatSync(resolved.absPath).isFile()) {
    throw new ApiError(404, "SQLite 文件不存在");
  }
  return resolved;
}

export function inspectWorkspaceSqliteSchema(
  dbPath: string,
  projectId: string,
  dbId: string,
): WorkspaceSqliteSchema {
  const { absPath, relPath } = resolveSqliteDbPath(dbPath, projectId, dbId);
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(absPath, { readOnly: true });
    const rawTables = db
      .prepare(
        "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type ASC, name ASC",
      )
      .all() as Array<{ name: string; type: "table" | "view"; sql: string | null }>;

    const tables = rawTables.map((t) => {
      const quoted = `"${t.name.replace(/"/g, '""')}"`;
      const columnsRaw = db!
        .prepare(`PRAGMA table_info(${quoted})`)
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: string | null;
      }>;
      let rowCount = 0;
      try {
        const cnt = db!
          .prepare(`SELECT COUNT(*) AS cnt FROM ${quoted}`)
          .get() as { cnt?: number } | undefined;
        rowCount = Number(cnt?.cnt ?? 0);
      } catch {
        rowCount = 0;
      }
      return {
        name: t.name,
        type: t.type,
        row_count: rowCount,
        sql: t.sql ?? "",
        columns: columnsRaw.map((c) => ({
          name: c.name,
          type: c.type || "ANY",
          notnull: Boolean(c.notnull),
          pk: Boolean(c.pk),
          default_value: c.dflt_value,
        })),
      };
    });

    return {
      database_id: dbId,
      file_path: relPath,
      tables,
    };
  } catch (err) {
    throw new ApiError(
      400,
      `无法读取 SQLite 结构：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function stripLeadingSqlComments(sql: string): string {
  let s = sql.trim();
  while (s.startsWith("--") || s.startsWith("/*")) {
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1).trim();
    } else {
      const end = s.indexOf("*/");
      if (end === -1) break;
      s = s.slice(end + 2).trim();
    }
  }
  return s;
}

function formatCellValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `<BLOB ${value.byteLength} bytes>`;
  }
  const str = String(value);
  return str.length > 2000 ? str.slice(0, 2000) + "…" : str;
}

export function queryWorkspaceSqlite(
  dbPath: string,
  projectId: string,
  dbId: string,
  rawSql: string,
  requestedLimit = 100,
): WorkspaceQueryResult {
  const { absPath } = resolveSqliteDbPath(dbPath, projectId, dbId);
  const trimmed = String(rawSql ?? "").trim().replace(/;+\s*$/, "");
  if (!trimmed) {
    throw new ApiError(400, "请输入只读 SQL 语句");
  }
  if (trimmed.length > 16_000) {
    throw new ApiError(400, "SQL 语句过长");
  }
  const body = stripLeadingSqlComments(trimmed);
  const upper = body.toUpperCase();
  const isAllowed =
    upper.startsWith("SELECT ") ||
    upper.startsWith("SELECT\n") ||
    upper.startsWith("WITH ") ||
    upper.startsWith("WITH\n") ||
    upper.startsWith("EXPLAIN ") ||
    /^PRAGMA\s+(?:TABLE_INFO|TABLE_LIST|INDEX_LIST|FOREIGN_KEY_LIST|DATABASE_LIST)\b/i.test(body);
  if (!isAllowed) {
    throw new ApiError(400, "仅允许只读查询（SELECT / WITH / EXPLAIN / 只读 PRAGMA）");
  }
  const limit = Math.max(1, Math.min(MAX_QUERY_ROWS, Math.floor(Number(requestedLimit) || 100)));

  const startedAt = Date.now();
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(absPath, { readOnly: true });
    const stmt = db.prepare(trimmed);
    const iter = stmt.iterate();
    const rows: Array<Record<string, string | number | boolean | null>> = [];
    let columns: string[] = [];
    let truncated = false;
    for (const rawRow of iter) {
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      const obj = rawRow as Record<string, unknown>;
      if (columns.length === 0) {
        columns = Object.keys(obj);
      }
      const formatted: Record<string, string | number | boolean | null> = {};
      for (const col of columns) {
        formatted[col] = formatCellValue(obj[col]);
      }
      rows.push(formatted);
    }
    return {
      columns,
      rows,
      row_count: rows.length,
      truncated,
      duration_ms: Date.now() - startedAt,
    };
  } catch (err) {
    throw new ApiError(
      400,
      `SQL 查询失败：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/* Bridge paths are wire paths relative to the space, never host filesystem paths. */
function bridgeFilePath(dbPath: string, projectId: string, path: string) {
  const root = getProjectWorkspaceRoot(dbPath, projectId);
  if (typeof path !== "string" || (path !== "HANDBOOK.md" && !path.startsWith("files/"))) {
    throw new ApiError(400, "仅允许访问 HANDBOOK.md 或 files/ 中的文件");
  }
  if (path !== "HANDBOOK.md") {
    const rel = path.slice(6);
    if (normalizeWorkspaceRelPath(rel) !== rel || /[:\\]/.test(rel) ||
        rel.split("/").some(part => part.startsWith(".") || /^(?:auth|datasources)\.json$/i.test(part)) ||
        // Repository browsing excludes all SQLite files. The space explicitly shares
        // SQLite databases, but the remaining sensitive-name rules must still apply.
        isSensitivePath(rel.toLowerCase().replace(/\.(sqlite3?|db)$/i, ".workspace-data"))) {
      throw new ApiError(403, "不允许同步此路径");
    }
  }
  const target = join(root, path);
  checkBridgeDirs(dirname(root), dirname(target));
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (st && (!st.isFile() || st.nlink !== 1)) throw new ApiError(403, "不允许访问链接或特殊文件");
  return target;
}

function checkBridgeDirs(base: string, parent: string, create = false) {
  let dir = base;
  for (const part of ["", ...relative(base, parent).split(sep)]) {
    dir = join(dir, part);
    if (create) {
      try { mkdirSync(dir, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) throw new ApiError(403, "工作区目录无效或包含符号链接");
  }
}

function openBridgeFile(dbPath: string, projectId: string, path: string, maxBytes: number) {
  const file = bridgeFilePath(dbPath, projectId, path);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isMissing(error)) throw new ApiError(404, "文件不存在"); throw error; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new ApiError(403, "不允许访问链接或特殊文件");
    const limit = path === "HANDBOOK.md" ? Math.min(maxBytes, MAX_HANDBOOK_BYTES) : maxBytes;
    if (st.size > limit) throw new ApiError(413, "文件超出传输大小限制");
    return { file, fd, size: st.size, updated_at: st.mtime.toISOString() };
  } catch (err) { closeSync(fd); throw err; }
}

function readBridgeChunks(fd: number, size: number, onChunk: (bytes: Buffer, position: number) => void) {
  const scratch = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
  for (let pos = 0; pos < size;) {
    const n = readSync(fd, scratch, 0, Math.min(scratch.length, size - pos), pos);
    if (!n) throw new ApiError(409, "文件在同步过程中发生变化");
    onChunk(scratch.subarray(0, n), pos);
    pos += n;
  }
}
function bridgeDigest(fd: number, size: number) {
  const hash = createHash("sha256");
  readBridgeChunks(fd, size, chunk => { hash.update(chunk); });
  return hash.digest("hex");
}
export function readBridgeWorkspaceFile(dbPath: string, projectId: string, path: string, maxBytes = MAX_UPLOAD_BYTES): Buffer {
  const { fd, size } = openBridgeFile(dbPath, projectId, path, maxBytes);
  try {
    const bytes = Buffer.allocUnsafe(size);
    readBridgeChunks(fd, size, (chunk, pos) => { chunk.copy(bytes, pos); });
    return bytes;
  } finally { closeSync(fd); }
}
export function streamBridgeWorkspaceFile(dbPath: string, projectId: string, path: string) {
  const { file, fd, size } = openBridgeFile(dbPath, projectId, path, MAX_UPLOAD_BYTES);
  try {
    const sha256 = bridgeDigest(fd, size);
    return { size, sha256, stream: createReadStream(file, { fd, start: 0, ...(size > 0 ? { end: size - 1 } : {}) }) };
  } catch (err) { closeSync(fd); throw err; }
}

export function writeBridgeWorkspaceFile(dbPath: string, projectId: string, path: string, bytes: Buffer) {
  if (!Buffer.isBuffer(bytes)) throw new ApiError(400, "文件内容无效");
  if (!path.startsWith("files/")) throw new ApiError(403, "本机节点只能写入 files/ 下的文件");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new ApiError(413, "文件超出传输大小限制");
  const file = bridgeFilePath(dbPath, projectId, path);
  assertWorkspaceQuota(getProjectFilesDir(dbPath, projectId), bytes.length, file, true);
  const root = getProjectWorkspaceRoot(dbPath, projectId);
  checkBridgeDirs(dirname(root), dirname(file), true);
  const tmp = join(dirname(file), `.relaydesk-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

export function buildWorkspaceManifest(dbPath: string, projectId: string) {
  const files: Array<{ path: string; size: number; updated_at: string; mtime: string; sha256: string }> = [];
  let handbook: { size: number; sha256: string; updated_at: string } | null = null;
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  if (dbPath === ":memory:") return { handbook, handbook_sha256: null, files, databases: [] };
  const root = getProjectWorkspaceRoot(dbPath, projectId);
  try {
    const bytes = readBridgeWorkspaceFile(dbPath, projectId, "HANDBOOK.md");
    handbook = { size: bytes.length, sha256: digest(bytes), updated_at: lstatSync(join(root, "HANDBOOK.md")).mtime.toISOString() };
  } catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
  // Check the files root before the generic listing (which resolves its realpath).
  const filesDir = join(root, "files");
  checkBridgeDirs(dirname(root), filesDir);
  const permitted: WorkspaceFileEntry[] = [];
  for (const entry of listWorkspaceFiles(dbPath, projectId).files) {
    if (entry.type !== "file") continue;
    try {
      const wirePath = `files/${entry.path}`;
      const { fd, size, updated_at } = openBridgeFile(dbPath, projectId, wirePath, Number.MAX_SAFE_INTEGER);
      try {
        files.push({ path: entry.path, size, updated_at, mtime: updated_at, sha256: bridgeDigest(fd, size) });
      } finally { closeSync(fd); }
      permitted.push(entry);
    } catch (error) {
      if (!(error instanceof ApiError && [400, 403, 404].includes(error.status))) throw error;
    }
  }
  const { secrets } = getWorkspaceDatasourceRuntimeEnv(dbPath, projectId);
  const databases = listDatabasesForFiles(dbPath, projectId, filesDir, permitted).map(db => ({
    ...db, name: redactSecrets(db.name, secrets), notes: redactSecrets(db.notes, secrets),
    host_preview: db.kind === "sqlite" && db.source === "external" ? "" : redactSecrets(db.host_preview, secrets),
  }));
  return { handbook, handbook_sha256: handbook?.sha256 ?? null, files, databases };
}

/* -------------------------------------------------------------------------- */
/* Repository Browser & Chat Workspace Assembly                               */
/* -------------------------------------------------------------------------- */

export function browseProjectRepoFiles(
  dbPath: string,
  project: AgentProjectInfo,
  repo?: string,
  subpath?: string,
): { entries: WorkspaceRepoFileEntry[]; truncated: boolean } {
  const roots = collectReadyRepos(dbPath, project);
  const target = repo
    ? roots.find((r) => r.repo.toLowerCase() === repo.toLowerCase())
    : roots[0];
  if (!target) {
    return { entries: [], truncated: false };
  }

  const cleanSub = (subpath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (cleanSub && isSensitivePath(cleanSub)) {
    return { entries: [], truncated: false };
  }
  const absDir = cleanSub ? resolve(target.realDir, cleanSub) : target.realDir;
  if (absDir !== target.realDir && !absDir.startsWith(target.realDir + sep)) {
    return { entries: [], truncated: false };
  }
  if (!existsSync(absDir)) {
    return { entries: [], truncated: false };
  }

  let dirents;
  try {
    dirents = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return { entries: [], truncated: false };
  }
  dirents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const entries: WorkspaceRepoFileEntry[] = [];
  let truncated = false;
  for (const item of dirents) {
    if (entries.length >= 200) {
      truncated = true;
      break;
    }
    if (item.isSymbolicLink()) continue;
    const rel = cleanSub ? `${cleanSub}/${item.name}` : item.name;
    if (isSensitivePath(rel)) continue;
    if (item.isDirectory()) {
      entries.push({ repo: target.repo, path: rel, type: "dir" });
    } else if (item.isFile()) {
      let size: number | undefined;
      try {
        size = statSync(join(absDir, item.name)).size;
      } catch {
        // ignore
      }
      entries.push({ repo: target.repo, path: rel, type: "file", size });
    }
  }
  return { entries, truncated };
}

export function readProjectRepoFileContent(
  dbPath: string,
  project: AgentProjectInfo,
  params: { repo?: string; path: string; start_line?: number; end_line?: number },
) {
  const roots = collectReadyRepos(dbPath, project);
  return readRepoFile(roots, params);
}

export function prepareProjectChatWorkspace(
  dbPath: string,
  project: AgentProjectInfo,
): {
  workspaceDir: string;
  filesDir: string;
  reposDir: string | null;
  readyRepos: Array<{ repo: string; dirName: string; commit: string }>;
  handbook: WorkspaceHandbook;
  databases: WorkspaceDatabaseEntry[];
  dbClients: WorkspaceDbClientInfo[];
  files: WorkspaceFileEntry[];
} {
  const workspaceDir = getProjectWorkspaceRoot(dbPath, project.id, true);
  const filesDir = join(workspaceDir, "files");
  const reposLinkPath = join(workspaceDir, "repos");
  const reposDir = getProjectReposDir(dbPath, project.id);
  const readyRoots = collectReadyRepos(dbPath, project);

  // Keep a convenient `repos` symlink inside the project workspace when synced mirrors exist.
  try {
    if (existsSync(reposLinkPath) || (() => { try { lstatSync(reposLinkPath); return true; } catch { return false; } })()) {
      const lst = lstatSync(reposLinkPath);
      if (lst.isSymbolicLink()) {
        unlinkSync(reposLinkPath);
      }
    }
    if (reposDir && existsSync(reposDir) && readyRoots.length > 0 && !existsSync(reposLinkPath)) {
      symlinkSync(reposDir, reposLinkPath, "dir");
    }
  } catch {
    // Non-fatal: Codex can still be informed of the absolute repo path via --add-dir.
  }

  const handbook = readWorkspaceHandbook(dbPath, project.id);
  const databases = listWorkspaceDatabases(dbPath, project.id);
  const dbClients = detectLocalDbClients();
  const { files } = listWorkspaceFiles(dbPath, project.id);

  return {
    workspaceDir,
    filesDir,
    reposDir: reposDir && existsSync(reposDir) && readyRoots.length > 0 ? reposDir : null,
    readyRepos: readyRoots.map((r) => ({
      repo: r.repo,
      dirName: basename(r.dir),
      commit: r.commit,
    })),
    handbook,
    databases,
    dbClients,
    files,
  };
}

export function getWorkspaceSummary(
  dbPath: string,
  project: AgentProjectInfo,
  localClis: { codex: boolean; claude: boolean },
): WorkspaceSummary {
  const { total_bytes, file_count } = listWorkspaceFiles(dbPath, project.id);
  const handbook = readWorkspaceHandbook(dbPath, project.id);
  const databases = listWorkspaceDatabases(dbPath, project.id);
  const reposStatus = getProjectReposStatus(dbPath, project);
  return {
    files_count: file_count,
    total_bytes,
    handbook_exists: handbook.exists,
    handbook_size: handbook.size,
    handbook_updated_at: handbook.updated_at,
    databases_count: databases.length,
    sqlite_count: databases.filter((d) => d.source === "workspace_file").length,
    repos_status: reposStatus,
    local_clis: localClis,
  };
}
