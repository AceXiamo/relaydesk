export type EditorBlock =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "code"; lang: string; code: string };

export type RichLineBlockType = "p" | "quote" | "ul" | "ol" | "task" | "h";

export interface ParsedRichLine {
  type: RichLineBlockType;
  content: string;
  depth?: number;
  indent?: number;
  bullet?: "-" | "*" | "+";
  order?: number;
  checked?: boolean;
  level?: number;
}

export interface InlineToken {
  type: "text" | "code" | "bold" | "italic" | "strike";
  text: string;
}

export const ZERO_WIDTH = "​";

let nextBlockId = 1;
export function makeBlockId(prefix: "t" | "c"): string {
  nextBlockId += 1;
  return `${prefix}-${nextBlockId}`;
}

function clampInt(val: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof val !== "number" || !Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(val)));
}

function countIndentSpaces(ws: string): number {
  let count = 0;
  for (const ch of ws) {
    count += ch === "\t" ? 2 : 1;
  }
  return count;
}

export function parseRichLine(rawLine: string): ParsedRichLine {
  const taskMatch = /^([ \t]*)([-*+])[ \u00A0]\[([ xX])\][ \u00A0](.*)$/.exec(rawLine);
  if (taskMatch) {
    return {
      type: "task",
      indent: Math.min(3, Math.floor(countIndentSpaces(taskMatch[1] ?? "") / 2)),
      checked: (taskMatch[3] ?? "").toLowerCase() === "x",
      content: taskMatch[4] ?? "",
    };
  }

  const ulMatch = /^([ \t]*)([-*+])[ \u00A0](.*)$/.exec(rawLine);
  if (ulMatch) {
    return {
      type: "ul",
      indent: Math.min(3, Math.floor(countIndentSpaces(ulMatch[1] ?? "") / 2)),
      bullet: (ulMatch[2] as "-" | "*" | "+") ?? "-",
      content: ulMatch[3] ?? "",
    };
  }

  const olMatch = /^([ \t]*)(\d{1,3})\.[ \u00A0](.*)$/.exec(rawLine);
  if (olMatch) {
    return {
      type: "ol",
      indent: Math.min(3, Math.floor(countIndentSpaces(olMatch[1] ?? "") / 2)),
      order: Math.max(1, Number.parseInt(olMatch[2] ?? "1", 10) || 1),
      content: olMatch[3] ?? "",
    };
  }

  const quoteMatch = /^((?:>[ \u00A0]?){0,2}>)[ \u00A0](.*)$/.exec(rawLine);
  if (quoteMatch) {
    const depth = Math.min(3, Math.max(1, (quoteMatch[1]?.match(/>/g) ?? []).length));
    return {
      type: "quote",
      depth,
      content: quoteMatch[2] ?? "",
    };
  }

  const headingMatch = /^(#{1,4})[ \u00A0](.*)$/.exec(rawLine);
  if (headingMatch) {
    return {
      type: "h",
      level: clampInt(headingMatch[1]?.length, 1, 4, 1),
      content: headingMatch[2] ?? "",
    };
  }

  return { type: "p", content: rawLine };
}

export function formatRichLinePrefix(line: Omit<ParsedRichLine, "content">): string {
  switch (line.type) {
    case "quote":
      return `${">".repeat(clampInt(line.depth, 1, 3, 1))} `;
    case "ul":
      return `${"  ".repeat(clampInt(line.indent, 0, 3, 0))}${line.bullet ?? "-"} `;
    case "ol":
      return `${"  ".repeat(clampInt(line.indent, 0, 3, 0))}${Math.max(1, Math.trunc(line.order ?? 1))}. `;
    case "task":
      return `${"  ".repeat(clampInt(line.indent, 0, 3, 0))}- [${line.checked ? "x" : " "}] `;
    case "h":
      return `${"#".repeat(clampInt(line.level, 1, 4, 1))} `;
    case "p":
    default:
      return "";
  }
}

export function serializeRichLine(line: ParsedRichLine): string {
  return `${formatRichLinePrefix(line)}${line.content}`;
}

export function tokenizeInlineMarkdown(content: string): InlineToken[] {
  if (!content) return [];
  const tokens: InlineToken[] = [];
  let plainBuf = "";

  const flushPlain = () => {
    if (plainBuf) {
      if (tokens.length > 0 && tokens[tokens.length - 1]!.type === "text") {
        tokens[tokens.length - 1]!.text += plainBuf;
      } else {
        tokens.push({ type: "text", text: plainBuf });
      }
      plainBuf = "";
    }
  };

  const codeRe = /`([^`\n]+)`/y;
  const boldRe = /\*\*([^\s*\n](?:[^*\n]*[^\s*\n])?)\*\*/y;
  const strikeRe = /~~([^\s~\n](?:[^~\n]*[^\s~\n])?)~~/y;
  const italicRe = /\*([^\s*\n](?:[^*\n]*[^\s*\n])?)\*/y;

  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;

    if (ch === "`") {
      codeRe.lastIndex = i;
      const m = codeRe.exec(content);
      if (m && m[1]) {
        flushPlain();
        tokens.push({ type: "code", text: m[1] });
        i = codeRe.lastIndex;
        continue;
      }
    }

    if (ch === "*" && content[i + 1] === "*") {
      boldRe.lastIndex = i;
      const m = boldRe.exec(content);
      if (m && m[1]) {
        flushPlain();
        tokens.push({ type: "bold", text: m[1] });
        i = boldRe.lastIndex;
        continue;
      }
    }

    if (ch === "~" && content[i + 1] === "~") {
      strikeRe.lastIndex = i;
      const m = strikeRe.exec(content);
      if (m && m[1]) {
        flushPlain();
        tokens.push({ type: "strike", text: m[1] });
        i = strikeRe.lastIndex;
        continue;
      }
    }

    if (ch === "*") {
      const prevChar = i > 0 ? content[i - 1]! : "";
      if (!/[A-Za-z0-9_*]/.test(prevChar)) {
        italicRe.lastIndex = i;
        const m = italicRe.exec(content);
        if (m && m[1]) {
          const nextChar = content[italicRe.lastIndex] ?? "";
          if (!/[A-Za-z0-9_*]/.test(nextChar)) {
            flushPlain();
            tokens.push({ type: "italic", text: m[1] });
            i = italicRe.lastIndex;
            continue;
          }
        }
      }
    }

    plainBuf += ch;
    i += 1;
  }

  flushPlain();
  return tokens;
}

