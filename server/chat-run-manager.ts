import { createHash, randomUUID } from "node:crypto";
import type { BridgeHub } from "./bridge-hub.ts";
import { formatChatHistory } from "./chat-history.ts";
import {
  RELAYDESK_MCP_INSTRUCTIONS,
  abortChatSessionRun,
  buildAttachmentContext,
  buildResumePrompt,
  detectLocalClis,
  isChatSessionRunning,
  runWebCliChatTurn,
} from "./codex-chat.ts";
import { ApiError } from "./errors.ts";
import { collectPriorSubagents, finalizeTurnSubagents } from "./cli-stream-parser.ts";
import {
  canResumeExternalSession,
  resolveChatExecutionTarget,
  type ResolvedChatExecutionTarget,
} from "./execution-router.ts";
import { Store, toTaskView } from "./store.ts";
import { buildFallbackSessionTitle, generateSessionTitle } from "./utility-ai.ts";
import { buildWorkspaceManifest, getWorkspaceDatasourceRuntimeEnv } from "./workspace.ts";
import type {
  AgentProjectInfo,
  ChatContextRef,
  ChatMessageRecord,
  ChatReasoningEffort,
  ChatRuntime,
  ChatSandboxMode,
  ChatSessionRecord,
  ChatStreamEvent,
  ChatToolEvent,
  DeliveryMode,
} from "../app/lib/types.ts";
import type { RelaydeskDelegateAction } from "./relaydesk-mcp.ts";

export interface RunSubscriber {
  onEvent: (event: ChatStreamEvent) => void;
  onClose?: () => void;
}

export interface ChatTurnFinishedInfo {
  projectId: string;
  sessionId: string;
  sessionKind: ChatSessionRecord["kind"];
  taskId: string | null;
  releaseId: string | null;
  status: "done" | "error" | "aborted";
  stopReason?: string;
}

export interface StartChatTurnOptions {
  projectInfo: AgentProjectInfo;
  sessionId: string;
  content: string;
  attachments?: ChatContextRef[];
  runId?: string;
  extraSystemContext?: string;
  skipAutoTitle?: boolean;
  resolvedTargetOverride?: ResolvedChatExecutionTarget;
  /** When true, the caller already claimed the task lease in the database. */
  skipTaskAutoClaim?: boolean;
  /** When true, start a fresh CLI thread while keeping messages in the same Relaydesk session. */
  forceFreshThread?: boolean;
  initialSubscriber?: RunSubscriber;
}

export interface StartedChatTurn {
  runId: string;
  session: ChatSessionRecord;
  userMessage: ChatMessageRecord;
  assistantMessage: ChatMessageRecord;
  unsubscribe: () => void;
  completion: Promise<void>;
}

interface ActiveRun {
  id: string;
  projectId: string;
  projectInfo: AgentProjectInfo;
  sessionId: string;
  controller: AbortController;
  reason?: "user_stop" | "follow_up";
  session: ChatSessionRecord;
  userMessage: ChatMessageRecord;
  assistantMessageId: string;
  assistantCreatedAt: string;
  content: string;
  events: Map<string, ChatToolEvent>;
  reasoning: string;
  statusLine: string;
  startedAt: number;
  lastLeaseTouchAt: number;
  subscribers: Set<RunSubscriber>;
}

const MUTATING_TASK_ACTIONS = new Set([
  "comment_task",
  "update_task",
  "transition_task",
  "create_task",
  "checkpoint_release",
  "finish_release",
]);

const LEASE_TOUCH_INTERVAL_MS = 30_000;
const MAX_DELEGATION_DEPTH = 1;
const DEFAULT_DELEGATE_WAIT_SECONDS = 180;
const MAX_DELEGATE_WAIT_SECONDS = 300;
const MAX_DELEGATE_SUMMARY_CHARS = 12_000;

interface DelegatedRunEntry {
  childSessionId: string;
  parentSessionId: string;
  parentRunId: string;
  toolEventId: string;
  runtime: ChatRuntime;
  model: string;
  title: string;
  completion: Promise<void>;
}

function buildSubagentWorkerContext(title: string, sandboxMode: ChatSandboxMode): string {
  return [
    `## Delegated Subagent Worker (${title})`,
    "You are an isolated child worker spawned by a parent Relaydesk session to complete one focused sub-task.",
    `- Sandbox mode: \`${sandboxMode}\`.`,
    "- Stay strictly scoped to the assigned brief. Do not ask follow-up questions unless truly blocked.",
    "- Return a concise, factual, directly actionable summary (file paths, findings, or changes made) for the parent agent.",
  ].join("\n");
}

function mergeDelegatedEvents(
  resultEvents: ChatToolEvent[],
  runEvents: ReadonlyMap<string, ChatToolEvent>,
): ChatToolEvent[] {
  const merged = new Map<string, ChatToolEvent>();
  for (const ev of resultEvents) {
    merged.set(ev.id, ev);
  }
  for (const [id, ev] of runEvents.entries()) {
    if (ev.subagent?.delegated || id.startsWith("delegated:")) {
      merged.set(id, ev);
    }
  }
  return Array.from(merged.values());
}

