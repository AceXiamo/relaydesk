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
import type {
  AiConfigStatus,
  AiNodeId,
  AiNodeRoute,
  AiProfileSummary,
  AiResolvedNodeSummary,
} from "../app/lib/types.ts";

export const AI_NODE_IDS: readonly AiNodeId[] = [
  "prescreen",
  "widget",
  "operator",
  "pr_audit",
] as const;

export const MAX_AI_PROFILES = 30;

export interface StoredAiProfile {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  created_at: string;
  updated_at: string;
}

export interface StoredAiConfigInput {
  version?: 2;
  base_url: string;
  model: string;
  api_key: string;
  intake_enabled: boolean;
  active_profile_id?: string;
  profiles?: StoredAiProfile[];
  node_routes?: Partial<Record<AiNodeId, Partial<AiNodeRoute>>>;
}

export interface StoredAiConfig {
  version: 2;
  base_url: string;
  model: string;
  api_key: string;
  intake_enabled: boolean;
  active_profile_id: string;
  profiles: StoredAiProfile[];
  node_routes: Record<AiNodeId, AiNodeRoute>;
}

export interface EffectiveAiConfig extends StoredAiConfig {
  source: "workspace" | "env" | "none";
}

export interface ResolvedAiNodeConfig {
  node: AiNodeId;
  configured: boolean;
  source: "workspace" | "env" | "none";
  profile_id: string;
  profile_name: string;
  base_url: string;
  model: string;
  api_key: string;
  intake_enabled: boolean;
  overrides_profile: boolean;
  overrides_model: boolean;
}

export function isAiNodeId(value: unknown): value is AiNodeId {
  return typeof value === "string" && (AI_NODE_IDS as readonly string[]).includes(value);
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

export function validateAiModelName(raw: string, allowEmpty = false): string {
  const cleaned = raw.trim();
  if (!cleaned) {
    if (allowEmpty) return "";
    throw new ApiError(400, "请输入模型名称（例如 gpt-5.4、deepseek-chat）");
  }
  if (cleaned.length > 160) {
    throw new ApiError(400, "模型名称过长（最多 160 字符）");
  }
  return cleaned;
}

export function inferAiProfileName(baseUrl: string, model: string): string {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "api.openai.com") return "OpenAI 官方";
    if (host === "api.deepseek.com") return "DeepSeek";
    if (host === "openrouter.ai") return "OpenRouter";
    if (isLoopbackHost(host)) return "本地模型";
    return host.replace(/^api\./, "").slice(0, 40) || model.slice(0, 40) || "默认模型";
  } catch {
    return model.slice(0, 40) || "默认模型";
  }
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

function emptyNodeRoutes(): Record<AiNodeId, AiNodeRoute> {
  return {
    prescreen: { profile_id: "", model: "" },
    widget: { profile_id: "", model: "" },
    operator: { profile_id: "", model: "" },
    pr_audit: { profile_id: "", model: "" },
  };
}

