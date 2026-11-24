import { expireGateLeases, gateInProgress, registerGateDispatcher, tryPresetGate } from "./deploy-gate.ts";
import type { BridgeHub } from "./bridge-hub.ts";
import type { ChatRunManager } from "./chat-run-manager.ts";
import { getChatRuntimeInfo } from "./codex-chat.ts";
import { ApiError } from "./errors.ts";
import {
  resolveLocalTaskExecutionTarget,
  type ResolvedChatExecutionTarget,
} from "./execution-router.ts";
import { extractShaFromDeliveryRef, Store, toAgentProject } from "./store.ts";
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
    `Do NOT load or run any external \`relaydesk\` CLI skill or \`relaydesk.mjs\`; use the connected \`relaydesk\` MCP server directly (\`list_tasks\`, \`get_task\`, \`list_releases\`, \`checkpoint_release\`, \`finish_release\`, plus read-only DB tools).`,
    "",
    "### Deployment Documentation Lookup Order",
    ...docOrder,
    "",
    "### Strict Rules & Safety",
    ...(release.trigger === "ai_gate" ? [`This approval is for the exact batch below and immutable target ${release.target_sha} only. Verify the running baseline and target before cutover; block if either differs from the approved baseline ${release.verification_context.ai_gate_baseline} and target. Never deploy a moving branch, latest image or a superset.`] : []),
    `1. **Read the deployment runbook first.** Follow the documented build, deploy, and verification steps faithfully.`,
    `2. **Block when docs are missing or high-risk:** If NO clear deployment procedure is documented in the sources above, OR if this release involves unconfirmed destructive database migrations, production secret rotations, or irreversible infrastructure changes, do **NOT** guess or improvise—call \`finish_release(release_id: "${relCode}", status: "blocked", summary: "<exact missing info or risk>")\` and stop.`,
    `3. **Persist pre-cutover checkpoint:** Before executing any deployment cutover or service restart (especially if deploying this project may restart Relaydesk itself or drop the bridge connection), call MCP \`checkpoint_release(release_id: "${relCode}", target_sha: "<full-40-char-sha>", deploy_ref: "<branch@sha>", health_url: "<url>", deploy_log: "<remote-log-path>", checks: [...], notes: "<rollback baseline / extra info>")\` (pass \`pier_server\` / \`pier_project\` only when this project deploys via Pier) so post-restart verification has full context.`,
    `4. **Verify code & health:** Confirm the local/remote branch matches the commits for the included tasks, execute the deployment steps, and verify production health/smoke checks before declaring success.`,
    `5. **Self-restart resilience:** If deploying this project restarts the Relaydesk server itself, persist \`checkpoint_release\` first, then trigger the detached cutover as the final step. Once reconnected, verification can resume on this same release without re-deploying.`,
    `6. **Never expose credentials:** Never print raw passwords, API keys, SSH private keys, or database connection strings in output or release summaries.`,
    `7. **Mandatory completion call:** Always end this session by calling MCP \`finish_release\` with:`,
    `   - \`release_id\`: \`"${relCode}"\``,
    `   - \`status\`: \`"succeeded"\`, \`"failed"\`, \`"blocked"\`, or \`"verifying"\` (use \`"verifying"\` if cutover is still in progress or verification evidence is insufficient)`,
    `   - \`deploy_ref\`: deployed commit SHA / image tag / release reference (if applicable)`,
    `   - \`target_sha\`: verified target commit SHA (if applicable)`,
    `   - \`summary\`: concise Markdown summary of what was deployed, health-check results, or exact failure/block reasons.`,
  ].join("\n");
}

