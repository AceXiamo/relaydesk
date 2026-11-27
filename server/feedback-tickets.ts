import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors.ts";
import type { Store } from "./store.ts";

export type FeedbackIdentity =
  | {
      kind: "portal";
      linkId: string;
      deviceId: string;
      label: string;
      canViewTeam: boolean;
      canRequestDeploy: boolean;
    }
  | { kind: "widget"; visitorId: string; canRequestDeploy: boolean };

const digest = (parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

// The randomly generated browser secret is a bearer credential, not a user-supplied display ID.
// Never store the secret, put it in URLs, accept a digest as an identity directly, or log it.
export function widgetVisitorDigest(
  projectId: string,
  secret: unknown,
): string {
  if (
    typeof secret !== "string" ||
    !/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i.test(
      secret,
    )
  ) {
    throw new ApiError(401, "缺少有效的本机访问凭证。");
  }
  return digest(["widget", projectId, secret.toLowerCase()]);
}

export function migrateFeedbackTickets(db: DatabaseSync) {
  const cols = new Set(
    db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((c) => c.name),
  );
  for (const [name, definition] of Object.entries({
    reporter_link_id: "TEXT",
    reporter_device_id: "TEXT",
    reporter_visitor_id: "TEXT",
    reporter_name: "TEXT NOT NULL DEFAULT ''",
    release_preference:
      "TEXT NOT NULL DEFAULT 'default' CHECK(release_preference IN ('default','request_immediate'))",
    feedback_title: "TEXT",
    feedback_type: "TEXT",
    feedback_request_key: "TEXT",
    feedback_accepted_release: "TEXT",
  })) {
    if (!cols.has(name))
      db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  }
  if (
    !db
      .prepare("PRAGMA table_info(messages)")
      .all()
      .some((c) => c.name === "visibility")
  ) {
    db.exec(
      "ALTER TABLE messages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal' CHECK(visibility IN ('internal','public'))",
    );
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS feedback_link_tasks ON tasks(project_id,reporter_link_id,number DESC) WHERE reporter_link_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS feedback_visitor_tasks ON tasks(project_id,reporter_visitor_id,number DESC) WHERE reporter_visitor_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS feedback_request_keys ON tasks(project_id,feedback_request_key) WHERE feedback_request_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS feedback_public_messages ON messages(task_id,id) WHERE visibility='public';
    CREATE TABLE IF NOT EXISTS feedback_rate_limits (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, actor TEXT NOT NULL, action TEXT NOT NULL,
      expires INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(project_id,actor,action)
    );
    CREATE INDEX IF NOT EXISTS feedback_rate_expiry ON feedback_rate_limits(expires);
  `);
}

const limits = {
  create: [6, 60_000],
  reply: [12, 60_000],
  accept: [8, 60_000],
  deploy: [1, 300_000],
} as const;
function consume(
  store: Store,
  project: string,
  identity: FeedbackIdentity,
  action: keyof typeof limits,
) {
  const [max, ms] = limits[action];
  const now = Date.now(),
    who =
      identity.kind === "portal"
        ? `device:${identity.deviceId}`
        : `widget:${identity.visitorId}`;
  store.db
    .prepare("DELETE FROM feedback_rate_limits WHERE expires<=?")
    .run(now);
  const r = store.db
    .prepare(
      `INSERT INTO feedback_rate_limits(project_id,actor,action,expires,count) VALUES(?,?,?,?,1)
    ON CONFLICT(project_id,actor,action) DO UPDATE SET count=count+1 WHERE count<?`,
    )
    .run(project, who, action, now + ms, max);
  if (!r.changes) throw new ApiError(429, "操作过于频繁，请稍后重试。");
}

function lookupPortal(
  store: Store,
  project: string,
  link: string,
  device: string,
) {
  return store.db
    .prepare(
      `SELECT l.label,l.can_view_team,l.can_request_deploy FROM portal_device_sessions d
    JOIN portal_access_links l ON d.link_id=l.id AND d.project_id=l.project_id
    WHERE d.id=? AND l.id=? AND l.project_id=? AND d.revoked_at IS NULL AND l.revoked_at IS NULL
      AND (l.expires_at IS NULL OR julianday(l.expires_at)>julianday('now'))`,
    )
    .get(device, link, project) as
    | { label: string; can_view_team: number; can_request_deploy: number }
    | undefined;
}

// Recheck project binding and active permissions inside the same transaction as each operation.
function liveIdentity(
  store: Store,
  project: string,
  id: FeedbackIdentity,
): FeedbackIdentity {
  if (id.kind === "widget") {
    if (!/^[0-9a-f]{64}$/.test(id.visitorId))
      throw new ApiError(401, "本机访问凭证无效。");
    return id;
  }
  const link = lookupPortal(store, project, id.linkId, id.deviceId);
  if (!link) throw new ApiError(401, "当前设备无权访问此项目。");
  return {
    ...id,
    label: link.label,
    canViewTeam: id.canViewTeam && !!link.can_view_team,
    canRequestDeploy: id.canRequestDeploy && !!link.can_request_deploy,
  };
}

interface FeedbackRow {
  id: string;
  number: number;
  feedback_title: string;
  created_at: string;
  status: string;
  owner: string;
  deploy_status: string;
  merged_into: string | null;
  resolution: string | null;
  release_id: string | null;
  deployed_at: string | null;
  feedback_accepted_release: string | null;
  reporter_link_id: string | null;
  reporter_visitor_id: string | null;
}

// Deliberately never read the editable internal title/body, merged parent, delivery refs or release notes into the public projection.
const columns = `id,number,feedback_title,created_at,status,owner,deploy_status,merged_into,resolution,release_id,deployed_at,
  feedback_accepted_release,reporter_link_id,reporter_visitor_id`;
const feedbackOnly = `feedback_title IS NOT NULL AND (reporter_link_id IS NOT NULL OR reporter_visitor_id IS NOT NULL)`;
const ownedBy = (row: FeedbackRow, id: FeedbackIdentity) =>
  id.kind === "portal"
    ? row.reporter_link_id === id.linkId
    : row.reporter_visitor_id === id.visitorId;
const canSeeTeam = (id: FeedbackIdentity) =>
  id.kind === "portal" && id.canViewTeam;
const deploymentKey = (row: FeedbackRow) =>
  row.release_id || row.deployed_at || "current";
function publicTask(row: FeedbackRow, id: FeedbackIdentity) {
  const owned = ownedBy(row, id),
    active = !row.merged_into;
  const done = row.status === "done",
    deployed = done && row.deploy_status === "deployed";
  const accepted =
    deployed && row.feedback_accepted_release === deploymentKey(row);
  const statusLabel = row.merged_into
    ? "已关联处理"
    : row.status === "waiting"
      ? "等待补充信息"
      : row.status === "review"
        ? "内部复核中"
        : row.status === "working" || row.status === "handoff"
          ? "排查与修复中"
          : !done
            ? "已提交，等待处理"
            : accepted
              ? "已确认解决"
              : deployed
                ? "已上线"
                : row.deploy_status === "deploying"
                  ? "正在发布上线"
                  : row.deploy_status === "pending"
                    ? "已修复，等待发布"
                    : row.deploy_status === "failed"
                      ? "发布暂缓"
                      : row.resolution === "shipped"
                        ? "已完成处理"
                        : row.resolution === "wontfix"
                          ? "已忽略"
                          : "已结束处理";
  return {
    id: row.id,
    code: `RD-${row.number}`,
    title: row.feedback_title,
    status_label: statusLabel,
    created_at: row.created_at,
    owned,
    can_reply:
      owned && active && row.status === "waiting" && row.owner !== "agent",
    can_accept:
      owned && active && deployed && !accepted && row.owner === "none",
    can_request_deploy:
      owned &&
      active &&
      done &&
      row.deploy_status === "pending" &&
      id.canRequestDeploy,
  };
}

function ticket(
  store: Store,
  project: string,
  id: FeedbackIdentity,
  taskId: string,
  ownerOnly = false,
) {
  const row = store.db
    .prepare(
      `SELECT ${columns} FROM tasks WHERE project_id=? AND id=? AND ${feedbackOnly}`,
    )
    .get(project, taskId) as unknown as FeedbackRow | undefined;
  if (!row || (!ownedBy(row, id) && (ownerOnly || !canSeeTeam(id))))
    throw new ApiError(404, "工单不存在。");
  return row;
}
function detail(store: Store, row: FeedbackRow, id: FeedbackIdentity) {
  const messages = store.db
    .prepare(
      `SELECT id,CASE WHEN author='reporter' THEN 'reporter' ELSE 'team' END author,body,created_at
    FROM messages WHERE task_id=? AND visibility='public' ORDER BY id ASC`,
    )
    .all(row.id) as unknown as Array<{
    id: number;
    author: "reporter" | "team";
    body: string;
    created_at: string;
  }>;
  if (
    row.status === "done" &&
    row.deploy_status === "deployed" &&
    row.deployed_at &&
    !row.merged_into
  ) {
    // Release summaries contain operational evidence; never publish them, even on success.
    messages.push({
      id: 0,
      author: "team",
      body: "本次反馈对应的更新已上线，请按原来的步骤验证结果。",
      created_at: row.deployed_at,
    });
    messages.sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
    );
  }
  return { task: publicTask(row, id), messages };
}
export function listFeedbackTickets(
  store: Store,
  project: string,
  identity: FeedbackIdentity,
  scope: string = "mine",
) {
  return store.transaction(false, () => {
    const id = liveIdentity(store, project, identity);
    if (scope !== "mine" && scope !== "team")
      throw new ApiError(400, "工单范围无效。");
    if (scope === "team" && !canSeeTeam(id))
      throw new ApiError(403, "无权查看团队反馈。");
    const ownerCol =
      id.kind === "portal" ? "reporter_link_id" : "reporter_visitor_id";
    const args =
      scope === "team"
        ? [project]
        : [project, id.kind === "portal" ? id.linkId : id.visitorId];
    const rows = store.db
      .prepare(
        `SELECT ${columns} FROM tasks WHERE project_id=? AND ${feedbackOnly}
      ${scope === "team" ? "" : `AND ${ownerCol}=?`} ORDER BY number DESC`,
      )
      .all(...args) as unknown as FeedbackRow[];
    return { tasks: rows.map((row) => publicTask(row, id)) };
  });
}
export function getFeedbackTicket(
  store: Store,
  project: string,
  identity: FeedbackIdentity,
  taskId: string,
) {
  return store.transaction(false, () => {
    const id = liveIdentity(store, project, identity);
    return detail(store, ticket(store, project, id, taskId), id);
  });
}

function text(value: unknown, max: number, required = true): string {
  if (value === undefined && !required) return "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new ApiError(400, "反馈内容格式或长度不正确。");
  return value.trim();
}
function sourcePage(value: unknown) {
  const raw = text(value, 2000, false);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      throw new Error();
    // Share-link tokens and authentication credentials commonly appear in query strings/fragments.
    return url.origin + url.pathname;
  } catch {
    throw new ApiError(400, "反馈页面地址无效。");
  }
}
function publicMessage(
  store: Store,
  taskId: string,
  author: "reporter" | "agent" | "human",
  body: string,
) {
  const message = store.addMessage(taskId, "comment", author, body);
  store.db
    .prepare("UPDATE messages SET visibility='public' WHERE id=? AND task_id=?")
    .run(message.id, taskId);
}

export function createFeedbackTicket(
  store: Store,
  project: string,
  identity: FeedbackIdentity,
  input: Record<string, unknown>,
) {
  let fresh = false;
  const result = store.transaction(true, () => {
    const id = liveIdentity(store, project, identity);
    const body = text(input.body, 24000),
      title =
        text(input.title, 180, false) || body.split(/\r?\n/)[0].slice(0, 120);
    const type = text(input.type, 50, false),
      external = text(input.external_id, 256, false);
    const images = input.images === undefined ? [] : input.images;
    if (
      !Array.isArray(images) ||
      images.length > 8 ||
      images.some((i) => {
        if (
          typeof i !== "string" ||
          i.length > 2000 ||
          !/^https?:\/\//i.test(i) ||
          /[\s()<>\\]/.test(i)
        )
          return true;
        try {
          const url = new URL(i);
          return !!(url.username || url.password || url.search || url.hash);
        } catch {
          return true;
        }
      })
    )
      throw new ApiError(400, "附件必须为不含凭证的图片地址。");
    const pref =
      input.release_preference === undefined
        ? "default"
        : input.release_preference;
    if (pref !== "default" && pref !== "request_immediate")
      throw new ApiError(400, "发布偏好无效。");
    if (pref === "request_immediate" && !id.canRequestDeploy)
      throw new ApiError(403, "无权申请即时发布。");
    // Keep the retry namespace independent of legacy clients' caller-chosen external_id values.
    const key = external
      ? digest([
          id.kind,
          id.kind === "portal" ? id.linkId : id.visitorId,
          external,
        ])
      : null;
    if (key) {
      const prior = store.db
        .prepare(
          "SELECT id FROM tasks WHERE project_id=? AND feedback_request_key=?",
        )
        .get(project, key);
      if (prior)
        return detail(
          store,
          ticket(store, project, id, String(prior.id), true),
          id,
        );
    }
    consume(store, project, id, "create");
    const withType = type ? `[${type}]\n\n${body}` : body;
    const imageBlock = images
      .filter((i) => !withType.includes(i))
      .map((i) => `![截图](${i})`)
      .join("\n\n");
    const submitted =
      withType + (imageBlock ? `\n\n### 附件截图\n${imageBlock}` : "");
    if (submitted.length > 24000)
      throw new ApiError(400, "反馈正文和附件过长。");
    const row = store.createTask(
      project,
      {
        title,
        body: submitted,
        source_url: sourcePage(input.source_url),
        attachments: images,
      },
      "widget",
    );
    store.db
      .prepare(
        `UPDATE tasks SET reporter_link_id=?,reporter_device_id=?,reporter_visitor_id=?,reporter_name=?,release_preference=?,feedback_title=?,feedback_type=?,feedback_request_key=? WHERE id=?`,
      )
      .run(
        id.kind === "portal" ? id.linkId : null,
        id.kind === "portal" ? id.deviceId : null,
        id.kind === "widget" ? id.visitorId : null,
        id.kind === "portal" ? id.label : "访客",
        pref,
        title,
        type,
        key,
        row.id,
      );
    if (id.kind === "portal")
      store.db
        .prepare(
          "UPDATE portal_device_sessions SET ticket_count=ticket_count+1 WHERE id=? AND project_id=? AND link_id=?",
        )
        .run(id.deviceId, project, id.linkId);
    publicMessage(store, row.id, "reporter", submitted);
    fresh = true;
    return detail(store, ticket(store, project, id, row.id, true), id);
  });
  // A legacy retry must not queue another AI prescreen or dispatch.
  return { ...result, created: fresh };
}

