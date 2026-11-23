import { createHash, randomUUID } from "node:crypto";
import {
  constants as fs,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isSensitivePath } from "../../server/repo-workspace.ts";

const RPC_LIMIT = 2 * 1024 * 1024;
const DOC_LIMIT = 64 * 1024;
const FILE_LIMIT = 20 * 1024 * 1024;
const TOTAL_LIMIT = 200 * 1024 * 1024;
const ROOT_DOCS = ["HANDBOOK.md", "DEPLOY.md"] as const;
const HASH = /^[a-f0-9]{64}$/;
function isRootDoc(path: string): boolean {
  return path === "HANDBOOK.md" || path === "DEPLOY.md";
}
export interface SpaceManifest {
  handbook_sha256?: string | null;
  handbook?: { size: number; sha256: string } | null;
  deploy_doc_sha256?: string | null;
  deploy_doc?: { size: number; sha256: string } | null;
  files: { path: string; size: number; sha256: string; mtime?: unknown }[];
  databases?: unknown[];
}
export type WorkspaceRpc = (
  type: "workspace.fetch" | "workspace.push",
  payload: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;
interface SyncOptions {
  cacheDir: string;
  workdir?: string;
  onFileSynced?(): void;
  projectId: string;
  runId: string;
  serverUrl: string;
  token: string;
  rpc: WorkspaceRpc;
  signal: AbortSignal;
}

export function validProjectId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
    !["constructor", "prototype", "__proto__"].includes(id)
  );
}
function safeFile(path: string): boolean {
  if (typeof path !== "string" || !path || path.length > 240 || /[\\:\x00-\x1f\x7f]/.test(path)) return false;
  const parts = path.split("/");
  if (parts.length > 10 || parts.some((p) => !p || p.startsWith(".") || /^(?:auth\.json|datasources\.json)$/i.test(p)))
    return false;
  // SQLite is first-class workspace content. Remove only the database suffix before applying repo secret rules.
  return !isSensitivePath(path.toLowerCase().replace(/\.(sqlite3?|db)$/i, ".workspace-database"));
}
function stat(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}
function directory(path: string, create: boolean) {
  if (create && !stat(path)) mkdirSync(path, { mode: 0o700 });
  if (!stat(path)?.isDirectory() || realpathSync(path) !== path) throw new Error("Unsafe workspace directory");
}
function projectDir(options: SyncOptions) {
  if (!validProjectId(options.projectId)) throw new Error("Invalid project ID");
  const configured = resolve(options.cacheDir);
  if (options.workdir) {
    let ancestor = configured;
    while (!stat(ancestor)) ancestor = dirname(ancestor);
    const target = join(realpathSync(ancestor), relative(ancestor, configured), options.projectId);
    const cwd = realpathSync(options.workdir);
    if (target === cwd || target.startsWith(cwd + sep) || cwd.startsWith(target + sep))
      throw new Error("Shadow cache must be separate from the bound workdir");
  }
  mkdirSync(configured, { recursive: true, mode: 0o700 });
  if (!stat(configured)?.isDirectory()) throw new Error("Unsafe spaces cache");
  const base = realpathSync(configured);
  const root = join(base, options.projectId);
  directory(root, true);
  directory(join(root, "files"), true);
  return root;
}
function checkedPath(root: string, path: string, create: boolean) {
  if (path !== "HANDBOOK.md" && path !== "DEPLOY.md" && !(path.startsWith("files/") && safeFile(path.slice(6))))
    throw new Error("Unsafe workspace file path");
  directory(root, false);
  let parent = root;
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    directory(parent, create);
  }
  const abs = join(root, path),
    st = stat(abs);
  if (st && (!st.isFile() || st.nlink !== 1)) throw new Error("Unsafe workspace file");
  return abs;
}
function readChecked(root: string, path: string, limit = FILE_LIMIT): Buffer | undefined {
  const abs = checkedPath(root, path, false);
  if (!stat(abs)) return;
  const fd = openSync(abs, fs.O_RDONLY | fs.O_NONBLOCK | fs.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > limit || realpathSync(abs) !== abs)
      throw new Error("Unsafe or oversized workspace file");
    const buf = Buffer.alloc(s.size);
    let n = 0;
    while (n < buf.length) {
      const count = readSync(fd, buf, n, buf.length - n, null);
      if (!count) break;
      n += count;
    }
    if (n !== s.size || fstatSync(fd).size !== n) throw new Error("Workspace file changed during read");
    return buf;
  } finally {
    closeSync(fd);
  }
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function scan(root: string): string[] {
  directory(root, false);
  const found: string[] = [];
  for (const doc of ROOT_DOCS) {
    const s = stat(join(root, doc));
    if (s?.isFile() && s.nlink === 1 && s.size <= FILE_LIMIT) found.push(doc);
  }
  let visited = 0;
  function walk(rel: string) {
    const dir = join(root, rel);
    directory(dir, false);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 5000) throw new Error("Workspace entry limit exceeded");
      const path = `${rel}/${entry.name}`;
      if (!safeFile(path.slice(6))) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const s = stat(join(root, path));
        if (s?.isFile() && s.nlink === 1 && s.size <= FILE_LIMIT) found.push(path);
      }
    }
  }
  walk("files");
  return found;
}
// A prior writable or interrupted turn may leave files that must not be visible
// in the next turn (including sensitive names, large files, and dangling links).
function prune(root: string, expected: Map<string, string>) {
  let visited = 0;
  function visit(dir: string, prefix: string) {
    directory(dir, false);
    for (const leaf of readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 5000) throw new Error("Workspace entry limit exceeded");
      directory(dir, false);
      const path = prefix + leaf.name,
        absolute = join(dir, leaf.name);
      if (leaf.isDirectory()) {
        visit(absolute, path + "/");
        if (path !== "files" && readdirSync(absolute).length === 0) rmdirSync(absolute);
      } else if (!expected.has(path)) unlinkSync(absolute);
      else if (!leaf.isFile() || stat(absolute)?.nlink !== 1) throw new Error("Unsafe workspace file");
    }
  }
  directory(root, false);
  const handbook = join(root, "HANDBOOK.md");
  if (!expected.has("HANDBOOK.md") && stat(handbook)) unlinkSync(handbook);
  const deployDoc = join(root, "DEPLOY.md");
  if (!expected.has("DEPLOY.md") && stat(deployDoc)) unlinkSync(deployDoc);
  visit(join(root, "files"), "files/");
}
function httpUrl(o: SyncOptions, path: string) {
  const origin = new URL(o.serverUrl);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  const url = new URL(`/api/bridge/projects/${encodeURIComponent(o.projectId)}/workspace/file`, origin);
  url.searchParams.set("path", path);
  url.searchParams.set("run_id", o.runId);
  return url;
}
function headers(o: SyncOptions) {
  return { Authorization: `Bearer ${o.token}`, "X-Relaydesk-Run-Id": o.runId };
}
function fields(o: SyncOptions, path: string) {
  return { project_id: o.projectId, run_id: o.runId, path };
}
async function pull(o: SyncOptions, root: string, path: string, hash: string, size?: number) {
  const target = checkedPath(root, path, true);
  const tmp = join(dirname(target), `.relaydesk-${randomUUID()}.tmp`);
  const fd = openSync(tmp, fs.O_EXCL | fs.O_CREAT | fs.O_WRONLY | fs.O_NOFOLLOW, 0o600);
  let renamed = false,
    bytes = 0;
  const digest = createHash("sha256");
  const write = (data: Uint8Array) => {
    if ((bytes += data.byteLength) > (size ?? RPC_LIMIT)) throw new Error("Workspace download exceeds declared size");
    digest.update(data);
    for (let i = 0; i < data.length;) i += writeSync(fd, data, i, data.length - i);
  };
  try {
    if ((size ?? 0) <= RPC_LIMIT) {
      const reply = await o.rpc("workspace.fetch", fields(o, path), o.signal);
      if (typeof reply.data !== "string" || reply.data.length > 4 * Math.ceil(RPC_LIMIT / 3))
        throw new Error("Invalid workspace.fetch result");
      const raw = Buffer.from(reply.data, "base64");
      if (raw.toString("base64") !== reply.data) throw new Error("Invalid workspace base64");
      write(raw);
    } else {
      const response = await fetch(httpUrl(o, path), {
        headers: headers(o),
        redirect: "error",
        signal: AbortSignal.any([o.signal, AbortSignal.timeout(60_000)]),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Workspace download failed (${response.status})`);
      }
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          write(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
    }
    o.signal.throwIfAborted();
    if ((size !== undefined && bytes !== size) || digest.digest("hex") !== hash)
      throw new Error("Workspace checksum or size mismatch");
    checkedPath(root, path, false);
    const tempStat = stat(tmp),
      opened = fstatSync(fd);
    if (!tempStat?.isFile() || opened.nlink !== 1 || tempStat.ino !== opened.ino || tempStat.dev !== opened.dev)
      throw new Error("Temporary workspace file changed");
    renameSync(tmp, target);
    renamed = true;
    o.onFileSynced?.();
  } finally {
    closeSync(fd);
    if (!renamed && realpathSync(dirname(target)) === dirname(target) && stat(tmp)) unlinkSync(tmp);
  }
}

export async function syncSpace(o: SyncOptions, manifest: SpaceManifest) {
  o.signal.throwIfAborted();
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length > 500)
    throw new Error("Invalid workspace manifest");
  const root = projectDir(o);
  const baseline = new Map<string, string>();
  const skipped: string[] = [];
  const entries: { path: string; hash: string; size?: number }[] = [];
  const handbookHash = manifest.handbook_sha256 ?? manifest.handbook?.sha256;
  if (
    manifest.handbook &&
    (!Number.isSafeInteger(manifest.handbook.size) || manifest.handbook.size < 0 || manifest.handbook.size > 64 * 1024)
  )
    throw new Error("Invalid handbook size");
  if (handbookHash) entries.push({ path: "HANDBOOK.md", hash: handbookHash, size: manifest.handbook?.size });
  const deployDocHash = manifest.deploy_doc_sha256 ?? manifest.deploy_doc?.sha256;
  if (
    manifest.deploy_doc &&
    (!Number.isSafeInteger(manifest.deploy_doc.size) || manifest.deploy_doc.size < 0 || manifest.deploy_doc.size > 64 * 1024)
  )
    throw new Error("Invalid deploy doc size");
  if (deployDocHash) entries.push({ path: "DEPLOY.md", hash: deployDocHash, size: manifest.deploy_doc?.size });
  let total = 0;
  for (const file of manifest.files) {
    if (!file || !safeFile(file.path) || !Number.isSafeInteger(file.size) || file.size < 0)
      throw new Error("Unsafe or invalid workspace manifest entry");
    if (file.size > FILE_LIMIT) {
      skipped.push(file.path);
      continue;
    }
    if ((total += file.size) > TOTAL_LIMIT) throw new Error("Workspace exceeds size limit");
    entries.push({ path: `files/${file.path}`, hash: file.sha256, size: file.size });
  }
  for (const entry of entries) {
    if (typeof entry.hash !== "string" || !HASH.test(entry.hash) || baseline.has(entry.path))
      throw new Error("Invalid workspace digest or duplicate path");
    baseline.set(entry.path, entry.hash);
  }
  prune(root, baseline);
  for (const { path, hash, size } of entries) {
    o.signal.throwIfAborted();
    checkedPath(root, path, true);
    const local = readChecked(root, path);
    if (!local || (size !== undefined && local.length !== size) || sha(local) !== hash)
      await pull(o, root, path, hash, size);
  }
  const handbook = baseline.has("HANDBOOK.md")
    ? readChecked(root, "HANDBOOK.md")?.toString("utf8").slice(0, 12000)
    : "";
  return { root, baseline, handbook, skipped };
}
// syncSpace already verified these hashes against the local bytes; do not re-read the mirror.
export function snapshotShadowFiles(mirror: Awaited<ReturnType<typeof syncSpace>>): Map<string, string> {
  return new Map([...mirror.baseline].filter(([path]) => isRootDoc(path) || path.startsWith("files/")));
}
export async function pushChangedShadowFiles(o: SyncOptions, mirror: Awaited<ReturnType<typeof syncSpace>>, before: Map<string, string>, secrets: string[]) {
  let count = 0,
    total = 0;
  for (const path of scan(mirror.root)) {
    o.signal.throwIfAborted();
    const doc = isRootDoc(path);
    const data = readChecked(mirror.root, path);
    if (!data) continue;
    if ((total += data.length) > TOTAL_LIMIT) throw new Error("Workspace exceeds size limit");
    const hash = sha(data);
    if (before.get(path) === hash || (path.startsWith("files/") && mirror.skipped.includes(path.slice(6)))) continue;
    if (doc && data.length > DOC_LIMIT) throw new Error(`${path} exceeds 64 KiB limit`);
    if (secrets.some((s) => s && (path.includes(s) || data.includes(Buffer.from(s)))))
      throw new Error("Workspace change contains a protected credential");
    if (data.length <= RPC_LIMIT) {
      await o.rpc("workspace.push", { ...fields(o, path), sha256: hash, data: data.toString("base64") }, o.signal);
    } else {
      const response = await fetch(httpUrl(o, path), {
        method: "PUT",
        headers: { ...headers(o), "Content-Type": "application/octet-stream" },
        body: new Uint8Array(data),
        redirect: "error",
        signal: AbortSignal.any([o.signal, AbortSignal.timeout(60_000)]),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Workspace upload failed (${response.status})`);
    }
    count++;
    o.onFileSynced?.();
  }
  return count;
}
