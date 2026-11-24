import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeCatalogPaths, detectBridgeCatalog } from "../agent/bridge/catalog.ts";
import {
  resolveActiveLocalAgent,
  resolveCatalogForTarget,
  resolveDefaultModelForTarget,
  resolveLocalTaskAgent,
  resolveLocalTaskModelCatalog,
  sanitizeBridgeModels,
} from "../app/lib/model-catalog.ts";
import type { BridgeAgentSummary, ChatRuntimeInfo } from "../app/lib/types.ts";

let homeDir: string, configDir: string, binDir: string;
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
const marker = (id: number) => `private-value-${id}`;
beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "bridge-catalog-"));
  configDir = join(homeDir, "bridge"); binDir = join(homeDir, "bin");
  await Promise.all([".claude", ".codex", "bridge", "bin"].map(p => mkdir(join(homeDir, p))));
  vi.stubEnv("PATH", binDir);
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true }); });

describe("local bridge model discovery", () => {
  it("merges fields by priority, enriches known IDs and probes configured executables without exporting paths or banners", async () => {
    await json(join(homeDir, ".claude/settings.json"), {
      model: "claude-opus-4-6", effortLevel: "low", models: [{ id: "agent", label: "global" }],
      availableModels: ["sonnet"], env: { ANTHROPIC_MODEL: "custom/env", ANTHROPIC_DEFAULT_OPUS_MODEL: "gateway/o",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "gateway/s", ANTHROPIC_DEFAULT_HAIKU_MODEL: "gateway/h", ANTHROPIC_AUTH_TOKEN: marker(1) },
    });
    await json(join(homeDir, ".claude/settings.local.json"), { models: [{ id: "agent", label: "local" }] });
    await writeFile(join(homeDir, ".codex/config.toml"), [
      'model = "gpt-5.4"', 'model_reasoning_effort = "minimal"', '[profiles."deep.v2"]',
      'model_reasoning_effort = "xhigh"', "model = 'gateway/deep' # model selection", '[mcp_servers.unrelated]',
      'model = "not-a-model"', 'description = """', '[profiles.fake]', 'model = "in-a-description"', '"""',
      '[model_providers.test]', `experimental_bearer_token = "${marker(2)}"`,
    ].join("\n"));
    await json(join(configDir, "models.json"), { models: [{ id: "gpt-5.4", runtime: "codex", context_window: 12345, label: "extra", token: marker(3) }] });
    const bin = join(binDir, "my codex");
    await writeFile(bin, '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\nprintf "version 1.2.3 private-value-004\\n"\n', { mode: 0o700 });
    await writeFile(join(binDir, "psql"), "", { mode: 0o700 });
    await writeFile(join(binDir, "mysql"), "", { mode: 0o600 });
    const result = await detectBridgeCatalog({
      agent_token: marker(5), runtimes: { codex: { bin, default_model: "gpt-5.4", default_effort: "high", extra_env: { TOKEN: marker(6) } } },
      model_catalog_files: ["models.json"], models: [{ id: "gpt-5.4", runtime: "codex", label: "explicit" }, { id: "gpt-5.4", runtime: "claude" },
        { id: marker(5), runtime: "claude" }, { id: marker(1), runtime: "codex" }],
    }, { homeDir, configDir });
    expect(result.runtimes).toEqual({ codex: { available: true, version: "1.2.3", default_model: "gpt-5.4", default_effort: "high" }, claude: { available: false, version: "" } });
    expect(result.db_clients).toEqual(["psql"]);
    const get = (id: string, runtime = "claude") => result.models.find(m => m.id === id && m.runtime === runtime);
    expect(get("gpt-5.4", "codex")).toMatchObject({ label: "explicit", context_window: 12345, effort_levels: ["low", "medium", "high", "max"], source: "bridge_config", default_effort: "high" });
    expect(get("gpt-5.4")).toEqual({ id: "gpt-5.4", runtime: "claude", source: "bridge_config" });
    expect(get("agent")).toMatchObject({ label: "local", source: "cli_config" });
    expect(get("gateway/deep", "codex")).toMatchObject({ default_effort: "max" });
    expect(get("claude-opus-4-6")).toMatchObject({ default_effort: "low" });
    expect(get("claude-opus-4-6")).not.toHaveProperty("context_window");
    expect(result.models.map(m => m.id)).toEqual(expect.arrayContaining(["sonnet", "custom/env", "gateway/o", "gateway/s", "gateway/h"]));
    expect(JSON.stringify(result)).not.toMatch(/private-value|in-a-description|not-a-model|claude-sonnet-4-6|my codex/);
  });

  it("distinguishes Fast capability, configured tier, and absent telemetry", async () => {
    const config = { models: ["legacy", "standard", "unknown", "confirmed", "manual"].map(id => ({ runtime: "codex", id, ...(id === "manual" && { supports_fast: false }) })) };
    await json(join(homeDir, ".codex/models_cache.json"), { models: [
      { slug: "confirmed", service_tiers: [{ id: "priority", description: marker(1) }] },
      { slug: "legacy", additional_speed_tiers: ["fast"] }, { slug: "standard", service_tiers: [] },
      { slug: "unknown" }, { slug: "manual", additional_speed_tiers: ["fast"] },
    ] });
    const absent = await detectBridgeCatalog(config, { homeDir, configDir });
    expect(absent.runtimes.codex.default_fast_mode).toBeUndefined();
    expect(absent.models.map(m => m.supports_fast)).toEqual([true, false, undefined, true, false]);
    await writeFile(join(homeDir, ".codex/config.toml"), 'service_tier = "priority"');
    const configured = await detectBridgeCatalog(config, { homeDir, configDir });
    expect(configured.runtimes.codex.default_fast_mode).toBe("on");
    expect(JSON.stringify(configured)).not.toContain(marker(1));
  });

  it("discovers all Claude picker options and merges the default without exporting option metadata", async () => {
    const options = Array.from({ length: 11 }, (_, i) => ({
      model: `gateway/model-${i}[1m]`, label: `Gateway model ${i}`, description: marker(i),
    }));
    await json(join(homeDir, ".claude/settings.json"), {
      model: options[0].model,
      modelPicker: { replaceBuiltInOptions: true, options },
    });
    const { models } = await detectBridgeCatalog({}, { homeDir, configDir });
    expect(models).toEqual(options.map(({ model, label }, i) => ({
      id: model, label, runtime: "claude", source: "cli_config", ...(i === 0 && { is_default: true }),
    })));
  });

  it("syncs only bounded windows for exact runtime/model matches and respects configured overrides", async () => {
    const codexDir = join(homeDir, "custom-codex"), claudeDir = join(homeDir, "custom-claude");
    await mkdir(codexDir);
    await mkdir(join(claudeDir, "cache"), { recursive: true });
    vi.stubEnv("CODEX_HOME", codexDir);
    await writeFile(join(codexDir, "config.toml"), [
      'model = "configured"', 'model_context_window = 90000',
      '[profiles.deep]', 'model = "profile"', 'model_context_window = 78000',
    ].join("\n"));
    await json(join(codexDir, "models_cache.json"), { models: [
      { slug: "shared", context_window: 120000, max_context_window: 900000, base_instructions: marker(7).repeat(100000) },
      ...["manual", "configured", "profile", "cache-only"].map(slug => ({ slug, context_window: 40000 })),
      { slug: "unknown", context_window: 10_000_001, max_context_window: 900000, total_token_usage: { total_tokens: 999 } },
    ] });
    await json(join(claudeDir, "settings.json"), { availableModels: [{ id: "listed", contextWindow: 51000 }], modelPicker: { options: [
      { model: "shared" }, { model: "explicit", contextWindow: 345678 }, { model: "shared[1m]" },
    ] } });
    await json(join(claudeDir, "cache/model-capabilities.json"), { timestamp: 1, models: [
      { id: "shared", max_input_tokens: 200000, max_tokens: 8192 }, { id: "explicit", max_input_tokens: 30000 },
      { id: "shared[1m]", max_tokens: 10000, input_tokens: 12345, total_input_tokens: 876543 },
    ] });
    const config = { runtimes: { claude: { extra_env: { CLAUDE_CONFIG_DIR: claudeDir } } }, models: [
      { id: "shared", runtime: "codex" }, { id: "manual", runtime: "codex", context_window: 42000 }, { id: "unknown", runtime: "codex" },
    ] };
    const { models } = await detectBridgeCatalog(config, { homeDir });
    expect(Object.fromEntries(models.map(m => [`${m.runtime}:${m.id}`, m.context_window]))).toStrictEqual({
      "codex:shared": 120000, "codex:manual": 42000, "codex:configured": 90000, "codex:profile": 78000, "codex:unknown": undefined,
      "claude:shared": 200000, "claude:explicit": 345678, "claude:listed": 51000, "claude:shared[1m]": undefined,
    });
    expect(JSON.stringify(models)).not.toMatch(/private-value|base_instructions|extra_env|total_input_tokens/);
    expect((await detectBridgeCatalog({ ...config, auto_detect_cli_configs: false }, { homeDir })).models[0]).not.toHaveProperty("context_window");
  });

  it("disables native discovery independently of explicitly configured files and watches absent files", async () => {
    await json(join(homeDir, ".claude/settings.json"), { model: "hidden" });
    await json(join(homeDir, "manual.json"), [{ id: "declared", runtime: "codex" }]);
    const config = { auto_detect_cli_configs: false, model_catalog_files: ["~/manual.json", "missing.json", "~/manual.json"] };
    expect(bridgeCatalogPaths(config, { homeDir, configDir })).toEqual([join(homeDir, "manual.json"), join(configDir, "missing.json")]);
    expect(bridgeCatalogPaths({}, { homeDir })).toEqual([
      ".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml", ".codex/models_cache.json", ".claude/cache/model-capabilities.json",
    ].map(path => join(homeDir, path)));
    expect((await detectBridgeCatalog(config, { homeDir, configDir })).models).toEqual([{ id: "declared", runtime: "codex", source: "bridge_config" }]);
  });

  it("ignores invalid, oversized and non-regular files without losing usable sources", async () => {
    await writeFile(join(homeDir, ".codex/config.toml"), 'model = "partial"\nnot valid');
    await writeFile(join(homeDir, ".claude/settings.json"), "{invalid");
    await json(join(homeDir, ".claude/settings.local.json"), { model: "too-big", padding: "x".repeat(1024 * 1024) });
    await json(join(configDir, "more.json"), [{ id: "survives", runtime: "claude" }]);
    expect((await detectBridgeCatalog({ model_catalog_files: [".", "more.json"] }, { homeDir, configDir })).models.map(m => m.id)).toEqual(["survives"]);
  });
});

