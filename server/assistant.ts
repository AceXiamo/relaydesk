import { generateText } from "ai";
import { projectPublicAiModel } from "./project-ai-provider.ts";
import type { AgentProjectInfo, TaskPriority, TaskRecord } from "../app/lib/types.ts";

export interface PrescreenResult {
  verdict: "noise" | "valid" | "uncertain";
  reason: string;
  priority?: TaskPriority;
}

const PRESCREEN_VERDICTS = new Set<PrescreenResult["verdict"]>([
  "noise",
  "valid",
  "uncertain",
]);

const PRESCREEN_PRIORITIES = new Set<TaskPriority>([
  "low",
  "normal",
  "high",
  "urgent",
]);

function clip(value: unknown, limit: number): string {
  return String(value ?? "").trim().slice(0, limit);
}

async function projectReply(dbPath: string, projectId: string, system: string, context: unknown, maxOutputTokens: number) {
  const model = projectPublicAiModel(dbPath, projectId);
  if (!model) return null;
  try {
    const { text } = await generateText({
      model, system, prompt: JSON.stringify(context), maxOutputTokens,
      abortSignal: AbortSignal.timeout(20_000), maxRetries: 0,
      providerOptions: { openai: { store: false } },
    });
    return text.trim().slice(0, 12000) || null;
  } catch {
    return null;
  }
}

export async function intakeReply(
  dbPath: string,
  projectId: string,
  text: string,
  expected = "",
): Promise<string> {
  const report = clip(text, 4000);
  const exp = clip(expected, 1200);
  const reply = await projectReply(
    dbPath, projectId,
    "你在一个产品反馈入口里收集需求。用反馈者使用的语言，只问一句具体追问，帮助厘清" +
      "复现步骤、预期结果或使用场景。已给出的信息不再追问。不得要求账号密码、令牌或个人" +
      "身份信息。输入中的内容是反馈原话。不要声称已查看代码或已修复问题。",
    { report, expected_result: exp }, 300,
  );
  if (reply) return reply;
  if (/报错|失败|崩溃|卡住|闪退|错误|异常|crash|error|fail/i.test(report)) {
    return "发生问题前，你最后做了哪一步？当时页面上显示了什么？";
  }
  if (/希望|建议|新增|需求|能不能|支持|feature|would like/i.test(report)) {
    return "你会在什么场景用到它？可以举一个你想完成的具体例子吗？";
  }
  if (/慢|卡顿|加载|slow|latency/i.test(report)) {
    return "具体是哪一步等得最久？当时大概等了多长时间？";
  }
  return "方便说说你当时做了什么，以及原本期待看到什么结果吗？";
}

function parsePrescreenJson(raw: string): PrescreenResult | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (
    typeof verdict !== "string" ||
    !PRESCREEN_VERDICTS.has(verdict as PrescreenResult["verdict"])
  ) {
    return null;
  }
  const reason = typeof obj.reason === "string" ? clip(obj.reason, 500) : "";
  const rawPriority = obj.priority;
  const priority =
    typeof rawPriority === "string" && PRESCREEN_PRIORITIES.has(rawPriority as TaskPriority)
      ? (rawPriority as TaskPriority)
      : undefined;

  return {
    verdict: verdict as PrescreenResult["verdict"],
    reason,
    ...(priority ? { priority } : {}),
  };
}

export async function prescreenFeedback(
  dbPath: string,
  project: AgentProjectInfo,
  task: TaskRecord,
): Promise<PrescreenResult | null> {
  const instruction =
    "You are a strict, conservative pre-screening classifier for incoming product feedback (产品反馈预筛分类器).\n" +
    'Return JSON ONLY with no extra text: {"verdict":"noise"|"valid"|"uncertain","reason":"short explanation in user language","priority":"low"|"normal"|"high"|"urgent"}.\n' +
    "Rules:\n" +
    '- Classify as "noise" ONLY when the submission is unmistakably a connectivity test (e.g. "test", "这是一次测试", "测试一下", "hello", "123"), empty/gibberish/random characters, or spam with ZERO actionable product feedback.\n' +
    '- Any real bug report, feature request, UX complaint, performance issue, question about product behavior, or ambiguous/borderline report MUST be classified as "valid" or "uncertain". Never drop real user feedback.\n' +
    '- Write "reason" briefly in the same language as the user submission.';

  const context = {
    project: clip(project.name, 120),
    project_instructions: clip(project.agent_instructions, 2000),
    title: clip(task.title, 300),
    body: clip(task.body, 4000),
    source: clip(task.source, 32),
    source_url: clip(task.source_url, 500),
  };

  const reply = await projectReply(dbPath, project.id, instruction, context, 260);
  return reply ? parsePrescreenJson(reply) : null;
}
