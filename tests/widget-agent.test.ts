import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectCliConfiguration } from "../server/project-cli-config.ts";
import { projectPublicAiEnabled } from "../server/project-ai-provider.ts";
import { intakeReply, prescreenFeedback } from "../server/assistant.ts";
import type { AgentProjectInfo, TaskRecord } from "../app/lib/types.ts";
import {
  createWidgetTextStreamGuard,
  extractRecoveredTicketDraft,
  runWidgetAgentStream,
  type WidgetChatMessage,
  type WidgetStreamEvent,
  type WidgetTicketDraft,
} from "../server/widget-agent.ts";
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

const projectId = "f".repeat(32);
const projectKey = "fixture-provider-key";
const repoToken = "fixture-github-token";
const projectInfo: AgentProjectInfo = {
  id: projectId, name: "Demo", repo: "fixture/demo", repos: [], widget_code_context: false,
  agent_instructions: "", delivery_mode: "review_only", automation_paused: true,
  deploy_policy: {
    mode: "none",
    window_start: "02:00",
    window_end: "06:00",
    timezone: "Asia/Shanghai",
    allow_urgent_override: true,
    doc_path: "",
  },
};

function configureModel(dbPath: string, id = projectId, runtime: "claude" | "codex" = "claude") {
  projectCliConfiguration(dbPath, id, {
    runtime, public_ai_enabled: true, api_key: projectKey, github_token: repoToken,
  });
}

// Intercept only the exact production provider URL. Local app requests remain real.
function interceptModel(url: string, mockUrl: string) {
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const href = input instanceof Request ? input.url : String(input);
    if (href === url) {
      expect(init?.redirect).toBe("error");
      return realFetch(mockUrl + new URL(url).pathname, init);
    }
    if (new URL(href).hostname === "127.0.0.1") return realFetch(input, init);
    throw new Error("Unexpected network request in test");
  });
  cleanups.push(() => spy.mockRestore());
}

interface MockChatRequest {
  tools?: Array<{ name: string }>;
  system: unknown;
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
  configureModel(dbPath);
  interceptModel("https://api.anthropic.com/v1/messages", mock.url);
  const repo = "fixture/demo";
  if (withRepo) {
    const projectDir = join(dir, "repos", projectId);
    const repoDir = join(projectDir, "fixture__demo");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "guide.md"), "Use Export in Reports.");
    writeFileSync(join(projectDir, ".sync-meta.json"), JSON.stringify({ synced_at: new Date().toISOString() }));
  }
  const events: WidgetStreamEvent[] = [];
  await runWidgetAgentStream({
    dbPath,
    project: {
      ...projectInfo, repo, repos: withRepo ? [repo] : [], widget_code_context: withRepo,
    },
    messages,
    onEvent: (event) => events.push(event),
  });
  return { requests, events };
}

function sendMessageStream(res: ServerResponse, options: {
  text?: string | string[];
  tool?: { id: string; name: string; input: object };
  stopReason?: "max_tokens";
}) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const event = (type: string, data = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", { message: { role: "assistant", usage: { input_tokens: 5 } } });
  let index = 0;
  if (options.text) {
    event("content_block_start", { index, content_block: { type: "text", text: "" } });
    for (const text of [options.text].flat()) event("content_block_delta", { index, delta: { type: "text_delta", text } });
    event("content_block_stop", { index: index++ });
  }
  if (options.tool) {
    const { name, id, input } = options.tool;
    event("content_block_start", { index, content_block: { type: "tool_use", name, id, input: {} } });
    event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    event("content_block_stop", { index });
  }
  event("message_delta", { delta: { stop_reason: options.stopReason ?? (options.tool ? "tool_use" : "end_turn") }, usage: { output_tokens: 10 } });
  event("message_stop");
  res.end();
}