export function buildReleaseVerifySystemContext(
  project: AgentProjectInfo,
  release: ReleaseRecord,
  options: { deployDocExists?: boolean } = {},
): string {
  const relCode = `REL-${release.number}`;
  const policy = project.deploy_policy;
  const docOrder: string[] = [];
  if (policy.doc_path.trim()) {
    docOrder.push(`1. Configured deploy doc path: \`${policy.doc_path.trim()}\` (check inside \`./\` or \`$RELAYDESK_SPACE_DIR/${policy.doc_path.trim()}\`).`);
  }
  docOrder.push(
    `${docOrder.length + 1}. Project Space deploy runbook: \`$RELAYDESK_SPACE_DIR/DEPLOY.md\`${options.deployDocExists ? " (present)" : " (check if present)"}.`,
  );
  docOrder.push(
    `${docOrder.length + 1}. Project Handbook deployment section: \`$RELAYDESK_SPACE_DIR/HANDBOOK.md\`.`,
  );

  const ctx = release.verification_context;
  const hasPierContext = Boolean(ctx.pier_server || ctx.pier_project);
  const evidenceItems: string[] = [
    `   - **Actual running version / target SHA** on the documented target server/service (e.g. deployed git commit/tag, version endpoint, \`.env\` / \`IMAGE_TAG\`, or container image digest) matching the expected target SHA.`,
    `   - **Service & health checks** matching the deployment documentation and persisted \`health_url\` / \`checks\` (e.g. process/service/container status and configured internal or public health endpoint).`,
    `   - **Deployment logs / records** if available (e.g. persisted \`deploy_log\` or documented remote deployment logs).`,
  ];
  if (hasPierContext) {
    evidenceItems.push(
      `   - **Pier deployment record** matching this release / target SHA for the recorded Pier target (\`${ctx.pier_server || "unspecified"}\` / \`${ctx.pier_project || "unspecified"}\`).`,
    );
  }

  return [
    `## Production Release Re-Verification Workflow (${relCode} · VERIFY-ONLY)`,
    `You are performing **read-only post-deploy verification** on existing Relaydesk release **${relCode}** (ID: \`${release.id}\`) for project "${project.name}".`,
    `Do NOT load or run any external \`relaydesk\` CLI skill or \`relaydesk.mjs\`; use the connected \`relaydesk\` MCP server directly (\`list_tasks\`, \`get_task\`, \`list_releases\`, \`checkpoint_release\`, \`finish_release\`, plus read-only DB tools).`,
    "",
    "### Deployment Documentation Reference (for verification checks only)",
    ...docOrder,
    "",
    "### Strict VERIFY-ONLY Rules",
    `1. **Read the deployment documentation first:** Check the documented target host(s), deployment method, version check, and health check endpoints before running any inspection commands.`,
    `2. **NEVER re-deploy or mutate production:** Do NOT run deploy scripts, \`docker compose up\`, rebuild images, restart services/containers, push git commits, or trigger any mutating action. Perform **read-only verification checks only**.`,
    `3. **Verify strictly from real evidence:** Judge the actual state of \`${relCode}\` from the checks documented for this project and the persisted verification context:`,
    ...evidenceItems,
    `4. **Exact outcome mapping via \`finish_release\`:**`,
    `   - **All documented checks pass & target SHA confirmed** → call \`finish_release(release_id: "${relCode}", status: "succeeded", target_sha: "<verified-sha>", deploy_ref: "<verified-ref>", summary: "<concise evidence: running SHA, service & health checks${hasPierContext ? ", Pier record" : ""}>")\`. This syncs the release and linked tasks idempotently (and corrects any prior false failure while preserving the original failure reason).`,
    `   - **Confirmed failure or rollback** (e.g. deploy failed in logs, service rolled back to previous SHA, or service/health checks failing) → call \`finish_release(release_id: "${relCode}", status: "failed", summary: "<exact verified failure or rollback evidence>")\`.`,
    `   - **Insufficient evidence** (e.g. remote deploy is still in progress, target host unreachable, or running SHA cannot yet be confirmed) → call \`finish_release(release_id: "${relCode}", status: "verifying", summary: "<what was checked and what evidence is still missing>")\`.`,
    `5. **Never expose credentials:** Never print raw passwords, API keys, SSH private keys, or database connection strings.`,
    `6. **Mandatory completion call:** Always end by calling MCP \`finish_release\` for \`${relCode}\`.`,
  ].join("\n");
}

