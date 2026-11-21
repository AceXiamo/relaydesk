import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.ts";
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
import {
  deleteAiProfile,
  deleteStoredAiConfig,
  getEffectiveAiConfig,
  isAiNodeId,
  isLoopbackHost,
  readStoredAiConfig,
  resolveAiConfigForNode,
  selectActiveAiProfile,
  toAiConfigStatus,
  updateAiNodeRoutes,
  upsertAiProfile,
  validateAiBaseUrl,
} from "./ai-config.ts";
import {
  intakeReply,
  operatorDiscuss,
  prescreenFeedback,
  testAiConnection,
} from "./assistant.ts";
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
import { getProjectReposStatus, syncProjectRepos } from "./repo-workspace.ts";
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
  GithubOwnerInfo,
  WidgetConfigPayload,
} from "../app/lib/types.ts";

export interface ApiContextOptions {
  store: Store;
  adminToken?: string;
  wallet?: WalletAuth | null;
  bindHost?: string;
}

export class ApiRouter {
  readonly store: Store;
  readonly adminToken: string;
  readonly wallet: WalletAuth | null;
  readonly bindHost: string;
  private traffic = new Map<string, number[]>();
  private assistantInFlight = 0;
  private prescreenInFlight = 0;
  private readonly maxAssistantSlots = 4;

  constructor(options: ApiContextOptions) {
    this.store = options.store;
    this.adminToken = options.adminToken ?? "";
    this.wallet = options.wallet ?? null;
    this.bindHost = options.bindHost ?? "127.0.0.1";
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
    const contentLengthHeader = req.headers["content-length"];
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isNaN(declared) || declared < 0 || declared > maxBytes) {
        throw new ApiError(413, "文件体积超出限制（最大 5 MB）");
      }
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        throw new ApiError(413, "文件体积超出限制（最大 5 MB）");
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
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
      if (!["GET", "POST", "PATCH", "OPTIONS", "HEAD"].includes(method)) {
        throw new ApiError(405, "Method not allowed");
      }

      const rawSubpath = pathname.slice("/api/".length).replace(/^\/+|\/+$/g, "");
      const parts = rawSubpath ? rawSubpath.split("/") : [];

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

      if (parts[0] === "ai") {
        const result = await this.handleAi(req, method, parts.slice(1), meta);
        this.sendJson(req, res, 200, result, meta);
        return;
      }

