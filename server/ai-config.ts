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
import { isIP } from "node:net";
import { ApiError } from "./errors.ts";
import type { AiConfigStatus } from "../app/lib/types.ts";

export interface StoredAiConfig {
  base_url: string;
  model: string;
  api_key: string;
  intake_enabled: boolean;
}

export interface EffectiveAiConfig extends StoredAiConfig {
  source: "workspace" | "env" | "none";
}

export function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "::1" || lower === "[::1]") return true;
  const bare = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  const ipVersion = isIP(bare);
  if (ipVersion === 4) {
    return bare.startsWith("127.");
  }
  if (ipVersion === 6) {
    return bare === "::1" || bare === "0:0:0:0:0:0:0:1" || bare.startsWith("::ffff:127.");
  }
  return false;
}

export function validateAiBaseUrl(raw: string): string {
  const cleaned = raw.trim().replace(/\/+$/, "");
  if (!cleaned) {
    throw new ApiError(400, "请输入有效的 API Base URL");
  }
  if (cleaned.length > 512) {
    throw new ApiError(400, "API Base URL 过长");
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new ApiError(400, "API Base URL 格式不正确，例如 https://api.openai.com/v1");
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
      "远程模型服务必须使用 HTTPS，仅本机回环地址支持 HTTP（不能包含查询参数或凭据）",
    );
  }
  return cleaned;
}

export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function aiConfigPath(dbPath: string): string {
  return join(dirname(dbPath), ".ai-config.json");
}

export function readStoredAiConfig(dbPath: string): StoredAiConfig | null {
  if (dbPath === ":memory:") return null;
  const path = aiConfigPath(dbPath);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredAiConfig>;
    if (typeof raw !== "object" || raw === null) return null;
    return {
      base_url: typeof raw.base_url === "string" ? raw.base_url.trim().replace(/\/+$/, "") : "",
      model: typeof raw.model === "string" ? raw.model.trim() : "",
      api_key: typeof raw.api_key === "string" ? raw.api_key.trim() : "",
      intake_enabled: Boolean(raw.intake_enabled),
    };
  } catch {
    return null;
  }
}

export function saveStoredAiConfig(dbPath: string, config: StoredAiConfig): void {
  if (dbPath === ":memory:") {
    throw new ApiError(500, "In-memory database does not support persistent AI config");
  }
  const path = aiConfigPath(dbPath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.ai-config.${randomBytes(8).toString("hex")}.tmp`);
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

export function deleteStoredAiConfig(dbPath: string): void {
  if (dbPath === ":memory:") return;
  const path = aiConfigPath(dbPath);
  try {
    unlinkSync(path);
  } catch {
    // ignore if missing
  }
}

export function getEffectiveAiConfig(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveAiConfig {
  const stored = readStoredAiConfig(dbPath);
  if (stored && stored.base_url && stored.model) {
    return { ...stored, source: "workspace" };
  }
  const envBase = (env.RELAYDESK_AI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const envModel = (env.RELAYDESK_AI_MODEL ?? "").trim();
  const envKey = (env.RELAYDESK_AI_KEY ?? "").trim();
  const envIntake = env.RELAYDESK_AI_INTAKE === "1";
  if (envBase && envModel) {
    return {
      base_url: envBase,
      model: envModel,
      api_key: envKey,
      intake_enabled: envIntake,
      source: "env",
    };
  }
  return {
    base_url: stored?.base_url ?? "",
    model: stored?.model ?? "",
    api_key: stored?.api_key ?? "",
    intake_enabled: stored?.intake_enabled ?? false,
    source: "none",
  };
}

export function toAiConfigStatus(config: EffectiveAiConfig): AiConfigStatus {
  const configured = Boolean(config.base_url && config.model);
  return {
    configured,
    source: configured ? config.source : "none",
    base_url: config.base_url,
    model: config.model,
    has_api_key: Boolean(config.api_key),
    api_key_preview: maskApiKey(config.api_key),
    intake_enabled: config.intake_enabled,
  };
}
