import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveStoredAiConfig } from "../server/ai-config.ts";
import { runWidgetAgentStream, type WidgetChatMessage, type WidgetStreamEvent } from "../server/widget-agent.ts";
import { startRelaydeskServer, type RunningRelaydeskServer } from "../server.ts";
import {
  isSensitivePath,
  listRepoFiles,
  readRepoFile,
  searchRepoCode,
  type ReadyRepoRoot,
} from "../server/repo-workspace.ts";
import { detectImageMime, parseDataUrlImage, validateImageBuffer } from "../server/r2.ts";

// Minimal valid 1x1 PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

async function startTempRelaydesk(): Promise<{
  srv: RunningRelaydeskServer;
  dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "relaydesk-widget-test-"));
  const srv = await startRelaydeskServer({
    host: "127.0.0.1",
    port: 0,
    dbPath: join(dir, "relaydesk.sqlite3"),
    apiOnly: true,
  });
  cleanups.push(async () => {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { srv, dir };
}

async function startMockHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const close = () => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  cleanups.push(close);
  return { url: `http://127.0.0.1:${port}`, close };
}

describe("R2 image validation & upload API", () => {
  it("validates image magic bytes and rejects spoofed non-images", () => {
    expect(detectImageMime(TINY_PNG)).toBe("image/png");
    expect(validateImageBuffer(TINY_PNG, "image/png").mime).toBe("image/png");

    const spoofedHtml = Buffer.from("<html><script>alert(1)</script></html>");
    expect(detectImageMime(spoofedHtml)).toBeNull();
    expect(() => validateImageBuffer(spoofedHtml, "image/png")).toThrow();

    const parsed = parseDataUrlImage(
      `data:image/png;base64,${TINY_PNG.toString("base64")}`,
    );
    expect(parsed.mime).toBe("image/png");
    expect(parsed.buffer.equals(TINY_PNG)).toBe(true);
  });

  it("saves R2 config, tests write, uploads widget screenshot, and attaches to intake task", async () => {
    const uploaded: Array<{ method: string; url: string; auth: string; contentType: string; bytes: number }> = [];
    const mockS3 = await startMockHttpServer((req, res, body) => {
      uploaded.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: String(req.headers.authorization ?? ""),
        contentType: String(req.headers["content-type"] ?? ""),
        bytes: body.length,
      });
      res.statusCode = req.method === "DELETE" ? 204 : 200;
      res.end();
    });

    const { srv } = await startTempRelaydesk();
    const createRes = await fetch(`${srv.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Demo App",
        repos: ["acexiamo/demo-app"],
        allowed_origins: ["https://demo.acexiamo.com"],
      }),
    });
    expect(createRes.status).toBe(200);
    const { project } = (await createRes.json()) as {
      project: { id: string; intake_key: string; widget_code_context: boolean };
    };
    expect(project.widget_code_context).toBe(true);

    // Before R2 configured: widget-config reports upload_enabled: false
    const cfgBeforeRes = await fetch(`${srv.url}/api/projects/${project.id}/widget-config`, {
      headers: {
        Origin: "https://demo.acexiamo.com",
        Authorization: `Bearer ${project.intake_key}`,
      },
    });
    expect(cfgBeforeRes.status).toBe(200);
    const cfgBefore = (await cfgBeforeRes.json()) as {
      project_name: string;
      upload_enabled: boolean;
    };
    expect(cfgBefore.project_name).toBe("Demo App");
    expect(cfgBefore.upload_enabled).toBe(false);

    // Configure R2 pointing at our mock S3 server
    const saveR2 = await fetch(`${srv.url}/api/r2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: "acct123",
        bucket: "relaydesk",
        public_url: "https://relaydesk-r2.acexiamo.com",
        endpoint: mockS3.url,
        access_key_id: "AKIA_TEST_KEY",
        secret_access_key: "SECRET_TEST_VALUE",
      }),
    });
    expect(saveR2.status).toBe(200);
    const r2Status = (await saveR2.json()) as { configured: boolean; bucket: string };
    expect(r2Status.configured).toBe(true);
    expect(r2Status.bucket).toBe("relaydesk");

    // Test R2 connection (PUT + DELETE probe)
    const testR2 = await fetch(`${srv.url}/api/r2/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(testR2.status).toBe(200);
    expect(uploaded.some((u) => u.method === "PUT" && u.auth.startsWith("AWS4-HMAC-SHA256"))).toBe(
      true,
    );

    // Upload raw PNG screenshot via widget endpoint
    const uploadRes = await fetch(`${srv.url}/api/projects/${project.id}/uploads`, {
      method: "POST",
      headers: {
        Origin: "https://demo.acexiamo.com",
        Authorization: `Bearer ${project.intake_key}`,
        "Content-Type": "image/png",
      },
      body: TINY_PNG,
    });
    expect(uploadRes.status).toBe(200);
    expect(uploadRes.headers.get("access-control-allow-origin")).toBe("https://demo.acexiamo.com");
    const uploadJson = (await uploadRes.json()) as { url: string; key: string; size: number };
    expect(uploadJson.url).toMatch(/^https:\/\/relaydesk-r2\.acexiamo\.com\/uploads\/.+\.png$/);
    expect(uploadJson.size).toBe(TINY_PNG.length);

    // Submit intake with attachment -> embedded in task body Markdown
    const intakeRes = await fetch(`${srv.url}/api/projects/${project.id}/intake`, {
      method: "POST",
      headers: {
        Origin: "https://demo.acexiamo.com",
        Authorization: `Bearer ${project.intake_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "widget",
        title: "按钮样式错位",
        body: "点击保存按钮后弹出层位置偏移。",
        source_url: "https://demo.acexiamo.com/settings",
        attachments: [uploadJson.url],
        skip_prescreen: true,
      }),
    });
    expect(intakeRes.status).toBe(200);
    const intakeJson = (await intakeRes.json()) as { task_id: string };
    const detailRes = await fetch(`${srv.url}/api/tasks/${intakeJson.task_id}`);
    const detail = (await detailRes.json()) as { task: { body: string } };
    expect(detail.task.body).toContain(`![截图](${uploadJson.url})`);
  });
});

