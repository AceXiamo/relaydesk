import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ChatReasoningEffort, ChatRuntime, ChatSandboxMode, ChatStreamEvent, ChatToolEvent } from "../app/lib/types.ts";
import type { readProjectCliSettings } from "./project-cli-config.ts";

const MAX_OUTPUT_CHARS = 120_000;
const MAX_TOOL_OUTPUT_CHARS = 3000;

export function redactSecrets(text: string, secrets: string[]): string {
  let result = text;
  // Sort longest secrets first so full connection URLs are redacted before shorter password substrings.
  const ordered = [...new Set(secrets)]
    .filter((s) => s && s.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    result = result.split(secret).join("[redacted]");
  }
  return result
    .replace(
      /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[\w]{16,})/g,
      "[redacted]",
    )
    .replace(
      /((?:postgres(?:ql)?|mysql|mariadb|redis|rediss|mongodb(?:\+srv)?):\/\/[^:\s/@]+:)[^@\s/]+(@)/gi,
      "$1[redacted]$2",
    );
}

function ensureWritableCliHome(dbPath: string, currentHome?: string): string | null {
  const trimmed = currentHome?.trim() ?? "";
  if (trimmed && trimmed !== "/") {
    if (!existsSync(trimmed)) {
      try {
        mkdirSync(trimmed, { recursive: true, mode: 0o700 });
      } catch {
        // Fall through to persistent data dir fallback below.
      }
    }
    if (existsSync(trimmed)) return trimmed;
  }
  if (dbPath && dbPath !== ":memory:") {
    const fallback = join(dirname(resolve(dbPath)), ".cli-home");
    try {
      mkdirSync(fallback, { recursive: true, mode: 0o700 });
      return fallback;
    } catch {
      return null;
    }
  }
  return null;
}

function shouldUseLegacyCodexLandlock(): boolean {
  const raw = process.env.RELAYDESK_CODEX_LEGACY_LANDLOCK?.trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return process.platform === "linux" && existsSync("/.dockerenv");
}

const claudeEffortSupport = new Map<string, boolean>();

export function detectClaudeSupportsEffort(bin: string): boolean {
  const cached = claudeEffortSupport.get(bin);
  if (cached !== undefined) return cached;
  const help = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 3000 });
  const supported = help.status === 0 && /(?:^|\s)--effort(?=[\s=,]|$)/m.test(`${help.stdout}\n${help.stderr}`);
  claudeEffortSupport.set(bin, supported);
  return supported;
}

const codexEffort = { off: "minimal", low: "low", medium: "medium", high: "high", max: "xhigh" } as const;

