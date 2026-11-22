import type { BridgeHub } from "./bridge-hub.ts";
import type { ChatRunManager } from "./chat-run-manager.ts";
import { getChatRuntimeInfo } from "./codex-chat.ts";
import { ApiError } from "./errors.ts";
import {
  resolveLocalTaskExecutionTarget,
  type ResolvedChatExecutionTarget,
} from "./execution-router.ts";
import { Store, toAgentProject } from "./store.ts";
import { readWorkspaceDeployDoc } from "./workspace.ts";
import type {
  AgentProjectInfo,
  ChatReasoningEffort,
  ChatRuntime,
  ChatSessionRecord,
  ProjectDeployPolicy,
  ReleaseRecord,
  ReleaseTrigger,
  TaskRecord,
} from "../app/lib/types.ts";

export const FAILED_RELEASE_COOLDOWN_MS = 10 * 60 * 1000;
export const DEFAULT_RELEASE_POLL_MS = 60_000;

export interface ManualReleaseOptions {
  force?: boolean;
  prompt?: string;
  runtime?: ChatRuntime;
  model?: string;
  reasoning_effort?: ChatReasoningEffort;
  execution_target?: string;
}

export interface ReleaseDispatcherOptions {
  pollIntervalMs?: number;
  cooldownMs?: number;
  now?: () => Date;
}

function parseClockMinutes(hhmm: string): number {
  const [hStr, mStr] = hhmm.split(":");
  return Number(hStr) * 60 + Number(mStr);
}

/**
 * Evaluate whether `now` falls inside the configured `[window_start, window_end)`
 * interval in `policy.timezone`. Supports cross-midnight windows (e.g. `23:00`–`06:00`).
 */
export function isInsideDeployWindow(
  policy: Pick<ProjectDeployPolicy, "window_start" | "window_end" | "timezone">,
  now: Date = new Date(),
): boolean {
  const startMin = parseClockMinutes(policy.window_start);
  const endMin = parseClockMinutes(policy.window_end);
  if (Number.isNaN(startMin) || Number.isNaN(endMin)) return false;
  if (startMin === endMin) return true;

  let hour = 0;
  let minute = 0;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: policy.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const rawHour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const rawMinute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    hour = rawHour === 24 ? 0 : rawHour;
    minute = rawMinute;
  } catch {
    hour = now.getUTCHours();
    minute = now.getUTCMinutes();
  }

  const nowMin = hour * 60 + minute;
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Cross-midnight window, e.g. 23:00 -> 06:00
  return nowMin >= startMin || nowMin < endMin;
}

export function buildReleaseSystemContext(
  project: AgentProjectInfo,
  release: ReleaseRecord,
  options: { deployDocExists?: boolean } = {},
): string {
  const relCode = `REL-${release.number}`;
  const policy = project.deploy_policy;
  const docOrder: string[] = [];
  if (policy.doc_path.trim()) {
    docOrder.push(`1. Configured deploy doc path: \`${policy.doc_path.trim()}\` (check inside the repo workdir \`./\` first, or \`$RELAYDESK_SPACE_DIR/${policy.doc_path.trim()}\`).`);
  }
  docOrder.push(
    `${docOrder.length + 1}. Project Space deploy runbook: \`$RELAYDESK_SPACE_DIR/DEPLOY.md\`${options.deployDocExists ? " (present)" : " (check if present)"}.`,
  );
  docOrder.push(
    `${docOrder.length + 1}. Project Handbook deployment section: \`$RELAYDESK_SPACE_DIR/HANDBOOK.md\`.`,
  );
  docOrder.push(
    `${docOrder.length + 1}. Project instructions and repository deployment docs/scripts (\`README.md\`, \`docs/\`, \`scripts/\`, etc.).`,
  );

  return [
    `## Autonomous Production Release Workflow (${relCode})`,
    `You are executing Relaydesk production release **${relCode}** for project "${project.name}" (trigger: \`${release.trigger}\`).`,
    `Do NOT load or run any external \`relaydesk\` CLI skill or \`relaydesk.mjs\`; use the connected \`relaydesk\` MCP server directly (\`list_tasks\`, \`get_task\`, \`list_releases\`, \`finish_release\`, plus read-only DB tools).`,
    "",
    "### Deployment Documentation Lookup Order",
    ...docOrder,
    "",
    "### Strict Rules & Safety",
    `1. **Read the deployment runbook first.** Follow the documented build, deploy, and verification steps faithfully.`,
    `2. **Block when docs are missing or high-risk:** If NO clear deployment procedure is documented in the sources above, OR if this release involves unconfirmed destructive database migrations, production secret rotations, or irreversible infrastructure changes, do **NOT** guess or improvise—call \`finish_release(release_id: "${relCode}", status: "blocked", summary: "<exact missing info or risk>")\` and stop.`,
    `3. **Verify code & health:** Confirm the local/remote branch matches the commits for the included tasks, execute the deployment steps, and verify production health/smoke checks before declaring success.`,
    `4. **Self-restart resilience:** If deploying this project restarts the Relaydesk server itself, wait until the restarted service passes its health check before calling \`finish_release\`. If an MCP call momentarily fails while the server is restarting, pause briefly and retry once the service is healthy.`,
    `5. **Never expose credentials:** Never print raw passwords, API keys, SSH private keys, or database connection strings in output or release summaries.`,
    `6. **Mandatory completion call:** Always end this session by calling MCP \`finish_release\` with:`,
    `   - \`release_id\`: \`"${relCode}"\``,
    `   - \`status\`: \`"succeeded"\`, \`"failed"\`, or \`"blocked"\``,
    `   - \`deploy_ref\`: deployed commit SHA / image tag / release reference (if applicable)`,
    `   - \`summary\`: concise Markdown summary of what was deployed, health-check results, or exact failure/block reasons.`,
  ].join("\n");
}