function normalizeStoredProfile(raw: unknown, fallbackNow: string): StoredAiProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const baseUrl =
    typeof obj.base_url === "string" ? obj.base_url.trim().replace(/\/+$/, "") : "";
  const model = typeof obj.model === "string" ? obj.model.trim().slice(0, 160) : "";
  if (!baseUrl || !model) return null;
  const apiKey = typeof obj.api_key === "string" ? obj.api_key.trim().slice(0, 512) : "";
  const id =
    typeof obj.id === "string" && obj.id.trim()
      ? obj.id.trim().slice(0, 64)
      : `prof_${randomBytes(6).toString("hex")}`;
  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim().slice(0, 60)
      : inferAiProfileName(baseUrl, model);
  const createdAt =
    typeof obj.created_at === "string" && obj.created_at ? obj.created_at : fallbackNow;
  const updatedAt =
    typeof obj.updated_at === "string" && obj.updated_at ? obj.updated_at : createdAt;
  return {
    id,
    name,
    base_url: baseUrl,
    model,
    api_key: apiKey,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function normalizeNodeRoutes(
  raw: unknown,
  validProfileIds: Set<string>,
): Record<AiNodeId, AiNodeRoute> {
  const routes = emptyNodeRoutes();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return routes;
  }
  const obj = raw as Record<string, unknown>;
  for (const nodeId of AI_NODE_IDS) {
    const entry = obj[nodeId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const rawProfileId = typeof rec.profile_id === "string" ? rec.profile_id.trim() : "";
    const profileId =
      rawProfileId && validProfileIds.has(rawProfileId) ? rawProfileId : "";
    const model = typeof rec.model === "string" ? rec.model.trim().slice(0, 160) : "";
    routes[nodeId] = { profile_id: profileId, model };
  }
  return routes;
}

function normalizeStoredAiConfig(input: Partial<StoredAiConfigInput>): StoredAiConfig {
  const now = new Date().toISOString();
  const seenIds = new Set<string>();
  const profiles: StoredAiProfile[] = [];

  if (Array.isArray(input.profiles)) {
    for (const item of input.profiles) {
      const normalized = normalizeStoredProfile(item, now);
      if (!normalized || seenIds.has(normalized.id)) continue;
      seenIds.add(normalized.id);
      profiles.push(normalized);
      if (profiles.length >= MAX_AI_PROFILES) break;
    }
  }

  const topBase =
    typeof input.base_url === "string" ? input.base_url.trim().replace(/\/+$/, "") : "";
  const topModel = typeof input.model === "string" ? input.model.trim().slice(0, 160) : "";
  const topKey = typeof input.api_key === "string" ? input.api_key.trim().slice(0, 512) : "";

  // Migrate legacy v1 single-profile configs automatically
  if (profiles.length === 0 && topBase && topModel) {
    profiles.push({
      id: "default",
      name: inferAiProfileName(topBase, topModel),
      base_url: topBase,
      model: topModel,
      api_key: topKey,
      created_at: now,
      updated_at: now,
    });
    seenIds.add("default");
  }

  const requestedActive =
    typeof input.active_profile_id === "string" ? input.active_profile_id.trim() : "";
  const activeProfile =
    profiles.find((p) => p.id === requestedActive) ?? profiles[0] ?? null;

  const validIds = new Set(profiles.map((p) => p.id));
  const nodeRoutes = normalizeNodeRoutes(input.node_routes, validIds);

  return {
    version: 2,
    base_url: activeProfile?.base_url ?? topBase,
    model: activeProfile?.model ?? topModel,
    api_key: activeProfile?.api_key ?? topKey,
    intake_enabled: Boolean(input.intake_enabled),
    active_profile_id: activeProfile?.id ?? "",
    profiles,
    node_routes: nodeRoutes,
  };
}

export function readStoredAiConfig(dbPath: string): StoredAiConfig | null {
  if (dbPath === ":memory:") return null;
  const path = aiConfigPath(dbPath);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredAiConfigInput>;
    if (typeof raw !== "object" || raw === null) return null;
    return normalizeStoredAiConfig(raw);
  } catch {
    return null;
  }
}

export function saveStoredAiConfig(dbPath: string, config: StoredAiConfigInput): StoredAiConfig {
  if (dbPath === ":memory:") {
    throw new ApiError(500, "In-memory database does not support persistent AI config");
  }
  const normalized = normalizeStoredAiConfig(config);
  const path = aiConfigPath(dbPath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.ai-config.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(normalized, null, 2), {
      mode: 0o600,
      encoding: "utf8",
    });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    return normalized;
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
  if (stored && stored.profiles.length > 0 && stored.base_url && stored.model) {
    return { ...stored, source: "workspace" };
  }

  const envBase = (env.RELAYDESK_AI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const envModel = (env.RELAYDESK_AI_MODEL ?? "").trim();
  const envKey = (env.RELAYDESK_AI_KEY ?? "").trim();
  const envIntake = env.RELAYDESK_AI_INTAKE === "1";
  if (envBase && envModel) {
    const now = new Date(0).toISOString();
    const envProfile: StoredAiProfile = {
      id: "env",
      name: `${inferAiProfileName(envBase, envModel)} (环境变量)`,
      base_url: envBase,
      model: envModel,
      api_key: envKey,
      created_at: now,
      updated_at: now,
    };
    return {
      version: 2,
      base_url: envBase,
      model: envModel,
      api_key: envKey,
      intake_enabled: envIntake,
      active_profile_id: "env",
      profiles: [envProfile],
      node_routes: emptyNodeRoutes(),
      source: "env",
    };
  }

  return {
    version: 2,
    base_url: stored?.base_url ?? "",
    model: stored?.model ?? "",
    api_key: stored?.api_key ?? "",
    intake_enabled: stored?.intake_enabled ?? false,
    active_profile_id: "",
    profiles: [],
    node_routes: emptyNodeRoutes(),
    source: "none",
  };
}

export function upsertAiProfile(
  dbPath: string,
  input: {
    id?: string;
    name?: string;
    base_url: string;
    model: string;
    api_key?: string;
    clear_api_key?: boolean;
    set_active?: boolean;
    intake_enabled?: boolean;
  },
): StoredAiConfig {
  const baseUrl = validateAiBaseUrl(input.base_url);
  const model = validateAiModelName(input.model);
  const rawKey = typeof input.api_key === "string" ? input.api_key.trim() : "";
  if (rawKey.length > 512) {
    throw new ApiError(400, "API Key 过长");
  }

  const existing = readStoredAiConfig(dbPath);
  const profiles = existing ? existing.profiles.map((p) => ({ ...p })) : [];
  const requestedId = typeof input.id === "string" ? input.id.trim() : "";
  const idx = requestedId ? profiles.findIndex((p) => p.id === requestedId) : -1;
  const now = new Date().toISOString();

  let targetId: string;
  if (idx >= 0) {
    const prev = profiles[idx]!;
    const nextKey = input.clear_api_key ? "" : rawKey || prev.api_key;
    const nextName =
      typeof input.name === "string" && input.name.trim()
        ? input.name.trim().slice(0, 60)
        : prev.name || inferAiProfileName(baseUrl, model);
    profiles[idx] = {
      ...prev,
      name: nextName,
      base_url: baseUrl,
      model,
      api_key: nextKey,
      updated_at: now,
    };
    targetId = prev.id;
  } else {
    if (profiles.length >= MAX_AI_PROFILES) {
      throw new ApiError(400, `最多保存 ${MAX_AI_PROFILES} 个模型配置`);
    }
    targetId = `prof_${randomBytes(6).toString("hex")}`;
    const nextName =
      typeof input.name === "string" && input.name.trim()
        ? input.name.trim().slice(0, 60)
        : inferAiProfileName(baseUrl, model);
    profiles.push({
      id: targetId,
      name: nextName,
      base_url: baseUrl,
      model,
      api_key: input.clear_api_key ? "" : rawKey,
      created_at: now,
      updated_at: now,
    });
  }

  const activeProfileId =
    input.set_active || !existing?.active_profile_id || profiles.length === 1
      ? targetId
      : existing.active_profile_id;

  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]!;
  return saveStoredAiConfig(dbPath, {
    version: 2,
    base_url: active.base_url,
    model: active.model,
    api_key: active.api_key,
    intake_enabled:
      input.intake_enabled !== undefined
        ? Boolean(input.intake_enabled)
        : existing?.intake_enabled ?? false,
    active_profile_id: active.id,
    profiles,
    node_routes: existing?.node_routes,
  });
}

