import type {
  BridgeAgentBindingSummary,
  BridgeAgentSummary,
  ChatRuntime,
  ChatSessionRecord,
  ProjectRoutingConfig,
} from "../app/lib/types.ts";
import type { BridgeHub } from "./bridge-hub.ts";
import { ApiError } from "./errors.ts";
import type { Store } from "./store.ts";

export interface ResolvedChatExecutionTarget {
  targetKey: string;
  localAgentId: string | null;
  localBinding: BridgeAgentBindingSummary | null;
  agentName?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
}

export interface LocalAgentEligibility {
  eligible: boolean;
  reason?: string;
  binding?: BridgeAgentBindingSummary;
}

export function normalizeExecutionPriority(
  routing: ProjectRoutingConfig,
  agents: ReadonlyArray<Pick<BridgeAgentSummary, "id">>,
): string[] {
  const validAgentIds = new Set(agents.map((a) => a.id));
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const raw of routing.priority ?? []) {
    if (typeof raw !== "string") continue;
    const item = raw.trim();
    if (!item || seen.has(item)) continue;
    if (item === "cloud") {
      seen.add(item);
      ordered.push(item);
    } else if (item.startsWith("local:")) {
      const id = item.slice("local:".length);
      if (validAgentIds.has(id)) {
        seen.add(item);
        ordered.push(item);
      }
    }
  }

  const missingAgents = agents
    .map((a) => `local:${a.id}`)
    .filter((key) => !seen.has(key));

  if (seen.has("cloud")) {
    // Respect explicit cloud placement; append newly registered agents at the end.
    return [...ordered, ...missingAgents];
  }
  // Default order: all local agents first, then cloud fallback.
  return [...ordered, ...missingAgents, "cloud"];
}

export function evaluateLocalAgentEligibility(options: {
  agent: BridgeAgentSummary;
  projectId: string;
  runtime: ChatRuntime;
  bridgeHub: BridgeHub | null;
  store: Store;
  requireCliRuns?: boolean;
}): LocalAgentEligibility {
  const { agent, projectId, runtime, bridgeHub, store, requireCliRuns } = options;
  if (!bridgeHub || !agent.online) {
    return { eligible: false, reason: `本机节点「${agent.name}」离线` };
  }
  if (requireCliRuns && !agent.accept_cli_runs) {
    return { eligible: false, reason: `本机节点「${agent.name}」未开启工单/审计承接` };
  }
  const binding = store.getProjectAgentBinding(projectId, agent.id);
  if (!binding) {
    return { eligible: false, reason: `本机节点「${agent.name}」未绑定本项目目录` };
  }
  if (!binding.enabled) {
    return { eligible: false, reason: `本机节点「${agent.name}」已禁用本项目绑定` };
  }
  if (!binding.path_ok || !binding.workdir) {
    return {
      eligible: false,
      reason: `本机节点「${agent.name}」目录校验未通过${binding.path_error ? `（${binding.path_error}）` : ""}`,
    };
  }
  try {
    bridgeHub.assertWorkspaceAccess(agent.id, projectId);
  } catch (err) {
    return {
      eligible: false,
      reason: err instanceof ApiError ? err.message : `本机节点「${agent.name}」目录绑定已失效`,
    };
  }
  if (!agent.runtimes[runtime]?.available) {
    return { eligible: false, reason: `本机节点「${agent.name}」未检测到 ${runtime} CLI` };
  }
  if (agent.max_concurrency > 0 && agent.active_runs >= agent.max_concurrency) {
    return {
      eligible: false,
      reason: `本机节点「${agent.name}」并发已满（${agent.active_runs}/${agent.max_concurrency}）`,
    };
  }
  return { eligible: true, binding };
}

export function canResumeExternalSession(
  session: Pick<ChatSessionRecord, "external_session_id" | "resolved_target">,
  targetKey: string,
): boolean {
  if (!session.external_session_id) return false;
  const previousTarget = session.resolved_target || "cloud";
  return previousTarget === targetKey;
}

export function resolveChatExecutionTarget(options: {
  store: Store;
  bridgeHub: BridgeHub | null;
  projectId: string;
  executionTarget: string;
  runtime: ChatRuntime;
  localClis: { codex: boolean; claude: boolean; agy?: boolean };
}): ResolvedChatExecutionTarget {
  const { store, bridgeHub, projectId, executionTarget, runtime, localClis } = options;

  if (executionTarget === "cloud") {
    if (!localClis[runtime]) {
      throw new ApiError(409, `云端服务器未检测到 ${runtime} CLI，无法在云端执行。`);
    }
    return { targetKey: "cloud", localAgentId: null, localBinding: null };
  }

  if (executionTarget.startsWith("local:")) {
    const agentId = executionTarget.slice("local:".length);
    if (!bridgeHub) {
      throw new ApiError(409, "本地执行节点服务未启用");
    }
    const binding = bridgeHub.assertCanRun(agentId, projectId, runtime);
    const rawAgent = store.getBridgeAgent(agentId);
    return {
      targetKey: `local:${agentId}`,
      localAgentId: agentId,
      localBinding: binding,
      agentName: rawAgent?.name,
    };
  }

  // executionTarget === "auto"
  const routing = store.getProjectExecutionRouting(projectId);
  const agents = store
    .listBridgeAgents()
    .map((a) => (bridgeHub ? bridgeHub.describe(a) : a));
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const priority = normalizeExecutionPriority(routing, agents);

  const skipped: Array<{ target: string; label: string; reason: string }> = [];

  for (let i = 0; i < priority.length; i += 1) {
    const candidate = priority[i];
    if (candidate === "cloud") {
      if (localClis[runtime]) {
        const firstSkipped = skipped[0];
        return {
          targetKey: "cloud",
          localAgentId: null,
          localBinding: null,
          ...(firstSkipped
            ? { fallbackFrom: firstSkipped.label, fallbackReason: firstSkipped.reason }
            : {}),
        };
      }
      const reason = `云端服务器未检测到 ${runtime} CLI`;
      skipped.push({ target: "cloud", label: "云端执行器", reason });
    } else if (candidate.startsWith("local:")) {
      const agentId = candidate.slice("local:".length);
      const agent = agentMap.get(agentId);
      if (!agent) continue;
      const check = evaluateLocalAgentEligibility({
        agent,
        projectId,
        runtime,
        bridgeHub,
        store,
      });
      if (check.eligible && check.binding) {
        const firstSkipped = skipped[0];
        return {
          targetKey: candidate,
          localAgentId: agent.id,
          localBinding: check.binding,
          agentName: agent.name,
          ...(firstSkipped
            ? { fallbackFrom: firstSkipped.label, fallbackReason: firstSkipped.reason }
            : {}),
        };
      }
      skipped.push({
        target: candidate,
        label: `本机「${agent.name}」`,
        reason: check.reason || `本机节点「${agent.name}」不可用`,
      });
    }

    if (i === 0 && !routing.auto_fallback) {
      const primary = skipped[0];
      throw new ApiError(
        409,
        `首选执行节点不可用：${primary?.reason || "当前不可用"}。已在项目设置中关闭自动降级，请恢复该节点或开启自动降级。`,
      );
    }
  }

  const summary = skipped.map((s) => s.reason).join("；");
  throw new ApiError(409, summary ? `没有可用的执行节点：${summary}` : `没有可用的 ${runtime} 执行节点`);
}

