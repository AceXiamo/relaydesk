import { expect, it, vi } from "vitest";
import { ChatLink } from "../agent/bridge/chat-link.ts";

const transport = () => ({ open: () => true, rpc: vi.fn(async () => ({})), emit: vi.fn() });
const done = { status: "done" as const, content: "one two", externalSessionId: "thread", events: [] };

it("holds a terminal result across a lost socket until the new hub connection acknowledges it", async () => {
  const first = transport(), next = transport();
  const link = new ChatLink(first, 1000, new AbortController());
  link.detach();
  const receipt = link.finish(done);
  expect(first.emit).not.toHaveBeenCalled();
  link.attach(next);
  expect(next.emit).toHaveBeenCalledExactlyOnceWith({ type: "done" }, done);
  link.received();
  await receipt;
});

it("restores the whole text snapshot without replaying an RPC that may have already committed", async () => {
  const first = transport(), next = transport(), abort = new AbortController();
  const link = new ChatLink(first, 1000, abort);
  first.rpc.mockRejectedValueOnce(new Error("reply lost"));
  await expect(link.rpc("task.rpc", {}, abort.signal)).rejects.toThrow("reply lost");
  link.event({ type: "text_delta", delta: "one " });
  link.detach();
  link.event({ type: "text_delta", delta: "two" });
  const read = link.rpc("workspace.fetch", {}, abort.signal);
  link.attach(next);
  await read;
  expect(first.rpc).toHaveBeenCalledTimes(1);
  expect(next.rpc).toHaveBeenCalledExactlyOnceWith("workspace.fetch", {}, abort.signal);
  expect(next.emit).toHaveBeenCalledWith({ type: "text_replace", text: "one two" });
  link.cancel();
});

it("replays only the latest snapshot of each subagent after reconnect", () => {
  const first = transport(), next = transport();
  const link = new ChatLink(first, 1000, new AbortController());
  const running = { id: "a", tool: "Agent", summary: "inspect", status: "running", subagent: { status: "running" } } as const;
  link.event({ type: "tool", event: running });
  link.detach();
  const done = { ...running, status: "done", subagent: { status: "done" }, output: "result" } as const;
  link.event({ type: "tool", event: done });
  link.event({ type: "tool", event: { ...running, id: "b" } });
  link.attach(next);
  expect(next.emit.mock.calls.map(([event]) => event)).toEqual([
    { type: "text_replace", text: "" }, { type: "tool", event: done }, { type: "tool", event: { ...running, id: "b" } },
  ]);
  link.cancel();
});

it("releases pending calls and kills the child when the grace expires", async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController(), link = new ChatLink(transport(), 30, abort);
    link.detach();
    const read = link.rpc("workspace.fetch", {}, abort.signal);
    const receipt = link.finish(done);
    vi.advanceTimersByTime(31);
    await receipt;
    await expect(read).rejects.toThrow();
    expect(abort.signal.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});