export function selectActiveAiProfile(dbPath: string, profileId: string): StoredAiConfig {
  const existing = readStoredAiConfig(dbPath);
  if (!existing || existing.profiles.length === 0) {
    throw new ApiError(400, "尚未配置任何工作区模型");
  }
  const target = existing.profiles.find((p) => p.id === profileId.trim());
  if (!target) {
    throw new ApiError(404, "未找到指定的模型配置");
  }
  return saveStoredAiConfig(dbPath, {
    ...existing,
    base_url: target.base_url,
    model: target.model,
    api_key: target.api_key,
    active_profile_id: target.id,
  });
}

export function deleteAiProfile(dbPath: string, profileId: string): StoredAiConfig | null {
  const existing = readStoredAiConfig(dbPath);
  if (!existing || existing.profiles.length === 0) {
    throw new ApiError(404, "未找到指定的模型配置");
  }
  const cleanedId = profileId.trim();
  const remaining = existing.profiles.filter((p) => p.id !== cleanedId);
  if (remaining.length === existing.profiles.length) {
    throw new ApiError(404, "未找到指定的模型配置");
  }
  if (remaining.length === 0) {
    deleteStoredAiConfig(dbPath);
    return null;
  }
  const nextActive =
    existing.active_profile_id === cleanedId
      ? remaining[0]!
      : remaining.find((p) => p.id === existing.active_profile_id) ?? remaining[0]!;

  return saveStoredAiConfig(dbPath, {
    ...existing,
    base_url: nextActive.base_url,
    model: nextActive.model,
    api_key: nextActive.api_key,
    active_profile_id: nextActive.id,
    profiles: remaining,
    node_routes: existing.node_routes,
  });
}

export function updateAiNodeRoutes(
  dbPath: string,
  input: {
    intake_enabled?: boolean;
    node_routes?: Partial<Record<AiNodeId, { profile_id?: string; model?: string }>>;
  },
): StoredAiConfig {
  const existing = readStoredAiConfig(dbPath);
  if (!existing || existing.profiles.length === 0) {
    throw new ApiError(400, "请先添加至少一个模型配置，再设置节点路由");
  }
  const validIds = new Set(existing.profiles.map((p) => p.id));
  const nextRoutes: Record<AiNodeId, AiNodeRoute> = {
    prescreen: { ...existing.node_routes.prescreen },
    widget: { ...existing.node_routes.widget },
    operator: { ...existing.node_routes.operator },
    pr_audit: { ...existing.node_routes.pr_audit },
  };

  if (input.node_routes && typeof input.node_routes === "object") {
    for (const nodeId of AI_NODE_IDS) {
      const patch = input.node_routes[nodeId];
      if (!patch || typeof patch !== "object") continue;
      const profileId =
        typeof patch.profile_id === "string"
          ? patch.profile_id.trim()
          : nextRoutes[nodeId].profile_id;
      if (profileId && !validIds.has(profileId)) {
        throw new ApiError(400, `节点 ${nodeId} 指定的模型配置不存在`);
      }
      const model =
        typeof patch.model === "string"
          ? validateAiModelName(patch.model, true)
          : nextRoutes[nodeId].model;
      nextRoutes[nodeId] = { profile_id: profileId, model };
    }
  }

  return saveStoredAiConfig(dbPath, {
    ...existing,
    intake_enabled:
      input.intake_enabled !== undefined
        ? Boolean(input.intake_enabled)
        : existing.intake_enabled,
    node_routes: nextRoutes,
  });
}

