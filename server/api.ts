import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.ts";
import {
  Store,
  field,
  safeEqual,
  toAgentProject,
  toProjectView,
  toTaskView,
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
  deleteStoredAiConfig,
  getEffectiveAiConfig,
  isLoopbackHost,
  readStoredAiConfig,
  saveStoredAiConfig,
  toAiConfigStatus,
  validateAiBaseUrl,
} from "./ai-config.ts";
import { intakeReply, operatorReply, testAiConnection } from "./assistant.ts";
import type { AuthMode, AuthStatusPayload, GithubOwnerInfo } from "../app/lib/types.ts";

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

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new ApiError(415, "Send application/json");
    }
    const contentLengthHeader = req.headers["content-length"];
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isNaN(declared) || declared < 0 || declared > 160_000) {
        throw new ApiError(413, "Request too large");
      }
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > 160_000) {
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
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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

      const isPublicPath =
        parts.length === 3 &&
        parts[0] === "projects" &&
        (parts[2] === "intake" || parts[2] === "clarify");
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

      const isWrite = method === "POST" || method === "PATCH";
      const data = isWrite ? await this.readJson(req) : {};

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

      const result = this.store.transaction(isWrite, () =>
        this.handleStoreApi(req, method, parts, data, meta),
      );
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
      const nextKey = clearApiKey ? "" : rawKey || existing?.api_key || "";
      saveStoredAiConfig(this.store.dbPath, {
        base_url: baseUrl,
        model,
        api_key: nextKey,
        intake_enabled: intakeEnabled,
      });
      return toAiConfigStatus(getEffectiveAiConfig(this.store.dbPath));
    }

    if (subparts.length === 1 && subparts[0] === "disconnect") {
      deleteStoredAiConfig(this.store.dbPath);
      return toAiConfigStatus(getEffectiveAiConfig(this.store.dbPath));
    }

    if (subparts.length === 1 && subparts[0] === "test") {
      const baseUrl = typeof data.base_url === "string" ? data.base_url.trim() : undefined;
      const model = typeof data.model === "string" ? data.model.trim() : undefined;
      const apiKey = typeof data.api_key === "string" ? data.api_key.trim() : undefined;
      return await testAiConnection(this.store.dbPath, {
        base_url: baseUrl,
        model,
        api_key: apiKey,
      });
    }

    throw new ApiError(404, "Unknown AI settings endpoint");
  }

  private async handleChat(
    req: IncomingMessage,
    parts: string[],
    data: Record<string, unknown>,
    meta: { corsOrigin?: string },
  ): Promise<{ reply: string }> {
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
      const reply = await operatorReply(
        this.store.dbPath,
        project!,
        task!,
        messages,
        body,
      );
      this.store.transaction(true, () => {
        this.store.addMessage(task!.id, "comment", "human", body);
        this.store.addMessage(task!.id, "comment", "assistant", reply);
      });
      return { reply };
    } finally {
      this.assistantInFlight -= 1;
    }
  }

  private handleStoreApi(
    req: IncomingMessage,
    method: string,
    parts: string[],
    data: Record<string, unknown>,
    meta: { corsOrigin?: string },
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
          return { task: toTaskView(this.store.createTask(projectId, data, "console")) };
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
        return { task_id: created.id, number: created.number };
      }

      if (parts[2] === "agent") {
        this.checkBearer(req, project.agent_key);
        const agentParts = parts.slice(3);
        if (method === "GET" && agentParts.length === 1 && agentParts[0] === "project") {
          return { project: toAgentProject(project) };
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
        return {
          message: this.store.addMessage(
            taskRow.id,
            "comment",
            "human",
            field(data, "body", 12000),
          ),
        };
      }
      if (parts.length === 3 && parts[2] === "action" && method === "POST") {
        return this.store.operatorAction(taskRow.id, data);
      }
    }

    throw new ApiError(404, "Unknown API endpoint");
  }
}
