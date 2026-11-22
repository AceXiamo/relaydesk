import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBridgeDaemon } from "../agent/bridge/index.ts";
import { normalizeExecutionPriority } from "../server/execution-router.ts";
import { fixture, type Fixture } from "./bridge-fixture.ts";

let f: Fixture | undefined;
let daemons: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(daemons.map((d) => d.close()));
  daemons = [];
  if (f) await f.close();
  f = undefined;
});

function fakeCodexCli(dir: string, tag: string) {
  const bin = join(dir, `fake-codex-${tag}`);
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("codex-cli 0.99.0"); process.exit(0); }
if (process.argv.includes("--help")) { console.log("codex exec"); process.exit(0); }
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => stdin += c);
process.stdin.on("end", () => {
  const hasHistory = stdin.includes("Previous Conversation Summary");
  const resumeIdx = process.argv.indexOf("resume");
  const resumeId = resumeIdx >= 0 ? process.argv[resumeIdx + 1] : "";
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread_${tag}_1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "from:${tag}|resume:" + resumeId + "|history:" + hasHistory } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
});
`;
  writeFileSync(bin, script, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}

describe("Execution routing, priority fallback, and local cli_runs dispatch", () => {
  it("normalizes execution priority with default local-first ordering and preserves explicit cloud position", () => {
    const agents = [{ id: "a1" }, { id: "a2" }];
    expect(
      normalizeExecutionPriority(
        { priority: [], auto_fallback: true, route_cli_runs: true, auto_dispatch_tasks: false, task_network_access: true },
        agents,
      ),
    ).toEqual(["local:a1", "local:a2", "cloud"]);

    expect(
      normalizeExecutionPriority(
        {
          priority: ["local:a2", "local:deleted", "local:a2"],
          auto_fallback: true,
          route_cli_runs: true,
          auto_dispatch_tasks: false,
          task_network_access: true,
        },
        agents,
      ),
    ).toEqual(["local:a2", "local:a1", "cloud"]);

    expect(
      normalizeExecutionPriority(
        {
          priority: ["cloud", "local:a2"],
          auto_fallback: true,
          route_cli_runs: true,
          auto_dispatch_tasks: false,
          task_network_access: true,
        },
        agents,
      ),
    ).toEqual(["cloud", "local:a2", "local:a1"]);
  });

  it("manages execution-routing API, routes auto chat by priority, falls back with history across nodes, and respects auto_fallback=false", async () => {
    f = await fixture();
    const projectId = await f.project("Routing Project");
    const a1 = await f.register("Mac Studio");
    const a2 = await f.register("MacBook Pro");

    // Rejects invalid priority target
    const badRes = await f.api(`/projects/${projectId}/execution-routing`, "PATCH", {
      priority: ["local:missing"],
    });
    expect(badRes.status).toBe(400);

    // Set priority: Mac Studio -> MacBook Pro -> cloud
    const updated = await f.ok(`/projects/${projectId}/execution-routing`, "PATCH", {
      priority: [`local:${a1.id}`, `local:${a2.id}`, "cloud"],
      auto_fallback: true,
      route_cli_runs: true,
    });
    expect(updated.effective_priority).toEqual([`local:${a1.id}`, `local:${a2.id}`, "cloud"]);

    // Start two real bridge daemons bound to the same project
    const startLocal = async (reg: { id: string; token: string }, tag: string) => {
      const homeDir = join(f!.root, `home-${tag}`);
      const repoDir = join(f!.root, `repo-${tag}`);
      const cfgDir = join(homeDir, ".config/relaydesk-bridge");
      mkdirSync(repoDir, { recursive: true });
      mkdirSync(cfgDir, { recursive: true });
      const bin = fakeCodexCli(homeDir, tag);
      const configPath = join(cfgDir, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          server_url: f!.wsUrl,
          agent_token: reg.token,
          max_concurrency: 2,
          accept_cli_runs: true,
          auto_detect_cli_configs: false,
          runtimes: { codex: { bin } },
          projects: { [projectId]: { workdir: repoDir } },
        }),
        { mode: 0o600 },
      );
      const d = await startBridgeDaemon({
        configPath,
        cacheDir: join(homeDir, "cache"),
        homeDir,
        reconnectMinMs: 20,
        reconnectMaxMs: 60,
      });
      daemons.push(d);
      await expect
        .poll(
          async () => {
            const list = (await f!.ok("/bridge/agents")).agents as Array<{
              id: string;
              online: boolean;
              bindings: Array<{ project_id: string; path_ok: boolean }>;
            }>;
            const item = list.find((x) => x.id === reg.id);
            return Boolean(item?.online && item.bindings.some((b) => b.project_id === projectId && b.path_ok));
          },
          { timeout: 5000, interval: 25 },
        )
        .toBe(true);
      return d;
    };

    const d1 = await startLocal(a1, "mac1");
    await startLocal(a2, "mac2");

    // Runtime endpoint exposes routing + online agents
    const runtime = await f.ok(`/projects/${projectId}/codex-chat/runtime`);
    expect(runtime.effective_priority).toEqual([`local:${a1.id}`, `local:${a2.id}`, "cloud"]);
    expect(runtime.agents.filter((a: { online: boolean }) => a.online)).toHaveLength(2);

    // Create an "auto" chat session
    const { session } = await f.ok(`/projects/${projectId}/codex-chat/sessions`, "POST", {
      runtime: "codex",
      execution_target: "auto",
      sandbox_mode: "read-only",
    });

    // Turn 1 -> hits primary node a1
    const r1 = await f.api(`/projects/${projectId}/codex-chat/sessions/${session.id}/messages`, "POST", {
      content: "first question",
    });
    expect(r1.ok).toBe(true);
    const sse1 = await r1.text();
    expect(sse1).toContain("from:mac1|resume:|history:false");

    const detail1 = await f.ok(`/projects/${projectId}/codex-chat/sessions/${session.id}`);
    expect(detail1.session.resolved_target).toBe(`local:${a1.id}`);
    expect(detail1.session.external_session_id).toBe("thread_mac1_1");

    // Take primary node a1 offline -> Turn 2 automatically falls back to a2 with conversation history & fresh thread
    await d1.close();
    await expect
      .poll(
        async () =>
          ((await f!.ok("/bridge/agents")).agents as Array<{ id: string; online: boolean }>).find(
            (x) => x.id === a1.id,
          )?.online,
        { timeout: 4000, interval: 20 },
      )
      .toBe(false);

    const r2 = await f.api(`/projects/${projectId}/codex-chat/sessions/${session.id}/messages`, "POST", {
      content: "follow up after failover",
    });
    expect(r2.ok).toBe(true);
    const sse2 = await r2.text();
    expect(sse2).toContain("已自动降级");
    expect(sse2).toContain("from:mac2|resume:|history:true");

    const detail2 = await f.ok(`/projects/${projectId}/codex-chat/sessions/${session.id}`);
    expect(detail2.session.resolved_target).toBe(`local:${a2.id}`);
    expect(detail2.session.external_session_id).toBe("thread_mac2_1");

    // Turn off auto_fallback while primary node a1 is still offline -> blocks with 409
    await f.ok(`/projects/${projectId}/execution-routing`, "PATCH", { auto_fallback: false });
    const r3 = await f.api(`/projects/${projectId}/codex-chat/sessions/${session.id}/messages`, "POST", {
      content: "should fail without fallback",
    });
    expect(r3.status).toBe(409);
    expect((await r3.json()).error).toContain("自动降级");
  });

  it("dispatches task discussion cli_runs to local Bridge without cloud API key and falls back to cloud queue when offline", async () => {
    f = await fixture();
    const projectId = await f.project("CLI Run Routing");
    const agent = await f.register("Mac Runner");

    const { task } = await f.ok(`/projects/${projectId}/tasks`, "POST", {
      title: "Check login issue",
      body: "Please inspect auth flow.",
      priority: "high",
      skip_prescreen: true,
    });

    // Without cloud API key and without any online bridge, discuss is rejected with 409
    const rejected = await f.api(`/tasks/${task.id}/discuss`, "POST", { body: "Explain root cause" });
    expect(rejected.status).toBe(409);

    // Connect local bridge with accept_cli_runs: true
    const homeDir = join(f.root, "home-cli");
    const repoDir = join(f.root, "repo-cli");
    const cfgDir = join(homeDir, ".config/relaydesk-bridge");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(cfgDir, { recursive: true });
    const bin = fakeCodexCli(homeDir, "clirun");
    const configPath = join(cfgDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        server_url: f.wsUrl,
        agent_token: agent.token,
        max_concurrency: 2,
        accept_cli_runs: true,
        auto_detect_cli_configs: false,
        runtimes: { codex: { bin } },
        projects: { [projectId]: { workdir: repoDir } },
      }),
      { mode: 0o600 },
    );
    const daemon = await startBridgeDaemon({
      configPath,
      cacheDir: join(homeDir, "cache"),
      homeDir,
      reconnectMinMs: 20,
      reconnectMaxMs: 60,
    });
    daemons.push(daemon);

    await expect
      .poll(
        async () => {
          const item = ((await f!.ok("/bridge/agents")).agents as Array<{
            id: string;
            online: boolean;
            accept_cli_runs: boolean;
            bindings: Array<{ project_id: string; path_ok: boolean }>;
          }>).find((x) => x.id === agent.id);
          return Boolean(
            item?.online &&
              item.accept_cli_runs &&
              item.bindings.some((b) => b.project_id === projectId && b.path_ok),
          );
        },
        { timeout: 5000, interval: 25 },
      )
      .toBe(true);

    // Now discuss succeeds even with NO cloud API key configured, and runs on local bridge
    const queued = await f.ok(`/tasks/${task.id}/discuss`, "POST", { body: "Analyze auth flow locally" });
    expect(queued.queued).toBe(true);
    expect(queued.target).toBe(`local:${agent.id}`);

    // Wait for local bridge to finish and persist assistant comment
    await expect
      .poll(
        async () => {
          const { runs } = await f!.ok(`/projects/${projectId}/tasks/${task.id}/cli-runs`);
          return runs[0]?.status;
        },
        { timeout: 6000, interval: 30 },
      )
      .toBe("succeeded");

    const taskDetail = await f.ok(`/tasks/${task.id}`);
    expect(
      taskDetail.messages.some(
        (m: { author: string; body: string }) =>
          m.author === "assistant" && m.body.includes("from:clirun"),
      ),
    ).toBe(true);

    // Disconnect bridge, configure cloud API key, and verify new discuss falls back to cloud queue
    await daemon.close();
    await expect
      .poll(
        async () =>
          ((await f!.ok("/bridge/agents")).agents as Array<{ id: string; online: boolean }>).find(
            (x) => x.id === agent.id,
          )?.online,
        { timeout: 4000, interval: 20 },
      )
      .toBe(false);

    await f.ok(`/projects/${projectId}/cli-config`, "PATCH", {
      runtime: "codex",
      api_key: "sk-cloud-fallback-key-1234",
      endpoint: "",
      model: "",
      public_ai_enabled: false,
    });
    const cloudQueued = await f.ok(`/tasks/${task.id}/discuss`, "POST", { body: "Run on cloud when local offline" });
    expect(cloudQueued.target).toBe("cloud");
    const { runs } = await f.ok(`/projects/${projectId}/tasks/${task.id}/cli-runs`);
    expect(runs[0].status).toBe("queued");
  });
});
