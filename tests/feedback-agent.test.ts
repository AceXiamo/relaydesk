import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalChat } from "../agent/bridge/runner.ts";
import {
  diagnoseFeedback,
  feedbackAgentAvailability,
  getFeedbackAgent,
  getFeedbackAgentStatus,
  parseFeedbackTriageOutput,
  patchFeedbackAgent,
  type FeedbackStreamEvent,
} from "../server/feedback-agent.ts";
import { saveStoredR2Config } from "../server/r2-config.ts";
import { Store } from "../server/store.ts";
import { writeBridgeWorkspaceFile } from "../server/workspace.ts";
import { fixture, type Fixture } from "./bridge-fixture.ts";

// Minimal valid 1x1 PNG bytes
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

const user = (text: string) => ({ role: "user" as const, text });
const assistant = (text: string) => ({ role: "assistant" as const, text });

describe("feedback agent configuration and legacy migration", () => {
  let dir: string;
  let dbPath: string;
  let store: Store;
  let projectId: string;
  let otherId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rd-fb-cfg-"));
    dbPath = join(dir, "test.sqlite");
    store = new Store(dbPath);
    projectId = store.createProject({ name: "Alpha", repo: "acme/alpha" }).id;
    otherId = store.createProject({ name: "Beta", repo: "acme/beta" }).id;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns safe defaults and allows saving even when no local node is online", () => {
    expect(getFeedbackAgent(store, projectId)).toEqual({
      enabled: false,
      execution_target: "auto",
      runtime: "codex",
      model: "",
      reasoning_effort: "default",
      system_prompt: "",
    });

    const updated = patchFeedbackAgent(store, projectId, {
      enabled: true,
      execution_target: "local:node-offline-1",
      runtime: "claude",
      model: "claude-sonnet-4-5",
      reasoning_effort: "medium",
      system_prompt: "先确认用户是否开启了自动同步选项。",
    });

    expect(updated).toEqual({
      enabled: true,
      execution_target: "local:node-offline-1",
      runtime: "claude",
      model: "claude-sonnet-4-5",
      reasoning_effort: "medium",
      system_prompt: "先确认用户是否开启了自动同步选项。",
    });
    expect(getFeedbackAgent(store, otherId).enabled).toBe(false);

    const status = getFeedbackAgentStatus(store, null, projectId);
    expect(status.available).toBe(false);
    expect(status.resolved_agent).toBeNull();
    expect(status.unavailable_reason).toBeTruthy();

    const pub = feedbackAgentAvailability(store, null, projectId);
    expect(pub).toEqual({ enabled: true, available: false });
    expect(Object.keys(pub).sort()).toEqual(["available", "enabled"]);
  });

  it("migrates legacy feedback_agents rows and public_guide idempotently", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "rd-fb-legacy-"));
    const legacyPath = join(legacyDir, "legacy.sqlite");
    try {
      const raw = new DatabaseSync(legacyPath);
      raw.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL,
          intake_key TEXT NOT NULL, bot_key TEXT NOT NULL, agent_key TEXT NOT NULL,
          allowed_origins TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
        );
        CREATE TABLE feedback_agents (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
          runtime TEXT NOT NULL CHECK(runtime IN ('codex','claude')),
          model TEXT NOT NULL,
          public_guide TEXT NOT NULL
        );
      `);
      raw
        .prepare(
          "INSERT INTO projects (id, name, repo, intake_key, bot_key, agent_key, allowed_origins, created_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?)",
        )
        .run("p_legacy", "Legacy", "acme/legacy", "ik_test", "bk_test", "ak_test", new Date().toISOString());
      raw
        .prepare(
          "INSERT INTO feedback_agents (project_id, enabled, runtime, model, public_guide) VALUES (?, 1, 'claude', 'claude-3-7', '老版本公开指南内容')",
        )
        .run("p_legacy");
      raw.close();

      // Re-open twice with Store to verify idempotency
      const s1 = new Store(legacyPath);
      const cfg1 = getFeedbackAgent(s1, "p_legacy");
      expect(cfg1).toEqual({
        enabled: true,
        execution_target: "auto",
        runtime: "claude",
        model: "claude-3-7",
        reasoning_effort: "default",
        system_prompt: "老版本公开指南内容",
      });
      // Clearing system_prompt must actually clear it and not resurrect public_guide
      patchFeedbackAgent(s1, "p_legacy", { system_prompt: "" });
      expect(getFeedbackAgent(s1, "p_legacy").system_prompt).toBe("");
      s1.close();

      const s2 = new Store(legacyPath);
      expect(getFeedbackAgent(s2, "p_legacy").system_prompt).toBe("");
      s2.close();
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("rejects secrets, project keys, cloud target, and invalid fields", () => {
    const row = store.getProjectRow(projectId);
    for (const bad of [
      {},
      { execution_target: "cloud" },
      { execution_target: "local:bad space" },
      { runtime: "gemini" },
      { model: "--inject" },
      { reasoning_effort: "extreme" },
      { unknown_field: true },
      { system_prompt: `Do not share ${row.intake_key}` },
      { system_prompt: `Key is ${row.agent_key}` },
      { system_prompt: "Use sk-live-secret1234567890" },
      { system_prompt: "Token: github_pat_1234567890abcdef" },
      { model: row.bot_key },
    ]) {
      expect(() => patchFeedbackAgent(store, projectId, bad)).toThrow();
    }
  });
});

describe("feedback agent Local Bridge execution, isolation, streaming, and SSRF protection", () => {
  let fx: Fixture;
  let projectId: string;
  let workdir: string;

  beforeEach(async () => {
    fx = await fixture();
    projectId = await fx.project("Feedback Demo");
    workdir = join(fx.root, "repo-alpha");
    mkdirSync(workdir, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fx.close();
  });

  it("resolves local:* nodes only, never falls back to cloud, and returns 503 when offline", async () => {
    const nodeA = await fx.register("Node A");
    const nodeB = await fx.register("Node B");

    // Put "cloud" first in project routing priority — feedback agent must completely ignore it.
    fx.srv.store.updateProjectExecutionRouting(projectId, {
      priority: ["cloud", `local:${nodeA.id}`, `local:${nodeB.id}`],
    });

    patchFeedbackAgent(fx.srv.store, projectId, {
      enabled: true,
      execution_target: "auto",
      runtime: "codex",
    });

    // Both nodes offline -> 503
    expect(
      getFeedbackAgentStatus(fx.srv.store, fx.srv.bridgeHub, projectId).available,
    ).toBe(false);
    await expect(
      diagnoseFeedback(fx.srv.store, fx.srv.bridgeHub, projectId, {
        messages: [user("导出按钮点不了")],
      }),
    ).rejects.toMatchObject({ status: 503 });

    // Connect node B only (accept_cli_runs: false should still be eligible for feedback diagnosis!)
    const connB = await fx.connect(nodeB.token);
    await connB.hello(
      [{ project_id: projectId, workdir, path_ok: true, path_error: "" }],
      {
        accept_cli_runs: false,
        runtimes: { codex: { available: true, default_model: "gpt-5.4" } },
      },
    );

    const autoStatus = getFeedbackAgentStatus(
      fx.srv.store,
      fx.srv.bridgeHub,
      projectId,
    );
    expect(autoStatus.available).toBe(true);
    expect(autoStatus.resolved_agent).toEqual({
      id: nodeB.id,
      name: "Node B",
      online: true,
      model: "gpt-5.4",
    });
    expect(autoStatus.unavailable_reason).toBeNull();

    // Pin explicitly to offline node A -> must NOT fall back to online node B or cloud!
    patchFeedbackAgent(fx.srv.store, projectId, {
      execution_target: `local:${nodeA.id}`,
    });
    const pinnedStatus = getFeedbackAgentStatus(
      fx.srv.store,
      fx.srv.bridgeHub,
      projectId,
    );
    expect(pinnedStatus.available).toBe(false);
    expect(pinnedStatus.resolved_agent).toMatchObject({
      id: nodeA.id,
      name: "Node A",
      online: false,
    });
    expect(pinnedStatus.unavailable_reason).toContain("离线");
    await expect(
      diagnoseFeedback(fx.srv.store, fx.srv.bridgeHub, projectId, {
        messages: [user("导出按钮点不了")],
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("enforces read-only public_feedback isolation, streams sanitized events, hides triage tag, and redacts paths/secrets", async () => {
    const node = await fx.register("Mac Studio");
    const conn = await fx.connect(node.token);
    await conn.hello(
      [{ project_id: projectId, workdir, path_ok: true, path_error: "" }],
      {
        runtimes: { codex: { available: true, default_model: "gpt-5.4" } },
      },
    );

    // Seed private workspace files that MUST NOT be readable during public_feedback
    writeBridgeWorkspaceFile(
      fx.srv.store.dbPath,
      projectId,
      "HANDBOOK.md",
      Buffer.from("INTERNAL SECRET HANDBOOK"),
    );
    writeBridgeWorkspaceFile(
      fx.srv.store.dbPath,
      projectId,
      "files/private.sqlite",
      Buffer.from("SQLite format 3\0secret"),
    );

    patchFeedbackAgent(fx.srv.store, projectId, {
      enabled: true,
      execution_target: `local:${node.id}`,
      runtime: "codex",
      model: "gpt-5.4",
      reasoning_effort: "low",
      system_prompt: "导出功能在报表页右上角。",
    });

    const projectRow = fx.srv.store.getProjectRow(projectId);
    const events: FeedbackStreamEvent[] = [];

    const diagnosePromise = diagnoseFeedback(
      fx.srv.store,
      fx.srv.bridgeHub,
      projectId,
      {
        messages: [user("我点导出一直报错 500")],
      },
      {
        onEvent: (ev) => events.push(ev),
      },
    );

    const startFrame = await conn.next("chat.start");
    expect(startFrame.payload.public_feedback).toBe(true);
    expect(startFrame.payload.sandbox_mode).toBe("read-only");
    expect(startFrame.payload.network_access).toBe(false);
    expect(startFrame.payload.resume_session_id).toBe("");
    expect(startFrame.payload.datasource_env).toBeUndefined();
    expect(startFrame.payload.workspace_manifest).toEqual({
      handbook: null,
      handbook_sha256: null,
      deploy_doc: null,
      deploy_doc_sha256: null,
      files: [],
      databases: [],
    });
    expect(startFrame.payload.system_context).toContain("导出功能在报表页右上角。");

    const runId = startFrame.payload.run_id as string;
    const sessionId = startFrame.payload.session_id as string;

    // 1. Attempt task.rpc during public_feedback -> MUST be rejected (403)
    const rpcId = conn.send("task.rpc", {
      run_id: runId,
      project_id: projectId,
      action: "list_tasks",
      params: {},
    });
    const rpcRes = await conn.next("task.rpc.result", rpcId);
    expect(rpcRes.payload.ok).toBe(false);
    expect(rpcRes.payload.status).toBe(403);

    // 2. Attempt workspace.fetch for HANDBOOK.md or private.sqlite -> MUST be rejected (403)
    const fetchDocId = conn.send("workspace.fetch", {
      project_id: projectId,
      run_id: runId,
      path: "HANDBOOK.md",
    });
    const fetchDocRes = await conn.next("workspace.fetch.result", fetchDocId);
    expect(fetchDocRes.payload.ok).toBe(false);
    expect(fetchDocRes.payload.status).toBe(403);

    const fetchDbId = conn.send("workspace.fetch", {
      project_id: projectId,
      run_id: runId,
      path: "files/private.sqlite",
    });
    const fetchDbRes = await conn.next("workspace.fetch.result", fetchDbId);
    expect(fetchDbRes.payload.ok).toBe(false);
    expect(fetchDbRes.payload.status).toBe(403);

    // 3. Emit raw tool events (with sensitive local paths) -> must be sanitized to friendly status
    conn.send("chat.event", {
      run_id: runId,
      session_id: sessionId,
      event: {
        type: "tool",
        event: {
          id: "t1",
          tool: "Read",
          summary: `${workdir}/src/export.ts`,
          status: "running",
          output: "const secret = 123;",
        },
      },
    });

    // 4. Stream response with split <relaydesk-triage> tag, local workdir path, and project key
    const chunks = [
      `已排查 ${workdir}/src/export.ts，确认是服务端空指针问题`,
      `（切勿使用 ${projectRow.intake_key}）。\n<relay`,
      `desk-triage>{"outcome":"suspected_bug","draft":{"title":"导出接口在 ${workdir} 触发 500","body":"点击导出后返回 500，相关密钥 ${projectRow.agent_key}。"}}</relaydesk-triage>`,
    ];
    for (const delta of chunks) {
      conn.send("chat.event", {
        run_id: runId,
        session_id: sessionId,
        event: { type: "text_delta", delta },
      });
    }
    conn.send("chat.event", {
      run_id: runId,
      session_id: sessionId,
      event: { type: "done" },
      result: {
        status: "done",
        content: chunks.join(""),
        events: [],
        externalSessionId: "",
      },
    });

    const result = await diagnosePromise;
    expect(result.outcome).toBe("suspected_bug");
    expect(result.reply).not.toContain("<relaydesk-triage");
    expect(result.reply).not.toContain(workdir);
    expect(result.reply).not.toContain(projectRow.intake_key);
    expect(result.reply).toContain("空指针问题");
    expect(result.draft?.title).not.toContain(workdir);
    expect(result.draft?.body).not.toContain(projectRow.agent_key);

    // Check streamed events: no raw paths, no tool names, no triage tags
    const statusLabels = events
      .filter((e) => e.type === "status")
      .map((e) => e.label);
    expect(statusLabels).toContain("正在查阅产品实现…");
    for (const label of statusLabels) {
      expect(label).not.toContain(workdir);
      expect(label).not.toContain("Read");
      expect(label).not.toContain("export.ts");
    }
    const streamedText = events
      .filter((e) => e.type === "delta")
      .map((e) => e.text)
      .join("");
    expect(streamedText).not.toContain("<relaydesk-triage");
    expect(streamedText).not.toContain(workdir);
    expect(streamedText).not.toContain(projectRow.intake_key);
    expect(streamedText).toContain("空指针问题");
  });

  it("stages whitelisted R2 screenshots for CLI vision, blocks SSRF URLs, and cleans up temp files", async () => {
    const node = await fx.register("Vision Node");
    const conn = await fx.connect(node.token);
    await conn.hello(
      [{ project_id: projectId, workdir, path_ok: true, path_error: "" }],
      {
        runtimes: { claude: { available: true, default_model: "claude-sonnet-4-5" } },
      },
    );

    saveStoredR2Config(fx.srv.store.dbPath, {
      account_id: "acct1234567890",
      bucket: "demo-bucket",
      access_key_id: "ak_demo_12345678",
      secret_access_key: "sk_demo_1234567890123456",
      public_url: "https://cdn.example.test/uploads",
      endpoint: "",
    });

    patchFeedbackAgent(fx.srv.store, projectId, {
      enabled: true,
      execution_target: `local:${node.id}`,
      runtime: "claude",
    });

    const fetchedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        fetchedUrls.push(url);
        expect(init?.redirect).toBe("error");
        if (url.endsWith("/valid.png")) {
          return new Response(PNG_BYTES, {
            status: 200,
            headers: { "Content-Type": "image/png" },
          });
        }
        if (url.endsWith("/fake.png")) {
          return new Response("not-an-image", {
            status: 200,
            headers: { "Content-Type": "image/png" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const events: FeedbackStreamEvent[] = [];
    const diagnosePromise = diagnoseFeedback(
      fx.srv.store,
      fx.srv.bridgeHub,
      projectId,
      {
        messages: [user("看下我附的报错截图")],
        images: [
          "https://cdn.example.test/uploads/p1/valid.png",
          "https://cdn.example.test/uploads/p1/fake.png",
          "https://evil.example.test/uploads/p1/steal.png",
          "http://127.0.0.1:8080/uploads/internal.png",
          "http://169.254.169.254/latest/meta-data",
        ],
      },
      { onEvent: (ev) => events.push(ev) },
    );

    const startFrame = await conn.next("chat.start");
    // Only the two whitelisted R2 URLs should ever have been fetched
    expect(fetchedUrls).toEqual([
      "https://cdn.example.test/uploads/p1/valid.png",
      "https://cdn.example.test/uploads/p1/fake.png",
    ]);

    // Only the magic-byte-verified PNG should be staged into workspace_manifest and image_paths
    expect(startFrame.payload.image_paths).toHaveLength(1);
    const relPath = startFrame.payload.image_paths[0] as string;
    expect(relPath).toMatch(/^_feedback_images\/[a-z0-9]+\/img-1\.png$/);
    expect(startFrame.payload.workspace_manifest.files).toHaveLength(1);
    expect(startFrame.payload.workspace_manifest.files[0].path).toBe(relPath);

    // Bridge CAN fetch the staged image via workspace.fetch
    const runId = startFrame.payload.run_id as string;
    const sessionId = startFrame.payload.session_id as string;
    const imgFetchId = conn.send("workspace.fetch", {
      project_id: projectId,
      run_id: runId,
      path: `files/${relPath}`,
    });
    const imgFetchRes = await conn.next("workspace.fetch.result", imgFetchId);
    expect(imgFetchRes.payload.ok).toBe(true);
    expect(Buffer.from(imgFetchRes.payload.data, "base64").equals(PNG_BYTES)).toBe(true);

    // Tool reading the image emits image analysis status
    conn.send("chat.event", {
      run_id: runId,
      session_id: sessionId,
      event: {
        type: "tool",
        event: {
          id: "t-img",
          tool: "Read",
          summary: `$RELAYDESK_SPACE_DIR/files/${relPath}`,
          status: "running",
        },
      },
    });
    conn.send("chat.event", {
      run_id: runId,
      session_id: sessionId,
      event: { type: "done" },
      result: {
        status: "done",
        content:
          '从截图看是权限开关未打开，请在设置页开启。\n<relaydesk-triage>{"outcome":"usage"}</relaydesk-triage>',
        events: [],
        externalSessionId: "",
      },
    });

    const res = await diagnosePromise;
    expect(res).toEqual({
      outcome: "usage",
      reply: "从截图看是权限开关未打开，请在设置页开启。",
    });
    expect(
      events.some((e) => e.type === "status" && e.label === "正在分析附带截图…"),
    ).toBe(true);

    // Temporary _feedback_images directory must be cleaned up after completion
    const feedbackImgRoot = join(
      fx.root,
      "workspaces",
      projectId,
      "files",
      "_feedback_images",
    );
    expect(
      !existsSync(feedbackImgRoot) || readdirSync(feedbackImgRoot).length === 0,
    ).toBe(true);
  });

  it("forces restricted localAccess and disables full_access & MCP in bridge runLocalChat for public_feedback", async () => {
    const binDir = join(fx.root, "fake-bin");
    const spaceDir = join(fx.root, "space");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(spaceDir, "files"), { recursive: true });

    const fakeCodex = join(binDir, "fake-codex");
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
const out = {
  argv: process.argv.slice(2),
  hasMcpToken: Boolean(process.env.RELAYDESK_MCP_TOKEN),
  hasDbEnv: Boolean(process.env.RELAYDESK_DB_MAIN),
};
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(out) } }));
`,
      { mode: 0o755 },
    );
    chmodSync(fakeCodex, 0o755);

    const turn = await runLocalChat({
      config: {
        codex_full_access: true,
        claude_full_access: true,
        runtimes: { codex: { bin: fakeCodex } },
      },
      catalog: {
        runtimes: {
          codex: { available: true, version: "1.0.0", default_model: "gpt-5.4" },
          claude: { available: false, version: "" },
        },
        models: [],
        db_clients: [],
      },
      p: {
        run_id: "r-pub-1",
        session_id: "feedback:1",
        project_id: projectId,
        runtime: "codex",
        model: "gpt-5.4",
        sandbox_mode: "workspace-write", // intentionally permissive — must be overridden!
        network_access: true, // intentionally permissive — must be overridden!
        prompt: "hello",
        workspace_manifest: { files: [] },
        datasource_env: { RELAYDESK_DB_MAIN: "postgres://user:pass@host/db" },
        public_feedback: true,
      },
      cwd: workdir,
      homeDir: fx.root,
      spaceDir,
      allowSecrets: true, // intentionally true — must be overridden!
      enableMcp: true, // intentionally true — must be overridden!
      signal: new AbortController().signal,
      prompt: "hello",
      onEvent: () => undefined,
    });

    expect(turn.status).toBe("done");
    const observed = JSON.parse(turn.content) as {
      argv: string[];
      hasMcpToken: boolean;
      hasDbEnv: boolean;
    };
    expect(observed.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(observed.argv).toContain("--sandbox");
    expect(observed.argv[observed.argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(observed.argv).toContain("sandbox_workspace_write.network_access=false");
    expect(observed.argv.join(" ")).not.toContain("mcp_servers.relaydesk");
    expect(observed.hasMcpToken).toBe(false);
    expect(observed.hasDbEnv).toBe(false);
  });
});

describe("parseFeedbackTriageOutput tolerance", () => {
  it("falls back gracefully to clarify when triage tag is missing or malformed without discarding reply", () => {
    expect(parseFeedbackTriageOutput("请问您是在哪个页面点击的？")).toEqual({
      outcome: "clarify",
      reply: "请问您是在哪个页面点击的？",
    });

    expect(
      parseFeedbackTriageOutput(
        "排查完成，请在右上角打开开关。\n<relaydesk-triage>{invalid json}</relaydesk-triage>",
      ),
    ).toEqual({
      outcome: "clarify",
      reply: "排查完成，请在右上角打开开关。",
    });

    expect(
      parseFeedbackTriageOutput(
        '确认可以复现。\n<relaydesk-triage>{"outcome":"suspected_bug","draft":{"title":"筛选失效","body":"点击重置后列表未刷新"}}</relaydesk-triage>',
      ),
    ).toEqual({
      outcome: "suspected_bug",
      reply: "确认可以复现。",
      draft: { title: "筛选失效", body: "点击重置后列表未刷新" },
    });
  });
});