export function buildCliInvocation(params: {
  dbPath: string;
  runtime: ChatRuntime;
  bin: string;
  model: string;
  reasoningEffort?: ChatReasoningEffort;
  extraAddDirs?: string[];
  claudeSupportsEffort?: boolean;
  sandboxMode: ChatSandboxMode;
  networkAccess: boolean;
  workspaceDir: string;
  reposDir: string | null;
  resumeSessionId: string;
  projectSettings: ReturnType<typeof readProjectCliSettings> | null;
  datasourceEnv?: Record<string, string>;
  datasourceSecrets?: string[];
  pgReadOnlyEnforced?: boolean;
}): { args: string[]; env: NodeJS.ProcessEnv; secrets: string[] } {
  const {
    dbPath,
    runtime,
    model,
    sandboxMode,
    networkAccess,
    workspaceDir,
    reposDir,
    resumeSessionId,
    projectSettings,
    datasourceEnv,
    datasourceSecrets,
    pgReadOnlyEnforced,
  } = params;

  const env: NodeJS.ProcessEnv = { ...process.env };
  const secrets: string[] = [...(datasourceSecrets ?? [])];

  const cliHome = ensureWritableCliHome(dbPath, env.HOME);
  if (cliHome) {
    env.HOME = cliHome;
  }

  if (datasourceEnv) {
    for (const [key, value] of Object.entries(datasourceEnv)) {
      env[key] = value;
    }
  }
  if (pgReadOnlyEnforced) {
    const existingPgOptions = (env.PGOPTIONS ?? "").trim();
    if (!existingPgOptions.includes("default_transaction_read_only")) {
      env.PGOPTIONS = existingPgOptions
        ? `${existingPgOptions} -c default_transaction_read_only=on`
        : "-c default_transaction_read_only=on";
    }
  }

  const runtimeSettings = projectSettings?.runtime === runtime ? projectSettings : null;
  const useProjectKey = Boolean(runtimeSettings?.api_key);
  const effectiveModel = model.trim() || runtimeSettings?.model.trim() || "";
  const effort = params.reasoningEffort ?? "default";
  const addDirs = new Set([reposDir, ...(resumeSessionId ? [] : params.extraAddDirs ?? [])]
    .filter((dir): dir is string => !!dir?.trim()));
  const addDirArgs = Array.from(addDirs).flatMap((dir) => ["--add-dir", dir]);

  if (runtime === "codex") {
    if (cliHome && !env.CODEX_HOME) {
      const codexHome = join(cliHome, ".codex");
      try {
        mkdirSync(codexHome, { recursive: true, mode: 0o700 });
        env.CODEX_HOME = codexHome;
      } catch {
        // Ignore if codex home cannot be pre-created; CLI will handle it.
      }
    }

    const overrides: string[] = [];
    if (shouldUseLegacyCodexLandlock()) {
      overrides.push("-c", "features.use_legacy_landlock=true");
    }
    if (useProjectKey && projectSettings) {
      secrets.push(projectSettings.api_key);
      if (projectSettings.github_token) secrets.push(projectSettings.github_token);
      if (projectSettings.endpoint) {
        env.RELAYDESK_PROVIDER_API_KEY = projectSettings.api_key;
        overrides.push(
          "-c",
          'model_provider="relaydesk"',
          "-c",
          'model_providers.relaydesk.name="Relaydesk"',
          "-c",
          'model_providers.relaydesk.env_key="RELAYDESK_PROVIDER_API_KEY"',
          "-c",
          'model_providers.relaydesk.wire_api="responses"',
          "-c",
          `model_providers.relaydesk.base_url=${JSON.stringify(projectSettings.endpoint)}`,
        );
      } else {
        env.CODEX_API_KEY = projectSettings.api_key;
      }
    }

    if (networkAccess) {
      overrides.push("-c", "sandbox_workspace_write.network_access=true");
    }

    if (effectiveModel) overrides.push("-m", effectiveModel);
    if (effort !== "default") {
      overrides.push("-c", `model_reasoning_effort=${JSON.stringify(codexEffort[effort])}`);
    }

    // Codex only honors sandbox_workspace_write.network_access under workspace-write sandbox.
    const effectiveCodexSandbox: ChatSandboxMode = networkAccess ? "workspace-write" : sandboxMode;

    if (resumeSessionId) {
      const args = [
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        "-c",
        `sandbox_mode=${JSON.stringify(effectiveCodexSandbox)}`,
        ...(useProjectKey ? ["--ignore-user-config"] : []),
        ...overrides,
        resumeSessionId,
        "-",
      ];
      return { args, env, secrets };
    }

    const args = [
      "-a",
      "never",
      "exec",
      "--json",
      "--sandbox",
      effectiveCodexSandbox,
      "--skip-git-repo-check",
      "-C",
      workspaceDir,
      ...addDirArgs,
      ...(useProjectKey ? ["--ignore-user-config"] : []),
      ...overrides,
      "-",
    ];
    return { args, env, secrets };
  }

  // Claude Code runtime
  if (!env.DISABLE_AUTOUPDATER) env.DISABLE_AUTOUPDATER = "1";
  if (!env.DISABLE_NONESSENTIAL_TRAFFIC) env.DISABLE_NONESSENTIAL_TRAFFIC = "1";
  if (useProjectKey && projectSettings) {
    secrets.push(projectSettings.api_key);
    env.ANTHROPIC_API_KEY = projectSettings.api_key;
    if (projectSettings.endpoint) {
      env.ANTHROPIC_BASE_URL = projectSettings.endpoint;
    }
  }
  const effortArgs: string[] = [];
  if (effort === "off") env.MAX_THINKING_TOKENS = "0";
  else if (effort !== "default") {
    if (params.claudeSupportsEffort ?? detectClaudeSupportsEffort(params.bin)) {
      effortArgs.push("--effort", effort);
    } else {
      env.CLAUDE_CODE_EFFORT_LEVEL = effort;
      env.MAX_THINKING_TOKENS = { low: "2048", medium: "8000", high: "16000", max: "31999" }[effort];
    }
  }
  const tools =
    sandboxMode === "workspace-write"
      ? "Read,Grep,Glob,Bash,Edit,Write"
      : "Read,Grep,Glob,Bash";
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools,
    "--allowedTools",
    tools,
    ...addDirArgs,
    ...(effectiveModel ? ["--model", effectiveModel] : []),
    ...effortArgs,
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
  ];
  return { args, env, secrets };
}