export function replyFeedbackTicket(
  store: Store,
  project: string,
  identity: FeedbackIdentity,
  taskId: string,
  body: unknown,
) {
  return store.transaction(true, () => {
    const id = liveIdentity(store, project, identity),
      row = ticket(store, project, id, taskId, true);
    if (!publicTask(row, id).can_reply)
      throw new ApiError(409, "当前工单不需要补充信息。");
    consume(store, project, id, "reply");
    publicMessage(store, taskId, "reporter", text(body, 8000));
    // Preserve an operator's assignment; waiting tasks do not carry a live agent lease.
    store.db
      .prepare(
        `UPDATE tasks SET status='ready',attempts=0,resolution=NULL,version=version+1 WHERE id=?`,
      )
      .run(taskId);
    return detail(store, ticket(store, project, id, taskId), id);
  });
}
export function acceptFeedbackTicket(
  store: Store,
  project: string,
  identity: FeedbackIdentity,
  taskId: string,
  outcome: "resolved" | "still_broken",
  body?: unknown,
) {
  return store.transaction(true, () => {
    const id = liveIdentity(store, project, identity),
      row = ticket(store, project, id, taskId, true);
    if (!publicTask(row, id).can_accept)
      throw new ApiError(409, "当前工单无法验收。");
    if (outcome !== "resolved" && outcome !== "still_broken")
      throw new ApiError(400, "验收结果无效。");
    const note = text(body, 8000, false);
    consume(store, project, id, "accept");
    if (outcome === "resolved") {
      store.db
        .prepare(
          "UPDATE tasks SET feedback_accepted_release=?,version=version+1 WHERE id=?",
        )
        .run(deploymentKey(row), taskId);
    } else {
      store.operatorAction(taskId, { action: "reopen" });
      store.db
        .prepare("UPDATE tasks SET feedback_accepted_release=NULL WHERE id=?")
        .run(taskId);
    }
    publicMessage(
      store,
      taskId,
      "reporter",
      (outcome === "resolved" ? "已确认解决" : "仍有问题") +
        (note ? `：${note}` : ""),
    );
    return detail(store, ticket(store, project, id, taskId), id);
  });
}
export function authorizeFeedbackDeployRequest(
  store: Store,
  project: string,
  identity: FeedbackIdentity,
  taskId: string,
): void {
  store.transaction(true, () => {
    const id = liveIdentity(store, project, identity),
      row = ticket(store, project, id, taskId, true);
    if (!id.canRequestDeploy) throw new ApiError(403, "无权申请即时发布。");
    if (!publicTask(row, id).can_request_deploy)
      throw new ApiError(409, "当前工单不在待发布队列。");
    consume(store, project, id, "deploy");
  });
}

