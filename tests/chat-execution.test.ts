import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatWatchdog, type ChatTimeoutReason } from "../agent/bridge/chat-timeouts.ts";
import type { ChatStreamEvent } from "../app/lib/types.ts";
import { runWebCliChatTurn } from "../server/codex-chat.ts";
import { toAgentProject } from "../server/store.ts";
import { buildWorkspaceManifest } from "../server/workspace.ts";
import { fixture, type Fixture } from "./bridge-fixture.ts";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it("gives the lock queue a separate budget and renews only the idle deadline on progress", () => {
  vi.useFakeTimers();
  vi.stubEnv("RELAYDESK_CHAT_QUEUE_TIMEOUT_MS", "500");
  vi.stubEnv("RELAYDESK_CHAT_IDLE_TIMEOUT_MS", "100");
  vi.stubEnv("RELAYDESK_CHAT_TOTAL_TIMEOUT_MS", "250");
  const expired: ChatTimeoutReason[] = [];
  const clock = chatWatchdog(reason => expired.push(reason));
  vi.advanceTimersByTime(450);
  clock.progress();
  for (let i = 0; i < 3; i++) {
    vi.advanceTimersByTime(80);
    clock.progress();
    expect(expired).toEqual([]);
  }
  vi.advanceTimersByTime(10);
  expect(expired).toEqual(["total_timeout"]);
  clock.progress();
  vi.advanceTimersByTime(1000);
  expect(expired).toEqual(["total_timeout"]);
});

describe("interrupted chat execution", () => {
  let f: Fixture;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.close(); });

  it.each(["codex", "claude"] as const)("keeps the first %s thread, text and tool result on cloud idle timeout", async runtime => {
    vi.stubEnv("RELAYDESK_CHAT_IDLE_TIMEOUT_MS", "1000");
    const bin = join(f.root, "fixture-cli.mjs");
    writeFileSync(bin, `#!${process.execPath}
if (process.argv.includes('--help')) process.exit(0);
const emit = event => console.log(JSON.stringify(event));
if (process.argv.includes('stream-json')) {
  emit({ type: 'system', session_id: 'first-thread' });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }, { type: 'tool_use', id: 't', name: 'Read' }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'fixture' }] } });
} else {
  emit({ type: 'thread.started', thread_id: 'first-thread' });
  emit({ type: 'agent_message.delta', delta: 'partial' });
  emit({ type: 'item.completed', item: { id: 't', type: 'command_execution', command: 'pwd', aggregated_output: 'fixture', exit_code: 0 } });
}
setInterval(() => {}, 2000);
`, { mode: 0o755 });
    vi.stubEnv(runtime === "codex" ? "RELAYDESK_CODEX_BIN" : "RELAYDESK_CLAUDE_BIN", bin);
    const projectId = await f.project();
    const session = f.srv.store.createChatSession(projectId, { runtime });
    const stream: ChatStreamEvent[] = [];
    const options = { dbPath: f.dbPath, project: toAgentProject(f.srv.store.getProjectRow(projectId)), session,
      attachments: [], priorMessages: [], prompt: "run", signal: new AbortController().signal,
      onEvent: (ev: ChatStreamEvent) => stream.push(ev) };
    expect(await runWebCliChatTurn(options)).toMatchObject({ status: "error", stopReason: "idle_timeout", content: "partial",
      events: [{ id: "t", status: "done", output: "fixture" }], externalSessionId: "first-thread" });
    const started = stream.findIndex(ev => ev.type === "status" && ev.external_session_id === "first-thread");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(stream.findIndex(ev => ev.type === "text_delta"));
    const before = stream.length;
    expect(await runWebCliChatTurn({ ...options, signal: AbortSignal.abort() })).toMatchObject({ status: "aborted", content: "", events: [], externalSessionId: "" });
    expect(stream).toHaveLength(before);
  });

  it.each(["abort", "disconnect", "idle_timeout", "queue_timeout", "total_timeout"])("returns the Hub snapshot after %s without a terminal frame", async cause => {
    vi.stubEnv("RELAYDESK_CHAT_QUEUE_TIMEOUT_MS", cause === "queue_timeout" ? "180" : "2000");
    vi.stubEnv("RELAYDESK_CHAT_IDLE_TIMEOUT_MS", cause === "idle_timeout" ? "180" : "2000");
    vi.stubEnv("RELAYDESK_CHAT_TOTAL_TIMEOUT_MS", cause === "total_timeout" ? "180" : "0");
    const { id, token } = await f.register();
    const projectId = await f.project();
    const conn = await f.connect(token);
    await conn.hello([{ project_id: projectId, workdir: "/test/repo", path_ok: true }]);
    const controller = new AbortController();
    const turn = f.srv.bridgeHub.runChatTurn(id, { session_id: "s", project_id: projectId, runtime: "codex", model: "",
      reasoning_effort: "default", sandbox_mode: "read-only", network_access: false, resume_session_id: "", prompt: "run", system_context: "",
      workspace_manifest: buildWorkspaceManifest(f.dbPath, projectId) }, () => {}, controller.signal, ["fixture-secret"]);
    const { run_id } = (await conn.next("chat.start")).payload;
    if (cause === "queue_timeout") {
      expect(await turn).toMatchObject({ status: "error", stopReason: cause, content: "", externalSessionId: "", events: [] });
      return;
    }
    const emit = (event: ChatStreamEvent) => conn.send("chat.event", { run_id, session_id: "s", event });
    emit({ type: "status", message: "Started", external_session_id: "first-thread" });
    emit({ type: "text_delta", delta: "discarded" });
    emit({ type: "text_replace", text: "received fix" });
    emit({ type: "text_delta", delta: "ture-secret!" });
    for (const status of ["running", "done"] as const) emit({ type: "tool", event: { id: "t", tool: "read", status, summary: "read file" } });
    emit({ type: "tool", event: { id: "child", tool: "Agent", summary: "inspect", status: "running",
      subagent: { status: "running", activity: "checking fixture-secret" } } });
    const barrier = conn.send("workspace.fetch", { project_id: projectId, path: "HANDBOOK.md" });
    await conn.next("workspace.fetch.result", barrier);
    if (cause === "abort") controller.abort();
    if (cause === "disconnect") conn.ws.terminate();
    expect(await turn).toMatchObject({ status: cause === "abort" ? "aborted" : "error", ...(cause.endsWith("timeout") && { stopReason: cause }),
      content: "received [redacted]!", externalSessionId: "first-thread", events: [{ id: "t", status: "done" },
        { id: "child", subagent: { status: "running", activity: "checking [redacted]" } }] });
  });
});
