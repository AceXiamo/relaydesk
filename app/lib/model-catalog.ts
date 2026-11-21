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

const levels = ["off", "low", "medium", "high", "max"] as const;
const isLevel = (value: unknown): value is typeof levels[number] => levels.some(level => value === level);

/** Construct a new, bounded wire object; never copy unknown keys or nested configuration. */
export function sanitizeBridgeModels(input: unknown): ModelCatalogItem[] {
  if (!Array.isArray(input)) return [];
  const models = new Map<string, ModelCatalogItem>();
  for (const entry of input) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row: Record<string, unknown> = entry;
    const { id, runtime } = row;
    if (!validCatalogId(id) || !publicText(id, 160) || (runtime !== "claude" && runtime !== "codex")) continue;
    const item: ModelCatalogItem = { id, runtime };
    if (publicText(row.label, 120)) item.label = row.label;
    if (publicText(row.provider, 60)) item.provider = row.provider;
    for (const key of ["context_window", "max_output_tokens"] as const) {
      const n = row[key];
      if (typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 10_000_000) item[key] = n;
    }
    for (const key of ["is_default", "supports_effort"] as const) {
      if (typeof row[key] === "boolean") item[key] = row[key];
    }
    if (Array.isArray(row.effort_levels)) item.effort_levels = [...new Set(row.effort_levels.filter(isLevel))];
    if (isLevel(row.default_effort)) item.default_effort = row.default_effort;
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
];

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
  const suggestions = builtinModels.filter((item) => item.runtime === runtime);
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
