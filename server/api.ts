import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeHub } from "./bridge-hub.ts";
import { ChatRunManager } from "./chat-run-manager.ts";
import { ReleaseDispatcher } from "./release-dispatcher.ts";
import { TaskDispatcher } from "./task-dispatcher.ts";
import { getFeedbackAgentStatus, patchFeedbackAgent, diagnoseFeedback, feedbackAgentAvailability, validateFeedbackDiagnosePayload } from "./feedback-agent.ts";
import { manageLinks, portalIdentity, PortalAccessError } from "./portal-access.ts";
import { createFeedbackTicket, listFeedbackTickets, getFeedbackTicket, replyFeedbackTicket, acceptFeedbackTicket, authorizeFeedbackDeployRequest, addPublicFeedbackQuestion, widgetVisitorDigest } from "./feedback-tickets.ts";
import { deployGateAvailable, latestDeployGate, listDeployGates, requestDeployGate } from "./deploy-gate.ts";

import {
  normalizeExecutionPriority,
  resolveCliRunBridgeTarget,
} from "./execution-router.ts";
import { ApiError } from "./errors.ts";
import { projectCliConfiguration } from "./project-cli-config.ts";
import { discoverProjectCliModels } from "./project-model-discovery.ts";
import {
  effortLabels,
  resolveActiveLocalAgent,
  resolveDefaultModelForTarget,
  validCatalogId,
} from "../app/lib/model-catalog.ts";
import { projectPublicAiEnabled } from "./project-ai-provider.ts";
import {
  Store,
  field,
  safeEqual,
  toAgentProject,
  toProjectView,
  toTaskView,
  type RawProjectRow,
  type RawTaskRow,
} from "./store.ts";
import {
  WalletAuth,
  formatSessionCookie,
  parseCookieValue,
} from "./wallet.ts";
import {
  GithubError,
  fetchGithubRepositories,
  fetchGithubRepositoriesAcrossConnections,
  inspectGithubToken,
  listGithubConnectionSummaries,
  readGithubConnections,
  removeGithubConnection,
  resolveScopeOwner,
  toGithubConnectionSummary,
  upsertGithubConnection,
} from "./github.ts";
import { isLoopbackHost } from "./loopback.ts";
import { intakeReply, prescreenFeedback } from "./assistant.ts";
import {
  deleteStoredR2Config,
  getEffectiveR2Config,
  isR2ConfigComplete,
  readStoredR2Config,
  saveStoredR2Config,
  toR2ConfigStatus,
  validateR2AccountId,
  validateR2Bucket,
  validateR2Endpoint,
  validateR2PublicUrl,
} from "./r2-config.ts";
import {
  MAX_UPLOAD_BYTES,
  parseDataUrlImage,
  testR2Connection,
  uploadProjectImage,
} from "./r2.ts";
import {
  deleteStoredUtilityAiConfig,
  getEffectiveUtilityAiConfig,
  readStoredUtilityAiConfig,
  saveStoredUtilityAiConfig,
  toUtilityAiConfigStatus,
  validateUtilityAiEndpoint,
  validateUtilityAiKey,
  validateUtilityAiModel,
  validateUtilityAiProvider,
} from "./utility-ai-config.ts";
import {
  buildFallbackSessionTitle,
  generateSessionTitle,
  testUtilityAiConnection,
} from "./utility-ai.ts";
import { getProjectReposStatus, syncProjectRepos } from "./repo-workspace.ts";
import { getWorkspaceInlineMime } from "../app/lib/workspace-media.ts";
import {
  addWorkspaceExternalDatasource,
  browseProjectRepoFiles,
  buildWorkspaceManifest,
  createWorkspaceDirectory,
  createWorkspaceSqliteDatabase,
  deleteWorkspaceDatabase,
  deleteWorkspaceFile,
  detectLocalDbClients,
  getWorkspaceDatasourceRuntimeEnv,
  getWorkspaceSummary,
  inspectWorkspaceSqliteSchema,
  listWorkspaceDatabases,
  listWorkspaceFiles,
  openWorkspaceFileForServing,
  queryWorkspaceSqlite,
  streamBridgeWorkspaceFile,
  readProjectRepoFileContent,
  readWorkspaceFile,
  readWorkspaceDeployDoc,
  readWorkspaceHandbook,
  updateWorkspaceExternalDatasource,
  uploadWorkspaceFile,
  writeBridgeWorkspaceFile,
  writeWorkspaceDeployDoc,
  writeWorkspaceHandbook,
  writeWorkspaceTextFile,
} from "./workspace.ts";
import {
  detectLocalClis,
  getChatRuntimeInfo,
} from "./codex-chat.ts";
import {
  runWidgetAgentStream,
  widgetStreamErrorLabel,
  type WidgetChatMessage,
  type WidgetPageContext,
  type WidgetStreamEvent,
} from "./widget-agent.ts";
import type {
  AuthMode,
  AuthStatusPayload,
  BridgeAgentBindingSummary,
  BridgeAgentPatch,
  BridgeAgentSummary,
  BridgeAgentTokenResponse,
  ChatContextRef,
  ChatReasoningEffort,
  ChatRuntime,
  ChatSessionKind,
  ChatSessionRecord,
  ChatSandboxMode,
  ChatStreamEvent,
  GithubOwnerInfo,
  ProjectRoutingConfig,
  WidgetConfigPayload,
  WorkspaceDatabaseKind,
} from "../app/lib/types.ts";

function chatModelSelection(data: Record<string, unknown>) {
  const fields: Partial<Pick<ChatSessionRecord, "runtime" | "model" | "reasoning_effort" | "execution_target" | "fast_mode">> = {};
  if ("fast_mode" in data) {
    if (data.fast_mode !== "default" && data.fast_mode !== "on" && data.fast_mode !== "off") throw new ApiError(400, "Fast 模式无效");
    fields.fast_mode = data.fast_mode;
  }
  if ("runtime" in data) {
    if (data.runtime !== "codex" && data.runtime !== "claude") throw new ApiError(400, "运行工具无效");
    fields.runtime = data.runtime;
  }
  if ("model" in data) {
    if (data.model !== "" && !validCatalogId(data.model)) throw new ApiError(400, "模型 ID 无效");
    fields.model = data.model;
  }
  if ("reasoning_effort" in data) {
    if (typeof data.reasoning_effort !== "string" || !Object.hasOwn(effortLabels, data.reasoning_effort)) {
      throw new ApiError(400, "思考强度无效");
    }
    fields.reasoning_effort = data.reasoning_effort as ChatReasoningEffort;
  }
  if ("execution_target" in data) {
    const target = data.execution_target;
    if (typeof target !== "string" || !/^(?:auto|cloud|local:[a-zA-Z0-9_-]{1,128})$/.test(target)) {
      throw new ApiError(400, "执行节点无效");
    }
    fields.execution_target = target;
  }
  return fields;
}

const MAX_BRIDGE_FILE_BYTES = 20 * 1024 * 1024;

export interface ApiContextOptions {
  store: Store;
  bridgeHub?: BridgeHub | null;
  adminToken?: string;
  wallet?: WalletAuth | null;
  bindHost?: string;
  releasePollIntervalMs?: number;
}

export class ApiRouter {
  readonly store: Store;
  readonly bridgeHub: BridgeHub | null;
  readonly adminToken: string;
  readonly wallet: WalletAuth | null;
  readonly bindHost: string;
  readonly chatRuns: ChatRunManager;
  readonly taskDispatcher: TaskDispatcher;
  readonly releaseDispatcher: ReleaseDispatcher;
  private traffic = new Map<string, number[]>();
  private nextTrafficSweep = 0;
  private cliPresence = new Map<string, { seen: number; runtime: string; ready: boolean; managed: boolean; runId?: string }>();
  private assistantInFlight = 0;
  private readonly diagnosing = new Set<string>();
  private prescreenInFlight = 0;
  private readonly maxAssistantSlots = 4;

  constructor(options: ApiContextOptions) {
    this.store = options.store;
    this.bridgeHub = options.bridgeHub ?? null;
    this.adminToken = options.adminToken ?? "";
    this.wallet = options.wallet ?? null;
    this.bindHost = options.bindHost ?? "127.0.0.1";
    this.chatRuns = new ChatRunManager(this.store, this.bridgeHub);
    this.taskDispatcher = new TaskDispatcher(this.store, this.bridgeHub, this.chatRuns);
    this.releaseDispatcher = new ReleaseDispatcher(this.store, this.bridgeHub, this.chatRuns, {
      ...(options.releasePollIntervalMs !== undefined
        ? { pollIntervalMs: options.releasePollIntervalMs }
        : {}),
    });
  }

  close(): void {
    this.taskDispatcher.close();
    this.releaseDispatcher.close();
  }

  getAuthMode(): AuthMode {
    if (this.wallet) return "wallet";
    if (this.adminToken) return "token";
    return "none";
  }

  isWalletAuthenticated(req: IncomingMessage): boolean {
    if (!this.wallet) return false;
    return this.wallet.authenticated(parseCookieValue(req.headers.cookie));
  }

  private rateLimit(key: string, limit: number): void {
    const now = Date.now();
    if (now >= this.nextTrafficSweep) {
      for (const [id, timestamps] of this.traffic) {
        if (timestamps[timestamps.length - 1] <= now - 60_000) this.traffic.delete(id);
      }
      this.nextTrafficSweep = now + 60_000;
    }
    const events = this.traffic.get(key) ?? [];
    while (events.length > 0 && events[0] <= now - 60_000) {
      events.shift();
    }
    if (events.length >= limit) {
      throw new ApiError(429, "Too many requests. Try again in a minute.");
    }
    events.push(now);
    this.traffic.set(key, events);
  }

  private checkOperator(
    req: IncomingMessage,
    meta: { adminChallenge?: boolean },
  ): void {
    const host = req.headers.host ?? "";
    let hostname = "";
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      hostname = "";
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) {
      throw new ApiError(403, "Operator actions require a same-origin request");
    }

    if (this.wallet) {
      if (host !== this.wallet.host || (origin && origin !== this.wallet.origin)) {
        throw new ApiError(403, "Invalid operator origin");
      }
      if (!this.wallet.authenticated(parseCookieValue(req.headers.cookie))) {
        throw new ApiError(401, "请使用管理员钱包登录");
      }
      return;
    }

    if (this.adminToken) {
      const auth = req.headers.authorization ?? "";
      let supplied = "";
      if (auth.startsWith("Bearer ")) {
        supplied = auth.slice(7);
      } else if (auth.startsWith("Basic ")) {
        try {
          const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
          const sep = decoded.indexOf(":");
          if (sep !== -1) supplied = decoded.slice(sep + 1);
        } catch {
          supplied = "";
        }
      }
      if (!safeEqual(this.adminToken, supplied)) {
        meta.adminChallenge = true;
        throw new ApiError(401, "Enter the operator password configured on this server");
      }
      return;
    }