describe("Widget agent with a streaming Messages provider", () => {
  it("cuts off code lookup before the final step and uses a tool-free summary prompt after drafting", async () => {
    const reply = "Use Export in Reports.";
    const { requests, events } = await mockWidgetAgent((body, i, res) => {
      const names = body.tools?.map((t) => t.name) ?? [];
      if (!names.length) return sendMessageStream(res, { text: reply });
      const name = names.includes("list_files") ? "list_files" : "propose_feedback_ticket";
      const args = name === "list_files" ? { dir: "." } : { title: "Export issue", summary: "Export failed", kind: "功能异常" };
      sendMessageStream(res, { tool: { id: `call_${i}`, name, input: args } });
    }, { withRepo: true });
    expect(requests).toHaveLength(9);
    expect(requests[0].tools?.map(t => t.name).sort()).toEqual(["list_files", "propose_feedback_ticket", "read_file", "search_code"]);
    expect(JSON.stringify(requests)).not.toContain(repoToken);
    expect(requests.slice(0, 7).every((r) => r.tools?.some((t) => t.name === "list_files"))).toBe(true);
    expect(requests[7].tools?.map((t) => t.name)).toEqual(["propose_feedback_ticket"]);
    expect(JSON.stringify(requests[7].system)).toContain("代码查阅步数已达上限");
    expect(requests[8].tools ?? []).toEqual([]);
    expect(JSON.stringify(requests[8].system)).not.toContain("propose_feedback_ticket");
    expect(requests.every((r) => r.max_tokens === 4096)).toBe(true);
    expect(events.some((e) => e.type === "ticket_draft")).toBe(true);
    expect(events.slice(-2)).toEqual([{ type: "delta", text: reply }, { type: "done", ok: true }]);
  });

  it("suppresses leaked DSML tool-call markup from delta events and recovers ticket_draft", async () => {
    const leaked =
      "已完成代码核查，确认卡片在快照为空时缺少兜底提示。\n\n" +
      "<｜｜DSML｜｜ calls>\n" +
      "<｜｜DSML｜｜ invoke name=\"propose_feedback_ticket\">\n" +
      "<｜｜DSML｜｜ parameter name=\"title\" string=\"true\">历史排期调整审批卡缺少明细展示</｜｜DSML｜｜ parameter>\n" +
      "<｜｜DSML｜｜ parameter name=\"issue_type\" string=\"true\">功能缺失/体验问题</｜｜DSML｜｜ parameter>\n" +
      "<｜｜DSML｜｜ parameter name=\"description\" string=\"true\">审批中心卡片未展示调整前后排期明细。</｜｜DSML｜｜ parameter>\n" +
      "</｜｜DSML｜｜ invoke>\n" +
      "</｜｜DSML｜｜ calls>";
    const { events } = await mockWidgetAgent((_body, _i, res) => {
      sendMessageStream(res, { text: leaked.match(/[\s\S]{1,3}/g) ?? [] });
    });
    const combinedText = events
      .filter((e): e is Extract<WidgetStreamEvent, { type: "delta" }> => e.type === "delta")
      .map((e) => e.text)
      .join("");
    expect(combinedText).toContain("已完成代码核查");
    expect(combinedText).not.toContain("DSML");
    expect(combinedText).not.toContain("propose_feedback_ticket");
    const draftEvent = events.find(
      (e): e is Extract<WidgetStreamEvent, { type: "ticket_draft" }> => e.type === "ticket_draft",
    );
    expect(draftEvent?.draft).toMatchObject({
      title: "历史排期调整审批卡缺少明细展示",
      kind: "功能异常",
      summary: "审批中心卡片未展示调整前后排期明细。",
    });
    expect(events.at(-1)).toEqual({ type: "done", ok: true });
  });

  it("separates pre-tool narration and post-tool answer with a paragraph break", async () => {
    const { events } = await mockWidgetAgent((_body, i, res) => {
      if (i === 0) {
        sendMessageStream(res, { text: "我先查一下文档。", tool: { id: "call_0", name: "read_file", input: { path: "guide.md" } } });
      } else {
        sendMessageStream(res, { text: "在报表页点击 Export 即可导出。" });
      }
    }, { withRepo: true });
    const combinedText = events
      .filter((e): e is Extract<WidgetStreamEvent, { type: "delta" }> => e.type === "delta")
      .map((e) => e.text)
      .join("");
    expect(combinedText).toBe("我先查一下文档。\n\n在报表页点击 Export 即可导出。");
  });

  it("keeps ordinary angle brackets intact while guarding single-bar DSML blocks", () => {
    let out = "";
    const drafts: WidgetTicketDraft[] = [];
    const guard = createWidgetTextStreamGuard({
      onText: (t) => {
        out += t;
      },
      onRecoveredDraft: (d) => drafts.push(d),
    });
    const input =
      "当 count < 5 且标签为 <span> 时触发。\n" +
      "<｜DSML｜calls>\n" +
      "<｜DSML｜invoke name=\"propose_feedback_ticket\">\n" +
      "<｜DSML｜parameter name=\"title\" string=\"true\">优化筛选提示</｜DSML｜parameter>\n" +
      "<｜DSML｜parameter name=\"type\" string=\"true\">feature</｜DSML｜parameter>\n" +
      "<｜DSML｜parameter name=\"description\" string=\"true\">希望增加空状态提示\\n支持一键清空。</｜DSML｜parameter>\n" +
      "</｜DSML｜calls>\n" +
      "请核对下方工单。";
    for (let i = 0; i < input.length; i += 2) {
      guard.push(input.slice(i, i + 2));
    }
    guard.flush();
    expect(out).toBe("当 count < 5 且标签为 <span> 时触发。\n请核对下方工单。");
    expect(drafts).toEqual([
      {
        title: "优化筛选提示",
        kind: "改进建议",
        priority: "normal",
        summary: "希望增加空状态提示\n支持一键清空。",
      },
    ]);
    expect(extractRecoveredTicketDraft("<｜DSML｜calls><｜DSML｜invoke name=\"other\"></｜DSML｜calls>")).toBeNull();
  });

  it.each([true, false])("retries an empty length completion once (summary has text: %s)", async (hasText) => {
    const reply = "Which report are you exporting?";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { requests, events } = await mockWidgetAgent((_body, i, res) => {
        if (i === 1 && hasText) sendMessageStream(res, { text: reply });
        else sendMessageStream(res, { stopReason: "max_tokens" });
      });
      expect(warn).toHaveBeenCalledWith("[widget-chat] empty stream output", {
        projectId, model: "claude-sonnet-5-5", finishReason: "length", stepCount: 1,
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
          sendMessageStream(res, { tool: { id: "lookup", name: "read_file", input: { path: "guide.md" } } });
        } else if (i === 1) sendMessageStream(res, { stopReason: "max_tokens" });
        else sendMessageStream(res, { text: "Use Export in Reports." });
      }, { withRepo: true });
      expect(requests).toHaveLength(3);
      expect(requests[2].tools).toBeUndefined();
      expect(JSON.stringify(requests[2].messages)).toContain("Use Export in Reports.");
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
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Unsupported file media type (private diagnostic)" } }));
        } else sendMessageStream(res, { text: "Please describe the screenshot." });
      }, { messages: [{ role: "user", text: "What happened?", attachments: [{ url }] }] });
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].messages.at(-1)?.content)).toContain(url);
      expect(JSON.stringify(requests[1].messages.at(-1)?.content)).not.toContain('"type":"image"');
      expect(events.slice(-2)).toEqual([{ type: "delta", text: "Please describe the screenshot." }, { type: "done", ok: true }]);
      expect(errorLog.mock.calls).toEqual([["[widget-chat] stream error", {
        projectId, model: "claude-sonnet-5-5", error: "Provider HTTP 400",
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
        sendMessageStream(res, { text: "I see the screenshot." });
      }, { messages: [{ role: "user", text: "What happened?", attachments: [{ url }] }] });
      expect(requests).toHaveLength(1);
      expect(requests[0].messages.at(-1)?.content).toContainEqual({ type: "image", source: { type: "url", url } });
      expect(JSON.stringify(emitWarning.mock.calls)).not.toContain("AISDK_DEP_IMAGE_CONTENT_PART");
      expect(events.at(-1)).toEqual({ type: "done", ok: true });
    } finally {
      emitWarning.mockRestore();
    }
  });
});

