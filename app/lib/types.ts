export type TaskStatus =
  | "triage"
  | "ready"
  | "working"
  | "handoff"
  | "waiting"
  | "review"
  | "done";

export type TaskPriority = "urgent" | "high" | "normal" | "low";

export type TaskOwner = "none" | "human" | "agent";

export type TaskSource = "widget" | "bot" | "console";

export type DeliveryMode = "direct_push" | "pr_automerge" | "review_only";

export type TaskResolution = "shipped" | "dismissed" | "merged" | null;

export type WorkspaceView =
  | "queue"
  | "triage"
  | "mine"
  | "agents"
  | "review"
  | "sources"
  | "settings";

export interface ProjectSummary {
  id: string;
  name: string;
  repo: string;
  repos: string[];
  automation_paused: boolean;
  delivery_mode: DeliveryMode;
  widget_code_context: boolean;
  created_at: string;
}

export interface ProjectDetail extends ProjectSummary {
  intake_key: string;
  bot_key: string;
  agent_key: string;
  allowed_origins: string[];
  agent_instructions: string;
}

export interface AgentProjectInfo {
  id: string;
  name: string;
  repo: string;
  repos: string[];
  automation_paused: boolean;
  delivery_mode: DeliveryMode;
  widget_code_context: boolean;
  agent_instructions: string;
}

export interface AgentQueueItem {
  id: string;
  number: number;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  owner: TaskOwner;
  attempts: number;
  updated_at: string;
}

export interface AgentQueuePayload {
  paused: boolean;
  active: AgentQueueItem | null;
  pending: AgentQueueItem[];
  project: AgentProjectInfo;
}

export interface TaskRecord {
  id: string;
  project_id: string;
  number: number;
  title: string;
  body: string;
  requirements: string;
  source: TaskSource;
  source_url: string;
  priority: TaskPriority;
  status: TaskStatus;
  owner: TaskOwner;
  version: number;
  attempts: number;
  resolution: TaskResolution;
  delivery_ref: string;
  triaged_by: string;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
  last_seen: string | null;
  message_count?: number;
  merged_count?: number;
  linked_feedback?: TaskRecord[];
}

export interface TaskMessage {
  id: number;
  task_id?: string;
  kind: "event" | "comment";
  author: "human" | "assistant" | "agent" | "system" | string;
  body: string;
  created_at: string;
}

export interface TaskDetailPayload {
  task: TaskRecord;
  messages: TaskMessage[];
  merged: TaskRecord[];
}

export type DiscussMode = "operator" | "pr_audit";

export interface ProjectCliSettings {
  runtime: "codex" | "claude";
  endpoint: string;
  model: string;
  public_ai_enabled: boolean;
}

export interface ProjectCliStatus extends ProjectCliSettings {
  configured: boolean;
  github_configured: boolean;
  online: boolean;
  ready: boolean;
  managed: boolean;
  last_seen_at: string | null;
}

export interface ProjectCliPatch extends ProjectCliSettings {
  api_key?: string;
  github_token?: string;
}

export interface CliRun {
  id: string;
  mode: DiscussMode;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: string;
  sha: string;
}

export interface DiscussResult {
  queued: true;
  run: CliRun;
  node: DiscussMode;
}

export type AuthMode = "none" | "token" | "wallet";

export interface AuthStatusPayload {
  mode: AuthMode;
  authenticated: boolean;
  address?: string;
}

export interface R2ConfigStatus {
  configured: boolean;
  source: "workspace" | "env" | "none";
  account_id: string;
  bucket: string;
  public_url: string;
  endpoint: string;
  has_credentials: boolean;
  access_key_preview: string;
}

export interface R2TestResult {
  ok: boolean;
  latency_ms: number;
  bucket: string;
  public_url: string;
}

export interface UploadedAttachment {
  url: string;
  key: string;
  content_type: string;
  size: number;
}

export interface RepoMirrorEntry {
  repo: string;
  ready: boolean;
  commit: string;
  updated_at: string | null;
  error?: string;
}

export interface ProjectReposSyncStatus {
  project_id: string;
  enabled: boolean;
  syncing: boolean;
  synced_at: string | null;
  repos: RepoMirrorEntry[];
}

export interface WidgetConfigPayload {
  project_id: string;
  project_name: string;
  ai_enabled: boolean;
  code_context_enabled: boolean;
  upload_enabled: boolean;
  max_upload_bytes: number;
}

export type GithubTokenType = "fine_grained" | "classic" | "other";

export interface GithubOwnerInfo {
  login: string;
  type: "User" | "Organization";
  avatar_url?: string;
}

export interface GithubConnectionSummary {
  id: string;
  label: string;
  token_preview: string;
  token_type: GithubTokenType;
  viewer: GithubOwnerInfo | null;
  owners: GithubOwnerInfo[];
  scope_owner?: GithubOwnerInfo | null;
  repo_count: number;
  created_at: string;
  updated_at: string;
}

export interface GithubInspectPayload {
  token_type: GithubTokenType;
  viewer: GithubOwnerInfo | null;
  candidates: GithubOwnerInfo[];
  suggested_scope: GithubOwnerInfo | null;
}

export interface GithubStatusPayload {
  configured: boolean;
  connections: GithubConnectionSummary[];
}

export interface GithubRepoItem {
  full_name: string;
  name: string;
  owner: string;
  owner_type: "User" | "Organization";
  owner_avatar?: string;
  private: boolean;
  archived: boolean;
  description: string;
  updated_at: string;
  connection_id?: string;
  connection_label?: string;
}

export interface GithubRepoWarning {
  connection_id: string;
  label: string;
  error: string;
}

export interface GithubReposPayload {
  repos: string[];
  items: GithubRepoItem[];
  viewer: GithubOwnerInfo | null;
  owners: GithubOwnerInfo[];
  owner: string;
  page: number;
  more: boolean;
  warnings?: GithubRepoWarning[];
}
