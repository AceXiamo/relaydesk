import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chatImageAttachments } from "./chat-image-attachments.ts";
import {
  buildCliInvocation,
  createCliStreamParser,
  formatCliStdinPrompt,
  redactSecrets,
  type CliStreamImageHandler,
  type StreamParseState,
} from "./cli-stream-parser.ts";
import { canResumeExternalSession } from "./execution-router.ts";
import { readProjectCliSettings } from "./project-cli-config.ts";
import {
  startRelaydeskMcpServer,
  type RelaydeskMcpHandle,
  type RelaydeskMcpTaskClient,
} from "./relaydesk-mcp.ts";
import { builtinModels } from "../app/lib/model-catalog.ts";
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
  TaskMessage,
  TaskRecord,
} from "../app/lib/types.ts";

import { chatTimeoutMessage, chatWatchdog, type ChatTimeoutReason } from "../agent/bridge/chat-timeouts.ts";
import { formatChatHistory } from "./chat-history.ts";

const CLI_DETECT_TTL_MS = 30_000;

interface CliDetectionCache {
  checkedAt: number;
  codex: string | null;
  claude: string | null;
  agy: string | null;
}

let cliCache: CliDetectionCache | null = null;
const activeSessionProcesses = new Map<string, { abort: () => void }>();

function resolveExecutable(name: ChatRuntime): string | null {
  const envKey = name === "codex" ? "RELAYDESK_CODEX_BIN" : name === "agy" ? "RELAYDESK_AGY_BIN" : "RELAYDESK_CLAUDE_BIN";
  const override = process.env[envKey]?.trim();
  if (override) {
    return existsSync(override) ? override : null;
  }
  const res = spawnSync("which", [name], { encoding: "utf8", timeout: 3000 });
  if (res.status === 0) {
    const found = res.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (found && existsSync(found)) return found;
  }
  if (name === "agy") {
    const localInstall = join(homedir(), ".local", "bin", "agy");
    if (existsSync(localInstall)) return localInstall;
  }
  return null;
}

export function detectLocalClis(forceRefresh = false): {
  codex: boolean;
  claude: boolean;
  agy: boolean;
  codexBin: string | null;
  claudeBin: string | null;
  agyBin: string | null;
} {
  const now = Date.now();
  if (!forceRefresh && cliCache && now - cliCache.checkedAt < CLI_DETECT_TTL_MS && !process.env.RELAYDESK_CODEX_BIN && !process.env.RELAYDESK_CLAUDE_BIN && !process.env.RELAYDESK_AGY_BIN) {
    return {
      codex: Boolean(cliCache.codex),
      claude: Boolean(cliCache.claude),
      agy: Boolean(cliCache.agy),
      codexBin: cliCache.codex,
      claudeBin: cliCache.claude,
      agyBin: cliCache.agy,
    };
  }
  const codexBin = resolveExecutable("codex");
  const claudeBin = resolveExecutable("claude");
  const agyBin = resolveExecutable("agy");
  cliCache = { checkedAt: now, codex: codexBin, claude: claudeBin, agy: agyBin };
  return {
    codex: Boolean(codexBin),
    claude: Boolean(claudeBin),
    agy: Boolean(agyBin),
    codexBin,
    claudeBin,
    agyBin,
  };
}

