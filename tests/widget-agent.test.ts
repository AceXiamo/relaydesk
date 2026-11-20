import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
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

    const blockedEnv = readRepoFile(roots, { path: ".env" });
    expect(blockedEnv.error).toBeTruthy();

    const blockedTraversal = readRepoFile(roots, { path: "../host-secret.txt" });
    expect(blockedTraversal.error).toBeTruthy();

    const blockedSymlink = readRepoFile(roots, { path: "docs/leak.txt" });
    expect(blockedSymlink.error).toBeTruthy();
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
