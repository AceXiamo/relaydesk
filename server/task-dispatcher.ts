import type { BridgeHub } from "./bridge-hub.ts";
import { buildTaskWorkflowSystemContext, type ChatRunManager } from "./chat-run-manager.ts";
import { getChatRuntimeInfo } from "./codex-chat.ts";
import { ApiError } from "./errors.ts";
import {
  resolveLocalTaskExecutionTarget,
  type ResolvedChatExecutionTarget,
} from "./execution-router.ts";
import { Store, toAgentProject, toTaskView } from "./store.ts";
import type {
  ChatReasoningEffort,
  ChatRuntime,
  ChatSessionRecord,
  TaskMessage,
  TaskRecord,
} from "../app/lib/types.ts";

export interface ManualDispatchOptions {
  prompt?: string;
  runtime?: ChatRuntime;
  model?: string;
  reasoning_effort?: ChatReasoningEffort;
  execution_target?: string;
}

export function buildTaskBriefPrompt(
  task: TaskRecord,
  messages: TaskMessage[],
  merged: TaskRecord[],
  extraPrompt?: string,
): string {
  const code = `RD-${task.number}`;
  const sections: string[] = [
    `# 任务 ${code}：${task.title}`,
    `- **优先级**：${task.priority}`,
    `- **当前状态**：${task.status}`,
    `- **来源**：${task.source}${task.source_url ? ` (${task.source_url})` : ""}`,
  ];

  if (task.requirements.trim()) {
    sections.push("", "## 需求与验收标准", task.requirements.trim());
  }

  sections.push("", "## 反馈详情", task.body.trim() || "（无正文）");

  if (merged.length > 0) {
    const mergedLines = merged.map(
      (item) => `- **RD-${item.number}** (${item.source}): ${item.title}\n  ${item.body.trim().slice(0, 400)}`,
    );
    sections.push("", "## 关联重复反馈", mergedLines.join("\n"));
  }

  const comments = messages.filter((m) => m.kind === "comment").slice(-15);
  if (comments.length > 0) {
    const commentLines = comments.map(
      (c) => `- [${c.author}] (${c.created_at}):\n  ${c.body.trim().slice(0, 1200)}`,
    );
    sections.push("", "## 已有讨论评论", commentLines.join("\n"));
  }

  if (extraPrompt?.trim()) {
    sections.push("", "## 额外说明", extraPrompt.trim());
  }

  sections.push(
    "",
    `请核实代码并自主处理任务 ${code}；完成后务必通过内置 \`relaydesk\` MCP 的 \`transition_task\` 工具更新任务状态。`,
  );
  return sections.join("\n");
}

export class TaskDispatcher {
  private readonly store: Store;
  private readonly bridgeHub: BridgeHub | null;
  private readonly chatRuns: ChatRunManager;
  private readonly pendingProjects = new Set<string>();
  private readonly inflightProjects = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(store: Store, bridgeHub: BridgeHub | null, chatRuns: ChatRunManager) {
    this.store = store;
    this.bridgeHub = bridgeHub;
    this.chatRuns = chatRuns;

    if (bridgeHub) {
      this.unsubscribers.push(
        bridgeHub.onAvailabilityChange((projectIds) => {
          if (projectIds && projectIds.length > 0) {
            for (const pid of projectIds) this.schedule(pid);
          } else {
            this.scheduleAll();
          }
        }),
      );
    }

    this.unsubscribers.push(
      chatRuns.onTurnFinished((info) => {
        if (info.status === "aborted" && info.stopReason === "follow_up") {
          return;
        }
        // A run just freed both project lock and local agent concurrency slot.
        this.schedule(info.projectId);
        this.scheduleAll();
      }),
    );
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.pendingProjects.clear();
  }

