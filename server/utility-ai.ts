import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { ApiError } from "./errors.ts";
import { readProjectCliSettings } from "./project-cli-config.ts";
import {
  getEffectiveUtilityAiConfig,
  isUtilityAiConfigComplete,
  readStoredUtilityAiConfig,
  validateUtilityAiEndpoint,
  validateUtilityAiKey,
  validateUtilityAiModel,
  validateUtilityAiProvider,
  type StoredUtilityAiConfig,
} from "./utility-ai-config.ts";
import type { UtilityAiProvider, UtilityAiTestResult } from "../app/lib/types.ts";

const DEFAULT_ENDPOINTS: Record<UtilityAiProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

const DEFAULT_PROJECT_FALLBACK_MODELS: Record<"codex" | "claude", string> = {
  codex: "gpt-4.1-mini",
  claude: "claude-haiku-5-5",
};

function normalizeBaseUrl(provider: UtilityAiProvider, rawEndpoint: string): string {
  const trimmed = rawEndpoint.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_ENDPOINTS[provider];
  if (provider === "anthropic") {
    const withoutMessages = trimmed.replace(/\/messages$/i, "");
    return /\/v1$/i.test(withoutMessages) ? withoutMessages : `${withoutMessages}/v1`;
  }
  const withoutPath = trimmed
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/responses$/i, "");
  return withoutPath;
}

function buildLanguageModel(config: StoredUtilityAiConfig) {
  const baseURL = normalizeBaseUrl(config.provider, config.endpoint);
  const options = {
    baseURL,
    apiKey: config.api_key.trim(),
  };
  if (config.provider === "anthropic") {
    return createAnthropic(options).messages(config.model.trim());
  }
  // Use Chat Completions API for maximum compatibility with OpenAI-compatible gateways.
  return createOpenAI(options).chat(config.model.trim());
}

export function resolveUtilityAiConfig(
  dbPath: string,
  projectId?: string,
): StoredUtilityAiConfig | null {
  const globalCfg = getEffectiveUtilityAiConfig(dbPath);
  if (isUtilityAiConfigComplete(globalCfg)) {
    return {
      provider: globalCfg.provider,
      endpoint: globalCfg.endpoint,
      api_key: globalCfg.api_key,
      model: globalCfg.model,
    };
  }

  if (projectId) {
    try {
      const cli = readProjectCliSettings(dbPath, projectId);
      if (cli.api_key.trim()) {
        return {
          provider: cli.runtime === "claude" ? "anthropic" : "openai",
          endpoint: cli.endpoint.trim(),
          api_key: cli.api_key.trim(),
          model: cli.model.trim() || DEFAULT_PROJECT_FALLBACK_MODELS[cli.runtime],
        };
      }
    } catch {
      // Ignore unreadable project settings and fall back cleanly.
    }
  }

  return null;
}

