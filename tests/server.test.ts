import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { privateKeyToAccount } from "viem/accounts";
import { startRelaydeskServer, type RunningRelaydeskServer } from "../server.ts";
import { Store } from "../server/store.ts";
import { WalletAuth } from "../server/wallet.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function makeTempDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "relaydesk-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath: join(dir, "relaydesk.sqlite3") };
}

async function startApiServer(
  opts: Partial<Parameters<typeof startRelaydeskServer>[0]> = {},
): Promise<RunningRelaydeskServer> {
  const { dbPath } = makeTempDb();
  const running = await startRelaydeskServer({
    host: "127.0.0.1",
    port: 0,
    dbPath,
    apiOnly: true,
    ...opts,
  });
  cleanups.push(() => running.close());
  return running;
}

async function jsonReq(
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return { status: res.status, headers: res.headers, json };
}

describe("Relaydesk Core Queue & Agent API", () => {
  it("creates projects, manages tasks, priorities, merges, and agent leases", async () => {
    const srv = await startApiServer();

    const pRes = await jsonReq(`${srv.url}/api/projects`, "POST", {
      name: "Demo App",
      repo: "https://github.com/acexiamo/demo-app.git",
      allowed_origins: ["https://demo.example.com"],
    });
    expect(pRes.status).toBe(200);
    const project = pRes.json.project as Record<string, unknown>;
    expect(project.repo).toBe("acexiamo/demo-app");

    // Widget intake with allowed origin & intake_key
    const intakeRes = await jsonReq(
      `${srv.url}/api/projects/${project.id}/intake`,
      "POST",
      {
        source: "widget",
        title: "导出 CSV 缺表头",
        body: "点击导出按钮后首行丢失",
        external_id: "ext-1",
        source_url: "https://demo.example.com/reports",
      },
      {
        Origin: "https://demo.example.com",
        Authorization: `Bearer ${project.intake_key}`,
      },
    );
    expect(intakeRes.status).toBe(200);
    expect(intakeRes.json.number).toBe(1);
    const taskId = intakeRes.json.task_id as string;

    // Duplicate external_id is idempotent
    const dupRes = await jsonReq(
      `${srv.url}/api/projects/${project.id}/intake`,
      "POST",
      {
        source: "widget",
        body: "重复提交",
        external_id: "ext-1",
      },
      {
        Origin: "https://demo.example.com",
        Authorization: `Bearer ${project.intake_key}`,
      },
    );
    expect(dupRes.status).toBe(200);
    expect(dupRes.json.task_id).toBe(taskId);

    // Disallowed origin rejected
    const badOrigin = await jsonReq(
      `${srv.url}/api/projects/${project.id}/intake`,
      "POST",
      { source: "widget", body: "bad" },
      {
        Origin: "https://evil.example.com",
        Authorization: `Bearer ${project.intake_key}`,
      },
    );
    expect(badOrigin.status).toBe(403);

    // Operator updates priority and sets status to ready
    let detail = await jsonReq(`${srv.url}/api/tasks/${taskId}`);
    let version = (detail.json.task as Record<string, number>).version;

    const priRes = await jsonReq(`${srv.url}/api/tasks/${taskId}/action`, "POST", {
      action: "priority",
      priority: "urgent",
      version,
    });
    expect(priRes.status).toBe(200);
    expect((priRes.json.task as Record<string, unknown>).priority).toBe("urgent");
    version = (priRes.json.task as Record<string, number>).version;

    const readyRes = await jsonReq(`${srv.url}/api/tasks/${taskId}/action`, "POST", {
      action: "status",
      status: "ready",
      version,
    });
    expect(readyRes.status).toBe(200);

    // Local agent claims the urgent ready task
    const claimRes = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/claim`,
      "POST",
      {},
      { Authorization: `Bearer ${project.agent_key}` },
    );
    expect(claimRes.status).toBe(200);
    const lease = claimRes.json.lease as string;
    const claimedTask = claimRes.json.task as Record<string, unknown>;
    expect(claimedTask.id).toBe(taskId);
    expect(claimedTask.owner).toBe("agent");
    expect(claimedTask.status).toBe("working");

    // Operator requests takeover -> handoff -> force_takeover revokes lease
    const takeover = await jsonReq(`${srv.url}/api/tasks/${taskId}/action`, "POST", {
      action: "takeover",
      version: claimedTask.version,
    });
    expect(takeover.status).toBe(200);
    expect((takeover.json.task as Record<string, unknown>).status).toBe("handoff");

    const forced = await jsonReq(`${srv.url}/api/tasks/${taskId}/action`, "POST", {
      action: "force_takeover",
      version: (takeover.json.task as Record<string, number>).version,
    });
    expect(forced.status).toBe(200);
    expect((forced.json.task as Record<string, unknown>).owner).toBe("human");

    // Stale agent lease is fenced
    const staleBeat = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${taskId}/heartbeat`,
      "POST",
      { lease },
      { Authorization: `Bearer ${project.agent_key}` },
    );
    expect(staleBeat.status).toBe(409);

    // Task list includes counts
    const listRes = await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`);
    expect(listRes.status).toBe(200);
    const list = listRes.json.tasks as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(typeof list[0].message_count).toBe("number");
  });
});

describe("Workspace LLM API Key Configuration & Assistant Chat", () => {
  it("saves, masks, tests, and uses workspace LLM config with OpenAI-compatible mock", async () => {
    // Spin up a local loopback mock OpenAI Chat Completions server
    let receivedAuth = "";
    let receivedModel = "";
    const mockAi = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedAuth = req.headers.authorization ?? "";
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          model: string;
        };
        receivedModel = body.model;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "MOCK_LLM_REPLY_OK" } }],
          }),
        );
      });
    });
    await new Promise<void>((r) => mockAi.listen(0, "127.0.0.1", r));
    cleanups.push(
      () => new Promise<void>((r) => mockAi.close(() => r())),
    );
    const mockPort = (mockAi.address() as { port: number }).port;
    const mockBaseUrl = `http://127.0.0.1:${mockPort}/v1`;

    const { dir, dbPath } = makeTempDb();
    const srv = await startApiServer({ dbPath });

    // Initially unconfigured
    const initial = await jsonReq(`${srv.url}/api/ai`);
    expect(initial.status).toBe(200);
    expect(initial.json.configured).toBe(false);
    expect(initial.json.has_api_key).toBe(false);

    // Rejects non-HTTPS remote URL
    const badUrl = await jsonReq(`${srv.url}/api/ai`, "POST", {
      base_url: "http://api.openai.com/v1",
      model: "gpt-4o-mini",
      api_key: "sk-test-1234567890",
      intake_enabled: false,
    });
    expect(badUrl.status).toBe(400);

    // Save valid loopback LLM config with API key
    const saved = await jsonReq(`${srv.url}/api/ai`, "POST", {
      base_url: mockBaseUrl,
      model: "gpt-4o-mini",
      api_key: "sk-secret-9876543210",
      intake_enabled: true,
    });
    expect(saved.status).toBe(200);
    expect(saved.json.configured).toBe(true);
    expect(saved.json.source).toBe("workspace");
    expect(saved.json.has_api_key).toBe(true);
    expect(saved.json.api_key_preview).toBe("sk-s••••3210");
    expect(JSON.stringify(saved.json)).not.toContain("sk-secret-9876543210");

    // Verify 0600 file permissions
    const mode = statSync(join(dir, ".ai-config.json")).mode & 0o777;
    expect(mode).toBe(0o600);

    // Update model without re-sending API key -> preserves saved key
    const updated = await jsonReq(`${srv.url}/api/ai`, "POST", {
      base_url: mockBaseUrl,
      model: "deepseek-chat",
      intake_enabled: true,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.model).toBe("deepseek-chat");
    expect(updated.json.has_api_key).toBe(true);

    // Test connection endpoint hits mock server with stored key
    const testRes = await jsonReq(`${srv.url}/api/ai/test`, "POST", {});
    expect(testRes.status).toBe(200);
    expect(testRes.json.ok).toBe(true);
    expect(testRes.json.reply_preview).toContain("MOCK_LLM_REPLY_OK");
    expect(receivedAuth).toBe("Bearer sk-secret-9876543210");
    expect(receivedModel).toBe("deepseek-chat");

    // Operator discuss uses configured LLM and persists reply
    const pRes = await jsonReq(`${srv.url}/api/projects`, "POST", {
      name: "AI Project",
      repo: "acexiamo/ai-proj",
    });
    const projId = (pRes.json.project as Record<string, string>).id;
    const tRes = await jsonReq(`${srv.url}/api/projects/${projId}/tasks`, "POST", {
      title: "测试 AI 讨论",
      body: "页面切换慢",
      priority: "high",
    });
    const taskId = (tRes.json.task as Record<string, string>).id;

    const discuss = await jsonReq(`${srv.url}/api/tasks/${taskId}/discuss`, "POST", {
      body: "帮我总结验收条件",
    });
    expect(discuss.status).toBe(200);
    expect(discuss.json.reply).toBe("MOCK_LLM_REPLY_OK");

    // Clear workspace AI config
    const cleared = await jsonReq(`${srv.url}/api/ai/disconnect`, "POST", {});
    expect(cleared.status).toBe(200);
    expect(cleared.json.configured).toBe(false);
    expect(cleared.json.has_api_key).toBe(false);
  });

  it("supports multiple model profiles, switching defaults, independent node routes, PR audit override, and max_completion_tokens", async () => {
    const captured: Array<{
      path: string;
      auth: string;
      model: string;
      hasMaxTokens: boolean;
      hasMaxCompletionTokens: boolean;
    }> = [];

    const multiMock = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        const model = String(parsed.model ?? "");
        captured.push({
          path: req.url ?? "",
          auth: String(req.headers.authorization ?? ""),
          model,
          hasMaxTokens: "max_tokens" in parsed,
          hasMaxCompletionTokens: "max_completion_tokens" in parsed,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: `REPLY_FROM_${model}` } }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => multiMock.listen(0, "127.0.0.1", resolve));
    const port = (multiMock.address() as { port: number }).port;
    const baseDeepseek = `http://127.0.0.1:${port}/deepseek/v1`;
    const baseOpenai = `http://127.0.0.1:${port}/openai/v1`;

    try {
      const { dbPath } = makeTempDb();
      const srv = await startApiServer({ dbPath });

      // 1. Add first profile (DeepSeek) -> auto active
      const add1 = await jsonReq(`${srv.url}/api/ai/profiles`, "POST", {
        name: "DeepSeek 日常",
        base_url: baseDeepseek,
        model: "deepseek-chat",
        api_key: "test-key-deepseek-1111",
        intake_enabled: true,
      });
      expect(add1.status).toBe(200);
      const profiles1 = add1.json.profiles as Array<Record<string, unknown>>;
      expect(profiles1).toHaveLength(1);
      const dsId = String(profiles1[0]!.id);
      expect(add1.json.active_profile_id).toBe(dsId);
      expect(add1.json.model).toBe("deepseek-chat");

      // 2. Add second profile (OpenAI Official Pro credits) without switching default yet
      const add2 = await jsonReq(`${srv.url}/api/ai/profiles`, "POST", {
        name: "OpenAI 官方",
        base_url: baseOpenai,
        model: "gpt-5.4",
        api_key: "test-key-openai-2222",
        set_active: false,
      });
      expect(add2.status).toBe(200);
      const profiles2 = add2.json.profiles as Array<Record<string, unknown>>;
      expect(profiles2).toHaveLength(2);
      const oaiId = String(profiles2.find((p) => p.name === "OpenAI 官方")!.id);
      expect(add2.json.active_profile_id).toBe(dsId);

      // 3. Configure per-node routes: PR audit uses OpenAI Official with independent model name override
      const routesRes = await jsonReq(`${srv.url}/api/ai/routes`, "POST", {
        intake_enabled: true,
        node_routes: {
          prescreen: { profile_id: dsId, model: "" },
          widget: { profile_id: dsId, model: "" },
          operator: { profile_id: "", model: "" },
          pr_audit: { profile_id: oaiId, model: "gpt-6.2-astra" },
        },
      });
      expect(routesRes.status).toBe(200);
      const resolvedNodes = routesRes.json.resolved_nodes as Record<
        string,
        Record<string, unknown>
      >;
      expect(resolvedNodes.pr_audit.profile_id).toBe(oaiId);
      expect(resolvedNodes.pr_audit.model).toBe("gpt-6.2-astra");
      expect(resolvedNodes.pr_audit.overrides_model).toBe(true);
      expect(resolvedNodes.operator.model).toBe("deepseek-chat");

      // 4. Create project & task and verify discuss routing
      const pRes = await jsonReq(`${srv.url}/api/projects`, "POST", {
        name: "Multi Model Project",
        repo: "acexiamo/multi-proj",
      });
      const projId = (pRes.json.project as Record<string, string>).id;
      const tRes = await jsonReq(`${srv.url}/api/projects/${projId}/tasks`, "POST", {
        title: "检查 PR 改动",
        body: "测试多模型与审计节点",
        priority: "high",
        skip_prescreen: true,
      });
      const taskId = (tRes.json.task as Record<string, string>).id;

      // 4a. Default operator chat uses active DeepSeek profile (max_tokens)
      const d1 = await jsonReq(`${srv.url}/api/tasks/${taskId}/discuss`, "POST", {
        body: "先看下需求",
      });
      expect(d1.status).toBe(200);
      expect(d1.json.reply).toBe("REPLY_FROM_deepseek-chat");
      expect(captured[captured.length - 1]).toMatchObject({
        path: "/deepseek/v1/chat/completions",
        auth: "Bearer test-key-deepseek-1111",
        model: "deepseek-chat",
        hasMaxTokens: true,
        hasMaxCompletionTokens: false,
      });

      // 4b. Mid-conversation switch to OpenAI profile -> uses gpt-5.4 & max_completion_tokens
      const d2 = await jsonReq(`${srv.url}/api/tasks/${taskId}/discuss`, "POST", {
        body: "用 GPT 分析下架构方案",
        profile_id: oaiId,
      });
      expect(d2.status).toBe(200);
      expect(d2.json.reply).toBe("REPLY_FROM_gpt-5.4");
      expect(captured[captured.length - 1]).toMatchObject({
        path: "/openai/v1/chat/completions",
        auth: "Bearer test-key-openai-2222",
        model: "gpt-5.4",
        hasMaxTokens: false,
        hasMaxCompletionTokens: true,
      });

      // 4c. PR audit node -> uses independent model name override gpt-6.2-astra
      const d3 = await jsonReq(`${srv.url}/api/tasks/${taskId}/discuss`, "POST", {
        body: "请审计当前 PR",
        mode: "pr_audit",
      });
      expect(d3.status).toBe(200);
      expect(d3.json.reply).toBe("REPLY_FROM_gpt-6.2-astra");
      expect(d3.json.node).toBe("pr_audit");
      expect(captured[captured.length - 1]).toMatchObject({
        path: "/openai/v1/chat/completions",
        auth: "Bearer test-key-openai-2222",
        model: "gpt-6.2-astra",
        hasMaxTokens: false,
        hasMaxCompletionTokens: true,
      });

      // 5. Test node connectivity directly via /api/ai/test with node="pr_audit"
      const testNode = await jsonReq(`${srv.url}/api/ai/test`, "POST", {
        node: "pr_audit",
      });
      expect(testNode.status).toBe(200);
      expect(testNode.json.model).toBe("gpt-6.2-astra");

      // 6. Switch active default profile to OpenAI Official
      const switched = await jsonReq(`${srv.url}/api/ai/profiles/select`, "POST", {
        profile_id: oaiId,
      });
      expect(switched.status).toBe(200);
      expect(switched.json.active_profile_id).toBe(oaiId);
      expect(switched.json.model).toBe("gpt-5.4");

      // 7. Delete OpenAI profile -> falls back cleanly to DeepSeek and resets pr_audit profile_id
      const deleted = await jsonReq(`${srv.url}/api/ai/profiles/delete`, "POST", {
        profile_id: oaiId,
      });
      expect(deleted.status).toBe(200);
      expect(deleted.json.active_profile_id).toBe(dsId);
      expect((deleted.json.profiles as unknown[]).length).toBe(1);
      const afterRoutes = deleted.json.node_routes as Record<
        string,
        Record<string, string>
      >;
      expect(afterRoutes.pr_audit.profile_id).toBe("");
    } finally {
      await new Promise<void>((resolve) => multiMock.close(() => resolve()));
    }
  });
});

