import type {
  BridgeAgentSummary,
  ChatReasoningEffort,
  ChatRuntime,
  ChatRuntimeInfo,
  ModelCatalogItem,
} from "./types.ts";

export const validCatalogId = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 160 && !value.startsWith("-") && !/[^!-~]/.test(value);

const publicText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max &&
  !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
  !/(?:[a-z][a-z0-9+.-]*:\/\/|\bBearer\s|(?:rdbr_|sk-|gh[pousr]_|github_pat_|xox[baprs]-)[a-z\d_-]{6,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+)/i.test(value);

export const validCatalogTokenLimit = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 10_000_000;

const levels = ["off", "low", "medium", "high", "max"] as const;
const isLevel = (value: unknown): value is typeof levels[number] => levels.some(level => value === level);

export function isAgyOrchestrator(id: string): boolean {
  return /^gemini-pro-orchestrator(?:-|$)/i.test(id);
}

/** Construct a new, bounded wire object; never copy unknown keys or nested configuration. */
export function sanitizeBridgeModels(input: unknown): ModelCatalogItem[] {
  if (!Array.isArray(input)) return [];
  const models = new Map<string, ModelCatalogItem>();
  for (const entry of input) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row: Record<string, unknown> = entry;
    const { id, runtime } = row;
    if (!validCatalogId(id) || !publicText(id, 160) || (runtime !== "claude" && runtime !== "codex" && runtime !== "agy")) continue;
    const item: ModelCatalogItem = { id, runtime };
    if (publicText(row.label, 120)) item.label = row.label;
    if (publicText(row.provider, 60)) item.provider = row.provider;
    for (const key of ["context_window", "max_output_tokens"] as const) {
      const n = row[key];
      if (validCatalogTokenLimit(n)) item[key] = n;
    }
    for (const key of ["is_default", "supports_effort"] as const) {
      if (typeof row[key] === "boolean") item[key] = row[key];
    }
    if (runtime === "codex" && typeof row.supports_fast === "boolean") item.supports_fast = row.supports_fast;
    if (Array.isArray(row.effort_levels)) item.effort_levels = [...new Set(row.effort_levels.filter(isLevel))];
    if (isLevel(row.default_effort)) item.default_effort = row.default_effort;
    if (runtime === "agy" && isAgyOrchestrator(id)) {
      item.supports_effort = false;
      delete item.effort_levels;
      delete item.default_effort;
    }
    if (Array.isArray(row.tags)) item.tags = [...new Set<string>(row.tags.filter((tag: unknown) => publicText(tag, 48)).slice(0, 8))];
    if (row.source === "bridge_config" || row.source === "cli_config" || row.source === "detected") item.source = row.source;
    const key = `${runtime}:${id}`;
    models.set(key, { ...models.get(key), ...item });
    if (models.size >= 200) break;
  }
  return [...models.values()];
}

export const effortLabels: Record<ChatReasoningEffort, string> = {
  default: "默认", off: "关闭", low: "低", medium: "中", high: "高", max: "极高",
};

export const builtinModels: ModelCatalogItem[] = [
  {
    runtime: "codex", provider: "OpenAI", id: "gpt-5.4", label: "GPT-5.4",
    context_window: 400_000, supports_effort: true,
    effort_levels: ["low", "medium", "high", "max"], default_effort: "high",
  },
  {
    runtime: "claude", provider: "Anthropic", id: "claude-opus-4-6", label: "Claude Opus 4.6",
    context_window: 1_000_000, supports_effort: true,
    effort_levels: ["off", "low", "medium", "high", "max"], default_effort: "high",
  },
  {
    runtime: "claude", provider: "Anthropic", id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6",
    context_window: 1_000_000, supports_effort: true,
    effort_levels: ["off", "low", "medium", "high"], default_effort: "medium",
  },
  {
    runtime: "agy", provider: "Google", id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)",
    context_window: 1_000_000, supports_effort: true,
    effort_levels: ["low", "medium", "high", "max"], default_effort: "medium",
  },
  {
    runtime: "agy", provider: "Google", id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)",
    context_window: 1_000_000, supports_effort: true,
    effort_levels: ["low", "medium", "high", "max"], default_effort: "high",
  },
  {
    runtime: "agy", provider: "Google", id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)",
    context_window: 1_000_000, supports_effort: true,
    effort_levels: ["low", "medium", "high"], default_effort: "medium",
  },
];