export interface StreamParseState {
  externalSessionId: string;
  text: string;
  hadIncrementalDelta: boolean;
  toolEvents: Map<string, ChatToolEvent>;
  errorMessage: string;
}

function upsertToolEvent(
  state: StreamParseState,
  event: ChatToolEvent,
  emit: (ev: ChatStreamEvent) => void,
) {
  const prev = state.toolEvents.get(event.id);
  const merged: ChatToolEvent = prev
    ? {
        ...prev,
        ...event,
        summary: event.summary || prev.summary,
        output: event.output ?? prev.output,
      }
    : event;
  state.toolEvents.set(merged.id, merged);
  emit({ type: "tool", event: merged });
}

function extractTextFromContentArray(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") return p.text;
        if (typeof p.output_text === "string") return p.output_text;
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

export function handleCodexJsonLine(
  obj: Record<string, unknown>,
  state: StreamParseState,
  secrets: string[],
  emit: (ev: ChatStreamEvent) => void,
) {
  const type = String(obj.type ?? "");

  if (type === "thread.started" && typeof obj.thread_id === "string" && obj.thread_id) {
    state.externalSessionId = obj.thread_id;
    emit({ type: "status", message: "已建立 Codex 会话线程", external_session_id: obj.thread_id });
    return;
  }

  if (type === "turn.started") {
    emit({ type: "status", message: "Codex 正在思考与检查项目空间…" });
    return;
  }

  if (type === "error" || type === "turn.failed") {
    const errObj = obj.error as Record<string, unknown> | undefined;
    const msg =
      (typeof obj.message === "string" && obj.message) ||
      (typeof errObj?.message === "string" && errObj.message) ||
      "Codex 执行出错";
    state.errorMessage = redactSecrets(msg, secrets);
    return;
  }

  // Handle incremental delta events if emitted by newer Codex versions
  if (
    (type === "item.agentMessage.delta" ||
      type === "agent_message.delta" ||
      type === "response.output_text.delta") &&
    typeof obj.delta === "string" &&
    obj.delta
  ) {
    const chunk = redactSecrets(obj.delta, secrets);
    state.hadIncrementalDelta = true;
    state.text = (state.text + chunk).slice(0, MAX_OUTPUT_CHARS);
    emit({ type: "text_delta", delta: chunk });
    return;
  }

  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") return;
    const itemType = String(item.type ?? "");
    const itemId = String(item.id ?? `${itemType}-${state.toolEvents.size + 1}`);

    if (itemType === "command_execution" || itemType === "shell_call" || itemType === "local_shell_call") {
      const cmd = String(item.command ?? item.cmd ?? "").trim() || "执行命令";
      const status =
        type === "item.completed"
          ? Number(item.exit_code ?? 0) === 0
            ? "done"
            : "error"
          : "running";
      const rawOut =
        typeof item.aggregated_output === "string"
          ? item.aggregated_output
          : typeof item.output === "string"
            ? item.output
            : undefined;
      upsertToolEvent(
        state,
        {
          id: itemId,
          tool: "shell",
          summary: redactSecrets(cmd, secrets).slice(0, 300),
          status,
          output: rawOut !== undefined ? redactSecrets(rawOut, secrets).slice(0, MAX_TOOL_OUTPUT_CHARS) : undefined,
          exit_code: typeof item.exit_code === "number" ? item.exit_code : null,
        },
        emit,
      );
      return;
    }

    if (itemType === "file_change") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((c) => (c && typeof c === "object" ? String((c as Record<string, unknown>).path ?? "") : ""))
        .filter(Boolean);
      const summary = paths.length ? `文件变更：${paths.join(", ")}` : "修改工作区文件";
      upsertToolEvent(
        state,
        {
          id: itemId,
          tool: "file_change",
          summary: summary.slice(0, 300),
          status: type === "item.completed" ? "done" : "running",
        },
        emit,
      );
      return;
    }

    if (itemType === "mcp_tool_call" || itemType === "tool_call") {
      const toolName = String(item.tool ?? item.name ?? "tool");
      upsertToolEvent(
        state,
        {
          id: itemId,
          tool: toolName,
          summary: `${toolName}`,
          status: type === "item.completed" ? (item.error ? "error" : "done") : "running",
        },
        emit,
      );
      return;
    }

    if (itemType === "reasoning") {
      const reasoningText =
        typeof item.text === "string"
          ? item.text
          : extractTextFromContentArray(item.summary ?? item.content);
      if (reasoningText.trim()) {
        emit({ type: "reasoning", text: redactSecrets(reasoningText.trim(), secrets).slice(0, 600) });
      }
      return;
    }

    if (itemType === "agent_message" || itemType === "message") {
      const msgText =
        typeof item.text === "string" ? item.text : extractTextFromContentArray(item.content);
      if (msgText) {
        const clean = redactSecrets(msgText, secrets).slice(0, MAX_OUTPUT_CHARS);
        if (type === "item.completed") {
          if (!state.text) {
            state.text = clean;
            emit({ type: "text_delta", delta: clean });
          } else if (clean !== state.text) {
            if (clean.startsWith(state.text)) {
              const delta = clean.slice(state.text.length);
              state.text = clean;
              if (delta) emit({ type: "text_delta", delta });
            } else if (state.hadIncrementalDelta) {
              // Append as a new paragraph if Codex produced multiple agent_message items in one turn
              const combined = `${state.text}\n\n${clean}`.slice(0, MAX_OUTPUT_CHARS);
              state.text = combined;
              emit({ type: "text_replace", text: combined });
            } else {
              const combined = `${state.text}\n\n${clean}`.slice(0, MAX_OUTPUT_CHARS);
              state.text = combined;
              emit({ type: "text_replace", text: combined });
            }
          }
        } else if (type === "item.updated" && clean.startsWith(state.text)) {
          const delta = clean.slice(state.text.length);
          if (delta) {
            state.hadIncrementalDelta = true;
            state.text = clean;
            emit({ type: "text_delta", delta });
          }
        }
      }
    }
  }
}