    const remoteAddr = req.socket.remoteAddress ?? "";
    const hasForwarded = Boolean(
      req.headers.forwarded ||
        req.headers["x-forwarded-host"] ||
        req.headers["x-forwarded-for"],
    );
    if (
      !(
        isLoopbackHost(this.bindHost) &&
        isLoopbackHost(hostname) &&
        isLoopbackHost(remoteAddr) &&
        !hasForwarded
      )
    ) {
      throw new ApiError(403, "Remote operator access requires RELAYDESK_ADMIN_TOKEN");
    }
  }

  private checkBearer(req: IncomingMessage, expected: string): void {
    const supplied = req.headers.authorization ?? "";
    if (!safeEqual(supplied, `Bearer ${expected}`)) {
      throw new ApiError(401, "Invalid project credential");
    }
  }

  private checkWidgetOrigin(
    req: IncomingMessage,
    allowedOriginsJson: string,
    meta: { corsOrigin?: string },
  ): void {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = JSON.parse(allowedOriginsJson) as string[];
    if (origin === "null" || (allowed.length > 0 && !allowed.includes(origin))) {
      throw new ApiError(403, "This origin is not enabled for the project");
    }
    meta.corsOrigin = origin;
  }

  private async readJson(
    req: IncomingMessage,
    maxBytes = 160_000,
  ): Promise<Record<string, unknown>> {
    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new ApiError(415, "Send application/json");
    }
    const contentLengthHeader = req.headers["content-length"];
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isNaN(declared) || declared < 0 || declared > maxBytes) {
        throw new ApiError(413, "Request too large");
      }
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        throw new ApiError(413, "Request too large");
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ApiError(400, "Malformed JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ApiError(400, "Expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  private async readBinary(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const limitMb = Math.max(1, Math.round(maxBytes / (1024 * 1024)));
    const contentLengthHeader = req.headers["content-length"];
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isNaN(declared) || declared < 0 || declared > maxBytes) {
        throw new ApiError(413, `文件体积超出限制（最大 ${limitMb} MB）`);
      }
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        throw new ApiError(413, `文件体积超出限制（最大 ${limitMb} MB）`);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  private sendJson(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    payload: unknown,
    meta: {
      corsOrigin?: string;
      sessionCookie?: string;
      adminChallenge?: boolean;
    } = {},
  ): void {
    const body = payload === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), "utf8");
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", String(body.length));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (meta.sessionCookie) {
      res.setHeader("Set-Cookie", meta.sessionCookie);
    }
    if (this.wallet) {
      res.setHeader("X-Relaydesk-Auth", "wallet");
    }
    if (meta.adminChallenge) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Relaydesk"');
    }
    if (meta.corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", meta.corsOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Visitor-Id");
    }
    if (req.method === "HEAD" || body.length === 0) {
      res.end();
    } else {
      res.end(body);
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const meta: {
      corsOrigin?: string;
      sessionCookie?: string;
      adminChallenge?: boolean;
    } = {};

    try {
      const method = (req.method ?? "GET").toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method)) {
        throw new ApiError(405, "Method not allowed");
      }

      const rawSubpath = pathname.slice("/api/".length).replace(/^\/+|\/+$/g, "");
      const parts = rawSubpath ? rawSubpath.split("/") : [];

      // Bridge agent authenticated standalone client download (independent of operator auth)
      if (
        parts.length === 2 &&
        parts[0] === "bridge" &&
        parts[1] === "client.mjs"
      ) {
        await this.handleBridgeClientBundle(req, res, method);
        return;
      }

      // Bridge agent authenticated workspace file transfer (independent of operator auth)
      if (
        parts.length === 5 &&
        parts[0] === "bridge" &&
        parts[1] === "projects" &&
        parts[3] === "workspace" &&
        parts[4] === "file"
      ) {
        const handled = await this.handleBridgeWorkspaceFile(req, res, method, parts[2]);
        if (handled !== undefined) {
          this.sendJson(req, res, 200, handled, meta);
        }
        return;
      }

      if (parts[0] === "auth") {
        const result = await this.handleAuth(req, method, parts.slice(1), meta);
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      if (parts[0] === "github") {
        const result = await this.handleGithub(req, method, parts.slice(1), meta);
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      if (parts[0] === "r2") {
        const result = await this.handleR2(req, method, parts.slice(1), meta);
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      if (parts[0] === "utility-ai") {
        const result = await this.handleUtilityAi(req, method, parts.slice(1), meta);
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      const feedbackPath = parts[0] === 'projects' && ['portal', 'widget-feedback'].includes(parts[2]);
      if (feedbackPath) {
        if (method === 'OPTIONS' && parts[2] === 'widget-feedback') {
          this.checkWidgetOrigin(req, this.store.getProjectRow(parts[1]).allowed_origins, meta);
          this.sendJson(req,res,204,null,meta);
        } else {
          const result = await this.handleFeedback(req, res, method, parts, meta);
          if (!res.destroyed && !res.headersSent && result !== undefined) this.sendJson(req, res, 200, result, meta);
        }
        return;
      }

      const isPublicPath =
        parts.length === 3 &&
        parts[0] === "projects" &&
        (parts[2] === "intake" ||
          parts[2] === "clarify" ||
          parts[2] === "uploads" ||
          parts[2] === "chat" ||
          parts[2] === "widget-config");
      const isAgentPath =
        parts.length >= 4 && parts[0] === "projects" && parts[2] === "agent";

      if (method === "OPTIONS" && isPublicPath) {
        this.store.transaction(false, () => {
          const project = this.store.getProjectRow(parts[1]);
          this.checkWidgetOrigin(req, project.allowed_origins, meta);
        });
        this.sendJson(req, res, 204, null, meta);
        return;
      }

      if (!isPublicPath && !isAgentPath) {
        this.checkOperator(req, meta);
      }

      if (parts.length === 1 && parts[0] === "sidebar-accounts") {
        if (method !== "GET") throw new ApiError(405, "Method not allowed");
        this.sendJson(req, res, 200, { accounts: this.bridgeHub?.sidebarAccounts() ?? [] }, meta);
        return;
      }

      // Operator Local Bridge agent management endpoints
      if (parts.length >= 2 && parts[0] === "bridge" && parts[1] === "agents") {
        const result = await this.handleBridgeAgents(req, method, parts.slice(2));
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      // Operator Project <-> Local Bridge agent binding endpoints
      if (parts.length >= 3 && parts[0] === "projects" && parts[2] === "agent-bindings") {
        const result = await this.handleProjectAgentBindings(req, method, parts[1], parts.slice(3));
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      // Operator Project execution routing & priority endpoints
      if (
        parts.length === 3 &&
        parts[0] === "projects" &&
        (parts[2] === "execution-routing" || parts[2] === "routing")
      ) {
        const result = await this.handleProjectExecutionRouting(req, method, parts[1]);
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      if (parts.length === 3 && parts[0] === "projects" && parts[2] === "feedback-agent") {
        if (method !== "GET" && method !== "PATCH") throw new ApiError(405, "Method not allowed");
        this.store.getProjectRow(parts[1]);
        if (method === "PATCH") {
          patchFeedbackAgent(this.store, parts[1], await this.readJson(req, 64 * 1024));
        }
        const status = getFeedbackAgentStatus(this.store, this.bridgeHub, parts[1]);
        this.sendJson(req, res, 200, status, meta);
        return;
      }
      if (parts[0] === 'projects' && parts[2] === 'portal-links') {
        const data = method === 'POST' || method === 'PATCH' ? await this.readJson(req, 8192) : {};
        const result = this.store.transaction(method !== 'GET', () => manageLinks(this.store, parts[1], method, parts.slice(3), data));
        this.sendJson(req,res,200,result,meta);
        return;
      }
      if (parts.length === 3 && parts[0] === 'projects' && parts[2] === 'deploy-gates' && method === 'GET') {
        this.sendJson(req,res,200,{evaluations:listDeployGates(this.store,parts[1])},meta);
        return;
      }

      // Operator Project deploy policy endpoints
      if (parts.length === 3 && parts[0] === "projects" && parts[2] === "deploy-policy") {
        const projectId = parts[1];
        if (method === "GET") {
          const deploy_policy = this.store.getProjectDeployPolicy(projectId);
          const deployDoc = readWorkspaceDeployDoc(this.store.dbPath, projectId);
          this.sendJson(req, res, 200, { deploy_policy, deploy_doc_exists: deployDoc.exists }, meta);
          return;
        }
        if (method === "PUT" || method === "PATCH") {
          const body = await this.readJson(req, 32 * 1024);
          const deploy_policy = this.store.transaction(true, () =>
            this.store.updateProjectDeployPolicy(projectId, body),
          );
          const deployDoc = readWorkspaceDeployDoc(this.store.dbPath, projectId);
          this.releaseDispatcher.schedule(projectId);
          this.sendJson(req, res, 200, { deploy_policy, deploy_doc_exists: deployDoc.exists }, meta);
          return;
        }
        throw new ApiError(405, "Method not allowed");
      }

      // Operator Project releases endpoints
      if (parts.length >= 3 && parts[0] === "projects" && parts[2] === "releases") {
        const projectId = parts[1];
        this.store.getProjectRow(projectId);
        if (parts.length === 3 && method === "GET") {
          const urlObj = new URL(req.url ?? "/", "http://127.0.0.1");
          const rawLimit = Number(urlObj.searchParams.get("limit") || 50);
          const releases = this.store.listReleases(projectId, Number.isFinite(rawLimit) ? rawLimit : 50);
          const pending_tasks = this.store.listTasksByDeployStatus(projectId, ["pending"]);
          const failed_tasks = this.store.listTasksByDeployStatus(projectId, ["failed"]);
          const active_release = this.store.getActiveRelease(projectId);
          const deploy_policy = this.store.getProjectDeployPolicy(projectId);
          const deployDoc = readWorkspaceDeployDoc(this.store.dbPath, projectId);
          this.sendJson(
            req,
            res,
            200,
            {
              releases,
              pending_tasks,
              failed_tasks,
              active_release,
              deploy_policy,
              deploy_doc_exists: deployDoc.exists,
            },
            meta,
          );
          return;
        }
        if (parts.length === 4 && parts[3] === "trigger" && method === "POST") {
          const hasBody =
            Number(req.headers["content-length"]) > 0 ||
            req.headers["transfer-encoding"] !== undefined;
          const body = hasBody ? await this.readJson(req, 32 * 1024) : {};
          const selection = chatModelSelection(body);
          const prompt =
            typeof body.prompt === "string" ? body.prompt.trim().slice(0, 8000) : undefined;
          const force = body.force === true;
          const result = this.releaseDispatcher.triggerReleaseManually(projectId, {
            force,
            prompt,
            ...selection,
          });
          this.sendJson(
            req,
            res,
            200,
            {
              release: result.release,
              session: result.session,
              run_id: result.runId,
            },
            meta,
          );
          return;
        }
        if (parts.length === 5 && parts[4] === "reverify" && method === "POST") {
          const hasBody =
            Number(req.headers["content-length"]) > 0 ||
            req.headers["transfer-encoding"] !== undefined;
          const body = hasBody ? await this.readJson(req, 32 * 1024) : {};
          const selection = chatModelSelection(body);
          const prompt =
            typeof body.prompt === "string" ? body.prompt.trim().slice(0, 8000) : undefined;
          const result = this.releaseDispatcher.reverifyRelease(projectId, parts[3], {
            prompt,
            ...selection,
          });
          this.sendJson(
            req,
            res,
            200,
            {
              release: result.release,
              session: result.session,
              run_id: result.runId,
            },
            meta,
          );
          return;
        }
        if (parts.length === 4 && method === "GET") {
          const release = this.store.getRelease(projectId, parts[3]);
          let session = release.session_id
            ? this.store.getReleaseChatSession(release.id)
            : null;
          if (session) {
            const activeRunId = this.chatRuns.getActiveRunId(session.id);
            if (activeRunId) session = { ...session, active_run_id: activeRunId };
          }
          this.sendJson(req, res, 200, { release, session }, meta);
          return;
        }
        throw new ApiError(405, "Method not allowed");
      }

      if (parts.length === 4 && parts[0] === "projects" && parts[2] === "cli-config" && parts[3] === "discover-models" && method === "POST") {
        const project = this.store.getProjectRow(parts[1]);
        const hasBody = Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"] !== undefined;
        const options = hasBody ? await this.readJson(req, 16 * 1024) : {};
        const models = await discoverProjectCliModels(this.store.dbPath, project.id, options);
        this.sendJson(req, res, 200, { models }, meta);
        return;
      }

      if (parts.length === 3 && parts[0] === "projects" && parts[2] === "cli-config" && (method === "GET" || method === "PATCH")) {
        const project = this.store.getProjectRow(parts[1]);
        const patch = method === "PATCH" ? await this.readJson(req, 64 * 1024) : undefined;
        const config = projectCliConfiguration(this.store.dbPath, project.id, patch);
        const presence = this.cliPresence.get(project.id);
        const online = !!presence && Date.now() - presence.seen < 90_000;
        this.sendJson(req, res, 200, { ...config, online, managed: presence?.managed ?? false,
          ready: online && !!presence?.ready && config.configured && presence.runtime === config.runtime,
          last_seen_at: presence ? new Date(presence.seen).toISOString() : null }, meta);
        return;
      }

      // Async operator repo mirror endpoints
      if (
        parts.length === 4 &&
        parts[0] === "projects" &&
        parts[2] === "repos" &&
        (parts[3] === "status" || parts[3] === "sync")
      ) {
        const result = await this.handleProjectRepos(method, parts[1], parts[3]);
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      // Operator Project Space endpoints (files, handbook, databases, repo browser)
      if (parts.length >= 4 && parts[0] === "projects" && parts[2] === "workspace") {
        const handled = await this.handleWorkspace(req, res, method, parts[1], parts.slice(3), meta);
        if (handled !== undefined) {
          this.sendJson(req, res, 200, handled, meta);
        }
        return;
      }

      // Operator Web Codex / CLI Chat endpoints (sessions + SSE streaming)
      if (parts.length >= 4 && parts[0] === "projects" && parts[2] === "codex-chat") {
        const handled = await this.handleCodexChat(req, res, method, parts[1], parts.slice(3), meta);
        if (handled !== undefined) {
          this.sendJson(req, res, 200, handled, meta);
        }
        return;
      }

      // Dedicated task agent session lookup and manual local agent dispatch
      if (method === "GET" && parts.length === 3 && parts[0] === "tasks" && parts[2] === "agent-session") {
        const result = this.store.transaction(false, () => {
          const task = this.store.getTaskRow(parts[1]);
          const session = this.store.getTaskChatSession(task.id);
          if (!session) return { session: null, messages: [] };
          const messages = this.store.listChatMessages(task.project_id, session.id);
          const activeRunId = this.chatRuns.getActiveRunId(session.id);
          return {
            session: activeRunId ? { ...session, active_run_id: activeRunId } : session,
            messages,
          };
        });
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      if (method === "POST" && parts.length === 3 && parts[0] === "tasks" && parts[2] === "dispatch") {
        const hasBody =
          Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"] !== undefined;
        const body = hasBody ? await this.readJson(req, 32 * 1024) : {};
        const selection = chatModelSelection(body);
        const prompt =
          typeof body.prompt === "string" && body.prompt.trim()
            ? body.prompt.trim().slice(0, 16_000)
            : undefined;
        const dispatched = this.taskDispatcher.dispatchTaskManually(parts[1], {
          ...selection,
          ...(prompt ? { prompt } : {}),
        });
        this.sendJson(req, res, 200, dispatched, meta);
        return;
      }

      // Public widget bootstrap config
      if (
        method === "GET" &&
        parts.length === 3 &&
        parts[0] === "projects" &&
        parts[2] === "widget-config"
      ) {
        const result = await this.handleWidgetConfig(req, parts[1], meta);
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      // Public widget screenshot / image upload to R2
      if (
        method === "POST" &&
        parts.length === 3 &&
        parts[0] === "projects" &&
        parts[2] === "uploads"
      ) {
        const result = await this.handleWidgetUpload(req, parts[1], meta);
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      // Public widget streaming Agent chat (SSE)
      if (
        method === "POST" &&
        parts.length === 3 &&
        parts[0] === "projects" &&
        parts[2] === "chat"
      ) {
        await this.handleWidgetChatStream(req, res, parts[1], meta);
        return;
      }

      const isMutation = method === "POST" || method === "PATCH";
      const isAgentQueueGet =
        method === "GET" &&
        isAgentPath &&
        parts.length === 4 &&
        parts[3] === "queue";
      const isWrite = isMutation || isAgentQueueGet;
      const data = isMutation ? await this.readJson(req) : {};

      if (
        method === "POST" &&
        parts.length === 3 &&
        ((parts[0] === "projects" && parts[2] === "clarify") ||
          (parts[0] === "tasks" && parts[2] === "discuss"))
      ) {
        const result = await this.handleChat(req, parts, data, meta);
        this.sendJson(req, res, "queued" in result ? 202 : 200, result, meta);
        return;
      }

      // CLI runs have their own leases and transactions, independent of task ownership.
      if (parts[0] === "projects" && parts[2] === "tasks" && parts.length === 5 && parts[4] === "cli-runs" && method === "GET") {
        const runs = this.store.listCliRuns(parts[1], parts[3]);
        this.sendJson(req, res, 200, { runs }, meta);
        return;
      }
      if (isAgentPath && parts[3] === "cli") {
        const project = this.store.getProjectRow(parts[1]);
        this.checkBearer(req, project.agent_key);
        if (method === "POST" && parts.length === 5 && parts[4] === "claim") {
          if (data.protocol !== 2 || data.managed !== true || !["codex", "claude"].includes(String(data.runtime)) || typeof data.ready !== "boolean") {
            throw new ApiError(400, "Expected a managed project CLI runner (protocol 2)");
          }
          const config = projectCliConfiguration(this.store.dbPath, project.id);
          const ready = data.ready && config.configured && data.runtime === config.runtime;
          const claim = ready ? this.store.claimCliRun(project.id) : null;
          this.cliPresence.set(project.id, { seen: Date.now(), runtime: String(data.runtime), managed: true, ready, runId: claim?.run.id });
          this.sendJson(req, res, 200, claim ?? { run: null }, meta);
          return;
        }
        if (method === "POST" && parts.length === 7 && parts[4] === "runs" && parts[6] === "events") {
          const run = this.store.eventCliRun(project.id, parts[5], data);
          const presence = this.cliPresence.get(project.id);
          if (presence?.runId === run.id) presence.seen = Date.now();
          this.sendJson(req, res, 200, { run }, meta);
          return;
        }
        throw new ApiError(404, "Unknown CLI endpoint");
      }

      const postCommit: Array<() => void> = [];
      const result = this.store.transaction(isWrite, () =>
        this.handleStoreApi(req, method, parts, data, meta, postCommit),
      );
      for (const taskFn of postCommit) {
        taskFn();
      }
      this.sendJson(req, res, 200, result, meta);
    } catch (err) {
      if (err instanceof ApiError) {
        this.sendJson(req, res, err.status, err instanceof PortalAccessError ? {error:err.message, code:err.code} : { error: err.message }, meta);
        return;
      }
      if (
        err instanceof Error &&
        (err.message.includes("SQLITE_BUSY") || err.message.includes("database is locked"))
      ) {
        this.sendJson(req, res, 503, { error: "Database operation unavailable" }, meta);
        return;
      }
      if (err instanceof SyntaxError || err instanceof RangeError) {
        this.sendJson(req, res, 400, { error: "Malformed request" }, meta);
        return;
      }
      this.sendJson(req, res, 500, { error: "Internal server error" }, meta);
    }
  }

  private describeBridgeAgent(agent: BridgeAgentSummary): BridgeAgentSummary {
    return this.bridgeHub ? this.bridgeHub.describe(agent) : agent;
  }

  private buildBridgeTokenResponse(
    req: IncomingMessage,
    agent: BridgeAgentSummary,
    token: string,
  ): BridgeAgentTokenResponse {
    const host = req.headers.host || `${this.bindHost}:4310`;
    const forwardedProto = typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"].split(",")[0].trim().toLowerCase()
      : "";
    const proto =
      forwardedProto === "https" || this.wallet?.origin.startsWith("https://")
        ? "wss"
        : "ws";
    const httpProto = proto === "wss" ? "https" : "http";
    const serverUrl = `${proto}://${host}/api/bridge/ws`;
    const clientUrl = `${httpProto}://${host}/api/bridge/client.mjs`;
    const described = this.describeBridgeAgent(agent);
    return {
      agent: described,
      token,
      client_url: clientUrl,
      bridge_version: "2.0.0",
      quickstart_config: {
        server_url: serverUrl,
        agent_token: token,
        agent_name: described.name,
        max_concurrency: described.max_concurrency,
        accept_cli_runs: described.accept_cli_runs,
        auto_detect_cli_configs: true,
        allowed_roots: [],
        projects: {},
        models: [],
      },
      start_command: "node ~/.local/share/relaydesk-bridge/relaydesk-bridge.mjs --config ~/.config/relaydesk-bridge/config.json",
    };
  }

  private bridgeBundleCache: { path: string; mtimeMs: number; size: number; body: Buffer; sha256: string } | null = null;

  private async handleBridgeClientBundle(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
  ): Promise<void> {
    if (method !== "GET" && method !== "HEAD") {
      throw new ApiError(405, "Method not allowed");
    }
    const urlObj = new URL(req.url ?? "/", "http://localhost");
    this.checkBridgeAgent(req, urlObj);

    const bundlePath = resolve(
      process.env.RELAYDESK_BRIDGE_BUNDLE_PATH?.trim() || "build/bridge/relaydesk-bridge.mjs",
    );
    if (!existsSync(bundlePath)) {
      throw new ApiError(503, "Bridge client bundle not built yet. Run pnpm build:bridge on the server.");
    }
    const st = statSync(bundlePath);
    if (!st.isFile()) {
      throw new ApiError(503, "Bridge client bundle is unavailable");
    }
    let cached = this.bridgeBundleCache;
    if (!cached || cached.path !== bundlePath || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      const body = readFileSync(bundlePath);
      const sha256 = createHash("sha256").update(body).digest("hex");
      cached = { path: bundlePath, mtimeMs: st.mtimeMs, size: st.size, body, sha256 };
      this.bridgeBundleCache = cached;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Content-Length", String(cached.body.length));
    res.setHeader("X-Content-Sha256", cached.sha256);
    res.setHeader("X-Bridge-Version", "2.0.0");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (method === "HEAD") {
      res.end();
      return;
    }
    res.end(cached.body);
  }

  private checkBridgeAgent(req: IncomingMessage, urlObj: URL): BridgeAgentSummary {
    if (urlObj.searchParams.has("token")) {
      throw new ApiError(401, "Bridge token must be sent in Authorization header");
    }
    const match = /^Bearer (rdbr_[a-zA-Z0-9_-]+)$/i.exec(req.headers.authorization ?? "");
    const agent = match ? this.store.findBridgeAgentByToken(match[1]) : null;
    if (!agent) {
      throw new ApiError(401, "Invalid bridge agent token");
    }
    return agent;
  }

  private async handleBridgeWorkspaceFile(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    projectId: string,
  ): Promise<unknown> {
    const urlObj = new URL(req.url ?? "/", "http://localhost");
    const agent = this.checkBridgeAgent(req, urlObj);
    const binding = this.store.getProjectAgentBinding(projectId, agent.id);
    if (!binding?.enabled || !binding.path_ok) throw new ApiError(403, "节点未绑定有效项目目录");
    const filePath = urlObj.searchParams.get("path") ?? "";

    if (method === "GET") {
      const headerRunId =
        typeof req.headers["x-relaydesk-run-id"] === "string"
          ? req.headers["x-relaydesk-run-id"].trim()
          : "";
      const requestedId = headerRunId || urlObj.searchParams.get("run_id")?.trim();
      this.bridgeHub?.assertPublicFeedbackReadAllowed(agent.id, projectId, filePath, requestedId);
      const { stream, size, sha256 } = streamBridgeWorkspaceFile(this.store.dbPath, projectId, filePath);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(size));
      res.setHeader("X-Content-Sha256", sha256);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      try { await pipeline(stream, res); }
      catch (err) { if (!res.destroyed && !res.headersSent) throw err; }
      return undefined;
    }

    if (method === "PUT") {
      const headerRunId =
        typeof req.headers["x-relaydesk-run-id"] === "string"
          ? req.headers["x-relaydesk-run-id"].trim()
          : "";
      const requestedId = headerRunId || urlObj.searchParams.get("run_id")?.trim();
      const runId = this.bridgeHub?.writeLeaseId(agent.id, projectId, requestedId);
      if (!this.bridgeHub || !runId) {
        throw new ApiError(403, "没有有效的写入租约");
      }
      const bytes = await this.readBinary(req, MAX_BRIDGE_FILE_BYTES);
      // Re-verify token, binding, and active write lease after buffering the upload body (prevent TOCTOU on abort/disconnect/rotation).
      const rechecked = this.checkBridgeAgent(req, urlObj);
      if (rechecked.id !== agent.id || !this.bridgeHub.hasActiveWriteLease(agent.id, projectId, runId)) {
        throw new ApiError(403, "没有有效的写入租约");
      }
      writeBridgeWorkspaceFile(this.store.dbPath, projectId, filePath, bytes);
      return {
        ok: true,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }

    throw new ApiError(405, "Method not allowed");
  }

  private async handleBridgeAgents(
    req: IncomingMessage,
    method: string,
    subparts: string[],
  ): Promise<unknown> {
    if (subparts.length === 0) {
      if (method === "GET") {
        const agents = this.store.listBridgeAgents().map((a) => this.describeBridgeAgent(a));
        return { agents };
      }
      if (method === "POST") {
        const data = await this.readJson(req, 16 * 1024);
        const name = field(data, "name", 120);
        const { agent, token } = this.store.transaction(true, () =>
          this.store.createBridgeAgent(name),
        );
        return this.buildBridgeTokenResponse(req, agent, token);
      }
      throw new ApiError(405, "Method not allowed");
    }

    const agentId = subparts[0];
    if (subparts.length === 1) {
      if (method === "PATCH") {
        const data = await this.readJson(req, 16 * 1024);
        const patch: BridgeAgentPatch = {};
        if ("name" in data) {
          if (typeof data.name !== "string" || !data.name.trim()) {
            throw new ApiError(400, "节点名称无效");
          }
          patch.name = data.name.trim().slice(0, 120);
        }
        if ("max_concurrency" in data) {
          if (typeof data.max_concurrency !== "number") {
            throw new ApiError(400, "并发上限无效");
          }
          patch.max_concurrency = data.max_concurrency;
        }
        if ("accept_cli_runs" in data) {
          if (typeof data.accept_cli_runs !== "boolean") {
            throw new ApiError(400, "accept_cli_runs 必须为布尔值");
          }
          patch.accept_cli_runs = data.accept_cli_runs;
        }
        const agent = this.store.transaction(true, () =>
          this.store.updateBridgeAgent(agentId, patch),
        );
        return { agent: this.describeBridgeAgent(agent) };
      }
      if (method === "DELETE") {
        this.store.transaction(true, () => this.store.deleteBridgeAgent(agentId));
        this.bridgeHub?.disconnect(agentId, 4002, "Agent deleted");
        return { ok: true };
      }
      throw new ApiError(405, "Method not allowed");
    }

    if (subparts.length === 2 && subparts[1] === "rotate-token" && method === "POST") {
      const { agent, token } = this.store.transaction(true, () =>
        this.store.rotateBridgeAgentToken(agentId),
      );
      this.bridgeHub?.disconnect(agentId, 4001, "Token rotated");
      return this.buildBridgeTokenResponse(req, agent, token);
    }

    if (subparts.length === 2 && subparts[1] === "refresh" && method === "POST") {
      if (!this.bridgeHub) {
        throw new ApiError(503, "Bridge hub unavailable");
      }
      this.bridgeHub.refresh(agentId);
      return { ok: true };
    }

    throw new ApiError(404, "Unknown bridge agent endpoint");
  }

  private async handleProjectAgentBindings(
    req: IncomingMessage,
    method: string,
    projectId: string,
    subparts: string[],
  ): Promise<unknown> {
    if (subparts.length === 0 && method === "GET") {
      this.store.getProjectRow(projectId);
      return { bindings: this.store.listProjectAgentBindings(projectId) };
    }

    if (subparts.length === 1 && method === "PATCH") {
      const agentId = subparts[0];
      this.store.getProjectRow(projectId);
      if (!this.store.getBridgeAgent(agentId)) {
        throw new ApiError(404, "本机节点不存在");
      }
      const data = await this.readJson(req, 16 * 1024);

      let workdir: string | undefined;
      if ("workdir" in data) {
        if (
          typeof data.workdir !== "string" ||
          !data.workdir.trim() ||
          data.workdir.length > 4096 ||
          /[\x00-\x1f]/.test(data.workdir)
        ) {
          throw new ApiError(400, "项目目录路径无效");
        }
        workdir = data.workdir.trim();
      }
      let allowDatasourceSecrets: boolean | undefined;
      if ("allow_datasource_secrets" in data) {
        if (typeof data.allow_datasource_secrets !== "boolean") {
          throw new ApiError(400, "allow_datasource_secrets 必须为布尔值");
        }
        allowDatasourceSecrets = data.allow_datasource_secrets;
      }
      let enabled: boolean | undefined;
      if ("enabled" in data) {
        if (typeof data.enabled !== "boolean") {
          throw new ApiError(400, "enabled 必须为布尔值");
        }
        enabled = data.enabled;
      }

      if (workdir !== undefined && workdir !== this.store.getProjectAgentBinding(projectId, agentId)?.workdir) {
        if (!this.bridgeHub) {
          throw new ApiError(409, "本机节点离线，无法校验目录");
        }
        const confirmed = await this.bridgeHub.bindProject(agentId, projectId, workdir);
        if (!confirmed.path_ok) {
          throw new ApiError(400, confirmed.path_error || "本机节点拒绝了该目录绑定");
        }
        const binding = this.store.transaction(true, () => {
          const latest = this.store.getProjectAgentBinding(projectId, agentId);
          if (!latest || !latest.path_ok || latest.workdir !== confirmed.workdir) {
            throw new ApiError(409, "项目目录绑定状态已变更，请重试");
          }
          if (allowDatasourceSecrets !== undefined || enabled !== undefined) {
            return this.store.upsertProjectAgentBinding(projectId, agentId, {
              ...(allowDatasourceSecrets !== undefined
                ? { allow_datasource_secrets: allowDatasourceSecrets }
                : {}),
              ...(enabled !== undefined ? { enabled } : {}),
            });
          }
          return latest;
        });
        if (binding.enabled && binding.path_ok) {
          this.taskDispatcher.schedule(projectId);
        }
        return { binding };
      }

      const binding = this.store.transaction(true, () =>
        this.store.upsertProjectAgentBinding(projectId, agentId, {
          ...(allowDatasourceSecrets !== undefined
            ? { allow_datasource_secrets: allowDatasourceSecrets }
            : {}),
          ...(enabled !== undefined ? { enabled } : {}),
        }),
      );
      if (binding.enabled && binding.path_ok) {
        this.taskDispatcher.schedule(projectId);
      }
      return { binding };
    }

    throw new ApiError(404, "Unknown project agent binding endpoint");
  }

  private async handleProjectExecutionRouting(
    req: IncomingMessage,
    method: string,
    projectId: string,
  ): Promise<unknown> {
    this.store.getProjectRow(projectId);
    const listDescribedAgents = () =>
      this.store.listBridgeAgents().map((a) => this.describeBridgeAgent(a));
    const readDefaultRuntime = (): ChatRuntime => {
      try {
        return projectCliConfiguration(this.store.dbPath, projectId).runtime;
      } catch {
        return "codex";
      }
    };

    if (method === "GET") {
      const routing = this.store.getProjectExecutionRouting(projectId);
      const agents = listDescribedAgents();
      return {
        routing,
        effective_priority: normalizeExecutionPriority(routing, agents),
        agents,
        default_runtime: readDefaultRuntime(),
      };
    }

    if (method === "PUT" || method === "PATCH") {
      const data = await this.readJson(req, 16 * 1024);
      const agents = listDescribedAgents();
      const validIds = new Set(agents.map((a) => a.id));
      const patch: Partial<ProjectRoutingConfig> = {};

      if ("priority" in data) {
        if (!Array.isArray(data.priority) || data.priority.length > 100) {
          throw new ApiError(400, "priority 必须为数组");
        }
        const cleaned: string[] = [];
        const seen = new Set<string>();
        for (const item of data.priority) {
          if (typeof item !== "string") throw new ApiError(400, "priority 元素必须为字符串");
          const trimmed = item.trim();
          if (trimmed === "cloud") {
            if (!seen.has("cloud")) {
              seen.add("cloud");
              cleaned.push("cloud");
            }
            continue;
          }
          if (trimmed.startsWith("local:")) {
            const agentId = trimmed.slice("local:".length);
            if (!validIds.has(agentId)) {
              throw new ApiError(400, `未知的执行节点：${trimmed}`);
            }
            if (!seen.has(trimmed)) {
              seen.add(trimmed);
              cleaned.push(trimmed);
            }
            continue;
          }
          throw new ApiError(400, `无效的优先级目标：${trimmed}`);
        }
        patch.priority = cleaned;
      }
      if ("auto_fallback" in data) {
        if (typeof data.auto_fallback !== "boolean") {
          throw new ApiError(400, "auto_fallback 必须为布尔值");
        }
        patch.auto_fallback = data.auto_fallback;
      }
      if ("route_cli_runs" in data) {
        if (typeof data.route_cli_runs !== "boolean") {
          throw new ApiError(400, "route_cli_runs 必须为布尔值");
        }
        patch.route_cli_runs = data.route_cli_runs;
      }
      if ("auto_dispatch_tasks" in data) {
        if (typeof data.auto_dispatch_tasks !== "boolean") {
          throw new ApiError(400, "auto_dispatch_tasks 必须为布尔值");
        }
        patch.auto_dispatch_tasks = data.auto_dispatch_tasks;
      }
      if ("task_runtime" in data) {
        if (data.task_runtime === "" || data.task_runtime === null || data.task_runtime === undefined) {
          patch.task_runtime = undefined;
        } else if (data.task_runtime === "codex" || data.task_runtime === "claude") {
          patch.task_runtime = data.task_runtime as ChatRuntime;
        } else {
          throw new ApiError(400, "task_runtime 无效");
        }
      }
      if ("task_model" in data) {
        if (data.task_model === "" || data.task_model === null || data.task_model === undefined) {
          patch.task_model = "";
        } else if (validCatalogId(data.task_model)) {
          patch.task_model = data.task_model;
        } else {
          throw new ApiError(400, "task_model 无效");
        }
      }
      if ("task_reasoning_effort" in data) {
        if (
          data.task_reasoning_effort === "" ||
          data.task_reasoning_effort === null ||
          data.task_reasoning_effort === undefined
        ) {
          patch.task_reasoning_effort = undefined;
        } else if (
          typeof data.task_reasoning_effort === "string" &&
          Object.hasOwn(effortLabels, data.task_reasoning_effort)
        ) {
          patch.task_reasoning_effort = data.task_reasoning_effort as ChatReasoningEffort;
        } else {
          throw new ApiError(400, "task_reasoning_effort 无效");
        }
      }
      if ("task_network_access" in data) {
        if (typeof data.task_network_access !== "boolean") {
          throw new ApiError(400, "task_network_access 必须为布尔值");
        }
        patch.task_network_access = data.task_network_access;
      }

      const routing = this.store.transaction(true, () =>
        this.store.updateProjectExecutionRouting(projectId, patch),
      );
      if (routing.auto_dispatch_tasks) {
        this.taskDispatcher.schedule(projectId);
      }
      return {
        routing,
        effective_priority: normalizeExecutionPriority(routing, agents),
        agents,
        default_runtime: readDefaultRuntime(),
      };
    }

    throw new ApiError(405, "Method not allowed");
  }

  private async handleAuth(
    req: IncomingMessage,
    method: string,
    subparts: string[],
    meta: { sessionCookie?: string; adminChallenge?: boolean },
  ): Promise<unknown> {
    if (subparts.length === 1 && subparts[0] === "status" && method === "GET") {
      const mode = this.getAuthMode();
      let authenticated = false;
      if (mode === "wallet") {
        authenticated = this.isWalletAuthenticated(req);
      } else if (mode === "none") {
        try {
          this.checkOperator(req, {});
          authenticated = true;
        } catch {
          authenticated = false;
        }
      } else {
        try {
          this.checkOperator(req, {});
          authenticated = true;
        } catch {
          authenticated = false;
        }
      }
      const status: AuthStatusPayload = {
        mode,
        authenticated,
        ...(this.wallet?.passwordEnabled ? { passwordEnabled: true } : {}),
        ...(this.wallet ? { address: this.wallet.address } : {}),
      };
      return status;
    }

    if (!this.wallet) {
      throw new ApiError(404, "Wallet authentication is not enabled");
    }
    if (method !== "POST") {
      throw new ApiError(405, "Method not allowed");
    }
    if (req.headers.host !== this.wallet.host || req.headers.origin !== this.wallet.origin) {
      throw new ApiError(403, "Invalid sign-in origin");
    }
    const endpoint = subparts[0];
    const data = await this.readJson(req);
    if (endpoint === "challenge" && subparts.length === 1) {
      try {
        return this.wallet.challenge(data.chain_id);
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : "Invalid chain ID");
      }
    }
    if (endpoint === "password" && subparts.length === 1 && this.wallet.passwordEnabled) {
      this.rateLimit("admin:password", 10);
      const token = this.wallet.verifyPassword(data.password);
      if (!token) throw new ApiError(401, "登录失败，请检查密码。");
      meta.sessionCookie = formatSessionCookie(token);
      return { ok: true };
    }
    if (endpoint === "verify" && subparts.length === 1) {
      const nonce = field(data, "nonce", 48);
      const signature = field(data, "signature", 132);
      const token = await this.wallet.verify(nonce, signature);
      if (!token) {
        throw new ApiError(401, "签名无效或已过期，请重新登录。");
      }
      meta.sessionCookie = formatSessionCookie(token);
      return { ok: true };
    }
    if (endpoint === "logout" && subparts.length === 1) {
      this.wallet.logout(parseCookieValue(req.headers.cookie));
      meta.sessionCookie = formatSessionCookie("");
      return { ok: true };
    }
    throw new ApiError(404, "Unknown sign-in endpoint");
  }

  private async handleGithub(
    req: IncomingMessage,
    method: string,
    subparts: string[],
    meta: { adminChallenge?: boolean },
  ): Promise<unknown> {
    this.checkOperator(req, meta);
    if (subparts.length === 0 && method === "GET") {
      const connections = listGithubConnectionSummaries(this.store.dbPath);
      return {
        configured: connections.length > 0,
        connections,
      };
    }
    if (method !== "POST") {
      throw new ApiError(405, "Method not allowed");
    }
    const data = await this.readJson(req);
    try {
      if (subparts.length === 1 && subparts[0] === "inspect") {
        const rawToken = typeof data.token === "string" ? data.token.trim() : "";
        const id =
          typeof data.id === "string" && data.id.trim()
            ? data.id.trim().slice(0, 64)
            : undefined;
        let token = rawToken;
        if (token) {
          if (token.length > 512 || !/^[A-Za-z0-9_]+$/.test(token)) {
            throw new ApiError(400, "请输入有效的 GitHub token");
          }
        } else if (id) {
          const existing = readGithubConnections(this.store.dbPath).find((c) => c.id === id);
          if (!existing) {
            throw new ApiError(404, "未找到对应的 GitHub Key。");
          }
          token = existing.token;
        } else {
          throw new ApiError(400, "请输入 GitHub token");
        }
        return await inspectGithubToken(token);
      }
      if (subparts.length === 1 && subparts[0] === "connect") {
        const rawToken = typeof data.token === "string" ? data.token.trim() : "";
        const label =
          typeof data.label === "string" ? data.label.trim().slice(0, 80) : "";
        const id =
          typeof data.id === "string" && data.id.trim()
            ? data.id.trim().slice(0, 64)
            : undefined;
        const existingConn = id
          ? readGithubConnections(this.store.dbPath).find((c) => c.id === id)
          : undefined;
        if (id && !existingConn && !rawToken) {
          throw new ApiError(404, "未找到对应的 GitHub Key。");
        }

        let token = rawToken;
        if (token) {
          if (token.length > 512 || !/^[A-Za-z0-9_]+$/.test(token)) {
            throw new ApiError(400, "请输入有效的 GitHub token");
          }
        } else if (existingConn) {
          token = existingConn.token;
        } else {
          throw new ApiError(400, "请输入有效的 GitHub token");
        }

        let scopeOwner: GithubOwnerInfo | null | undefined;
        if ("scope_owner" in data) {
          const rawScope = data.scope_owner;
          if (rawScope === null || rawScope === "" || rawScope === "auto") {
            scopeOwner = null;
          } else if (rawScope && typeof rawScope === "object") {
            const obj = rawScope as Record<string, unknown>;
            const scopeLogin =
              typeof obj.login === "string" ? obj.login.trim().replace(/^@/, "") : "";
            const scopeType =
              obj.type === "Organization" || obj.type === "User" ? obj.type : null;
            if (!scopeLogin || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(scopeLogin)) {
              throw new ApiError(400, "无效的 GitHub 账号或组织名称");
            }
            if (!scopeType) {
              throw new ApiError(400, "归属类型仅支持个人账号或组织");
            }
            scopeOwner = await resolveScopeOwner(token, {
              login: scopeLogin,
              type: scopeType,
            });
          } else {
            throw new ApiError(400, "无效的归属作用域参数");
          }
        } else if (existingConn) {
          scopeOwner = existingConn.scope_owner ?? null;
        }

        const effectiveScope = scopeOwner ?? null;
        const catalog = await fetchGithubRepositories(token, {
          page: 1,
          scopeOwner: effectiveScope,
        });
        const finalScope = effectiveScope
          ? catalog.owners[0] ?? effectiveScope
          : null;
        const saved = upsertGithubConnection(this.store.dbPath, {
          id,
          label: label || undefined,
          token,
          viewer: catalog.viewer,
          owners: catalog.owners,
          scope_owner: finalScope,
          repo_count: catalog.items.length,
        });
        const summaries = saved.connections.map(toGithubConnectionSummary);
        return {
          configured: summaries.length > 0,
          connection: toGithubConnectionSummary(saved.connection),
          connections: summaries,
          viewer: catalog.viewer,
          org_count: catalog.owners.filter((o) => o.type === "Organization").length,
          repo_count: catalog.items.length,
        };
      }
      if (subparts.length === 1 && subparts[0] === "disconnect") {
        const id =
          typeof data.id === "string" && data.id.trim()
            ? data.id.trim().slice(0, 64)
            : undefined;
        const remaining = removeGithubConnection(this.store.dbPath, id);
        const summaries = remaining.map(toGithubConnectionSummary);
        return {
          configured: summaries.length > 0,
          connections: summaries,
        };
      }
      if (subparts.length === 1 && subparts[0] === "refresh") {
        const id =
          typeof data.id === "string" && data.id.trim()
            ? data.id.trim().slice(0, 64)
            : undefined;
        const existing = readGithubConnections(this.store.dbPath);
        if (existing.length === 0) {
          throw new ApiError(409, "尚未配置 GitHub Key。");
        }
        if (id) {
          const target = existing.find((c) => c.id === id);
          if (!target) {
            throw new ApiError(404, "未找到对应的 GitHub Key。");
          }
          const catalog = await fetchGithubRepositories(target.token, {
            page: 1,
            scopeOwner: target.scope_owner ?? null,
          });
          const finalScope = target.scope_owner
            ? catalog.owners[0] ?? target.scope_owner
            : null;
          const saved = upsertGithubConnection(this.store.dbPath, {
            id: target.id,
            token: target.token,
            viewer: catalog.viewer,
            owners: catalog.owners,
            scope_owner: finalScope,
            repo_count: catalog.items.length,
          });
          const summaries = saved.connections.map(toGithubConnectionSummary);
          return {
            configured: summaries.length > 0,
            connection: toGithubConnectionSummary(saved.connection),
            connections: summaries,
            viewer: catalog.viewer,
            org_count: catalog.owners.filter((o) => o.type === "Organization").length,
            repo_count: catalog.items.length,
          };
        }
        let latest = existing;
        for (const conn of existing) {
          const catalog = await fetchGithubRepositories(conn.token, {
            page: 1,
            scopeOwner: conn.scope_owner ?? null,
          });
          const finalScope = conn.scope_owner
            ? catalog.owners[0] ?? conn.scope_owner
            : null;
          const saved = upsertGithubConnection(this.store.dbPath, {
            id: conn.id,
            token: conn.token,
            viewer: catalog.viewer,
            owners: catalog.owners,
            scope_owner: finalScope,
            repo_count: catalog.items.length,
          });
          latest = saved.connections;
        }
        const summaries = latest.map(toGithubConnectionSummary);
        return {
          configured: summaries.length > 0,
          connections: summaries,
        };
      }
      if (subparts.length === 1 && subparts[0] === "repos") {
        const page = data.page ?? 1;
        if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 100000) {
          throw new ApiError(400, "Invalid page");
        }
        let owner = "all";
        if (typeof data.owner === "string" && data.owner.trim()) {
          const cleaned = data.owner.trim();
          if (cleaned !== "all" && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(cleaned)) {
            throw new ApiError(400, "无效的 GitHub 组织或用户名");
          }
          owner = cleaned;
        }
        let ownerType: "User" | "Organization" | undefined;
        if (data.owner_type === "User" || data.owner_type === "Organization") {
          ownerType = data.owner_type;
        }
        const connectionId =
          typeof data.connection_id === "string" && data.connection_id.trim()
            ? data.connection_id.trim().slice(0, 64)
            : undefined;
        const connections = readGithubConnections(this.store.dbPath);
        if (connections.length === 0) {
          throw new ApiError(409, "请先在设置中连接至少一个 GitHub Key。");
        }
        return await fetchGithubRepositoriesAcrossConnections(connections, {
          page,
          owner,
          ownerType,
          connectionId,
        });
      }
    } catch (err) {
      if (err instanceof GithubError) {
        throw new ApiError(502, err.message);
      }
      throw err;
    }
    throw new ApiError(404, "Unknown GitHub endpoint");
  }

  private async handleR2(
    req: IncomingMessage,
    method: string,
    subparts: string[],
    meta: { adminChallenge?: boolean },
  ): Promise<unknown> {
    this.checkOperator(req, meta);
    if (subparts.length === 0 && method === "GET") {
      return toR2ConfigStatus(getEffectiveR2Config(this.store.dbPath));
    }
    if (method !== "POST") {
      throw new ApiError(405, "Method not allowed");
    }
    const data = await this.readJson(req);

    if (subparts.length === 0) {
      const endpoint =
        typeof data.endpoint === "string" && data.endpoint.trim()
          ? validateR2Endpoint(data.endpoint)
          : "";
      const accountId = endpoint
        ? typeof data.account_id === "string"
          ? data.account_id.trim().slice(0, 128)
          : ""
        : validateR2AccountId(field(data, "account_id", 128));
      const bucket = validateR2Bucket(field(data, "bucket", 63));
      const publicUrl = validateR2PublicUrl(field(data, "public_url", 512));
      const rawAccessKey =
        typeof data.access_key_id === "string" ? data.access_key_id.trim() : "";
      const rawSecretKey =
        typeof data.secret_access_key === "string" ? data.secret_access_key.trim() : "";
      if (rawAccessKey.length > 256 || rawSecretKey.length > 512) {
        throw new ApiError(400, "R2 凭据长度超出限制");
      }
      const existing = readStoredR2Config(this.store.dbPath);
      const accessKeyId = rawAccessKey || existing?.access_key_id || "";
      const secretAccessKey = rawSecretKey || existing?.secret_access_key || "";
      if (!accessKeyId || !secretAccessKey) {
        throw new ApiError(400, "请填写 R2 Access Key ID 和 Secret Access Key");
      }
      saveStoredR2Config(this.store.dbPath, {
        account_id: accountId,
        bucket,
        access_key_id: accessKeyId,
        secret_access_key: secretAccessKey,
        public_url: publicUrl,
        endpoint,
      });
      return toR2ConfigStatus(getEffectiveR2Config(this.store.dbPath));
    }

    if (subparts.length === 1 && subparts[0] === "disconnect") {
      deleteStoredR2Config(this.store.dbPath);
      return toR2ConfigStatus(getEffectiveR2Config(this.store.dbPath));
    }

    if (subparts.length === 1 && subparts[0] === "test") {
      return await testR2Connection(this.store.dbPath, {
        account_id: typeof data.account_id === "string" ? data.account_id.trim() : undefined,
        bucket: typeof data.bucket === "string" ? data.bucket.trim() : undefined,
        public_url: typeof data.public_url === "string" ? data.public_url.trim() : undefined,
        access_key_id:
          typeof data.access_key_id === "string" ? data.access_key_id.trim() : undefined,
        secret_access_key:
          typeof data.secret_access_key === "string" ? data.secret_access_key.trim() : undefined,
        endpoint: typeof data.endpoint === "string" ? data.endpoint.trim() : undefined,
      });
    }

    throw new ApiError(404, "Unknown R2 settings endpoint");
  }

  private async handleUtilityAi(
    req: IncomingMessage,
    method: string,
    subparts: string[],
    meta: { adminChallenge?: boolean },
  ): Promise<unknown> {
    this.checkOperator(req, meta);
    if (subparts.length === 0 && method === "GET") {
      return toUtilityAiConfigStatus(getEffectiveUtilityAiConfig(this.store.dbPath));
    }
    if (method !== "POST") {
      throw new ApiError(405, "Method not allowed");
    }
    const data = await this.readJson(req, 16 * 1024);

    if (subparts.length === 0) {
      const provider = validateUtilityAiProvider(data.provider ?? "openai");
      const endpoint = validateUtilityAiEndpoint(data.endpoint ?? "");
      const model = validateUtilityAiModel(data.model);
      const rawApiKey = validateUtilityAiKey(data.api_key ?? "");
      const existing = readStoredUtilityAiConfig(this.store.dbPath);
      const destinationChanged =
        Boolean(existing?.api_key) &&
        (provider !== existing!.provider || endpoint !== existing!.endpoint);
      const apiKey = rawApiKey || (!destinationChanged ? existing?.api_key || "" : "");
      if (!apiKey) {
        throw new ApiError(
          400,
          destinationChanged
            ? "切换协议或 API 地址时，请重新输入对应的 API Key。"
            : "请填写 API Key。",
        );
      }
      saveStoredUtilityAiConfig(this.store.dbPath, {
        provider,
        endpoint,
        api_key: apiKey,
        model,
      });
      return toUtilityAiConfigStatus(getEffectiveUtilityAiConfig(this.store.dbPath));
    }

    if (subparts.length === 1 && subparts[0] === "disconnect") {
      deleteStoredUtilityAiConfig(this.store.dbPath);
      return toUtilityAiConfigStatus(getEffectiveUtilityAiConfig(this.store.dbPath));
    }

    if (subparts.length === 1 && subparts[0] === "test") {
      return await testUtilityAiConnection(this.store.dbPath, {
        provider:
          data.provider !== undefined ? validateUtilityAiProvider(data.provider) : undefined,
        endpoint: typeof data.endpoint === "string" ? data.endpoint : undefined,
        model: typeof data.model === "string" ? data.model : undefined,
        api_key: typeof data.api_key === "string" ? data.api_key : undefined,
      });
    }

    throw new ApiError(404, "Unknown utility AI settings endpoint");
  }

  private async handleProjectRepos(
    method: string,
    projectId: string,
    action: string,
  ): Promise<unknown> {
    const projectInfo = this.store.transaction(false, () =>
      toAgentProject(this.store.getProjectRow(projectId)),
    );
    if (action === "status" && method === "GET") {
      return getProjectReposStatus(this.store.dbPath, projectInfo);
    }
    if (action === "sync" && method === "POST") {
      return await syncProjectRepos(this.store.dbPath, projectInfo);
    }
    throw new ApiError(405, "Method not allowed");
  }

  private getQueryParams(req: IncomingMessage): URLSearchParams {
    try {
      return new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    } catch {
      return new URLSearchParams();
    }
  }

  private async handleWorkspace(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    projectId: string,
    subparts: string[],
    _meta: { corsOrigin?: string },
  ): Promise<unknown> {
    const projectInfo = this.store.transaction(false, () =>
      toAgentProject(this.store.getProjectRow(projectId)),
    );
    const query = this.getQueryParams(req);

    // GET /api/projects/:id/workspace/summary
    if (subparts.length === 1 && subparts[0] === "summary" && method === "GET") {
      const clis = detectLocalClis();
      return getWorkspaceSummary(this.store.dbPath, projectInfo, {
        codex: clis.codex,
        claude: clis.claude,
      });
    }

    // GET /api/projects/:id/workspace/files
    if (subparts.length === 1 && subparts[0] === "files" && method === "GET") {
      return listWorkspaceFiles(this.store.dbPath, projectInfo.id);
    }

    // GET / HEAD / POST / DELETE /api/projects/:id/workspace/file
    if (subparts.length === 1 && subparts[0] === "file") {
      if (method === "GET" || method === "HEAD") {
        const relPath = query.get("path") ?? "";
        const isDownload = query.get("download") === "1";
        const isInline = query.get("inline") === "1";
        if (isDownload || isInline) {
          const served = openWorkspaceFileForServing(
            this.store.dbPath,
            projectInfo.id,
            relPath,
          );
          try {
            const safeFilename = served.name.replace(/["\\\r\n]/g, "_");
            const inlineMime = isInline ? getWorkspaceInlineMime(served.ext) : undefined;
            const cacheControl = inlineMime ? "private, max-age=3600" : "no-store";

            res.setHeader("ETag", served.etag);
            res.setHeader("Last-Modified", served.mtime.toUTCString());
            res.setHeader("Cache-Control", cacheControl);
            res.setHeader("Accept-Ranges", "bytes");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Referrer-Policy", "no-referrer");
            res.setHeader("X-Frame-Options", inlineMime ? "SAMEORIGIN" : "DENY");
            if (inlineMime === "image/svg+xml") {
              res.setHeader(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; sandbox",
              );
            }

            const ifNoneMatch = req.headers["if-none-match"];
            if (typeof ifNoneMatch === "string" && !req.headers.range) {
              const normalizedTarget = served.etag;
              const matches =
                ifNoneMatch.trim() === "*" ||
                ifNoneMatch
                  .split(",")
                  .some((tag) => tag.trim().replace(/^W\//i, "") === normalizedTarget);
              if (matches) {
                res.statusCode = 304;
                served.close();
                res.end();
                return undefined;
              }
            }

            res.setHeader("Content-Type", inlineMime ?? "application/octet-stream");
            res.setHeader(
              "Content-Disposition",
              inlineMime
                ? `inline; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(served.name)}`
                : `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(served.name)}`,
            );

            let start = 0;
            let end = Math.max(0, served.size - 1);
            let isPartial = false;
            const rawRange = req.headers.range;
            if (typeof rawRange === "string" && rawRange.startsWith("bytes=")) {
              const rangeSpec = rawRange.slice(6).trim();
              if (!rangeSpec.includes(",")) {
                const match = /^(\d*)-(\d*)$/.exec(rangeSpec);
                if (match && (match[1] || match[2])) {
                  if (!match[1]) {
                    const suffix = Number(match[2]);
                    if (!Number.isSafeInteger(suffix) || suffix <= 0 || served.size === 0) {
                      res.statusCode = 416;
                      res.setHeader("Content-Range", `bytes */${served.size}`);
                      served.close();
                      res.end();
                      return undefined;
                    }
                    start = Math.max(0, served.size - suffix);
                    end = served.size - 1;
                    isPartial = true;
                  } else {
                    const parsedStart = Number(match[1]);
                    const parsedEnd = match[2]
                      ? Math.min(served.size - 1, Number(match[2]))
                      : served.size - 1;
                    if (
                      !Number.isSafeInteger(parsedStart) ||
                      !Number.isSafeInteger(parsedEnd) ||
                      parsedStart < 0 ||
                      parsedStart >= served.size ||
                      parsedStart > parsedEnd
                    ) {
                      res.statusCode = 416;
                      res.setHeader("Content-Range", `bytes */${served.size}`);
                      served.close();
                      res.end();
                      return undefined;
                    }
                    start = parsedStart;
                    end = parsedEnd;
                    isPartial = true;
                  }
                }
              }
            }

            const chunkLength = served.size === 0 ? 0 : end - start + 1;
            if (isPartial) {
              res.statusCode = 206;
              res.setHeader("Content-Range", `bytes ${start}-${end}/${served.size}`);
            } else {
              res.statusCode = 200;
            }
            res.setHeader("Content-Length", String(chunkLength));

            if (method === "HEAD" || chunkLength === 0) {
              served.close();
              res.end();
              return undefined;
            }

            const stream = served.createStream(start, end);
            await new Promise<void>((resolveStream) => {
              const cleanup = () => {
                res.off("close", onClose);
                stream.destroy();
                resolveStream();
              };
              const onClose = () => {
                cleanup();
              };
              res.once("close", onClose);
              stream.on("error", () => {
                if (!res.headersSent) {
                  res.statusCode = 500;
                }
                if (!res.writableEnded) res.end();
                cleanup();
              });
              stream.on("end", () => {
                res.off("close", onClose);
                resolveStream();
              });
              stream.pipe(res);
            });
            return undefined;
          } catch (err) {
            served.close();
            throw err;
          }
        }
        if (method === "HEAD") {
          throw new ApiError(405, "Method not allowed");
        }
        return { file: readWorkspaceFile(this.store.dbPath, projectInfo.id, relPath) };
      }
      if (method === "POST") {
        const data = await this.readJson(req, 3 * 1024 * 1024);
        const relPath = typeof data.path === "string" ? data.path : "";
        if (data.type === "dir") {
          return { file: createWorkspaceDirectory(this.store.dbPath, projectInfo.id, relPath) };
        }
        const content = typeof data.content === "string" ? data.content : "";
        return { file: writeWorkspaceTextFile(this.store.dbPath, projectInfo.id, relPath, content) };
      }
      if (method === "DELETE") {
        const relPath = query.get("path") ?? "";
        return deleteWorkspaceFile(this.store.dbPath, projectInfo.id, relPath);
      }
      throw new ApiError(405, "Method not allowed");
    }

    // POST /api/projects/:id/workspace/upload
    if (subparts.length === 1 && subparts[0] === "upload" && method === "POST") {
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (contentType.includes("application/json")) {
        const data = await this.readJson(req, 28 * 1024 * 1024);
        const relPath = typeof data.path === "string" ? data.path : "";
        const encoding = data.encoding === "base64" ? "base64" : "utf8";
        const raw = typeof data.content === "string" ? data.content : "";
        const buf = Buffer.from(raw, encoding);
        return { file: uploadWorkspaceFile(this.store.dbPath, projectInfo.id, relPath, buf) };
      }
      const headerPath = req.headers["x-file-path"];
      const relPath =
        query.get("path") ||
        (typeof headerPath === "string" ? decodeURIComponent(headerPath) : "");
      const buf = await this.readBinary(req, 20 * 1024 * 1024);
      return { file: uploadWorkspaceFile(this.store.dbPath, projectInfo.id, relPath, buf) };
    }

    // GET / POST / PATCH /api/projects/:id/workspace/handbook
    if (subparts.length === 1 && subparts[0] === "handbook") {
      if (method === "GET") {
        return { handbook: readWorkspaceHandbook(this.store.dbPath, projectInfo.id) };
      }
      if (method === "POST" || method === "PATCH") {
        const data = await this.readJson(req, 128 * 1024);
        const content = typeof data.content === "string" ? data.content : "";
        return { handbook: writeWorkspaceHandbook(this.store.dbPath, projectInfo.id, content) };
      }
      throw new ApiError(405, "Method not allowed");
    }

    // GET / PUT / POST / PATCH /api/projects/:id/workspace/deploy-doc
    if (subparts.length === 1 && subparts[0] === "deploy-doc") {
      if (method === "GET") {
        return { deploy_doc: readWorkspaceDeployDoc(this.store.dbPath, projectInfo.id) };
      }
      if (method === "PUT" || method === "POST" || method === "PATCH") {
        const data = await this.readJson(req, 128 * 1024);
        const content = typeof data.content === "string" ? data.content : "";
        return { deploy_doc: writeWorkspaceDeployDoc(this.store.dbPath, projectInfo.id, content) };
      }
      throw new ApiError(405, "Method not allowed");
    }

    // GET / POST /api/projects/:id/workspace/databases
    if (subparts.length === 1 && subparts[0] === "databases") {
      if (method === "GET") {
        const refreshClients = query.get("refresh_clients") === "1";
        return {
          databases: listWorkspaceDatabases(this.store.dbPath, projectInfo.id),
          clients: detectLocalDbClients(refreshClients),
        };
      }
      if (method === "POST") {
        const data = await this.readJson(req, 256 * 1024);
        if (data.mode === "sqlite_new") {
          const database = createWorkspaceSqliteDatabase(this.store.dbPath, projectInfo.id, {
            name: typeof data.name === "string" ? data.name : "",
            init_sql: typeof data.init_sql === "string" ? data.init_sql : "",
          });
          return { database };
        }
        const database = addWorkspaceExternalDatasource(this.store.dbPath, projectInfo.id, {
          name: typeof data.name === "string" ? data.name : "",
          kind: (typeof data.kind === "string" ? data.kind : "postgres") as WorkspaceDatabaseKind,
          env_var: typeof data.env_var === "string" ? data.env_var : undefined,
          connection_url: typeof data.connection_url === "string" ? data.connection_url : "",
          read_only: data.read_only !== false,
          notes: typeof data.notes === "string" ? data.notes : "",
        });
        return { database };
      }
      throw new ApiError(405, "Method not allowed");
    }

    // PATCH / DELETE /api/projects/:id/workspace/databases/:dbId
    if (subparts.length === 2 && subparts[0] === "databases") {
      const dbId = decodeURIComponent(subparts[1]);
      if (method === "PATCH") {
        const data = await this.readJson(req, 64 * 1024);
        const database = updateWorkspaceExternalDatasource(this.store.dbPath, projectInfo.id, dbId, {
          name: typeof data.name === "string" ? data.name : undefined,
          kind: typeof data.kind === "string" ? (data.kind as WorkspaceDatabaseKind) : undefined,
          env_var: typeof data.env_var === "string" ? data.env_var : undefined,
          connection_url: typeof data.connection_url === "string" ? data.connection_url : undefined,
          clear_connection_url: data.clear_connection_url === true,
          read_only: typeof data.read_only === "boolean" ? data.read_only : undefined,
          notes: typeof data.notes === "string" ? data.notes : undefined,
        });
        return { database };
      }
      if (method === "DELETE") {
        return deleteWorkspaceDatabase(this.store.dbPath, projectInfo.id, dbId);
      }
      throw new ApiError(405, "Method not allowed");
    }

    // GET /api/projects/:id/workspace/databases/:dbId/schema
    if (
      subparts.length === 3 &&
      subparts[0] === "databases" &&
      subparts[2] === "schema" &&
      method === "GET"
    ) {
      const dbId = decodeURIComponent(subparts[1]);
      return { schema: inspectWorkspaceSqliteSchema(this.store.dbPath, projectInfo.id, dbId) };
    }

    // POST /api/projects/:id/workspace/databases/:dbId/query
    if (
      subparts.length === 3 &&
      subparts[0] === "databases" &&
      subparts[2] === "query" &&
      method === "POST"
    ) {
      const dbId = decodeURIComponent(subparts[1]);
      const data = await this.readJson(req, 32 * 1024);
      const sql = typeof data.sql === "string" ? data.sql : "";
      const limit = typeof data.limit === "number" ? data.limit : 100;
      return { result: queryWorkspaceSqlite(this.store.dbPath, projectInfo.id, dbId, sql, limit) };
    }

    // GET /api/projects/:id/workspace/repos/files
    if (
      subparts.length === 2 &&
      subparts[0] === "repos" &&
      subparts[1] === "files" &&
      method === "GET"
    ) {
      const repo = query.get("repo") || undefined;
      const subpath = query.get("path") || undefined;
      return browseProjectRepoFiles(this.store.dbPath, projectInfo, repo, subpath);
    }

    // GET /api/projects/:id/workspace/repos/file
    if (
      subparts.length === 2 &&
      subparts[0] === "repos" &&
      subparts[1] === "file" &&
      method === "GET"
    ) {
      const repo = query.get("repo") || undefined;
      const path = query.get("path") ?? "";
      const startLine = Number(query.get("start_line") ?? "1") || 1;
      const endLine = Number(query.get("end_line") ?? String(startLine + 149)) || startLine + 149;
      return {
        file: readProjectRepoFileContent(this.store.dbPath, projectInfo, {
          repo,
          path,
          start_line: startLine,
          end_line: endLine,
        }),
      };
    }

    throw new ApiError(404, "Unknown workspace endpoint");
  }

  private async handleCodexChat(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    projectId: string,
    subparts: string[],
    _meta: { corsOrigin?: string },
  ): Promise<unknown> {
    const projectInfo = this.store.transaction(false, () =>
      toAgentProject(this.store.getProjectRow(projectId)),
    );

    // GET /api/projects/:id/codex-chat/runtime
    if (subparts.length === 1 && subparts[0] === "runtime" && method === "GET") {
      const base = getChatRuntimeInfo(this.store.dbPath, projectInfo.id);
      const routing = this.store.getProjectExecutionRouting(projectInfo.id);
      const agents = this.store.listBridgeAgents().map((a) => this.describeBridgeAgent(a));
      return {
        ...base,
        routing,
        effective_priority: normalizeExecutionPriority(routing, agents),
        agents,
      };
    }

    // GET / POST /api/projects/:id/codex-chat/sessions
    if (subparts.length === 1 && subparts[0] === "sessions") {
      if (method === "GET") {
        const urlObj = new URL(req.url ?? "/", "http://127.0.0.1");
        const rawKind = urlObj.searchParams.get("kind");
        const kind: ChatSessionKind | "all" =
          rawKind === "task" || rawKind === "release" || rawKind === "all" ? rawKind : "chat";
        const sessions = this.store.transaction(false, () =>
          this.store.listChatSessions(projectInfo.id, kind).map((s) => {
            const activeRunId = this.chatRuns.getActiveRunId(s.id);
            return activeRunId ? { ...s, active_run_id: activeRunId } : s;
          }),
        );
        return { sessions };
      }
      if (method === "POST") {
        const data = await this.readJson(req, 16 * 1024);
        const runtimeInfo = getChatRuntimeInfo(this.store.dbPath, projectInfo.id);
        const selection = chatModelSelection(data);
        const runtime = selection.runtime ?? runtimeInfo.project_cli.runtime;
        const target = selection.execution_target ?? "auto";
        const routing = this.store.getProjectExecutionRouting(projectInfo.id);
        const agents = this.store.listBridgeAgents().map((a) => this.describeBridgeAgent(a));
        const activeLocalAgent = resolveActiveLocalAgent(
          {
            ...runtimeInfo,
            routing,
            effective_priority: normalizeExecutionPriority(routing, agents),
            agents,
          },
          projectInfo.id,
          target,
          runtime,
        );
        const model =
          selection.model ??
          (activeLocalAgent
            ? ""
            : resolveDefaultModelForTarget(runtime, null, runtimeInfo.project_cli));
        const sandboxMode: ChatSandboxMode =
          data.sandbox_mode === "read-only" ? "read-only" : "workspace-write";
        const networkAccess = data.network_access !== false;
        const session = this.store.transaction(true, () =>
          this.store.createChatSession(projectInfo.id, {
            ...selection,
            title: typeof data.title === "string" ? data.title : undefined,
            runtime,
            model,
            sandbox_mode: sandboxMode,
            network_access: networkAccess,
          }),
        );
        return { session };
      }
      throw new ApiError(405, "Method not allowed");
    }

    // GET / PATCH / DELETE /api/projects/:id/codex-chat/sessions/:sessionId
    if (subparts.length === 2 && subparts[0] === "sessions") {
      const sessionId = subparts[1];
      if (method === "GET") {
        return this.store.transaction(false, () => {
          const session = this.store.getChatSession(projectInfo.id, sessionId);
          const messages = this.store.listChatMessages(projectInfo.id, sessionId);
          const activeRunId = this.chatRuns.getActiveRunId(sessionId);
          return { session: activeRunId ? { ...session, active_run_id: activeRunId } : session, messages };
        });
      }
      if (method === "PATCH") {
        const data = await this.readJson(req, 16 * 1024);
        const selection = chatModelSelection(data);
        const sandbox = data.sandbox_mode === "read-only" || data.sandbox_mode === "workspace-write" ? data.sandbox_mode : undefined;
        const network = typeof data.network_access === "boolean" ? data.network_access : undefined;
        const session = this.store.transaction(true, () => {
          const current = this.store.getChatSession(projectInfo.id, sessionId);
          // Apply permission changes on a fresh invocation; resume reuses the previous sandbox.
          const permissionsChanged = (sandbox !== undefined && sandbox !== current.sandbox_mode) ||
            (network !== undefined && network !== current.network_access);
          return this.store.updateChatSession(projectInfo.id, sessionId, {
            title: typeof data.title === "string" ? data.title : undefined,
            ...selection,
            sandbox_mode: sandbox,
            network_access: network,
            ...(permissionsChanged && { external_session_id: "" }),
          });
        });
        return { session };
      }
      if (method === "DELETE") {
        const removed = this.store.transaction(true, () => this.store.deleteChatSession(projectInfo.id, sessionId));
        this.chatRuns.forceAbortSession(sessionId);
        return removed;
      }
      throw new ApiError(405, "Method not allowed");
    }

    // GET /api/projects/:id/codex-chat/sessions/:sessionId/stream
    if (
      subparts.length === 3 &&
      subparts[0] === "sessions" &&
      subparts[2] === "stream" &&
      method === "GET"
    ) {
      const sessionId = subparts[1];
      this.store.transaction(false, () => this.store.getChatSession(projectInfo.id, sessionId));
      if (!this.chatRuns.getActiveRunId(sessionId)) {
        res.statusCode = 204;
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return undefined;
      }

      let headersSent = false;
      const preflush: ChatStreamEvent[] = [];
      const writeEvent = (event: ChatStreamEvent) => {
        if (!headersSent) {
          preflush.push(event);
          return;
        }
        if (res.writableEnded || res.destroyed) return;
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      const unsubscribe = this.chatRuns.subscribe(
        sessionId,
        {
          onEvent: writeEvent,
          onClose: () => {
            if (!res.writableEnded) res.end();
          },
        },
        { replaySnapshot: true },
      );
      if (!unsubscribe) {
        res.statusCode = 204;
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return undefined;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.flushHeaders?.();
      headersSent = true;
      for (const ev of preflush) {
        writeEvent(ev);
      }
      preflush.length = 0;

      res.on("close", () => {
        unsubscribe();
      });

      await new Promise<void>((resolveStream) => {
        if (res.writableEnded || res.destroyed) {
          resolveStream();
          return;
        }
        res.once("close", resolveStream);
        res.once("finish", resolveStream);
      });
      return undefined;
    }

    // POST /api/projects/:id/codex-chat/sessions/:sessionId/abort
    if (
      subparts.length === 3 &&
      subparts[0] === "sessions" &&
      subparts[2] === "abort" &&
      method === "POST"
    ) {
      const sessionId = subparts[1];
      this.store.transaction(false, () => this.store.getChatSession(projectInfo.id, sessionId));
      const data = await this.readJson(req, 1024);
      if (!data.run_id || typeof data.run_id !== "string") throw new ApiError(400, "停止操作需要指定运行 ID");
      if (data.reason !== undefined && data.reason !== "follow_up" && data.reason !== "user_stop") {
        throw new ApiError(400, "无效的停止原因");
      }
      const aborted = this.chatRuns.abort(
        sessionId,
        data.run_id,
        data.reason === "follow_up" ? "follow_up" : "user_stop",
      );
      return { aborted };
    }

    // POST /api/projects/:id/codex-chat/sessions/:sessionId/title
    if (
      subparts.length === 3 &&
      subparts[0] === "sessions" &&
      subparts[2] === "title" &&
      method === "POST"
    ) {
      const sessionId = subparts[1];
      const { session, messages } = this.store.transaction(false, () => ({
        session: this.store.getChatSession(projectInfo.id, sessionId),
        messages: this.store.listChatMessages(projectInfo.id, sessionId),
      }));
      const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
      if (!firstUser) {
        return { session, generated: false };
      }
      const firstAssistant = messages.find((m) => m.role === "assistant" && m.content.trim());
      const aiTitle = await generateSessionTitle(this.store.dbPath, {
        projectId: projectInfo.id,
        userMessage: firstUser.content,
        assistantReply: firstAssistant?.content,
      });
      const nextTitle = aiTitle || buildFallbackSessionTitle(firstUser.content);
      const updated = this.store.transaction(true, () =>
        this.store.updateChatSession(projectInfo.id, sessionId, { title: nextTitle }),
      );
      return { session: updated, generated: Boolean(aiTitle) };
    }

    // POST /api/projects/:id/codex-chat/sessions/:sessionId/messages (SSE stream)
    if (
      subparts.length === 3 &&
      subparts[0] === "sessions" &&
      subparts[2] === "messages" &&
      method === "POST"
    ) {
      const sessionId = subparts[1];
      const data = await this.readJson(req, 64 * 1024);
      const rawContent = field(data, "content", 16_000, false);
      const rawAttachments = Array.isArray(data.attachments) ? data.attachments : [];
      const attachments: ChatContextRef[] = [];
      for (const item of rawAttachments.slice(0, 8)) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const kind = obj.kind;
        if (
          kind !== "file" &&
          kind !== "repo_file" &&
          kind !== "database" &&
          kind !== "task" &&
          kind !== "image"
        ) {
          continue;
        }
        const label = typeof obj.label === "string" ? obj.label.trim().slice(0, 120) : "";
        const ref = typeof obj.ref === "string" ? obj.ref.trim().slice(0, 300) : "";
        const repo = typeof obj.repo === "string" ? obj.repo.trim().slice(0, 120) : undefined;
        const mime =
          kind === "image" && typeof obj.mime === "string" && /^image\/[a-z0-9.+-]+$/i.test(obj.mime.trim())
            ? obj.mime.trim().slice(0, 64)
            : undefined;
        if (!ref) continue;
        attachments.push({
          kind,
          label: label || ref,
          ref,
          ...(repo ? { repo } : {}),
          ...(mime ? { mime } : {}),
        });
      }
      if (!rawContent && !attachments.some((att) => att.kind === "image")) {
        throw new ApiError(400, "请输入消息内容或附带图片");
      }
      const content = rawContent || "请查看附带的图片";

      const runId = data.run_id === undefined ? randomUUID() : data.run_id;
      if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new ApiError(400, "无效的运行 ID");

      let headersSent = false;
      const preflush: ChatStreamEvent[] = [];
      const writeEvent = (event: ChatStreamEvent) => {
        if (!headersSent) {
          preflush.push(event);
          return;
        }
        if (res.writableEnded || res.destroyed) return;
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      const started = this.chatRuns.startTurn({
        projectInfo,
        sessionId,
        content,
        attachments,
        runId,
        initialSubscriber: {
          onEvent: writeEvent,
          onClose: () => {
            if (!res.writableEnded) res.end();
          },
        },
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.flushHeaders?.();
      headersSent = true;
      for (const ev of preflush) {
        writeEvent(ev);
      }
      preflush.length = 0;

      // Client disconnect only unsubscribes from the SSE stream; the run continues on the server.
      res.on("close", () => {
        started.unsubscribe();
      });

      await new Promise<void>((resolveStream) => {
        if (res.writableEnded || res.destroyed) {
          resolveStream();
          return;
        }
        res.once("close", resolveStream);
        res.once("finish", resolveStream);
      });
      return undefined;
    }

    throw new ApiError(404, "Unknown Codex chat endpoint");
  }

  private releaseWindow(projectId: string): string {
    const policy = this.store.getProjectDeployPolicy(projectId);
    return policy.mode === "scheduled"
      ? `${policy.window_start}–${policy.window_end} (${policy.timezone})`
      : policy.mode === "manual"
        ? "由管理员安排发布"
        : "";
  }

  private widgetIdentity(projectId: string, req: IncomingMessage) {
    return {
      kind: "widget" as const,
      visitorId: widgetVisitorDigest(projectId, req.headers["x-visitor-id"]),
      canRequestDeploy: deployGateAvailable(this.store, projectId, true),
    };
  }

  private scheduleFeedback(project: RawProjectRow, taskId: string) {
    if (project.automation_paused) return;
    if (this.store.getProjectExecutionRouting(project.id).auto_dispatch_tasks)
      this.taskDispatcher.schedule(project.id);
    else this.schedulePrescreen(project, this.store.getTaskRow(taskId));
  }

  private async handleFeedback(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    parts: string[],
    meta: { corsOrigin?: string },
  ) {
    const [, projectId, entry, resource, taskId, action] = parts;
    const widget = entry === "widget-feedback";
    const authenticate = () => {
      if (widget) {
        const p = this.store.getProjectRow(projectId);
        this.checkWidgetOrigin(req, p.allowed_origins, meta);
        this.checkBearer(req, p.intake_key);
        return this.widgetIdentity(projectId, req);
      }
      const origin = req.headers.origin;
      if (
        (origin &&
          origin !== `https://${req.headers.host}` &&
          origin !== `http://${req.headers.host}`) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new ApiError(403, "请在反馈面板中执行操作。");
      const id = portalIdentity(this.store, projectId, req);
      id.canRequestDeploy &&= deployGateAvailable(this.store, projectId);
      return id;
    };
    const id = authenticate();
    const p = this.store.getProjectRow(projectId);
    const key = id.kind === "widget" ? id.visitorId : id.deviceId;
    if (method === "GET" && parts.length === 4 && resource === "config") {
      const availability = feedbackAgentAvailability(this.store, this.bridgeHub, projectId);
      return {
        project_name: p.name,
        label: id.kind === "portal" ? id.label : "本机访客",
        can_view_team: id.kind === "portal" && id.canViewTeam,
        can_request_deploy: id.canRequestDeploy,
        release_window: this.releaseWindow(projectId),
        upload_enabled: isR2ConfigComplete(
          getEffectiveR2Config(this.store.dbPath),
        ),
        ai_enabled: projectPublicAiEnabled(this.store.dbPath, p.id),
        agent_enabled: availability.enabled,
        agent_available: availability.available,
      };
    }
    if (method === "POST") {
      this.rateLimit(`${projectId}:feedback-write`, 160);
      this.rateLimit(`${projectId}:feedback:${key}`, 30);
      if (parts.length === 4 && resource === "uploads")
        return this.readAndUploadImage(req, projectId, authenticate);
    }
    const data = method === "POST" ? await this.readJson(req) : {};
    // Body streaming yields to revocations and policy changes. Reauthorize before committing.
    const actor = method === "POST" ? authenticate() : id;
    if (parts.length === 4 && resource === "diagnose" && method === "POST") {
      const availability = feedbackAgentAvailability(this.store, this.bridgeHub, projectId);
      if (!availability.enabled) {
        throw new ApiError(409, "当前项目未启用反馈诊断 Agent。");
      }
      if (!availability.available) {
        throw new ApiError(503, "反馈诊断助手当前离线，暂不接受在线诊断，请稍后再试或直接提交反馈。");
      }
      validateFeedbackDiagnosePayload(data);
      if (res.destroyed) return undefined;
      authenticate();
      const actorKey = `${projectId}:diagnose:${key}`;
      if (this.diagnosing.has(actorKey)) throw new ApiError(409, "上一条诊断消息仍在处理中。");
      this.rateLimit(`${projectId}:diagnose`, 32);
      this.rateLimit(actorKey, 12);
      if (this.assistantInFlight >= this.maxAssistantSlots) throw new ApiError(429, "反馈 Agent 正忙，请稍后再试。");
      this.assistantInFlight++;
      this.diagnosing.add(actorKey);
      const abort = new AbortController();
      const cancel = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.once("close", cancel);
      const wantsSse =
        typeof req.headers.accept === "string" &&
        req.headers.accept.toLowerCase().includes("text/event-stream");

      if (wantsSse) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        if (meta.corsOrigin) {
          res.setHeader("Access-Control-Allow-Origin", meta.corsOrigin);
          res.setHeader("Vary", "Origin");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Visitor-Id");
        }
        res.flushHeaders?.();
        const writeSse = (eventName: string, payload: unknown) => {
          if (res.writableEnded || res.destroyed) return;
          res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        try {
          const result = await diagnoseFeedback(
            this.store,
            this.bridgeHub,
            projectId,
            data,
            {
              signal: abort.signal,
              onEvent: (ev) => {
                if (ev.type === "status") writeSse("status", { label: ev.label });
                else if (ev.type === "delta") writeSse("delta", { text: ev.text });
              },
            },
          );
          const postAvailability = feedbackAgentAvailability(this.store, this.bridgeHub, projectId);
          if (!postAvailability.enabled) throw new ApiError(409, "项目反馈 Agent 已停用。");
          authenticate();
          writeSse("done", result);
        } catch (err) {
          if (!abort.signal.aborted && !res.writableEnded && !res.destroyed) {
            const status = err instanceof ApiError ? err.status : 500;
            const error = err instanceof ApiError ? err.message : "诊断过程中断，请重试或直接提交反馈。";
            writeSse("error", { status, error });
          }
        } finally {
          res.off("close", cancel);
          this.diagnosing.delete(actorKey);
          this.assistantInFlight = Math.max(0, this.assistantInFlight - 1);
          if (!res.writableEnded) res.end();
        }
        return undefined;
      }

      try {
        const result = await diagnoseFeedback(
          this.store,
          this.bridgeHub,
          projectId,
          data,
          { signal: abort.signal },
        );
        const postAvailability = feedbackAgentAvailability(this.store, this.bridgeHub, projectId);
        if (!postAvailability.enabled) throw new ApiError(409, "项目反馈 Agent 已停用。");
        authenticate();
        return result;
      } finally {
        res.off("close", cancel);
        this.diagnosing.delete(actorKey);
        this.assistantInFlight = Math.max(0, this.assistantInFlight - 1);
      }
    }
    if (parts.length === 4 && resource === "clarify" && method === "POST") {
      this.rateLimit(`${projectId}:clarify`, 20);
      if (this.assistantInFlight >= this.maxAssistantSlots)
        throw new ApiError(429, "助手繁忙，请稍后再试。");
      this.assistantInFlight++;
      try {
        const reply = await intakeReply(
          this.store.dbPath,
          projectId,
          field(data, "body", 8000),
          "",
        );
        authenticate();
        return { reply };
      } finally {
        this.assistantInFlight--;
      }
    }
    if (resource !== "tasks") throw new ApiError(404, "未知反馈操作。");
    if (parts.length === 4 && method === "GET") {
      const team =
        new URL(req.url || "/", "http://localhost").searchParams.get(
          "scope",
        ) === "team";
      return listFeedbackTickets(
        this.store,
        projectId,
        actor,
        team ? "team" : "mine",
      );
    }
    if (parts.length === 4 && method === "POST") {
      const result = createFeedbackTicket(this.store, projectId, actor, data);
      if (result.created) this.scheduleFeedback(p, result.task.id);
      return {task: result.task, messages: result.messages, gate: latestDeployGate(this.store, projectId, result.task.id)};
    }
    if (parts.length === 5 && method === "GET")
      return {
        ...getFeedbackTicket(this.store, projectId, actor, taskId),
        gate: latestDeployGate(this.store, projectId, taskId),
      };
    if (parts.length === 6 && method === "POST") {
      if (action === "reply" || action === "accept") {
        if (action === "accept" && typeof data.resolved !== "boolean")
          throw new ApiError(400, "请选择验收结果。");
        const result =
          action === "reply"
            ? replyFeedbackTicket(
                this.store,
                projectId,
                actor,
                taskId,
                field(data, "body", 8000),
              )
            : acceptFeedbackTicket(
                this.store,
                projectId,
                actor,
                taskId,
                data.resolved ? "resolved" : "still_broken",
                field(data, "body", 8000, false),
              );
        if (this.store.getTaskRow(taskId).status === "ready")
          this.taskDispatcher.schedule(projectId);
        return {...result, gate: latestDeployGate(this.store, projectId, taskId)};
      }
      if (action === "deploy-request") {
        return this.store.transaction(true, () => {
          authorizeFeedbackDeployRequest(this.store, projectId, actor, taskId);
          const gate = requestDeployGate(this.store, projectId, taskId, {
            label: actor.kind === "portal" ? actor.label : "本机访客",
            deviceId: actor.kind === "portal" ? actor.deviceId : null,
            source: actor.kind,
            reason: field(data, "reason", 500, false),
          });
          return { gate };
        });
      }
    }
    throw new ApiError(404, "未知反馈操作。");
  }

  private async handleWidgetConfig(
    req: IncomingMessage,
    projectId: string,
    meta: { corsOrigin?: string },
  ): Promise<WidgetConfigPayload> {
    const project = this.store.transaction(false, () => {
      const row = this.store.getProjectRow(projectId);
      this.checkWidgetOrigin(req, row.allowed_origins, meta);
      this.checkBearer(req, row.intake_key);
      return toAgentProject(row);
    });
    const r2Cfg = getEffectiveR2Config(this.store.dbPath);
    const aiEnabled = projectPublicAiEnabled(this.store.dbPath, project.id);
    const availability = feedbackAgentAvailability(this.store, this.bridgeHub, projectId);
    return {
      project_id: project.id,
      project_name: project.name,
      ai_enabled: aiEnabled,
      agent_enabled: availability.enabled,
      agent_available: availability.available,
      tracking_enabled:true,
      can_request_deploy:deployGateAvailable(this.store,projectId,true),
      release_window:this.releaseWindow(projectId),
      code_context_enabled: Boolean(
        aiEnabled && project.widget_code_context && project.repos.length > 0,
      ),
      upload_enabled: isR2ConfigComplete(r2Cfg),
      max_upload_bytes: MAX_UPLOAD_BYTES,
    };
  }

  private async handleWidgetUpload(
    req: IncomingMessage,
    projectId: string,
    meta: { corsOrigin?: string },
  ): Promise<unknown> {
    this.store.transaction(false, () => {
      const row = this.store.getProjectRow(projectId);
      this.checkWidgetOrigin(req, row.allowed_origins, meta);
      this.checkBearer(req, row.intake_key);
      this.rateLimit(`${row.id}:upload`, 30);
    });

    return this.readAndUploadImage(req,projectId);
  }

  private async readAndUploadImage(
    req: IncomingMessage,
    projectId: string,
    reauthorize?: () => unknown,
  ) {
    const contentType = (req.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    let image: { buffer: Buffer; mime: string };
    if (contentType === "application/json") {
      const data = await this.readJson(req, 7_600_000);
      image = parseDataUrlImage(field(data, "data_url", 7_400_000));
    } else if (contentType.startsWith("image/")) {
      image = {
        buffer: await this.readBinary(req, MAX_UPLOAD_BYTES),
        mime: contentType,
      };
    } else throw new ApiError(415, "请上传图片。");
    reauthorize?.();
    try {
      return await uploadProjectImage(
        this.store.dbPath,
        projectId,
        image.buffer,
        image.mime,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) throw err;
      throw new ApiError(
        err instanceof ApiError ? err.status : 503,
        "图片存储暂不可用，请稍后重试或直接提交文字反馈。",
      );
    }
  }

  private async handleWidgetChatStream(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    meta: { corsOrigin?: string },
  ): Promise<void> {
    const data = await this.readJson(req, 160_000);
    const project = this.store.transaction(false, () => {
      const row = this.store.getProjectRow(projectId);
      this.checkWidgetOrigin(req, row.allowed_origins, meta);
      this.checkBearer(req, row.intake_key);
      this.rateLimit(`${row.id}:chat`, 24);
      return toAgentProject(row);
    });

    const rawMessages = data.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > 30) {
      throw new ApiError(400, "messages must be a non-empty array (max 30 items)");
    }

    const messages: WidgetChatMessage[] = [];
    for (const item of rawMessages) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const role = obj.role === "assistant" ? "assistant" : obj.role === "user" ? "user" : null;
      if (!role) continue;
      const text = typeof obj.text === "string" ? obj.text.trim().slice(0, 6000) : "";
      const attachments: Array<{ url: string; name?: string }> = [];
      if (Array.isArray(obj.attachments)) {
        for (const att of obj.attachments.slice(0, 4)) {
          if (typeof att === "string" && att.trim()) {
            attachments.push({ url: att.trim().slice(0, 2000) });
          } else if (att && typeof att === "object") {
            const a = att as Record<string, unknown>;
            if (typeof a.url === "string" && a.url.trim()) {
              attachments.push({
                url: a.url.trim().slice(0, 2000),
                ...(typeof a.name === "string" ? { name: a.name.trim().slice(0, 120) } : {}),
              });
            }
          }
        }
      }
      if (!text && attachments.length === 0) continue;
      messages.push({ role, text, ...(attachments.length ? { attachments } : {}) });
    }
    if (messages.length === 0 || !messages.some((m) => m.role === "user")) {
      throw new ApiError(400, "请输入有效的对话内容");
    }

    let page: WidgetPageContext | undefined;
    if (data.page && typeof data.page === "object") {
      const p = data.page as Record<string, unknown>;
      page = {
        url: typeof p.url === "string" ? p.url.slice(0, 1000) : undefined,
        title: typeof p.title === "string" ? p.title.slice(0, 300) : undefined,
        viewport: typeof p.viewport === "string" ? p.viewport.slice(0, 60) : undefined,
        user_agent: typeof p.user_agent === "string" ? p.user_agent.slice(0, 300) : undefined,
      };
    }

    if (this.assistantInFlight >= this.maxAssistantSlots) {
      throw new ApiError(429, "AI 助手当前较忙，请稍后重试。");
    }
    this.assistantInFlight += 1;

    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (meta.corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", meta.corsOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Visitor-Id");
    }
    res.flushHeaders?.();

    const writeEvent = (event: WidgetStreamEvent) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await runWidgetAgentStream({
        dbPath: this.store.dbPath,
        project,
        messages,
        page,
        signal: abortController.signal,
        onEvent: writeEvent,
      });
    } catch (err) {
      if (!abortController.signal.aborted) {
        console.error("[widget-chat] unhandled stream error", { projectId, error: widgetStreamErrorLabel(err) });
        writeEvent({ type: "error", error: "对话处理异常，请重试或直接提单。" });
      }
    } finally {
      this.assistantInFlight = Math.max(0, this.assistantInFlight - 1);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  private async handleChat(
    req: IncomingMessage,
    parts: string[],
    data: Record<string, unknown>,
    meta: { corsOrigin?: string },
  ) {
    const body = field(data, "body", 8000);
    if (parts[0] === "tasks") {
      // Only this authenticated operator endpoint can create a shell-capable job.
      const row = this.store.getTaskRow(parts[1]);
      const config = projectCliConfiguration(this.store.dbPath, row.project_id);
      const localTarget = resolveCliRunBridgeTarget({
        store: this.store,
        bridgeHub: this.bridgeHub,
        projectId: row.project_id,
        runtime: config.runtime,
        cloudConfigured: config.configured,
      });
      if (!config.configured && !localTarget) {
        throw new ApiError(409, "请先在项目设置中配置 CLI 的 API Key，或连接并绑定可用的本机 Local Agent。");
      }
      const node = data.mode === "pr_audit" ? "pr_audit" : "operator";
      const run = this.store.enqueueCliRun(row.project_id, row.id, node, body);
      if (localTarget) {
        this.dispatchCliRunToBridge({
          projectId: row.project_id,
          runId: run.id,
          agentId: localTarget.agent.id,
          agentName: localTarget.agent.name,
          runtime: config.runtime,
          model: config.model,
          reasoningEffort: config.default_effort,
          cloudFallbackAllowed: config.configured && this.store.getProjectExecutionRouting(row.project_id).auto_fallback,
        });
      }
      return {
        queued: true,
        node,
        run,
        ...(localTarget ? { target: `local:${localTarget.agent.id}`, target_name: localTarget.agent.name } : { target: "cloud" }),
      };
    }
    const row = this.store.getProjectRow(parts[1]);
    this.checkWidgetOrigin(req, row.allowed_origins, meta);
    this.checkBearer(req, row.intake_key);
    this.rateLimit(`${row.id}:clarify`, 20);
    if (this.assistantInFlight >= this.maxAssistantSlots) throw new ApiError(429, "Assistant is busy. Try again shortly.");
    this.assistantInFlight += 1;
    try {
      return { reply: await intakeReply(this.store.dbPath, row.id, body, field(data, "expected", 8000, false)) };
    } finally {
      this.assistantInFlight -= 1;
    }
  }

  private dispatchCliRunToBridge(options: {
    projectId: string;
    runId: string;
    agentId: string;
    agentName: string;
    runtime: "codex" | "claude";
    model: string;
    reasoningEffort: ChatReasoningEffort;
    cloudFallbackAllowed: boolean;
  }): void {
    if (!this.bridgeHub) return;
    const claimed = this.store.claimCliRunById(options.projectId, options.runId);
    if (!claimed) return;
    const { run, lease, context } = claimed;
    const history = context.messages
      .slice(-15)
      .map((m) => `[${m.author} · ${m.kind}] ${m.body.slice(0, 1200)}`)
      .join("\n");
    const modeHeader =
      run.mode === "pr_audit"
        ? "你正在本机只读代码仓库中执行 Pull Request 独立审计。请结合本地代码、工单上下文与 PR 信息，输出清晰的风险点、回归检查与结论，切勿修改本地文件。"
        : "你正在本机只读代码仓库中回答运营/研发关于本工单的问题。请查阅真实代码后给出精准、带文件路径与行号依据的答复，切勿修改本地文件。";
    const promptParts = [
      modeHeader,
      `工单 #${context.task.number}：${context.task.title}`,
      context.task.body ? `工单描述：\n${context.task.body.slice(0, 4000)}` : "",
      context.task.delivery_ref ? `关联交付/PR：${context.task.delivery_ref}` : "",
      history ? `近期对话记录：\n${history}` : "",
      `本次请求：\n${run.question}`,
    ].filter(Boolean);
    const systemContext = context.project.agent_instructions.trim()
      ? `## Project Instructions\n${context.project.agent_instructions.trim().slice(0, 4000)}`
      : "";
    const manifest = buildWorkspaceManifest(this.store.dbPath, options.projectId);

    try {
      this.store.eventCliRun(options.projectId, run.id, {
        event: "progress",
        lease,
        body: `已派发至本机节点「${options.agentName}」执行…`,
      });
    } catch {
      return;
    }

    let hadProgress = false;
    void this.bridgeHub
      .runCliRun(
        options.agentId,
        {
          run_id: run.id,
          project_id: options.projectId,
          mode: run.mode,
          runtime: options.runtime,
          model: options.model || undefined,
          reasoning_effort: options.reasoningEffort,
          prompt: promptParts.join("\n\n"),
          system_context: systemContext || undefined,
          workspace_manifest: manifest,
        },
        (ev) => {
          try {
            if (ev.event === "progress") {
              hadProgress = true;
              this.store.eventCliRun(options.projectId, run.id, {
                event: "progress",
                lease,
                body: ev.body || `本机节点「${options.agentName}」处理中…`,
                ...(ev.sha ? { sha: ev.sha } : {}),
              });
            } else if (ev.event === "heartbeat") {
              this.store.eventCliRun(options.projectId, run.id, {
                event: "heartbeat",
                lease,
                body: "",
                ...(ev.sha ? { sha: ev.sha } : {}),
              });
            } else if (ev.event === "finish") {
              this.store.eventCliRun(options.projectId, run.id, {
                event: "finish",
                lease,
                body: ev.body || "已完成。",
                ...(ev.sha ? { sha: ev.sha } : {}),
              });
            } else if (ev.event === "fail") {
              if (!hadProgress && options.cloudFallbackAllowed) {
                if (this.store.requeueCliRun(options.projectId, run.id, lease)) {
                  return;
                }
              }
              this.store.eventCliRun(options.projectId, run.id, {
                event: "fail",
                lease,
                body: ev.body || "本机节点执行失败",
                ...(ev.sha ? { sha: ev.sha } : {}),
              });
            }
          } catch {
            // Lease may have already expired or completed.
          }
        },
      )
      .catch((err) => {
        if (!hadProgress && options.cloudFallbackAllowed) {
          if (this.store.requeueCliRun(options.projectId, run.id, lease)) {
            return;
          }
        }
        try {
          this.store.eventCliRun(options.projectId, run.id, {
            event: "fail",
            lease,
            body: err instanceof Error ? err.message : "派发至本机节点失败",
          });
        } catch {
          // ignore
        }
      });
  }

  private schedulePrescreen(project: RawProjectRow, task: RawTaskRow): void {
    if (project.automation_paused) return;
    if (task.merged_into || task.status !== "triage" || task.owner !== "none") return;
    if (this.prescreenInFlight >= 4) return;

    const projectInfo = toAgentProject(project);
    const taskView = toTaskView(task);
    this.prescreenInFlight += 1;

    void prescreenFeedback(this.store.dbPath, projectInfo, taskView)
      .then((result) => {
        if (!result) return;
        this.store.transaction(true, () => {
          this.store.applyServerPrescreen(task.id, result);
        });
      })
      .catch(() => {
        // Fail open so intake never fails and background errors never leak unhandled rejections.
      })
      .finally(() => {
        this.prescreenInFlight = Math.max(0, this.prescreenInFlight - 1);
      });
  }

  private handleStoreApi(
    req: IncomingMessage,
    method: string,
    parts: string[],
    data: Record<string, unknown>,
    meta: { corsOrigin?: string },
    postCommit: Array<() => void>,
  ): unknown {
    if (parts.length === 1 && parts[0] === "projects") {
      if (method === "GET") {
        return { projects: this.store.listProjects() };
      }
      if (method === "POST") {
        return { project: this.store.createProject(data) };
      }
    }

    if (parts.length >= 2 && parts[0] === "projects") {
      const projectId = parts[1];
      const project = this.store.getProjectRow(projectId);

      if (parts.length === 2) {
        if (method === "GET") {
          return { project: this.store.getProjectDetail(projectId) };
        }
        if (method === "PATCH") {
          const updated = this.store.updateProject(projectId, data);
          if (!updated.automation_paused) {
            postCommit.push(() => {
              this.taskDispatcher.schedule(projectId);
              this.releaseDispatcher.schedule(projectId);
            });
          }
          return { project: updated };
        }
      }

      if (parts.length === 3 && parts[2] === "tasks") {
        if (method === "GET") {
          return { tasks: this.store.listTasks(projectId) };
        }
        if (method === "POST") {
          const created = this.store.createTask(projectId, data, "console");
          const routing = this.store.getProjectExecutionRouting(projectId);
          if (!project.automation_paused && routing.auto_dispatch_tasks) {
            postCommit.push(() => this.taskDispatcher.schedule(projectId));
          } else if (data.skip_prescreen !== true) {
            postCommit.push(() => this.schedulePrescreen(project, created));
          }
          return { task: this.store.getTaskView(created.id) };
        }
      }

      if (parts.length === 3 && parts[2] === "intake" && method === "POST") {
        this.checkWidgetOrigin(req, project.allowed_origins, meta);
        const source = field(data, "source", 12);
        if (source !== "widget" && source !== "bot") {
          throw new ApiError(400, "Unknown feedback source");
        }
        this.checkBearer(req, source === "bot" ? project.bot_key : project.intake_key);
        this.rateLimit(`${projectId}:intake`, 120);
        if (source === 'widget' && req.headers['x-visitor-id'] !== undefined) {
          const actor = this.widgetIdentity(projectId,req);
          const images = Array.isArray(data.attachments) ? data.attachments.map(a => typeof a === 'string' ? a : a?.url) : [];
          const {task, created} = createFeedbackTicket(this.store,projectId,actor,{...data, images});
          if (created) postCommit.push(() => this.scheduleFeedback(project,task.id));
          return {task_id:task.id,number:this.store.getTaskRow(task.id).number};
        }
        // Keep legacy widget priority hints, but never let an anonymous draft bypass the release window.
        const legacyInput = source === "widget" && data.priority === "urgent" ? {...data, priority: "high"} : data;
        const created = this.store.createTask(projectId, legacyInput, source);
        const routing = this.store.getProjectExecutionRouting(projectId);
        if (!project.automation_paused && routing.auto_dispatch_tasks) {
          postCommit.push(() => this.taskDispatcher.schedule(projectId));
        } else if (source === 'widget' || data.skip_prescreen !== true) {
          postCommit.push(() => this.schedulePrescreen(project, created));
        }
        return { task_id: created.id, number: created.number };
      }

      if (parts[2] === "agent") {
        this.checkBearer(req, project.agent_key);
        const agentParts = parts.slice(3);
        if (method === "GET" && agentParts.length === 1 && agentParts[0] === "project") {
          return { project: toAgentProject(project) };
        }
        if (method === "GET" && agentParts.length === 1 && agentParts[0] === "queue") {
          return this.store.getAgentQueue(project);
        }
        if (method === "GET" && agentParts.length === 2 && agentParts[1] === "thread") {
          const taskRow = this.store.getTaskRow(agentParts[0]);
          if (taskRow.project_id !== project.id) {
            throw new ApiError(404, "Task not found");
          }
          return {
            task_id: taskRow.id,
            number: taskRow.number,
            messages: this.store.getTaskMessages(taskRow.id),
          };
        }
        if (method === "POST") {
          const agentRes = this.store.agentCall(project, agentParts, data);
          if (agentParts.length === 2 && agentParts[1] === "finish" && data.complete === true) {
            postCommit.push(() => this.releaseDispatcher.schedule(projectId));
          }
          return agentRes;
        }
      }
    }

    if (parts.length >= 2 && parts[0] === "tasks") {
      const taskRow = this.store.getTaskRow(parts[1]);
      if (parts.length === 2 && method === "GET") {
        return {
          task: this.store.getTaskView(taskRow.id),
          messages: this.store.getTaskMessages(taskRow.id),
          merged: this.store.getMergedTasks(taskRow.id),
        };
      }
      if (parts.length === 3 && parts[2] === "messages" && method === "POST") {
        const res = this.store.operatorAddComment(
          taskRow.id,
          field(data, "body", 12000),
          data.public_question ? false : data.reopen !== false,
        );
        if (data.public_question) {
          addPublicFeedbackQuestion(this.store, taskRow.project_id, taskRow.id, data.public_question, 'human');
        } else if (res.task.owner === "none" && (res.task.status === "ready" || res.task.status === "triage")) {
          postCommit.push(() => this.taskDispatcher.schedule(taskRow.project_id));
        }
        return { ...res, task: this.store.getTaskView(taskRow.id) };
      }
      if (parts.length === 3 && parts[2] === "action" && method === "POST") {
        const res = this.store.operatorAction(taskRow.id, data);
        if (res.task.owner === "none" && (res.task.status === "ready" || res.task.status === "triage")) {
          postCommit.push(() => this.taskDispatcher.schedule(taskRow.project_id));
        }
        return { task: this.store.getTaskView(taskRow.id) };
      }
    }

    throw new ApiError(404, "Unknown API endpoint");
  }
}
