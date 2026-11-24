import type {
  DeployGateEvaluation,
  FeedbackDiagnoseMessage,
  FeedbackDiagnoseResponse,
  FeedbackDiagnoseStreamEvent,
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

async function portalDiagnoseStream(
  path: string,
  payload: { messages: FeedbackDiagnoseMessage[]; images?: string[] },
  signal?: AbortSignal,
  onEvent?: (event: FeedbackDiagnoseStreamEvent) => void,
): Promise<FeedbackDiagnoseResponse> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });

  const contentType = (response.headers.get("content-type") || "").toLowerCase();

  if (!response.ok) {
    let data: Record<string, unknown> = {};
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = {};
    }
    throw new PortalApiError(
      response.status,
      typeof data.error === "string"
        ? data.error
        : `诊断请求失败（HTTP ${response.status}）`,
      typeof data.code === "string" ? data.code : undefined,
    );
  }

  if (!contentType.includes("text/event-stream") || !response.body) {
    const data = (await response.json()) as FeedbackDiagnoseResponse;
    return data;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedText = "";
  let accumulatedReasoning = "";
  let finalResult: FeedbackDiagnoseResponse | null = null;

  const processFrame = (rawFrame: string) => {
    const lines = rawFrame.split(/\r?\n/);
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    } catch {
      return;
    }

    if (eventName === "status" && typeof parsed.label === "string") {
      onEvent?.({ type: "status", label: parsed.label });
    } else if (eventName === "reasoning" && typeof parsed.text === "string") {
      accumulatedReasoning += parsed.text;
      onEvent?.({ type: "reasoning", text: parsed.text });
    } else if (eventName === "delta" && typeof parsed.text === "string") {
      accumulatedText += parsed.text;
      onEvent?.({ type: "delta", text: parsed.text });
    } else if (eventName === "done") {
      finalResult = parsed as unknown as FeedbackDiagnoseResponse;
    } else if (eventName === "error") {
      throw new PortalApiError(
        typeof parsed.status === "number" ? parsed.status : 500,
        typeof parsed.error === "string"
          ? parsed.error
          : "诊断过程中断，请重试或直接提交反馈。",
        typeof parsed.code === "string" ? parsed.code : undefined,
      );
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        let sepIndex: number;
        while ((sepIndex = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const frame = buffer.slice(0, sepIndex);
          const sepMatch = buffer.slice(sepIndex).match(/^\r?\n\r?\n/);
          buffer = buffer.slice(sepIndex + (sepMatch ? sepMatch[0].length : 2));
          if (frame.trim()) processFrame(frame);
        }
      }
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) processFrame(buffer);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (finalResult) return finalResult;
  if (accumulatedText.trim()) {
    return {
      reply: accumulatedText.trim(),
      outcome: "clarify",
      ...(accumulatedReasoning.trim()
        ? { reasoning: accumulatedReasoning.trim() }
        : {}),
    };
  }
  throw new PortalApiError(502, "诊断流意外结束，请重试或直接提交反馈。");
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
      onEvent?: (event: FeedbackDiagnoseStreamEvent) => void,
    ) => portalDiagnoseStream(`${base}/diagnose`, payload, signal, onEvent),

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