export const CHAT_RUNTIMES: readonly ChatRuntime[] = ["codex", "claude", "agy"] as const;

export function runtimeDisplayName(runtime: ChatRuntime): string {
  if (runtime === "claude") return "Claude Code";
  if (runtime === "agy") return "Antigravity CLI";
  return "Codex CLI";
}

export function runtimeShortName(runtime: ChatRuntime): string {
  if (runtime === "claude") return "Claude";
  if (runtime === "agy") return "Agy";
  return "Codex";
}

// Local windows depend on the harness configuration, even for a known model ID.
export const localBuiltinMetadata = builtinModels.map(({ context_window, ...metadata }) => metadata);

/**
 * Resolve which local bridge agent (if any) will handle execution for the given target and runtime.
 * Returns null when execution targets Relaydesk Cloud.
 */
export function resolveActiveLocalAgent(
  runtimeInfo: ChatRuntimeInfo | null | undefined,
  projectId: string | undefined,
  executionTarget: string,
  runtime: ChatRuntime,
): BridgeAgentSummary | null {
  const agents = runtimeInfo?.agents ?? [];
  if (executionTarget === "cloud") return null;
  if (executionTarget.startsWith("local:")) {
    const id = executionTarget.slice("local:".length);
    return agents.find((a) => a.id === id) ?? null;
  }
  const priority = runtimeInfo?.effective_priority ?? agents.map((a) => `local:${a.id}`);
  for (let i = 0; i < priority.length; i += 1) {
    const key = priority[i];
    if (key === "cloud") {
      if (runtimeInfo?.local_clis[runtime]) return null;
      if (i === 0 && runtimeInfo?.routing?.auto_fallback === false) return null;
      continue;
    }
    if (!key.startsWith("local:")) continue;
    const id = key.slice("local:".length);
    const agent = agents.find((a) => a.id === id);
    const binding = projectId ? agent?.bindings.find((b) => b.project_id === projectId) : undefined;
    const eligible = Boolean(
      agent?.online &&
        (!projectId || (binding?.enabled && binding?.path_ok)) &&
        agent?.runtimes[runtime]?.available,
    );
    if (eligible && agent) return agent;
    if (i === 0 && runtimeInfo?.routing?.auto_fallback === false) return null;
  }
  return null;
}

export function showEffortControl(runtime: ChatRuntime, entry?: ModelCatalogItem): boolean {
  if (runtime !== "agy") return true;
  if (!entry || isAgyOrchestrator(entry.id) || entry.supports_effort === false) return false;
  return entry?.effort_levels ? entry.effort_levels.length > 0 : entry?.supports_effort === true;
}

export function fastSupportForTarget(
  entry: ModelCatalogItem | undefined,
  agent: BridgeAgentSummary | null,
  target: string,
  info: ChatRuntimeInfo | null,
): boolean | undefined {
  const fixedTarget = target === "auto" && info?.routing?.auto_fallback === false
    ? info.effective_priority?.[0] : target;
  if (!agent && fixedTarget?.startsWith("local:")) return undefined;
  return entry?.runtime === "codex" ? entry.supports_fast : undefined;
}

export function chatTargetAvailability(info: ChatRuntimeInfo | null, projectId: string, target: string, runtime: ChatRuntime) {
  const agent = resolveActiveLocalAgent(info, projectId, target, runtime);
  const primary = target === "auto" ? info?.effective_priority?.[0] : target;
  const fixedLocal = primary?.startsWith("local:") && (target !== "auto" || info?.routing?.auto_fallback === false);
  const binding = agent?.bindings.find(b => b.project_id === projectId);
  if (agent?.online && agent.runtimes[runtime]?.available && binding?.enabled && binding.path_ok) {
    return { mode: "local_cli" as const };
  }
  if (fixedLocal) {
    const selected = info?.agents?.find(a => `local:${a.id}` === primary);
    const reason = selected && !selected.online ? `本机节点「${selected.name}」离线。上线后可手动发送草稿。`
      : "本机节点暂不可用，请检查节点和项目绑定。";
    return { mode: "unavailable" as const, reason };
  }
  const mode = info?.auth_mode[runtime] ?? "unavailable";
  const allOffline = target === "auto" && info?.agents?.length && info.agents.every(a => !a.online);
  return { mode, reason: mode === "unavailable" && allOffline ? "本机节点离线。上线后可手动发送草稿。" : undefined };
}