describe("Ethereum Wallet SIWE Authentication (viem)", () => {
  it("completes challenge, personal_sign verification, session cookie, and logout", async () => {
    const account = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const wallet = new WalletAuth(account.address, "https://relaydesk.example.com");

    const challenge = wallet.challenge(1);
    expect(challenge.address).toBe(account.address);
    expect(challenge.message).toContain("relaydesk.example.com");

    const sig = await account.signMessage({ message: challenge.message });
    const session = await wallet.verify(challenge.nonce, sig);
    expect(session).toBeTruthy();
    expect(wallet.authenticated(session!)).toBe(true);

    // Nonce cannot be replayed
    const replay = await wallet.verify(challenge.nonce, sig);
    expect(replay).toBeNull();

    // Logout revokes session
    wallet.logout(session!);
    expect(wallet.authenticated(session!)).toBe(false);
  });
});

describe("GitHub Personal & Organization Repository Listing", () => {
  it("lists personal + org repos, filters by org, and handles Fine-grained PAT fallback", async () => {
    const mockGh = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/user") {
        res.end(
          JSON.stringify({
            login: "AceXiamo",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/1001?v=4",
          }),
        );
        return;
      }
      if (url.pathname === "/user/orgs") {
        res.end(
          JSON.stringify([
            {
              login: "acme-org",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2001?v=4",
            },
            {
              login: "scoped-org",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2002?v=4",
            },
          ]),
        );
        return;
      }
      if (url.pathname === "/user/repos") {
        const affiliation = url.searchParams.get("affiliation") ?? "";
        const personalRepo = {
          full_name: "AceXiamo/relaydesk",
          name: "relaydesk",
          private: false,
          archived: false,
          description: "Personal feedback queue",
          pushed_at: "2026-11-20T12:00:00Z",
          owner: {
            login: "AceXiamo",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/1001?v=4",
          },
        };
        const scopedOrgRepo = {
          full_name: "scoped-org/console-ui",
          name: "console-ui",
          private: true,
          archived: false,
          description: "Org repo accessible via /user/repos",
          pushed_at: "2026-11-20T11:00:00Z",
          owner: {
            login: "scoped-org",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/2002?v=4",
          },
        };
        const rows =
          affiliation === "owner" ? [personalRepo] : [personalRepo, scopedOrgRepo];
        res.end(JSON.stringify(rows));
        return;
      }
      if (url.pathname === "/orgs/acme-org/repos") {
        res.end(
          JSON.stringify([
            {
              full_name: "acme-org/core-api",
              name: "core-api",
              private: true,
              archived: false,
              description: "Acme organization backend",
              pushed_at: "2026-11-20T13:00:00Z",
              owner: {
                login: "acme-org",
                type: "Organization",
                avatar_url: "https://avatars.githubusercontent.com/u/2001?v=4",
              },
            },
          ]),
        );
        return;
      }
      if (url.pathname === "/orgs/scoped-org/repos") {
        res.statusCode = 403;
        res.end(JSON.stringify({ message: "Resource not accessible by PAT" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    });

    await new Promise<void>((r) => mockGh.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => mockGh.close(() => r())));
    const ghPort = (mockGh.address() as { port: number }).port;
    const prevBase = process.env.RELAYDESK_GITHUB_API_BASE;
    process.env.RELAYDESK_GITHUB_API_BASE = `http://127.0.0.1:${ghPort}`;
    cleanups.push(() => {
      if (prevBase === undefined) delete process.env.RELAYDESK_GITHUB_API_BASE;
      else process.env.RELAYDESK_GITHUB_API_BASE = prevBase;
    });

    const srv = await startApiServer();

    const connectRes = await jsonReq(`${srv.url}/api/github/connect`, "POST", {
      token: "ghp_testorgtoken123456",
    });
    expect(connectRes.status).toBe(200);
    expect(connectRes.json.configured).toBe(true);
    expect(connectRes.json.org_count).toBe(2);
    expect(connectRes.json.repo_count).toBe(3);

    // All repos merges personal + org repos
    const allRes = await jsonReq(`${srv.url}/api/github/repos`, "POST", {
      page: 1,
      owner: "all",
    });
    expect(allRes.status).toBe(200);
    expect(allRes.json.repos).toEqual([
      "acme-org/core-api",
      "AceXiamo/relaydesk",
      "scoped-org/console-ui",
    ]);
    const owners = allRes.json.owners as Array<{
      login: string;
      type: string;
      avatar_url?: string;
    }>;
    expect(owners.map((o) => `${o.type}:${o.login}`)).toEqual([
      "User:AceXiamo",
      "Organization:acme-org",
      "Organization:scoped-org",
    ]);
    expect(owners[0].avatar_url).toBe(
      "https://avatars.githubusercontent.com/u/1001?v=4&s=64",
    );
    const items = allRes.json.items as Array<{
      full_name: string;
      owner_avatar?: string;
    }>;
    expect(items[0].owner_avatar).toBe(
      "https://avatars.githubusercontent.com/u/2001?v=4&s=64",
    );

    // Specific org query uses /orgs/{org}/repos
    const acmeRes = await jsonReq(`${srv.url}/api/github/repos`, "POST", {
      page: 1,
      owner: "acme-org",
      owner_type: "Organization",
    });
    expect(acmeRes.status).toBe(200);
    expect(acmeRes.json.repos).toEqual(["acme-org/core-api"]);

    // Org returning 403 on /orgs/{org}/repos gracefully falls back to /user/repos
    const scopedRes = await jsonReq(`${srv.url}/api/github/repos`, "POST", {
      page: 1,
      owner: "scoped-org",
      owner_type: "Organization",
    });
    expect(scopedRes.status).toBe(200);
    expect(scopedRes.json.repos).toEqual(["scoped-org/console-ui"]);

    // Personal owner filter returns only user repos
    const userRes = await jsonReq(`${srv.url}/api/github/repos`, "POST", {
      page: 1,
      owner: "AceXiamo",
      owner_type: "User",
    });
    expect(userRes.status).toBe(200);
    expect(userRes.json.repos).toEqual(["AceXiamo/relaydesk"]);
  });

  it("supports multiple GitHub PATs (personal + org-scoped Fine-grained PATs), partial failures, refresh, and per-key disconnect", async () => {
    let orgTokenExpired = false;
    const mockGh = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const auth = req.headers.authorization ?? "";
      res.setHeader("Content-Type", "application/json");

      if (auth === "Bearer github_pat_personal_key_1111") {
        if (url.pathname === "/user") {
          res.end(
            JSON.stringify({
              login: "AceXiamo",
              type: "User",
              avatar_url: "https://avatars.githubusercontent.com/u/1001?v=4",
            }),
          );
          return;
        }
        if (url.pathname === "/user/orgs") {
          res.end(JSON.stringify([]));
          return;
        }
        if (url.pathname === "/user/repos") {
          res.end(
            JSON.stringify([
              {
                full_name: "AceXiamo/relaydesk",
                name: "relaydesk",
                private: false,
                archived: false,
                description: "Personal feedback queue",
                pushed_at: "2026-11-20T12:00:00Z",
                owner: {
                  login: "AceXiamo",
                  type: "User",
                  avatar_url: "https://avatars.githubusercontent.com/u/1001?v=4",
                },
              },
            ]),
          );
          return;
        }
        res.statusCode = 403;
        res.end(JSON.stringify({ message: "Forbidden" }));
        return;
      }

      if (auth === "Bearer github_pat_org_acme_key_2222") {
        if (orgTokenExpired) {
          res.statusCode = 401;
          res.end(JSON.stringify({ message: "Bad credentials" }));
          return;
        }
        if (url.pathname === "/user") {
          // Fine-grained PAT scoped to an org still returns the creator on /user
          res.end(
            JSON.stringify({
              login: "AceXiamo",
              type: "User",
              avatar_url: "https://avatars.githubusercontent.com/u/1001?v=4",
            }),
          );
          return;
        }
        if (url.pathname === "/user/orgs") {
          res.end(JSON.stringify([]));
          return;
        }
        if (url.pathname === "/user/repos" || url.pathname === "/orgs/acme-org/repos") {
          res.end(
            JSON.stringify([
              {
                full_name: "acme-org/core-api",
                name: "core-api",
                private: true,
                archived: false,
                description: "Acme backend",
                pushed_at: "2026-11-20T15:00:00Z",
                owner: {
                  login: "acme-org",
                  type: "Organization",
                  avatar_url: "https://avatars.githubusercontent.com/u/2001?v=4",
                },
              },
            ]),
          );
          return;
        }
      }

      res.statusCode = 401;
      res.end(JSON.stringify({ message: "Unauthorized" }));
    });

    await new Promise<void>((r) => mockGh.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => mockGh.close(() => r())));
    const ghPort = (mockGh.address() as { port: number }).port;
    const prevBase = process.env.RELAYDESK_GITHUB_API_BASE;
    process.env.RELAYDESK_GITHUB_API_BASE = `http://127.0.0.1:${ghPort}`;
    cleanups.push(() => {
      if (prevBase === undefined) delete process.env.RELAYDESK_GITHUB_API_BASE;
      else process.env.RELAYDESK_GITHUB_API_BASE = prevBase;
    });

    const srv = await startApiServer();

    // 1. Connect personal Fine-grained PAT
    const c1 = await jsonReq(`${srv.url}/api/github/connect`, "POST", {
      token: "github_pat_personal_key_1111",
    });
    expect(c1.status).toBe(200);
    const conn1 = c1.json.connection as {
      id: string;
      label: string;
      token_type: string;
      token_preview: string;
      owners: Array<{ login: string; type: string }>;
    };
    expect(conn1.label).toBe("@AceXiamo");
    expect(conn1.token_type).toBe("fine_grained");
    expect(conn1.token_preview).toBe("github_pat_••••1111");
    expect(conn1.owners.map((o) => `${o.type}:${o.login}`)).toEqual(["User:AceXiamo"]);

    // 2. Connect org-only Fine-grained PAT (viewer is still AceXiamo, but owners should only be acme-org)
    const c2 = await jsonReq(`${srv.url}/api/github/connect`, "POST", {
      token: "github_pat_org_acme_key_2222",
      label: "Acme 组织 Key",
    });
    expect(c2.status).toBe(200);
    const conn2 = c2.json.connection as {
      id: string;
      label: string;
      owners: Array<{ login: string; type: string }>;
    };
    expect(conn2.label).toBe("Acme 组织 Key");
    expect(conn2.owners.map((o) => `${o.type}:${o.login}`)).toEqual(["Organization:acme-org"]);

    // 3. GET /api/github returns both masked connections without leaking raw tokens
    const statusRes = await jsonReq(`${srv.url}/api/github`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.json.configured).toBe(true);
    expect((statusRes.json.connections as unknown[]).length).toBe(2);
    expect(JSON.stringify(statusRes.json)).not.toContain("github_pat_personal_key_1111");
    expect(JSON.stringify(statusRes.json)).not.toContain("github_pat_org_acme_key_2222");

    // 4. "all" aggregates repos & owners across both keys
    const allRes = await jsonReq(`${srv.url}/api/github/repos`, "POST", {
      page: 1,
      owner: "all",
    });
    expect(allRes.status).toBe(200);
    expect(allRes.json.repos).toEqual(["acme-org/core-api", "AceXiamo/relaydesk"]);
    expect(
      (allRes.json.owners as Array<{ login: string; type: string }>).map(
        (o) => `${o.type}:${o.login}`,
      ),
    ).toEqual(["User:AceXiamo", "Organization:acme-org"]);

    // 5. Filtering by org routes to the org key and keeps all owner tabs intact
    const orgRes = await jsonReq(`${srv.url}/api/github/repos`, "POST", {
      page: 1,
      owner: "acme-org",
      owner_type: "Organization",
    });
    expect(orgRes.status).toBe(200);
    expect(orgRes.json.repos).toEqual(["acme-org/core-api"]);
    expect(
      (orgRes.json.owners as Array<{ login: string; type: string }>).map(
        (o) => `${o.type}:${o.login}`,
      ),
    ).toEqual(["User:AceXiamo", "Organization:acme-org"]);

    // 6. Partial failure: if org key expires, personal repos still load with warning
    orgTokenExpired = true;
    const partialRes = await jsonReq(`${srv.url}/api/github/repos`, "POST", {
      page: 1,
      owner: "all",
    });
    expect(partialRes.status).toBe(200);
    expect(partialRes.json.repos).toEqual(["AceXiamo/relaydesk"]);
    expect((partialRes.json.warnings as Array<{ connection_id: string }>)[0].connection_id).toBe(
      conn2.id,
    );

    // 7. Refresh working key succeeds
    const refreshRes = await jsonReq(`${srv.url}/api/github/refresh`, "POST", {
      id: conn1.id,
    });
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.json.repo_count).toBe(1);

    // 8. Disconnect only the expired org key; personal key stays configured
    const delRes = await jsonReq(`${srv.url}/api/github/disconnect`, "POST", {
      id: conn2.id,
    });
    expect(delRes.status).toBe(200);
    expect(delRes.json.configured).toBe(true);
    expect((delRes.json.connections as Array<{ id: string }>).map((c) => c.id)).toEqual([
      conn1.id,
    ]);
  });

  it("ignores unrelated /user/orgs and /orgs/*/repos for Fine-grained PATs scoped to a specific organization", async () => {
    const requestedPaths: string[] = [];
    let repoOwnerName = "zeta-org";
    const mockGh = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const auth = req.headers.authorization ?? "";
      requestedPaths.push(`${auth === "Bearer github_pat_zero_repos_0000" ? "zero" : "zeta"}:${url.pathname}`);
      res.setHeader("Content-Type", "application/json");

      if (url.pathname === "/user") {
        res.end(
          JSON.stringify({
            login: "AceXiamo",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/1001?v=4",
          }),
        );
        return;
      }

      // GitHub returns all public org memberships on /user/orgs even for a Fine-grained PAT
      // scoped to a completely different org. Relaydesk must ignore /user/orgs for Fine-grained PATs.
      if (url.pathname === "/user/orgs") {
        res.end(
          JSON.stringify([
            {
              login: "alpha-org",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/3001?v=4",
            },
            {
              login: "beta-org",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/3002?v=4",
            },
          ]),
        );
        return;
      }

      // /orgs/{org}/repos returns public repos for ANY org even if the Fine-grained PAT is not scoped to it
      if (url.pathname === "/orgs/alpha-org/repos") {
        res.end(
          JSON.stringify([
            {
              full_name: "alpha-org/public-site",
              name: "public-site",
              private: false,
              archived: false,
              description: "Unrelated org public repo",
              pushed_at: "2026-11-20T18:00:00Z",
              owner: {
                login: "alpha-org",
                type: "Organization",
                avatar_url: "https://avatars.githubusercontent.com/u/3001?v=4",
              },
            },
          ]),
        );
        return;
      }

      if (url.pathname === "/user/repos") {
        if (auth === "Bearer github_pat_zero_repos_0000") {
          res.end(JSON.stringify([]));
          return;
        }
        res.end(
          JSON.stringify([
            {
              full_name: `${repoOwnerName}/relay-private`,
              name: "relay-private",
              private: true,
              archived: false,
              description: "Target org repo actually granted to the Fine-grained PAT",
              pushed_at: "2026-11-20T16:00:00Z",
              owner: {
                login: repoOwnerName,
                type: "Organization",
                avatar_url: "https://avatars.githubusercontent.com/u/4001?v=4",
              },
            },
          ]),
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    });

    await new Promise<void>((r) => mockGh.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => mockGh.close(() => r())));
    const ghPort = (mockGh.address() as { port: number }).port;
    const prevBase = process.env.RELAYDESK_GITHUB_API_BASE;
    process.env.RELAYDESK_GITHUB_API_BASE = `http://127.0.0.1:${ghPort}`;
    cleanups.push(() => {
      if (prevBase === undefined) delete process.env.RELAYDESK_GITHUB_API_BASE;
      else process.env.RELAYDESK_GITHUB_API_BASE = prevBase;
    });

    const srv = await startApiServer();

    // 1. Connecting the zeta-org Fine-grained PAT must bind ONLY to zeta-org (never alpha-org)
    const connectRes = await jsonReq(`${srv.url}/api/github/connect`, "POST", {
      token: "github_pat_zeta_only_9999",
    });
    expect(connectRes.status).toBe(200);
    const conn = connectRes.json.connection as {
      id: string;
      label: string;
      owners: Array<{ login: string; type: string }>;
      repo_count: number;
    };
    expect(conn.label).toBe("zeta-org");
    expect(conn.owners.map((o) => `${o.type}:${o.login}`)).toEqual(["Organization:zeta-org"]);
    expect(conn.repo_count).toBe(1);
    expect(requestedPaths.some((p) => p.endsWith(":/user/orgs"))).toBe(false);
    expect(requestedPaths.some((p) => p.includes("/orgs/"))).toBe(false);

    // 2. Listing all repos returns only zeta-org repos (no alpha-org public repo leakage)
    const allRes = await jsonReq(`${srv.url}/api/github/repos`, "POST", {
      page: 1,
      owner: "all",
    });
    expect(allRes.status).toBe(200);
    expect(allRes.json.repos).toEqual(["zeta-org/relay-private"]);
    expect(
      (allRes.json.owners as Array<{ login: string; type: string }>).map(
        (o) => `${o.type}:${o.login}`,
      ),
    ).toEqual(["Organization:zeta-org"]);

    // 3. Filtering by alpha-org does NOT fall back to /orgs/alpha-org/repos
    const alphaRes = await jsonReq(`${srv.url}/api/github/repos`, "POST", {
      page: 1,
      owner: "alpha-org",
      owner_type: "Organization",
    });
    expect(alphaRes.status).toBe(200);
    expect(alphaRes.json.repos).toEqual([]);
    expect(requestedPaths.some((p) => p.includes("/orgs/alpha-org/repos"))).toBe(false);

    // 4. Refresh recomputes auto-inferred label when org changes (e.g. after fixing stale metadata)
    repoOwnerName = "omega-org";
    const refreshRes = await jsonReq(`${srv.url}/api/github/refresh`, "POST", {
      id: conn.id,
    });
    expect(refreshRes.status).toBe(200);
    expect((refreshRes.json.connection as { label: string }).label).toBe("omega-org");
    expect(
      ((refreshRes.json.connection as { owners: Array<{ login: string }> }).owners).map(
        (o) => o.login,
      ),
    ).toEqual(["omega-org"]);

    // 5. Fine-grained PAT with 0 accessible repos stores owners: [] instead of misattributing to alpha-org or viewer
    const zeroRes = await jsonReq(`${srv.url}/api/github/connect`, "POST", {
      token: "github_pat_zero_repos_0000",
    });
    expect(zeroRes.status).toBe(200);
    const zeroConn = zeroRes.json.connection as {
      owners: Array<{ login: string }>;
      repo_count: number;
    };
    expect(zeroConn.owners).toEqual([]);
    expect(zeroConn.repo_count).toBe(0);
  });

  it("supports inspecting a token and manually locking a GitHub Key to a chosen organization or account", async () => {
    const requested: string[] = [];
    const mockGh = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const auth = req.headers.authorization ?? "";
      const tag = auth.includes("roxy_org") ? "org" : "personal";
      requested.push(`${tag}:${url.pathname}`);
      res.setHeader("Content-Type", "application/json");

      if (url.pathname === "/user") {
        res.end(
          JSON.stringify({
            login: "AceXiamo",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/1001?v=4",
          }),
        );
        return;
      }

      if (url.pathname === "/user/orgs") {
        res.end(
          JSON.stringify([
            {
              login: "NexionDev",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2001?v=4",
            },
            {
              login: "roxy-org",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2002?v=4",
            },
          ]),
        );
        return;
      }

      if (url.pathname === "/orgs/roxy-org") {
        res.end(
          JSON.stringify({
            login: "roxy-org",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/2002?v=4",
          }),
        );
        return;
      }

      if (url.pathname === "/orgs/roxy-org/repos") {
        res.end(
          JSON.stringify([
            {
              full_name: "roxy-org/roxy-web",
              name: "roxy-web",
              private: true,
              archived: false,
              description: "Roxy web app",
              pushed_at: "2026-11-20T19:00:00Z",
              owner: {
                login: "roxy-org",
                type: "Organization",
                avatar_url: "https://avatars.githubusercontent.com/u/2002?v=4",
              },
            },
            {
              full_name: "roxy-org/roxy-api",
              name: "roxy-api",
              private: true,
              archived: false,
              description: "Roxy backend API",
              pushed_at: "2026-11-20T18:00:00Z",
              owner: {
                login: "roxy-org",
                type: "Organization",
                avatar_url: "https://avatars.githubusercontent.com/u/2002?v=4",
              },
            },
          ]),
        );
        return;
      }

      // Simulate /user/repos being flooded with personal & unrelated org public repos
      if (url.pathname === "/user/repos") {
        const affiliation = url.searchParams.get("affiliation") ?? "";
        if (affiliation === "owner") {
          res.end(
            JSON.stringify([
              {
                full_name: "AceXiamo/relaydesk",
                name: "relaydesk",
                private: false,
                archived: false,
                description: "Personal repo",
                pushed_at: "2026-11-20T17:00:00Z",
                owner: {
                  login: "AceXiamo",
                  type: "User",
                  avatar_url: "https://avatars.githubusercontent.com/u/1001?v=4",
                },
              },
            ]),
          );
          return;
        }
        res.end(
          JSON.stringify([
            {
              full_name: "AceXiamo/relaydesk",
              name: "relaydesk",
              private: false,
              archived: false,
              description: "Personal repo",
              pushed_at: "2026-11-20T17:00:00Z",
              owner: {
                login: "AceXiamo",
                type: "User",
                avatar_url: "https://avatars.githubusercontent.com/u/1001?v=4",
              },
            },
            {
              full_name: "NexionDev/public-noise",
              name: "public-noise",
              private: false,
              archived: false,
              description: "Unrelated org public repo",
              pushed_at: "2026-11-20T16:00:00Z",
              owner: {
                login: "NexionDev",
                type: "Organization",
                avatar_url: "https://avatars.githubusercontent.com/u/2001?v=4",
              },
            },
          ]),
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    });

    await new Promise<void>((r) => mockGh.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => mockGh.close(() => r())));
    const ghPort = (mockGh.address() as { port: number }).port;

    const prevBase = process.env.RELAYDESK_GITHUB_API_BASE;
    process.env.RELAYDESK_GITHUB_API_BASE = `http://127.0.0.1:${ghPort}`;
    cleanups.push(() => {
      if (prevBase === undefined) delete process.env.RELAYDESK_GITHUB_API_BASE;
      else process.env.RELAYDESK_GITHUB_API_BASE = prevBase;
    });

    const srv = await startApiServer();

    // 1. Inspect Fine-grained PAT to discover candidate orgs/accounts
    const inspectRes = await jsonReq(`${srv.url}/api/github/inspect`, "POST", {
      token: "github_pat_roxy_org_key_9999",
    });
    expect(inspectRes.status).toBe(200);
    expect(inspectRes.json.token_type).toBe("fine_grained");
    expect(
      (inspectRes.json.candidates as Array<{ login: string; type: string }>).map(
        (c) => `${c.type}:${c.login}`,
      ),
    ).toEqual(["User:AceXiamo", "Organization:NexionDev", "Organization:roxy-org"]);

    // 2. Connect personal key locked to AceXiamo
    const c1 = await jsonReq(`${srv.url}/api/github/connect`, "POST", {
      token: "ghp_personal_key_1111",
      scope_owner: { login: "AceXiamo", type: "User" },
    });
    expect(c1.status).toBe(200);
    const conn1 = c1.json.connection as {
      id: string;
      scope_owner: { login: string; type: string } | null;
      owners: Array<{ login: string }>;
    };
    expect(conn1.scope_owner?.login).toBe("AceXiamo");
    expect(conn1.owners.map((o) => o.login)).toEqual(["AceXiamo"]);

    // 3. Connect org Fine-grained PAT initially without scope, then update its scope_owner by id WITHOUT re-sending token
    const c2Initial = await jsonReq(`${srv.url}/api/github/connect`, "POST", {
      token: "github_pat_roxy_org_key_9999",
      label: "roxy",
    });
    expect(c2Initial.status).toBe(200);
    const conn2Id = (c2Initial.json.connection as { id: string }).id;

    // Inspect existing saved connection by id
    const inspectById = await jsonReq(`${srv.url}/api/github/inspect`, "POST", {
      id: conn2Id,
    });
    expect(inspectById.status).toBe(200);
    expect((inspectById.json.candidates as Array<{ login: string }>).map((c) => c.login)).toContain(
      "roxy-org",
    );

    // Lock existing connection to roxy-org without re-pasting token
    const c2Updated = await jsonReq(`${srv.url}/api/github/connect`, "POST", {
      id: conn2Id,
      scope_owner: { login: "roxy-org", type: "Organization" },
    });
    expect(c2Updated.status).toBe(200);
    const conn2 = c2Updated.json.connection as {
      id: string;
      label: string;
      scope_owner: { login: string; type: string; avatar_url?: string } | null;
      owners: Array<{ login: string; type: string }>;
      repo_count: number;
    };
    expect(conn2.scope_owner?.login).toBe("roxy-org");
    expect(conn2.scope_owner?.type).toBe("Organization");
    expect(conn2.owners.map((o) => `${o.type}:${o.login}`)).toEqual(["Organization:roxy-org"]);
    expect(conn2.repo_count).toBe(2);

    // 4. Aggregated "all" returns both AceXiamo and roxy-org repos cleanly (no NexionDev leak!)
    requested.length = 0;
    const allRes = await jsonReq(`${srv.url}/api/github/repos`, "POST", {
      page: 1,
      owner: "all",
    });
    expect(allRes.status).toBe(200);
    expect(allRes.json.repos).toEqual([
      "roxy-org/roxy-web",
      "roxy-org/roxy-api",
      "AceXiamo/relaydesk",
    ]);
    expect(
      (allRes.json.owners as Array<{ login: string }>).map((o) => o.login),
    ).toEqual(["AceXiamo", "roxy-org"]);

    // 5. Filtering by roxy-org only queries the roxy-org key
    requested.length = 0;
    const roxyRes = await jsonReq(`${srv.url}/api/github/repos`, "POST", {
      page: 1,
      owner: "roxy-org",
      owner_type: "Organization",
    });
    expect(roxyRes.status).toBe(200);
    expect(roxyRes.json.repos).toEqual(["roxy-org/roxy-web", "roxy-org/roxy-api"]);
    expect(requested.every((r) => r.startsWith("org:"))).toBe(true);
  });

  it("supports binding multiple GitHub repositories to a single project", async () => {
    const srv = await startApiServer();

    // 1. Create project with multiple repos (deduped & normalized)
    const created = await jsonReq(`${srv.url}/api/projects`, "POST", {
      name: "Multi Repo Product",
      repos: [
        "https://github.com/acme-org/web.git",
        "acme-org/api",
        "git@github.com:acme-org/web.git",
      ],
    });
    expect(created.status).toBe(200);
    const project = created.json.project as {
      id: string;
      repo: string;
      repos: string[];
      agent_key: string;
    };
    expect(project.repo).toBe("acme-org/web");
    expect(project.repos).toEqual(["acme-org/web", "acme-org/api"]);

    // 2. List projects & agent project endpoint expose both repo and repos
    const listed = await jsonReq(`${srv.url}/api/projects`);
    expect(listed.status).toBe(200);
    const summary = (listed.json.projects as Array<{ repo: string; repos: string[] }>)[0];
    expect(summary.repo).toBe("acme-org/web");
    expect(summary.repos).toEqual(["acme-org/web", "acme-org/api"]);

    const agentProj = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/project`,
      "GET",
      undefined,
      { Authorization: `Bearer ${project.agent_key}` },
    );
    expect(agentProj.status).toBe(200);
    expect((agentProj.json.project as { repos: string[] }).repos).toEqual([
      "acme-org/web",
      "acme-org/api",
    ]);

    // 3. Create & claim a task with an agent lease
    const taskRes = await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
      title: "Fix header",
      body: "Header overflows on mobile",
      priority: "high",
    });
    const task = taskRes.json.task as { id: string; version: number };
    await jsonReq(`${srv.url}/api/tasks/${task.id}/action`, "POST", {
      action: "status",
      status: "ready",
      version: task.version,
    });
    const claimRes = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/claim`,
      "POST",
      {},
      { Authorization: `Bearer ${project.agent_key}` },
    );
    expect(claimRes.status).toBe(200);

    // 4. Adding a new repo during active agent handoff is allowed
    const addRepoRes = await jsonReq(`${srv.url}/api/projects/${project.id}`, "PATCH", {
      repos: ["acme-org/web", "acme-org/api", "acme-org/mobile"],
    });
    expect(addRepoRes.status).toBe(200);
    expect((addRepoRes.json.project as { repos: string[] }).repos).toEqual([
      "acme-org/web",
      "acme-org/api",
      "acme-org/mobile",
    ]);

    // 5. Removing an existing bound repo during active agent handoff is rejected (409)
    const removeRepoRes = await jsonReq(`${srv.url}/api/projects/${project.id}`, "PATCH", {
      repos: ["acme-org/web"],
    });
    expect(removeRepoRes.status).toBe(409);

    // 6. After finishing the handoff, rebinding & changing primary repo succeeds
    const claimedTask = claimRes.json.task as { id: string; version: number };
    const lease = claimRes.json.lease as string;
    const finishRes = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${claimedTask.id}/finish`,
      "POST",
      { lease, version: claimedTask.version, body: "Done" },
      { Authorization: `Bearer ${project.agent_key}` },
    );
    expect(finishRes.status).toBe(200);
    const rebindRes = await jsonReq(`${srv.url}/api/projects/${project.id}`, "PATCH", {
      repos: ["acme-org/api", "acme-org/mobile"],
    });
    expect(rebindRes.status).toBe(200);
    expect((rebindRes.json.project as { repo: string; repos: string[] }).repo).toBe(
      "acme-org/api",
    );
    expect((rebindRes.json.project as { repos: string[] }).repos).toEqual([
      "acme-org/api",
      "acme-org/mobile",
    ]);
  });
});

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 30,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

describe("Autonomous Execution Queue, Lease Reclamation & Agent Operations", () => {
  it("smoothly migrates legacy SQLite tables to include automation and task metadata columns", () => {
    const { dbPath } = makeTempDb();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL,
        intake_key TEXT NOT NULL, bot_key TEXT NOT NULL, agent_key TEXT NOT NULL,
        allowed_origins TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        requirements TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
        source_url TEXT NOT NULL DEFAULT '', external_id TEXT,
        priority TEXT NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'none',
        lease TEXT, version INTEGER NOT NULL DEFAULT 1, merged_into TEXT REFERENCES tasks(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('p1', 'Legacy', 'acme/legacy', 'ik', 'bk', 'ak', '[]', '2026-01-01T00:00:00.000Z');
      INSERT INTO tasks VALUES ('t1', 'p1', 1, 'Old task', 'Body', '', 'console', '', NULL, 'normal', 'triage', 'none', NULL, 1, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
    `);
    legacy.close();

    const store = new Store(dbPath);
    cleanups.push(() => store.close());

    const projects = store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].automation_paused).toBe(false);
    expect(projects[0].delivery_mode).toBe("direct_push");
    expect(projects[0].repos).toEqual(["acme/legacy"]);

    const tasks = store.listTasks("p1");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].attempts).toBe(0);
    expect(tasks[0].resolution).toBeNull();
    expect(tasks[0].delivery_ref).toBe("");
    expect(tasks[0].triaged_by).toBe("");
  });

  it("supports zero-human-gate claiming, queue ordering, serial lock, and automation pause", async () => {
    const srv = await startApiServer();

    const pRes = await jsonReq(`${srv.url}/api/projects`, "POST", {
      name: "Auto Queue App",
      repo: "acexiamo/auto-queue",
    });
    expect(pRes.status).toBe(200);
    const project = pRes.json.project as {
      id: string;
      agent_key: string;
      automation_paused: boolean;
      delivery_mode: string;
    };
    expect(project.automation_paused).toBe(false);
    expect(project.delivery_mode).toBe("direct_push");

    // Create three tasks: #1 triage normal, #2 triage high, #3 ready high
    const t1 = (
      await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
        title: "Normal triage feedback",
        body: "Minor copy fix",
        priority: "normal",
      })
    ).json.task as { id: string; version: number };
    const t2 = (
      await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
        title: "High triage bug",
        body: "Crash on click",
        priority: "high",
      })
    ).json.task as { id: string; version: number };
    const t3 = (
      await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
        title: "High ready bug",
        body: "Already triaged high bug",
        priority: "high",
      })
    ).json.task as { id: string; version: number };
    await jsonReq(`${srv.url}/api/tasks/${t3.id}/action`, "POST", {
      action: "status",
      status: "ready",
      version: t3.version,
    });

    const auth = { Authorization: `Bearer ${project.agent_key}` };

    // GET /agent/queue orders by priority -> ready before triage -> number ASC
    const q1 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/queue`, "GET", undefined, auth);
    expect(q1.status).toBe(200);
    expect(q1.json.paused).toBe(false);
    expect(q1.json.active).toBeNull();
    const pendingIds = (q1.json.pending as Array<{ id: string }>).map((i) => i.id);
    expect(pendingIds).toEqual([t3.id, t2.id, t1.id]);

    // Pause automation blocks claims
    const pauseRes = await jsonReq(`${srv.url}/api/projects/${project.id}`, "PATCH", {
      automation_paused: true,
    });
    expect(pauseRes.status).toBe(200);
    expect((pauseRes.json.project as { automation_paused: boolean }).automation_paused).toBe(true);

    const pausedClaim = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/claim`,
      "POST",
      {},
      auth,
    );
    expect(pausedClaim.status).toBe(200);
    expect(pausedClaim.json.task).toBeNull();
    expect(pausedClaim.json.paused).toBe(true);
    expect(pausedClaim.json.reason).toBe("paused");

    // Reject invalid delivery_mode
    const badMode = await jsonReq(`${srv.url}/api/projects/${project.id}`, "PATCH", {
      delivery_mode: "yolo_push",
    });
    expect(badMode.status).toBe(400);

    // Resume automation
    await jsonReq(`${srv.url}/api/projects/${project.id}`, "PATCH", {
      automation_paused: false,
    });

    // Claim specific triage task directly (zero human gate)
    const claimSpecific = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/claim`,
      "POST",
      { task_id: t2.id },
      auth,
    );
    expect(claimSpecific.status).toBe(200);
    const claimed = claimSpecific.json.task as Record<string, unknown>;
    expect(claimed.id).toBe(t2.id);
    expect(claimed.status).toBe("working");
    expect(claimed.owner).toBe("agent");
    expect(Array.isArray(claimed.linked_feedback)).toBe(true);
    expect(typeof claimed.message_count).toBe("number");

    // Serial lock: a second claim while t2 is active returns busy: true
    const busyClaim = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/claim`,
      "POST",
      {},
      auth,
    );
    expect(busyClaim.status).toBe(200);
    expect(busyClaim.json.task).toBeNull();
    expect(busyClaim.json.busy).toBe(true);
    expect((busyClaim.json.active_task as { id: string }).id).toBe(t2.id);

    // Queue reflects active task
    const q2 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/queue`, "GET", undefined, auth);
    expect((q2.json.active as { id: string }).id).toBe(t2.id);
  });

  it("supports agent triage, comment, thread, complete (direct_push & review_only), dismiss, merge, and retryable fail", async () => {
    const srv = await startApiServer();

    const pRes = await jsonReq(`${srv.url}/api/projects`, "POST", {
      name: "Lifecycle App",
      repo: "acexiamo/lifecycle",
    });
    const project = pRes.json.project as { id: string; agent_key: string };
    const auth = { Authorization: `Bearer ${project.agent_key}` };

    // Task 1: triage -> comment -> thread -> complete (direct_push -> done + shipped)
    const t1 = (
      await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
        title: "Login button misaligned",
        body: "Button shifts right on Safari",
        priority: "normal",
      })
    ).json.task as { id: string };

    const c1 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    const lease1 = c1.json.lease as string;

    const triageRes = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${t1.id}/triage`,
      "POST",
      {
        lease: lease1,
        title: "Fix Safari login button alignment",
        requirements: "- Align CTA with form grid on Safari 18",
        priority: "high",
      },
      auth,
    );
    expect(triageRes.status).toBe(200);
    const triaged = triageRes.json.task as Record<string, unknown>;
    expect(triaged.title).toBe("Fix Safari login button alignment");
    expect(triaged.priority).toBe("high");
    expect(triaged.triaged_by).toBe("agent");

    const commentRes = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${t1.id}/comment`,
      "POST",
      { lease: lease1, body: "### Investigation\nFound flex-basis bug in `LoginForm.tsx`." },
      auth,
    );
    expect(commentRes.status).toBe(200);
    expect((commentRes.json.message as { author: string }).author).toBe("agent");

    const threadRes = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${t1.id}/thread`,
      "GET",
      undefined,
      auth,
    );
    expect(threadRes.status).toBe(200);
    expect(threadRes.json.task_id).toBe(t1.id);
    expect((threadRes.json.messages as Array<{ body: string }>).some((m) => m.body.includes("LoginForm.tsx"))).toBe(true);

    const complete1 = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${t1.id}/complete`,
      "POST",
      {
        lease: lease1,
        summary: "## Shipped\nFixed Safari flex-basis and added regression test.",
        delivery_ref: "commit:abc1234",
      },
      auth,
    );
    expect(complete1.status).toBe(200);
    const completed1 = complete1.json.task as Record<string, unknown>;
    expect(completed1.status).toBe("done");
    expect(completed1.resolution).toBe("shipped");
    expect(completed1.delivery_ref).toBe("commit:abc1234");
    expect(completed1.owner).toBe("none");

    // Verify markdown summary was stored as an agent comment
    const detail1 = await jsonReq(`${srv.url}/api/tasks/${t1.id}`);
    const msgs1 = detail1.json.messages as Array<{ kind: string; author: string; body: string }>;
    expect(msgs1.some((m) => m.kind === "comment" && m.author === "agent" && m.body.includes("## Shipped"))).toBe(true);

    // Task 2: review_only mode -> complete goes to review
    await jsonReq(`${srv.url}/api/projects/${project.id}`, "PATCH", {
      delivery_mode: "review_only",
    });
    const t2 = (
      await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
        title: "Add export filter",
        body: "Allow filtering by date range",
        priority: "normal",
      })
    ).json.task as { id: string };
    const c2 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    const lease2 = c2.json.lease as string;
    const complete2 = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${t2.id}/complete`,
      "POST",
      {
        lease: lease2,
        summary: "Opened PR #42 for date filter.",
        delivery_ref: "https://github.com/acexiamo/lifecycle/pull/42",
      },
      auth,
    );
    expect(complete2.status).toBe(200);
    const completed2 = complete2.json.task as Record<string, unknown>;
    expect(completed2.status).toBe("review");
    expect(completed2.resolution).toBeNull();
    expect(completed2.delivery_ref).toBe("https://github.com/acexiamo/lifecycle/pull/42");

    // Task 3: dismiss noise feedback
    const t3 = (
      await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
        title: "test 123",
        body: "just testing",
        priority: "low",
      })
    ).json.task as { id: string };
    const c3 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    const lease3 = c3.json.lease as string;
    const dismissRes = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${t3.id}/dismiss`,
      "POST",
      { lease: lease3, reason: "Connectivity test with no actionable product issue." },
      auth,
    );
    expect(dismissRes.status).toBe(200);
    const dismissed = dismissRes.json.task as Record<string, unknown>;
    expect(dismissed.status).toBe("done");
    expect(dismissed.resolution).toBe("dismissed");
    expect(dismissed.triaged_by).toBe("agent");

    // Task 4 & Task 5: agent merge duplicate into open task
    const t4 = (
      await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
        title: "Primary dark mode issue",
        body: "Sidebar stays light in dark mode",
        priority: "normal",
      })
    ).json.task as { id: string };
    const t5 = (
      await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
        title: "Duplicate dark mode issue",
        body: "Left nav does not respect dark theme",
        priority: "high",
      })
    ).json.task as { id: string };

    // Claims higher priority t5 first
    const c5 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    expect((c5.json.task as { id: string }).id).toBe(t5.id);
    const mergeRes = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${t5.id}/merge`,
      "POST",
      { lease: c5.json.lease, target_id: t4.id },
      auth,
    );
    expect(mergeRes.status).toBe(200);
    const mergedTask = mergeRes.json.task as Record<string, unknown>;
    expect(mergedTask.status).toBe("done");
    expect(mergedTask.resolution).toBe("merged");
    expect(mergedTask.merged_into).toBe(t4.id);
    expect(mergedTask.triaged_by).toBe("agent");

    // Verify target task t4 has t5 linked
    const t4Detail = await jsonReq(`${srv.url}/api/tasks/${t4.id}`);
    expect((t4Detail.json.merged as Array<{ id: string }>).map((m) => m.id)).toEqual([t5.id]);

    // Task 4: retryable fail increments attempts and returns to ready, then non-retryable goes to waiting
    const c4a = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    const fail1 = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${t4.id}/fail`,
      "POST",
      { lease: c4a.json.lease, retryable: true, body: "Transient network error during test" },
      auth,
    );
    expect(fail1.status).toBe(200);
    expect((fail1.json.task as { status: string; attempts: number }).status).toBe("ready");
    expect((fail1.json.task as { attempts: number }).attempts).toBe(1);

    const c4b = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    const fail2 = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${t4.id}/fail`,
      "POST",
      { lease: c4b.json.lease, retryable: false, body: "Need design confirmation" },
      auth,
    );
    expect(fail2.status).toBe(200);
    expect((fail2.json.task as { status: string; attempts: number }).status).toBe("waiting");
    expect((fail2.json.task as { attempts: number }).attempts).toBe(2);
  });

  it("reclaims stale agent leases and escalates to waiting at max attempts (3)", async () => {
    const { dbPath } = makeTempDb();
    const srv = await startApiServer({ dbPath });

    const pRes = await jsonReq(`${srv.url}/api/projects`, "POST", {
      name: "Stale Lease App",
      repo: "acexiamo/stale",
    });
    const project = pRes.json.project as { id: string; agent_key: string };
    const auth = { Authorization: `Bearer ${project.agent_key}` };

    const t = (
      await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
        title: "Long running refactor",
        body: "Refactor billing pipeline",
        priority: "high",
      })
    ).json.task as { id: string };

    const backdateLastSeen = (taskId: string) => {
      const db = new DatabaseSync(dbPath);
      const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE tasks SET last_seen = ?, updated_at = ? WHERE id = ?").run(
        oldIso,
        oldIso,
        taskId,
      );
      db.close();
    };

    // Attempt 1 -> stale -> reclaimed to ready (attempts=1)
    const c1 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    expect((c1.json.task as { id: string }).id).toBe(t.id);
    backdateLastSeen(t.id);

    const q1 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/queue`, "GET", undefined, auth);
    expect(q1.json.active).toBeNull();
    expect((q1.json.pending as Array<{ id: string; status: string; attempts: number }>)[0]).toMatchObject({
      id: t.id,
      status: "ready",
      attempts: 1,
    });

    // Attempt 2 -> stale -> reclaimed to ready (attempts=2)
    const c2 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    expect((c2.json.task as { id: string }).id).toBe(t.id);
    backdateLastSeen(t.id);

    // Claiming triggers reclamation and immediately claims for attempt 3
    const c3 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    expect((c3.json.task as { id: string; attempts: number }).id).toBe(t.id);
    expect((c3.json.task as { attempts: number }).attempts).toBe(2);

    // Attempt 3 -> stale -> reaches max attempts (3) -> waiting (not claimable)
    backdateLastSeen(t.id);
    const c4 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    expect(c4.json.task).toBeNull();

    const detail = await jsonReq(`${srv.url}/api/tasks/${t.id}`);
    const task = detail.json.task as { status: string; owner: string; attempts: number };
    expect(task.status).toBe("waiting");
    expect(task.owner).toBe("none");
    expect(task.attempts).toBe(3);
    const msgs = detail.json.messages as Array<{ body: string }>;
    expect(msgs.some((m) => m.body === "Stale agent lease reclaimed")).toBe(true);
    expect(msgs.some((m) => m.body === "Stale agent lease reached max attempts")).toBe(true);
  });

  it("auto-reopens done/waiting/review tasks on operator comment, supports reopen: false, and reopen action", async () => {
    const srv = await startApiServer();

    const pRes = await jsonReq(`${srv.url}/api/projects`, "POST", {
      name: "Reopen App",
      repo: "acexiamo/reopen",
    });
    const project = pRes.json.project as { id: string; agent_key: string };
    const auth = { Authorization: `Bearer ${project.agent_key}` };

    const t = (
      await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
        title: "Export timeout",
        body: "Large export times out",
        priority: "high",
      })
    ).json.task as { id: string };

    // Agent dismisses task
    const c1 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${t.id}/dismiss`,
      "POST",
      { lease: c1.json.lease, reason: "False alarm" },
      auth,
    );

    // Comment with reopen: false does NOT reopen
    const noReopen = await jsonReq(`${srv.url}/api/tasks/${t.id}/messages`, "POST", {
      body: "Leaving an internal note only",
      reopen: false,
    });
    expect(noReopen.status).toBe(200);
    expect(noReopen.json.reopened).toBe(false);
    expect((noReopen.json.task as { status: string; resolution: string }).status).toBe("done");
    expect((noReopen.json.task as { resolution: string }).resolution).toBe("dismissed");

    // Normal operator comment auto-reopens to ready and clears resolution/attempts
    const autoReopen = await jsonReq(`${srv.url}/api/tasks/${t.id}/messages`, "POST", {
      body: "Actually this reproduces with 50k rows, please fix.",
    });
    expect(autoReopen.status).toBe(200);
    expect(autoReopen.json.reopened).toBe(true);
    const reopenedTask = autoReopen.json.task as {
      status: string;
      resolution: string | null;
      attempts: number;
      version: number;
    };
    expect(reopenedTask.status).toBe("ready");
    expect(reopenedTask.resolution).toBeNull();
    expect(reopenedTask.attempts).toBe(0);

    // Agent fails into waiting, then operator uses explicit action: "reopen"
    const c2 = await jsonReq(`${srv.url}/api/projects/${project.id}/agent/claim`, "POST", {}, auth);
    const failed = await jsonReq(
      `${srv.url}/api/projects/${project.id}/agent/${t.id}/fail`,
      "POST",
      { lease: c2.json.lease, retryable: false, body: "Blocked on fixture" },
      auth,
    );
    const waitingVer = (failed.json.task as { version: number }).version;

    const explicitReopen = await jsonReq(`${srv.url}/api/tasks/${t.id}/action`, "POST", {
      action: "reopen",
      version: waitingVer,
    });
    expect(explicitReopen.status).toBe(200);
    const tReopened = explicitReopen.json.task as {
      status: string;
      attempts: number;
      resolution: string | null;
    };
    expect(tReopened.status).toBe("ready");
    expect(tReopened.attempts).toBe(0);
    expect(tReopened.resolution).toBeNull();
  });
});

