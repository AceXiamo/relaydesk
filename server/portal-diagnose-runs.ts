import { ApiError } from "./errors.ts";
import type {
  FeedbackDiagnosisResult,
  FeedbackStreamEvent,
} from "./feedback-agent.ts";

export interface PortalDiagnoseSnapshot {
  run_id: string;
  status_label: string;
  steps: string[];
  reasoning: string;
  text: string;
  started_at: number;
}

export type PortalDiagnoseRunEvent =
  | { type: "started"; run_id: string; started_at: number }
  | { type: "snapshot"; snapshot: PortalDiagnoseSnapshot }
  | { type: "status"; label: string }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; result: FeedbackDiagnosisResult }
  | { type: "error"; status: number; error: string }
  | { type: "aborted"; message: string };

export interface PortalDiagnoseSubscriber {
  onEvent: (event: PortalDiagnoseRunEvent) => void;
  onClose?: () => void;
}

interface ManagedDiagnoseRun {
  id: string;
  projectId: string;
  actorKey: string;
  controller: AbortController;
  status: "running" | "done" | "error" | "aborted";
  statusLabel: string;
  steps: string[];
  reasoning: string;
  text: string;
  startedAt: number;
  finishedAt?: number;
  result?: FeedbackDiagnosisResult;
  error?: { status: number; error: string };
  subscribers: Set<PortalDiagnoseSubscriber>;
}

const FINISHED_RUN_TTL_MS = 10 * 60 * 1000;
const MAX_STORED_RUNS = 200;
const MAX_BUFFERED_CHARS = 120_000;

export class PortalDiagnoseRunManager {
  private readonly runs = new Map<string, ManagedDiagnoseRun>();

  startRun(options: {
    runId: string;
    projectId: string;
    actorKey: string;
    execute: (ctx: {
      signal: AbortSignal;
      onEvent: (ev: FeedbackStreamEvent) => void;
    }) => Promise<FeedbackDiagnosisResult>;
    onRelease: () => void;
    initialSubscriber?: PortalDiagnoseSubscriber;
  }): { unsubscribe: () => void } {
    this.pruneExpired();

    if (this.runs.has(options.runId)) {
      throw new ApiError(409, "该诊断任务已存在，请刷新或重试。");
    }

    const startedAt = Date.now();
    const initialLabel = "正在分析问题与上下文…";
    const managed: ManagedDiagnoseRun = {
      id: options.runId,
      projectId: options.projectId,
      actorKey: options.actorKey,
      controller: new AbortController(),
      status: "running",
      statusLabel: initialLabel,
      steps: [initialLabel],
      reasoning: "",
      text: "",
      startedAt,
      subscribers: new Set(),
    };
    this.runs.set(options.runId, managed);

    let unsubscribe = () => {};
    if (options.initialSubscriber) {
      const sub = options.initialSubscriber;
      managed.subscribers.add(sub);
      unsubscribe = () => {
        managed.subscribers.delete(sub);
      };
      try {
        sub.onEvent({ type: "started", run_id: managed.id, started_at: startedAt });
      } catch {
        managed.subscribers.delete(sub);
      }
    }

    void (async () => {
      try {
        const result = await options.execute({
          signal: managed.controller.signal,
          onEvent: (ev) => {
            if (managed.status !== "running") return;
            if (ev.type === "status") {
              const clean = (ev.label || "正在排查问题…").trim();
              if (clean) {
                managed.statusLabel = clean;
                if (managed.steps[managed.steps.length - 1] !== clean) {
                  managed.steps = [...managed.steps, clean].slice(-20);
                }
              }
              this.broadcast(managed, { type: "status", label: managed.statusLabel });
            } else if (ev.type === "reasoning" && ev.text) {
              managed.reasoning = (managed.reasoning + ev.text).slice(0, MAX_BUFFERED_CHARS);
              this.broadcast(managed, { type: "reasoning", text: ev.text });
            } else if (ev.type === "delta" && ev.text) {
              managed.text = (managed.text + ev.text).slice(0, MAX_BUFFERED_CHARS);
              this.broadcast(managed, { type: "delta", text: ev.text });
            }
          },
        });

        if (managed.controller.signal.aborted || managed.status !== "running") {
          if (managed.status === "running") {
            managed.status = "aborted";
            managed.finishedAt = Date.now();
            this.broadcast(managed, {
              type: "aborted",
              message: "已停止本轮排查。",
            });
          }
          return;
        }

        managed.status = "done";
        managed.result = result;
        managed.finishedAt = Date.now();
        this.broadcast(managed, { type: "done", result });
      } catch (err) {
        if (managed.controller.signal.aborted) {
          if (managed.status === "running") {
            managed.status = "aborted";
            managed.finishedAt = Date.now();
            this.broadcast(managed, {
              type: "aborted",
              message: "已停止本轮排查。",
            });
          }
          return;
        }
        const status = err instanceof ApiError ? err.status : 500;
        const error =
          err instanceof ApiError
            ? err.message
            : "诊断过程中断，请重试或直接提交反馈。";
        managed.status = "error";
        managed.error = { status, error };
        managed.finishedAt = Date.now();
        this.broadcast(managed, { type: "error", status, error });
      } finally {
        this.closeSubscribers(managed);
        options.onRelease();
      }
    })();

    return { unsubscribe };
  }

