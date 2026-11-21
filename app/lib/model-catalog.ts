import type { ChatReasoningEffort, ModelCatalogItem } from "./types.ts";

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
