import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ApiError } from "./errors.ts";
import type {
  AgentProjectInfo,
  ProjectDetail,
  ProjectSummary,
  TaskMessage,
  TaskPriority,
  TaskRecord,
  TaskStatus,
} from "../app/lib/types.ts";

export const STATUSES = new Set<TaskStatus>([
  "triage",
  "ready",
  "working",
  "waiting",
  "review",
  "done",
]);

export const PRIORITIES = new Set<TaskPriority>([
  "low",
  "normal",
  "high",
  "urgent",
]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL,
    repos TEXT NOT NULL DEFAULT '[]',
    intake_key TEXT NOT NULL, bot_key TEXT NOT NULL, agent_key TEXT NOT NULL,
    allowed_origins TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
    agent_instructions TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    requirements TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '', external_id TEXT,
    priority TEXT NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'none',
    lease TEXT, version INTEGER NOT NULL DEFAULT 1, merged_into TEXT REFERENCES tasks(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen TEXT,
    UNIQUE(project_id, number), UNIQUE(project_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS queue ON tasks(project_id, status, owner);
CREATE INDEX IF NOT EXISTS merged ON tasks(merged_into);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS thread ON messages(task_id, id);
`;

export function nowIso(): string {
  return new Date().toISOString();
}

export function field(
  data: Record<string, unknown>,
  name: string,
  limit: number,
  required = true,
): string {
  const raw = data[name] ?? "";
  if (typeof raw !== "string" || raw.length > limit || (required && !raw.trim())) {
    throw new ApiError(400, `Invalid ${name} (maximum ${limit} characters)`);
  }
  return raw.trim();
}

export const MAX_PROJECT_REPOS = 20;

export function parseRepository(value: string): string {
  const match = value.match(
    /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
  );
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw new ApiError(400, "Use a GitHub owner/repository or repository URL");
  }
  return `${match[1]}/${match[2]}`;
}

export function parseRepositories(data: Record<string, unknown>): string[] {
  if ("repos" in data && data.repos !== undefined) {
    const raw = data.repos;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new ApiError(400, "Select at least one GitHub repository");
    }
    if (raw.length > MAX_PROJECT_REPOS) {
      throw new ApiError(400, `A project can bind at most ${MAX_PROJECT_REPOS} repositories`);
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== "string" || entry.length > 200 || !entry.trim()) {
        throw new ApiError(400, "Use a GitHub owner/repository or repository URL");
      }
      const parsed = parseRepository(entry.trim());
      const key = parsed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(parsed);
      }
    }
    if (result.length === 0) {
      throw new ApiError(400, "Select at least one GitHub repository");
    }
    return result;
  }
  return [parseRepository(field(data, "repo", 200))];
}

function deserializeProjectRepos(row: { repo: string; repos?: string | null }): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  if (typeof row.repos === "string" && row.repos.trim()) {
    try {
      const parsed = JSON.parse(row.repos);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string" && item.trim()) {
            const clean = item.trim();
            const key = clean.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              result.push(clean);
            }
          }
        }
      }
    } catch {
      // fall back to single repo column
    }
  }
  if (result.length === 0 && row.repo) {
    result.push(row.repo);
  }
  return result;
}

export function serializeOrigins(values: unknown): string {
  if (!Array.isArray(values) || values.length > 100) {
    throw new ApiError(400, "allowed_origins must be a list of origins");
  }
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length > 512) {
      throw new ApiError(400, "Invalid origin");
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(400, "Use an HTTP(S) origin without a path");
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/")
    ) {
      throw new ApiError(400, "Use an HTTP(S) origin without a path");
    }
    result.push(value.replace(/\/$/, ""));
  }
  return JSON.stringify(result);
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function tokenUrlSafe(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

function uuidHex(): string {
  return randomUUID().replace(/-/g, "");
}

export interface RawProjectRow {
  id: string;
  name: string;
  repo: string;
  repos?: string;
  intake_key: string;
  bot_key: string;
  agent_key: string;
  allowed_origins: string;
  created_at: string;
  agent_instructions: string;
}

export interface RawTaskRow {
  id: string;
  project_id: string;
  number: number;
  title: string;
  body: string;
  requirements: string;
  source: string;
  source_url: string;
  external_id: string | null;
  priority: string;
  status: string;
  owner: string;
  lease: string | null;
  version: number;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
  last_seen: string | null;
  message_count?: number;
  merged_count?: number;
}

export function toProjectView(row: RawProjectRow): ProjectDetail {
  const repos = deserializeProjectRepos(row);
  return {
    id: row.id,
    name: row.name,
    repo: repos[0] ?? row.repo,
    repos,
    intake_key: row.intake_key,
    bot_key: row.bot_key,
    agent_key: row.agent_key,
    allowed_origins: JSON.parse(row.allowed_origins) as string[],
    created_at: row.created_at,
    agent_instructions: row.agent_instructions,
  };
}

export function toAgentProject(row: RawProjectRow): AgentProjectInfo {
  const repos = deserializeProjectRepos(row);
  return {
    id: row.id,
    name: row.name,
    repo: repos[0] ?? row.repo,
    repos,
    agent_instructions: row.agent_instructions,
  };
}

export function toTaskView(row: RawTaskRow): TaskRecord {
  const result: TaskRecord = {
    id: row.id,
    project_id: row.project_id,
    number: row.number,
    title: row.title,
    body: row.body,
    requirements: row.requirements,
    source: row.source as TaskRecord["source"],
    source_url: row.source_url,
    priority: row.priority as TaskPriority,
    status: row.status as TaskStatus,
    owner: row.owner as TaskRecord["owner"],
    version: row.version,
    merged_into: row.merged_into,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen: row.last_seen,
  };
  if (typeof row.message_count === "number") {
    result.message_count = row.message_count;
  }
  if (typeof row.merged_count === "number") {
    result.merged_count = row.merged_count;
  }
  return result;
}

export class Store {
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath, { timeout: 10000 });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA);

    const cols = this.db
      .prepare("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "agent_instructions")) {
      this.db.exec(
        "ALTER TABLE projects ADD COLUMN agent_instructions TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!cols.some((c) => c.name === "repos")) {
      this.db.exec(
        "ALTER TABLE projects ADD COLUMN repos TEXT NOT NULL DEFAULT '[]'",
      );
    }
    const unmigrated = this.db
      .prepare("SELECT id, repo FROM projects WHERE (repos IS NULL OR repos = '' OR repos = '[]') AND repo != ''")
      .all() as Array<{ id: string; repo: string }>;
    if (unmigrated.length > 0) {
      const updateStmt = this.db.prepare("UPDATE projects SET repos = ? WHERE id = ?");
      for (const row of unmigrated) {
        updateStmt.run(JSON.stringify([row.repo]), row.id);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(write: boolean, fn: () => T): T {
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure when transaction is already closed.
      }
      throw err;
    }
  }

  listProjects(): ProjectSummary[] {
    const rows = this.db
      .prepare("SELECT id, name, repo, repos, created_at FROM projects ORDER BY created_at")
      .all() as unknown as Array<{
      id: string;
      name: string;
      repo: string;
      repos?: string;
      created_at: string;
    }>;
    return rows.map((row) => {
      const repos = deserializeProjectRepos(row);
      return {
        id: row.id,
        name: row.name,
        repo: repos[0] ?? row.repo,
        repos,
        created_at: row.created_at,
      };
    });
  }

  getProjectRow(projectId: string): RawProjectRow {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(projectId) as unknown as RawProjectRow | undefined;
    if (!row) throw new ApiError(404, "Record not found");
    return row;
  }

  getTaskRow(taskId: string): RawTaskRow {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as unknown as RawTaskRow | undefined;
    if (!row) throw new ApiError(404, "Record not found");
    return row;
  }

  createProject(data: Record<string, unknown>): ProjectDetail {
    const name = field(data, "name", 100);
    const repos = parseRepositories(data);
    const repo = repos[0];
    const allowedOrigins = serializeOrigins(data.allowed_origins ?? []);
    const agentInstructions = field(data, "agent_instructions", 8000, false);
    const projectId = uuidHex();
    const created = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects(id, name, repo, repos, intake_key, bot_key, agent_key, allowed_origins, created_at, agent_instructions)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        name,
        repo,
        JSON.stringify(repos),
        tokenUrlSafe(32),
        tokenUrlSafe(32),
        tokenUrlSafe(32),
        allowedOrigins,
        created,
        agentInstructions,
      );
    return toProjectView(this.getProjectRow(projectId));
  }

  updateProject(projectId: string, data: Record<string, unknown>): ProjectDetail {
    const project = this.getProjectRow(projectId);
    const name = "name" in data ? field(data, "name", 100) : project.name;
    const currentRepos = deserializeProjectRepos(project);
    const nextRepos =
      "repos" in data || "repo" in data ? parseRepositories(data) : currentRepos;
    const nextRepoSet = new Set(nextRepos.map((r) => r.toLowerCase()));
    const removedExistingRepo = currentRepos.some(
      (r) => !nextRepoSet.has(r.toLowerCase()),
    );
    if (removedExistingRepo) {
      const active = this.db
        .prepare("SELECT 1 FROM tasks WHERE project_id = ? AND owner = 'agent' LIMIT 1")
        .get(projectId);
      if (active) {
        throw new ApiError(409, "Complete active handoffs before rebinding the repository");
      }
    }
    const repo = nextRepos[0];
    const allowed =
      "allowed_origins" in data
        ? serializeOrigins(data.allowed_origins)
        : project.allowed_origins;
    const instructions =
      "agent_instructions" in data
        ? field(data, "agent_instructions", 8000, false)
        : project.agent_instructions;
    this.db
      .prepare(
        "UPDATE projects SET name = ?, repo = ?, repos = ?, allowed_origins = ?, agent_instructions = ? WHERE id = ?",
      )
      .run(name, repo, JSON.stringify(nextRepos), allowed, instructions, projectId);
    return toProjectView(this.getProjectRow(projectId));
  }

  listTasks(projectId: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.*,
           (SELECT COUNT(*) FROM messages m WHERE m.task_id = t.id AND m.kind = 'comment') AS message_count,
           (SELECT COUNT(*) FROM tasks sub WHERE sub.merged_into = t.id) AS merged_count
         FROM tasks t
         WHERE t.project_id = ?
         ORDER BY t.updated_at DESC, t.number DESC`,
      )
      .all(projectId) as unknown as RawTaskRow[];
    return rows.map(toTaskView);
  }

  addMessage(
    taskId: string,
    kind: "event" | "comment",
    author: string,
    body: string,
  ): TaskMessage {
    const created = nowIso();
    const res = this.db
      .prepare(
        "INSERT INTO messages(task_id, kind, author, body, created_at) VALUES(?, ?, ?, ?, ?)",
      )
      .run(taskId, kind, author, body, created);
    this.db
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
      .run(created, taskId);
    return {
      id: Number(res.lastInsertRowid),
      kind,
      author,
      body,
      created_at: created,
    };
  }

  getTaskMessages(taskId: string, limit?: number): TaskMessage[] {
    if (limit) {
      const rows = this.db
        .prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY id DESC LIMIT ?")
        .all(taskId, limit) as unknown as TaskMessage[];
      return rows.reverse();
    }
    return this.db
      .prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY id ASC")
      .all(taskId) as unknown as TaskMessage[];
  }

  getMergedTasks(taskId: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE merged_into = ? ORDER BY number ASC")
      .all(taskId) as unknown as RawTaskRow[];
    return rows.map(toTaskView);
  }

  createTask(
    projectId: string,
    data: Record<string, unknown>,
    source: "widget" | "bot" | "console",
  ): RawTaskRow {
    const body = field(data, "body", 24000);
    const title =
      field(data, "title", 180, false) || (body.split(/\r?\n/)[0] ?? "").slice(0, 120);
    const priority = (field(data, "priority", 10, false) || "normal") as TaskPriority;
    if (!PRIORITIES.has(priority)) {
      throw new ApiError(400, "Unknown priority");
    }
    const sourceUrl = field(data, "source_url", 2000, false);
    if (sourceUrl) {
      let parsed: URL;
      try {
        parsed = new URL(sourceUrl);
      } catch {
        throw new ApiError(400, "source_url must be an HTTP(S) URL");
      }
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
        throw new ApiError(400, "source_url must be an HTTP(S) URL");
      }
    }
    const externalId = field(data, "external_id", 256, false) || null;
    if (externalId) {
      const prev = this.db
        .prepare(
          "SELECT * FROM tasks WHERE project_id = ? AND source = ? AND external_id = ?",
        )
        .get(projectId, source, externalId) as unknown as RawTaskRow | undefined;
      if (prev) return prev;
    }
    const nextRow = this.db
      .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next_num FROM tasks WHERE project_id = ?")
      .get(projectId) as unknown as { next_num: number };
    const taskId = uuidHex();
    const created = nowIso();
    this.db
      .prepare(
        `INSERT INTO tasks(id, number, project_id, title, body, source, source_url, external_id,
          priority, status, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'triage', ?, ?)`,
      )
      .run(
        taskId,
        nextRow.next_num,
        projectId,
        title,
        body,
        source,
        sourceUrl,
        externalId,
        priority,
        created,
        created,
      );
    this.addMessage(taskId, "event", "system", "Feedback received");
    return this.getTaskRow(taskId);
  }

  private updateTaskFields(
    task: RawTaskRow,
    changes: Record<string, string | number | null>,
  ): void {
    const merged: Record<string, string | number | null> = {
      ...changes,
      updated_at: nowIso(),
      version: task.version + 1,
    };
    const keys = Object.keys(merged);
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => merged[k]);
    this.db
      .prepare(`UPDATE tasks SET ${sets} WHERE id = ?`)
      .run(...values, task.id);
  }

  private checkVersion(
    data: Record<string, unknown>,
    task: RawTaskRow,
    required = false,
  ): void {
    if (required || "version" in data) {
      const ver = data.version;
      if (typeof ver !== "number" || !Number.isInteger(ver) || ver !== task.version) {
        throw new ApiError(409, "Task changed. Refresh before continuing.");
      }
    }
  }

  operatorAction(taskId: string, data: Record<string, unknown>): { task: TaskRecord } {
    const task = this.getTaskRow(taskId);
    this.checkVersion(data, task);
    const action = field(data, "action", 32);
    const owner = task.owner;
    const status = task.status;

    if (task.merged_into) {
      throw new ApiError(409, "Open the primary task to continue");
    }

    let changes: Record<string, string | number | null>;
    let event: string;

    if (action === "claim" && owner === "none" && status !== "done") {
      changes = { owner: "human" };
      event = "Assigned to operator";
    } else if (action === "release" && owner === "human") {
      changes = { owner: "none", status: status === "working" ? "ready" : status };
      event = "Released by operator";
    } else if (action === "takeover" && owner === "agent" && status === "working") {
      changes = { status: "handoff" };
      event = "Operator requested handoff";
    } else if (action === "force_takeover" && owner === "agent" && status === "handoff") {
      changes = { owner: "human", status: "working", lease: null };
      event = "Operator took ownership and revoked the agent lease";
    } else if (action === "requirements") {
      const body = field(data, "body", 24000, false);
      changes = { requirements: body };
      event = `Updated requirements\n${body}`;
    } else if (action === "priority") {
      const nextPriority = field(data, "priority", 10) as TaskPriority;
      if (!PRIORITIES.has(nextPriority)) {
        throw new ApiError(400, "Unknown priority");
      }
      changes = { priority: nextPriority };
      event = `Priority → ${nextPriority}`;
    } else if (action === "status" && owner !== "agent") {
      const newStatus = field(data, "status", 16) as TaskStatus;
      if (!STATUSES.has(newStatus)) {
        throw new ApiError(400, "Invalid status");
      }
      if (newStatus === "working" && owner !== "human") {
        throw new ApiError(409, "Claim the task before starting work");
      }
      changes = { status: newStatus };
      if (newStatus === "done") {
        changes.owner = "none";
      }
      event = `${status} → ${newStatus}`;
    } else if (action === "merge" && owner !== "agent") {
      const targetId = field(data, "target_id", 64);
      const target = this.getTaskRow(targetId);
      if (
        target.project_id !== task.project_id ||
        targetId === task.id ||
        target.owner === "agent" ||
        target.merged_into ||
        target.status === "done"
      ) {
        throw new ApiError(
          409,
          "Select an open, unmerged task in this project without an active agent",
        );
      }
      this.db
        .prepare("UPDATE tasks SET merged_into = ? WHERE merged_into = ?")
        .run(targetId, task.id);
      changes = { merged_into: targetId, status: "done", owner: "none" };
      event = `Merged into #${target.number}`;
      this.updateTaskFields(target, {});
      this.addMessage(
        targetId,
        "event",
        "human",
        `Linked feedback #${task.number}: ${task.title}`,
      );
    } else {
      throw new ApiError(409, "Action unavailable for the current owner or status");
    }

    this.updateTaskFields(task, changes);
    this.addMessage(task.id, "event", "human", event);
    return { task: toTaskView(this.getTaskRow(task.id)) };
  }

  agentCall(
    project: RawProjectRow,
    parts: string[],
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const projectId = project.id;
    const publicProject = toAgentProject(project);

    if (parts.length === 1 && parts[0] === "claim") {
      const task = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE project_id = ? AND status = 'ready' AND owner = 'none' AND merged_into IS NULL
           ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, number
           LIMIT 1`,
        )
        .get(projectId) as unknown as RawTaskRow | undefined;
      if (!task) return { task: null };
      const lease = tokenUrlSafe(32);
      this.updateTaskFields(task, {
        lease,
        owner: "agent",
        status: "working",
        last_seen: nowIso(),
      });
      this.addMessage(task.id, "event", "agent", "Local agent claimed task");
      const acquired = toTaskView(this.getTaskRow(task.id));
      acquired.linked_feedback = this.getMergedTasks(task.id);
      return { task: acquired, lease, project: publicProject };
    }

    if (parts.length !== 2) {
      throw new ApiError(404, "Unknown agent operation");
    }
    const [taskId, operation] = parts;
    const task = this.getTaskRow(taskId);
    if (task.project_id !== projectId) {
      throw new ApiError(404, "Task not found");
    }
    const lease = field(data, "lease", 128);
    if (task.owner !== "agent" || !task.lease || !safeEqual(task.lease, lease)) {
      throw new ApiError(409, "Lease is no longer active");
    }

    if (operation === "heartbeat") {
      this.db
        .prepare("UPDATE tasks SET last_seen = ? WHERE id = ?")
        .run(nowIso(), taskId);
    } else {
      let nextStatus: TaskStatus;
      let nextOwner: "none" | "human";
      let fallback: string;
      if (operation === "handoff" && task.status === "handoff") {
        nextStatus = "working";
        nextOwner = "human";
        fallback = "Agent handed over task";
      } else if (operation === "finish" && task.status === "working") {
        this.checkVersion(data, task, true);
        nextStatus = "review";
        nextOwner = "none";
        fallback = "Agent submitted task for review";
      } else if (operation === "fail" && task.status === "working") {
        nextStatus = "waiting";
        nextOwner = "none";
        fallback = "Agent needs assistance";
      } else {
        throw new ApiError(409, "Agent must honor the current task state");
      }
      const body = field(data, "body", 24000, false);
      this.updateTaskFields(task, {
        lease: null,
        status: nextStatus,
        owner: nextOwner,
        last_seen: nowIso(),
      });
      this.addMessage(
        taskId,
        "event",
        "agent",
        body ? `${fallback}\n${body}` : fallback,
      );
    }

    return { task: toTaskView(this.getTaskRow(taskId)) };
  }
}
