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
  ChatSessionRecord,
  ChatStreamEvent,
  ChatToolEvent,
  DeliveryMode,
} from "../app/lib/types.ts";

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
  "finish_release",
]);

const LEASE_TOUCH_INTERVAL_MS = 30_000;

export function buildTaskWorkflowSystemContext(
  project: AgentProjectInfo,
  taskNumber: number,
): string {
  const code = `RD-${taskNumber}`;
  const deliveryMode: DeliveryMode = project.delivery_mode || "direct_push";
  const deliverySteps =
    deliveryMode === "pr_automerge"
      ? [
          `1. Create and switch to branch \`relaydesk/rd-${taskNumber}\`.`,
          `2. Commit cleanly with a conventional commit message and push the branch.`,
          `3. Open a PR via \`gh pr create --fill\` and enable auto-merge via \`gh pr merge --auto --squash\`.`,
          `4. Call MCP \`transition_task\` with \`task: "${code}", status: "done", resolution: "shipped", delivery_ref: "<pr_url>", comment: "<concise Markdown summary>"\`.`,
        ].join("\n")
      : deliveryMode === "review_only"
        ? [
            `1. Create and switch to branch \`relaydesk/rd-${taskNumber}\`.`,
            `2. Commit cleanly on that branch without pushing to the main branch.`,
            `3. Call MCP \`transition_task\` with \`task: "${code}", status: "review", delivery_ref: "relaydesk/rd-${taskNumber}", comment: "<concise Markdown summary>"\`.`,
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
  private readonly finishedListeners = new Set<(info: ChatTurnFinishedInfo) => void>();

  constructor(store: Store, bridgeHub: BridgeHub | null) {
    this.store = store;
    this.bridgeHub = bridgeHub;
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
    if (event.type === "text_delta") {
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

    const canResumePrior = canResumeExternalSession(session, targetKey);
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
        const contextBlocks: string[] = [];
        if ((session.kind !== "task" && session.kind !== "release") || !extraSystemContext?.trim()) {
          contextBlocks.push(RELAYDESK_MCP_INSTRUCTIONS);
        }
        if (extraSystemContext?.trim()) {
          contextBlocks.push(extraSystemContext.trim());
        }
        if (projectInfo.agent_instructions.trim()) {
          contextBlocks.push(
            `## Project Instructions\n${projectInfo.agent_instructions.trim().slice(0, 4000)}`,
          );
        }
        if (workspaceManifest.databases.length > 0) {
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
        result = await this.bridgeHub!.runChatTurn(
          localAgentId,
          {
            session_id: sessionId,
            project_id: projectInfo.id,
            runtime: session.runtime,
            model: session.model,
            reasoning_effort: session.reasoning_effort,
            sandbox_mode: session.sandbox_mode,
            network_access: session.network_access,
            resume_session_id: canResumePrior ? session.external_session_id : "",
            prompt: canResumePrior ? buildResumePrompt(prompt, attachmentContext) : prompt,
            system_context: contextBlocks.join("\n\n"),
            workspace_manifest: workspaceManifest,
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

      const saved = this.store.transaction(true, () => {
        const updatedMsg = this.store.updateChatMessage(run.assistantMessageId, {
          content:
            result.status === "error" && !result.content && result.error
              ? `执行失败：${result.error}`
              : result.content,
          events: result.events,
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
          content: `执行异常：${errMsg}`,
          status: "error",
        });
        const updatedSession = this.store.updateChatSession(projectInfo.id, sessionId, {
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
}
