import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { sanitizeBridgeModels } from "../app/lib/model-catalog.ts";
import type { BridgeAgentSummary, ChatReasoningEffort, ChatRuntime, ChatSandboxMode, ChatStreamEvent } from "../app/lib/types.ts";
import type { RunChatTurnResult } from "./codex-chat.ts";
import { redactSecrets } from "./cli-stream-parser.ts";
import { ApiError } from "./errors.ts";
import type { Store } from "./store.ts";
import { type buildWorkspaceManifest, readBridgeWorkspaceFile, writeBridgeWorkspaceFile } from "./workspace.ts";

export interface BridgeChatStart {
  session_id: string;
  project_id: string;
  runtime: ChatRuntime;
  model: string;
  reasoning_effort: ChatReasoningEffort;
  sandbox_mode: ChatSandboxMode;
  network_access: boolean;
  resume_session_id: string;
  prompt: string;
  system_context: string;
  workspace_manifest: ReturnType<typeof buildWorkspaceManifest>;
  datasource_env?: Record<string, string>;
  pg_read_only_enforced?: boolean;
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

export interface BridgeHubOptions { pingIntervalMs?: number; pongTimeoutMs?: number }
const RPC_BYTES = 2 * 1024 * 1024;
const RUN_TIMEOUT_MS = 8 * 60_000;
const text = (max: number) => z.string().max(max);
const report = z.object({
  project_id: text(64).min(1), workdir: text(4096).regex(/^[^\x00-\x1f]*$/),
  path_ok: z.boolean(), path_error: text(1024).default(""),
});
type Report = z.infer<typeof report>;
type Binding = Omit<Report, "project_id">;
const runtime = z.object({ available: z.boolean(), version: text(150).optional(), default_model: text(160).optional(),
  default_effort: z.enum(["default", "off", "low", "medium", "high", "max"]).optional() });
const catalog = z.object({
  hostname: text(200).optional(), platform: text(80).optional(), bridge_version: text(64).optional(),
  max_concurrency: z.number().int().min(1).max(128).optional(), accept_cli_runs: z.boolean().optional(),
  runtimes: z.object({ claude: runtime.optional(), codex: runtime.optional() }).optional(),
  projects: z.array(report).max(1000).optional(), models: z.unknown().optional(),
  allowed_roots_enabled: z.boolean().optional(), db_clients: z.array(text(64)).max(64).optional(),
});
const frame = z.object({ type: text(64), id: text(128).min(1).optional(), payload: z.record(z.string(), z.unknown()) });
type Payload = z.infer<typeof frame>["payload"];
const tool = z.object({ id: text(256), tool: text(128), summary: text(4096), status: z.enum(["running", "done", "error"]),
  output: text(32_768).optional(), exit_code: z.number().int().nullable().optional() });
const intermediate = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool"), event: tool }),
  z.object({ type: z.literal("status"), message: text(4096), external_session_id: text(512).optional() }),
  z.object({ type: z.literal("text_delta"), delta: text(120_000) }),
  z.object({ type: z.literal("text_replace"), text: text(120_000) }),
  z.object({ type: z.literal("reasoning"), text: text(120_000) }),
]);
const terminal = z.object({ content: text(120_000), events: z.array(tool).max(1000), externalSessionId: text(512),
  status: z.enum(["done", "error", "aborted"]), error: text(32_768).optional() });
const cliRunEventSchema = z.object({
  run_id: text(160).min(1),
  event: z.enum(["heartbeat", "progress", "finish", "fail"]),
  body: text(24_000).default(""),
  sha: text(64).optional(),
});
const taskRpcSchema = z.object({
  run_id: text(160).min(1),
  project_id: text(64).min(1),
  action: z.enum(["list_tasks", "get_task", "comment_task", "update_task", "transition_task", "create_task"]),
  params: z.record(z.string(), z.unknown()).default({}),
});
const MUTATING_TASK_ACTIONS = new Set(["comment_task", "update_task", "transition_task", "create_task"]);
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
  id: string; project: string; session: string; write: boolean; owner: Connection; workdir: string;
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
  id: string; ws: WebSocket; ready: boolean; lastPong: number; projects: Map<string, Binding>;
  binds: Map<string, { project: string; workdir: string; settle: (value: Binding | Error) => void }>;
}

