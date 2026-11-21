import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ApiError } from "./errors.ts";
import type {
  AgentProjectInfo,
  AgentQueueItem,
  AgentQueuePayload,
  DeliveryMode,
  ProjectDetail,
  ProjectSummary,
  TaskMessage,
  TaskPriority,
  TaskRecord,
  TaskResolution,
  TaskStatus,
} from "../app/lib/types.ts";
import type { PrescreenResult } from "./assistant.ts";

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

export const DELIVERY_MODES = new Set<DeliveryMode>([
  "direct_push",
  "pr_automerge",
  "review_only",
]);

export const MAX_AGENT_ATTEMPTS = 3;
export const STALE_LEASE_MS = 45 * 60 * 1000;
export const CLI_LEASE_MS = 5 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL,
    repos TEXT NOT NULL DEFAULT '[]',
    intake_key TEXT NOT NULL, bot_key TEXT NOT NULL, agent_key TEXT NOT NULL,
    allowed_origins TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
    agent_instructions TEXT NOT NULL DEFAULT '',
    automation_paused INTEGER NOT NULL DEFAULT 0,
    cli_enabled INTEGER NOT NULL DEFAULT 0,
    delivery_mode TEXT NOT NULL DEFAULT 'direct_push',
    widget_code_context INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    requirements TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '', external_id TEXT,
    priority TEXT NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'none',
    lease TEXT, version INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    resolution TEXT,
    delivery_ref TEXT NOT NULL DEFAULT '',
    triaged_by TEXT NOT NULL DEFAULT '',
    merged_into TEXT REFERENCES tasks(id),
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
CREATE TABLE IF NOT EXISTS cli_runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    task_id TEXT NOT NULL REFERENCES tasks(id), mode TEXT NOT NULL CHECK(mode IN ('operator','pr_audit')),
    status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
    question TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '', sha TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, lease TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS cli_active_task ON cli_runs(task_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS cli_pending ON cli_runs(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS cli_thread ON cli_runs(task_id, created_at);
`;

export type CliRunMode = "operator" | "pr_audit";
export interface CliRun {
  id: string;
  project_id: string;
  task_id: string;
  mode: CliRunMode;
  status: "queued" | "running" | "succeeded" | "failed";
  question: string;
  progress: string;
  sha: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ClaimedCliRun {
  run: CliRun;
  lease: string;
  context: { task: TaskRecord; project: AgentProjectInfo; messages: TaskMessage[] };
}

// Keep lease credentials out of every public query, including UPDATE ... RETURNING.
const CLI_FIELDS = "id, project_id, task_id, mode, status, question, progress, sha, created_at, updated_at, started_at, finished_at";

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

function cliEnabledFlag(data: Record<string, unknown>, fallback: number): number {
  if (data.cli_enabled === undefined) return fallback;
  if (typeof data.cli_enabled !== "boolean") throw new ApiError(400, "cli_enabled must be a boolean");
  return data.cli_enabled ? 1 : 0;
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
  cli_enabled?: number;
  automation_paused?: number;
  delivery_mode?: string;
  widget_code_context?: number;
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
  attempts?: number;
  resolution?: string | null;
  delivery_ref?: string;
  triaged_by?: string;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
  last_seen: string | null;
  message_count?: number;
  merged_count?: number;
}

function normalizeDeliveryMode(value: unknown): DeliveryMode {
  if (typeof value === "string" && DELIVERY_MODES.has(value as DeliveryMode)) {
    return value as DeliveryMode;
  }
  return "direct_push";
}

function parseDeliveryMode(value: unknown): DeliveryMode {
  if (typeof value !== "string" || !DELIVERY_MODES.has(value as DeliveryMode)) {
    throw new ApiError(400, "Invalid delivery_mode");
  }
  return value as DeliveryMode;
}

function normalizeResolution(value: unknown): TaskResolution {
  if (value === "shipped" || value === "dismissed" || value === "merged") {
    return value;
  }
  return null;
}

function toAgentQueueItem(row: RawTaskRow): AgentQueueItem {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    priority: row.priority as TaskPriority,
    status: row.status as TaskStatus,
    owner: row.owner as TaskRecord["owner"],
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    updated_at: row.updated_at,
  };
}

export function toProjectView(row: RawProjectRow): ProjectDetail {
  const repos = deserializeProjectRepos(row);
  return {
    id: row.id,
    name: row.name,
    repo: repos[0] ?? row.repo,
    repos,
    cli_enabled: Boolean(row.cli_enabled),
    automation_paused: Boolean(row.automation_paused),
    delivery_mode: normalizeDeliveryMode(row.delivery_mode),
    widget_code_context: row.widget_code_context === undefined ? true : Boolean(row.widget_code_context),
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
    cli_enabled: Boolean(row.cli_enabled),
    automation_paused: Boolean(row.automation_paused),
    delivery_mode: normalizeDeliveryMode(row.delivery_mode),
    widget_code_context: row.widget_code_context === undefined ? true : Boolean(row.widget_code_context),
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
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    resolution: normalizeResolution(row.resolution),
    delivery_ref: row.delivery_ref ?? "",
    triaged_by: row.triaged_by ?? "",
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
    if (!cols.some((c) => c.name === "automation_paused")) {
      this.db.exec(
        "ALTER TABLE projects ADD COLUMN automation_paused INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!cols.some((c) => c.name === "cli_enabled")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN cli_enabled INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.some((c) => c.name === "delivery_mode")) {
      this.db.exec(
        "ALTER TABLE projects ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'direct_push'",
      );
    }
    if (!cols.some((c) => c.name === "widget_code_context")) {
      this.db.exec(
        "ALTER TABLE projects ADD COLUMN widget_code_context INTEGER NOT NULL DEFAULT 1",
      );
    }
    const taskCols = this.db
      .prepare("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string }>;
    if (!taskCols.some((c) => c.name === "attempts")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!taskCols.some((c) => c.name === "resolution")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN resolution TEXT");
    }
    if (!taskCols.some((c) => c.name === "delivery_ref")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN delivery_ref TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!taskCols.some((c) => c.name === "triaged_by")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN triaged_by TEXT NOT NULL DEFAULT ''",
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
      .prepare(
        "SELECT id, name, repo, repos, cli_enabled, automation_paused, delivery_mode, widget_code_context, created_at FROM projects ORDER BY created_at",
      )
      .all() as unknown as Array<{
      id: string;
      name: string;
      repo: string;
      repos?: string;
      cli_enabled?: number;
      automation_paused?: number;
      delivery_mode?: string;
      widget_code_context?: number;
      created_at: string;
    }>;
    return rows.map((row) => {
      const repos = deserializeProjectRepos(row);
      return {
        id: row.id,
        name: row.name,
        repo: repos[0] ?? row.repo,
        repos,
        cli_enabled: Boolean(row.cli_enabled),
        automation_paused: Boolean(row.automation_paused),
        delivery_mode: normalizeDeliveryMode(row.delivery_mode),
        widget_code_context:
          row.widget_code_context === undefined ? true : Boolean(row.widget_code_context),
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
    const automationPaused =
      "automation_paused" in data && data.automation_paused !== undefined
        ? (() => {
            if (typeof data.automation_paused !== "boolean") {
              throw new ApiError(400, "automation_paused must be a boolean");
            }
            return data.automation_paused ? 1 : 0;
          })()
        : 0;
    const deliveryMode =
      "delivery_mode" in data && data.delivery_mode !== undefined
        ? parseDeliveryMode(data.delivery_mode)
        : "direct_push";
    const widgetCodeContext =
      "widget_code_context" in data && data.widget_code_context !== undefined
        ? (() => {
            if (typeof data.widget_code_context !== "boolean") {
              throw new ApiError(400, "widget_code_context must be a boolean");
            }
            return data.widget_code_context ? 1 : 0;
          })()
        : 1;
    const projectId = uuidHex();
    const created = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects(id, name, repo, repos, intake_key, bot_key, agent_key, allowed_origins, created_at, agent_instructions, automation_paused, delivery_mode, widget_code_context, cli_enabled)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        automationPaused,
        deliveryMode,
        widgetCodeContext,
        cliEnabledFlag(data, 0),
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
    let automationPaused = project.automation_paused ? 1 : 0;
    if ("automation_paused" in data && data.automation_paused !== undefined) {
      if (typeof data.automation_paused !== "boolean") {
        throw new ApiError(400, "automation_paused must be a boolean");
      }
      automationPaused = data.automation_paused ? 1 : 0;
    }
    const deliveryMode =
      "delivery_mode" in data && data.delivery_mode !== undefined
        ? parseDeliveryMode(data.delivery_mode)
        : normalizeDeliveryMode(project.delivery_mode);
    let widgetCodeContext =
      project.widget_code_context === undefined ? 1 : project.widget_code_context ? 1 : 0;
    if ("widget_code_context" in data && data.widget_code_context !== undefined) {
      if (typeof data.widget_code_context !== "boolean") {
        throw new ApiError(400, "widget_code_context must be a boolean");
      }
      widgetCodeContext = data.widget_code_context ? 1 : 0;
    }
    this.db
      .prepare(
        "UPDATE projects SET name = ?, repo = ?, repos = ?, allowed_origins = ?, agent_instructions = ?, automation_paused = ?, delivery_mode = ?, widget_code_context = ?, cli_enabled = ? WHERE id = ?",
      )
      .run(
        name,
        repo,
        JSON.stringify(nextRepos),
        allowed,
        instructions,
        automationPaused,
        deliveryMode,
        widgetCodeContext,
        cliEnabledFlag(data, project.cli_enabled ?? 0),
        projectId,
      );
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

  private cliTask(projectId: string, taskId: string): RawTaskRow {
    const task = this.getTaskRow(taskId);
    if (task.project_id !== projectId) throw new ApiError(404, "Record not found");
    return task;
  }

  // Called only under BEGIN IMMEDIATE, after checking lease or expiry. Clearing the
  // lease and appending the terminal comment commit together or not at all.
  private completeCliRun(run: CliRun, status: "succeeded" | "failed", body: string, sha: string): CliRun {
    const now = nowIso();
    const result = this.db.prepare(`UPDATE cli_runs SET status = ?, progress = ?, sha = ?,
      lease = NULL, updated_at = ?, finished_at = ? WHERE id = ? AND project_id = ? AND status = 'running'
      RETURNING ${CLI_FIELDS}`).get(status, body, sha, now, now, run.id, run.project_id) as unknown as CliRun;
    this.addMessage(run.task_id, "comment", "assistant", status === "failed" ? `CLI 运行失败：${body}` : body);
    return result;
  }

  private expireCliRuns(projectId: string): void {
    const cutoff = new Date(Date.now() - CLI_LEASE_MS).toISOString();
    const stale = this.db.prepare(`SELECT ${CLI_FIELDS} FROM cli_runs
      WHERE project_id = ? AND status = 'running' AND updated_at <= ?`).all(projectId, cutoff) as unknown as CliRun[];
    for (const run of stale) {
      this.completeCliRun(run, "failed", "CLI 租约已过期，未自动重试。请检查本地执行结果后再决定是否重新运行。", run.sha);
    }
  }

  enqueueCliRun(projectId: string, taskId: string, mode: CliRunMode, question: string): CliRun {
    if (mode !== "operator" && mode !== "pr_audit") throw new ApiError(400, "Invalid CLI mode");
    const body = field({ question }, "question", 8000);
    return this.transaction(true, () => {
      this.cliTask(projectId, taskId);
      const project = this.getProjectRow(projectId);
      if (!project.cli_enabled) throw new ApiError(409, "CLI is disabled for this project");
      if (project.automation_paused) throw new ApiError(409, "Automation is paused");
      this.expireCliRuns(projectId);
      if (this.db.prepare("SELECT 1 FROM cli_runs WHERE task_id = ? AND status IN ('queued','running')").get(taskId)) {
        throw new ApiError(409, "This task already has an active CLI run");
      }
      const now = nowIso();
      const run = this.db.prepare(`INSERT INTO cli_runs(id, project_id, task_id, mode, question, status, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, 'queued', ?, ?) RETURNING ${CLI_FIELDS}`)
        .get(uuidHex(), projectId, taskId, mode, body, now, now) as unknown as CliRun;
      this.addMessage(taskId, "comment", "human", body);
      return run;
    });
  }

  listCliRuns(projectId: string, taskId: string): CliRun[] {
    return this.transaction(true, () => {
      this.cliTask(projectId, taskId);
      this.expireCliRuns(projectId);
      return this.db.prepare(`SELECT ${CLI_FIELDS} FROM cli_runs WHERE project_id = ? AND task_id = ?
        ORDER BY created_at DESC, rowid DESC`).all(projectId, taskId) as unknown as CliRun[];
    });
  }

  claimCliRun(projectId: string): ClaimedCliRun | null {
    return this.transaction(true, () => {
      const project = this.getProjectRow(projectId);
      this.expireCliRuns(projectId);
      if (!project.cli_enabled || project.automation_paused) return null;
      const lease = tokenUrlSafe();
      const now = nowIso();
      const run = this.db.prepare(`UPDATE cli_runs SET status = 'running', lease = ?, started_at = ?, updated_at = ?
        WHERE id = (SELECT id FROM cli_runs WHERE project_id = ? AND status = 'queued' ORDER BY created_at, rowid LIMIT 1)
        RETURNING ${CLI_FIELDS}`).get(lease, now, now, projectId) as unknown as CliRun | undefined;
      if (!run) return null;
      return { run, lease, context: {
        task: toTaskView(this.cliTask(projectId, run.task_id)), project: toAgentProject(project),
        messages: this.getTaskMessages(run.task_id, 30),
      } };
    });
  }

  eventCliRun(projectId: string, runId: string, data: Record<string, unknown>): CliRun {
    const event = field(data, "event", 16);
    if (!["heartbeat", "progress", "finish", "fail"].includes(event)) throw new ApiError(400, "Invalid CLI event");
    const lease = field(data, "lease", 128);
    const body = field(data, "body", event === "progress" ? 4000 : 24000, event !== "heartbeat");
    const sha = field(data, "sha", 64, false);
    if (sha && !/^[0-9a-f]{7,64}$/i.test(sha)) throw new ApiError(400, "Invalid commit SHA");
    const result = this.transaction(true, () => {
      this.expireCliRuns(projectId);
      const run = this.db.prepare(`SELECT ${CLI_FIELDS}, lease FROM cli_runs WHERE id = ? AND project_id = ?`)
        .get(runId, projectId) as unknown as (CliRun & { lease: string | null }) | undefined;
      if (!run) throw new ApiError(404, "Record not found");
      if (run.status !== "running" || !run.lease || !safeEqual(lease, run.lease)) return null;
      if (event === "finish" || event === "fail") {
        return this.completeCliRun(run, event === "finish" ? "succeeded" : "failed", body, sha || run.sha);
      }
      return this.db.prepare(`UPDATE cli_runs SET progress = ?, sha = ?, updated_at = ?
        WHERE id = ? RETURNING ${CLI_FIELDS}`).get(event === "progress" ? body : run.progress, sha || run.sha, nowIso(), run.id) as unknown as CliRun;
    });
    // Reject outside the transaction: a late worker must not roll back its own expiration.
    if (!result) throw new ApiError(409, "Lease is no longer active");
    return result;
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
    let body = field(data, "body", 24000);
    if ("attachments" in data && data.attachments !== undefined) {
      if (!Array.isArray(data.attachments) || data.attachments.length > 8) {
        throw new ApiError(400, "attachments must be an array of at most 8 image URLs");
      }
      const extraImages: string[] = [];
      for (const item of data.attachments) {
        const rawUrl =
          typeof item === "string"
            ? item.trim()
            : item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string"
              ? ((item as { url: string }).url).trim()
              : "";
        if (!rawUrl || rawUrl.length > 2000) {
          throw new ApiError(400, "Invalid attachment URL");
        }
        let parsed: URL;
        try {
          parsed = new URL(rawUrl);
        } catch {
          throw new ApiError(400, "Attachment URL must be an HTTP(S) URL");
        }
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
          throw new ApiError(400, "Attachment URL must be an HTTP(S) URL");
        }
        if (!body.includes(rawUrl)) {
          extraImages.push(`![截图](${rawUrl})`);
        }
      }
      if (extraImages.length > 0) {
        const suffix = `\n\n### 附件截图\n${extraImages.join("\n\n")}`;
        if (body.length + suffix.length <= 24000) {
          body += suffix;
        }
      }
    }
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
    } else if (action === "reopen" && owner !== "agent") {
      changes = {
        status: "ready",
        owner: "none",
        lease: null,
        attempts: 0,
        resolution: null,
      };
      event = "Reopened for automation";
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
      changes = {
        merged_into: targetId,
        status: "done",
        owner: "none",
        resolution: "merged",
      };
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

  operatorAddComment(
    taskId: string,
    body: string,
    reopen = true,
  ): { message: TaskMessage; task: TaskRecord; reopened: boolean } {
    const task = this.getTaskRow(taskId);
    const message = this.addMessage(taskId, "comment", "human", body);
    let reopened = false;
    if (
      reopen !== false &&
      !task.merged_into &&
      task.owner === "none" &&
      (task.status === "waiting" || task.status === "review" || task.status === "done")
    ) {
      this.updateTaskFields(task, {
        status: "ready",
        attempts: 0,
        resolution: null,
      });
      this.addMessage(taskId, "event", "human", "Reopened by operator comment");
      reopened = true;
    }
    return {
      message,
      task: toTaskView(this.getTaskRow(taskId)),
      reopened,
    };
  }

  applyServerPrescreen(taskId: string, result: PrescreenResult): TaskRecord | null {
    const task = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as unknown as RawTaskRow | undefined;
    if (!task || task.merged_into || task.status !== "triage" || task.owner !== "none") {
      return null;
    }

    if (result.verdict === "noise") {
      this.updateTaskFields(task, {
        status: "done",
        owner: "none",
        resolution: "dismissed",
        triaged_by: "server_ai",
      });
      const reason =
        result.reason.trim() || "该提交属于测试/无效噪音消息，未包含可执行的产品反馈。";
      this.addMessage(
        task.id,
        "comment",
        "assistant",
        `**AI 预筛已自动归档**\n\n- **判定原因**：${reason}\n- **误判恢复**：如需重新进入自动化队列，直接在此下方回复评论即可自动重新打开任务。`,
      );
      this.addMessage(
        task.id,
        "event",
        "system",
        "Server AI pre-screened as noise and archived",
      );
      return toTaskView(this.getTaskRow(task.id));
    }

    if (result.verdict === "valid") {
      const changes: Record<string, string | number | null> = {
        status: "ready",
        triaged_by: "server_ai",
      };
      if (
        task.priority === "normal" &&
        result.priority &&
        PRIORITIES.has(result.priority)
      ) {
        changes.priority = result.priority;
      }
      this.updateTaskFields(task, changes);
      this.addMessage(
        task.id,
        "event",
        "system",
        "Server AI pre-screened and promoted to ready",
      );
      return toTaskView(this.getTaskRow(task.id));
    }

    return toTaskView(task);
  }

  reclaimStaleAgentLeases(projectId: string, staleMs = STALE_LEASE_MS): number {
    const working = this.db
      .prepare(
        "SELECT * FROM tasks WHERE project_id = ? AND owner = 'agent' AND status = 'working'",
      )
      .all(projectId) as unknown as RawTaskRow[];

    let reclaimed = 0;
    const now = Date.now();
    for (const task of working) {
      const lastActivity = Date.parse(task.last_seen || task.updated_at);
      if (Number.isNaN(lastActivity) || now - lastActivity <= staleMs) {
        continue;
      }
      const nextAttempts = (task.attempts ?? 0) + 1;
      if (nextAttempts >= MAX_AGENT_ATTEMPTS) {
        this.updateTaskFields(task, {
          status: "waiting",
          owner: "none",
          lease: null,
          attempts: nextAttempts,
        });
        this.addMessage(
          task.id,
          "event",
          "system",
          "Stale agent lease reached max attempts",
        );
      } else {
        this.updateTaskFields(task, {
          status: "ready",
          owner: "none",
          lease: null,
          attempts: nextAttempts,
        });
        this.addMessage(task.id, "event", "system", "Stale agent lease reclaimed");
      }
      reclaimed += 1;
    }
    return reclaimed;
  }

  getAgentQueue(project: RawProjectRow): AgentQueuePayload {
    this.reclaimStaleAgentLeases(project.id);
    const active = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE project_id = ? AND owner = 'agent' AND status IN ('working', 'handoff')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(project.id) as unknown as RawTaskRow | undefined;

    const pending = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE project_id = ? AND status IN ('ready', 'triage') AND owner = 'none' AND merged_into IS NULL AND attempts < ?
         ORDER BY
           CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           CASE status WHEN 'ready' THEN 0 ELSE 1 END,
           number ASC
         LIMIT 20`,
      )
      .all(project.id, MAX_AGENT_ATTEMPTS) as unknown as RawTaskRow[];

    return {
      paused: Boolean(project.automation_paused),
      active: active ? toAgentQueueItem(active) : null,
      pending: pending.map(toAgentQueueItem),
      project: toAgentProject(project),
    };
  }

  agentCall(
    project: RawProjectRow,
    parts: string[],
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const projectId = project.id;
    const publicProject = toAgentProject(project);

    if (parts.length === 1 && parts[0] === "claim") {
      this.reclaimStaleAgentLeases(projectId);
      if (project.automation_paused) {
        return {
          task: null,
          paused: true,
          reason: "paused",
          project: publicProject,
        };
      }

      const active = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE project_id = ? AND owner = 'agent' AND status IN ('working', 'handoff')
           LIMIT 1`,
        )
        .get(projectId) as unknown as RawTaskRow | undefined;
      if (active) {
        return {
          task: null,
          busy: true,
          active_task: toTaskView(active),
          project: publicProject,
        };
      }

      const requestedTaskId = field(data, "task_id", 64, false);
      const task = requestedTaskId
        ? (this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE id = ? AND project_id = ? AND status IN ('ready', 'triage') AND owner = 'none' AND merged_into IS NULL AND attempts < ?
               LIMIT 1`,
            )
            .get(requestedTaskId, projectId, MAX_AGENT_ATTEMPTS) as unknown as
            | RawTaskRow
            | undefined)
        : (this.db
            .prepare(
              `SELECT * FROM tasks
               WHERE project_id = ? AND status IN ('ready', 'triage') AND owner = 'none' AND merged_into IS NULL AND attempts < ?
               ORDER BY
                 CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                 CASE status WHEN 'ready' THEN 0 ELSE 1 END,
                 number ASC
               LIMIT 1`,
            )
            .get(projectId, MAX_AGENT_ATTEMPTS) as unknown as RawTaskRow | undefined);

      if (!task) return { task: null, project: publicProject };

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
      const countRow = this.db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM messages WHERE task_id = ? AND kind = 'comment'",
        )
        .get(task.id) as unknown as { cnt: number };
      acquired.message_count = countRow.cnt;
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
      return { task: toTaskView(this.getTaskRow(taskId)) };
    }

    if (operation === "comment") {
      const body = field(data, "body", 24000);
      const message = this.addMessage(taskId, "comment", "agent", body);
      this.db
        .prepare("UPDATE tasks SET last_seen = ? WHERE id = ?")
        .run(nowIso(), taskId);
      return { message, task: toTaskView(this.getTaskRow(taskId)) };
    }

    if (operation === "triage") {
      if (task.status !== "working") {
        throw new ApiError(409, "Agent must honor the current task state");
      }
      const changes: Record<string, string | number | null> = {
        triaged_by: "agent",
        last_seen: nowIso(),
      };
      if ("title" in data && data.title !== undefined) {
        const nextTitle = field(data, "title", 180, false);
        if (nextTitle) changes.title = nextTitle;
      }
      if ("requirements" in data && data.requirements !== undefined) {
        changes.requirements = field(data, "requirements", 24000, false);
      }
      if ("priority" in data && data.priority !== undefined) {
        const nextPriority = field(data, "priority", 10) as TaskPriority;
        if (!PRIORITIES.has(nextPriority)) {
          throw new ApiError(400, "Unknown priority");
        }
        changes.priority = nextPriority;
      }
      this.updateTaskFields(task, changes);
      this.addMessage(taskId, "event", "agent", "Agent triaged task");
      return { task: toTaskView(this.getTaskRow(taskId)) };
    }

    if (operation === "complete") {
      if (task.status !== "working") {
        throw new ApiError(409, "Agent must honor the current task state");
      }
      const summary =
        "summary" in data && data.summary !== undefined
          ? field(data, "summary", 24000, false)
          : field(data, "body", 24000, false);
      const deliveryRef =
        "delivery_ref" in data && data.delivery_ref !== undefined
          ? field(data, "delivery_ref", 500, false)
          : undefined;
      const requirements =
        "requirements" in data && data.requirements !== undefined
          ? field(data, "requirements", 24000, false)
          : undefined;

      const deliveryMode = normalizeDeliveryMode(project.delivery_mode);
      const reviewOnly = deliveryMode === "review_only" && data.force_done !== true;
      const nextStatus: TaskStatus = reviewOnly ? "review" : "done";
      const nextResolution: TaskResolution = reviewOnly ? null : "shipped";

      const changes: Record<string, string | number | null> = {
        status: nextStatus,
        resolution: nextResolution,
        owner: "none",
        lease: null,
        last_seen: nowIso(),
      };
      if (deliveryRef !== undefined) {
        changes.delivery_ref = deliveryRef;
      }
      if (requirements !== undefined) {
        changes.requirements = requirements;
      }
      this.updateTaskFields(task, changes);
      if (summary) {
        this.addMessage(taskId, "comment", "agent", summary);
      }
      this.addMessage(
        taskId,
        "event",
        "agent",
        reviewOnly
          ? "Agent submitted task for review"
          : "Agent shipped and completed task",
      );
      return { task: toTaskView(this.getTaskRow(taskId)) };
    }

    if (operation === "dismiss") {
      if (task.status !== "working") {
        throw new ApiError(409, "Agent must honor the current task state");
      }
      const reason =
        "reason" in data && data.reason !== undefined
          ? field(data, "reason", 12000, false)
          : field(data, "body", 12000, false);
      this.updateTaskFields(task, {
        status: "done",
        owner: "none",
        lease: null,
        resolution: "dismissed",
        triaged_by: "agent",
        last_seen: nowIso(),
      });
      this.addMessage(
        taskId,
        "comment",
        "agent",
        reason || "Dismissed as non-actionable feedback.",
      );
      this.addMessage(taskId, "event", "agent", "Agent dismissed task");
      return { task: toTaskView(this.getTaskRow(taskId)) };
    }

    if (operation === "merge") {
      if (task.status !== "working") {
        throw new ApiError(409, "Agent must honor the current task state");
      }
      const targetId = field(data, "target_id", 64);
      const target = this.getTaskRow(targetId);
      if (
        target.project_id !== task.project_id ||
        targetId === task.id ||
        target.merged_into ||
        target.status === "done"
      ) {
        throw new ApiError(409, "Select an open, unmerged task in this project");
      }
      this.db
        .prepare("UPDATE tasks SET merged_into = ? WHERE merged_into = ?")
        .run(targetId, task.id);
      this.updateTaskFields(task, {
        merged_into: targetId,
        status: "done",
        owner: "none",
        lease: null,
        resolution: "merged",
        triaged_by: "agent",
        last_seen: nowIso(),
      });
      this.addMessage(task.id, "event", "agent", `Merged into #${target.number}`);
      this.updateTaskFields(target, {});
      this.addMessage(
        targetId,
        "event",
        "agent",
        `Linked feedback #${task.number}: ${task.title}`,
      );
      return { task: toTaskView(this.getTaskRow(task.id)) };
    }

    if (operation === "handoff" && task.status === "handoff") {
      const body = field(data, "body", 24000, false);
      this.updateTaskFields(task, {
        lease: null,
        status: "working",
        owner: "human",
        last_seen: nowIso(),
      });
      this.addMessage(
        taskId,
        "event",
        "agent",
        body ? `Agent handed over task\n${body}` : "Agent handed over task",
      );
      return { task: toTaskView(this.getTaskRow(taskId)) };
    }

    if (operation === "finish" && task.status === "working") {
      this.checkVersion(data, task, true);
      const body = field(data, "body", 24000, false);
      const completeNow = data.complete === true;
      const nextStatus: TaskStatus = completeNow ? "done" : "review";
      const nextResolution: TaskResolution = completeNow ? "shipped" : null;
      const fallback = completeNow
        ? "Agent shipped and completed task"
        : "Agent submitted task for review";
      this.updateTaskFields(task, {
        lease: null,
        status: nextStatus,
        owner: "none",
        resolution: nextResolution,
        last_seen: nowIso(),
      });
      if (completeNow && body) {
        this.addMessage(taskId, "comment", "agent", body);
        this.addMessage(taskId, "event", "agent", fallback);
      } else {
        this.addMessage(
          taskId,
          "event",
          "agent",
          body ? `${fallback}\n${body}` : fallback,
        );
      }
      return { task: toTaskView(this.getTaskRow(taskId)) };
    }

    if (operation === "fail" && task.status === "working") {
      const body = field(data, "body", 24000, false);
      const nextAttempts = (task.attempts ?? 0) + 1;
      const retryable =
        data.retryable === true && nextAttempts < MAX_AGENT_ATTEMPTS;
      this.updateTaskFields(task, {
        lease: null,
        status: retryable ? "ready" : "waiting",
        owner: "none",
        attempts: nextAttempts,
        last_seen: nowIso(),
      });
      if (body) {
        this.addMessage(taskId, "comment", "agent", body);
      }
      this.addMessage(taskId, "event", "agent", "Agent needs assistance");
      return { task: toTaskView(this.getTaskRow(taskId)) };
    }

    throw new ApiError(409, "Agent must honor the current task state");
  }
}
