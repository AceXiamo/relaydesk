import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatReasoningEffort, ChatRuntime, ChatStreamEvent } from "../app/lib/types.ts";
import { buildCliInvocation, createCliStreamParser, detectClaudeSupportsEffort, redactSecrets } from "../server/cli-stream-parser.ts";
import { getChatRuntimeInfo, runWebCliChatTurn } from "../server/codex-chat.ts";
import { projectCliConfiguration } from "../server/project-cli-config.ts";
import { Store, toAgentProject } from "../server/store.ts";

const base = {
  dbPath: ":memory:", bin: "unused", runtime: "codex", model: "", sandboxMode: "read-only",
  networkAccess: false, workspaceDir: "/workspace", reposDir: "/repos", resumeSessionId: "", projectSettings: null,
} as const;

const efforts = [
  ["off", "minimal", "0"], ["low", "low", "2048"], ["medium", "medium", "8000"],
  ["high", "high", "16000"], ["max", "xhigh", "31999"],
] as const;

describe("CLI invocation", () => {
  let temp: string;
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "relaydesk-effort-"));
    vi.stubEnv("HOME", temp);
    vi.stubEnv("CODEX_HOME", undefined);
    vi.stubEnv("MAX_THINKING_TOKENS", undefined);
    vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(temp, { recursive: true, force: true });
  });

  it.each(efforts)("maps %s for Codex and both Claude CLI generations", (effort, codex, budget) => {
    for (const resumeSessionId of ["", "existing-thread"]) {
      const params = { ...base, resumeSessionId, reasoningEffort: effort };
      const { args } = buildCliInvocation(params);
      expect(args[args.indexOf(`model_reasoning_effort="${codex}"`) - 1]).toBe("-c");
      const modern = buildCliInvocation({ ...params, runtime: "claude", claudeSupportsEffort: true });
      if (effort === "off") {
        expect(modern.args).not.toContain("--effort");
        expect(modern.env.MAX_THINKING_TOKENS).toBe("0");
      } else {
        expect(modern.args[modern.args.indexOf("--effort") + 1]).toBe(effort);
        expect(modern.env.MAX_THINKING_TOKENS).toBeUndefined();
      }
      const legacy = buildCliInvocation({ ...params, runtime: "claude", claudeSupportsEffort: false });
      expect(legacy.args).not.toContain("--effort");
      expect(legacy.env.CLAUDE_CODE_EFFORT_LEVEL).toBe(effort === "off" ? undefined : effort);
      expect(legacy.env.MAX_THINKING_TOKENS).toBe(budget);
    }
  });

  it.each(["codex", "claude"] as const)("leaves %s defaults intact and deduplicates extra mounts on fresh turns only", (runtime) => {
    const params = { ...base, runtime, extraAddDirs: ["", "  ", "/repos", "/space", "/space"] };
    const dirs = (args: string[]) => args.flatMap((arg, i) => arg === "--add-dir" ? [args[i + 1]] : []);
    for (const reasoningEffort of [undefined, "default"] satisfies Array<ChatReasoningEffort | undefined>) {
      const { args, env } = buildCliInvocation({ ...params, reasoningEffort });
      expect(dirs(args)).toEqual(["/repos", "/space"]);
      expect(args.join(" ")).not.toContain("effort");
      expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
      expect(env.MAX_THINKING_TOKENS).toBeUndefined();
    }
    const resumed = buildCliInvocation({ ...params, resumeSessionId: "same-thread" });
    expect(resumed.args).toContain("same-thread");
    expect(dirs(resumed.args)).not.toContain("/space");
  });

  it("publishes the cloud catalog and applies project defaults only for the matching runtime", async () => {
    const dbPath = join(temp, "relaydesk.sqlite3");
    const fake = join(temp, "fake-cli");
    writeFileSync(fake, "#!/bin/sh\nwhile read -r line; do :; done\nprintf '%s\\n' \"$@\" \"effort=$CLAUDE_CODE_EFFORT_LEVEL\" \"budget=$MAX_THINKING_TOKENS\"\n", { mode: 0o700 });
    vi.stubEnv("RELAYDESK_CODEX_BIN", fake);
    vi.stubEnv("RELAYDESK_CLAUDE_BIN", fake);
    const store = new Store(dbPath);
    try {
      const { id } = store.createProject({ name: "Default effort", repo: "example/test" });
      const project = toAgentProject(store.getProjectRow(id));
      const catalog = [
        { runtime: "codex", id: "custom/default", label: "Project default" },
        { runtime: "codex", id: "fixed", supports_effort: false },
        { runtime: "codex", id: "limited", effort_levels: ["low"] },
        { runtime: "codex", id: "per-model", effort_levels: ["low", "medium"], default_effort: "medium" },
      ];
      projectCliConfiguration(dbPath, id, { runtime: "codex", model: "custom/default", default_effort: "high", models: catalog });
      expect(getChatRuntimeInfo(dbPath, id).project_cli).toMatchObject({ models: catalog, default_effort: "high" });
      const session = store.createChatSession(id);
      const turn = async (runtime: ChatRuntime, model: string, reasoning_effort: ChatReasoningEffort) => {
        const result = await runWebCliChatTurn({
          project, dbPath, session: { ...session, runtime, model, reasoning_effort, external_session_id: "saved-thread" },
          prompt: "check settings", attachments: [], priorMessages: [], signal: new AbortController().signal, onEvent() {},
        });
        expect(result.status).toBe("done");
        expect(result.externalSessionId).toBe("saved-thread");
        return result.content.split("\n");
      };
      expect(await turn("codex", "", "default")).toEqual(expect.arrayContaining(["resume", "saved-thread", "custom/default", 'model_reasoning_effort="high"']));
      expect(await turn("codex", "per-model", "default")).toEqual(expect.arrayContaining(["resume", "saved-thread", "per-model", 'model_reasoning_effort="medium"']));
      for (const model of ["fixed", "limited"]) {
        expect((await turn("codex", model, "default")).join(" ")).not.toContain("model_reasoning_effort=");
      }
      const override = await turn("codex", "custom/override", "max");
      expect(override).toEqual(expect.arrayContaining(["resume", "saved-thread", "custom/override", 'model_reasoning_effort="xhigh"']));
      expect(override).not.toContain("custom/default");
      const otherRuntime = await turn("claude", "", "default");
      expect(otherRuntime).not.toContain("--effort");
      expect(otherRuntime).not.toContain("--model");
      expect(otherRuntime).toEqual(expect.arrayContaining(["effort=", "budget="]));
    } finally {
      store.close();
    }
  });

  it("probes help once per executable and distinguishes similarly named flags", () => {
    const cli = (name: string, flag: string) => {
      const path = join(temp, name);
      writeFileSync(path, `#!/bin/sh\n[ "$1" = --help ] || exit 1\nprintf '%s\\n' '  ${flag} <level>'\n`, { mode: 0o700 });
      return path;
    };
    const current = cli("current", "--effort");
    expect(detectClaudeSupportsEffort(current)).toBe(true);
    rmSync(current);
    expect(detectClaudeSupportsEffort(current)).toBe(true);
    expect(detectClaudeSupportsEffort(cli("legacy", "--effort-preview"))).toBe(false);
  });
});