function releaseTaskLine(release: ReleaseRecord, item: ReleaseRecord["task_snapshot"][number]): string {
  if (release.trigger === "ai_gate") {
    // Reporter-controlled titles, labels and request text are not release-agent instructions.
    return `- **RD-${item.number}** · \`${extractShaFromDeliveryRef(item.delivery_ref)}\``;
  }
  const ref = item.delivery_ref ? ` · \`${item.delivery_ref}\`` : "";
  return `- **RD-${item.number}** [${item.priority}]${ref}：${item.title}`;
}

export function buildReleaseVerifyPrompt(
  project: AgentProjectInfo,
  release: ReleaseRecord,
  extraPrompt?: string,
): string {
  const relCode = `REL-${release.number}`;
  const ctx = release.verification_context;
  const lines: string[] = [
    `# 重新验收生产发布 ${relCode}（仅检查，严禁重新部署）`,
    `- **发布 ID**：\`${release.id}\`（编号：\`${relCode}\`）`,
    `- **项目**：${project.name}（\`${project.repo}\`）`,
    `- **目标 SHA**：${release.target_sha ? `\`${release.target_sha}\`` : "（未显式记录，请结合关联任务的 delivery_ref 核对）"}`,
  ];
  if (release.deploy_ref) {
    lines.push(`- **Deploy Ref**：\`${release.deploy_ref}\``);
  }
  if (ctx.pier_server || ctx.pier_project) {
    lines.push(
      `- **Pier 目标**：server=\`${ctx.pier_server || "未指定"}\` · project=\`${ctx.pier_project || "未指定"}\``,
    );
  }
  if (ctx.health_url) {
    lines.push(`- **健康检查地址**：\`${ctx.health_url}\``);
  }
  if (ctx.deploy_log) {
    lines.push(`- **远端部署日志**：\`${ctx.deploy_log}\``);
  }
  if (ctx.checks && ctx.checks.length > 0) {
    lines.push("", "## 持久化检查项");
    for (const check of ctx.checks) {
      lines.push(`- ${check}`);
    }
  }
  if (ctx.notes) {
    lines.push("", "## 切换前持久化备注", ctx.notes);
  }
  if (ctx.previous_failure_summary) {
    lines.push(
      "",
      "## 原失败记录（如验收确认已成功上线，将修正该误报并自动保留原失败原因）",
      ctx.previous_failure_summary,
    );
  }
  if (release.task_snapshot.length > 0) {
    lines.push("", `## 归属本发布单的任务（共 ${release.task_snapshot.length} 项）`);
    for (const item of release.task_snapshot) {
      lines.push(releaseTaskLine(release, item));
    }
  }
  if (extraPrompt?.trim()) {
    lines.push("", "## 操作者附加验收说明", extraPrompt.trim());
  }
  const verifyScope =
    ctx.pier_server || ctx.pier_project
      ? "先按项目部署文档核对实际运行的目标 SHA、服务与健康检查状态，以及对应 Pier 部署记录"
      : "先阅读项目部署文档，按文档指定的目标主机、版本核对方式与健康检查入口核对实际运行的目标 SHA 与服务状态";
  lines.push(
    "",
    `请严格仅执行只读验收检查（${verifyScope}），不要触发任何部署或重启操作；核验完毕后调用 \`finish_release\` 更新 \`${relCode}\` 状态。`,
  );
  return lines.join("\n");
}

