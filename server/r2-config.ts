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
import type { R2ConfigStatus } from "../app/lib/types.ts";

export interface StoredR2Config {
  account_id: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  public_url: string;
  endpoint: string;
}

export interface EffectiveR2Config extends StoredR2Config {
  source: "workspace" | "env" | "none";
}

export function validateR2PublicUrl(raw: string): string {
  const cleaned = raw.trim().replace(/\/+$/, "");
  if (!cleaned) {
    throw new ApiError(400, "请输入 R2 公开访问域名（例如 https://assets.example.com）");
  }
  if (cleaned.length > 512) {
    throw new ApiError(400, "R2 公开访问域名过长");
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new ApiError(400, "R2 公开访问域名格式不正确");
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
    throw new ApiError(400, "R2 公开访问域名必须使用 HTTPS（不含查询参数或凭据）");
  }
  return cleaned;
}

export function validateR2Endpoint(raw: string): string {
  const cleaned = raw.trim().replace(/\/+$/, "");
  if (!cleaned) return "";
  if (cleaned.length > 512) {
    throw new ApiError(400, "S3 Endpoint 过长");
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new ApiError(400, "S3 Endpoint 格式不正确");
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
    throw new ApiError(400, "S3 Endpoint 必须使用 HTTPS（仅本机回环地址支持 HTTP）");
  }
  return cleaned;
}

export function validateR2Bucket(raw: string): string {
  const cleaned = raw.trim();
  if (!cleaned || cleaned.length > 63 || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(cleaned)) {
    throw new ApiError(400, "Bucket 名称仅支持小写字母、数字和短横线（3-63 字符）");
  }
  return cleaned;
}

export function validateR2AccountId(raw: string): string {
  const cleaned = raw.trim();
  if (!cleaned || cleaned.length > 128 || !/^[A-Za-z0-9_-]+$/.test(cleaned)) {
    throw new ApiError(400, "请输入有效的 Cloudflare Account ID");
  }
  return cleaned;
}

export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function r2ConfigPath(dbPath: string): string {
  return join(dirname(dbPath), ".r2-config.json");
}

export function readStoredR2Config(dbPath: string): StoredR2Config | null {
  if (dbPath === ":memory:") return null;
  const path = r2ConfigPath(dbPath);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredR2Config>;
    if (typeof raw !== "object" || raw === null) return null;
    return {
      account_id: typeof raw.account_id === "string" ? raw.account_id.trim() : "",
      bucket: typeof raw.bucket === "string" ? raw.bucket.trim() : "",
      access_key_id: typeof raw.access_key_id === "string" ? raw.access_key_id.trim() : "",
      secret_access_key:
        typeof raw.secret_access_key === "string" ? raw.secret_access_key.trim() : "",
      public_url:
        typeof raw.public_url === "string" ? raw.public_url.trim().replace(/\/+$/, "") : "",
      endpoint: typeof raw.endpoint === "string" ? raw.endpoint.trim().replace(/\/+$/, "") : "",
    };
  } catch {
    return null;
  }
}

export function saveStoredR2Config(dbPath: string, config: StoredR2Config): void {
  if (dbPath === ":memory:") {
    throw new ApiError(500, "In-memory database does not support persistent R2 config");
  }
  const path = r2ConfigPath(dbPath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.r2-config.${randomBytes(8).toString("hex")}.tmp`);
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

export function deleteStoredR2Config(dbPath: string): void {
  if (dbPath === ":memory:") return;
  const path = r2ConfigPath(dbPath);
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

export function isR2ConfigComplete(cfg: Partial<StoredR2Config> | null | undefined): boolean {
  if (!cfg) return false;
  return Boolean(
    (cfg.account_id || cfg.endpoint) &&
      cfg.bucket &&
      cfg.access_key_id &&
      cfg.secret_access_key &&
      cfg.public_url,
  );
}

export function getEffectiveR2Config(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveR2Config {
  const stored = readStoredR2Config(dbPath);
  if (isR2ConfigComplete(stored)) {
    return { ...stored!, source: "workspace" };
  }
  const envCfg: StoredR2Config = {
    account_id: (env.RELAYDESK_R2_ACCOUNT_ID ?? "").trim(),
    bucket: (env.RELAYDESK_R2_BUCKET ?? "").trim(),
    access_key_id: (env.RELAYDESK_R2_ACCESS_KEY_ID ?? "").trim(),
    secret_access_key: (env.RELAYDESK_R2_SECRET_ACCESS_KEY ?? "").trim(),
    public_url: (env.RELAYDESK_R2_PUBLIC_URL ?? "").trim().replace(/\/+$/, ""),
    endpoint: (env.RELAYDESK_R2_ENDPOINT ?? "").trim().replace(/\/+$/, ""),
  };
  if (isR2ConfigComplete(envCfg)) {
    return { ...envCfg, source: "env" };
  }
  return {
    account_id: stored?.account_id ?? envCfg.account_id,
    bucket: stored?.bucket ?? envCfg.bucket,
    access_key_id: stored?.access_key_id ?? envCfg.access_key_id,
    secret_access_key: stored?.secret_access_key ?? envCfg.secret_access_key,
    public_url: stored?.public_url ?? envCfg.public_url,
    endpoint: stored?.endpoint ?? envCfg.endpoint,
    source: "none",
  };
}

export function resolveR2Endpoint(config: Pick<StoredR2Config, "account_id" | "endpoint">): string {
  if (config.endpoint) return config.endpoint.replace(/\/+$/, "");
  return `https://${config.account_id}.r2.cloudflarestorage.com`;
}

export function toR2ConfigStatus(config: EffectiveR2Config): R2ConfigStatus {
  const configured = isR2ConfigComplete(config);
  return {
    configured,
    source: configured ? config.source : "none",
    account_id: config.account_id,
    bucket: config.bucket,
    public_url: config.public_url,
    endpoint: config.endpoint,
    has_credentials: Boolean(config.access_key_id && config.secret_access_key),
    access_key_preview: maskSecret(config.access_key_id),
  };
}