describe("Repo workspace read-only sandbox", () => {
  it("lists, searches, and reads safe files while blocking sensitive files and symlink escapes", async () => {
    const base = mkdtempSync(join(tmpdir(), "relaydesk-sandbox-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));

    const repoDir = join(base, "repo");
    const outsideSecret = join(base, "host-secret.txt");
    mkdirSync(join(repoDir, "docs"), { recursive: true });
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    writeFileSync(outsideSecret, "TOP_SECRET_HOST_DATA");
    writeFileSync(join(repoDir, ".env"), "FAKE_ENV_MARKER=DO_NOT_EXPOSE_12345");
    writeFileSync(join(repoDir, ".git", "config"), "[core]\n");
    writeFileSync(
      join(repoDir, "docs", "guide.md"),
      "# 使用指南\n\n点击右上角「导出 CSV」按钮即可下载报表。\n",
    );
    symlinkSync(outsideSecret, join(repoDir, "docs", "leak.txt"));

    const roots: ReadyRepoRoot[] = [
      { repo: "acexiamo/demo", dir: repoDir, realDir: realpathSync(repoDir), commit: "abc1234" },
    ];

    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".env.production")).toBe(true);
    expect(isSensitivePath(".git/config")).toBe(true);
    expect(isSensitivePath("config/secrets.json")).toBe(true);
    expect(isSensitivePath("docs/guide.md")).toBe(false);
    expect(isSensitivePath(".")).toBe(true);
    expect(isSensitivePath("./docs")).toBe(true);
    for (const dir of [".", "./", "./docs", " ././docs/ "]) {
      expect(listRepoFiles(roots, { dir }).entries).toContain("docs/guide.md");
    }

    const listed = listRepoFiles(roots, { max_depth: 3 });
    expect(listed.entries).toContain("docs/guide.md");
    expect(listed.entries.some((e) => e.includes(".env") || e.includes(".git") || e.includes("leak.txt"))).toBe(
      false,
    );

    const searched = await searchRepoCode(roots, { query: "导出 CSV" });
    expect(searched.matches.length).toBeGreaterThanOrEqual(1);
    expect(searched.matches[0]?.path).toBe("docs/guide.md");

    const envSearch = await searchRepoCode(roots, { query: "DO_NOT_EXPOSE_12345" });
    expect(envSearch.matches).toHaveLength(0);

    const safeRead = readRepoFile(roots, { path: "docs/guide.md", start_line: 1, end_line: 10 });
    expect(safeRead.error).toBeUndefined();
    expect(safeRead.content).toContain("导出 CSV");

    expect(readRepoFile(roots, { path: "./docs/guide.md" }).content).toBe(safeRead.content);
    symlinkSync(join(repoDir, "docs"), join(repoDir, "alias"));
    for (const path of [".env", "./.env", "../host-secret.txt", ".git/config", "docs/../.env", "docs/leak.txt", "alias/guide.md"]) {
      expect(readRepoFile(roots, { path })).toMatchObject({ content: "", error: expect.any(String) });
    }
    expect(listRepoFiles(roots, { dir: "alias" }).entries).toEqual([]);
  });
});

