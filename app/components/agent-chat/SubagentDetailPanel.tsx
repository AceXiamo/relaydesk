import { useEffect, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import {
  SUBAGENT_STATUS_META,
  compactWhitespace,
  formatSubagentRuntimeLabel,
  formatSubagentTask,
  resolveSubagentAvatar,
  type AggregatedSubagent,
  type SessionSubagentSummary,
} from "~/lib/subagents.ts";
import type {
  ChatMessageRecord,
  ChatSessionRecord,
  ChatStreamEvent,
  ChatToolEvent,
} from "~/lib/types.ts";
import { ChatWorkspaceImage } from "../ChatWorkspaceImage.tsx";
import { Icon } from "../Icon.tsx";
import { MarkdownContent } from "../MarkdownContent.tsx";
import { MorphIcon } from "../MotionPrimitives.tsx";
import { ToolChipsGroup } from "./AgentPrimitives.tsx";
import { PixelGridMatrix, SubagentAvatar, renderToolOutputLines } from "./SubagentDock.tsx";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

interface ChildStreamState {
  session: ChatSessionRecord | null;
  messages: ChatMessageRecord[];
  streamingMsgId: string | null;
  streamingContent: string;
  streamingReasoning: string;
  streamingEvents: ChatToolEvent[];
  statusLine: string;
  loading: boolean;
  error: string | null;
}

const EMPTY_CHILD_STATE: ChildStreamState = {
  session: null,
  messages: [],
  streamingMsgId: null,
  streamingContent: "",
  streamingReasoning: "",
  streamingEvents: [],
  statusLine: "",
  loading: false,
  error: null,
};

function mergeToolEvent(list: ChatToolEvent[], next: ChatToolEvent): ChatToolEvent[] {
  const idx = list.findIndex((item) => item.id === next.id);
  if (idx === -1) return [...list, next];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

export function SubagentDetailPanel({
  projectId,
  summary,
  selectedId,
  onSelectId,
  onClose,
  onJumpToMessage,
}: {
  projectId: string;
  summary: SessionSubagentSummary;
  selectedId: string | null;
  onSelectId: (id: string) => void;
  onClose: () => void;
  onJumpToMessage?: (messageId: string) => void;
}) {
  const [childState, setChildState] = useState<ChildStreamState>(EMPTY_CHILD_STATE);
  const [stopping, setStopping] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const selectedItem: AggregatedSubagent | null =
    selectedId ? (summary.byId.get(selectedId) ?? summary.items[0] ?? null) : null;
  const childSessionId = selectedItem?.event.subagent.session_id || "";

  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, onClose]);

  useEffect(() => {
    if (!selectedId || !childSessionId) {
      setChildState(EMPTY_CHILD_STATE);
      return;
    }

    const abort = new AbortController();
    let cancelled = false;

    setChildState({ ...EMPTY_CHILD_STATE, loading: true });

    const applyStreamEvent = (ev: ChatStreamEvent) => {
      if (cancelled) return;
      setChildState((prev) => {
        if (ev.type === "snapshot") {
          const existingWithoutStream = prev.messages.filter(
            (m) => m.id !== ev.assistant_message.id && m.id !== ev.user_message.id,
          );
          return {
            ...prev,
            session: ev.session,
            messages: [...existingWithoutStream, ev.user_message],
            streamingMsgId: ev.assistant_message.id,
            streamingContent: ev.assistant_message.content,
            streamingReasoning: ev.reasoning,
            streamingEvents: ev.assistant_message.events,
            statusLine: ev.status_line,
            loading: false,
            error: null,
          };
        }
        if (ev.type === "session_updated") {
          return { ...prev, session: ev.session };
        }
        if (ev.type === "text_delta") {
          return { ...prev, streamingContent: prev.streamingContent + ev.delta };
        }
        if (ev.type === "text_replace") {
          return { ...prev, streamingContent: ev.text };
        }
        if (ev.type === "reasoning") {
          return { ...prev, streamingReasoning: prev.streamingReasoning + ev.text };
        }
        if (ev.type === "tool") {
          return { ...prev, streamingEvents: mergeToolEvent(prev.streamingEvents, ev.event) };
        }
        if (ev.type === "status") {
          return { ...prev, statusLine: ev.message };
        }
        if (ev.type === "done") {
          const nextMsgs = prev.messages.some((m) => m.id === ev.message.id)
            ? prev.messages.map((m) => (m.id === ev.message.id ? ev.message : m))
            : [...prev.messages, ev.message];
          return {
            ...prev,
            session: ev.session,
            messages: nextMsgs,
            streamingMsgId: null,
            streamingContent: "",
            streamingReasoning: "",
            streamingEvents: [],
            statusLine: "",
          };
        }
        if (ev.type === "error") {
          const nextMsgs =
            ev.message && prev.messages.some((m) => m.id === ev.message!.id)
              ? prev.messages.map((m) => (m.id === ev.message!.id ? ev.message! : m))
              : ev.message
                ? [...prev.messages, ev.message]
                : prev.messages;
          return {
            ...prev,
            messages: nextMsgs,
            streamingMsgId: null,
            streamingContent: "",
            streamingReasoning: "",
            streamingEvents: [],
            statusLine: "",
            error: ev.error,
          };
        }
        return prev;
      });
    };

    void (async () => {
      try {
        const res = await api.getCodexChatSession(projectId, childSessionId);
        if (cancelled) return;
        const streamingMsg = res.messages.find((m) => m.status === "streaming");
        setChildState({
          session: res.session,
          messages: streamingMsg ? res.messages.filter((m) => m.id !== streamingMsg.id) : res.messages,
          streamingMsgId: streamingMsg?.id ?? null,
          streamingContent: streamingMsg?.content ?? "",
          streamingReasoning: "",
          streamingEvents: streamingMsg?.events ?? [],
          statusLine: res.session.status === "running" ? "子代理正在执行…" : "",
          loading: false,
          error: null,
        });

        if (res.session.active_run_id || res.session.status === "running") {
          await api.subscribeCodexChatStream(projectId, childSessionId, applyStreamEvent, abort.signal);
          if (!cancelled) {
            const refreshed = await api.getCodexChatSession(projectId, childSessionId).catch(() => null);
            if (refreshed && !cancelled) {
              setChildState((prev) => ({
                ...prev,
                session: refreshed.session,
                messages: refreshed.messages,
                streamingMsgId: null,
                streamingContent: "",
                streamingReasoning: "",
                streamingEvents: [],
                statusLine: "",
              }));
            }
          }
        }
      } catch (err) {
        if (cancelled || abort.signal.aborted) return;
        setChildState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : "加载子代理对话失败",
        }));
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [projectId, selectedId, childSessionId, selectedItem?.status]);

  useEffect(() => {
    if (childState.streamingContent || childState.messages.length) {
      bottomRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
    }
  }, [childState.messages.length, childState.streamingContent.length]);

  if (!selectedId || !selectedItem) return null;

  const avatar = resolveSubagentAvatar(selectedItem.id, selectedItem.launchIndex);
  const statusMeta = SUBAGENT_STATUS_META[selectedItem.status];
  const taskText = formatSubagentTask(selectedItem.event);
  const runtimeLabel = formatSubagentRuntimeLabel(
    childState.session?.runtime ?? selectedItem.event.subagent.runtime,
  );
  const modelLabel = childState.session?.model || selectedItem.event.subagent.model || "";
  const sandboxMode = childState.session?.sandbox_mode;
  const isDelegated = Boolean(childSessionId);
  const isRunning = selectedItem.status === "running" || childState.session?.status === "running";
  const activeRunId = childState.session?.active_run_id;
  const jumpMsgId = selectedItem.sourceMessageId || selectedItem.latestMessageId;

  const handleStopDelegated = async () => {
    if (!childSessionId || !activeRunId || stopping) return;
    setStopping(true);
    try {
      await api.abortCodexChatSession(projectId, childSessionId, activeRunId, "user_stop");
    } finally {
      setStopping(false);
    }
  };

  const handleCopyNativeOutput = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedOutput(true);
    window.setTimeout(() => setCopiedOutput(false), 1500);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`子代理对话面板：${avatar.name}`}
      data-subagent-detail-panel="1"
      data-subagent-selected-id={selectedItem.id}
      className="fixed inset-0 z-50 flex justify-end"
    >
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 bg-black/35 backdrop-blur-[2px] animate-fade-in"
      />

      {/* Independent Slide-Over Conversation Panel */}
      <aside className="relative z-10 flex h-full w-full max-w-[min(680px,100vw)] flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-canvas)] shadow-2xl animate-slide-in-right">
        {/* Accent hairline */}
        <div
          aria-hidden="true"
          className="h-[2.5px] w-full shrink-0"
          style={{
            background: `linear-gradient(90deg, ${avatar.accentHex}, color-mix(in srgb, ${avatar.accentHex} 24%, transparent))`,
          }}
        />

        {/* Member switcher strip when multiple subagents exist */}
        {summary.total > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]/55 px-4 py-2 rd-scroll">
            {summary.items.map((item) => {
              const itemAvatar = resolveSubagentAvatar(item.id, item.launchIndex);
              const active = item.id === selectedItem.id;
              const rt = formatSubagentRuntimeLabel(item.event.subagent.runtime);
              return (
                <button
                  key={item.id}
                  type="button"
                  data-subagent-tab={item.id}
                  onClick={() => onSelectId(item.id)}
                  className={cn(
                    "rd-focus-ring rd-press inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11.5px] transition-[color,background-color,border-color,transform] duration-150 cursor-pointer",
                    active
                      ? "border-[var(--border-strong)] bg-[var(--rd-plate)] text-[var(--text-primary)] font-medium shadow-xs"
                      : "border-transparent bg-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
                  )}
                >
                  <SubagentAvatar
                    avatar={itemAvatar}
                    status={item.status}
                    size="xs"
                    bobbing={item.status === "running"}
                  />
                  <span className="truncate max-w-[120px]">{itemAvatar.name}</span>
                  {rt && (
                    <span className="rounded bg-[var(--surface-subtle)] px-1 font-mono text-[10px] text-[var(--text-muted)]">
                      {rt}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Header */}
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-card)]/80 px-5 py-3.5 shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <SubagentAvatar
              avatar={avatar}
              status={selectedItem.status}
              size="md"
              bobbing={isRunning}
              elevated={isRunning}
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <h2 className="m-0 text-[14px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
                  {avatar.name}
                </h2>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium leading-none",
                    statusMeta.badgeClass,
                  )}
                >
                  {isRunning && <PixelGridMatrix variant="orbit" className="scale-[0.78] -ml-0.5" />}
                  <span>{statusMeta.label}</span>
                </span>
                {runtimeLabel && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--text-secondary)]">
                    <span>{runtimeLabel}</span>
                    {modelLabel && <span className="text-[var(--text-muted)]">· {modelLabel}</span>}
                  </span>
                )}
                {sandboxMode && (
                  <span className="inline-flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                    {sandboxMode === "read-only" ? "只读" : "可写"}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[12.5px] leading-[1.45] text-[var(--text-secondary)] break-words">
                {taskText}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {isDelegated && isRunning && activeRunId && (
              <button
                type="button"
                onClick={() => void handleStopDelegated()}
                disabled={stopping}
                className="rd-focus-ring rd-press inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11.5px] font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-500/15 transition-[color,background-color,transform] duration-150 cursor-pointer disabled:opacity-50"
              >
                <Icon name="square" size={11} />
                <span>{stopping ? "停止中" : "停止"}</span>
              </button>
            )}
            {onJumpToMessage && jumpMsgId && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onJumpToMessage(jumpMsgId);
                }}
                className="rd-focus-ring rd-press inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--rd-plate)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-[color,background-color,transform] duration-150 cursor-pointer"
              >
                <span>跳到父消息</span>
                <Icon name="arrow-up-right" size={12} />
              </button>
            )}
            <button
              type="button"
              aria-label="关闭子代理面板"
              onClick={onClose}
              className="rd-focus-ring rd-press inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-[color,background-color,transform] duration-150 cursor-pointer"
            >
              <Icon name="x" size={15} />
            </button>
          </div>
        </header>

        {/* Independent Conversation / Execution Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4 rd-scroll">
          {isDelegated ? (
            <>
              {childState.loading && (
                <div className="flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 px-3.5 py-3 text-[12px] text-[var(--text-muted)]">
                  <PixelGridMatrix variant="orbit" />
                  <span>正在加载独立子会话记录…</span>
                </div>
              )}

              {childState.error && (
                <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3.5 py-2.5 text-[12px] text-rose-600 dark:text-rose-400">
                  {childState.error}
                </div>
              )}

              {childState.messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "space-y-2",
                    msg.role === "user" && "flex justify-end",
                  )}
                >
                  {msg.role === "user" ? (
                    <div className="max-w-[90%] rounded-2xl rounded-tr-sm border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-3.5 py-2.5 text-[13px] leading-[1.6] text-[var(--text-primary)] whitespace-pre-wrap break-words">
                      <div className="mb-1 text-[10.5px] font-medium text-[var(--text-muted)]">
                        委派任务简报
                      </div>
                      {msg.content}
                    </div>
                  ) : (
                    <div className="space-y-2.5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
                      {msg.events.length > 0 && (
                        <ToolChipsGroup events={msg.events} isStreaming={msg.status === "streaming"} />
                      )}
                      {msg.content ? (
                        <MarkdownContent content={msg.content} projectId={projectId} />
                      ) : msg.error_reason ? (
                        <p className="m-0 text-[12.5px] text-rose-600 dark:text-rose-400">
                          {msg.error_reason}
                        </p>
                      ) : (
                        <p className="m-0 text-[12px] text-[var(--text-muted)]">无文本输出</p>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {childState.streamingMsgId && (
                <div className="space-y-2.5 rounded-2xl border border-indigo-500/25 bg-[var(--surface-card)] px-4 py-3">
                  {childState.streamingReasoning && (
                    <details className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 px-3 py-2 text-[11.5px] text-[var(--text-secondary)]">
                      <summary className="cursor-pointer select-none font-medium text-[var(--text-muted)]">
                        思考过程
                      </summary>
                      <pre className="mt-1.5 m-0 max-h-48 overflow-y-auto rd-scroll font-mono text-[11px] leading-[1.5] whitespace-pre-wrap break-words">
                        {childState.streamingReasoning}
                      </pre>
                    </details>
                  )}
                  {childState.streamingEvents.length > 0 && (
                    <ToolChipsGroup events={childState.streamingEvents} isStreaming={true} />
                  )}
                  {childState.streamingContent ? (
                    <MarkdownContent
                      content={childState.streamingContent}
                      projectId={projectId}
                      streaming={true}
                    />
                  ) : (
                    <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
                      <PixelGridMatrix variant="orbit" />
                      <span>{childState.statusLine || "子代理正在思考并执行…"}</span>
                    </div>
                  )}
                </div>
              )}

              <div ref={bottomRef} />
            </>
          ) : (
            /* Harness-native subagent detailed view */
            <div className="space-y-3.5">
              {selectedItem.event.subagent.activity?.trim() && (
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/70 px-3.5 py-2.5">
                  <div className="text-[11px] font-medium text-[var(--text-muted)] mb-1">
                    {isRunning ? "当前步骤" : "最近步骤"}
                  </div>
                  <div className="font-mono text-[12px] text-[var(--text-primary)] break-words">
                    {compactWhitespace(selectedItem.event.subagent.activity)}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
                <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 px-3.5 py-2">
                  <span className="text-[11.5px] font-semibold text-[var(--text-secondary)]">
                    {statusMeta.outputLabel}
                    {typeof selectedItem.event.exit_code === "number" && (
                      <span className="ml-2 font-mono text-[10.5px] text-[var(--text-muted)]">
                        exit {selectedItem.event.exit_code}
                      </span>
                    )}
                  </span>
                  {selectedItem.event.output?.trim() && (
                    <button
                      type="button"
                      onClick={() => handleCopyNativeOutput(selectedItem.event.output ?? "")}
                      className="rd-focus-ring rd-press inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-[color,background-color,transform] duration-150 cursor-pointer"
                    >
                      <MorphIcon
                        name="copy"
                        activeName="check"
                        active={copiedOutput}
                        size={11}
                        activeClassName="text-emerald-500"
                      />
                      <span>{copiedOutput ? "已复制" : "复制"}</span>
                    </button>
                  )}
                </div>
                <div className="p-3.5">
                  {selectedItem.event.output?.trim() ? (
                    renderToolOutputLines(selectedItem.event.output)
                  ) : (
                    <p className="m-0 text-[12px] text-[var(--text-muted)]">
                      {isRunning ? "子代理正在后台执行，完成后将展示完整输出…" : "暂无文本输出"}
                    </p>
                  )}
                </div>
              </div>

              {selectedItem.event.images && selectedItem.event.images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {selectedItem.event.images.map((img, imgIdx) => (
                    <ChatWorkspaceImage
                      key={`${selectedItem.id}-img-${imgIdx}`}
                      url={img.url}
                      alt={img.alt || "子代理输出图片"}
                      className="max-h-60 max-w-full rounded-lg border border-[var(--border-subtle)]"
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
