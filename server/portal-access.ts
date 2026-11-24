import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { ApiError } from "./errors.ts";
import type { Store } from "./store.ts";

export const PORTAL_SCHEMA = `
 CREATE TABLE IF NOT EXISTS portal_access_links (
   id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
   label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL,
   can_view_team INTEGER NOT NULL DEFAULT 0, can_request_deploy INTEGER NOT NULL DEFAULT 1,
   max_devices INTEGER CHECK(max_devices > 0), expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS portal_links_project ON portal_access_links(project_id);
 CREATE TABLE IF NOT EXISTS portal_device_sessions (
   id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES portal_access_links(id) ON DELETE CASCADE,
   project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, session_hash TEXT NOT NULL UNIQUE,
   device_label TEXT NOT NULL, fingerprint_summary TEXT NOT NULL, last_ip TEXT NOT NULL,
   ticket_count INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS portal_devices_link ON portal_device_sessions(link_id,revoked_at);`;

const errors = {
  invalid_link: "分享链接无效，请向项目管理员索取新链接。",
  expired_link: "分享链接已过期，请联系项目管理员续期。",
  revoked_link: "管理员已停用此分享链接。",
  removed_device: "此设备的访问权限已被移除，请联系管理员。",
  device_limit: "此链接的设备名额已满，请联系管理员移除闲置设备。",
  missing_session: "请从管理员提供的分享链接进入反馈面板。",
};
export class PortalAccessError extends ApiError {
  readonly code: keyof typeof errors;
  constructor(code: keyof typeof errors) {
    super(401, errors[code]);
    this.code = code;
  }
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const cookieName = (projectId: string) => `rd_portal_${projectId}`;
const cookieToken = (req: IncomingMessage, projectId: string) =>
  (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(cookieName(projectId) + "="))
    ?.split("=")[1] || "";

type LinkState = {
  id: string;
  label: string;
  revoked_at: string | null;
  expires_at: string | null;
  can_view_team: number;
  can_request_deploy: number;
  max_devices: number | null;
};
function checkLink(link: LinkState | undefined): asserts link is LinkState {
  if (!link) throw new PortalAccessError("invalid_link");
  if (link.revoked_at) throw new PortalAccessError("revoked_link");
  if (link.expires_at && Date.parse(link.expires_at) <= Date.now())
    throw new PortalAccessError("expired_link");
}
function metadata(req: IncomingMessage) {
  const ua = (req.headers["user-agent"] || "").slice(0, 512);
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad/i.test(ua)
      ? "iOS"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac OS|Macintosh/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "其他系统";
  const browser = /Edg/i.test(ua)
    ? "Edge"
    : /Firefox|FxiOS/i.test(ua)
      ? "Firefox"
      : /Chrome|CriOS/i.test(ua)
        ? "Chrome"
        : /Safari/i.test(ua)
          ? "Safari"
          : "其他浏览器";
  const peer = req.socket.remoteAddress || "";
  // Forwarding headers are not a trusted identity signal. Opt in only behind a sanitizing proxy.
  const forwarded =
    process.env.RELAYDESK_TRUST_PROXY === "1"
      ? String(req.headers["x-forwarded-for"] || "")
          .split(",")[0]
          .trim()
      : "";
  return {
    label: `${os} · ${browser}`,
    fingerprint: hash(
      `${ua}\n${String(req.headers["accept-language"] || "").slice(0, 100)}`,
    ).slice(0, 20),
    ip: isIP(forwarded) ? forwarded : peer,
  };
}
export function portalIdentity(
  store: Store,
  projectId: string,
  req: IncomingMessage,
) {
  const token = cookieToken(req, projectId);
  if (!token) throw new PortalAccessError("missing_session");
  const row = store.db
    .prepare(
      `SELECT l.*, d.id device_id, d.revoked_at removed FROM portal_device_sessions d JOIN portal_access_links l ON d.link_id=l.id WHERE d.session_hash=? AND d.project_id=? AND l.project_id=?`,
    )
    .get(hash(token), projectId, projectId) as
    (LinkState & { device_id: string; removed: string | null }) | undefined;
  if (!row) throw new PortalAccessError("missing_session");
  checkLink(row);
  if (row.removed) throw new PortalAccessError("removed_device");
  const m = metadata(req);
  store.db
    .prepare(
      `UPDATE portal_device_sessions SET last_seen_at=?,last_ip=?,fingerprint_summary=?,device_label=?
       WHERE id=? AND (last_seen_at<? OR last_ip!=? OR fingerprint_summary!=?)`,
    )
    .run(
      new Date().toISOString(),
      m.ip,
      m.fingerprint,
      m.label,
      row.device_id,
      new Date(Date.now() - 15_000).toISOString(),
      m.ip,
      m.fingerprint,
    );
  return {
    kind: "portal" as const,
    linkId: row.id,
    deviceId: row.device_id,
    label: row.label,
    canViewTeam: !!row.can_view_team,
    canRequestDeploy: !!row.can_request_deploy,
  };
}

/** Consume before SSR, logging or loading assets (including on invalid/expired links). */
export function redeemPortalLink(
  store: Store,
  projectId: string,
  raw: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  let location = `/p/${encodeURIComponent(projectId)}`;
  try {
    const session = store.transaction(true, () => {
      const link = store.db
        .prepare(
          "SELECT * FROM portal_access_links WHERE project_id=? AND token_hash=?",
        )
        .get(projectId, hash(raw)) as LinkState | undefined;
      checkLink(link);
      const existing = store.db
        .prepare(
          "SELECT id,revoked_at FROM portal_device_sessions WHERE link_id=? AND session_hash=?",
        )
        .get(link.id, hash(cookieToken(req, projectId)));
      if (existing?.revoked_at) throw new PortalAccessError("removed_device");
      if (existing) {
        portalIdentity(store, projectId, req);
        return null;
      }
      const { n } = store.db
        .prepare(
          "SELECT COUNT(*) n FROM portal_device_sessions WHERE link_id=? AND revoked_at IS NULL",
        )
        .get(link.id)!;
      if (link.max_devices !== null && Number(n) >= link.max_devices)
        throw new PortalAccessError("device_limit");
      const token = randomBytes(32).toString("base64url"),
        now = new Date().toISOString(),
        m = metadata(req);
      store.db
        .prepare(
          `INSERT INTO portal_device_sessions(id,link_id,project_id,session_hash,device_label,fingerprint_summary,last_ip,last_seen_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          link.id,
          projectId,
          hash(token),
          m.label,
          m.fingerprint,
          m.ip,
          now,
          now,
        );
      return token;
    });
    if (session) {
      const localHttp =
        /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(
          req.headers.host || "",
        ) && req.headers["x-forwarded-proto"] !== "https";
      res.setHeader(
        "Set-Cookie",
        `${cookieName(projectId)}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${localHttp ? "" : "; Secure"}`,
      );
    }
  } catch (err) {
    if (!(err instanceof PortalAccessError)) throw err;
    location += `?error=${err.code}`;
  }
  res
    .writeHead(302, {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    })
    .end();
}

function linkConfig(data: Record<string, unknown>) {
  const label = typeof data.label === "string" ? data.label.trim() : "";
  if (!label || label.length > 80)
    throw new ApiError(400, "请输入 1 至 80 个字符的链接备注。");
  for (const flag of ["can_view_team", "can_request_deploy"])
    if (data[flag] !== undefined && typeof data[flag] !== "boolean")
      throw new ApiError(400, "权限值无效。");
  const max = data.max_devices ?? null;
  if (
    max !== null &&
    (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1)
  )
    throw new ApiError(400, "设备上限必须为正整数。");
  const expiry = data.expires_at;
  if (
    expiry != null &&
    (typeof expiry !== "string" ||
      !Number.isFinite(Date.parse(expiry)) ||
      Date.parse(expiry) <= Date.now())
  )
    throw new ApiError(400, "请选择未来的有效期。");
  return [
    label,
    Number(data.can_view_team === true),
    Number(data.can_request_deploy !== false),
    max as number | null,
    typeof expiry === "string" ? new Date(expiry).toISOString() : null,
  ] as const;
}
export function manageLinks(
  store: Store,
  projectId: string,
  method: string,
  path: string[],
  data: Record<string, unknown>,
) {
  store.getProjectRow(projectId);
  const db = store.db;
  if (!path.length && method === "GET") {
    const links = db
      .prepare(
        `SELECT id,label,token_prefix,can_view_team,can_request_deploy,max_devices,expires_at,revoked_at,created_at FROM portal_access_links WHERE project_id=? ORDER BY created_at DESC`,
      )
      .all(projectId);
    const devices = db
      .prepare(
        `SELECT id,link_id,device_label,fingerprint_summary,last_ip,ticket_count,last_seen_at,created_at FROM portal_device_sessions WHERE project_id=? AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
      )
      .all(projectId);
    const byLink = new Map<string, typeof devices>();
    for (const device of devices) {
      const id = String(device.link_id);
      const group = byLink.get(id);
      if (group) group.push(device);
      else byLink.set(id, [device]);
    }
    return {
      links: links.map((l) => ({
        ...l,
        can_view_team: !!l.can_view_team,
        can_request_deploy: !!l.can_request_deploy,
        devices: byLink.get(String(l.id)) ?? [],
      })),
    };
  }
  if (!path.length && method === "POST") {
    const fields = linkConfig(data),
      id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    db.prepare(
      `INSERT INTO portal_access_links(id,project_id,token_hash,token_prefix,label,can_view_team,can_request_deploy,max_devices,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      projectId,
      hash(token),
      token.slice(0, 6),
      ...fields,
      new Date().toISOString(),
    );
    return { id, url: `/p/${projectId}?token=${token}` };
  }
  const [id, sub, deviceId] = path;
  if (path.length === 1 && method === "PATCH") {
    const row = db
      .prepare("SELECT * FROM portal_access_links WHERE project_id=? AND id=?")
      .get(projectId, id) as LinkState | undefined;
    if (!row || row.revoked_at) throw new ApiError(404, "链接不存在或已停用。");
    const fields = linkConfig({
      ...row,
      can_view_team: !!row.can_view_team,
      can_request_deploy: !!row.can_request_deploy,
      ...data,
    });
    const { n } = db
      .prepare(
        "SELECT COUNT(*) n FROM portal_device_sessions WHERE link_id=? AND revoked_at IS NULL",
      )
      .get(id)!;
    if (fields[3] !== null && fields[3] < Number(n))
      throw new ApiError(409, "请先移除多余设备，再降低上限。");
    db.prepare(
      "UPDATE portal_access_links SET label=?,can_view_team=?,can_request_deploy=?,max_devices=?,expires_at=? WHERE id=? AND project_id=?",
    ).run(...fields, id, projectId);
    return { ok: true };
  }
  if (path.length === 1 && method === "DELETE") {
    const now = new Date().toISOString();
    const r = db
      .prepare(
        "UPDATE portal_access_links SET revoked_at=COALESCE(revoked_at,?) WHERE project_id=? AND id=?",
      )
      .run(now, projectId, id);
    if (!r.changes) throw new ApiError(404, "链接不存在。");
    db.prepare(
      "UPDATE portal_device_sessions SET revoked_at=? WHERE project_id=? AND link_id=? AND revoked_at IS NULL",
    ).run(now, projectId, id);
    return { ok: true };
  }
  if (path.length === 3 && sub === "devices" && method === "DELETE") {
    const r = db
      .prepare(
        "UPDATE portal_device_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE project_id=? AND link_id=? AND id=?",
      )
      .run(new Date().toISOString(), projectId, id, deviceId);
    if (!r.changes) throw new ApiError(404, "设备不存在。");
    return { ok: true };
  }
  throw new ApiError(404, "未知链接操作。");
}
