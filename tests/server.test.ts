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
