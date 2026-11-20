import type {
  AiConfigStatus,
  AiTestResult,
  AuthStatusPayload,
  GithubOwnerInfo,
  GithubReposPayload,
  ProjectDetail,
  ProjectSummary,
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
  createProject: (payload: { name: string; repo: string }) =>
    request<{ project: ProjectDetail }>("/api/projects", "POST", payload),
  getProject: (id: string) =>
    request<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(id)}`),
  updateProject: (
    id: string,
    payload: {
      name?: string;
      repo?: string;
      agent_instructions?: string;
      allowed_origins?: string[];
    },
  ) =>
    request<{ project: ProjectDetail }>(
      `/api/projects/${encodeURIComponent(id)}`,
      "PATCH",
      payload,
    ),

  listTasks: (projectId: string) =>
    request<{ tasks: TaskRecord[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks`,
    ),
  createTask: (
    projectId: string,
    payload: { title?: string; body: string; priority: TaskPriority },
  ) =>
    request<{ task: TaskRecord }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks`,
      "POST",
      payload,
    ),
  getTaskDetail: (taskId: string) =>
    request<TaskDetailPayload>(`/api/tasks/${encodeURIComponent(taskId)}`),
  addTaskMessage: (taskId: string, body: string) =>
    request<{ message: TaskMessage }>(
      `/api/tasks/${encodeURIComponent(taskId)}/messages`,
      "POST",
      { body },
    ),
  discussTask: (taskId: string, body: string) =>
    request<{ reply: string }>(
      `/api/tasks/${encodeURIComponent(taskId)}/discuss`,
      "POST",
      { body },
    ),
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
        | "merge";
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

  getGithubStatus: () => request<{ configured: boolean }>("/api/github"),
  connectGithub: (token: string) =>
    request<{
      configured: boolean;
      viewer?: GithubOwnerInfo | null;
      org_count?: number;
      repo_count?: number;
    }>("/api/github/connect", "POST", { token }),
  disconnectGithub: () =>
    request<{ configured: boolean }>("/api/github/disconnect", "POST", {}),
  listGithubRepos: (
    params:
      | number
      | { page?: number; owner?: string; owner_type?: "User" | "Organization" } = 1,
  ) =>
    request<GithubReposPayload>(
      "/api/github/repos",
      "POST",
      typeof params === "number" ? { page: params } : params,
    ),

  getAiConfig: () => request<AiConfigStatus>("/api/ai"),
  saveAiConfig: (payload: {
    base_url: string;
    model: string;
    api_key?: string;
    clear_api_key?: boolean;
    intake_enabled: boolean;
  }) => request<AiConfigStatus>("/api/ai", "POST", payload),
  testAiConfig: (payload?: { base_url?: string; model?: string; api_key?: string }) =>
    request<AiTestResult>("/api/ai/test", "POST", payload ?? {}),
  disconnectAiConfig: () =>
    request<AiConfigStatus>("/api/ai/disconnect", "POST", {}),
};
