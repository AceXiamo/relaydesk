import { ContextUsageLabel } from "./agent-chat/ContextUsageLabel.tsx";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "~/lib/api.ts";
import { chatMessageContent, STOP_LABELS } from "~/lib/chat-content.ts";
import { messagesWithTurn, type ProjectChatStreams } from "~/lib/chat-streams.ts";
import { formatRelativeTime } from "~/lib/format.ts";
import { effortLabels, resolveLocalTaskAgent } from "~/lib/model-catalog.ts";
import { aggregateSessionSubagents } from "~/lib/subagents.ts";
import type {
  ChatContextRef,
  ChatReasoningEffort,
  ChatRuntime,
  ChatSessionRecord,
  ProjectExecutionRoutingResponse,
  TaskRecord,
} from "~/lib/types.ts";
import { ChatFailureNotice, SubagentDetailPanel, SubagentDock, ThinkingTrace, ToolChipsGroup } from "./agent-chat/AgentPrimitives.tsx";
import { RichPromptEditor, type RichPromptEditorHandle } from "./agent-chat/RichPromptEditor.tsx";
import { Icon } from "./Icon.tsx";
import {
  adaptSelectionForRuntimeSwitch,
  LocalAgentEffortSelect,
  LocalAgentModelCombobox,
  LocalAgentTargetSelect,
  runtimeLabel,
} from "./LocalAgentModelPicker.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { Button, LivePulseDot, useToast } from "./ui.tsx";

type SessionHistory = Awaited<ReturnType<typeof api.getTaskAgentSession>>;

export interface TaskDispatchDraftConfig {
  execution_target: string;
  runtime: ChatRuntime | null;
  model: string | null;
  reasoning_effort: ChatReasoningEffort | null;
}

interface Props {
  task: TaskRecord;
  streams: ProjectChatStreams;
  routing?: ProjectExecutionRoutingResponse;
  paused?: boolean;
  initialDraftConfig?: TaskDispatchDraftConfig;
  onTaskUpdated?: () => void;
}

export function TaskAgentSessionPanel(props: Props) {
  return <SessionPanel key={props.task.id} {...props} />;
}

