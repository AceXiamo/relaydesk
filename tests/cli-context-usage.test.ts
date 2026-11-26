import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRuntime, ChatStreamEvent } from "../app/lib/types.ts";
import { createCliStreamParser } from "../server/cli-stream-parser.ts";
import { codexRolloutMonitor, type CodexRolloutActivity } from "../server/cli-context-usage.ts";
import { runLocalChat } from "../agent/bridge/runner.ts";
import { runWebCliChatTurn } from "../server/codex-chat.ts";
import { Store, toAgentProject } from "../server/store.ts";

const temps: string[] = [];
function tmp() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "relaydesk-usage-")));
  temps.push(path);
  return path;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});
function capture(runtime: ChatRuntime, home?: string, resumeId = "") {
  const events: ChatStreamEvent[] = [];
  const parser = createCliStreamParser(runtime, [], e => events.push(e), undefined, undefined,
    home ? { env: { CODEX_HOME: home }, resumeId } : undefined);
  return { parser, events, line: (row: unknown) => parser.write(JSON.stringify(row) + "\n"),
    snapshots: () => events.flatMap(e => e.type === "context_usage" ? [e.usage] : []) };
}
const assistant = (id: string, model: string, usage: unknown) => ({ type: "assistant", message: { id, model, usage } });
const id = "c0dec000-0000-4000-8100-000000000001";
const other = "c0dec000-0000-4000-8100-000000000002";
const filename = (home: string, thread = id) => join(home, "sessions/2026/11/24", `rollout-2026-11-24T01-02-03-${thread}.jsonl`);
function index(home: string, path: string, thread = id) {
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    db.prepare("INSERT INTO threads VALUES (?,?)").run(thread, path);
  } finally { db.close(); }
}
const event = (payload: unknown, timestamp = new Date().toISOString()) => JSON.stringify({ type: "event_msg", timestamp, payload }) + "\n";
const token = (used: number, window = 258400) => ({ type: "token_count", info: {
  total_token_usage: { total_tokens: 900000 }, last_token_usage: { total_tokens: used }, model_context_window: window,
}, rate_limits: { ignored: "private-rollout-content" } });

