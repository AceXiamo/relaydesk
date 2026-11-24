import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as r2 from "../server/r2.ts";
import { writeWorkspaceDeployDoc } from "../server/workspace.ts";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startRelaydeskServer,
  type RunningRelaydeskServer,
} from "../server.ts";

const admin = { Authorization: "Bearer fixture-operator" };
let srv: RunningRelaydeskServer,
  dir: string,
  project: string,
  base: string,
  intake: string;
async function call(
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
  data?: unknown,
) {
  const res = await fetch(new URL(url, srv.url), {
    method,
    headers: {
      ...headers,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    redirect: "manual",
  });
  return { res, json: await res.json().catch(() => null) };
}
async function link(data: Record<string, unknown> = {}) {
  const r = await call(base + "/portal-links", "POST", admin, {
    label: "测试组",
    ...data,
  });
  expect(r.res.status).toBe(200);
  return r.json as { id: string; url: string };
}
async function redeem(url: string, cookie = "") {
  const { res } = await call(url, "GET", {
    Cookie: cookie,
    "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/140 Safari/537.36",
  });
  return {
    res,
    cookie: res.headers.get("Set-Cookie")?.split(";")[0] || "",
    location: res.headers.get("location"),
  };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rd-portal-"));
  srv = await startRelaydeskServer({
    port: 0,
    dbPath: join(dir, "fixture.sqlite"),
    apiOnly: true,
    adminToken: admin.Authorization.slice(7),
  });
  const p = srv.store.createProject({
    name: "Feedback",
    repo: "fixture/feedback",
    allowed_origins: ["https://widget.example"],
  });
  srv.store.updateProject(p.id, { automation_paused: true });
  project = p.id;
  intake = p.intake_key;
  base = `/api/projects/${project}`;
});
afterEach(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("feedback access links over HTTP", () => {
  it("exchanges one secret for an isolated HttpOnly cookie before rendering and enforces a live device cap", async () => {
    expect((await call(base + "/portal-links")).res.status).toBe(401);
    expect(
      (
        await call(base + "/portal-links", "POST", admin, {
          label: "test",
          max_devices: 0,
        })
      ).res.status,
    ).toBe(400);
    const l = await link({ max_devices: 1 });
    const attempts = await Promise.all([redeem(l.url), redeem(l.url)]);
    const ok = attempts.find((a) => a.cookie)!;
    expect(ok.location).toBe(`/p/${project}`);
    expect(ok.res.status).toBe(302);
    expect(ok.res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
    expect(ok.res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(attempts.find((a) => !a.cookie)?.location).toBe(
      `/p/${project}?error=device_limit`,
    );
    expect((await redeem(l.url, ok.cookie)).location).toBe(ok.location);
    const h = {
      Cookie: ok.cookie,
      "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/140 Safari/537.36",
    };
    expect((await call(base + "/portal/config", "GET", h)).json).toMatchObject({
      label: "测试组",
      can_view_team: false,
      can_request_deploy: false,
    });
    expect(
      (await call(base + "/portal/tasks?scope=team", "GET", h)).res.status,
    ).toBe(403);
    expect((await call(base + "/portal-links", "GET", h)).res.status).toBe(401);
    const token = new URL(l.url, srv.url).searchParams.get("token")!;
    const rows = (await call(base + "/portal-links", "GET", admin)).json.links;
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain("session_hash");
    expect(rows[0].devices).toHaveLength(1);
    expect(rows[0].devices[0].device_label).toBe("macOS · Chrome");
    expect(
      (
        await call(`${base}/portal-links/${l.id}`, "PATCH", admin, {
          can_view_team: true,
        })
      ).res.status,
    ).toBe(200);
    expect(
      (await call(base + "/portal/config", "GET", h)).json.can_view_team,
    ).toBe(true);
    expect(
      (
        await call(
          `${base}/portal-links/${l.id}/devices/${rows[0].devices[0].id}`,
          "DELETE",
          admin,
        )
      ).res.status,
    ).toBe(200);
    expect((await call(base + "/portal/config", "GET", h)).json.code).toBe(
      "removed_device",
    );
    expect((await redeem(l.url, ok.cookie)).location).toContain(
      "error=removed_device",
    );
    const other = await redeem(l.url);
    expect(other.cookie).toBeTruthy();
    expect(
      (await call(`${base}/portal-links/${l.id}`, "DELETE", admin)).res.status,
    ).toBe(200);
    expect(
      (await call(base + "/portal/config", "GET", { Cookie: other.cookie }))
        .json.code,
    ).toBe("revoked_link");
    expect((await redeem(l.url)).location).toContain("error=revoked_link");
  });
  it("rejects expired, invalid, anonymous, cross-project, and cross-origin access", async () => {
    const l = await link();
    const { cookie } = await redeem(l.url);
    const other = srv.store.createProject({
      name: "Other",
      repo: "fixture/other",
    });
    expect((await redeem(l.url.replace(project, other.id))).location).toContain(
      "error=invalid_link",
    );
    expect(
      (
        await call(`/api/projects/${other.id}/portal/config`, "GET", {
          Cookie: cookie,
        })
      ).res.status,
    ).toBe(401);
    expect((await call(base + "/portal/config")).json.code).toBe(
      "missing_session",
    );
    expect(
      (
        await call(
          base + "/portal/tasks",
          "POST",
          { Cookie: cookie, Origin: "https://foreign.example" },
          { body: "test" },
        )
      ).res.status,
    ).toBe(403);
    srv.store.db
      .prepare("UPDATE portal_access_links SET expires_at=? WHERE id=?")
      .run("2001-01-01T00:00:00Z", l.id);
    expect(
      (await call(base + "/portal/config", "GET", { Cookie: cookie })).json
        .code,
    ).toBe("expired_link");
    expect((await redeem(l.url)).location).toContain("error=expired_link");
  });
  it("keeps link ownership across devices, team read-only, and internal messages private", async () => {
    const own = await link(),
      { cookie } = await redeem(own.url),
      h = { Cookie: cookie };
    const owner2 = { Cookie: (await redeem(own.url)).cookie };
    const team = {
      Cookie: (await redeem((await link({ can_view_team: true })).url)).cookie,
    };
    const submitted = await call(base + "/portal/tasks", "POST", h, {
      title: "按钮没有响应",
      body: "点击保存后没有变化",
      type: "bug",
      images: [],
    });
    expect(submitted.res.status).toBe(200);
    const id = submitted.json.task.id,
      url = base + "/portal/tasks/" + id;
    expect(
      (await call(base + "/portal/tasks", "GET", owner2)).json.tasks.map(
        (t: { id: string }) => t.id,
      ),
    ).toContain(id);
    expect(
      (
        await call(base + "/portal/tasks?scope=team", "GET", team)
      ).json.tasks.map((t: { id: string }) => t.id),
    ).toContain(id);
    expect(
      (await call(url + "/reply", "POST", team, { body: "不是我的反馈" })).res
        .status,
    ).not.toBe(200);
    expect(
      (
        await call(`/api/tasks/${id}/messages`, "POST", admin, {
          body: "internal-only-diagnostic",
          reopen: false,
          public_question: "steps",
        })
      ).res.status,
    ).toBe(200);
    const detail = (await call(url, "GET", h)).json;
    expect(JSON.stringify(detail)).not.toContain("internal-only-diagnostic");
    expect(detail.task.can_reply).toBe(true);
    expect(
      (await call(url + "/reply", "POST", owner2, { body: "刷新后仍然出现" }))
        .res.status,
    ).toBe(200);
    expect(srv.store.getTaskRow(id).status).toBe("ready");
    expect(detail.messages.length).toBeGreaterThan(0);
    const list = (await call(base + "/portal-links", "GET", admin)).json.links;
    expect(
      list
        .find((r: { id: string }) => r.id === own.id)
        .devices.map((d: { ticket_count: number }) => d.ticket_count)
        .sort(),
    ).toEqual([0, 1]);
    expect(
      (await call(url + "/deploy-request", "POST", h, {})).res.status,
    ).not.toBe(200);
    expect(
      (await call(url + "/accept", "POST", h, { resolved: true })).res.status,
    ).not.toBe(200);
    srv.store.db
      .prepare(
        "UPDATE tasks SET status='done',owner='none',deploy_status='deployed',deployed_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), id);
    expect(
      (await call(url + "/accept", "POST", h, { resolved: true })).json.task
        .status_label,
    ).toBe("已确认解决");
    expect(
      (await call(url + "/accept", "POST", h, { resolved: true })).res.status,
    ).toBe(409);
  });
  it("revalidates authorization after an in-flight submission finishes buffering", async () => {
    const l = await link();
    const { cookie } = await redeem(l.url);
    const receiving = once(srv.server, "request");
    const req = request(srv.url + base + "/portal/tasks", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const response = once(req, "response");
    req.write('{"title":"First half",');
    await receiving;
    await call(base + "/portal-links/" + l.id, "DELETE", admin);
    req.end('"body":"Second half"}');
    const [res] = await response;
    res.resume();
    expect(res.statusCode).toBe(401);
    expect(srv.store.listTasks(project)).toHaveLength(0);
  });
  it("permits clarification and image uploads only while the device is authorized", async () => {
    const l = await link(),
      h = { Cookie: (await redeem(l.url)).cookie };
    const url = `https://assets.example/uploads/${project}/example.png`;
    const upload = vi.spyOn(r2, "uploadProjectImage").mockResolvedValue({
      url,
      key: "fixture",
      size: 4,
      content_type: "image/png",
    });
    try {
      const send = () =>
        fetch(srv.url + base + "/portal/uploads", {
          method: "POST",
          headers: { ...h, "Content-Type": "image/png" },
          body: Buffer.from([137, 80, 78, 71]),
        });
      expect((await (await send()).json()).url).toBe(url);
      expect(upload).toHaveBeenCalledOnce();
      const { json } = await call(base + "/portal/tasks", "POST", h, {
        title: "附图",
        body: "无法保存",
        images: [url],
      });
      expect(srv.store.getTaskRow(json.task.id).body).toContain(url);
      expect(
        (await call(base + "/portal/clarify", "POST", h, { body: "无法保存" }))
          .json.reply,
      ).toBeTruthy();
      await call(base + "/portal-links/" + l.id, "DELETE", admin);
      expect((await send()).status).toBe(401);
      expect(upload).toHaveBeenCalledOnce();
    } finally {
      upload.mockRestore();
    }
  });
  it("publishes a sanitized gate verdict and keeps the review record operator-only", async () => {
    // Manual policy cannot start a release on its own. No remote commands or model calls in this fixture.
    writeWorkspaceDeployDoc(
      srv.store.dbPath,
      project,
      "# Fixture runbook\nNo traffic contract.",
    );
    srv.store.updateProject(project, { automation_paused: false });
    srv.store.updateProjectDeployPolicy(project, {
      mode: "manual",
      allow_ai_immediate_deploy: true,
    });
    const h = { Cookie: (await redeem((await link()).url)).cookie };
    expect(
      (await call(base + "/portal/config", "GET", h)).json.can_request_deploy,
    ).toBe(true);
    const { json } = await call(base + "/portal/tasks", "POST", h, {
      title: "调整间距",
      body: "缩小空白",
    });
    const id = json.task.id,
      url = base + "/portal/tasks/" + id;
    srv.store.db
      .prepare(
        "UPDATE tasks SET status='done', deploy_status='pending', owner='none' WHERE id=?",
      )
      .run(id);
    expect(
      (await call(url + "/deploy-request", "POST", h, { reason: "希望提前" }))
        .json.gate.status,
    ).toBe("evaluating");
    const { gate } = (await call(url, "GET", h)).json;
    expect(gate.status).toBe("escalated");
    expect(gate).not.toHaveProperty("internal_evidence");
    expect((await call(base + "/deploy-gates", "GET", h)).res.status).toBe(401);
    expect(
      (await call(base + "/deploy-gates", "GET", admin)).json.evaluations[0]
        .status,
    ).toBe("escalated");
    expect(
      (await call(url + "/deploy-request", "POST", h, {})).res.status,
    ).toBe(429);
  });
  it("keeps widget intake compatible without granting history by ticket number or project key", async () => {
    const h = {
      Authorization: `Bearer ${intake}`,
      Origin: "https://widget.example",
    };
    const visitor = { ...h, "X-Visitor-Id": randomUUID() };
    const cfg = (await call(base + "/widget-config", "GET", h)).json;
    expect(cfg).toMatchObject({
      tracking_enabled: true,
      can_request_deploy: false,
    });
    const data = {
      source: "widget",
      body: "提供详细问题信息",
      title: "更新主页",
    };
    expect((await call(base + "/intake", "POST", h, data)).res.status).toBe(
      200,
    );
    const tracked = await call(base + "/intake", "POST", visitor, data);
    expect(tracked.res.status).toBe(200);
    const id = tracked.json.task_id;
    const url = base + "/widget-feedback/tasks";
    expect(
      (await call(url, "OPTIONS", h)).res.headers.get(
        "Access-Control-Allow-Headers",
      ),
    ).toContain("X-Visitor-Id");
    expect(
      (await call(url, "GET", visitor)).json.tasks.map(
        (t: { id: string }) => t.id,
      ),
    ).toEqual([id]);
    expect(
      (
        await call(url + "/" + id, "GET", {
          ...visitor,
          "X-Visitor-Id": randomUUID(),
        })
      ).res.status,
    ).not.toBe(200);
    expect((await call(url, "GET", h)).res.status).not.toBe(200);
    expect(
      (
        await call(url, "GET", {
          ...visitor,
          Origin: "https://disallowed.example",
        })
      ).res.status,
    ).toBe(403);
    expect(
      (await call(url, "GET", { ...visitor, Authorization: "Bearer wrong" }))
        .res.status,
    ).toBe(401);
  });
});