export async function testUtilityAiConnection(
  dbPath: string,
  override?: Partial<StoredUtilityAiConfig>,
): Promise<UtilityAiTestResult> {
  const stored = readStoredUtilityAiConfig(dbPath);
  const effective = getEffectiveUtilityAiConfig(dbPath);

  const provider =
    override?.provider !== undefined
      ? validateUtilityAiProvider(override.provider)
      : effective.provider;
  const endpoint =
    override?.endpoint !== undefined
      ? validateUtilityAiEndpoint(override.endpoint)
      : effective.endpoint;
  const model =
    override?.model !== undefined
      ? validateUtilityAiModel(override.model)
      : validateUtilityAiModel(effective.model);

  const rawKey = override?.api_key !== undefined ? validateUtilityAiKey(override.api_key) : "";
  const destinationChanged =
    Boolean(stored?.api_key) &&
    (provider !== stored!.provider || endpoint !== stored!.endpoint);
  const apiKey = rawKey || (!destinationChanged ? effective.api_key : "");

  if (!apiKey) {
    throw new ApiError(
      400,
      destinationChanged
        ? "切换协议或 API 地址时，请重新输入对应的 API Key 再测试。"
        : "请先填写 API Key。",
    );
  }

  const startedAt = Date.now();
  try {
    const languageModel = buildLanguageModel({ provider, endpoint, api_key: apiKey, model });
    const { text } = await generateText({
      model: languageModel,
      prompt: "Reply with OK only.",
      maxOutputTokens: 16,
      abortSignal: AbortSignal.timeout(15_000),
      maxRetries: 0,
    });
    return {
      ok: true,
      provider,
      model,
      latency_ms: Math.max(1, Date.now() - startedAt),
      reply_preview: text.trim().slice(0, 60) || "OK",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "连接测试失败";
    throw new ApiError(502, `模型连通性测试失败：${message.slice(0, 260)}`);
  }
}

function redactSensitiveSnippets(input: string): string {
  return input
    .replace(
      /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*([:=])\s*("[^"]*"|'[^']*'|\S+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]");
}

function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, " ")
    .replace(/```+/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[#>*\-\s]+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildFallbackSessionTitle(content: string): string {
  const raw = content.trim();
  if (!raw) return "新对话";

  // Prefer natural-language prose outside fenced code blocks.
  const withoutFences = raw.replace(/```[\s\S]*?(?:```|$)/g, "\n").trim();
  const proseCandidate = stripMarkdownFormatting(redactSensitiveSnippets(withoutFences));
  if (proseCandidate && proseCandidate.length >= 2) {
    const firstSentence = proseCandidate.split(/[。！？!?\n]/)[0]?.trim() || proseCandidate;
    return firstSentence.slice(0, 28);
  }

  // Content is primarily code or config snippets: infer a clean human label.
  const lower = raw.toLowerCase();
  if (/\[\s*client\s*\]|mysql|mysqldump|innodb|mariadb/i.test(lower)) {
    return "MySQL 数据库配置";
  }
  if (/\b(select|insert|update|delete|create\s+table|alter\s+table)\b/i.test(lower)) {
    return "SQL 查询与数据库分析";
  }
  if (/^\s*\{[\s\S]*\}\s*$/m.test(raw) || /```json\b/i.test(lower)) {
    return "JSON 数据分析";
  }
  if (/dockerfile|docker\s+compose|nginx|systemd/i.test(lower)) {
    return "部署与服务配置";
  }
  const fenceLang = /```([a-zA-Z0-9_+-]+)/.exec(raw)?.[1];
  if (fenceLang) {
    return `${fenceLang.toUpperCase()} 代码讨论`;
  }

  const cleaned = stripMarkdownFormatting(redactSensitiveSnippets(raw));
  return cleaned ? cleaned.slice(0, 24) : "代码与配置讨论";
}

export function sanitizeGeneratedTitle(raw: string): string {
  const firstLine = raw
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "";

  const cleaned = firstLine
    .replace(/^(?:标题|会话标题|Title)\s*[:：]\s*/i, "")
    .replace(/^[#>*\-\s]+/, "")
    .replace(/```+/g, "")
    .replace(/[。！？.!?]+$/, "")
    .replace(/^["'“”‘’「」《》`]+|["'“”‘’「」《》`]+$/g, "")
    .replace(/[。！？.!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, 32);
}

export async function generateSessionTitle(
  dbPath: string,
  params: {
    projectId?: string;
    userMessage: string;
    assistantReply?: string;
  },
): Promise<string | null> {
  const cfg = resolveUtilityAiConfig(dbPath, params.projectId);
  if (!cfg) return null;

  const safeUser = redactSensitiveSnippets(params.userMessage).trim().slice(0, 1800);
  const safeAssistant = params.assistantReply
    ? redactSensitiveSnippets(params.assistantReply).trim().slice(0, 600)
    : "";

  if (!safeUser) return null;

  try {
    const languageModel = buildLanguageModel(cfg);
    const promptParts = [`用户输入：\n${safeUser}`];
    if (safeAssistant) {
      promptParts.push(`助手回复摘要：\n${safeAssistant}`);
    }
    const { text } = await generateText({
      model: languageModel,
      system:
        "你是一个对话会话标题生成器。请根据用户的消息内容，提炼一个简洁、自然、准确的会话标题。\n" +
        "严格要求：\n" +
        "1. 仅输出标题本身，不要加引号、书名号、序号、前缀（如「标题：」）或任何解释。\n" +
        "2. 中文控制在 6–16 个字以内，英文控制在 3–7 个词以内，语言与用户主要语言一致。\n" +
        "3. 绝对不要包含 Markdown 符号（如 ```、#、*）、原始代码片段、IP 地址、密码或密钥。",
      prompt: promptParts.join("\n\n"),
      maxOutputTokens: 48,
      abortSignal: AbortSignal.timeout(12_000),
      maxRetries: 0,
    });
    const sanitized = sanitizeGeneratedTitle(text);
    return sanitized || null;
  } catch {
    return null;
  }
}
