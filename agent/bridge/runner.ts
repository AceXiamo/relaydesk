import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { chatImageAttachments } from "../../server/chat-image-attachments.ts";
import {
  buildCliInvocation,
  createCliStreamParser,
  formatCliStdinPrompt,
  redactSecrets,
  type PriorSubagentSeed,
} from "../../server/cli-stream-parser.ts";
import type { RunChatTurnResult } from "../../server/codex-chat.ts";
import {
  startRelaydeskMcpServer,
  type RelaydeskMcpDatasourceMeta,
  type RelaydeskMcpHandle,
  type RelaydeskMcpTaskClient,
} from "../../server/relaydesk-mcp.ts";
import type { ChatFastMode, ChatReasoningEffort, ChatRuntime, ChatSandboxMode, ChatStreamEvent, WorkspaceDatabaseKind } from "../../app/lib/types.ts";
import type { BridgeCatalog, BridgeCatalogConfig } from "./catalog.ts";
import type { SpaceManifest } from "./space-sync.ts";

export interface ChatStart {
  run_id: string;
  session_id: string;
  project_id: string;
  runtime: ChatRuntime;
  model?: string;
  reasoning_effort?: ChatReasoningEffort;
  fast_mode?: ChatFastMode;
  sandbox_mode: ChatSandboxMode;
  network_access?: boolean;
  resume_session_id?: string;
  expected_workdir?: string;
  prompt: string;
  system_context?: string;
  workspace_manifest: SpaceManifest;
  image_paths?: string[];
  datasource_env?: Record<string, unknown>;
  pg_read_only_enforced?: boolean;
  public_feedback?: boolean;
  prior_subagents?: PriorSubagentSeed[];
}

const VALID_SUBAGENT_STATUS = new Set(["unknown", "running", "done", "error", "interrupted"]);

function sanitizePriorSubagents(raw: unknown): PriorSubagentSeed[] {
  if (!Array.isArray(raw)) return [];
  const out: PriorSubagentSeed[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim().slice(0, 256) : "";
    const tool = typeof rec.tool === "string" ? rec.tool.trim().slice(0, 128) : "";
    const summary = typeof rec.summary === "string" ? rec.summary.slice(0, 4096) : "";
    const sa = rec.subagent && typeof rec.subagent === "object" ? (rec.subagent as Record<string, unknown>) : null;
    const saStatus = typeof sa?.status === "string" && VALID_SUBAGENT_STATUS.has(sa.status)
      ? (sa.status as PriorSubagentSeed["subagent"]["status"])
      : null;
    if (!id || !tool || !saStatus) continue;
    const activity = typeof sa?.activity === "string" && sa.activity.trim()
      ? sa.activity.trim().slice(0, 4096)
      : undefined;
    out.push({
      id,
      tool,
      summary: summary || tool,
      ...(rec.status === "running" || rec.status === "done" || rec.status === "error" ? { status: rec.status } : {}),
      subagent: { status: saStatus, ...(activity ? { activity } : {}) },
    });
    if (out.length >= 50) break;
  }
  return out;
}
export function datasourceValues(input: ChatStart["datasource_env"]) {
  const env: Record<string, string> = Object.create(null);
  const secrets = new Set<string>();
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!/^RELAYDESK_DB_[A-Z0-9_]{1,40}$/.test(k) || typeof v !== "string" || !v || v.includes("\0") || v.length > 8192)
      continue;
    env[k] = v;
    secrets.add(v);
    try {
      const pwd = new URL(v).password;
      if (pwd) {
        secrets.add(pwd);
        secrets.add(decodeURIComponent(pwd));
      }
    } catch {
      /* libpq also accepts key/value DSNs. */
    }
    const m = v.match(/(?:^|\s)password\s*=\s*(?:'([^']+)'|"([^"]+)"|(\S+))/i);
    if (m) secrets.add(m[1] || m[2] || m[3]);
  }
  return { env, secrets: [...secrets] };
}
export function checkChat(p: ChatStart) {
  if (
    !["codex", "claude", "agy"].includes(p.runtime) ||
    !["workspace-write", "read-only"].includes(p.sandbox_mode) ||
    typeof p.prompt !== "string"
  )
    throw new Error("Invalid chat request");
  if (p.resume_session_id && !/^[\w][\w.-]{0,199}$/.test(p.resume_session_id))
    throw new Error("Invalid resume session ID");
  if (
    p.model &&
    (typeof p.model !== "string" || p.model.startsWith("-") || /[\x00-\x1f]/.test(p.model) || p.model.length > 200)
  )
    throw new Error("Invalid model ID");
  if (p.reasoning_effort && !["default", "off", "low", "medium", "high", "max"].includes(p.reasoning_effort))
    throw new Error("Invalid reasoning effort");
  if (p.fast_mode !== undefined && !["default", "on", "off"].includes(p.fast_mode)) throw new Error("Invalid Fast mode");
  if (p.image_paths !== undefined) {
    if (!Array.isArray(p.image_paths) || p.image_paths.length > 8) throw new Error("Invalid image paths");
    for (const rel of p.image_paths) {
      if (
        typeof rel !== "string" ||
        !rel ||
        rel.length > 240 ||
        rel.startsWith("/") ||
        rel.includes("..") ||
        /[\\:\x00-\x1f\x7f]/.test(rel)
      ) {
        throw new Error("Invalid image path");
      }
    }
  }
}
const VALID_DB_KINDS = new Set<WorkspaceDatabaseKind>(["sqlite", "postgres", "mysql", "redis", "mongodb", "other"]);