export function buildTaskWorkflowSystemContext(
  project: AgentProjectInfo,
  taskNumber: number,
): string {
  const code = `RD-${taskNumber}`;
  const deliveryMode: DeliveryMode = project.delivery_mode || "direct_push";
  const targetBranch = (project.target_branch || "").trim();
  const branchPrefix = (project.branch_prefix || "").trim() || "relaydesk";
  const workBranch = `${branchPrefix}/rd-${taskNumber}`;
  const deliverySteps =
    deliveryMode === "pr_automerge"
      ? targetBranch
        ? [
            `1. Run \`git fetch origin\` and create/switch to branch \`${workBranch}\` based on \`origin/${targetBranch}\` (e.g. \`git checkout -B ${workBranch} origin/${targetBranch}\`).`,
            `2. Commit cleanly with a conventional commit message and push the branch (\`git push -u origin ${workBranch}\`).`,
            `3. Open a PR targeting \`${targetBranch}\` via \`gh pr create --base ${targetBranch} --fill\` and enable auto-merge via \`gh pr merge --auto --squash\`.`,
            `4. Call MCP \`transition_task\` with \`task: "${code}", status: "done", resolution: "shipped", delivery_ref: "<pr_url>", comment: "<concise Markdown summary>"\`.`,
          ].join("\n")
        : [
            `1. Create and switch to branch \`${workBranch}\`.`,
            `2. Commit cleanly with a conventional commit message and push the branch.`,
            `3. Open a PR via \`gh pr create --fill\` and enable auto-merge via \`gh pr merge --auto --squash\`.`,
            `4. Call MCP \`transition_task\` with \`task: "${code}", status: "done", resolution: "shipped", delivery_ref: "<pr_url>", comment: "<concise Markdown summary>"\`.`,
          ].join("\n")
      : deliveryMode === "review_only"
        ? targetBranch
          ? [
              `1. Run \`git fetch origin\` and create/switch to branch \`${workBranch}\` based on \`origin/${targetBranch}\` (e.g. \`git checkout -B ${workBranch} origin/${targetBranch}\`).`,
              `2. Commit cleanly on \`${workBranch}\` without pushing to \`${targetBranch}\` or the default branch.`,
              `3. Call MCP \`transition_task\` with \`task: "${code}", status: "review", delivery_ref: "${workBranch}", comment: "<concise Markdown summary>"\`.`,
            ].join("\n")
          : [
              `1. Create and switch to branch \`${workBranch}\`.`,
              `2. Commit cleanly on that branch without pushing to the main branch.`,
              `3. Call MCP \`transition_task\` with \`task: "${code}", status: "review", delivery_ref: "${workBranch}", comment: "<concise Markdown summary>"\`.`,
            ].join("\n")
        : targetBranch
          ? [
              `1. Ensure you are on target branch \`${targetBranch}\` (sync via \`git fetch origin\` and \`git checkout ${targetBranch}\` if needed), all relevant verification checks pass, and \`git status\` has no stray junk files.`,
              `2. Create a clean conventional commit (\`fix:\`, \`feat:\`, etc.) and push to \`${targetBranch}\` (\`git push origin ${targetBranch}\`).`,
              `3. Call MCP \`transition_task\` with \`task: "${code}", status: "done", resolution: "shipped", delivery_ref: "${targetBranch}@<shortsha>", comment: "<concise Markdown summary>"\`.`,
            ].join("\n")
          : [
              `1. Ensure all relevant verification checks pass and \`git status\` has no stray junk files.`,
              `2. Create a clean conventional commit (\`fix:\`, \`feat:\`, etc.) and run \`git push\`.`,
              `3. Call MCP \`transition_task\` with \`task: "${code}", status: "done", resolution: "shipped", delivery_ref: "<branch>@<shortsha>", comment: "<concise Markdown summary>"\`.`,
            ].join("\n");

  const deployMode = project.deploy_policy?.mode ?? "none";
  const deployBoundary =
    deployMode !== "none"
      ? [
          "",
          `### Production Deployment Policy (\`${deployMode}\`)`,
          `- **Do NOT deploy to production during this task session.** Only complete code delivery (\`${deliveryMode}\`) and call \`transition_task\`.`,
          `- Production releases are executed separately by Relaydesk's Release pipeline according to the project deploy policy.`,
          `- If this task ONLY changes documentation, tests, or non-deployed tooling/config and does not require a production deployment, pass \`needs_deploy: false\` in \`transition_task\`.`,
        ]
      : [];

  return [
    `## Autonomous Task Execution Workflow (${code})`,
    `You are assigned Relaydesk task ${code} in project "${project.name}". The task is already claimed for this session—do NOT load or run any external \`relaydesk\` CLI skill or \`relaydesk.mjs\`; use the connected \`relaydesk\` MCP server directly (\`get_task\`, \`list_tasks\`, \`update_task\`, \`comment_task\`, \`transition_task\`, plus read-only DB tools \`list_datasources\`, \`describe_datasource\`, \`query_datasource\`).`,
    "",
    "### Rules",
    `1. Verify against the real codebase first. Never fabricate code paths, configs, or test results, and never print raw database credentials or tokens.`,
    `2. Noise / spam / already fixed: call \`transition_task(task: "${code}", status: "done", resolution: "dismissed", comment: "<factual evidence>")\` and stop.`,
    `3. Duplicate of an open task: check \`list_tasks\`, call \`transition_task(task: "${code}", merge_into: "<RD-xxx>", comment: "<brief reason>")\` and stop.`,
    `4. Valid task: implement the minimal clean change, run real verification checks (typecheck, tests, build), then complete delivery below.`,
    `5. Blocked or needing human decision: call \`transition_task(task: "${code}", status: "waiting", comment: "<concise summary>")\` and in your reply clearly state (in the user's language) the exact files/logic inspected, every concrete missing input or choice, and recommended options.`,
    `6. Operator follow-ups take highest priority: read any newly provided details, answers, or constraints directly and act on them instead of repeating earlier questions; finish by updating ${code} via \`transition_task\`.`,
    "",
    `### Delivery Mode: \`${deliveryMode}\``,
    deliverySteps,
    ...deployBoundary,
  ].join("\n");
}