function stream(runtime: ChatRuntime) {
  const events: ChatStreamEvent[] = [];
  const parser = createCliStreamParser(runtime, ["sample-secret"], (event) => events.push(event));
  const line = (obj: unknown) => parser.write(JSON.stringify(obj) + "\n");
  return { parser, events, line };
}

describe("shared CLI stream parser", () => {
  it("parses fragmented Codex JSONL, preserves the final line, and redacts tool output and errors", () => {
    const { parser, events, line } = stream("codex");
    parser.write('{"type":"thread.st');
    parser.write('arted","thread_id":"thread-1"}\r\n');
    line({ type: "item.started", item: { id: "c1", type: "command_execution", command: "run" } });
    line({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "run", aggregated_output: "sample-secret", exit_code: 0 } });
    line({ type: "agent_message.delta", delta: "Hello" });
    line({ type: "item.completed", item: { type: "agent_message", text: "Hello world" } });
    line({ type: "turn.failed", error: { message: "failed: sample-secret" } });
    parser.write("plain text without newline");
    parser.finish(false);
    expect(parser.state.externalSessionId).toBe("thread-1");
    expect(parser.state.text).toBe("Hello world\nplain text without newline");
    expect(parser.state.errorMessage).toBe("failed: [redacted]");
    expect(parser.state.toolEvents.get("c1")).toMatchObject({ status: "done", output: "[redacted]" });
    expect(JSON.stringify(events)).not.toContain("sample-secret");
  });

  it("normalizes Claude thinking, text, and tool results without duplicating the final reply", () => {
    const { parser, events, line } = stream("claude");
    line({ type: "system", session_id: "session-1" });
    line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "check sample-secret" } } });
    line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好" } } });
    line({ type: "assistant", message: { content: [
      { type: "text", text: "你好" }, { type: "tool_use", id: "c1", name: "Bash", input: { command: "inspect sample-secret" } },
    ] } });
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "sample-secret" }] } });
    line({ type: "result", result: "你好" });
    parser.finish(true);
    expect(parser.state.externalSessionId).toBe("session-1");
    expect(parser.state.text).toBe("你好");
    expect(parser.state.toolEvents.get("c1")).toMatchObject({ summary: "Bash: inspect [redacted]", status: "done", output: "[redacted]" });
    expect(events).toContainEqual({ type: "reasoning", text: "check [redacted]" });
    expect(JSON.stringify(events)).not.toContain("sample-secret");
  });

  it("redacts full connection strings before their shorter credentials", () => {
    const password = "sample-secret";
    const url = `postgres://reader:${password}@db.example/project`;
    expect(redactSecrets(`${url} ${password}`, [password, url])).toBe("[redacted] [redacted]");
  });
});
