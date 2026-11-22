import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../server/store.ts";
import { bearer, fixture, operator, type Fixture } from "./bridge-fixture.ts";

let f: Fixture;
beforeEach(async () => { f = await fixture(); });
afterEach(async () => { await f.close(); });

async function readSseText(res: Response): Promise<string> {
  return await res.text();
}

describe("event-driven task auto-dispatch to local agents", () => {
  it("dispatches newly created tasks immediately, isolates task sessions from regular chats, and handles MCP completion + queued next task", async () => {
    const projectId = await f.project();
    const { token, id: agentId } = await f.register("mac-mini");
    const conn = await f.connect(token);
    await conn.hello([{ project_id: projectId, workdir: "/repo/app", path_ok: true }]);

    // Enable auto_dispatch_tasks on this project.
    const routing = await f.ok(`/projects/${projectId}/execution-routing`, "PATCH", {
      auto_dispatch_tasks: true,
      task_runtime: "codex",
      task_network_access: true,
    });
    expect(routing.routing.auto_dispatch_tasks).toBe(true);
    expect(routing.routing.task_runtime).toBe("codex");
    expect(routing.routing.task_network_access).toBe(true);

    // Create a normal chat session to verify isolation.
    const regularChat = await f.ok(`/projects/${projectId}/codex-chat/sessions`, "POST", {
      title: "普通开发讨论",
    });

    // Create task 1 from console (normal priority) -> should auto-dispatch immediately.
    const created1 = await f.ok(`/projects/${projectId}/tasks`, "POST", {
      title: "修复登录按钮样式",
      body: "移动端登录按钮被裁切",
      priority: "normal",
    });
    const start1 = await conn.next("chat.start");
    expect(start1.payload.project_id).toBe(projectId);
    expect(start1.payload.sandbox_mode).toBe("workspace-write");
    expect(start1.payload.network_access).toBe(true);
    expect(String(start1.payload.prompt)).toContain("RD-1");
    expect(String(start1.payload.system_context)).toContain("Autonomous Task Execution Workflow (RD-1)");

    const task1SessionId = String(start1.payload.session_id);
    const run1Id = String(start1.payload.run_id);

    // Task sessions must NOT leak into regular Codex chat list.
    const regularList = await f.ok(`/projects/${projectId}/codex-chat/sessions`);
    expect(regularList.sessions.map((s: { id: string }) => s.id)).toEqual([regularChat.session.id]);

    // Task sessions ARE visible via ?kind=task and /api/tasks/:id/agent-session.
    const taskSessionsList = await f.ok(`/projects/${projectId}/codex-chat/sessions?kind=task`);
    expect(taskSessionsList.sessions.map((s: { id: string }) => s.id)).toEqual([task1SessionId]);
    expect(taskSessionsList.sessions[0]).toMatchObject({
      kind: "task",
      task_id: created1.task.id,
      status: "running",
    });

    const task1AgentSession = await f.ok(`/tasks/${created1.task.id}/agent-session`);
    expect(task1AgentSession.session).toMatchObject({
      id: task1SessionId,
      kind: "task",
      task_id: created1.task.id,
      status: "running",
      execution_target: `local:${agentId}`,
    });
    expect(task1AgentSession.session.active_run_id).toBeTruthy();

    // Create task 2 via widget intake while task 1 is still running -> must stay queued (1 per project).
    const projectDetail = await f.ok(`/projects/${projectId}`);
    const intakeRes = await fetch(`${f.srv.url}/api/projects/${projectId}/intake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${projectDetail.project.intake_key}`,
      },
      body: JSON.stringify({
        source: "widget",
        title: "结账接口 500 报错",
        body: "点击提交订单时报 500",
        priority: "urgent",
      }),
    });
    expect(intakeRes.status).toBe(200);
    const created2 = (await intakeRes.json()) as { task_id: string; number: number };

    const task2Before = await f.ok(`/tasks/${created2.task_id}`);
    expect(task2Before.task.status).toBe("triage");
    expect(task2Before.task.owner).toBe("none");

    // Agent calls MCP transition_task on its own leased task RD-1 -> allowed!
    const rpcId = conn.send("task.rpc", {
      run_id: run1Id,
      project_id: projectId,
      action: "transition_task",
      params: {
        task: "RD-1",
        status: "done",
        resolution: "shipped",
        delivery_ref: "main@abc1234",
        comment: "已修复移动端按钮裁切并通过校验。",
      },
    });
    const rpcResult = await conn.next("task.rpc.result", rpcId);
    expect(rpcResult.payload.ok).toBe(true);

    // Finish task 1 run -> should automatically dispatch queued task 2 immediately!
    conn.send("chat.event", {
      run_id: run1Id,
      session_id: task1SessionId,
      event: { type: "done" },
      result: {
        content: "已修复并推送 main@abc1234",
        events: [],
        status: "done",
        externalSessionId: "ext-thread-1",
      },
    });

    const start2 = await conn.next("chat.start");
    expect(String(start2.payload.prompt)).toContain("RD-2");
    expect(String(start2.payload.prompt)).toContain("结账接口 500 报错");

    const task1After = await f.ok(`/tasks/${created1.task.id}`);
    expect(task1After.task).toMatchObject({
      status: "done",
      resolution: "shipped",
      delivery_ref: "main@abc1234",
      owner: "none",
      agent_session_id: task1SessionId,
      agent_session_status: "idle",
    });

    // Cleanly finish task 2 so fixture shuts down cleanly.
    conn.send("chat.event", {
      run_id: start2.payload.run_id,
      session_id: start2.payload.session_id,
      event: { type: "done" },
      result: { content: "done", events: [], status: "done", externalSessionId: "ext-thread-2" },
    });
  });

  it("replays live snapshot over GET /stream without aborting on client disconnect, and supports interruptible follow-ups", async () => {
    const projectId = await f.project();
    const { token } = await f.register("macbook");
    const conn = await f.connect(token);
    await conn.hello([{ project_id: projectId, workdir: "/repo/app", path_ok: true }]);
    await f.ok(`/projects/${projectId}/execution-routing`, "PATCH", { auto_dispatch_tasks: true });

    const created = await f.ok(`/projects/${projectId}/tasks`, "POST", {
      title: "支持暗色模式切换",
      body: "添加暗色模式切换按钮",
    });
    const start1 = await conn.next("chat.start");
    const sessionId = String(start1.payload.session_id);
    const bridgeRunId = String(start1.payload.run_id);

    // Emit partial progress before any browser subscribes.
    conn.send("chat.event", {
      run_id: bridgeRunId,
      session_id: sessionId,
      event: { type: "status", message: "Analyzing repo", external_session_id: "thread-xyz" },
    });
    conn.send("chat.event", {
      run_id: bridgeRunId,
      session_id: sessionId,
      event: { type: "tool", event: { id: "t1", tool: "read", summary: "Read theme.css", status: "done" } },
    });
    conn.send("chat.event", {
      run_id: bridgeRunId,
      session_id: sessionId,
      event: { type: "reasoning", text: "第一步排查主题变量，" },
    });
    conn.send("chat.event", {
      run_id: bridgeRunId,
      session_id: sessionId,
      event: { type: "reasoning", text: "第二步核对深色配色。" },
    });
    conn.send("chat.event", {
      run_id: bridgeRunId,
      session_id: sessionId,
      event: { type: "text_delta", delta: "正在检查主题变量" },
    });
    const barrier = conn.send("workspace.fetch", { project_id: projectId, path: "HANDBOOK.md" });
    await conn.next("workspace.fetch.result", barrier);

    // Browser opens live subscription -> receives snapshot immediately, then disconnects early.
    const abortCtrl = new AbortController();
    const streamRes = await fetch(
      `${f.srv.url}/api/projects/${projectId}/codex-chat/sessions/${sessionId}/stream`,
      { signal: abortCtrl.signal, headers: bearer(operator) },
    );
    expect(streamRes.status).toBe(200);
    const reader = streamRes.body!.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    expect(firstChunk).toContain("event: snapshot");
    expect(firstChunk).toContain("正在检查主题变量");
    expect(firstChunk).toContain("Read theme.css");
    expect(firstChunk).toContain("第一步排查主题变量，第二步核对深色配色。");
    abortCtrl.abort();
    await reader.cancel().catch(() => {});

    // Disconnecting SSE MUST NOT abort the running task!
    const detailMid = await f.ok(`/tasks/${created.task.id}/agent-session`);
    expect(detailMid.session.status).toBe("running");
    const activeRunId = detailMid.session.active_run_id as string;
    expect(activeRunId).toBeTruthy();

    // User interrupts with a follow-up ("插话"): abort with reason="follow_up" must keep task working.
    const abortRes = await f.ok(
      `/projects/${projectId}/codex-chat/sessions/${sessionId}/abort`,
      "POST",
      { run_id: activeRunId, reason: "follow_up" },
    );
    expect(abortRes).toEqual({ aborted: true });
    await conn.next("chat.abort");

    // Wait briefly for abort persistence.
    await new Promise((r) => setTimeout(r, 40));
    const taskDuringFollowUp = await f.ok(`/tasks/${created.task.id}`);
    expect(taskDuringFollowUp.task.status).toBe("working");
    expect(taskDuringFollowUp.task.owner).toBe("agent");

    // Send the human follow-up message -> resumes external session.
    const followUpRes = await f.api(
      `/projects/${projectId}/codex-chat/sessions/${sessionId}/messages`,
      "POST",
      { run_id: "followup-1", content: "顺便把侧栏颜色也适配一下" },
    );
    const start2 = await conn.next("chat.start");
    expect(start2.payload.resume_session_id).toBe("thread-xyz");
    expect(String(start2.payload.prompt)).toContain("顺便把侧栏颜色也适配一下");

    // Complete via MCP + finish turn.
    const rpcId = conn.send("task.rpc", {
      run_id: start2.payload.run_id,
      project_id: projectId,
      action: "transition_task",
      params: { task: "RD-1", status: "done", resolution: "shipped", comment: "已完成暗色模式与侧栏适配" },
    });
    await conn.next("task.rpc.result", rpcId);
    conn.send("chat.event", {
      run_id: start2.payload.run_id,
      session_id: sessionId,
      event: { type: "done" },
      result: { content: "已完成所有适配", events: [], status: "done", externalSessionId: "thread-xyz" },
    });
    expect(await readSseText(followUpRes)).toContain("event: done");

    // When idle, GET /stream returns 204.
    const idleStream = await fetch(
      `${f.srv.url}/api/projects/${projectId}/codex-chat/sessions/${sessionId}/stream`,
      { headers: bearer(operator) },
    );
    expect(idleStream.status).toBe(204);
  });

  it("moves task to waiting on error, disconnect, or missing MCP transition, and reactivates on human follow-up", async () => {
    const projectId = await f.project();
    const { token } = await f.register("dev-box");
    const conn = await f.connect(token);
    await conn.hello([{ project_id: projectId, workdir: "/repo/app", path_ok: true }]);

    // Keep auto_dispatch_tasks=false and trigger manual dispatch via POST /api/tasks/:id/dispatch.
    const created = await f.ok(`/projects/${projectId}/tasks`, "POST", {
      title: "排查支付回调偶发失败",
      body: "需要确认 webhook 签名逻辑",
    });
    const dispatched = await f.ok(`/tasks/${created.task.id}/dispatch`, "POST", {});
    expect(dispatched.session.kind).toBe("task");
    expect(dispatched.session.status).toBe("running");
    const start1 = await conn.next("chat.start");

    // Simulate execution error -> task moves to waiting.
    conn.send("chat.event", {
      run_id: start1.payload.run_id,
      session_id: start1.payload.session_id,
      event: { type: "error" },
      result: { content: "", error: "CLI exited with code 1", events: [], status: "error", externalSessionId: "" },
    });
    await new Promise((r) => setTimeout(r, 60));

    const waitingTask = await f.ok(`/tasks/${created.task.id}`);
    expect(waitingTask.task.status).toBe("waiting");
    expect(waitingTask.task.owner).toBe("none");

    // Human replies inside the task's session -> reactivates task to working automatically.
    const continueRes = await f.api(
      `/projects/${projectId}/codex-chat/sessions/${dispatched.session.id}/messages`,
      "POST",
      { run_id: "human-continue-1", content: "我已经补了测试 key，请重新跑一遍" },
    );
    const start2 = await conn.next("chat.start");
    const activeAgain = await f.ok(`/tasks/${created.task.id}`);
    expect(activeAgain.task.status).toBe("working");
    expect(activeAgain.task.owner).toBe("agent");

    // Agent finishes turn without calling transition_task -> safeguard moves task to waiting.
    conn.send("chat.event", {
      run_id: start2.payload.run_id,
      session_id: start2.payload.session_id,
      event: { type: "done" },
      result: {
        content: "已验证签名逻辑，需要你确认是否保留旧版本兼容。",
        events: [],
        status: "done",
        externalSessionId: "thread-2",
      },
    });
    expect(await readSseText(continueRes)).toContain("event: done");
    const afterSafeguard = await f.ok(`/tasks/${created.task.id}`);
    expect(afterSafeguard.task.status).toBe("waiting");
    expect(afterSafeguard.task.owner).toBe("none");
  });

  it("queues tasks while offline and dispatches automatically once local agent connects, and recovers stale sessions on boot", async () => {
    const projectId = await f.project();
    const { token } = await f.register("laptop");
    await f.ok(`/projects/${projectId}/execution-routing`, "PATCH", { auto_dispatch_tasks: true });

    // Create task while no agent is connected.
    const created = await f.ok(`/projects/${projectId}/tasks`, "POST", {
      title: "离线时提交的任务",
      body: "本机上线后应自动拉起",
    });
    await new Promise((r) => setTimeout(r, 40));
    expect((await f.ok(`/tasks/${created.task.id}`)).task.status).toBe("triage");

    // Now local agent connects and reports binding -> task dispatches immediately!
    const conn = await f.connect(token);
    await conn.hello([{ project_id: projectId, workdir: "/repo/app", path_ok: true }]);
    const start = await conn.next("chat.start");
    expect(String(start.payload.prompt)).toContain("离线时提交的任务");

    // Test startup recovery directly on a separate in-memory store.
    const recoveryStore = new Store(":memory:");
    const p = recoveryStore.createProject({ name: "Demo", repo: "acme/demo" });
    const t = recoveryStore.createTask(p.id, { title: "Stuck task", body: "body" }, "console");
    const s = recoveryStore.createChatSession(p.id, { kind: "task", task_id: t.id, title: "RD-1" });
    recoveryStore.claimTaskForSession(t.id, s.id, "laptop", "auto");
    recoveryStore.updateChatSession(p.id, s.id, { status: "running" });
    const recovered = recoveryStore.recoverInterruptedSessionRuns();
    expect(recovered).toEqual({ recoveredSessions: 1, recoveredTasks: 1 });
    expect(recoveryStore.getTaskView(t.id).status).toBe("waiting");
    expect(recoveryStore.getTaskView(t.id).owner).toBe("none");
    expect(recoveryStore.getChatSession(p.id, s.id).status).toBe("idle");
    recoveryStore.close();

    // Finish active bridge run cleanly.
    conn.send("chat.event", {
      run_id: start.payload.run_id,
      session_id: start.payload.session_id,
      event: { type: "done" },
      result: { content: "ok", events: [], status: "done", externalSessionId: "" },
    });
  });
});