describe("bridge wire model sanitizer", () => {
  it("whitelists schema fields, validates limits and rejects invalid identities", () => {
    expect(sanitizeBridgeModels({ models: [] })).toEqual([]);
    expect(sanitizeBridgeModels([null, {}, { id: "-arg", runtime: "codex" }, { id: "ok", runtime: "other" },
      { id: "https://api.test/models", runtime: "claude" }, { id: "rdbr_examplecredential", runtime: "claude" },
      { id: "r/model[1m]", runtime: "claude", label: "display\ntext", provider: "provider", context_window: 42, max_output_tokens: -5,
        effort_levels: ["off", "default", {}, "off", "max"], default_effort: "default", supports_effort: false, is_default: "false",
        tags: ["coding", { token: "secret" }, "x".repeat(100), "coding"], source: "not-a-source", token: "secret", env: { TEST: "secret" } },
    ])).toEqual([{ id: "r/model[1m]", runtime: "claude", provider: "provider", context_window: 42, effort_levels: ["off", "max"], supports_effort: false, tags: ["coding"] }]);
  });
  it("deduplicates by runtime and ID and caps the output at 200 models", () => {
    const rows = [{ id: "m", runtime: "codex", label: "A" }, { id: "m", runtime: "codex", context_window: 42 }, { id: "m", runtime: "claude" },
      ...Array.from({ length: 250 }, (_, i) => ({ runtime: "codex", id: `m${i}` }))];
    const models = sanitizeBridgeModels(rows);
    expect(models).toHaveLength(200);
    expect(models[0]).toEqual({ id: "m", runtime: "codex", label: "A", context_window: 42 });
    expect(models[1].runtime).toBe("claude");
  });
});