/** Re-resolve the original requester's authority at dispatch time; never inherit a replacement device's permissions. */
export function getFeedbackDeployPresetIdentity(
  store: Store,
  project: string,
  taskId: string,
  widgetDeployEnabled: boolean,
): FeedbackIdentity | null {
  const row = store.db
    .prepare(
      `SELECT reporter_link_id,reporter_device_id,reporter_visitor_id FROM tasks WHERE id=? AND project_id=? AND ${feedbackOnly}
    AND merged_into IS NULL AND status='done' AND deploy_status='pending' AND release_preference='request_immediate'`,
    )
    .get(taskId, project);
  if (!row) return null;
  if (
    typeof row.reporter_link_id === "string" &&
    typeof row.reporter_device_id === "string"
  ) {
    const link = lookupPortal(
      store,
      project,
      row.reporter_link_id,
      row.reporter_device_id,
    );
    if (!link?.can_request_deploy) return null;
    return {
      kind: "portal",
      linkId: row.reporter_link_id,
      deviceId: row.reporter_device_id,
      label: link.label,
      canViewTeam: !!link.can_view_team,
      canRequestDeploy: true,
    };
  }
  if (
    widgetDeployEnabled &&
    typeof row.reporter_visitor_id === "string" &&
    /^[0-9a-f]{64}$/.test(row.reporter_visitor_id)
  )
    return {
      kind: "widget",
      visitorId: row.reporter_visitor_id,
      canRequestDeploy: true,
    };
  return null;
}

