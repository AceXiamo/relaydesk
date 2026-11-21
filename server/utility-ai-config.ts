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
import { ApiError } from "./errors.ts";
import { isLoopbackHost } from "./loopback.ts";
import { maskSecret } from "./r2-config.ts";
import type { UtilityAiConfigStatus, UtilityAiProvider } from "../app/lib/types.ts";

export interface StoredUtilityAiConfig {
  provider: UtilityAiProvider;
  endpoint: string;
  api_key: string;
  model: string;
}

export interface EffectiveUtilityAiConfig extends StoredUtilityAiConfig {
  source: "workspace" | "env" | "none";
}

export function validateUtilityAiProvider(raw: unknown): UtilityAiProvider {
  if (raw === "openai" || raw === "anthropic") return raw;
  throw new ApiError(400, "请选择有效的协议类型（OpenAI 兼容或 Anthropic）");
}

export function validateUtilityAiEndpoint(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") {
    throw new ApiError(400, "API Endpoint 格式不正确");
  }
  const cleaned = raw.trim().replace(/\/+$/, "");
  if (!cleaned) return "";
  if (cleaned.length > 512) {
    throw new ApiError(400, "API Endpoint 过长");
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new ApiError(400, "API Endpoint 格式不正确，请输入完整的 URL（例如 https://api.openai.com/v1）");
  }
  const local = isLoopbackHost(parsed.hostname);
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !(parsed.protocol === "https:" || (parsed.protocol === "http:" && local))
  ) {
    throw new ApiError(
      400,
      "API Endpoint 必须使用 HTTPS（仅本机回环地址允许 HTTP），且不能包含凭据或查询参数",
    );
  }
  return cleaned;
}

export function validateUtilityAiModel(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "请输入模型名称");
  }
  const cleaned = raw.trim();
  if (!cleaned || cleaned.length > 160 || cleaned.startsWith("-") || /[^!-~]/.test(cleaned)) {
    throw new ApiError(400, "请输入有效的模型名称（1-160 个可见 ASCII 字符）");
  }
  return cleaned;
}

export function validateUtilityAiKey(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") {
    throw new ApiError(400, "API Key 格式不正确");
  }
  const cleaned = raw.trim();
  if (cleaned.length > 4096 || /[^!-~]/.test(cleaned)) {
    throw new ApiError(400, "API Key 格式不正确或长度超出限制");
  }
  return cleaned;
}

export function utilityAiConfigPath(dbPath: string): string {
  return join(dirname(dbPath), ".utility-ai-config.json");
}

export function readStoredUtilityAiConfig(dbPath: string): StoredUtilityAiConfig | null {
  if (dbPath === ":memory:") return null;
  const path = utilityAiConfigPath(dbPath);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredUtilityAiConfig>;
    if (typeof raw !== "object" || raw === null) return null;
    const provider: UtilityAiProvider = raw.provider === "anthropic" ? "anthropic" : "openai";
    return {
      provider,
      endpoint: typeof raw.endpoint === "string" ? raw.endpoint.trim().replace(/\/+$/, "") : "",
      api_key: typeof raw.api_key === "string" ? raw.api_key.trim() : "",
      model: typeof raw.model === "string" ? raw.model.trim() : "",
    };
  } catch {
    return null;
  }
}

export function saveStoredUtilityAiConfig(dbPath: string, config: StoredUtilityAiConfig): void {
  if (dbPath === ":memory:") {
    throw new ApiError(409, "In-memory database does not support persistent utility AI config");
  }
  const path = utilityAiConfigPath(dbPath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.utility-ai-config.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2), {
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
}

export function deleteStoredUtilityAiConfig(dbPath: string): void {
  if (dbPath === ":memory:") return;
  const path = utilityAiConfigPath(dbPath);
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

export function isUtilityAiConfigComplete(
  cfg: Partial<StoredUtilityAiConfig> | null | undefined,
): boolean {
  if (!cfg) return false;
  return Boolean(cfg.api_key?.trim() && cfg.model?.trim());
}

export function getEffectiveUtilityAiConfig(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveUtilityAiConfig {
  const stored = readStoredUtilityAiConfig(dbPath);
  if (isUtilityAiConfigComplete(stored)) {
    return { ...stored!, source: "workspace" };
  }
  const rawProvider = (env.RELAYDESK_UTILITY_AI_PROVIDER ?? "").trim().toLowerCase();
  const envCfg: StoredUtilityAiConfig = {
    provider: rawProvider === "anthropic" ? "anthropic" : "openai",
    endpoint: (env.RELAYDESK_UTILITY_AI_ENDPOINT ?? "").trim().replace(/\/+$/, ""),
    api_key: (env.RELAYDESK_UTILITY_AI_API_KEY ?? "").trim(),
    model: (env.RELAYDESK_UTILITY_AI_MODEL ?? "").trim(),
  };
  if (isUtilityAiConfigComplete(envCfg)) {
    return { ...envCfg, source: "env" };
  }
  return {
    provider: stored?.provider ?? envCfg.provider,
    endpoint: stored?.endpoint ?? envCfg.endpoint,
    api_key: stored?.api_key ?? envCfg.api_key,
    model: stored?.model ?? envCfg.model,
    source: "none",
  };
}

export function toUtilityAiConfigStatus(config: EffectiveUtilityAiConfig): UtilityAiConfigStatus {
  const configured = isUtilityAiConfigComplete(config);
  return {
    configured,
    source: configured ? config.source : "none",
    provider: config.provider,
    endpoint: config.endpoint,
    model: config.model,
    has_api_key: Boolean(config.api_key),
    api_key_preview: maskSecret(config.api_key),
  };
}
