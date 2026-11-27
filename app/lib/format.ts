import type {
  DeliveryMode,
  DeployMode,
  ReleaseStatus,
  ReleaseTrigger,
  TaskDeployStatus,
  TaskOwner,
  TaskPriority,
  TaskResolution,
  TaskSource,
  TaskStatus,
} from "./types.ts";

export const DEPLOY_MODE_LABELS: Record<DeployMode, string> = {
  none: "不管理部署",
  manual: "仅手动发布",
  immediate: "完成后自动发布",
  scheduled: "定时窗口期发布",
};

export const DEPLOY_MODE_DESCRIPTIONS: Record<DeployMode, string> = {
  none: "代码推送或合流即视作闭环（适合已接入 Vercel / GitHub Actions 等外部 CI/CD 的项目）。",
  manual: "任务交付完成后进入「待发布」队列，由你在控制台手动点击「立即发布」触发生产部署。",
  immediate: "待处理任务队列清空后，自动启动 Release Agent 将所有待发布变更合并部署到生产环境。",
  scheduled: "任务交付完成后先积攒在待发布队列，仅在设定的低峰窗口期内自动发布（紧急任务可穿透）。",
};

export const TASK_DEPLOY_STATUS_LABELS: Record<TaskDeployStatus, string> = {
  not_required: "无需发布",
  pending: "待发布",
  deploying: "发布中",
  deployed: "已发布",
  failed: "发布失败",
};

export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  running: "发布中",
  verifying: "待验收",
  succeeded: "发布成功",
  failed: "发布失败",
  blocked: "已阻塞",
};

export const RELEASE_TRIGGER_LABELS: Record<ReleaseTrigger, string> = {
  immediate: "自动立即",
  scheduled: "窗口期自动",
  urgent: "紧急穿透",
  manual: "手动触发",
  ai_gate: "AI 门禁放行",
};

export function releaseCode(num: number): string {
  return `REL-${num}`;
}

export const DELIVERY_MODE_LABELS: Record<DeliveryMode, string> = {
  direct_push: "直推部署",
  pr_automerge: "PR 自动合流",
  review_only: "仅提交验收",
};

export const DELIVERY_MODE_DESCRIPTIONS: Record<DeliveryMode, string> = {
  direct_push: "验证通过后直接 commit 并 push 到工作分支触发自动部署，立即闭环。",
  pr_automerge: "切独立分支提交并创建 PR 开启 auto-merge，CI 通过后自动合并闭环。",
  review_only: "在独立分支完成改动并汇报，流转至待验收，等待人工检查。",
};

export const RESOLUTION_LABELS: Record<Exclude<TaskResolution, null>, string> = {
  shipped: "已自动交付",
  dismissed: "已过滤归档",
  wontfix: "暂不实施",
  merged: "已合并去重",
};

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
  assistant: "助手",
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
  "Agent shipped and completed task": "Agent 已验证交付并自动闭环",
  "Agent dismissed task": "Agent 研判为无效/已解决并归档",
  "Ignored by operator": "已设为忽略（暂不实施）",
  "Server AI pre-screened as noise and archived": "服务端 AI 预筛判定为噪音并自动归档",
  "Server AI pre-screened and promoted to ready": "服务端 AI 预筛通过，自动进入队列",
  "Stale agent lease reclaimed": "超时 Agent 租约已自动回收",
  "Stale agent lease reached max attempts": "多次超时失败，已暂停自动重试待人工查看",
  "Reopened by operator comment": "收到新评论，已自动重新激活进入队列",
  "Reopened for automation": "已重新放回自动执行队列",
  "Agent triaged task": "Agent 已整理任务要求与优先级",
  "Agent needs assistance": "Agent 需要补充信息",
  "Human followed up in agent session": "你在执行会话中追加了指令",
  "Agent finished reply without changing task status; moved to waiting":
    "Agent 已回复但未变更任务状态，已转为待补充",
  "Agent execution stopped by operator; moved to waiting":
    "已手动停止 Agent 执行，已转为待补充",
  "Server restarted while agent session was running; moved to waiting":
    "服务重启导致执行中断，已转为待补充",
  "Task created": "任务已创建",
};

export function formatEventBody(body: string): string {
  if (EVENT_TRANSLATIONS[body]) return EVENT_TRANSLATIONS[body];
  if (body.startsWith("Auto-dispatched to local agent")) {
    return body.replace("Auto-dispatched to local agent", "已自动分配给 Local Agent");
  }
  if (body.startsWith("Dispatched to local agent")) {
    return body.replace("Dispatched to local agent", "已分配给 Local Agent");
  }
  if (body.startsWith("Agent execution interrupted or failed")) {
    const cleaned = body
      .replace(/^Agent execution interrupted or failed/, "Agent 执行异常中断")
      .replace(/;\s*moved to waiting$/, "，已转为待补充");
    return cleaned;
  }
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
