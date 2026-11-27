import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { agyAcpTurn } from "../server/agy-acp.ts";
import { createCliStreamParser } from "../server/cli-stream-parser.ts";

function fixture(model = "", effort = "", fullAccess = false) {
  const requests: { id: number; method?: string; params?: Record<string, unknown>; result?: object }[] = [];
  const input = new Writable({
    write(chunk, _, done) {
      requests.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  const parser = createCliStreamParser("agy", ["fixture-token"], () => {});
  const turn = agyAcpTurn(
    { model, effort, fullAccess, url: "http://localhost/mcp", token: "fixture-token" },
    "/workspace",
    "",
    "hello",
    input,
    parser.write,
  );
  const write = (message: object) => turn.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const reply = (result: object) => write({ id: requests.at(-1)?.id, result });
  turn.start();
  return { turn, write, reply, requests, input, state: parser.state };
}

it("requires advertised HTTP support before sending credentials", () => {
  const f = fixture();
  f.reply({ agentCapabilities: {} });
  expect(f.state.errorMessage).toContain("HTTP MCP");
  expect(JSON.stringify(f.requests)).not.toContain("fixture-token");
  expect(f.input.writableEnded).toBe(true);
});

it("uses model-specific effort options and keeps permission, tool and streaming events distinct", () => {
  const f = fixture("new-model", "high");
  f.reply({ agentCapabilities: { mcpCapabilities: { http: true } } });
  const option = (id: string, currentValue: string, value: string) => ({
    id,
    currentValue,
    options: [{ value }],
  });
  f.reply({ sessionId: "s", configOptions: [option("model", "old", "new-model")] });
  expect(f.requests.at(-1)?.params).toMatchObject({ configId: "model", value: "new-model" });
  f.reply({ configOptions: [option("thought_level", "low", "high")] });
  expect(f.requests.at(-1)?.params).toMatchObject({ configId: "thought_level", value: "high" });
  f.reply({});
  const prompt = f.requests.at(-1)!;
  expect(prompt.method).toBe("session/prompt");
  const update = (u: object) => f.write({ method: "session/update", params: { sessionId: "s", update: u } });
  update({ sessionUpdate: "tool_call", toolCallId: "t", kind: "read", title: "Read " + "x".repeat(400) });
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "t",
    title: "Read fixture-token " + "y".repeat(5000),
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "ok fixture-token" } }],
  });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
  f.write({ id: 99, method: "session/request_permission", params: {} });
  expect(f.requests.at(-1)?.result).toEqual({ outcome: { outcome: "cancelled" } });
  f.write({ id: prompt.id, result: { stopReason: "end_turn" } });
  expect(f.input.writableEnded).toBe(true);
  expect(f.state.text).toBe("ok");
  expect(f.state.toolEvents.get("agy-step-0")).toMatchObject({
    status: "done",
    tool: "read",
    summary: ("Read [redacted] " + "y".repeat(5000)).slice(0, 4096),
    output: "ok [redacted]",
  });
});

it("reports premature worker exit", () => {
  const f = fixture();
  f.turn.close();
  expect(f.state.errorMessage).toContain("before completing initialize");
});

it.each([false, true])("answers ACP permission requests for the active session with fullAccess=%s", (full) => {
  const f = fixture("", "", full);
  f.reply({ agentCapabilities: { mcpCapabilities: { http: true } } });
  f.reply({ sessionId: "s", configOptions: [] });
  const ask = (sessionId: string, kinds: string[]) => {
    const options = kinds.map(kind => ({ kind, optionId: "id-" + kind }));
    f.write({ id: 99, method: "session/request_permission", params: { sessionId, options } });
    return f.requests.at(-1)?.result;
  };
  const cancelled = { outcome: { outcome: "cancelled" } };
  const selected = (kind: string) => ({ outcome: { outcome: "selected", optionId: "id-" + kind } });
  expect(ask("s", ["reject_once", "allow_always", "allow_once"])).toEqual(full ? selected("allow_once") : cancelled);
  expect(ask("s", ["allow_always"])).toEqual(full ? selected("allow_always") : cancelled);
  expect(ask("s", ["reject_once"])).toEqual(cancelled);
  expect(ask("other", ["allow_once"])).toEqual(cancelled);
});
