import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../server/store.ts";
import {
  acceptFeedbackTicket,
  addPublicFeedbackQuestion,
  authorizeFeedbackDeployRequest,
  createFeedbackTicket,
  getFeedbackDeployPresetIdentity,
  getFeedbackTicket,
  listFeedbackTickets,
  migrateFeedbackTickets,
  PUBLIC_FEEDBACK_QUESTIONS,
  replyFeedbackTicket,
  widgetVisitorDigest,
  type FeedbackIdentity,
} from "../server/feedback-tickets.ts";

let store: Store, project: string;
const input = {
  title: "导出问题",
  body: "点击导出后没有收到下载文件",
  type: "bug",
  images: [],
  release_preference: "default",
};
const makeWidget = (secret = randomUUID() as string, p = project) => ({
  kind: "widget" as const,
  visitorId: widgetVisitorDigest(p, secret),
  canRequestDeploy: true,
});
function makePortal(
  linkId = randomUUID() as string,
  deviceId = randomUUID() as string,
  p = project,
) {
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT OR IGNORE INTO portal_access_links(id,project_id,token_hash,token_prefix,label,created_at,can_view_team) VALUES(?,?,?,'token','产品',?,1)`,
    )
    .run(linkId, p, randomUUID(), now);
  store.db
    .prepare(
      `INSERT INTO portal_device_sessions(id,link_id,project_id,session_hash,device_label,fingerprint_summary,last_ip,last_seen_at,created_at) VALUES(?,?,?,?,'browser','fixture','127.0.0.1',?,?)`,
    )
    .run(deviceId, linkId, p, randomUUID(), now, now);
  return {
    kind: "portal" as const,
    linkId,
    deviceId,
    label: "产品",
    canViewTeam: true,
    canRequestDeploy: true,
  };
}
const countFor = (device: string) =>
  store.db
    .prepare("SELECT ticket_count FROM portal_device_sessions WHERE id=?")
    .get(device)?.ticket_count;
const state = (taskId: string, status: string, deploy = "not_required") =>
  store.db
    .prepare("UPDATE tasks SET status=?,deploy_status=? WHERE id=?")
    .run(status, deploy, taskId);

beforeEach(() => {
  store = new Store(":memory:");
  project = store.createProject({ name: "Feedback", repo: "acme/test" }).id;
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});

describe("public feedback ownership and privacy", () => {
  it("validates and project-binds the local bearer; unowned legacy tasks cannot be claimed by choosing a known ID", () => {
    const raw = randomBytes(32).toString("hex"),
      who = makeWidget(raw),
      foreign = makeWidget();
    const otherProject = store.createProject({
      name: "Other",
      repo: "acme/other",
    }).id;
    expect(makeWidget(raw, otherProject).visitorId).not.toBe(who.visitorId);
    expect(makeWidget(who.visitorId).visitorId).not.toBe(who.visitorId);
    for (const invalid of [
      undefined,
      {},
      "visitor-1",
      "00000000-0000-0000-0000-000000000000",
      raw + "\n",
    ])
      expect(() => widgetVisitorDigest(project, invalid)).toThrow();
    const legacy = store.createTask(
      project,
      { body: "Internal legacy contents", external_id: "retry" },
      "widget",
    );
    const created = createFeedbackTicket(store, project, who, {
      ...input,
      external_id: "retry",
      reporter_link_id: "fake",
      reporter_visitor_id: foreign.visitorId,
      priority: "urgent",
      release_id: "fake",
      status: "done",
      source: "console",
      requirements: "SECRET",
      images: ["https://assets.example/upload/a.png"],
      source_url: "https://site.test/a?token=SECRET#SECRET",
    });
    expect(created.created).toBe(true);
    expect(created.task.id).not.toBe(legacy.id);
    expect(
      createFeedbackTicket(store, project, who, {
        ...input,
        external_id: "retry",
      }),
    ).toMatchObject({ task: { id: created.task.id }, created: false });
    const different = createFeedbackTicket(store, project, foreign, {
      ...input,
      external_id: "retry",
    });
    expect(different.task.id).not.toEqual(created.task.id);
    expect(
      listFeedbackTickets(store, project, who).tasks.map((t) => t.id),
    ).toEqual([created.task.id]);
    for (const [p, id, task] of [
      [project, who, legacy.id],
      [project, foreign, created.task.id],
      [otherProject, who, created.task.id],
    ] as const)
      expect(() => getFeedbackTicket(store, p, id, task)).toThrow(/不存在/);
    expect(() => listFeedbackTickets(store, project, who, "team")).toThrow();
    expect(store.getTaskRow(created.task.id)).toMatchObject({
      reporter_link_id: null,
      reporter_visitor_id: who.visitorId,
      source_url: "https://site.test/a",
      priority: "normal",
      status: "triage",
      requirements: "",
    });
    expect(JSON.stringify(store.getTaskRow(created.task.id))).not.toContain(
      raw,
    );
    expect(created.messages[0].body).toContain(
      "https://assets.example/upload/a.png",
    );
    expect(JSON.stringify(created)).not.toMatch(
      /SECRET|reporter_visitor|requirements|source_url/,
    );
  });

  it("uses link ownership across devices; team reads only public feedback and never grants write privileges", () => {
    const a = makePortal(),
      same = makePortal(a.linkId),
      team = makePortal(),
      outsider = makePortal();
    store.db
      .prepare("UPDATE portal_access_links SET can_view_team=0 WHERE id=?")
      .run(outsider.linkId);
    const normal = store.createTask(
      project,
      { body: "operator-only" },
      "console",
    );
    const item = createFeedbackTicket(store, project, a, {
      ...input,
      external_id: "same",
    });
    expect(
      createFeedbackTicket(store, project, same, {
        ...input,
        external_id: "same",
      }).task.id,
    ).toBe(item.task.id);
    expect(countFor(a.deviceId)).toBe(1);
    expect(countFor(same.deviceId)).toBe(0);
    expect(listFeedbackTickets(store, project, same).tasks[0].owned).toBe(true);
    expect(listFeedbackTickets(store, project, team).tasks).toEqual([]);
    expect(
      listFeedbackTickets(store, project, team, "team").tasks.map((t) => t.id),
    ).toEqual([item.task.id]);
    expect(() => getFeedbackTicket(store, project, team, normal.id)).toThrow();
    expect(() =>
      listFeedbackTickets(store, project, outsider, "team"),
    ).toThrow();
    expect(() =>
      getFeedbackTicket(store, project, outsider, item.task.id),
    ).toThrow();
    for (const [status, deploy] of [
      ["waiting", "not_required"],
      ["done", "deployed"],
      ["done", "pending"],
    ]) {
      state(item.task.id, status, deploy);
      expect(
        getFeedbackTicket(store, project, team, item.task.id).task,
      ).toMatchObject({
        owned: false,
        can_reply: false,
        can_accept: false,
        can_request_deploy: false,
      });
      expect(() =>
        replyFeedbackTicket(store, project, team, item.task.id, "reply"),
      ).toThrow(/不存在/);
      expect(() =>
        acceptFeedbackTicket(
          store,
          project,
          team,
          item.task.id,
          "still_broken",
        ),
      ).toThrow(/不存在/);
      expect(() =>
        authorizeFeedbackDeployRequest(store, project, team, item.task.id),
      ).toThrow(/不存在/);
    }
    const otherProject = store.createProject({
      name: "Other",
      repo: "acme/other",
    }).id;
    expect(() =>
      listFeedbackTickets(store, otherProject, team, "team"),
    ).toThrow();
    expect(() =>
      createFeedbackTicket(
        store,
        project,
        { ...team, deviceId: a.deviceId },
        input,
      ),
    ).toThrow();
    store.db
      .prepare(
        "UPDATE portal_device_sessions SET revoked_at='removed' WHERE id=?",
      )
      .run(a.deviceId);
    expect(() => getFeedbackTicket(store, project, a, item.task.id)).toThrow();
    expect(
      getFeedbackTicket(store, project, same, item.task.id).task.owned,
    ).toBe(true);
  });

  it("projects immutable submitted content, not editable task fields, AI prescreens, merged parents or internal comments", () => {
    const id = makeWidget(),
      created = createFeedbackTicket(store, project, id, input),
      task = created.task.id;
    store.applyServerPrescreen(task, {
      verdict: "noise",
      reason: "Internal: SELECT * FROM secrets at 127.0.0.1",
    });
    store.chatAgentTaskOp(project, "update_task", {
      task,
      title: "SECRET_PATH",
      body: "SECRET_SQL",
      delivery_ref: "SECRET_GITHUB",
    });
    store.chatAgentTaskOp(project, "comment_task", {
      task,
      body: "SECRET internal incident log",
      visibility: "public",
    });
    store.operatorAddComment(task, "SECRET operator diagnostic", false);
    const primary = store.createTask(
      project,
      { body: "SECRET primary" },
      "console",
    );
    store.operatorAction(task, { action: "merge", target_id: primary.id });
    const dto = getFeedbackTicket(store, project, id, task);
    expect(dto.task.status_label).toBe("已关联处理");
    expect(dto.task.title).toBe(input.title);
    expect(Object.keys(dto.task).sort()).toEqual(
      [
        "id",
        "code",
        "title",
        "status_label",
        "created_at",
        "can_reply",
        "can_accept",
        "can_request_deploy",
        "owned",
      ].sort(),
    );
    expect(Object.keys(dto.messages[0]).sort()).toEqual(
      ["id", "body", "author", "created_at"].sort(),
    );
    expect(JSON.stringify(dto)).not.toMatch(
      /SECRET|SQL|127\.0\.0\.1|SELECT|agent|merged_into/,
    );
    expect(() => getFeedbackTicket(store, project, id, primary.id)).toThrow();
  });

  it("allows only a separate reviewed public question, delivers reporter replies and preserves non-public diagnostic text", () => {
    const id = makeWidget(),
      task = createFeedbackTicket(store, project, id, input).task.id;
    expect(() =>
      replyFeedbackTicket(store, project, id, task, "过早回复"),
    ).toThrow();
    store.chatAgentTaskOp(project, "comment_task", {
      task,
      body: "SECRET agent trace",
      public_question: "steps",
    });
    expect(store.getTaskRow(task).status).toBe("waiting");
    store.db
      .prepare(
        "UPDATE tasks SET owner='agent',status='working',lease='active' WHERE id=?",
      )
      .run(task);
    expect(() =>
      addPublicFeedbackQuestion(store, project, task, "environment", "human"),
    ).toThrow(/Agent/);
    expect(store.getTaskRow(task)).toMatchObject({
      owner: "agent",
      status: "working",
      lease: "active",
    });
    store.db
      .prepare(
        "UPDATE tasks SET owner='human',status='review',lease=NULL WHERE id=?",
      )
      .run(task);
    addPublicFeedbackQuestion(store, project, task, "environment", "human");
    expect(store.getTaskRow(task)).toMatchObject({
      owner: "human",
      status: "waiting",
    });
    for (const invalid of [
      true,
      "constructor",
      "__proto__",
      "SECRET SQL",
      {},
      "",
      null,
    ]) {
      expect(() =>
        store.chatAgentTaskOp(project, "comment_task", {
          task,
          body: "SECRET",
          public_question: invalid,
        }),
      ).toThrow();
    }
    expect(() =>
      store.chatAgentTaskOp(project, "comment_task", {
        task,
        body: "SECRET",
        public_question: "steps",
        reopen: true,
      }),
    ).toThrow();
    const waiting = getFeedbackTicket(store, project, id, task);
    expect(waiting.task).toMatchObject({
      can_reply: true,
      status_label: "等待补充信息",
    });
    expect(waiting.messages.slice(1).map((m) => [m.author, m.body])).toEqual([
      ["team", PUBLIC_FEEDBACK_QUESTIONS.steps],
      ["team", PUBLIC_FEEDBACK_QUESTIONS.environment],
    ]);
    expect(() => replyFeedbackTicket(store, project, id, task, " ")).toThrow();
    const result = replyFeedbackTicket(
      store,
      project,
      id,
      task,
      "仅在第二次操作时出现",
    );
    expect(result.task).toMatchObject({
      can_reply: false,
      status_label: "已提交，等待处理",
    });
    expect(result.messages.at(-1)).toMatchObject({
      author: "reporter",
      body: "仅在第二次操作时出现",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(store.getTaskRow(task).status).toBe("ready");
    expect(() =>
      replyFeedbackTicket(store, project, id, task, "duplicate"),
    ).toThrow();
  });

  it("maps all lifecycle states and only accepts deployed tasks; negative acceptance reopens with ownership intact", () => {
    const id = makeWidget(),
      task = createFeedbackTicket(store, project, id, input).task.id;
    for (const [s, d, label] of [
      ["triage", "not_required", "已提交，等待处理"],
      ["ready", "not_required", "已提交，等待处理"],
      ["working", "not_required", "排查与修复中"],
      ["handoff", "not_required", "排查与修复中"],
      ["waiting", "not_required", "等待补充信息"],
      ["review", "not_required", "内部复核中"],
      ["done", "pending", "已修复，等待发布"],
      ["done", "deploying", "正在发布上线"],
      ["done", "failed", "发布暂缓"],
    ]) {
      state(task, s, d);
      expect(
        getFeedbackTicket(store, project, id, task).task.status_label,
      ).toBe(label);
      expect(() =>
        acceptFeedbackTicket(store, project, id, task, "resolved"),
      ).toThrow();
    }
    state(task, "done", "deployed");
    store.db
      .prepare("UPDATE tasks SET release_id='r1',deployed_at=? WHERE id=?")
      .run(new Date().toISOString(), task);
    expect(getFeedbackTicket(store, project, id, task).task).toMatchObject({
      can_accept: true,
      status_label: "已上线",
    });
    expect(
      getFeedbackTicket(store, project, id, task).messages.some(
        (m) => m.author === "team" && m.body.includes("已上线"),
      ),
    ).toBe(true);
    const accepted = acceptFeedbackTicket(
      store,
      project,
      id,
      task,
      "resolved",
      "已经恢复了",
    );
    expect(accepted.task).toMatchObject({
      can_accept: false,
      status_label: "已确认解决",
    });
    expect(() =>
      acceptFeedbackTicket(store, project, id, task, "still_broken"),
    ).toThrow();
    store.db.prepare("UPDATE tasks SET release_id='r2' WHERE id=?").run(task);
    expect(
      acceptFeedbackTicket(store, project, id, task, "still_broken", "下载失败")
        .task,
    ).toMatchObject({ can_accept: false, owned: true });
    expect(store.getTaskRow(task)).toMatchObject({
      status: "ready",
      owner: "none",
      deploy_status: "not_required",
      release_id: null,
      reporter_visitor_id: id.visitorId,
    });
  });
});

describe("feedback rate limits and deploy authorization", () => {
  it("restricts public priority, preflight permissions and pending status even on a confirmed widget draft", () => {
    const visitor = makeWidget(),
      denied = { ...visitor, canRequestDeploy: false };
    const data = {
      ...input,
      release_preference: "request_immediate",
      priority: "urgent",
    };
    expect(() => createFeedbackTicket(store, project, denied, data)).toThrow();
    const t = createFeedbackTicket(store, project, visitor, data).task;
    store.applyServerPrescreen(t.id, {
      verdict: "valid",
      reason: "urgent",
      priority: "urgent",
    });
    expect(store.getTaskRow(t.id).priority).toBe("high");
    expect(() =>
      authorizeFeedbackDeployRequest(store, project, visitor, t.id),
    ).toThrow();
    expect(
      getFeedbackDeployPresetIdentity(store, project, t.id, true),
    ).toBeNull();
    state(t.id, "done", "pending");
    expect(
      getFeedbackDeployPresetIdentity(store, project, t.id, false),
    ).toBeNull();
    expect(getFeedbackDeployPresetIdentity(store, project, t.id, true)).toEqual(
      visitor,
    );
    expect(() =>
      authorizeFeedbackDeployRequest(store, project, denied, t.id),
    ).toThrow();
    authorizeFeedbackDeployRequest(store, project, visitor, t.id);
    expect(() =>
      authorizeFeedbackDeployRequest(store, project, visitor, t.id),
    ).toThrow(/频繁/);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
    authorizeFeedbackDeployRequest(store, project, visitor, t.id);
  });

  it("rejects stale preset authorizations after permissions, expiry, device or link revocation", () => {
    const id = makePortal(),
      t = createFeedbackTicket(store, project, id, {
        ...input,
        release_preference: "request_immediate",
      }).task.id;
    makePortal(id.linkId);
    state(t, "done", "pending");
    expect(getFeedbackDeployPresetIdentity(store, project, t, false)).toEqual(
      id,
    );
    store.db
      .prepare("UPDATE portal_access_links SET can_request_deploy=0 WHERE id=?")
      .run(id.linkId);
    expect(() =>
      authorizeFeedbackDeployRequest(store, project, id, t),
    ).toThrow();
    expect(getFeedbackDeployPresetIdentity(store, project, t, true)).toBeNull();
    store.db
      .prepare(
        "UPDATE portal_access_links SET can_request_deploy=1,expires_at='2000-01-01' WHERE id=?",
      )
      .run(id.linkId);
    expect(getFeedbackDeployPresetIdentity(store, project, t, true)).toBeNull();
    store.db
      .prepare(
        "UPDATE portal_access_links SET expires_at=NULL,revoked_at='removed' WHERE id=?",
      )
      .run(id.linkId);
    expect(getFeedbackDeployPresetIdentity(store, project, t, true)).toBeNull();
    store.db
      .prepare("UPDATE portal_access_links SET revoked_at=NULL WHERE id=?")
      .run(id.linkId);
    store.db
      .prepare(
        "UPDATE portal_device_sessions SET revoked_at='removed' WHERE id=?",
      )
      .run(id.deviceId);
    expect(getFeedbackDeployPresetIdentity(store, project, t, true)).toBeNull();
  });

  it("applies transaction-safe independent create/reply quotas per device or visitor, while retries do not consume a slot", () => {
    const id = makePortal(),
      second = makePortal(id.linkId);
    let task = "";
    for (let i = 0; i < 6; i++)
      task = createFeedbackTicket(store, project, id, {
        ...input,
        external_id: `r${i}`,
      }).task.id;
    expect(() => createFeedbackTicket(store, project, id, input)).toThrow(
      /频繁/,
    );
    expect(
      createFeedbackTicket(store, project, id, { ...input, external_id: "r5" })
        .task.id,
    ).toBe(task);
    expect(countFor(id.deviceId)).toBe(6);
    createFeedbackTicket(store, project, second, input);
    for (let i = 0; i < 12; i++) {
      state(task, "waiting");
      replyFeedbackTicket(store, project, id, task, "more info");
    }
    state(task, "waiting");
    expect(() =>
      replyFeedbackTicket(store, project, id, task, "too many"),
    ).toThrow(/频繁/);
    expect(store.getTaskRow(task).status).toBe("waiting");
    expect(
      replyFeedbackTicket(store, project, second, task, "more info").task
        .can_reply,
    ).toBe(false);
    const anon: FeedbackIdentity = makeWidget();
    for (let i = 0; i < 6; i++)
      createFeedbackTicket(store, project, anon, input);
    expect(() => createFeedbackTicket(store, project, anon, input)).toThrow(
      /频繁/,
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    createFeedbackTicket(store, project, id, input);
  });

  it("exposes status_label='已忽略' without internal ignore reason or public action flags when ignored", () => {
    const id = makeWidget(),
      created = createFeedbackTicket(store, project, id, input),
      taskId = created.task.id;
    store.operatorAction(taskId, {
      action: "ignore",
      body: "SECRET internal triage rationale",
    });

    const dto = getFeedbackTicket(store, project, id, taskId);
    expect(dto.task).toMatchObject({
      status_label: "已忽略",
      can_reply: false,
      can_accept: false,
      can_request_deploy: false,
    });
    expect(JSON.stringify(dto)).not.toContain("SECRET");
  });
});

it("migrates old rows fail-closed without inferring visibility or ownership from historic roles or source", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,number INTEGER,source TEXT);
      CREATE TABLE messages(id INTEGER PRIMARY KEY,task_id TEXT,author TEXT,body TEXT);
      INSERT INTO tasks VALUES('t','p',1,'widget'); INSERT INTO messages VALUES(1,'t','human','old human log'),(2,'t','assistant','old agent log')`);
    migrateFeedbackTickets(db);
    migrateFeedbackTickets(db);
    expect(
      db
        .prepare(
          "SELECT reporter_link_id,reporter_visitor_id,feedback_title,release_preference FROM tasks",
        )
        .get(),
    ).toMatchObject({
      reporter_link_id: null,
      reporter_visitor_id: null,
      feedback_title: null,
      release_preference: "default",
    });
    expect(
      db
        .prepare("SELECT visibility FROM messages")
        .all()
        .map((m) => m.visibility),
    ).toEqual(["internal", "internal"]);
  } finally {
    db.close();
  }
});
