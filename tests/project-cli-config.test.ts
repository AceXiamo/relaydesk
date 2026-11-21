import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectCliConfiguration, readProjectCliSettings } from "../server/project-cli-config.ts";

const id = "a".repeat(32);
const publicDefaults = { runtime: "codex", endpoint: "", model: "", configured: false, github_configured: false, public_ai_enabled: false };
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
    expect(() => projectCliConfiguration(":memory:", id, { api_key: "key" })).toThrow(/persistent/);
    expect(() => projectCliConfiguration(db, "../project")).toThrow(/project ID/);
  });

  it("persists the exact private schema and exposes only public settings", () => {
    const fields = { runtime: "claude", endpoint: "https://proxy.example/api", model: "vendor/model:beta", public_ai_enabled: true };
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
      expect(() => patch(update)).toThrow(/Re-enter the API key/);
      expect(readFileSync(file, "utf8")).toBe(before);
    }
    expect(patch({ endpoint: "https://two.example", api_key: "old" }).configured).toBe(true);
    expect(patch({ endpoint: "https://three.example", api_key: "new" }).configured).toBe(true);
    expect(() => patch({ runtime: "claude" })).toThrow(/Re-enter the API key/);
    expect(patch({ runtime: "claude", api_key: "" })).toMatchObject({ configured: false, github_configured: true });
  });

  it("rejects unsafe endpoints and full API routes without echoing input", () => {
    for (const endpoint of ["http://api.example", "https://secret-value@api.example", "https://api.example?", "https://api.example/#",
      "https://localhost.", "https://a.localhost", "https://metadata.google.internal", "https://gateway.lan", "https://service",
      "https://127.1", "https://2130706433", "https://0x7f000001", "https://169.254.169.254", "https://10.1.2.3", "https://[::1]",
      "https://[fd00::1]", "https://[fe80::1]", "https://[::ffff:127.0.0.1]", "https://api.example/v1/responses",
      "https://api.example/v1/chat/completions", "https://api.example/v1/messages/count_tokens", "https://api.example/v1/%6dessages"]) {
      expect(() => patch({ endpoint })).toThrow(/^Provide a public HTTPS API base URL for this runtime$/);
    }
    expect(() => patch({ runtime: "claude", endpoint: "https://api.example/base/v1/" })).toThrow(/base URL/);
    expect(patch({ endpoint: "https://api.example:8443/base/v1/" }).endpoint).toBe("https://api.example:8443/base/v1");
  });

  it("rejects invalid patch fields without disclosing submitted secrets", () => {
    for (const invalid of [{}, { configured: true }, { project_id: id }, { runtime: "other" }, { public_ai_enabled: "false" },
      { api_key: 123 }, { github_token: "secret-value\n" }, { model: "--option" }, { endpoint: false }]) {
      expect(() => patch(invalid)).toThrow(expect.objectContaining({ status: 400, message: expect.not.stringContaining("secret-value") }));
    }
    expect(existsSync(root)).toBe(false);
  });

  it("rejects credentials copied into public fields and oversized serialized settings", () => {
    for (const update of [{ model: "contains-secret-value", api_key: "secret-value" },
      { endpoint: "https://api.example/secret-value", github_token: "secret-value" },
      { api_key: '"'.repeat(4096), github_token: '"'.repeat(4096) }]) {
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
      JSON.stringify({ ...saved, public_ai_enabled: undefined })]) {
      writeFileSync(file, contents);
      for (const read of [readProjectCliSettings, projectCliConfiguration]) {
        expect(() => read(db, id)).toThrow(expect.objectContaining({ status: 500, message: expect.not.stringContaining("secret-value") }));
      }
      expect(() => patch({ model: "valid" })).toThrow(/invalid/);
      expect(readFileSync(file, "utf8")).toBe(contents);
    }
  });

  it("rejects unsafe permissions and symlinks", () => {
    patch({ api_key: "value" });
    for (const path of [root, project, file]) {
      const original = statSync(path).mode & 0o777;
      chmodSync(path, original | 0o040);
      expect(() => readProjectCliSettings(db, id)).toThrow(/invalid/);
      chmodSync(path, original);
    }
    const other = join(dir, "outside");
    writeFileSync(other, "untouched", { mode: 0o600 });
    unlinkSync(file);
    symlinkSync(other, file);
    expect(() => patch({ api_key: "new" })).toThrow(/invalid/);
    rmSync(project, { recursive: true });
    symlinkSync(dir, project);
    expect(() => patch({ api_key: "new" })).toThrow(/invalid/);
    expect(readFileSync(other, "utf8")).toBe("untouched");
  });
});
