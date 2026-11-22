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
  | "workspace"
  | "chat"
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
  models?: ModelCatalogItem[];
  default_effort?: ChatReasoningEffort;
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

/* ── Project Space (Workspace) ─────────────────────────────────────────── */

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  type: "file" | "dir";
  size: number;
  updated_at: string;
  ext: string;
  is_text: boolean;
  is_sqlite: boolean;
}

export interface WorkspaceFileDetail extends WorkspaceFileEntry {
  content?: string;
  truncated?: boolean;
}

export interface WorkspaceHandbook {
  content: string;
  exists: boolean;
  size: number;
  updated_at: string | null;
}

export type WorkspaceDatabaseKind =
  | "sqlite"
  | "postgres"
  | "mysql"
  | "redis"
  | "mongodb"
  | "other";

export interface WorkspaceDbClientInfo {
  id: "psql" | "mysql" | "sqlite3" | "redis-cli" | "mongosh";
  label: string;
  kinds: WorkspaceDatabaseKind[];
  installed: boolean;
  bin_path?: string;
  install_hint: string;
}

export interface WorkspaceDatabaseEntry {
  id: string;
  name: string;
  kind: WorkspaceDatabaseKind;
  source: "workspace_file" | "external";
  file_path?: string;
  env_var?: string;
  read_only: boolean;
  queryable: boolean;
  size?: number;
  table_count?: number;
  host_preview: string;
  has_connection_url: boolean;
  notes: string;
  updated_at: string;
}

export interface WorkspaceSqliteColumn {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  default_value: string | null;
}

export interface WorkspaceSqliteTable {
  name: string;
  type: "table" | "view";
  row_count: number;
  sql: string;
  columns: WorkspaceSqliteColumn[];
}

export interface WorkspaceSqliteSchema {
  database_id: string;
  file_path: string;
  tables: WorkspaceSqliteTable[];
}

export interface WorkspaceQueryResult {
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  row_count: number;
  truncated: boolean;
  duration_ms: number;
}

export interface WorkspaceSummary {
  files_count: number;
  total_bytes: number;
  handbook_exists: boolean;
  handbook_size: number;
  handbook_updated_at: string | null;
  databases_count: number;
  sqlite_count: number;
  repos_status: ProjectReposSyncStatus;
  local_clis: {
    codex: boolean;
    claude: boolean;
  };
}

export interface WorkspaceRepoFileEntry {
  repo: string;
  path: string;
  type: "file" | "dir";
  size?: number;
}

export interface WorkspaceRepoFileContent {
  repo: string;
  path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  content: string;
  error?: string;
}

/* ── Web Codex / CLI Chat ──────────────────────────────────────────────── */

export type ChatRuntime = "codex" | "claude";
export type ChatSandboxMode = "read-only" | "workspace-write";
export type ChatReasoningEffort = "default" | "off" | "low" | "medium" | "high" | "max";

export interface ModelCatalogItem {
  id: string;
  label?: string;
  runtime: ChatRuntime;
  provider?: string;
  context_window?: number;
  max_output_tokens?: number;
  supports_effort?: boolean;
  effort_levels?: Array<Exclude<ChatReasoningEffort, "default">>;
  default_effort?: Exclude<ChatReasoningEffort, "default">;
  is_default?: boolean;
  tags?: string[];
  source?: "bridge_config" | "cli_config" | "cloud_config" | "detected";
}

export interface BridgeAgentBindingSummary {
  project_id: string;
  project_name?: string;
  agent_id: string;
  workdir: string;
  path_ok: boolean;
  path_error: string;
  enabled: boolean;
  allow_datasource_secrets: boolean;
  updated_at: string;
}

export interface BridgeRuntimeStatus {
  available: boolean;
  version?: string;
  default_model?: string;
  default_effort?: ChatReasoningEffort;
}