describe("Two-Tier Server LLM Pre-screening (Plan A)", () => {
  it("auto-archives noise, promotes valid feedback, fails open on errors, and honors skip_prescreen", async () => {
    let callCount = 0;
    const mockAi = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        callCount += 1;
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content: string }>;
        };
        const userMsg = payload.messages.find((m) => m.role === "user")?.content ?? "";

        if (userMsg.includes("TRIGGER_ERROR")) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Upstream unavailable" }));
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");

        if (userMsg.includes("这是一次测试")) {
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      verdict: "noise",
                      reason: "这是一条连通性测试消息，不包含产品问题",
                      priority: "low",
                    }),
                  },
                },
              ],
            }),
          );
          return;
        }

        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '```json\n{"verdict":"valid","reason":"明确描述了结账页崩溃问题","priority":"high"}\n```',
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((r) => mockAi.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => mockAi.close(() => r())));
    const mockPort = (mockAi.address() as { port: number }).port;

    const srv = await startApiServer();

    // Configure loopback LLM
    const aiCfg = await jsonReq(`${srv.url}/api/ai`, "POST", {
      base_url: `http://127.0.0.1:${mockPort}/v1`,
      model: "gpt-4o-mini",
      api_key: "{{SECRET_prescreen_test}}",
      intake_enabled: false,
    });
    expect(aiCfg.status).toBe(200);

    const pRes = await jsonReq(`${srv.url}/api/projects`, "POST", {
      name: "Prescreen App",
      repo: "acexiamo/prescreen",
    });
    const project = pRes.json.project as { id: string; intake_key: string };

    // 1. Noise via widget intake -> auto-archived as done + dismissed + triaged_by=server_ai
    const noiseIntake = await jsonReq(
      `${srv.url}/api/projects/${project.id}/intake`,
      "POST",
      { source: "widget", title: "测试", body: "这是一次测试" },
      { Authorization: `Bearer ${project.intake_key}` },
    );
    expect(noiseIntake.status).toBe(200);
    const noiseId = noiseIntake.json.task_id as string;

    await waitForCondition(async () => {
      const d = await jsonReq(`${srv.url}/api/tasks/${noiseId}`);
      return (d.json.task as { status: string }).status === "done";
    });

    const noiseDetail = await jsonReq(`${srv.url}/api/tasks/${noiseId}`);
    const noiseTask = noiseDetail.json.task as Record<string, unknown>;
    expect(noiseTask.status).toBe("done");
    expect(noiseTask.resolution).toBe("dismissed");
    expect(noiseTask.triaged_by).toBe("server_ai");
    const noiseMsgs = noiseDetail.json.messages as Array<{ kind: string; author: string; body: string }>;
    expect(noiseMsgs.some((m) => m.kind === "comment" && m.author === "assistant")).toBe(true);
    expect(noiseMsgs.some((m) => m.body === "Server AI pre-screened as noise and archived")).toBe(true);

    // Operator comment recovers a dismissed task back to ready
    const recoverRes = await jsonReq(`${srv.url}/api/tasks/${noiseId}/messages`, "POST", {
      body: "其实需要查一下这个入口",
    });
    expect(recoverRes.json.reopened).toBe(true);
    expect((recoverRes.json.task as { status: string }).status).toBe("ready");

    // 2. Valid feedback via console -> auto-promoted to ready with suggested priority
    const validRes = await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
      title: "结账页点击提交后白屏",
      body: "在 Chrome 点击确认支付后控制台报 TypeError 并白屏",
      priority: "normal",
    });
    const validId = (validRes.json.task as { id: string }).id;

    await waitForCondition(async () => {
      const d = await jsonReq(`${srv.url}/api/tasks/${validId}`);
      return (d.json.task as { status: string }).status === "ready";
    });

    const validDetail = await jsonReq(`${srv.url}/api/tasks/${validId}`);
    const validTask = validDetail.json.task as Record<string, unknown>;
    expect(validTask.status).toBe("ready");
    expect(validTask.priority).toBe("high");
    expect(validTask.triaged_by).toBe("server_ai");

    // 3. LLM error -> fails open (remains in triage)
    const beforeErrCalls = callCount;
    const errRes = await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
      title: "Error case",
      body: "TRIGGER_ERROR real bug report",
      priority: "normal",
    });
    expect(errRes.status).toBe(200);
    const errId = (errRes.json.task as { id: string }).id;
    await waitForCondition(async () => callCount > beforeErrCalls);
    await new Promise((r) => setTimeout(r, 60));
    const errDetail = await jsonReq(`${srv.url}/api/tasks/${errId}`);
    expect((errDetail.json.task as { status: string }).status).toBe("triage");

    // 4. skip_prescreen: true does not invoke LLM
    const beforeSkipCalls = callCount;
    const skipRes = await jsonReq(`${srv.url}/api/projects/${project.id}/tasks`, "POST", {
      title: "Skipped prescreen",
      body: "这是一次测试",
      priority: "normal",
      skip_prescreen: true,
    });
    expect(skipRes.status).toBe(200);
    await new Promise((r) => setTimeout(r, 80));
    expect(callCount).toBe(beforeSkipCalls);
    const skipDetail = await jsonReq(`${srv.url}/api/tasks/${(skipRes.json.task as { id: string }).id}`);
    expect((skipDetail.json.task as { status: string }).status).toBe("triage");
  });
});