export function resolveCliRunBridgeTarget(options: {
  store: Store;
  bridgeHub: BridgeHub | null;
  projectId: string;
  runtime: ChatRuntime;
  cloudConfigured: boolean;
}): { agent: BridgeAgentSummary; binding: BridgeAgentBindingSummary } | null {
  const { store, bridgeHub, projectId, runtime, cloudConfigured } = options;
  if (!bridgeHub) return null;
  const routing = store.getProjectExecutionRouting(projectId);
  if (!routing.route_cli_runs) return null;

  const agents = store.listBridgeAgents().map((a) => bridgeHub.describe(a));
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const priority = normalizeExecutionPriority(routing, agents);

  for (let i = 0; i < priority.length; i += 1) {
    const candidate = priority[i];
    if (candidate === "cloud") {
      if (cloudConfigured) {
        // User explicitly ranked cloud ahead of remaining local agents and cloud is configured.
        return null;
      }
      if (i === 0 && !routing.auto_fallback) return null;
      continue;
    }
    if (candidate.startsWith("local:")) {
      const agentId = candidate.slice("local:".length);
      const agent = agentMap.get(agentId);
      if (!agent) continue;
      const check = evaluateLocalAgentEligibility({
        agent,
        projectId,
        runtime,
        bridgeHub,
        store,
        requireCliRuns: true,
      });
      if (check.eligible && check.binding) {
        return { agent, binding: check.binding };
      }
      if (i === 0 && !routing.auto_fallback) {
        return null;
      }
    }
  }

  return null;
}

export interface LocalTaskTargetResolution {
  target: {
    targetKey: string;
    agent: BridgeAgentSummary;
    binding: BridgeAgentBindingSummary;
  } | null;
  reasons: string[];
}

export function resolveLocalTaskExecutionTarget(options: {
  store: Store;
  bridgeHub: BridgeHub | null;
  projectId: string;
  runtime: ChatRuntime;
  executionTarget?: string;
}): LocalTaskTargetResolution {
  const { store, bridgeHub, projectId, runtime, executionTarget } = options;
  if (!bridgeHub) {
    return { target: null, reasons: ["本地执行节点服务未启用"] };
  }

  const agents = store.listBridgeAgents().map((a) => bridgeHub.describe(a));
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const tryAgent = (agent: BridgeAgentSummary): { ok: true; binding: BridgeAgentBindingSummary } | { ok: false; reason: string } => {
    const check = evaluateLocalAgentEligibility({
      agent,
      projectId,
      runtime,
      bridgeHub,
      store,
    });
    if (!check.eligible || !check.binding) {
      return { ok: false, reason: check.reason || `本机节点「${agent.name}」不可用` };
    }
    if (bridgeHub.hasActiveRunForProject(agent.id, projectId)) {
      return { ok: false, reason: `本机节点「${agent.name}」正在当前项目目录执行其他会话` };
    }
    return { ok: true, binding: check.binding };
  };

  if (executionTarget && executionTarget.startsWith("local:")) {
    const agentId = executionTarget.slice("local:".length);
    const agent = agentMap.get(agentId);
    if (!agent) {
      return { target: null, reasons: [`未找到指定的本机节点：${executionTarget}`] };
    }
    const res = tryAgent(agent);
    if (res.ok) {
      return { target: { targetKey: executionTarget, agent, binding: res.binding }, reasons: [] };
    }
    return { target: null, reasons: [res.reason] };
  }

  const routing = store.getProjectExecutionRouting(projectId);
  const priority = normalizeExecutionPriority(routing, agents);
  const reasons: string[] = [];

  for (const candidate of priority) {
    if (!candidate.startsWith("local:")) continue;
    const agentId = candidate.slice("local:".length);
    const agent = agentMap.get(agentId);
    if (!agent) continue;
    const res = tryAgent(agent);
    if (res.ok) {
      return { target: { targetKey: candidate, agent, binding: res.binding }, reasons: [] };
    }
    reasons.push(res.reason);
  }

  if (reasons.length === 0) {
    reasons.push("未配置可用的本机执行节点（请先绑定并上线 Local Agent）");
  }
  return { target: null, reasons };
}

