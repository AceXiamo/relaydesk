import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { ApiError } from "./errors.ts";

type Runtime = "codex" | "claude";
interface ProjectCliSettings {
  project_id: string;
  runtime: Runtime;
  endpoint: string;
  model: string;
  api_key: string;
  github_token: string;
  public_ai_enabled: boolean;
}

const maxSettingsBytes = 16 * 1024;
const editable = new Set(["runtime", "endpoint", "model", "api_key", "github_token", "public_ai_enabled"]);
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const invalidFile = () => new ApiError(500, "Project CLI settings are unreadable or invalid");
const invalidEndpoint = () => new ApiError(400, "Provide a public HTTPS API base URL for this runtime");
const validSecret = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && !/[^!-~]/.test(value);

function defaults(id: string): ProjectCliSettings {
  return { project_id: id, runtime: "codex", endpoint: "", model: "", api_key: "", github_token: "", public_ai_enabled: false };
}

function baseUrl(value: unknown, runtime: Runtime): string {
  if (value === "") return "";
  if (typeof value !== "string" || value.length > 2048 || !/^https:\/\/[^/]/i.test(value) || /[\s\\?#%@]/u.test(value)) throw invalidEndpoint();
  let url: URL;
  try { url = new URL(value); } catch { throw invalidEndpoint(); }
  const host = url.hostname.replace(/\.$/, "");
  const labels = host.split(".");
  // Validate the canonical hostname, including WHATWG's normalization of numeric hosts.
  // The HTTP adapter must also enforce public DNS results at connection time and on redirects.
  if (isIP(host) || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /(?:^|\.)(?:localhost|localdomain|local|internal|intranet|private|lan|corp|home|arpa|onion)$/.test(host) ||
      labels.includes("metadata")) throw invalidEndpoint();
  const path = url.pathname.replace(/\/+$/, "");
  if (!/^(?:\/[\w.~-]+)*$/.test(path) || /\/(?:responses|messages|chat|completions|models|embeddings|files|batches|images|audio|moderations|assistants|threads|uploads)(?:\/|$)/i.test(path) ||
      (runtime === "claude" && /\/v1$/i.test(path))) throw invalidEndpoint();
  url.hostname = host;
  return url.origin + path;
}

function protectPublicFields(endpoint: string, model: string, secrets: string[]) {
  if (secrets.some(secret => secret && (endpoint.includes(secret) || model.includes(secret)))) {
    throw new ApiError(400, "Keep credentials out of the endpoint and model");
  }
}

function validated(value: Record<string, unknown>, id: string): ProjectCliSettings {
  const { runtime, model, api_key, github_token, public_ai_enabled } = value;
  if (runtime !== "codex" && runtime !== "claude") throw new ApiError(400, "Invalid CLI runtime");
  if (typeof model !== "string" || model.length > 160 || model.startsWith("-") || /[^!-~]/.test(model)) throw new ApiError(400, "Invalid CLI model");
  if (!validSecret(api_key) || !validSecret(github_token)) throw new ApiError(400, "Invalid API key or GitHub token");
  if (typeof public_ai_enabled !== "boolean") throw new ApiError(400, "Public AI setting must be a boolean");
  const endpoint = baseUrl(value.endpoint, runtime);
  protectPublicFields(endpoint, model, [api_key, github_token]);
  return { project_id: id, runtime, endpoint, model, api_key, github_token, public_ai_enabled };
}

// Mount only this project's directory into its trusted supervisor, read-only. Directory
// mounts allow atomic replacements to propagate when credentials rotate.
function settingsPath(dbPath: string, id: string, create: boolean) {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new ApiError(400, "Invalid project ID");
  if (dbPath === ":memory:") {
    if (create) throw new ApiError(409, "Project CLI settings require a persistent data directory");
    return null;
  }
  const root = join(dirname(resolve(dbPath)), "cli-runners");
  const project = join(root, id);
  for (const dir of [root, project]) {
    if (create) {
      try { mkdirSync(dir, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw invalidFile(); }
    }
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw invalidFile();
    } catch (error) { if (!create && isMissing(error)) return null; throw invalidFile(); }
  }
  return join(project, "settings.json");
}

/** Trusted server-side consumers only. The result contains both raw credentials. */
export function readProjectCliSettings(dbPath: string, id: string): ProjectCliSettings {
  const path = settingsPath(dbPath, id, false);
  if (!path) return defaults(id);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isMissing(error)) return defaults(id); throw invalidFile(); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > maxSettingsBytes) throw invalidFile();
    const value = JSON.parse(readFileSync(fd, "utf8"));
    if (value?.project_id !== id || Object.keys(value).some(key => key !== "project_id" && !editable.has(key))) throw invalidFile();
    return validated(value, id);
  } catch { throw invalidFile(); } finally { closeSync(fd); }
}

/** The operator route authenticates the caller. Credentials are write-only here. */
export function projectCliConfiguration(dbPath: string, id: string, patch?: Record<string, unknown>) {
  let settings = readProjectCliSettings(dbPath, id);
  if (patch !== undefined) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !editable.has(key))) {
      throw new ApiError(400, "Provide valid project CLI settings");
    }
    const next = validated({ ...settings, ...patch }, id);
    protectPublicFields(next.endpoint, next.model, [settings.api_key, settings.github_token]);
    if (settings.api_key && (next.runtime !== settings.runtime || next.endpoint !== settings.endpoint) && !Object.hasOwn(patch, "api_key")) {
      throw new ApiError(400, "Re-enter the API key or clear it when changing runtime or endpoint");
    }
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > maxSettingsBytes) throw new ApiError(400, "Project CLI settings exceed the size limit");
    const path = settingsPath(dbPath, id, true)!;
    const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, serialized, { flag: "wx", mode: 0o600 });
      renameSync(tmp, path);
    } finally {
      try { unlinkSync(tmp); } catch (error) { if (!isMissing(error)) throw error; }
    }
    settings = next;
  }
  const { runtime, endpoint, model, public_ai_enabled, api_key, github_token } = settings;
  return { runtime, endpoint, model, configured: Boolean(api_key), github_configured: Boolean(github_token), public_ai_enabled };
}
