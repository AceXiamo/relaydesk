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

export type DeployMode = "none" | "manual" | "immediate" | "scheduled";

export interface ProjectDeployPolicy {
  runtime: ChatRuntime | null;
  model: string | null;
  mode: DeployMode;
  window_start: string;
  window_end: string;
  timezone: string;
  allow_urgent_override: boolean;
  allow_ai_immediate_deploy?: boolean;
  allow_widget_deploy_request?: boolean;
  doc_path: string;
}

export type TaskDeployStatus =
  | "not_required"
  | "pending"
  | "deploying"
  | "deployed"
  | "failed";

export type ReleaseTrigger = "immediate" | "scheduled" | "manual" | "urgent" | "ai_gate";

export type DeployGateStatus = "evaluating" | "approved" | "deferred" | "escalated" | "failed";
export type DeployGateSource = "portal" | "widget" | "preset";
export interface PublicDeployGate {
  id: string;
  status: DeployGateStatus;
  public_reason: string;
  created_at: string;
  finished_at: string | null;
}
export interface DeployGateEvaluation extends PublicDeployGate {
  task_title: string;
  task_number: number;
  release_number: number | null;
  reason: string;
  project_id: string;
  task_id: string;
  requested_by_label: string;
  trigger_source: DeployGateSource;
  internal_evidence: string;
  release_id: string | null;
}

export type ReleaseStatus = "running" | "verifying" | "succeeded" | "failed" | "blocked";

export interface ReleaseVerificationContext {
  ai_gate_requester?: string;
  ai_gate_baseline?: string;
  target_sha?: string;
  pier_server?: string;
  pier_project?: string;
  health_url?: string;
  deploy_doc_path?: string;
  deploy_log?: string;
  checks?: string[];
  notes?: string;
  checkpoint_at?: string;
  previous_failure_summary?: string;
  previous_failed_at?: string;
  correction_basis?: string;
  corrected_at?: string;
  reverify_count?: number;
  last_reverify_at?: string;
}

export interface ReleaseTaskSnapshot {
  id: string;
  number: number;
  title: string;
  priority: TaskPriority;
  delivery_ref: string;
  summary?: string;
}

