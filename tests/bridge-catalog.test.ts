import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeCatalogPaths, detectBridgeCatalog } from "../agent/bridge/catalog.ts";
import { sanitizeBridgeModels } from "../app/lib/model-catalog.ts";

let homeDir: string, configDir: string, binDir: string;
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
const marker = (id: number) => `private-value-${id}`;
beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "bridge-catalog-"));
  configDir = join(homeDir, "bridge"); binDir = join(homeDir, "bin");
  await Promise.all([".claude", ".codex", "bridge", "bin"].map(p => mkdir(join(homeDir, p))));
  vi.stubEnv("PATH", binDir);
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
    expect(get("claude-opus-4-6")).toMatchObject({ context_window: 1_000_000, default_effort: "low" });
    expect(result.models.map(m => m.id)).toEqual(expect.arrayContaining(["sonnet", "custom/env", "gateway/o", "gateway/s", "gateway/h"]));
    expect(JSON.stringify(result)).not.toMatch(/private-value|in-a-description|not-a-model|claude-sonnet-4-6|my codex/);
  });

  it("disables native discovery independently of explicitly configured files and watches absent files", async () => {
    await json(join(homeDir, ".claude/settings.json"), { model: "hidden" });
    await json(join(homeDir, "manual.json"), [{ id: "declared", runtime: "codex" }]);
    const config = { auto_detect_cli_configs: false, model_catalog_files: ["~/manual.json", "missing.json", "~/manual.json"] };
    expect(bridgeCatalogPaths(config, { homeDir, configDir })).toEqual([join(homeDir, "manual.json"), join(configDir, "missing.json")]);
    expect(bridgeCatalogPaths({}, { homeDir })).toEqual([join(homeDir, ".claude/settings.json"), join(homeDir, ".claude/settings.local.json"), join(homeDir, ".codex/config.toml")]);
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
