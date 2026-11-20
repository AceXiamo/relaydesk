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
  agent_instructions: string;
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

export type AuthMode = "none" | "token" | "wallet";

export interface AuthStatusPayload {
  mode: AuthMode;
  authenticated: boolean;
  address?: string;
}

export interface AiConfigStatus {
  configured: boolean;
  source: "workspace" | "env" | "none";
  base_url: string;
  model: string;
  has_api_key: boolean;
  api_key_preview: string;
  intake_enabled: boolean;
}

export interface AiTestResult {
  ok: boolean;
  latency_ms: number;
  model: string;
  reply_preview: string;
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