export function ensureTextBoundaries(blocks: EditorBlock[]): EditorBlock[] {
  if (blocks.length === 0) {
    return [{ id: makeBlockId("t"), type: "text", text: "" }];
  }
  const out: EditorBlock[] = [];
  for (const block of blocks) {
    if (block.type === "code") {
      if (out.length === 0 || out[out.length - 1]?.type === "code") {
        out.push({ id: makeBlockId("t"), type: "text", text: "" });
      }
      out.push(block);
    } else {
      const prev = out[out.length - 1];
      if (prev && prev.type === "text") {
        const merged =
          prev.text && block.text ? `${prev.text}\n${block.text}` : prev.text || block.text;
        out[out.length - 1] = { ...prev, text: merged };
      } else {
        out.push(block);
      }
    }
  }
  if (out[out.length - 1]?.type === "code") {
    out.push({ id: makeBlockId("t"), type: "text", text: "" });
  }
  return out;
}

export function parseMarkdownToBlocks(markdown: string): EditorBlock[] {
  if (!markdown) {
    return [{ id: makeBlockId("t"), type: "text", text: "" }];
  }

  const normalized = markdown.replace(/\r\n/g, "\n");
  const blocks: EditorBlock[] = [];
  const fenceRe = /^```([a-zA-Z0-9_+-]*)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(normalized)) !== null) {
    const before = normalized.slice(lastIndex, match.index).replace(/\n$/, "");
    blocks.push({ id: makeBlockId("t"), type: "text", text: before });
    const lang = (match[1] ?? "").trim();
    const code = (match[2] ?? "").replace(/\n$/, "");
    blocks.push({ id: makeBlockId("c"), type: "code", lang, code });
    lastIndex = fenceRe.lastIndex;
    if (normalized[lastIndex] === "\n") {
      lastIndex += 1;
    }
  }

  const tail = normalized.slice(lastIndex);
  blocks.push({ id: makeBlockId("t"), type: "text", text: tail });

  return ensureTextBoundaries(blocks);
}

export function serializeBlocksToMarkdown(blocks: EditorBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      const clean = block.text.replaceAll(ZERO_WIDTH, "");
      if (clean) {
        parts.push(clean);
      }
    } else {
      const lang = block.lang.trim().replace(/[^a-zA-Z0-9_+-]/g, "");
      const code = block.code.replace(/\r\n/g, "\n");
      parts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
    }
  }
  return parts.join("\n");
}

export function preserveSoftLineBreaks(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  let inMathBlock = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (!inFence && /^\$\$\s*$/.test(trimmed)) {
      inMathBlock = !inMathBlock;
      out.push(line);
      continue;
    }

    if (inFence || inMathBlock) {
      out.push(line);
      continue;
    }

    const next = lines[i + 1];
    const nextTrimmed = next?.trim() ?? "";
    const bothNonEmptyQuotes =
      /^>+\s+\S/.test(trimmed) && /^>+\s+\S/.test(nextTrimmed);
    const quoteBoundary =
      !bothNonEmptyQuotes && (/^>\s?/.test(trimmed) || /^>\s?/.test(nextTrimmed));
    const alertHeaderRe = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
    const isBlockBoundary =
      !trimmed ||
      !nextTrimmed ||
      /^```/.test(nextTrimmed) ||
      /^\$\$/.test(trimmed) ||
      /^\$\$/.test(nextTrimmed) ||
      alertHeaderRe.test(trimmed) ||
      alertHeaderRe.test(nextTrimmed) ||
      /^#{1,6}\s/.test(trimmed) ||
      /^#{1,6}\s/.test(nextTrimmed) ||
      quoteBoundary ||
      /^\|.*\|$/.test(trimmed) ||
      /^\|.*\|$/.test(nextTrimmed) ||
      /^([-*_])\1{2,}$/.test(trimmed) ||
      /^([-*_])\1{2,}$/.test(nextTrimmed) ||
      /^\s*([-*+]|\d+\.)\s+/.test(next);

    if (next !== undefined && !isBlockBoundary && !line.endsWith("  ")) {
      out.push(`${line}  `);
    } else {
      out.push(line);
    }
  }

  return out.join("\n");
}
