import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { chatWatchdog, chatTimeoutMessage, type ChatTimeoutReason } from "../agent/bridge/chat-timeouts.ts";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { sanitizeBridgeModels } from "../app/lib/model-catalog.ts";
import type {
  BridgeAgentSummary,
  ChatFastMode,
  ChatReasoningEffort,
  ChatRuntime,
  ChatSandboxMode,
  ChatStreamEvent,
  RepoBranchDetailPayload,
  RepoLocalWorkdirStatus,
} from "../app/lib/types.ts";
import type { RunChatTurnResult } from "./codex-chat.ts";
import { redactSecrets, type PriorSubagentSeed } from "./cli-stream-parser.ts";
import { ApiError } from "./errors.ts";
import { sanitizeSidebarAccount, type AccountProvider } from "./sidebar-accounts.ts";
import type { Store } from "./store.ts";
import { type buildWorkspaceManifest, readBridgeWorkspaceFile, writeBridgeWorkspaceFile } from "./workspace.ts";

export interface BridgeChatStart {
  run_id?: string;
  session_id: string;
  project_id: string;
  runtime: ChatRuntime;
  model: string;
  reasoning_effort: ChatReasoningEffort;
  fast_mode?: ChatFastMode;
  sandbox_mode: ChatSandboxMode;
  network_access: boolean;
  resume_session_id: string;
  prompt: string;
  system_context: string;
  workspace_manifest: ReturnType<typeof buildWorkspaceManifest>;
  image_paths?: string[];
  datasource_env?: Record<string, string>;
  pg_read_only_enforced?: boolean;
  public_feedback?: boolean;
  is_subagent?: boolean;
  prior_subagents?: PriorSubagentSeed[];
}

export interface BridgeCliRunStart {
  run_id: string;
  project_id: string;
  mode: "operator" | "pr_audit";
  runtime: ChatRuntime;
  model?: string;
  reasoning_effort?: ChatReasoningEffort;
  prompt: string;
  system_context?: string;
  workspace_manifest: ReturnType<typeof buildWorkspaceManifest>;
}

export interface BridgeCliRunEvent {
  event: "heartbeat" | "progress" | "finish" | "fail";
  body: string;
  sha?: string;
}

export interface BridgeHubOptions { pingIntervalMs?: number; pongTimeoutMs?: number; chatReconnectMs?: number }
const RPC_BYTES = 2 * 1024 * 1024;
const RUN_TIMEOUT_MS = 8 * 60_000;
const text = (max: number) => z.string().max(max);
const report = z.object({
  project_id: text(64).min(1), workdir: text(4096).regex(/^[^\x00-\x1f]*$/),
  path_ok: z.boolean(), path_error: text(1024).default(""),
  git_branch: text(200).optional(), has_dirty_files: z.boolean().optional(),
});
type Report = z.infer<typeof report>;
type Binding = Omit<Report, "project_id">;
const runtime = z.object({ default_fast_mode: z.enum(["on", "off"]).optional(), available: z.boolean(), version: text(150).optional(), default_model: text(160).optional(),
  default_effort: z.enum(["default", "off", "low", "medium", "high", "max"]).optional() });
const catalog = z.object({
  hostname: text(200).optional(), platform: text(80).optional(), bridge_version: text(64).optional(),
  max_concurrency: z.number().int().min(0).max(128).optional(), accept_cli_runs: z.boolean().optional(),
  runtimes: z.object({ claude: runtime.optional(), codex: runtime.optional(), agy: runtime.optional() }).optional(),
  projects: z.array(report).max(1000).optional(), models: z.unknown().optional(),
  allowed_roots_enabled: z.boolean().optional(), db_clients: z.array(text(64)).max(64).optional(),
  git_inspect: z.boolean().optional(),
});
const localBranchInfoSchema = z.object({
  name: text(200).min(1),
  current: z.boolean(),
  sha: text(64).default(""),
  committed_at: text(64).default(""),
  upstream: text(200).default(""),
  ahead: z.number().int().min(0).default(0),
  behind: z.number().int().min(0).default(0),
  upstream_gone: z.boolean().default(false),
  author: text(120).default(""),
  subject: text(240).default(""),
});
const gitStatusResultSchema = z.object({
  ok: z.boolean(),
  workdir: text(4096).default(""),
  repo_dir: text(4096).default(""),
  remote_repo: text(200).default(""),
  current_branch: text(200).default(""),
  detached: z.boolean().default(false),
  head_sha: text(64).default(""),
  has_dirty_files: z.boolean().default(false),
  staged_count: z.number().int().min(0).default(0),
  unstaged_count: z.number().int().min(0).default(0),
  untracked_count: z.number().int().min(0).default(0),
  branches: z.array(localBranchInfoSchema).max(200).default([]),
  error: text(1024).optional(),
});
const gitBranchDetailResultSchema = z.object({
  ok: z.boolean(),
  repo: text(200).default(""),
  branch: text(200).default(""),
  source: z.literal("local").default("local"),
  commits: z.array(z.object({
    sha: text(64).min(1),
    short_sha: text(16).min(1),
    message: text(400),
    author_name: text(120).default(""),
    date: text(64).default(""),
  })).max(30).default([]),
  compare: z.object({
    base: text(200),
    status: z.enum(["ahead", "behind", "diverged", "identical"]),
    ahead_by: z.number().int().min(0),
    behind_by: z.number().int().min(0),
    total_commits: z.number().int().min(0),
    files_count: z.number().int().min(0),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
    files: z.array(z.object({
      filename: text(400),
      status: text(32),
      additions: z.number().int().min(0),
      deletions: z.number().int().min(0),
    })).max(50),
  }).nullable().default(null),
  error: text(1024).optional(),
});
const frame = z.object({ type: text(64), id: text(128).min(1).optional(), payload: z.record(z.string(), z.unknown()) });
type Payload = z.infer<typeof frame>["payload"];
const toolImage = z.object({ url: text(2048), alt: text(256).optional() });
const toolFields = z.object({ id: text(256), tool: text(128), summary: text(4096), status: z.enum(["running", "done", "error"]),
  output: text(32_768).optional(), exit_code: z.number().int().nullable().optional(),
  images: z.array(toolImage).max(4).optional(),
  subagent: z.object({
    status: z.enum(["unknown", "running", "done", "error", "interrupted"]),
    activity: text(4096).optional(),
    session_id: text(128).optional(),
    runtime: z.enum(["codex", "claude", "agy"]).optional(),
    model: text(200).optional(),
    delegated: z.boolean().optional(),
  }).optional() });
