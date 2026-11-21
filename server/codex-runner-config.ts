import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ApiError } from "./errors.ts";

interface Credentials { project_id: string; api_key: string; github_token: string }
const empty = (id: string): Credentials => ({ project_id: id, api_key: "", github_token: "" });
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const invalidFile = () => new ApiError(500, "Codex credential file is not readable or is invalid");
const validSecret = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && /^[!-~]*$/.test(value);

// Mount only this project's directory into its trusted supervisor, read-only. Mounting a
// directory (not a single file) lets atomic renames propagate during credential rotation.
function credentialPath(dbPath: string, id: string, create: boolean) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new ApiError(400, "Invalid project ID");
  if (dbPath === ":memory:") {
    if (create) throw new ApiError(409, "Codex credentials require a persistent data directory");
    return null;
  }
  const root = join(dirname(resolve(dbPath)), "codex-runners");
  const project = join(root, id);
  for (const dir of [root, project]) {
    if (create) {
      try { mkdirSync(dir, { mode: 0o700 }); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    }
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (st.mode & 0o077)) throw invalidFile();
    } catch (err) { if (!create && isMissing(err)) return null; throw err; }
  }
  return join(project, "credentials.json");
}

function read(path: string | null, id: string): Credentials {
  if (!path) return empty(id);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (err) { if (isMissing(err)) return empty(id); throw invalidFile(); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) || st.size > 16384) throw invalidFile();
    const val = JSON.parse(readFileSync(fd, "utf8"));
    if (val?.project_id !== id || !validSecret(val.api_key) || !validSecret(val.github_token)) throw invalidFile();
    return val;
  } catch { throw invalidFile(); } finally { closeSync(fd); }
}

export function codexConfiguration(dbPath: string, id: string, patch?: Record<string, unknown>) {
  if (patch) {
    const keys = Object.keys(patch);
    if (!keys.length || keys.some(k => (k !== "api_key" && k !== "github_token") || !validSecret(patch[k]))) {
      throw new ApiError(400, "Provide a valid Codex API key or GitHub token");
    }
  }
  const path = credentialPath(dbPath, id, Boolean(patch));
  const value = read(path, id);
  if (patch && path) {
    if (typeof patch.api_key === "string") value.api_key = patch.api_key;
    if (typeof patch.github_token === "string") value.github_token = patch.github_token;
    // Empty strings explicitly revoke a credential. Never return either value, even masked.
    const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      renameSync(tmp, path);
    } finally {
      try { unlinkSync(tmp); } catch (err) { if (!isMissing(err)) throw err; }
    }
  }
  return { configured: Boolean(value.api_key), github_configured: Boolean(value.github_token) };
}
