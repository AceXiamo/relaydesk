import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteStoredUtilityAiConfig,
  getEffectiveUtilityAiConfig,
  readStoredUtilityAiConfig,
  saveStoredUtilityAiConfig,
  toUtilityAiConfigStatus,
  validateUtilityAiEndpoint,
  validateUtilityAiModel,
  validateUtilityAiProvider,
} from "../server/utility-ai-config.ts";
import { buildFallbackSessionTitle, sanitizeGeneratedTitle } from "../server/utility-ai.ts";
import {
  parseMarkdownToBlocks,
  parseRichLine,
  preserveSoftLineBreaks,
  serializeBlocksToMarkdown,
  serializeRichLine,
  tokenizeInlineMarkdown,
} from "../app/lib/chat-markdown.ts";

describe("utility AI global config & title helpers", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relaydesk-utility-ai-"));
    dbPath = join(dir, "state.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists global utility AI settings with 0600 permissions and redacts API key in status", () => {
    saveStoredUtilityAiConfig(dbPath, {
      provider: "openai",
      endpoint: "https://api.deepseek.com/v1",
      api_key: "sk-1234567890abcdef",
      model: "deepseek-chat",
    });

    const stored = readStoredUtilityAiConfig(dbPath);
    expect(stored).toEqual({
      provider: "openai",
      endpoint: "https://api.deepseek.com/v1",
      api_key: "sk-1234567890abcdef",
      model: "deepseek-chat",
    });
    expect(statSync(join(dir, ".utility-ai-config.json")).mode & 0o777).toBe(0o600);

    const status = toUtilityAiConfigStatus(getEffectiveUtilityAiConfig(dbPath, {}));
    expect(status.configured).toBe(true);
    expect(status.source).toBe("workspace");
    expect(status.has_api_key).toBe(true);
    expect(status.api_key_preview).toBe("sk-1••••cdef");
    expect(JSON.stringify(status)).not.toContain("sk-1234567890abcdef");

    deleteStoredUtilityAiConfig(dbPath);
    expect(getEffectiveUtilityAiConfig(dbPath, {}).source).toBe("none");
  });

  it("validates provider, endpoint, and model cleanly", () => {
    expect(validateUtilityAiProvider("openai")).toBe("openai");
    expect(validateUtilityAiProvider("anthropic")).toBe("anthropic");
    expect(() => validateUtilityAiProvider("invalid")).toThrow();

    expect(validateUtilityAiEndpoint("")).toBe("");
    expect(validateUtilityAiEndpoint("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(validateUtilityAiEndpoint("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/v1");
    expect(() => validateUtilityAiEndpoint("http://api.example.com/v1")).toThrow();
    expect(() => validateUtilityAiEndpoint("https://user:pass@api.example.com")).toThrow();

    expect(validateUtilityAiModel("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(() => validateUtilityAiModel("")).toThrow();
    expect(() => validateUtilityAiModel("--bad")).toThrow();
  });

  it("generates clean fallback session titles without raw fences, IPs, or passwords", () => {
    const iniMsg = '```ini\n[client]\nhost="58.210.56.219"\npassword="supersecret"\n```';
    const iniTitle = buildFallbackSessionTitle(iniMsg);
    expect(iniTitle).not.toContain("```");
    expect(iniTitle).not.toContain("58.210.56.219");
    expect(iniTitle).not.toContain("supersecret");
    expect(iniTitle).toBe("MySQL 数据库配置");

    const proseWithCode = "帮我检查这个登录接口为什么报错\n```ts\nconsole.log(1)\n```";
    expect(buildFallbackSessionTitle(proseWithCode)).toBe("帮我检查这个登录接口为什么报错");
  });

  it("sanitizes LLM generated titles", () => {
    expect(sanitizeGeneratedTitle("标题：「配置 MySQL 连接文件」。\n附加说明")).toBe(
      "配置 MySQL 连接文件",
    );
    expect(sanitizeGeneratedTitle('"`Fix sidebar collapse`"')).toBe("Fix sidebar collapse");
  });

  it("parses and round-trips markdown blocks in RichPromptEditor", () => {
    const md = "看看这个配置：\n```ini\n[client]\nhost=127.0.0.1\n```\n然后帮我写入 `files/db.cnf`";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks.filter((b) => b.type === "code")).toHaveLength(1);
    expect(serializeBlocksToMarkdown(blocks)).toBe(md);
  });

  it("preserves soft line breaks in prose and consecutive quote lines without touching fenced code or math blocks", () => {
    const input = "第一行\n第二行\n```bash\necho a\necho b\n```\n$$\na + b\nc + d\n$$";
    const out = preserveSoftLineBreaks(input);
    expect(out).toBe("第一行  \n第二行\n```bash\necho a\necho b\n```\n$$\na + b\nc + d\n$$");

    const quoteInput = "> 引用第一行\n> 引用第二行\n>\n>> 嵌套一\n>> 嵌套二";
    expect(preserveSoftLineBreaks(quoteInput)).toBe(
      "> 引用第一行  \n> 引用第二行\n>\n>> 嵌套一  \n>> 嵌套二",
    );

    const alertInput = "> [!NOTE]\n> 提示第一行\n> 提示第二行";
    expect(preserveSoftLineBreaks(alertInput)).toBe(
      "> [!NOTE]\n> 提示第一行  \n> 提示第二行",
    );
  });

  it("parses, serializes, and tokenizes rich markdown lines and inline tokens", () => {
    const lines = [
      "# 一级标题",
      "#### 四级标题",
      "> 一级引用",
      ">>\u00A0二级引用",
      "- 无序列表",
      "  * 缩进无序",
      "3. 自定义编号",
      "  1. 嵌套编号",
      "- [ ] 待办",
      "  - [x] 已完成",
      "#tag",
      ">= 10",
    ];
    const parsed = lines.map(parseRichLine);
    expect(parsed[0]).toEqual({ type: "h", level: 1, content: "一级标题" });
    expect(parsed[1]).toEqual({ type: "h", level: 4, content: "四级标题" });
    expect(parsed[2]).toEqual({ type: "quote", depth: 1, content: "一级引用" });
    expect(parsed[3]).toEqual({ type: "quote", depth: 2, content: "二级引用" });
    expect(parsed[4]).toEqual({ type: "ul", indent: 0, bullet: "-", content: "无序列表" });
    expect(parsed[5]).toEqual({ type: "ul", indent: 1, bullet: "*", content: "缩进无序" });
    expect(parsed[6]).toEqual({ type: "ol", indent: 0, order: 3, content: "自定义编号" });
    expect(parsed[7]).toEqual({ type: "ol", indent: 1, order: 1, content: "嵌套编号" });
    expect(parsed[8]).toEqual({ type: "task", indent: 0, checked: false, content: "待办" });
    expect(parsed[9]).toEqual({ type: "task", indent: 1, checked: true, content: "已完成" });
    expect(parsed[10]).toEqual({ type: "p", content: "#tag" });
    expect(parsed[11]).toEqual({ type: "p", content: ">= 10" });

    expect(serializeRichLine(parsed[3]!)).toBe(">> 二级引用");
    expect(serializeRichLine(parsed[9]!)).toBe("  - [x] 已完成");

    expect(tokenizeInlineMarkdown("普通 `code` **bold** *italic* ~~del~~ 2*3*4")).toEqual([
      { type: "text", text: "普通 " },
      { type: "code", text: "code" },
      { type: "text", text: " " },
      { type: "bold", text: "bold" },
      { type: "text", text: " " },
      { type: "italic", text: "italic" },
      { type: "text", text: " " },
      { type: "strike", text: "del" },
      { type: "text", text: " 2*3*4" },
    ]);
  });
});
