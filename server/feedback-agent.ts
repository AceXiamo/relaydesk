import WebSocket from "ws";
import { z } from "zod";
import { ApiError } from "./errors.ts";
import { readProjectCliSettings } from "./project-cli-config.ts";
import type { Store } from "./store.ts";
import {
  MAX_WIRE,
  systemPrompt,
  publicPrompt,
  validTurn,
  validFeedbackModel,
  type Inference,
  type FeedbackRuntime,
} from "./feedback-protocol.ts";

const modelId = z.string().refine(validFeedbackModel);
const configSchema = z.strictObject({
  enabled: z.boolean(),
  runtime: z.enum(["codex", "claude"]),
  model: z.union([z.literal(""), modelId]),
  public_guide: z.string().trim().max(12000),
});
type Config = z.infer<typeof configSchema>;
const defaults: Config = {
  enabled: false,
  runtime: "codex",
  model: "",
  public_guide: "",
};
const unavailable = () =>
  new ApiError(503, "安全反馈执行器暂不可用，可以稍后重试或直接提交反馈。");
const disabled = () =>
  new ApiError(409, "项目未启用可用的反馈 Agent，可以直接提交反馈。");
// Local integration harnesses can select only a numeric loopback port, not an arbitrary host.
function runnerAddress() {
  const local = process.env.RELAYDESK_FEEDBACK_LOOPBACK_PORT;
  if (local !== undefined && !/^[1-9]\d{0,4}$/.test(local)) throw unavailable();
  return local === undefined ? "feedback-runner:8790" : `127.0.0.1:${local}`;
}
const token = () =>
  /^[a-f0-9]{64}$/.test(process.env.RELAYDESK_FEEDBACK_TOKEN || "")
    ? process.env.RELAYDESK_FEEDBACK_TOKEN!
    : null;
