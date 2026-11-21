import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectCliConfiguration, readProjectCliSettings } from "../server/project-cli-config.ts";

const id = "a".repeat(32);
const publicDefaults = { runtime: "codex", endpoint: "", model: "", models: [], default_effort: "default", configured: false, github_configured: false, public_ai_enabled: false };
let dir: string, db: string, root: string, project: string, file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "project-cli-"));
  db = join(dir, "state.sqlite");
  root = join(dir, "cli-runners");
  project = join(root, id);
  file = join(project, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const patch = (changes: Record<string, unknown>) => projectCliConfiguration(db, id, changes);

describe("project CLI settings", () => {
  it("returns defaults without creating files or reading legacy credentials", () => {
    const legacy = join(dir, "codex-runners", id);
    mkdirSync(legacy, { recursive: true, mode: 0o700 });
    writeFileSync(join(legacy, "credentials.json"), JSON.stringify({ project_id: id, api_key: "legacy", github_token: "legacy" }), { mode: 0o600 });
    expect(projectCliConfiguration(db, id)).toEqual(publicDefaults);
    expect(existsSync(root)).toBe(false);
    expect(projectCliConfiguration(":memory:", id)).toEqual(publicDefaults);
    expect(() => projectCliConfiguration(":memory:", id, { api_key: "key" })).toThrow(/持久化/);
    expect(() => projectCliConfiguration(db, "../project")).toThrow(/项目 ID/);
  });

  it("persists the exact private schema and exposes only public settings", () => {
    const fields = { models: [], default_effort: "default", runtime: "claude", endpoint: "https://proxy.example/api", model: "vendor/model:beta", public_ai_enabled: true };
    const secrets = { api_key: "test-api-key", github_token: "test-gh-token" };
    const state = { ...fields, configured: true, github_configured: true };
    expect(patch({ ...fields, ...secrets })).toEqual(state);
    expect(projectCliConfiguration(db, id)).toEqual(state);
    const stored = { project_id: id, ...fields, ...secrets };
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(stored);
    expect(readProjectCliSettings(db, id)).toEqual(stored);
    expect(projectCliConfiguration(db, "b".repeat(32))).toEqual(publicDefaults);
    for (const path of [project, root]) expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(patch({ api_key: "", public_ai_enabled: false })).toEqual({ ...state, configured: false, public_ai_enabled: false });
    expect(patch({ github_token: "" }).github_configured).toBe(false);
  });

  it("requires explicit key entry or clearing when its destination changes", () => {
    patch({ endpoint: "https://ONE.example/v1/", api_key: "old", github_token: "github" });
    expect(patch({ endpoint: "https://one.example/v1", model: "gpt-test" }).configured).toBe(true);
    const before = readFileSync(file, "utf8");
    for (const update of [{ endpoint: "" }, { endpoint: "https://two.example", github_token: "different" }, { runtime: "claude", endpoint: "" }]) {
      expect(() => patch(update)).toThrow(/重新输入/);
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    expect(patch({ endpoint: "https://two.example", api_key: "old" }).configured).toBe(true);
    expect(patch({ endpoint: "https://three.example", api_key: "new" }).configured).toBe(true);
    expect(() => patch({ runtime: "claude" })).toThrow(/重新输入/);
    expect(patch({ runtime: "claude", api_key: "" })).toMatchObject({ configured: false, github_configured: true });
  });

  it("rejects unsafe endpoints and full API routes without echoing input", () => {
    for (const endpoint of ["http://api.example", "https://secret-value@api.example", "https://api.example?", "https://api.example/#",
      "https://localhost.", "https://a.localhost", "https://metadata.google.internal", "https://gateway.lan", "https://service",
      "https://127.1", "https://2130706433", "https://0x7f000001", "https://169.254.169.254", "https://10.1.2.3", "https://[::1]",
      "https://[fd00::1]", "https://[fe80::1]", "https://[::ffff:127.0.0.1]", "https://api.example/v1/responses",
      "https://api.example/v1/chat/completions", "https://api.example/v1/messages/count_tokens", "https://api.example/v1/%6dessages"]) {
      expect(() => patch({ endpoint })).toThrow(/^请提供该运行时的公网 HTTPS API 基础地址$/);
    }
    expect(() => patch({ runtime: "claude", endpoint: "https://api.example/base/v1/" })).toThrow(/基础地址/);
    expect(patch({ endpoint: "https://api.example:8443/base/v1/" }).endpoint).toBe("https://api.example:8443/base/v1");
  });

  it("rejects invalid patch fields without disclosing submitted secrets", () => {
    for (const invalid of [{}, { configured: true }, { project_id: id }, { runtime: "other" }, { public_ai_enabled: "false" },
      { api_key: 123 }, { github_token: "secret-value\n" }, { model: "--option" }, { endpoint: false }]) {
      expect(() => patch(invalid)).toThrow(expect.objectContaining({ status: 400, message: expect.not.stringContaining("secret-value") }));
    }
    expect(existsSync(root)).toBe(false);
  });

  it("rejects credentials copied into public fields", () => {
    for (const update of [{ model: "contains-secret-value", api_key: "secret-value" },
      { endpoint: "https://api.example/secret-value", github_token: "secret-value" }]) {
      expect(() => patch(update)).toThrow(expect.objectContaining({ status: 400, message: expect.not.stringContaining("secret-value") }));
    }
    expect(existsSync(file)).toBe(false);
  });

  it("keeps replaced and revoked credentials out of both public fields", () => {
    const previousKey = "previous-api-key";
    const previousToken = "previous-github-token";
    patch({ api_key: previousKey, github_token: previousToken });
    const before = readFileSync(file, "utf8");
    for (const secret of [previousKey, previousToken]) {
      for (const fields of [{ model: `model-${secret}` }, { endpoint: `https://api.example/${secret}` }]) {
        expect(() => patch({ ...fields, api_key: "replacement", github_token: "" })).toThrow(expect.objectContaining({
          status: 400, message: expect.not.stringContaining(secret),
        }));
        expect(readFileSync(file, "utf8")).toBe(before);
      }
    }
  });

  it("fails closed on tampered files, extra fields, and mismatched project IDs", () => {
    patch({ api_key: "secret-value" });
    const saved = readProjectCliSettings(db, id);
    for (const contents of ["secret-value invalid JSON", JSON.stringify({ ...saved, project_id: "b".repeat(32) }),
      JSON.stringify({ ...saved, extra: true }), JSON.stringify({ ...saved, endpoint: "https://localhost" }),
      JSON.stringify({ ...saved, public_ai_enabled: undefined }), JSON.stringify({ ...saved, default_effort: null }),
      JSON.stringify({ ...saved, models: [{ id: "m", runtime: "codex", tags: [saved.api_key] }] })]) {
      writeFileSync(file, contents);
      for (const read of [readProjectCliSettings, projectCliConfiguration]) {
        expect(() => read(db, id)).toThrow(expect.objectContaining({ status: 500, message: expect.not.stringContaining("secret-value") }));
      }
      expect(() => patch({ model: "valid" })).toThrow(/无效/);
      expect(readFileSync(file, "utf8")).toBe(contents);
    }
  });

  it("fills in new fields for legacy files without rewriting on read", () => {
    patch({ model: "legacy" });
    const { models: _models, default_effort: _effort, ...legacy } = readProjectCliSettings(db, id);
    writeFileSync(file, JSON.stringify(legacy));
    expect(readProjectCliSettings(db, id)).toEqual({ ...legacy, models: [], default_effort: "default" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(legacy);
    expect(patch({ public_ai_enabled: true })).toMatchObject({ model: "legacy", default_effort: "default", models: [] });
  });

  const item = { id: "gateway/model:alpha", runtime: "claude", label: "主力模型", provider: "代理", context_window: 2_000_000,
    max_output_tokens: 32_768, supports_effort: true, effort_levels: ["off", "high", "off"], default_effort: "high", is_default: true,
    tags: ["fast"], source: "detected" };

  it("normalizes models and preserves omitted catalog fields on patch", () => {
    const expected = [{ ...item, effort_levels: ["off", "high"], source: "cloud_config" }];
    expect(patch({ models: [item], default_effort: "max" })).toMatchObject({ models: expected, default_effort: "max" });
    expect(patch({ model: "new" }).models).toEqual(expected);
    expect(readProjectCliSettings(db, id)).toMatchObject({ models: expected, default_effort: "max" });
    expect(patch({ models: [] }).models).toEqual([]);
  });

  it("rejects invalid catalogs and duplicate identities atomically", () => {
    const invalidItems = [{ id: "" }, { id: "-flag" }, { id: "a b" }, { id: "x".repeat(161) }, { runtime: "api" },
      { label: "x".repeat(121) }, { label: "with\ncontrol" }, { provider: "x".repeat(61) }, { tags: Array(9).fill("tag") },
      { tags: [3] }, { effort_levels: ["default"] }, { default_effort: "xhigh" },
      { context_window: 1.5 }, { context_window: 10_000_001 }, { max_output_tokens: 0 }, { supports_effort: "yes" },
      { is_default: 1 }, { source: "unknown" }, { api_key: "unexpected" }];
    for (const models of [null, {}, [null], [item, item], Array(51).fill(item), ...invalidItems.map(fields => [{ ...item, ...fields }])]) {
      expect(() => patch({ models })).toThrow(expect.objectContaining({ status: 400 }));
    }
    expect(() => patch({ default_effort: "minimal" })).toThrow(expect.objectContaining({ status: 400 }));
    expect(existsSync(file)).toBe(false);
    expect(patch({ models: [item, { ...item, runtime: "codex" }] }).models).toHaveLength(2);
  });

  it("rejects current and replaced secrets in nested model metadata", () => {
    const oldKey = 'old"credential', oldToken = "old-git-token", nextKey = "new-api-secret", nextToken = "new-git-secret";
    patch({ api_key: oldKey, github_token: oldToken });
    const before = readFileSync(file, "utf8");
    for (const secret of [oldKey, oldToken, nextKey, nextToken]) {
      for (const fields of [{ id: `model-${secret}` }, { label: `name ${secret}` }, { provider: secret }, { tags: ["other", secret] }]) {
        expect(() => patch({ api_key: nextKey, github_token: nextToken, models: [{ ...item, ...fields }] })).toThrow(expect.objectContaining({
          status: 400, message: expect.not.stringContaining(secret),
        }));
      }
    }
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("enforces the 64 KiB limit on UTF-8 serialized bytes for both reads and writes", () => {
    const models = (count: number) => Array.from({ length: count }, (_, i) => ({ ...item, id: `m-${i}`, label: "名".repeat(120),
      provider: "商".repeat(60), tags: Array(8).fill("签".repeat(40)) }));
    expect(patch({ models: models(20) }).models).toHaveLength(20);
    expect(statSync(file).size).toBeGreaterThan(16 * 1024);
    expect(readProjectCliSettings(db, id).models).toHaveLength(20);
    const before = readFileSync(file, "utf8");
    expect(() => patch({ models: models(50) })).toThrow(/64 KiB/);
    expect(readFileSync(file, "utf8")).toBe(before);
    writeFileSync(file, before + " ".repeat(65537 - Buffer.byteLength(before)));
    expect(() => readProjectCliSettings(db, id)).toThrow(expect.objectContaining({ status: 500 }));
  });

  it("rejects unsafe permissions and symlinks", () => {
    patch({ api_key: "value" });
    for (const path of [root, project, file]) {
      const original = statSync(path).mode & 0o777;
      chmodSync(path, original | 0o040);
      expect(() => readProjectCliSettings(db, id)).toThrow(/无效/);
      chmodSync(path, original);
    }
    const other = join(dir, "outside");
    writeFileSync(other, "untouched", { mode: 0o600 });
    unlinkSync(file);
    symlinkSync(other, file);
    expect(() => patch({ api_key: "new" })).toThrow(/无效/);
    rmSync(project, { recursive: true });
    symlinkSync(dir, project);
    expect(() => patch({ api_key: "new" })).toThrow(/无效/);
    expect(readFileSync(other, "utf8")).toBe("untouched");
  });
});
