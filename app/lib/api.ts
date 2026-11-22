import type {
  AuthStatusPayload,
  SidebarAccount,
  BridgeAgentBindingSummary,
  BridgeAgentPatch,
  BridgeAgentSummary,
  BridgeAgentTokenResponse,
  BridgeBindingPatch,
  ProjectExecutionRoutingResponse,
  ProjectRoutingConfig,
  ChatContextRef,
  ChatMessageRecord,
  ChatRuntime,
  ChatReasoningEffort,
  ModelCatalogItem,
  ChatRuntimeInfo,
  ChatSandboxMode,
  ChatSessionKind,
  ChatSessionRecord,
  ChatStreamEvent,
  CliRun,
  ProjectCliPatch,
  ProjectCliStatus,
  DeliveryMode,
  DiscussMode,
  DiscussResult,
  GithubConnectionSummary,
  GithubInspectPayload,
  GithubOwnerInfo,
  GithubReposPayload,
  GithubStatusPayload,
  ProjectDetail,
  ProjectDeployPolicy,
  ProjectReposSyncStatus,
  ProjectSummary,
  R2ConfigStatus,
  R2TestResult,
  ReleaseRecord,
  TaskDetailPayload,
  TaskMessage,
  TaskPriority,
  TaskRecord,
  TaskStatus,
  UtilityAiConfigStatus,
  UtilityAiProvider,
  UtilityAiTestResult,
  WorkspaceDatabaseEntry,
  WorkspaceDatabaseKind,
  WorkspaceDbClientInfo,
  WorkspaceFileDetail,
  WorkspaceFileEntry,
  WorkspaceHandbook,
  WorkspaceQueryResult,
  WorkspaceRepoFileContent,
  WorkspaceRepoFileEntry,
  WorkspaceSqliteSchema,
  WorkspaceSummary,
} from "./types.ts";

export class ClientApiError extends Error {
  status: number;
  authMode?: string | null;

  constructor(status: number, message: string, authMode?: string | null) {
    super(message);
    this.status = status;
    this.authMode = authMode;
    this.name = "ClientApiError";
  }
}

async function request<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (
    response.status === 401 &&
    response.headers.get("X-Relaydesk-Auth") === "wallet" &&
    typeof window !== "undefined" &&
    window.location.pathname !== "/login"
  ) {
    window.location.replace(`/login${window.location.hash}`);
    throw new ClientApiError(401, "请使用管理员钱包登录", "wallet");
  }

  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new ClientApiError(
      response.status,
      typeof data.error === "string" ? data.error : `请求失败（HTTP ${response.status}）`,
      response.headers.get("X-Relaydesk-Auth"),
    );
  }

  return data as T;
}

async function readChatStream(response: Response, onEvent: (event: ChatStreamEvent) => void) {
  if (!response.ok || !response.body) {
    let msg = `请求失败（HTTP ${response.status}）`;
    try {
      const err = (await response.json()) as { error?: string };
      if (typeof err.error === "string") msg = err.error;
    } catch {
      // ignore
    }
    throw new ClientApiError(response.status, msg);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (!dataLines.length) continue;
      let event: ChatStreamEvent;
      try { event = JSON.parse(dataLines.join("\n")) as ChatStreamEvent; }
      catch { continue; }
      onEvent(event);
    }
  }
}