export function buildReleaseBriefPrompt(
  project: AgentProjectInfo,
  release: ReleaseRecord,
  extraPrompt?: string,
): string {
  const relCode = `REL-${release.number}`;
  const triggerLabels: Record<ReleaseTrigger, string> = {
    immediate: "自动立即发布（immediate）",
    scheduled: "定时窗口期自动发布（scheduled）",
    urgent: "紧急任务窗口穿透发布（urgent override）",
    manual: "手动触发发布（manual）",
  };

  const lines: string[] = [
    `# 生产发布 ${relCode}（项目：${project.name}）`,
    `- **触发方式**：${triggerLabels[release.trigger] ?? release.trigger}`,
    `- **代码仓库**：${project.repo}`,
    `- **部署策略**：\`${project.deploy_policy.mode}\`${project.deploy_policy.doc_path ? `（自定义文档：\`${project.deploy_policy.doc_path}\`）` : ""}`,
  ];

  if (release.task_snapshot.length > 0) {
    lines.push("", `## 本次包含的待发布任务（共 ${release.task_snapshot.length} 项）`);
    for (const item of release.task_snapshot) {
      const refPart = item.delivery_ref ? ` · \`${item.delivery_ref}\`` : "";
      lines.push(`- **RD-${item.number}** [${item.priority}]${refPart}：${item.title}`);
    }
  } else {
    lines.push("", "## 本次包含的待发布任务", "- 无关联任务（手动强制发布当前最新代码）");
  }

  if (extraPrompt?.trim()) {
    lines.push("", "## 操作者附加说明", extraPrompt.trim());
  }

  lines.push(
    "",
    `请先查阅项目部署文档并核对当前代码状态，按文档完成生产部署与健康检查；完成后务必调用内置 \`relaydesk\` MCP 的 \`finish_release\` 工具汇报 \`${relCode}\` 的最终状态。`,
  );

  return lines.join("\n");
}