describe("Claude current context", () => {
  it("uses only the latest main call's input/cache tokens, including message_delta corrections and [1m] windows", () => {
    const { line, snapshots } = capture("claude");
    const first = assistant("a", "main", { input_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 7, output_tokens: 500 });
    line({ type: "system", subtype: "init", model: "main[1m]" });
    line({ type: "stream_event", event: { type: "message_start", message: first.message } });
    line(first);
    line({ type: "stream_event", api_message_id: "a", event: { type: "message_delta", usage: { input_tokens: 60 } } });
    line(assistant("b", "main", { input_tokens: 20, iterations: [
      { type: "message", input_tokens: 99 }, { type: "fallback_message", input_tokens: 10, cache_read_input_tokens: 2 },
      { type: "advisor_message", input_tokens: 88 }, { type: "compaction", input_tokens: 99 },
    ] }));
    line({ ...assistant("sub", "other", { input_tokens: 999 }), parent_tool_use_id: "agent" });
    line({ ...assistant("replay", "other", { input_tokens: 888 }), isReplay: true });
    line(assistant("b", "main", { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    line({ type: "result", usage: { input_tokens: 80000 }, modelUsage: { other: { contextWindow: 1 }, main: { contextWindow: 200000 }, "main[1m]": { inputTokens: 80000, contextWindow: 1000000 } } });
    expect(snapshots()).toEqual([{ used_tokens: 157 }, { used_tokens: 167 }, { used_tokens: 12 }, { used_tokens: 12, window_tokens: 1000000 }]);
  });

  it("never binds an earlier sample to a fallback model, or a pre-compaction model to a new sample", () => {
    const { line, snapshots } = capture("claude");
    line(assistant("a", "model-a", { input_tokens: 60 }));
    line(assistant("b", "model-b", { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    line({ type: "result", modelUsage: { "model-b": { contextWindow: 80000 } } });
    line({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 60, post_tokens: 11 } });
    line({ type: "result", modelUsage: { "model-a": { contextWindow: 99999 } } });
    line(assistant("c", "model-c", { input_tokens: 18 }));
    line({ type: "result", modelUsage: { "model-b": { contextWindow: 12345 } } });
    expect(snapshots()).toEqual([{ used_tokens: 60 }, { used_tokens: 11 }, { used_tokens: 18 }]);
  });

  it("does not synthesize a percentage from billing, synthetic, invalid or zero usage", () => {
    const { line, snapshots } = capture("claude");
    line(assistant("a", "<synthetic>", { input_tokens: 10 }));
    for (const input_tokens of [0, -1, 0.25, "12", null, 2 ** 53]) line(assistant("a", "main", { input_tokens }));
    line({ type: "result", usage: { input_tokens: 91 }, modelUsage: { main: { inputTokens: 100, contextWindow: 1000000 } } });
    expect(snapshots()).toEqual([]);
  });
});

describe("Codex current context", () => {
  it("ignores turn billing, cumulative totals, malformed numbers and unknown windows", () => {
    const { line, snapshots } = capture("codex");
    line({ type: "turn.completed", usage: { input_tokens: 20000, output_tokens: 40 } });
    line({ type: "token_count", info: { total_token_usage: { total_tokens: 9999 } } });
    for (const total_tokens of [-1, "3", 1.5, 2 ** 53]) line({ type: "token_count", info: { last_token_usage: { total_tokens } } });
    line(token(100)); line(token(100)); line(token(22, -1));
    expect(snapshots()).toEqual([{ used_tokens: 100, window_tokens: 258400 }, { used_tokens: 22 }]);
  });

  it("tails only the resumed thread after its startup offset, reassembles split rows and flushes before done", async () => {
    const home = tmp();
    const path = filename(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, event({ type: "task_started" }) + event(token(999)));
    writeFileSync(filename(home, other), event({ type: "task_started" }) + event(token(555)));
    index(home, path); index(home, filename(home, other), other);
    const { line, parser, events, snapshots } = capture("codex", home, id);
    line({ type: "thread.started", thread_id: id });
    const latest = event(token(45));
    appendFileSync(path, event(token(777)) + event({ type: "task_started" }) + "x".repeat(180000) + "\n" + event(token(123)) + latest.slice(0, 50));
    try {
      await vi.waitFor(() => expect(snapshots()).toEqual([{ used_tokens: 123, window_tokens: 258400 }]), { timeout: 3000 });
      appendFileSync(path, latest.slice(50) + event({ type: "task_complete" }) + event({ type: "task_started" }) + event(token(444)));
    } finally { await parser.finish(true); }
    expect(snapshots()).toEqual([{ used_tokens: 123, window_tokens: 258400 }, { used_tokens: 45, window_tokens: 258400 }]);
    expect(JSON.stringify(events)).not.toContain("private-rollout-content");
    expect(parser.state.text).toBe("");
  });

  it("matches only current-turn activities and final envelopes, including split UTF-8 on resume", async () => {
    const home = tmp(), path = filename(home);
    mkdirSync(dirname(path), { recursive: true });
    index(home, path);
    const fixture = readFileSync(new URL("./fixtures/codex-subagent-rollout.jsonl", import.meta.url), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const row = (r: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), ...r as object }) + "\n";
    const [start, spawn, active, done, wait, message, end] = fixture;
    writeFileSync(path, fixture.map(row).join(""));
    const result: CodexRolloutActivity[] = [];
    const monitor = codexRolloutMonitor({ CODEX_HOME: home }, id, () => {}, e => result.push(e));
    monitor.start(id);
    const change = (r: typeof message, fields: object) => ({ ...r, payload: { ...r.payload, ...fields } });
    const prefix = Buffer.from([message, start, spawn, change(active, { thread_id: other }), active, wait,
      change(done, { item: { ...done.payload.item, kind: "unknown" } }), change(done, { turn_id: "not-this-turn" }),
      change(message, { recipient: "/other" }), change(message, { author: "/root/unrelated" }),
      change(message, { content: [{ type: "input_text", text: message.payload.content[0].text.replace("FINAL_ANSWER", "PROGRESS") }] }),
      done].map(row).join(""));
    const data = Buffer.concat([prefix, Buffer.from([message, end, ...fixture].map(row).join(""))]);
    // Force a read between bytes of a multi-byte character in the active result.
    const boundary = data.indexOf(Buffer.from("铜色"), prefix.length) + 1;
    expect(boundary).toBeGreaterThan(prefix.length);
    appendFileSync(path, data.subarray(0, boundary));
    try {
      await vi.waitFor(() => expect(result.map(r => r.kind)).toEqual(["started", "completed"]), { timeout: 3000 });
      appendFileSync(path, data.subarray(boundary));
    } finally { await monitor.finish(); }
    expect(result).toEqual([{ threadId: other, kind: "started", task: "检查颜色" }, { threadId: other, kind: "completed" },
      { threadId: other, kind: "message", result: "铜色" }]);
  });

  it("matches resumed-turn Codex rollout completed + FINAL_ANSWER for prior subagent thread IDs", async () => {
    const home = tmp(), path = filename(home);
    mkdirSync(dirname(path), { recursive: true });
    index(home, path);
    const fixture = readFileSync(new URL("./fixtures/codex-subagent-rollout.jsonl", import.meta.url), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const row = (r: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), ...r as object }) + "\n";
    const [start, , , done, , message, end] = fixture;
    writeFileSync(path, row(start) + row(end));

    const events: ChatStreamEvent[] = [];
    const parser = createCliStreamParser("codex", [], (e) => events.push(e), undefined, undefined, {
      env: { CODEX_HOME: home },
      resumeId: id,
      priorSubagents: [
        {
          id: `codex-agent-${other}`,
          tool: "spawn_agent",
          summary: "检查颜色",
          status: "running",
          subagent: { status: "running" },
        },
      ],
    });
    parser.write(JSON.stringify({ type: "thread.started", thread_id: id }) + "\n");
    appendFileSync(path, [start, done, message, end].map(row).join(""));
    try {
      await vi.waitFor(
        () => expect(parser.state.toolEvents.get(`codex-agent-${other}`)).toMatchObject({
          summary: "检查颜色",
          output: "铜色",
          subagent: { status: "done" },
        }),
        { timeout: 3000 },
      );
    } finally {
      await parser.finish(true);
    }
  });

  it.each(["outside", "wrong-id", "symlink", "mismatched-resume", "traversal"])("rejects %s without reading its telemetry", async mode => {
    const home = tmp();
    const untrusted = mode === "wrong-id" ? filename(home, other) : filename(tmp());
    mkdirSync(dirname(untrusted), { recursive: true });
    const path = filename(home);
    mkdirSync(dirname(path), { recursive: true });
    const mismatched = mode === "mismatched-resume";
    if (mismatched) { writeFileSync(filename(home, other), ""); index(home, filename(home, other), other); }
    if (mode === "symlink") symlinkSync(untrusted, path);
    index(home, mode === "symlink" || mismatched ? path : untrusted);
    const { line, parser, snapshots } = capture("codex", home, mismatched ? other : "");
    writeFileSync(mismatched ? path : untrusted, event({ type: "task_started" }) + event(token(999)));
    line({ type: "thread.started", thread_id: mode === "traversal" ? "../" + id : id });
    await parser.finish(false);
    expect(snapshots()).toEqual([]);
  });
});

it.each(["cloud", "local"])("delivers the Codex rollout snapshot from the effective %s CLI home before the runner exits", async mode => {
  const temp = tmp(), home = tmp(), path = filename(home);
  mkdirSync(dirname(path), { recursive: true });
  index(home, path);
  const replay = readFileSync(new URL("./fixtures/codex-subagent-rollout.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const fake = join(temp, "codex.cjs");
  writeFileSync(fake, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => {
    const fs = require('node:fs'), path = require('node:path');
    console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(id)}}));
    const rows = ${JSON.stringify(replay)};
    rows.splice(1, 0, {type:'event_msg', payload:${JSON.stringify(token(56))}});
    fs.writeFileSync(path.join(process.env.CODEX_HOME, ${JSON.stringify(path.slice(home.length + 1))}), rows.map(row => JSON.stringify({...row, timestamp:new Date().toISOString()})+'\\n').join(''));
    console.log(JSON.stringify({type:'item.completed',item:{id:'wait',type:'collab_tool_call',tool:'wait',receiver_thread_ids:[],agents_states:{},status:'completed'}}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:40000}}));
  });`, { mode: 0o700 });
  vi.stubEnv("HOME", temp);
  vi.stubEnv("CODEX_HOME", mode === "cloud" ? home : tmp());
  vi.stubEnv("RELAYDESK_CODEX_BIN", fake);
  const events: ChatStreamEvent[] = [];
  const shared = { prompt: "fixture", signal: new AbortController().signal, onEvent: (e: ChatStreamEvent) => events.push(e) };
  const childSnapshot = { summary: "检查颜色", output: "铜色", subagent: { status: "done" } };
  const expected = { status: "done", content: "ok", events: expect.arrayContaining([expect.objectContaining(childSnapshot)]) };
  if (mode === "cloud") {
    const dbPath = join(temp, "store.sqlite"), store = new Store(dbPath);
    try {
      const projectId = store.createProject({ name: "Fixture", repo: "test/test" }).id;
      const result = await runWebCliChatTurn({ ...shared, dbPath, project: toAgentProject(store.getProjectRow(projectId)),
        session: store.createChatSession(projectId), attachments: [], priorMessages: [] });
      expect(result).toMatchObject(expected);
    } finally { store.close(); }
  } else {
    const cli = { available: true, version: "test" };
    const result = await runLocalChat({ ...shared, config: { runtimes: { codex: { bin: fake, extra_env: { CODEX_HOME: home } } } },
      catalog: { models: [], db_clients: [], runtimes: { codex: cli, claude: cli, agy: cli } }, homeDir: temp, cwd: temp, spaceDir: temp, allowSecrets: false,
      p: { session_id: "session", project_id: "project", run_id: "run", runtime: "codex", sandbox_mode: "read-only", prompt: shared.prompt, workspace_manifest: { files: [] } } });
    expect(result).toMatchObject(expected);
  }
  const tools = events.flatMap(e => e.type === "tool" ? [e.event] : []);
  expect(tools).toContainEqual(expect.objectContaining({ tool: "wait", status: "done" }));
  const child = tools.filter(e => e.subagent);
  expect(new Set(child.map(e => e.id)).size).toBe(1);
  expect(child.at(-1)).toMatchObject({ summary: "检查颜色", output: "铜色", subagent: { status: "done" } });
  expect(events.filter(e => e.type === "context_usage")).toEqual([{ type: "context_usage", usage: { used_tokens: 56, window_tokens: 258400 } }]);
  expect(JSON.stringify(events)).not.toContain("private-rollout-content");
});
