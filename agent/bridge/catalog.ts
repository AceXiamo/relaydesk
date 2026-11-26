import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { localBuiltinMetadata, sanitizeBridgeModels, validCatalogTokenLimit } from "../../app/lib/model-catalog.ts";
import type { BridgeRuntimeStatus, ChatReasoningEffort, ChatRuntime, ModelCatalogItem } from "../../app/lib/types.ts";

export interface BridgeCatalogConfig {
  agent_token?: unknown;
  claude_full_access?: boolean;
  codex_full_access?: boolean;
  agy_full_access?: boolean;
  auto_detect_cli_configs?: boolean;
  model_catalog_files?: unknown;
  runtimes?: Partial<Record<ChatRuntime, { bin?: string; default_model?: string; default_effort?: ChatReasoningEffort; extra_env?: unknown }>>;
  models?: unknown;
}
export interface BridgeCatalogOptions { homeDir?: string; configDir?: string }
export type BridgeCatalogRuntime = BridgeRuntimeStatus & { version: string };
export interface BridgeCatalog {
  runtimes: Record<ChatRuntime, BridgeCatalogRuntime>;
  models: ModelCatalogItem[];
  db_clients: string[];
}

type Fields = Record<string, unknown>;
const record = (input: unknown): Fields => input !== null && typeof input === "object" && !Array.isArray(input) ? input as Fields : {};
const runtimes = ["codex", "claude", "agy"] as const;
const dbClients = ["psql", "mysql", "sqlite3", "redis-cli", "mongosh"];
const exec = promisify(execFile);
const maxFileBytes = 1024 * 1024;

function sources(config: BridgeCatalogConfig, { homeDir = homedir(), configDir = join(homeDir, ".config/relaydesk-bridge") }: BridgeCatalogOptions) {
  function harnessDir(runtime: ChatRuntime, variable: string) {
    const override = record(config.runtimes?.[runtime]?.extra_env)[variable] ?? process.env[variable];
    return typeof override === "string" && isAbsolute(override) ? override : join(homeDir, `.${runtime}`);
  }
  const claudeDir = harnessDir("claude", "CLAUDE_CONFIG_DIR"), codexDir = harnessDir("codex", "CODEX_HOME");
  const agyDir = join(homeDir, ".gemini", "antigravity-cli");
  const detect = config.auto_detect_cli_configs !== false;
  const claude = detect ? ["settings.json", "settings.local.json"].map(name => join(claudeDir, name)) : [];
  const codex = detect ? [join(codexDir, "config.toml")] : [];
  const agy = detect ? [join(agyDir, "settings.json")] : [];
  const caches = detect ? [
    { runtime: "codex" as const, path: join(codexDir, "models_cache.json") },
    { runtime: "claude" as const, path: join(claudeDir, "cache", "model-capabilities.json") },
  ] : [];
  const catalogs = Array.isArray(config.model_catalog_files) ? config.model_catalog_files
    .filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 4096 && !p.includes("\0"))
    .map(p => p.startsWith("~/") ? resolve(homeDir, p.slice(2)) : resolve(configDir, p)) : [];
  return { claude, codex, agy, caches, catalogs: [...new Set(catalogs)] };
}

/** Includes missing files so the daemon can refresh when a config is first created. */
export function bridgeCatalogPaths(config: BridgeCatalogConfig, options: BridgeCatalogOptions = {}): string[] {
  const { claude, codex, agy, caches, catalogs } = sources(config, options);
  return [...new Set([...claude, ...codex, ...agy, ...caches.map(cache => cache.path), ...catalogs])];
}

async function load(path: string, parse: (text: string) => unknown, byteLimit = maxFileBytes): Promise<unknown> {
  // Config files are optional. Skip devices, FIFOs, oversized files and partial writes.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > byteLimit) return null;
    const buf = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buf.length) {
      const { bytesRead } = await file.read(buf, size, buf.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > info.size) return null;
    return parse(buf.toString("utf8", 0, size));
  } catch { return null; }
  finally { await file.close(); }
}

async function probe(bin: string): Promise<BridgeCatalogRuntime> {
  try {
    const { stdout } = await exec(bin, ["--version"], { timeout: 2500, killSignal: "SIGKILL", maxBuffer: 8192 });
    // Never forward an arbitrary banner, local path, stderr or command error.
    const version = stdout.match(/(?:^|\s)v?(\d{1,6}\.\d{1,6}(?:\.\d{1,6})?)(?=[\s+-]|$)/)?.[1] ?? "";
    return { available: true, version };
  } catch { return { available: false, version: "" }; }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if ((await stat(path)).isFile()) { await access(path, constants.X_OK); return true; }
  } catch { /* Missing or not executable. */ }
  return false;
}

