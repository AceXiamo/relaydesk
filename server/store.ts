import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validCatalogId } from "../app/lib/model-catalog.ts";
import { ApiError } from "./errors.ts";
import type {
  AgentProjectInfo,
  AgentQueueItem,
  AgentQueuePayload,
  BridgeAgentSummary,
  BridgeAgentPatch,
  BridgeAgentBindingSummary,
  ChatContextRef,
  ChatMessageRecord,
  ChatRuntime,
  ChatSandboxMode,
  ChatSessionKind,
  ChatSessionRecord,
  ChatToolEvent,
  DeliveryMode,
  DeployMode,
  ProjectDeployPolicy,
  ProjectDetail,
  ProjectRoutingConfig,
  ProjectSummary,
  ReleaseRecord,
  ReleaseStatus,
  ReleaseTaskSnapshot,
  ReleaseTrigger,
  TaskDeployStatus,
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

export const DEPLOY_MODES = new Set<DeployMode>([
  "none",
  "manual",
  "immediate",
  "scheduled",
]);

export const TASK_DEPLOY_STATUSES = new Set<TaskDeployStatus>([
  "not_required",
  "pending",
  "deploying",
  "deployed",
  "failed",
]);

export const RELEASE_STATUSES = new Set<ReleaseStatus>([
  "running",
  "succeeded",
  "failed",
  "blocked",
]);

export const RELEASE_TRIGGERS = new Set<ReleaseTrigger>([
  "immediate",
  "scheduled",
  "urgent",
  "manual",
]);

export const DEFAULT_DEPLOY_POLICY: ProjectDeployPolicy = {
  runtime: null,
  model: null,
  mode: "none",
  window_start: "02:00",
  window_end: "06:00",
  timezone: "Asia/Shanghai",
  allow_urgent_override: true,
  doc_path: "",
};

export function isValidClockHHmm(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

export function isValidIanaTimeZone(value: string): boolean {
  if (!value || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function normalizeDeployPolicy(raw: unknown): ProjectDeployPolicy {
  let parsed: Record<string, unknown> = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsed = obj as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    parsed = raw as Record<string, unknown>;
  }

  const mode =
    typeof parsed.mode === "string" && DEPLOY_MODES.has(parsed.mode as DeployMode)
      ? (parsed.mode as DeployMode)
      : DEFAULT_DEPLOY_POLICY.mode;
  const window_start =
    typeof parsed.window_start === "string" && isValidClockHHmm(parsed.window_start.trim())
      ? parsed.window_start.trim()
      : DEFAULT_DEPLOY_POLICY.window_start;
  const window_end =
    typeof parsed.window_end === "string" && isValidClockHHmm(parsed.window_end.trim())
      ? parsed.window_end.trim()
      : DEFAULT_DEPLOY_POLICY.window_end;
  const timezone =
    typeof parsed.timezone === "string" && isValidIanaTimeZone(parsed.timezone.trim())
      ? parsed.timezone.trim()
      : DEFAULT_DEPLOY_POLICY.timezone;
  const allow_urgent_override =
    typeof parsed.allow_urgent_override === "boolean"
      ? parsed.allow_urgent_override
      : DEFAULT_DEPLOY_POLICY.allow_urgent_override;
  const doc_path =
    typeof parsed.doc_path === "string" ? parsed.doc_path.trim().slice(0, 240) : "";

  const runtime = parsed.runtime === "codex" || parsed.runtime === "claude" ? parsed.runtime : null;
  return {
    runtime,
    model: runtime && validCatalogId(parsed.model) ? parsed.model : null,
    mode,
    window_start,
    window_end,
    timezone,
    allow_urgent_override,
    doc_path,
  };
}

export function parseDeployPolicyPatch(
  current: ProjectDeployPolicy,
  patch: Record<string, unknown>,
): ProjectDeployPolicy {
  let mode = current.mode;
  if ("mode" in patch && patch.mode !== undefined) {
    if (typeof patch.mode !== "string" || !DEPLOY_MODES.has(patch.mode as DeployMode)) {
      throw new ApiError(400, "Invalid deploy policy mode (allowed: none, manual, immediate, scheduled)");
    }
    mode = patch.mode as DeployMode;
  }

  let window_start = current.window_start;
  if ("window_start" in patch && patch.window_start !== undefined) {
    const val = typeof patch.window_start === "string" ? patch.window_start.trim() : "";
    if (!isValidClockHHmm(val)) {
      throw new ApiError(400, "Invalid window_start (expected HH:mm)");
    }
    window_start = val;
  }

  let window_end = current.window_end;
  if ("window_end" in patch && patch.window_end !== undefined) {
    const val = typeof patch.window_end === "string" ? patch.window_end.trim() : "";
    if (!isValidClockHHmm(val)) {
      throw new ApiError(400, "Invalid window_end (expected HH:mm)");
    }
    window_end = val;
  }

  let timezone = current.timezone;
  if ("timezone" in patch && patch.timezone !== undefined) {
    const val = typeof patch.timezone === "string" ? patch.timezone.trim() : "";
    if (!isValidIanaTimeZone(val)) {
      throw new ApiError(400, "Invalid IANA timezone");
    }
    timezone = val;
  }

  let allow_urgent_override = current.allow_urgent_override;
  if ("allow_urgent_override" in patch && patch.allow_urgent_override !== undefined) {
    if (typeof patch.allow_urgent_override !== "boolean") {
      throw new ApiError(400, "allow_urgent_override must be a boolean");
    }
    allow_urgent_override = patch.allow_urgent_override;
  }

  let doc_path = current.doc_path;
  if ("doc_path" in patch && patch.doc_path !== undefined) {
    if (typeof patch.doc_path !== "string") {
      throw new ApiError(400, "doc_path must be a string");
    }
    const cleaned = patch.doc_path.trim();
    if (
      cleaned.length > 240 ||
      /[\x00-\x1f\x7f\\]/.test(cleaned) ||
      cleaned.startsWith("/") ||
      cleaned.split("/").some((part) => part === "..")
    ) {
      throw new ApiError(400, "Invalid doc_path (use a safe relative path)");
    }
    doc_path = cleaned;
  }

  const runtime = patch.runtime === undefined ? current.runtime : patch.runtime;
  if (runtime !== null && runtime !== "codex" && runtime !== "claude") {
    throw new ApiError(400, "Invalid release runtime");
  }
  let model = runtime === current.runtime ? current.model : null;
  if (patch.model !== undefined) {
    if (patch.model === null || patch.model === "") {
      model = null;
    } else if (runtime && validCatalogId(patch.model)) {
      model = patch.model;
    } else {
      throw new ApiError(400, "Invalid release model or missing release runtime");
    }
  }
  return {
    runtime,
    model,
    mode,
    window_start,
    window_end,
    timezone,
    allow_urgent_override,
    doc_path,
  };
}

function normalizeTaskDeployStatus(value: unknown): TaskDeployStatus {
  if (typeof value === "string" && TASK_DEPLOY_STATUSES.has(value as TaskDeployStatus)) {
    return value as TaskDeployStatus;
  }
  return "not_required";
}

function normalizeChatSessionKind(value: unknown): ChatSessionKind {
  if (value === "task") return "task";
  if (value === "release") return "release";
  return "chat";
}

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
    delivery_mode TEXT NOT NULL DEFAULT 'direct_push',
    widget_code_context INTEGER NOT NULL DEFAULT 1,
    execution_routing_json TEXT NOT NULL DEFAULT '{}',
    deploy_policy_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS bridge_agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL DEFAULT '',
    hostname TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', bridge_version TEXT NOT NULL DEFAULT '',
    max_concurrency INTEGER NOT NULL DEFAULT 2, accept_cli_runs INTEGER NOT NULL DEFAULT 1,
    runtimes_json TEXT NOT NULL DEFAULT '{}', models_json TEXT NOT NULL DEFAULT '[]', capabilities_json TEXT NOT NULL DEFAULT '{}',
    last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bridge_agent_token_prefix ON bridge_agents(token_prefix);
CREATE TABLE IF NOT EXISTS project_agent_bindings (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES bridge_agents(id) ON DELETE CASCADE,
    workdir TEXT NOT NULL DEFAULT '', path_ok INTEGER NOT NULL DEFAULT 0, path_error TEXT NOT NULL DEFAULT '',
    allow_datasource_secrets INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id, agent_id)
);
CREATE INDEX IF NOT EXISTS agent_bound_projects ON project_agent_bindings(agent_id, project_id);
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
    deploy_status TEXT NOT NULL DEFAULT 'not_required',
    deployed_at TEXT,
    release_id TEXT,
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
CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('immediate','scheduled','urgent','manual')),
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed','blocked')),
    session_id TEXT,
    task_ids_json TEXT NOT NULL DEFAULT '[]',
    task_snapshot_json TEXT NOT NULL DEFAULT '[]',
    deploy_ref TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE(project_id, number)
);
CREATE INDEX IF NOT EXISTS releases_project ON releases(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS releases_project_status ON releases(project_id, status);
CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','task','release')),
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    release_id TEXT,
    title TEXT NOT NULL,
    runtime TEXT NOT NULL DEFAULT 'codex' CHECK(runtime IN ('codex','claude')),
    model TEXT NOT NULL DEFAULT '',
    reasoning_effort TEXT NOT NULL DEFAULT 'default',
    execution_target TEXT NOT NULL DEFAULT 'auto',
    resolved_target TEXT NOT NULL DEFAULT '',
    sandbox_mode TEXT NOT NULL DEFAULT 'read-only' CHECK(sandbox_mode IN ('read-only','workspace-write')),
    network_access INTEGER NOT NULL DEFAULT 0,
    external_session_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','error')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_sessions_project ON chat_sessions(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    events_json TEXT NOT NULL DEFAULT '[]',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'done' CHECK(status IN ('streaming','done','error','aborted')),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_session ON chat_messages(session_id, created_at ASC);
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
  automation_paused?: number;
  delivery_mode?: string;
  widget_code_context?: number;
  execution_routing_json: string;
  deploy_policy_json?: string;
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
  deploy_status?: string;
  deployed_at?: string | null;
  release_id?: string | null;
  release_number?: number | null;
  created_at: string;
  updated_at: string;
  last_seen: string | null;
  message_count?: number;
  merged_count?: number;
  agent_session_id?: string | null;
  agent_session_status?: string | null;
  agent_session_target?: string | null;
}