// Older Agy bridges used the display title as the tool name.
const tool = z.preprocess(value => {
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string" &&
      /^agy-step-\d+$/.test(value.id) && "tool" in value && typeof value.tool === "string" && value.tool.length > 128 &&
      "summary" in value && typeof value.summary === "string") {
    return { ...value, tool: "tool", summary: value.summary.slice(0, 4096) };
  }
  return value;
}, toolFields);

const diagnosticFields = new Set(["event", "events", "id", "type", "tool", "summary", "status", "output", "images", "url", "alt",
  "subagent", "activity", "session_id", "runtime", "model", "text", "delta", "message", "content", "error", "externalSessionId", "payload"]);
function frameFailure(err: unknown) {
  if (!(err instanceof z.ZodError)) return err instanceof SyntaxError ? "invalid_json" : "handler_error";
  const issue = err.issues[0];
  if (!issue) return "validation_error";
  // Only schema-owned labels and lengths are safe in production logs.
  const field = issue.path.map(key => typeof key === "number" ? "[]" : diagnosticFields.has(String(key)) ? key : "?").join(".");
  const input = issue.input;
  const length = typeof input === "string" || Array.isArray(input) ? ` length=${input.length}` : "";
  return `validation=${issue.code} field=${field || "<root>"}${length}`;
}

const contextUsageFrame = z.object({ type: z.literal("context_usage"), usage: z.object({
  used_tokens: z.number().int().nonnegative(), window_tokens: z.number().int().positive().optional(),
}) });
const intermediate = z.discriminatedUnion("type", [
  contextUsageFrame,
  z.object({ type: z.literal("tool"), event: tool }),
  z.object({ type: z.literal("status"), message: text(4096), external_session_id: text(512).optional() }),
  z.object({ type: z.literal("text_delta"), delta: text(120_000) }),
  z.object({ type: z.literal("text_replace"), text: text(120_000) }),
  z.object({ type: z.literal("reasoning"), text: text(120_000) }),
]);
const terminal = z.object({ content: text(120_000), events: z.array(tool).max(1000), externalSessionId: text(512),
  status: z.enum(["done", "error", "aborted"]), error: text(32_768).optional(),
  stopReason: z.enum(["queue_timeout", "idle_timeout", "total_timeout"]).optional() });
const cliRunEventSchema = z.object({
  run_id: text(160).min(1),
  event: z.enum(["heartbeat", "progress", "finish", "fail"]),
  body: text(24_000).default(""),
  sha: text(64).optional(),
});
const taskRpcSchema = z.object({
  run_id: text(160).min(1),
  project_id: text(64).min(1),
  action: z.enum([
    "list_tasks",
    "get_task",
    "comment_task",
    "update_task",
    "transition_task",
    "create_task",
    "list_releases",
    "checkpoint_release",
    "finish_release",
  ]),
  params: z.record(z.string(), z.unknown()).default({}),
});
const delegateRpcSchema = z.object({
  run_id: text(160).min(1),
  project_id: text(64).min(1),
  action: z.enum([
    "delegate_task",
    "check_delegated_task",
    "wait_delegated_task",
    "cancel_delegated_task",
  ]),
  params: z.record(z.string(), z.unknown()).default({}),
});

export type BridgeDelegateRpcHandler = (ctx: {
  projectId: string;
  sessionId: string;
  runId: string;
  action: "delegate_task" | "check_delegated_task" | "wait_delegated_task" | "cancel_delegated_task";
  params: Record<string, unknown>;
}) => Promise<unknown>;

const MUTATING_TASK_ACTIONS = new Set([
  "comment_task",
  "update_task",
  "transition_task",
  "create_task",
  "checkpoint_release",
  "finish_release",
]);
function redact<T>(object: T, secrets: string[]): T {
  return JSON.parse(JSON.stringify(object, (key, value) => typeof value === "string" && key !== "type" && key !== "status"
    ? redactSecrets(value, secrets).replace(/rdbr_[a-f0-9]{48}/gi, "[redacted]") : value));
}

// Do not emit an unfinished credential prefix at the end of a streaming delta:
// two individually harmless frames must not concatenate into a secret in SSE.
function streamOutput(onEvent: (event: ChatStreamEvent) => void, secrets: string[]) {
  let pending = "";
  return (event: z.infer<typeof intermediate>) => {
    if (event.type === "text_delta" || event.type === "text_replace") {
      const combined = event.type === "text_delta" ? pending + event.delta : event.text;
      const clean = redactSecrets(combined, secrets);
      let keep = 0;
      for (const secret of secrets) {
        if (secret.length < 4) continue;
        const start = Math.max(0, clean.length - secret.length + 1);
        for (let i = clean.indexOf(secret[0], start); i !== -1 && clean.length - i > keep; i = clean.indexOf(secret[0], i + 1)) {
          if (secret.startsWith(clean.slice(i))) { keep = clean.length - i; break; }
        }
      }
      pending = keep ? clean.slice(-keep) : "";
      const safe = clean.slice(0, clean.length - keep);
      if (event.type === "text_delta" && !safe) return;
      event = event.type === "text_delta" ? { type: "text_delta", delta: safe } : { type: "text_replace", text: safe };
    }
    onEvent(redact(event, secrets));
  };
}
interface Run {
  id: string; project: string; session: string; write: boolean; publicFeedback: boolean; allowedReadPaths?: Set<string>; owner: Connection; workdir: string;
  grace?: NodeJS.Timeout;
  grantedSecrets: boolean;
  status: (message: string) => void;
  onEvent: ReturnType<typeof streamOutput>;
  emitTaskUpdated: (mutated: { task_id?: string; action: string }) => void;
  secrets: string[];
  finish: (result: RunChatTurnResult) => void; stop: (reason: string, aborted?: boolean) => void;
}
interface CliRunHandle {
  id: string; project: string; owner: Connection; workdir: string;
  onEvent: (event: BridgeCliRunEvent) => void;
  finish: (event: BridgeCliRunEvent) => void;
  stop: (reason: string) => void;
}
interface Connection {
  instance?: string;
  accounts: Map<AccountProvider, NonNullable<ReturnType<typeof sanitizeSidebarAccount>>>;
  id: string; ws: WebSocket; ready: boolean; lastPong: number; projects: Map<string, Binding>;
  binds: Map<string, { project: string; workdir: string; settle: (value: Binding | Error) => void }>;
  gitQueries: Map<string, { project: string; settle: (value: unknown | Error) => void }>;
}