export class BridgeHub {
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
  private readonly connections = new Map<string, Connection>();
  private readonly runs = new Map<string, Run>();
  private readonly cliRuns = new Map<string, CliRunHandle>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly timeout: number;
  private closing?: Promise<void>;
  private readonly store: Store;
  constructor(store: Store, opts: BridgeHubOptions = {}) {
    this.store = store;
    this.timeout = opts.pongTimeoutMs ?? 35_000;
    this.heartbeat = setInterval(() => {
      for (const conn of this.connections.values()) {
        if (Date.now() - conn.lastPong >= this.timeout) {
          this.drop(conn, "本机节点心跳超时");
          conn.ws.terminate();
        } else if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
      }
    }, opts.pingIntervalMs ?? 15_000).unref();
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
      this.disconnect(agent.id, 4001, "Replaced by newer connection");
      const conn: Connection = { id: agent.id, ws, ready: false, lastPong: Date.now(), projects: new Map(), binds: new Map() };
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
        } catch {
          this.disconnect(conn.id, 1008, "Invalid bridge frame");
        }
      });
      ws.on("error", () => { this.drop(conn, "本机节点连接异常"); ws.terminate(); });
      ws.on("close", () => this.drop(conn, "本机节点连接中断"));
    });
    return true;
  }

  private send(conn: Connection, type: string, payload: unknown, id?: string) {
    if (conn.ws.readyState !== WebSocket.OPEN) throw new ApiError(409, "本机节点已离线");
    conn.ws.send(JSON.stringify({ type, id, ts: new Date().toISOString(), payload }));
  }
  private drop(conn: Connection, reason: string) {
    if (this.connections.get(conn.id) !== conn) return;
    this.connections.delete(conn.id);
    for (const bind of conn.binds.values()) bind.settle(new ApiError(409, reason));
    for (const run of this.runs.values()) if (run.owner === conn) run.stop(reason);
    for (const cli of this.cliRuns.values()) if (cli.owner === conn) cli.stop(reason);
  }
  disconnect(agentId: string, code = 4000, reason = "Bridge disconnected") {
    const conn = this.connections.get(agentId);
    if (!conn) return;
    this.drop(conn, "本机节点连接中断");
    conn.ws.close(code, reason);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearInterval(this.heartbeat);
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
  describe(agent: BridgeAgentSummary): BridgeAgentSummary {
    const chatCount = Array.from(this.runs.values()).filter(run => run.owner.id === agent.id).length;
    const cliCount = Array.from(this.cliRuns.values()).filter(run => run.owner.id === agent.id).length;
    return { ...agent, online: !!this.live(agent.id), active_runs: chatCount + cliCount };
  }
  refresh(agentId: string) {
    const conn = this.live(agentId);
    if (!conn) throw new ApiError(409, "本机节点离线");
    this.send(conn, "catalog.refresh", {});
  }
  private saveReport(conn: Connection, value: Report) {
    const { project_id, workdir, path_error } = value;
    const path_ok = value.path_ok && !!workdir.trim();
    const old = this.store.getProjectAgentBinding(project_id, conn.id);
    // Device reports can revoke an obsolete grant, but never create or restore one.
    this.store.upsertProjectAgentBinding(project_id, conn.id, { workdir, path_error, path_ok,
      ...(old && old.workdir !== workdir && { allow_datasource_secrets: false }) });
    conn.projects.set(project_id, { workdir, path_error, path_ok });
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
    this.store.updateBridgeAgentTelemetry(conn.id, {
      hostname: p.hostname ?? current.hostname, platform: p.platform ?? current.platform, bridge_version: p.bridge_version ?? current.bridge_version,
      max_concurrency: p.max_concurrency ?? current.max_concurrency, accept_cli_runs: p.accept_cli_runs ?? current.accept_cli_runs,
      runtimes: p.runtimes ?? (hello ? {} : current.runtimes), models: p.models !== undefined ? sanitizeBridgeModels(p.models) : hello ? [] : current.models,
      capabilities: { allowed_roots_enabled: p.allowed_roots_enabled ?? (!hello && current.capabilities.allowed_roots_enabled === true),
        db_clients: p.db_clients ?? (hello ? [] : current.capabilities.db_clients) }, last_seen_at: new Date().toISOString(),
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
        this.send(conn, "hello.ack", { agent_id: conn.id, agent_name: agent.name, bindings: agent.bindings }, id);
      }
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
        } else bytes = readBridgeWorkspaceFile(this.store.dbPath, project_id, path, RPC_BYTES);
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
        if (this.assertWorkspaceAccess(conn.id, req.project_id).workdir !== run.workdir) {
          throw new ApiError(403, "项目目录绑定已失效");
        }
        const mutating = MUTATING_TASK_ACTIONS.has(req.action);
        const { result, mutated } = this.store.transaction(mutating, () =>
          this.store.chatAgentTaskOp(req.project_id, req.action, req.params),
        );
        if (mutated) {
          run.emitTaskUpdated(mutated);
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
    } else if (type === "project.bind.result") {
      const pending = id && conn.binds.get(id);
      if (!pending || p.project_id !== pending.project) return;
      const value = report.parse(p);
      // Realpath may canonicalize the requested directory on the device. Require
      // an echo of the requested path when accepting a different successful path.
      if ((p.requested_workdir ?? value.workdir) !== pending.workdir) return;
      if (value.path_ok) this.saveReport(conn, value);
      pending.settle({ workdir: value.workdir, path_error: value.path_error, path_ok: value.path_ok });
    } else if (type === "chat.event") {
      const run = typeof p.run_id === "string" && this.runs.get(p.run_id);
      if (!run || run.owner !== conn || p.session_id !== run.session) return;
      try {
        if (this.assertWorkspaceAccess(conn.id, run.project).workdir !== run.workdir) throw new Error();
      } catch { run.stop("项目目录绑定已失效"); return; }
      const tag = z.object({ type: z.string() }).parse(p.event).type;
      if (tag === "done" || tag === "error") {
        const result = terminal.parse(p.result);
        if (tag === "error" && result.status === "done") throw new Error();
        // The HTTP caller persists the result before emitting the authoritative terminal event.
        run.finish(redact(result, run.secrets));
      } else run.onEvent(intermediate.parse(p.event));
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
  assertWorkspaceAccess(agentId: string, projectId: string) {
    const reported = this.live(agentId)?.projects.get(projectId);
    const binding = this.store.getProjectAgentBinding(projectId, agentId);
    if (!reported?.path_ok || !binding?.enabled || !binding.path_ok || binding.workdir !== reported.workdir) {
      throw new ApiError(403, "本机节点未绑定有效的项目目录");
    }
    return binding;
  }
  assertCanRun(agentId: string, projectId: string, runtime: ChatRuntime) {
    if (!this.live(agentId)) throw new ApiError(409, "本机节点离线");
    let binding;
    try { binding = this.assertWorkspaceAccess(agentId, projectId); }
    catch (error) { if (error instanceof ApiError && error.status === 403) throw new ApiError(409, error.message); throw error; }
    const agent = this.describe(this.agent(agentId));
    if (!agent.runtimes[runtime]?.available) throw new ApiError(409, `本机节点未安装 ${runtime}`);
    if (agent.active_runs >= agent.max_concurrency) throw new ApiError(409, "本机节点并发已满");
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
    const binding = this.assertCanRun(agentId, payload.project_id, payload.runtime);
    if (this.isChatSessionRunning(payload.session_id)) throw new ApiError(409, "会话正在运行");
    const conn = this.live(agentId)!;
    const id = randomUUID();
    const { datasource_env, pg_read_only_enforced, ...start } = payload;
    const grant = binding.allow_datasource_secrets ? { datasource_env, pg_read_only_enforced } : {};
    return new Promise(resolve => {
      const finish = (result: RunChatTurnResult) => {
        if (!this.runs.delete(id)) return;
        clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(result);
      };
      const stop = (reason: string, aborted = false) => {
        if (this.connections.get(agentId) === conn && conn.ws.readyState === WebSocket.OPEN) {
          this.send(conn, "chat.abort", { run_id: id, session_id: payload.session_id });
        }
        finish({ status: aborted ? "aborted" : "error", content: "", error: reason, events: [], externalSessionId: "" });
      };
      const abort = () => stop("对话已中止", true);
      const timer = setTimeout(() => stop("本机节点执行超时"), RUN_TIMEOUT_MS).unref();
      this.runs.set(id, { id, session: payload.session_id, project: payload.project_id, workdir: binding.workdir,
        owner: conn, write: payload.sandbox_mode === "workspace-write", onEvent: streamOutput(onEvent, secrets),
        emitTaskUpdated: (mutated) => onEvent({ type: "task_updated", task_id: mutated.task_id, action: mutated.action }),
        secrets, finish, stop });
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      try { this.send(conn, "chat.start", { ...start, prompt: redactSecrets(start.prompt, secrets),
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
