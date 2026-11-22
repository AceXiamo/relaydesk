import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "~/lib/api.ts";
import { splitInlineThinkContent, STOP_LABELS } from "~/lib/chat-content.ts";
import { messagesWithTurn, type ProjectChatStreams } from "~/lib/chat-streams.ts";
import { formatRelativeTime } from "~/lib/format.ts";
import type { ProjectExecutionRoutingResponse, TaskRecord } from "~/lib/types.ts";
import { ThinkingTrace, ToolChipsGroup } from "./agent-chat/AgentPrimitives.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { Button, LivePulseDot, useToast } from "./ui.tsx";

type SessionHistory = Awaited<ReturnType<typeof api.getTaskAgentSession>>;

interface Props {
  task: TaskRecord;
  streams: ProjectChatStreams;
  routing?: ProjectExecutionRoutingResponse;
  paused?: boolean;
  onTaskUpdated?: () => void;
}

export function TaskAgentSessionPanel(props: Props) {
  return <SessionPanel key={props.task.id} {...props} />;
}

function SessionPanel({ task, streams, routing, paused, onTaskUpdated }: Props) {
  const toast = useToast();
  const [data, setData] = useState<SessionHistory>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [dispatching, setDispatching] = useState(false);
  const [draft, setDraft] = useState("");
  const sequence = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const sessionId = (data ? data.session?.id : task.agent_session_id) ?? "";
  const readTurn = useCallback(() => streams.snapshot().get(sessionId), [streams, sessionId]);
  const turn = useSyncExternalStore(streams.subscribe, readTurn, readTurn);
  const session = turn?.session ?? data?.session;
  const running = turn?.running ?? session?.status === "running";
  const blocked = Boolean(turn?.pending || turn?.stopping || (running && !turn));

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
      if (unsent) setDraft(current => [current, unsent.content].filter(Boolean).join("\n"));
    }
  }, [streams, sessionId, turn]);

  useEffect(() => {
    const el = transcript.current;
    if (el && followBottom.current) el.scrollTop = el.scrollHeight;
  }, [data, turn]);

  const dispatch = async () => {
    setDispatching(true);
    try {
      const result = await api.dispatchTaskToAgent(task.id);
      streams.observe(result.session, []);
      setData(previous => ({ session: result.session, messages: previous?.messages ?? [] }));
      onTaskUpdated?.();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "分配任务失败");
    } finally { setDispatching(false); }
  };

  const send = () => {
    const content = draft.trim();
    if (!session || !content || blocked) return;
    const completion = streams.send(session, content, [], turn?.runId);
    if (!completion) return;
    setDraft("");
    followBottom.current = true;
    void completion.catch(err => toast.error(err instanceof Error ? err.message : "发送失败"));
  };
  const stop = () => {
    if (!turn) return;
    void streams.abort(sessionId, turn.runId)?.catch(err => toast.error(err instanceof Error ? err.message : "停止失败"));
  };

  const target = session?.resolved_target || task.agent_session_target || session?.execution_target;
  const nodeName = routing?.agents.find(agent => `local:${agent.id}` === target)?.name;
  const messages = messagesWithTurn(data?.messages ?? [], turn);
  const status = running ? "执行中" : session?.status === "error" ? "执行异常" : "空闲";
  return (
    <section aria-label="任务执行会话" className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--surface-canvas)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs">
        <LivePulseDot active={running} tone={running ? "emerald" : "zinc"} />
        <span className="font-medium">{session ? status : "执行会话"}</span>
        {session && <span className="max-w-full truncate rounded-md bg-[var(--surface-subtle)] px-2 py-1 font-mono text-[11px] text-[var(--text-secondary)]" title={target}>
          {session.runtime === "claude" ? "Claude" : "Codex"} · {nodeName || (target === "auto" ? "自动路由" : target) || "本机"}
        </span>}
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="ghost" icon="refresh-cw" disabled={loading || dispatching} onClick={() => void load()}>刷新</Button>
          {session && !running && !task.merged_into && <Button size="xs" variant="secondary" loading={dispatching} onClick={() => void dispatch()}>重新分配</Button>}
          {running && <Button size="xs" variant="secondary" disabled={blocked} onClick={stop}>停止</Button>}
        </div>
      </header>
      {error && <p role="alert" className="px-4 py-2 text-xs text-rose-600">{error}</p>}
      {!session ? (
        <div className="m-auto max-w-sm space-y-3 px-6 py-8 text-center">
          <Icon name="terminal" size={24} className="mx-auto text-[var(--text-muted)]" />
          <p className="text-sm font-medium">{loading ? "正在读取会话…" : error ? "无法读取执行会话" : "尚未开始执行"}</p>
          {!loading && !error && <>
            <p className="text-xs leading-relaxed text-[var(--text-muted)]">{task.merged_into ? "此任务已合并，请在主任务中继续。" : paused ? "项目已暂停自动执行，可手动分配。" : routing?.routing.auto_dispatch_tasks && task.owner === "none" && (task.status === "triage" || task.status === "ready") ? "任务已排队，正在等待可用的 Local Agent。" : "手动分配后，可在这里查看执行过程并随时插话。"}</p>
            {!task.merged_into && <Button size="sm" variant="primary" icon="terminal" loading={dispatching} onClick={() => void dispatch()}>立即分配 Local Agent</Button>}
          </>}
        </div>
      ) : <>
        <div ref={transcript} onScroll={e => { const el = e.currentTarget; followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72; }} className="rd-scroll min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.map((msg, index) => {
              if (!msg.content && msg.role === "user" && !msg.attachments.length) return null;
              const brief = index === 0 && msg.role === "user";
              const assistant = msg.role === "assistant";
              const trace = turn?.assistant.id === msg.id ? turn.trace : turn?.previous.find(pair => pair.assistant.id === msg.id)?.trace;
              const live = assistant && running && msg.id === turn?.assistant.id;
              const { thinkingBlocks, visibleContent } = splitInlineThinkContent(msg.content);
              const label = assistant ? "Local Agent" : brief ? "任务说明" : msg.role === "system" ? "系统" : "你";
              return <article key={msg.id} className={assistant ? "space-y-2" : "rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3"}>
                <div className="mb-2 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  <Icon name={assistant ? "terminal" : brief ? "file-text" : "message-square"} size={13} />
                  <span className="font-medium text-[var(--text-secondary)]">{label}</span>
                  <span className="ml-auto text-[11px]">{msg.stop_reason ? STOP_LABELS[msg.stop_reason] : msg.status === "error" ? "执行异常" : msg.status === "aborted" ? "已停止" : formatRelativeTime(msg.created_at)}</span>
                </div>
                {assistant && <>
                  <ThinkingTrace active={Boolean(live)} statusLabel={turn?.statusLine || "正在执行"} startedAt={trace?.startedAt} durationMs={trace?.durationMs} entries={[...(trace?.entries ?? []), ...thinkingBlocks.map((text, i) => ({ id: `inline-${i}`, kind: "reasoning" as const, text }))]} />
                  <ToolChipsGroup events={msg.events} isStreaming={live} />
                </>}
                {brief && msg.content.length > 550 ? <details><summary className="cursor-pointer text-xs text-[var(--text-secondary)]">展开任务说明</summary><MarkdownContent content={msg.content} projectId={task.project_id} compact /></details> : <MarkdownContent content={assistant ? visibleContent : msg.content} projectId={task.project_id} compact />}
                {msg.attachments.map(ref => <span key={`${ref.kind}-${ref.ref}`} className="mr-2 text-xs text-[var(--text-muted)]">{ref.label || ref.ref}</span>)}
              </article>;
            })}
          </div>
        </div>
        <form className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--surface-card)] p-3" onSubmit={e => { e.preventDefault(); send(); }}>
          <div className="mx-auto max-w-3xl">
            <textarea aria-label="发送给 Local Agent" rows={2} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); send(); }
            }} placeholder={running ? "插话，调整当前执行方向…" : "补充要求，继续处理任务…"} className="w-full resize-none rounded-lg bg-[var(--surface-subtle)] px-3 py-2 text-sm rd-focus-ring" />
            <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
              <span className="mr-auto text-[11px] text-[var(--text-muted)]">{turn?.stopping ? turn.stopFailed ? "等待当前回复结束" : "正在停止当前回复…" : "Shift + Enter 换行"}</span>
              {running && <Button type="button" size="xs" variant="secondary" disabled={blocked} onClick={stop}>停止</Button>}
              <Button type="submit" size="xs" variant="primary" icon="send" disabled={!draft.trim() || blocked}>{running ? "发送插话" : "发送"}</Button>
            </div>
          </div>
        </form>
      </>}
    </section>
  );
}
