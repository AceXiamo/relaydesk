import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ChatContextUsage,
  ChatFastMode,
  ChatReasoningEffort,
  ChatRuntime,
  ChatSandboxMode,
  ChatStreamEvent,
  ChatToolEvent,
  ChatToolImage,
} from "../app/lib/types.ts";
import type { readProjectCliSettings } from "./project-cli-config.ts";
import { claudeContextTracker, codexContextUsage, codexRolloutMonitor } from "./cli-context-usage.ts";

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
  fastMode?: ChatFastMode;
  extraAddDirs?: string[];
  imagePaths?: string[];
  claudeSupportsEffort?: boolean;
  localAccess?: "restricted" | "full";
  sandboxMode: ChatSandboxMode;
  networkAccess: boolean;
  workspaceDir: string;
  reposDir: string | null;
  resumeSessionId: string;
  projectSettings: ReturnType<typeof readProjectCliSettings> | null;
  datasourceEnv?: Record<string, string>;
  datasourceSecrets?: string[];
  pgReadOnlyEnforced?: boolean;
  mcp?: {
    url: string;
    tokenEnvVar: string;
    claudeConfigPath?: string;
  };
}): { args: string[]; env: NodeJS.ProcessEnv; secrets: string[] } {
  const {
    dbPath,
    runtime,
    model,
    sandboxMode,
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
  const networkAccess = params.networkAccess === true && (!params.localAccess || sandboxMode === "workspace-write");
  const fullAccess = params.localAccess === "full" && networkAccess;

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

    // Local turns explicitly override the node's network default, including on resume.
    if (!fullAccess && (params.localAccess || networkAccess)) {
      overrides.push("-c", `sandbox_workspace_write.network_access=${networkAccess}`);
    }
    if (params.localAccess && !fullAccess && resumeSessionId && sandboxMode === "workspace-write" && params.extraAddDirs?.length) {
      overrides.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(params.extraAddDirs)}`);
    }

    if (effectiveModel) overrides.push("-m", effectiveModel);
    if (params.fastMode === "on" || params.fastMode === "off") {
      overrides.push("-c", params.fastMode === "on" ? 'service_tier="priority"' : 'service_tier="default"');
    }
    if (effort !== "default") {
      overrides.push("-c", `model_reasoning_effort=${JSON.stringify(codexEffort[effort])}`);
    }
    if (params.mcp?.url) {
      overrides.push(
        "-c",
        `mcp_servers.relaydesk.url=${JSON.stringify(params.mcp.url)}`,
        "-c",
        `mcp_servers.relaydesk.bearer_token_env_var=${JSON.stringify(params.mcp.tokenEnvVar)}`,
        "-c",
        'mcp_servers.relaydesk.default_tools_approval_mode="approve"',
      );
    }

    // Codex only honors sandbox_workspace_write.network_access under workspace-write sandbox.
    const effectiveCodexSandbox: ChatSandboxMode = networkAccess ? "workspace-write" : sandboxMode;
    const imageArgs: string[] = [];
    for (const imgPath of params.imagePaths ?? []) {
      if (typeof imgPath === "string" && imgPath && !imgPath.startsWith("-")) {
        imageArgs.push("--image", imgPath);
      }
    }

    if (resumeSessionId) {
      const args = [
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        ...(fullAccess ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-c", `sandbox_mode=${JSON.stringify(effectiveCodexSandbox)}`]),
        ...(useProjectKey ? ["--ignore-user-config"] : []),
        ...overrides,
        ...imageArgs,
        resumeSessionId,
        "-",
      ];
      return { args, env, secrets };
    }

    const args = [
      ...(fullAccess ? [] : ["-a", "never"]),
      "exec",
      "--json",
      ...(fullAccess ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", effectiveCodexSandbox]),
      "--skip-git-repo-check",
      "-C",
      workspaceDir,
      ...(fullAccess ? [] : addDirArgs),
      ...(useProjectKey ? ["--ignore-user-config"] : []),
      ...overrides,
      ...imageArgs,
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
      ? "Read,Grep,Glob,Bash,Edit,Write,Agent"
      : params.localAccess ? "Read,Grep,Glob" : "Read,Grep,Glob,Bash";
  const allowedTools = params.mcp?.claudeConfigPath ? `${tools},mcp__relaydesk__*` : tools;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    ...(fullAccess ? ["bypassPermissions"] : ["dontAsk", "--tools", tools, "--allowedTools", allowedTools]),
    ...(params.mcp?.claudeConfigPath ? ["--mcp-config", params.mcp.claudeConfigPath] : []),
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
  readAttachments: Map<string, ChatToolImage>;
  claudeNestedAgents?: Map<string, string>;
  errorMessage: string;
}

export type CliStreamImageHandler = (img: {
  mime: string;
  data: string;
  toolUseId?: string;
  toolName?: string;
}) => ChatToolImage | null;

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
        images: event.images?.length ? event.images : prev.images,
      }
    : event;
  state.toolEvents.set(merged.id, merged);
  emit({ type: "tool", event: merged });
}

function extractImagesFromContentArray(content: unknown): Array<{ mime: string; data: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ mime: string; data: string }> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type !== "image") continue;
    // Anthropic tool_result image block: { type: "image", source: { type: "base64", media_type, data } }
    if (p.source && typeof p.source === "object") {
      const src = p.source as Record<string, unknown>;
      if (src.type === "base64" && typeof src.data === "string" && src.data.length > 0) {
        const mime = typeof src.media_type === "string" && src.media_type ? src.media_type : "image/png";
        out.push({ mime, data: src.data });
        if (out.length >= 4) break;
        continue;
      }
    }
    // MCP tool result image block: { type: "image", mimeType, data }
    if (typeof p.data === "string" && p.data.length > 0) {
      const mime =
        typeof p.mimeType === "string" && p.mimeType
          ? p.mimeType
          : typeof p.mime_type === "string" && p.mime_type
            ? p.mime_type
            : "image/png";
      out.push({ mime, data: p.data });
      if (out.length >= 4) break;
    }
  }
  return out;
}

function collectToolImages(
  content: unknown,
  onImage: CliStreamImageHandler | undefined,
  meta: { toolUseId?: string; toolName?: string },
): ChatToolImage[] | undefined {
  if (!onImage) return undefined;
  const raw = extractImagesFromContentArray(content);
  if (!raw.length) return undefined;
  const saved: ChatToolImage[] = [];
  for (const item of raw) {
    try {
      const res = onImage({ ...item, ...meta });
      if (res && res.url) saved.push(res);
    } catch {
      // Ignore malformed/oversized tool image blocks without failing the stream.
    }
  }
  return saved.length ? saved : undefined;
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

// Codex reports a different item id for spawn, wait, and close. Keep the
// original spawn item as the card id, including before the child has a thread.
const codexAgentIds = new WeakMap<StreamParseState, Map<string, string>>();

function handleCodexCollab(
  item: Record<string, unknown>, eventType: string, state: StreamParseState, secrets: string[],
  emit: (ev: ChatStreamEvent) => void,
) {
  let agents = codexAgentIds.get(state);
  if (!agents) {
    agents = new Map();
    codexAgentIds.set(state, agents);
  }
  const spawn = item.tool === "spawn_agent";
  const clean = (value: unknown, limit: number) =>
    typeof value === "string" ? redactSecrets(value.trim(), secrets).slice(0, limit) : "";
  const itemId = clean(item.id, 256);
  const snapshots = item.agents_states && typeof item.agents_states === "object" && !Array.isArray(item.agents_states)
    ? item.agents_states as Record<string, unknown> : {};
  const receivers = new Set<string>(Array.isArray(item.receiver_thread_ids)
    ? item.receiver_thread_ids.filter((id): id is string => typeof id === "string" && !!id) : []);
  for (const id of Object.keys(snapshots)) receivers.add(id);
  if (spawn && !receivers.size && itemId) receivers.add("");
  // An unaddressed wait is still a real tool call, not evidence of a child.
  // Keep updating that call even if a later event supplies its targets.
  const priorCall = state.toolEvents.get(itemId);
  if (itemId && (!receivers.size || (priorCall && !priorCall.subagent))) {
    const tool = clean(item.tool, 128) || "collab_tool_call";
    upsertToolEvent(state, {
      id: itemId, tool, summary: tool,
      status: item.status === "failed" || item.status === "interrupted" ? "error"
        : eventType === "item.completed" ? "done" : "running",
    }, emit);
  }

  for (const thread of receivers) {
    const id = agents.get(thread) || (spawn ? itemId : clean(`codex-agent-${thread}`, 256));
    if (!id) continue;
    if (thread) agents.set(thread, id);
    const previous = state.toolEvents.get(id);
    const snapshot = Object.hasOwn(snapshots, thread) ? snapshots[thread] : null;
    const agent = snapshot && typeof snapshot === "object" ? snapshot as Record<string, unknown> : {};
    const message = clean(agent.message, 32768);
    let status = previous?.subagent?.status ?? "unknown";
    switch (agent.status) {
      case "pending_init": case "running": status = "running"; break;
      case "completed": status = "done"; break;
      case "errored": status = "error"; break;
      case "interrupted": case "shutdown":
        if (status !== "done" && status !== "error") status = "interrupted";
        break;
      case "not_found": status = "unknown"; break;
      default:
        if (spawn && item.status === "failed") status = "error";
        if (spawn && item.status === "interrupted") status = "interrupted";
    }
    const summary = (spawn && clean(item.prompt, 4096)) || previous?.summary || "Codex 子代理";
    const activity = status === "running" ? message.slice(0, 4096) || previous?.subagent?.activity : undefined;
    const output = status === "done" || status === "error" || status === "interrupted" ? message || previous?.output : undefined;
    upsertToolEvent(state, {
      id, tool: "spawn_agent", summary, status: status === "error" || status === "interrupted" ? "error"
        : status === "done" ? "done" : "running",
      subagent: { status, ...(activity ? { activity } : {}) }, ...(output ? { output } : {}),
    }, emit);
  }
}

export function handleCodexJsonLine(
  obj: Record<string, unknown>,
  state: StreamParseState,
  secrets: string[],
  emit: (ev: ChatStreamEvent) => void,
  onImage?: CliStreamImageHandler,
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

    if (itemType === "collab_tool_call") {
      handleCodexCollab(item, type, state, secrets, emit);
      return;
    }

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
      const serverName = typeof item.server === "string" && item.server ? `${item.server}.` : "";
      const toolName = String(item.tool ?? item.name ?? "tool");
      const rawArgs = item.arguments && typeof item.arguments === "object"
        ? (item.arguments as Record<string, unknown>)
        : undefined;
      const argHint = rawArgs
        ? typeof rawArgs.query === "string"
          ? rawArgs.query
          : typeof rawArgs.task === "string" || typeof rawArgs.task === "number"
            ? String(rawArgs.task)
            : typeof rawArgs.datasource === "string"
              ? rawArgs.datasource
              : typeof rawArgs.title === "string"
                ? rawArgs.title
                : ""
        : "";
      const summary = argHint
        ? `${serverName}${toolName}: ${redactSecrets(argHint, secrets).slice(0, 220)}`
        : `${serverName}${toolName}`;
      const resultObj = item.result && typeof item.result === "object"
        ? (item.result as Record<string, unknown>)
        : undefined;
      const rawOut =
        typeof item.error === "string"
          ? item.error
          : item.error && typeof item.error === "object" && typeof (item.error as Record<string, unknown>).message === "string"
            ? String((item.error as Record<string, unknown>).message)
            : resultObj && Array.isArray(resultObj.content)
              ? extractTextFromContentArray(resultObj.content)
              : typeof item.output === "string"
                ? item.output
                : undefined;
      const toolImages =
        resultObj && Array.isArray(resultObj.content)
          ? collectToolImages(resultObj.content, onImage, { toolUseId: itemId, toolName: `${serverName}${toolName}` })
          : undefined;
      upsertToolEvent(
        state,
        {
          id: itemId,
          tool: `${serverName}${toolName}`,
          summary,
          status: type === "item.completed" ? (item.error ? "error" : "done") : "running",
          output: rawOut !== undefined ? redactSecrets(rawOut, secrets).slice(0, MAX_TOOL_OUTPUT_CHARS) : undefined,
          ...(toolImages ? { images: toolImages } : {}),
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

function isClaudeAgent(name: unknown) {
  return name === "Agent" || name === "Task";
}

function claudeAgentId(raw: string, secrets: string[]) {
  if (raw.length <= 256 && redactSecrets(raw, secrets) === raw) return raw;
  return `claude-agent-${createHash("sha256").update(raw).digest("hex")}`;
}

function updateClaudeChildActivity(
  obj: Record<string, unknown>, parentId: string, state: StreamParseState,
  secrets: string[], emit: (ev: ChatStreamEvent) => void,
) {
  const owner = state.toolEvents.get(state.claudeNestedAgents?.get(parentId) ?? claudeAgentId(parentId, secrets));
  if (owner?.subagent?.status !== "running") return;
  const stream = obj.event as Record<string, unknown> | undefined;
  const message = obj.message as Record<string, unknown> | undefined;
  const blocks = obj.type === "stream_event" && stream?.type === "content_block_start"
    ? [stream.content_block]
    : obj.type === "assistant" && Array.isArray(message?.content) ? message.content : [];
  let activity = obj.type === "tool_progress" && typeof obj.tool_name === "string" ? obj.tool_name : "";
  for (const block of blocks) {
    if (block?.type === "tool_use" && typeof block.name === "string") {
      if (isClaudeAgent(block.name) && typeof block.id === "string") {
        (state.claudeNestedAgents ??= new Map()).set(block.id, owner.id);
      }
      activity = block.name;
    } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      activity = block.text.trim();
    } else if (block?.type === "thinking") {
      activity = "思考中";
    }
  }
  if (obj.type === "stream_event" && stream?.type === "content_block_delta") {
    const delta = stream.delta as Record<string, unknown> | undefined;
    if (delta?.type === "thinking_delta") activity = "思考中";
    if (delta?.type === "text_delta") activity = "正在回复";
  }
  activity = redactSecrets(activity, secrets).slice(0, 4096);
  if (activity && activity !== owner.subagent.activity) {
    upsertToolEvent(state, { ...owner, subagent: { status: "running", activity } }, emit);
  }
}

export function handleClaudeJsonLine(
  obj: Record<string, unknown>,
  state: StreamParseState,
  secrets: string[],
  emit: (ev: ChatStreamEvent) => void,
  onImage?: CliStreamImageHandler,
  lookupAttachment?: (path: string) => ChatToolImage | undefined,
) {
  const type = String(obj.type ?? "");
  if (typeof obj.parent_tool_use_id === "string" && obj.parent_tool_use_id) {
    updateClaudeChildActivity(obj, obj.parent_tool_use_id, state, secrets, emit);
    return;
  }
  if (typeof obj.session_id === "string" && obj.session_id && !state.externalSessionId) {
    state.externalSessionId = obj.session_id;
    emit({ type: "status", message: "已建立 Claude Code 会话", external_session_id: obj.session_id });
  }

  if (type === "system" && typeof obj.tool_use_id === "string") {
    const owner = state.toolEvents.get(claudeAgentId(obj.tool_use_id, secrets));
    if (owner?.subagent && (owner.subagent.status === "running" || owner.subagent.status === "unknown")) {
      if (obj.subtype === "task_progress" || obj.subtype === "task_started") {
        const raw = obj.last_tool_name || obj.description;
        if (typeof raw === "string" && raw.trim()) {
          const activity = redactSecrets(raw.trim(), secrets).slice(0, 4096);
          upsertToolEvent(state, { ...owner, subagent: { status: "running", activity } }, emit);
        }
      } else if (obj.subtype === "task_notification") {
        const status = obj.status === "completed" ? "done" : obj.status === "failed" ? "error"
          : obj.status === "stopped" ? "interrupted" : undefined;
        if (status) upsertToolEvent(state, { ...owner, status: status === "done" ? "done" : "error",
          subagent: { status },
          output: typeof obj.summary === "string" ? redactSecrets(obj.summary, secrets).slice(0, 32768) : owner.output,
        }, emit);
      }
    }
    return;
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
        const name = String(block.name ?? "tool");
        if (isClaudeAgent(name) && (typeof block.id !== "string" || !block.id)) return;
        const rawId = String(block.id ?? `tool-${state.toolEvents.size + 1}`);
        const id = isClaudeAgent(name) ? claudeAgentId(rawId, secrets) : rawId;
        if (isClaudeAgent(name) && state.toolEvents.has(id)) return;
        upsertToolEvent(
          state,
          { id, tool: name, summary: `调用 ${name}`, status: "running",
            ...(isClaudeAgent(name) ? { subagent: { status: "running" as const } } : {}) },
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
          const name = String(b.name ?? "tool");
          if (isClaudeAgent(name) && (typeof b.id !== "string" || !b.id)) continue;
          const rawId = String(b.id ?? `tool-${state.toolEvents.size + 1}`);
          const id = isClaudeAgent(name) ? claudeAgentId(rawId, secrets) : rawId;
          const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
          if (name === "Read" && typeof input.file_path === "string") {
            const image = lookupAttachment?.(input.file_path);
            if (image) state.readAttachments.set(id, image);
          }
          if (isClaudeAgent(name)) {
            const task = [input.description, input.prompt, input.subagent_type].find(
              (value): value is string => typeof value === "string" && !!value.trim(),
            );
            const previous = state.toolEvents.get(id);
            upsertToolEvent(state, {
              id, tool: name, summary: task ? redactSecrets(task.trim(), secrets).slice(0, 4096) : `调用 ${name}`,
              status: previous?.status ?? "running", subagent: previous?.subagent ?? { status: "running" },
            }, emit);
            continue;
          }
          const detail =
            (typeof input.description === "string" && input.description.trim()) ||
            (typeof input.command === "string"
              ? input.command
              : typeof input.query === "string"
                ? input.query
                : typeof input.task === "string" || typeof input.task === "number"
                  ? String(input.task)
                  : typeof input.datasource === "string"
                    ? input.datasource
                    : typeof input.title === "string"
                      ? input.title
                      : typeof input.file_path === "string"
                        ? basename(input.file_path)
                        : typeof input.path === "string"
                          ? input.path
                          : typeof input.pattern === "string"
                            ? input.pattern
                            : name);
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
          const existing = state.toolEvents.get(b.tool_use_id) ?? state.toolEvents.get(claudeAgentId(b.tool_use_id, secrets));
          if (existing) {
            if (existing.subagent) {
              // The CLI's envelope contains structured output for a single tool result only.
              const result = content.length === 1 ? obj.tool_use_result as Record<string, unknown> | undefined : undefined;
              const launched = result?.status === "async_launched";
              if (launched && existing.subagent.status !== "running") continue;
              const status = existing.subagent.status === "interrupted" || result?.status === "stopped" ? "interrupted"
                : b.is_error || result?.status === "failed" || existing.subagent.status === "error" ? "error"
                : launched ? "running" : "done";
              const raw = extractTextFromContentArray(result?.content) || extractTextFromContentArray(b.content);
              upsertToolEvent(state, { ...existing, status: status === "interrupted" ? "error" : status,
                subagent: status === "running" ? existing.subagent : { status },
                output: !launched && raw ? redactSecrets(raw, secrets).slice(0, 32768) : existing.output,
              }, emit);
              continue;
            }
            const rawOut = extractTextFromContentArray(b.content);
            const attachment = state.readAttachments.get(b.tool_use_id);
            state.readAttachments.delete(b.tool_use_id);
            const toolImages = attachment && !b.is_error && extractImagesFromContentArray(b.content).length === 1
              ? [attachment]
              : collectToolImages(b.content, onImage, { toolUseId: b.tool_use_id, toolName: existing.tool });
            upsertToolEvent(
              state,
              {
                ...existing,
                status: b.is_error ? "error" : "done",
                output: rawOut ? redactSecrets(rawOut, secrets).slice(0, MAX_TOOL_OUTPUT_CHARS) : existing.output,
                ...(toolImages ? { images: toolImages } : {}),
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
        if (!ev.subagent) upsertToolEvent(state, { ...ev, status: "done" }, emit);
      }
    }
  }
}

export function createCliStreamParser(
  runtime: ChatRuntime,
  secrets: string[],
  onEvent: (event: ChatStreamEvent) => void,
  onImage?: CliStreamImageHandler,
  lookupAttachment?: (path: string) => ChatToolImage | undefined,
  sessionFiles?: { env: NodeJS.ProcessEnv; resumeId: string; redact?: (value: string) => string },
) {
  let lastUsage: ChatContextUsage | undefined;
  function publish(usage: ChatContextUsage) {
    if (lastUsage?.used_tokens === usage.used_tokens && lastUsage.window_tokens === usage.window_tokens) return;
    lastUsage = usage;
    onEvent({ type: "context_usage", usage });
  }
  const trackClaude = claudeContextTracker(publish);
  let nativeCodexSnapshot = false;
  const state: StreamParseState = {
    externalSessionId: "",
    text: "",
    hadIncrementalDelta: false,
    toolEvents: new Map(),
    readAttachments: new Map(),
    errorMessage: "",
  };
  const rollout = runtime === "codex" && sessionFiles ? codexRolloutMonitor(sessionFiles.env, sessionFiles.resumeId, usage => {
    if (!nativeCodexSnapshot) publish(usage);
  }, activity => {
    const id = codexAgentIds.get(state)?.get(activity.threadId) ?? `codex-agent-${activity.threadId}`;
    const previous = state.toolEvents.get(id);
    const previousStatus = previous?.subagent?.status;
    const terminal = previousStatus === "done" || previousStatus === "error" || previousStatus === "interrupted";
    const status = terminal ? previousStatus : activity.kind === "completed" ? "done"
      : activity.kind === "started" ? "running" : previousStatus ?? "unknown";
    const clean = sessionFiles.redact ?? ((text: string) => redactSecrets(text, secrets));
    const output = activity.result ? clean(activity.result).slice(0, 32768) : previous?.output;
    upsertToolEvent(state, {
      id, tool: "spawn_agent", summary: (activity.task && clean(activity.task).slice(0, 4096)) || previous?.summary || "Codex 子代理",
      status: status === "done" ? "done" : status === "error" || status === "interrupted" ? "error" : "running",
      subagent: { ...previous?.subagent, status }, ...(output ? { output } : {}),
    }, onEvent);
  }) : undefined;
  let remainder = "";
  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { /* Fall back to plain text for non-JSON CLI output. */ }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      try {
        if (runtime === "codex") {
          handleCodexJsonLine(obj, state, secrets, onEvent, onImage);
          if (obj.type === "thread.started") rollout?.start(state.externalSessionId);
          if (obj.type === "token_count") {
            const usage = codexContextUsage(obj.info);
            if (usage) { nativeCodexSnapshot = true; publish(usage); }
          }
        } else {
          trackClaude(obj);
          handleClaudeJsonLine(obj, state, secrets, onEvent, onImage, lookupAttachment);
        }
      } catch { /* Never forward a malformed structured event as raw chat text. */ }
      return;
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
        if (ev.status === "running" && !(runtime === "codex" && ev.subagent)) {
          upsertToolEvent(
            state,
            runtime === "claude" && ev.subagent
              ? { ...ev, status: success ? "running" : "error", subagent: { status: success ? "unknown" : "interrupted" } }
              : { ...ev, status: success ? "done" : "error" },
            onEvent,
          );
        }
      }
      return rollout?.finish();
    },
  };
}