interface MockChatRequest {
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: unknown }>;
  max_tokens: number;
}

async function mockWidgetAgent(
  respond: (body: MockChatRequest, index: number, res: ServerResponse) => void,
  { withRepo = false, messages = [{ role: "user", text: "How do I export a report?" }] as WidgetChatMessage[] } = {},
) {
  const requests: MockChatRequest[] = [];
  const mock = await startMockHttpServer((_req, res, raw) => {
    const body = JSON.parse(raw.toString()) as MockChatRequest;
    requests.push(body);
    respond(body, requests.length - 1, res);
  });
  const dir = mkdtempSync(join(tmpdir(), "relaydesk-mock-agent-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "test.sqlite3");
  saveStoredAiConfig(dbPath, { base_url: mock.url, api_key: "", model: "local-mock", intake_enabled: true });
  const repo = "fixture/demo";
  if (withRepo) {
    const projectDir = join(dir, "repos", "demo");
    const repoDir = join(projectDir, "fixture__demo");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "guide.md"), "Use Export in Reports.");
    writeFileSync(join(projectDir, ".sync-meta.json"), JSON.stringify({ synced_at: new Date().toISOString() }));
  }
  const events: WidgetStreamEvent[] = [];
  await runWidgetAgentStream({
    dbPath,
    project: {
      id: "demo", name: "Demo", repo, repos: withRepo ? [repo] : [], widget_code_context: withRepo,
      agent_instructions: "", delivery_mode: "review_only", automation_paused: true,
    },
    messages,
    onEvent: (event) => events.push(event),
  });
  return { requests, events };
}

function sendCompletion(res: ServerResponse, delta: object, finishReason: string) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: finishReason }]) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, ...choice }] })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

