import { randomBytes } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { ApiError } from "./errors.ts";
import {
  getEffectiveR2Config,
  isR2ConfigComplete,
  resolveR2Endpoint,
  validateR2AccountId,
  validateR2Bucket,
  validateR2Endpoint,
  validateR2PublicUrl,
  type StoredR2Config,
} from "./r2-config.ts";
import type { R2TestResult, UploadedAttachment } from "../app/lib/types.ts";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: GIF87a or GIF89a
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return "image/gif";
  }
  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function parseDataUrlImage(dataUrl: string): { buffer: Buffer; mime: string } {
  const trimmed = dataUrl.trim();
  const match = trimmed.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new ApiError(400, "仅支持 PNG / JPEG / WebP / GIF 格式的图片");
  }
  const base64 = match[2].replace(/\s+/g, "");
  if (base64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 16) {
    throw new ApiError(413, "图片体积不能超过 5 MB");
  }
  const buffer = Buffer.from(base64, "base64");
  return validateImageBuffer(buffer, match[1].toLowerCase());
}

export function validateImageBuffer(
  buffer: Buffer,
  declaredMime?: string,
): { buffer: Buffer; mime: string } {
  if (!buffer || buffer.length === 0) {
    throw new ApiError(400, "上传图片内容为空");
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, "图片体积不能超过 5 MB");
  }
  const detected = detectImageMime(buffer);
  if (!detected) {
    throw new ApiError(400, "无法识别的图片格式，请上传 PNG、JPEG、WebP 或 GIF 图片");
  }
  if (declaredMime) {
    const clean = declaredMime.split(";")[0].trim().toLowerCase();
    const normalizedDeclared = clean === "image/jpg" ? "image/jpeg" : clean;
    if (normalizedDeclared && !ALLOWED_IMAGE_TYPES[normalizedDeclared]) {
      throw new ApiError(400, "仅支持 PNG、JPEG、WebP 或 GIF 图片");
    }
  }
  return { buffer, mime: detected };
}

function createR2Client(config: Pick<StoredR2Config, "access_key_id" | "secret_access_key">) {
  return new AwsClient({
    accessKeyId: config.access_key_id,
    secretAccessKey: config.secret_access_key,
    service: "s3",
    region: "auto",
  });
}

function buildObjectUrl(
  config: Pick<StoredR2Config, "account_id" | "bucket" | "endpoint">,
  key: string,
): string {
  const endpoint = resolveR2Endpoint(config);
  const encodedKey = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${endpoint}/${encodeURIComponent(config.bucket)}/${encodedKey}`;
}

function dateStamp(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export async function uploadProjectImage(
  dbPath: string,
  projectId: string,
  buffer: Buffer,
  declaredMime?: string,
): Promise<UploadedAttachment> {
  const config = getEffectiveR2Config(dbPath);
  if (!isR2ConfigComplete(config)) {
    throw new ApiError(503, "当前站点尚未配置 R2 图床存储，请联系管理员在设置页配置");
  }
  const validated = validateImageBuffer(buffer, declaredMime);
  const ext = ALLOWED_IMAGE_TYPES[validated.mime] ?? "png";
  const safeProject = projectId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "project";
  const key = `uploads/${safeProject}/${dateStamp()}/${randomBytes(12).toString("hex")}.${ext}`;

  const client = createR2Client(config);
  const targetUrl = buildObjectUrl(config, key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await client.fetch(targetUrl, {
      method: "PUT",
      headers: {
        "Content-Type": validated.mime,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Disposition": "inline",
      },
      body: new Uint8Array(validated.buffer),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new ApiError(
        502,
        `R2 上传失败（HTTP ${response.status}${detail ? `: ${detail}` : ""}）`,
      );
    }
    return {
      url: `${config.public_url.replace(/\/+$/, "")}/${key}`,
      key,
      content_type: validated.mime,
      size: validated.buffer.length,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiError(504, "R2 上传超时，请稍后重试");
    }
    throw new ApiError(502, "无法连接到 R2 存储服务，请检查配置与网络");
  } finally {
    clearTimeout(timer);
  }
}

export async function testR2Connection(
  dbPath: string,
  override?: Partial<StoredR2Config>,
): Promise<R2TestResult> {
  const effective = getEffectiveR2Config(dbPath);
  const accountId = override?.account_id?.trim() || effective.account_id;
  const endpoint = override?.endpoint !== undefined
    ? validateR2Endpoint(override.endpoint)
    : effective.endpoint;
  if (!endpoint) {
    validateR2AccountId(accountId);
  }
  const bucket = validateR2Bucket(override?.bucket?.trim() || effective.bucket);
  const publicUrl = validateR2PublicUrl(override?.public_url?.trim() || effective.public_url);
  const accessKeyId = override?.access_key_id?.trim() || effective.access_key_id;
  const secretAccessKey = override?.secret_access_key?.trim() || effective.secret_access_key;

  if (!accessKeyId || !secretAccessKey) {
    throw new ApiError(400, "请填写 R2 Access Key ID 和 Secret Access Key");
  }

  const config: StoredR2Config = {
    account_id: accountId,
    bucket,
    access_key_id: accessKeyId,
    secret_access_key: secretAccessKey,
    public_url: publicUrl,
    endpoint,
  };

  const client = createR2Client(config);
  const probeKey = `_relaydesk-probe/${randomBytes(8).toString("hex")}.txt`;
  const targetUrl = buildObjectUrl(config, probeKey);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const putRes = await client.fetch(targetUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "relaydesk-r2-ok",
      signal: controller.signal,
    });
    if (!putRes.ok) {
      const detail = (await putRes.text().catch(() => "")).slice(0, 180);
      throw new ApiError(
        502,
        `R2 写入测试失败（HTTP ${putRes.status}${detail ? `: ${detail}` : ""}）`,
      );
    }
    // Best-effort cleanup
    await client.fetch(targetUrl, { method: "DELETE", signal: controller.signal }).catch(() => {});
    return {
      ok: true,
      latency_ms: Date.now() - started,
      bucket,
      public_url: publicUrl,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiError(502, "R2 连接测试超时（15 秒）");
    }
    throw new ApiError(502, "无法连接到 R2，请检查 Account ID / Endpoint 与密钥权限");
  } finally {
    clearTimeout(timer);
  }
}
