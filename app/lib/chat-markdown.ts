export type EditorBlock =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "code"; lang: string; code: string };

export const ZERO_WIDTH = "​";

let nextBlockId = 1;
export function makeBlockId(prefix: "t" | "c"): string {
  nextBlockId += 1;
  return `${prefix}-${nextBlockId}`;
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

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    const next = lines[i + 1];
    const nextTrimmed = next?.trim() ?? "";
    const isBlockBoundary =
      !trimmed ||
      !nextTrimmed ||
      /^```/.test(nextTrimmed) ||
      /^#{1,6}\s/.test(trimmed) ||
      /^#{1,6}\s/.test(nextTrimmed) ||
      /^>\s?/.test(trimmed) ||
      /^>\s?/.test(nextTrimmed) ||
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