describe("target-scoped model catalog resolution", () => {
  const macAgent: BridgeAgentSummary = {
    id: "agent-mac",
    name: "xiamo's mac",
    online: true,
    hostname: "AceXiamo.local",
    platform: "darwin",
    bridge_version: "2.0.0",
    token_prefix: "rdbr_mac",
    max_concurrency: 2,
    active_runs: 0,
    accept_cli_runs: true,
    last_seen_at: "2026-11-22T00:00:00Z",
    updated_at: "2026-11-22T00:00:00Z",
    runtimes: {
      claude: { available: true, version: "2.1.330" },
      codex: { available: true, version: "0.140.0" },
    },
    models: [
      { id: "codex/gpt-6.2-astra", runtime: "claude", is_default: true, source: "cli_config" },
      { id: "codex/gpt-6.2-sol", runtime: "claude", source: "cli_config" },
      { id: "gpt-6.2-astra", runtime: "codex", is_default: true, source: "cli_config" },
    ],
    capabilities: { allowed_roots_enabled: true },
    bindings: [
      {
        project_id: "proj-1",
        agent_id: "agent-mac",
        workdir: "/Users/dev/project",
        enabled: true,
        path_ok: true,
        path_error: "",
        allow_datasource_secrets: false,
        updated_at: "2026-11-22T00:00:00Z",
      },
    ],
    created_at: "2026-11-22T00:00:00Z",
  };

  const runtimeInfo: ChatRuntimeInfo = {
    local_clis: { claude: true, codex: true },
    project_cli: {
      runtime: "claude",
      configured: true,
      endpoint: "https://gateway.example/v1",
      model: "deepseek-flash",
      models: [{ id: "deepseek-flash", runtime: "claude", source: "cloud_config" }],
      default_effort: "medium",
    },
    auth_mode: { claude: "project_key", codex: "local_cli" },
    routing: {
      priority: ["local:agent-mac", "cloud"],
      auto_fallback: true,
      route_cli_runs: true,
      auto_dispatch_tasks: false,
      task_network_access: true,
    },
    effective_priority: ["local:agent-mac", "cloud"],
    agents: [macAgent],
  };

  it("isolates local agent models from cloud project CLI models and unrelated builtins", () => {
    const active = resolveActiveLocalAgent(runtimeInfo, "proj-1", "auto", "claude");
    expect(active?.id).toBe("agent-mac");

    const claudeCatalog = resolveCatalogForTarget({
      runtime: "claude",
      activeLocalAgent: active,
      projectCli: runtimeInfo.project_cli,
      selectedModel: "codex/gpt-6.2-astra",
    });
    expect(claudeCatalog.map((m) => m.id)).toEqual(["codex/gpt-6.2-astra", "codex/gpt-6.2-sol"]);
    expect(resolveDefaultModelForTarget("claude", active, runtimeInfo.project_cli)).toBe("codex/gpt-6.2-astra");

    const codexCatalog = resolveCatalogForTarget({
      runtime: "codex",
      activeLocalAgent: active,
      projectCli: runtimeInfo.project_cli,
      selectedModel: "",
    });
    expect(codexCatalog.map((m) => m.id)).toEqual(["gpt-6.2-astra"]);
    expect(resolveDefaultModelForTarget("codex", active, runtimeInfo.project_cli)).toBe("gpt-6.2-astra");
  });

  it("keeps unreported local windows absent in chat and task pickers, including fallback rows", () => {
    const agent = { ...macAgent, models: [{ id: "claude-opus-4-6", runtime: "claude" as const, context_window: 48000 }] };
    const options = { runtime: "claude" as const, selectedModel: "claude-sonnet-4-6" };
    for (const catalog of [resolveCatalogForTarget({ ...options, activeLocalAgent: agent, projectCli: undefined }),
      resolveLocalTaskModelCatalog({ ...options, agent })]) {
      expect(catalog.map(item => item.context_window)).toEqual([48000, undefined]);
    }
    expect(resolveLocalTaskModelCatalog({ ...options, agent: null }).every(item => item.context_window === undefined)).toBe(true);
  });

  it("uses cloud project models and built-in suggestions only when targeting cloud", () => {
    const active = resolveActiveLocalAgent(runtimeInfo, "proj-1", "cloud", "claude");
    expect(active).toBeNull();

    const cloudCatalog = resolveCatalogForTarget({
      runtime: "claude",
      activeLocalAgent: active,
      projectCli: runtimeInfo.project_cli,
      selectedModel: "deepseek-flash",
    });
    expect(cloudCatalog.map((m) => m.id)).toEqual(["deepseek-flash", "claude-opus-4-6", "claude-sonnet-4-6"]);
    expect(resolveDefaultModelForTarget("claude", active, runtimeInfo.project_cli)).toBe("deepseek-flash");
  });

  it("falls through cloud in auto mode when cloud lacks the CLI and auto_fallback is enabled", () => {
    const cloudFirstNoCli: ChatRuntimeInfo = {
      ...runtimeInfo,
      local_clis: { claude: false, codex: false },
      routing: {
        priority: ["cloud", "local:agent-mac"],
        auto_fallback: true,
        route_cli_runs: true,
        auto_dispatch_tasks: false,
        task_network_access: true,
      },
      effective_priority: ["cloud", "local:agent-mac"],
    };
    expect(resolveActiveLocalAgent(cloudFirstNoCli, "proj-1", "auto", "claude")?.id).toBe("agent-mac");

    const strictCloudFirst: ChatRuntimeInfo = {
      ...cloudFirstNoCli,
      routing: {
        priority: ["cloud", "local:agent-mac"],
        auto_fallback: false,
        route_cli_runs: true,
        auto_dispatch_tasks: false,
        task_network_access: true,
      },
    };
    expect(resolveActiveLocalAgent(strictCloudFirst, "proj-1", "auto", "claude")).toBeNull();
  });

  it("resolves Local Agent task target skipping cloud and isolates its model catalog", () => {
    const resolved = resolveLocalTaskAgent({
      agents: [macAgent],
      effectivePriority: ["cloud", "local:agent-mac"],
      projectId: "proj-1",
      executionTarget: "auto",
      runtime: "claude",
    });
    expect(resolved.ready).toBe(true);
    expect(resolved.agent?.id).toBe("agent-mac");

    const catalog = resolveLocalTaskModelCatalog({
      runtime: "claude",
      agent: resolved.agent,
      includeSelectedFallback: false,
    });
    expect(catalog.map((m) => m.id)).toEqual(["codex/gpt-6.2-astra", "codex/gpt-6.2-sol"]);

    // When no local agent is registered yet, falls back to built-in suggestions for the chosen harness.
    const noAgent = resolveLocalTaskAgent({
      agents: [],
      effectivePriority: ["cloud"],
      projectId: "proj-1",
      executionTarget: "auto",
      runtime: "codex",
    });
    expect(noAgent.ready).toBe(false);
    expect(noAgent.agent).toBeNull();
    const fallbackCatalog = resolveLocalTaskModelCatalog({
      runtime: "codex",
      agent: noAgent.agent,
      includeSelectedFallback: false,
    });
    expect(fallbackCatalog.map((m) => m.id)).toEqual(["gpt-5.4"]);
  });
});
