import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { validCatalogId } from "../app/lib/model-catalog.ts";
import type { ChatReasoningEffort, ModelCatalogItem } from "../app/lib/types.ts";
import { ApiError } from "./errors.ts";

type Runtime = "codex" | "claude";
interface ProjectCliSettings {
  project_id: string;
  runtime: Runtime;
  endpoint: string;
  model: string;
  models: ModelCatalogItem[];
  default_effort: ChatReasoningEffort;
  api_key: string;
  github_token: string;
  public_ai_enabled: boolean;
}

const maxSettingsBytes = 64 * 1024;
const editable = new Set(["runtime", "endpoint", "model", "models", "default_effort", "api_key", "github_token", "public_ai_enabled"]);
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const invalidFile = () => new ApiError(500, "项目 CLI 配置不可读或无效");
const invalidEndpoint = () => new ApiError(400, "请提供该运行时的公网 HTTPS API 基础地址");
export const validSecret = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && !/[^!-~]/.test(value);

function defaults(id: string): ProjectCliSettings {
  return { project_id: id, runtime: "codex", endpoint: "", model: "", models: [], default_effort: "default", api_key: "", github_token: "", public_ai_enabled: false };
}

export function baseUrl(value: unknown, runtime: Runtime): string {
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

const effortLevel = z.enum(["off", "low", "medium", "high", "max"]);
const reasoningEffort = z.union([z.literal("default"), effortLevel]);
const displayText = (limit: number) => z.string().max(limit).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u);
const tokenLimit = z.number().int().positive().max(10_000_000).optional();
const catalogItem = z.strictObject({
  id: z.string().refine(validCatalogId), runtime: z.enum(["codex", "claude"]),
  label: displayText(120).optional(), provider: displayText(60).optional(), context_window: tokenLimit, max_output_tokens: tokenLimit,
  supports_fast: z.boolean().optional(), supports_effort: z.boolean().optional(), is_default: z.boolean().optional(),
  effort_levels: z.array(effortLevel).transform(levels => [...new Set(levels)]).optional(), default_effort: effortLevel.optional(),
  tags: z.array(z.string()).max(8).optional(), source: z.enum(["cloud_config", "detected", "bridge_config", "cli_config"]).optional(),
});
const catalog = z.array(catalogItem).max(50);

export function containsCredential(field: string, secrets: string[]) {
  return secrets.some(secret => secret.length > 0 && field.includes(secret));
}

function protectPublicFields(endpoint: string, model: string, models: ModelCatalogItem[], secrets: string[]) {
  // Compare individual strings as well: JSON escaping must not disguise an embedded credential.
  const fields = [endpoint, model];
  if (models.length) fields.push(JSON.stringify(models));
  for (const item of models) {
    for (const value of Object.values(item)) {
      if (typeof value === "string") fields.push(value);
      else if (Array.isArray(value)) fields.push(...value);
    }
  }
  if (fields.some(field => containsCredential(field, secrets))) throw new ApiError(400, "请勿在端点或模型配置中包含凭据");
}

function validated(value: Record<string, unknown>, id: string, previousSecrets: string[] = []): ProjectCliSettings {
  const { runtime, model, api_key, github_token, public_ai_enabled } = value;
  if (runtime !== "codex" && runtime !== "claude") throw new ApiError(400, "CLI 运行时无效");
  if (model !== "" && !validCatalogId(model)) throw new ApiError(400, "CLI 模型 ID 无效");
  if (!validSecret(api_key) || !validSecret(github_token)) throw new ApiError(400, "API 密钥或 GitHub 令牌无效");
  if (typeof public_ai_enabled !== "boolean") throw new ApiError(400, "公开 AI 设置必须为布尔值");
  const parsed = catalog.safeParse(value.models);
  if (!parsed.success) throw new ApiError(400, "模型列表无效，最多支持 50 个模型");
  const models = parsed.data.map(item => ({ ...item, source: "cloud_config" as const }));
  if (new Set(models.map(m => `${m.runtime}:${m.id}`)).size !== models.length) throw new ApiError(400, "同一运行时的模型 ID 不得重复");
  const effort = reasoningEffort.safeParse(value.default_effort);
  if (!effort.success) throw new ApiError(400, "默认思考强度无效");
  const endpoint = baseUrl(value.endpoint, runtime);
  protectPublicFields(endpoint, model, models, [api_key, github_token, ...previousSecrets]);
  return { project_id: id, runtime, endpoint, model, models, default_effort: effort.data, api_key, github_token, public_ai_enabled };
}

// Mount only this project's directory into its trusted supervisor, read-only. Directory
// mounts allow atomic replacements to propagate when credentials rotate.
function settingsPath(dbPath: string, id: string, create: boolean) {
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new ApiError(400, "项目 ID 无效");
  if (dbPath === ":memory:") {
    if (create) throw new ApiError(409, "项目 CLI 配置需要持久化数据目录");
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
    return validated({ models: [], default_effort: "default", ...value }, id);
  } catch { throw invalidFile(); } finally { closeSync(fd); }
}

/** The operator route authenticates the caller. Credentials are write-only here. */
export function projectCliConfiguration(dbPath: string, id: string, patch?: Record<string, unknown>) {
  let settings = readProjectCliSettings(dbPath, id);
  if (patch !== undefined) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !editable.has(key))) {
      throw new ApiError(400, "请提供有效的项目 CLI 配置");
    }
    const next = validated({ ...settings, ...patch }, id, [settings.api_key, settings.github_token]);
    if (settings.api_key && (next.runtime !== settings.runtime || next.endpoint !== settings.endpoint) && !Object.hasOwn(patch, "api_key")) {
      throw new ApiError(400, "更换运行时或端点时，请重新输入或清除 API 密钥");
    }
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > maxSettingsBytes) throw new ApiError(400, "项目 CLI 配置超过 64 KiB");
    const path = settingsPath(dbPath, id, true)!;
    const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, serialized, { flag: "wx", mode: 0o600 });
      renameSync(tmp, path);
    } catch { throw new ApiError(500, "无法保存项目 CLI 配置"); } finally {
      try { unlinkSync(tmp); } catch (error) { if (!isMissing(error)) throw new ApiError(500, "无法清理项目 CLI 临时配置"); }
    }
    settings = next;
  }
  const { runtime, endpoint, model, models, default_effort, public_ai_enabled, api_key, github_token } = settings;
  return { runtime, endpoint, model, models, default_effort, configured: Boolean(api_key), github_configured: Boolean(github_token), public_ai_enabled };
}