export interface ReleaseRecord {
  id: string;
  project_id: string;
  number: number;
  trigger: ReleaseTrigger;
  status: ReleaseStatus;
  session_id: string | null;
  task_ids: string[];
  task_snapshot: ReleaseTaskSnapshot[];
  target_sha: string;
  deploy_ref: string;
  summary: string;
  verification_context: ReleaseVerificationContext;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export type TaskResolution = "shipped" | "dismissed" | "merged" | null;

export type WorkspaceView =
  | "queue"
  | "triage"
  | "mine"
  | "agents"
  | "review"
  | "releases"
  | "workspace"
  | "chat"
  | "sources"
  | "settings";

export interface SidebarAccount {
  nodeName?: string;
  identity?: string;
  id: string;
  name: string | null;
  avatarUrl: string | null;
  service: string;
  plan: string | null;
  status: "ready" | "unverified" | "unavailable";
  windows: { label: string; remainingPercent: number | null; resetsAt: string | null }[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  repo: string;
  repos: string[];
  automation_paused: boolean;
  delivery_mode: DeliveryMode;
  target_branch: string;
  branch_prefix: string;
  deploy_policy: ProjectDeployPolicy;
  pending_deploy_count: number;
  failed_deploy_count?: number;
  active_release_id?: string | null;
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
  target_branch?: string;
  branch_prefix?: string;
  deploy_policy: ProjectDeployPolicy;
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
  deploy_status: TaskDeployStatus;
  deployed_at: string | null;
  release_id: string | null;
  release_number?: number | null;
  triaged_by: string;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
  last_seen: string | null;
  message_count?: number;
  merged_count?: number;
  linked_feedback?: TaskRecord[];
  agent_session_id?: string | null;
  agent_session_status?: "idle" | "running" | "error" | null;
  agent_session_target?: string | null;
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
  passwordEnabled?: boolean;
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
  branch?: string;
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
  agent_enabled: boolean;
  agent_available?: boolean;
  tracking_enabled: boolean;
  can_request_deploy: boolean;
  release_window: string;
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

export interface GithubBranchItem {
  name: string;
  protected: boolean;
}

export interface GithubBranchesPayload {
  repo: string;
  default_branch: string;
  branches: string[];
  items: GithubBranchItem[];
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
  deploy_doc_exists?: boolean;
  deploy_doc_size?: number;
  deploy_doc_updated_at?: string | null;
  databases_count: number;
  sqlite_count: number;
  repos_status: ProjectReposSyncStatus;
  local_clis: {
    codex: boolean;
    claude: boolean;
    agy?: boolean;
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

export interface RepoBranchPullRequest {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  base_ref: string;
  author: string;
  updated_at: string;
}

export interface RepoBranchLinkedTask {
  id: string;
  number: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  delivery_ref: string;
}

export type RepoBranchMergeStatus = "base" | "merged" | "ahead" | "diverged" | "unknown";

export interface RepoLocalBranchInfo {
  name: string;
  current: boolean;
  sha: string;
  committed_at: string;
  upstream: string;
  ahead: number;
  behind: number;
  upstream_gone: boolean;
  merged_into_base?: boolean;
  ahead_of_base?: number;
  behind_base?: number;
  author: string;
  subject: string;
}

export interface RepoLocalWorkdirStatus {
  agent_id: string;
  agent_name: string;
  online: boolean;
  workdir: string;
  repo_dir?: string;
  remote_repo?: string;
  current_branch: string;
  detached: boolean;
  head_sha: string;
  has_dirty_files: boolean;
  staged_count: number;
  unstaged_count: number;
  untracked_count: number;
  branches: RepoLocalBranchInfo[];
  detailed: boolean;
  error?: string;
}

export interface RepoBranchItem {
  name: string;
  source: "both" | "remote" | "local";
  is_default: boolean;
  is_target: boolean;
  is_mirror_branch: boolean;
  is_local_current: boolean;
  protected: boolean;
  remote_sha: string;
  local_sha: string;
  sha: string;
  committed_at: string;
  author: string;
  subject: string;
  upstream: string;
  ahead: number | null;
  behind: number | null;
  upstream_gone: boolean;
  merge_status: RepoBranchMergeStatus;
  ahead_of_base: number | null;
  behind_base: number | null;
  open_pr: RepoBranchPullRequest | null;
  linked_tasks: RepoBranchLinkedTask[];
  github_url: string;
}

export interface RepoBranchesOverviewPayload {
  repo: string;
  html_url: string;
  private?: boolean;
  default_branch: string;
  target_branch: string;
  branch_prefix: string;
  delivery_mode: DeliveryMode;
  compare_base: string;
  github_configured: boolean;
  remote_error?: string;
  prs_unavailable?: boolean;
  mirror: RepoMirrorEntry | null;
  local_workdir: RepoLocalWorkdirStatus | null;
  branches: RepoBranchItem[];
  counts: {
    total: number;
    remote: number;
    local_only: number;
    with_pr: number;
    with_task: number;
    merged: number;
    unmerged: number;
  };
  fetched_at: string;
}

export interface RepoGitGraphRef {
  name: string;
  kind: "local" | "remote" | "tag";
  is_head?: boolean;
  is_default?: boolean;
  is_target?: boolean;
  merge_status?: RepoBranchMergeStatus;
  ahead_of_base?: number | null;
  behind_base?: number | null;
  open_pr_number?: number;
  linked_task_numbers?: number[];
}

export interface RepoGitGraphCommit {
  sha: string;
  short_sha: string;
  parents: string[];
  message: string;
  author_name: string;
  author_login?: string;
  date: string;
  html_url?: string;
  refs: RepoGitGraphRef[];
}

export interface RepoGitGraphPayload {
  repo: string;
  source: "local" | "remote";
  base_branch: string;
  base_first_parent_shas: string[];
  commits: RepoGitGraphCommit[];
  truncated: boolean;
  fetched_at: string;
  error?: string;
}

export interface RepoBranchCommitItem {
  sha: string;
  short_sha: string;
  message: string;
  author_name: string;
  author_login?: string;
  author_avatar?: string;
  date: string;
  html_url?: string;
}

export interface RepoBranchChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface RepoBranchComparison {
  base: string;
  status: "ahead" | "behind" | "diverged" | "identical";
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  files_count: number;
  additions: number;
  deletions: number;
  files: RepoBranchChangedFile[];
  html_url?: string;
}

export interface RepoBranchDetailPayload {
  repo: string;
  branch: string;
  source: "remote" | "local";
  commits: RepoBranchCommitItem[];
  compare: RepoBranchComparison | null;
  error?: string;
}

/* ── Web Codex / CLI Chat ──────────────────────────────────────────────── */

export type ChatFastMode = "default" | "on" | "off";
export type ChatRuntime = "codex" | "claude" | "agy";
export type ChatSandboxMode = "read-only" | "workspace-write";
export type ChatReasoningEffort = "default" | "off" | "low" | "medium" | "high" | "max";

export interface ModelCatalogItem {
  id: string;
  label?: string;
  runtime: ChatRuntime;
  provider?: string;
  context_window?: number;
  max_output_tokens?: number;
  supports_fast?: boolean;
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
  git_branch?: string;
  has_dirty_files?: boolean;
  updated_at: string;
}

export interface BridgeRuntimeStatus {
  default_fast_mode?: Exclude<ChatFastMode, "default">;
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
  capabilities: { allowed_roots_enabled?: boolean; db_clients?: string[]; git_inspect?: boolean; git_graph?: boolean };
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
  deploy_doc?: Omit<BridgeWorkspaceManifestFile, "path"> | null;
  files: BridgeWorkspaceManifestFile[];
}

export type BridgeAgentPatch = Partial<Pick<BridgeAgentSummary, "name" | "max_concurrency" | "accept_cli_runs">>;
export type BridgeBindingPatch = Partial<Pick<BridgeAgentBindingSummary, "workdir" | "allow_datasource_secrets" | "enabled">>;

export interface ProjectRoutingConfig {
  priority: string[];
  auto_fallback: boolean;
  route_cli_runs: boolean;
  auto_dispatch_tasks: boolean;
  task_runtime?: ChatRuntime;
  task_model?: string;
  task_reasoning_effort?: ChatReasoningEffort;
  task_network_access: boolean;
}

export interface ProjectExecutionRoutingResponse {
  routing: ProjectRoutingConfig;
  effective_priority: string[];
  agents: BridgeAgentSummary[];
  default_runtime?: ChatRuntime;
}

export interface FeedbackAgentResolvedNode {
  id: string;
  name: string;
  online: boolean;
  model: string;
}

export interface FeedbackAgentSettings {
  enabled: boolean;
  available: boolean;
  execution_target: string;
  runtime: ChatRuntime;
  model: string;
  reasoning_effort: ChatReasoningEffort;
  system_prompt: string;
  resolved_agent: FeedbackAgentResolvedNode | null;
  unavailable_reason: string | null;
}

export type FeedbackAgentPatch = Partial<
  Pick<
    FeedbackAgentSettings,
    | "enabled"
    | "execution_target"
    | "runtime"
    | "model"
    | "reasoning_effort"
    | "system_prompt"
  >
>;

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
  subagent?: {
    status: "unknown" | "running" | "done" | "error" | "interrupted";
    activity?: string;
    session_id?: string;
    runtime?: ChatRuntime;
    model?: string;
    delegated?: boolean;
  };
}

export type ChatSessionKind = "chat" | "task" | "release";
export type ChatSessionRole = "root" | "subagent";

export interface ChatContextUsage {
  used_tokens: number;
  window_tokens?: number;
}

export interface ChatSessionRecord {
  id: string;
  project_id: string;
  kind: ChatSessionKind;
  task_id: string | null;
  release_id: string | null;
  parent_session_id?: string | null;
  delegation_depth?: number;
  session_role?: ChatSessionRole;
  title: string;
  runtime: ChatRuntime;
  model: string;
  sandbox_mode: ChatSandboxMode;
  network_access: boolean;
  execution_target: string;
  resolved_target: string;
  reasoning_effort: ChatReasoningEffort;
  fast_mode?: ChatFastMode;
  context_used_tokens?: number | null;
  context_window_tokens?: number | null;
  external_session_id: string;
  active_run_id?: string;
  status: "idle" | "running" | "error";
  created_at: string;
  updated_at: string;
  message_count?: number;
  last_message_preview?: string;
}

export interface ChatMessageRecord {
  runtime?: ChatRuntime;
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  events: ChatToolEvent[];
  attachments: ChatContextRef[];
  status: "streaming" | "done" | "error" | "aborted";
  error_reason?: string;
  stop_reason?: "user_stop" | "follow_up" | "queue_timeout" | "idle_timeout" | "total_timeout";
  created_at: string;
}

export interface ChatRuntimeInfo {
  local_clis: {
    codex: boolean;
    claude: boolean;
    agy?: boolean;
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
    agy?: "project_key" | "local_cli" | "unavailable";
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
  | { type: "context_usage"; usage: ChatContextUsage }
  | { type: "session"; session: ChatSessionRecord; user_message: ChatMessageRecord; assistant_message_id: string }
  | {
      type: "snapshot";
      run_id: string;
      session: ChatSessionRecord;
      user_message: ChatMessageRecord;
      assistant_message: ChatMessageRecord;
      status_line: string;
      reasoning: string;
      started_at: number;
    }
  | { type: "session_updated"; session: ChatSessionRecord }
  | { type: "task_updated"; task_id?: string; action: string }
  | { type: "status"; message: string; external_session_id?: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; event: ChatToolEvent }
  | { type: "text_delta"; delta: string }
  | { type: "text_replace"; text: string }
  | { type: "done"; message: ChatMessageRecord; session: ChatSessionRecord }
  | { type: "error"; error: string; message?: ChatMessageRecord };

