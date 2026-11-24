import type {
  DeployGateEvaluation,
  FeedbackDiagnoseMessage,
  FeedbackDiagnoseResponse,
  FeedbackReleasePreference,
  PortalAccessErrorCode,
  PortalConfig,
  PortalTask,
  PortalTaskDetail,
} from "./portal-types.ts";

export class PortalApiError extends Error {
  readonly status: number;
  readonly code?: PortalAccessErrorCode | string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "PortalApiError";
    this.status = status;
    this.code = code;
  }
}

async function portalRequest<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new PortalApiError(
      response.status,
      typeof data.error === "string" ? data.error : `请求失败（HTTP ${response.status}）`,
      typeof data.code === "string" ? data.code : undefined,
    );
  }

  return data as T;
}

export function createPortalApi(projectId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/portal`;

  return {
    getConfig: (signal?: AbortSignal) =>
      portalRequest<PortalConfig>(`${base}/config`, "GET", undefined, signal),

    listTasks: (scope: "mine" | "team" = "mine", signal?: AbortSignal) =>
      portalRequest<{ tasks: PortalTask[] }>(
        scope === "team" ? `${base}/tasks?scope=team` : `${base}/tasks`,
        "GET",
        undefined,
        signal,
      ),

    getTask: (taskId: string, signal?: AbortSignal) =>
      portalRequest<PortalTaskDetail>(
        `${base}/tasks/${encodeURIComponent(taskId)}`,
        "GET",
        undefined,
        signal,
      ),

    createTask: (payload: {
      title?: string;
      body: string;
      type?: string;
      images?: string[];
      release_preference?: FeedbackReleasePreference;
      external_id?: string;
      source_url?: string;
    }) => portalRequest<PortalTaskDetail>(`${base}/tasks`, "POST", payload),

    replyTask: (taskId: string, body: string) =>
      portalRequest<PortalTaskDetail>(
        `${base}/tasks/${encodeURIComponent(taskId)}/reply`,
        "POST",
        { body },
      ),

    acceptTask: (taskId: string, resolved: boolean, body?: string) =>
      portalRequest<PortalTaskDetail>(
        `${base}/tasks/${encodeURIComponent(taskId)}/accept`,
        "POST",
        body ? { resolved, body } : { resolved },
      ),

    requestDeploy: (taskId: string, reason?: string) =>
      portalRequest<{ gate: DeployGateEvaluation }>(
        `${base}/tasks/${encodeURIComponent(taskId)}/deploy-request`,
        "POST",
        reason ? { reason } : {},
      ),

    diagnose: (
      payload: { messages: FeedbackDiagnoseMessage[]; images?: string[] },
      signal?: AbortSignal,
    ) =>
      portalRequest<FeedbackDiagnoseResponse>(
        `${base}/diagnose`,
        "POST",
        payload,
        signal,
      ),

    clarify: (body: string) =>
      portalRequest<{ reply: string }>(`${base}/clarify`, "POST", { body }),

    uploadImage: async (file: Blob): Promise<{ url: string }> => {
      const contentType =
        file.type && file.type.startsWith("image/") ? file.type : "image/png";
      const response = await fetch(`${base}/uploads`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": contentType },
        body: file,
      });
      let data: Record<string, unknown> = {};
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch {
        data = {};
      }
      if (!response.ok || typeof data.url !== "string") {
        throw new PortalApiError(
          response.status,
          typeof data.error === "string"
            ? data.error
            : `图片上传失败（HTTP ${response.status}）`,
          typeof data.code === "string" ? data.code : undefined,
        );
      }
      return { url: data.url };
    },
  };
}