describe("Widget agent with a local streaming model", () => {
  it("reserves the last step for a user-facing answer after repeated tool calls", async () => {
    const reply = "Use Export in Reports.";
    const { requests, events } = await mockWidgetAgent((body, i, res) => {
      const names = body.tools?.map((t) => t.function.name) ?? [];
      if (!names.length) return sendCompletion(res, { content: reply }, "stop");
      const name = names.includes("list_files") ? "list_files" : "propose_feedback_ticket";
      const args = name === "list_files" ? { dir: "." } : { title: "Export issue", summary: "Export failed", kind: "功能异常" };
      sendCompletion(res, { tool_calls: [{ index: 0, id: `call_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    }, { withRepo: true });
    expect(requests).toHaveLength(10);
    expect(requests.slice(0, 8).every((r) => r.tools?.some((t) => t.function.name === "list_files"))).toBe(true);
    expect(requests[8].tools?.map((t) => t.function.name)).toEqual(["propose_feedback_ticket"]);
    expect(requests[9].tools ?? []).toEqual([]);
    expect(requests.every((r) => r.max_tokens === 4096)).toBe(true);
    expect(events.slice(-2)).toEqual([{ type: "delta", text: reply }, { type: "done", ok: true }]);
  });

  it.each([true, false])("retries an empty length completion once (summary has text: %s)", async (hasText) => {
    const reply = "Which report are you exporting?";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { requests, events } = await mockWidgetAgent((_body, i, res) => {
        if (i === 1 && hasText) sendCompletion(res, { content: reply }, "stop");
        else sendCompletion(res, {}, "length");
      });
      expect(warn).toHaveBeenCalledWith("[widget-chat] empty stream output", {
        projectId: "demo", model: "local-mock", finishReason: "length", stepCount: 1,
      });
      expect(requests.map((r) => r.max_tokens)).toEqual([4096, 2048]);
      expect(requests[1].tools).toBeUndefined();
      expect(events.filter((event) => event.type !== "status")).toEqual(hasText
        ? [{ type: "delta", text: reply }, { type: "done", ok: true }]
        : [{ type: "error", error: "AI 助手未能生成有效回复，请重试或点击右上角「直接提单」。" }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("preserves lookup results for the no-tools summary", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { requests, events } = await mockWidgetAgent((_body, i, res) => {
        if (i === 0) {
          sendCompletion(res, { tool_calls: [{ index: 0, id: "lookup", type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "guide.md" }) } }] }, "tool_calls");
        } else if (i === 1) sendCompletion(res, {}, "length");
        else sendCompletion(res, { content: "Use Export in Reports." }, "stop");
      }, { withRepo: true });
      expect(requests).toHaveLength(3);
      expect(requests[2].tools).toBeUndefined();
      const toolResult = requests[2].messages.find((m) => m.role === "tool");
      expect(toolResult?.content).toContain("Use Export in Reports.");
      expect(events.at(-1)).toEqual({ type: "done", ok: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("retries a rejected file as text without exposing the provider error", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const url = "https://images.example.test/screenshot.png";
      const { requests, events } = await mockWidgetAgent((_body, i, res) => {
        if (i === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Unsupported file media type (private diagnostic)" } }));
        } else sendCompletion(res, { content: "Please describe the screenshot." }, "stop");
      }, { messages: [{ role: "user", text: "What happened?", attachments: [{ url }] }] });
      expect(requests).toHaveLength(2);
      expect(requests[1].messages.at(-1)?.content).toContain(url);
      expect(events.slice(-2)).toEqual([{ type: "delta", text: "Please describe the screenshot." }, { type: "done", ok: true }]);
      expect(errorLog.mock.calls).toEqual([["[widget-chat] stream error", {
        projectId: "demo", model: "local-mock", error: "Provider HTTP 400",
      }]]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("sends an image URL without the deprecated image content part", async () => {
    const url = "https://images.example.test/screenshot.WebP?width=400";
    const emitWarning = vi.spyOn(process, "emitWarning");
    try {
      const { requests, events } = await mockWidgetAgent((_body, _i, res) => {
        sendCompletion(res, { content: "I see the screenshot." }, "stop");
      }, { messages: [{ role: "user", text: "What happened?", attachments: [{ url }] }] });
      expect(requests).toHaveLength(1);
      expect(requests[0].messages.at(-1)?.content).toContainEqual({ type: "image_url", image_url: { url } });
      expect(JSON.stringify(emitWarning.mock.calls)).not.toContain("AISDK_DEP_IMAGE_CONTENT_PART");
      expect(events.at(-1)).toEqual({ type: "done", ok: true });
    } finally {
      emitWarning.mockRestore();
    }
  });
});

describe("Widget streaming chat endpoint", () => {
  it("streams graceful fallback + ticket_draft when workspace LLM is not configured", async () => {
    const { srv } = await startTempRelaydesk();
    const createRes = await fetch(`${srv.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Relaydesk Test",
        repos: ["acexiamo/relaydesk"],
      }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; intake_key: string };
    };

    const chatRes = await fetch(`${srv.url}/api/projects/${project.id}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${project.intake_key}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", text: "导出按钮点击后报错 500" }],
        page: { url: "https://app.example.com/reports", title: "报表" },
      }),
    });
    expect(chatRes.status).toBe(200);
    expect(chatRes.headers.get("content-type")).toContain("text/event-stream");
    const sseText = await chatRes.text();
    expect(sseText).toContain("event: delta");
    expect(sseText).toContain("event: ticket_draft");
    expect(sseText).toContain("功能异常");
    expect(sseText).toContain("event: done");
  });

  it("cancels the upstream model stream when the widget disconnects", async () => {
    let upstream: ServerResponse | undefined;
    const mock = await startMockHttpServer((_req, res) => {
      upstream = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
    });
    const { srv, dir } = await startTempRelaydesk();
    saveStoredAiConfig(join(dir, "relaydesk.sqlite3"), {
      base_url: mock.url, api_key: "", model: "local-mock", intake_enabled: true,
    });
    const createRes = await fetch(`${srv.url}/api/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Disconnect test", repos: ["fixture/demo"], widget_code_context: false }),
    });
    const { project } = await createRes.json() as { project: { id: string; intake_key: string } };
    const controller = new AbortController();
    try {
      const chat = await fetch(`${srv.url}/api/projects/${project.id}/chat`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${project.intake_key}` },
        body: JSON.stringify({ messages: [{ role: "user", text: "How do I export?" }] }),
      });
      expect(chat.status).toBe(200);
      await vi.waitFor(() => expect(upstream).toBeDefined());
      controller.abort();
      await vi.waitFor(() => expect(upstream?.destroyed).toBe(true));
    } finally {
      controller.abort();
      upstream?.end();
    }
  });

  it("toggles widget_code_context via PATCH /api/projects/:id", async () => {
    const { srv } = await startTempRelaydesk();
    const createRes = await fetch(`${srv.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Private Repo App",
        repos: ["acexiamo/private-app"],
      }),
    });
    const { project } = (await createRes.json()) as {
      project: { id: string; widget_code_context: boolean };
    };
    expect(project.widget_code_context).toBe(true);

    const patchRes = await fetch(`${srv.url}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widget_code_context: false }),
    });
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as {
      project: { widget_code_context: boolean };
    };
    expect(updated.project.widget_code_context).toBe(false);
  });
});
