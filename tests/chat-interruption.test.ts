import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixture, type Fixture } from "./bridge-fixture.ts";

let f: Fixture;
beforeEach(async () => { f = await fixture(); });
afterEach(async () => { await f.close(); });

describe("chat interruption and continuation", () => {
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
    if (thread) event({ type: "status", message: "started", external_session_id: thread });
    event({ type: "tool", event: tool });
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
    expect(detail.messages.at(-1)).toMatchObject({ content: "Partial result", events: [expect.objectContaining(tool)], status: "aborted", stop_reason: "follow_up" });
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