export interface RawReleaseRow {
  id: string;
  project_id: string;
  number: number;
  trigger: string;
  status: string;
  session_id: string | null;
  task_ids_json: string;
  task_snapshot_json: string;
  deploy_ref: string;
  summary: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
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

export interface ProjectDeployStats {
  pending_deploy_count: number;
  failed_deploy_count: number;
  active_release_id: string | null;
}

export function toProjectView(row: RawProjectRow, stats?: Partial<ProjectDeployStats>): ProjectDetail {
  const repos = deserializeProjectRepos(row);
  return {
    id: row.id,
    name: row.name,
    repo: repos[0] ?? row.repo,
    repos,
    automation_paused: Boolean(row.automation_paused),
    delivery_mode: normalizeDeliveryMode(row.delivery_mode),
    deploy_policy: normalizeDeployPolicy(row.deploy_policy_json),
    pending_deploy_count: stats?.pending_deploy_count ?? 0,
    failed_deploy_count: stats?.failed_deploy_count ?? 0,
    active_release_id: stats?.active_release_id ?? null,
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
    automation_paused: Boolean(row.automation_paused),
    delivery_mode: normalizeDeliveryMode(row.delivery_mode),
    deploy_policy: normalizeDeployPolicy(row.deploy_policy_json),
    widget_code_context: row.widget_code_context === undefined ? true : Boolean(row.widget_code_context),
    agent_instructions: row.agent_instructions,
  };
}

export function toReleaseView(row: RawReleaseRow): ReleaseRecord {
  let taskIds: string[] = [];
  let taskSnapshot: ReleaseTaskSnapshot[] = [];
  try {
    const parsed = JSON.parse(row.task_ids_json);
    if (Array.isArray(parsed)) {
      taskIds = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    taskIds = [];
  }
  try {
    const parsed = JSON.parse(row.task_snapshot_json);
    if (Array.isArray(parsed)) {
      taskSnapshot = parsed as ReleaseTaskSnapshot[];
    }
  } catch {
    taskSnapshot = [];
  }
  return {
    id: row.id,
    project_id: row.project_id,
    number: row.number,
    trigger: (RELEASE_TRIGGERS.has(row.trigger as ReleaseTrigger)
      ? row.trigger
      : "manual") as ReleaseTrigger,
    status: (RELEASE_STATUSES.has(row.status as ReleaseStatus)
      ? row.status
      : "failed") as ReleaseStatus,
    session_id: row.session_id ?? null,
    task_ids: taskIds,
    task_snapshot: taskSnapshot,
    deploy_ref: row.deploy_ref ?? "",
    summary: row.summary ?? "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at ?? null,
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
    deploy_status: normalizeTaskDeployStatus(row.deploy_status),
    deployed_at: row.deployed_at ?? null,
    release_id: row.release_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_seen: row.last_seen,
  };
  if (typeof row.release_number === "number") {
    result.release_number = row.release_number;
  } else if (row.release_number === null) {
    result.release_number = null;
  }
  if (typeof row.message_count === "number") {
    result.message_count = row.message_count;
  }
  if (typeof row.merged_count === "number") {
    result.merged_count = row.merged_count;
  }
  if (row.agent_session_id !== undefined) {
    result.agent_session_id = row.agent_session_id || null;
  }
  if (row.agent_session_status !== undefined) {
    const st = row.agent_session_status;
    result.agent_session_status =
      st === "idle" || st === "running" || st === "error" ? st : null;
  }
  if (row.agent_session_target !== undefined) {
    result.agent_session_target = row.agent_session_target || null;
  }
  return result;
}

const BRIDGE_AGENT_FIELDS = `id, name, token_prefix, hostname, platform, bridge_version, max_concurrency,
  accept_cli_runs, runtimes_json, models_json, capabilities_json, last_seen_at, created_at, updated_at`;

type BridgeAgentRow = Pick<BridgeAgentSummary, "id" | "name" | "token_prefix" | "hostname" | "platform" |
  "bridge_version" | "max_concurrency" | "last_seen_at" | "created_at" | "updated_at"> & {
  accept_cli_runs: number; runtimes_json: string; models_json: string; capabilities_json: string;
};

function bridgeAgentSummary(row: BridgeAgentRow, bindings: BridgeAgentBindingSummary[]): BridgeAgentSummary {
  const { accept_cli_runs, runtimes_json, models_json, capabilities_json, ...fields } = row;
  // Only the hub can report live connections or active runs.
  return { ...fields, online: false, active_runs: 0, bindings,
    accept_cli_runs: Boolean(accept_cli_runs), runtimes: JSON.parse(runtimes_json),
    models: JSON.parse(models_json), capabilities: JSON.parse(capabilities_json) };
}

type BindingRow = Omit<BridgeAgentBindingSummary, "path_ok" | "enabled" | "allow_datasource_secrets"> & {
  path_ok: number; enabled: number; allow_datasource_secrets: number;
};

function bindingView(row: BindingRow): BridgeAgentBindingSummary {
  return { ...row, path_ok: Boolean(row.path_ok), enabled: Boolean(row.enabled),
    allow_datasource_secrets: Boolean(row.allow_datasource_secrets) };
}

type BridgeTelemetry = Partial<Pick<BridgeAgentSummary, "hostname" | "platform" | "bridge_version" |
  "max_concurrency" | "accept_cli_runs" | "runtimes" | "models" | "capabilities" | "last_seen_at">>;
type BindingPatch = Partial<Pick<BridgeAgentBindingSummary, "workdir" | "path_ok" | "path_error" |
  "allow_datasource_secrets" | "enabled">>;

const BINDING_SELECT = `SELECT b.*, p.name AS project_name FROM project_agent_bindings b JOIN projects p ON p.id = b.project_id`;

function verifyBridgeLimits(patch: BridgeAgentPatch) {
  if (patch.max_concurrency !== undefined && (!Number.isSafeInteger(patch.max_concurrency) || patch.max_concurrency < 1)) {
    throw new ApiError(400, "max_concurrency must be a positive integer");
  }
  if (patch.accept_cli_runs !== undefined && typeof patch.accept_cli_runs !== "boolean") {
    throw new ApiError(400, "accept_cli_runs must be a boolean");
  }
}

function bridgeToken() {
  const token = `rdbr_${randomBytes(24).toString("hex")}`;
  return { token, hash: createHash("sha256").update(token).digest("hex"), prefix: token.slice(0, 12) };
}

export class Store {
  readonly dbPath: string;
  private db: DatabaseSync;
  private txDepth = 0;

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
    if (!cols.some((c) => c.name === "execution_routing_json")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN execution_routing_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!cols.some((c) => c.name === "deploy_policy_json")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN deploy_policy_json TEXT NOT NULL DEFAULT '{}'");
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
    if (!taskCols.some((c) => c.name === "deploy_status")) {
      this.db.exec(
        "ALTER TABLE tasks ADD COLUMN deploy_status TEXT NOT NULL DEFAULT 'not_required'",
      );
    }
    if (!taskCols.some((c) => c.name === "deployed_at")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN deployed_at TEXT");
    }
    if (!taskCols.some((c) => c.name === "release_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN release_id TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS tasks_project_deploy ON tasks(project_id, deploy_status, updated_at DESC)");
    const messageCols = this.db.prepare("PRAGMA table_info(chat_messages)").all();
    if (!messageCols.some((c) => c.name === "stop_reason")) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN stop_reason TEXT");
    }
    const chatSessionCols = this.db
      .prepare("PRAGMA table_info(chat_sessions)")
      .all() as Array<{ name: string }>;
    if (!chatSessionCols.some((c) => c.name === "network_access")) {
      this.db.exec(
        "ALTER TABLE chat_sessions ADD COLUMN network_access INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!chatSessionCols.some((c) => c.name === "reasoning_effort")) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'default'");
    }
    if (!chatSessionCols.some((c) => c.name === "execution_target")) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN execution_target TEXT NOT NULL DEFAULT 'auto'");
    }
    if (!chatSessionCols.some((c) => c.name === "resolved_target")) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN resolved_target TEXT NOT NULL DEFAULT ''");
    }
    if (!chatSessionCols.some((c) => c.name === "kind")) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
    }
    if (!chatSessionCols.some((c) => c.name === "task_id")) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE");
    }
    this.migrateChatSessionsForReleases();
    this.db.exec("CREATE INDEX IF NOT EXISTS chat_sessions_project_kind ON chat_sessions(project_id, kind, updated_at DESC)");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_task_unique ON chat_sessions(task_id) WHERE task_id IS NOT NULL");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_release_unique ON chat_sessions(release_id) WHERE release_id IS NOT NULL");
    // Before routing existed, only the cloud runner could have issued a thread ID.
    this.db.exec("UPDATE chat_sessions SET resolved_target = 'cloud' WHERE resolved_target = '' AND external_session_id != ''");
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

  private migrateChatSessionsForReleases(): void {
    const meta = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_sessions'")
      .get() as { sql?: string } | undefined;
    const tableSql = meta?.sql ?? "";
    const cols = this.db
      .prepare("PRAGMA table_info(chat_sessions)")
      .all() as Array<{ name: string }>;
    const hasReleaseId = cols.some((c) => c.name === "release_id");
    const hasOldKindCheck = /CHECK\s*\(\s*kind\s+IN\s*\(\s*'chat'\s*,\s*'task'\s*\)\s*\)/i.test(tableSql);

    if (!hasOldKindCheck) {
      if (!hasReleaseId) {
        this.db.exec("ALTER TABLE chat_sessions ADD COLUMN release_id TEXT");
      }
      return;
    }

    // Safely rebuild chat_sessions to allow kind='release' and add release_id
    // without triggering ON DELETE CASCADE on chat_messages.
    this.db.exec("PRAGMA foreign_keys=OFF");
    try {
      this.transaction(true, () => {
        this.db.exec(`
          CREATE TABLE chat_sessions_new (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','task','release')),
            task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
            release_id TEXT,
            title TEXT NOT NULL,
            runtime TEXT NOT NULL DEFAULT 'codex' CHECK(runtime IN ('codex','claude')),
            model TEXT NOT NULL DEFAULT '',
            reasoning_effort TEXT NOT NULL DEFAULT 'default',
            execution_target TEXT NOT NULL DEFAULT 'auto',
            resolved_target TEXT NOT NULL DEFAULT '',
            sandbox_mode TEXT NOT NULL DEFAULT 'read-only' CHECK(sandbox_mode IN ('read-only','workspace-write')),
            network_access INTEGER NOT NULL DEFAULT 0,
            external_session_id TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','error')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO chat_sessions_new (
            id, project_id, kind, task_id, release_id, title, runtime, model,
            reasoning_effort, execution_target, resolved_target, sandbox_mode,
            network_access, external_session_id, status, created_at, updated_at
          )
          SELECT
            id, project_id, kind, task_id, ${hasReleaseId ? "release_id" : "NULL"}, title, runtime, model,
            reasoning_effort, execution_target, resolved_target, sandbox_mode,
            network_access, external_session_id, status, created_at, updated_at
          FROM chat_sessions;
          DROP TABLE chat_sessions;
          ALTER TABLE chat_sessions_new RENAME TO chat_sessions;
          CREATE INDEX IF NOT EXISTS chat_sessions_project ON chat_sessions(project_id, updated_at DESC);
        `);
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys=ON");
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(write: boolean, fn: () => T): T {
    if (this.txDepth > 0) {
      const sp = `rd_sp_${this.txDepth}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      this.txDepth += 1;
      try {
        const result = fn();
        this.txDepth -= 1;
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        this.txDepth -= 1;
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          // Ignore savepoint rollback failure if outer transaction was aborted.
        }
        throw err;
      }
    }

    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    this.txDepth = 1;
    try {
      const result = fn();
      this.txDepth = 0;
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.txDepth = 0;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure when transaction is already closed.
      }
      throw err;
    }
  }

  getProjectDeployStats(projectId: string): ProjectDeployStats {
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN deploy_status = 'pending' THEN 1 ELSE 0 END) AS pending_cnt,
           SUM(CASE WHEN deploy_status = 'failed' THEN 1 ELSE 0 END) AS failed_cnt
         FROM tasks
         WHERE project_id = ? AND merged_into IS NULL AND deploy_status IN ('pending', 'failed')`,
      )
      .get(projectId) as { pending_cnt?: number | null; failed_cnt?: number | null } | undefined;
    const activeRel = this.db
      .prepare(
        "SELECT id FROM releases WHERE project_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId) as { id?: string } | undefined;
    return {
      pending_deploy_count: Number(counts?.pending_cnt ?? 0),
      failed_deploy_count: Number(counts?.failed_cnt ?? 0),
      active_release_id: activeRel?.id ?? null,
    };
  }

  listProjects(): ProjectSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, repo, repos, automation_paused, delivery_mode, deploy_policy_json, widget_code_context, created_at
         FROM projects ORDER BY created_at`,
      )
      .all() as unknown as Array<{
      id: string;
      name: string;
      repo: string;
      repos?: string;
      automation_paused?: number;
      delivery_mode?: string;
      deploy_policy_json?: string;
      widget_code_context?: number;
      created_at: string;
    }>;
    const taskCounts = this.db
      .prepare(
        `SELECT project_id,
           SUM(CASE WHEN deploy_status = 'pending' THEN 1 ELSE 0 END) AS pending_cnt,
           SUM(CASE WHEN deploy_status = 'failed' THEN 1 ELSE 0 END) AS failed_cnt
         FROM tasks
         WHERE merged_into IS NULL AND deploy_status IN ('pending', 'failed')
         GROUP BY project_id`,
      )
      .all() as Array<{ project_id: string; pending_cnt: number; failed_cnt: number }>;
    const countMap = new Map<string, { pending: number; failed: number }>();
    for (const c of taskCounts) {
      countMap.set(c.project_id, {
        pending: Number(c.pending_cnt ?? 0),
        failed: Number(c.failed_cnt ?? 0),
      });
    }
    const activeReleases = this.db
      .prepare(
        `SELECT project_id, id FROM releases WHERE status = 'running' ORDER BY created_at DESC`,
      )
      .all() as Array<{ project_id: string; id: string }>;
    const activeMap = new Map<string, string>();
    for (const r of activeReleases) {
      if (!activeMap.has(r.project_id)) {
        activeMap.set(r.project_id, r.id);
      }
    }
    return rows.map((row) => {
      const repos = deserializeProjectRepos(row);
      const counts = countMap.get(row.id);
      return {
        id: row.id,
        name: row.name,
        repo: repos[0] ?? row.repo,
        repos,
        automation_paused: Boolean(row.automation_paused),
        delivery_mode: normalizeDeliveryMode(row.delivery_mode),
        deploy_policy: normalizeDeployPolicy(row.deploy_policy_json),
        pending_deploy_count: counts?.pending ?? 0,
        failed_deploy_count: counts?.failed ?? 0,
        active_release_id: activeMap.get(row.id) ?? null,
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

  getProjectDetail(projectId: string): ProjectDetail {
    const row = this.getProjectRow(projectId);
    return toProjectView(row, this.getProjectDeployStats(projectId));
  }

  getProjectDeployPolicy(projectId: string): ProjectDeployPolicy {
    return normalizeDeployPolicy(this.getProjectRow(projectId).deploy_policy_json);
  }

  updateProjectDeployPolicy(
    projectId: string,
    patch: Record<string, unknown>,
  ): ProjectDeployPolicy {
    const current = this.getProjectDeployPolicy(projectId);
    const next = parseDeployPolicyPatch(current, patch);
    this.db
      .prepare("UPDATE projects SET deploy_policy_json = ? WHERE id = ?")
      .run(JSON.stringify(next), projectId);
    return next;
  }

  createBridgeAgent(name: string): { agent: BridgeAgentSummary; token: string } {
    const label = field({ name }, "name", 100);
    const { token, hash, prefix } = bridgeToken();
    const id = uuidHex();
    const now = nowIso();
    this.db.prepare(`INSERT INTO bridge_agents (id, name, token_hash, token_prefix, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, label, hash, prefix, now, now);
    return { agent: this.requireBridgeAgent(id), token };
  }

  getBridgeAgent(agentId: string): BridgeAgentSummary | null {
    const row = this.db.prepare(`SELECT ${BRIDGE_AGENT_FIELDS} FROM bridge_agents WHERE id = ?`).get(agentId) as unknown as BridgeAgentRow | undefined;
    return row ? bridgeAgentSummary(row, this.listAgentBindings(agentId)) : null;
  }

  private requireBridgeAgent(agentId: string) {
    const agent = this.getBridgeAgent(agentId);
    if (!agent) throw new ApiError(404, "Bridge agent not found");
    return agent;
  }

  listBridgeAgents(): BridgeAgentSummary[] {
    const rows = this.db.prepare(`SELECT ${BRIDGE_AGENT_FIELDS} FROM bridge_agents ORDER BY created_at, rowid`).all() as unknown as BridgeAgentRow[];
    const bindings = this.db.prepare(`${BINDING_SELECT} ORDER BY p.name, p.id`).all() as unknown as BindingRow[];
    const grouped = new Map<string, BridgeAgentBindingSummary[]>();
    for (const row of bindings) {
      if (!grouped.has(row.agent_id)) grouped.set(row.agent_id, []);
      grouped.get(row.agent_id)!.push(bindingView(row));
    }
    return rows.map(row => bridgeAgentSummary(row, grouped.get(row.id) ?? []));
  }

  findBridgeAgentByToken(rawToken: string): BridgeAgentSummary | null {
    if (typeof rawToken !== "string" || !/^rdbr_[a-f0-9]{48}$/.test(rawToken)) return null;
    const hash = createHash("sha256").update(rawToken).digest("hex");
    const candidates = this.db.prepare("SELECT id, token_hash FROM bridge_agents WHERE token_prefix = ?").all(rawToken.slice(0, 12));
    const match = candidates.find(row => safeEqual(String(row.token_hash), hash));
    return match ? this.getBridgeAgent(String(match.id)) : null;
  }

  updateBridgeAgent(agentId: string, patch: BridgeAgentPatch): BridgeAgentSummary {
    const agent = this.requireBridgeAgent(agentId);
    if (Object.keys(patch).some(key => !["name", "max_concurrency", "accept_cli_runs"].includes(key))) {
      throw new ApiError(400, "Unknown bridge agent setting");
    }
    verifyBridgeLimits(patch);
    const name = patch.name === undefined ? agent.name : field({ name: patch.name }, "name", 100);
    this.db.prepare("UPDATE bridge_agents SET name = ?, max_concurrency = ?, accept_cli_runs = ?, updated_at = ? WHERE id = ?")
      .run(name, patch.max_concurrency ?? agent.max_concurrency, Number(patch.accept_cli_runs ?? agent.accept_cli_runs), nowIso(), agentId);
    return this.requireBridgeAgent(agentId);
  }

  rotateBridgeAgentToken(agentId: string): { agent: BridgeAgentSummary; token: string } {
    const { token, hash, prefix } = bridgeToken();
    const { changes } = this.db.prepare("UPDATE bridge_agents SET token_hash = ?, token_prefix = ?, updated_at = ? WHERE id = ?")
      .run(hash, prefix, nowIso(), agentId);
    if (!changes) throw new ApiError(404, "Bridge agent not found");
    return { agent: this.requireBridgeAgent(agentId), token };
  }

  deleteBridgeAgent(agentId: string): void {
    if (!this.db.prepare("DELETE FROM bridge_agents WHERE id = ?").run(agentId).changes) throw new ApiError(404, "Bridge agent not found");
  }

  updateBridgeAgentTelemetry(agentId: string, telemetry: BridgeTelemetry): void {
    verifyBridgeLimits(telemetry);
    const json = (v: unknown) => v === undefined ? null : JSON.stringify(v);
    const now = nowIso();
    const { changes } = this.db.prepare(`UPDATE bridge_agents SET hostname = coalesce(?, hostname), platform = coalesce(?, platform),
      bridge_version = coalesce(?, bridge_version), max_concurrency = coalesce(?, max_concurrency), accept_cli_runs = coalesce(?, accept_cli_runs),
      runtimes_json = coalesce(?, runtimes_json), models_json = coalesce(?, models_json), capabilities_json = coalesce(?, capabilities_json),
      last_seen_at = ?, updated_at = ? WHERE id = ?`).run(telemetry.hostname ?? null, telemetry.platform ?? null,
        telemetry.bridge_version ?? null, telemetry.max_concurrency ?? null, telemetry.accept_cli_runs === undefined ? null : Number(telemetry.accept_cli_runs),
        json(telemetry.runtimes), json(telemetry.models), json(telemetry.capabilities), telemetry.last_seen_at ?? now, now, agentId);
    if (!changes) throw new ApiError(404, "Bridge agent not found");
  }

  listProjectAgentBindings(projectId: string): BridgeAgentBindingSummary[] {
    const rows = this.db.prepare(`${BINDING_SELECT} WHERE b.project_id = ? ORDER BY b.agent_id`).all(projectId) as unknown as BindingRow[];
    return rows.map(bindingView);
  }

  listAgentBindings(agentId: string): BridgeAgentBindingSummary[] {
    const rows = this.db.prepare(`${BINDING_SELECT} WHERE b.agent_id = ? ORDER BY p.name, p.id`).all(agentId) as unknown as BindingRow[];
    return rows.map(bindingView);
  }

  getProjectAgentBinding(projectId: string, agentId: string): BridgeAgentBindingSummary | null {
    const row = this.db.prepare(`${BINDING_SELECT} WHERE b.project_id = ? AND b.agent_id = ?`).get(projectId, agentId) as unknown as BindingRow | undefined;
    return row ? bindingView(row) : null;
  }

  upsertProjectAgentBinding(projectId: string, agentId: string, patch: BindingPatch): BridgeAgentBindingSummary {
    this.getProjectRow(projectId);
    this.requireBridgeAgent(agentId);
    const previous = this.getProjectAgentBinding(projectId, agentId);
    const workdir = patch.workdir ?? previous?.workdir ?? "";
    const samePath = previous?.workdir === workdir;
    const pathOk = Boolean(workdir && (patch.path_ok ?? (samePath && previous?.path_ok)));
    this.db.prepare(`INSERT INTO project_agent_bindings(project_id, agent_id, workdir, path_ok, path_error, allow_datasource_secrets, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, agent_id) DO UPDATE SET workdir = excluded.workdir,
      path_ok = excluded.path_ok, path_error = excluded.path_error, allow_datasource_secrets = excluded.allow_datasource_secrets,
      enabled = excluded.enabled, updated_at = excluded.updated_at`).run(projectId, agentId, workdir, Number(pathOk),
        patch.path_error ?? (samePath ? previous.path_error : ""), Number(patch.allow_datasource_secrets ?? previous?.allow_datasource_secrets ?? false),
        Number(patch.enabled ?? previous?.enabled ?? true), nowIso());
    return this.getProjectAgentBinding(projectId, agentId)!;
  }

  getProjectExecutionRouting(projectId: string): ProjectRoutingConfig {
    const stored: Partial<ProjectRoutingConfig> = JSON.parse(this.getProjectRow(projectId).execution_routing_json);
    return {
      priority: stored.priority ?? [],
      auto_fallback: stored.auto_fallback ?? true,
      route_cli_runs: stored.route_cli_runs ?? true,
      auto_dispatch_tasks: stored.auto_dispatch_tasks ?? false,
      ...(stored.task_runtime ? { task_runtime: stored.task_runtime } : {}),
      ...(stored.task_model !== undefined ? { task_model: stored.task_model } : {}),
      ...(stored.task_reasoning_effort ? { task_reasoning_effort: stored.task_reasoning_effort } : {}),
      task_network_access: stored.task_network_access ?? true,
    };
  }

  updateProjectExecutionRouting(projectId: string, patch: Partial<ProjectRoutingConfig>): ProjectRoutingConfig {
    const current = this.getProjectExecutionRouting(projectId);
    const nextRuntime = "task_runtime" in patch ? patch.task_runtime : current.task_runtime;
    const nextModel = "task_model" in patch ? patch.task_model : current.task_model;
    const nextEffort = "task_reasoning_effort" in patch ? patch.task_reasoning_effort : current.task_reasoning_effort;
    const routing: ProjectRoutingConfig = {
      priority: patch.priority ?? current.priority,
      auto_fallback: patch.auto_fallback ?? current.auto_fallback,
      route_cli_runs: patch.route_cli_runs ?? current.route_cli_runs,
      auto_dispatch_tasks: patch.auto_dispatch_tasks ?? current.auto_dispatch_tasks,
      ...(nextRuntime ? { task_runtime: nextRuntime } : {}),
      ...(nextModel ? { task_model: nextModel } : {}),
      ...(nextEffort ? { task_reasoning_effort: nextEffort } : {}),
      task_network_access: patch.task_network_access ?? current.task_network_access,
    };
    this.db.prepare("UPDATE projects SET execution_routing_json = ? WHERE id = ?")
      .run(JSON.stringify(routing), projectId);
    return routing;
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
        `INSERT INTO projects(id, name, repo, repos, intake_key, bot_key, agent_key, allowed_origins, created_at, agent_instructions, automation_paused, delivery_mode, widget_code_context)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return this.getProjectDetail(projectId);
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
    let deployPolicyJson = project.deploy_policy_json ?? "{}";
    if ("deploy_policy" in data && data.deploy_policy !== undefined) {
      if (!data.deploy_policy || typeof data.deploy_policy !== "object" || Array.isArray(data.deploy_policy)) {
        throw new ApiError(400, "deploy_policy must be an object");
      }
      const nextPolicy = parseDeployPolicyPatch(
        normalizeDeployPolicy(deployPolicyJson),
        data.deploy_policy as Record<string, unknown>,
      );
      deployPolicyJson = JSON.stringify(nextPolicy);
    }
    this.db
      .prepare(
        "UPDATE projects SET name = ?, repo = ?, repos = ?, allowed_origins = ?, agent_instructions = ?, automation_paused = ?, delivery_mode = ?, widget_code_context = ?, deploy_policy_json = ? WHERE id = ?",
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
        deployPolicyJson,
        projectId,
      );
    return this.getProjectDetail(projectId);
  }

  listTasks(projectId: string): TaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.*,
           (SELECT COUNT(*) FROM messages m WHERE m.task_id = t.id AND m.kind = 'comment') AS message_count,
           (SELECT COUNT(*) FROM tasks sub WHERE sub.merged_into = t.id) AS merged_count,
           s.id AS agent_session_id,
           s.status AS agent_session_status,
           s.resolved_target AS agent_session_target,
           r.number AS release_number
         FROM tasks t
         LEFT JOIN chat_sessions s ON s.task_id = t.id AND s.kind = 'task'
         LEFT JOIN releases r ON r.id = t.release_id
         WHERE t.project_id = ?
         ORDER BY t.updated_at DESC, t.number DESC`,
      )
      .all(projectId) as unknown as RawTaskRow[];
    return rows.map(toTaskView);
  }

  getTaskView(taskId: string): TaskRecord {
    const row = this.db
      .prepare(
        `SELECT t.*,
           (SELECT COUNT(*) FROM messages m WHERE m.task_id = t.id AND m.kind = 'comment') AS message_count,
           (SELECT COUNT(*) FROM tasks sub WHERE sub.merged_into = t.id) AS merged_count,
           s.id AS agent_session_id,
           s.status AS agent_session_status,
           s.resolved_target AS agent_session_target,
           r.number AS release_number
         FROM tasks t
         LEFT JOIN chat_sessions s ON s.task_id = t.id AND s.kind = 'task'
         LEFT JOIN releases r ON r.id = t.release_id
         WHERE t.id = ?`,
      )
      .get(taskId) as unknown as RawTaskRow | undefined;
    if (!row) throw new ApiError(404, "Record not found");
    return toTaskView(row);
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
      if (project.automation_paused) return null;
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

  claimCliRunById(projectId: string, runId: string): ClaimedCliRun | null {
    return this.transaction(true, () => {
      const project = this.getProjectRow(projectId);
      this.expireCliRuns(projectId);
      if (project.automation_paused) return null;
      const lease = tokenUrlSafe();
      const now = nowIso();
      const run = this.db.prepare(`UPDATE cli_runs SET status = 'running', lease = ?, started_at = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND status = 'queued'
        RETURNING ${CLI_FIELDS}`).get(lease, now, now, runId, projectId) as unknown as CliRun | undefined;
      if (!run) return null;
      return { run, lease, context: {
        task: toTaskView(this.cliTask(projectId, run.task_id)), project: toAgentProject(project),
        messages: this.getTaskMessages(run.task_id, 30),
      } };
    });
  }

  requeueCliRun(projectId: string, runId: string, lease: string): boolean {
    return this.transaction(true, () => {
      const row = this.db.prepare("SELECT status, lease FROM cli_runs WHERE id = ? AND project_id = ?")
        .get(runId, projectId) as { status: string; lease: string | null } | undefined;
      if (!row || row.status !== "running" || !row.lease || !safeEqual(lease, row.lease)) return false;
      const res = this.db.prepare("UPDATE cli_runs SET status = 'queued', lease = NULL, started_at = NULL, progress = '', updated_at = ? WHERE id = ? AND project_id = ? AND status = 'running'")
        .run(nowIso(), runId, projectId);
      return res.changes > 0;
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
      } else {
        changes.deploy_status = "not_required";
        changes.deployed_at = null;
        changes.release_id = null;
      }
      event = `${status} → ${newStatus}`;
    } else if (action === "reopen" && owner !== "agent") {
      changes = {
        status: "ready",
        owner: "none",
        lease: null,
        attempts: 0,
        resolution: null,
        deploy_status: "not_required",
        deployed_at: null,
        release_id: null,
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
        deploy_status: "not_required",
        deployed_at: null,
        release_id: null,
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
    return { task: this.getTaskView(task.id) };
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
        deploy_status: "not_required",
        deployed_at: null,
        release_id: null,
      });
      this.addMessage(taskId, "event", "human", "Reopened by operator comment");
      reopened = true;
    }
    return {
      message,
      task: this.getTaskView(taskId),
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

    return toTaskView(this.getTaskRow(task.id));
  }

  findProjectTask(projectId: string, ref: unknown): RawTaskRow {
    if (typeof ref === "number" && Number.isInteger(ref) && ref > 0) {
      const row = this.db
        .prepare("SELECT * FROM tasks WHERE project_id = ? AND number = ? LIMIT 1")
        .get(projectId, ref) as unknown as RawTaskRow | undefined;
      if (!row) throw new ApiError(404, `Task RD-${ref} not found`);
      return row;
    }
    const raw = typeof ref === "string" ? ref.trim() : "";
    if (!raw || raw.length > 128) {
      throw new ApiError(400, "Invalid task reference");
    }
    const codeMatch = /^(?:rd-|#)?(\d+)$/i.exec(raw);
    if (codeMatch) {
      const num = Number(codeMatch[1]);
      if (Number.isInteger(num) && num > 0) {
        const byNum = this.db
          .prepare("SELECT * FROM tasks WHERE project_id = ? AND number = ? LIMIT 1")
          .get(projectId, num) as unknown as RawTaskRow | undefined;
        if (byNum) return byNum;
      }
    }
    const byId = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ? LIMIT 1")
      .get(projectId, raw) as unknown as RawTaskRow | undefined;
    if (!byId) throw new ApiError(404, `Task ${raw} not found`);
    return byId;
  }

  private resolveDeployStatusOnDone(
    project: RawProjectRow,
    resolution: string | null,
    needsDeploy?: boolean,
  ): TaskDeployStatus {
    if (resolution !== "shipped") return "not_required";
    if (needsDeploy === false) return "not_required";
    const policy = normalizeDeployPolicy(project.deploy_policy_json);
    if (policy.mode === "none") return "not_required";
    return "pending";
  }

  chatAgentTaskOp(
    projectId: string,
    action: string,
    params: Record<string, unknown>,
    context?: { sessionId?: string },
  ): { result: unknown; mutated?: { task_id?: string; release_id?: string; action: string } } {
    const project = this.getProjectRow(projectId);

    if (action === "list_tasks") {
      const statusFilter =
        typeof params.status === "string" && params.status.trim()
          ? params.status.trim()
          : "";
      if (statusFilter && !STATUSES.has(statusFilter as TaskStatus)) {
        throw new ApiError(400, "Invalid status filter");
      }
      const priorityFilter =
        typeof params.priority === "string" && params.priority.trim()
          ? params.priority.trim()
          : "";
      if (priorityFilter && !PRIORITIES.has(priorityFilter as TaskPriority)) {
        throw new ApiError(400, "Invalid priority filter");
      }
      const deployStatusFilter =
        typeof params.deploy_status === "string" && params.deploy_status.trim()
          ? params.deploy_status.trim()
          : "";
      if (
        deployStatusFilter &&
        !TASK_DEPLOY_STATUSES.has(deployStatusFilter as TaskDeployStatus)
      ) {
        throw new ApiError(400, "Invalid deploy_status filter");
      }
      const search =
        typeof params.search === "string" ? params.search.trim().toLowerCase() : "";
      const includeDone = params.include_done !== false;
      const includeMerged = params.include_merged === true;
      const limit = Math.max(
        1,
        Math.min(100, Math.floor(Number(params.limit) || 30)),
      );

      let tasks = this.listTasks(projectId);
      if (!includeMerged) tasks = tasks.filter((t) => !t.merged_into);
      if (!includeDone && !statusFilter && !deployStatusFilter) {
        tasks = tasks.filter((t) => t.status !== "done");
      }
      if (statusFilter) tasks = tasks.filter((t) => t.status === statusFilter);
      if (priorityFilter) tasks = tasks.filter((t) => t.priority === priorityFilter);
      if (deployStatusFilter) {
        tasks = tasks.filter((t) => t.deploy_status === deployStatusFilter);
      }
      if (search) {
        tasks = tasks.filter(
          (t) =>
            `rd-${t.number}`.includes(search) ||
            t.title.toLowerCase().includes(search) ||
            t.body.toLowerCase().includes(search),
        );
      }

      const items = tasks.slice(0, limit).map((t) => ({
        id: t.id,
        code: `RD-${t.number}`,
        number: t.number,
        title: t.title,
        status: t.status,
        priority: t.priority,
        owner: t.owner,
        source: t.source,
        resolution: t.resolution,
        triaged_by: t.triaged_by,
        delivery_ref: t.delivery_ref,
        deploy_status: t.deploy_status,
        release_id: t.release_id,
        release_number: t.release_number ?? null,
        deployed_at: t.deployed_at,
        attempts: t.attempts,
        message_count: t.message_count ?? 0,
        merged_count: t.merged_count ?? 0,
        updated_at: t.updated_at,
        created_at: t.created_at,
        body_preview: t.body.slice(0, 300),
      }));
      return { result: { total: tasks.length, tasks: items } };
    }

    if (action === "get_task") {
      const row = this.findProjectTask(projectId, params.task ?? params.task_id ?? params.number);
      const task = this.getTaskView(row.id);
      const messages = this.getTaskMessages(row.id);
      const merged = this.getMergedTasks(row.id);
      return {
        result: {
          code: `RD-${task.number}`,
          task,
          messages,
          merged,
        },
      };
    }

    if (action === "comment_task") {
      const row = this.findProjectTask(projectId, params.task ?? params.task_id ?? params.number);
      const body = field(params, "body", 24000);
      const message = this.addMessage(row.id, "comment", "agent", body);
      let reopened = false;
      if (
        params.reopen === true &&
        !row.merged_into &&
        row.owner === "none" &&
        (row.status === "waiting" || row.status === "review" || row.status === "done")
      ) {
        this.updateTaskFields(row, {
          status: "ready",
          resolution: null,
          attempts: 0,
          deploy_status: "not_required",
          deployed_at: null,
          release_id: null,
        });
        this.addMessage(row.id, "event", "agent", "Agent reopened task via comment");
        reopened = true;
      }
      const updated = this.getTaskView(row.id);
      return {
        result: { code: `RD-${updated.number}`, message, task: updated, reopened },
        mutated: { task_id: row.id, action: "comment_task" },
      };
    }

    if (action === "update_task") {
      const row = this.findProjectTask(projectId, params.task ?? params.task_id ?? params.number);
      if (row.merged_into) {
        throw new ApiError(409, "Open the primary task to continue");
      }
      const changes: Record<string, string | number | null> = {};
      const updatedFields: string[] = [];
      if ("title" in params && params.title !== undefined) {
        const nextTitle = field(params, "title", 180);
        changes.title = nextTitle;
        updatedFields.push("title");
      }
      if ("body" in params && params.body !== undefined) {
        changes.body = field(params, "body", 24000, false);
        updatedFields.push("body");
      }
      if ("requirements" in params && params.requirements !== undefined) {
        changes.requirements = field(params, "requirements", 24000, false);
        updatedFields.push("requirements");
      }
      if ("priority" in params && params.priority !== undefined) {
        const nextPriority = field(params, "priority", 10) as TaskPriority;
        if (!PRIORITIES.has(nextPriority)) {
          throw new ApiError(400, "Unknown priority");
        }
        changes.priority = nextPriority;
        updatedFields.push(`priority → ${nextPriority}`);
      }
      if ("delivery_ref" in params && params.delivery_ref !== undefined) {
        changes.delivery_ref = field(params, "delivery_ref", 500, false);
        updatedFields.push("delivery_ref");
      }
      if (updatedFields.length === 0) {
        throw new ApiError(400, "No fields specified to update");
      }
      const ownSessionLease = Boolean(context?.sessionId && row.lease === `session:${context.sessionId}`);
      if (ownSessionLease && !row.triaged_by) {
        changes.triaged_by = "local_agent";
      }
      this.updateTaskFields(row, changes);
      this.addMessage(row.id, "event", "agent", `Agent updated ${updatedFields.join(", ")}`);
      const updated = toTaskView(this.getTaskRow(row.id));
      return {
        result: { code: `RD-${updated.number}`, task: updated },
        mutated: { task_id: row.id, action: "update_task" },
      };
    }

    if (action === "transition_task") {
      const row = this.findProjectTask(projectId, params.task ?? params.task_id ?? params.number);
      if (row.merged_into) {
        throw new ApiError(409, "Open the primary task to continue");
      }
      const ownSessionLease = Boolean(context?.sessionId && row.lease === `session:${context.sessionId}`);
      if (row.owner === "agent" && row.lease && !ownSessionLease) {
        throw new ApiError(
          409,
          "Another autonomous agent worker currently holds an active lease on this task",
        );
      }
      const comment =
        "comment" in params && params.comment !== undefined
          ? field(params, "comment", 24000, false)
          : "";
      const mergeIntoRef = params.merge_into;
      if (mergeIntoRef !== undefined && mergeIntoRef !== null && String(mergeIntoRef).trim() !== "") {
        const target = this.findProjectTask(projectId, mergeIntoRef);
        if (target.id === row.id || target.merged_into || target.status === "done") {
          throw new ApiError(409, "Select an open, unmerged target task in this project");
        }
        this.db
          .prepare("UPDATE tasks SET merged_into = ? WHERE merged_into = ?")
          .run(target.id, row.id);
        this.updateTaskFields(row, {
          merged_into: target.id,
          status: "done",
          owner: "none",
          lease: null,
          resolution: "merged",
          deploy_status: "not_required",
          deployed_at: null,
          release_id: null,
        });
        if (comment) {
          this.addMessage(row.id, "comment", "agent", comment);
        }
        this.addMessage(row.id, "event", "agent", `Agent merged into RD-${target.number}`);
        this.updateTaskFields(target, {});
        this.addMessage(
          target.id,
          "event",
          "agent",
          `Linked feedback RD-${row.number}: ${row.title}`,
        );
        const updated = this.getTaskView(row.id);
        return {
          result: { code: `RD-${updated.number}`, task: updated, merged_into: `RD-${target.number}` },
          mutated: { task_id: row.id, action: "transition_task" },
        };
      }

      const nextStatus = field(params, "status", 16) as TaskStatus;
      if (!STATUSES.has(nextStatus) || nextStatus === "handoff") {
        throw new ApiError(400, "Invalid target status (allowed: triage, ready, working, waiting, review, done)");
      }
      let needsDeploy: boolean | undefined;
      if ("needs_deploy" in params && params.needs_deploy !== undefined) {
        if (typeof params.needs_deploy !== "boolean") {
          throw new ApiError(400, "needs_deploy must be a boolean");
        }
        needsDeploy = params.needs_deploy;
      }
      const changes: Record<string, string | number | null> = { status: nextStatus };
      if (nextStatus === "working") {
        changes.owner = "agent";
        changes.lease = ownSessionLease ? row.lease : null;
        changes.last_seen = nowIso();
        changes.resolution = null;
        changes.deploy_status = "not_required";
        changes.deployed_at = null;
        changes.release_id = null;
      } else if (nextStatus === "done") {
        const rawRes =
          "resolution" in params && params.resolution !== undefined && params.resolution !== null
            ? field(params, "resolution", 16, false)
            : "";
        if (rawRes && rawRes !== "shipped" && rawRes !== "dismissed" && rawRes !== "wontfix") {
          throw new ApiError(400, "Invalid resolution (allowed: shipped, dismissed, wontfix)");
        }
        const effectiveRes = rawRes || "shipped";
        changes.owner = "none";
        changes.lease = null;
        changes.resolution = effectiveRes as TaskResolution;
        changes.deploy_status = this.resolveDeployStatusOnDone(project, effectiveRes, needsDeploy);
        changes.deployed_at = null;
        changes.release_id = null;
        if (ownSessionLease && rawRes === "dismissed" && !row.triaged_by) {
          changes.triaged_by = "local_agent";
        }
      } else {
        changes.owner = "none";
        changes.lease = null;
        changes.resolution = null;
        changes.deploy_status = "not_required";
        changes.deployed_at = null;
        changes.release_id = null;
      }
      if ("delivery_ref" in params && params.delivery_ref !== undefined) {
        changes.delivery_ref = field(params, "delivery_ref", 500, false);
      }
      this.updateTaskFields(row, changes);
      if (comment) {
        this.addMessage(row.id, "comment", "agent", comment);
      }
      this.addMessage(
        row.id,
        "event",
        "agent",
        `Agent transitioned status: ${row.status} → ${nextStatus}`,
      );
      const updated = this.getTaskView(row.id);
      return {
        result: { code: `RD-${updated.number}`, task: updated },
        mutated: { task_id: row.id, action: "transition_task" },
      };
    }

    if (action === "list_releases") {
      const statusFilter =
        typeof params.status === "string" && params.status.trim()
          ? params.status.trim()
          : "";
      if (statusFilter && !RELEASE_STATUSES.has(statusFilter as ReleaseStatus)) {
        throw new ApiError(400, "Invalid release status filter");
      }
      const limit = Math.max(1, Math.min(50, Math.floor(Number(params.limit) || 20)));
      let releases = this.listReleases(projectId, 100);
      if (statusFilter) {
        releases = releases.filter((r) => r.status === statusFilter);
      }
      return {
        result: {
          total: releases.length,
          releases: releases.slice(0, limit).map((r) => ({
            ...r,
            code: `REL-${r.number}`,
          })),
        },
      };
    }

    if (action === "finish_release") {
      const releaseRef = params.release_id ?? params.release ?? params.number;
      if (releaseRef === undefined || releaseRef === null || String(releaseRef).trim() === "") {
        throw new ApiError(400, "release_id is required");
      }
      const rawStatus = field(params, "status", 16);
      if (rawStatus !== "succeeded" && rawStatus !== "failed" && rawStatus !== "blocked") {
        throw new ApiError(400, "Invalid release status (allowed: succeeded, failed, blocked)");
      }
      const summary = field(params, "summary", 16000);
      const deployRef =
        "deploy_ref" in params && params.deploy_ref !== undefined
          ? field(params, "deploy_ref", 500, false)
          : undefined;
      let deployedTaskIds: string[] | undefined;
      if ("deployed_task_ids" in params && params.deployed_task_ids !== undefined) {
        if (!Array.isArray(params.deployed_task_ids)) {
          throw new ApiError(400, "deployed_task_ids must be an array of task IDs or codes");
        }
        deployedTaskIds = params.deployed_task_ids.map((item) => {
          if (typeof item !== "string" || !item.trim()) {
            throw new ApiError(400, "Invalid entry in deployed_task_ids");
          }
          return item.trim();
        });
      }
      const { release, updatedTaskIds } = this.finishRelease(projectId, releaseRef as string | number, {
        status: rawStatus,
        summary,
        deploy_ref: deployRef,
        deployed_task_ids: deployedTaskIds,
        author: "agent",
      });
      return {
        result: {
          code: `REL-${release.number}`,
          release,
          updated_task_ids: updatedTaskIds,
        },
        mutated: { release_id: release.id, action: "finish_release" },
      };
    }

    if (action === "create_task") {
      const title = field(params, "title", 180);
      const body =
        "body" in params && params.body !== undefined
          ? field(params, "body", 24000, false) || title
          : title;
      const priority =
        "priority" in params && params.priority !== undefined
          ? (field(params, "priority", 10) as TaskPriority)
          : "normal";
      if (!PRIORITIES.has(priority)) {
        throw new ApiError(400, "Unknown priority");
      }
      const status =
        "status" in params && params.status !== undefined
          ? (field(params, "status", 16) as TaskStatus)
          : "triage";
      if (status !== "triage" && status !== "ready") {
        throw new ApiError(400, "New tasks can only start in triage or ready");
      }
      const requirements =
        "requirements" in params && params.requirements !== undefined
          ? field(params, "requirements", 24000, false)
          : "";
      const created = this.createTask(projectId, { title, body, priority }, "console");
      const extra: Record<string, string | number | null> = {};
      if (requirements) extra.requirements = requirements;
      if (status === "ready") extra.status = "ready";
      if (Object.keys(extra).length > 0) {
        this.updateTaskFields(created, extra);
      }
      this.addMessage(created.id, "event", "agent", "Agent created task from chat");
      const view = toTaskView(this.getTaskRow(created.id));
      return {
        result: { code: `RD-${view.number}`, task: view },
        mutated: { task_id: created.id, action: "create_task" },
      };
    }

    throw new ApiError(400, `Unknown task action: ${action}`);
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
      const needsDeploy = typeof data.needs_deploy === "boolean" ? data.needs_deploy : undefined;
      const nextDeployStatus: TaskDeployStatus = completeNow
        ? this.resolveDeployStatusOnDone(project, nextResolution, needsDeploy)
        : "not_required";
      const fallback = completeNow
        ? "Agent shipped and completed task"
        : "Agent submitted task for review";
      this.updateTaskFields(task, {
        lease: null,
        status: nextStatus,
        owner: "none",
        resolution: nextResolution,
        deploy_status: nextDeployStatus,
        deployed_at: null,
        release_id: null,
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

  /* ── Web Codex / CLI Chat Sessions ────────────────────────────────────── */

  private mapChatMessageRow(row: {
    id: string;
    session_id: string;
    role: "user" | "assistant" | "system";
    content: string;
    events_json: string;
    attachments_json: string;
    status: "streaming" | "done" | "error" | "aborted";
    created_at: string;
    stop_reason?: ChatMessageRecord["stop_reason"] | null;
  }): ChatMessageRecord {
    let events: ChatToolEvent[] = [];
    let attachments: ChatContextRef[] = [];
    try {
      const parsed = JSON.parse(row.events_json) as unknown;
      if (Array.isArray(parsed)) events = parsed as ChatToolEvent[];
    } catch {
      events = [];
    }
    try {
      const parsed = JSON.parse(row.attachments_json) as unknown;
      if (Array.isArray(parsed)) attachments = parsed as ChatContextRef[];
    } catch {
      attachments = [];
    }
    return {
      id: row.id,
      session_id: row.session_id,
      role: row.role,
      content: row.content,
      events,
      attachments,
      status: row.status,
      ...(row.stop_reason && { stop_reason: row.stop_reason }),
      created_at: row.created_at,
    };
  }

  listChatSessions(projectId: string, kind: ChatSessionKind | "all" = "chat"): ChatSessionRecord[] {
    this.getProjectRow(projectId);
    const whereKind = kind === "all" ? "" : " AND s.kind = ?";
    const sql = `SELECT s.*,
          (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count,
          (SELECT m.content FROM chat_messages m WHERE m.session_id = s.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message_preview
         FROM chat_sessions s
         WHERE s.project_id = ?${whereKind}
         ORDER BY s.updated_at DESC, s.rowid DESC
         LIMIT 100`;
    const rows = (
      kind === "all"
        ? this.db.prepare(sql).all(projectId)
        : this.db.prepare(sql).all(projectId, kind)
    ) as unknown as Array<
      Omit<ChatSessionRecord, "network_access" | "kind" | "task_id" | "release_id"> & {
        kind?: string;
        task_id?: string | null;
        release_id?: string | null;
        network_access?: number;
        message_count: number;
        last_message_preview: string | null;
      }
    >;
    return rows.map((row) => ({
      ...row,
      kind: normalizeChatSessionKind(row.kind),
      task_id: row.task_id ?? null,
      release_id: row.release_id ?? null,
      network_access: Boolean(row.network_access),
      message_count: Number(row.message_count ?? 0),
      last_message_preview: row.last_message_preview
        ? row.last_message_preview.replace(/\s+/g, " ").trim().slice(0, 120)
        : "",
    }));
  }

  getChatSession(projectId: string, sessionId: string): ChatSessionRecord {
    this.getProjectRow(projectId);
    const row = this.db
      .prepare("SELECT * FROM chat_sessions WHERE id = ? AND project_id = ?")
      .get(sessionId, projectId) as unknown as
      | (Omit<ChatSessionRecord, "network_access" | "kind" | "task_id" | "release_id"> & {
          kind?: string;
          task_id?: string | null;
          release_id?: string | null;
          network_access?: number;
        })
      | undefined;
    if (!row) throw new ApiError(404, "对话会话不存在");
    return {
      ...row,
      kind: normalizeChatSessionKind(row.kind),
      task_id: row.task_id ?? null,
      release_id: row.release_id ?? null,
      network_access: Boolean(row.network_access),
    };
  }

  getTaskChatSession(taskId: string): ChatSessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM chat_sessions WHERE task_id = ? AND kind = 'task' LIMIT 1")
      .get(taskId) as unknown as
      | (Omit<ChatSessionRecord, "network_access" | "kind" | "task_id" | "release_id"> & {
          kind?: string;
          task_id?: string | null;
          release_id?: string | null;
          network_access?: number;
        })
      | undefined;
    if (!row) return null;
    return {
      ...row,
      kind: "task",
      task_id: row.task_id ?? taskId,
      release_id: row.release_id ?? null,
      network_access: Boolean(row.network_access),
    };
  }

  getReleaseChatSession(releaseId: string): ChatSessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM chat_sessions WHERE release_id = ? AND kind = 'release' LIMIT 1")
      .get(releaseId) as unknown as
      | (Omit<ChatSessionRecord, "network_access" | "kind" | "task_id" | "release_id"> & {
          kind?: string;
          task_id?: string | null;
          release_id?: string | null;
          network_access?: number;
        })
      | undefined;
    if (!row) return null;
    return {
      ...row,
      kind: "release",
      task_id: row.task_id ?? null,
      release_id: row.release_id ?? releaseId,
      network_access: Boolean(row.network_access),
    };
  }

  createChatSession(
    projectId: string,
    data: Partial<Pick<ChatSessionRecord,
      "kind" | "task_id" | "release_id" | "title" | "runtime" | "model" | "reasoning_effort" | "execution_target" | "sandbox_mode" | "network_access"
    >> = {},
  ): ChatSessionRecord {
    this.getProjectRow(projectId);
    const kind: ChatSessionKind = normalizeChatSessionKind(data.kind);
    const taskId = kind === "task" && typeof data.task_id === "string" && data.task_id.trim()
      ? data.task_id.trim()
      : null;
    const releaseId = kind === "release" && typeof data.release_id === "string" && data.release_id.trim()
      ? data.release_id.trim()
      : null;
    const title =
      typeof data.title === "string" && data.title.trim()
        ? data.title.trim().slice(0, 120)
        : "新对话";
    const runtime: ChatRuntime = data.runtime === "claude" ? "claude" : "codex";
    const model =
      typeof data.model === "string" ? data.model.trim().slice(0, 160) : "";
    const sandboxMode: ChatSandboxMode =
      data.sandbox_mode === "workspace-write" ? "workspace-write" : "read-only";
    const networkAccess = data.network_access === true ? 1 : 0;
    const id = uuidHex();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO chat_sessions(id, project_id, kind, task_id, release_id, title, runtime, model, reasoning_effort, execution_target, sandbox_mode, network_access, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, kind, taskId, releaseId, title, runtime, model, data.reasoning_effort ?? "default",
        data.execution_target ?? "auto", sandboxMode, networkAccess, now, now);
    return this.getChatSession(projectId, id);
  }

  /* ── Event-Driven Task Session Lifecycle Helpers ──────────────────────── */

  hasActiveRelease(projectId: string): boolean {
    const running = this.db
      .prepare("SELECT 1 FROM releases WHERE project_id = ? AND status = 'running' LIMIT 1")
      .get(projectId);
    return Boolean(running);
  }

  getActiveRelease(projectId: string): ReleaseRecord | null {
    const row = this.db
      .prepare("SELECT * FROM releases WHERE project_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1")
      .get(projectId) as unknown as RawReleaseRow | undefined;
    return row ? toReleaseView(row) : null;
  }

  hasActiveAgentTask(projectId: string): boolean {
    const working = this.db
      .prepare(
        "SELECT 1 FROM tasks WHERE project_id = ? AND owner = 'agent' AND status = 'working' AND merged_into IS NULL LIMIT 1",
      )
      .get(projectId);
    if (working) return true;
    const runningSession = this.db
      .prepare(
        "SELECT 1 FROM chat_sessions WHERE project_id = ? AND kind IN ('task', 'release') AND status = 'running' LIMIT 1",
      )
      .get(projectId);
    if (runningSession) return true;
    return this.hasActiveRelease(projectId);
  }

  hasPendingReadyTasks(projectId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM tasks WHERE project_id = ? AND status = 'ready' AND owner = 'none' AND merged_into IS NULL LIMIT 1",
      )
      .get(projectId);
    return Boolean(row);
  }

  listTasksByDeployStatus(projectId: string, statuses: TaskDeployStatus[]): TaskRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT t.*,
           (SELECT COUNT(*) FROM messages m WHERE m.task_id = t.id AND m.kind = 'comment') AS message_count,
           (SELECT COUNT(*) FROM tasks sub WHERE sub.merged_into = t.id) AS merged_count,
           s.id AS agent_session_id,
           s.status AS agent_session_status,
           s.resolved_target AS agent_session_target,
           r.number AS release_number
         FROM tasks t
         LEFT JOIN chat_sessions s ON s.task_id = t.id AND s.kind = 'task'
         LEFT JOIN releases r ON r.id = t.release_id
         WHERE t.project_id = ? AND t.merged_into IS NULL AND t.deploy_status IN (${placeholders})
         ORDER BY
           CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           t.number ASC`,
      )
      .all(projectId, ...statuses) as unknown as RawTaskRow[];
    return rows.map(toTaskView);
  }

  getLastRelease(projectId: string): ReleaseRecord | null {
    const row = this.db
      .prepare("SELECT * FROM releases WHERE project_id = ? ORDER BY number DESC LIMIT 1")
      .get(projectId) as unknown as RawReleaseRow | undefined;
    return row ? toReleaseView(row) : null;
  }

  listReleases(projectId: string, limit = 50): ReleaseRecord[] {
    this.getProjectRow(projectId);
    const capped = Math.max(1, Math.min(200, Math.floor(limit || 50)));
    const rows = this.db
      .prepare("SELECT * FROM releases WHERE project_id = ? ORDER BY number DESC LIMIT ?")
      .all(projectId, capped) as unknown as RawReleaseRow[];
    return rows.map(toReleaseView);
  }

  findProjectRelease(projectId: string, ref: string | number): RawReleaseRow {
    if (typeof ref === "number" && Number.isInteger(ref) && ref > 0) {
      const row = this.db
        .prepare("SELECT * FROM releases WHERE project_id = ? AND number = ? LIMIT 1")
        .get(projectId, ref) as unknown as RawReleaseRow | undefined;
      if (!row) throw new ApiError(404, `Release REL-${ref} not found`);
      return row;
    }
    const raw = typeof ref === "string" ? ref.trim() : "";
    if (!raw || raw.length > 128) {
      throw new ApiError(400, "Invalid release reference");
    }
    const codeMatch = /^(?:rel-|#)?(\d+)$/i.exec(raw);
    if (codeMatch) {
      const num = Number(codeMatch[1]);
      if (Number.isInteger(num) && num > 0) {
        const byNum = this.db
          .prepare("SELECT * FROM releases WHERE project_id = ? AND number = ? LIMIT 1")
          .get(projectId, num) as unknown as RawReleaseRow | undefined;
        if (byNum) return byNum;
      }
    }
    const byId = this.db
      .prepare("SELECT * FROM releases WHERE project_id = ? AND id = ? LIMIT 1")
      .get(projectId, raw) as unknown as RawReleaseRow | undefined;
    if (!byId) throw new ApiError(404, `Release ${raw} not found`);
    return byId;
  }

  getRelease(projectId: string, releaseIdOrRef: string | number): ReleaseRecord {
    return toReleaseView(this.findProjectRelease(projectId, releaseIdOrRef));
  }

  findReleaseById(releaseId: string): ReleaseRecord | null {
    const row = this.db
      .prepare("SELECT * FROM releases WHERE id = ? LIMIT 1")
      .get(releaseId) as unknown as RawReleaseRow | undefined;
    return row ? toReleaseView(row) : null;
  }

  createRelease(
    projectId: string,
    options: {
      trigger: ReleaseTrigger;
      taskIds: string[];
      runtime?: ChatRuntime;
      model?: string;
      reasoning_effort?: ChatSessionRecord["reasoning_effort"];
      execution_target?: string;
      network_access?: boolean;
    },
  ): { release: ReleaseRecord; session: ChatSessionRecord } {
    return this.transaction(true, () => {
      this.getProjectRow(projectId);
      if (this.hasActiveRelease(projectId)) {
        throw new ApiError(409, "A release is already running for this project");
      }

      const uniqueTaskIds = [...new Set(options.taskIds.filter((id) => typeof id === "string" && id.trim()))];
      const snapshot: ReleaseTaskSnapshot[] = [];
      const claimedTaskIds: string[] = [];
      for (const taskId of uniqueTaskIds) {
        const task = this.db
          .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ? AND merged_into IS NULL")
          .get(taskId, projectId) as unknown as RawTaskRow | undefined;
        if (!task) continue;
        if (task.deploy_status !== "pending" && task.deploy_status !== "failed") continue;
        claimedTaskIds.push(task.id);
        snapshot.push({
          id: task.id,
          number: task.number,
          title: task.title,
          priority: task.priority as TaskPriority,
          delivery_ref: task.delivery_ref ?? "",
        });
      }

      const nextRow = this.db
        .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next_num FROM releases WHERE project_id = ?")
        .get(projectId) as unknown as { next_num: number };
      const releaseNumber = nextRow.next_num;
      const releaseId = uuidHex();
      const sessionId = uuidHex();
      const now = nowIso();
      const title = `REL-${releaseNumber} 发布${claimedTaskIds.length > 0 ? `（${claimedTaskIds.length} 个任务）` : ""}`;
      const runtime: ChatRuntime = options.runtime === "claude" ? "claude" : "codex";
      const model = typeof options.model === "string" ? options.model.trim().slice(0, 160) : "";
      const reasoningEffort = options.reasoning_effort ?? "default";
      const executionTarget = options.execution_target ?? "auto";
      const networkAccess = options.network_access === false ? 0 : 1;

      this.db
        .prepare(
          `INSERT INTO releases(id, project_id, number, trigger, status, session_id, task_ids_json, task_snapshot_json, deploy_ref, summary, created_at, updated_at, finished_at)
           VALUES(?, ?, ?, ?, 'running', ?, ?, ?, '', '', ?, ?, NULL)`,
        )
        .run(
          releaseId,
          projectId,
          releaseNumber,
          options.trigger,
          sessionId,
          JSON.stringify(claimedTaskIds),
          JSON.stringify(snapshot),
          now,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO chat_sessions(id, project_id, kind, task_id, release_id, title, runtime, model, reasoning_effort, execution_target, sandbox_mode, network_access, created_at, updated_at)
           VALUES(?, ?, 'release', NULL, ?, ?, ?, ?, ?, ?, 'workspace-write', ?, ?, ?)`,
        )
        .run(
          sessionId,
          projectId,
          releaseId,
          title,
          runtime,
          model,
          reasoningEffort,
          executionTarget,
          networkAccess,
          now,
          now,
        );

      for (const taskId of claimedTaskIds) {
        this.db
          .prepare("UPDATE tasks SET deploy_status = 'deploying', release_id = ?, updated_at = ? WHERE id = ?")
          .run(releaseId, now, taskId);
        this.addMessage(taskId, "event", "system", `Queued for release REL-${releaseNumber}`);
      }

      return {
        release: this.getRelease(projectId, releaseId),
        session: this.getChatSession(projectId, sessionId),
      };
    });
  }

  finishRelease(
    projectId: string,
    releaseRef: string | number,
    payload: {
      status: "succeeded" | "failed" | "blocked";
      summary: string;
      deploy_ref?: string;
      deployed_task_ids?: string[];
      author?: "agent" | "system";
    },
  ): { release: ReleaseRecord; updatedTaskIds: string[] } {
    return this.transaction(true, () => {
      const row = this.findProjectRelease(projectId, releaseRef);
      if (row.status !== "running") {
        throw new ApiError(409, `Release REL-${row.number} is already finished (${row.status})`);
      }
      const release = toReleaseView(row);
      const now = nowIso();
      const author = payload.author ?? "agent";
      const deployRef = payload.deploy_ref?.trim() ?? release.deploy_ref ?? "";
      const summary = payload.summary.trim().slice(0, 16000);
      const updatedTaskIds: string[] = [];

      if (payload.status === "succeeded") {
        let targetIds: Set<string>;
        if (payload.deployed_task_ids && payload.deployed_task_ids.length > 0) {
          targetIds = new Set<string>();
          for (const ref of payload.deployed_task_ids) {
            try {
              const found = this.findProjectTask(projectId, ref);
              targetIds.add(found.id);
            } catch {
              // Ignore unknown task references if agent listed an unrelated code
            }
          }
        } else {
          targetIds = new Set<string>(release.task_ids);
        }

        for (const taskId of targetIds) {
          const taskRow = this.db
            .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
            .get(taskId, projectId) as unknown as RawTaskRow | undefined;
          if (!taskRow) continue;
          if (
            taskRow.deploy_status === "deploying" ||
            taskRow.deploy_status === "pending" ||
            taskRow.deploy_status === "failed"
          ) {
            this.db
              .prepare(
                "UPDATE tasks SET deploy_status = 'deployed', deployed_at = ?, release_id = ?, updated_at = ? WHERE id = ?",
              )
              .run(now, release.id, now, taskId);
            this.addMessage(
              taskId,
              "event",
              author,
              `Released in REL-${release.number}${deployRef ? ` (${deployRef})` : ""}`,
            );
            updatedTaskIds.push(taskId);
          }
        }

        // Any tasks claimed by this release that were NOT deployed return to pending.
        for (const taskId of release.task_ids) {
          if (targetIds.has(taskId)) continue;
          const taskRow = this.db
            .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
            .get(taskId, projectId) as unknown as RawTaskRow | undefined;
          if (taskRow && taskRow.deploy_status === "deploying" && taskRow.release_id === release.id) {
            this.db
              .prepare(
                "UPDATE tasks SET deploy_status = 'pending', release_id = NULL, updated_at = ? WHERE id = ?",
              )
              .run(now, taskId);
            this.addMessage(
              taskId,
              "event",
              author,
              `Not included in REL-${release.number}; returned to pending deploy`,
            );
          }
        }
      } else {
        for (const taskId of release.task_ids) {
          const taskRow = this.db
            .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
            .get(taskId, projectId) as unknown as RawTaskRow | undefined;
          if (taskRow && taskRow.deploy_status === "deploying" && taskRow.release_id === release.id) {
            this.db
              .prepare("UPDATE tasks SET deploy_status = 'failed', updated_at = ? WHERE id = ?")
              .run(now, taskId);
            this.addMessage(
              taskId,
              "event",
              author,
              `Release REL-${release.number} ${payload.status}: ${summary.slice(0, 300)}`,
            );
            updatedTaskIds.push(taskId);
          }
        }
      }

      this.db
        .prepare(
          `UPDATE releases
           SET status = ?, summary = ?, deploy_ref = ?, updated_at = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(payload.status, summary, deployRef, now, now, release.id);

      return {
        release: this.getRelease(projectId, release.id),
        updatedTaskIds,
      };
    });
  }

  finalizeReleaseSessionTurn(
    releaseId: string,
    sessionId: string,
    outcome: {
      status: "done" | "error" | "aborted";
      stopReason?: string;
      error?: string;
      replyContent?: string;
    },
  ): ReleaseRecord | null {
    if (outcome.status === "aborted" && outcome.stopReason === "follow_up") {
      return null;
    }
    const row = this.db
      .prepare("SELECT * FROM releases WHERE id = ? LIMIT 1")
      .get(releaseId) as unknown as RawReleaseRow | undefined;
    if (!row || row.status !== "running" || row.session_id !== sessionId) {
      return null;
    }
    let summary: string;
    if (outcome.status === "error") {
      summary = `Release session error: ${(outcome.error?.trim() || "Unknown error").slice(0, 500)}`;
    } else if (outcome.status === "aborted") {
      summary = "Release session was aborted before calling finish_release.";
    } else {
      const preview = outcome.replyContent?.trim().slice(0, 500);
      summary = preview
        ? `Release agent exited without calling finish_release. Last reply: ${preview}`
        : "Release agent exited without calling finish_release.";
    }
    return this.finishRelease(row.project_id, row.id, {
      status: "failed",
      summary,
      author: "system",
    }).release;
  }

  findNextDispatchableTask(projectId: string): RawTaskRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE project_id = ? AND status IN ('ready', 'triage') AND owner = 'none' AND merged_into IS NULL
         ORDER BY
           CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           CASE status WHEN 'ready' THEN 0 ELSE 1 END,
           number ASC
         LIMIT 1`,
      )
      .get(projectId) as unknown as RawTaskRow | undefined;
    return row ?? null;
  }

  claimTaskForSession(
    taskId: string,
    sessionId: string,
    agentLabel: string,
    reason: "auto" | "manual" | "followup" = "auto",
  ): TaskRecord {
    const task = this.getTaskRow(taskId);
    if (task.merged_into) {
      throw new ApiError(409, "Open the primary task to continue");
    }
    const lease = `session:${sessionId}`;
    const alreadyOwnedBySelf = task.owner === "agent" && task.lease === lease;
    if (task.owner === "agent" && task.lease && !alreadyOwnedBySelf) {
      throw new ApiError(409, "Another agent worker currently holds an active lease on this task");
    }
    const nextAttempts = reason === "followup" ? (task.attempts ?? 0) : (task.attempts ?? 0) + 1;
    this.updateTaskFields(task, {
      status: "working",
      owner: "agent",
      lease,
      resolution: null,
      attempts: nextAttempts,
      last_seen: nowIso(),
    });
    const eventText =
      reason === "auto"
        ? `Auto-dispatched to local agent「${agentLabel}」`
        : reason === "manual"
          ? `Dispatched to local agent「${agentLabel}」`
          : "Human followed up in agent session";
    this.addMessage(taskId, "event", reason === "followup" ? "human" : "agent", eventText);
    return this.getTaskView(taskId);
  }

  touchTaskSessionLease(taskId: string, sessionId: string): void {
    this.db
      .prepare("UPDATE tasks SET last_seen = ? WHERE id = ? AND owner = 'agent' AND lease = ?")
      .run(nowIso(), taskId, `session:${sessionId}`);
  }

  finalizeTaskSessionTurn(
    taskId: string,
    sessionId: string,
    outcome: {
      status: "done" | "error" | "aborted";
      stopReason?: string;
      error?: string;
      replyContent?: string;
    },
  ): TaskRecord | null {
    // Follow-up interruption hands over immediately to the next turn in the same session.
    if (outcome.status === "aborted" && outcome.stopReason === "follow_up") {
      return null;
    }
    const task = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as unknown as RawTaskRow | undefined;
    if (!task) return null;
    const expectedLease = `session:${sessionId}`;
    if (task.owner !== "agent" || task.lease !== expectedLease || task.status !== "working") {
      return null;
    }
    this.updateTaskFields(task, {
      status: "waiting",
      owner: "none",
      lease: null,
      last_seen: nowIso(),
    });
    if (outcome.status === "error") {
      const detail = outcome.error?.trim() ? `：${outcome.error.trim().slice(0, 300)}` : "";
      this.addMessage(taskId, "event", "agent", `Agent execution interrupted or failed${detail}; moved to waiting`);
    } else if (outcome.status === "aborted") {
      this.addMessage(taskId, "event", "agent", "Agent execution stopped by operator; moved to waiting");
    } else {
      const preview = outcome.replyContent?.trim();
      if (preview) {
        this.addMessage(taskId, "comment", "agent", preview.slice(0, 12_000));
      }
      this.addMessage(
        taskId,
        "event",
        "agent",
        "Agent finished reply without changing task status; moved to waiting",
      );
    }
    return this.getTaskView(taskId);
  }

  recoverInterruptedSessionRuns(): {
    recoveredSessions: number;
    recoveredTasks: number;
    recoveredReleases: number;
  } {
    return this.transaction(true, () => {
      const now = nowIso();
      const runningMessages = this.db
        .prepare("UPDATE chat_messages SET status = 'error' WHERE status = 'streaming'")
        .run();
      const runningSessions = this.db
        .prepare("UPDATE chat_sessions SET status = 'idle', updated_at = ? WHERE status = 'running'")
        .run(now);
      const staleTasks = this.db
        .prepare("SELECT * FROM tasks WHERE owner = 'agent' AND status = 'working' AND lease LIKE 'session:%'")
        .all() as unknown as RawTaskRow[];
      for (const task of staleTasks) {
        this.updateTaskFields(task, {
          status: "waiting",
          owner: "none",
          lease: null,
          last_seen: now,
        });
        this.addMessage(
          task.id,
          "event",
          "system",
          "Server restarted while agent session was running; moved to waiting",
        );
      }
      const staleReleases = this.db
        .prepare("SELECT * FROM releases WHERE status = 'running'")
        .all() as unknown as RawReleaseRow[];
      for (const rel of staleReleases) {
        this.db
          .prepare(
            "UPDATE releases SET status = 'failed', summary = ?, updated_at = ?, finished_at = ? WHERE id = ?",
          )
          .run(
            "Server restarted while release session was running.",
            now,
            now,
            rel.id,
          );
        const relView = toReleaseView(rel);
        for (const taskId of relView.task_ids) {
          const taskRow = this.db
            .prepare("SELECT * FROM tasks WHERE id = ? AND release_id = ? AND deploy_status = 'deploying'")
            .get(taskId, rel.id) as unknown as RawTaskRow | undefined;
          if (taskRow) {
            this.db
              .prepare("UPDATE tasks SET deploy_status = 'failed', updated_at = ? WHERE id = ?")
              .run(now, taskId);
            this.addMessage(
              taskId,
              "event",
              "system",
              `Release REL-${rel.number} interrupted by server restart; marked deploy failed`,
            );
          }
        }
      }
      void runningMessages;
      return {
        recoveredSessions: Number(runningSessions.changes ?? 0),
        recoveredTasks: staleTasks.length,
        recoveredReleases: staleReleases.length,
      };
    });
  }

  updateChatSession(
    projectId: string,
    sessionId: string,
    patch: Partial<Pick<ChatSessionRecord,
      "title" | "runtime" | "model" | "reasoning_effort" | "execution_target" | "resolved_target" |
      "sandbox_mode" | "network_access" | "external_session_id" | "status"
    >>,
  ): ChatSessionRecord {
    const current = this.getChatSession(projectId, sessionId);
    const title =
      patch.title !== undefined
        ? String(patch.title).trim().slice(0, 120) || current.title
        : current.title;
    const runtime: ChatRuntime =
      patch.runtime !== undefined
        ? patch.runtime === "claude"
          ? "claude"
          : "codex"
        : current.runtime;
    const model =
      patch.model !== undefined
        ? String(patch.model).trim().slice(0, 160)
        : current.model;
    const sandboxMode: ChatSandboxMode =
      patch.sandbox_mode !== undefined
        ? patch.sandbox_mode === "workspace-write"
          ? "workspace-write"
          : "read-only"
        : current.sandbox_mode;
    const networkAccess =
      typeof patch.network_access === "boolean"
        ? patch.network_access
        : current.network_access;
    // External thread IDs belong to a particular CLI runtime.
    const externalSessionId = runtime !== current.runtime ? "" :
      (patch.external_session_id?.trim().slice(0, 200) ?? current.external_session_id);
    const status = patch.status ?? current.status;
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE chat_sessions
         SET title = ?, runtime = ?, model = ?, reasoning_effort = ?, execution_target = ?, resolved_target = ?,
             sandbox_mode = ?, network_access = ?, external_session_id = ?, status = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(
        title,
        runtime,
        model,
        patch.reasoning_effort ?? current.reasoning_effort,
        patch.execution_target ?? current.execution_target,
        patch.resolved_target ?? (current.resolved_target || (externalSessionId ? "cloud" : "")),
        sandboxMode,
        networkAccess ? 1 : 0,
        externalSessionId,
        status,
        now,
        sessionId,
        projectId,
      );
    return this.getChatSession(projectId, sessionId);
  }

  deleteChatSession(projectId: string, sessionId: string): { deleted: string } {
    this.getChatSession(projectId, sessionId);
    this.db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(sessionId);
    this.db
      .prepare("DELETE FROM chat_sessions WHERE id = ? AND project_id = ?")
      .run(sessionId, projectId);
    return { deleted: sessionId };
  }

  listChatMessages(projectId: string, sessionId: string): ChatMessageRecord[] {
    this.getChatSession(projectId, sessionId);
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT rowid AS seq, * FROM chat_messages WHERE session_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 200) ORDER BY created_at ASC, seq ASC`,
      )
      .all(sessionId) as unknown as Array<{
      id: string;
      session_id: string;
      role: "user" | "assistant" | "system";
      content: string;
      events_json: string;
      attachments_json: string;
      status: "streaming" | "done" | "error" | "aborted";
      created_at: string;
    }>;
    return rows.map((r) => this.mapChatMessageRow(r));
  }

  addChatMessage(
    sessionId: string,
    payload: {
      role: "user" | "assistant" | "system";
      content: string;
      events?: ChatToolEvent[];
      attachments?: ChatContextRef[];
      status?: "streaming" | "done" | "error" | "aborted";
      id?: string;
    },
  ): ChatMessageRecord {
    const id = payload.id ?? uuidHex();
    if (payload.id && this.db.prepare("SELECT 1 FROM chat_messages WHERE id = ?").get(id)) {
      throw new ApiError(409, "此轮消息已提交");
    }
    const now = nowIso();
    const eventsJson = JSON.stringify(payload.events ?? []);
    const attachmentsJson = JSON.stringify(payload.attachments ?? []);
    const status = payload.status ?? "done";
    this.db
      .prepare(
        `INSERT INTO chat_messages(id, session_id, role, content, events_json, attachments_json, status, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, payload.role, payload.content, eventsJson, attachmentsJson, status, now);
    this.db
      .prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?")
      .run(now, sessionId);
    const row = this.db
      .prepare("SELECT * FROM chat_messages WHERE id = ?")
      .get(id) as unknown as {
      id: string;
      session_id: string;
      role: "user" | "assistant" | "system";
      content: string;
      events_json: string;
      attachments_json: string;
      status: "streaming" | "done" | "error" | "aborted";
      created_at: string;
    };
    return this.mapChatMessageRow(row);
  }

  updateChatMessage(
    messageId: string,
    patch: {
      content?: string;
      events?: ChatToolEvent[];
      status?: "streaming" | "done" | "error" | "aborted";
      stop_reason?: ChatMessageRecord["stop_reason"];
    },
  ): ChatMessageRecord {
    const row = this.db
      .prepare("SELECT * FROM chat_messages WHERE id = ?")
      .get(messageId) as unknown as
      | {
          id: string;
          session_id: string;
          role: "user" | "assistant" | "system";
          content: string;
          events_json: string;
          attachments_json: string;
          status: "streaming" | "done" | "error" | "aborted";
          created_at: string;
        }
      | undefined;
    if (!row) throw new ApiError(404, "消息不存在");
    const content = patch.content !== undefined ? patch.content : row.content;
    const eventsJson =
      patch.events !== undefined ? JSON.stringify(patch.events) : row.events_json;
    const status = patch.status ?? row.status;
    this.db
      .prepare("UPDATE chat_messages SET content = ?, events_json = ?, status = ?, stop_reason = COALESCE(?, stop_reason) WHERE id = ?")
      .run(content, eventsJson, status, patch.stop_reason ?? null, messageId);
    this.db
      .prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?")
      .run(nowIso(), row.session_id);
    return this.mapChatMessageRow({
      ...row,
      content,
      events_json: eventsJson,
      status,
      ...(patch.stop_reason && { stop_reason: patch.stop_reason }),
    });
  }
}