export const api = {
  getSidebarAccounts: () =>
    request<{ accounts: SidebarAccount[] }>("/api/sidebar-accounts"),
  getAuthStatus: () => request<AuthStatusPayload>("/api/auth/status"),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", "POST", {}),

  listProjects: () => request<{ projects: ProjectSummary[] }>("/api/projects"),
  createProject: (payload: { name: string; repo?: string; repos?: string[] }) =>
    request<{ project: ProjectDetail }>("/api/projects", "POST", payload),
  getProject: (id: string) =>
    request<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(id)}`),
  updateProject: (
    id: string,
    payload: {
      name?: string;
      repo?: string;
      repos?: string[];
      agent_instructions?: string;
      allowed_origins?: string[];
      automation_paused?: boolean;
      delivery_mode?: DeliveryMode;
      widget_code_context?: boolean;
    },
  ) =>
    request<{ project: ProjectDetail }>(
      `/api/projects/${encodeURIComponent(id)}`,
      "PATCH",
      payload,
    ),

  listBridgeAgents: () => request<{ agents: BridgeAgentSummary[] }>("/api/bridge/agents"),
  createBridgeAgent: (name: string) => request<BridgeAgentTokenResponse>("/api/bridge/agents", "POST", { name }),
  updateBridgeAgent: (agentId: string, patch: BridgeAgentPatch) =>
    request<{ agent: BridgeAgentSummary }>(`/api/bridge/agents/${encodeURIComponent(agentId)}`, "PATCH", patch),
  rotateBridgeAgentToken: (agentId: string) =>
    request<BridgeAgentTokenResponse>(`/api/bridge/agents/${encodeURIComponent(agentId)}/rotate-token`, "POST", {}),
  refreshBridgeAgent: (agentId: string) =>
    request<{ ok: true }>(`/api/bridge/agents/${encodeURIComponent(agentId)}/refresh`, "POST", {}),
  deleteBridgeAgent: (agentId: string) =>
    request<{ ok: true }>(`/api/bridge/agents/${encodeURIComponent(agentId)}`, "DELETE"),
  updateProjectAgentBinding: (projectId: string, agentId: string, patch: BridgeBindingPatch) =>
    request<{ binding: BridgeAgentBindingSummary }>(`/api/projects/${encodeURIComponent(projectId)}/agent-bindings/${encodeURIComponent(agentId)}`, "PATCH", patch),
  getProjectExecutionRouting: (projectId: string) =>
    request<ProjectExecutionRoutingResponse>(`/api/projects/${encodeURIComponent(projectId)}/execution-routing`),
  updateProjectExecutionRouting: (projectId: string, patch: Partial<Omit<ProjectRoutingConfig, "task_runtime">> & { task_runtime?: ChatRuntime | null }) =>
    request<ProjectExecutionRoutingResponse>(`/api/projects/${encodeURIComponent(projectId)}/routing`, "PATCH", patch),

  getProjectCliConfig: (projectId: string) =>
    request<ProjectCliStatus>(`/api/projects/${encodeURIComponent(projectId)}/cli-config`),
  discoverProjectCliModels: (projectId: string, values: { runtime?: ChatRuntime; endpoint?: string; api_key?: string } = {}) =>
    request<{ models: ModelCatalogItem[] }>(`/api/projects/${encodeURIComponent(projectId)}/cli-config/discover-models`, "POST", values),
  updateProjectCliConfig: (projectId: string, settings: ProjectCliPatch) =>
    request<ProjectCliStatus>(
      `/api/projects/${encodeURIComponent(projectId)}/cli-config`,
      "PATCH",
      settings,
    ),

  listTasks: (projectId: string) =>
    request<{ tasks: TaskRecord[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks`,
    ),
  createTask: (
    projectId: string,
    payload: { title?: string; body: string; priority: TaskPriority; skip_prescreen?: boolean },
  ) =>
    request<{ task: TaskRecord }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks`,
      "POST",
      payload,
    ),
  getTaskDetail: (taskId: string) =>
    request<TaskDetailPayload>(`/api/tasks/${encodeURIComponent(taskId)}`),
  getTaskAgentSession: (taskId: string) =>
    request<{ session: ChatSessionRecord | null; messages: ChatMessageRecord[] }>(`/api/tasks/${encodeURIComponent(taskId)}/agent-session`),
  dispatchTaskToAgent: (taskId: string, payload?: {
    prompt?: string; runtime?: ChatRuntime; model?: string; reasoning_effort?: ChatReasoningEffort; execution_target?: string;
  }) => request<{ session: ChatSessionRecord; task: TaskRecord; run_id: string }>(`/api/tasks/${encodeURIComponent(taskId)}/dispatch`, "POST", payload ?? {}),
  addTaskMessage: (taskId: string, body: string, options?: { reopen?: boolean }) =>
    request<{ message: TaskMessage; task?: TaskRecord; reopened?: boolean }>(
      `/api/tasks/${encodeURIComponent(taskId)}/messages`,
      "POST",
      options?.reopen === false ? { body, reopen: false } : { body },
    ),
  listCliRuns: (projectId: string, taskId: string) =>
    request<{ runs: CliRun[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/cli-runs`,
    ),
  discussTask: (
    taskId: string,
    body: string,
    mode: DiscussMode,
  ) =>
    request<DiscussResult>(`/api/tasks/${encodeURIComponent(taskId)}/discuss`, "POST", {
      body,
      mode,
    }),
  taskAction: (
    taskId: string,
    payload: {
      action:
        | "claim"
        | "release"
        | "takeover"
        | "force_takeover"
        | "requirements"
        | "status"
        | "priority"
        | "merge"
        | "reopen";
      version: number;
      status?: TaskStatus;
      priority?: TaskPriority;
      body?: string;
      target_id?: string;
    },
  ) =>
    request<{ task: TaskRecord }>(
      `/api/tasks/${encodeURIComponent(taskId)}/action`,
      "POST",
      payload,
    ),

  getGithubStatus: () => request<GithubStatusPayload>("/api/github"),
  inspectGithub: (payload: { token?: string; id?: string }) =>
    request<GithubInspectPayload>("/api/github/inspect", "POST", payload),
  connectGithub: (
    tokenOrPayload:
      | string
      | {
          token?: string;
          label?: string;
          id?: string;
          scope_owner?: { login: string; type: "User" | "Organization" } | null;
        },
  ) =>
    request<{
      configured: boolean;
      connection: GithubConnectionSummary;
      connections: GithubConnectionSummary[];
      viewer?: GithubOwnerInfo | null;
      org_count?: number;
      repo_count?: number;
    }>(
      "/api/github/connect",
      "POST",
      typeof tokenOrPayload === "string"
        ? { token: tokenOrPayload }
        : tokenOrPayload,
    ),
  disconnectGithub: (id?: string) =>
    request<GithubStatusPayload>(
      "/api/github/disconnect",
      "POST",
      id ? { id } : {},
    ),
  refreshGithubConnection: (id?: string) =>
    request<{
      configured: boolean;
      connection?: GithubConnectionSummary;
      connections: GithubConnectionSummary[];
      viewer?: GithubOwnerInfo | null;
      org_count?: number;
      repo_count?: number;
    }>("/api/github/refresh", "POST", id ? { id } : {}),
  listGithubRepos: (
    params:
      | number
      | {
          page?: number;
          owner?: string;
          owner_type?: "User" | "Organization";
          connection_id?: string;
        } = 1,
  ) =>
    request<GithubReposPayload>(
      "/api/github/repos",
      "POST",
      typeof params === "number" ? { page: params } : params,
    ),

  getR2Config: () => request<R2ConfigStatus>("/api/r2"),
  saveR2Config: (payload: {
    account_id: string;
    bucket: string;
    public_url: string;
    access_key_id?: string;
    secret_access_key?: string;
    endpoint?: string;
  }) => request<R2ConfigStatus>("/api/r2", "POST", payload),
  testR2Config: (payload?: {
    account_id?: string;
    bucket?: string;
    public_url?: string;
    access_key_id?: string;
    secret_access_key?: string;
    endpoint?: string;
  }) => request<R2TestResult>("/api/r2/test", "POST", payload ?? {}),
  disconnectR2Config: () =>
    request<R2ConfigStatus>("/api/r2/disconnect", "POST", {}),

  getUtilityAiConfig: () => request<UtilityAiConfigStatus>("/api/utility-ai"),
  saveUtilityAiConfig: (payload: {
    provider: UtilityAiProvider;
    endpoint?: string;
    model: string;
    api_key?: string;
  }) => request<UtilityAiConfigStatus>("/api/utility-ai", "POST", payload),
  testUtilityAiConfig: (payload?: {
    provider?: UtilityAiProvider;
    endpoint?: string;
    model?: string;
    api_key?: string;
  }) => request<UtilityAiTestResult>("/api/utility-ai/test", "POST", payload ?? {}),
  disconnectUtilityAiConfig: () =>
    request<UtilityAiConfigStatus>("/api/utility-ai/disconnect", "POST", {}),

  getProjectReposStatus: (projectId: string) =>
    request<ProjectReposSyncStatus>(
      `/api/projects/${encodeURIComponent(projectId)}/repos/status`,
    ),
  syncProjectRepos: (projectId: string) =>
    request<ProjectReposSyncStatus>(
      `/api/projects/${encodeURIComponent(projectId)}/repos/sync`,
      "POST",
      {},
    ),

  /* ── Project Space (Workspace) ──────────────────────────────────────── */

  getWorkspaceSummary: (projectId: string) =>
    request<WorkspaceSummary>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/summary`,
    ),
  listWorkspaceFiles: (projectId: string) =>
    request<{ files: WorkspaceFileEntry[]; total_bytes: number; file_count: number }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/files`,
    ),
  getWorkspaceFile: (projectId: string, path: string) =>
    request<{ file: WorkspaceFileDetail }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/file?path=${encodeURIComponent(path)}`,
    ),
  saveWorkspaceFile: (projectId: string, path: string, content: string) =>
    request<{ file: WorkspaceFileDetail }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/file`,
      "POST",
      { path, content },
    ),
  createWorkspaceDir: (projectId: string, path: string) =>
    request<{ file: WorkspaceFileEntry }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/file`,
      "POST",
      { path, type: "dir" },
    ),
  deleteWorkspaceFile: (projectId: string, path: string) =>
    request<{ deleted: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/file?path=${encodeURIComponent(path)}`,
      "DELETE",
    ),
  uploadWorkspaceFile: async (
    projectId: string,
    path: string,
    file: Blob | File | ArrayBuffer,
  ): Promise<{ file: WorkspaceFileDetail }> => {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/upload?path=${encodeURIComponent(path)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      },
    );
    let data: Record<string, unknown> = {};
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new ClientApiError(
        response.status,
        typeof data.error === "string" ? data.error : `上传失败（HTTP ${response.status}）`,
      );
    }
    return data as { file: WorkspaceFileDetail };
  },
  getWorkspaceHandbook: (projectId: string) =>
    request<{ handbook: WorkspaceHandbook }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/handbook`,
    ),
  saveWorkspaceHandbook: (projectId: string, content: string) =>
    request<{ handbook: WorkspaceHandbook }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/handbook`,
      "POST",
      { content },
    ),
  getWorkspaceDeployDoc: (projectId: string) =>
    request<{ deploy_doc: WorkspaceHandbook }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/deploy-doc`,
    ),
  saveWorkspaceDeployDoc: (projectId: string, content: string) =>
    request<{ deploy_doc: WorkspaceHandbook }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/deploy-doc`,
      "PUT",
      { content },
    ),
  getProjectDeployPolicy: (projectId: string) =>
    request<{ deploy_policy: ProjectDeployPolicy; deploy_doc_exists: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/deploy-policy`,
    ),
  updateProjectDeployPolicy: (
    projectId: string,
    patch: Partial<ProjectDeployPolicy>,
  ) =>
    request<{ deploy_policy: ProjectDeployPolicy; deploy_doc_exists: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/deploy-policy`,
      "PUT",
      patch,
    ),
  listProjectReleases: (projectId: string, limit = 50) =>
    request<{
      releases: ReleaseRecord[];
      pending_tasks: TaskRecord[];
      failed_tasks: TaskRecord[];
      active_release: ReleaseRecord | null;
      deploy_policy: ProjectDeployPolicy;
      deploy_doc_exists: boolean;
    }>(
      `/api/projects/${encodeURIComponent(projectId)}/releases?limit=${encodeURIComponent(String(limit))}`,
    ),
  getProjectRelease: (projectId: string, releaseId: string) =>
    request<{ release: ReleaseRecord; session: ChatSessionRecord | null }>(
      `/api/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}`,
    ),
  triggerProjectRelease: (
    projectId: string,
    payload?: {
      force?: boolean;
      prompt?: string;
      runtime?: ChatRuntime;
      model?: string;
      reasoning_effort?: ChatReasoningEffort;
      execution_target?: string;
    },
  ) =>
    request<{ release: ReleaseRecord; session: ChatSessionRecord; run_id: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/releases/trigger`,
      "POST",
      payload ?? {},
    ),
  reverifyProjectRelease: (
    projectId: string,
    releaseId: string,
    payload?: {
      prompt?: string;
      runtime?: ChatRuntime;
      model?: string;
      reasoning_effort?: ChatReasoningEffort;
      execution_target?: string;
    },
  ) =>
    request<{ release: ReleaseRecord; session: ChatSessionRecord; run_id: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(releaseId)}/reverify`,
      "POST",
      payload ?? {},
    ),
  listWorkspaceDatabases: (projectId: string, refreshClients = false) =>
    request<{ databases: WorkspaceDatabaseEntry[]; clients: WorkspaceDbClientInfo[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/databases${refreshClients ? "?refresh_clients=1" : ""}`,
    ),
  createWorkspaceSqlite: (projectId: string, payload: { name: string; init_sql?: string }) =>
    request<{ database: WorkspaceDatabaseEntry }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/databases`,
      "POST",
      { mode: "sqlite_new", ...payload },
    ),
  addWorkspaceDatasource: (
    projectId: string,
    payload: {
      name: string;
      kind: WorkspaceDatabaseKind;
      env_var?: string;
      connection_url?: string;
      read_only?: boolean;
      notes?: string;
    },
  ) =>
    request<{ database: WorkspaceDatabaseEntry }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/databases`,
      "POST",
      { mode: "external", ...payload },
    ),
  updateWorkspaceDatasource: (
    projectId: string,
    dbId: string,
    patch: {
      name?: string;
      kind?: WorkspaceDatabaseKind;
      env_var?: string;
      connection_url?: string;
      clear_connection_url?: boolean;
      read_only?: boolean;
      notes?: string;
    },
  ) =>
    request<{ database: WorkspaceDatabaseEntry }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/databases/${encodeURIComponent(dbId)}`,
      "PATCH",
      patch,
    ),
  deleteWorkspaceDatabase: (projectId: string, dbId: string) =>
    request<{ deleted: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/databases/${encodeURIComponent(dbId)}`,
      "DELETE",
    ),
  getWorkspaceDatabaseSchema: (projectId: string, dbId: string) =>
    request<{ schema: WorkspaceSqliteSchema }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/databases/${encodeURIComponent(dbId)}/schema`,
    ),
  queryWorkspaceDatabase: (projectId: string, dbId: string, sql: string, limit = 100) =>
    request<{ result: WorkspaceQueryResult }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/databases/${encodeURIComponent(dbId)}/query`,
      "POST",
      { sql, limit },
    ),
  listWorkspaceRepoFiles: (projectId: string, params?: { repo?: string; path?: string }) => {
    const qs = new URLSearchParams();
    if (params?.repo) qs.set("repo", params.repo);
    if (params?.path) qs.set("path", params.path);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ entries: WorkspaceRepoFileEntry[]; truncated: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/repos/files${suffix}`,
    );
  },
  getWorkspaceRepoFile: (
    projectId: string,
    params: { repo?: string; path: string; start_line?: number; end_line?: number },
  ) => {
    const qs = new URLSearchParams();
    if (params.repo) qs.set("repo", params.repo);
    qs.set("path", params.path);
    if (params.start_line) qs.set("start_line", String(params.start_line));
    if (params.end_line) qs.set("end_line", String(params.end_line));
    return request<{ file: WorkspaceRepoFileContent }>(
      `/api/projects/${encodeURIComponent(projectId)}/workspace/repos/file?${qs.toString()}`,
    );
  },

  /* ── Web Codex / CLI Chat ───────────────────────────────────────────── */

  getCodexChatRuntime: (projectId: string) =>
    request<ChatRuntimeInfo>(
      `/api/projects/${encodeURIComponent(projectId)}/codex-chat/runtime`,
    ),
  listCodexChatSessions: (projectId: string, kind?: ChatSessionKind | "all") =>
    request<{ sessions: ChatSessionRecord[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/codex-chat/sessions${kind ? `?kind=${kind}` : ""}`,
    ),
  createCodexChatSession: (
    projectId: string,
    payload?: {
      title?: string;
      runtime?: ChatRuntime;
      model?: string;
      reasoning_effort?: ChatReasoningEffort;
      execution_target?: string;
      sandbox_mode?: ChatSandboxMode;
      network_access?: boolean;
    },
  ) =>
    request<{ session: ChatSessionRecord }>(
      `/api/projects/${encodeURIComponent(projectId)}/codex-chat/sessions`,
      "POST",
      payload ?? {},
    ),
  getCodexChatSession: (projectId: string, sessionId: string) =>
    request<{ session: ChatSessionRecord; messages: ChatMessageRecord[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/codex-chat/sessions/${encodeURIComponent(sessionId)}`,
    ),
  updateCodexChatSession: (
    projectId: string,
    sessionId: string,
    patch: {
      title?: string;
      runtime?: ChatRuntime;
      model?: string;
      reasoning_effort?: ChatReasoningEffort;
      execution_target?: string;
      sandbox_mode?: ChatSandboxMode;
      network_access?: boolean;
    },
  ) =>
    request<{ session: ChatSessionRecord }>(
      `/api/projects/${encodeURIComponent(projectId)}/codex-chat/sessions/${encodeURIComponent(sessionId)}`,
      "PATCH",
      patch,
    ),
  deleteCodexChatSession: (projectId: string, sessionId: string) =>
    request<{ deleted: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/codex-chat/sessions/${encodeURIComponent(sessionId)}`,
      "DELETE",
    ),
  abortCodexChatSession: (projectId: string, sessionId: string, run_id: string, reason: "user_stop" | "follow_up") =>
    request<{ aborted: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/codex-chat/sessions/${encodeURIComponent(sessionId)}/abort`,
      "POST",
      { run_id, reason },
    ),
  regenerateCodexChatSessionTitle: (projectId: string, sessionId: string) =>
    request<{ session: ChatSessionRecord; generated: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/codex-chat/sessions/${encodeURIComponent(sessionId)}/title`,
      "POST",
      {},
    ),
  subscribeCodexChatStream: async (
    projectId: string, sessionId: string, onEvent: (event: ChatStreamEvent) => void, signal?: AbortSignal,
  ): Promise<boolean> => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/codex-chat/sessions/${encodeURIComponent(sessionId)}/stream`, {
      headers: { Accept: "text/event-stream" }, signal,
    });
    if (response.status === 204) return false;
    await readChatStream(response, onEvent);
    return true;
  },
  streamCodexChatMessage: async (
    projectId: string,
    sessionId: string,
    payload: { run_id: string; content: string; attachments?: ChatContextRef[] },
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/codex-chat/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      },
    );
    await readChatStream(response, onEvent);
  },
};
