import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { buildCliInvocation, createCliStreamParser, redactSecrets } from "../../server/cli-stream-parser.ts";
import type { RunChatTurnResult } from "../../server/codex-chat.ts";
import {
  startRelaydeskMcpServer,
  type RelaydeskMcpDatasourceMeta,
  type RelaydeskMcpHandle,
  type RelaydeskMcpTaskClient,
} from "../../server/relaydesk-mcp.ts";
import type { ChatReasoningEffort, ChatRuntime, ChatSandboxMode, ChatStreamEvent, WorkspaceDatabaseKind } from "../../app/lib/types.ts";
import type { BridgeCatalog, BridgeCatalogConfig } from "./catalog.ts";
import type { SpaceManifest } from "./space-sync.ts";

export interface ChatStart {
  run_id: string;
  session_id: string;
  project_id: string;
  runtime: ChatRuntime;
  model?: string;
  reasoning_effort?: ChatReasoningEffort;
  sandbox_mode: ChatSandboxMode;
  network_access?: boolean;
  resume_session_id?: string;
  prompt: string;
  system_context?: string;
  workspace_manifest: SpaceManifest;
  image_paths?: string[];
  datasource_env?: Record<string, unknown>;
  pg_read_only_enforced?: boolean;
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
    !["codex", "claude"].includes(p.runtime) ||
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
  o.signal.throwIfAborted();
  const p = o.p,
    runtime = p.runtime,
    cfg = o.config.runtimes?.[runtime];
  const configured = cfg?.bin || runtime;
  // Resolve before changing cwd so a project cannot substitute a CLI through a relative PATH entry.
  const candidates =
    configured.includes("/") || isAbsolute(configured)
      ? [resolve(configured)]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .filter(isAbsolute)
          .map((dir) => join(dir, configured));
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
  let effort =
    p.reasoning_effort && p.reasoning_effort !== "default"
      ? p.reasoning_effort
      : (metadata?.default_effort ?? o.catalog.runtimes[runtime].default_effort ?? "default");
  if (
    metadata?.supports_effort === false ||
    (effort !== "default" && metadata?.effort_levels && !metadata.effort_levels.includes(effort))
  )
    effort = "default";
  const datasource = datasourceValues(p.datasource_env);
  const secrets = [...datasource.secrets, String(o.config.agent_token || "")].filter(Boolean);
  const write = p.sandbox_mode === "workspace-write";
  let mcpHandle: RelaydeskMcpHandle | null = null;
  let claudeMcpConfigPath: string | null = null;
  if (o.enableMcp) {
    mcpHandle = await startRelaydeskMcpServer({
      projectId: p.project_id,
      spaceDir: o.spaceDir,
      databases: normalizeManifestDatabases(p.workspace_manifest?.databases),
      datasourceEnv: o.allowSecrets ? datasource.env : {},
      allowDatasourceSecrets: o.allowSecrets,
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
  const resolvedImagePaths: string[] = [];
  for (const rel of p.image_paths ?? []) {
    const abs = resolve(spaceFilesRoot, rel);
    if ((abs === spaceFilesRoot || abs.startsWith(spaceFilesRoot + sep)) && existsSync(abs)) {
      resolvedImagePaths.push(abs);
    }
  }
  const { args, env } = buildCliInvocation({
    dbPath: ":memory:",
    runtime,
    bin,
    model,
    reasoningEffort: effort,
    sandboxMode: p.sandbox_mode,
    networkAccess: write && p.network_access === true,
    workspaceDir: o.cwd,
    // Fresh turns mount the shadow dir; Claude also accepts --add-dir on resume.
    reposDir: runtime === "claude" && p.resume_session_id ? o.spaceDir : null,
    extraAddDirs: [o.spaceDir],
    imagePaths: resolvedImagePaths,
    resumeSessionId: p.resume_session_id || "",
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
  if (p.resume_session_id && write && runtime === "codex")
    args.splice(-2, 0, "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([o.spaceDir])}`);
  if (!write && runtime === "claude") {
    // Bash is an arbitrary writer even if Edit and Write are absent.
    args[args.indexOf("--tools") + 1] = "Read,Grep,Glob";
    args[args.indexOf("--allowedTools") + 1] = claudeMcpConfigPath
      ? "Read,Grep,Glob,mcp__relaydesk__*"
      : "Read,Grep,Glob";
  }
  env.HOME = o.homeDir;
  if (runtime === "codex" && !process.env.CODEX_HOME) env.CODEX_HOME = join(o.homeDir, ".codex");
  for (const [k, v] of Object.entries(cfg?.extra_env ?? {})) if (typeof v === "string") env[k] = v;
  for (const [k, v] of Object.entries(env)) {
    if (/^RELAYDESK_/i.test(k)) delete env[k];
    else if (v && v.length >= 4 && /(key|token|secret|password|credential)/i.test(k)) secrets.push(v);
  }
  if (o.allowSecrets) Object.assign(env, datasource.env);
  if (o.allowSecrets && p.pg_read_only_enforced === true)
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
  const saveToolImage = write
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
  );
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
  child.stdin.end(clean(o.prompt), "utf8");
  try {
    const code = await closed;
    await stopGroup();
    const success = code === 0 && !o.signal.aborted && !overflow;
    parser.finish(success);
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