export function handleClaudeJsonLine(
  obj: Record<string, unknown>,
  state: StreamParseState,
  secrets: string[],
  emit: (ev: ChatStreamEvent) => void,
) {
  const type = String(obj.type ?? "");
  if (typeof obj.session_id === "string" && obj.session_id && !state.externalSessionId) {
    state.externalSessionId = obj.session_id;
    emit({ type: "status", message: "已建立 Claude Code 会话", external_session_id: obj.session_id });
  }

  if (type === "stream_event" && obj.event && typeof obj.event === "object") {
    const ev = obj.event as Record<string, unknown>;
    const evType = String(ev.type ?? "");
    if (evType === "content_block_delta" && ev.delta && typeof ev.delta === "object") {
      const delta = ev.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        const clean = redactSecrets(delta.text, secrets);
        state.hadIncrementalDelta = true;
        state.text = (state.text + clean).slice(0, MAX_OUTPUT_CHARS);
        emit({ type: "text_delta", delta: clean });
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
        emit({ type: "reasoning", text: redactSecrets(delta.thinking, secrets).slice(0, 600) });
      }
    } else if (evType === "content_block_start" && ev.content_block && typeof ev.content_block === "object") {
      const block = ev.content_block as Record<string, unknown>;
      if (block.type === "tool_use") {
        const id = String(block.id ?? `tool-${state.toolEvents.size + 1}`);
        const name = String(block.name ?? "tool");
        upsertToolEvent(
          state,
          { id, tool: name, summary: `调用 ${name}`, status: "running" },
          emit,
        );
      }
    }
    return;
  }

  if (type === "assistant" && obj.message && typeof obj.message === "object") {
    const content = (obj.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use") {
          const id = String(b.id ?? `tool-${state.toolEvents.size + 1}`);
          const name = String(b.name ?? "tool");
          const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
          const detail =
            typeof input.command === "string"
              ? input.command
              : typeof input.file_path === "string"
                ? basename(input.file_path)
                : typeof input.path === "string"
                  ? input.path
                  : typeof input.pattern === "string"
                    ? input.pattern
                    : name;
          upsertToolEvent(
            state,
            { id, tool: name, summary: `${name}: ${redactSecrets(detail, secrets).slice(0, 220)}`, status: "running" },
            emit,
          );
        } else if (b.type === "text" && typeof b.text === "string" && !state.hadIncrementalDelta) {
          const clean = redactSecrets(b.text, secrets).slice(0, MAX_OUTPUT_CHARS);
          if (clean && !state.text) {
            state.text = clean;
            emit({ type: "text_delta", delta: clean });
          }
        }
      }
    }
    return;
  }

  if (type === "user" && obj.message && typeof obj.message === "object") {
    const content = (obj.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          const existing = state.toolEvents.get(b.tool_use_id);
          if (existing) {
            const rawOut = extractTextFromContentArray(b.content);
            upsertToolEvent(
              state,
              {
                ...existing,
                status: b.is_error ? "error" : "done",
                output: rawOut ? redactSecrets(rawOut, secrets).slice(0, MAX_TOOL_OUTPUT_CHARS) : existing.output,
              },
              emit,
            );
          }
        }
      }
    }
    return;
  }

  if (type === "result") {
    if (obj.is_error || obj.subtype === "error_during_execution") {
      const msg = typeof obj.result === "string" && obj.result ? obj.result : "Claude Code 执行失败";
      state.errorMessage = redactSecrets(msg, secrets);
    } else if (typeof obj.result === "string" && obj.result && !state.text) {
      const clean = redactSecrets(obj.result, secrets).slice(0, MAX_OUTPUT_CHARS);
      state.text = clean;
      emit({ type: "text_delta", delta: clean });
    }
    for (const ev of state.toolEvents.values()) {
      if (ev.status === "running") {
        upsertToolEvent(state, { ...ev, status: "done" }, emit);
      }
    }
  }
}

