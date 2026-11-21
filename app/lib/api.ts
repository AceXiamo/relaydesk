import type {
  AuthStatusPayload,
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
  ProjectReposSyncStatus,
  ProjectSummary,
  R2ConfigStatus,
  R2TestResult,
  TaskDetailPayload,
  TaskMessage,
  TaskPriority,
  TaskRecord,
  TaskStatus,
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
  method: "GET" | "POST" | "PATCH" = "GET",
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

export const api = {
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

  getProjectCliConfig: (projectId: string) =>
    request<ProjectCliStatus>(`/api/projects/${encodeURIComponent(projectId)}/cli-config`),
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
};
