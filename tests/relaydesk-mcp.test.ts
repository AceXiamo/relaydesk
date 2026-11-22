import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBridgeDaemon } from "../agent/bridge/index.ts";
import { ProjectChatStreams } from "../app/lib/chat-streams.ts";
import type { ChatSessionRecord, ChatStreamEvent } from "../app/lib/types.ts";
import {
  startRelaydeskMcpServer,
  validateMongoReadOnlyOp,
  validateReadOnlySql,
  validateRedisReadOnlyCommand,
} from "../server/relaydesk-mcp.ts";
import { bearer, fixture, operator, type Fixture } from "./bridge-fixture.ts";

describe("read-only database query validators", () => {
  it("allows safe read-only SQL and blocks write, multi-statement, and admin queries", () => {
    expect(validateReadOnlySql("SELECT id, name FROM users WHERE note = 'DROP TABLE; --'", "postgres")).toEqual({
      ok: true,
      sql: "SELECT id, name FROM users WHERE note = 'DROP TABLE; --'",
    });
    expect(validateReadOnlySql("/* inspect */ WITH recent AS (SELECT * FROM orders LIMIT 5) SELECT * FROM recent;", "postgres").ok).toBe(true);
    expect(validateReadOnlySql("SHOW TABLES", "mysql").ok).toBe(true);
    expect(validateReadOnlySql("PRAGMA table_info(users)", "sqlite").ok).toBe(true);

    const blocked: Array<[string, "sqlite" | "postgres" | "mysql"]> = [
      ["SELECT 1; DROP TABLE users", "postgres"],
      ["DELETE FROM users WHERE id = 1", "postgres"],
      ["UPDATE users SET role = 'admin'", "mysql"],
      ["WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d", "postgres"],
      ["SELECT * FROM users INTO OUTFILE '/tmp/pwn.csv'", "mysql"],
      ["SELECT pg_read_file('/etc/passwd')", "postgres"],
      ["SET default_transaction_read_only = off", "postgres"],
      ["PRAGMA writable_schema = ON", "sqlite"],
      ["COPY users TO PROGRAM 'id'", "postgres"],
    ];
    for (const [sql, kind] of blocked) {
      expect(validateReadOnlySql(sql, kind).ok, `expected blocked: ${sql}`).toBe(false);
    }
  });

  it("enforces Redis read-only command allowlist and MongoDB safe operations", () => {
    expect(validateRedisReadOnlyCommand(["GET", "session:1"]).ok).toBe(true);
    expect(validateRedisReadOnlyCommand(["hgetall", "user:42"]).ok).toBe(true);
    expect(validateRedisReadOnlyCommand(["SET", "k", "v"]).ok).toBe(false);
    expect(validateRedisReadOnlyCommand(["DEL", "k"]).ok).toBe(false);
    expect(validateRedisReadOnlyCommand(["FLUSHALL"]).ok).toBe(false);
    expect(validateRedisReadOnlyCommand(["EVAL", "return 1", "0"]).ok).toBe(false);

    expect(validateMongoReadOnlyOp({ operation: "find", collection: "orders", filter: { status: "open" }, limit: 10 }).ok).toBe(true);
    expect(validateMongoReadOnlyOp({ operation: "aggregate", collection: "orders", pipeline: [{ $match: { ok: true } }, { $out: "evil" }] }).ok).toBe(false);
    expect(validateMongoReadOnlyOp({ operation: "find", collection: "orders", filter: { $where: "this.x == 1" } }).ok).toBe(false);
  });
});

