import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { readProjectCliSettings } from "./project-cli-config.ts";
import {
  getWorkspaceDatasourceRuntimeEnv,
  prepareProjectChatWorkspace,
  readProjectRepoFileContent,
  readWorkspaceFile,
} from "./workspace.ts";
import type {
  AgentProjectInfo,
  ChatContextRef,
  ChatMessageRecord,
  ChatRuntime,
  ChatRuntimeInfo,
  ChatSandboxMode,
  ChatSessionRecord,
  ChatStreamEvent,
  ChatToolEvent,
  TaskRecord,
} from "../app/lib/types.ts";

const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_OUTPUT_CHARS = 120_000;
const MAX_TOOL_OUTPUT_CHARS = 3000;
const CLI_DETECT_TTL_MS = 30_000;

interface CliDetectionCache {
  checkedAt: number;
  codex: string | null;
  claude: string | null;
}

let cliCache: CliDetectionCache | null = null;
const activeSessionProcesses = new Map<string, { abort: () => void }>();

function resolveExecutable(name: "codex" | "claude"): string | null {
  const envKey = name === "codex" ? "RELAYDESK_CODEX_BIN" : "RELAYDESK_CLAUDE_BIN";
  const override = process.env[envKey]?.trim();
  if (override) {
    return existsSync(override) ? override : null;
  }
  const res = spawnSync("which", [name], { encoding: "utf8", timeout: 3000 });
  if (res.status === 0) {
    const found = res.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (found && existsSync(found)) return found;
  }
  return null;
}

export function detectLocalClis(forceRefresh = false): {
  codex: boolean;
  claude: boolean;
  codexBin: string | null;
  claudeBin: string | null;
} {
  const now = Date.now();
  if (!forceRefresh && cliCache && now - cliCache.checkedAt < CLI_DETECT_TTL_MS && !process.env.RELAYDESK_CODEX_BIN && !process.env.RELAYDESK_CLAUDE_BIN) {
    return {
      codex: Boolean(cliCache.codex),
      claude: Boolean(cliCache.claude),
      codexBin: cliCache.codex,
      claudeBin: cliCache.claude,
    };
  }
  const codexBin = resolveExecutable("codex");
  const claudeBin = resolveExecutable("claude");
  cliCache = { checkedAt: now, codex: codexBin, claude: claudeBin };
  return {
    codex: Boolean(codexBin),
    claude: Boolean(claudeBin),
    codexBin,
    claudeBin,
  };
}

export function getChatRuntimeInfo(dbPath: string, projectId: string): ChatRuntimeInfo {
  const clis = detectLocalClis();
  let settings = {
    runtime: "codex" as ChatRuntime,
    endpoint: "",
    model: "",
    api_key: "",
  };
  try {
    settings = readProjectCliSettings(dbPath, projectId);
  } catch {
    // Fall back to default when persistent settings are unavailable (e.g. :memory:).
  }

  const codexAuth = !clis.codex
    ? "unavailable"
    : settings.runtime === "codex" && settings.api_key
      ? "project_key"
      : "local_cli";
  const claudeAuth = !clis.claude
    ? "unavailable"
    : settings.runtime === "claude" && settings.api_key
      ? "project_key"
      : "local_cli";

  return {
    local_clis: { codex: clis.codex, claude: clis.claude },
    project_cli: {
      runtime: settings.runtime,
      configured: Boolean(settings.api_key),
      endpoint: settings.endpoint,
      model: settings.model,
    },
    auth_mode: {
      codex: codexAuth,
      claude: claudeAuth,
    },
  };
}

export function abortChatSessionRun(sessionId: string): boolean {
  const entry = activeSessionProcesses.get(sessionId);
  if (!entry) return false;
  entry.abort();
  return true;
}

export function isChatSessionRunning(sessionId: string): boolean {
  return activeSessionProcesses.has(sessionId);
}