function normalizeManifestDatabases(rows: unknown): RelaydeskMcpDatasourceMeta[] {
  if (!Array.isArray(rows)) return [];
  const out: RelaydeskMcpDatasourceMeta[] = [];
  for (const row of rows.slice(0, 100)) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const kind = typeof obj.kind === "string" && VALID_DB_KINDS.has(obj.kind as WorkspaceDatabaseKind)
      ? (obj.kind as WorkspaceDatabaseKind)
      : "other";
    const source = obj.source === "workspace_file" || obj.source === "external" ? obj.source : null;
    if (!name || !source) continue;
    out.push({
      id: typeof obj.id === "string" ? obj.id : undefined,
      name,
      kind,
      source,
      file_path: typeof obj.file_path === "string" ? obj.file_path : undefined,
      env_var: typeof obj.env_var === "string" ? obj.env_var : undefined,
      host_preview: typeof obj.host_preview === "string" ? obj.host_preview : undefined,
      read_only: typeof obj.read_only === "boolean" ? obj.read_only : true,
      notes: typeof obj.notes === "string" ? obj.notes : undefined,
      has_connection_url: typeof obj.has_connection_url === "boolean" ? obj.has_connection_url : undefined,
    });
  }
  return out;
}

interface RunnerOptions {
  config: BridgeCatalogConfig;
  catalog: BridgeCatalog;
  p: ChatStart;
  cwd: string;
  homeDir: string;
  spaceDir: string;
  allowSecrets: boolean;
  enableMcp?: boolean;
  taskClient?: RelaydeskMcpTaskClient;
  signal: AbortSignal;
  prompt: string;
  onEvent(event: ChatStreamEvent): void;
}
export async function runLocalChat(o: RunnerOptions): Promise<RunChatTurnResult> {
  if (o.signal.aborted) return { status: "aborted", content: "", events: [], externalSessionId: o.p.resume_session_id || "" };
  const p = o.p,
    runtime = p.runtime,
    cfg = o.config.runtimes?.[runtime];
  const isPublicFeedback = p.public_feedback === true;
  const effectiveSandboxMode: ChatSandboxMode = isPublicFeedback ? "read-only" : p.sandbox_mode;
  const effectiveNetworkAccess = isPublicFeedback ? false : p.network_access === true;
  const effectiveAllowSecrets = isPublicFeedback ? false : o.allowSecrets;
  const effectiveEnableMcp = isPublicFeedback ? false : Boolean(o.enableMcp);
  const effectiveResumeSessionId = isPublicFeedback ? "" : (p.resume_session_id || "");
  const effectiveFastMode = isPublicFeedback ? undefined : p.fast_mode;
  const configured = cfg?.bin || runtime;
  // Resolve before changing cwd so a project cannot substitute a CLI through a relative PATH entry.
  const candidates =
    configured.includes("/") || isAbsolute(configured)
      ? [resolve(configured)]
      : [
          ...(process.env.PATH ?? "")
            .split(delimiter)
            .filter(isAbsolute)
            .map((dir) => join(dir, configured)),
          ...(!cfg?.bin && runtime === "agy" ? [join(o.homeDir, ".local", "bin", "agy")] : []),
        ];
  const bin = candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!bin) throw new Error("Configured local CLI is unavailable");
  const model = p.model || o.catalog.runtimes[runtime].default_model || "";
  const metadata = o.catalog.models.find((m) => m.runtime === runtime && m.id === model);
  const fastModel = model ? metadata : o.catalog.models.find(m => m.runtime === runtime && m.is_default);
  if (runtime === "codex" && effectiveFastMode && effectiveFastMode !== "default" && fastModel?.supports_fast !== true) {
    throw new Error("当前模型未确认支持 GPT Fast。请在会话模型设置中选择「跟随 Harness」或更换模型。");
  }
  let effort =
    p.reasoning_effort && p.reasoning_effort !== "default"
      ? p.reasoning_effort
      : (metadata?.default_effort ?? o.catalog.runtimes[runtime].default_effort ?? "default");
  if (
    metadata?.supports_effort === false ||
    (effort !== "default" && metadata?.effort_levels && !metadata.effort_levels.includes(effort))
  )
    effort = "default";
  const datasource = isPublicFeedback
    ? { env: Object.create(null) as Record<string, string>, secrets: [] as string[] }
    : datasourceValues(p.datasource_env);
  const secrets = [...datasource.secrets, String(o.config.agent_token || "")].filter(Boolean);
  const fullAccess = isPublicFeedback
    ? false
    : (runtime === "codex" ? o.config.codex_full_access : runtime === "agy" ? o.config.agy_full_access : o.config.claude_full_access);
  let mcpHandle: RelaydeskMcpHandle | null = null;
  let claudeMcpConfigPath: string | null = null;
  if (effectiveEnableMcp) {
    mcpHandle = await startRelaydeskMcpServer({
      projectId: p.project_id,
      spaceDir: o.spaceDir,
      databases: normalizeManifestDatabases(p.workspace_manifest?.databases),
      datasourceEnv: effectiveAllowSecrets ? datasource.env : {},
      allowDatasourceSecrets: effectiveAllowSecrets,
      secrets,
      taskClient: o.taskClient,
      signal: o.signal,
    });
    secrets.push(mcpHandle.token);
    if (runtime === "claude") {
      claudeMcpConfigPath = join(tmpdir(), `relaydesk-mcp-${randomUUID()}.json`);
      writeFileSync(claudeMcpConfigPath, JSON.stringify(mcpHandle.claudeConfigObject()), {
        mode: 0o600,
        flag: "wx",
      });
    }
  }
  try {
  const spaceFilesRoot = resolve(join(o.spaceDir, "files"));
  const attachedImages = chatImageAttachments(p.project_id, o.spaceDir, o.cwd, p.image_paths ?? []);
  const { args, env } = buildCliInvocation({
    dbPath: ":memory:",
    runtime,
    bin,
    model,
    reasoningEffort: effort,
    fastMode: effectiveFastMode,
    sandboxMode: effectiveSandboxMode,
    networkAccess: effectiveNetworkAccess,
    localAccess: !isPublicFeedback && fullAccess === true ? "full" : "restricted",
    workspaceDir: o.cwd,
    // Fresh turns mount the shadow dir; Claude and Agy also accept --add-dir on resume.
    reposDir: (runtime === "claude" || runtime === "agy") && effectiveResumeSessionId ? o.spaceDir : null,
    extraAddDirs: [o.spaceDir],
    imagePaths: attachedImages.paths,
    resumeSessionId: effectiveResumeSessionId,
    projectSettings: null,
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
  env.HOME = o.homeDir;
  if (runtime === "codex" && !process.env.CODEX_HOME) env.CODEX_HOME = join(o.homeDir, ".codex");
  for (const [k, v] of Object.entries(cfg?.extra_env ?? {})) if (typeof v === "string") env[k] = v;
  for (const [k, v] of Object.entries(env)) {
    if (/^RELAYDESK_/i.test(k)) delete env[k];
    else if (v && v.length >= 4 && /(key|token|secret|password|credential)/i.test(k)) secrets.push(v);
  }
  if (effectiveAllowSecrets) Object.assign(env, datasource.env);
  if (effectiveAllowSecrets && p.pg_read_only_enforced === true)
    env.PGOPTIONS = `${env.PGOPTIONS ?? ""} -c default_transaction_read_only=on`.trim();
  if (mcpHandle && runtime === "codex") env.RELAYDESK_MCP_TOKEN = mcpHandle.token;
  env.RELAYDESK_SPACE_DIR = o.spaceDir;
  const protectedValues = [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length);
  const clean = (value: string) => {
    let result = redactSecrets(value, protectedValues);
    for (const s of protectedValues) if (s.length < 4) result = result.replaceAll(s, "[redacted]");
    return result;
  };
  function redactObject<T>(obj: T): T {
    return JSON.parse(
      JSON.stringify(obj, (k, value: unknown) =>
        typeof value === "string" && k !== "type" && k !== "status" ? clean(value) : value,
      ),
    );
  }
  // A CLI may split a credential across two JSON deltas. Withhold a possible
  // secret prefix until the next delta, then redact before the bytes leave the machine.
  let rawText = "",
    sentText = "";
  function safeText(text: string, final = false) {
    if (!final) {
      let hold = 0;
      for (const secret of protectedValues) {
        if (secret.length === 1) continue;
        const suffix = text.slice(1 - secret.length);
        for (let i = suffix.indexOf(secret[0]); i !== -1; i = suffix.indexOf(secret[0], i + 1)) {
          if (secret.startsWith(suffix.slice(i))) {
            hold = Math.max(hold, suffix.length - i);
            break;
          }
        }
      }
      if (hold) text = text.slice(0, -hold);
    }
    return clean(text);
  }
  function emitText(final = false) {
    const next = safeText(rawText, final);
    if (next === sentText) return;
    o.onEvent(
      next.startsWith(sentText)
        ? { type: "text_delta", delta: next.slice(sentText.length) }
        : { type: "text_replace", text: next },
    );
    sentText = next;
  }
  const IMAGE_MIME_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
  };
  let savedToolImages = 0;
  const saveToolImage = !isPublicFeedback && effectiveSandboxMode === "workspace-write"
    ? (img: { mime: string; data: string; toolName?: string }) => {
        if (savedToolImages >= 12) return null;
        const ext = IMAGE_MIME_EXT[img.mime.toLowerCase()];
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
          url: `/api/projects/${encodeURIComponent(p.project_id)}/workspace/file?path=${encodeURIComponent(relPath)}&inline=1`,
          alt: img.toolName ? `${img.toolName} image` : filename,
        };
      }
    : undefined;
  const priorSubagents = p.resume_session_id ? sanitizePriorSubagents(p.prior_subagents) : [];
  const parser = createCliStreamParser(
    runtime,
    [],
    (ev) => {
      if (ev.type === "text_delta" || ev.type === "text_replace") {
        rawText = (ev.type === "text_delta" ? rawText + ev.delta : ev.text).slice(0, 120_000);
        emitText();
      } else if (ev.type === "reasoning") o.onEvent({ type: "reasoning", text: safeText(ev.text) });
      else o.onEvent(redactObject(ev));
    },
    saveToolImage,
    attachedImages.lookup,
    {
      env,
      resumeId: p.resume_session_id || "",
      redact: clean,
      ...(priorSubagents.length ? { priorSubagents } : {}),
    },
  );
  if (o.signal.aborted) return { status: "aborted", content: "", events: [], externalSessionId: p.resume_session_id || "" };
  const child = spawn(bin, args, { cwd: o.cwd, env, detached: true, stdio: "pipe" });
  const pid = child.pid;
  function signalGroup(sig: NodeJS.Signals | 0) {
    if (!pid) return false;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, sig);
      return true;
    } catch {
      return false;
    }
  }
  let termination: Promise<void> | undefined;
  function stopGroup() {
    if (termination) return termination;
    if (!signalGroup("SIGTERM")) return Promise.resolve();
    termination = new Promise<void>((resolve) =>
      setTimeout(() => {
        signalGroup("SIGKILL");
        resolve();
      }, 400),
    );
    return termination;
  }
  const abort = () => {
    void stopGroup();
  };
  o.signal.addEventListener("abort", abort, { once: true });
  if (o.signal.aborted) abort();
  // Descendants can inherit stdout and keep 'close' pending long after 'exit'.
  child.once("exit", abort);
  child.stdin.on("error", () => {
    /* An early CLI exit closes stdin. */
  });
  let stderr = "",
    bytes = 0,
    overflow = false;
  child.stdout.setEncoding("utf8").on("data", (s: string) => {
    if ((bytes += Buffer.byteLength(s)) <= 32 * 1024 * 1024) parser.write(s);
    else {
      overflow = true;
      abort();
    }
  });
  child.stderr.setEncoding("utf8").on("data", (s: string) => {
    stderr = (stderr + s).slice(-8000);
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(formatCliStdinPrompt(runtime, clean(o.prompt)), "utf8");
  try {
    const code = await closed;
    await stopGroup();
    const success = code === 0 && !o.signal.aborted && !overflow;
    await parser.finish(success);
    emitText(true);
    const { state } = parser;
    const error = overflow
      ? "CLI output exceeded limit"
      : state.errorMessage || (!success ? stderr.trim() || `CLI exited (${code})` : "");
    return redactObject({
      content: state.text,
      externalSessionId: state.externalSessionId || p.resume_session_id || "",
      events: Array.from(state.toolEvents.values()),
      status: o.signal.aborted ? "aborted" : error ? "error" : "done",
      ...(error && !o.signal.aborted ? { error } : {}),
    });
  } finally {
    await stopGroup();
    o.signal.removeEventListener("abort", abort);
  }
  } finally {
    if (claudeMcpConfigPath && existsSync(claudeMcpConfigPath)) {
      try {
        unlinkSync(claudeMcpConfigPath);
      } catch {
        // ignore cleanup error
      }
    }
    if (mcpHandle) {
      await mcpHandle.close().catch(() => undefined);
    }
  }
}
