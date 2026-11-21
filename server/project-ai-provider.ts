import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { readProjectCliSettings } from "./project-cli-config.ts";

// Only the isolated CLI may use a custom endpoint. Public requests never resolve
// a project-supplied hostname or follow a provider redirect with credentials.
const OFFICIAL = {
  codex: { origin: "https://api.openai.com", defaultModel: "gpt-4.1-mini" },
  claude: { origin: "https://api.anthropic.com", defaultModel: "claude-sonnet-5-5" },
} as const;

function publicAiConfig(dbPath: string, projectId: string) {
  let settings: ReturnType<typeof readProjectCliSettings>;
  try {
    settings = readProjectCliSettings(dbPath, projectId);
  } catch {
    // A missing or unreadable configuration must not prevent manual feedback.
    return null;
  }
  if (!settings.public_ai_enabled || !settings.api_key.trim()) return null;
  const { origin, defaultModel } = OFFICIAL[settings.runtime];
  const baseURL = `${origin}/v1`;
  const endpoint = settings.endpoint.trim().replace(/\/+$/, "");
  if (endpoint && endpoint !== baseURL && endpoint !== origin) return null;
  return { runtime: settings.runtime, baseURL, apiKey: settings.api_key.trim(), model: settings.model.trim() || defaultModel };
}

export function projectPublicAiEnabled(dbPath: string, projectId: string): boolean {
  return publicAiConfig(dbPath, projectId) !== null;
}

export function projectPublicAiModel(dbPath: string, projectId: string) {
  const config = publicAiConfig(dbPath, projectId);
  if (!config) return null;
  const options = {
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    fetch: (url: RequestInfo | URL, init?: RequestInit) => fetch(url, { ...init, redirect: "error" }),
  };
  return config.runtime === "codex"
    ? createOpenAI(options).responses(config.model)
    : createAnthropic(options).messages(config.model);
}
