import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../app/lib/api.ts";
import { messagesWithTurn, ProjectChatStreams } from "../app/lib/chat-streams.ts";
import { bearer, fixture, operator, type Fixture } from "./bridge-fixture.ts";

describe("server-started release chat", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input !== "string" || !input.startsWith("/api/")) return fetch(input, init);
      return fetch(f.srv.url + input, { ...init, headers: { ...init?.headers, ...bearer(operator) } });
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await f.close();
  });

  it.each(["manual", "immediate"] as const)("subscribes to the session selected by a %s release", async mode => {
    const project = await f.project();
    const base = `/projects/${project}`;
    const conn = await f.connect((await f.register()).token);
    await conn.hello([{ project_id: project, workdir: "/repo/release", path_ok: true }]);
    await f.ok(`${base}/deploy-policy`, "PUT", { mode });
    let sessionId: string;
    if (mode === "manual") {
      sessionId = (await f.ok(`${base}/releases/trigger`, "POST", { force: true })).session.id;
    } else {
      const task = f.srv.store.createTask(project, { title: "Ship change", body: "Ready for release" }, "console");
      f.srv.store.chatAgentTaskOp(project, "transition_task", { task: task.id, status: "done", resolution: "shipped" });
      f.srv.api.releaseDispatcher.schedule(project);
      await expect.poll(async () => (await f.ok(`${base}/releases`)).releases.length).toBe(1);
      sessionId = (await f.ok(`${base}/releases`)).releases[0].session_id;
    }
    const start = await conn.next("chat.start");
    const ids = { run_id: start.payload.run_id, session_id: sessionId };
    const tool = { id: "build", tool: "shell", status: "running", summary: "build release" };
    const sendProgress = () => {
      conn.send("chat.event", { ...ids, event: { type: "tool", event: tool } });
      conn.send("chat.event", { ...ids, event: { type: "text_delta", delta: "first" } });
    };
    const subscribe = vi.fn(api.subscribeCodexChatStream);
    const streams = new ProjectChatStreams({ ...api, subscribeCodexChatStream: subscribe });
    const current = () => streams.chatSnapshot().get(sessionId);
    const open = async () => {
      streams.select(sessionId);
      const history = await api.getCodexChatSession(project, sessionId);
      streams.observe(history.session, history.messages);
      return history;
    };
    if (mode === "immediate") {
      sendProgress();
      // A subsequent RPC on the same socket confirms that progress has reached the server.
      const id = conn.send("task.rpc", { ...ids, project_id: project, action: "list_releases", params: {} });
      await conn.next("task.rpc.result", id);
    }
    await open();
    if (mode === "manual") sendProgress();
    await expect.poll(current).toMatchObject({ running: true, assistant: { content: "first", events: [tool] } });
    streams.select(null);
    const history = await open();
    expect(subscribe).toHaveBeenCalledTimes(1);
    const finishedTool = { ...tool, status: "done" };
    conn.send("chat.event", { ...ids, event: { type: "tool", event: finishedTool } });
    conn.send("chat.event", { ...ids, event: { type: "text_delta", delta: " second" } });
    await expect.poll(() => messagesWithTurn(history.messages, current())).toMatchObject([
      { role: "user" }, { role: "assistant", content: "first second", events: [finishedTool] },
    ]);
    if (mode === "manual") {
      await streams.abort(sessionId, history.session.active_run_id!);
    } else {
      conn.send("chat.event", { ...ids, event: { type: "done" }, result: {
        status: "done", content: "first second", events: [finishedTool], externalSessionId: "",
      } });
    }
    const status = mode === "manual" ? "aborted" : "done";
    await expect.poll(current).toMatchObject({ running: false, session: { status: "idle" }, assistant: { content: "first second", status } });
    const final = await api.getCodexChatSession(project, sessionId);
    expect(final.messages).toHaveLength(2);
    expect(final.messages[1]).toEqual(current()!.assistant);
    // A fresh page can receive running history just before the server returns 204 to its subscription.
    const fresh = new ProjectChatStreams(api);
    fresh.observe(history.session, history.messages);
    await expect.poll(() => fresh.chatSnapshot().get(sessionId)).toMatchObject({ running: false, assistant: final.messages[1] });
  });
});