function SessionPanel({ task, streams, routing, paused, initialDraftConfig, onTaskUpdated }: Props) {
  const toast = useToast();
  const [data, setData] = useState<SessionHistory>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [dispatching, setDispatching] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatContextRef[]>([]);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [dragOverImage, setDragOverImage] = useState(false);
  const [draftTarget, setDraftTarget] = useState<string>(initialDraftConfig?.execution_target ?? "auto");
  const [draftRuntime, setDraftRuntime] = useState<ChatRuntime | null>(initialDraftConfig?.runtime ?? null);
  const [draftModel, setDraftModel] = useState<string | null>(initialDraftConfig?.model ?? null);
  const [draftEffort, setDraftEffort] = useState<ChatReasoningEffort | null>(initialDraftConfig?.reasoning_effort ?? null);

  const sequence = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  const composerRef = useRef<RichPromptEditorHandle | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const followBottom = useRef(true);
  const sessionId = (data ? data.session?.id : task.agent_session_id) ?? "";
  const readTurn = useCallback(() => streams.snapshot().get(sessionId), [streams, sessionId]);
  const turn = useSyncExternalStore(streams.subscribe, readTurn, readTurn);
  const session = turn?.session ?? data?.session;
  const running = turn?.running ?? session?.status === "running";
  const blocked = Boolean(turn?.submitting || turn?.pending || turn?.stopping || (running && !turn));

  const agents = routing?.agents ?? [];
  const effectivePriority = routing?.effective_priority;
  const projectDefaultRuntime: ChatRuntime =
    routing?.routing.task_runtime ?? routing?.default_runtime ?? "codex";

  const activeTarget = session ? (session.execution_target || "auto") : draftTarget;
  const activeRuntime: ChatRuntime = session
    ? session.runtime
    : (draftRuntime ?? projectDefaultRuntime);
  const activeModel = session
    ? session.model
    : (draftModel ?? (activeRuntime === projectDefaultRuntime ? (routing?.routing.task_model ?? "") : ""));
  const activeEffort: ChatReasoningEffort = session
    ? (session.reasoning_effort ?? "default")
    : (draftEffort ?? routing?.routing.task_reasoning_effort ?? "default");

  const resolvedAgent = useMemo(
    () =>
      resolveLocalTaskAgent({
        agents,
        effectivePriority,
        projectId: task.project_id,
        executionTarget: activeTarget,
        runtime: activeRuntime,
      }),
    [agents, effectivePriority, task.project_id, activeTarget, activeRuntime],
  );

  const offlineTarget = activeTarget.startsWith("local:") && routing && !resolvedAgent.agent?.online;
  const runtimeAvailability = useMemo(() => {
    const check = (rt: ChatRuntime) =>
      resolveLocalTaskAgent({
        agents,
        effectivePriority,
        projectId: task.project_id,
        executionTarget: activeTarget,
        runtime: rt,
      }).ready;
    return { codex: check("codex"), claude: check("claude"), agy: check("agy") };
  }, [agents, effectivePriority, task.project_id, activeTarget]);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const history = await api.getTaskAgentSession(task.id);
      if (sequence.current !== request) return;
      setData(history);
      setError("");
      if (history.session) {
        const cached = streams.snapshot().get(history.session.id);
        const tail = history.messages.at(-1);
        if (cached && !cached.running && !cached.pending && history.session.status !== "running" &&
            (!cached.saved || (tail?.id !== cached.assistant.id && history.messages.some(m => m.id === cached.assistant.id)))) {
          streams.retire(history.session.id, cached);
        } else if (history.session.status !== "running") {
          streams.syncSession(history.session);
        }
        streams.observe(history.session, history.messages);
      }
    } catch (err) {
      if (sequence.current === request) setError(err instanceof Error ? err.message : "读取执行会话失败");
    } finally {
      if (sequence.current === request) setLoading(false);
    }
  }, [task.id, streams]);

  useEffect(() => {
    void load();
    return () => { sequence.current++; };
  }, [load, task.agent_session_id, task.agent_session_status]);

  useEffect(() => {
    if (onTaskUpdated) return streams.subscribeTaskActivity(task.id, onTaskUpdated);
  }, [streams, task.id, onTaskUpdated]);

  useEffect(() => {
    if (!turn?.running && turn?.pending) {
      const unsent = streams.takeUnsent(sessionId);
      if (unsent) {
        setDraft(current => [current, unsent.content].filter(Boolean).join("\n"));
        if (unsent.attachments?.length) {
          setAttachments(current => {
            const seen = new Set(current.map(a => `${a.kind}:${a.ref}`));
            const merged = [...current];
            for (const item of unsent.attachments) {
              const key = `${item.kind}:${item.ref}`;
              if (!seen.has(key)) {
                seen.add(key);
                merged.push(item);
              }
            }
            return merged.slice(0, 8);
          });
        }
      }
    }
  }, [streams, sessionId, turn]);

  useEffect(() => {
    const el = transcript.current;
    if (el && followBottom.current) el.scrollTop = el.scrollHeight;
  }, [data, turn]);

  const updateSessionConfig = async (
    patch: Partial<Pick<ChatSessionRecord, "execution_target" | "runtime" | "model" | "reasoning_effort">>,
  ) => {
    if (!session || running || savingConfig) return;
    setSavingConfig(true);
    try {
      const res = await api.updateCodexChatSession(task.project_id, session.id, patch);
      streams.syncSession(res.session);
      setData(previous => previous ? { ...previous, session: res.session } : { session: res.session, messages: [] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新执行配置失败");
    } finally {
      setSavingConfig(false);
    }
  };

  const handleSelectTarget = (nextTarget: string) => {
    if (session) {
      void updateSessionConfig({ execution_target: nextTarget });
    } else {
      setDraftTarget(nextTarget);
    }
  };

  const handleSelectRuntime = (nextRuntime: ChatRuntime) => {
    if (nextRuntime === activeRuntime) return;
    const nextAgent = resolveLocalTaskAgent({
      agents,
      effectivePriority,
      projectId: task.project_id,
      executionTarget: activeTarget,
      runtime: nextRuntime,
    }).agent;
    const adapted = adaptSelectionForRuntimeSwitch({
      nextRuntime,
      agent: nextAgent,
      currentModel: activeModel,
      currentEffort: activeEffort,
    });
    if (session) {
      void updateSessionConfig({
        runtime: nextRuntime,
        model: adapted.model,
        reasoning_effort: adapted.effort,
      });
    } else {
      setDraftRuntime(nextRuntime);
      setDraftModel(adapted.model);
      setDraftEffort(adapted.effort);
    }
  };

  const handleSelectModel = (nextModel: string, nextEffort: ChatReasoningEffort) => {
    if (session) {
      void updateSessionConfig({
        model: nextModel,
        ...(nextEffort !== activeEffort ? { reasoning_effort: nextEffort } : {}),
      });
    } else {
      setDraftModel(nextModel);
      setDraftEffort(nextEffort);
    }
  };

  const handleSelectEffort = (nextEffort: ChatReasoningEffort) => {
    if (session) {
      void updateSessionConfig({ reasoning_effort: nextEffort });
    } else {
      setDraftEffort(nextEffort);
    }
  };

  const dispatch = async () => {
    setDispatching(true);
    try {
      const result = await api.dispatchTaskToAgent(task.id, {
        execution_target: activeTarget,
        runtime: activeRuntime,
        model: activeModel,
        reasoning_effort: activeEffort,
      });
      streams.observe(result.session, []);
      setData(previous => ({ session: result.session, messages: previous?.messages ?? [] }));
      onTaskUpdated?.();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "分配任务失败");
    } finally { setDispatching(false); }
  };

  const handleUploadImages = async (files: File[]) => {
    if (uploadingImages || files.length === 0) return;
    const MIME_EXT: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif",
    };
    const remainingSlots = Math.max(0, 8 - attachments.length);
    if (remainingSlots === 0) {
      toast.error("单条消息最多附带 8 个图片/引用");
      return;
    }
    const candidates = files.slice(0, remainingSlots);
    setUploadingImages(true);
    try {
      const uploaded: ChatContextRef[] = [];
      for (const file of candidates) {
        const mime = file.type.toLowerCase();
        const ext = MIME_EXT[mime];
        if (!ext) {
          toast.error(`不支持的图片格式：${file.name || mime || "未知"}`);
          continue;
        }
        if (file.size > 10 * 1024 * 1024) {
          toast.error(`图片过大（上限 10MB）：${file.name}`);
          continue;
        }
        const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const relPath = `_chat_images/${unique}.${ext}`;
        await api.uploadWorkspaceFile(task.project_id, relPath, file);
        uploaded.push({
          kind: "image",
          label: file.name || `image.${ext}`,
          ref: relPath,
          mime,
        });
      }
      if (uploaded.length > 0) {
        setAttachments((prev) => [...prev, ...uploaded].slice(0, 8));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传图片失败");
    } finally {
      setUploadingImages(false);
    }
  };

  const removeAttachment = (targetRef: ChatContextRef) => {
    setAttachments((prev) =>
      prev.filter((item) => !(item.kind === targetRef.kind && item.ref === targetRef.ref)),
    );
  };

  const send = () => {
    const content = draft.trim();
    const hasImages = attachments.length > 0;
    if (!session || (!content && !hasImages) || offlineTarget || blocked || savingConfig || uploadingImages) return;
    const finalContent = content || "请查看附带的图片并继续处理当前任务。";
    const completion = streams.send(session, finalContent, attachments, turn?.runId, () => {
      setDraft(current => current === draft ? "" : current);
      setAttachments(current => current.filter(item => !attachments.includes(item)));
    });
    if (!completion) return;
    followBottom.current = true;
    void completion.catch(err => toast.error(err instanceof Error ? err.message : "发送失败"));
  };
  const stop = () => {
    if (!turn) return;
    void streams.abort(sessionId, turn.runId)?.catch(err => toast.error(err instanceof Error ? err.message : "停止失败"));
  };

  const target = session?.resolved_target || task.agent_session_target || session?.execution_target;
  const nodeName = agents.find(agent => `local:${agent.id}` === target)?.name;
  const messages = messagesWithTurn(data?.messages ?? [], turn);
  const subagentSummary = useMemo(() => aggregateSessionSubagents(messages), [messages]);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
  const [highlightedMsgId, setHighlightedMsgId] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);

  useEffect(() => {
    setSelectedSubagentId(null);
    setHighlightedMsgId(null);
  }, [sessionId]);

  useEffect(() => {
    return () => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
      }
    };
  }, []);

  const handleFocusSubagent = useCallback((id: string) => {
    setSelectedSubagentId(id);
  }, []);

  const handleJumpToMessage = useCallback((messageId: string) => {
    const container = transcript.current;
    if (!container) return;
    const candidates = container.querySelectorAll<HTMLElement>("[data-message-id]");
    const el = Array.from(candidates).find((node) => node.dataset.messageId === messageId);
    el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    setHighlightedMsgId(messageId);
    if (highlightTimer.current !== null) {
      window.clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = window.setTimeout(() => {
      setHighlightedMsgId((curr) => (curr === messageId ? null : curr));
    }, 1800);
  }, []);
  const status = running ? "执行中" : session?.status === "error" ? "执行异常" : "空闲";
  const controlsDisabled = running || dispatching || savingConfig || blocked;

  return (
    <section aria-label="任务执行会话" className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--surface-canvas)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
        <LivePulseDot active={running} tone={running ? "emerald" : "zinc"} />
        <span className="font-medium">{session ? status : "执行会话"}</span>
        {session && (
          <span
            className="max-w-full truncate rounded-md bg-[var(--surface-subtle)] px-2 py-1 font-mono text-[11px] text-[var(--text-secondary)]"
            title={`${runtimeLabel(session.runtime)} · ${session.model || "节点默认"} · ${nodeName || target || "本机"}`}
          >
            {session.runtime === "claude" ? "Claude" : session.runtime === "agy" ? "Agy" : "Codex"}
            {" · "}
            {session.model || "节点默认"}
            {session.reasoning_effort && session.reasoning_effort !== "default"
              ? ` · ${effortLabels[session.reasoning_effort]}`
              : ""}
            {" · "}
            {nodeName || (target === "auto" ? "自动路由" : target) || "本机"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="ghost" icon="refresh-cw" disabled={loading || dispatching} onClick={() => void load()}>刷新</Button>
          {session && !running && !task.merged_into && (
            <Button size="xs" variant="secondary" loading={dispatching} disabled={savingConfig} onClick={() => void dispatch()}>重新分配</Button>
          )}
          {running && <Button size="xs" variant="secondary" disabled={blocked} onClick={stop}>停止</Button>}
        </div>
      </header>
      {error && <p role="alert" className="px-4 py-2 text-xs text-rose-600">{error}</p>}
      {!session ? (
        <div className="m-auto w-full max-w-lg space-y-4 px-5 py-8 text-center">
          <div className="space-y-2">
            <Icon name="terminal" size={24} className="mx-auto text-[var(--text-muted)]" />
            <p className="text-sm font-medium">{loading ? "正在读取会话…" : error ? "无法读取执行会话" : "尚未开始执行"}</p>
            {!loading && !error && (
              <p className="text-xs leading-relaxed text-[var(--text-muted)]">
                {task.merged_into
                  ? "此任务已合并，请在主任务中继续。"
                  : paused
                    ? "项目已暂停自动执行，可在此指定节点、Harness 与模型手动分配。"
                    : routing?.routing.auto_dispatch_tasks && task.owner === "none" && (task.status === "triage" || task.status === "ready")
                      ? "任务已排队等待自动分配，也可立即指定节点、Harness 与模型手动派发。"
                      : "选择本机节点、Harness 与模型后立即分配，可实时查看执行过程并随时插话。"}
              </p>
            )}
          </div>
          {!loading && !error && !task.merged_into && (
            <div className="space-y-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 text-left shadow-xs">
              <div className="space-y-1.5">
                <p className="text-[11.5px] font-medium text-[var(--text-secondary)]">Harness（运行工具）</p>
                <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="选择任务 Harness">
                  {(["codex", "claude", "agy"] as const).map((rt) => {
                    const selected = activeRuntime === rt;
                    const ready = runtimeAvailability[rt];
                    return (
                      <button
                        key={rt}
                        type="button"
                        disabled={dispatching}
                        aria-pressed={selected}
                        onClick={() => handleSelectRuntime(rt)}
                        className={`rd-focus-ring flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                          selected
                            ? "border-[var(--rd-accent)] bg-[var(--surface-active)] text-[var(--text-primary)]"
                            : "border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        <LivePulseDot tone={ready ? "emerald" : "zinc"} active={ready} />
                        <span>{runtimeLabel(rt)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-[11.5px] font-medium text-[var(--text-secondary)]">Local Agent 节点</p>
                <LocalAgentTargetSelect
                  projectId={task.project_id}
                  runtime={activeRuntime}
                  agents={agents}
                  effectivePriority={effectivePriority}
                  value={activeTarget}
                  disabled={dispatching}
                  size="sm"
                  fullWidth
                  onChange={handleSelectTarget}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <p className="text-[11.5px] font-medium text-[var(--text-secondary)]">模型</p>
                  <LocalAgentModelCombobox
                    runtime={activeRuntime}
                    agent={resolvedAgent.agent}
                    model={activeModel}
                    currentEffort={activeEffort}
                    disabled={dispatching}
                    direction="down"
                    size="sm"
                    fullWidth
                    ariaLabel="任务执行模型"
                    onChange={handleSelectModel}
                  />
                </div>
                <LocalAgentEffortSelect
                  showLabel
                  runtime={activeRuntime}
                  agent={resolvedAgent.agent}
                  model={activeModel}
                  value={activeEffort}
                  disabled={dispatching}
                  size="sm"
                  fullWidth
                  ariaLabel="任务推理强度"
                  onChange={handleSelectEffort}
                />
              </div>

              {routing !== undefined && !resolvedAgent.ready && resolvedAgent.reason && (
                <p className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                  <Icon name="alert-circle" size={12} className="shrink-0" />
                  <span>{resolvedAgent.reason}</span>
                </p>
              )}

              <Button
                size="sm"
                variant="primary"
                icon="terminal"
                loading={dispatching}
                className="w-full justify-center"
                onClick={() => void dispatch()}
              >
                立即分配 Local Agent
              </Button>
            </div>
          )}
        </div>
      ) : <>
        <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={transcript}
          onScroll={e => { const el = e.currentTarget; followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72; }}
          className="rd-scroll min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6"
        >
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.map((msg, index) => {
              if (!msg.content && msg.role === "user" && !msg.attachments.length) return null;
              const brief = index === 0 && msg.role === "user";
              const assistant = msg.role === "assistant";
              const trace = turn?.assistant.id === msg.id ? turn.trace : turn?.previous.find(pair => pair.assistant.id === msg.id)?.trace;
              const live = assistant && running && msg.id === turn?.assistant.id;
              const { thinkingBlocks, visibleContent, errorReason } = chatMessageContent(msg);
              const label = assistant ? "Local Agent" : brief ? "任务说明" : msg.role === "system" ? "系统" : "你";
              const isHighlighted = highlightedMsgId === msg.id;
              return <article
                key={msg.id}
                data-message-id={msg.id}
                className={`${assistant ? "space-y-2" : "rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3"} ${
                  isHighlighted ? "ring-2 ring-indigo-500/40 rounded-xl" : ""
                }`}
              >
                <div className="mb-2 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  <Icon name={assistant ? "terminal" : brief ? "file-text" : "message-square"} size={13} />
                  <span className="font-medium text-[var(--text-secondary)]">{label}</span>
                  <span className="ml-auto text-[11px]">{msg.stop_reason ? STOP_LABELS[msg.stop_reason] : msg.status === "error" ? "执行异常" : msg.status === "aborted" ? "已停止" : formatRelativeTime(msg.created_at)}</span>
                </div>
                {assistant && <>
                  <ThinkingTrace active={Boolean(live)} statusLabel={turn?.statusLine || "正在执行"} startedAt={trace?.startedAt} durationMs={trace?.durationMs} entries={[...(trace?.entries ?? []), ...thinkingBlocks.map((text, i) => ({ id: `inline-${i}`, kind: "reasoning" as const, text }))]} />
                  <ToolChipsGroup
                    events={msg.events}
                    isStreaming={live}
                    subagentStates={subagentSummary.byId}
                    messageId={msg.id}
                    onSelectSubagent={handleFocusSubagent}
                  />
                </>}
                {brief && msg.content.length > 550 ? <details><summary className="cursor-pointer text-xs text-[var(--text-secondary)]">展开任务说明</summary><MarkdownContent content={msg.content} projectId={task.project_id} compact /></details> : <MarkdownContent content={assistant ? visibleContent : msg.content} projectId={task.project_id} streaming={Boolean(live)} compact />}
                {errorReason && <ChatFailureNotice reason={errorReason} />}
                {msg.attachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {msg.attachments.map(ref =>
                      ref.kind === "image" ? (
                        <a
                          key={`${ref.kind}-${ref.ref}`}
                          href={`/api/projects/${encodeURIComponent(task.project_id)}/workspace/file?path=${encodeURIComponent(ref.ref)}&inline=1`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group relative block overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)]"
                        >
                          <img
                            src={`/api/projects/${encodeURIComponent(task.project_id)}/workspace/file?path=${encodeURIComponent(ref.ref)}&inline=1`}
                            alt={ref.label || ref.ref}
                            className="h-16 w-16 object-cover transition-transform group-hover:scale-105"
                          />
                        </a>
                      ) : (
                        <span key={`${ref.kind}-${ref.ref}`} className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
                          {ref.label || ref.ref}
                        </span>
                      ),
                    )}
                  </div>
                )}
              </article>;
            })}
          </div>
        </div>
        </div>
        <form className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--surface-canvas)] px-3 py-3 sm:px-4" onSubmit={e => { e.preventDefault(); send(); }}>
          <div className="mx-auto max-w-3xl space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2" aria-label="会话执行配置">
              <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <LocalAgentTargetSelect
                projectId={task.project_id}
                runtime={activeRuntime}
                agents={agents}
                effectivePriority={effectivePriority}
                value={activeTarget}
                disabled={controlsDisabled}
                size="xs"
                className="max-w-[180px]"
                onChange={handleSelectTarget}
              />
              <div className="inline-flex h-7 items-center rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 p-0.5" role="group" aria-label="切换会话 Harness">
                {(["codex", "claude", "agy"] as const).map((rt) => (
                  <button
                    key={rt}
                    type="button"
                    disabled={controlsDisabled}
                    aria-pressed={activeRuntime === rt}
                    onClick={() => handleSelectRuntime(rt)}
                    className={`rd-focus-ring rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                      activeRuntime === rt
                        ? "bg-[var(--surface-card)] text-[var(--text-primary)] shadow-2xs"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {rt === "claude" ? "Claude" : rt === "agy" ? "Agy" : "Codex"}
                  </button>
                ))}
              </div>
              <LocalAgentModelCombobox
                runtime={activeRuntime}
                agent={resolvedAgent.agent}
                model={activeModel}
                currentEffort={activeEffort}
                disabled={controlsDisabled}
                direction="up"
                size="xs"
                ariaLabel="切换会话模型"
                onChange={handleSelectModel}
              />
              <LocalAgentEffortSelect
                runtime={activeRuntime}
                agent={resolvedAgent.agent}
                model={activeModel}
                value={activeEffort}
                disabled={controlsDisabled}
                size="xs"
                ariaLabel="切换会话推理强度"
                onChange={handleSelectEffort}
              />
              </div>
              {subagentSummary.total > 0 && (
                <SubagentDock
                  summary={subagentSummary}
                  selectedId={selectedSubagentId}
                  onSelectSubagent={handleFocusSubagent}
                  align="right"
                  className="ml-auto"
                />
              )}
            </div>

            <div
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer.types ?? []).includes("Files")) {
                  e.preventDefault();
                  if (!dragOverImage) setDragOverImage(true);
                }
              }}
              onDragLeave={(e) => {
                if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setDragOverImage(false);
                }
              }}
              onDrop={(e) => {
                setDragOverImage(false);
                const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"));
                if (files.length > 0) {
                  e.preventDefault();
                  void handleUploadImages(files);
                }
              }}
              className={`relative rounded-xl border bg-[var(--surface-card)] transition-all focus-within:border-indigo-500/60 focus-within:ring-2 focus-within:ring-indigo-500/12 ${
                dragOverImage
                  ? "border-indigo-500 ring-2 ring-indigo-500/20"
                  : "border-[var(--border-subtle)]"
              }`}
            >
              {attachments.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 px-3 pt-2.5 pb-1">
                  {attachments.map((att) => (
                    <span
                      key={`${att.kind}-${att.ref}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-1 pr-2 text-[11px] text-[var(--text-secondary)]"
                    >
                      {att.kind === "image" && (
                        <img
                          src={`/api/projects/${encodeURIComponent(task.project_id)}/workspace/file?path=${encodeURIComponent(att.ref)}&inline=1`}
                          alt={att.label}
                          className="h-6 w-6 rounded object-cover"
                        />
                      )}
                      <span className="max-w-[140px] truncate">{att.label || att.ref}</span>
                      <button
                        type="button"
                        aria-label={`移除 ${att.label || att.ref}`}
                        onClick={() => removeAttachment(att)}
                        className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] cursor-pointer"
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <RichPromptEditor
                ref={composerRef}
                value={draft}
                disabled={blocked}
                ariaLabel="发送给 Local Agent"
                placeholder={running ? "插话，调整当前执行方向（支持 `行内代码` 与 ``` 代码块）…" : "补充要求、配置或代码片段，继续处理任务…"}
                onChange={setDraft}
                onSubmit={send}
                onPasteImages={(files) => void handleUploadImages(files)}
                className="w-full px-3 pt-2.5 pb-1.5 min-h-[54px] max-h-[220px] overflow-y-auto rd-scroll cursor-text"
              />

              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (files.length > 0) void handleUploadImages(files);
                }}
              />

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)]/70 bg-[var(--surface-subtle)]/35 px-2.5 py-1.5 rounded-b-xl">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    disabled={blocked || uploadingImages}
                    onClick={() => imageInputRef.current?.click()}
                    title="上传或粘贴图片"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Icon name={uploadingImages ? "loader-2" : "image"} size={14} className={uploadingImages ? "animate-spin" : undefined} />
                  </button>
                  <span className="truncate text-[11px] text-[var(--text-muted)]">
                    {turn?.stopping
                      ? turn.stopFailed
                        ? "等待当前回复结束"
                        : "正在停止当前回复…"
                      : offlineTarget ? "本机节点离线。上线后可手动发送草稿。"
                      : savingConfig
                        ? "正在保存执行配置…"
                        : "Enter 发送 · Shift+Enter 换行"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <ContextUsageLabel session={session} variant="ghost" align="right" />
                  {running && <Button type="button" size="xs" variant="secondary" disabled={blocked} onClick={stop}>停止</Button>}
                  <Button type="submit" size="xs" variant="primary" icon="send" disabled={(!draft.trim() && attachments.length === 0) || offlineTarget || blocked || savingConfig || uploadingImages}>{running ? "发送插话" : "发送"}</Button>
                </div>
              </div>
            </div>
          </div>
        </form>
      </>}
      <SubagentDetailPanel
        projectId={task.project_id}
        summary={subagentSummary}
        selectedId={selectedSubagentId}
        onSelectId={setSelectedSubagentId}
        onClose={() => setSelectedSubagentId(null)}
        onJumpToMessage={handleJumpToMessage}
      />
    </section>
  );
}
