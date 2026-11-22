import { describe, expect, it, vi } from "vitest";
import { messagesWithTurn, ProjectChatStreams } from "../app/lib/chat-streams.ts";
import { api } from "../app/lib/api.ts";
import type { ChatSessionRecord, ChatStreamEvent } from "../app/lib/types.ts";

function session(project_id: string, id: string): ChatSessionRecord {
  return { project_id, id, title: id, runtime: "codex", model: "", sandbox_mode: "read-only",
    network_access: false, execution_target: "auto", resolved_target: "", reasoning_effort: "default",
    external_session_id: "", status: "idle", created_at: "", updated_at: "" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}

function fixture() {
  const requests = new Map<string, { emit: (ev: ChatStreamEvent) => void; end: () => void; signal?: AbortSignal }>();
  const streamCodexChatMessage = vi.fn((project: string, id: string, _payload: unknown, emit: (ev: ChatStreamEvent) => void, signal?: AbortSignal) =>
    new Promise<void>(resolve => {
      requests.set(`${project}/${id}`, { emit, end: resolve, signal });
      signal?.addEventListener("abort", () => resolve(), { once: true });
    }));
  const transport = { streamCodexChatMessage, abortCodexChatSession: vi.fn(async () => ({ aborted: true })),
    getCodexChatSession: vi.fn<typeof api.getCodexChatSession>() };
  return { transport, requests, streams: new ProjectChatStreams(transport) };
}

describe("project chat streams", () => {
  it("keeps receiving the same turn with the chat unmounted and another session or project selected", async () => {
    const { streams, transport, requests } = fixture();
    const a = session("p", "a");
    const listener = vi.fn();
    const leave = streams.subscribe(listener);
    streams.select(a.id);
    const first = streams.send(a, "first", []);
    const run = requests.get("p/a")!;
    const initial = streams.snapshot().get("a")!;
    leave();
    streams.select("b");
    const second = streams.send(session("p", "b"), "second", []);
    const otherProject = new ProjectChatStreams(transport);
    const third = otherProject.send(session("q", "a"), "unrelated", []);
    const user = { ...initial.user, id: "user" };
    run.emit({ type: "session", user_message: user, assistant_message_id: "assistant", session: a });
    run.emit({ type: "reasoning", text: "one" });
    run.emit({ type: "reasoning", text: " two" });
    run.emit({ type: "tool", event: { id: "cmd", tool: "shell", summary: "listing", status: "running" } });
    run.emit({ type: "text_delta", delta: "partial" });
    expect(listener).toHaveBeenCalledTimes(2);
    const reconnect = streams.subscribe(listener);
    streams.select("a");
    const live = streams.snapshot().get("a")!;
    expect(live).toMatchObject({ running: true, assistant: { content: "partial", events: [{ id: "cmd" }] },
      statusLine: "正在生成回复", trace: { entries: [{ kind: "reasoning", text: "one two" }] } });
    expect(messagesWithTurn([user, { ...live.assistant, content: "" }], live)).toEqual([user, live.assistant]);
    expect(streams.snapshot().get("b")?.assistant.content).toBe("");
    expect(otherProject.snapshot().get("a")?.user.content).toBe("unrelated");
    expect(run.signal?.aborted).not.toBe(true);
    reconnect();
    run.emit({ type: "done", session: a, message: { ...live.assistant, content: "finished", status: "done" } });
    run.end();
    await first;
    streams.retire("a", live);
    expect(streams.snapshot().get("a")).toMatchObject({ running: false, assistant: { content: "finished" } });
    for (const [key, store, sess] of [["p/b", streams, session("p", "b")], ["q/a", otherProject, session("q", "a")]] as const) {
      const req = requests.get(key)!;
      req.emit({ type: "done", session: sess, message: { ...store.snapshot().get(sess.id)!.assistant, status: "done" } });
      req.end();
    }
    await Promise.all([second, third]);
  });

  it.each(["done", "aborted"] as const)("hands off exactly once on saved %s, before old EOF or abort ACK", async status => {
    const { streams, transport, requests } = fixture();
    const a = session("p", "a");
    const first = streams.send(a, "old", []);
    const old = requests.get("p/a")!;
    const turn = streams.snapshot().get("a")!;
    expect(streams.send(a, "old", [])).toBeNull();
    const ack = deferred<{ aborted: boolean }>();
    transport.abortCodexChatSession.mockReturnValueOnce(ack.promise);
    const images = [{ kind: "image" as const, ref: "files/test.png", label: "test" }];
    const next = streams.send(a, "follow-up", images, turn.runId);
    expect(streams.send(a, "follow-up", images, turn.runId)).toBeNull();
    streams.abort("a", turn.runId);
    expect(transport.abortCodexChatSession).toHaveBeenCalledExactlyOnceWith("p", "a", turn.runId, "follow_up");
    expect(transport.streamCodexChatMessage).toHaveBeenCalledExactlyOnceWith("p", "a", { run_id: turn.runId, content: "old", attachments: [] }, expect.any(Function));
    old.emit({ type: "text_delta", delta: "partial" });
    const pending = streams.snapshot().get("a")!;
    expect(messagesWithTurn([], pending).map(m => m.content)).toEqual(["old", "partial", "follow-up"]);
    const message = { ...turn.assistant, content: "saved partial", status, ...(status === "aborted" && { stop_reason: "follow_up" as const }) };
    old.emit({ type: "done", session: a, message });
    const successor = streams.snapshot().get("a")!;
    expect(successor.runId).not.toBe(turn.runId);
    expect(successor.pending).toBeUndefined();
    expect(successor.user.id).toBe(pending.pending!.id);
    expect(transport.streamCodexChatMessage).toHaveBeenLastCalledWith("p", "a", { run_id: successor.runId, content: "follow-up", attachments: images }, expect.any(Function));
    expect(messagesWithTurn([turn.user, message], successor)).toEqual([turn.user, message, successor.user, successor.assistant]);
    old.emit({ type: "text_delta", delta: "late" });
    old.emit({ type: "done", session: a, message });
    streams.abort("a", turn.runId);
    expect(streams.send(a, "late click", [], turn.runId)).toBeNull();
    ack.resolve({ aborted: false });
    old.end();
    await first;
    expect(streams.snapshot().get("a")).toBe(successor);
    expect(transport.streamCodexChatMessage).toHaveBeenCalledTimes(2);
    expect(transport.abortCodexChatSession).toHaveBeenCalledTimes(1);
    const req = requests.get("p/a")!;
    req.emit({ type: "done", session: a, message: { ...successor.assistant, status: "done" } });
    req.end();
    await next;
  });

  it("manual stop targets one run and waits for its saved partial without submitting a successor", async () => {
    const { streams, transport, requests } = fixture();
    const a = session("p", "a");
    const first = streams.send(a, "question", []);
    const turn = streams.snapshot().get("a")!;
    await streams.abort("a", turn.runId);
    await streams.abort("a", turn.runId);
    expect(transport.abortCodexChatSession).toHaveBeenCalledExactlyOnceWith("p", "a", turn.runId, "user_stop");
    expect(streams.snapshot().get("a")).toMatchObject({ running: true, stopping: "user_stop" });
    expect(streams.send(a, "draft", [], turn.runId)).toBeNull();
    const req = requests.get("p/a")!;
    req.emit({ type: "done", session: a, message: { ...turn.assistant, content: "partial", status: "aborted", stop_reason: "user_stop" } });
    req.end();
    await first;
    expect(streams.snapshot().get("a")).toMatchObject({ running: false, assistant: { content: "partial", stop_reason: "user_stop" } });
    expect(transport.streamCodexChatMessage).toHaveBeenCalledTimes(1);
  });

  it("retries an early stop only after the same run registers", async () => {
    const { streams, transport, requests } = fixture();
    const a = session("p", "a");
    const first = streams.send(a, "question", []);
    const turn = streams.snapshot().get("a")!;
    transport.abortCodexChatSession.mockResolvedValueOnce({ aborted: false });
    const stop = streams.abort("a", turn.runId);
    await Promise.resolve();
    const req = requests.get("p/a")!;
    req.emit({ type: "session", session: a, user_message: turn.user, assistant_message_id: "assistant" });
    await stop;
    expect(transport.abortCodexChatSession.mock.calls).toEqual(Array(2).fill(["p", "a", turn.runId, "user_stop"]));
    req.emit({ type: "done", session: a, message: { ...turn.assistant, id: "assistant", status: "aborted" } });
    req.end();
    await first;
  });

  it("does not treat EOF as a save; preserves the unsent draft and attachments", async () => {
    const { streams, transport, requests } = fixture();
    const a = session("p", "a");
    const first = streams.send(a, "question", []);
    const turn = streams.snapshot().get("a")!;
    const attachments = [{ kind: "task" as const, label: "task", ref: "t" }];
    const follow = streams.send(a, "next", attachments, turn.runId);
    requests.get("p/a")!.end();
    await Promise.all([expect(first).rejects.toThrow("回复连接已中断"), expect(follow).rejects.toThrow("追问未发送")]);
    expect(transport.streamCodexChatMessage).toHaveBeenCalledTimes(1);
    expect(streams.takeUnsent("a")).toMatchObject({ content: "next", attachments });
    expect(streams.takeUnsent("a")).toBeUndefined();
  });

  it("recovers a disconnected local stream only after GET confirms the same assistant is saved", async () => {
    const { streams, transport, requests } = fixture();
    const a = session("p", "a");
    const first = streams.send(a, "question", []);
    const turn = streams.snapshot().get("a")!;
    const old = requests.get("p/a")!;
    old.emit({ type: "session", session: a, user_message: turn.user, assistant_message_id: "registered" });
    const next = streams.send(a, "next", [], turn.runId);
    const get = deferred<Awaited<ReturnType<typeof api.getCodexChatSession>>>();
    transport.getCodexChatSession.mockReturnValueOnce(get.promise);
    old.end();
    await Promise.resolve();
    expect(transport.streamCodexChatMessage).toHaveBeenCalledTimes(1);
    const saved = { ...turn.assistant, id: "registered", status: "aborted" as const, stop_reason: "follow_up" as const };
    get.resolve({ session: a, messages: [turn.user, saved] });
    await first;
    const successor = streams.snapshot().get("a")!;
    expect(successor.previous[0].assistant).toEqual(saved);
    const req = requests.get("p/a")!;
    req.emit({ type: "done", session: a, message: { ...successor.assistant, status: "done" } });
    req.end();
    await next;
  });

  it.each([true, false])("only accepts a persisted error for the registered assistant (matches=%s)", async matches => {
    const { streams, transport, requests } = fixture();
    const a = session("p", "a");
    const first = streams.send(a, "question", []);
    const turn = streams.snapshot().get("a")!;
    const old = requests.get("p/a")!;
    old.emit({ type: "session", session: a, user_message: turn.user, assistant_message_id: "registered" });
    const next = streams.send(a, "next", [], turn.runId);
    old.emit({ type: "error", error: "timeout", message: { ...turn.assistant, id: matches ? "registered" : "unrelated", status: "error", stop_reason: "total_timeout" } });
    old.end();
    expect(transport.streamCodexChatMessage).toHaveBeenCalledTimes(matches ? 2 : 1);
    await expect(first).rejects.toThrow("timeout");
    if (!matches) {
      await expect(next).rejects.toThrow("追问未发送");
      return;
    }
    const successor = streams.snapshot().get("a")!;
    expect(successor.previous[0].assistant.stop_reason).toBe("total_timeout");
    const req = requests.get("p/a")!;
    req.emit({ type: "done", session: a, message: { ...successor.assistant, status: "done" } });
    req.end();
    await next;
  });

  it("serializes the generated run ID in the message and targeted abort POST", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(""))
      .mockResolvedValueOnce(Response.json({ aborted: true }));
    try {
      await api.streamCodexChatMessage("p", "s", { run_id: "r1", content: "q" }, vi.fn());
      await api.abortCodexChatSession("p", "s", "r1", "user_stop");
      expect(fetch.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))])).toEqual([
        ["/api/projects/p/codex-chat/sessions/s/messages", "POST", { run_id: "r1", content: "q" }],
        ["/api/projects/p/codex-chat/sessions/s/abort", "POST", { run_id: "r1", reason: "user_stop" }],
      ]);
    } finally { fetch.mockRestore(); }
  });

  it("uses a matching saved assistant from GET as the barrier for a remotely owned run", async () => {
    const { streams, transport, requests } = fixture();
    const a = session("p", "a");
    const remote = { ...a, active_run_id: "remote", status: "running" as const };
    const user = { id: "u", role: "user" as const, session_id: "a", created_at: "", content: "old", status: "done" as const, attachments: [], events: [] };
    const assistant = { ...user, id: "assistant", role: "assistant" as const, status: "streaming" as const, content: "" };
    const saved = { ...assistant, status: "done" as const, content: "saved" };
    const get = deferred<Awaited<ReturnType<typeof api.getCodexChatSession>>>();
    transport.getCodexChatSession.mockReturnValueOnce(get.promise);
    streams.observe(remote, [user, assistant]);
    const next = streams.send(remote, "next", [], "remote");
    streams.select("another");
    expect(transport.abortCodexChatSession).toHaveBeenCalledExactlyOnceWith("p", "a", "remote", "follow_up");
    expect(transport.streamCodexChatMessage).not.toHaveBeenCalled();
    get.resolve({ session: a, messages: [user, saved] });
    await Promise.resolve();
    const successor = streams.snapshot().get("a")!;
    expect(successor.previous[0].assistant).toEqual(saved);
    const req = requests.get("p/a")!;
    req.emit({ type: "done", session: a, message: { ...successor.assistant, status: "done" } });
    req.end();
    await next;
  });
});
