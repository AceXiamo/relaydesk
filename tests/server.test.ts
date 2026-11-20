import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { startRelaydeskServer, type RunningRelaydeskServer } from "../server.ts";
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
});
