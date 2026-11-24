import { once } from "node:events";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getProjectFilesDir } from "../server/workspace.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { bearer, fixture, operator, sha256, type Fixture } from "./bridge-fixture.ts";

let f: Fixture;
beforeEach(async () => { f = await fixture(); });
afterEach(async () => { await f.close(); });

async function unauthorized(url: string, token?: string) {
  const socket = new WebSocket(url, { headers: token ? bearer(token) : {}, handshakeTimeout: 2000 });
  try { await expect(once(socket, "open")).rejects.toThrow(/401/); } finally { socket.terminate(); }
}
const bindings = (project_id: string) => [{ project_id, workdir: "/test/workdir", path_ok: true, path_error: "" }];

describe("BridgeHub registration and connection lifecycle", () => {
  it("exposes only live, sanitized node accounts to the operator without project bindings", async () => {
    const first = await f.register("Office");
    const second = await f.register("Laptop");
    expect((await f.api("/sidebar-accounts", "GET", undefined, first.token)).status).toBe(401);
    const a = await f.connect(first.token);
    const b = await f.connect(second.token);
    await Promise.all([a.hello(), b.hello()]);
    const row = { id: "shared", name: "User", plan: "Pro", status: "ready", avatarUrl: "javascript:bad",
      nodeName: "spoof", service: "spoof", accessToken: "secret", windows: [
        { label: "5h", remainingPercent: 80, resetsAt: null, extra: "secret" },
      ] };
    for (const device of [a, b]) device.send("sidebar.account", { provider: "codex", account: row });
    const accounts = async () => (await f.ok("/sidebar-accounts")).accounts;
    const expected = { name: "User", service: "Codex", plan: "Pro", status: "ready", avatarUrl: null,
      windows: [{ label: "5h", remainingPercent: 80, resetsAt: null }] };
    await expect.poll(accounts).toEqual([
      { ...expected, id: `${first.id}:codex:shared`, nodeName: "Office" },
      { ...expected, id: `${second.id}:codex:shared`, nodeName: "Laptop" },
    ]);
    a.send("sidebar.account", { provider: "codex", account: { ...row, windows: Array(100).fill(row.windows[0]) } });
    await expect.poll(accounts).toHaveLength(1);
    const replacement = await f.connect(second.token);
    await replacement.hello();
    expect(await accounts()).toEqual([]);
    const avatarUrl = "data:image/png;base64,iVBORw0KGgo=";
    replacement.send("sidebar.account", { provider: "gemini", account: { ...row, avatarUrl, identity: "user@example.org" } });
    await expect.poll(accounts).toEqual([expect.objectContaining({ avatarUrl, identity: "user@example.org", service: "Gemini" })]);
    replacement.ws.terminate();
    await expect.poll(accounts).toEqual([]);
  });

  it("keeps operator and agent authentication separate and stores only the device token digest", async () => {
    const { id, token, quickstart_config } = await f.register();
    expect(quickstart_config).toMatchObject({ server_url: f.wsUrl, agent_token: token });
    const list = await f.ok("/bridge/agents");
    expect(list.agents).toContainEqual(expect.objectContaining({ id, online: false }));
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(list)).not.toContain(sha256(token));
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT * FROM bridge_agents WHERE id = ?").get(id);
      expect(row?.token_hash).toBe(sha256(token));
      expect(JSON.stringify(row)).not.toContain(token);
    } finally { db.close(); }
    expect((await f.api("/bridge/agents", "GET", undefined, token)).status).toBe(401);
    await unauthorized(f.wsUrl);
    await unauthorized(f.wsUrl, operator);
    await unauthorized(`${f.wsUrl}?token=${encodeURIComponent(token)}`);
    await unauthorized(`${f.wsUrl}?token=${encodeURIComponent(token)}`, token);
    const changed = await f.ok(`/bridge/agents/${id}`, "PATCH", { name: "Renamed fixture" });
    expect(changed.agent).toMatchObject({ id, name: "Renamed fixture" });
    expect(JSON.stringify(changed)).not.toContain(token);
    const device = await f.connect(token);
    expect((await device.hello()).payload).toMatchObject({ agent_id: id });
  });

  it("replaces an existing connection, then revokes active sockets on rotation and deletion", async () => {
    const { id, token } = await f.register();
    const original = await f.connect(token);
    await original.hello();
    const firstClosed = once(original.ws, "close");
    const replacement = await f.connect(token);
    expect((await firstClosed)[0]).toBe(4001);
    expect((await replacement.hello()).payload.agent_id).toBe(id);
    expect(await f.ok(`/bridge/agents/${id}/refresh`, "POST", {})).toEqual({ ok: true });
    await replacement.next("catalog.refresh");
    const replacedClosed = once(replacement.ws, "close");
    const rotated = await f.ok(`/bridge/agents/${id}/rotate-token`, "POST", {});
    expect(rotated.token).toMatch(/^rdbr_/);
    expect(rotated.token).not.toBe(token);
    expect(rotated.agent.id).toBe(id);
    expect(rotated.quickstart_config.agent_token).toBe(rotated.token);
    await replacedClosed;
    await unauthorized(f.wsUrl, token);
    const fresh = await f.connect(rotated.token);
    await fresh.hello();
    const freshClosed = once(fresh.ws, "close");
    expect(await f.ok(`/bridge/agents/${id}`, "DELETE")).toEqual({ ok: true });
    await freshClosed;
    await unauthorized(f.wsUrl, rotated.token);
    expect((await f.ok("/bridge/agents")).agents).toEqual([]);
  });

  it("marks silent clients offline, closes their SSE, and keeps a responding peer online", async () => {
    await f.close();
    f = await fixture({ bridgeHubOptions: { pingIntervalMs: 75, pongTimeoutMs: 1500 } });
    const responsive = await f.register("Responding");
    const silent = await f.register("Silent");
    const p = await f.project();
    const good = await f.connect(responsive.token);
    await good.hello(bindings(p));
    const timeout = await f.connect(silent.token, { autoPong: false });
    const ping = once(timeout.ws, "ping");
    const closed = once(timeout.ws, "close");
    await timeout.hello(bindings(p));
    const s = await f.session(p, silent.id);
    const response = await s.turn("Wait for missed heartbeat");
    await timeout.next("chat.start");
    await ping;
    await closed;
    expect(await response.text()).toContain("event: error");
    expect((await s.detail()).messages.at(-1).status).toBe("error");
    expect((await f.ok("/bridge/agents")).agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: silent.id, online: false }), expect.objectContaining({ id: responsive.id, online: true }),
    ]));
  });

  it("updates the catalog without allowing device reports to overwrite operator-owned permissions", async () => {
    const { id, token } = await f.register();
    const p = await f.project();
    const conn = await f.connect(token);
    const projectReports = [...bindings(p), ...bindings("unknown-project")];
    await conn.hello(projectReports);
    const route = `/projects/${p}/agent-bindings/${id}`;
    expect((await f.ok(route, "PATCH", { enabled: false, allow_datasource_secrets: true })).binding)
      .toMatchObject({ enabled: false, allow_datasource_secrets: true });
    conn.send("catalog.sync", { runtimes: { codex: { available: true, version: "v2" } },
      models: [{ id: "test-model", runtime: "codex", context_window: 424242, effort_levels: ["low", "high"] }],
      projects: projectReports.map(x => ({ ...x, enabled: true, allow_datasource_secrets: false })) });
    await expect.poll(async () => (await f.ok("/bridge/agents")).agents[0].models).toContainEqual(expect.objectContaining({
      id: "test-model", context_window: 424242, effort_levels: ["low", "high"],
    }));
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT project_id, enabled, allow_datasource_secrets FROM project_agent_bindings WHERE agent_id = ?").all(id))
        .toEqual([{ project_id: p, enabled: 0, allow_datasource_secrets: 1 }]);
    } finally { db.close(); }
    const binding = async () => (await f.ok("/bridge/agents")).agents[0].bindings[0];
    conn.send("catalog.sync", { projects: [{ ...bindings(p)[0], workdir: "/test/new" }] });
    await expect.poll(binding).toMatchObject({ workdir: "/test/new", allow_datasource_secrets: false, enabled: false });
    await f.ok(route, "PATCH", { allow_datasource_secrets: true });
    conn.send("catalog.sync", { projects: [] });
    await expect.poll(binding).toMatchObject({ path_ok: false, allow_datasource_secrets: false, enabled: false });
  });

  it.each(["process", "binding", "cancel"])("does not transfer a detached write lease after a change to %s", async change => {
    const { id, token } = await f.register();
    const p = await f.project(), original = await f.connect(token);
    const instance = crypto.randomUUID();
    await original.hello(bindings(p), { chat_instance: instance });
    const session = await f.session(p, id, "workspace-write");
    const stream = (await session.turn("work")).text();
    const { payload: { run_id } } = await original.next("chat.start");
    original.ws.terminate();
    await expect.poll(async () => (await f.ok("/bridge/agents")).agents[0].online).toBe(false);
    expect(f.srv.bridgeHub.hasActiveWriteLease(id, p)).toBe(false);
    if (change === "cancel") expect(f.srv.bridgeHub.abortChatSessionRun(session.id)).toBe(true);
    const next = await f.connect(token);
    const reports = change === "binding" ? [{ ...bindings(p)[0], workdir: "/elsewhere" }] : bindings(p);
    const ack = await next.hello(reports, { chat_instance: change === "process" ? crypto.randomUUID() : instance, resume_runs: [run_id] });
    expect(ack.payload.resumed_runs).toEqual([]);
    expect(f.srv.bridgeHub.hasActiveWriteLease(id, p)).toBe(false);
    await stream;
    expect((await session.detail()).messages.at(-1).status).toBe(change === "cancel" ? "aborted" : "error");
  });

  it("streams the latest context sample, persists it on reload, and clears it on model changes", async () => {
    const { id, token } = await f.register(), p = await f.project();
    const conn = await f.connect(token);
    expect((await conn.hello(bindings(p))).payload.context_usage).toBe(true);
    const s = await f.session(p, id);
    const response = (await s.turn("report context")).text();
    const ids = { run_id: (await conn.next("chat.start")).payload.run_id, session_id: s.id };
    conn.send("chat.event", { ...ids, event: { type: "context_usage", usage: { used_tokens: -1 } } });
    for (const used_tokens of [18000, 6000]) {
      conn.send("chat.event", { ...ids, event: { type: "context_usage", usage: { used_tokens, window_tokens: 24000 } } });
    }
    const barrier = conn.send("workspace.fetch", { project_id: p, path: "HANDBOOK.md" });
    await conn.next("workspace.fetch.result", barrier);
    const restored = await f.api(`${s.path}/stream`);
    conn.send("chat.event", { ...ids, event: { type: "done" }, result: { status: "done", content: "ok", events: [], externalSessionId: "thread" } });
    expect(await response).toContain('"used_tokens":6000');
    const snapshot = (await restored.text()).split("\n").find(line => line.startsWith("data:") && line.includes('"type":"snapshot"'))!;
    expect(JSON.parse(snapshot.slice(5)).session).toMatchObject({ context_used_tokens: 6000, context_window_tokens: 24000 });
    expect((await s.detail()).session).toMatchObject({ context_used_tokens: 6000, context_window_tokens: 24000 });
    await f.ok(s.path, "PATCH", { model: "another-model" });
    expect((await s.detail()).session.context_used_tokens).toBeNull();
  });

  it("deletes an active session without leaving the SSE response or lease open", async () => {
    const { id, token } = await f.register();
    const p = await f.project();
    const conn = await f.connect(token);
    await conn.hello(bindings(p));
    const session = await f.session(p, id, "workspace-write");
    const stream = await session.turn("Wait until deleted");
    const start = await conn.next("chat.start");
    await f.ok(session.path, "DELETE");
    expect((await conn.next("chat.abort")).payload.run_id).toBe(start.payload.run_id);
    expect(await stream.text()).toContain("event: error");
    expect((await f.api(session.path)).status).toBe(404);
    expect(f.srv.bridgeHub.hasActiveWriteLease(id, p)).toBe(false);
  });

  it("applies operator binding changes only after this device confirms the matching request", async () => {
    const { id, token } = await f.register();
    const p = await f.project();
    const conn = await f.connect(token);
    await conn.hello(bindings(p), { allowed_roots_enabled: true });
    const change = f.api(`/projects/${p}/agent-bindings/${id}`, "PATCH", { workdir: "/test/new", allow_datasource_secrets: true });
    const { id: requestId, payload } = await conn.next("project.bind");
    const result = { ...payload, path_ok: true, path_error: "" };
    conn.send("project.bind.result", result, "unrelated-request");
    conn.send("project.bind.result", { ...result, project_id: "wrong-project" }, requestId);
    // A subsequent RPC round-trip is a barrier: the hub has handled both preceding frames.
    const barrier = conn.send("workspace.fetch", { project_id: p, path: "HANDBOOK.md" });
    await conn.next("workspace.fetch.result", barrier);
    expect((await f.ok("/bridge/agents")).agents[0].bindings[0]).toMatchObject({ workdir: "/test/workdir", allow_datasource_secrets: false });
    conn.send("project.bind.result", result, requestId);
    const res = await change;
    expect(res.ok).toBe(true);
    expect((await res.json()).binding).toMatchObject({ workdir: "/test/new", allow_datasource_secrets: true });
  });
});