      if (parts[0] === "r2") {
        const result = await this.handleR2(req, method, parts.slice(1), meta);
        this.sendJson(req, res, 200, result, meta);
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

      // Public widget bootstrap config
      if (
        method === "GET" &&
        parts.length === 3 &&
        parts[0] === "projects" &&
        parts[2] === "widget-config"
      ) {
        const result = this.handleWidgetConfig(req, parts[1], meta);
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
        this.sendJson(req, res, 200, result, meta);
        return;
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
        this.sendJson(req, res, err.status, { error: err.message }, meta);
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

  private async handleAi(
    req: IncomingMessage,
    method: string,
    subparts: string[],
    meta: { adminChallenge?: boolean },
  ): Promise<unknown> {
    this.checkOperator(req, meta);
    if (subparts.length === 0 && method === "GET") {
      return toAiConfigStatus(getEffectiveAiConfig(this.store.dbPath));
    }
    if (method !== "POST") {
      throw new ApiError(405, "Method not allowed");
    }
    const data = await this.readJson(req);

    if (subparts.length === 0) {
      const baseUrl = validateAiBaseUrl(field(data, "base_url", 512));
      const model = field(data, "model", 160);
      const rawKey = typeof data.api_key === "string" ? data.api_key.trim() : "";
      if (rawKey.length > 512) {
        throw new ApiError(400, "API Key 过长");
      }
      const clearApiKey = data.clear_api_key === true;
      const intakeEnabled = Boolean(data.intake_enabled);
      const existing = readStoredAiConfig(this.store.dbPath);
      const targetId =
        typeof data.id === "string" && data.id.trim()
          ? data.id.trim()
          : existing?.active_profile_id || undefined;
      const name = typeof data.name === "string" ? data.name.trim() : undefined;
      upsertAiProfile(this.store.dbPath, {
        id: targetId,
        name,
        base_url: baseUrl,
        model,
        api_key: rawKey,
        clear_api_key: clearApiKey,
        set_active: true,
        intake_enabled: intakeEnabled,
      });
      if (data.node_routes && typeof data.node_routes === "object") {
        updateAiNodeRoutes(this.store.dbPath, {
          intake_enabled: intakeEnabled,
          node_routes: data.node_routes as Record<string, { profile_id?: string; model?: string }>,
        });
      }
      return toAiConfigStatus(getEffectiveAiConfig(this.store.dbPath));
    }

    if (subparts.length === 1 && subparts[0] === "profiles") {
      const baseUrl = validateAiBaseUrl(field(data, "base_url", 512));
      const model = field(data, "model", 160);
      const rawKey = typeof data.api_key === "string" ? data.api_key.trim() : "";
      if (rawKey.length > 512) {
        throw new ApiError(400, "API Key 过长");
      }
      upsertAiProfile(this.store.dbPath, {
        id: typeof data.id === "string" ? data.id.trim() : undefined,
        name: typeof data.name === "string" ? data.name.trim() : undefined,
        base_url: baseUrl,
        model,
        api_key: rawKey,
        clear_api_key: data.clear_api_key === true,
        set_active: data.set_active === true,
        intake_enabled:
          typeof data.intake_enabled === "boolean" ? data.intake_enabled : undefined,
      });
      return toAiConfigStatus(getEffectiveAiConfig(this.store.dbPath));
    }

    if (subparts.length === 2 && subparts[0] === "profiles" && subparts[1] === "select") {
      const profileId = field(data, "profile_id", 64);
      selectActiveAiProfile(this.store.dbPath, profileId);
      return toAiConfigStatus(getEffectiveAiConfig(this.store.dbPath));
    }

    if (subparts.length === 2 && subparts[0] === "profiles" && subparts[1] === "delete") {
      const profileId = field(data, "profile_id", 64);
      deleteAiProfile(this.store.dbPath, profileId);
      return toAiConfigStatus(getEffectiveAiConfig(this.store.dbPath));
    }

    if (subparts.length === 1 && subparts[0] === "routes") {
      updateAiNodeRoutes(this.store.dbPath, {
        intake_enabled:
          typeof data.intake_enabled === "boolean" ? data.intake_enabled : undefined,
        node_routes:
          data.node_routes && typeof data.node_routes === "object"
            ? (data.node_routes as Record<string, { profile_id?: string; model?: string }>)
            : undefined,
      });
      return toAiConfigStatus(getEffectiveAiConfig(this.store.dbPath));
    }

    if (subparts.length === 1 && subparts[0] === "disconnect") {
      deleteStoredAiConfig(this.store.dbPath);
      return toAiConfigStatus(getEffectiveAiConfig(this.store.dbPath));
    }

    if (subparts.length === 1 && subparts[0] === "test") {
      const profileId =
        typeof data.profile_id === "string" ? data.profile_id.trim() : undefined;
      const node = isAiNodeId(data.node) ? data.node : undefined;
      const baseUrl = typeof data.base_url === "string" ? data.base_url.trim() : undefined;
      const model = typeof data.model === "string" ? data.model.trim() : undefined;
      const apiKey = typeof data.api_key === "string" ? data.api_key.trim() : undefined;
      return await testAiConnection(this.store.dbPath, {
        profile_id: profileId,
        node,
        base_url: baseUrl,
        model,
        api_key: apiKey,
      });
    }

    throw new ApiError(404, "Unknown AI settings endpoint");
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

  private handleWidgetConfig(
    req: IncomingMessage,
    projectId: string,
    meta: { corsOrigin?: string },
  ): WidgetConfigPayload {
    const project = this.store.transaction(false, () => {
      const row = this.store.getProjectRow(projectId);
      this.checkWidgetOrigin(req, row.allowed_origins, meta);
      this.checkBearer(req, row.intake_key);
      return toAgentProject(row);
    });
    const aiCfg = resolveAiConfigForNode(this.store.dbPath, "widget");
    const r2Cfg = getEffectiveR2Config(this.store.dbPath);
    const aiEnabled = Boolean(aiCfg.intake_enabled && aiCfg.base_url && aiCfg.model);
    return {
      project_id: project.id,
      project_name: project.name,
      ai_enabled: aiEnabled,
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

    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType === "application/json") {
      const data = await this.readJson(req, 7_600_000);
      const dataUrl = field(data, "data_url", 7_400_000);
      const { buffer, mime } = parseDataUrlImage(dataUrl);
      return await uploadProjectImage(this.store.dbPath, projectId, buffer, mime);
    }
    if (contentType.startsWith("image/")) {
      const buffer = await this.readBinary(req, MAX_UPLOAD_BYTES);
      return await uploadProjectImage(this.store.dbPath, projectId, buffer, contentType);
    }
    throw new ApiError(415, "Send image/* binary or application/json with data_url");
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
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
  ): Promise<{
    reply: string;
    model?: string;
    profile_name?: string;
    node?: string;
    used_llm?: boolean;
  }> {
    const body = field(data, "body", 8000);
    const clarify = parts[0] === "projects";

    let task: ReturnType<typeof toTaskView> | undefined;
    let project: ReturnType<typeof toAgentProject> | undefined;
    let messages: ReturnType<Store["getTaskMessages"]> = [];

    this.store.transaction(false, () => {
      if (clarify) {
        const row = this.store.getProjectRow(parts[1]);
        this.checkWidgetOrigin(req, row.allowed_origins, meta);
        this.checkBearer(req, row.intake_key);
        this.rateLimit(`${row.id}:clarify`, 20);
      } else {
        const taskRow = this.store.getTaskRow(parts[1]);
        task = toTaskView(taskRow);
        project = toAgentProject(this.store.getProjectRow(task.project_id));
        messages = this.store.getTaskMessages(task.id, 30);
      }
    });

    if (this.assistantInFlight >= this.maxAssistantSlots) {
      throw new ApiError(429, "Assistant is busy. Try again shortly.");
    }
    this.assistantInFlight += 1;
    try {
      if (clarify) {
        const expected = field(data, "expected", 8000, false);
        const reply = await intakeReply(this.store.dbPath, body, expected);
        return { reply };
      }
      const profileId =
        typeof data.profile_id === "string" && data.profile_id.trim()
          ? data.profile_id.trim()
          : undefined;
      const modelOverride =
        typeof data.model === "string" && data.model.trim()
          ? data.model.trim().slice(0, 160)
          : undefined;
      const mode = data.mode === "pr_audit" ? "pr_audit" : "operator";
      const result = await operatorDiscuss(
        this.store.dbPath,
        project!,
        task!,
        messages,
        body,
        {
          profile_id: profileId,
          model: modelOverride,
          mode,
        },
      );
      this.store.transaction(true, () => {
        this.store.addMessage(task!.id, "comment", "human", body);
        this.store.addMessage(task!.id, "comment", "assistant", result.reply);
      });
      return result;
    } finally {
      this.assistantInFlight -= 1;
    }
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
          return { project: toProjectView(project) };
        }
        if (method === "PATCH") {
          return { project: this.store.updateProject(projectId, data) };
        }
      }

      if (parts.length === 3 && parts[2] === "tasks") {
        if (method === "GET") {
          return { tasks: this.store.listTasks(projectId) };
        }
        if (method === "POST") {
          const created = this.store.createTask(projectId, data, "console");
          if (data.skip_prescreen !== true) {
            postCommit.push(() => this.schedulePrescreen(project, created));
          }
          return { task: toTaskView(created) };
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
        const created = this.store.createTask(projectId, data, source);
        if (data.skip_prescreen !== true) {
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
          return this.store.agentCall(project, agentParts, data);
        }
      }
    }

    if (parts.length >= 2 && parts[0] === "tasks") {
      const taskRow = this.store.getTaskRow(parts[1]);
      if (parts.length === 2 && method === "GET") {
        return {
          task: toTaskView(taskRow),
          messages: this.store.getTaskMessages(taskRow.id),
          merged: this.store.getMergedTasks(taskRow.id),
        };
      }
      if (parts.length === 3 && parts[2] === "messages" && method === "POST") {
        return this.store.operatorAddComment(
          taskRow.id,
          field(data, "body", 12000),
          data.reopen !== false,
        );
      }
      if (parts.length === 3 && parts[2] === "action" && method === "POST") {
        return this.store.operatorAction(taskRow.id, data);
      }
    }

    throw new ApiError(404, "Unknown API endpoint");
  }
}