const readCli = (s: Store, id: string) => readProjectCliSettings(s.dbPath, id);
function hasSecret(value: string, secrets: (string | undefined | null)[]) {
  return (
    /\b(?:sk-|gh[pousr]_|github_pat_|rdbr_|xox[baprs]-)[a-z\d_-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[\w.+/=-]{12,}|\b(?:AKIA|ASIA)[A-Z\d]{16}\b|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{6,}/i.test(
      value,
    ) || secrets.some((s) => s && value.includes(s))
  );
}
function safeFields(
  store: Store,
  id: string,
  cfg: Config,
  cli: ReturnType<typeof readCli>,
) {
  const row = store.getProjectRow(id);
  return ![cfg.public_guide, cfg.model].some((v) =>
    hasSecret(v, [
      row.agent_key,
      row.intake_key,
      row.bot_key,
      cli.api_key,
      cli.github_token,
      token(),
    ]),
  );
}
export function getFeedbackAgent(store: Store, projectId: string): Config {
  store.getProjectRow(projectId);
  const row = store.db
    .prepare(
      "SELECT enabled,runtime,model,public_guide FROM feedback_agents WHERE project_id=?",
    )
    .get(projectId);
  if (!row) return { ...defaults };
  const cfg = configSchema.parse({ ...row, enabled: row.enabled === 1 });
  if (!safeFields(store, projectId, cfg, readCli(store, projectId)))
    throw new ApiError(409, "反馈配置包含不可公开的内容，请清除或重新配置。");
  return cfg;
}
function binding(cli: ReturnType<typeof readCli>, cfg: Config) {
  if (!cfg.model || cli.runtime !== cfg.runtime || !cli.api_key) return null;
  const origin =
    cfg.runtime === "codex"
      ? "https://api.openai.com"
      : "https://api.anthropic.com";
  const endpoint = cli.endpoint || origin;
  let base: string;
  if (endpoint === origin || endpoint === origin + "/v1") base = origin + "/v1";
  else {
    // Admin deployment policy, never sourced from the visitor, project prompt or model.
    try {
      const allow: unknown = JSON.parse(
        process.env.RELAYDESK_FEEDBACK_GATEWAYS || "{}",
      );
      const list = (allow as Partial<Record<FeedbackRuntime, unknown>>)?.[
        cfg.runtime
      ];
      if (
        !Array.isArray(list) ||
        !list.includes(endpoint) ||
        !endpoint.startsWith("https://")
      )
        return null;
    } catch {
      return null;
    }
    base = cfg.runtime === "claude" ? endpoint + "/v1" : endpoint;
  }
  return {
    url: base + (cfg.runtime === "codex" ? "/responses" : "/messages"),
    key: cli.api_key,
  };
}
export function patchFeedbackAgent(
  store: Store,
  projectId: string,
  body: unknown,
): Config {
  const changes = configSchema.partial().safeParse(body);
  if (!changes.success || !Object.keys(changes.data).length)
    throw new ApiError(400, "反馈 Agent 设置无效。");
  return store.transaction(true, () => {
    const current = store.db
      .prepare(
        "SELECT enabled,runtime,model,public_guide FROM feedback_agents WHERE project_id=?",
      )
      .get(projectId);
    const cfg = configSchema.parse({
      ...defaults,
      ...current,
      enabled: current?.enabled === 1,
      ...changes.data,
    });
    const cli = readCli(store, projectId);
    if (!safeFields(store, projectId, cfg, cli))
      throw new ApiError(400, "请勿在公开指引或模型名称中填写凭据。");
    if (cfg.enabled) {
      if (!token())
        throw new ApiError(409, "请先由部署管理员配置独立反馈执行器。");
      if (!binding(cli, cfg))
        throw new ApiError(
          409,
          "请填写反馈模型，并配置同运行时的项目云端 API Key。仅允许官方端点或部署管理员批准的网关。",
        );
    }
    store.db
      .prepare(
        `INSERT INTO feedback_agents(project_id,enabled,runtime,model,public_guide) VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,runtime=excluded.runtime,model=excluded.model,public_guide=excluded.public_guide`,
      )
      .run(projectId, +cfg.enabled, cfg.runtime, cfg.model, cfg.public_guide);
    return cfg;
  });
}
let healthCache:
  { key: string; expires: number; ready: Promise<boolean> } | undefined;
export async function feedbackAgentAvailable(
  store: Store,
  projectId: string,
): Promise<boolean> {
  try {
    const cfg = getFeedbackAgent(store, projectId),
      key = token();
    if (!cfg.enabled || !key || !binding(readCli(store, projectId), cfg))
      return false;
    if (
      !healthCache ||
      healthCache.key !== key ||
      healthCache.expires <= Date.now()
    ) {
      const ready = fetch(`http://${runnerAddress()}/health`, {
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal: AbortSignal.timeout(1500),
      })
        .then(async (r) => r.ok && (await r.text()) === "feedback-cli-v1")
        .catch(() => false);
      healthCache = { key, ready, expires: Date.now() + 3000 };
    }
    return await healthCache.ready;
  } catch {
    return false;
  }
}
const message = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string().trim().min(1).max(6000),
});
const requestSchema = z.strictObject({
  messages: z.array(message).min(1).max(25),
  images: z.array(z.string().max(2048)).max(8).optional(),
});
function visitorInput(data: unknown) {
  const parsed = requestSchema.safeParse(data);
  if (!parsed.success) throw new ApiError(400, "请提供有效的对话记录和附件。");
  const { messages, images = [] } = parsed.data;
  if (
    messages.at(-1)!.role !== "user" ||
    messages.reduce((n, m) => n + m.text.length, 0) > 32000 ||
    messages.some((m, i) => m.role !== (i % 2 ? "assistant" : "user"))
  )
    throw new ApiError(
      400,
      "对话必须从访客发言开始，交替发送，并以当前问题结束。",
    );
  for (const s of images) {
    try {
      const u = new URL(s);
      if (
        !["https:", "http:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash
      )
        throw Error();
    } catch {
      throw new ApiError(400, "请提供不含凭据的已上传截图地址。");
    }
  }
  return { messages, attachment_count: images.length }; // Never fetch attachment URLs or disclose them to the model.
}
const nonempty = (n: number) => z.string().trim().min(1).max(n);
const reply = nonempty(4000),
  quote = nonempty(1000);
const answer = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("clarify"), reply }),
  z.strictObject({ outcome: z.literal("usage"), reply, guide_quote: quote }),
  z.strictObject({
    outcome: z.literal("suspected_bug"),
    reply,
    guide_quote: quote,
    steps_quote: quote,
    observed_quote: quote,
    draft: z.strictObject({ title: nonempty(160), body: nonempty(4000) }),
  }),
]);
type Diagnosis = {
  reply: string;
  outcome: "clarify" | "usage" | "suspected_bug";
  draft?: { title: string; body: string };
};
function diagnosis(
  result: string,
  input: ReturnType<typeof visitorInput>,
  guide: string,
): Diagnosis {
  const a = answer.parse(JSON.parse(result));
  const hasUserQuote = (s: string) =>
    input.messages.some((m) => m.role === "user" && m.text.includes(s));
  if (
    a.outcome !== "clarify" &&
    (!guide.includes(a.guide_quote) ||
      (a.outcome === "suspected_bug" &&
        (!hasUserQuote(a.steps_quote) ||
          !hasUserQuote(a.observed_quote) ||
          a.steps_quote === a.observed_quote)))
  )
    return {
      outcome: "clarify",
      reply:
        "为了区分使用方式和产品异常，你是按哪些步骤操作的？预期和实际看到的结果分别是什么？",
    };
  return {
    reply: a.reply,
    outcome: a.outcome,
    ...(a.outcome === "suspected_bug" ? { draft: a.draft } : {}),
  };
}
async function upstream(
  cfg: Config,
  auth: { url: string; key: string },
  request: Inference,
  signal: AbortSignal,
) {
  const codex = cfg.runtime === "codex";
  const req = codex
    ? {
        model: cfg.model,
        store: false,
        instructions: request.instructions,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: request.prompt }],
          },
        ],
        max_output_tokens: 3000,
      }
    : {
        model: cfg.model,
        system: request.instructions,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: 3000,
      };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(codex
      ? { authorization: `Bearer ${auth.key}` }
      : { "x-api-key": auth.key, "anthropic-version": "2023-06-01" }),
  } as Record<string, string>;
  const r = await fetch(auth.url, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
    signal,
    redirect: "error",
  });
  if (!r.ok || !r.body) {
    await r.body?.cancel();
    throw unavailable();
  }
  const reader = r.body.getReader(),
    chunks: Buffer[] = [];
  let n = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if ((n += value.length) > MAX_WIRE) {
      await reader.cancel();
      throw unavailable();
    }
    chunks.push(Buffer.from(value));
  }
  const json = JSON.parse(Buffer.concat(chunks).toString());
  if (codex) {
    if (
      json.status !== "completed" ||
      !Array.isArray(json.output) ||
      json.output.some((i: any) => !["reasoning", "message"].includes(i?.type))
    )
      throw unavailable();
    const msgs = json.output.filter((i: any) => i.type === "message");
    if (
      msgs.length !== 1 ||
      msgs[0].role !== "assistant" ||
      !Array.isArray(msgs[0].content) ||
      msgs[0].content.length !== 1 ||
      msgs[0].content[0]?.type !== "output_text"
    )
      throw unavailable();
    return msgs[0].content[0].text;
  }
  if (
    json.type !== "message" ||
    json.role !== "assistant" ||
    json.stop_reason !== "end_turn" ||
    !Array.isArray(json.content) ||
    json.content.length !== 1 ||
    json.content[0]?.type !== "text"
  )
    throw unavailable();
  return json.content[0].text;
}

