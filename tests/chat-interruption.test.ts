import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRuntimeInfo } from "../app/lib/types.ts";
import { chatMessageContent } from "../app/lib/chat-content.ts";
import { chatTargetAvailability } from "../app/lib/model-catalog.ts";
import { fixture, type Fixture } from "./bridge-fixture.ts";

let f: Fixture;
beforeEach(async () => { f = await fixture(); });
afterEach(async () => { await f.close(); });

describe("chat interruption and continuation", () => {
  it("keeps partial output and rejects offline submissions until a manual send after reconnect", async () => {
    const projectId = await f.project();
    const { token, id } = await f.register();
    const target = `local:${id}`;
    const projects = [{ project_id: projectId, workdir: "/fixture", path_ok: true }];
    const runtime = () => f.ok(`/projects/${projectId}/codex-chat/runtime`);
    const first = await f.connect(token);
    await first.hello(projects);
    const session = await f.session(projectId, id);
    const response = await session.turn("first");
    const { run_id } = (await first.next("chat.start")).payload;
    first.send("chat.event", { run_id, session_id: session.id, event: { type: "text_delta", delta: "**partial**" } });
    first.ws.close(1000);
    expect(await response.text()).toContain("event: error");
    const before = await session.detail();
    const failed = before.messages.at(-1);
    expect(failed).toMatchObject({ content: "**partial**", status: "error", error_reason: expect.stringContaining("中断") });
    expect(chatMessageContent(failed)).toMatchObject({ visibleContent: "**partial**", errorReason: failed.error_reason });
    expect(chatMessageContent({ ...failed, error_reason: undefined, content: "执行失败：本机节点离线" })).toMatchObject({ visibleContent: "", errorReason: "本机节点离线" });

    const offline = await runtime();
    expect(chatTargetAvailability(offline, projectId, target, "codex")).toMatchObject({ mode: "unavailable", reason: expect.stringContaining("手动发送") });
    const fixedPrimary: ChatRuntimeInfo = { ...offline, effective_priority: [target, "cloud"], routing: { ...offline.routing, auto_fallback: false },
      local_clis: { codex: true, claude: false }, auth_mode: { codex: "local_cli", claude: "unavailable" } };
    expect(chatTargetAvailability(fixedPrimary, projectId, "auto", "codex").mode).toBe("unavailable");
    expect(chatTargetAvailability({ ...fixedPrimary, routing: { ...offline.routing, auto_fallback: true } }, projectId, "auto", "codex").mode).toBe("local_cli");
    const draft = { content: "draft", attachments: [{ kind: "task", label: "task", ref: "t" }] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await f.api(`${session.path}/messages`, "POST", draft);
      expect(rejected.status).toBe(409);
    }
    const second = await f.connect(token);
    await second.hello(projects);
    expect(chatTargetAvailability(await runtime(), projectId, target, "codex").mode).toBe("local_cli");
    expect(await session.detail()).toEqual(before);
    const manual = await session.turn(draft.content, draft.attachments);
    const next = (await second.next("chat.start")).payload;
    second.send("chat.event", { run_id: next.run_id, session_id: session.id, event: { type: "done" },
      result: { content: "completed", events: [], status: "done", externalSessionId: "" } });
    expect(await manual.text()).toContain("event: done");
    const after = await session.detail();
    expect(after.messages).toHaveLength(4);
    expect(after.messages[2]).toMatchObject(draft);
  });

  it.each(["early-thread", ""])('continues the interrupted first request (thread=%j) and ignores stale stops', async thread => {
    const p = await f.project();
    const { token, id } = await f.register();
    const conn = await f.connect(token);
    await conn.hello([{ project_id: p, workdir: "/fixture", path_ok: true }]);
    const s = await f.session(p, id);
    const send = (run_id: string, content: string) => f.api(`${s.path}/messages`, "POST", { run_id, content });
    const abort = (run_id: string) => f.ok(`${s.path}/abort`, "POST", { run_id, reason: "follow_up" });
    const original = "x".repeat(2000) + " ORIGINAL REQUIREMENT";
    const first = await send("first", original);
    const { run_id } = (await conn.next("chat.start")).payload;
    const ids = { run_id, session_id: s.id };
    const event = (event: object) => conn.send("chat.event", { ...ids, event });
    const tool = { id: "t", tool: "read", summary: "Read file", status: "done" };
    const subagent = { id: "sa-1", tool: "Agent", summary: "Inspect repo", status: "running", subagent: { status: "running", activity: "Grep" } };
    if (thread) event({ type: "status", message: "started", external_session_id: thread });
    event({ type: "tool", event: tool });
    event({ type: "tool", event: subagent });
    event({ type: "text_delta", delta: "Partial result" });
    // An RPC on the same socket establishes that the hub observed all prior events.
    const barrier = conn.send("workspace.fetch", { project_id: p, path: "HANDBOOK.md" });
    await conn.next("workspace.fetch.result", barrier);
    expect((await s.detail()).session.active_run_id).toBe("first");
    expect((await f.api(`${s.path}/abort`, "POST", {})).status).toBe(400);
    expect(await abort("first")).toEqual({ aborted: true });
    await conn.next("chat.abort"); // No terminal frame from the bridge.
    expect(await first.text()).toContain("event: done");
    const detail = await s.detail();
    expect(detail.messages.at(-1)).toMatchObject({
      content: "Partial result",
      events: [
        expect.objectContaining(tool),
        expect.objectContaining({ id: "sa-1", status: "error", subagent: { status: "interrupted", activity: "Grep" } }),
      ],
      status: "aborted",
      stop_reason: "follow_up",
    });
    expect(detail.session.external_session_id).toBe(thread);
    expect((await send("first", original)).status).toBe(409);
    const second = await send("second", "ADDITIONAL CONDITION");
    const next = (await conn.next("chat.start")).payload;
    expect(next.resume_session_id).toBe(thread);
    expect(next.prompt).toContain("ADDITIONAL CONDITION");
    expect(next.system_context + next.prompt).toContain("ORIGINAL REQUIREMENT");
    expect(await abort("first")).toEqual({ aborted: false });
    conn.send("chat.event", { ...ids, event: { type: "done" }, result: { content: "late", events: [], status: "done", externalSessionId: "late" } });
    conn.send("chat.event", { run_id: next.run_id, session_id: s.id, event: { type: "done" }, result: { content: "finished", events: [], status: "done", externalSessionId: "new-id" } });
    expect(await second.text()).toContain("event: done");
    expect((await s.detail()).messages.map((m: { content: string }) => m.content)).toEqual([original, "Partial result", "ADDITIONAL CONDITION", "finished"]);
  });
});