/**
 * Resolve the default model ID strictly scoped to the active execution target.
 * Local agent targets never inherit cloud project_cli.model.
 */
export function resolveDefaultModelForTarget(
  runtime: ChatRuntime,
  activeLocalAgent: BridgeAgentSummary | null,
  projectCli: ChatRuntimeInfo["project_cli"] | undefined,
): string {
  if (activeLocalAgent) {
    return (
      activeLocalAgent.runtimes[runtime]?.default_model ||
      activeLocalAgent.models.find((item) => item.runtime === runtime && item.is_default)?.id ||
      ""
    );
  }
  if (projectCli?.runtime === runtime && projectCli.model) {
    return projectCli.model;
  }
  return projectCli?.models?.find((item) => item.runtime === runtime && item.is_default)?.id || "";
}

/**
 * Build the selectable model catalog for a runtime and execution target.
 * - Local agent target: strictly mirrors models reported by that agent (plus its runtime default_model),
 *   without merging cloud project_cli models or unrelated built-in models.
 * - Cloud target: uses project_cli models, project default model, and built-in fallback models.
 */
export function resolveCatalogForTarget(options: {
  runtime: ChatRuntime;
  activeLocalAgent: BridgeAgentSummary | null;
  projectCli: ChatRuntimeInfo["project_cli"] | undefined;
  selectedModel?: string;
  includeSelectedFallback?: boolean;
}): ModelCatalogItem[] {
  const {
    runtime,
    activeLocalAgent,
    projectCli,
    selectedModel = "",
    includeSelectedFallback = true,
  } = options;
  const suggestions = (activeLocalAgent ? localBuiltinMetadata : builtinModels).filter((item) => item.runtime === runtime);
  const enrich = (item: ModelCatalogItem): ModelCatalogItem => ({
    ...suggestions.find((s) => s.id === item.id),
    ...item,
  });
  const catalog = new Map<string, ModelCatalogItem>();

  if (activeLocalAgent) {
    for (const item of activeLocalAgent.models) {
      if (item.runtime === runtime) {
        catalog.set(item.id, enrich(item));
      }
    }
    const agentDefault = activeLocalAgent.runtimes[runtime]?.default_model;
    if (agentDefault && !catalog.has(agentDefault)) {
      catalog.set(
        agentDefault,
        suggestions.find((s) => s.id === agentDefault) ?? {
          id: agentDefault,
          runtime,
          is_default: true,
        },
      );
    }
    if (includeSelectedFallback && selectedModel && !catalog.has(selectedModel)) {
      catalog.set(
        selectedModel,
        suggestions.find((s) => s.id === selectedModel) ?? { id: selectedModel, runtime },
      );
    }
    return [...catalog.values()];
  }

  for (const item of projectCli?.models ?? []) {
    if (item.runtime === runtime && !catalog.has(item.id)) {
      catalog.set(item.id, enrich(item));
    }
  }
  const projectDefault = projectCli?.runtime === runtime ? projectCli.model : "";
  if (projectDefault && !catalog.has(projectDefault)) {
    catalog.set(
      projectDefault,
      suggestions.find((s) => s.id === projectDefault) ?? { id: projectDefault, runtime },
    );
  }
  if (includeSelectedFallback && selectedModel && !catalog.has(selectedModel)) {
    catalog.set(
      selectedModel,
      suggestions.find((s) => s.id === selectedModel) ?? { id: selectedModel, runtime },
    );
  }
  for (const item of suggestions) {
    if (!catalog.has(item.id)) {
      catalog.set(item.id, item);
    }
  }
  return [...catalog.values()];
}

export interface LocalTaskAgentResolution {
  agent: BridgeAgentSummary | null;
  ready: boolean;
  reason?: string;
}

