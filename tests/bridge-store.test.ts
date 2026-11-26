import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../server/store.ts";

describe("local bridge store", () => {
  let root: string;
  let path: string;
  let store: Store;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "relaydesk-bridge-store-"));
    path = join(root, "store.sqlite");
    store = new Store(path);
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  it("persists a digest and prefix, rotates immediately, and never returns the digest in a summary", () => {
    const first = store.createBridgeAgent(" Laptop ");
    expect(first.token).toMatch(/^rdbr_[a-f0-9]{48}$/);
    expect(first.agent).toMatchObject({ name: "Laptop", token_prefix: first.token.slice(0, 12), online: false,
      active_runs: 0, bindings: [], last_seen_at: null, max_concurrency: 0, accept_cli_runs: true });
    const hash = createHash("sha256").update(first.token).digest("hex");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT * FROM bridge_agents WHERE id = ?").get(first.agent.id);
      expect(row?.token_hash).toBe(hash);
      expect(JSON.stringify(row)).not.toContain(first.token);
    } finally { db.close(); }
    expect(store.findBridgeAgentByToken(first.token)).toEqual(first.agent);
    expect(store.findBridgeAgentByToken(first.token.slice(0, -1) + (first.token.endsWith("0") ? "1" : "0"))).toBeNull();
    expect(JSON.stringify(store.listBridgeAgents())).not.toContain(hash);
    const rotated = store.rotateBridgeAgentToken(first.agent.id);
    expect(rotated.agent.id).toBe(first.agent.id);
    expect(store.findBridgeAgentByToken(first.token)).toBeNull();
    store.close(); store = new Store(path);
    expect(store.findBridgeAgentByToken(rotated.token)).toEqual(rotated.agent);
    store.deleteBridgeAgent(first.agent.id);
    expect(store.findBridgeAgentByToken(rotated.token)).toBeNull();
    expect(store.getBridgeAgent(first.agent.id)).toBeNull();
    for (const op of [() => store.deleteBridgeAgent(first.agent.id), () => store.updateBridgeAgent(first.agent.id, {}),
      () => store.rotateBridgeAgentToken(first.agent.id)]) expect(op).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("accepts only operator-editable fields and merges partial telemetry without erasing the catalog", () => {
    const { agent } = store.createBridgeAgent("Workstation");
    expect(store.updateBridgeAgent(agent.id, { name: "Desk", accept_cli_runs: false, max_concurrency: 4 }))
      .toMatchObject({ name: "Desk", accept_cli_runs: false, max_concurrency: 4 });
    expect(store.updateBridgeAgent(agent.id, { max_concurrency: 0 })).toMatchObject({ max_concurrency: 0 });
    expect(store.updateBridgeAgent(agent.id, { max_concurrency: 4 })).toMatchObject({ max_concurrency: 4 });
    expect(() => store.updateBridgeAgent(agent.id, { max_concurrency: -1 })).toThrow();
    expect(() => store.updateBridgeAgent(agent.id, { hostname: "forged" } as never)).toThrow();
    store.updateBridgeAgentTelemetry(agent.id, { hostname: "workstation", bridge_version: "v1", runtimes: { codex: { available: true } },
      models: [{ runtime: "codex", id: "custom", context_window: 16000 }], capabilities: { allowed_roots_enabled: true } });
    store.updateBridgeAgentTelemetry(agent.id, {});
    expect(store.getBridgeAgent(agent.id)).toMatchObject({ name: "Desk", hostname: "workstation", max_concurrency: 4,
      last_seen_at: expect.any(String), online: false, models: [{ runtime: "codex", id: "custom", context_window: 16000 }] });
  });

  it("retains binding permissions on device updates and deletes bindings when a device is removed", () => {
    const { agent } = store.createBridgeAgent("Desk");
    const project = store.createProject({ name: "Docs", repo: "example/docs" });
    const upsert = (patch: Parameters<Store["upsertProjectAgentBinding"]>[2]) => store.upsertProjectAgentBinding(project.id, agent.id, patch);
    expect(store.getProjectAgentBinding(project.id, agent.id)).toBeNull();
    expect(upsert({ workdir: "/repo", path_ok: true })).toMatchObject({ project_name: "Docs", path_ok: true, allow_datasource_secrets: false, enabled: true });
    upsert({ enabled: false, allow_datasource_secrets: true });
    expect(upsert({ path_ok: false, path_error: "unavailable" })).toMatchObject({ workdir: "/repo", enabled: false, allow_datasource_secrets: true });
    expect(upsert({ workdir: "/next", allow_datasource_secrets: false })).toMatchObject({ path_ok: false, path_error: "", enabled: false, allow_datasource_secrets: false });
    const bindings = store.listProjectAgentBindings(project.id);
    expect(store.listAgentBindings(agent.id)).toEqual(bindings);
    expect(store.listBridgeAgents()[0].bindings).toEqual(bindings);
    store.deleteBridgeAgent(agent.id);
    expect(store.listProjectAgentBindings(project.id)).toEqual([]);
  });
});
