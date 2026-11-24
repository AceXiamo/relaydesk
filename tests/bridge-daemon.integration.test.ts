import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBridgeDaemon, type BridgeDaemonOptions } from "../agent/bridge/index.ts";
import { buildWorkspaceManifest, getProjectFilesDir } from "../server/workspace.ts";
import { bearer, fixture, operator, sha256, type Fixture } from "./bridge-fixture.ts";

const readers = vi.hoisted(() => ({ codex: vi.fn(), gemini: vi.fn() }));
vi.mock("../agent/bridge/codex-account.ts", () => ({ readCodexAccount: readers.codex }));
vi.mock("../agent/bridge/gemini-account.ts", () => ({ readGeminiAccount: readers.gemini }));

// Use real OS processes rather than mocking spawn: cancellation must also reap grandchildren.
const fakeCli = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) { console.log('codex-cli 1.0.0'); process.exit(0); }
if (args.includes('--help')) { console.log('test codex help'); process.exit(0); }
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString();
const space = process.env.RELAYDESK_SPACE_DIR;
const emit = obj => console.log(JSON.stringify(obj));
const claude = args.includes('stream-json');
if (prompt.includes('RETRY_FIXTURE')) {
  const resumed = args.includes('resume') || args.includes('--resume');
  appendFileSync('attempts.jsonl', JSON.stringify({ resumed, history: prompt.includes('HISTORY_MARKER') }) + '\\n');
  if (resumed) {
    if (prompt.includes('PARTIAL_TOOL')) emit({ type: 'item.started', item: { id: 't', type: 'command_execution', command: 'pwd' } });
    console.error(prompt.includes('OTHER_ERROR') ? 'permission denied' : 'No conversation found with session ID: stale');
    process.exit(1);
  }
  if (prompt.includes('FRESH_FAIL')) { console.error('startup failed'); process.exit(1); }
}
if (claude) emit({ type: 'system', session_id: 'local-claude-thread' });
else emit({ type: 'thread.started', thread_id: 'local-fixture-thread' });
const dbUrl = process.env.RELAYDESK_DB_FIXTURE ?? '';
const facts = { cwd: process.cwd(), space, args, hasHistory: prompt.includes('historical-fixture'),
  hasRef: prompt.includes('workspace reference marker'), hasDbEnv: Boolean(dbUrl), pg: process.env.PGOPTIONS,
  promptAllowsDocs: prompt.includes('$RELAYDESK_SPACE_DIR/HANDBOOK.md') && prompt.includes('$RELAYDESK_SPACE_DIR/DEPLOY.md') && !prompt.includes('treat HANDBOOK.md as read-only'),
  handbook: existsSync(join(space,'HANDBOOK.md')) ? readFileSync(join(space,'HANDBOOK.md'),'utf8') : null,
  deployDoc: existsSync(join(space,'DEPLOY.md')) ? readFileSync(join(space,'DEPLOY.md'),'utf8') : null };