async function onPath(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (await isExecutableFile(join(dir, name))) return true;
  }
  return false;
}

async function resolveRuntimeBin(runtime: ChatRuntime, configured: string | undefined, homeDir: string): Promise<string> {
  if (configured) return configured;
  if (runtime === "agy" && !(await onPath("agy"))) {
    const localInstall = join(homeDir, ".local", "bin", "agy");
    if (await isExecutableFile(localInstall)) return localInstall;
  }
  return runtime;
}

async function probeAgyModels(bin: string): Promise<Array<Record<string, unknown>>> {
  try {
    const { stdout } = await exec(bin, ["models"], { timeout: 5000, killSignal: "SIGKILL", maxBuffer: 65536 });
    const rows: Array<Record<string, unknown>> = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || !line.includes("\t")) continue;
      const [id, label] = line.split("\t").map(part => part.trim());
      if (!id || id.startsWith("-")) continue;
      const provider = id.startsWith("claude-") ? "Anthropic" : id.startsWith("gpt-") ? "OpenAI" : "Google";
      rows.push({
        runtime: "agy",
        id,
        ...(label ? { label } : {}),
        provider,
        supports_effort: true,
        effort_levels: ["low", "medium", "high", "max"],
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function effort(raw: unknown): ModelCatalogItem["default_effort"] {
  switch (raw) {
    case "minimal": case "none": return "off";
    case "xhigh": return "max";
    case "off": case "low": case "medium": case "high": case "max": return raw;
    default: return undefined;
  }
}

export async function detectBridgeCatalog(config: BridgeCatalogConfig, options: BridgeCatalogOptions = {}): Promise<BridgeCatalog> {
  const homeDir = options.homeDir ?? homedir();
  const files = sources(config, options);
  const resolvedBins = await Promise.all(
    runtimes.map(runtime => resolveRuntimeBin(runtime, config.runtimes?.[runtime]?.bin, homeDir)),
  );
  const [claude, codex, agy, catalogs, caches, runtimeProbes, dbProbes] = await Promise.all([
    Promise.all(files.claude.map(path => load(path, JSON.parse))),
    Promise.all(files.codex.map(path => load(path, parseToml))),
    Promise.all(files.agy.map(path => load(path, JSON.parse))),
    Promise.all(files.catalogs.map(path => load(path, JSON.parse))),
    // Codex embeds model instructions in its cache, which can exceed the config file limit.
    Promise.all(files.caches.map(async ({ runtime, path }) => ({ runtime, models: record(await load(path, JSON.parse, 8 * maxFileBytes)).models }))),
    Promise.all(resolvedBins.map(bin => probe(bin))),
    Promise.all(dbClients.map(onPath)),
  ]);
  const agyDetectedModels = runtimeProbes[2].available && config.auto_detect_cli_configs !== false
    ? await probeAgyModels(resolvedBins[2])
    : [];
  // Refuse aliases/labels duplicating an actual local credential, even when pasted into a public field.
  const secrets = new Set<string>();
  if (typeof config.agent_token === "string" && config.agent_token) secrets.add(config.agent_token);
  function guardEnv(value: unknown) {
    for (const [key, v] of Object.entries(record(value))) {
      if (/(?:key|token|secret|passw(?:or)?d|credential|authorization)/i.test(key) && typeof v === "string" && v) secrets.add(v);
    }
  }
  for (const settings of claude) guardEnv(record(settings).env);
  for (const runtime of runtimes) guardEnv(config.runtimes?.[runtime]?.extra_env);
  const clean = (rows: unknown) => sanitizeBridgeModels(rows).filter(item => !Object.values(item).flat()
    .some(value => typeof value === "string" && [...secrets].some(secret => value.includes(secret))));
  const items = new Map<string, ModelCatalogItem>();
  // Sources are consumed highest priority first. Lower sources can only fill missing fields.
  const add = (rows: unknown, source: NonNullable<ModelCatalogItem["source"]>) => {
    for (const model of clean(rows)) {
      const key = `${model.runtime}:${model.id}`;
      if (items.has(key) || items.size < 200) items.set(key, { ...model, source, ...items.get(key) });
    }
  };
  add(config.models, "bridge_config");
  for (const [i, runtime] of runtimes.entries()) {
    const settings = config.runtimes?.[runtime];
    const [model] = clean([{ runtime, id: settings?.default_model, default_effort: settings?.default_effort, is_default: true }]);
    if (model) {
      runtimeProbes[i].default_model = model.id;
      add([model], "bridge_config");
    }
    const configuredEffort = settings?.default_effort === "default" ? "default" : effort(settings?.default_effort);
    if (configuredEffort) runtimeProbes[i].default_effort = configuredEffort;
  }
  for (const catalog of catalogs) add(Array.isArray(catalog) ? catalog : record(catalog).models, "bridge_config");

  for (const value of claude.reverse()) {
    const settings = record(value), env = record(settings.env);
    const defaultId = settings.model ?? env.ANTHROPIC_MODEL;
    add([{ runtime: "claude", id: defaultId, default_effort: effort(settings.effortLevel), is_default: true }], "cli_config");
    for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) {
      add([{ id: env[key], runtime: "claude" }], "cli_config");
    }
    for (const list of [settings.availableModels, settings.models]) {
      if (Array.isArray(list)) add(list.map(entry => {
        if (typeof entry === "string") return { id: entry, runtime: "claude" };
        const row = record(entry);
        return { ...row, runtime: "claude", context_window: row.context_window ?? row.contextWindow };
      }), "cli_config");
    }
    const pickerOptions = record(settings.modelPicker).options;
    if (Array.isArray(pickerOptions)) {
      add(pickerOptions.map(option => {
        const { model, label, context_window, contextWindow } = record(option);
        return { id: model, label, runtime: "claude", context_window: context_window ?? contextWindow };
      }), "cli_config");
    }
  }
  for (const value of codex) {
    const settings = record(value);
    // Expose only recognized configured tiers; absence is not evidence that Fast is off.
    if (settings.service_tier === "priority" || settings.service_tier === "fast") runtimeProbes[0].default_fast_mode = "on";
    else if (settings.service_tier === "default") runtimeProbes[0].default_fast_mode = "off";
    add([{ id: settings.model, runtime: "codex", context_window: settings.model_context_window,
      default_effort: effort(settings.model_reasoning_effort), is_default: true }], "cli_config");
    for (const value of Object.values(record(settings.profiles))) {
      const profile = record(value);
      add([{ id: profile.model, runtime: "codex", context_window: profile.model_context_window,
        default_effort: effort(profile.model_reasoning_effort) }], "cli_config");
    }
  }
  for (const value of agy) {
    const settings = record(value);
    add([{ id: settings.model, runtime: "agy", default_effort: effort(settings.effort ?? settings.effortLevel), is_default: true }], "cli_config");
  }
  if (agyDetectedModels.length > 0) {
    add(agyDetectedModels, "detected");
  }
  // Caches describe capabilities. They do not select models or grant access to them.
  for (const { runtime, models } of caches) {
    if (!Array.isArray(models)) continue;
    for (const entry of models) {
      const row = record(entry);
      const id = runtime === "codex" ? row.slug : row.id;
      const window = runtime === "codex" ? row.context_window : row.max_input_tokens;
      if (typeof id !== "string") continue;
      const model = items.get(`${runtime}:${id}`);
      if (!model) continue;
      if (model.context_window === undefined && validCatalogTokenLimit(window)) model.context_window = window;
      if (runtime === "codex" && model.supports_fast === undefined) {
        const speeds = row.additional_speed_tiers, tiers = row.service_tiers;
        if ((Array.isArray(speeds) && speeds.includes("fast")) ||
            (Array.isArray(tiers) && tiers.some(tier => record(tier).id === "priority"))) model.supports_fast = true;
        else if ((Array.isArray(speeds) && speeds.every(speed => typeof speed === "string")) ||
                 (Array.isArray(tiers) && tiers.every(tier => typeof record(tier).id === "string"))) model.supports_fast = false;
      }
    }
  }
  for (const builtin of localBuiltinMetadata) {
    const key = `${builtin.runtime}:${builtin.id}`;
    if (items.has(key)) items.set(key, { ...builtin, ...items.get(key) });
  }
  return {
    runtimes: { codex: runtimeProbes[0], claude: runtimeProbes[1], agy: runtimeProbes[2] },
    models: [...items.values()], db_clients: dbClients.filter((_, i) => dbProbes[i]),
  };
}