export class BridgeHub {
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
  private readonly connections = new Map<string, Connection>();
  private readonly runs = new Map<string, Run>();
  private readonly cliRuns = new Map<string, CliRunHandle>();
  private readonly availabilityListeners = new Set<(projectIds?: string[]) => void>();
  private delegateHandler: BridgeDelegateRpcHandler | null = null;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly timeout: number;
  private readonly reconnectMs: number;
  private closing?: Promise<void>;
  private readonly store: Store;
  constructor(store: Store, opts: BridgeHubOptions = {}) {
    this.store = store;
    this.timeout = opts.pongTimeoutMs ?? 35_000;
    this.reconnectMs = opts.chatReconnectMs ?? 30_000;
    this.heartbeat = setInterval(() => {
      for (const conn of this.connections.values()) {
        if (Date.now() - conn.lastPong >= this.timeout) {
          this.drop(conn, "本机节点心跳超时", true);
          conn.ws.terminate();
        } else if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
      }
    }, opts.pingIntervalMs ?? 15_000).unref();
  }

  setDelegateHandler(handler: BridgeDelegateRpcHandler | null): void {
    this.delegateHandler = handler;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (req.url?.split("?")[0] !== "/api/bridge/ws") return false;
    if (this.closing) { socket.destroy(); return true; }
    const match = /^Bearer (rdbr_[a-zA-Z0-9_-]+)$/i.exec(req.headers.authorization ?? "");
    const agent = req.url === "/api/bridge/ws" && match && this.store.findBridgeAgentByToken(match[1]);
    if (!agent) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n", () => socket.destroy());
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, ws => {
      const previous = this.connections.get(agent.id);
      if (previous) {
        this.drop(previous, "本机节点连接已被替换", true);
        previous.ws.close(4001, "Replaced by newer connection");
      }
      const conn: Connection = { id: agent.id, ws, ready: false, accounts: new Map(), lastPong: Date.now(), projects: new Map(), binds: new Map(), gitQueries: new Map() };
      this.connections.set(conn.id, conn);
      ws.on("pong", () => {
        if (this.connections.get(conn.id) !== conn || !conn.ready) return;
        conn.lastPong = Date.now();
        this.store.updateBridgeAgentTelemetry(conn.id, { last_seen_at: new Date().toISOString() });
      });
      ws.on("message", (data, binary) => {
        if (this.connections.get(conn.id) !== conn || ws.readyState !== WebSocket.OPEN) return;
        try {
          if (binary) throw new Error();
          const msg = frame.parse(JSON.parse(data.toString()));
          if (!conn.ready && msg.type !== "hello") throw new Error();
          this.receive(conn, msg.type, msg.id, msg.payload);
        } catch (err) {
          console.warn(`[bridge] rejected frame: ${frameFailure(err)}`);
          this.disconnect(conn.id, 1008, "Invalid bridge frame");
        }
      });
      ws.on("error", () => { /* The close code distinguishes transport loss from invalid frames. */ });
      ws.on("close", code => this.drop(conn, `本机节点连接中断（WebSocket ${code}）`, code === 1006));
    });
    return true;
  }

  private send(conn: Connection, type: string, payload: unknown, id?: string) {
    if (conn.ws.readyState !== WebSocket.OPEN) throw new ApiError(409, "本机节点已离线");
    conn.ws.send(JSON.stringify({ type, id, ts: new Date().toISOString(), payload }));
  }
  private drop(conn: Connection, reason: string, transient = false) {
    if (this.connections.get(conn.id) !== conn) return;
    this.connections.delete(conn.id);
    for (const bind of conn.binds.values()) bind.settle(new ApiError(409, reason));
    for (const query of conn.gitQueries.values()) query.settle(new ApiError(409, reason));
    for (const run of this.runs.values()) if (run.owner === conn) {
      console.info(`[bridge] ${reason}; run=${run.id} last_pong_ms=${Date.now() - conn.lastPong} buffered_bytes=${conn.ws.bufferedAmount}`);
      if (!transient || !conn.instance || this.reconnectMs <= 0) run.stop(reason);
      else {
        run.grace = setTimeout(() => run.stop(`${reason}。未能及时接回原执行；已保留收到的进度，不会自动重跑。`), this.reconnectMs).unref();
        run.status("本机节点暂时离线，正在等待接回原执行…");
      }
    }
    for (const cli of this.cliRuns.values()) if (cli.owner === conn) cli.stop(reason);
  }
  disconnect(agentId: string, code = 4000, reason = "Bridge disconnected") {
    for (const run of this.runs.values()) if (run.owner.id === agentId && run.grace) run.stop("本机节点连接已撤销");
    const conn = this.connections.get(agentId);
    if (!conn) return;
    this.drop(conn, code === 1008 ? "本机节点发送了无效协议帧" : "本机节点连接已撤销");
    conn.ws.close(code, reason);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearInterval(this.heartbeat);
    for (const run of this.runs.values()) if (run.grace) run.stop("服务端正在关闭");
    for (const conn of this.connections.values()) this.drop(conn, "服务端正在关闭");
    this.closing = new Promise<void>(resolve => {
      for (const ws of this.wss.clients) ws.close(1001, "Server shutting down");
      // A silent or already-replaced peer must not keep server shutdown pending.
      const timer = setTimeout(() => { for (const ws of this.wss.clients) ws.terminate(); }, 500).unref();
      this.wss.close(() => { clearTimeout(timer); resolve(); });
    });
    return this.closing;
  }
  private live(agentId: string) {
    const conn = this.connections.get(agentId);
    return conn?.ready && conn.ws.readyState === WebSocket.OPEN && Date.now() - conn.lastPong < this.timeout ? conn : undefined;
  }
  sidebarAccounts() {
    return this.store.listBridgeAgents().flatMap(agent => {
      const conn = this.live(agent.id);
      if (!conn) return [];
      return (["codex", "gemini"] as const).flatMap(provider => {
        const row = conn.accounts.get(provider);
        return row ? [{ ...row, id: `${agent.id}:${provider}:${row.id}`, nodeName: agent.name }] : [];
      });
    });
  }
  describe(agent: BridgeAgentSummary): BridgeAgentSummary {
    const conn = this.live(agent.id);
    const chatCount = Array.from(this.runs.values()).filter(run => run.owner.id === agent.id).length;
    const cliCount = Array.from(this.cliRuns.values()).filter(run => run.owner.id === agent.id).length;
    const bindings = conn
      ? agent.bindings.map((b) => {
          const live = conn.projects.get(b.project_id);
          if (!live) return b;
          return {
            ...b,
            ...(live.git_branch !== undefined ? { git_branch: live.git_branch } : {}),
            ...(live.has_dirty_files !== undefined ? { has_dirty_files: live.has_dirty_files } : {}),
          };
        })
      : agent.bindings;
    return { ...agent, bindings, online: !!conn, active_runs: chatCount + cliCount };
  }
  onAvailabilityChange(listener: (projectIds?: string[]) => void): () => void {
    this.availabilityListeners.add(listener);
    return () => { this.availabilityListeners.delete(listener); };
  }
  private notifyAvailability(projectIds?: string[]) {
    for (const listener of this.availabilityListeners) {
      try { listener(projectIds); } catch { /* listener errors must not break hub */ }
    }
  }
  hasActiveRunForProject(agentId: string, projectId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.owner.id === agentId && run.project === projectId) return true;
    }
    for (const cli of this.cliRuns.values()) {
      if (cli.owner.id === agentId && cli.project === projectId) return true;
    }
    return false;
  }
  refresh(agentId: string) {
    const conn = this.live(agentId);
    if (!conn) throw new ApiError(409, "本机节点离线");
    this.send(conn, "catalog.refresh", {});
  }
  private saveReport(conn: Connection, value: Report) {
    const { project_id, workdir, path_error, git_branch, has_dirty_files } = value;
    const path_ok = value.path_ok && !!workdir.trim();
    const old = this.store.getProjectAgentBinding(project_id, conn.id);
    // Device reports can revoke an obsolete grant, but never create or restore one.
    this.store.upsertProjectAgentBinding(project_id, conn.id, { workdir, path_error, path_ok,
      ...(old && old.workdir !== workdir && { allow_datasource_secrets: false }) });
    conn.projects.set(project_id, {
      workdir,
      path_error,
      path_ok,
      ...(git_branch !== undefined ? { git_branch } : {}),
      ...(has_dirty_files !== undefined ? { has_dirty_files } : {}),
    });
    for (const run of this.runs.values()) {
      if (run.owner === conn && run.project === project_id && (!path_ok || run.workdir !== workdir)) run.stop("项目目录绑定已变更");
    }
    for (const cli of this.cliRuns.values()) {
      if (cli.owner === conn && cli.project === project_id && (!path_ok || cli.workdir !== workdir)) cli.stop("项目目录绑定已变更");
    }
  }
  private agent(agentId: string) {
    const agent = this.store.getBridgeAgent(agentId);
    if (!agent) throw new ApiError(404, "本机节点不存在");
    return agent;
  }
  private sync(conn: Connection, payload: Payload, hello: boolean, full: boolean) {
    const p = catalog.parse(payload);
    const current = this.agent(conn.id);
    const reports = p.projects ?? (full ? [] : undefined);
    if (reports) {
      const seen = new Set<string>();
      for (const item of reports) {
        if (seen.has(item.project_id)) throw new ApiError(400, "重复的项目绑定");
        try { this.store.getProjectRow(item.project_id); }
        catch (err) { if (err instanceof ApiError && err.status === 404) continue; throw err; }
        seen.add(item.project_id);
        this.saveReport(conn, item);
      }
      for (const old of this.store.listAgentBindings(conn.id)) {
        if (seen.has(old.project_id)) continue;
        this.store.upsertProjectAgentBinding(old.project_id, conn.id, { path_ok: false, path_error: "节点未报告该项目目录", allow_datasource_secrets: false });
        conn.projects.delete(old.project_id);
        for (const run of this.runs.values()) if (run.owner === conn && run.project === old.project_id) run.stop("项目目录绑定已移除");
        for (const cli of this.cliRuns.values()) if (cli.owner === conn && cli.project === old.project_id) cli.stop("项目目录绑定已移除");
      }
    }
    const gitInspect = p.git_inspect === true || (!hello && current.capabilities.git_inspect === true);
    this.store.updateBridgeAgentTelemetry(conn.id, {
      hostname: p.hostname ?? current.hostname, platform: p.platform ?? current.platform, bridge_version: p.bridge_version ?? current.bridge_version,
      max_concurrency: p.max_concurrency ?? current.max_concurrency, accept_cli_runs: p.accept_cli_runs ?? current.accept_cli_runs,
      runtimes: p.runtimes ?? (hello ? {} : current.runtimes), models: p.models !== undefined ? sanitizeBridgeModels(p.models) : hello ? [] : current.models,
      capabilities: { allowed_roots_enabled: p.allowed_roots_enabled ?? (!hello && current.capabilities.allowed_roots_enabled === true),
        db_clients: p.db_clients ?? (hello ? [] : current.capabilities.db_clients),
        ...(gitInspect ? { git_inspect: true } : {}) }, last_seen_at: new Date().toISOString(),
    });
  }
  private receive(conn: Connection, type: string, id: string | undefined, p: Payload) {
    if (type === "hello" || type === "catalog.sync" || type === "status.update") {
      const hello = type === "hello";
      if (hello && conn.ready) throw new Error();
      this.sync(conn, p, hello, type !== "status.update");
      if (hello) {
        conn.ready = true;
        const agent = this.agent(conn.id);
        const resumed: string[] = [];
        if (this.reconnectMs > 0 && typeof p.chat_instance === "string" && z.uuid().safeParse(p.chat_instance).success) conn.instance = p.chat_instance;
        const offered = new Set(z.array(z.uuid()).max(128).optional().parse(p.resume_runs));
        for (const run of this.runs.values()) {
          if (!run.grace || run.owner.id !== conn.id) continue;
          const binding = this.store.getProjectAgentBinding(run.project, conn.id);
          if (!conn.instance || conn.instance !== run.owner.instance || !offered.has(run.id) || !binding?.enabled || !binding.path_ok ||
              !conn.projects.get(run.project)?.path_ok || binding.workdir !== run.workdir || (run.grantedSecrets && !binding.allow_datasource_secrets)) {
            run.stop("本机节点未能接回原执行；不会自动重跑。");
            continue;
          }
          clearTimeout(run.grace);
          run.grace = undefined;
          run.owner = conn;
          resumed.push(run.id);
          run.status("本机节点已重连，继续原执行。");
        }
        this.send(conn, "hello.ack", { agent_id: conn.id, agent_name: agent.name, sidebar_accounts: true, context_usage: true, bindings: agent.bindings,
          ...(conn.instance && { chat_reconnect_ms: this.reconnectMs, resumed_runs: resumed }) }, id);
      }
      if (conn.ready) {
        const readyProjects = Array.from(conn.projects.entries())
          .filter(([, b]) => b.path_ok)
          .map(([pid]) => pid);
        if (readyProjects.length > 0) this.notifyAvailability(readyProjects);
      }
    } else if (type === "sidebar.account") {
      const provider = p.provider;
      if (provider !== "codex" && provider !== "gemini") return;
      const row = sanitizeSidebarAccount(provider, p.account);
      if (row) conn.accounts.set(provider, row);
      else conn.accounts.delete(provider);
    } else if (type === "workspace.fetch" || type === "workspace.push") {
      if (!id) throw new Error();
      try {
        const { project_id, path } = z.object({ project_id: text(64), path: text(260) }).parse(p);
        this.assertWorkspaceAccess(conn.id, project_id);
        let bytes: Buffer;
        if (type === "workspace.push") {
          if ((p.run_id !== undefined && typeof p.run_id !== "string") || !this.hasActiveWriteLease(conn.id, project_id, p.run_id)) throw new ApiError(403, "没有有效的写入租约");
          if (typeof p.data !== "string" || p.data.length > 4 * Math.ceil(RPC_BYTES / 3)) throw new ApiError(413, "文件超出帧大小限制");
          bytes = Buffer.from(p.data, "base64");
          if (bytes.length > RPC_BYTES) throw new ApiError(413, "文件超出帧大小限制");
          if (bytes.toString("base64") !== p.data) throw new ApiError(400, "无效的 Base64 数据");
          if (p.sha256 !== undefined && p.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new ApiError(400, "文件摘要不匹配");
          writeBridgeWorkspaceFile(this.store.dbPath, project_id, path, bytes);
        } else {
          this.assertPublicFeedbackReadAllowed(conn.id, project_id, path, typeof p.run_id === "string" ? p.run_id : undefined);
          bytes = readBridgeWorkspaceFile(this.store.dbPath, project_id, path, RPC_BYTES);
        }
        this.send(conn, type + ".result", { ok: true, data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") }, id);
      } catch (err) {
        this.send(conn, type + ".result", { ok: false, error: err instanceof ApiError ? err.message : "文件请求无效", status: err instanceof ApiError ? err.status : 400 }, id);
      }
    } else if (type === "task.rpc") {
      if (!id) throw new Error();
      try {
        const req = taskRpcSchema.parse(p);
        const run = this.runs.get(req.run_id);
        if (!run || run.owner !== conn || run.project !== req.project_id) {
          throw new ApiError(403, "没有有效的对话执行上下文");
        }
        if (run.publicFeedback) {
          throw new ApiError(403, "公开反馈会话禁止调用工单工具");
        }
        if (this.assertWorkspaceAccess(conn.id, req.project_id).workdir !== run.workdir) {
          throw new ApiError(403, "项目目录绑定已失效");
        }
        const mutating = MUTATING_TASK_ACTIONS.has(req.action);
        const { result, mutated } = this.store.transaction(mutating, () =>
          this.store.chatAgentTaskOp(req.project_id, req.action, req.params, { sessionId: run.session }),
        );
        if (mutated) {
          run.emitTaskUpdated(mutated);
          if (
            mutated.action === "create_task" ||
            mutated.action === "transition_task" ||
            mutated.action === "finish_release"
          ) {
            this.notifyAvailability([req.project_id]);
          }
        }
        this.send(conn, "task.rpc.result", { ok: true, data: result }, id);
      } catch (err) {
        this.send(
          conn,
          "task.rpc.result",
          {
            ok: false,
            error: err instanceof ApiError ? err.message : "工单操作请求无效",
            status: err instanceof ApiError ? err.status : 400,
          },
          id,
        );
      }
    } else if (type === "delegate.rpc") {
      if (!id) throw new Error();
      void (async () => {
        try {
          const req = delegateRpcSchema.parse(p);
          const run = this.runs.get(req.run_id);
          if (!run || run.owner !== conn || run.project !== req.project_id) {
            throw new ApiError(403, "没有有效的对话执行上下文");
          }
          if (run.publicFeedback) {
            throw new ApiError(403, "公开反馈会话禁止委派子代理");
          }
          if (this.assertWorkspaceAccess(conn.id, req.project_id).workdir !== run.workdir) {
            throw new ApiError(403, "项目目录绑定已失效");
          }
          if (!this.delegateHandler) {
            throw new ApiError(503, "子代理委派服务未就绪");
          }
          const result = await this.delegateHandler({
            projectId: req.project_id,
            sessionId: run.session,
            runId: run.id,
            action: req.action,
            params: req.params,
          });
          this.send(conn, "delegate.rpc.result", { ok: true, data: result }, id);
        } catch (err) {
          this.send(
            conn,
            "delegate.rpc.result",
            {
              ok: false,
              error: err instanceof ApiError ? err.message : err instanceof Error ? err.message : "子代理委派请求无效",
              status: err instanceof ApiError ? err.status : 400,
            },
            id,
          );
        }
      })();
    } else if (type === "project.bind.result") {
      const pending = id && conn.binds.get(id);
      if (!pending || p.project_id !== pending.project) return;
      const value = report.parse(p);
      // Realpath may canonicalize the requested directory on the device. Require
      // an echo of the requested path when accepting a different successful path.
      if ((p.requested_workdir ?? value.workdir) !== pending.workdir) return;
      if (value.path_ok) {
        this.saveReport(conn, value);
        this.notifyAvailability([value.project_id]);
      }
      pending.settle({ workdir: value.workdir, path_error: value.path_error, path_ok: value.path_ok });
    } else if (type === "repo.git_status.result" || type === "repo.git_branch_detail.result") {
      const pending = id && conn.gitQueries.get(id);
      if (!pending) return;
      if (type === "repo.git_status.result") {
        pending.settle(gitStatusResultSchema.parse(p));
      } else {
        pending.settle(gitBranchDetailResultSchema.parse(p));
      }
    } else if (type === "chat.lost" && conn.instance) {
      const run = typeof p.run_id === "string" && this.runs.get(p.run_id);
      if (run && run.owner === conn) run.stop("重连时原执行已结束；不会自动重跑。");
    } else if (type === "chat.event") {
      const run = typeof p.run_id === "string" && this.runs.get(p.run_id);
      if (!run || run.owner !== conn || p.session_id !== run.session) return;
      try {
        if (this.assertWorkspaceAccess(conn.id, run.project).workdir !== run.workdir) throw new Error();
      } catch { run.stop("项目目录绑定已失效"); return; }
      const tag = z.object({ type: z.string() }).parse(p.event).type;
      if (tag === "done" || tag === "error") {
        const result = terminal.parse(p.result, { reportInput: true });
        if (tag === "error" && result.status === "done") throw new Error();
        // The HTTP caller persists the result before emitting the authoritative terminal event.
        run.finish(redact(result, run.secrets));
        if (conn.instance) this.send(conn, "chat.received", { run_id: run.id });
      } else if (tag === "context_usage") {
        // Optional telemetry must never tear down the execution connection.
        const sample = contextUsageFrame.safeParse(p.event);
        if (sample.success) run.onEvent(sample.data);
      } else run.onEvent(intermediate.parse(p.event, { reportInput: true }));
    } else if (type === "cli_run.event") {
      const ev = cliRunEventSchema.parse(p);
      const cli = this.cliRuns.get(ev.run_id);
      if (!cli || cli.owner !== conn) return;
      try {
        if (this.assertWorkspaceAccess(conn.id, cli.project).workdir !== cli.workdir) throw new Error();
      } catch { cli.stop("项目目录绑定已失效"); return; }
      const cleanEvent: BridgeCliRunEvent = {
        event: ev.event,
        body: redactSecrets(ev.body, []).replace(/rdbr_[a-f0-9]{48}/gi, "[redacted]"),
        ...(ev.sha && /^[0-9a-f]{7,64}$/i.test(ev.sha) ? { sha: ev.sha } : {}),
      };
      if (cleanEvent.event === "finish" || cleanEvent.event === "fail") {
        cli.finish(cleanEvent);
      } else {
        cli.onEvent(cleanEvent);
      }
    } else throw new Error();
  }
  async bindProject(agentId: string, projectId: string, workdir: string): Promise<Binding> {
    const conn = this.live(agentId);
    if (!conn) throw new ApiError(409, "本机节点离线");
    this.store.getProjectRow(projectId);
    if (!this.agent(agentId).capabilities.allowed_roots_enabled) throw new ApiError(403, "本机节点未启用 allowed_roots");
    if (Array.from(conn.binds.values()).some(b => b.project === projectId)) throw new ApiError(409, "目录绑定正在进行");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const settle = (value: Binding | Error) => {
        clearTimeout(timer); conn.binds.delete(id);
        if (value instanceof Error) reject(value); else resolve(value);
      };
      const timer = setTimeout(() => settle(new ApiError(504, "本机节点目录校验超时")), 10_000).unref();
      conn.binds.set(id, { project: projectId, workdir, settle });
      try { this.send(conn, "project.bind", { project_id: projectId, workdir }, id); }
      catch { settle(new ApiError(409, "本机节点离线")); }
    });
  }
  private sendGitQuery<T>(conn: Connection, projectId: string, type: string, payload: Record<string, unknown>, timeoutMs = 4000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const settle = (value: unknown | Error) => {
        clearTimeout(timer);
        conn.gitQueries.delete(id);
        if (value instanceof Error) reject(value);
        else resolve(value as T);
      };
      const timer = setTimeout(() => settle(new ApiError(504, "本机节点 Git 查询超时")), timeoutMs).unref();
      conn.gitQueries.set(id, { project: projectId, settle });
      try { this.send(conn, type, payload, id); }
      catch { settle(new ApiError(409, "本机节点已离线")); }
    });
  }
  async inspectProjectGit(
    agentId: string,
    projectId: string,
    repo?: string,
  ): Promise<Omit<RepoLocalWorkdirStatus, "agent_id" | "agent_name" | "online"> | null> {
    const conn = this.live(agentId);
    if (!conn) return null;
    const binding = this.assertWorkspaceAccess(agentId, projectId);
    const liveReport = conn.projects.get(projectId);
    const agent = this.agent(agentId);
    const fallbackStatus = (error?: string): Omit<RepoLocalWorkdirStatus, "agent_id" | "agent_name" | "online"> => ({
      workdir: binding.workdir,
      current_branch: liveReport?.git_branch ?? "",
      detached: false,
      head_sha: "",
      has_dirty_files: Boolean(liveReport?.has_dirty_files),
      staged_count: 0,
      unstaged_count: 0,
      untracked_count: 0,
      branches: [],
      detailed: false,
      ...(error ? { error } : {}),
    });
    if (!agent.capabilities.git_inspect) {
      return fallbackStatus();
    }
    try {
      const res = await this.sendGitQuery<z.infer<typeof gitStatusResultSchema>>(
        conn,
        projectId,
        "repo.git_status",
        { project_id: projectId, ...(repo ? { repo } : {}) },
      );
      if (!res.ok) {
        return fallbackStatus(res.error || "本机节点无法读取 Git 状态");
      }
      return {
        workdir: res.workdir || binding.workdir,
        ...(res.repo_dir ? { repo_dir: res.repo_dir } : {}),
        ...(res.remote_repo ? { remote_repo: res.remote_repo } : {}),
        current_branch: res.current_branch,
        detached: res.detached,
        head_sha: res.head_sha,
        has_dirty_files: res.has_dirty_files,
        staged_count: res.staged_count,
        unstaged_count: res.unstaged_count,
        untracked_count: res.untracked_count,
        branches: res.branches,
        detailed: true,
        ...(res.error ? { error: res.error } : {}),
      };
    } catch (err) {
      return fallbackStatus(err instanceof Error ? err.message : "本机节点 Git 状态查询失败");
    }
  }
  async inspectProjectBranchDetail(
    agentId: string,
    projectId: string,
    params: { repo?: string; branch: string; baseBranch?: string },
  ): Promise<RepoBranchDetailPayload | null> {
    const conn = this.live(agentId);
    if (!conn) return null;
    this.assertWorkspaceAccess(agentId, projectId);
    const agent = this.agent(agentId);
    if (!agent.capabilities.git_inspect) {
      return null;
    }
    const res = await this.sendGitQuery<z.infer<typeof gitBranchDetailResultSchema>>(
      conn,
      projectId,
      "repo.git_branch_detail",
      {
        project_id: projectId,
        branch: params.branch,
        ...(params.repo ? { repo: params.repo } : {}),
        ...(params.baseBranch ? { base_branch: params.baseBranch } : {}),
      },
    );
    if (!res.ok) {
      throw new ApiError(400, res.error || "本机节点无法读取该分支详情");
    }
    return {
      repo: res.repo || params.repo || "",
      branch: res.branch || params.branch,
      source: "local",
      commits: res.commits,
      compare: res.compare,
      ...(res.error ? { error: res.error } : {}),
    };
  }
  assertWorkspaceAccess(agentId: string, projectId: string) {
    const reported = this.live(agentId)?.projects.get(projectId);
    const binding = this.store.getProjectAgentBinding(projectId, agentId);
    if (!reported?.path_ok || !binding?.enabled || !binding.path_ok || binding.workdir !== reported.workdir) {
      throw new ApiError(403, "本机节点未绑定有效的项目目录");
    }
    return binding;
  }
  assertPublicFeedbackReadAllowed(agentId: string, projectId: string, path: string, runId?: string) {
    const run = runId ? this.runs.get(runId) : undefined;
    if (run?.publicFeedback) {
      if (run.owner.id !== agentId || run.project !== projectId || !run.allowedReadPaths?.has(path)) {
        throw new ApiError(403, "公开反馈会话仅允许读取本次诊断附带的附件");
      }
      return;
    }
    if (!runId) {
      const projectRuns = Array.from(this.runs.values()).filter(
        r => r.owner.id === agentId && r.project === projectId,
      );
      if (projectRuns.length > 0 && projectRuns.every(r => r.publicFeedback)) {
        if (!projectRuns.some(r => r.allowedReadPaths?.has(path))) {
          throw new ApiError(403, "公开反馈会话仅允许读取本次诊断附带的附件");
        }
      }
    }
  }
  assertCanRun(agentId: string, projectId: string, runtime: ChatRuntime) {
    if (!this.live(agentId)) throw new ApiError(409, "本机节点离线");
    let binding;
    try { binding = this.assertWorkspaceAccess(agentId, projectId); }
    catch (error) { if (error instanceof ApiError && error.status === 403) throw new ApiError(409, error.message); throw error; }
    const agent = this.describe(this.agent(agentId));
    if (!agent.runtimes[runtime]?.available) throw new ApiError(409, `本机节点未安装 ${runtime}`);
    if (agent.max_concurrency > 0 && agent.active_runs >= agent.max_concurrency) throw new ApiError(409, "本机节点并发已满");
    return binding;
  }
  writeLeaseId(agentId: string, projectId: string, runId?: string): string | undefined {
    const conn = this.live(agentId);
    if (!conn) return;
    const run = runId !== undefined ? this.runs.get(runId) : Array.from(this.runs.values()).find(r => r.owner === conn && r.project === projectId && r.write);
    if (!run?.write || run.owner !== conn || run.project !== projectId) return;
    try { if (this.assertWorkspaceAccess(agentId, projectId).workdir === run.workdir) return run.id; }
    catch { /* The binding was revoked. */ }
  }
  hasActiveWriteLease(agentId: string, projectId: string, runId?: string) {
    return this.writeLeaseId(agentId, projectId, runId) !== undefined;
  }
  isChatSessionRunning(sessionId: string) { return Array.from(this.runs.values()).some(run => run.session === sessionId); }
  abortChatSessionRun(sessionId: string) {
    const run = Array.from(this.runs.values()).find(run => run.session === sessionId);
    if (!run) return false;
    run.stop("对话已中止", true); return true;
  }
  async runChatTurn(agentId: string, payload: BridgeChatStart, onEvent: (event: ChatStreamEvent) => void, signal: AbortSignal, secrets: string[] = []): Promise<RunChatTurnResult> {
    if (signal.aborted) return { status: "aborted", content: "", events: [], externalSessionId: payload.resume_session_id };
    const binding = this.assertCanRun(agentId, payload.project_id, payload.runtime);
    const isPublicFeedback = payload.public_feedback === true;
    const effectivePayload: BridgeChatStart = isPublicFeedback
      ? {
          ...payload,
          sandbox_mode: "read-only",
          network_access: false,
          resume_session_id: "",
          fast_mode: undefined,
          datasource_env: undefined,
          pg_read_only_enforced: undefined,
          workspace_manifest: {
            handbook: null,
            handbook_sha256: null,
            deploy_doc: null,
            deploy_doc_sha256: null,
            files: (payload.workspace_manifest?.files ?? []).filter((f) =>
              f.path.startsWith("_feedback_images/"),
            ),
            databases: [],
          },
          public_feedback: true,
        }
      : payload;
    if (effectivePayload.runtime === "codex" && effectivePayload.fast_mode && effectivePayload.fast_mode !== "default") {
      const agent = this.store.getBridgeAgent(agentId);
      const model = effectivePayload.model || agent?.runtimes.codex?.default_model;
      if (!agent?.models.some(m => m.runtime === "codex" && (model ? m.id === model : m.is_default) && m.supports_fast)) {
        throw new ApiError(409, "该节点未确认模型支持 GPT Fast。请选择「跟随 Harness」或更换模型。");
      }
    }
    if (this.isChatSessionRunning(effectivePayload.session_id)) throw new ApiError(409, "会话正在运行");
    const conn = this.live(agentId)!;
    const id = effectivePayload.run_id || randomUUID();
    const { run_id: _runId, datasource_env, pg_read_only_enforced, ...start } = effectivePayload;
    const grant = !isPublicFeedback && binding.allow_datasource_secrets ? { datasource_env, pg_read_only_enforced } : {};
    const allowedReadPaths = isPublicFeedback
      ? new Set((effectivePayload.workspace_manifest?.files ?? []).map((f) => `files/${f.path}`))
      : undefined;
    return new Promise(resolve => {
      let content = "";
      let externalSessionId = effectivePayload.resume_session_id;
      const tools = new Map<string, RunChatTurnResult["events"][number]>();
      const finish = (result: RunChatTurnResult) => {
        const current = this.runs.get(id);
        if (!current) return;
        this.runs.delete(id);
        clearTimeout(current.grace);
        clock.close();
        signal.removeEventListener("abort", abort);
        if (result.status !== "done") {
          for (const tool of result.events) tools.set(tool.id, tool);
          result = { ...result, content: result.content || redact(content, secrets), events: [...tools.values()] };
        }
        resolve(result);
        const boundProjects = Array.from(conn.projects.entries())
          .filter(([, b]) => b.path_ok)
          .map(([pid]) => pid);
        if (boundProjects.length > 0) this.notifyAvailability(boundProjects);
      };
      const stop = (reason: string, aborted = false, stopReason?: ChatTimeoutReason) => {
        const owner = this.runs.get(id)?.owner;
        finish({ status: aborted ? "aborted" : "error", content: "", error: reason, events: [], externalSessionId,
          ...(stopReason && { stopReason }) });
        if (owner && this.connections.get(agentId) === owner && owner.ws.readyState === WebSocket.OPEN) {
          this.send(owner, "chat.abort", { run_id: id, session_id: effectivePayload.session_id });
        }
      };
      const abort = () => stop("对话已中止", true);
      const clock = chatWatchdog(reason => stop(chatTimeoutMessage[reason], false, reason));
      const publish = streamOutput(event => {
        if (event.type === "text_delta") content = (content + event.delta).slice(0, 120_000);
        else if (event.type === "text_replace") content = event.text;
        else if (event.type === "status" && event.external_session_id !== undefined) externalSessionId = event.external_session_id;
        else if (event.type === "tool" && (tools.has(event.event.id) || tools.size < 1000)) tools.set(event.event.id, event.event);
        onEvent(event);
      }, secrets);
      this.runs.set(id, { id, session: effectivePayload.session_id, project: effectivePayload.project_id, workdir: binding.workdir,
        owner: conn, publicFeedback: isPublicFeedback, allowedReadPaths,
        grantedSecrets: !isPublicFeedback && !!(binding.allow_datasource_secrets && Object.keys(datasource_env ?? {}).length),
        status: message => onEvent({ type: "status", message }), write: !isPublicFeedback && effectivePayload.sandbox_mode === "workspace-write", onEvent: event => { clock.progress(); publish(event); },
        emitTaskUpdated: (mutated) => onEvent({ type: "task_updated", task_id: mutated.task_id, action: mutated.action }),
        secrets, finish, stop });
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      try { this.send(conn, "chat.start", { ...start, expected_workdir: binding.workdir, prompt: redactSecrets(start.prompt, secrets),
        system_context: redactSecrets(start.system_context ?? "", secrets), ...grant, run_id: id }); }
      catch { stop("本机节点连接中断"); }
    });
  }
  abortCliRun(runId: string) {
    const cli = this.cliRuns.get(runId);
    if (!cli) return false;
    cli.stop("CLI 运行已中止");
    return true;
  }
  runCliRun(agentId: string, payload: BridgeCliRunStart, onEvent: (event: BridgeCliRunEvent) => void): Promise<BridgeCliRunEvent> {
    const binding = this.assertCanRun(agentId, payload.project_id, payload.runtime);
    const agent = this.agent(agentId);
    if (!agent.accept_cli_runs) throw new ApiError(409, "本机节点未开启工单/审计承接");
    if (this.cliRuns.has(payload.run_id)) throw new ApiError(409, "该 CLI 任务已在执行");
    const conn = this.live(agentId)!;
    return new Promise((resolve) => {
      const finish = (result: BridgeCliRunEvent) => {
        if (!this.cliRuns.delete(payload.run_id)) return;
        clearTimeout(timer);
        onEvent(result);
        resolve(result);
        const boundProjects = Array.from(conn.projects.entries())
          .filter(([, b]) => b.path_ok)
          .map(([pid]) => pid);
        if (boundProjects.length > 0) this.notifyAvailability(boundProjects);
      };
      const stop = (reason: string) => {
        if (this.connections.get(agentId) === conn && conn.ws.readyState === WebSocket.OPEN) {
          this.send(conn, "cli_run.abort", { run_id: payload.run_id });
        }
        finish({ event: "fail", body: reason });
      };
      const timer = setTimeout(() => stop("本机节点 CLI 执行超时"), RUN_TIMEOUT_MS).unref();
      this.cliRuns.set(payload.run_id, {
        id: payload.run_id,
        project: payload.project_id,
        owner: conn,
        workdir: binding.workdir,
        onEvent,
        finish,
        stop,
      });
      try {
        this.send(conn, "cli_run.start", payload);
      } catch {
        stop("本机节点连接中断");
      }
    });
  }
}