function evaluateLocalAgentForTask(
  agent: BridgeAgentSummary,
  projectId: string | undefined,
  runtime: ChatRuntime,
): { ready: boolean; bound: boolean; hasRuntime: boolean; reason?: string } {
  const binding = projectId ? agent.bindings.find((b) => b.project_id === projectId) : undefined;
  const bound = !projectId || Boolean(binding?.enabled && binding?.path_ok);
  const hasRuntime = Boolean(agent.runtimes[runtime]?.available);
  if (!agent.online) {
    return { ready: false, bound, hasRuntime, reason: `节点「${agent.name}」离线` };
  }
  if (!bound) {
    return { ready: false, bound, hasRuntime, reason: `节点「${agent.name}」未绑定或未启用本项目目录` };
  }
  if (!hasRuntime) {
    return {
      ready: false,
      bound,
      hasRuntime,
      reason: `节点「${agent.name}」未检测到 ${runtimeDisplayName(runtime)}`,
    };
  }
  if (agent.max_concurrency > 0 && agent.active_runs >= agent.max_concurrency) {
    return {
      ready: false,
      bound,
      hasRuntime,
      reason: `节点「${agent.name}」并发已满 (${agent.active_runs}/${agent.max_concurrency})`,
    };
  }
  return { ready: true, bound, hasRuntime };
}

/**
 * Resolve the Local Agent node for task dispatch (never falls back to Cloud).
 * When no node is immediately ready, returns the best candidate node for model catalog preview
 * along with `ready: false` and a human-readable `reason`.
 */
export function resolveLocalTaskAgent(options: {
  agents?: BridgeAgentSummary[];
  effectivePriority?: string[];
  projectId?: string;
  executionTarget?: string;
  runtime: ChatRuntime;
}): LocalTaskAgentResolution {
  const { agents = [], effectivePriority, projectId, executionTarget = "auto", runtime } = options;

  if (executionTarget.startsWith("local:")) {
    const id = executionTarget.slice("local:".length);
    const agent = agents.find((a) => a.id === id) ?? null;
    if (!agent) {
      return { agent: null, ready: false, reason: "指定的 Local Agent 不存在" };
    }
    const check = evaluateLocalAgentForTask(agent, projectId, runtime);
    return { agent, ready: check.ready, reason: check.reason };
  }

  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of effectivePriority ?? []) {
    if (entry.startsWith("local:")) {
      const id = entry.slice("local:".length);
      if (!seen.has(id)) {
        seen.add(id);
        orderedIds.push(id);
      }
    }
  }
  for (const agent of agents) {
    if (!seen.has(agent.id)) {
      seen.add(agent.id);
      orderedIds.push(agent.id);
    }
  }

  const orderedAgents = orderedIds
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is BridgeAgentSummary => Boolean(a));

  if (orderedAgents.length === 0) {
    return { agent: null, ready: false, reason: "暂无已注册的 Local Agent" };
  }

  let fallbackCandidate: { agent: BridgeAgentSummary; score: number; reason?: string } | null = null;
  for (const agent of orderedAgents) {
    const check = evaluateLocalAgentForTask(agent, projectId, runtime);
    if (check.ready) {
      return { agent, ready: true };
    }
    const hasModels = agent.models.some((m) => m.runtime === runtime) || Boolean(agent.runtimes[runtime]?.default_model);
    const score =
      (check.bound ? 4 : 0) +
      (agent.online ? 2 : 0) +
      (check.hasRuntime || hasModels ? 1 : 0);
    if (!fallbackCandidate || score > fallbackCandidate.score) {
      fallbackCandidate = { agent, score, reason: check.reason };
    }
  }

  return {
    agent: fallbackCandidate?.agent ?? null,
    ready: false,
    reason: fallbackCandidate?.reason ?? "暂无可用的 Local Agent",
  };
}

/**
 * Build the selectable model catalog for Local Agent task dispatch/settings.
 * Mirrors the resolved Local Agent's reported models when an agent is present;
 * falls back to built-in suggestions only when no Local Agent is registered yet.
 */
export function resolveLocalTaskModelCatalog(options: {
  runtime: ChatRuntime;
  agent: BridgeAgentSummary | null;
  selectedModel?: string;
  includeSelectedFallback?: boolean;
}): ModelCatalogItem[] {
  const { runtime, agent, selectedModel = "", includeSelectedFallback = true } = options;
  if (agent) {
    return resolveCatalogForTarget({
      runtime,
      activeLocalAgent: agent,
      projectCli: undefined,
      selectedModel,
      includeSelectedFallback,
    });
  }
  return resolveCatalogForTarget({
    runtime,
    activeLocalAgent: null,
    projectCli: undefined,
    selectedModel,
    includeSelectedFallback,
  }).map(({ context_window, ...metadata }) => metadata);
}