function redactSecrets(text: string, secrets: string[]): string {
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

function buildAttachmentContext(
  dbPath: string,
  project: AgentProjectInfo,
  attachments: ChatContextRef[],
  workspaceDatabases: ReturnType<typeof prepareProjectChatWorkspace>["databases"],
  resolveTask?: (taskId: string) => TaskRecord | null,
): string {
  if (!attachments.length) return "";
  const blocks: string[] = [];
  for (const att of attachments.slice(0, 8)) {
    if (att.kind === "file") {
      try {
        const detail = readWorkspaceFile(dbPath, project.id, att.ref);
        if (detail.is_text && detail.content) {
          blocks.push(
            `### Referenced Workspace File: files/${detail.path}\n\`\`\`\n${detail.content.slice(0, 8000)}\n\`\`\``,
          );
        } else {
          blocks.push(
            `### Referenced Workspace File: files/${detail.path} (${detail.is_sqlite ? "SQLite database" : "binary"}, ${detail.size} bytes)`,
          );
        }
      } catch {
        blocks.push(`### Referenced Workspace File: files/${att.ref}`);
      }
    } else if (att.kind === "repo_file") {
      try {
        const file = readProjectRepoFileContent(dbPath, project, {
          repo: att.repo,
          path: att.ref,
          start_line: 1,
          end_line: 150,
        });
        if (!file.error && file.content) {
          blocks.push(
            `### Referenced Repository File: ${file.repo}:${file.path}\n\`\`\`\n${file.content.slice(0, 8000)}\n\`\`\``,
          );
        } else {
          blocks.push(`### Referenced Repository File: ${att.repo ? `${att.repo}:` : ""}${att.ref}`);
        }
      } catch {
        blocks.push(`### Referenced Repository File: ${att.repo ? `${att.repo}:` : ""}${att.ref}`);
      }
    } else if (att.kind === "database") {
      const matchedDb = workspaceDatabases.find(
        (db) =>
          db.id === att.ref ||
          db.env_var === att.ref ||
          (db.file_path && (`files/${db.file_path}` === att.ref || db.file_path === att.ref)) ||
          db.host_preview === att.ref ||
          db.name === att.label,
      );
      if (matchedDb && matchedDb.source === "external") {
        blocks.push(
          [
            `### Referenced External Datasource: ${matchedDb.name} (${matchedDb.kind.toUpperCase()})`,
            matchedDb.env_var && matchedDb.has_connection_url
              ? `- Connection env var: $${matchedDb.env_var} (already injected into subprocess env; NEVER echo/print its value)`
              : `- Connection URL: not configured`,
            matchedDb.host_preview ? `- Endpoint: ${matchedDb.host_preview}` : "",
            `- Access policy: ${matchedDb.read_only ? "STRICT READ-ONLY (no writes/DDL)" : "read-write"}`,
            matchedDb.notes ? `- Schema / notes:\n${matchedDb.notes.slice(0, 2000)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } else if (matchedDb && matchedDb.source === "workspace_file") {
        blocks.push(
          `### Referenced SQLite Database: ${matchedDb.name} (./files/${matchedDb.file_path}, ${matchedDb.table_count ?? 0} tables)`,
        );
      } else {
        blocks.push(`### Referenced Database: ${att.label} (${att.ref})`);
      }
    } else if (att.kind === "task") {
      const task = resolveTask?.(att.ref);
      if (task) {
        blocks.push(
          [
            `### Referenced Task: RD-${task.number} — ${task.title}`,
            `- Status: ${task.status} | Priority: ${task.priority} | Owner: ${task.owner}`,
            task.delivery_ref ? `- Delivery ref: ${task.delivery_ref}` : "",
            task.body ? `- Description:\n${task.body.slice(0, 3000)}` : "",
            task.requirements ? `- Requirements:\n${task.requirements.slice(0, 2000)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } else {
        blocks.push(`### Referenced Task: ${att.label} (${att.ref})`);
      }
    }
  }
  return blocks.join("\n\n");
}

function buildInitialPrompt(params: {
  project: AgentProjectInfo;
  runtime: ChatRuntime;
  workspace: ReturnType<typeof prepareProjectChatWorkspace>;
  sandboxMode: ChatSandboxMode;
  networkAccess: boolean;
  pgReadOnlyEnforced: boolean;
  userPrompt: string;
  attachmentContext: string;
  priorMessages?: ChatMessageRecord[];
}): string {
  const {
    project,
    runtime,
    workspace,
    sandboxMode,
    networkAccess,
    pgReadOnlyEnforced,
    userPrompt,
    attachmentContext,
    priorMessages,
  } = params;
  const lines: string[] = [
    `You are the project assistant for "${project.name}" inside Relaydesk Project Space.`,
    `Your current working directory is the project workspace root:`,
    `- ./files/ : Project Space files uploaded or created by the operator (including documents, fixtures, CSVs, and SQLite databases).`,
    `- ./HANDBOOK.md : Project handbook maintained by the operator (if present).`,
    workspace.readyRepos.length > 0
      ? `- ./repos/ : Read-only synced git mirrors for bound repositories (${workspace.readyRepos.map((r) => `${r.repo} -> repos/${r.dirName} @ ${r.commit.slice(0, 8)}`).join(", ")}).`
      : `- Bound repositories: ${(project.repos.length ? project.repos : [project.repo]).filter(Boolean).join(", ") || "none synced locally yet"}.`,
    sandboxMode === "workspace-write"
      ? `- Mode: workspace-write (you may create or edit files under ./files/ when asked; never modify ./repos/ or disclose secrets).`
      : `- Mode: read-only (inspect files, repositories, and databases without modifying any project files under ./files/ or ./repos/).`,
    runtime === "codex"
      ? networkAccess
        ? `- Network: ENABLED for this session (you may connect to configured external datasources using local CLI clients or query remote services when asked).`
        : `- Network: DISABLED by Codex sandbox (only local files and local SQLite databases are reachable; if the operator asks to connect to a remote database or install a package, let them know to enable "允许联网" in the chat toolbar).`
      : `- Network: follows local Claude Code runtime environment (external database CLI connections are available when configured).`,
    `- Security: NEVER print, echo, log, or reveal raw values of RELAYDESK_DB_* environment variables or any database passwords/connection URLs.`,
    `- Answer in the same language as the user's message. Cite concrete file paths, table names, or command results when relevant.`,
  ];

  if (project.agent_instructions.trim()) {
    lines.push("", "## Project Instructions", project.agent_instructions.trim().slice(0, 4000));
  }

  if (workspace.handbook.exists && workspace.handbook.content.trim()) {
    lines.push("", "## Project Handbook (HANDBOOK.md)", workspace.handbook.content.trim().slice(0, 12000));
  }

  if (workspace.files.length > 0) {
    const fileLines = workspace.files
      .filter((f) => f.type === "file")
      .slice(0, 40)
      .map((f) => `- files/${f.path} (${f.size} B${f.is_sqlite ? ", SQLite" : ""})`);
    if (fileLines.length > 0) {
      lines.push("", "## Workspace Files", ...fileLines);
    }
  }

  if (workspace.databases.length > 0) {
    const dbLines = workspace.databases.map((db) => {
      if (db.source === "workspace_file") {
        return `- [SQLite] ${db.name}: path=./files/${db.file_path} (${db.table_count ?? 0} tables; inspect with sqlite3/python3/node)`;
      }
      const envPart =
        db.has_connection_url && db.env_var
          ? `env=$${db.env_var}`
          : "no connection URL configured";
      const accessPart = db.read_only
        ? "STRICT READ-ONLY (only SELECT/SHOW/DESCRIBE/EXPLAIN; never execute writes or DDL)"
        : "read-write";
      const notePart = db.notes ? `\n  Notes: ${db.notes.slice(0, 1000)}` : "";
      return `- [${db.kind.toUpperCase()}] ${db.name}: ${envPart}, endpoint=${db.host_preview || "external"}, access=${accessPart}${notePart}`;
    });
    const installedClients = workspace.dbClients
      .filter((c) => c.installed)
      .map((c) => c.id);
    const missingClients = workspace.dbClients
      .filter((c) => !c.installed)
      .map((c) => `${c.id} (${c.install_hint})`);

    lines.push("", "## Project Databases", ...dbLines);
    lines.push(
      `- Local DB CLI clients installed: ${installedClients.length > 0 ? installedClients.join(", ") : "none detected"}`,
    );
    if (missingClients.length > 0) {
      lines.push(`- Missing DB CLI clients (install on host if needed): ${missingClients.join("; ")}`);
    }
    if (pgReadOnlyEnforced) {
      lines.push(
        `- PostgreSQL read-only guardrail active: PGOPTIONS is preconfigured with default_transaction_read_only=on.`,
      );
    }
    lines.push(
      `- Usage example: psql "$RELAYDESK_DB_..." -c "SELECT ..." (or mysql / redis-cli -u "$RELAYDESK_DB_..." / mongosh "$RELAYDESK_DB_..."). Never print the env var itself.`,
    );
  }

  if (priorMessages && priorMessages.length > 0) {
    lines.push("", "## Previous Conversation Summary");
    for (const msg of priorMessages.slice(-8)) {
      const label = msg.role === "user" ? "User" : "Assistant";
      lines.push(`[${label}]: ${msg.content.slice(0, 1500)}`);
    }
  }

  if (attachmentContext) {
    lines.push("", "## Explicitly Attached Context", attachmentContext);
  }

  lines.push("", "## User Message", userPrompt);
  return lines.join("\n");
}

function buildResumePrompt(userPrompt: string, attachmentContext: string): string {
  if (!attachmentContext) return userPrompt;
  return `${attachmentContext}\n\n## User Message\n${userPrompt}`;
}

function buildCliInvocation(params: {
  runtime: ChatRuntime;
  bin: string;
  model: string;
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

  const useProjectKey =
    Boolean(projectSettings && projectSettings.runtime === runtime && projectSettings.api_key);
  const effectiveModel = model.trim() || (projectSettings?.runtime === runtime ? projectSettings.model.trim() : "");

  if (runtime === "codex") {
    const overrides: string[] = [];
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

    if (effectiveModel) {
      overrides.push("-m", effectiveModel);
    }

    if (resumeSessionId) {
      const args = [
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        ...(useProjectKey ? ["--ignore-user-config"] : []),
        ...overrides,
        resumeSessionId,
        "-",
      ];
      return { args, env, secrets };
    }

    // Codex only honors sandbox_workspace_write.network_access under workspace-write sandbox.
    const effectiveCodexSandbox: ChatSandboxMode = networkAccess ? "workspace-write" : sandboxMode;
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
      ...(reposDir ? ["--add-dir", reposDir] : []),
      ...(useProjectKey ? ["--ignore-user-config"] : []),
      ...overrides,
      "-",
    ];
    return { args, env, secrets };
  }

  // Claude Code runtime
  if (useProjectKey && projectSettings) {
    secrets.push(projectSettings.api_key);
    env.ANTHROPIC_API_KEY = projectSettings.api_key;
    if (projectSettings.endpoint) {
      env.ANTHROPIC_BASE_URL = projectSettings.endpoint;
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
    ...(reposDir ? ["--add-dir", reposDir] : []),
    ...(effectiveModel ? ["--model", effectiveModel] : []),
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
  ];
  return { args, env, secrets };
}

interface StreamParseState {
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

function handleCodexJsonLine(
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

function handleClaudeJsonLine(
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

export interface RunChatTurnOptions {
  dbPath: string;
  project: AgentProjectInfo;
  session: ChatSessionRecord;
  prompt: string;
  attachments: ChatContextRef[];
  priorMessages: ChatMessageRecord[];
  signal: AbortSignal;
  resolveTask?: (taskId: string) => TaskRecord | null;
  onEvent: (event: ChatStreamEvent) => void;
}

export interface RunChatTurnResult {
  content: string;
  events: ChatToolEvent[];
  externalSessionId: string;
  status: "done" | "error" | "aborted";
  error?: string;
}

function runSingleCliAttempt(params: {
  sessionId: string;
  runtime: ChatRuntime;
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinPrompt: string;
  secrets: string[];
  signal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}): Promise<{
  exitCode: number | null;
  aborted: boolean;
  timedOut: boolean;
  stderr: string;
  state: StreamParseState;
}> {
  const { sessionId, runtime, bin, args, cwd, env, stdinPrompt, secrets, signal, onEvent } = params;
  return new Promise((resolve) => {
    const state: StreamParseState = {
      externalSessionId: "",
      text: "",
      hadIncrementalDelta: false,
      toolEvents: new Map(),
      errorMessage: "",
    };
    let aborted = false;
    let timedOut = false;
    let stderrBuf = "";
    let stdoutRemainder = "";
    let settled = false;
    let proc: ChildProcess;

    try {
      proc = spawn(bin, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      state.errorMessage = `无法启动 ${runtime} CLI：${err instanceof Error ? err.message : String(err)}`;
      resolve({ exitCode: -1, aborted: false, timedOut: false, stderr: state.errorMessage, state });
      return;
    }

    const killProc = () => {
      if (proc.killed) return;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      const forceTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000);
      forceTimer.unref();
    };

    const doAbort = () => {
      aborted = true;
      killProc();
    };

    activeSessionProcesses.set(sessionId, { abort: doAbort });
    const onSignalAbort = () => doAbort();
    if (signal.aborted) {
      doAbort();
    } else {
      signal.addEventListener("abort", onSignalAbort, { once: true });
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProc();
    }, DEFAULT_TIMEOUT_MS);
    timeoutTimer.unref();

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

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutRemainder += chunk.toString("utf8");
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < 8000) {
        stderrBuf += chunk.toString("utf8").slice(0, 8000 - stderrBuf.length);
      }
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      signal.removeEventListener("abort", onSignalAbort);
      if (activeSessionProcesses.get(sessionId)?.abort === doAbort) {
        activeSessionProcesses.delete(sessionId);
      }
      if (stdoutRemainder.trim()) {
        processLine(stdoutRemainder);
      }
      for (const ev of state.toolEvents.values()) {
        if (ev.status === "running") {
          upsertToolEvent(
            state,
            { ...ev, status: exitCode === 0 && !aborted ? "done" : "error" },
            onEvent,
          );
        }
      }
      resolve({
        exitCode,
        aborted,
        timedOut,
        stderr: redactSecrets(stderrBuf.trim(), secrets),
        state,
      });
    };

    proc.on("error", (err) => {
      state.errorMessage = `启动 ${runtime} 进程失败：${err.message}`;
      finish(-1);
    });

    proc.on("close", (code) => {
      finish(code);
    });

    try {
      proc.stdin?.end(stdinPrompt, "utf8");
    } catch {
      // ignore EPIPE if process exited immediately
    }
  });
}

export async function runWebCliChatTurn(options: RunChatTurnOptions): Promise<RunChatTurnResult> {
  const { dbPath, project, session, prompt, attachments, priorMessages, signal, resolveTask, onEvent } =
    options;
  const clis = detectLocalClis();
  const bin = session.runtime === "codex" ? clis.codexBin : clis.claudeBin;
  if (!bin) {
    const label = session.runtime === "codex" ? "Codex CLI (`codex`)" : "Claude Code (`claude`)";
    return {
      content: "",
      events: [],
      externalSessionId: session.external_session_id,
      status: "error",
      error: `当前服务器未检测到本机 ${label}，请先安装或切换到已安装的 CLI 运行工具。`,
    };
  }

  let projectSettings: ReturnType<typeof readProjectCliSettings> | null = null;
  try {
    projectSettings = readProjectCliSettings(dbPath, project.id);
  } catch {
    projectSettings = null;
  }

  const workspace = prepareProjectChatWorkspace(dbPath, project);
  const datasourceRuntime = getWorkspaceDatasourceRuntimeEnv(dbPath, project.id);
  const attachmentContext = buildAttachmentContext(
    dbPath,
    project,
    attachments,
    workspace.databases,
    resolveTask,
  );

  const runWithResume = Boolean(session.external_session_id);
  const execute = async (resumeId: string) => {
    const stdinPrompt = resumeId
      ? buildResumePrompt(prompt, attachmentContext)
      : buildInitialPrompt({
          project,
          runtime: session.runtime,
          workspace,
          sandboxMode: session.sandbox_mode,
          networkAccess: session.network_access,
          pgReadOnlyEnforced: datasourceRuntime.pgReadOnlyEnforced,
          userPrompt: prompt,
          attachmentContext,
          priorMessages,
        });
    const invocation = buildCliInvocation({
      runtime: session.runtime,
      bin,
      model: session.model,
      sandboxMode: session.sandbox_mode,
      networkAccess: session.network_access,
      workspaceDir: workspace.workspaceDir,
      reposDir: workspace.reposDir,
      resumeSessionId: resumeId,
      projectSettings,
      datasourceEnv: datasourceRuntime.env,
      datasourceSecrets: datasourceRuntime.secrets,
      pgReadOnlyEnforced: datasourceRuntime.pgReadOnlyEnforced,
    });
    return runSingleCliAttempt({
      sessionId: session.id,
      runtime: session.runtime,
      bin,
      args: invocation.args,
      cwd: workspace.workspaceDir,
      env: invocation.env,
      stdinPrompt,
      secrets: invocation.secrets,
      signal,
      onEvent,
    });
  };

  onEvent({
    type: "status",
    message: runWithResume
      ? `正在续接 ${session.runtime === "codex" ? "Codex" : "Claude"} 会话…`
      : `正在启动 ${session.runtime === "codex" ? "Codex" : "Claude"}（工作区已挂载项目文件与手册）…`,
  });

  let attempt = await execute(session.external_session_id);

  // If resuming a prior CLI thread failed before producing any output, transparently retry with a fresh thread seeded with conversation history.
  if (
    runWithResume &&
    !attempt.aborted &&
    !attempt.timedOut &&
    attempt.exitCode !== 0 &&
    !attempt.state.text
  ) {
    onEvent({ type: "status", message: "原 CLI 线程不可复用，正在携带上下文开启新线程…" });
    attempt = await execute("");
  }

  const finalSessionId = attempt.state.externalSessionId || session.external_session_id;
  const events = Array.from(attempt.state.toolEvents.values());

  if (attempt.aborted) {
    return {
      content: attempt.state.text || "（已中止生成）",
      events,
      externalSessionId: finalSessionId,
      status: "aborted",
    };
  }

  if (attempt.timedOut) {
    return {
      content: attempt.state.text,
      events,
      externalSessionId: finalSessionId,
      status: "error",
      error: "本轮执行超时（超过 8 分钟）已自动停止。",
    };
  }

  if (attempt.exitCode !== 0 || (attempt.state.errorMessage && !attempt.state.text)) {
    const detail =
      attempt.state.errorMessage ||
      attempt.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" / ") ||
      `CLI 退出码 ${attempt.exitCode ?? "unknown"}`;
    return {
      content: attempt.state.text,
      events,
      externalSessionId: finalSessionId,
      status: "error",
      error: detail,
    };
  }

  const finalContent = attempt.state.text.trim() || "（执行完成，无文本输出）";
  return {
    content: finalContent,
    events,
    externalSessionId: finalSessionId,
    status: "done",
  };
}
