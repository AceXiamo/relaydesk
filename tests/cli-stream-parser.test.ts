import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatReasoningEffort, ChatRuntime, ChatStreamEvent } from "../app/lib/types.ts";
import { chatImageAttachments } from "../server/chat-image-attachments.ts";
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

  it("sets Codex relaydesk MCP approval mode to approve on fresh and resumed turns", () => {
    for (const resumeSessionId of ["", "existing-thread"]) {
      const { args } = buildCliInvocation({
        ...base,
        runtime: "codex",
        resumeSessionId,
        mcp: { url: "http://127.0.0.1:4321/mcp", tokenEnvVar: "RELAYDESK_MCP_TOKEN" },
      });
      expect(args).toContain('mcp_servers.relaydesk.url="http://127.0.0.1:4321/mcp"');
      expect(args).toContain('mcp_servers.relaydesk.bearer_token_env_var="RELAYDESK_MCP_TOKEN"');
      expect(args).toContain('mcp_servers.relaydesk.default_tools_approval_mode="approve"');
    }
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
  it("reuses only the matching Read attachment in live and terminal events, even without a writable mirror", () => {
    const space = mkdtempSync(join(tmpdir(), "relaydesk-read-"));
    try {
      mkdirSync(join(space, "files"));
      const ref = "a #1.png";
      const path = join(space, "files", ref);
      writeFileSync(path, "fixture");
      const attachments = chatImageAttachments("p1", space, space, [ref]);
      const received: ChatStreamEvent[] = [];
      const parser = createCliStreamParser("claude", [], ev => received.push(ev), undefined, attachments.lookup);
      const emit = (type: string, content: unknown[]) => parser.write(JSON.stringify({ type, message: { content } }) + "\n");
      const use = (id: string, file_path: string) => ({ type: "tool_use", id, name: "Read", input: { file_path } });
      emit("assistant", [use("a", `./files/${ref}`), use("b", join(space, ref)), use("c", path)]);
      const result = (id: string, is_error = false) => ({ type: "tool_result", tool_use_id: id, is_error,
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] });
      emit("user", [result("b"), result("c", true), result("a")]);
      const expected = { id: "a", status: "done", images: [{ url: "/api/projects/p1/workspace/file?path=a%20%231.png&inline=1", alt: ref }] };
      expect(received.at(-1)).toMatchObject({ type: "tool", event: expected });
      parser.finish(true);
      expect(parser.state.toolEvents.get("a")).toMatchObject(expected);
      expect(parser.state.toolEvents.get("b")?.images).toBeUndefined();
      expect(parser.state.toolEvents.get("c")?.images).toBeUndefined();
    } finally {
      rmSync(space, { recursive: true, force: true });
    }
  });
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

  it("extracts base64 images from Claude tool_result and Codex mcp_tool_call via onImage", () => {
    const claudeEvents: ChatStreamEvent[] = [];
    const claudeParser = createCliStreamParser(
      "claude",
      [],
      (ev) => claudeEvents.push(ev),
      (img) => ({ url: `/api/projects/p1/workspace/file?path=_chat_images/${img.toolName}.png&inline=1`, alt: img.mime }),
    );
    claudeParser.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "mcp__browser__screenshot", input: {} }] },
      }) + "\n",
    );
    claudeParser.write(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "Captured" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
              ],
            },
          ],
        },
      }) + "\n",
    );
    expect(claudeParser.state.toolEvents.get("t1")).toMatchObject({
      status: "done",
      output: "Captured",
      images: [{ url: "/api/projects/p1/workspace/file?path=_chat_images/mcp__browser__screenshot.png&inline=1", alt: "image/png" }],
    });

    const codexParser = createCliStreamParser(
      "codex",
      [],
      () => undefined,
      (img) => ({ url: `/api/projects/p1/workspace/file?path=_chat_images/${img.toolName}.jpg&inline=1`, alt: img.mime }),
    );
    codexParser.write(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "m1",
          type: "mcp_tool_call",
          server: "browser",
          tool: "shot",
          result: {
            content: [{ type: "image", mimeType: "image/jpeg", data: "/9j/4AAQ" }],
          },
        },
      }) + "\n",
    );
    expect(codexParser.state.toolEvents.get("m1")).toMatchObject({
      status: "done",
      images: [{ url: "/api/projects/p1/workspace/file?path=_chat_images/browser.shot.jpg&inline=1", alt: "image/jpeg" }],
    });
  });

  it("passes --image flags to Codex and enables Agent tool for Claude workspace-write", () => {
    const codexFresh = buildCliInvocation({
      dbPath: ":memory:",
      runtime: "codex",
      bin: "codex",
      model: "gpt-5.4",
      sandboxMode: "read-only",
      networkAccess: false,
      workspaceDir: "/tmp/ws",
      reposDir: null,
      imagePaths: ["/tmp/ws/files/_chat_images/a.png"],
      resumeSessionId: "",
      projectSettings: null,
    });
    expect(codexFresh.args).toContain("--image");
    expect(codexFresh.args).toContain("/tmp/ws/files/_chat_images/a.png");

    const codexResume = buildCliInvocation({
      dbPath: ":memory:",
      runtime: "codex",
      bin: "codex",
      model: "gpt-5.4",
      sandboxMode: "read-only",
      networkAccess: false,
      workspaceDir: "/tmp/ws",
      reposDir: null,
      imagePaths: ["/tmp/ws/files/_chat_images/b.png"],
      resumeSessionId: "thread-9",
      projectSettings: null,
    });
    expect(codexResume.args).toContain("--image");
    expect(codexResume.args).toContain("/tmp/ws/files/_chat_images/b.png");

    const claudeWrite = buildCliInvocation({
      dbPath: ":memory:",
      runtime: "claude",
      bin: "claude",
      model: "",
      sandboxMode: "workspace-write",
      networkAccess: false,
      workspaceDir: "/tmp/ws",
      reposDir: null,
      resumeSessionId: "",
      projectSettings: null,
      claudeSupportsEffort: false,
    });
    const toolsIdx = claudeWrite.args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(claudeWrite.args[toolsIdx + 1]).toContain("Agent");
  });
});