export function resolveAiConfigForNode(
  dbPath: string,
  node: AiNodeId,
  override?: { profile_id?: string; model?: string },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAiNodeConfig {
  const effective = getEffectiveAiConfig(dbPath, env);
  const route = effective.node_routes[node] ?? { profile_id: "", model: "" };
  const defaultProfile =
    effective.profiles.find((p) => p.id === effective.active_profile_id) ??
    effective.profiles[0] ??
    null;

  let chosenProfile: StoredAiProfile | null = defaultProfile;
  let overridesProfile = false;

  const overrideProfileId = override?.profile_id?.trim() ?? "";
  if (overrideProfileId) {
    const found = effective.profiles.find((p) => p.id === overrideProfileId);
    if (!found) {
      throw new ApiError(400, "所选模型配置不存在，请刷新后重试");
    }
    chosenProfile = found;
    overridesProfile = chosenProfile.id !== (defaultProfile?.id ?? "");
  } else if (route.profile_id) {
    const routed = effective.profiles.find((p) => p.id === route.profile_id);
    if (routed) {
      chosenProfile = routed;
      overridesProfile = chosenProfile.id !== (defaultProfile?.id ?? "");
    }
  }

  const overrideModel = override?.model?.trim() ?? "";
  const routeModel = route.model?.trim() ?? "";
  const effectiveModel = overrideModel || routeModel || chosenProfile?.model || "";
  const overridesModel = Boolean(
    chosenProfile && effectiveModel && effectiveModel !== chosenProfile.model,
  );
  const baseUrl = chosenProfile?.base_url ?? "";
  const configured = Boolean(baseUrl && effectiveModel);

  return {
    node,
    configured,
    source: configured ? effective.source : "none",
    profile_id: chosenProfile?.id ?? "",
    profile_name: chosenProfile?.name ?? "",
    base_url: baseUrl,
    model: effectiveModel,
    api_key: chosenProfile?.api_key ?? "",
    intake_enabled: effective.intake_enabled,
    overrides_profile: overridesProfile,
    overrides_model: overridesModel,
  };
}

export function toAiProfileSummary(profile: StoredAiProfile): AiProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    base_url: profile.base_url,
    model: profile.model,
    has_api_key: Boolean(profile.api_key),
    api_key_preview: maskApiKey(profile.api_key),
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

function buildResolvedNodesMap(
  config: EffectiveAiConfig,
): Record<AiNodeId, AiResolvedNodeSummary> {
  const defaultProfile =
    config.profiles.find((p) => p.id === config.active_profile_id) ??
    config.profiles[0] ??
    null;

  const result = {} as Record<AiNodeId, AiResolvedNodeSummary>;
  for (const node of AI_NODE_IDS) {
    const route = config.node_routes[node] ?? { profile_id: "", model: "" };
    const chosen =
      (route.profile_id
        ? config.profiles.find((p) => p.id === route.profile_id)
        : null) ?? defaultProfile;
    const model = route.model.trim() || chosen?.model || "";
    const baseUrl = chosen?.base_url ?? "";
    const configured = Boolean(baseUrl && model);
    result[node] = {
      node,
      configured,
      source: configured ? config.source : "none",
      profile_id: chosen?.id ?? "",
      profile_name: chosen?.name ?? "",
      base_url: baseUrl,
      model,
      has_api_key: Boolean(chosen?.api_key),
      overrides_profile: Boolean(chosen && defaultProfile && chosen.id !== defaultProfile.id),
      overrides_model: Boolean(chosen && model && model !== chosen.model),
    };
  }
  return result;
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
    active_profile_id: config.active_profile_id,
    profiles: config.profiles.map(toAiProfileSummary),
    node_routes: {
      prescreen: { ...config.node_routes.prescreen },
      widget: { ...config.node_routes.widget },
      operator: { ...config.node_routes.operator },
      pr_audit: { ...config.node_routes.pr_audit },
    },
    resolved_nodes: buildResolvedNodesMap(config),
  };
}