export function getChatRuntimeInfo(dbPath: string, projectId: string): ChatRuntimeInfo {
  const clis = detectLocalClis();
  let settings: ReturnType<typeof readProjectCliSettings> | null = null;
  try {
    settings = readProjectCliSettings(dbPath, projectId);
  } catch {
    // Fall back to default when persistent settings are unavailable (e.g. :memory:).
  }

  const codexAuth = !clis.codex
    ? "unavailable"
    : settings?.runtime === "codex" && settings.api_key
      ? "project_key"
      : "local_cli";
  const claudeAuth = !clis.claude
    ? "unavailable"
    : settings?.runtime === "claude" && settings.api_key
      ? "project_key"
      : "local_cli";
  const agyAuth = !clis.agy ? "unavailable" : "local_cli";

  return {
    local_clis: { codex: clis.codex, claude: clis.claude, agy: clis.agy },
    project_cli: {
      runtime: settings?.runtime ?? "codex",
      configured: Boolean(settings?.api_key),
      endpoint: settings?.endpoint ?? "",
      model: settings?.model ?? "",
      models: settings?.models ?? [],
      default_effort: settings?.default_effort ?? "default",
    },
    auth_mode: {
      codex: codexAuth,
      claude: claudeAuth,
      agy: agyAuth,
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

export interface ResolvedTaskAttachment {
  task: TaskRecord;
  messages?: TaskMessage[];
  merged?: TaskRecord[];
}

export type TaskAttachmentResolver = (taskId: string) => TaskRecord | ResolvedTaskAttachment | null;

export const RELAYDESK_MCP_INSTRUCTIONS = [
  "## Relaydesk MCP Tools (`relaydesk`)",
  "- Task tools: `list_tasks`, `get_task`, `comment_task`, `update_task`, `transition_task`, `create_task` (all scoped to this project).",
  "- Database tools: `list_datasources`, `describe_datasource`, `query_datasource` (strictly read-only inspection/queries for project SQLite files and configured external databases; works even in read-only chat mode without Bash).",
  "- Follow the operator's explicit intent: when asked to analyze or investigate a task, inspect code/data first and post findings via `comment_task` if asked or helpful; do NOT transition task status, close, merge, or create tasks unless the operator asks or clearly instructs you to.",
  "- Never reveal or print raw database connection URLs, passwords, or tokens.",
].join("\n");

export function buildAttachmentContext(
  dbPath: string,
  project: AgentProjectInfo,
  attachments: ChatContextRef[],
  workspaceDatabases: ReturnType<typeof prepareProjectChatWorkspace>["databases"],
  resolveTask?: TaskAttachmentResolver,
  options?: { spaceDirVar?: string },
): string {
  if (!attachments.length) return "";
  const filePrefix = options?.spaceDirVar ? `${options.spaceDirVar}/files` : "./files";
  const blocks: string[] = [];
  for (const att of attachments.slice(0, 8)) {
    if (att.kind === "image") {
      blocks.push(
        `### Attached Image: ${att.label}\n- Path: ${filePrefix}/${att.ref}\n- Inspect this image directly (for Claude Code, call the Read tool on this path).`,
      );
    } else if (att.kind === "file") {
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
      const resolved = resolveTask?.(att.ref);
      const detail: ResolvedTaskAttachment | null = resolved
        ? "task" in resolved
          ? resolved
          : { task: resolved }
        : null;
      if (detail) {
        const { task, messages = [], merged = [] } = detail;
        const threadLines = messages
          .slice(-12)
          .map((m) => {
            const limit = m.kind === "comment" ? 800 : 200;
            return `  - [${m.created_at}] (${m.author}/${m.kind}) ${m.body.slice(0, limit)}`;
          });
        const mergedLines = merged
          .slice(0, 8)
          .map((m) => `  - RD-${m.number}: ${m.title}`);
        blocks.push(
          [
            `### Referenced Task: RD-${task.number} — ${task.title}`,
            `- Task ID: ${task.id} | Code: RD-${task.number}`,
            `- Status: ${task.status} | Priority: ${task.priority} | Owner: ${task.owner} | Source: ${task.source}`,
            task.resolution || task.triaged_by
              ? `- Resolution: ${task.resolution ?? "none"} | Triaged by: ${task.triaged_by ?? "none"}`
              : "",
            task.delivery_ref ? `- Delivery ref: ${task.delivery_ref}` : "",
            task.source_url ? `- Source URL: ${task.source_url}` : "",
            task.body ? `- Description:\n${task.body.slice(0, 3000)}` : "",
            task.requirements ? `- Requirements:\n${task.requirements.slice(0, 2000)}` : "",
            mergedLines.length > 0 ? `- Linked feedback:\n${mergedLines.join("\n")}` : "",
            threadLines.length > 0 ? `- Recent comments & events (${messages.length} total):\n${threadLines.join("\n")}` : "",
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
    `- ./HANDBOOK.md : Project handbook maintained by the operator (${workspace.handbook.exists ? "present" : "not created yet"}).`,
    `- ./DEPLOY.md : Project deployment runbook (${workspace.deployDoc.exists ? "present" : "not created yet"}).`,
    workspace.readyRepos.length > 0
      ? `- ./repos/ : Read-only synced git mirrors for bound repositories (${workspace.readyRepos.map((r) => `${r.repo} -> repos/${r.dirName} @ ${r.commit.slice(0, 8)}`).join(", ")}).`
      : `- Bound repositories: ${(project.repos.length ? project.repos : [project.repo]).filter(Boolean).join(", ") || "none synced locally yet"}.`,
    sandboxMode === "workspace-write"
      ? `- Mode: workspace-write (you may create or edit ./HANDBOOK.md, ./DEPLOY.md, and files under ./files/ when asked; never modify ./repos/ or datasources.json, and never disclose secrets). To show generated images or screenshots in chat, save them under ./files/ and embed them in Markdown as ![description](files/...).`
      : `- Mode: read-only (inspect files, repositories, and databases without modifying ./HANDBOOK.md, ./DEPLOY.md, ./files/, or ./repos/).`,
    runtime === "codex"
      ? networkAccess
        ? `- Network: ENABLED for this session (you may connect to configured external datasources using local CLI clients or query remote services when asked).`
        : `- Network: DISABLED by Codex sandbox (only local files and local SQLite databases are reachable; if the operator asks to connect to a remote database or install a package, let them know to enable "联网" in the chat toolbar).`
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
      `- Usage example: prefer the \`relaydesk\` MCP tools (\`list_datasources\`, \`describe_datasource\`, \`query_datasource\`) for safe read-only inspection; in workspace-write mode you may also use psql/mysql/redis-cli/mongosh with "$RELAYDESK_DB_...". Never print the env var itself.`,
    );
  }

  lines.push("", RELAYDESK_MCP_INSTRUCTIONS);

  const history = formatChatHistory(priorMessages ?? []);
  if (history) lines.push("", "## Previous Conversation Summary", history);

  if (attachmentContext) {
    lines.push("", "## Explicitly Attached Context", attachmentContext);
  }

  lines.push("", "## User Message", userPrompt);
  return lines.join("\n");
}

export function buildResumePrompt(userPrompt: string, attachmentContext: string): string {
  if (!attachmentContext) return userPrompt;
  return `${attachmentContext}\n\n## User Message\n${userPrompt}`;
}

export interface RunChatTurnOptions {
  dbPath: string;
  project: AgentProjectInfo;
  session: ChatSessionRecord;
  prompt: string;
  attachments: ChatContextRef[];
  priorMessages: ChatMessageRecord[];
  signal: AbortSignal;
  resolveTask?: TaskAttachmentResolver;
  taskClient?: RelaydeskMcpTaskClient;
  onEvent: (event: ChatStreamEvent) => void;
}

export interface RunChatTurnResult {
  content: string;
  events: ChatToolEvent[];
  externalSessionId: string;
  status: "done" | "error" | "aborted";
  error?: string;
  stopReason?: ChatTimeoutReason;
}

function runSingleCliAttempt(params: {
  sessionId: string;
  resumeId: string;
  runtime: ChatRuntime;
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinPrompt: string;
  secrets: string[];
  signal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
  onImage?: CliStreamImageHandler;
  lookupAttachment?: ReturnType<typeof chatImageAttachments>["lookup"];
}): Promise<{
  exitCode: number | null;
  aborted: boolean;
  stderr: string;
  state: StreamParseState;
}> {
  const { sessionId, runtime, bin, args, cwd, env, stdinPrompt, secrets, signal, onEvent, onImage } = params;
  return new Promise((resolve) => {
    const parser = createCliStreamParser(runtime, secrets, onEvent, onImage, params.lookupAttachment, { env, resumeId: params.resumeId });
    const { state } = parser;
    if (signal.aborted) {
      resolve({ exitCode: null, aborted: true, stderr: "", state });
      return;
    }
    let aborted = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let stderrBuf = "";
    let settled = false;
    let proc: ChildProcess;

    try {
      proc = spawn(bin, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      state.errorMessage = `无法启动 ${runtime} CLI：${err instanceof Error ? err.message : String(err)}`;
      resolve({ exitCode: -1, aborted: false, stderr: state.errorMessage, state });
      return;
    }

    const killGroup = (sig: NodeJS.Signals) => {
      if (!proc.pid) return false;
      try {
        process.kill(process.platform === "win32" ? proc.pid : -proc.pid, sig);
        return true;
      } catch {
        return false;
      }
    };
    const killProc = () => {
      if (!forceTimer && killGroup("SIGTERM")) {
        forceTimer = setTimeout(() => killGroup("SIGKILL"), 400).unref();
      }
    };
    proc.once("exit", killProc);
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

    proc.stdout?.setEncoding("utf8").on("data", (chunk: string) => parser.write(chunk));

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < 8000) {
        stderrBuf += chunk.toString("utf8").slice(0, 8000 - stderrBuf.length);
      }
    });

    const finish = async (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      if (forceTimer) killGroup("SIGKILL");
      signal.removeEventListener("abort", onSignalAbort);
      if (activeSessionProcesses.get(sessionId)?.abort === doAbort) {
        activeSessionProcesses.delete(sessionId);
      }
      await parser.finish(exitCode === 0 && !aborted);
      state.text = redactSecrets(state.text, secrets);
      resolve({
        exitCode,
        aborted,
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

    proc.stdin?.on("error", () => { /* The CLI may exit before reading stdin. */ });
    try {
      proc.stdin?.end(formatCliStdinPrompt(runtime, stdinPrompt), "utf8");
    } catch {
      // ignore EPIPE if process exited immediately
    }
  });
}

export async function runWebCliChatTurn(options: RunChatTurnOptions): Promise<RunChatTurnResult> {
  const { dbPath, project, session, prompt, attachments, priorMessages, resolveTask, taskClient, onEvent } =
    options;
  const priorId = canResumeExternalSession(session, "cloud") ? session.external_session_id : "";
  const interrupted: RunChatTurnResult = { status: "aborted", content: "", events: [], externalSessionId: priorId };
  if (options.signal.aborted) return interrupted;
  const clis = detectLocalClis();
  const bin = session.runtime === "codex" ? clis.codexBin : session.runtime === "agy" ? clis.agyBin : clis.claudeBin;
  if (!bin) {
    const label = session.runtime === "codex" ? "Codex CLI (`codex`)" : session.runtime === "agy" ? "Antigravity CLI (`agy`)" : "Claude Code (`claude`)";
    return {
      content: "",
      events: [],
      externalSessionId: priorId,
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

  const matchingSettings = projectSettings?.runtime === session.runtime ? projectSettings : null;
  const model = session.model || matchingSettings?.model || "";
  const matchesModel = (item: { runtime: ChatRuntime; id: string }) => item.runtime === session.runtime && item.id === model;
  const projectModel = projectSettings?.models.find(matchesModel);
  const metadata = { ...builtinModels.find(matchesModel), ...projectModel };
  if (session.runtime === "codex" && session.fast_mode && session.fast_mode !== "default" && metadata.supports_fast !== true) {
    return { content: "", events: [], externalSessionId: priorId, status: "error",
      error: "当前云端模型未确认支持 GPT Fast。请在会话模型设置中选择「跟随 Harness」或更换模型。" };
  }
  let reasoningEffort = session.reasoning_effort === "default"
    ? projectModel?.default_effort ?? matchingSettings?.default_effort ?? "default"
    : session.reasoning_effort;
  if (metadata.supports_effort === false || (reasoningEffort !== "default" && metadata.effort_levels && !metadata.effort_levels.includes(reasoningEffort))) {
    reasoningEffort = "default";
  }
  let mcpHandle: RelaydeskMcpHandle | null = null;
  let claudeMcpConfigPath: string | null = null;
  let stopReason: ChatTimeoutReason | undefined;
  const timeout = new AbortController();
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  try {
    mcpHandle = await startRelaydeskMcpServer({
      projectId: project.id,
      spaceDir: workspace.workspaceDir,
      databases: workspace.databases.map((db) => ({
        id: db.id,
        name: db.name,
        kind: db.kind,
        source: db.source,
        file_path: db.file_path,
        env_var: db.env_var,
        host_preview: db.host_preview,
        read_only: db.read_only,
        notes: db.notes,
        has_connection_url: db.has_connection_url,
      })),
      datasourceEnv: datasourceRuntime.env,
      allowDatasourceSecrets: true,
      secrets: datasourceRuntime.secrets,
      taskClient,
      signal,
    });
    if (session.runtime === "claude") {
      claudeMcpConfigPath = join(tmpdir(), `relaydesk-mcp-${randomUUID()}.json`);
      writeFileSync(claudeMcpConfigPath, JSON.stringify(mcpHandle.claudeConfigObject()), {
        mode: 0o600,
        flag: "wx",
      });
    }
  } catch {
    mcpHandle = null;
  }

  const spaceFilesRoot = join(workspace.workspaceDir, "files");
  const attachedImages = chatImageAttachments(project.id, workspace.workspaceDir, workspace.workspaceDir,
    attachments.filter(att => att.kind === "image").map(att => att.ref));
  const CLOUD_IMAGE_MIME_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
  };
  let savedToolImages = 0;
  const saveToolImage: CliStreamImageHandler = (img) => {
    if (savedToolImages >= 12) return null;
    const ext = CLOUD_IMAGE_MIME_EXT[img.mime.toLowerCase()];
    if (!ext) return null;
    const buf = Buffer.from(img.data, "base64");
    if (!buf.length || buf.length > 10 * 1024 * 1024) return null;
    const imgDir = join(spaceFilesRoot, "_chat_images");
    mkdirSync(imgDir, { recursive: true, mode: 0o700 });
    const filename = `tool-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    const relPath = `_chat_images/${filename}`;
    writeFileSync(join(imgDir, filename), buf, { mode: 0o600, flag: "wx" });
    savedToolImages += 1;
    return {
      url: `/api/projects/${encodeURIComponent(project.id)}/workspace/file?path=${encodeURIComponent(relPath)}&inline=1`,
      alt: img.toolName ? `${img.toolName} image` : filename,
    };
  };

  const clock = chatWatchdog(reason => {
    if (signal.aborted) return;
    stopReason = reason;
    timeout.abort();
  });
  const runWithResume = Boolean(priorId);
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
      dbPath,
      runtime: session.runtime,
      bin,
      model,
      reasoningEffort,
      fastMode: session.fast_mode,
      sandboxMode: session.sandbox_mode,
      networkAccess: session.network_access,
      workspaceDir: workspace.workspaceDir,
      reposDir: workspace.reposDir,
      imagePaths: attachedImages.paths,
      resumeSessionId: resumeId,
      projectSettings,
      datasourceEnv: datasourceRuntime.env,
      datasourceSecrets: [...datasourceRuntime.secrets, ...(mcpHandle ? [mcpHandle.token] : [])],
      pgReadOnlyEnforced: datasourceRuntime.pgReadOnlyEnforced,
      ...(mcpHandle
        ? {
            mcp: {
              url: mcpHandle.url,
              tokenEnvVar: "RELAYDESK_MCP_TOKEN",
              ...(claudeMcpConfigPath ? { claudeConfigPath: claudeMcpConfigPath } : {}),
            },
          }
        : {}),
    });
    if (mcpHandle && session.runtime === "codex") {
      invocation.env.RELAYDESK_MCP_TOKEN = mcpHandle.token;
    }
    return runSingleCliAttempt({
      sessionId: session.id,
      resumeId,
      runtime: session.runtime,
      bin,
      args: invocation.args,
      cwd: workspace.workspaceDir,
      env: invocation.env,
      stdinPrompt,
      secrets: invocation.secrets,
      signal,
      onEvent: event => { clock.progress(); onEvent(event); },
      onImage: saveToolImage,
      lookupAttachment: attachedImages.lookup,
    });
  };

  try {
    if (signal.aborted) return interrupted;
    clock.progress();
    const runtimeLabel = session.runtime === "codex" ? "Codex" : session.runtime === "agy" ? "Antigravity CLI" : "Claude";
    onEvent({
      type: "status",
      message: runWithResume
        ? `正在续接 ${runtimeLabel} 会话…`
        : `正在启动 ${runtimeLabel}（工作区已挂载项目文件与手册）…`,
    });

    let resumeId = priorId;
    let attempt = await execute(resumeId);

    // If resuming a prior CLI thread failed before producing any output, transparently retry with a fresh thread seeded with conversation history.
    if (
      runWithResume &&
      !attempt.aborted &&
      !signal.aborted &&
      !attempt.state.toolEvents.size &&
      !attempt.state.externalSessionId &&
      attempt.exitCode !== 0 &&
      !attempt.state.text
    ) {
      onEvent({ type: "status", message: "原 CLI 线程不可复用，正在携带上下文开启新线程…", external_session_id: "" });
      resumeId = "";
      attempt = await execute(resumeId);
    }

    const finalSessionId = attempt.state.externalSessionId || resumeId;
    const events = Array.from(attempt.state.toolEvents.values());

    if (attempt.aborted || signal.aborted) {
      return {
        content: attempt.state.text,
        events,
        externalSessionId: finalSessionId,
        status: stopReason ? "error" : "aborted",
        ...(stopReason && { stopReason, error: chatTimeoutMessage[stopReason] }),
      };
    }

    if (attempt.exitCode !== 0 || attempt.state.errorMessage) {
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
  } finally {
    clock.close();
    if (claudeMcpConfigPath && existsSync(claudeMcpConfigPath)) {
      try {
        unlinkSync(claudeMcpConfigPath);
      } catch {
        // ignore
      }
    }
    if (mcpHandle) {
      await mcpHandle.close().catch(() => undefined);
    }
  }
}