export async function diagnoseFeedback(
  store: Store,
  projectId: string,
  data: unknown,
  signal?: AbortSignal,
): Promise<Diagnosis> {
  const cfg = getFeedbackAgent(store, projectId),
    serviceToken = token();
  if (!cfg.enabled || !serviceToken) throw disabled();
  const cli = readCli(store, projectId),
    auth = binding(cli, cfg);
  if (!auth) throw disabled();
  const input = visitorInput(data),
    prompt = publicPrompt({ public_guide: cfg.public_guide, ...input });
  const turn = { runtime: cfg.runtime, model: cfg.model, prompt };
  if (!validTurn(turn))
    throw new ApiError(413, "公开指引和对话过长，请缩短后再试。");
  const row = store.getProjectRow(projectId),
    secrets = [
      serviceToken,
      auth.key,
      cli.github_token,
      row.bot_key,
      row.agent_key,
      row.intake_key,
    ];
  if (input.messages.some((m) => hasSecret(m.text, secrets)))
    throw new ApiError(400, "对话中可能包含凭据，请移除敏感信息后再试。");
  const controller = new AbortController();
  const stop = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(58_000),
    ...(signal ? [signal] : []),
  ]);
  try {
    stop.throwIfAborted();
    return await new Promise<Diagnosis>((resolve, reject) => {
      const ws = new WebSocket(`ws://${runnerAddress()}/turn`, {
        headers: { Authorization: `Bearer ${serviceToken}` },
        followRedirects: false,
        handshakeTimeout: 2000,
        maxPayload: MAX_WIRE,
        perMessageDeflate: false,
      });
      const close = () => {
        ws.terminate();
        reject(unavailable());
      };
      let claimed = false,
        result: Diagnosis | undefined;
      stop.addEventListener("abort", close, { once: true });
      ws.once("error", () => reject(unavailable()));
      ws.once("close", () => {
        stop.removeEventListener("abort", close);
        reject(unavailable());
      });
      ws.once("open", () =>
        ws.send(JSON.stringify({ type: "start", ...turn })),
      );
      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "done" && result) {
            resolve(result);
            ws.close();
            return;
          }
          if (
            msg.type !== "infer" ||
            claimed ||
            msg.request?.prompt !== prompt ||
            msg.request?.instructions !== systemPrompt ||
            msg.model !== cfg.model
          )
            throw unavailable();
          claimed = true;
          const text = await upstream(cfg, auth, msg.request, stop);
          if (typeof text !== "string" || hasSecret(text, secrets))
            throw unavailable();
          const validated = diagnosis(text, input, cfg.public_guide);
          // Compare decoded strings too: JSON escapes must not conceal a returned credential.
          if (
            [
              validated.reply,
              validated.draft?.title,
              validated.draft?.body,
            ].some((field) => field && hasSecret(field, secrets))
          )
            throw unavailable();
          result = validated;
          ws.send(JSON.stringify({ type: "text", text }));
        } catch {
          close();
        }
      });
    });
  } catch {
    throw unavailable();
  } finally {
    controller.abort();
  }
}