  schedule(projectId: string): void {
    if (!projectId) return;
    this.pendingProjects.add(projectId);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, 20);
      this.flushTimer.unref();
    }
  }

  scheduleAll(): void {
    let projects: Array<{ id: string; automation_paused: boolean }>;
    try {
      projects = this.store.listProjects();
    } catch {
      return;
    }
    for (const project of projects) {
      if (!project.automation_paused) {
        this.pendingProjects.add(project.id);
      }
    }
    if (this.pendingProjects.size > 0 && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, 20);
      this.flushTimer.unref();
    }
  }

  private flush(): void {
    const ids = Array.from(this.pendingProjects);
    this.pendingProjects.clear();
    for (const projectId of ids) {
      this.tryDispatchProject(projectId);
    }
  }

  tryDispatchProject(projectId: string): { dispatched: boolean; taskId?: string; sessionId?: string } {
    if (this.inflightProjects.has(projectId)) {
      return { dispatched: false };
    }
    this.inflightProjects.add(projectId);
    try {
      const projectRow = this.store.getProjectRow(projectId);
      if (projectRow.automation_paused) {
        return { dispatched: false };
      }
      const routing = this.store.getProjectExecutionRouting(projectId);
      if (!routing.auto_dispatch_tasks) {
        return { dispatched: false };
      }
      if (this.store.hasActiveAgentTask(projectId) || this.chatRuns.hasActiveRunForProject(projectId)) {
        return { dispatched: false };
      }

      const nextTaskRow = this.store.findNextDispatchableTask(projectId);
      if (!nextTaskRow) {
        return { dispatched: false };
      }

      const runtimeInfo = getChatRuntimeInfo(this.store.dbPath, projectId);
      const runtime: ChatRuntime = routing.task_runtime ?? runtimeInfo.project_cli.runtime ?? "codex";
      const resolution = resolveLocalTaskExecutionTarget({
        store: this.store,
        bridgeHub: this.bridgeHub,
        projectId,
        runtime,
      });
      if (!resolution.target) {
        return { dispatched: false };
      }

      const started = this.dispatchTaskWithTarget(nextTaskRow.id, resolution.target, {
        reason: "auto",
        runtime,
        model: routing.task_model ?? "",
        reasoningEffort: routing.task_reasoning_effort ?? "default",
        networkAccess: routing.task_network_access ?? true,
      });
      return {
        dispatched: true,
        taskId: started.task.id,
        sessionId: started.session.id,
      };
    } catch {
      // Auto-dispatch must fail quietly; tasks remain queued for the next availability event.
      return { dispatched: false };
    } finally {
      this.inflightProjects.delete(projectId);
    }
  }

  dispatchTaskManually(
    taskId: string,
    opts: ManualDispatchOptions = {},
  ): { session: ChatSessionRecord; task: TaskRecord; run_id: string } {
    const taskRow = this.store.getTaskRow(taskId);
    if (taskRow.merged_into) {
      throw new ApiError(409, "此反馈已并入主任务，请在主任务中派发");
    }
    const existingSession = this.store.getTaskChatSession(taskId);
    if (existingSession && this.chatRuns.isRunning(existingSession.id)) {
      throw new ApiError(409, "当前任务正在由 Agent 执行中，可直接插话或先停止");
    }

    const projectId = taskRow.project_id;
    const routing = this.store.getProjectExecutionRouting(projectId);
    const runtimeInfo = getChatRuntimeInfo(this.store.dbPath, projectId);
    const runtime: ChatRuntime =
      opts.runtime ?? routing.task_runtime ?? runtimeInfo.project_cli.runtime ?? "codex";

    const resolution = resolveLocalTaskExecutionTarget({
      store: this.store,
      bridgeHub: this.bridgeHub,
      projectId,
      runtime,
      executionTarget: opts.execution_target,
    });
    if (!resolution.target) {
      throw new ApiError(
        409,
        `暂无可用的本机节点执行此任务：${resolution.reasons.join("；")}`,
      );
    }

    return this.dispatchTaskWithTarget(taskId, resolution.target, {
      reason: "manual",
      runtime,
      model: opts.model ?? routing.task_model ?? "",
      reasoningEffort: opts.reasoning_effort ?? routing.task_reasoning_effort ?? "default",
      networkAccess: routing.task_network_access ?? true,
      extraPrompt: opts.prompt,
    });
  }

  private dispatchTaskWithTarget(
    taskId: string,
    selected: NonNullable<ReturnType<typeof resolveLocalTaskExecutionTarget>["target"]>,
    opts: {
      reason: "auto" | "manual";
      runtime: ChatRuntime;
      model: string;
      reasoningEffort: ChatReasoningEffort;
      networkAccess: boolean;
      extraPrompt?: string;
    },
  ): { session: ChatSessionRecord; task: TaskRecord; run_id: string } {
    const prepared = this.store.transaction(true, () => {
      const taskRow = this.store.getTaskRow(taskId);
      const projectRow = this.store.getProjectRow(taskRow.project_id);
      const projectInfo = toAgentProject(projectRow);
      const taskViewBefore = toTaskView(taskRow);
      const messages = this.store.getTaskMessages(taskId);
      const merged = this.store.getMergedTasks(taskId);

      let session = this.store.getTaskChatSession(taskId);
      const title = `RD-${taskRow.number} · ${taskRow.title}`.slice(0, 120);
      if (!session) {
        session = this.store.createChatSession(projectInfo.id, {
          kind: "task",
          task_id: taskId,
          title,
          runtime: opts.runtime,
          model: opts.model,
          reasoning_effort: opts.reasoningEffort,
          execution_target: selected.targetKey,
          sandbox_mode: "workspace-write",
          network_access: opts.networkAccess,
        });
      } else {
        const permChanged =
          session.sandbox_mode !== "workspace-write" ||
          session.network_access !== opts.networkAccess ||
          session.runtime !== opts.runtime;
        session = this.store.updateChatSession(projectInfo.id, session.id, {
          title,
          runtime: opts.runtime,
          model: opts.model,
          reasoning_effort: opts.reasoningEffort,
          execution_target: selected.targetKey,
          sandbox_mode: "workspace-write",
          network_access: opts.networkAccess,
          ...(permChanged ? { external_session_id: "" } : {}),
        });
      }

      const claimedTask = this.store.claimTaskForSession(
        taskId,
        session.id,
        selected.agent.name,
        opts.reason,
      );

      const priorChatMessages = this.store.listChatMessages(projectInfo.id, session.id);
      const prompt =
        priorChatMessages.length === 0
          ? buildTaskBriefPrompt(taskViewBefore, messages, merged, opts.extraPrompt)
          : opts.extraPrompt?.trim()
            ? opts.extraPrompt.trim()
            : `请继续处理任务 RD-${taskRow.number}（当前状态已重新激活）。完成后请通过内置 \`relaydesk\` MCP 更新状态。`;

      return {
        projectInfo,
        session,
        claimedTask,
        prompt,
        taskNumber: taskRow.number,
      };
    });

    const resolvedTarget: ResolvedChatExecutionTarget = {
      targetKey: selected.targetKey,
      localAgentId: selected.agent.id,
      localBinding: selected.binding,
      agentName: selected.agent.name,
    };

    const started = this.chatRuns.startTurn({
      projectInfo: prepared.projectInfo,
      sessionId: prepared.session.id,
      content: prepared.prompt,
      extraSystemContext: buildTaskWorkflowSystemContext(
        prepared.projectInfo,
        prepared.taskNumber,
      ),
      skipAutoTitle: true,
      skipTaskAutoClaim: true,
      resolvedTargetOverride: resolvedTarget,
    });

    return {
      session: started.session,
      task: this.store.getTaskView(taskId),
      run_id: started.runId,
    };
  }
}
