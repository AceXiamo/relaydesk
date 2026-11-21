import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { builtinModels, sanitizeBridgeModels } from "../../app/lib/model-catalog.ts";
import type { BridgeRuntimeStatus, ChatReasoningEffort, ChatRuntime, ModelCatalogItem } from "../../app/lib/types.ts";

export interface BridgeCatalogConfig {
  agent_token?: unknown;
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
const runtimes = ["codex", "claude"] as const;
const dbClients = ["psql", "mysql", "sqlite3", "redis-cli", "mongosh"];
const exec = promisify(execFile);
const maxFileBytes = 1024 * 1024;

function sources(config: BridgeCatalogConfig, { homeDir = homedir(), configDir = join(homeDir, ".config/relaydesk-bridge") }: BridgeCatalogOptions) {
  const claude = config.auto_detect_cli_configs === false ? [] : ["settings.json", "settings.local.json"].map(name => join(homeDir, ".claude", name));
  const codex = config.auto_detect_cli_configs === false ? [] : [join(homeDir, ".codex/config.toml")];
  const catalogs = Array.isArray(config.model_catalog_files) ? config.model_catalog_files
    .filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 4096 && !p.includes("\0"))
    .map(p => p.startsWith("~/") ? resolve(homeDir, p.slice(2)) : resolve(configDir, p)) : [];
  return { claude, codex, catalogs: [...new Set(catalogs)] };
}

/** Includes missing files so the daemon can refresh when a config is first created. */
export function bridgeCatalogPaths(config: BridgeCatalogConfig, options: BridgeCatalogOptions = {}): string[] {
  const { claude, codex, catalogs } = sources(config, options);
  return [...new Set([...claude, ...codex, ...catalogs])];
}

async function load(path: string, parse: (text: string) => unknown): Promise<unknown> {
  // Config files are optional. Skip devices, FIFOs, oversized files and partial writes.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxFileBytes) return null;
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

async function onPath(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(dir, name);
    try {
      if ((await stat(path)).isFile()) { await access(path, constants.X_OK); return true; }
    } catch { /* Not installed in this directory. */ }
  }
  return false;
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
  const files = sources(config, options);
  const [claude, codex, catalogs, runtimeProbes, dbProbes] = await Promise.all([
    Promise.all(files.claude.map(path => load(path, JSON.parse))),
    Promise.all(files.codex.map(path => load(path, parseToml))),
    Promise.all(files.catalogs.map(path => load(path, JSON.parse))),
    Promise.all(runtimes.map(runtime => probe(config.runtimes?.[runtime]?.bin || runtime))),
    Promise.all(dbClients.map(onPath)),
  ]);
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
      if (Array.isArray(list)) add(list.map(row => typeof row === "string" ? { id: row, runtime: "claude" } : { ...record(row), runtime: "claude" }), "cli_config");
    }
  }
  for (const value of codex) {
    const settings = record(value);
    add([{ id: settings.model, runtime: "codex", default_effort: effort(settings.model_reasoning_effort), is_default: true }], "cli_config");
    for (const value of Object.values(record(settings.profiles))) {
      const profile = record(value);
      add([{ id: profile.model, runtime: "codex", default_effort: effort(profile.model_reasoning_effort) }], "cli_config");
    }
  }
  for (const builtin of builtinModels) {
    const key = `${builtin.runtime}:${builtin.id}`;
    if (items.has(key)) items.set(key, { ...builtin, ...items.get(key) });
  }
  return {
    runtimes: { codex: runtimeProbes[0], claude: runtimeProbes[1] },
    models: [...items.values()], db_clients: dbClients.filter((_, i) => dbProbes[i]),
  };
}