// Only reviewed, user-facing text can cross from an internal agent/operator channel. A boolean
// visibility flag on an existing comment could otherwise publish SQL, credentials or debug logs.
export const PUBLIC_FEEDBACK_QUESTIONS = {
  steps: "可以补充一下出现问题前的操作步骤吗？",
  expected: "你期望看到什么结果？实际看到的结果是什么？",
  environment: "请告诉我们使用的设备类型、操作系统和浏览器版本。",
  frequency: "这个问题每次都会出现，还是偶尔出现？",
  screenshot: "可以提供一张已遮挡个人信息的截图吗？",
  confirm_fix: "请再试一次原来的操作，并告诉我们是否恢复正常。",
} as const;
export function addPublicFeedbackQuestion(
  store: Store,
  project: string,
  taskId: string,
  key: unknown,
  author: "human" | "agent",
) {
  if (typeof key !== "string" || !Object.hasOwn(PUBLIC_FEEDBACK_QUESTIONS, key))
    throw new ApiError(400, "请选择公开追问模板。");
  return store.transaction(true, () => {
    const row = store.db
      .prepare(
        `SELECT owner,lease,status,deploy_status FROM tasks WHERE id=? AND project_id=? AND ${feedbackOnly} AND merged_into IS NULL`,
      )
      .get(taskId, project);
    if (!row) throw new ApiError(404, "反馈工单不存在。");
    if (row.owner === "agent" || row.lease)
      throw new ApiError(
        409,
        "请先由持有任务的 Agent 结束当前执行并将工单转为等待补充。",
      );
    if (
      !["triage", "ready", "working", "waiting", "review"].includes(
        String(row.status),
      ) ||
      row.deploy_status !== "not_required"
    )
      throw new ApiError(409, "此阶段无法发起公开追问。");
    if (row.status !== "waiting") {
      store.db
        .prepare(
          "UPDATE tasks SET status='waiting',version=version+1 WHERE id=?",
        )
        .run(taskId);
    }
    publicMessage(
      store,
      taskId,
      author,
      PUBLIC_FEEDBACK_QUESTIONS[key as keyof typeof PUBLIC_FEEDBACK_QUESTIONS],
    );
  });
}