export function buildReleaseBriefPrompt(
  project: AgentProjectInfo,
  release: ReleaseRecord,
  extraPrompt?: string,
): string {
  const relCode = `REL-${release.number}`;
  const triggerLabels: Record<ReleaseTrigger, string> = {
    ai_gate: "反馈侧申请 · AI 评估通过（ai_gate）",
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
      lines.push(releaseTaskLine(release, item));
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
  private readonly autoVerifyAttempts = new Map<string, number>();
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

    this.unsubscribers.push(registerGateDispatcher(store, {
      busy: id => this.chatRuns.hasActiveRunForProject(id),
      prepare: (id, taskIds, target, label, base, gateId) => {
        const projectInfo = toAgentProject(store.getProjectRow(id));
        const selection = this.releaseSelection(projectInfo);
        const { target: node } = resolveLocalTaskExecutionTarget({ store, bridgeHub, projectId: id, runtime: selection.runtime });
        if (!node) throw new ApiError(409, "没有可用的发布节点");
        const prepared = this.prepareReleaseSession({
          projectInfo, trigger: "ai_gate", taskIds, targetSha: target, gateRequester: label, gateBaseline: base, gateId,
          ...selection,
          resolvedTarget: { targetKey: node.targetKey, localAgentId: node.agent.id, localBinding: node.binding, agentName: node.agent.name },
        });
        return { releaseId: prepared.release.id, start: prepared.start };
      },
    }));
    expireGateLeases(store);

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
    let projects: Array<{
      id: string;
      automation_paused: boolean;
      deploy_policy: ProjectDeployPolicy;
      active_release_id?: string | null;
    }>;
    try {
      expireGateLeases(this.store);
      projects = this.store.listProjects();
    } catch {
      return;
    }
    for (const project of projects) {
      if (
        !project.automation_paused &&
        (project.deploy_policy.mode === "immediate" ||
          project.deploy_policy.mode === "scheduled" ||
          (project.deploy_policy.mode === "manual" && project.deploy_policy.allow_ai_immediate_deploy) ||
          Boolean(project.active_release_id))
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
    if (
      this.store.hasActiveRelease(projectId) ||
      this.store.hasActiveAgentTask(projectId) ||
      this.chatRuns.hasActiveRunForProject(projectId)
    ) {
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
      // Priority 1: if a previous release was interrupted (e.g. self-restart / disconnect)
      // and is awaiting verification, resume read-only verification on the SAME release
      // once a local agent reconnects, without triggering a new deployment.
      const verifyingRelease = this.store.getVerifyingRelease(projectId);
      if (verifyingRelease) {
        const projectRow = this.store.getProjectRow(projectId);
        if (projectRow.automation_paused) {
          return { dispatched: false, reason: "automation_paused" };
        }
        if (
          this.store.hasActiveAgentTask(projectId) ||
          this.chatRuns.hasActiveRunForProject(projectId)
        ) {
          return { dispatched: false, reason: "project_busy" };
        }
        const nowMs = this.nowFn().getTime();
        const lastAttempt = this.autoVerifyAttempts.get(verifyingRelease.id) ?? 0;
        if (lastAttempt > 0 && nowMs - lastAttempt < this.cooldownMs) {
          return { dispatched: false, reason: "reverify_cooldown" };
        }
        const projectInfo = toAgentProject(projectRow);
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
        this.autoVerifyAttempts.set(verifyingRelease.id, nowMs);
        const started = this.launchReverifySession({
          projectInfo,
          releaseRef: verifyingRelease.id,
          ...selection,
          resolvedTarget: {
            targetKey: resolution.target.targetKey,
            localAgentId: resolution.target.agent.id,
            localBinding: resolution.target.binding,
            agentName: resolution.target.agent.name,
          },
        });
        return {
          dispatched: true,
          releaseId: started.release.id,
          sessionId: started.session.id,
        };
      }

      if (gateInProgress(this.store, projectId)) return { dispatched: false, reason: "gate_evaluating" };
      const check = this.evaluateProject(projectId);
      if (!check.eligible || !check.trigger || !check.tasks) {
        if (check.reason === "policy_manual" || check.reason === "outside_deploy_window") tryPresetGate(this.store, projectId);
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

    if (gateInProgress(this.store, projectId)) throw new ApiError(409, "AI 门禁评估进行中，请稍后重试");
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

  reverifyRelease(
    projectId: string,
    releaseRef: string | number,
    options: Omit<ManualReleaseOptions, "force"> = {},
  ): { release: ReleaseRecord; session: ChatSessionRecord; runId: string } {
    const projectInfo = toAgentProject(this.store.getProjectRow(projectId));
    if (this.store.hasActiveAgentTask(projectId) || this.chatRuns.hasActiveRunForProject(projectId)) {
      throw new ApiError(409, "当前项目已有正在执行的任务或发布会话，请等待完成后再发起重新验收");
    }

    const existing = this.store.getRelease(projectId, releaseRef);
    if (existing.status === "succeeded") {
      throw new ApiError(409, `发布单 REL-${existing.number} 已验收成功，无需重新验收`);
    }
    if (existing.status === "running") {
      throw new ApiError(409, `发布单 REL-${existing.number} 正在执行中`);
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
        `没有可用的在线本机 Agent 节点执行验收：${resolution.reasons.join("；") || "无可用节点"}`,
      );
    }

    const resolvedTarget: ResolvedChatExecutionTarget = {
      targetKey: resolution.target.targetKey,
      localAgentId: resolution.target.agent.id,
      localBinding: resolution.target.binding,
      agentName: resolution.target.agent.name,
    };

    // Reset auto-verify cooldown so manual reverify records fresh timestamp.
    this.autoVerifyAttempts.set(existing.id, this.nowFn().getTime());

    return this.launchReverifySession({
      projectInfo,
      releaseRef: existing.id,
      ...selection,
      resolvedTarget,
      extraPrompt: options.prompt,
    });
  }

  private launchReverifySession(params: {
    projectInfo: AgentProjectInfo;
    releaseRef: string | number;
    runtime: ChatRuntime;
    model: string;
    reasoningEffort: ChatReasoningEffort;
    networkAccess: boolean;
    resolvedTarget: ResolvedChatExecutionTarget;
    extraPrompt?: string;
  }): { release: ReleaseRecord; session: ChatSessionRecord; runId: string } {
    const { release, session } = this.store.prepareReleaseReverify(
      params.projectInfo.id,
      params.releaseRef,
      {
        runtime: params.runtime,
        model: params.model,
        reasoning_effort: params.reasoningEffort,
        execution_target: params.resolvedTarget.targetKey,
        network_access: params.networkAccess,
      },
    );

    const deployDoc = readWorkspaceDeployDoc(this.store.dbPath, params.projectInfo.id);
    const systemContext = buildReleaseVerifySystemContext(params.projectInfo, release, {
      deployDocExists: deployDoc.exists,
    });
    const prompt = buildReleaseVerifyPrompt(params.projectInfo, release, params.extraPrompt);

    const started = this.chatRuns.startTurn({
      projectInfo: params.projectInfo,
      sessionId: session.id,
      content: prompt,
      extraSystemContext: systemContext,
      skipAutoTitle: true,
      forceFreshThread: true,
      resolvedTargetOverride: params.resolvedTarget,
    });
    return { release, session: started.session, runId: started.runId };
  }

  private launchReleaseSession(params: Parameters<ReleaseDispatcher["prepareReleaseSession"]>[0]) {
    return this.prepareReleaseSession(params).start();
  }

  private prepareReleaseSession(params: {
    projectInfo: AgentProjectInfo;
    trigger: ReleaseTrigger;
    taskIds: string[];
    targetSha?: string;
    gateRequester?: string;
    gateBaseline?: string;
    gateId?: string;
    runtime: ChatRuntime;
    model: string;
    reasoningEffort: ChatReasoningEffort;
    networkAccess: boolean;
    resolvedTarget: ResolvedChatExecutionTarget;
    extraPrompt?: string;
  }) {
    const { release, session } = this.store.createRelease(params.projectInfo.id, {
      trigger: params.trigger,
      target_sha: params.targetSha,
      gateRequester: params.gateRequester,
      gateBaseline: params.gateBaseline,
      gateId: params.gateId,
      taskIds: params.taskIds,
      runtime: params.runtime,
      model: params.model,
      reasoning_effort: params.reasoningEffort,
      execution_target: params.resolvedTarget.targetKey,
      network_access: params.networkAccess,
    });

    const start = () => {
      try {
        const deployDoc = readWorkspaceDeployDoc(this.store.dbPath, params.projectInfo.id);
        const systemContext = buildReleaseSystemContext(params.projectInfo, release, {
          deployDocExists: deployDoc.exists,
        });
        const prompt = buildReleaseBriefPrompt(params.projectInfo, release, params.extraPrompt);
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
    };
    return { release, start };
  }
}
