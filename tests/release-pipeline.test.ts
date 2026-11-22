import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../server/store.ts";
import {
  isInsideDeployWindow,
  ReleaseDispatcher,
  FAILED_RELEASE_COOLDOWN_MS,
} from "../server/release-dispatcher.ts";
import { buildTaskWorkflowSystemContext, ChatRunManager } from "../server/chat-run-manager.ts";
import { BridgeHub } from "../server/bridge-hub.ts";
import {
  readWorkspaceDeployDoc,
  writeWorkspaceDeployDoc,
  buildWorkspaceManifest,
} from "../server/workspace.ts";
import type { ProjectDeployPolicy } from "../app/lib/types.ts";
import { fixture, type Fixture } from "./bridge-fixture.ts";

describe("RD-6 SQLite migration & store invariants", () => {
  it("safely migrates a legacy schema with chat_sessions CHECK(kind IN ('chat','task')) and preserves chat_messages FKs", () => {
    const dir = mkdtempSync(join(tmpdir(), "relaydesk-rd6-mig-"));
    try {
      const dbPath = join(dir, "legacy.sqlite");
      const raw = new DatabaseSync(dbPath);
      raw.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          repo TEXT NOT NULL,
          repos TEXT NOT NULL DEFAULT '[]',
          intake_key TEXT NOT NULL,
          bot_key TEXT NOT NULL,
          agent_key TEXT NOT NULL,
          allowed_origins TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          agent_instructions TEXT NOT NULL DEFAULT '',
          automation_paused INTEGER NOT NULL DEFAULT 0,
          delivery_mode TEXT NOT NULL DEFAULT 'direct_push',
          widget_code_context INTEGER NOT NULL DEFAULT 1,
          execution_routing_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          number INTEGER NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          requirements TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'console',
          source_url TEXT NOT NULL DEFAULT '',
          priority TEXT NOT NULL DEFAULT 'normal',
          status TEXT NOT NULL DEFAULT 'triage',
          owner TEXT NOT NULL DEFAULT 'none',
          version INTEGER NOT NULL DEFAULT 1,
          attempts INTEGER NOT NULL DEFAULT 0,
          resolution TEXT,
          delivery_ref TEXT NOT NULL DEFAULT '',
          triaged_by TEXT NOT NULL DEFAULT '',
          merged_into TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, number)
        );
        CREATE TABLE chat_sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat', 'task')),
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          title TEXT NOT NULL DEFAULT '新对话',
          runtime TEXT NOT NULL DEFAULT 'codex' CHECK(runtime IN ('codex', 'claude')),
          model TEXT NOT NULL DEFAULT '',
          sandbox_mode TEXT NOT NULL DEFAULT 'read-only' CHECK(sandbox_mode IN ('read-only', 'workspace-write')),
          network_access INTEGER NOT NULL DEFAULT 0,
          execution_target TEXT NOT NULL DEFAULT 'auto',
          resolved_target TEXT NOT NULL DEFAULT '',
          reasoning_effort TEXT NOT NULL DEFAULT 'default',
          external_session_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'running')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE chat_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          attachments_json TEXT NOT NULL DEFAULT '[]',
          events_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );
      `);

      const now = "2026-11-20T00:00:00.000Z";
      raw.prepare(
        `INSERT INTO projects (id, name, repo, intake_key, bot_key, agent_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("proj_legacy", "Legacy App", "acme/legacy", "ik_1", "bk_1", "ak_1", now);
      raw.prepare(
        `INSERT INTO chat_sessions (id, project_id, kind, title, created_at, updated_at) VALUES (?, ?, 'chat', ?, ?, ?)`,
      ).run("sess_legacy", "proj_legacy", "Old chat", now, now);
      raw.prepare(
        `INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
      ).run("msg_legacy", "sess_legacy", "Keep me safe!", now);
      raw.close();

      // Open via Store -> triggers migrations
      const store = new Store(dbPath);
      const checkDb = new DatabaseSync(dbPath);
      expect(checkDb.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      checkDb.close();

      // Existing sessions & messages intact
      const existingSession = store.getChatSession("proj_legacy", "sess_legacy");
      expect(existingSession.title).toBe("Old chat");
      expect(existingSession.release_id).toBeNull();
      const messages = store.listChatMessages("proj_legacy", "sess_legacy");
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Keep me safe!");

      // Default deploy policy applied to legacy project
      const project = store.getProjectDetail("proj_legacy");
      expect(project.deploy_policy).toMatchObject({ mode: "none", runtime: null, model: null });

      // New kind='release' session and releases table work cleanly
      const { release: rel, session: relSession } = store.createRelease("proj_legacy", {
        trigger: "manual",
        taskIds: [],
      });
      expect(rel.number).toBe(1);
      expect(relSession.kind).toBe("release");
      expect(relSession.release_id).toBe(rel.id);

      // Re-opening is idempotent
      store.close();
      const reopened = new Store(dbPath);
      expect(reopened.getRelease("proj_legacy", rel.id).number).toBe(1);
      reopened.close();
      const checkDb2 = new DatabaseSync(dbPath);
      expect(checkDb2.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      checkDb2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tracks task deploy_status lifecycle: mode=none vs manual, dismissed/merged, needs_deploy=false, and reopen reset", () => {
    const store = new Store(":memory:");
    try {
      const p = store.createProject({ name: "DeployTest", repo: "acme/app" });

      // Default mode='none': done(shipped) stays not_required
      const tNone = store.createTask(p.id, { title: "Under mode none", body: "b" }, "console");
      store.chatAgentTaskOp(p.id, "transition_task", {
        task: tNone.id,
        status: "done",
        resolution: "shipped",
      });
      expect(store.getTaskView(tNone.id).deploy_status).toBe("not_required");

      // Switch to mode='manual'
      store.updateProjectDeployPolicy(p.id, { mode: "manual" });

      // Shipped -> pending
      const tShip = store.createTask(p.id, { title: "Feature A", body: "b" }, "console");
      store.chatAgentTaskOp(p.id, "transition_task", {
        task: tShip.id,
        status: "done",
        resolution: "shipped",
        delivery_ref: "main@1111111",
      });
      const shipped = store.getTaskView(tShip.id);
      expect(shipped.deploy_status).toBe("pending");

      // Shipped with needs_deploy: false -> not_required
      const tDocOnly = store.createTask(p.id, { title: "README typo", body: "b" }, "console");
      store.chatAgentTaskOp(p.id, "transition_task", {
        task: tDocOnly.id,
        status: "done",
        resolution: "shipped",
        needs_deploy: false,
      });
      expect(store.getTaskView(tDocOnly.id).deploy_status).toBe("not_required");

      // Dismissed -> not_required
      const tDismiss = store.createTask(p.id, { title: "Spam", body: "b" }, "console");
      store.chatAgentTaskOp(p.id, "transition_task", {
        task: tDismiss.id,
        status: "done",
        resolution: "dismissed",
      });
      expect(store.getTaskView(tDismiss.id).deploy_status).toBe("not_required");

      // Reopen a pending task -> resets deploy_status to not_required
      const { task: reopened } = store.operatorAction(tShip.id, {
        action: "reopen",
        version: shipped.version,
      });
      expect(reopened.status).toBe("ready");
      expect(reopened.deploy_status).toBe("not_required");
      expect(reopened.deployed_at).toBeNull();
      expect(reopened.release_id).toBeNull();

      // Ship again, release & succeed -> deployed + deployed_at set; then reopen -> resets cleanly
      store.chatAgentTaskOp(p.id, "transition_task", {
        task: tShip.id,
        status: "done",
        resolution: "shipped",
      });
      expect(store.getTaskView(tShip.id).deploy_status).toBe("pending");
      const { release: rel } = store.createRelease(p.id, {
        trigger: "manual",
        taskIds: [tShip.id],
      });
      expect(store.getTaskView(tShip.id).deploy_status).toBe("deploying");
      expect(store.getTaskView(tShip.id).release_id).toBe(rel.id);

      const { release: finished } = store.finishRelease(p.id, rel.id, {
        status: "succeeded",
        deploy_ref: "prod@2222222",
        summary: "Deployed cleanly.",
      });
      expect(finished.status).toBe("succeeded");
      const deployedTask = store.getTaskView(tShip.id);
      expect(deployedTask.deploy_status).toBe("deployed");
      expect(deployedTask.deployed_at).toBeTruthy();
      expect(deployedTask.release_number).toBe(1);

      const { task: reopenedAfterDeploy } = store.operatorAction(tShip.id, {
        action: "reopen",
        version: deployedTask.version,
      });
      expect(reopenedAfterDeploy.deploy_status).toBe("not_required");
      expect(reopenedAfterDeploy.deployed_at).toBeNull();
      expect(reopenedAfterDeploy.release_id).toBeNull();
    } finally {
      store.close();
    }
  });

  it("recovers interrupted running release sessions on startup", () => {
    const store = new Store(":memory:");
    try {
      const p = store.createProject({ name: "Recovery", repo: "acme/rec" });
      store.updateProjectDeployPolicy(p.id, { mode: "immediate" });
      const t = store.createTask(p.id, { title: "Ship me", body: "b" }, "console");
      store.chatAgentTaskOp(p.id, "transition_task", {
        task: t.id,
        status: "done",
        resolution: "shipped",
      });
      const { release: rel, session: sess } = store.createRelease(p.id, {
        trigger: "immediate",
        taskIds: [t.id],
      });
      store.updateChatSession(p.id, sess.id, { status: "running" });

      expect(store.hasActiveAgentTask(p.id)).toBe(true);
      const recovered = store.recoverInterruptedSessionRuns();
      expect(recovered).toEqual({
        recoveredSessions: 1,
        recoveredTasks: 0,
        recoveredReleases: 1,
      });

      const relAfter = store.getRelease(p.id, rel.id);
      expect(relAfter.status).toBe("verifying");
      expect(relAfter.finished_at).toBeNull();
      expect(relAfter.summary).toContain("待验收");
      const taskAfter = store.getTaskView(t.id);
      expect(taskAfter.deploy_status).toBe("deploying");
      expect(taskAfter.release_id).toBe(rel.id);
      expect(store.getChatSession(p.id, sess.id).status).toBe("idle");
      expect(store.hasActiveAgentTask(p.id)).toBe(false);
      expect(store.hasActiveRelease(p.id)).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("RD-6 deploy window calculation & ReleaseDispatcher scheduling logic", () => {
  const basePolicy: ProjectDeployPolicy = {
    mode: "scheduled",
    window_start: "02:00",
    window_end: "06:00",
    timezone: "Asia/Shanghai",
    allow_urgent_override: true,
    runtime: null,
    model: null,
    doc_path: "",
  };

  it("handles normal and cross-midnight IANA timezone windows accurately", () => {
    // 2026-11-23T03:00:00+08:00 == 2026-11-22T19:00:00Z -> inside 02:00-06:00 Asia/Shanghai
    expect(isInsideDeployWindow(basePolicy, new Date("2026-11-22T19:00:00Z"))).toBe(true);
    // 2026-11-23T01:59:00+08:00 == 2026-11-22T17:59:00Z -> outside
    expect(isInsideDeployWindow(basePolicy, new Date("2026-11-22T17:59:00Z"))).toBe(false);
    // 2026-11-23T06:00:00+08:00 == 2026-11-22T22:00:00Z -> end exclusive
    expect(isInsideDeployWindow(basePolicy, new Date("2026-11-22T22:00:00Z"))).toBe(false);

    // Cross-midnight window: 22:00 - 06:00 Asia/Shanghai
    const overnight: ProjectDeployPolicy = {
      ...basePolicy,
      window_start: "22:00",
      window_end: "06:00",
    };
    // 23:30+08:00 == 15:30Z -> inside
    expect(isInsideDeployWindow(overnight, new Date("2026-11-22T15:30:00Z"))).toBe(true);
    // 02:30+08:00 == 18:30Z -> inside
    expect(isInsideDeployWindow(overnight, new Date("2026-11-22T18:30:00Z"))).toBe(true);
    // 14:00+08:00 == 06:00Z -> outside
    expect(isInsideDeployWindow(overnight, new Date("2026-11-22T06:00:00Z"))).toBe(false);

    // Equal start/end means 24h open
    expect(
      isInsideDeployWindow({ ...basePolicy, window_start: "00:00", window_end: "00:00" }, new Date()),
    ).toBe(true);
  });

  it("evaluates queue-idle batching, scheduled window, urgent override, circuit breaker, and cooldown", () => {
    const store = new Store(":memory:");
    const bridgeHub = new BridgeHub(store);
    const chatRuns = new ChatRunManager(store, bridgeHub);
    let nowMs = Date.parse("2026-11-22T06:00:00Z"); // 14:00 Asia/Shanghai (outside 02:00-06:00)

    const dispatcher = new ReleaseDispatcher(store, bridgeHub, chatRuns, {
      now: () => new Date(nowMs),
      pollIntervalMs: 0,
    });

    try {
      const p = store.createProject({ name: "SchedApp", repo: "acme/sched" });
      store.updateProjectDeployPolicy(p.id, {
        mode: "scheduled",
        window_start: "02:00",
        window_end: "06:00",
        timezone: "Asia/Shanghai",
        allow_urgent_override: true,
      });

      // Normal shipped task + another ready task -> blocked by pending_tasks_remaining
      const t1 = store.createTask(p.id, { title: "Task 1", body: "b", priority: "normal" }, "console");
      const t2 = store.createTask(p.id, { title: "Task 2", body: "b", priority: "normal" }, "console");
      store.chatAgentTaskOp(p.id, "transition_task", {
        task: t1.id,
        status: "done",
        resolution: "shipped",
      });
      store.chatAgentTaskOp(p.id, "transition_task", {
        task: t2.id,
        status: "ready",
      });

      expect(dispatcher.evaluateProject(p.id)).toMatchObject({
        eligible: false,
        reason: "ready_queue_not_empty",
      });

      // Finish t2 as well -> now queue is idle, but outside 02:00-06:00 window
      store.chatAgentTaskOp(p.id, "transition_task", {
        task: t2.id,
        status: "done",
        resolution: "shipped",
      });
      expect(dispatcher.evaluateProject(p.id)).toMatchObject({
        eligible: false,
        reason: "outside_deploy_window",
      });

      // Advance clock into 03:00 Asia/Shanghai (19:00Z) -> triggers scheduled release batching both tasks!
      nowMs = Date.parse("2026-11-22T19:00:00Z");
      const inWindow = dispatcher.evaluateProject(p.id);
      expect(inWindow.eligible).toBe(true);
      expect(inWindow.trigger).toBe("scheduled");
      expect((inWindow.tasks ?? []).map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());

      // Outside window again, add an urgent shipped task -> urgent override!
      nowMs = Date.parse("2026-11-22T06:00:00Z"); // 14:00+08
      const tUrgent = store.createTask(p.id, { title: "Hotfix", body: "b", priority: "urgent" }, "console");
      store.chatAgentTaskOp(p.id, "transition_task", {
        task: tUrgent.id,
        status: "done",
        resolution: "shipped",
      });
      const urgentCheck = dispatcher.evaluateProject(p.id);
      expect(urgentCheck.eligible).toBe(true);
      expect(urgentCheck.trigger).toBe("urgent");

      // Disable allow_urgent_override -> held outside window
      store.updateProjectDeployPolicy(p.id, { allow_urgent_override: false });
      expect(dispatcher.evaluateProject(p.id)).toMatchObject({
        eligible: false,
        reason: "outside_deploy_window",
      });

      // Switch to immediate mode + simulate a failed release -> circuit breaker halts auto-retry
      store.updateProjectDeployPolicy(p.id, { mode: "immediate" });
      const { release: rel1 } = store.createRelease(p.id, {
        trigger: "immediate",
        taskIds: [t1.id, t2.id, tUrgent.id],
      });
      store.finishRelease(p.id, rel1.id, { status: "failed", summary: "SSH failed" });

      // All 3 tasks are failed, 0 pending -> circuit breaker stops auto-retry
      expect(dispatcher.evaluateProject(p.id)).toMatchObject({
        eligible: false,
        reason: "no_pending_tasks",
      });

      // A new pending task arrives immediately after failure -> respects cooldown first
      const tNew = store.createTask(p.id, { title: "Fix deploy script", body: "b" }, "console");
      store.chatAgentTaskOp(p.id, "transition_task", {
        task: tNew.id,
        status: "done",
        resolution: "shipped",
      });
      nowMs = Date.now() + 1000; // within FAILED_RELEASE_COOLDOWN_MS of rel1.finished_at
      expect(dispatcher.evaluateProject(p.id)).toMatchObject({
        eligible: false,
        reason: "failed_cooldown",
      });

      // After cooldown passes -> auto-release batches new pending task + previously failed tasks
      nowMs = Date.now() + FAILED_RELEASE_COOLDOWN_MS + 5000;
      const recoveredCheck = dispatcher.evaluateProject(p.id);
      expect(recoveredCheck.eligible).toBe(true);
      expect(recoveredCheck.trigger).toBe("immediate");
      const recoveredIds = (recoveredCheck.tasks ?? []).map((t) => t.id);
      expect(recoveredIds).toContain(tNew.id);
      expect(recoveredIds).toContain(t1.id);
    } finally {
      dispatcher.close();
      store.close();
    }
  });

  it("instructs regular task agents NOT to deploy production when deploy_policy.mode !== 'none'", () => {
    const store = new Store(":memory:");
    try {
      const p = store.createProject({ name: "PromptGuard", repo: "acme/guard" });
      const t = store.createTask(p.id, { title: "Add button", body: "b" }, "console");

      const promptNone = buildTaskWorkflowSystemContext(store.getProjectDetail(p.id), t.number);
      expect(promptNone).not.toContain("Do NOT deploy to production");

      store.updateProjectDeployPolicy(p.id, { mode: "scheduled" });
      const promptScheduled = buildTaskWorkflowSystemContext(store.getProjectDetail(p.id), t.number);
      expect(promptScheduled).toContain("Do NOT deploy to production");
      expect(promptScheduled).toContain("needs_deploy: false");
    } finally {
      store.close();
    }
  });
});

describe("RD-6 end-to-end API, Bridge Release Agent, Concurrency Lock, Abnormal Exit & MCP", () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.close(); });

  it("validates deploy-policy & DEPLOY.md APIs, runs auto-immediate batch release, handles finish_release MCP, and enforces concurrency lock", async () => {
    const projectId = await f.project("Release E2E");
    const { token } = await f.register("deploy-mac");
    const conn = await f.connect(token);
    await conn.hello([{ project_id: projectId, workdir: "/repo/e2e", path_ok: true }], {
      runtimes: { codex: { available: true }, claude: { available: true } },
    });

    // 1. Validate deploy-policy REST API
    const badTz = await f.api(`/projects/${projectId}/deploy-policy`, "PUT", {
      mode: "scheduled",
      timezone: "Mars/Olympus_Mons",
    });
    expect(badTz.status).toBe(400);

    const badTime = await f.api(`/projects/${projectId}/deploy-policy`, "PUT", {
      mode: "scheduled",
      window_start: "25:99",
    });
    expect(badTime.status).toBe(400);

    for (const invalid of [{ runtime: "unknown" }, { runtime: "claude", model: "bad model" }]) {
      expect((await f.api(`/projects/${projectId}/deploy-policy`, "PUT", invalid)).status).toBe(400);
    }
    const policyRes = await f.ok(`/projects/${projectId}/deploy-policy`, "PUT", {
      mode: "immediate",
      runtime: "claude",
      model: "release-model",
      doc_path: "",
    });
    expect(policyRes.deploy_policy).toMatchObject({ mode: "immediate", runtime: "claude", model: "release-model" });
    expect((await f.ok(`/projects/${projectId}/deploy-policy`)).deploy_policy).toEqual(policyRes.deploy_policy);

    // 2. Save and read workspace DEPLOY.md and verify manifest includes deploy_doc
    const docBefore = await f.ok(`/projects/${projectId}/workspace/deploy-doc`);
    expect(docBefore.deploy_doc.exists).toBe(false);

    const savedDoc = await f.ok(`/projects/${projectId}/workspace/deploy-doc`, "PUT", {
      content: "# Deploy Guide\nRun `./scripts/deploy.sh` and curl `/api/health`.",
    });
    expect(savedDoc.deploy_doc.exists).toBe(true);
    expect(savedDoc.deploy_doc.content).toContain("./scripts/deploy.sh");

    const diskDoc = readWorkspaceDeployDoc(f.dbPath, projectId);
    expect(diskDoc.exists).toBe(true);
    writeWorkspaceDeployDoc(f.dbPath, projectId, diskDoc.content);
    const manifest = buildWorkspaceManifest(f.dbPath, projectId);
    expect(manifest.deploy_doc).not.toBeNull();
    expect(manifest.deploy_doc?.sha256).toMatch(/^[0-9a-f]{64}$/);

    // 3. Enable auto_dispatch_tasks and create a task -> task agent finishes via MCP transition_task
    await f.ok(`/projects/${projectId}/execution-routing`, "PATCH", {
      auto_dispatch_tasks: true, task_runtime: "codex", task_model: "task-model",
    });
    const created = await f.ok(`/projects/${projectId}/tasks`, "POST", {
      title: "修复首页加载闪烁",
      body: "首屏渲染闪烁",
    });
    const taskStart = await conn.next("chat.start");
    expect(taskStart.payload).toMatchObject({ runtime: "codex", model: "task-model" });
    expect(String(taskStart.payload.system_context)).toContain("Do NOT deploy to production");

    // Task Agent transitions task to done (shipped) -> enters deploy_status='pending'
    const rpcDoneId = conn.send("task.rpc", {
      run_id: taskStart.payload.run_id,
      project_id: projectId,
      action: "transition_task",
      params: {
        task: "RD-1",
        status: "done",
        resolution: "shipped",
        delivery_ref: "main@aaaa111",
        comment: "代码已提交推送",
      },
    });
    const rpcDoneRes = await conn.next("task.rpc.result", rpcDoneId);
    expect(rpcDoneRes.payload.ok).toBe(true);

    // Finish task turn -> ReleaseDispatcher should automatically start REL-1!
    conn.send("chat.event", {
      run_id: taskStart.payload.run_id,
      session_id: taskStart.payload.session_id,
      event: { type: "done" },
      result: { content: "Task done", events: [], status: "done", externalSessionId: "" },
    });

    const releaseStart = await conn.next("chat.start");
    expect(releaseStart.payload).toMatchObject({ runtime: "claude", model: "release-model" });
    expect(String(releaseStart.payload.system_context)).toContain("REL-1");
    expect(String(releaseStart.payload.system_context)).toContain("DEPLOY.md");
    expect(String(releaseStart.payload.prompt)).toContain("RD-1");

    // Release session is visible via ?kind=release and isolated from default ?kind=chat
    const relSessions = await f.ok(`/projects/${projectId}/codex-chat/sessions?kind=release`);
    expect(relSessions.sessions).toHaveLength(1);
    expect(relSessions.sessions[0].kind).toBe("release");
    const chatSessions = await f.ok(`/projects/${projectId}/codex-chat/sessions`);
    expect(chatSessions.sessions).toHaveLength(0);

    // 4. Concurrency lock: while REL-1 is running, a new task must stay queued & manual trigger must 409
    const queuedTask = await f.ok(`/projects/${projectId}/tasks`, "POST", {
      title: "发布期间新到的反馈",
      body: "必须等待 REL-1 结束后再派发",
    });
    await new Promise((r) => setTimeout(r, 80));
    expect((await f.ok(`/tasks/${queuedTask.task.id}`)).task.status).toBe("triage");

    const dupTrigger = await f.api(`/projects/${projectId}/releases/trigger`, "POST", { force: true });
    expect(dupTrigger.status).toBe(409);

    // 5. MCP list_releases & list_tasks(deploy_status) & finish_release work via bridge task.rpc
    const listRelId = conn.send("task.rpc", {
      run_id: releaseStart.payload.run_id,
      project_id: projectId,
      action: "list_releases",
      params: { limit: 10 },
    });
    const listRelRes = await conn.next("task.rpc.result", listRelId);
    expect(listRelRes.payload.ok).toBe(true);
    expect(listRelRes.payload.data.releases[0]).toMatchObject({
      number: 1,
      status: "running",
      code: "REL-1",
    });

    const listDeployTasksId = conn.send("task.rpc", {
      run_id: releaseStart.payload.run_id,
      project_id: projectId,
      action: "list_tasks",
      params: { deploy_status: "deploying", include_done: true },
    });
    const listDeployTasksRes = await conn.next("task.rpc.result", listDeployTasksId);
    expect(listDeployTasksRes.payload.ok).toBe(true);
    expect(listDeployTasksRes.payload.data.tasks.map((t: { id: string }) => t.id)).toEqual([
      created.task.id,
    ]);

    const finishId = conn.send("task.rpc", {
      run_id: releaseStart.payload.run_id,
      project_id: projectId,
      action: "finish_release",
      params: {
        release_id: listRelRes.payload.data.releases[0].id,
        status: "succeeded",
        deploy_ref: "main@aaaa111",
        summary: "已通过部署脚本发布并完成 /api/health 验收。",
      },
    });
    const finishRes = await conn.next("task.rpc.result", finishId);
    expect(finishRes.payload.ok).toBe(true);

    // Close the Release Agent turn -> releases lock, and queued task RD-2 should auto-dispatch!
    conn.send("chat.event", {
      run_id: releaseStart.payload.run_id,
      session_id: releaseStart.payload.session_id,
      event: { type: "done" },
      result: { content: "Released!", events: [], status: "done", externalSessionId: "" },
    });

    const task2Start = await conn.next("chat.start");
    expect(String(task2Start.payload.prompt)).toContain("RD-2");

    // Verify REL-1 and RD-1 final states via REST API
    const releasesApi = await f.ok(`/projects/${projectId}/releases`);
    expect(releasesApi.releases[0]).toMatchObject({
      number: 1,
      status: "succeeded",
      trigger: "immediate",
      deploy_ref: "main@aaaa111",
    });
    const rd1 = await f.ok(`/tasks/${created.task.id}`);
    expect(rd1.task.deploy_status).toBe("deployed");
    expect(rd1.task.deployed_at).toBeTruthy();

    // Cleanly end RD-2 turn
    conn.send("chat.event", {
      run_id: task2Start.payload.run_id,
      session_id: task2Start.payload.session_id,
      event: { type: "done" },
      result: { content: "ok", events: [], status: "done", externalSessionId: "" },
    });
  });

  it.each(["scheduled", "urgent"] as const)("uses the project release selection for the %s trigger", async (trigger) => {
    const projectId = await f.project();
    const { token } = await f.register();
    const conn = await f.connect(token);
    await conn.hello([{ project_id: projectId, workdir: "/repo", path_ok: true }], {
      runtimes: { claude: { available: true } },
    });
    const { store, bridgeHub, api } = f.srv;
    store.updateProjectDeployPolicy(projectId, {
      mode: "scheduled", timezone: "UTC", window_start: "02:00", window_end: "06:00",
      runtime: "claude", model: "release-model",
    });
    const task = store.createTask(projectId, { title: "Release change", body: "Deploy the pending change", priority: "urgent" }, "console");
    store.chatAgentTaskOp(projectId, "transition_task", { task: task.id, status: "done" });
    const now = new Date(trigger === "scheduled" ? "2026-11-23T03:00:00Z" : "2026-11-23T09:00:00Z");
    const dispatcher = new ReleaseDispatcher(store, bridgeHub, api.chatRuns, { now: () => now, pollIntervalMs: 0 });
    try {
      const result = dispatcher.tryDispatchProject(projectId);
      expect(result.dispatched).toBe(true);
      expect(store.getRelease(projectId, result.releaseId!).trigger).toBe(trigger);
      expect((await conn.next("chat.start")).payload).toMatchObject({ runtime: "claude", model: "release-model" });
    } finally {
      dispatcher.close();
    }
  });

  it("inherits task routing until configured and keeps manual overrides scoped to one release", async () => {
    const projectId = await f.project();
    const api = `/projects/${projectId}`;
    const { token } = await f.register();
    const conn = await f.connect(token);
    await conn.hello([{ project_id: projectId, workdir: "/repo", path_ok: true }], {
      runtimes: { codex: { available: true }, claude: { available: true } },
    });
    await f.ok(`${api}/execution-routing`, "PATCH", { task_runtime: "codex", task_model: "task-model" });
    async function checkRelease(overrides: Record<string, string>, expectedRuntime: string, expectedModel: string) {
      const started = await f.ok(`${api}/releases/trigger`, "POST", { force: true, ...overrides });
      const { payload } = await conn.next("chat.start");
      expect(started.session).toMatchObject({ runtime: expectedRuntime, model: expectedModel });
      expect(payload).toMatchObject({ runtime: expectedRuntime, model: expectedModel });
      conn.send("chat.event", { run_id: payload.run_id, session_id: payload.session_id, event: { type: "done" },
        result: { content: "done", events: [], status: "done", externalSessionId: "" } });
      await expect.poll(() => f.srv.store.getChatSession(projectId, payload.session_id).status).toBe("idle");
    }
    await checkRelease({}, "codex", "task-model");
    await f.ok(`${api}/deploy-policy`, "PUT", { runtime: "claude" });
    await checkRelease({}, "claude", "");
    await f.ok(`${api}/deploy-policy`, "PUT", { model: "release-model" });
    await checkRelease({ runtime: "codex", model: "one-off" }, "codex", "one-off");
    await checkRelease({ runtime: "codex" }, "codex", "");
    await checkRelease({}, "claude", "release-model");
    await f.ok(`${api}/deploy-policy`, "PUT", { runtime: null });
    await checkRelease({}, "codex", "task-model");
  });

  it("handles manual force release and marks release failed on abnormal session exit without finish_release", async () => {
    const projectId = await f.project("Manual Release");
    const { token } = await f.register("deploy-mac-2");
    const conn = await f.connect(token);
    await conn.hello([{ project_id: projectId, workdir: "/repo/manual", path_ok: true }]);

    await f.ok(`/projects/${projectId}/deploy-policy`, "PUT", { mode: "manual" });

    // Trigger with empty queue and force=false -> rejected (400)
    const emptyRes = await f.api(`/projects/${projectId}/releases/trigger`, "POST", {});
    expect(emptyRes.status).toBe(400);

    // Trigger with force=true -> starts REL-1
    const triggered = await f.ok(`/projects/${projectId}/releases/trigger`, "POST", {
      force: true,
      prompt: "重新构建一次生产镜像",
    });
    expect(triggered.release.number).toBe(1);
    expect(triggered.release.trigger).toBe("manual");

    const relStart = await conn.next("chat.start");
    expect(String(relStart.payload.prompt)).toContain("重新构建一次生产镜像");

    // Agent exits WITHOUT calling finish_release -> fallback marks REL-1 as failed
    conn.send("chat.event", {
      run_id: relStart.payload.run_id,
      session_id: relStart.payload.session_id,
      event: { type: "done" },
      result: { content: "Oops forgot to finish_release", events: [], status: "done", externalSessionId: "" },
    });

    await expect
      .poll(async () => (await f.ok(`/projects/${projectId}/releases/${triggered.release.id}`)).release.status, {
        timeout: 4000,
        interval: 25,
      })
      .toBe("failed");

    const relDetail = await f.ok(`/projects/${projectId}/releases/${triggered.release.id}`);
    expect(relDetail.release.summary).toContain("finish_release");
  });
});

describe("RD-9 self-restart verification recovery, MCP tools & reverify", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await fixture();
  });

  afterEach(async () => {
    await f.close();
  });

  it("migrates legacy releases table without verifying status or verification columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "relaydesk-rd9-mig-"));
    try {
      const dbPath = join(dir, "legacy-releases.sqlite");
      const raw = new DatabaseSync(dbPath);
      raw.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          repo TEXT NOT NULL,
          repos TEXT NOT NULL DEFAULT '[]',
          intake_key TEXT NOT NULL,
          bot_key TEXT NOT NULL,
          agent_key TEXT NOT NULL,
          allowed_origins TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          agent_instructions TEXT NOT NULL DEFAULT '',
          automation_paused INTEGER NOT NULL DEFAULT 0,
          delivery_mode TEXT NOT NULL DEFAULT 'direct_push',
          deploy_policy_json TEXT NOT NULL DEFAULT '{}',
          widget_code_context INTEGER NOT NULL DEFAULT 1,
          execution_routing_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE releases (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          number INTEGER NOT NULL,
          trigger TEXT NOT NULL CHECK(trigger IN ('immediate','scheduled','urgent','manual')),
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed','blocked')),
          session_id TEXT,
          task_ids_json TEXT NOT NULL DEFAULT '[]',
          task_snapshot_json TEXT NOT NULL DEFAULT '[]',
          deploy_ref TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          UNIQUE(project_id, number)
        );
      `);
      const now = "2026-11-22T22:00:00.000Z";
      raw.prepare(
        `INSERT INTO projects (id, name, repo, intake_key, bot_key, agent_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("proj_rd9", "RelayDesk", "AceXiamo/relaydesk", "ik_1", "bk_1", "ak_1", now);
      raw.prepare(
        `INSERT INTO releases (id, project_id, number, trigger, status, summary, created_at, updated_at, finished_at)
         VALUES (?, ?, 2, 'immediate', 'failed', 'Server restarted while release session was running.', ?, ?, ?)`,
      ).run("rel_2", "proj_rd9", now, now, now);
      raw.close();

      const store = new Store(dbPath);
      try {
        const rel = store.getRelease("proj_rd9", "REL-2");
        expect(rel.status).toBe("failed");
        expect(rel.target_sha).toBe("");
        expect(rel.verification_context).toEqual({});

        // Verify new 'verifying' status is permitted by migrated CHECK constraint
        const updated = store.finishRelease("proj_rd9", "REL-2", {
          status: "verifying",
          target_sha: "fd99c350dfbc9f6485d4c97f649b9f350fd28e67",
          summary: "Awaiting health check evidence",
        });
        expect(updated.release.status).toBe("verifying");
        expect(updated.release.target_sha).toBe("fd99c350dfbc9f6485d4c97f649b9f350fd28e67");
        expect(updated.release.verification_context.previous_failure_summary).toContain(
          "Server restarted while release session was running.",
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists checkpoint before cutover, moves to verifying on disconnect, and auto-resumes verify-only on reconnect", async () => {
    const projectId = await f.project("RelayDesk Self");
    const { token } = await f.register("mac-self-deploy");
    const conn1 = await f.connect(token);
    await conn1.hello([{ project_id: projectId, workdir: "/repo/relaydesk", path_ok: true }]);

    await f.ok(`/projects/${projectId}/deploy-policy`, "PUT", { mode: "manual" });

    const created = await f.ok(`/projects/${projectId}/tasks`, "POST", {
      title: "RD-7 mobile stats",
      body: "Compact mobile stats",
    });
    f.srv.store.chatAgentTaskOp(projectId, "transition_task", {
      task: created.task.id,
      status: "done",
      resolution: "shipped",
      delivery_ref: "main@fd99c350dfbc9f6485d4c97f649b9f350fd28e67",
    });

    const triggered = await f.ok(`/projects/${projectId}/releases/trigger`, "POST", {});
    expect(triggered.release.number).toBe(1);
    expect(triggered.release.target_sha).toBe("fd99c350dfbc9f6485d4c97f649b9f350fd28e67");

    const startFrame = await conn1.next("chat.start");
    const runId1 = String(startFrame.payload.run_id);
    const sessionId = String(startFrame.payload.session_id);

    // Persist pre-cutover checkpoint via task.rpc (same path as MCP checkpoint_release)
    conn1.send(
      "task.rpc",
      {
        run_id: runId1,
        project_id: projectId,
        action: "checkpoint_release",
        params: {
          release_id: "REL-1",
          target_sha: "fd99c350dfbc9f6485d4c97f649b9f350fd28e67",
          pier_server: "tw-1",
          pier_project: "relaydesk",
          health_url: "https://relaydesk.acexiamo.com/api/auth/status",
          deploy_log: "/tmp/relaydesk-deploy-fd99c350.log",
          checks: ["web healthy", "runner running", "HTTP 200 /api/auth/status"],
        },
      },
      "rpc-checkpoint-1",
    );
    const cpReply = await conn1.next("task.rpc.result");
    expect(cpReply.payload.ok).toBe(true);

    // Simulate self-restart / WebSocket disconnect mid-deploy
    conn1.ws.close();

    // Release should transition to `verifying` (NOT `failed`), and task keeps `deploying` ownership
    await expect
      .poll(async () => (await f.ok(`/projects/${projectId}/releases/${triggered.release.id}`)).release.status, {
        timeout: 4000,
        interval: 25,
      })
      .toBe("verifying");

    const midRel = (await f.ok(`/projects/${projectId}/releases/${triggered.release.id}`)).release;
    expect(midRel.finished_at).toBeNull();
    expect(midRel.verification_context.pier_server).toBe("tw-1");
    expect(midRel.verification_context.health_url).toBe("https://relaydesk.acexiamo.com/api/auth/status");
    const midTask = (await f.ok(`/tasks/${created.task.id}`)).task;
    expect(midTask.deploy_status).toBe("deploying");
    expect(midTask.release_id).toBe(triggered.release.id);

    // Bridge reconnects -> ReleaseDispatcher automatically resumes read-only verification on the SAME release & session
    const conn2 = await f.connect(token);
    await conn2.hello([{ project_id: projectId, workdir: "/repo/relaydesk", path_ok: true }]);

    const verifyStart = await conn2.next("chat.start");
    expect(verifyStart.payload.session_id).toBe(sessionId);
    expect(verifyStart.payload.resume_session_id).toBe("");
    expect(String(verifyStart.payload.system_context)).toContain("VERIFY-ONLY");
    expect(String(verifyStart.payload.prompt)).toContain("fd99c350dfbc9f6485d4c97f649b9f350fd28e67");
    expect(String(verifyStart.payload.prompt)).toContain("tw-1");

    // Still only 1 release exists (no duplicate release created)
    const listDuringVerify = await f.ok(`/projects/${projectId}/releases`);
    expect(listDuringVerify.releases).toHaveLength(1);

    // First report insufficient evidence -> keeps `verifying` and task stays `deploying`
    conn2.send(
      "task.rpc",
      {
        run_id: String(verifyStart.payload.run_id),
        project_id: projectId,
        action: "finish_release",
        params: {
          release_id: "REL-1",
          status: "verifying",
          summary: "Pier deploy still in progress; waiting for web healthy.",
        },
      },
      "rpc-finish-verifying",
    );
    const verReply = await conn2.next("task.rpc.result");
    expect(verReply.payload.ok).toBe(true);
    expect((verReply.payload.data as any).release.status).toBe("verifying");

    // Then report full evidence -> syncs release & task to succeeded/deployed
    conn2.send(
      "task.rpc",
      {
        run_id: String(verifyStart.payload.run_id),
        project_id: projectId,
        action: "finish_release",
        params: {
          release_id: "REL-1",
          status: "succeeded",
          target_sha: "fd99c350dfbc9f6485d4c97f649b9f350fd28e67",
          deploy_ref: "main@fd99c350dfbc9f6485d4c97f649b9f350fd28e67",
          summary: "Pier record confirmed, web healthy, runner running, /api/auth/status HTTP 200.",
        },
      },
      "rpc-finish-ok",
    );
    const okReply = await conn2.next("task.rpc.result");
    expect(okReply.payload.ok).toBe(true);

    conn2.send("chat.event", {
      run_id: verifyStart.payload.run_id,
      session_id: verifyStart.payload.session_id,
      event: { type: "done" },
      result: { content: "Verified REL-1", events: [], status: "done", externalSessionId: "" },
    });

    await expect
      .poll(async () => (await f.ok(`/projects/${projectId}/releases/${triggered.release.id}`)).release.status)
      .toBe("succeeded");

    const finalTask = (await f.ok(`/tasks/${created.task.id}`)).task;
    expect(finalTask.deploy_status).toBe("deployed");
    expect(finalTask.release_id).toBe(triggered.release.id);

    // Repeating reverify on an already succeeded release is rejected (idempotent protection)
    const dupReverify = await f.api(
      `/projects/${projectId}/releases/${triggered.release.id}/reverify`,
      "POST",
      {},
    );
    expect(dupReverify.status).toBe(409);
  });

  it("allows console reverify on an existing failed release (REL-2 style) to correct false failure while preserving original reason", async () => {
    const projectId = await f.project("RelayDesk REL-2");
    const { token } = await f.register("mac-reverify");
    const conn = await f.connect(token);
    await conn.hello([{ project_id: projectId, workdir: "/repo/relaydesk", path_ok: true }]);

    await f.ok(`/projects/${projectId}/deploy-policy`, "PUT", { mode: "manual" });

    const t7 = await f.ok(`/projects/${projectId}/tasks`, "POST", { title: "RD-7", body: "b" });
    const t8 = await f.ok(`/projects/${projectId}/tasks`, "POST", { title: "RD-8", body: "b" });
    f.srv.store.chatAgentTaskOp(projectId, "transition_task", {
      task: t7.task.id,
      status: "done",
      delivery_ref: "main@0ed3048",
    });
    f.srv.store.chatAgentTaskOp(projectId, "transition_task", {
      task: t8.task.id,
      status: "done",
      delivery_ref: "main@fd99c350dfbc9f6485d4c97f649b9f350fd28e67",
    });

    // Simulate a legacy failed release record caused by server restart
    const { release: rel } = f.srv.store.createRelease(projectId, {
      trigger: "immediate",
      taskIds: [t7.task.id, t8.task.id],
    });
    f.srv.store.finishRelease(projectId, rel.id, {
      status: "failed",
      summary: "Server restarted while release session was running.",
      author: "system",
    });
    expect(f.srv.store.getRelease(projectId, rel.id).status).toBe("failed");
    expect(f.srv.store.getTaskView(t7.task.id).deploy_status).toBe("failed");
    expect(f.srv.store.getTaskView(t8.task.id).deploy_status).toBe("failed");

    // Trigger console reverify on the existing failed release
    const rev = await f.ok(`/projects/${projectId}/releases/${rel.id}/reverify`, "POST", {
      prompt: "核对 tw-1 Web/Runner 镜像 SHA 与 /api/auth/status",
    });
    expect(rev.release.id).toBe(rel.id);
    expect(rev.release.number).toBe(rel.number);
    expect(rev.release.status).toBe("verifying");

    // Duplicate concurrent reverify is rejected with 409
    const dupConcurrent = await f.api(`/projects/${projectId}/releases/${rel.id}/reverify`, "POST", {});
    expect(dupConcurrent.status).toBe(409);

    const startFrame = await conn.next("chat.start");
    expect(String(startFrame.payload.system_context)).toContain("VERIFY-ONLY");
    expect(String(startFrame.payload.prompt)).toContain("Server restarted while release session was running.");

    // Agent verifies evidence and calls finish_release(status: "succeeded")
    conn.send(
      "task.rpc",
      {
        run_id: String(startFrame.payload.run_id),
        project_id: projectId,
        action: "finish_release",
        params: {
          release_id: `REL-${rel.number}`,
          status: "succeeded",
          target_sha: "fd99c350dfbc9f6485d4c97f649b9f350fd28e67",
          deploy_ref: "main@fd99c350dfbc9f6485d4c97f649b9f350fd28e67",
          summary: "tw-1 Web healthy & Runner running fd99c350dfbc9f6485d4c97f649b9f350fd28e67; /api/auth/status HTTP 200; Pier deploy record verified.",
        },
      },
      "rpc-reverify-fix",
    );
    const rpcRes = await conn.next("task.rpc.result");
    expect(rpcRes.payload.ok).toBe(true);

    conn.send("chat.event", {
      run_id: startFrame.payload.run_id,
      session_id: startFrame.payload.session_id,
      event: { type: "done" },
      result: { content: "Re-verified and corrected", events: [], status: "done", externalSessionId: "" },
    });

    await expect
      .poll(() => f.srv.store.getChatSession(projectId, String(startFrame.payload.session_id)).status)
      .toBe("idle");

    // Check release corrected while preserving original failure reason and correction basis
    const corrected = f.srv.store.getRelease(projectId, rel.id);
    expect(corrected.status).toBe("succeeded");
    expect(corrected.target_sha).toBe("fd99c350dfbc9f6485d4c97f649b9f350fd28e67");
    expect(corrected.summary).toContain("Server restarted while release session was running.");
    expect(corrected.summary).toContain("/api/auth/status HTTP 200");
    expect(corrected.verification_context.previous_failure_summary).toContain(
      "Server restarted while release session was running.",
    );
    expect(corrected.verification_context.correction_basis).toContain("/api/auth/status HTTP 200");
    expect(corrected.verification_context.corrected_at).toBeTruthy();

    // Both tasks synced to deployed without creating a second release
    expect(f.srv.store.listReleases(projectId)).toHaveLength(1);
    expect(f.srv.store.getTaskView(t7.task.id).deploy_status).toBe("deployed");
    expect(f.srv.store.getTaskView(t8.task.id).deploy_status).toBe("deployed");
  });
});
