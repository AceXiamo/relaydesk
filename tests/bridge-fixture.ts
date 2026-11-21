import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type ClientOptions } from "ws";
import { expect } from "vitest";
import { startRelaydeskServer, type RelaydeskServerOptions } from "../server.ts";

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const operator = "test-only-operator";
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export type Frame = { type: string; id?: string; payload: Record<string, any> };

export async function fixture(options: RelaydeskServerOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "relaydesk-bridge-test-"));
  const dbPath = join(root, "db.sqlite");
  const srv = await startRelaydeskServer({ host: "127.0.0.1", port: 0, dbPath, apiOnly: true, adminToken: operator, ...options });
  const wsUrl = `${srv.url.replace(/^http/, "ws")}/api/bridge/ws`;
  const sockets = new Set<WebSocket>();
  const api = (path: string, method = "GET", body?: unknown, token = operator) => fetch(`${srv.url}/api${path}`, {
    method, headers: { ...bearer(token), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ok = async (path: string, method?: string, body?: unknown) => {
    const res = await api(path, method, body);
    const json = await res.json();
    expect(res.ok, `${method ?? "GET"} ${path}: ${res.status} ${json.error ?? ""}`).toBe(true);
    return json;
  };
  const register = async (name = "Test bridge") => {
    const { agent, token, quickstart_config, start_command } = await ok("/bridge/agents", "POST", { name });
    expect(start_command).toEqual(expect.stringContaining("bridge"));
    expect(start_command).not.toContain(token);
    expect(agent.id).toEqual(expect.any(String));
    expect(token).toMatch(/^rdbr_/);
    return { id: agent.id as string, token: token as string, quickstart_config };
  };
  const project = async (name = "Bridge project"): Promise<string> => (await ok("/projects", "POST", { name, repo: "example/bridge" })).project.id;
  const connect = async (token: string, options: ClientOptions = {}) => {
    const ws = new WebSocket(wsUrl, { headers: bearer(token), ...options });
    sockets.add(ws);
    ws.once("close", () => sockets.delete(ws));
    const frames: Frame[] = [];
    ws.on("message", (bytes) => frames.push(JSON.parse(bytes.toString())));
    const next = async (type: string, id?: string) => {
      const match = () => frames.findIndex(f => f.type === type && (id === undefined || f.id === id));
      await expect.poll(match, { timeout: 4000, interval: 10, message: `Expected frame ${type}` }).toBeGreaterThanOrEqual(0);
      return frames.splice(match(), 1)[0];
    };
    const send = (type: string, payload: Frame["payload"], id = randomUUID() as string) => {
      ws.send(JSON.stringify({ type, id, ts: new Date().toISOString(), payload }));
      return id;
    };
    await once(ws, "open");
    return { ws, send, next, hello: async (projects: Frame["payload"][] = [], extra: Frame["payload"] = {}) => {
      send("hello", { hostname: "test-node", platform: process.platform, bridge_version: "1.0.0", max_concurrency: 1,
        accept_cli_runs: false, runtimes: { codex: { available: true, version: "codex-test" } }, models: [], projects,
        db_clients: [], allowed_roots_enabled: false, ...extra });
      return next("hello.ack");
    } };
  };
  const session = async (p: string, id: string, sandbox_mode = "read-only") => {
    const base = `/projects/${p}/codex-chat/sessions`;
    const { session: created } = await ok(base, "POST", { runtime: "codex", title: "Test turn", execution_target: `local:${id}`, sandbox_mode });
    const path = `${base}/${created.id}`;
    return { id: created.id as string, path,
      detail: () => ok(path),
      turn: async (content: string, attachments: unknown[] = []) => {
        const res = await api(`${path}/messages`, "POST", { content, attachments });
        if (!res.ok) throw new Error(`Start turn ${res.status}: ${await res.text()}`);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        return res;
      },
    };
  };
  const close = async () => {
    for (const ws of sockets) ws.terminate();
    try { await srv.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  };
  return { root, dbPath, srv, wsUrl, api, ok, register, project, connect, session, close };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