describe("Project public model protocols and fallback", () => {
  function testDb() {
    const dir = mkdtempSync(join(tmpdir(), "relaydesk-public-ai-"));
    cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
    return join(dir, "test.sqlite3");
  }
  const task: TaskRecord = {
    id: "task", project_id: projectId, title: "Export", body: "Export failed", source: "widget", source_url: "",
    number: 1, requirements: "", priority: "normal", status: "triage", owner: "none", version: 1, attempts: 0,
    resolution: null, delivery_ref: "", triaged_by: "", merged_into: null,
    deploy_status: "not_required", deployed_at: null, release_id: null,
    created_at: "", updated_at: "", last_seen: null,
  };

  it.each(["codex", "claude"] as const)("uses the project's %s protocol for intake and prescreen without forwarding its settings", async (runtime) => {
    const dbPath = testDb();
    configureModel(dbPath, projectId, runtime);
    const codex = runtime === "codex";
    const defaultModel = codex ? "gpt-4.1-mini" : "claude-sonnet-5-5";
    const verdict = { verdict: "valid", reason: "Export failed", priority: "high" };
    const mock = vi.spyOn(globalThis, "fetch");
    cleanups.push(() => mock.mockRestore());
    for (const text of ["Which format?", JSON.stringify(verdict), "not-json"]) {
      mock.mockResolvedValueOnce(Response.json(codex
        ? { output: [{ type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text, annotations: [] }] }] }
        : { type: "message", content: [{ type: "text", text }], usage: { input_tokens: 3, output_tokens: 4 }, stop_reason: "end_turn" }));
    }
    expect(projectPublicAiEnabled(dbPath, projectId)).toBe(true);
    expect(await intakeReply(dbPath, projectId, task.body)).toBe("Which format?");
    projectCliConfiguration(dbPath, projectId, { model: "configured-model" });
    expect(await prescreenFeedback(dbPath, projectInfo, task)).toEqual(verdict);
    expect(await prescreenFeedback(dbPath, projectInfo, task)).toBeNull();
    expect(mock.mock.calls).toHaveLength(3);
    mock.mock.calls.forEach(([url, init], index) => {
      expect(String(url)).toBe(codex ? "https://api.openai.com/v1/responses" : "https://api.anthropic.com/v1/messages");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get(codex ? "authorization" : "x-api-key")).toBe(codex ? `Bearer ${projectKey}` : projectKey);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(index ? "configured-model" : defaultModel);
      expect(body[codex ? "input" : "messages"]).toBeInstanceOf(Array);
      expect(body.tools).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(projectKey);
      expect(JSON.stringify([body, [...headers]])).not.toContain(repoToken);
    });
  });

  it("streams the Codex widget over Responses with only the draft tool and no server-side screenshot download", async () => {
    const dbPath = testDb();
    configureModel(dbPath, projectId, "codex");
    const screenshot = "https://images.example.test/report.png";
    const frames = [
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "Use Export." },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1" } },
      { type: "response.completed", response: {} },
    ];
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(""), {
      headers: { "Content-Type": "text/event-stream" },
    }));
    cleanups.push(() => mock.mockRestore());
    const events: WidgetStreamEvent[] = [];
    await runWidgetAgentStream({ dbPath, project: projectInfo, messages: [{ role: "user", text: "Help?", attachments: [{ url: screenshot }] }], onEvent: e => events.push(e) });
    expect(events.slice(-2)).toEqual([{ type: "delta", text: "Use Export." }, { type: "done", ok: true }]);
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "gpt-4.1-mini", stream: true, store: false });
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["propose_feedback_ticket"]);
    expect(body.input.at(-1).content).toContainEqual({ type: "input_image", image_url: screenshot });
    expect(JSON.stringify([body, [...new Headers(init?.headers)]])).not.toContain(repoToken);
  });

  it.each([
    { public_ai_enabled: false, api_key: projectKey },
    { public_ai_enabled: true, api_key: "" },
    { public_ai_enabled: true, api_key: projectKey, endpoint: "https://gateway.example.test/v1" },
    { public_ai_enabled: true, api_key: projectKey, endpoint: "https://api.anthropic.com" },
  ])("falls back without DNS or HTTP for unavailable public configurations %#", async patch => {
    const dbPath = testDb();
    // A configured sibling project must never enable this one.
    configureModel(dbPath, "1".repeat(32));
    projectCliConfiguration(dbPath, projectId, { ...patch, runtime: "codex" });
    const mock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected request"));
    cleanups.push(() => mock.mockRestore());
    expect(projectPublicAiEnabled(dbPath, projectId)).toBe(false);
    expect(await intakeReply(dbPath, projectId, task.body)).toContain("最后做了哪一步");
    expect(await prescreenFeedback(dbPath, projectInfo, task)).toBeNull();
    const events: WidgetStreamEvent[] = [];
    await runWidgetAgentStream({ dbPath, project: projectInfo, messages: [{ role: "user", text: task.body }], onEvent: e => events.push(e) });
    expect(events.map(e => e.type)).toEqual(["delta", "ticket_draft", "done"]);
    expect(mock).not.toHaveBeenCalled();
  });

  it("does not follow provider redirects and keeps the intake and prescreen fallbacks", async () => {
    const dbPath = testDb();
    configureModel(dbPath, projectId, "codex");
    const paths: string[] = [];
    const mock = await startMockHttpServer((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(307, { Location: "/unexpected-destination" });
      res.end();
    });
    interceptModel("https://api.openai.com/v1/responses", mock.url);
    expect(await intakeReply(dbPath, projectId, task.body)).toContain("最后做了哪一步");
    expect(await prescreenFeedback(dbPath, projectInfo, task)).toBeNull();
    expect(paths).toEqual(["/v1/responses", "/v1/responses"]);
  });
});

