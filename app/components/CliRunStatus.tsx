import { useEffect, useState } from "react";
import { api } from "~/lib/api.ts";
import type { CliRun } from "~/lib/types.ts";

const statusLabels = {
  queued: "已排队，等待项目执行器领取",
  running: "运行中",
  succeeded: "已完成",
  failed: "执行失败",
};

interface CliRunQuery {
  projectId?: string;
  taskId?: string;
  submitted: CliRun | null;
  onRefreshTask: (taskId: string) => Promise<void>;
}

export function useCliRuns({ projectId, taskId, submitted, onRefreshTask }: CliRunQuery) {
  const [runs, setRuns] = useState<CliRun[]>([]);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!projectId || !taskId) return;
    let active = true;
    let timer: number;
    let refreshed = new Set<string>();
    let refreshSubmission = Boolean(submitted);

    const poll = async () => {
      let delay = 3000;
      try {
        const { runs: latest } = await api.listCliRuns(projectId, taskId);
        if (!active) return;
        setRuns(latest);
        const completed = latest.filter((run) => run.status === "succeeded" || run.status === "failed");
        if (refreshSubmission || completed.some((run) => !refreshed.has(run.id))) {
          try {
            await onRefreshTask(taskId);
          } catch {
            if (active) setNotice("讨论记录暂时无法刷新，正在重试。");
            return;
          }
          if (!active) return;
          refreshed = new Set(completed.map((run) => run.id));
          refreshSubmission = false;
        }
        setNotice("");
        const includesSubmission = !submitted || latest.some((run) => run.id === submitted.id);
        if (completed.length === latest.length && includesSubmission) {
          delay = 20000;
        }
      } catch {
        if (active) setNotice("暂时无法读取 CLI 状态，正在重试。");
      } finally {
        if (active) timer = window.setTimeout(poll, delay);
      }
    };

    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [projectId, taskId, submitted, onRefreshTask]);

  const visible = submitted && !runs.some((run) => run.id === submitted.id)
    ? [submitted, ...runs]
    : runs;
  return { runs: visible, notice };
}

export function CliRunStatus({ runs, notice }: { runs: CliRun[]; notice: string }) {
  if (!runs.length && !notice) return null;
  return (
    <div role="status" aria-label="项目 CLI 运行状态" className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 text-xs">
      {runs.map((run) => (
        <div key={run.id} className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong>{run.mode === "pr_audit" ? "CLI · PR 审计" : "CLI · 任务讨论"}</strong>
            <span className={run.status === "failed" ? "text-rose-600 dark:text-rose-400" : "text-[var(--text-secondary)]"}>
              {statusLabels[run.status]}
            </span>
            {/^[a-f0-9]{7,64}$/i.test(run.sha) && <code>{run.sha.slice(0, 7)}</code>}
          </div>
          {(run.status === "queued" || run.status === "running") && run.progress && <p className="break-words text-[var(--text-muted)]">{run.progress}</p>}
        </div>
      ))}
      {runs.some((run) => run.status === "queued") && (
        <p className="text-[var(--text-muted)]">执行器离线时，请求会留在队列中。启动本项目的执行器即可继续。</p>
      )}
      {notice && <p className="text-amber-700 dark:text-amber-300">{notice}</p>}
    </div>
  );
}