export function createCliStreamParser(
  runtime: ChatRuntime,
  secrets: string[],
  onEvent: (event: ChatStreamEvent) => void,
) {
  const state: StreamParseState = {
    externalSessionId: "",
    text: "",
    hadIncrementalDelta: false,
    toolEvents: new Map(),
    errorMessage: "",
  };
  let remainder = "";
  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (runtime === "codex") {
          handleCodexJsonLine(parsed as Record<string, unknown>, state, secrets, onEvent);
        } else {
          handleClaudeJsonLine(parsed as Record<string, unknown>, state, secrets, onEvent);
        }
        return;
      }
    } catch {
      // Plain-text fallback when a CLI emits raw text instead of JSONL.
    }
    const clean = redactSecrets(rawLine, secrets);
    state.text = (state.text + (state.text ? "\n" : "") + clean).slice(0, MAX_OUTPUT_CHARS);
    onEvent({ type: "text_delta", delta: (state.text === clean ? "" : "\n") + clean });
  };

  return {
    state,
    write(chunk: string) {
      const lines = (remainder + chunk).split(/\r?\n/);
      remainder = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    },
    finish(success: boolean) {
      if (remainder) processLine(remainder);
      remainder = "";
      for (const ev of state.toolEvents.values()) {
        if (ev.status === "running") {
          upsertToolEvent(
            state,
            { ...ev, status: success ? "done" : "error" },
            onEvent,
          );
        }
      }
    },
  };
}