export interface BridgeAgentSummary {
  id: string;
  name: string;
  token_prefix: string;
  hostname: string;
  platform: string;
  bridge_version: string;
  max_concurrency: number;
  accept_cli_runs: boolean;
  online: boolean;
  active_runs: number;
  bindings: BridgeAgentBindingSummary[];
  runtimes: Partial<Record<ChatRuntime, BridgeRuntimeStatus>>;
  models: ModelCatalogItem[];
  capabilities: { allowed_roots_enabled?: boolean; db_clients?: string[] };
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BridgeAgentTokenResponse {
  agent: BridgeAgentSummary;
  token: string;
  quickstart_config: Record<string, unknown>;
  start_command: string;
  client_url: string;
  bridge_version?: string;
}

export interface BridgeWorkspaceManifestFile {
  path: string;
  size: number;
  sha256: string;
  updated_at: string;
}

export interface BridgeWorkspaceManifest {
  handbook?: Omit<BridgeWorkspaceManifestFile, "path"> | null;
  files: BridgeWorkspaceManifestFile[];
}

export type BridgeAgentPatch = Partial<Pick<BridgeAgentSummary, "name" | "max_concurrency" | "accept_cli_runs">>;
export type BridgeBindingPatch = Partial<Pick<BridgeAgentBindingSummary, "workdir" | "allow_datasource_secrets" | "enabled">>;

export interface ProjectRoutingConfig {
  priority: string[];
  auto_fallback: boolean;
  route_cli_runs: boolean;
}

export interface ProjectExecutionRoutingResponse {
  routing: ProjectRoutingConfig;
  effective_priority: string[];
  agents: BridgeAgentSummary[];
}

export interface ChatContextRef {
  kind: "file" | "repo_file" | "database" | "task" | "image";
  label: string;
  ref: string;
  repo?: string;
  mime?: string;
}

export interface ChatToolImage {
  url: string;
  alt?: string;
}

export interface ChatToolEvent {
  id: string;
  tool: string;
  summary: string;
  status: "running" | "done" | "error";
  output?: string;
  exit_code?: number | null;
  images?: ChatToolImage[];
}

export interface ChatSessionRecord {
  id: string;
  project_id: string;
  title: string;
  runtime: ChatRuntime;
  model: string;
  sandbox_mode: ChatSandboxMode;
  network_access: boolean;
  execution_target: string;
  resolved_target: string;
  reasoning_effort: ChatReasoningEffort;
  external_session_id: string;
  status: "idle" | "running" | "error";
  created_at: string;
  updated_at: string;
  message_count?: number;
  last_message_preview?: string;
}

export interface ChatMessageRecord {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  events: ChatToolEvent[];
  attachments: ChatContextRef[];
  status: "streaming" | "done" | "error" | "aborted";
  created_at: string;
}

export interface ChatRuntimeInfo {
  local_clis: {
    codex: boolean;
    claude: boolean;
  };
  project_cli: {
    runtime: ChatRuntime;
    configured: boolean;
    endpoint: string;
    model: string;
    models: ModelCatalogItem[];
    default_effort: ChatReasoningEffort;
  };
  auth_mode: {
    codex: "project_key" | "local_cli" | "unavailable";
    claude: "project_key" | "local_cli" | "unavailable";
  };
  routing?: ProjectRoutingConfig;
  effective_priority?: string[];
  agents?: BridgeAgentSummary[];
}

export type UtilityAiProvider = "openai" | "anthropic";

export interface UtilityAiConfigStatus {
  configured: boolean;
  source: "workspace" | "env" | "none";
  provider: UtilityAiProvider;
  endpoint: string;
  model: string;
  has_api_key: boolean;
  api_key_preview: string;
}

export interface UtilityAiTestResult {
  ok: boolean;
  provider: UtilityAiProvider;
  model: string;
  latency_ms: number;
  reply_preview: string;
}

export type ChatStreamEvent =
  | { type: "session"; session: ChatSessionRecord; user_message: ChatMessageRecord; assistant_message_id: string }
  | { type: "session_updated"; session: ChatSessionRecord }
  | { type: "task_updated"; task_id?: string; action: string }
  | { type: "status"; message: string; external_session_id?: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; event: ChatToolEvent }
  | { type: "text_delta"; delta: string }
  | { type: "text_replace"; text: string }
  | { type: "done"; message: ChatMessageRecord; session: ChatSessionRecord }
  | { type: "error"; error: string; message?: ChatMessageRecord };