  subscribeRun(
    runId: string,
    projectId: string,
    actorKey: string,
    subscriber: PortalDiagnoseSubscriber,
  ): { unsubscribe: () => void; finished: boolean } | null {
    this.pruneExpired();
    const managed = this.runs.get(runId);
    if (
      !managed ||
      managed.projectId !== projectId ||
      managed.actorKey !== actorKey
    ) {
      return null;
    }

    const snapshot: PortalDiagnoseSnapshot = {
      run_id: managed.id,
      status_label: managed.statusLabel,
      steps: [...managed.steps],
      reasoning: managed.reasoning,
      text: managed.text,
      started_at: managed.startedAt,
    };

    if (managed.status === "running") {
      try {
        subscriber.onEvent({ type: "snapshot", snapshot });
      } catch {
        return { unsubscribe: () => {}, finished: false };
      }
      managed.subscribers.add(subscriber);
      return {
        unsubscribe: () => {
          managed.subscribers.delete(subscriber);
        },
        finished: false,
      };
    }

    try {
      if (managed.status === "done" && managed.result) {
        subscriber.onEvent({ type: "snapshot", snapshot });
        subscriber.onEvent({ type: "done", result: managed.result });
      } else if (managed.status === "error" && managed.error) {
        subscriber.onEvent({
          type: "error",
          status: managed.error.status,
          error: managed.error.error,
        });
      } else {
        subscriber.onEvent({
          type: "aborted",
          message: "已停止本轮排查。",
        });
      }
    } catch {
      // Ignore closed response write errors during immediate replay.
    } finally {
      try {
        subscriber.onClose?.();
      } catch {
        // Ignore close errors.
      }
    }
    return { unsubscribe: () => {}, finished: true };
  }

  abortRun(runId: string, projectId: string, actorKey: string): boolean {
    const managed = this.runs.get(runId);
    if (
      !managed ||
      managed.projectId !== projectId ||
      managed.actorKey !== actorKey
    ) {
      return false;
    }
    if (managed.status === "running") {
      managed.controller.abort();
    }
    return true;
  }

  private broadcast(
    managed: ManagedDiagnoseRun,
    event: PortalDiagnoseRunEvent,
  ): void {
    for (const sub of Array.from(managed.subscribers)) {
      try {
        sub.onEvent(event);
      } catch {
        managed.subscribers.delete(sub);
      }
    }
  }

  private closeSubscribers(managed: ManagedDiagnoseRun): void {
    for (const sub of Array.from(managed.subscribers)) {
      try {
        sub.onClose?.();
      } catch {
        // Ignore close errors.
      }
    }
    managed.subscribers.clear();
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (
        run.status !== "running" &&
        run.finishedAt !== undefined &&
        now - run.finishedAt > FINISHED_RUN_TTL_MS
      ) {
        this.runs.delete(id);
      }
    }
    if (this.runs.size <= MAX_STORED_RUNS) return;
    const finished = Array.from(this.runs.values())
      .filter((r) => r.status !== "running")
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    while (this.runs.size > MAX_STORED_RUNS && finished.length > 0) {
      const oldest = finished.shift();
      if (oldest) this.runs.delete(oldest.id);
    }
  }
}
