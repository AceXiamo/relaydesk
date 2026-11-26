import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatToolEvent } from "../app/lib/types.ts";
import { createCliStreamParser } from "../server/cli-stream-parser.ts";

function stream() {
  const events: ChatToolEvent[] = [];
  const parser = createCliStreamParser("codex", ["sample-secret"], event => {
    if (event.type === "tool") events.push(event.event);
  });
  function call(id: string, tool: string, fields: Record<string, unknown>) {
    parser.write(JSON.stringify({ type: "item.completed", item: { id, type: "collab_tool_call", tool, ...fields } }) + "\n");
  }
  return { parser, events, call };
}

describe("Codex collaboration events", () => {
  it("keeps concurrent children separate across a shared wait and redacts their snapshots", () => {
    const { parser, call } = stream();
    call("spawn1", "spawn_agent", { receiver_thread_ids: ["a"], prompt: "first sample-secret" });
    call("spawn2", "spawn_agent", { receiver_thread_ids: ["b"], prompt: "second" });
    call("wait", "wait", { receiver_thread_ids: ["a", "b"], agents_states: {
      a: { status: "running", message: "reading sample-secret" },
      b: { status: "errored", message: "failed sample-secret" },
    } });
    expect([...parser.state.toolEvents.values()]).toMatchObject([
      { id: "spawn1", summary: "first [redacted]", subagent: { status: "running", activity: "reading [redacted]" } },
      { id: "spawn2", summary: "second", output: "failed [redacted]", subagent: { status: "error" } },
    ]);
    call("wait2", "wait", { agents_states: { a: { status: "completed", message: "result sample-secret" } } });
    call("close", "close_agent", { agents_states: { a: { status: "shutdown", message: null } } });
    expect(parser.state.toolEvents.get("spawn1")).toMatchObject({ status: "done", output: "result [redacted]", subagent: { status: "done" } });
  });

  it.each([true, false])("preserves the latest child snapshot on parent exit (success=%s)", success => {
    const { parser, call } = stream();
    call("spawn", "spawn_agent", { receiver_thread_ids: ["a"], prompt: "constant", agents_states: { a: { status: "running" } } });
    const snapshot = parser.state.toolEvents.get("spawn");
    parser.finish(success);
    expect(parser.state.toolEvents.get("spawn")).toBe(snapshot);
  });

  it("treats missing snapshots and unaddressed waits conservatively", () => {
    const { parser, call } = stream();
    call("empty", "wait", { receiver_thread_ids: [], agents_states: {}, status: "completed" });
    expect([...parser.state.toolEvents.values()]).toEqual([{ id: "empty", tool: "wait", summary: "wait", status: "done" }]);
    call("wait", "wait", { receiver_thread_ids: ["a"], status: "completed" });
    call("close", "close_agent", { agents_states: { a: { status: "interrupted" } } });
    expect([...parser.state.toolEvents.values()].filter(e => e.subagent)).toMatchObject([{ subagent: { status: "interrupted" } }]);
  });

  it("closes a visible wait when its target only arrives at completion", () => {
    const { parser, call } = stream();
    parser.write('{"type":"item.started","item":{"id":"w","type":"collab_tool_call","tool":"wait","receiver_thread_ids":[]}}\n');
    expect(parser.state.toolEvents.get("w")).toMatchObject({ tool: "wait", status: "running" });
    call("w", "wait", { agents_states: { a: { status: "running" } } });
    expect([...parser.state.toolEvents.values()]).toMatchObject([
      { tool: "wait", status: "done" }, { subagent: { status: "running" } },
    ]);
  });

  it("bounds task, activity, result, and id before publishing", () => {
    const { parser, call } = stream();
    const text = "sample-secret" + "x".repeat(40000);
    call("s".repeat(270), "spawn_agent", { prompt: text, agents_states: { a: { status: "running", message: text } } });
    const [running] = parser.state.toolEvents.values();
    expect(running.id.length).toBeLessThanOrEqual(256);
    expect(running.summary).toBe(("[redacted]" + "x".repeat(4096)).slice(0, 4096));
    expect(running.subagent?.activity).toBe(running.summary);
    call("wait", "wait", { agents_states: { a: { status: "completed", message: text } } });
    expect(parser.state.toolEvents.get(running.id)?.output).toBe(("[redacted]" + "x".repeat(32768)).slice(0, 32768));
  });

  // Recorded with codex-cli 0.171.0, multi_agent_version=v1, in an empty read-only workspace.
  it("replays the sanitized CLI recording through fragmented stdout", () => {
    const { parser, events } = stream();
    const jsonl = readFileSync(new URL("./fixtures/codex-subagents.jsonl", import.meta.url), "utf8").trimEnd();
    for (let offset = 0; offset < jsonl.length; offset += 37) parser.write(jsonl.slice(offset, offset + 37));
    parser.finish(true);
    expect(parser.state.text).toContain("COPPER");
    expect(new Set(events.map(event => event.id))).toEqual(new Set(["item_1"]));
    expect(events.map(event => event.subagent?.status)).toEqual(["unknown", "running", "running", "done", "done", "done"]);
    expect(events.every(event => event.summary === "Reply only COPPER.")).toBe(true);
    expect([...parser.state.toolEvents.values()]).toMatchObject([{ status: "done", output: "COPPER", subagent: { status: "done" } }]);
  });

  it("preserves prior subagent task summary when a resumed turn receives wait/close updates", () => {
    const events: ChatToolEvent[] = [];
    const parser = createCliStreamParser(
      "codex",
      ["sample-secret"],
      (event) => { if (event.type === "tool") events.push(event.event); },
      undefined,
      undefined,
      {
        env: {},
        resumeId: "thread-1",
        priorSubagents: [
          {
            id: "codex-agent-child-1",
            tool: "spawn_agent",
            summary: "检查跨轮次状态同步",
            status: "running",
            subagent: { status: "unknown" },
          },
        ],
      },
    );

    parser.write(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "wait-2",
          type: "collab_tool_call",
          tool: "wait",
          agents_states: { "child-1": { status: "completed", message: "同步完成 sample-secret" } },
        },
      }) + "\n",
    );
    expect(parser.state.toolEvents.get("codex-agent-child-1")).toMatchObject({
      tool: "spawn_agent",
      summary: "检查跨轮次状态同步",
      status: "done",
      output: "同步完成 [redacted]",
      subagent: { status: "done" },
    });
  });
});
