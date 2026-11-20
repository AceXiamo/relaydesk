import type { TaskOwner, TaskPriority, TaskSource, TaskStatus } from "./types.ts";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  triage: "待整理",
  ready: "待处理",
  working: "处理中",
  handoff: "交接中",
  waiting: "待补充",
  review: "待验收",
  done: "已完成",
};

export const STATUS_ORDER: TaskStatus[] = [
  "triage",
  "ready",
  "working",
  "handoff",
  "waiting",
  "review",
  "done",
];

export const OWNER_LABELS: Record<TaskOwner, string> = {
  none: "未认领",
  human: "我",
  agent: "Local agent",
};

export const SOURCE_LABELS: Record<TaskSource, string> = {
  widget: "应用组件",
  bot: "群聊 Bot",
  console: "手动录入",
};

export const SOURCE_ICONS: Record<TaskSource, string> = {
  widget: "lucide:code-2",
  bot: "lucide:bot",
  console: "lucide:pen-line",
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: "紧急",
  high: "高",
  normal: "普通",
  low: "低",
};

export const PRIORITY_ORDER: TaskPriority[] = ["urgent", "high", "normal", "low"];

export const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const AUTHOR_LABELS: Record<string, string> = {
  human: "我",
  assistant: "项目助手",
  agent: "Local agent",
  system: "系统",
};

export function taskCode(num: number): string {
  return `RD-${String(num).padStart(3, "0")}`;
}

export function formatRelativeTime(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "—";
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 45) return "刚刚";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return "昨天";
  if (diffDay < 30) return `${diffDay}d`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

const EVENT_TRANSLATIONS: Record<string, string> = {
  "Feedback received": "收到反馈",
  "Assigned to operator": "你认领了任务",
  "Released by operator": "你已释放任务",
  "Operator requested handoff": "已请求 Agent 交接",
  "Operator took ownership and revoked the agent lease":
    "你已接手任务，旧 Agent 的回写权已撤销",
  "Local agent claimed task": "Local agent 已领取任务",
  "Agent handed over task": "Agent 已完成交接",
  "Agent submitted task for review": "Agent 已提交验收",
  "Agent needs assistance": "Agent 需要补充信息",
  "Task created": "任务已创建",
};

export function formatEventBody(body: string): string {
  if (EVENT_TRANSLATIONS[body]) return EVENT_TRANSLATIONS[body];
  if (body.startsWith("Updated requirements\n")) {
    return body.replace("Updated requirements", "执行要求已更新");
  }
  if (body.startsWith("Priority → ")) {
    const p = body.slice("Priority → ".length) as TaskPriority;
    return `优先级调整为 ${PRIORITY_LABELS[p] ?? p}`;
  }
  for (const [en, zh] of Object.entries(EVENT_TRANSLATIONS)) {
    if (body.startsWith(en + "\n")) {
      return zh + body.slice(en.length);
    }
  }
  const arrowParts = body.split(" → ");
  if (arrowParts.length === 2) {
    const [from, to] = arrowParts as [TaskStatus, TaskStatus];
    if (STATUS_LABELS[from] && STATUS_LABELS[to]) {
      return `${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}`;
    }
  }
  return body;
}