if (existsSync('pids.json')) {
  const [previousPid] = JSON.parse(readFileSync('pids.json','utf8'));
  try { process.kill(previousPid, 0); facts.previousCliAlive = true; } catch { facts.previousCliAlive = false; }
}
if (existsSync(join(space,'files','large.bin'))) facts.digest = createHash('sha256').update(readFileSync(join(space,'files','large.bin'))).digest('hex');
if (existsSync(join(space,'files','sample.sqlite'))) {
  const db = new DatabaseSync(join(space,'files','sample.sqlite'), { readOnly: true });
  facts.sqlite = db.prepare('SELECT marker FROM fixture').get().marker;
  db.close();
}
writeFileSync('facts.json', JSON.stringify(facts));
if (prompt.includes('WAIT_FOR_NETWORK_SWITCH')) {
  appendFileSync('launches.txt', String(process.pid) + '\\n');
  while (!existsSync('network-restored')) await new Promise(resolve => setTimeout(resolve, 20));
}
if (prompt.includes('MAKE_CHANGES')) {
  writeFileSync(join(space, 'HANDBOOK.md'), 'updated handbook');
  writeFileSync(join(space, 'DEPLOY.md'), 'updated deploy doc');
  writeFileSync(join(space, 'files', 'output.txt'), 'result from local workspace');
  writeFileSync(join(space, 'files', 'large.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 0xa5));
  writeFileSync(join(space, 'files', '.env'), 'do not publish');
}
if (prompt.includes('BLOCK_UNTIL_CANCELLED') && !args.includes('resume')) {
  emit({ type: 'agent_message.delta', delta: 'before interruption' });
  emit({ type: 'item.completed', item: { id: 'partial-tool', type: 'command_execution', command: 'pwd', aggregated_output: 'partial output', exit_code: 0 } });
  if (prompt.includes('SHOW_PROGRESS')) setInterval(() => emit({ type: 'agent_message.delta', delta: '.' }), 80);
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 30000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(resolve => child.stdout.once('data', resolve));
  writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
  await new Promise(() => setInterval(() => {}, 30000));
}
if (claude) {
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'fixture reasoning' } } });
  emit({ type: 'assistant', message: { model: 'fixture-main', usage: { input_tokens: 25, cache_read_input_tokens: 75, cache_creation_input_tokens: 0 } } });
  emit({ type: 'result', result: 'fixture Claude reply', modelUsage: { 'fixture-main': { contextWindow: 200000 } } });
  process.exit(0);
}
emit({ type: 'item.completed', item: { id: 'tool', type: 'command_execution', command: 'fixture', aggregated_output: 'tool:' + dbUrl, exit_code: 0 } });
emit({ type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: 'fixture-reply:' + dbUrl } });
`;

const privateCatalogValue = ["private", "fixture", "config", "value"].join("-");
let f: Fixture;
let daemon: Awaited<ReturnType<typeof startBridgeDaemon>> | undefined;
beforeEach(async () => {
  readers.codex.mockReset().mockResolvedValue(null);
  readers.gemini.mockReset().mockResolvedValue(null);
  f = await fixture();
  vi.stubEnv("HOME", join(f.root, "home"));
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
});
afterEach(async () => {
  try { await daemon?.close(); } finally { daemon = undefined; vi.unstubAllEnvs(); await f.close(); }
});

async function start(roots = true, concurrency = 1, timers: Pick<BridgeDaemonOptions, "accountRefreshMs" | "accountTimeoutMs"> = {}) {
  const p = await f.project();
  const { id, token } = await f.register();
  const homeDir = join(f.root, "home");
  const cacheDir = join(f.root, "cache");
  const allowed = join(f.root, "allowed");
  const repo = join(allowed, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  mkdirSync(join(homeDir, ".codex"), { recursive: true });
  writeFileSync(join(homeDir, ".claude", "settings.json"), JSON.stringify({ model: "detected-claude", env: { ANTHROPIC_API_KEY: privateCatalogValue } }));
  writeFileSync(join(homeDir, ".codex", "config.toml"), 'model = "detected-codex"\nmodel_reasoning_effort = "medium"\n');
  const bin = join(f.root, "fake-codex.mjs");
  writeFileSync(bin, fakeCli, { mode: 0o755 });
  const configPath = join(f.root, "config.json");
  const config = { server_url: f.wsUrl, agent_token: token, agent_name: "Fixture", auto_detect_cli_configs: true,
    allowed_roots: roots ? [allowed] : [], max_concurrency: concurrency,
    projects: { [p]: { workdir: repo } }, runtimes: { codex: { bin }, claude: { bin } },
    models: [{ id: "detected-codex", runtime: "codex", context_window: 543210, effort_levels: ["low", "high"] }] };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  daemon = await startBridgeDaemon({ configPath, cacheDir, homeDir, ...timers, reconnectMinMs: 30, reconnectMaxMs: 100 });
  const agent = async () => (await f.ok("/bridge/agents")).agents.find((a: { id: string }) => a.id === id);
  await expect.poll(async () => (await agent())?.runtimes?.codex?.available, { timeout: 5000 }).toBe(true);
  return { id, p, token, configPath, cacheDir, repo, allowed, agent, bindPath: `/projects/${p}/agent-bindings/${id}` };
}

const facts = (repo: string) => JSON.parse(readFileSync(join(repo, "facts.json"), "utf8"));
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    // A container's PID 1 may not reap an already-terminated orphan immediately.
    return process.platform !== "linux" || !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch { return false; }
}

describe("real bridge daemon + HTTP chat", () => {
  it("publishes each provider independently and refreshes a failed snapshot", async () => {
    const row = { id: "one", name: "User", avatarUrl: null, plan: "Pro", status: "ready", windows: [] };
    let release!: () => void;
    readers.codex.mockResolvedValueOnce(row).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(row); }));
    readers.gemini.mockResolvedValue(row);
    await start(true, 1, { accountRefreshMs: 500, accountTimeoutMs: 100 });
    const accounts = async () => (await f.ok("/sidebar-accounts")).accounts;
    await expect.poll(accounts, { interval: 10 }).toHaveLength(2);
    await expect.poll(accounts, { timeout: 2500 }).toEqual([expect.objectContaining({ service: "Gemini", nodeName: "Test bridge" })]);
    await expect.poll(() => readers.gemini.mock.calls.length, { timeout: 2500 }).toBeGreaterThanOrEqual(3);
    expect(readers.codex).toHaveBeenCalledTimes(2);
    release();
    readers.codex.mockRejectedValueOnce(new Error("private error")).mockResolvedValue(row);
    await expect.poll(accounts, { timeout: 2500 }).toHaveLength(2);
  });

  it("merges native catalogs, hot reloads config, and accepts only real directories inside allowed roots", async () => {
    const { p, token, configPath, allowed, agent, bindPath } = await start();
    const summary = await agent();
    expect(summary.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "detected-claude", runtime: "claude" }),
      expect.objectContaining({ id: "detected-codex", context_window: 543210, effort_levels: ["low", "high"] }),
    ]));
    expect(JSON.stringify(summary)).not.toContain(privateCatalogValue);
    expect(JSON.stringify(summary)).not.toContain(token);
    const fresh = join(allowed, "second-repo");
    mkdirSync(fresh);
    const { binding } = await f.ok(bindPath, "PATCH", { workdir: fresh });
    expect(realpathSync(binding.workdir)).toBe(realpathSync(fresh));
    expect(binding.path_ok).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(realpathSync(config.projects[p].workdir)).toBe(realpathSync(fresh));
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(allowed, "points-outside"), "dir");
    for (const workdir of [outside, join(allowed, "points-outside"), join(allowed, "absent")]) {
      expect((await f.api(bindPath, "PATCH", { workdir })).status).toBeGreaterThanOrEqual(400);
      expect(realpathSync(JSON.parse(readFileSync(configPath, "utf8")).projects[p].workdir)).toBe(realpathSync(fresh));
    }
    config.models.push({ id: "hot-loaded", runtime: "codex", context_window: 99000 });
    writeFileSync(configPath, JSON.stringify(config));
    await expect.poll(async () => (await agent()).models, { timeout: 6000 }).toContainEqual(expect.objectContaining({ id: "hot-loaded", context_window: 99000 }));
  });

  it("publishes cache-only window changes and clears the window when the cache no longer reports it", async () => {
    const { agent, configPath } = await start();
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    delete config.models[0].context_window;
    writeFileSync(configPath, JSON.stringify(config));
    const model = async () => (await agent()).models.find((item: { id: string }) => item.id === "detected-codex");
    await expect.poll(model, { timeout: 6000 }).not.toHaveProperty("context_window");
    const cachePath = join(f.root, "home", ".codex", "models_cache.json");
    for (const context_window of [140000, 96000, undefined]) {
      writeFileSync(cachePath, JSON.stringify({ models: [{ slug: "detected-codex", context_window, total_tokens: 987654 }] }));
      await expect.poll(async () => (await model()).context_window, { timeout: 6000 }).toBe(context_window);
    }
  });

  it("refreshes the reported Claude catalog when only the picker options change", async () => {
    const { agent } = await start();
    const settingsPath = join(f.root, "home", ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const model of ["gateway/first", "gateway/replacement[1m]"]) {
      settings.modelPicker = { replaceBuiltInOptions: true, options: [{ model, label: "Custom model" }] };
      writeFileSync(settingsPath, JSON.stringify(settings));
      await expect.poll(async () => (await agent()).models.filter((item: { runtime: string }) => item.runtime === "claude"),
        { timeout: 6000 }).toEqual([
        expect.objectContaining({ id: settings.model, is_default: true }),
        expect.objectContaining({ id: model, label: "Custom model" }),
      ]);
    }
  });

  it("revalidates locally configured project paths when allowed roots change", async () => {
    const { p, id, configPath } = await start();
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const elsewhere = join(f.root, "different-root");
    mkdirSync(elsewhere);
    config.allowed_roots = [elsewhere];
    writeFileSync(configPath, JSON.stringify(config));
    await expect.poll(async () => (await f.ok("/bridge/agents")).agents.find((a: { id: string }) => a.id === id).bindings[0].path_ok,
      { timeout: 6000 }).toBe(false);
    const session = await f.session(p, id);
    expect((await f.api(`${session.path}/messages`, "POST", { content: "Do not run" })).status).toBe(409);
  });

  it("cannot remotely change a locally declared workdir without allowed roots", async () => {
    const { bindPath, p, repo, configPath } = await start(false);
    const workdir = join(f.root, "another");
    mkdirSync(workdir);
    expect((await f.api(bindPath, "PATCH", { workdir })).ok).toBe(false);
    expect(realpathSync(JSON.parse(readFileSync(configPath, "utf8")).projects[p].workdir)).toBe(realpathSync(repo));
  });

  it("mounts the shadow space, resumes on the same machine, and writes back only permitted changes", async () => {
    const { p, id, repo, token, cacheDir } = await start();
    const w = `/projects/${p}/workspace`;
    await f.ok(`${w}/handbook`, "POST", { content: "fixture handbook" });
    await f.ok(`${w}/file`, "POST", { path: "reference.md", content: "workspace reference marker" });
    const large = Buffer.alloc(2 * 1024 * 1024 + 1, 0x9c);
    const binary = async (name: string, bytes: Buffer) => {
      const res = await fetch(`${f.srv.url}/api${w}/upload?path=${name}`, { method: "POST", headers: bearer(operator), body: new Uint8Array(bytes) });
      expect(res.ok).toBe(true);
    };
    await binary("large.bin", large);
    const dbPath = join(f.root, "fixture.sqlite");
    const db = new DatabaseSync(dbPath);
    try { db.exec("CREATE TABLE fixture(marker TEXT); INSERT INTO fixture VALUES ('sqlite-marker')"); } finally { db.close(); }
    await binary("sample.sqlite", readFileSync(dbPath));
    const huge = join(getProjectFilesDir(f.dbPath, p), "oversized.bin");
    writeFileSync(huge, "");
    truncateSync(huge, 20 * 1024 * 1024 + 1);
    const s = await f.session(p, id);
    const attachment = { kind: "file", ref: "reference.md", label: "reference.md" };
    const text = await (await s.turn("Read attachment and mirror", [attachment])).text();
    expect(text).toContain("event: tool");
    expect(text).toContain("event: done");
    const observed = facts(repo);
    expect(observed).toMatchObject({ cwd: realpathSync(repo), hasRef: true, handbook: "fixture handbook", digest: sha256(large), sqlite: "sqlite-marker" });
    expect(realpathSync(observed.space)).toBe(realpathSync(join(cacheDir, p)));
    expect(existsSync(join(observed.space, "files", "oversized.bin"))).toBe(false);
    expect(observed.args).toContain("--add-dir");
    expect(observed.args[observed.args.indexOf("--add-dir") + 1]).toBe(observed.space);
    expect(readdirSync(repo)).toEqual(["facts.json"]);
    expect((await s.detail()).session).toMatchObject({ resolved_target: `local:${id}`, external_session_id: "local-fixture-thread" });
    const mirrorFile = join(observed.space, "files", "large.bin");
    await f.ok(`${w}/handbook`, "POST", { content: "new cloud handbook" });
    await f.ok(`${w}/file?path=reference.md`, "DELETE");
    const previousMtime = statSync(mirrorFile).mtimeMs;
    expect(await (await s.turn("Follow up")).text()).toContain("event: done");
    expect(facts(repo).args).toEqual(expect.arrayContaining(["resume", "local-fixture-thread"]));
    expect(statSync(mirrorFile).mtimeMs).toBe(previousMtime);
    expect(facts(repo).handbook).toBe("new cloud handbook");
    expect(existsSync(join(observed.space, "files", "reference.md"))).toBe(false);
    // A misbehaving CLI can write its own cache, but read-only turns must never publish it.
    expect(await (await s.turn("MAKE_CHANGES")).text()).toContain("event: done");
    expect((await f.ok(`${w}/handbook`)).handbook.content).toBe("new cloud handbook");
    expect((await f.ok(`${w}/deploy-doc`)).deploy_doc.exists).toBe(false);
    expect((await f.api(`${w}/file?path=output.txt`)).status).toBe(404);
    const write = await f.session(p, id, "workspace-write");
    expect(await (await write.turn("MAKE_CHANGES")).text()).toContain("event: done");
    expect(facts(repo).promptAllowsDocs).toBe(true);
    expect((await f.ok(`${w}/handbook`)).handbook.content).toBe("updated handbook");
    expect((await f.ok(`${w}/deploy-doc`)).deploy_doc.content).toBe("updated deploy doc");
    expect((await f.ok(`${w}/file?path=output.txt`)).file.content).toBe("result from local workspace");
    const uploaded = await fetch(`${f.srv.url}/api/bridge/projects/${p}/workspace/file?path=files/large.bin`, { headers: bearer(token) });
    expect(sha256(Buffer.from(await uploaded.arrayBuffer()))).toBe(sha256(Buffer.alloc(large.length, 0xa5)));
    expect((await f.ok(`${w}/files`)).files.map((e: { path: string }) => e.path)).not.toContain(".env");
    expect((await fetch(`${f.srv.url}/api/bridge/projects/${p}/workspace/file?path=files/output.txt`, { method: "PUT", headers: bearer(token), body: "late change" })).status).toBe(403);
  });

  it("applies session Fast preferences through HTTP and the bridge without losing the thread", async () => {
    const { id, p, repo, agent } = await start();
    writeFileSync(join(f.root, "home/.codex/models_cache.json"), JSON.stringify({ models: [{ slug: "detected-codex", additional_speed_tiers: ["fast"] }] }));
    await expect.poll(async () => (await agent()).models, { timeout: 6000 }).toContainEqual(expect.objectContaining({ id: "detected-codex", supports_fast: true }));
    const s = await f.session(p, id);
    expect((await s.detail()).session.fast_mode).toBe("default");
    expect((await f.api(s.path, "PATCH", { fast_mode: true })).status).toBe(400);
    for (const [mode, tier] of [["on", "priority"], ["off", "default"], ["default", null]] as const) {
      expect((await f.ok(s.path, "PATCH", { model: "detected-codex", fast_mode: mode })).session.fast_mode).toBe(mode);
      expect(await (await s.turn("Check Fast")).text()).toContain("event: done");
      const args = facts(repo).args as string[];
      expect(args.includes("resume")).toBe(mode !== "on");
      expect(args.filter(arg => arg.startsWith("service_tier="))).toEqual(tier ? [`service_tier="${tier}"`] : []);
    }
  });

  it("normalizes a local Claude stream and keeps its read-only tool set", async () => {
    const { id, p, repo } = await start();
    const s = await f.session(p, id);
    await f.ok(s.path, "PATCH", { runtime: "claude", model: "detected-claude", reasoning_effort: "high" });
    const text = await (await s.turn("Inspect local sources")).text();
    expect(text).toContain("event: reasoning");
    expect(text).toContain("fixture Claude reply");
    expect(text).toContain("event: context_usage");
    expect((await s.detail()).session).toMatchObject({ resolved_target: `local:${id}`, external_session_id: "local-claude-thread", context_used_tokens: 100, context_window_tokens: 200000 });
    const { args, space } = facts(repo);
    expect(args[args.indexOf("--add-dir") + 1]).toBe(space);
    expect(args[args.indexOf("--allowedTools") + 1].split(",")).not.toContain("Write");
  });

  it("uses full Claude permissions on fresh and resumed writable network turns when enabled locally", async () => {
    const { id, p, repo, configPath, agent } = await start();
    const s = await f.session(p, id, "workspace-write");
    await f.ok(s.path, "PATCH", { runtime: "claude", network_access: true });
    const run = async () => {
      expect(await (await s.turn("Inspect local tools")).text()).toContain("event: done");
      return facts(repo).args as string[];
    };
    expect(await run()).toContain("dontAsk");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.models.push({ id: "full-access-fixture", runtime: "claude" });
    writeFileSync(configPath, JSON.stringify({ ...config, claude_full_access: true }));
    await expect.poll(async () => (await agent()).models, { timeout: 6000 })
      .toContainEqual(expect.objectContaining({ id: "full-access-fixture" }));
    const full = await f.session(p, id, "workspace-write");
    await f.ok(full.path, "PATCH", { runtime: "claude", network_access: true });
    for (const resumed of [false, true]) {
      expect(await (await full.turn("Inspect local tools")).text()).toContain("event: done");
      const { args } = facts(repo);
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
      expect(args).not.toContain("--tools");
      expect(args).not.toContain("--allowedTools");
      expect(args.includes("--resume")).toBe(resumed);
    }
    await f.ok(s.path, "PATCH", { network_access: false });
    expect(await run()).toContain("dontAsk");
    await f.ok(s.path, "PATCH", { sandbox_mode: "read-only" });
    const readOnly = await run();
    expect(readOnly).toContain("dontAsk");
    expect(readOnly[readOnly.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
  });

  it("requires a local Codex opt-in on each fresh or resumed writable network turn", async () => {
    const { id, p, repo, configPath, agent } = await start();
    const session = await f.session(p, id, "workspace-write");
    await f.ok(session.path, "PATCH", { network_access: true });
    const turn = async (s = session) => {
      expect(await (await s.turn("Inspect local permissions")).text()).toContain("event: done");
      return facts(repo).args as string[];
    };
    const bypass = "--dangerously-bypass-approvals-and-sandbox";
    const defaults = await turn();
    expect(defaults[defaults.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(defaults).not.toContain(bypass);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...config, codex_full_access: true, accept_cli_runs: true }));
    await expect.poll(async () => (await agent()).accept_cli_runs, { timeout: 6000 }).toBe(true);
    const fresh = await f.session(p, id, "workspace-write");
    await f.ok(fresh.path, "PATCH", { network_access: true });
    for (const resumed of [false, true]) {
      const args = await turn(fresh);
      expect(args.includes("resume")).toBe(resumed);
      expect(args).toContain(bypass);
      expect(args).not.toContain("--sandbox");
      expect(args.some(arg => arg.startsWith("sandbox_"))).toBe(false);
    }

    await f.ok(fresh.path, "PATCH", { network_access: false });
    expect(await turn(fresh)).not.toContain(bypass);
    const offline = await turn(fresh);
    expect(offline).toEqual(expect.arrayContaining(["resume", 'sandbox_mode="workspace-write"', "sandbox_workspace_write.network_access=false"]));
    expect(offline).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify([facts(repo).space])}`);
    expect(offline).not.toContain(bypass);
    await f.ok(fresh.path, "PATCH", { sandbox_mode: "read-only", network_access: true });
    expect(await turn(fresh)).not.toContain(bypass);
    const readOnly = await turn(fresh);
    expect(readOnly).toEqual(expect.arrayContaining(["resume", 'sandbox_mode="read-only"', "sandbox_workspace_write.network_access=false"]));
    expect(readOnly).not.toContain(bypass);

    for (const mode of ["pr_audit", "operator"] as const) {
      const result = await f.srv.bridgeHub.runCliRun(id, {
        run_id: `permissions-${mode}`, project_id: p, mode, runtime: "codex",
        prompt: "Inspect the project", workspace_manifest: buildWorkspaceManifest(f.dbPath, p),
      }, () => {});
      expect(result.event).toBe("finish");
      const { args } = facts(repo);
      expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
      expect(args).not.toContain(bypass);
      expect(args).toContain("sandbox_workspace_write.network_access=false");
    }

    await f.ok(fresh.path, "PATCH", { sandbox_mode: "workspace-write", network_access: true });
    expect(await turn(fresh)).toContain(bypass);
    // A Claude grant and a truthy string must not authorize Codex.
    writeFileSync(configPath, JSON.stringify({ ...config, claude_full_access: true, codex_full_access: "true" }));
    await expect.poll(async () => (await agent()).accept_cli_runs, { timeout: 6000 }).toBe(false);
    const revoked = await turn(fresh);
    expect(revoked).toEqual(expect.arrayContaining(["resume", 'sandbox_mode="workspace-write"', "sandbox_workspace_write.network_access=true"]));
    expect(revoked).not.toContain(bypass);
  });

  it.each(["symlink", "hardlink"])("refuses a %s in the shadow cache and leaves the external file untouched", async (kind) => {
    const { id, p, cacheDir, repo } = await start();
    await f.ok(`/projects/${p}/workspace/file`, "POST", { path: "notes.txt", content: "cloud copy" });
    const dir = join(cacheDir, p, "files");
    mkdirSync(dir, { recursive: true });
    const outside = join(f.root, "outside.txt");
    writeFileSync(outside, "outside copy");
    (kind === "symlink" ? symlinkSync : linkSync)(outside, join(dir, "notes.txt"));
    const s = await f.session(p, id, "workspace-write");
    expect(await (await s.turn("Read the mirror")).text()).toContain("event: error");
    expect((await s.detail()).messages.at(-1).status).toBe("error");
    expect(readFileSync(outside, "utf8")).toBe("outside copy");
    expect(existsSync(join(repo, "facts.json"))).toBe(false);
  });

  it("rejects a downloaded file if its bytes changed after the manifest was built", async () => {
    const { id, p, cacheDir, repo } = await start();
    const size = 2 * 1024 * 1024 + 1;
    const source = join(getProjectFilesDir(f.dbPath, p, true), "changing.bin");
    writeFileSync(source, Buffer.alloc(size, 1));
    let changed = false;
    f.srv.server.prependListener("request", req => {
      if (req.url?.startsWith(`/api/bridge/projects/${p}/workspace/file?`)) {
        changed = true;
        writeFileSync(source, Buffer.alloc(size, 2));
      }
    });
    const s = await f.session(p, id);
    expect(await (await s.turn("Read the changing file")).text()).toContain("event: error");
    expect(changed).toBe(true);
    expect(existsSync(join(cacheDir, p, "files", "changing.bin"))).toBe(false);
    expect(existsSync(join(repo, "facts.json"))).toBe(false);
  });

  it("starts fresh with conversation history when the last successful turn ran on a different machine", async () => {
    const { id, p, repo } = await start();
    const s = await f.session(p, id);
    f.srv.store.updateChatSession(p, s.id, { resolved_target: "cloud", external_session_id: "old-cloud-thread" });
    f.srv.store.addChatMessage(s.id, { role: "user", content: "historical-fixture" });
    f.srv.store.addChatMessage(s.id, { role: "assistant", content: "previous cloud answer" });
    expect(await (await s.turn("Continue after switching nodes")).text()).toContain("event: done");
    expect(facts(repo).hasHistory).toBe(true);
    expect(facts(repo).args).not.toContain("resume");
    expect(facts(repo).args).not.toContain("old-cloud-thread");
    expect((await s.detail()).session).toMatchObject({ resolved_target: `local:${id}`, external_session_id: "local-fixture-thread" });
  });

  it("never exports datasource credentials by default; opted-in turns enforce read-only PG and redact output", async () => {
    const { id, p, repo, configPath, cacheDir, bindPath } = await start();
    const url = "postgresql://fixture:only-in-memory@db.example.invalid/fixture";
    await f.ok(`/projects/${p}/workspace/databases`, "POST", { mode: "external", kind: "postgres", name: "Fixture", connection_url: url });
    const s = await f.session(p, id);
    expect(await (await s.turn("Check datasource")).text()).toContain("event: done");
    expect(facts(repo).hasDbEnv).toBe(false);
    await f.ok(bindPath, "PATCH", { allow_datasource_secrets: true });
    const text = await (await s.turn("Repeat datasource check")).text();
    expect(text).toContain("event: done");
    expect(facts(repo)).toMatchObject({ hasDbEnv: true, pg: expect.stringContaining("default_transaction_read_only=on") });
    const saved = JSON.stringify(await s.detail());
    for (const value of [saved, text]) {
      expect(value).toContain("[redacted]");
      expect(value).not.toContain("only-in-memory");
    }
    expect(readFileSync(configPath, "utf8")).not.toContain("only-in-memory");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.projects[p].allow_datasource_secrets = false;
    config.models.push({ runtime: "codex", id: "local-opt-out-applied" });
    writeFileSync(configPath, JSON.stringify(config));
    await expect.poll(async () => (await f.ok("/bridge/agents")).agents[0].models, { timeout: 5000 })
      .toContainEqual(expect.objectContaining({ id: "local-opt-out-applied" }));
    expect(await (await s.turn("Check local opt-out")).text()).toContain("event: done");
    expect(facts(repo).hasDbEnv).toBe(false);
    for (const path of readdirSync(cacheDir, { recursive: true, encoding: "utf8" })) {
      const file = join(cacheDir, path);
      if (statSync(file).isFile()) expect(readFileSync(file).includes(Buffer.from("only-in-memory"))).toBe(false);
    }
  });

  it.each([
    { prompt: "RETRY_FIXTURE", fresh: true, externalSessionId: "local-fixture-thread", status: "done" },
    { prompt: "RETRY_FIXTURE FRESH_FAIL", fresh: true, externalSessionId: "", status: "error" },
    { prompt: "RETRY_FIXTURE OTHER_ERROR", fresh: false, externalSessionId: "stale", status: "error" },
    { prompt: "RETRY_FIXTURE PARTIAL_TOOL", fresh: false, externalSessionId: "stale", status: "error" },
  ])("recovers a missing local thread only before side effects ($prompt)", async ({ prompt, fresh, externalSessionId, status }) => {
    const { id, p, repo } = await start();
    const result = await f.srv.bridgeHub.runChatTurn(id, {
      project_id: p, session_id: "retry-session", runtime: "codex", sandbox_mode: "read-only", network_access: false,
      model: "", reasoning_effort: "default", resume_session_id: "stale", system_context: "HISTORY_MARKER",
      workspace_manifest: buildWorkspaceManifest(f.dbPath, p), prompt,
    }, () => {}, new AbortController().signal);
    expect(result).toMatchObject({ status, externalSessionId });
    const attempts = readFileSync(join(repo, "attempts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(attempts).toEqual([{ resumed: true, history: false }, ...(fresh ? [{ resumed: false, history: true }] : [])]);
    if (prompt.includes("PARTIAL_TOOL")) expect(result.events).toMatchObject([{ id: "t" }]);
  });

  it.each(["idle_timeout", "total_timeout"] as const)("forwards the daemon's own %s and partial result", async reason => {
    const { id, p } = await start();
    // The server samples its budget during dispatch. The daemon samples its own on receipt.
    vi.stubEnv("RELAYDESK_CHAT_IDLE_TIMEOUT_MS", "10000");
    vi.stubEnv("RELAYDESK_CHAT_TOTAL_TIMEOUT_MS", "0");
    const turn = f.srv.bridgeHub.runChatTurn(id, {
      project_id: p, session_id: "timeout-session", runtime: "codex", sandbox_mode: "read-only", network_access: false,
      model: "", reasoning_effort: "default", resume_session_id: "", system_context: "",
      workspace_manifest: buildWorkspaceManifest(f.dbPath, p),
      prompt: reason === "idle_timeout" ? "BLOCK_UNTIL_CANCELLED" : "BLOCK_UNTIL_CANCELLED SHOW_PROGRESS",
    }, () => {}, new AbortController().signal);
    vi.stubEnv(reason === "idle_timeout" ? "RELAYDESK_CHAT_IDLE_TIMEOUT_MS" : "RELAYDESK_CHAT_TOTAL_TIMEOUT_MS", "850");
    expect(await turn).toMatchObject({ status: "error", stopReason: reason, content: expect.stringContaining("before interruption"),
      events: [{ id: "partial-tool", output: "partial output" }], externalSessionId: "local-fixture-thread" });
  });

  it("times out a lock waiter separately while another chat keeps making progress", async () => {
    vi.stubEnv("RELAYDESK_CHAT_QUEUE_TIMEOUT_MS", "1250");
    vi.stubEnv("RELAYDESK_CHAT_IDLE_TIMEOUT_MS", "800");
    const { id, p, repo } = await start(true, 2);
    const first = await f.session(p, id);
    const waiting = await f.session(p, id);
    const stream = (await first.turn("BLOCK_UNTIL_CANCELLED SHOW_PROGRESS")).text();
    await expect.poll(() => existsSync(join(repo, "pids.json"))).toBe(true);
    const queued = await (await waiting.turn("must wait for the lock")).text();
    expect(queued).toContain("等待项目执行锁超时");
    expect(f.srv.bridgeHub.isChatSessionRunning(first.id)).toBe(true);
    f.srv.bridgeHub.abortChatSessionRun(first.id);
    expect(await stream).toContain("before interruption");
    const next = await f.session(p, id);
    expect(await (await next.turn("acquire after cancellation")).text()).toContain("fixture-reply");
  });

  it("reattaches the same CLI after transport loss, then syncs its workspace through the new socket", async () => {
    const connections: Duplex[] = [];
    f.srv.server.on("upgrade", (_req, socket) => connections.push(socket));
    const { id, p, repo } = await start();
    const session = await f.session(p, id, "workspace-write");
    const finished = (await session.turn("WAIT_FOR_NETWORK_SWITCH MAKE_CHANGES")).text();
    await expect.poll(() => existsSync(join(repo, "launches.txt"))).toBe(true);
    connections[0].destroy();
    await expect.poll(() => connections.length).toBeGreaterThan(1);
    await expect.poll(() => f.srv.bridgeHub.hasActiveWriteLease(id, p)).toBe(true);
    writeFileSync(join(repo, "network-restored"), "go");
    const text = await finished;
    expect(text).toContain("正在等待接回原执行");
    expect(text).toContain("继续原执行");
    expect(text).toContain("event: done");
    expect(readFileSync(join(repo, "launches.txt"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(getProjectFilesDir(f.dbPath, p), "output.txt"), "utf8")).toBe("result from local workspace");
    expect((await session.detail()).messages.at(-1).status).toBe("done");
  });

  it.each(["abort", "disconnect"] as const)("%s closes the running SSE response and kills the entire child process group", async (action) => {
    if (action === "disconnect") {
      await f.close();
      f = await fixture({ bridgeHubOptions: { chatReconnectMs: 15 } });
    }
    const connections: Duplex[] = [];
    f.srv.server.on("upgrade", (_req, socket) => connections.push(socket));
    const { id, p, repo, token } = await start();
    const s = await f.session(p, id, "workspace-write");
    const response = await s.turn("BLOCK_UNTIL_CANCELLED");
    const finished = response.text();
    await expect.poll(() => existsSync(join(repo, "pids.json"))).toBe(true);
    const pids: number[] = JSON.parse(readFileSync(join(repo, "pids.json"), "utf8"));
    try {
      expect(pids.map(alive)).toEqual([true, true]);
      if (action === "abort") {
        const { active_run_id } = (await s.detail()).session;
        expect((await f.ok(`${s.path}/abort`, "POST", { run_id: active_run_id, reason: "follow_up" })).aborted).toBe(true);
      }
      else connections[0].destroy();
      const text = await finished;
      const detail = await s.detail();
      expect(detail.messages.at(-1)).toMatchObject({ content: "before interruption", events: [{ id: "partial-tool", output: "partial output" }] });
      expect(detail.messages.at(-1).status).toBe(action === "abort" ? "aborted" : "error");
      expect(text).toContain(action === "abort" ? "event: done" : "event: error");
      if (action === "abort") {
        expect(detail.messages.at(-1).stop_reason).toBe("follow_up");
        expect(await (await s.turn("continue immediately")).text()).toContain("fixture-reply");
        expect(facts(repo)).toMatchObject({ previousCliAlive: false, args: expect.arrayContaining(["resume", "local-fixture-thread"]) });
      }
      await expect.poll(() => pids.map(alive), { timeout: 6000 }).toEqual([false, false]);
      const put = await fetch(`${f.srv.url}/api/bridge/projects/${p}/workspace/file?path=files/cancel.txt`, { method: "PUT", headers: bearer(token), body: "late" });
      expect(put.status).toBe(403);
      if (action === "disconnect") {
        await expect.poll(() => connections.length, { timeout: 4000 }).toBeGreaterThan(1);
        await expect.poll(async () => (await f.ok("/bridge/agents")).agents[0].online).toBe(true);
        const next = await f.session(p, id);
        expect(await (await next.turn("First turn after reconnect")).text()).toContain("event: done");
      }
    } finally {
      for (const pid of pids) { if (alive(pid)) process.kill(pid, "SIGKILL"); }
    }
  });
});