describe("Relaydesk Streamable HTTP MCP server", () => {
  let f: Fixture;
  let daemon: Awaited<ReturnType<typeof startBridgeDaemon>> | undefined;

  beforeEach(async () => {
    f = await fixture();
    vi.stubEnv("HOME", join(f.root, "home"));
    vi.stubEnv("CODEX_HOME", undefined);
  });

  afterEach(async () => {
    try {
      await daemon?.close();
    } finally {
      daemon = undefined;
      vi.unstubAllEnvs();
      await f.close();
    }
  });

  async function mcpRpc(url: string, token: string, body: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: res.status === 202 ? null : await res.json() };
  }

  it("authenticates requests, queries SQLite & mock Postgres in strict read-only mode, and redacts secrets", async () => {
    const spaceDir = join(f.root, "space");
    mkdirSync(join(spaceDir, "files"), { recursive: true });
    const sqliteFile = join(spaceDir, "files", "orders.sqlite");
    const db = new DatabaseSync(sqliteFile);
    try {
      db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, code TEXT); INSERT INTO orders VALUES (1, 'ORD-100');");
    } finally {
      db.close();
    }

    const fakePsql = join(f.root, "fake-psql.mjs");
    const psqlSecret = "super-secret-prod-pass-999";
    writeFileSync(
      fakePsql,
      `#!/usr/bin/env node
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const sql = Buffer.concat(chunks).toString('utf8').trim();
const argvHasSecret = process.argv.join(' ').includes(${JSON.stringify(psqlSecret)});
console.log('col_pgoptions,col_argv_leak,col_sql,col_secret');
console.log(JSON.stringify(process.env.PGOPTIONS || '') + ',' + argvHasSecret + ',' + JSON.stringify(sql) + ',' + JSON.stringify(process.env.PGPASSWORD || ''));
`,
      { mode: 0o755 },
    );

    const mcp = await startRelaydeskMcpServer({
      projectId: "proj-1",
      spaceDir,
      databases: [
        { id: "file:orders.sqlite", name: "orders.sqlite", kind: "sqlite", source: "workspace_file", file_path: "orders.sqlite", read_only: true },
        { id: "ext-pg", name: "生产库", kind: "postgres", source: "external", env_var: "RELAYDESK_DB_PROD", host_preview: "db.prod:5432/app", read_only: true },
      ],
      datasourceEnv: { RELAYDESK_DB_PROD: `postgres://readonly:${psqlSecret}@db.prod:5432/app?sslmode=require` },
      allowDatasourceSecrets: true,
      secrets: [psqlSecret],
      dbBinaries: { psql: fakePsql },
    });

    try {
      // Reject unauthenticated access
      const unauth = await fetch(mcp.url, { method: "POST", body: "{}" });
      expect(unauth.status).toBe(401);

      // Initialize & notification
      const init = await mcpRpc(mcp.url, mcp.token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      });
      expect(init.status).toBe(200);
      expect(init.json.result.serverInfo.name).toBe("relaydesk");

      const notif = await mcpRpc(mcp.url, mcp.token, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(notif.status).toBe(202);

      // SQLite describe + query
      const desc = await mcpRpc(mcp.url, mcp.token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "describe_datasource", arguments: { datasource: "orders.sqlite" } },
      });
      expect(desc.json.result.isError).toBe(false);
      expect(desc.json.result.content[0].text).toContain("orders");

      const sqliteRes = await mcpRpc(mcp.url, mcp.token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "query_datasource", arguments: { datasource: "orders.sqlite", query: "SELECT * FROM orders" } },
      });
      expect(sqliteRes.json.result.isError).toBe(false);
      expect(sqliteRes.json.result.content[0].text).toContain("ORD-100");

      // External Postgres query: enforces PGOPTIONS read-only, never leaks password on argv, redacts output
      const pgRes = await mcpRpc(mcp.url, mcp.token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "query_datasource", arguments: { datasource: "生产库", query: "SELECT 1 AS ok" } },
      });
      expect(pgRes.json.result.isError).toBe(false);
      const pgText = pgRes.json.result.content[0].text;
      expect(pgText).toContain("default_transaction_read_only=on");
      expect(pgText).toContain('"col_argv_leak": "false"');
      expect(pgText).not.toContain(psqlSecret);
      expect(pgText).toContain("[redacted]");

      // Blocked write SQL returns isError: true
      const writeRes = await mcpRpc(mcp.url, mcp.token, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "query_datasource", arguments: { datasource: "生产库", query: "DELETE FROM orders" } },
      });
      expect(writeRes.json.result.isError).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it("blocks external datasource queries when allowDatasourceSecrets is false", async () => {
    const spaceDir = join(f.root, "space-locked");
    mkdirSync(join(spaceDir, "files"), { recursive: true });
    const mcp = await startRelaydeskMcpServer({
      projectId: "proj-1",
      spaceDir,
      databases: [
        { id: "ext-pg", name: "生产库", kind: "postgres", source: "external", env_var: "RELAYDESK_DB_PROD", read_only: true },
      ],
      datasourceEnv: {},
      allowDatasourceSecrets: false,
    });
    try {
      const res = await mcpRpc(mcp.url, mcp.token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "query_datasource", arguments: { datasource: "生产库", query: "SELECT 1" } },
      });
      expect(res.json.result.isError).toBe(true);
      expect(res.json.result.content[0].text).toContain("允许数据源凭证");
    } finally {
      await mcp.close();
    }
  });

  it("executes task operations and read-only DB queries end-to-end through Local Bridge MCP in read-only mode", async () => {
    const p = await f.project();
    const otherProj = await f.project();
    const { id, token } = await f.register();

    // Seed a task with a comment and linked feedback
    const createdTask = (await f.ok(`/projects/${p}/tasks`, "POST", {
      title: "结算页面金额偶发多算",
      body: "有用户反馈 4 月账单汇总偏高",
      priority: "high",
      skip_prescreen: true,
    })).task;
    await f.ok(`/tasks/${createdTask.id}/messages`, "POST", {
      body: "补充线索：订单号 ORD-777 出现重复明细",
      reopen: false,
    });

    // Seed a SQLite file in project space
    const dbPath = join(f.root, "prod-snap.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE billing (order_no TEXT, amount INT); INSERT INTO billing VALUES ('ORD-777', 4200);");
    } finally {
      db.close();
    }
    const uploadRes = await fetch(`${f.srv.url}/api/projects/${p}/workspace/upload?path=billing.sqlite`, {
      method: "POST",
      headers: bearer(operator),
      body: new Uint8Array(readFileSync(dbPath)),
    });
    expect(uploadRes.ok).toBe(true);

    // Fake CLI that connects to the injected Relaydesk MCP server over HTTP (works for both Codex & Claude!)
    const fakeMcpCli = join(f.root, "fake-mcp-cli.mjs");
    writeFileSync(
      fakeMcpCli,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) { console.log('claude 2.1.330'); process.exit(0); }
if (args.includes('--help')) { console.log('--effort'); process.exit(0); }
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString('utf8');
const isClaude = args.includes('stream-json');
let mcpUrl = '';
let mcpToken = '';
let claudeConfigPath = '';
if (isClaude) {
  const idx = args.indexOf('--mcp-config');
  claudeConfigPath = idx !== -1 ? args[idx + 1] : '';
  const cfg = JSON.parse(readFileSync(claudeConfigPath, 'utf8'));
  mcpUrl = cfg.mcpServers.relaydesk.url;
  mcpToken = cfg.mcpServers.relaydesk.headers.Authorization.replace(/^Bearer\\s+/, '');
} else {
  const urlArg = args.find(a => a.startsWith('mcp_servers.relaydesk.url='));
  mcpUrl = JSON.parse(urlArg.split('=').slice(1).join('='));
  mcpToken = process.env.RELAYDESK_MCP_TOKEN || '';
}
async function callTool(id, name, toolArgs) {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mcpToken },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: toolArgs } }),
  });
  return await res.json();
}
const getRes = await callTool(1, 'get_task', { task: 'RD-1' });
const dbRes = await callTool(2, 'query_datasource', { datasource: 'billing.sqlite', query: "SELECT amount FROM billing WHERE order_no = 'ORD-777'" });
const commentRes = await callTool(3, 'comment_task', { task: 'RD-1', body: '已定位：ORD-777 金额为 4200' });
const transRes = await callTool(4, 'transition_task', { task: 'RD-1', status: 'review', delivery_ref: 'investigation/ord-777' });
const createRes = await callTool(5, 'create_task', { title: '清理重复账单记录', priority: 'normal', status: 'ready' });
writeFileSync('mcp-facts.json', JSON.stringify({
  isClaude,
  claudeConfigPath,
  toolsFlag: isClaude ? args[args.indexOf('--tools') + 1] : null,
  allowedToolsFlag: isClaude ? args[args.indexOf('--allowedTools') + 1] : null,
  promptHasThread: prompt.includes('ORD-777 出现重复明细'),
  promptHasTaskId: prompt.includes(${JSON.stringify(createdTask.id)}),
  getOk: !getRes.result.isError,
  dbText: dbRes.result.content[0].text,
  commentOk: !commentRes.result.isError,
  transOk: !transRes.result.isError,
  createOk: !createRes.result.isError,
}));
if (isClaude) {
  console.log(JSON.stringify({ type: 'system', session_id: 'claude-mcp-sess' }));
  console.log(JSON.stringify({ type: 'result', result: '已通过 MCP 完成排查并回复工单 RD-1' }));
} else {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-mcp-sess' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '已通过 MCP 完成排查并回复工单 RD-1' } }));
}
`,
      { mode: 0o755 },
    );

    const homeDir = join(f.root, "home");
    const cacheDir = join(f.root, "cache");
    const allowed = join(f.root, "allowed");
    const repo = join(allowed, "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const configPath = join(f.root, "bridge.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        server_url: f.wsUrl,
        agent_token: token,
        allowed_roots: [allowed],
        max_concurrency: 2,
        projects: { [p]: { workdir: repo } },
        runtimes: { codex: { bin: fakeMcpCli }, claude: { bin: fakeMcpCli } },
      }),
      { mode: 0o600 },
    );

    daemon = await startBridgeDaemon({ configPath, cacheDir, homeDir, reconnectMinMs: 30, reconnectMaxMs: 100 });
    await expect
      .poll(async () => (await f.ok("/bridge/agents")).agents.find((a: { id: string }) => a.id === id)?.runtimes?.claude?.available, {
        timeout: 5000,
      })
      .toBe(true);

    // Run in Claude READ-ONLY mode (Bash disabled, MCP enabled!) with @RD-1 attached
    const s = await f.session(p, id, "read-only");
    await f.ok(s.path, "PATCH", { runtime: "claude" });
    const sse = await (
      await s.turn("帮我排查 RD-1 并回复工单", [
        { kind: "task", label: "RD-1 · 结算页面金额偶发多算", ref: createdTask.id },
      ])
    ).text();

    expect(sse).toContain("event: task_updated");
    expect(sse).toContain("event: done");

    const observed = JSON.parse(readFileSync(join(repo, "mcp-facts.json"), "utf8"));
    expect(observed).toMatchObject({
      isClaude: true,
      toolsFlag: "Read,Grep,Glob",
      allowedToolsFlag: "Read,Grep,Glob,mcp__relaydesk__*",
      promptHasThread: true,
      promptHasTaskId: true,
      getOk: true,
      commentOk: true,
      transOk: true,
      createOk: true,
    });
    expect(observed.dbText).toContain("4200");
    // Temp Claude MCP config file must be cleaned up after the run
    expect(existsSync(observed.claudeConfigPath)).toBe(false);

    // Verify mutations landed in Store under project p only (never otherProj)
    const detail = await f.ok(`/tasks/${createdTask.id}`);
    expect(detail.task.status).toBe("review");
    expect(detail.task.delivery_ref).toBe("investigation/ord-777");
    expect(detail.messages.some((m: { author: string; body: string }) => m.author === "agent" && m.body.includes("ORD-777 金额为 4200"))).toBe(true);

    const pTasks = (await f.ok(`/projects/${p}/tasks`)).tasks;
    expect(pTasks.some((t: { title: string; status: string }) => t.title === "清理重复账单记录" && t.status === "ready")).toBe(true);
    const otherTasks = (await f.ok(`/projects/${otherProj}/tasks`)).tasks;
    expect(otherTasks).toHaveLength(0);

    // Also verify Codex read-only mode receives MCP URL + RELAYDESK_MCP_TOKEN and executes tools over Bridge
    const codexSession = await f.session(p, id, "read-only");
    const codexSse = await (await codexSession.turn("用 Codex 只读再查一次 RD-1")).text();
    expect(codexSse).toContain("event: task_updated");
    expect(codexSse).toContain("event: done");
    const codexFacts = JSON.parse(readFileSync(join(repo, "mcp-facts.json"), "utf8"));
    expect(codexFacts).toMatchObject({
      isClaude: false,
      getOk: true,
      commentOk: true,
    });
    expect(codexFacts.dbText).toContain("4200");
  });
});

describe("ProjectChatStreams task_updated callback", () => {
  it("notifies registered handler when task_updated arrives mid-stream", async () => {
    const session: ChatSessionRecord = {
      id: "s1",
      project_id: "p1",
      title: "Test",
      runtime: "claude",
      model: "",
      sandbox_mode: "read-only",
      network_access: false,
      execution_target: "auto",
      resolved_target: "local:a1",
      reasoning_effort: "default",
      external_session_id: "",
      status: "idle",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const mutated: Array<{ task_id?: string; action: string }> = [];
    const streams = new ProjectChatStreams({
      async getCodexChatSession() { return { session, messages: [] }; },
      async streamCodexChatMessage(_pid, _sid, _payload, onEvent) {
        const events: ChatStreamEvent[] = [
          { type: "task_updated", task_id: "t-123", action: "comment_task" },
          { type: "text_delta", delta: "done" },
          {
            type: "done",
            session,
            message: {
              id: "m1",
              session_id: "s1",
              role: "assistant",
              content: "done",
              events: [],
              attachments: [],
              status: "done",
              created_at: new Date().toISOString(),
            },
          },
        ];
        for (const ev of events) onEvent(ev);
      },
      async abortCodexChatSession() {
        return { aborted: true };
      },
    });
    streams.setTaskUpdatedHandler((ev) => mutated.push(ev));
    await streams.send(session, "check RD-1", []);
    expect(mutated).toEqual([{ task_id: "t-123", action: "comment_task" }]);
  });
});