describe("Widget streaming chat endpoint", () => {
  it("streams graceful fallback + ticket_draft when project public AI is not configured", async () => {
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
    const createRes = await fetch(`${srv.url}/api/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Disconnect test", repos: ["fixture/demo"], widget_code_context: false }),
    });
    const { project } = await createRes.json() as { project: { id: string; intake_key: string } };
    configureModel(join(dir, "relaydesk.sqlite3"), project.id);
    interceptModel("https://api.anthropic.com/v1/messages", mock.url);
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

  it("serves public widget illustration and logo assets with cross-origin headers", async () => {
    const { srv } = await startTempRelaydesk();
    const paths = [
      "/widget/logo.webp",
      "/widget/hero-dark.webp",
      "/widget/hero-light.webp",
      "/widget/illus-bug.webp",
      "/widget/illus-guide.webp",
      "/widget/illus-idea.webp",
      "/widget/illus-success.webp",
    ];
    for (const p of paths) {
      const res = await fetch(`${srv.url}${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("content-type"), p).toBe("image/webp");
      expect(res.headers.get("access-control-allow-origin"), p).toBe("*");
      expect(res.headers.get("cross-origin-resource-policy"), p).toBe("cross-origin");
      const bytes = await res.arrayBuffer();
      expect(bytes.byteLength, p).toBeGreaterThan(500);
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
