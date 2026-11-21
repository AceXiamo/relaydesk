import { lookup } from "node:dns";
import type { IncomingMessage } from "node:http";
import { get } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { builtinModels, validCatalogId } from "../app/lib/model-catalog.ts";
import type { ModelCatalogItem } from "../app/lib/types.ts";
import { ApiError } from "./errors.ts";
import { baseUrl, containsCredential, readProjectCliSettings, validSecret } from "./project-cli-config.ts";

const official = { codex: "https://api.openai.com/v1", claude: "https://api.anthropic.com" };
const discoveryFields = new Set(["endpoint", "runtime", "api_key"]);
const maxResponseBytes = 1024 * 1024;
const nonPublic = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublic.addSubnet(address, prefix, "ipv4");
// Azure's virtual platform address is only reachable from inside its network.
nonPublic.addAddress("168.63.129.16", "ipv4");
// Only global unicast IPv6; exclude protocol assignments, documentation and transition networks.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  nonPublic.addSubnet(address, prefix, "ipv6");
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  // Validate every answer and pass the checked addresses straight to the socket. A second
  // resolution (or a shared socket from a different agent) could invalidate the check.
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error || !addresses.length || !addresses.every(({ address, family }) => {
      if (isIP(address) !== family) return false;
      return family === 4 ? !nonPublic.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !nonPublic.check(address, "ipv6");
    })) return callback(new Error("模型端点必须解析为公网地址"), "", 0);
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

async function loadModels(url: string, headers: Record<string, string>): Promise<unknown[]> {
  const signal = AbortSignal.timeout(12_000);
  // Native HTTPS never follows a redirect, including same-host redirects to a different path.
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      get(url, { headers, agent: false, lookup: publicLookup, signal }, resolve).on("error", reject);
    });
    try {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) throw new Error();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > maxResponseBytes) throw new Error();
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(payload?.data)) throw new Error();
      return payload.data;
    } finally { response.destroy(); }
  } catch {
    if (signal.aborted) throw new ApiError(504, "模型发现请求超时");
    throw new ApiError(502, "无法获取模型列表，请检查公网端点、API 密钥和响应格式");
  }
}

export async function discoverProjectCliModels(dbPath: string, projectId: string, body: Record<string, unknown>): Promise<ModelCatalogItem[]> {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !discoveryFields.has(key))) {
    throw new ApiError(400, "模型发现参数无效");
  }
  const saved = readProjectCliSettings(dbPath, projectId);
  const runtime = Object.hasOwn(body, "runtime") ? body.runtime : saved.runtime;
  if (runtime !== "codex" && runtime !== "claude") throw new ApiError(400, "CLI 运行时无效");
  const configuredEndpoint = runtime === saved.runtime ? saved.endpoint : "";
  const endpoint = baseUrl(Object.hasOwn(body, "endpoint") ? body.endpoint : configuredEndpoint, runtime) || official[runtime];
  const supplied = Object.hasOwn(body, "api_key") ? body.api_key : "";
  if (!validSecret(supplied)) throw new ApiError(400, "API 密钥无效");
  const sameTarget = runtime === saved.runtime && endpoint === (saved.endpoint || official[saved.runtime]);
  const key = Object.hasOwn(body, "api_key") ? supplied : (sameTarget ? saved.api_key : "");
  if (!key) throw new ApiError(400, "请为当前运行时和端点输入 API 密钥");
  const secrets = [key, saved.api_key, saved.github_token];
  if (containsCredential(endpoint, secrets)) throw new ApiError(400, "请勿在端点中包含凭据");
  const headers: Record<string, string> = runtime === "codex" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key, "anthropic-version": "2023-06-01" };
  const rows = await loadModels(endpoint + (runtime === "codex" ? "/models" : "/v1/models"), headers);
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || !("id" in row) || !validCatalogId(row.id) || containsCredential(row.id, secrets)) continue;
    ids.add(row.id);
  }
  // Never forward arbitrary upstream metadata (including error text, URLs, tokens, or headers).
  return [...ids].sort().slice(0, 80).map(id => ({ ...builtinModels.find(model => model.id === id && model.runtime === runtime), id, runtime, source: "detected" }));
}
