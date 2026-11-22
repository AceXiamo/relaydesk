import { describe, expect, it, vi } from "vitest";
import { messagesWithTurn, ProjectChatStreams } from "../app/lib/chat-streams.ts";
import type { ChatSessionRecord, ChatStreamEvent } from "../app/lib/types.ts";

function session(project_id: string, id: string): ChatSessionRecord {
  return { project_id, id, title: id, runtime: "codex", model: "", sandbox_mode: "read-only",
    network_access: false, execution_target: "auto", resolved_target: "", reasoning_effort: "default",
    external_session_id: "", status: "idle", created_at: "", updated_at: "" };
}

function fixture() {
  const requests = new Map<string, { emit: (ev: ChatStreamEvent) => void; end: () => void; signal?: AbortSignal }>();
  const streamCodexChatMessage = vi.fn((project: string, id: string, _payload: unknown, emit: (ev: ChatStreamEvent) => void, signal?: AbortSignal) =>
    new Promise<void>(resolve => {
      requests.set(`${project}/${id}`, { emit, end: resolve, signal });
      signal?.addEventListener("abort", () => resolve(), { once: true });
    }));
  const transport = { streamCodexChatMessage, abortCodexChatSession: vi.fn(async () => ({ aborted: true })) };
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
    expect(run.signal?.aborted).toBe(false);
    reconnect();
    run.emit({ type: "done", session: a, message: { ...live.assistant, content: "finished", status: "done" } });
    run.end();
    await first;
    streams.retire("a", live);
    expect(streams.snapshot().get("a")).toMatchObject({ running: false, assistant: { content: "finished" } });
    streams.abort("b");
    otherProject.abort("a");
    await Promise.all([second, third]);
  });

  it("stops only the requested turn and holds the session until its abort POST settles", async () => {
    const { streams, transport, requests } = fixture();
    let acknowledge!: () => void;
    transport.abortCodexChatSession.mockImplementationOnce(() => new Promise(resolve => {
      acknowledge = () => resolve({ aborted: true });
    }));
    const a = session("p", "a");
    const first = streams.send(a, "question", []);
    const other = streams.send(session("p", "b"), "other", []);
    streams.abort("a");
    streams.abort("a");
    expect(transport.abortCodexChatSession).toHaveBeenCalledExactlyOnceWith("p", "a");
    expect(requests.get("p/a")?.signal?.aborted).toBe(true);
    expect(requests.get("p/b")?.signal?.aborted).toBe(false);
    await streams.send(a, "too soon", []);
    expect(transport.streamCodexChatMessage).toHaveBeenCalledTimes(2);
    acknowledge();
    await first;
    expect(streams.snapshot().get("a")).toMatchObject({ running: false, statusLine: "", assistant: { status: "aborted" } });
    requests.get("p/b")!.end();
    await expect(other).rejects.toThrow("回复连接已中断");
    expect(streams.snapshot().get("b")?.assistant.status).toBe("error");
  });
});
