import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as r2 from "../server/r2.ts";
import * as feedbackAgent from "../server/feedback-agent.ts";
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

function parseSseFrames(raw: string): Array<{ event: string; data: any }> {
  const frames: Array<{ event: string; data: any }> = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) {
      frames.push({ event, data: JSON.parse(dataLines.join("\n")) });
    }
  }
  return frames;
}

describe("project feedback diagnosis over HTTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves the project-specific Local Bridge feedback settings even when offline without changing deployment or another project", async () => {
    const other = srv.store.createProject({
      name: "Other",
      repo: "fixture/other",
    });
    const before = srv.store.getProjectDeployPolicy(project);
    const settings = {
      enabled: true,
      execution_target: "auto",
      runtime: "claude",
      model: "claude-sonnet-4-5",
      reasoning_effort: "medium",
      system_prompt: "从报表页导出，优先区分用法与缺陷。",
    };
    const saved = await call(
      base + "/feedback-agent",
      "PATCH",
      admin,
      settings,
    );
    expect(saved.res.status).toBe(200);
    expect(saved.json).toMatchObject({
      ...settings,
      available: false,
      resolved_agent: null,
    });
    expect(typeof saved.json.unavailable_reason).toBe("string");
    expect(
      (await call(base + "/feedback-agent", "GET", admin)).json,
    ).toMatchObject(settings);
    expect(
      (await call(`/api/projects/${other.id}/feedback-agent`, "GET", admin))
        .json.system_prompt,
    ).not.toBe(settings.system_prompt);
    expect(srv.store.getProjectDeployPolicy(project)).toEqual(before);
  });

  it("isolates operator settings, exposes agent_enabled + agent_available, and rejects offline with 503", async () => {
    const { cookie } = await redeem((await link()).url);
    const headers = { Cookie: cookie };
    const widgetHeaders = {
      Authorization: `Bearer ${intake}`,
      Origin: "https://widget.example",
      "X-Visitor-Id": randomUUID(),
    };

    expect(
      (await call(base + "/feedback-agent", "GET", admin)).json.enabled,
    ).toBe(false);
    expect(
      (
        await call(base + "/feedback-agent", "PATCH", headers, {
          enabled: true,
        })
      ).res.status,
    ).toBe(401);
    expect(
      (await call(base + "/feedback-agent", "GET", headers)).res.status,
    ).toBe(401);

    const payload = { messages: [{ role: "user", text: "怎样导出报表？" }] };
    // Disabled -> 409
    expect(
      (await call(base + "/portal/diagnose", "POST", headers, payload)).res
        .status,
    ).toBe(409);

    // Enable without any online local node -> agent_enabled: true, agent_available: false, diagnose -> 503
    await call(base + "/feedback-agent", "PATCH", admin, {
      enabled: true,
      system_prompt: "仅供内部提示词，不得泄露到 config",
    });

    for (const [suffix, h] of [
      ["/portal/config", headers],
      ["/widget-config", widgetHeaders],
    ] as const) {
      const cfg = (await call(base + suffix, "GET", h)).json;
      expect(cfg.agent_enabled).toBe(true);
      expect(cfg.agent_available).toBe(false);
      expect(cfg).not.toHaveProperty("system_prompt");
      expect(cfg).not.toHaveProperty("public_guide");
      expect(cfg).not.toHaveProperty("model");
      expect(cfg).not.toHaveProperty("resolved_agent");
      expect(cfg).not.toHaveProperty("unavailable_reason");
    }

    // Offline 503 for both JSON and SSE requests (HTTP status 503 before streaming starts)
    expect(
      (await call(base + "/portal/diagnose", "POST", headers, payload)).res
        .status,
    ).toBe(503);
    const offlineSse = await fetch(new URL(base + "/portal/diagnose", srv.url), {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
    });
    expect(offlineSse.status).toBe(503);

    // When available: unauthorized / bad origin are still blocked before diagnoseFeedback runs
    const availSpy = vi
      .spyOn(feedbackAgent, "feedbackAgentAvailability")
      .mockReturnValue({ enabled: true, available: true });
    const runSpy = vi
      .spyOn(feedbackAgent, "diagnoseFeedback")
      .mockResolvedValue({ reply: "在报表页选择导出。", outcome: "usage" });

    for (const [suffix, h] of [
      ["/portal/config", headers],
      ["/widget-config", widgetHeaders],
    ] as const) {
      const cfg = (await call(base + suffix, "GET", h)).json;
      expect(cfg.agent_enabled).toBe(true);
      expect(cfg.agent_available).toBe(true);
    }

    expect(
      (await call(base + "/portal/diagnose", "POST", {}, payload)).res.status,
    ).toBe(401);
    expect(
      (
        await call(
          base + "/widget-feedback/diagnose",
          "POST",
          { ...widgetHeaders, Origin: "https://other.example" },
          payload,
        )
      ).res.status,
    ).toBe(403);
    expect(runSpy).not.toHaveBeenCalled();

    // JSON mode works on widget-feedback/diagnose without creating a ticket
    const jsonRes = await call(
      base + "/widget-feedback/diagnose",
      "POST",
      widgetHeaders,
      payload,
    );
    expect(jsonRes.res.status).toBe(200);
    expect(jsonRes.json).toEqual({
      reply: "在报表页选择导出。",
      outcome: "usage",
    });
    expect(srv.store.listTasks(project)).toHaveLength(0);

    // Node goes offline mid-session -> 503
    availSpy.mockReturnValue({ enabled: true, available: false });
    expect(
      (
        await call(
          base + "/widget-feedback/diagnose",
          "POST",
          widgetHeaders,
          payload,
        )
      ).res.status,
    ).toBe(503);
  });

  it("streams status, delta, and done over SSE when Accept includes text/event-stream", async () => {
    const { cookie } = await redeem((await link()).url);
    const widgetHeaders = {
      Authorization: `Bearer ${intake}`,
      Origin: "https://widget.example",
      "X-Visitor-Id": randomUUID(),
    };
    vi.spyOn(feedbackAgent, "feedbackAgentAvailability").mockReturnValue({
      enabled: true,
      available: true,
    });
    vi.spyOn(feedbackAgent, "diagnoseFeedback").mockImplementation(
      async (_store, _hub, _pid, _data, opts) => {
        opts?.onEvent?.({ type: "status", label: "正在查阅产品实现…" });
        opts?.onEvent?.({ type: "delta", text: "已确认是按钮" });
        opts?.onEvent?.({ type: "delta", text: "未绑定事件。" });
        return {
          reply: "已确认是按钮未绑定事件。",
          outcome: "suspected_bug",
          draft: { title: "导出按钮无响应", body: "点击导出按钮后没有任何请求发出。" },
        };
      },
    );

    const sseRes = await fetch(
      new URL(base + "/widget-feedback/diagnose", srv.url),
      {
        method: "POST",
        headers: {
          ...widgetHeaders,
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", text: "点击导出没反应" }],
        }),
      },
    );
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
    expect(sseRes.headers.get("access-control-allow-origin")).toBe(
      "https://widget.example",
    );
    const frames = parseSseFrames(await sseRes.text());
    expect(frames).toEqual([
      { event: "status", data: { label: "正在查阅产品实现…" } },
      { event: "delta", data: { text: "已确认是按钮" } },
      { event: "delta", data: { text: "未绑定事件。" } },
      {
        event: "done",
        data: {
          reply: "已确认是按钮未绑定事件。",
          outcome: "suspected_bug",
          draft: {
            title: "导出按钮无响应",
            body: "点击导出按钮后没有任何请求发出。",
          },
        },
      },
    ]);

    // Portal SSE also returns HTTP 400 JSON (not SSE) for malformed input
    const badRes = await fetch(new URL(base + "/portal/diagnose", srv.url), {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ messages: [] }),
    });
    expect(badRes.status).toBe(400);
    expect(badRes.headers.get("content-type")).toContain("application/json");
  });

  it("aborts abandoned diagnosis work and frees the slot for the next turn", async () => {
    const h = {
      Cookie: (await redeem((await link()).url)).cookie,
      "Content-Type": "application/json",
    };
    vi.spyOn(feedbackAgent, "feedbackAgentAvailability").mockReturnValue({
      enabled: true,
      available: true,
    });
    let started!: () => void, stopped!: () => void;
    const ready = new Promise<void>((resolve) => {
        started = resolve;
      }),
      cancelled = new Promise<void>((resolve) => {
        stopped = resolve;
      });
    vi.spyOn(feedbackAgent, "diagnoseFeedback")
      .mockImplementationOnce(
        (_s, _hub, _p, _d, opts) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener(
              "abort",
              () => {
                stopped();
                reject(new Error("aborted"));
              },
              { once: true },
            );
            started();
          }),
      )
      .mockResolvedValueOnce({ outcome: "usage", reply: "在报表页选择导出。" });
    const payload = { messages: [{ role: "user", text: "如何导出？" }] };
    const controller = new AbortController();
    const pending = fetch(srv.url + base + "/portal/diagnose", {
      method: "POST",
      headers: h,
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch(() => null);
    await ready;
    controller.abort();
    await Promise.all([cancelled, pending]);
    expect(
      (await call(base + "/portal/diagnose", "POST", h, payload)).res.status,
    ).toBe(200);
  });

  it("rejects overlapping turns and withholds results if access is revoked during diagnosis (JSON & SSE)", async () => {
    const l = await link();
    const h = { Cookie: (await redeem(l.url)).cookie };
    vi.spyOn(feedbackAgent, "feedbackAgentAvailability").mockReturnValue({
      enabled: true,
      available: true,
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    type Verdict = Awaited<ReturnType<typeof feedbackAgent.diagnoseFeedback>>;
    let finish!: (v: Verdict) => void;
    const completion = new Promise<Verdict>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(feedbackAgent, "diagnoseFeedback").mockImplementation(async () => {
      started();
      return completion;
    });
    const ask = () =>
      call(base + "/portal/diagnose", "POST", h, {
        messages: [{ role: "user", text: "如何导出？" }],
      });
    const first = ask();
    await entered;
    try {
      expect((await ask()).res.status).toBe(409);
      expect(
        (await call(base + "/portal-links/" + l.id, "DELETE", admin)).res
          .status,
      ).toBe(200);
    } finally {
      finish({ reply: "not delivered", outcome: "usage" });
    }
    const result = await first;
    expect(result.res.status).toBe(401);
    expect(result.json).not.toHaveProperty("reply");

    // SSE revocation mid-stream emits error event (status 401), never done
    const l2 = await link();
    const h2 = { Cookie: (await redeem(l2.url)).cookie };
    let started2!: () => void;
    const entered2 = new Promise<void>((resolve) => {
      started2 = resolve;
    });
    let finish2!: (v: Verdict) => void;
    const completion2 = new Promise<Verdict>((resolve) => {
      finish2 = resolve;
    });
    vi.spyOn(feedbackAgent, "diagnoseFeedback").mockImplementationOnce(async () => {
      started2();
      return completion2;
    });
    const ssePromise = fetch(new URL(base + "/portal/diagnose", srv.url), {
      method: "POST",
      headers: {
        ...h2,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ messages: [{ role: "user", text: "如何导出？" }] }),
    });
    await entered2;
    await call(base + "/portal-links/" + l2.id, "DELETE", admin);
    finish2({ reply: "secret", outcome: "usage" });
    const sseRes = await ssePromise;
    const frames = parseSseFrames(await sseRes.text());
    expect(frames.some((f) => f.event === "done")).toBe(false);
    expect(frames.some((f) => f.event === "error" && f.data.status === 401)).toBe(true);
  });

  it("keeps clarification, usage advice and suspected bugs separate from creating a ticket", async () => {
    const { cookie } = await redeem((await link()).url);
    const h = { Cookie: cookie };
    vi.spyOn(feedbackAgent, "feedbackAgentAvailability").mockReturnValue({
      enabled: true,
      available: true,
    });
    const run = vi.spyOn(feedbackAgent, "diagnoseFeedback");
    const draft = {
      title: "导出按钮没有生成文件",
      body: "在报表页面选择导出后，没有下载文件。",
    };
    run
      .mockResolvedValueOnce({
        reply: "你在哪个页面操作？",
        outcome: "clarify",
      })
      .mockResolvedValueOnce({
        reply: "在报表页面选择导出。",
        outcome: "usage",
      })
      .mockResolvedValueOnce({
        reply: "按这些步骤仍然无法导出，是否记录为疑似缺陷？",
        outcome: "suspected_bug",
        draft,
      });
    const messages = [{ role: "user", text: "无法导出" }];
    for (const [expected, followUp] of [
      ["clarify", "报表页面。"],
      ["usage", "已点击导出，没有生成文件。"],
      ["suspected_bug", ""],
    ] as const) {
      const reply = await call(base + "/portal/diagnose", "POST", h, {
        messages,
      });
      expect(reply.res.status).toBe(200);
      expect(reply.json.outcome).toBe(expected);
      expect(srv.store.listTasks(project)).toHaveLength(0);
      if (followUp)
        messages.push(
          { role: "assistant", text: reply.json.reply },
          { role: "user", text: followUp },
        );
      else expect(reply.json.draft).toEqual(draft);
    }
    expect(run.mock.calls.at(-1)?.[3]).toMatchObject({ messages });
    expect(
      (
        await call(base + "/portal/tasks", "POST", h, {
          ...draft,
          title: "我确认的标题",
        })
      ).json.task.title,
    ).toBe("我确认的标题");
    expect(srv.store.listTasks(project)).toHaveLength(1);
  });
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
