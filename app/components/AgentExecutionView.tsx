import { useEffect, useMemo, useState } from "react";
import type { ProjectChatStreams } from "~/lib/chat-streams.ts";
import { formatRelativeTime, taskCode } from "~/lib/format.ts";
import type { ProjectDetail, ProjectExecutionRoutingResponse, TaskRecord } from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { SegmentedDetent } from "./MotionPrimitives.tsx";
import { TaskAgentSessionPanel } from "./TaskAgentSessionPanel.tsx";
import { Button, LivePulseDot, PriorityBadge, StatusBadge } from "./ui.tsx";

const filters = { all: "全部执行", running: "执行中", queued: "排队中", waiting: "待人工", processed: "已处理" } as const;
type Filter = keyof typeof filters;

function category(task: TaskRecord): Exclude<Filter, "all"> | undefined {
  if (task.agent_session_status === "running" || task.owner === "agent") return "running";
  if (task.owner === "none" && (task.status === "ready" || task.status === "triage")) return "queued";
  if (task.status === "waiting") return "waiting";
  if (task.agent_session_id) return "processed";
}

interface Props {
  project: ProjectDetail | null;
  tasks: TaskRecord[];
  streams: ProjectChatStreams;
  routing?: ProjectExecutionRoutingResponse;
  onOpenTaskDetail: (id: string) => void;
  onRefreshTasks: () => void;
  onOpenRoutingSettings: () => void;
}

export function AgentExecutionView({ project, tasks, streams, routing, onOpenTaskDetail, onRefreshTasks, onOpenRoutingSettings }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [showMobileSession, setShowMobileSession] = useState(false);
  const counts = useMemo(() => {
    const res: Record<Filter, number> = { all: 0, running: 0, queued: 0, waiting: 0, processed: 0 };
    for (const task of tasks) {
      if (task.merged_into) continue;
      const g = category(task);
      if (!g) continue;
      res.all += 1;
      res[g] += 1;
    }
    return res;
  }, [tasks]);
  const filterOptions = useMemo(
    () =>
      (Object.keys(filters) as Filter[]).map((key) => ({
        value: key,
        label: key === "all" ? "全部" : filters[key],
        badge: counts[key] > 0 ? counts[key] : undefined,
      })),
    [counts],
  );
  const rows = useMemo(() => {
    const order = { running: 0, queued: 1, waiting: 2, processed: 3 };
    return tasks.flatMap(task => {
      const group = category(task);
      return !task.merged_into && group && (filter === "all" || filter === group) ? [{ task, group }] : [];
    }).sort((a, b) => order[a.group] - order[b.group] || b.task.updated_at.localeCompare(a.task.updated_at));
  }, [tasks, filter]);
  // Keep watching the selected task when a live update moves it out of the current filter.
  const selected = tasks.find(task => task.id === selectedId && !task.merged_into) ?? rows[0]?.task;
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);
  const online = routing?.agents.filter(agent => agent.online).length;

  return <main className="flex min-h-0 flex-1 overflow-hidden bg-[var(--surface-canvas)]">
    <aside className={`${showMobileSession && selected ? "hidden" : "flex"} min-h-0 w-full flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-card)] md:flex md:w-72 lg:w-80 md:shrink-0`}>
      <header className="space-y-3 border-b border-[var(--border-subtle)] px-4 py-4">
        <div className="flex items-center justify-between gap-2"><h1 className="text-lg font-semibold tracking-tight">Agent 执行</h1>
          {project && <Button size="xs" variant="ghost" icon="settings" onClick={onOpenRoutingSettings}>路由设置</Button>}
        </div>
        <p className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><LivePulseDot active={Boolean(online)} tone={online ? "emerald" : "zinc"} />
          {online !== undefined ? `${online} 台 Local Agent 在线` : project ? "本机节点状态待确认" : "尚未选择项目"}
        </p>
        <div className="overflow-x-auto no-scrollbar">
          <SegmentedDetent<Filter>
            size="xs"
            ariaLabel="筛选任务执行"
            options={filterOptions}
            value={filter}
            onChange={(key) => {
              setFilter(key);
              setSelectedId(undefined);
            }}
          />
        </div>
      </header>
      <div className="rd-scroll flex-1 overflow-y-auto">
        {rows.map(({ task, group }) => (
          <button
            key={task.id}
            type="button"
            aria-current={selected?.id === task.id || undefined}
            onClick={() => {
              setSelectedId(task.id);
              setShowMobileSession(true);
            }}
            className={`rd-focus-ring block w-full cursor-pointer border-b border-[var(--border-subtle)] px-4 py-3 text-left transition-[background-color,box-shadow] duration-150 ${
              selected?.id === task.id
                ? "bg-[var(--surface-active)] shadow-[inset_3px_0_var(--rd-accent)]"
                : "hover:bg-[var(--surface-subtle)]"
            }`}
          >
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]"><span className="font-mono">{taskCode(task.number)}</span><time className="ml-auto">{formatRelativeTime(task.updated_at)}</time></div>
          <p className="my-1.5 line-clamp-2 text-sm font-medium">{task.title}</p>
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><StatusBadge status={task.status} resolution={task.resolution} /><LivePulseDot active={group === "running"} tone={group === "running" ? "emerald" : "zinc"} />{task.agent_session_status === "error" ? "执行异常" : task.agent_session_status === "idle" ? "会话空闲" : filters[group]}</div>
          </button>
        ))}
        {!rows.length && <p className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">{filter === "all" ? "暂无待分配或已执行的任务" : "此筛选下暂无任务"}</p>}
      </div>
    </aside>
    <section className={`${showMobileSession && selected ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col md:flex`}>
      {selected ? <>
        <header className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-card)] px-4 py-3">
          <Button size="xs" variant="ghost" className="md:hidden" icon="arrow-left" onClick={() => setShowMobileSession(false)}>执行列表</Button>
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-[var(--text-muted)]">{taskCode(selected.number)}</span><StatusBadge status={selected.status} resolution={selected.resolution} /><PriorityBadge priority={selected.priority} showLabel /></div>
            <h2 className="mt-1 break-words text-base font-semibold">{selected.title}</h2></div>
          {selected.delivery_ref && (/^https?:\/\//i.test(selected.delivery_ref) ? <a href={selected.delivery_ref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-[var(--rd-accent)] hover:underline">查看交付<Icon name="external-link" size={12} /></a> : <span className="max-w-40 truncate font-mono text-xs" title={selected.delivery_ref}>{selected.delivery_ref}</span>)}
          <Button size="xs" variant="secondary" onClick={() => onOpenTaskDetail(selected.id)}>任务详情</Button>
        </header>
        <TaskAgentSessionPanel task={selected} streams={streams} paused={project?.automation_paused} routing={routing} onTaskUpdated={onRefreshTasks} />
      </> : <p className="m-auto text-sm text-[var(--text-muted)]">选择任务，查看执行会话。</p>}
    </section>
  </main>;
}