export class ChatRunManager {
  private readonly store: Store;
  private readonly bridgeHub: BridgeHub | null;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly delegatedRuns = new Map<string, DelegatedRunEntry>();
  private readonly finishedListeners = new Set<(info: ChatTurnFinishedInfo) => void>();

  constructor(store: Store, bridgeHub: BridgeHub | null) {
    this.store = store;
    this.bridgeHub = bridgeHub;
    this.bridgeHub?.setDelegateHandler((ctx) => this.handleDelegateRpc(ctx));
  }

  onTurnFinished(listener: (info: ChatTurnFinishedInfo) => void): () => void {
    this.finishedListeners.add(listener);
    return () => {
      this.finishedListeners.delete(listener);
    };
  }

  getActiveRunId(sessionId: string): string | undefined {
    return this.runs.get(sessionId)?.id;
  }

  isRunning(sessionId: string): boolean {
    return (
      this.runs.has(sessionId) ||
      isChatSessionRunning(sessionId) ||
      Boolean(this.bridgeHub?.isChatSessionRunning(sessionId))
    );
  }

  hasActiveRunForProject(projectId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.projectId === projectId) return true;
    }
    return false;
  }

  abort(sessionId: string, runId: string, reason: "user_stop" | "follow_up"): boolean {
    const run = this.runs.get(sessionId);
    if (!run || run.id !== runId) return false;
    run.reason ??= reason;
    run.controller.abort();
    return true;
  }

  forceAbortSession(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (run) {
      run.reason ??= "user_stop";
      run.controller.abort();
    }
    abortChatSessionRun(sessionId);
    this.bridgeHub?.abortChatSessionRun(sessionId);
  }

  subscribe(
    sessionId: string,
    subscriber: RunSubscriber,
    options: { replaySnapshot?: boolean } = {},
  ): (() => void) | null {
    const run = this.runs.get(sessionId);
    if (!run) return null;
    if (options.replaySnapshot !== false) {
      const assistantMessage: ChatMessageRecord = {
        id: run.assistantMessageId,
        session_id: run.sessionId,
        role: "assistant",
        runtime: run.session.runtime,
        content: run.content,
        events: Array.from(run.events.values()),
        attachments: [],
        status: "streaming",
        created_at: run.assistantCreatedAt,
      };
      try {
        subscriber.onEvent({
          type: "snapshot",
          run_id: run.id,
          session: { ...run.session, active_run_id: run.id },
          user_message: run.userMessage,
          assistant_message: assistantMessage,
          status_line: run.statusLine,
          reasoning: run.reasoning,
          started_at: run.startedAt,
        });
      } catch {
        return () => {};
      }
    }
    run.subscribers.add(subscriber);
    return () => {
      run.subscribers.delete(subscriber);
    };
  }

  private emit(run: ActiveRun, event: ChatStreamEvent): void {
    if (event.type === "context_usage") {
      run.session = { ...run.session, context_used_tokens: event.usage.used_tokens, context_window_tokens: event.usage.window_tokens ?? null };
    } else if (event.type === "text_delta") {
      run.content = (run.content + event.delta).slice(0, 120_000);
    } else if (event.type === "text_replace") {
      run.content = event.text.slice(0, 120_000);
    } else if (event.type === "tool") {
      if (run.events.has(event.event.id) || run.events.size < 1000) {
        run.events.set(event.event.id, event.event);
      }
    } else if (event.type === "reasoning") {
      run.reasoning = (run.reasoning + event.text).slice(0, 120_000);
    } else if (event.type === "status") {
      run.statusLine = event.message;
    } else if (event.type === "session_updated") {
      // An asynchronous title update must not roll back a newer CLI reading.
      event = { ...event, session: { ...event.session, context_used_tokens: run.session.context_used_tokens, context_window_tokens: run.session.context_window_tokens } };
      run.session = { ...event.session, active_run_id: run.id };
    }

    if (run.session.kind === "task" && run.session.task_id) {
      const now = Date.now();
      if (now - run.lastLeaseTouchAt >= LEASE_TOUCH_INTERVAL_MS) {
        run.lastLeaseTouchAt = now;
        try {
          this.store.touchTaskSessionLease(run.session.task_id, run.sessionId);
        } catch {
          // Non-fatal lease heartbeat error
        }
      }
    }

    for (const sub of Array.from(run.subscribers)) {
      try {
        sub.onEvent(event);
      } catch {
        run.subscribers.delete(sub);
      }
    }
  }

  private closeSubscribers(run: ActiveRun): void {
    for (const sub of Array.from(run.subscribers)) {
      try {
        sub.onClose?.();
      } catch {
        // Ignore close errors
      }
    }
    run.subscribers.clear();
  }

  private notifyFinished(info: ChatTurnFinishedInfo): void {
    for (const listener of this.finishedListeners) {
      try {
        listener(info);
      } catch {
        // Non-fatal listener error
      }
    }
  }

  startTurn(options: StartChatTurnOptions): StartedChatTurn {
    const {
      projectInfo,
      sessionId,
      content,
      attachments = [],
      extraSystemContext,
      skipAutoTitle,
      resolvedTargetOverride,
      skipTaskAutoClaim,
      forceFreshThread,
      initialSubscriber,
    } = options;
    const runId = options.runId ?? randomUUID();

    if (this.isRunning(sessionId)) {
      throw new ApiError(409, "当前会话正在生成回复，请等待完成或先点击停止。");
    }

    const localClis = detectLocalClis();
    const {
      session,
      priorMessages,
      userMessage,
      assistantMessage,
      provisionalTitle,
      resolvedTarget,
      taskNumber,
    } = this.store.transaction(true, () => {
      let current = this.store.getChatSession(projectInfo.id, sessionId);
      const resolved =
        resolvedTargetOverride ??
        resolveChatExecutionTarget({
          store: this.store,
          bridgeHub: this.bridgeHub,
          projectId: projectInfo.id,
          executionTarget: current.execution_target || "auto",
          runtime: current.runtime,
          localClis: { codex: localClis.codex, claude: localClis.claude },
        });

      let linkedTaskNumber: number | null = null;
      if (current.kind === "task" && current.task_id) {
        const taskRow = this.store.getTaskRow(current.task_id);
        linkedTaskNumber = taskRow.number;
        const ownLease = `session:${sessionId}`;
        const alreadyActive =
          taskRow.status === "working" &&
          taskRow.owner === "agent" &&
          taskRow.lease === ownLease;
        if (!skipTaskAutoClaim && !alreadyActive) {
          const agentLabel = resolved.agentName || (resolved.localAgentId ?? "cloud");
          this.store.claimTaskForSession(current.task_id, sessionId, agentLabel, "followup");
        }
      }

      const prior = this.store.listChatMessages(projectInfo.id, sessionId);
      const autoTitle =
        !skipAutoTitle &&
        current.kind === "chat" &&
        prior.length === 0 &&
        (!current.title || current.title === "新对话")
          ? buildFallbackSessionTitle(content)
          : undefined;
      current = this.store.updateChatSession(projectInfo.id, sessionId, {
        ...(autoTitle ? { title: autoTitle } : {}),
        // Each turn waits for its own measurement, including turns on a different fallback node.
        context_used_tokens: null, context_window_tokens: null,
        status: "running",
      });
      const userMsg = this.store.addChatMessage(sessionId, {
        role: "user",
        content,
        attachments,
        status: "done",
      });
      const assistantMsg = this.store.addChatMessage(sessionId, {
        id: createHash("sha256").update(`${sessionId}:${runId}`).digest("hex").slice(0, 32),
        role: "assistant",
        runtime: current.runtime,
        content: "",
        events: [],
        status: "streaming",
      });
      return {
        session: current,
        priorMessages: prior,
        userMessage: userMsg,
        assistantMessage: assistantMsg,
        provisionalTitle: autoTitle,
        resolvedTarget: resolved,
        taskNumber: linkedTaskNumber,
      };
    });

    const abortController = new AbortController();
    const run: ActiveRun = {
      id: runId,
      projectId: projectInfo.id,
      projectInfo,
      sessionId,
      controller: abortController,
      session,
      userMessage,
      assistantMessageId: assistantMessage.id,
      assistantCreatedAt: assistantMessage.created_at,
      content: "",
      events: new Map(),
      reasoning: "",
      statusLine: "",
      startedAt: Date.now(),
      lastLeaseTouchAt: Date.now(),
      subscribers: new Set(),
    };

    if (initialSubscriber) {
      run.subscribers.add(initialSubscriber);
    }
    this.runs.set(sessionId, run);

    this.emit(run, {
      type: "session",
      session: { ...session, active_run_id: runId },
      user_message: userMessage,
      assistant_message_id: assistantMessage.id,
    });

    const completion = this.executeRun(run, {
      projectInfo,
      priorMessages,
      content,
      attachments,
      provisionalTitle,
      resolvedTarget,
      extraSystemContext:
        extraSystemContext ??
        (session.kind === "task" && taskNumber !== null
          ? buildTaskWorkflowSystemContext(projectInfo, taskNumber)
          : undefined),
      forceFreshThread,
    });

    return {
      runId,
      session: { ...session, active_run_id: runId },
      userMessage,
      assistantMessage,
      unsubscribe: () => {
        if (initialSubscriber) {
          run.subscribers.delete(initialSubscriber);
        }
      },
      completion,
    };
  }

  private async executeRun(
    run: ActiveRun,
    params: {
      projectInfo: AgentProjectInfo;
      priorMessages: ChatMessageRecord[];
      content: string;
      attachments: ChatContextRef[];
      provisionalTitle?: string;
      resolvedTarget: ResolvedChatExecutionTarget;
      extraSystemContext?: string;
      forceFreshThread?: boolean;
    },
  ): Promise<void> {
    const {
      projectInfo,
      priorMessages,
      content,
      attachments,
      provisionalTitle,
      resolvedTarget,
      extraSystemContext,
      forceFreshThread,
    } = params;
    const { session, sessionId } = run;
    const { targetKey, localAgentId, localBinding } = resolvedTarget;

    const titlePromise = provisionalTitle
      ? generateSessionTitle(this.store.dbPath, {
          projectId: projectInfo.id,
          userMessage: content,
        })
          .then((aiTitle) => {
            if (!aiTitle || aiTitle === provisionalTitle) return;
            const updated = this.store.transaction(true, () => {
              try {
                const latest = this.store.getChatSession(projectInfo.id, sessionId);
                if (latest.title !== provisionalTitle) return null;
                return this.store.updateChatSession(projectInfo.id, sessionId, {
                  title: aiTitle,
                });
              } catch {
                return null;
              }
            });
            if (updated) {
              this.emit(run, { type: "session_updated", session: updated });
            }
          })
          .catch(() => {
            // Non-fatal: keep provisional fallback title
          })
      : Promise.resolve();

    const canResumePrior = !forceFreshThread && canResumeExternalSession(session, targetKey);
    const last = priorMessages.at(-1);
    const prompt =
      canResumePrior &&
      last?.role === "assistant" &&
      (last.status === "aborted" || last.status === "error")
        ? `## Interrupted turn\n${formatChatHistory(priorMessages.slice(-2))}\n\n## User Message\n${content}`
        : content;

    if (resolvedTarget.fallbackFrom) {
      const destLabel = localAgentId
        ? `本机「${resolvedTarget.agentName || localAgentId}」`
        : "云端执行器";
      this.emit(run, {
        type: "status",
        message: `${resolvedTarget.fallbackReason || `${resolvedTarget.fallbackFrom}不可用`}，已自动降级到${destLabel}执行`,
      });
    } else if (localAgentId) {
      this.emit(run, {
        type: "status",
        message: `正在由本机节点「${resolvedTarget.agentName || localAgentId}」执行…`,
      });
    }

    const resolveTask = (taskId: string) => {
      try {
        const row = this.store.getTaskRow(taskId);
        if (row.project_id !== projectInfo.id) return null;
        return {
          task: toTaskView(row),
          messages: this.store.getTaskMessages(row.id),
          merged: this.store.getMergedTasks(row.id),
        };
      } catch {
        return null;
      }
    };

    let terminalStatus: "done" | "error" | "aborted" = "error";
    let terminalStopReason: string | undefined;

    try {
      let result;
      if (localAgentId) {
        const workspaceManifest = buildWorkspaceManifest(this.store.dbPath, projectInfo.id);
        const datasourceRuntime = getWorkspaceDatasourceRuntimeEnv(
          this.store.dbPath,
          projectInfo.id,
        );
        const workspaceFilePaths = new Set(workspaceManifest.files.map((file) => file.path));
        const bridgeAttachments = attachments.filter(
          (att) => (att.kind !== "file" && att.kind !== "image") || workspaceFilePaths.has(att.ref),
        );
        const bridgeImagePaths = bridgeAttachments
          .filter((att) => att.kind === "image")
          .map((att) => att.ref);
        const attachmentContext = buildAttachmentContext(
          this.store.dbPath,
          projectInfo,
          bridgeAttachments,
          workspaceManifest.databases,
          resolveTask,
          { spaceDirVar: "$RELAYDESK_SPACE_DIR" },
        );
        const isSubagent =
          session.session_role === "subagent" ||
          Boolean(session.parent_session_id) ||
          (session.delegation_depth ?? 0) > 0;
        const contextBlocks: string[] = [];
        if (
          !isSubagent &&
          ((session.kind !== "task" && session.kind !== "release") || !extraSystemContext?.trim())
        ) {
          contextBlocks.push(RELAYDESK_MCP_INSTRUCTIONS);
        }
        if (extraSystemContext?.trim()) {
          contextBlocks.push(extraSystemContext.trim());
        }
        if (projectInfo.agent_instructions.trim()) {
          contextBlocks.push(
            `## Project Instructions\n${projectInfo.agent_instructions.trim().slice(0, isSubagent ? 1500 : 4000)}`,
          );
        }
        if (!isSubagent && workspaceManifest.databases.length > 0) {
          const dbLines = workspaceManifest.databases.map((db) => {
            if (db.source === "workspace_file") {
              return `- [SQLite] ${db.name}: path=$RELAYDESK_SPACE_DIR/files/${db.file_path} (${db.table_count ?? 0} tables; queryable via relaydesk MCP tools)`;
            }
            const envPart =
              localBinding?.allow_datasource_secrets && db.has_connection_url && db.env_var
                ? `env=$${db.env_var} (queryable via relaydesk MCP tools)`
                : "credentials not exported to this device";
            const accessPart = db.read_only ? "STRICT READ-ONLY" : "read-write";
            const notePart = db.notes ? `\n  Notes: ${db.notes.slice(0, 1000)}` : "";
            return `- [${db.kind.toUpperCase()}] ${db.name}: ${envPart}, endpoint=${db.host_preview || "external"}, access=${accessPart}${notePart}`;
          });
          contextBlocks.push(`## Project Databases\n${dbLines.join("\n")}`);
        }
        if (priorMessages.length) {
          contextBlocks.push(`## Previous Conversation Summary\n${formatChatHistory(priorMessages)}`);
        }
        if (!canResumePrior && attachmentContext) {
          contextBlocks.push(`## Explicitly Attached Context\n${attachmentContext}`);
        }
        const priorSubagents = canResumePrior ? collectPriorSubagents(priorMessages) : [];
        result = await this.bridgeHub!.runChatTurn(
          localAgentId,
          {
            run_id: run.id,
            session_id: sessionId,
            project_id: projectInfo.id,
            runtime: session.runtime,
            model: session.model,
            reasoning_effort: session.reasoning_effort,
            fast_mode: session.fast_mode,
            sandbox_mode: session.sandbox_mode,
            network_access: session.network_access,
            resume_session_id: canResumePrior ? session.external_session_id : "",
            prompt: canResumePrior ? buildResumePrompt(prompt, attachmentContext) : prompt,
            system_context: contextBlocks.join("\n\n"),
            workspace_manifest: workspaceManifest,
            ...(isSubagent ? { is_subagent: true } : {}),
            ...(priorSubagents.length ? { prior_subagents: priorSubagents } : {}),
            ...(bridgeImagePaths.length ? { image_paths: bridgeImagePaths } : {}),
            ...(localBinding?.allow_datasource_secrets
              ? {
                  datasource_env: datasourceRuntime.env,
                  pg_read_only_enforced: datasourceRuntime.pgReadOnlyEnforced,
                }
              : {}),
          },
          (ev) => this.emit(run, ev),
          run.controller.signal,
          datasourceRuntime.secrets,
        );
      } else {
        const isSubagent =
          session.session_role === "subagent" ||
          Boolean(session.parent_session_id) ||
          (session.delegation_depth ?? 0) > 0;
        const cloudPrompt =
          extraSystemContext?.trim() && !canResumePrior
            ? `${extraSystemContext.trim()}\n\n${prompt}`
            : prompt;
        result = await runWebCliChatTurn({
          dbPath: this.store.dbPath,
          project: projectInfo,
          session: canResumePrior ? session : { ...session, external_session_id: "" },
          prompt: cloudPrompt,
          attachments,
          priorMessages,
          signal: run.controller.signal,
          resolveTask,
          taskClient: {
            call: async (action, opParams) => {
              const { result: opResult, mutated } = this.store.transaction(
                MUTATING_TASK_ACTIONS.has(action),
                () => this.store.chatAgentTaskOp(projectInfo.id, action, opParams, { sessionId }),
              );
              if (mutated) {
                this.emit(run, {
                  type: "task_updated",
                  task_id: mutated.task_id,
                  action: mutated.action,
                });
              }
              return opResult;
            },
          },
          delegateClient: isSubagent
            ? undefined
            : {
                call: (action, opParams) =>
                  this.handleDelegateRpc({
                    projectId: projectInfo.id,
                    sessionId,
                    runId: run.id,
                    action,
                    params: opParams,
                  }),
              },
          onEvent: (ev) => this.emit(run, ev),
        });
      }

      if (provisionalTitle) {
        await Promise.race([
          titlePromise,
          new Promise((resolve) => setTimeout(resolve, 600)),
        ]);
      }

      const stopReason = result.stopReason ?? (result.status === "aborted" ? run.reason : undefined);
      terminalStatus = result.status;
      terminalStopReason = stopReason;

      const finalEvents = finalizeTurnSubagents(
        mergeDelegatedEvents(result.events, run.events),
        result.status,
      );
      const saved = this.store.transaction(true, () => {
        const updatedMsg = this.store.updateChatMessage(run.assistantMessageId, {
          content: result.status === "error" ? result.content || run.content : result.content,
          error_reason: result.status === "error" ? result.error : undefined,
          events: finalEvents,
          status: result.status,
          stop_reason: stopReason,
        });
        const current = this.store.getChatSession(projectInfo.id, sessionId);
        const canResume =
          current.runtime === session.runtime &&
          current.sandbox_mode === session.sandbox_mode &&
          current.network_access === session.network_access &&
          current.execution_target === session.execution_target;
        const nextExternalId = canResume ? result.externalSessionId : "";
        const updatedSession = this.store.updateChatSession(projectInfo.id, sessionId, {
          external_session_id: nextExternalId,
          context_used_tokens: canResume && current.model === session.model ? run.session.context_used_tokens : null,
          context_window_tokens: canResume && current.model === session.model ? run.session.context_window_tokens : null,
          resolved_target: targetKey,
          status: result.status === "error" ? "error" : "idle",
        });

        let taskFinalized = false;
        let releaseFinalized = false;
        if (updatedSession.kind === "task" && updatedSession.task_id) {
          const moved = this.store.finalizeTaskSessionTurn(updatedSession.task_id, sessionId, {
            status: result.status,
            stopReason,
            error: result.error,
            replyContent: result.content,
          });
          taskFinalized = Boolean(moved);
        } else if (updatedSession.kind === "release" && updatedSession.release_id) {
          const moved = this.store.finalizeReleaseSessionTurn(updatedSession.release_id, sessionId, {
            status: result.status,
            stopReason,
            error: result.error,
            replyContent: result.content,
          });
          releaseFinalized = Boolean(moved);
        }
        return { updatedMsg, updatedSession, taskFinalized, releaseFinalized };
      });

      if (saved.taskFinalized && saved.updatedSession.task_id) {
        this.emit(run, {
          type: "task_updated",
          task_id: saved.updatedSession.task_id,
          action: "finalize_task",
        });
      }
      if (saved.releaseFinalized && saved.updatedSession.release_id) {
        this.emit(run, {
          type: "task_updated",
          action: "finalize_release",
        });
      }

      if (result.status === "error" && result.error) {
        this.emit(run, { type: "error", error: result.error, message: saved.updatedMsg });
      } else {
        this.emit(run, {
          type: "done",
          message: saved.updatedMsg,
          session: saved.updatedSession,
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        this.emit(run, { type: "error", error: "对话已删除或不可用" });
        return;
      }
      const errMsg = err instanceof Error ? err.message : "对话执行异常";
      terminalStatus = "error";
      const { savedMsg, taskFinalized, releaseFinalized } = this.store.transaction(true, () => {
        const msg = this.store.updateChatMessage(run.assistantMessageId, {
          content: run.content,
          events: finalizeTurnSubagents(Array.from(run.events.values()), "error"),
          error_reason: errMsg,
          status: "error",
        });
        const updatedSession = this.store.updateChatSession(projectInfo.id, sessionId, {
          context_used_tokens: run.session.context_used_tokens, context_window_tokens: run.session.context_window_tokens,
          status: "error",
        });
        let finalized = false;
        let relFinalized = false;
        if (updatedSession.kind === "task" && updatedSession.task_id) {
          const moved = this.store.finalizeTaskSessionTurn(updatedSession.task_id, sessionId, {
            status: "error",
            error: errMsg,
          });
          finalized = Boolean(moved);
        } else if (updatedSession.kind === "release" && updatedSession.release_id) {
          const moved = this.store.finalizeReleaseSessionTurn(updatedSession.release_id, sessionId, {
            status: "error",
            error: errMsg,
          });
          relFinalized = Boolean(moved);
        }
        return { savedMsg: msg, taskFinalized: finalized, releaseFinalized: relFinalized };
      });
      if (taskFinalized && session.task_id) {
        this.emit(run, {
          type: "task_updated",
          task_id: session.task_id,
          action: "finalize_task",
        });
      }
      if (releaseFinalized && session.release_id) {
        this.emit(run, {
          type: "task_updated",
          action: "finalize_release",
        });
      }
      this.emit(run, { type: "error", error: errMsg, message: savedMsg });
    } finally {
      this.runs.delete(sessionId);
      this.closeSubscribers(run);
      this.notifyFinished({
        projectId: projectInfo.id,
        sessionId,
        sessionKind: session.kind,
        taskId: session.task_id,
        releaseId: session.release_id,
        status: terminalStatus,
        stopReason: terminalStopReason,
      });
    }
  }

  private buildDelegatedStatusPayload(
    projectId: string,
    childSession: ChatSessionRecord,
    timedOut = false,
  ): Record<string, unknown> {
    const activeChild = this.runs.get(childSession.id);
    const messages = this.store.listChatMessages(projectId, childSession.id);
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const running = Boolean(activeChild) || this.isRunning(childSession.id);
    const status = running
      ? "running"
      : lastAssistant?.status === "aborted"
        ? "aborted"
        : lastAssistant?.status === "error" || childSession.status === "error"
          ? "error"
          : "done";
    const activity = activeChild?.statusLine || "";
    const content = activeChild?.content || lastAssistant?.content || "";
    const summary = content.trim().slice(0, MAX_DELEGATE_SUMMARY_CHARS);
    return {
      session_id: childSession.id,
      title: childSession.title,
      runtime: childSession.runtime,
      model: childSession.model || undefined,
      sandbox_mode: childSession.sandbox_mode,
      status,
      ...(timedOut ? { timed_out: true } : {}),
      ...(activity ? { activity } : {}),
      ...(summary ? { summary } : {}),
      ...(lastAssistant?.error_reason ? { error: lastAssistant.error_reason } : {}),
    };
  }

  private emitDelegatedToolUpdate(
    parentSessionId: string,
    parentRunId: string,
    event: ChatToolEvent,
  ): void {
    const parentRun = this.runs.get(parentSessionId);
    if (parentRun && parentRun.id === parentRunId) {
      this.emit(parentRun, { type: "tool", event });
    }
  }

  async handleDelegateRpc(ctx: {
    projectId: string;
    sessionId: string;
    runId: string;
    action: RelaydeskDelegateAction;
    params: Record<string, unknown>;
  }): Promise<unknown> {
    const { projectId, sessionId, runId, action, params } = ctx;
    const parentRun = this.runs.get(sessionId);
    if (!parentRun || parentRun.id !== runId || parentRun.projectId !== projectId) {
      throw new ApiError(403, "父会话当前不在运行中，无法执行委派操作");
    }
    const parentSession = this.store.getChatSession(projectId, sessionId);
    if (
      parentSession.session_role === "subagent" ||
      Boolean(parentSession.parent_session_id) ||
      (parentSession.delegation_depth ?? 0) >= MAX_DELEGATION_DEPTH
    ) {
      throw new ApiError(403, "子代理会话不允许继续嵌套委派子代理");
    }

    if (action === "delegate_task") {
      const rawRuntime = typeof params.runtime === "string" ? params.runtime.trim().toLowerCase() : "";
      if (rawRuntime !== "claude" && rawRuntime !== "codex" && rawRuntime !== "agy") {
        throw new ApiError(400, "runtime 必须是 claude、codex 或 agy");
      }
      const runtime: ChatRuntime = rawRuntime;
      const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
      if (!prompt) {
        throw new ApiError(400, "prompt 不能为空");
      }
      if (prompt.length > 40_000) {
        throw new ApiError(400, "prompt 长度超出上限（40000 字符）");
      }
      const rawTitle = typeof params.title === "string" ? params.title.trim().slice(0, 80) : "";
      const title = rawTitle || buildFallbackSessionTitle(prompt) || `${runtime} 子代理`;
      const model = typeof params.model === "string" ? params.model.trim().slice(0, 160) : "";
      const rawEffort = typeof params.reasoning_effort === "string" ? params.reasoning_effort.trim() : "default";
      const reasoningEffort: ChatReasoningEffort =
        rawEffort === "off" ||
        rawEffort === "low" ||
        rawEffort === "medium" ||
        rawEffort === "high" ||
        rawEffort === "max"
          ? rawEffort
          : "default";
      const requestedSandbox: ChatSandboxMode =
        params.sandbox_mode === "read-only"
          ? "read-only"
          : params.sandbox_mode === "workspace-write"
            ? "workspace-write"
            : parentSession.sandbox_mode;
      // Child sandbox can never exceed parent sandbox privilege.
      const sandboxMode: ChatSandboxMode =
        parentSession.sandbox_mode === "read-only" ? "read-only" : requestedSandbox;
      const mode = params.mode === "async" ? "async" : "wait";
      const timeoutSec = Math.max(
        10,
        Math.min(
          MAX_DELEGATE_WAIT_SECONDS,
          Math.floor(Number(params.timeout_seconds) || DEFAULT_DELEGATE_WAIT_SECONDS),
        ),
      );

      const childSession = this.store.createChatSession(projectId, {
        kind: "chat",
        parent_session_id: parentSession.id,
        delegation_depth: (parentSession.delegation_depth ?? 0) + 1,
        session_role: "subagent",
        title,
        runtime,
        model,
        reasoning_effort: reasoningEffort,
        execution_target: parentSession.execution_target || "auto",
        sandbox_mode: sandboxMode,
        network_access: parentSession.network_access,
      });

      const toolEventId = `delegated:${childSession.id}`;
      let latestActivity = `已启动 ${runtime}${model ? ` (${model})` : ""} 子代理…`;

      const buildMirroredEvent = (
        subStatus: NonNullable<ChatToolEvent["subagent"]>["status"],
        activity?: string,
        output?: string,
      ): ChatToolEvent => ({
        id: toolEventId,
        tool: `delegate:${runtime}`,
        summary: title,
        status: subStatus === "done" ? "done" : subStatus === "error" || subStatus === "interrupted" ? "error" : "running",
        ...(output ? { output: output.slice(0, 8000) } : {}),
        subagent: {
          status: subStatus,
          ...(activity ? { activity: activity.slice(0, 500) } : {}),
          session_id: childSession.id,
          runtime,
          ...(model ? { model } : {}),
          delegated: true,
        },
      });

      this.emitDelegatedToolUpdate(
        parentSession.id,
        runId,
        buildMirroredEvent("running", latestActivity),
      );

      let started: StartedChatTurn;
      try {
        started = this.startTurn({
          projectInfo: parentRun.projectInfo,
          sessionId: childSession.id,
          content: prompt,
          skipAutoTitle: true,
          extraSystemContext: buildSubagentWorkerContext(title, sandboxMode),
          initialSubscriber: {
            onEvent: (ev) => {
              if (ev.type === "tool") {
                const summary = ev.event.summary || ev.event.tool;
                if (summary) {
                  latestActivity = summary;
                  this.emitDelegatedToolUpdate(
                    parentSession.id,
                    runId,
                    buildMirroredEvent("running", latestActivity),
                  );
                }
              } else if (ev.type === "status" && ev.message) {
                latestActivity = ev.message;
                this.emitDelegatedToolUpdate(
                  parentSession.id,
                  runId,
                  buildMirroredEvent("running", latestActivity),
                );
              } else if (ev.type === "done") {
                const finalStatus =
                  ev.message.status === "aborted"
                    ? "interrupted"
                    : ev.message.status === "error"
                      ? "error"
                      : "done";
                this.emitDelegatedToolUpdate(
                  parentSession.id,
                  runId,
                  buildMirroredEvent(
                    finalStatus,
                    finalStatus === "done" ? "已完成" : ev.message.error_reason || "执行结束",
                    ev.message.content || ev.message.error_reason,
                  ),
                );
              } else if (ev.type === "error") {
                this.emitDelegatedToolUpdate(
                  parentSession.id,
                  runId,
                  buildMirroredEvent("error", ev.error || "执行失败", ev.error),
                );
              }
            },
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "无法启动子代理";
        this.emitDelegatedToolUpdate(parentSession.id, runId, buildMirroredEvent("error", msg, msg));
        throw err;
      }

      const entry: DelegatedRunEntry = {
        childSessionId: childSession.id,
        parentSessionId: parentSession.id,
        parentRunId: runId,
        toolEventId,
        runtime,
        model: childSession.model,
        title,
        completion: started.completion,
      };
      this.delegatedRuns.set(childSession.id, entry);
      void started.completion.finally(() => {
        if (this.delegatedRuns.get(childSession.id) === entry) {
          this.delegatedRuns.delete(childSession.id);
        }
      });

      if (mode === "async") {
        return {
          session_id: childSession.id,
          title,
          runtime,
          model: childSession.model || undefined,
          sandbox_mode: sandboxMode,
          mode: "async",
          status: "running",
        };
      }

      let timedOut = false;
      await Promise.race([
        started.completion,
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutSec * 1000);
          timer.unref?.();
        }),
      ]);

      const latestChild = this.store.getChatSession(projectId, childSession.id);
      return this.buildDelegatedStatusPayload(projectId, latestChild, timedOut);
    }

    const childSessionId = typeof params.session_id === "string" ? params.session_id.trim() : "";
    if (!childSessionId) {
      throw new ApiError(400, "缺少 session_id");
    }
    const childSession = this.store.getChatSession(projectId, childSessionId);
    if (childSession.parent_session_id !== parentSession.id) {
      throw new ApiError(403, "只能查询或操作当前父会话委派的子代理");
    }

    if (action === "check_delegated_task") {
      return this.buildDelegatedStatusPayload(projectId, childSession);
    }

    if (action === "wait_delegated_task") {
      const timeoutSec = Math.max(
        5,
        Math.min(
          MAX_DELEGATE_WAIT_SECONDS,
          Math.floor(Number(params.timeout_seconds) || DEFAULT_DELEGATE_WAIT_SECONDS),
        ),
      );
      const entry = this.delegatedRuns.get(childSession.id);
      let timedOut = false;
      if (entry) {
        await Promise.race([
          entry.completion,
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              timedOut = true;
              resolve();
            }, timeoutSec * 1000);
            timer.unref?.();
          }),
        ]);
      }
      const latestChild = this.store.getChatSession(projectId, childSession.id);
      return this.buildDelegatedStatusPayload(projectId, latestChild, timedOut);
    }

    if (action === "cancel_delegated_task") {
      this.forceAbortSession(childSession.id);
      return {
        session_id: childSession.id,
        status: "aborted",
      };
    }

    throw new ApiError(400, `不支持的委派操作: ${action}`);
  }
}