function fileUrl(p: string, path = "files/demo.txt") {
  return `${f.srv.url}/api/bridge/projects/${p}/workspace/file?path=${encodeURIComponent(path)}`;
}

describe("BridgeHub workspace access", () => {
  it("sends only safe workspace metadata until the operator grants datasource access", async () => {
    const { id, token } = await f.register();
    const p = await f.project();
    const marker = ["private", "fixture", "value"].join("-");
    const url = `postgresql://reader:${marker}@db.example.invalid/app`;
    await f.ok(`/projects/${p}/workspace/databases`, "POST", { mode: "external", kind: "postgres", name: "Fixture", connection_url: url });
    await f.ok(`/projects/${p}/workspace/file`, "POST", { path: "notes.txt", content: "manifest" });
    writeFileSync(join(getProjectFilesDir(f.dbPath, p), ".env"), "unshareable-attachment-value");
    const conn = await f.connect(token);
    await conn.hello(bindings(p));
    const s = await f.session(p, id);
    for (const granted of [false, true]) {
      if (granted) await f.ok(`/projects/${p}/agent-bindings/${id}`, "PATCH", { allow_datasource_secrets: true });
      const response = await s.turn("Read metadata", [{ kind: "file", ref: ".env", label: ".env" }]);
      const start = (await conn.next("chat.start")).payload;
      expect(JSON.stringify(start)).not.toContain("unshareable-attachment-value");
      expect(start.workspace_manifest.files).toContainEqual(expect.objectContaining({ path: "notes.txt", size: 8, sha256: sha256("manifest") }));
      expect(start.workspace_manifest.databases).toContainEqual(expect.objectContaining({ name: "Fixture", kind: "postgres" }));
      const { datasource_env, ...nonSecretFields } = start;
      expect(JSON.stringify(nonSecretFields)).not.toContain(marker);
      if (granted) expect(datasource_env).toMatchObject({ RELAYDESK_DB_FIXTURE: url });
      else expect(datasource_env).toBeUndefined();
      const ids = { run_id: start.run_id, session_id: s.id };
      conn.send("chat.event", { ...ids, event: { type: "text_delta", delta: granted ? url : "metadata only" } });
      conn.send("chat.event", { ...ids, event: { type: "done" }, result: {
        content: granted ? url : "metadata only", events: [], externalSessionId: "fixture-thread", status: "done",
      } });
      expect(await response.text()).not.toContain(marker);
      expect(JSON.stringify(await s.detail())).not.toContain(marker);
    }
  });

  it("grants only the writing device/project a lease, rejects unsafe paths, and revokes access at disconnect", async () => {
    const { id, token } = await f.register();
    const other = await f.register("Other agent");
    const p = await f.project(), q = await f.project("Unrelated");
    const conn = await f.connect(token);
    await conn.hello([...bindings(p), ...bindings(q)]);
    const peer = await f.connect(other.token);
    await peer.hello(bindings(p));
    const outside = join(f.root, "outside.txt");
    writeFileSync(outside, "original outside");
    symlinkSync(outside, join(getProjectFilesDir(f.dbPath, p, true), "symlink.txt"));
    const write = await f.session(p, id, "workspace-write");
    const response = await write.turn("Hold the write lease");
    const { run_id } = (await conn.next("chat.start")).payload;
    const busy = await f.session(p, id);
    expect((await f.api(`${busy.path}/messages`, "POST", { content: "Do not fall back to cloud" })).status).toBe(409);
    expect((await busy.detail()).messages).toEqual([]);
    expect((await f.ok("/bridge/agents")).agents.find((a: { id: string }) => a.id === id).active_runs).toBe(1);
    const put = (p: string, path: string, token: string) => fetch(fileUrl(p, path), {
      method: "PUT", headers: { ...bearer(token), "X-Relaydesk-Run-Id": run_id }, body: "new content",
    });
    expect((await put(p, "files/allowed.txt", token)).ok).toBe(true);
    expect(f.srv.bridgeHub.hasActiveWriteLease(id, p)).toBe(true);
    expect((await fetch(fileUrl(p, "files/implicit.txt"), { method: "PUT", headers: bearer(token), body: "bound write" })).ok).toBe(true);
    expect((await put(p, "HANDBOOK.md", token)).ok).toBe(true);
    const handbookPush = conn.send("workspace.push", { project_id: p, run_id, path: "HANDBOOK.md", data: Buffer.from("# Updated handbook").toString("base64") });
    expect((await conn.next("workspace.push.result", handbookPush)).payload).toMatchObject({ ok: true });
    const deployPush = conn.send("workspace.push", { project_id: p, run_id, path: "DEPLOY.md", data: Buffer.from("# Updated deploy doc").toString("base64") });
    expect((await conn.next("workspace.push.result", deployPush)).payload).toMatchObject({ ok: true });
    expect((await f.ok(`/projects/${p}/workspace/handbook`)).handbook.content).toBe("# Updated handbook");
    expect((await f.ok(`/projects/${p}/workspace/deploy-doc`)).deploy_doc.content).toBe("# Updated deploy doc");
    const oversizedDoc = Buffer.alloc(64 * 1024 + 1, "a");
    expect((await fetch(fileUrl(p, "HANDBOOK.md"), {
      method: "PUT", headers: { ...bearer(token), "X-Relaydesk-Run-Id": run_id }, body: oversizedDoc,
    })).status).toBe(413);
    expect((await put(p, "datasources.json", token)).status).toBe(403);
    expect((await put(q, "files/forbidden.txt", token)).status).toBe(403);
    expect((await put(p, "files/forbidden.txt", other.token)).status).toBe(403);
    for (const path of ["files/../outside.txt", "files/.env", "files/symlink.txt"]) {
      for (const res of [await fetch(fileUrl(p, path), { headers: bearer(token) }), await put(p, path, token)]) {
        expect([400, 403]).toContain(res.status);
      }
      const req = conn.send("workspace.push", { project_id: p, run_id, path, sha256: sha256("new content"), data: Buffer.from("new content").toString("base64") });
      expect((await conn.next("workspace.push.result", req)).payload.ok).toBe(false);
    }
    const badChecksum = conn.send("workspace.push", { project_id: p, run_id, path: "files/allowed.txt", data: "YQ==", sha256: sha256("b") });
    expect((await conn.next("workspace.push.result", badChecksum)).payload).toMatchObject({ ok: false, status: 400 });
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
    writeFileSync(join(getProjectFilesDir(f.dbPath, p), "large.bin"), oversized);
    const rpcTooLarge = conn.send("workspace.fetch", { project_id: p, path: "files/large.bin" });
    expect((await conn.next("workspace.fetch.result", rpcTooLarge)).payload).toMatchObject({ ok: false, status: 413 });
    expect(readFileSync(outside, "utf8")).toBe("original outside");
    conn.ws.terminate();
    expect(await response.text()).toContain("event: error");
    expect((await put(p, "files/allowed.txt", token)).status).toBe(403);
    const reconnected = await f.connect(token);
    await reconnected.hello(bindings(p));
    const read = await f.session(p, id, "read-only");
    const readResponse = await read.turn("Read without privilege");
    const readRun = (await reconnected.next("chat.start")).payload.run_id;
    const denied = reconnected.send("workspace.push", { project_id: p, run_id: readRun, path: "files/allowed.txt", data: Buffer.from("readonly").toString("base64"), sha256: sha256("readonly") });
    expect((await reconnected.next("workspace.push.result", denied)).payload).toMatchObject({ ok: false, status: 403 });
    const deniedHandbook = reconnected.send("workspace.push", { project_id: p, run_id: readRun, path: "HANDBOOK.md", data: Buffer.from("readonly").toString("base64"), sha256: sha256("readonly") });
    expect((await reconnected.next("workspace.push.result", deniedHandbook)).payload).toMatchObject({ ok: false, status: 403 });
    const deniedDeploy = reconnected.send("workspace.push", { project_id: p, run_id: readRun, path: "DEPLOY.md", data: Buffer.from("readonly").toString("base64"), sha256: sha256("readonly") });
    expect((await reconnected.next("workspace.push.result", deniedDeploy)).payload).toMatchObject({ ok: false, status: 403 });
    reconnected.ws.terminate();
    await readResponse.text();
    expect(readFileSync(join(getProjectFilesDir(f.dbPath, p), "allowed.txt"), "utf8")).toBe("new content");
  });

  it("scopes downloads to enabled bindings and denies writes without a live write lease on either transport", async () => {
    const { id, token } = await f.register();
    const other = await f.register("Other device");
    const p = await f.project();
    const q = await f.project("Other project");
    for (const project of [p, q]) await f.ok(`/projects/${project}/workspace/file`, "POST", { path: "demo.txt", content: "original" });
    const conn = await f.connect(token);
    await conn.hello(bindings(p));
    const read = (project: string, device = token) => fetch(fileUrl(project), { headers: bearer(device) });
    expect((await fetch(`${fileUrl(p)}&token=${token}`)).status).toBe(401);
    expect((await read(p, operator)).status).toBe(401);
    expect((await read(p, other.token)).status).toBe(403);
    expect((await read(q)).status).toBe(403);
    const download = await read(p);
    expect(download.headers.get("X-Content-Sha256")).toBe(sha256("original"));
    expect(await download.text()).toBe("original");
    const fetchId = conn.send("workspace.fetch", { project_id: p, path: "files/demo.txt" });
    expect((await conn.next("workspace.fetch.result", fetchId)).payload).toMatchObject({
      ok: true, data: Buffer.from("original").toString("base64"), sha256: sha256("original"),
    });
    const denied = conn.send("workspace.fetch", { project_id: q, path: "files/demo.txt" });
    expect((await conn.next("workspace.fetch.result", denied)).payload).toMatchObject({ ok: false, status: 403 });
    expect((await fetch(fileUrl(p), { method: "PUT", headers: bearer(token), body: "unleased" })).status).toBe(403);
    const push = conn.send("workspace.push", { project_id: p, path: "files/demo.txt", data: Buffer.from("unleased").toString("base64") });
    expect((await conn.next("workspace.push.result", push)).payload).toMatchObject({ ok: false, status: 403 });
    expect(await (await read(p)).text()).toBe("original");
    await f.ok(`/projects/${p}/agent-bindings/${id}`, "PATCH", { enabled: false });
    expect((await read(p)).status).toBe(403);
  });
});
