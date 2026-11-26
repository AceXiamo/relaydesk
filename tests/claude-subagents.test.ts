import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatMessageRecord, ChatStreamEvent } from "../app/lib/types.ts";
import { collectPriorSubagents, createCliStreamParser, finalizeTurnSubagents } from "../server/cli-stream-parser.ts";

const secret = "fixture-secret";
function stream() {
  const events: ChatStreamEvent[] = [];
  const parser = createCliStreamParser("claude", [secret], event => events.push(event));
  const line = (row: unknown) => parser.write(`${JSON.stringify(row)}\n`);
  const message = (type: string, content: unknown[], parent_tool_use_id?: string) =>
    line({ type, message: { content }, parent_tool_use_id });
  return { parser, events, line, message };
}
const tool = (id: string, name: string, description: string) => ({ type: "tool_use", id, name, input: { description } });
const result = (tool_use_id: string, content: string, is_error = false) => ({ type: "tool_result", tool_use_id, content, is_error });

describe("Claude subagents", () => {
  it("replays two recorded foreground agents without mixing their reports into the main reply", () => {
    const { parser, events } = stream();
    // Captured with Claude Code in an empty workspace, only Agent enabled and MCP disabled.
    const recording = readFileSync(new URL("./fixtures/claude-subagents.jsonl", import.meta.url), "utf8").trimEnd();
    for (let offset = 0; offset < recording.length; offset += 37) parser.write(recording.slice(offset, offset + 37));
    parser.finish(true);
    expect(parser.state.text).toBe("ROOT_OK");
    expect(events.filter(e => e.type === "text_delta")).toEqual([{ type: "text_delta", delta: "ROOT_OK" }]);
    expect([...parser.state.toolEvents.keys()]).toEqual(["tool-agent-1", "tool-agent-2"]);
    for (const [id, answer] of [["tool-agent-1", "CHILD_OK"], ["tool-agent-2", "SECOND_OK"]]) {
      expect(events).toContainEqual(expect.objectContaining({ type: "tool", event: expect.objectContaining({ id,
        subagent: { status: "running", activity: answer },
      }) }));
      expect(parser.state.toolEvents.get(id)).toMatchObject({ tool: "Agent", status: "done", subagent: { status: "done" }, summary: `Reply ${answer}`, output: answer });
    }
  });

  it("routes interleaved children and grandchildren through their parent IDs", () => {
    const { parser, events, line, message } = stream();
    message("assistant", [tool("a", "Task", `Inspect ${secret}`), tool("b", "Agent", "Review")]);
    message("assistant", [tool("c", "Task", "Nested")], "a");
    message("assistant", [tool("d", "Read", "Read")], "b");
    line({ type: "stream_event", parent_tool_use_id: "c", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: secret } } });
    expect(parser.state.toolEvents.get("a")?.subagent?.activity).toBe("思考中");
    expect(parser.state.toolEvents.get("b")?.subagent?.activity).toBe("Read");
    message("assistant", [{ type: "text", text: `Checking ${secret}` }], "c");
    message("user", [result("a", "Child tool output")], "b");
    message("assistant", [{ type: "text", text: "Orphan" }], "missing");
    line({ type: "result", is_error: true, result: "Child error", parent_tool_use_id: "c" });
    expect(parser.state.toolEvents.get("a")).toMatchObject({ summary: "Inspect [redacted]", subagent: { status: "running", activity: "Checking [redacted]" } });
    message("user", [result("b", `Failed ${secret}`, true), result("a", "Success")]);
    expect(parser.state.toolEvents.get("b")).toMatchObject({ subagent: { status: "error" }, output: "Failed [redacted]" });
    expect(parser.state.toolEvents.get("a")).toMatchObject({ subagent: { status: "done" }, output: "Success" });
    expect([...parser.state.toolEvents.keys()]).toEqual(["a", "b"]);
    expect(parser.state.text).toBe("");
    expect(parser.state.errorMessage).toBe("");
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events.every(e => e.type === "tool")).toBe(true);
  });

  it.each([[true, "unknown"], [false, "interrupted"]] as const)("keeps unfinished work distinct on finish(%s)", (success, expected) => {
    const { parser, message, line } = stream();
    message("assistant", [tool("a", "Agent", "Review")]);
    line({ type: "user", message: { content: [result("a", "Launch acknowledged")] }, tool_use_result: { status: "async_launched" } });
    line({ type: "result", result: "Main reply" });
    expect(parser.state.toolEvents.get("a")).toMatchObject({ subagent: { status: "running" } });
    parser.finish(success);
    expect(parser.state.toolEvents.get("a")?.subagent?.status).toBe(expected);
    expect(parser.state.toolEvents.get("a")?.output).toBeUndefined();
  });

  it("limits and redacts agent metadata while preserving correlation", () => {
    const { parser, events, message } = stream();
    const id = secret + "x".repeat(256);
    const value = secret + "a".repeat(32768);
    message("assistant", [tool(id, "Task", value)]);
    message("assistant", [{ type: "text", text: value }], id);
    const [event] = parser.state.toolEvents.values();
    expect(event.id.length).toBeLessThanOrEqual(256);
    expect(event.summary).toHaveLength(4096);
    expect(event.subagent?.activity).toHaveLength(4096);
    message("user", [result(id, value)]);
    expect(parser.state.toolEvents.size).toBe(1);
    expect(parser.state.toolEvents.get(event.id)?.output).toHaveLength(32768);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("resumes prior async subagent metadata across turns and normalizes aborted running subagents", () => {
    const turn1 = stream();
    turn1.message("assistant", [tool("agent-1", "Agent", "探索 agy harness 集成")]);
    turn1.line({ type: "user", message: { content: [result("agent-1", "Launch acknowledged")] }, tool_use_result: { status: "async_launched" } });
    turn1.parser.finish(true);

    const priorMsg: ChatMessageRecord = {
      id: "m1",
      session_id: "s1",
      role: "assistant",
      content: "",
      events: [...turn1.parser.state.toolEvents.values()],
      attachments: [],
      status: "done",
      created_at: "2026-11-26T10:00:00.000Z",
    };

    const seeds = collectPriorSubagents([priorMsg]);
    expect(seeds).toEqual([
      {
        id: "agent-1",
        tool: "Agent",
        summary: "探索 agy harness 集成",
        status: "running",
        subagent: { status: "unknown" },
      },
    ]);

    const turn2Events: ChatStreamEvent[] = [];
    const turn2 = createCliStreamParser(
      "claude",
      [secret],
      (ev) => turn2Events.push(ev),
      undefined,
      undefined,
      { env: {}, resumeId: "claude-sess-1", priorSubagents: seeds },
    );

    // Unreferenced prior subagents are not eagerly added to turn 2 toolEvents
    expect(turn2.state.toolEvents.size).toBe(0);

    turn2.write(JSON.stringify({ type: "system", subtype: "task_progress", tool_use_id: "agent-1", last_tool_name: "Grep" }) + "\n");
    expect(turn2.state.toolEvents.get("agent-1")).toMatchObject({
      tool: "Agent",
      summary: "探索 agy harness 集成",
      status: "running",
      subagent: { status: "running", activity: "Grep" },
    });

    turn2.write(JSON.stringify({ type: "system", subtype: "task_notification", tool_use_id: "agent-1", status: "completed", summary: "Found 3 callers" }) + "\n");
    turn2.finish(true);
    expect(turn2.state.toolEvents.get("agent-1")).toMatchObject({
      tool: "Agent",
      summary: "探索 agy harness 集成",
      status: "done",
      output: "Found 3 callers",
      subagent: { status: "done" },
    });

    const finalized = finalizeTurnSubagents(
      [{ id: "a-run", tool: "Agent", summary: "running task", status: "running", subagent: { status: "running", activity: "Read" } }],
      "aborted",
    );
    expect(finalized).toEqual([
      { id: "a-run", tool: "Agent", summary: "running task", status: "error", subagent: { status: "interrupted", activity: "Read" } },
    ]);
  });
});
