import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildWorkspaceFileUrl,
  formatMediaDuration,
  getWorkspaceInlineMime,
  getWorkspaceMediaKind,
} from "../app/lib/workspace-media.ts";
import { startRelaydeskServer, type RunningRelaydeskServer } from "../server.ts";

describe("Project Space & Web Codex Chat API", () => {
  let tmpDir: string;
  let srv: RunningRelaydeskServer;
  let projectId: string;
  let fakeCodexPath: string;
  const prevCodexBin = process.env.RELAYDESK_CODEX_BIN;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "relaydesk-ws-chat-"));
    fakeCodexPath = join(tmpDir, "fake-codex.mjs");
    writeFileSync(
      fakeCodexPath,
      `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const isResume = args.includes("resume");
const threadId = isResume ? args[args.length - 2] || "thread-resumed" : "thread-abc-123";
const hasHandbook = existsSync("HANDBOOK.md");
const hasSpec = existsSync("files/docs/spec.md");
const dbEnvKeys = Object.keys(process.env).filter((k) => k.startsWith("RELAYDESK_DB_")).sort();
const pgOptions = process.env.PGOPTIONS || "";
const codexHome = process.env.CODEX_HOME || "";
const leakedUrl = dbEnvKeys.length > 0 ? process.env[dbEnvKeys[0]] : "";
if (prompt.includes("EDIT_PROJECT_DOCS")) {
  writeFileSync("HANDBOOK.md", "# Cloud Edited Handbook\\n");
  writeFileSync("DEPLOY.md", "# Cloud Edited Deploy Doc\\n");
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });
emit({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "ls -la files" } });
emit({
  type: "item.completed",
  item: {
    id: "cmd-1",
    type: "command_execution",
    command: "ls -la files",
    aggregated_output: "docs\\ndatabases\\n" + (leakedUrl ? "LEAK:" + leakedUrl : ""),
    exit_code: 0,
  },
});
emit({
  type: "item.completed",
  item: {
    id: "msg-1",
    type: "agent_message",
    text: isResume
      ? "Resumed turn ok (args=" + args.join(" ") + ", promptLen=" + prompt.length + ")"
      : "Workspace ready: handbook=" +
        hasHandbook +
        ", spec=" +
        hasSpec +
        ", promptHasRef=" +
        prompt.includes("spec.md") +
        ", promptAllowsDocs=" +
        (prompt.includes("create or edit ./HANDBOOK.md, ./DEPLOY.md, and files under ./files/") &&
          prompt.includes("./DEPLOY.md")) +
        ", dbEnvs=" +
        dbEnvKeys.join(",") +
        ", pgOptions=" +
        pgOptions +
        ", codexHome=" +
        codexHome +
        ", args=" +
        args.join(" ") +
        (leakedUrl ? ", raw=" + leakedUrl : ""),
  },
});
`,
      { mode: 0o755 },
    );
    chmodSync(fakeCodexPath, 0o755);
    process.env.RELAYDESK_CODEX_BIN = fakeCodexPath;

    srv = await startRelaydeskServer({
      host: "127.0.0.1",
      port: 0,
      dbPath: join(tmpDir, "relaydesk.sqlite3"),
      apiOnly: true,
    });

    const created = await fetch(`${srv.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Workspace Demo", repo: "acme/demo" }),
    }).then((r) => r.json() as Promise<{ project: { id: string } }>);
    projectId = created.project.id;
  });

  afterAll(async () => {
    if (prevCodexBin === undefined) {
      delete process.env.RELAYDESK_CODEX_BIN;
    } else {
      process.env.RELAYDESK_CODEX_BIN = prevCodexBin;
    }
    await srv?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("manages workspace files, uploads, handbook, and rejects path traversal", async () => {
    // Reject traversal
    const badRes = await fetch(`${srv.url}/api/projects/${projectId}/workspace/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "../escape.txt", content: "nope" }),
    });
    expect(badRes.status).toBe(400);

    // Create text file
    const createRes = await fetch(`${srv.url}/api/projects/${projectId}/workspace/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "docs/spec.md", content: "# Spec\nHello Relaydesk" }),
    });
    expect(createRes.status).toBe(200);
    const createdJson = (await createRes.json()) as { file: { path: string; content: string } };
    expect(createdJson.file.path).toBe("docs/spec.md");
    expect(createdJson.file.content).toContain("Hello Relaydesk");

    // Upload raw binary file
    const binPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const uploadRes = await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/upload?path=${encodeURIComponent("assets/sample.png")}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: binPayload,
      },
    );
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as { file: { is_text: boolean; size: number } };
    expect(uploaded.file.is_text).toBe(false);
    expect(uploaded.file.size).toBe(binPayload.length);

    // List files
    const listRes = await fetch(`${srv.url}/api/projects/${projectId}/workspace/files`);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { files: Array<{ path: string }>; file_count: number };
    expect(listed.file_count).toBe(2);
    expect(listed.files.some((f) => f.path === "docs/spec.md")).toBe(true);
    expect(listed.files.some((f) => f.path === "assets/sample.png")).toBe(true);

    // Handbook read/write
    const hbSave = await fetch(`${srv.url}/api/projects/${projectId}/workspace/handbook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Handbook\nRun pnpm test" }),
    });
    expect(hbSave.status).toBe(200);
    const hbGet = await fetch(`${srv.url}/api/projects/${projectId}/workspace/handbook`).then(
      (r) => r.json() as Promise<{ handbook: { exists: boolean; content: string } }>,
    );
    expect(hbGet.handbook.exists).toBe(true);
    expect(hbGet.handbook.content).toContain("Run pnpm test");

    // Delete binary asset
    const delRes = await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/file?path=${encodeURIComponent("assets/sample.png")}`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(200);
  });

  it("creates SQLite databases, inspects schema, runs read-only queries, and masks external credentials", async () => {
    const createDb = await fetch(`${srv.url}/api/projects/${projectId}/workspace/databases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "sqlite_new",
        name: "metrics",
        init_sql:
          "CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, score INT); INSERT INTO events (kind, score) VALUES ('bug', 9), ('feat', 5);",
      }),
    });
    expect(createDb.status).toBe(200);
    const createdDb = (await createDb.json()) as {
      database: { id: string; table_count: number; queryable: boolean };
    };
    expect(createdDb.database.table_count).toBe(1);
    expect(createdDb.database.queryable).toBe(true);

    // Inspect schema
    const schemaRes = await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/databases/${encodeURIComponent(createdDb.database.id)}/schema`,
    );
    expect(schemaRes.status).toBe(200);
    const schemaJson = (await schemaRes.json()) as {
      schema: { tables: Array<{ name: string; row_count: number }> };
    };
    expect(schemaJson.schema.tables[0]?.name).toBe("events");
    expect(schemaJson.schema.tables[0]?.row_count).toBe(2);

    // Read-only SELECT works
    const queryRes = await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/databases/${encodeURIComponent(createdDb.database.id)}/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT kind, score FROM events ORDER BY score DESC;" }),
      },
    );
    expect(queryRes.status).toBe(200);
    const queryJson = (await queryRes.json()) as {
      result: { columns: string[]; rows: Array<{ kind: string; score: number }> };
    };
    expect(queryJson.result.columns).toEqual(["kind", "score"]);
    expect(queryJson.result.rows[0]).toEqual({ kind: "bug", score: 9 });

    // Destructive query rejected
    const badSql = await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/databases/${encodeURIComponent(createdDb.database.id)}/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "DELETE FROM events;" }),
      },
    );
    expect(badSql.status).toBe(400);

    // Add external datasource & verify secret URL is redacted
    const extRes = await fetch(`${srv.url}/api/projects/${projectId}/workspace/databases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "external",
        name: "Prod Readonly",
        kind: "postgres",
        connection_url: "postgresql://reader:supersecretpassword@db.internal.example:5432/prod",
        notes: "Contains users and billing tables",
      }),
    });
    expect(extRes.status).toBe(200);
    const listDbs = await fetch(`${srv.url}/api/projects/${projectId}/workspace/databases`).then(
      (r) => r.json() as Promise<{ databases: Array<Record<string, unknown>> }>,
    );
    const extEntry = listDbs.databases.find((d) => d.name === "Prod Readonly");
    expect(extEntry).toBeDefined();
    expect(extEntry?.host_preview).toBe("postgresql://db.internal.example:5432/prod");
    expect(JSON.stringify(extEntry)).not.toContain("supersecretpassword");
  });

  it("streams web Codex chat turns with workspace context and multi-turn resume", async () => {
    const rt = await fetch(`${srv.url}/api/projects/${projectId}/codex-chat/runtime`).then(
      (r) => r.json() as Promise<{ local_clis: { codex: boolean } }>,
    );
    expect(rt.local_clis.codex).toBe(true);

    // Create session
    const created = await fetch(`${srv.url}/api/projects/${projectId}/codex-chat/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "codex", sandbox_mode: "read-only" }),
    }).then((r) => r.json() as Promise<{ session: { id: string } }>);
    const sessionId = created.session.id;

    // First turn (SSE)
    const turn1Res = await fetch(
      `${srv.url}/api/projects/${projectId}/codex-chat/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Inspect the workspace spec",
          attachments: [{ kind: "file", label: "docs/spec.md", ref: "docs/spec.md" }],
        }),
      },
    );
    expect(turn1Res.status).toBe(200);
    const turn1Text = await turn1Res.text();
    expect(turn1Text).toContain("event: tool");
    expect(turn1Text).toContain("Workspace ready: handbook=true, spec=true, promptHasRef=true");
    expect(turn1Text).toContain("event: done");

    // Verify persisted session got external_session_id and auto-title
    const detail1 = await fetch(
      `${srv.url}/api/projects/${projectId}/codex-chat/sessions/${sessionId}`,
    ).then(
      (r) =>
        r.json() as Promise<{
          session: { external_session_id: string; title: string };
          messages: Array<{ role: string; content: string; events: unknown[] }>;
        }>,
    );
    expect(detail1.session.external_session_id).toBe("thread-abc-123");
    expect(detail1.session.title).toBe("Inspect the workspace spec");
    expect(detail1.messages.length).toBe(2);
    expect(detail1.messages[1].events.length).toBe(1);

    // Second turn resumes thread
    const turn2Res = await fetch(
      `${srv.url}/api/projects/${projectId}/codex-chat/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Follow up question" }),
      },
    );
    expect(turn2Res.status).toBe(200);
    const turn2Text = await turn2Res.text();
    expect(turn2Text).toContain("Resumed turn ok");
    expect(turn2Text).toContain("thread-abc-123");

    // Delete session
    const delRes = await fetch(
      `${srv.url}/api/projects/${projectId}/codex-chat/sessions/${sessionId}`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(200);
  });

  it("injects external datasource env vars, enforces PG read-only, redacts secrets, and toggles Codex network access", async () => {
    const listDbs = await fetch(`${srv.url}/api/projects/${projectId}/workspace/databases`).then(
      (r) =>
        r.json() as Promise<{
          databases: Array<{ id: string; name: string; env_var?: string; read_only: boolean }>;
          clients: Array<{ id: string; installed: boolean }>;
        }>,
    );
    expect(Array.isArray(listDbs.clients)).toBe(true);
    expect(listDbs.clients.some((c) => c.id === "psql")).toBe(true);

    const extEntry = listDbs.databases.find((d) => d.name === "Prod Readonly");
    expect(extEntry).toBeDefined();
    expect(extEntry?.env_var).toBe("RELAYDESK_DB_PROD_READONLY");

    // Update external datasource metadata while preserving existing secret URL
    const patchDbRes = await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/databases/${encodeURIComponent(extEntry!.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          env_var: "RELAYDESK_DB_ANALYTICS",
          notes: "Updated schema notes",
        }),
      },
    );
    expect(patchDbRes.status).toBe(200);
    const patchedDb = (await patchDbRes.json()) as {
      database: { env_var: string; has_connection_url: boolean; notes: string };
    };
    expect(patchedDb.database.env_var).toBe("RELAYDESK_DB_ANALYTICS");
    expect(patchedDb.database.has_connection_url).toBe(true);
    expect(patchedDb.database.notes).toBe("Updated schema notes");

    // Create a session with network_access enabled
    const created = await fetch(`${srv.url}/api/projects/${projectId}/codex-chat/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runtime: "codex",
        sandbox_mode: "read-only",
        network_access: true,
      }),
    }).then((r) => r.json() as Promise<{ session: { id: string; network_access: boolean } }>);
    expect(created.session.network_access).toBe(true);
    const sessionId = created.session.id;

    // Run turn and check env injection, PGOPTIONS, network_access flag, and secret redaction
    const turnRes = await fetch(
      `${srv.url}/api/projects/${projectId}/codex-chat/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Check external postgres datasource" }),
      },
    );
    expect(turnRes.status).toBe(200);
    const sseText = await turnRes.text();
    expect(sseText).toContain("dbEnvs=RELAYDESK_DB_ANALYTICS");
    expect(sseText).toContain("pgOptions=-c default_transaction_read_only=on");
    expect(sseText).toContain("sandbox_workspace_write.network_access=true");
    expect(sseText).toContain("--sandbox workspace-write");
    expect(sseText).toContain("[redacted]");
    expect(sseText).not.toContain("db.internal.example:5432/prod");

    // Toggling network_access off invalidates external_session_id
    const toggleRes = await fetch(
      `${srv.url}/api/projects/${projectId}/codex-chat/sessions/${sessionId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network_access: false }),
      },
    );
    expect(toggleRes.status).toBe(200);
    const toggled = (await toggleRes.json()) as {
      session: { network_access: boolean; external_session_id: string };
    };
    expect(toggled.session.network_access).toBe(false);
    expect(toggled.session.external_session_id).toBe("");
  });

  it("bootstraps writable CLI HOME/CODEX_HOME and enables legacy Landlock when configured", async () => {
    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevLegacy = process.env.RELAYDESK_CODEX_LEGACY_LANDLOCK;
    const customHome = join(tmpDir, "container-cli-home");

    process.env.HOME = customHome;
    delete process.env.CODEX_HOME;
    process.env.RELAYDESK_CODEX_LEGACY_LANDLOCK = "1";

    try {
      const created = await fetch(`${srv.url}/api/projects/${projectId}/codex-chat/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtime: "codex", sandbox_mode: "read-only" }),
      }).then((r) => r.json() as Promise<{ session: { id: string } }>);

      const turnRes = await fetch(
        `${srv.url}/api/projects/${projectId}/codex-chat/sessions/${created.session.id}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Check container sandbox flags" }),
        },
      );
      expect(turnRes.status).toBe(200);
      const sseText = await turnRes.text();
      expect(sseText).toContain("features.use_legacy_landlock=true");
      expect(sseText).toContain("/container-cli-home/.codex");
      expect(existsSync(join(customHome, ".codex"))).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      if (prevLegacy === undefined) delete process.env.RELAYDESK_CODEX_LEGACY_LANDLOCK;
      else process.env.RELAYDESK_CODEX_LEGACY_LANDLOCK = prevLegacy;
    }
  });

  it("defaults new chat sessions to workspace-write with network enabled and persists HANDBOOK.md/DEPLOY.md edits", async () => {
    const defaultRes = await fetch(`${srv.url}/api/projects/${projectId}/codex-chat/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "codex" }),
    });
    expect(defaultRes.status).toBe(200);
    const { session: defaultSession } = (await defaultRes.json()) as {
      session: { id: string; sandbox_mode: string; network_access: boolean };
    };
    expect(defaultSession.sandbox_mode).toBe("workspace-write");
    expect(defaultSession.network_access).toBe(true);

    const turnRes = await fetch(
      `${srv.url}/api/projects/${projectId}/codex-chat/sessions/${defaultSession.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "EDIT_PROJECT_DOCS" }),
      },
    );
    expect(turnRes.status).toBe(200);
    const sseText = await turnRes.text();
    expect(sseText).toContain("promptAllowsDocs=true");
    expect(sseText).toContain("--sandbox workspace-write");
    expect(sseText).toContain("sandbox_workspace_write.network_access=true");

    const handbookRes = await fetch(`${srv.url}/api/projects/${projectId}/workspace/handbook`).then(
      (r) => r.json() as Promise<{ handbook: { exists: boolean; content: string } }>,
    );
    expect(handbookRes.handbook).toMatchObject({ exists: true, content: "# Cloud Edited Handbook\n" });

    const deployRes = await fetch(`${srv.url}/api/projects/${projectId}/workspace/deploy-doc`).then(
      (r) => r.json() as Promise<{ deploy_doc: { exists: boolean; content: string } }>,
    );
    expect(deployRes.deploy_doc).toMatchObject({ exists: true, content: "# Cloud Edited Deploy Doc\n" });

    // Explicit read-only and offline overrides remain honored
    const restrictedRes = await fetch(`${srv.url}/api/projects/${projectId}/codex-chat/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "codex", sandbox_mode: "read-only", network_access: false }),
    });
    expect(restrictedRes.status).toBe(200);
    const { session: restrictedSession } = (await restrictedRes.json()) as {
      session: { sandbox_mode: string; network_access: boolean };
    };
    expect(restrictedSession.sandbox_mode).toBe("read-only");
    expect(restrictedSession.network_access).toBe(false);
  });

  it("streams inline media with MIME/CSP headers, Range 206/416, ETag 304, HEAD, and caps large text reads", async () => {
    expect(getWorkspaceMediaKind(".png")).toBe("image");
    expect(getWorkspaceMediaKind("MP4")).toBe("video");
    expect(getWorkspaceMediaKind(".m4a")).toBe("audio");
    expect(getWorkspaceMediaKind(".pdf")).toBe("pdf");
    expect(getWorkspaceMediaKind(".txt")).toBeNull();
    expect(getWorkspaceInlineMime(".html")).toBeUndefined();
    expect(formatMediaDuration(3665)).toBe("1:01:05");
    expect(buildWorkspaceFileUrl("proj_1", "a/b.png", "inline", "v1")).toContain("&inline=1&v=v1");

    // Upload a 16-byte video stub
    const videoBytes = Buffer.from("0123456789abcdef", "utf8");
    const upVid = await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/upload?path=${encodeURIComponent("media/demo.mp4")}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: videoBytes },
    );
    expect(upVid.status).toBe(200);
    const upVidJson = (await upVid.json()) as { file: { is_text: boolean; size: number } };
    expect(upVidJson.file.is_text).toBe(false);
    expect(upVidJson.file.size).toBe(16);

    // Inline full fetch with ETag & Range capability headers
    const inlineUrl = `${srv.url}/api/projects/${projectId}/workspace/file?path=${encodeURIComponent("media/demo.mp4")}&inline=1`;
    const fullRes = await fetch(inlineUrl);
    expect(fullRes.status).toBe(200);
    expect(fullRes.headers.get("content-type")).toBe("video/mp4");
    expect(fullRes.headers.get("accept-ranges")).toBe("bytes");
    expect(fullRes.headers.get("content-disposition")).toContain("inline;");
    const etag = fullRes.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(await fullRes.text()).toBe("0123456789abcdef");

    // Conditional ETag -> 304 Not Modified
    const cachedRes = await fetch(inlineUrl, { headers: { "If-None-Match": etag! } });
    expect(cachedRes.status).toBe(304);
    expect(await cachedRes.text()).toBe("");

    // HEAD request
    const headRes = await fetch(inlineUrl, { method: "HEAD" });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("content-length")).toBe("16");
    expect(await headRes.text()).toBe("");

    // Range requests: explicit, open-ended, suffix, and out-of-range
    const r1 = await fetch(inlineUrl, { headers: { Range: "bytes=2-5" } });
    expect(r1.status).toBe(206);
    expect(r1.headers.get("content-range")).toBe("bytes 2-5/16");
    expect(r1.headers.get("content-length")).toBe("4");
    expect(await r1.text()).toBe("2345");

    const r2 = await fetch(inlineUrl, { headers: { Range: "bytes=12-" } });
    expect(r2.status).toBe(206);
    expect(r2.headers.get("content-range")).toBe("bytes 12-15/16");
    expect(await r2.text()).toBe("cdef");

    const r3 = await fetch(inlineUrl, { headers: { Range: "bytes=-3" } });
    expect(r3.status).toBe(206);
    expect(r3.headers.get("content-range")).toBe("bytes 13-15/16");
    expect(await r3.text()).toBe("def");

    const rBad = await fetch(inlineUrl, { headers: { Range: "bytes=99-120" } });
    expect(rBad.status).toBe(416);
    expect(rBad.headers.get("content-range")).toBe("bytes */16");

    // Audio, PDF, and SVG security headers; HTML must never be served inline
    await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/upload?path=${encodeURIComponent("media/clip.mp3")}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("ID3test") },
    );
    const audioRes = await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/file?path=${encodeURIComponent("media/clip.mp3")}&inline=1`,
    );
    expect(audioRes.headers.get("content-type")).toBe("audio/mpeg");

    await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/upload?path=${encodeURIComponent("media/doc.pdf")}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("%PDF-1.4") },
    );
    const pdfRes = await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/file?path=${encodeURIComponent("media/doc.pdf")}&inline=1`,
    );
    expect(pdfRes.headers.get("content-type")).toBe("application/pdf");
    expect(pdfRes.headers.get("x-frame-options")).toBe("SAMEORIGIN");

    const svgSave = await fetch(`${srv.url}/api/projects/${projectId}/workspace/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "media/icon.svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" }),
    });
    expect(svgSave.status).toBe(200);
    expect(((await svgSave.json()) as { file: { is_text: boolean } }).file.is_text).toBe(true);
    const svgRes = await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/file?path=${encodeURIComponent("media/icon.svg")}&inline=1`,
    );
    expect(svgRes.headers.get("content-type")).toBe("image/svg+xml");
    expect(svgRes.headers.get("content-security-policy")).toContain("sandbox");

    await fetch(`${srv.url}/api/projects/${projectId}/workspace/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/page.html", content: "<script>alert(1)</script>" }),
    });
    const htmlRes = await fetch(
      `${srv.url}/api/projects/${projectId}/workspace/file?path=${encodeURIComponent("notes/page.html")}&inline=1`,
    );
    expect(htmlRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(htmlRes.headers.get("content-disposition")).toContain("attachment;");

    // Large text file is truncated to 512 KiB
    const bigText = "A".repeat(600 * 1024);
    const bigRes = await fetch(`${srv.url}/api/projects/${projectId}/workspace/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/large.txt", content: bigText }),
    });
    expect(bigRes.status).toBe(200);
    const bigJson = (await bigRes.json()) as {
      file: { is_text: boolean; truncated: boolean; size: number; content: string };
    };
    expect(bigJson.file.is_text).toBe(true);
    expect(bigJson.file.truncated).toBe(true);
    expect(bigJson.file.size).toBe(600 * 1024);
    expect(bigJson.file.content.length).toBe(512 * 1024);
  });
});