export class ReleaseDispatcher {
  private readonly store: Store;
  private readonly bridgeHub: BridgeHub | null;
  private readonly chatRuns: ChatRunManager;
  private readonly cooldownMs: number;
  private readonly nowFn: () => Date;
  private readonly pendingProjects = new Set<string>();
  private readonly inflightProjects = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(
    store: Store,
    bridgeHub: BridgeHub | null,
    chatRuns: ChatRunManager,
    options: ReleaseDispatcherOptions = {},
  ) {
    this.store = store;
    this.bridgeHub = bridgeHub;
    this.chatRuns = chatRuns;
    this.cooldownMs = options.cooldownMs ?? FAILED_RELEASE_COOLDOWN_MS;
    this.nowFn = options.now ?? (() => new Date());

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
        this.schedule(info.projectId);
        this.scheduleAll();
      }),
    );

    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_RELEASE_POLL_MS;
    if (pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => {
        this.scheduleAll();
      }, pollIntervalMs);
      this.pollTimer.unref();
    }
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
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
      }, 30);
      this.flushTimer.unref();
    }
  }

  scheduleAll(): void {
    let projects: Array<{ id: string; automation_paused: boolean; deploy_policy: ProjectDeployPolicy }>;
    try {
      projects = this.store.listProjects();
    } catch {
      return;
    }
    for (const project of projects) {
      if (
        !project.automation_paused &&
        (project.deploy_policy.mode === "immediate" || project.deploy_policy.mode === "scheduled")
      ) {
        this.pendingProjects.add(project.id);
      }
    }
    if (this.pendingProjects.size > 0 && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, 30);
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

  /**
   * Pure decision helper for auto-release eligibility on a single project.
   * Returns the trigger + batch of tasks to release, or a skip reason.
   */
  evaluateProject(projectId: string): {
    eligible: boolean;
    reason?: string;
    trigger?: ReleaseTrigger;
    tasks?: TaskRecord[];
  } {
    const projectRow = this.store.getProjectRow(projectId);
    if (projectRow.automation_paused) {
      return { eligible: false, reason: "automation_paused" };
    }
    const policy = this.store.getProjectDeployPolicy(projectId);
    if (policy.mode === "none" || policy.mode === "manual") {
      return { eligible: false, reason: `policy_${policy.mode}` };
    }
    if (this.store.hasActiveAgentTask(projectId) || this.chatRuns.hasActiveRunForProject(projectId)) {
      return { eligible: false, reason: "project_busy" };
    }
    // Wait until the ready queue is idle so consecutive tasks are batched into one release.
    if (this.store.hasPendingReadyTasks(projectId)) {
      return { eligible: false, reason: "ready_queue_not_empty" };
    }

    const pendingTasks = this.store.listTasksByDeployStatus(projectId, ["pending"]);
    if (pendingTasks.length === 0) {
      // Circuit breaker: never auto-retry when only previously failed tasks exist.
      return { eligible: false, reason: "no_pending_tasks" };
    }

    const now = this.nowFn();
    let trigger: ReleaseTrigger;
    if (policy.mode === "immediate") {
      trigger = "immediate";
    } else {
      const inWindow = isInsideDeployWindow(policy, now);
      const hasUrgent =
        policy.allow_urgent_override && pendingTasks.some((task) => task.priority === "urgent");
      if (inWindow) {
        trigger = "scheduled";
      } else if (hasUrgent) {
        trigger = "urgent";
      } else {
        return { eligible: false, reason: "outside_deploy_window" };
      }
    }

    // Failure cooldown: after a failed/blocked release, wait cooldownMs before auto-retrying even with new pending tasks.
    const lastRelease = this.store.getLastRelease(projectId);
    if (lastRelease && (lastRelease.status === "failed" || lastRelease.status === "blocked")) {
      const finishedMs = Date.parse(lastRelease.finished_at || lastRelease.updated_at);
      if (!Number.isNaN(finishedMs) && now.getTime() - finishedMs < this.cooldownMs) {
        return { eligible: false, reason: "failed_cooldown" };
      }
    }

    // Include any previously failed tasks in the new batch so unshipped commits deploy together.
    const failedTasks = this.store.listTasksByDeployStatus(projectId, ["failed"]);
    const batchMap = new Map<string, TaskRecord>();
    for (const task of [...pendingTasks, ...failedTasks]) {
      batchMap.set(task.id, task);
    }

    return {
      eligible: true,
      trigger,
      tasks: Array.from(batchMap.values()),
    };
  }

  private releaseSelection(project: AgentProjectInfo, overrides: ManualReleaseOptions = {}) {
    const routing = this.store.getProjectExecutionRouting(project.id);
    const policy = project.deploy_policy;
    const runtime = overrides.runtime ?? policy.runtime ?? routing.task_runtime ??
      getChatRuntimeInfo(this.store.dbPath, project.id).project_cli.runtime ?? "codex";
    // A configured harness with no model uses that harness's own default.
    const defaultModel = policy.runtime === null ? routing.task_model :
      runtime === policy.runtime ? policy.model : null;
    return {
      runtime,
      model: overrides.model ?? defaultModel ?? "",
      reasoningEffort: overrides.reasoning_effort ?? routing.task_reasoning_effort ?? "default",
      networkAccess: routing.task_network_access ?? true,
    };
  }

  tryDispatchProject(projectId: string): {
    dispatched: boolean;
    reason?: string;
    releaseId?: string;
    sessionId?: string;
  } {
    if (this.inflightProjects.has(projectId)) {
      return { dispatched: false, reason: "inflight" };
    }
    this.inflightProjects.add(projectId);
    try {
      const check = this.evaluateProject(projectId);
      if (!check.eligible || !check.trigger || !check.tasks) {
        return { dispatched: false, reason: check.reason };
      }

      const projectInfo = toAgentProject(this.store.getProjectRow(projectId));
      const selection = this.releaseSelection(projectInfo);
      const resolution = resolveLocalTaskExecutionTarget({
        store: this.store,
        bridgeHub: this.bridgeHub,
        projectId,
        runtime: selection.runtime,
      });
      if (!resolution.target) {
        return { dispatched: false, reason: resolution.reasons.join("；") || "no_local_agent" };
      }

      const resolvedTarget: ResolvedChatExecutionTarget = {
        targetKey: resolution.target.targetKey,
        localAgentId: resolution.target.agent.id,
        localBinding: resolution.target.binding,
        agentName: resolution.target.agent.name,
      };
      const started = this.launchReleaseSession({
        projectInfo,
        trigger: check.trigger,
        taskIds: check.tasks.map((t) => t.id),
        ...selection,
        resolvedTarget,
      });
      return {
        dispatched: true,
        releaseId: started.release.id,
        sessionId: started.session.id,
      };
    } catch {
      return { dispatched: false, reason: "dispatch_error" };
    } finally {
      this.inflightProjects.delete(projectId);
    }
  }

  triggerReleaseManually(
    projectId: string,
    options: ManualReleaseOptions = {},
  ): { release: ReleaseRecord; session: ChatSessionRecord; runId: string } {
    const projectInfo = toAgentProject(this.store.getProjectRow(projectId));
    if (this.store.hasActiveAgentTask(projectId) || this.chatRuns.hasActiveRunForProject(projectId)) {
      throw new ApiError(409, "当前项目已有正在执行的任务或发布会话，请等待完成后再触发发布");
    }

    const batchTasks = this.store.listTasksByDeployStatus(projectId, ["pending", "failed"]);
    if (batchTasks.length === 0 && !options.force) {
      throw new ApiError(
        400,
        "当前没有待发布或发布失败的任务；如确需发布最新代码，请勾选强制发布",
      );
    }

    const selection = this.releaseSelection(projectInfo, options);
    const resolution = resolveLocalTaskExecutionTarget({
      store: this.store,
      bridgeHub: this.bridgeHub,
      projectId,
      runtime: selection.runtime,
      executionTarget: options.execution_target,
    });
    if (!resolution.target) {
      throw new ApiError(
        409,
        `没有可用的在线本机 Agent 节点执行发布：${resolution.reasons.join("；") || "无可用节点"}`,
      );
    }

    const resolvedTarget: ResolvedChatExecutionTarget = {
      targetKey: resolution.target.targetKey,
      localAgentId: resolution.target.agent.id,
      localBinding: resolution.target.binding,
      agentName: resolution.target.agent.name,
    };

    return this.launchReleaseSession({
      projectInfo,
      trigger: "manual",
      taskIds: batchTasks.map((t) => t.id),
      ...selection,
      resolvedTarget,
      extraPrompt: options.prompt,
    });
  }

  private launchReleaseSession(params: {
    projectInfo: AgentProjectInfo;
    trigger: ReleaseTrigger;
    taskIds: string[];
    runtime: ChatRuntime;
    model: string;
    reasoningEffort: ChatReasoningEffort;
    networkAccess: boolean;
    resolvedTarget: ResolvedChatExecutionTarget;
    extraPrompt?: string;
  }): { release: ReleaseRecord; session: ChatSessionRecord; runId: string } {
    const { release, session } = this.store.createRelease(params.projectInfo.id, {
      trigger: params.trigger,
      taskIds: params.taskIds,
      runtime: params.runtime,
      model: params.model,
      reasoning_effort: params.reasoningEffort,
      execution_target: params.resolvedTarget.targetKey,
      network_access: params.networkAccess,
    });

    const deployDoc = readWorkspaceDeployDoc(this.store.dbPath, params.projectInfo.id);
    const systemContext = buildReleaseSystemContext(params.projectInfo, release, {
      deployDocExists: deployDoc.exists,
    });
    const prompt = buildReleaseBriefPrompt(params.projectInfo, release, params.extraPrompt);

    try {
      const started = this.chatRuns.startTurn({
        projectInfo: params.projectInfo,
        sessionId: session.id,
        content: prompt,
        extraSystemContext: systemContext,
        skipAutoTitle: true,
        resolvedTargetOverride: params.resolvedTarget,
      });
      return { release, session: started.session, runId: started.runId };
    } catch (err) {
      // Roll back running release if starting the chat turn synchronously failed.
      const errMsg = err instanceof Error ? err.message : "Failed to start release session";
      try {
        this.store.finishRelease(params.projectInfo.id, release.id, {
          status: "failed",
          summary: `Failed to start release session: ${errMsg}`,
          author: "system",
        });
      } catch {
        // Ignore rollback failure
      }
      throw err;
    }
  }
}
