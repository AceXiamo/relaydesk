import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ZERO_WIDTH,
  ensureTextBoundaries,
  formatRichLinePrefix,
  makeBlockId,
  parseMarkdownToBlocks,
  parseRichLine,
  serializeBlocksToMarkdown,
  serializeRichLine,
  tokenizeInlineMarkdown,
  type EditorBlock,
  type ParsedRichLine,
} from "~/lib/chat-markdown.ts";
import { isMobileComposerDevice, useIsMobileComposer } from "~/lib/mobile-input.ts";
import { Icon } from "../Icon.tsx";

export interface RichPromptEditorHandle {
  focus: () => void;
}

export type RichPromptSubmitMode = "enter" | "mod-enter" | "button-only";

type InlineKind = "code" | "bold" | "italic" | "strike";

const INLINE_CODE_CLASS =
  "inline-block align-baseline px-1.5 py-[0.5px] mx-[1px] rounded-[5px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] font-mono text-[12px] leading-[1.45] text-[var(--text-primary)]";

const KNOWN_CODE_LANGS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "bash",
  "sh",
  "zsh",
  "shell",
  "py",
  "python",
  "sql",
  "go",
  "rust",
  "rs",
  "css",
  "scss",
  "html",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "md",
  "markdown",
  "diff",
  "java",
  "c",
  "cpp",
  "swift",
  "kt",
  "kotlin",
  "rb",
  "ruby",
  "php",
  "dockerfile",
  "docker",
  "graphql",
  "text",
  "txt",
]);

function createSentinelBr(): HTMLBRElement {
  const el = document.createElement("br");
  el.dataset.rdSentinel = "true";
  return el;
}

function isSentinelBr(node: Node | null): node is HTMLBRElement {
  return (
    node?.nodeType === Node.ELEMENT_NODE &&
    (node as HTMLElement).tagName === "BR" &&
    (node as HTMLElement).dataset.rdSentinel === "true"
  );
}

function isIgnorableEmptyNode(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replaceAll(ZERO_WIDTH, "").length === 0;
  }
  return isSentinelBr(node);
}

function getInlineElementKind(node: Node | null): InlineKind | null {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as HTMLElement;
  if (el.tagName === "CODE" || el.dataset.inlineCode === "true") return "code";
  if (el.tagName === "STRONG" || el.dataset.inlineBold === "true") return "bold";
  if (el.tagName === "EM" || el.dataset.inlineItalic === "true") return "italic";
  if (el.tagName === "DEL" || el.dataset.inlineStrike === "true") return "strike";
  return null;
}

function isLineElement(node: Node | null): node is HTMLDivElement {
  return (
    node?.nodeType === Node.ELEMENT_NODE &&
    (node as HTMLElement).tagName === "DIV" &&
    (node as HTMLElement).dataset.rdLine === "true"
  );
}

function getLineAncestor(node: Node | null, root: HTMLElement): HTMLDivElement | null {
  let curr: Node | null = node;
  while (curr && curr !== root) {
    if (isLineElement(curr)) return curr;
    curr = curr.parentNode;
  }
  return null;
}

function getInlineFormatAncestor(
  node: Node | null,
  root: HTMLElement,
  onlyCode = false,
): HTMLElement | null {
  let curr: Node | null = node;
  while (curr && curr !== root) {
    if (isLineElement(curr)) break;
    const kind = getInlineElementKind(curr);
    if (kind && (!onlyCode || kind === "code")) {
      return curr as HTMLElement;
    }
    curr = curr.parentNode;
  }
  return null;
}

function getInlineCodeAncestor(node: Node | null, root: HTMLElement): HTMLElement | null {
  return getInlineFormatAncestor(node, root, true);
}

function hasVisibleContentInFragment(frag: Node): boolean {
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let curr: Node | null = walker.nextNode();
  while (curr) {
    if (curr.nodeType === Node.TEXT_NODE) {
      if ((curr.textContent ?? "").replaceAll(ZERO_WIDTH, "").length > 0) return true;
    } else if (curr.nodeType === Node.ELEMENT_NODE) {
      const el = curr as HTMLElement;
      if (el.tagName === "BR" && el.dataset.rdSentinel !== "true") return true;
      if (getInlineElementKind(el) !== null) {
        if ((el.textContent ?? "").replaceAll(ZERO_WIDTH, "").length > 0) return true;
      }
    }
    curr = walker.nextNode();
  }
  return false;
}

function lineHasVisibleContent(lineEl: HTMLElement): boolean {
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let curr: Node | null = walker.nextNode();
  while (curr) {
    if (curr.nodeType === Node.TEXT_NODE) {
      if ((curr.textContent ?? "").replaceAll(ZERO_WIDTH, "").length > 0) return true;
    } else if (curr.nodeType === Node.ELEMENT_NODE) {
      const el = curr as HTMLElement;
      if (getInlineElementKind(el) !== null) {
        if ((el.textContent ?? "").replaceAll(ZERO_WIDTH, "").length > 0) return true;
      }
    }
    curr = walker.nextNode();
  }
  return false;
}

function hasVisibleContentAfter(node: Node, root: HTMLElement): boolean {
  const afterRange = document.createRange();
  afterRange.selectNodeContents(root);
  afterRange.setStartAfter(node);
  return hasVisibleContentInFragment(afterRange.cloneContents());
}

function hasRealBrBefore(node: Node, root: HTMLElement): boolean {
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(root);
  beforeRange.setEndBefore(node);
  const frag = beforeRange.cloneContents();
  const children = Array.from(frag.childNodes);
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const child = children[i]!;
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").replaceAll(ZERO_WIDTH, "").length === 0) continue;
      return false;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      if (el.tagName === "BR" && el.dataset.rdSentinel !== "true") return true;
      return false;
    }
  }
  return false;
}

function cleanupStaleSentinels(root: HTMLElement): void {
  const lineEls = Array.from(root.querySelectorAll("div[data-rd-line='true']")) as HTMLElement[];
  if (lineEls.length > 0) {
    for (const lineEl of lineEls) {
      if (lineHasVisibleContent(lineEl)) {
        for (const s of Array.from(lineEl.querySelectorAll("br[data-rd-sentinel='true']"))) {
          s.remove();
        }
      } else {
        const brs = Array.from(lineEl.querySelectorAll("br"));
        if (brs.length === 0) {
          lineEl.appendChild(createSentinelBr());
        } else {
          brs[0]!.dataset.rdSentinel = "true";
          for (let i = 1; i < brs.length; i += 1) {
            brs[i]!.remove();
          }
        }
      }
    }
  }

  const sentinels = Array.from(root.querySelectorAll("br[data-rd-sentinel='true']"));
  for (const s of sentinels) {
    if (getLineAncestor(s, root)) continue;
    if (hasVisibleContentAfter(s, root) || !hasRealBrBefore(s, root)) {
      s.remove();
    }
  }
}

function createInlineElement(kind: InlineKind, text: string): HTMLElement {
  if (kind === "code") {
    const el = document.createElement("code");
    el.setAttribute("data-inline-code", "true");
    el.className = INLINE_CODE_CLASS;
    el.textContent = text;
    return el;
  }
  if (kind === "bold") {
    const el = document.createElement("strong");
    el.setAttribute("data-inline-bold", "true");
    el.className = "rd-ed-bold";
    el.textContent = text;
    return el;
  }
  if (kind === "italic") {
    const el = document.createElement("em");
    el.setAttribute("data-inline-italic", "true");
    el.className = "rd-ed-italic";
    el.textContent = text;
    return el;
  }
  const el = document.createElement("del");
  el.setAttribute("data-inline-strike", "true");
  el.className = "rd-ed-strike";
  el.textContent = text;
  return el;
}

function applyLineBlockMeta(el: HTMLElement, meta: Omit<ParsedRichLine, "content">): void {
  el.dataset.rdLine = "true";
  el.dataset.rdBlock = meta.type;
  delete el.dataset.rdDepth;
  delete el.dataset.rdIndent;
  delete el.dataset.rdBullet;
  delete el.dataset.rdOrder;
  delete el.dataset.rdStart;
  delete el.dataset.rdChecked;
  delete el.dataset.rdLevel;

  switch (meta.type) {
    case "quote": {
      const depth = Math.min(3, Math.max(1, Math.trunc(meta.depth ?? 1)));
      el.dataset.rdDepth = String(depth);
      el.className = "rd-ed-line rd-ed-quote";
      break;
    }
    case "ul": {
      const indent = Math.min(3, Math.max(0, Math.trunc(meta.indent ?? 0)));
      el.dataset.rdIndent = String(indent);
      el.dataset.rdBullet = meta.bullet ?? "-";
      el.className = "rd-ed-line rd-ed-li rd-ed-ul";
      break;
    }
    case "ol": {
      const indent = Math.min(3, Math.max(0, Math.trunc(meta.indent ?? 0)));
      const order = Math.max(1, Math.trunc(meta.order ?? 1));
      el.dataset.rdIndent = String(indent);
      el.dataset.rdOrder = String(order);
      el.className = "rd-ed-line rd-ed-li rd-ed-ol";
      break;
    }
    case "task": {
      const indent = Math.min(3, Math.max(0, Math.trunc(meta.indent ?? 0)));
      el.dataset.rdIndent = String(indent);
      el.dataset.rdChecked = meta.checked ? "true" : "false";
      el.className = "rd-ed-line rd-ed-li rd-ed-task";
      break;
    }
    case "h": {
      const level = Math.min(4, Math.max(1, Math.trunc(meta.level ?? 1)));
      el.dataset.rdLevel = String(level);
      el.className = `rd-ed-line rd-ed-h rd-ed-h${level}`;
      break;
    }
    case "p":
    default:
      el.className = "rd-ed-line";
      break;
  }
}

function readLineBlockMeta(el: HTMLElement): Omit<ParsedRichLine, "content"> {
  const type = el.dataset.rdBlock;
  switch (type) {
    case "quote":
      return {
        type: "quote",
        depth: Math.min(3, Math.max(1, Number.parseInt(el.dataset.rdDepth || "1", 10) || 1)),
      };
    case "ul":
      return {
        type: "ul",
        indent: Math.min(3, Math.max(0, Number.parseInt(el.dataset.rdIndent || "0", 10) || 0)),
        bullet: (el.dataset.rdBullet as "-" | "*" | "+") || "-",
      };
    case "ol":
      return {
        type: "ol",
        indent: Math.min(3, Math.max(0, Number.parseInt(el.dataset.rdIndent || "0", 10) || 0)),
        order: Math.max(1, Number.parseInt(el.dataset.rdOrder || "1", 10) || 1),
      };
    case "task":
      return {
        type: "task",
        indent: Math.min(3, Math.max(0, Number.parseInt(el.dataset.rdIndent || "0", 10) || 0)),
        checked: el.dataset.rdChecked === "true",
      };
    case "h":
      return {
        type: "h",
        level: Math.min(4, Math.max(1, Number.parseInt(el.dataset.rdLevel || "1", 10) || 1)),
      };
    default:
      return { type: "p" };
  }
}

function appendInlineNodes(parent: Node, content: string): Node | null {
  if (!content) return null;
  const tokens = tokenizeInlineMarkdown(content);
  let lastNode: Node | null = null;
  for (const tok of tokens) {
    if (tok.type === "text") {
      const tn = document.createTextNode(tok.text);
      parent.appendChild(tn);
      lastNode = tn;
    } else {
      const el = createInlineElement(tok.type, tok.text);
      parent.appendChild(el);
      lastNode = el;
    }
  }
  if (tokens.length > 0 && tokens[tokens.length - 1]!.type !== "text") {
    const z = document.createTextNode(ZERO_WIDTH);
    parent.appendChild(z);
    lastNode = z;
  }
  return lastNode;
}

function createLineElement(parsed: ParsedRichLine): HTMLDivElement {
  const lineEl = document.createElement("div");
  applyLineBlockMeta(lineEl, parsed);
  if (parsed.content) {
    appendInlineNodes(lineEl, parsed.content);
  }
  if (!lineHasVisibleContent(lineEl)) {
    lineEl.innerHTML = "";
    lineEl.appendChild(createSentinelBr());
  }
  return lineEl;
}

function renumberOrderedLists(root: HTMLElement): void {
  const counters = new Map<number, number>();
  for (const child of Array.from(root.children)) {
    if (!isLineElement(child)) {
      counters.clear();
      continue;
    }
    const block = child.dataset.rdBlock;
    if (block === "ol") {
      const indent = Math.min(3, Math.max(0, Number.parseInt(child.dataset.rdIndent || "0", 10) || 0));
      for (const k of Array.from(counters.keys())) {
        if (k > indent) counters.delete(k);
      }
      const prev = counters.get(indent);
      let nextOrder: number;
      if (prev !== undefined) {
        nextOrder = prev + 1;
        delete child.dataset.rdStart;
      } else {
        nextOrder = child.dataset.rdStart
          ? Math.max(1, Number.parseInt(child.dataset.rdStart, 10) || 1)
          : 1;
      }
      counters.set(indent, nextOrder);
      if (child.dataset.rdOrder !== String(nextOrder)) {
        child.dataset.rdOrder = String(nextOrder);
      }
    } else if (block === "ul" || block === "task") {
      const indent = Math.min(3, Math.max(0, Number.parseInt(child.dataset.rdIndent || "0", 10) || 0));
      for (const k of Array.from(counters.keys())) {
        if (k >= indent) counters.delete(k);
      }
    } else if (block === "p" && !lineHasVisibleContent(child)) {
      // Blank line preserves loose ordered list numbering
    } else {
      counters.clear();
    }
  }
}

function renderInlineMarkdownToDom(container: HTMLElement, text: string): void {
  container.innerHTML = "";
  if (!text) return;
  const lines = text.split("\n");
  const frag = document.createDocumentFragment();
  const inRunByIndent = new Set<number>();

  for (const rawLine of lines) {
    const parsed = parseRichLine(rawLine);
    const lineEl = createLineElement(parsed);
    if (parsed.type === "ol") {
      const indent = parsed.indent ?? 0;
      for (const k of Array.from(inRunByIndent)) {
        if (k > indent) inRunByIndent.delete(k);
      }
      if (!inRunByIndent.has(indent)) {
        if ((parsed.order ?? 1) > 1) {
          lineEl.dataset.rdStart = String(parsed.order);
        }
        inRunByIndent.add(indent);
      }
    } else if (parsed.type === "ul" || parsed.type === "task") {
      const indent = parsed.indent ?? 0;
      for (const k of Array.from(inRunByIndent)) {
        if (k >= indent) inRunByIndent.delete(k);
      }
    } else if (parsed.type === "p" && !parsed.content.trim()) {
      // Loose list blank separator
    } else {
      inRunByIndent.clear();
    }
    frag.appendChild(lineEl);
  }
  container.appendChild(frag);
  renumberOrderedLists(container);
}

function serializeInlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replaceAll(ZERO_WIDTH, "").replace(/\u00A0/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === "BR") {
    return el.dataset.rdSentinel === "true" ? "" : "\n";
  }
  const kind = getInlineElementKind(el);
  if (kind) {
    const inner = (el.textContent ?? "")
      .replaceAll(ZERO_WIDTH, "")
      .replace(/\u00A0/g, " ")
      .replace(/\n/g, " ");
    if (!inner) return "";
    if (kind === "code") return `\`${inner}\``;
    if (kind === "bold") return `**${inner}**`;
    if (kind === "italic") return `*${inner}*`;
    return `~~${inner}~~`;
  }
  let out = "";
  for (const child of Array.from(el.childNodes)) {
    out += serializeInlineNode(child);
  }
  return out;
}

function serializeLineElement(lineEl: HTMLElement): string {
  if (!lineHasVisibleContent(lineEl)) {
    return formatRichLinePrefix(readLineBlockMeta(lineEl));
  }
  let content = "";
  for (const child of Array.from(lineEl.childNodes)) {
    if (
      child.nodeType === Node.ELEMENT_NODE &&
      (child as HTMLElement).tagName === "BR" &&
      ((child as HTMLElement).dataset.rdSentinel === "true" || !hasVisibleContentAfter(child, lineEl))
    ) {
      continue;
    }
    content += serializeInlineNode(child);
  }
  return `${formatRichLinePrefix(readLineBlockMeta(lineEl))}${content}`;
}

function serializeDomToInlineMarkdown(container: HTMLElement): string {
  const children = Array.from(container.childNodes);
  if (children.length === 0) return "";

  const lines: string[] = [];
  let looseBuf = "";
  let hasLoose = false;

  const flushLoose = () => {
    if (hasLoose) {
      lines.push(looseBuf);
      looseBuf = "";
      hasLoose = false;
    }
  };

  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      if (el.tagName === "DIV" || el.tagName === "P") {
        flushLoose();
        if (isLineElement(el)) {
          lines.push(serializeLineElement(el));
        } else {
          let inner = "";
          for (const c of Array.from(el.childNodes)) {
            if (
              c.nodeType === Node.ELEMENT_NODE &&
              (c as HTMLElement).tagName === "BR" &&
              ((c as HTMLElement).dataset.rdSentinel === "true" || !hasVisibleContentAfter(c, el))
            ) {
              continue;
            }
            inner += serializeInlineNode(c);
          }
          lines.push(inner);
        }
        continue;
      }
    }
    hasLoose = true;
    looseBuf += serializeInlineNode(child);
  }
  flushLoose();
  return lines.join("\n");
}

function serializeInlineRange(range: Range): string {
  const span = document.createElement("span");
  span.appendChild(range.cloneContents());
  let out = "";
  for (const child of Array.from(span.childNodes)) {
    if (
      child.nodeType === Node.ELEMENT_NODE &&
      (child as HTMLElement).tagName === "BR" &&
      ((child as HTMLElement).dataset.rdSentinel === "true" || !hasVisibleContentAfter(child, span))
    ) {
      continue;
    }
    out += serializeInlineNode(child);
  }
  return out;
}

function fragmentHasInlineElement(frag: DocumentFragment): boolean {
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_ELEMENT);
  let curr: Node | null = walker.nextNode();
  while (curr) {
    if (getInlineElementKind(curr) !== null) return true;
    curr = walker.nextNode();
  }
  return false;
}

function setCaretAtEnd(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function setCaretAtStart(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const firstChild = el.firstChild;
  if (firstChild && isLineElement(firstChild)) {
    if (firstChild.firstChild && firstChild.firstChild.nodeType === Node.TEXT_NODE) {
      range.setStart(firstChild.firstChild, 0);
    } else {
      range.setStart(firstChild, 0);
    }
  } else {
    range.selectNodeContents(el);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function setCaretAtStartOfLine(lineEl: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const first = lineEl.firstChild;
  if (first && first.nodeType === Node.TEXT_NODE) {
    range.setStart(first, 0);
  } else {
    range.setStart(lineEl, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function setCaretAtLineCharOffset(lineEl: HTMLElement, targetOffset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();

  if (!lineHasVisibleContent(lineEl) || targetOffset <= 0) {
    const first = lineEl.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) {
      const text = first.textContent ?? "";
      const pos = text === ZERO_WIDTH ? 1 : 0;
      range.setStart(first, pos);
    } else {
      range.setStart(lineEl, 0);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }

  let remaining = targetOffset;
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  let curr: Node | null = walker.nextNode();
  let lastText: Text | null = null;
  while (curr) {
    const tn = curr as Text;
    lastText = tn;
    let visibleCount = 0;
    for (let i = 0; i < tn.data.length; i += 1) {
      if (tn.data[i] === ZERO_WIDTH) continue;
      visibleCount += 1;
      if (visibleCount === remaining) {
        range.setStart(tn, i + 1);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
    }
    remaining -= visibleCount;
    curr = walker.nextNode();
  }

  if (lastText) {
    range.setStart(lastText, lastText.data.length);
  } else {
    range.selectNodeContents(lineEl);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function serializeChildSlice(nodes: Node[]): string | null {
  if (nodes.length === 0) return null;
  const div = document.createElement("div");
  for (const n of nodes) {
    div.appendChild(n.cloneNode(true));
  }
  return serializeDomToInlineMarkdown(div);
}

function getMarkdownBeforeCaret(root: HTMLElement, range: Range): { before: string; after: string } {
  const startLine = getLineAncestor(range.startContainer, root);
  const endLine = getLineAncestor(range.endContainer, root);

  if (!startLine && !endLine) {
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(root);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const beforeDiv = document.createElement("div");
    beforeDiv.appendChild(beforeRange.cloneContents());

    const afterRange = document.createRange();
    afterRange.selectNodeContents(root);
    afterRange.setStart(range.endContainer, range.endOffset);
    const afterDiv = document.createElement("div");
    afterDiv.appendChild(afterRange.cloneContents());

    return {
      before: serializeDomToInlineMarkdown(beforeDiv),
      after: serializeDomToInlineMarkdown(afterDiv),
    };
  }

  const children = Array.from(root.childNodes);

  let before = "";
  if (startLine) {
    const startIdx = children.indexOf(startLine);
    const prefixStr = startIdx > 0 ? serializeChildSlice(children.slice(0, startIdx)) : null;
    const inlineBeforeRange = document.createRange();
    inlineBeforeRange.selectNodeContents(startLine);
    inlineBeforeRange.setEnd(range.startContainer, range.startOffset);
    const inlineBefore = serializeInlineRange(inlineBeforeRange);
    const currLineBefore = serializeRichLine({
      ...readLineBlockMeta(startLine),
      content: inlineBefore,
    });
    before = prefixStr !== null ? `${prefixStr}\n${currLineBefore}` : currLineBefore;
  } else {
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(root);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const beforeDiv = document.createElement("div");
    beforeDiv.appendChild(beforeRange.cloneContents());
    before = serializeDomToInlineMarkdown(beforeDiv);
  }

  let after = "";
  if (endLine) {
    const endIdx = children.indexOf(endLine);
    const inlineAfterRange = document.createRange();
    inlineAfterRange.selectNodeContents(endLine);
    inlineAfterRange.setStart(range.endContainer, range.endOffset);
    const inlineAfter = serializeInlineRange(inlineAfterRange);
    const suffixStr =
      endIdx >= 0 && endIdx < children.length - 1
        ? serializeChildSlice(children.slice(endIdx + 1))
        : null;
    after = suffixStr !== null ? `${inlineAfter}\n${suffixStr}` : inlineAfter;
  } else {
    const afterRange = document.createRange();
    afterRange.selectNodeContents(root);
    afterRange.setStart(range.endContainer, range.endOffset);
    const afterDiv = document.createElement("div");
    afterDiv.appendChild(afterRange.cloneContents());
    after = serializeDomToInlineMarkdown(afterDiv);
  }

  return { before, after };
}

function stripLeadingCharsFromLine(
  lineEl: HTMLElement,
  charCount: number,
  caretOffsetAfterStrip: number,
  sel: Selection,
): void {
  let remaining = charCount;
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let curr = walker.nextNode();
  while (curr) {
    textNodes.push(curr as Text);
    curr = walker.nextNode();
  }

  for (const tn of textNodes) {
    if (remaining <= 0) break;
    let cutAt = 0;
    while (cutAt < tn.data.length && remaining > 0) {
      if (tn.data[cutAt] !== ZERO_WIDTH) {
        remaining -= 1;
      }
      cutAt += 1;
    }
    tn.data = tn.data.slice(cutAt);
    if (tn.data.replaceAll(ZERO_WIDTH, "").length === 0) {
      tn.parentNode?.removeChild(tn);
    }
  }

  if (!lineHasVisibleContent(lineEl)) {
    lineEl.innerHTML = "";
    lineEl.appendChild(createSentinelBr());
    const nextRange = document.createRange();
    nextRange.setStart(lineEl, 0);
    nextRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(nextRange);
    return;
  }

  for (const s of Array.from(lineEl.querySelectorAll("br[data-rd-sentinel='true']"))) {
    s.remove();
  }
  setCaretAtLineCharOffset(lineEl, caretOffsetAfterStrip);
}

interface TextSegmentProps {
  id: string;
  text: string;
  disabled: boolean;
  showPlaceholder: boolean;
  placeholder: string;
  ariaLabel: string;
  submitMode: RichPromptSubmitMode;
  isMobileComposer: boolean;
  isFirst: boolean;
  isLast: boolean;
  hasCodeBlocks: boolean;
  onTextChange: (id: string, nextText: string) => void;
  onConvertToCodeBlock: (id: string, beforeText: string, lang: string, afterText: string) => void;
  onPasteMarkdown: (id: string, beforeText: string, pasted: string, afterText: string) => void;
  onPasteImages?: (files: File[]) => void;
  onInterceptKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => boolean;
  onSubmit: () => void;
  onFocusPrevCode: (id: string) => void;
  onFocusNextCode: (id: string) => void;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
}

function TextSegment({
  id,
  text,
  disabled,
  showPlaceholder,
  placeholder,
  ariaLabel,
  submitMode,
  isMobileComposer,
  isFirst,
  isLast,
  hasCodeBlocks,
  onTextChange,
  onConvertToCodeBlock,
  onPasteMarkdown,
  onPasteImages,
  onInterceptKeyDown,
  onSubmit,
  onFocusPrevCode,
  onFocusNextCode,
  registerRef,
}: TextSegmentProps) {
  const divRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const lastDomTextRef = useRef<string | null>(null);

  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      divRef.current = node;
      registerRef(id, node);
    },
    [id, registerRef],
  );

  useLayoutEffect(() => {
    const el = divRef.current;
    if (!el) return;
    if (lastDomTextRef.current === text) return;
    renderInlineMarkdownToDom(el, text);
    lastDomTextRef.current = text;
  }, [text]);

  const tryAutoConvertInlineMarkdown = useCallback((el: HTMLElement): boolean => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return false;
    if (getInlineFormatAncestor(range.startContainer, el)) return false;
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;

    const textNode = range.startContainer as Text;
    const raw = textNode.data;
    const offset = range.startOffset;
    const beforeCaret = raw.slice(0, offset);
    const afterCaret = raw.slice(offset);

    let kind: InlineKind | null = null;
    let prefixKeep = "";
    let innerText = "";

    const codeMatch = /(^|[^`])`([^`\n]+)`$/.exec(beforeCaret);
    if (codeMatch && codeMatch[2]) {
      kind = "code";
      prefixKeep = beforeCaret.slice(0, codeMatch.index + (codeMatch[1]?.length ?? 0));
      innerText = codeMatch[2];
    } else {
      const boldMatch = /\*\*([^\s*\n](?:[^*\n]*[^\s*\n])?)\*\*$/.exec(beforeCaret);
      if (boldMatch && boldMatch[1]) {
        kind = "bold";
        prefixKeep = beforeCaret.slice(0, boldMatch.index);
        innerText = boldMatch[1];
      } else {
        const strikeMatch = /~~([^\s~\n](?:[^~\n]*[^\s~\n])?)~~$/.exec(beforeCaret);
        if (strikeMatch && strikeMatch[1]) {
          kind = "strike";
          prefixKeep = beforeCaret.slice(0, strikeMatch.index);
          innerText = strikeMatch[1];
        } else {
          const italicMatch =
            /(^|[^A-Za-z0-9_*])\*([^\s*\n](?:[^*\n]*[^\s*\n])?)\*$/.exec(beforeCaret);
          const firstAfter = afterCaret.replaceAll(ZERO_WIDTH, "")[0] ?? "";
          if (italicMatch && italicMatch[2] && !/[A-Za-z0-9_*]/.test(firstAfter)) {
            kind = "italic";
            prefixKeep = beforeCaret.slice(0, italicMatch.index + (italicMatch[1]?.length ?? 0));
            innerText = italicMatch[2];
          }
        }
      }
    }

    if (!kind || !innerText) return false;

    const parent = textNode.parentNode;
    if (!parent) return false;

    const frag = document.createDocumentFragment();
    if (prefixKeep) {
      frag.appendChild(document.createTextNode(prefixKeep));
    }
    const inlineEl = createInlineElement(kind, innerText);
    frag.appendChild(inlineEl);

    const trailingNode = document.createTextNode(afterCaret || ZERO_WIDTH);
    frag.appendChild(trailingNode);

    parent.replaceChild(frag, textNode);

    const nextRange = document.createRange();
    nextRange.setStart(trailingNode, afterCaret ? 0 : 1);
    nextRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(nextRange);
    return true;
  }, []);

  const tryAutoConvertLineBlock = useCallback((el: HTMLElement): boolean => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return false;
    if (getInlineFormatAncestor(range.startContainer, el)) return false;

    let lineEl = getLineAncestor(range.startContainer, el);
    if (!lineEl) {
      // Promote single loose line when user types a Markdown block prefix in an empty/plain editor
      if (
        el.querySelector("div[data-rd-line='true']") ||
        el.querySelector("br:not([data-rd-sentinel='true'])")
      ) {
        return false;
      }
      const beforeR = document.createRange();
      beforeR.selectNodeContents(el);
      beforeR.setEnd(range.startContainer, range.startOffset);
      const beforeFrag = beforeR.cloneContents();
      if (fragmentHasInlineElement(beforeFrag)) return false;
      const beforePlain = serializeInlineRange(beforeR).replaceAll(ZERO_WIDTH, "");
      if (parseRichLine(beforePlain).type === "p") return false;

      const wrapped = document.createElement("div");
      applyLineBlockMeta(wrapped, { type: "p" });
      const savedContainer = range.startContainer;
      const savedOffset = range.startOffset;
      while (el.firstChild) {
        wrapped.appendChild(el.firstChild);
      }
      el.appendChild(wrapped);
      const restored = document.createRange();
      if (savedContainer === el) {
        restored.setStart(wrapped, Math.min(savedOffset, wrapped.childNodes.length));
      } else {
        restored.setStart(savedContainer, savedOffset);
      }
      restored.collapse(true);
      sel.removeAllRanges();
      sel.addRange(restored);
      lineEl = wrapped;
    }

    const activeRange = sel.getRangeAt(0);
    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(lineEl);
    beforeRange.setEnd(activeRange.startContainer, activeRange.startOffset);
    const beforeFrag = beforeRange.cloneContents();
    if (fragmentHasInlineElement(beforeFrag)) return false;

    const beforePlain = serializeInlineRange(beforeRange).replaceAll(ZERO_WIDTH, "");
    if (!beforePlain) return false;

    const meta = readLineBlockMeta(lineEl);

    if (meta.type === "p") {
      const parsed = parseRichLine(beforePlain);
      if (parsed.type === "p") return false;
      const prefixLen = beforePlain.length - parsed.content.length;
      applyLineBlockMeta(lineEl, parsed);
      if (parsed.type === "ol" && (parsed.order ?? 1) > 1) {
        lineEl.dataset.rdStart = String(parsed.order);
      }
      stripLeadingCharsFromLine(lineEl, prefixLen, parsed.content.length, sel);
      renumberOrderedLists(el);
      return true;
    }

    if (meta.type === "ul") {
      const taskUpgrade = /^\[([ xX])\][ \u00A0](.*)$/.exec(beforePlain);
      if (!taskUpgrade) return false;
      const checked = (taskUpgrade[1] ?? "").toLowerCase() === "x";
      const rest = taskUpgrade[2] ?? "";
      const prefixLen = beforePlain.length - rest.length;
      applyLineBlockMeta(lineEl, {
        type: "task",
        indent: meta.indent ?? 0,
        checked,
      });
      stripLeadingCharsFromLine(lineEl, prefixLen, rest.length, sel);
      return true;
    }

    if (meta.type === "quote" && (meta.depth ?? 1) < 3) {
      const quoteUpgrade = /^((?:>[ \u00A0]?){0,1}>)[ \u00A0](.*)$/.exec(beforePlain);
      if (!quoteUpgrade) return false;
      const added = Math.max(1, (quoteUpgrade[1]?.match(/>/g) ?? []).length);
      const nextDepth = Math.min(3, (meta.depth ?? 1) + added);
      const rest = quoteUpgrade[2] ?? "";
      const prefixLen = beforePlain.length - rest.length;
      applyLineBlockMeta(lineEl, { type: "quote", depth: nextDepth });
      stripLeadingCharsFromLine(lineEl, prefixLen, rest.length, sel);
      return true;
    }

    return false;
  }, []);

  const tryAutoConvertCodeFence = useCallback(
    (el: HTMLElement): boolean => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.startContainer)) return false;
      if (getInlineCodeAncestor(range.startContainer, el)) return false;

      const { before, after } = getMarkdownBeforeCaret(el, range);
      if (!/(^|[^`])```$/.test(before)) return false;

      const beforeText = before.slice(0, -3).replace(/\n$/, "");
      const afterText = after.replace(/^\n/, "");
      renderInlineMarkdownToDom(el, beforeText);
      lastDomTextRef.current = beforeText;
      onConvertToCodeBlock(id, beforeText, "", afterText);
      return true;
    },
    [id, onConvertToCodeBlock],
  );

  const syncFromDom = useCallback(() => {
    const el = divRef.current;
    if (!el) return;
    if (
      !el.querySelector("div[data-rd-line='true']") &&
      !hasVisibleContentInFragment(el) &&
      el.querySelectorAll("br:not([data-rd-sentinel='true'])").length <= 1
    ) {
      el.innerHTML = "";
    }
    cleanupStaleSentinels(el);
    if (!composingRef.current) {
      if (tryAutoConvertCodeFence(el)) return;
      tryAutoConvertLineBlock(el);
      tryAutoConvertInlineMarkdown(el);
    }
    // Remove empty inline format tags left behind by deleting all characters inside one.
    for (const inlineEl of Array.from(
      el.querySelectorAll(
        "code[data-inline-code='true'], strong[data-inline-bold='true'], em[data-inline-italic='true'], del[data-inline-strike='true']",
      ),
    )) {
      if (!(inlineEl.textContent ?? "").replaceAll(ZERO_WIDTH, "")) {
        inlineEl.remove();
      }
    }
    if (el.querySelector("div[data-rd-block='ol']")) {
      renumberOrderedLists(el);
    }
    const serialized = serializeDomToInlineMarkdown(el);
    lastDomTextRef.current = serialized;
    onTextChange(id, serialized);
  }, [
    id,
    onTextChange,
    tryAutoConvertCodeFence,
    tryAutoConvertInlineMarkdown,
    tryAutoConvertLineBlock,
  ]);

  const insertLineBreak = useCallback(
    (el: HTMLElement, sel: Selection, range: Range) => {
      const inlineAncestor = getInlineFormatAncestor(range.startContainer, el);
      if (inlineAncestor) {
        const isCode = getInlineElementKind(inlineAncestor) === "code";
        const atEnd = (() => {
          const test = document.createRange();
          test.selectNodeContents(inlineAncestor);
          test.setStart(range.endContainer, range.endOffset);
          return test.toString().replaceAll(ZERO_WIDTH, "").length === 0;
        })();
        if (isCode || atEnd) {
          range.setStartAfter(inlineAncestor);
          range.collapse(true);
        } else {
          range.deleteContents();
        }
      } else {
        range.deleteContents();
      }

      const lineEl = getLineAncestor(range.startContainer, el);
      if (!lineEl) {
        // Promote loose content into uniform line <div> elements before splitting
        const { before, after } = getMarkdownBeforeCaret(el, range);
        const beforeLines = before.split("\n");
        const afterLines = after.split("\n");
        const currBeforeRaw = beforeLines[beforeLines.length - 1] ?? "";
        const currAfterRaw = afterLines[0] ?? "";
        const currParsed = parseRichLine(currBeforeRaw);

        el.innerHTML = "";
        const frag = document.createDocumentFragment();
        for (const l of beforeLines.slice(0, -1)) {
          frag.appendChild(createLineElement(parseRichLine(l)));
        }
        const firstLineEl = createLineElement(currParsed);
        frag.appendChild(firstLineEl);

        const nextMeta: Omit<ParsedRichLine, "content"> =
          currParsed.type === "ul"
            ? { type: "ul", indent: currParsed.indent ?? 0, bullet: currParsed.bullet ?? "-" }
            : currParsed.type === "task"
              ? { type: "task", indent: currParsed.indent ?? 0, checked: false }
              : currParsed.type === "ol"
                ? { type: "ol", indent: currParsed.indent ?? 0, order: (currParsed.order ?? 1) + 1 }
                : currParsed.type === "quote"
                  ? { type: "quote", depth: currParsed.depth ?? 1 }
                  : { type: "p" };
        const newLineEl = createLineElement({ ...nextMeta, content: currAfterRaw });
        frag.appendChild(newLineEl);

        for (const l of afterLines.slice(1)) {
          frag.appendChild(createLineElement(parseRichLine(l)));
        }
        el.appendChild(frag);
        renumberOrderedLists(el);
        setCaretAtStartOfLine(newLineEl);
        newLineEl.scrollIntoView?.({ block: "nearest" });
        syncFromDom();
        return;
      }

      const beforeRange = document.createRange();
      beforeRange.selectNodeContents(lineEl);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      const inlineBefore = serializeInlineRange(beforeRange);

      const afterRange = document.createRange();
      afterRange.selectNodeContents(lineEl);
      afterRange.setStart(range.endContainer, range.endOffset);
      const inlineAfter = serializeInlineRange(afterRange);

      const meta = readLineBlockMeta(lineEl);
      const lineIsEmpty =
        !inlineBefore.replaceAll(ZERO_WIDTH, "") && !inlineAfter.replaceAll(ZERO_WIDTH, "");

      if (
        lineIsEmpty &&
        (meta.type === "ul" || meta.type === "ol" || meta.type === "task" || meta.type === "quote")
      ) {
        if (meta.type === "quote") {
          if ((meta.depth ?? 1) > 1) {
            applyLineBlockMeta(lineEl, { type: "quote", depth: (meta.depth ?? 1) - 1 });
          } else {
            applyLineBlockMeta(lineEl, { type: "p" });
          }
        } else if ((meta.indent ?? 0) > 0) {
          applyLineBlockMeta(lineEl, {
            ...meta,
            indent: (meta.indent ?? 0) - 1,
            ...(meta.type === "ol" ? { order: 1 } : {}),
          });
        } else {
          applyLineBlockMeta(lineEl, { type: "p" });
        }
        lineEl.innerHTML = "";
        lineEl.appendChild(createSentinelBr());
        renumberOrderedLists(el);
        setCaretAtStartOfLine(lineEl);
        lineEl.scrollIntoView?.({ block: "nearest" });
        syncFromDom();
        return;
      }

      lineEl.innerHTML = "";
      if (inlineBefore) {
        appendInlineNodes(lineEl, inlineBefore);
      }
      if (!lineHasVisibleContent(lineEl)) {
        lineEl.innerHTML = "";
        lineEl.appendChild(createSentinelBr());
      }

      const nextMeta: Omit<ParsedRichLine, "content"> =
        meta.type === "ul"
          ? { type: "ul", indent: meta.indent ?? 0, bullet: meta.bullet ?? "-" }
          : meta.type === "task"
            ? { type: "task", indent: meta.indent ?? 0, checked: false }
            : meta.type === "ol"
              ? { type: "ol", indent: meta.indent ?? 0, order: (meta.order ?? 1) + 1 }
              : meta.type === "quote"
                ? { type: "quote", depth: meta.depth ?? 1 }
                : { type: "p" };

      const nextLineEl = createLineElement({ ...nextMeta, content: inlineAfter });
      lineEl.after(nextLineEl);
      renumberOrderedLists(el);
      setCaretAtStartOfLine(nextLineEl);
      nextLineEl.scrollIntoView?.({ block: "nearest" });
      syncFromDom();
    },
    [syncFromDom],
  );

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const el = divRef.current;
    if (!el) return;
    const lineEl = getLineAncestor(e.target as Node | null, el);
    if (!lineEl || lineEl.dataset.rdBlock !== "task") return;

    const rect = lineEl.getBoundingClientRect();
    const indent = Math.min(3, Math.max(0, Number.parseInt(lineEl.dataset.rdIndent || "0", 10) || 0));
    const hitboxRight = rect.left + 26 + indent * 18;
    if (e.clientX <= hitboxRight) {
      e.preventDefault();
      lineEl.dataset.rdChecked = lineEl.dataset.rdChecked === "true" ? "false" : "true";
      syncFromDom();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (composingRef.current || e.nativeEvent.isComposing) return;

    if (onInterceptKeyDown?.(e)) {
      return;
    }

    const el = divRef.current;
    if (!el) return;
    const sel = window.getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;

    // 1. Wrap selected text with backtick -> inline code pill
    if (e.key === "`" && !e.metaKey && !e.ctrlKey && !e.altKey && range && !range.collapsed) {
      const selected = range.toString();
      if (selected && !selected.includes("\n") && !getInlineFormatAncestor(range.startContainer, el)) {
        e.preventDefault();
        range.deleteContents();
        const codeEl = createInlineElement("code", selected);
        const spacer = document.createTextNode(ZERO_WIDTH);
        range.insertNode(spacer);
        range.insertNode(codeEl);
        const nextRange = document.createRange();
        nextRange.setStart(spacer, 1);
        nextRange.collapse(true);
        sel!.removeAllRanges();
        sel!.addRange(nextRange);
        syncFromDom();
        return;
      }
    }

    // 2. Exit inline format elements cleanly with ArrowRight or closing backtick at end of <code>
    if (range && range.collapsed) {
      const inlineAncestor = getInlineFormatAncestor(range.startContainer, el);
      if (inlineAncestor) {
        const isCode = getInlineElementKind(inlineAncestor) === "code";
        const atEnd = (() => {
          const test = document.createRange();
          test.selectNodeContents(inlineAncestor);
          test.setStart(range.endContainer, range.endOffset);
          return test.toString().replaceAll(ZERO_WIDTH, "").length === 0;
        })();

        if (atEnd && (e.key === "ArrowRight" || (isCode && e.key === "`"))) {
          e.preventDefault();
          let nextSibling = inlineAncestor.nextSibling;
          if (!nextSibling || nextSibling.nodeType !== Node.TEXT_NODE) {
            const z = document.createTextNode(ZERO_WIDTH);
            inlineAncestor.after(z);
            nextSibling = z;
          }
          const nextRange = document.createRange();
          nextRange.setStart(nextSibling, nextSibling.textContent === ZERO_WIDTH ? 1 : 0);
          nextRange.collapse(true);
          sel!.removeAllRanges();
          sel!.addRange(nextRange);
          return;
        }
      }
    }

    // 3. Detect ``` or ```lang + Space / Enter -> convert to Code Block Card
    if ((e.key === " " || e.key === "Enter") && range && range.collapsed) {
      if (!getInlineCodeAncestor(range.startContainer, el)) {
        const { before, after } = getMarkdownBeforeCaret(el, range);
        const linesBefore = before.split("\n");
        const currentLine = linesBefore[linesBefore.length - 1] ?? "";
        const fenceMatch = /^```([a-zA-Z0-9_+-]*)$/.exec(currentLine);
        if (fenceMatch) {
          e.preventDefault();
          const lang = fenceMatch[1] ?? "";
          const preceding = linesBefore.slice(0, -1).join("\n");
          const remaining = after.replace(/^\n/, "");
          renderInlineMarkdownToDom(el, preceding);
          lastDomTextRef.current = preceding;
          onConvertToCodeBlock(id, preceding, lang, remaining);
          return;
        }
      }
    }

    // 4. Tab / Shift+Tab indentation inside list items
    if (e.key === "Tab" && range && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const lineEl = getLineAncestor(range.startContainer, el);
      if (lineEl) {
        const meta = readLineBlockMeta(lineEl);
        if (meta.type === "ul" || meta.type === "ol" || meta.type === "task") {
          e.preventDefault();
          const curIndent = meta.indent ?? 0;
          const nextIndent = e.shiftKey ? Math.max(0, curIndent - 1) : Math.min(3, curIndent + 1);
          if (nextIndent !== curIndent) {
            applyLineBlockMeta(lineEl, {
              ...meta,
              indent: nextIndent,
              ...(meta.type === "ol" ? { order: 1 } : {}),
            });
            renumberOrderedLists(el);
            syncFromDom();
          }
          return;
        }
      }
    }

    // 5. Smart Backspace at line offset 0: outdent / unwrap formatted line or merge with previous line
    if (e.key === "Backspace" && range && range.collapsed && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const lineEl = getLineAncestor(range.startContainer, el);
      if (lineEl) {
        const beforeRange = document.createRange();
        beforeRange.selectNodeContents(lineEl);
        beforeRange.setEnd(range.startContainer, range.startOffset);
        const atLineStart = !hasVisibleContentInFragment(beforeRange.cloneContents());

        if (atLineStart) {
          const meta = readLineBlockMeta(lineEl);
          if (meta.type === "quote") {
            e.preventDefault();
            if ((meta.depth ?? 1) > 1) {
              applyLineBlockMeta(lineEl, { type: "quote", depth: (meta.depth ?? 1) - 1 });
            } else {
              applyLineBlockMeta(lineEl, { type: "p" });
            }
            setCaretAtStartOfLine(lineEl);
            syncFromDom();
            return;
          }
          if (meta.type === "ul" || meta.type === "ol" || meta.type === "task") {
            e.preventDefault();
            if ((meta.indent ?? 0) > 0) {
              applyLineBlockMeta(lineEl, {
                ...meta,
                indent: (meta.indent ?? 0) - 1,
                ...(meta.type === "ol" ? { order: 1 } : {}),
              });
            } else {
              applyLineBlockMeta(lineEl, { type: "p" });
            }
            renumberOrderedLists(el);
            setCaretAtStartOfLine(lineEl);
            syncFromDom();
            return;
          }
          if (meta.type === "h") {
            e.preventDefault();
            applyLineBlockMeta(lineEl, { type: "p" });
            setCaretAtStartOfLine(lineEl);
            syncFromDom();
            return;
          }
          const prevEl = lineEl.previousElementSibling;
          if (prevEl && isLineElement(prevEl)) {
            e.preventDefault();
            for (const s of Array.from(prevEl.querySelectorAll("br[data-rd-sentinel='true']"))) {
              s.remove();
            }
            for (const s of Array.from(lineEl.querySelectorAll("br[data-rd-sentinel='true']"))) {
              s.remove();
            }
            const prevWasEmpty = !lineHasVisibleContent(prevEl);
            if (prevWasEmpty) {
              prevEl.innerHTML = "";
            }
            const lastPrevChild = prevEl.lastChild;
            while (lineEl.firstChild) {
              const child = lineEl.firstChild;
              if (isIgnorableEmptyNode(child) && !prevWasEmpty) {
                lineEl.removeChild(child);
                continue;
              }
              prevEl.appendChild(child);
            }
            lineEl.remove();

            if (!lineHasVisibleContent(prevEl)) {
              prevEl.innerHTML = "";
              prevEl.appendChild(createSentinelBr());
              setCaretAtStartOfLine(prevEl);
            } else {
              const nextRange = document.createRange();
              if (lastPrevChild && lastPrevChild.nodeType === Node.TEXT_NODE) {
                nextRange.setStart(lastPrevChild, (lastPrevChild as Text).data.length);
              } else if (lastPrevChild) {
                nextRange.setStartAfter(lastPrevChild);
              } else {
                const first = prevEl.firstChild;
                if (first && first.nodeType === Node.TEXT_NODE) {
                  nextRange.setStart(first, 0);
                } else {
                  nextRange.setStart(prevEl, 0);
                }
              }
              nextRange.collapse(true);
              sel!.removeAllRanges();
              sel!.addRange(nextRange);
            }
            renumberOrderedLists(el);
            syncFromDom();
            return;
          }
        }
      }
    }

    // 6. Arrow navigation into adjacent code blocks
    if (e.key === "ArrowUp" && !isFirst && range && range.collapsed) {
      const { before } = getMarkdownBeforeCaret(el, range);
      if (!before.includes("\n")) {
        e.preventDefault();
        onFocusPrevCode(id);
        return;
      }
    }
    if (e.key === "ArrowDown" && !isLast && range && range.collapsed) {
      const { after } = getMarkdownBeforeCaret(el, range);
      if (!after.includes("\n")) {
        e.preventDefault();
        onFocusNextCode(id);
        return;
      }
    }

    // 7. Submit / newline behavior based on submitMode and mobile device detection
    if (e.key === "Enter") {
      const effectiveSubmitMode: RichPromptSubmitMode =
        submitMode === "button-only" || isMobileComposerDevice() ? "button-only" : submitMode;
      const shouldSubmit =
        effectiveSubmitMode === "button-only"
          ? false
          : effectiveSubmitMode === "mod-enter"
            ? e.metaKey || e.ctrlKey
            : !e.shiftKey;
      if (!shouldSubmit) {
        e.preventDefault();
        if (sel && range) {
          insertLineBreak(el, sel, range);
        }
        return;
      }
      e.preventDefault();
      onSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (onPasteImages) {
      const imageFiles: File[] = [];
      for (const item of Array.from(e.clipboardData.items ?? [])) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) imageFiles.push(f);
        }
      }
      if (imageFiles.length === 0) {
        for (const f of Array.from(e.clipboardData.files ?? [])) {
          if (f.type.startsWith("image/")) imageFiles.push(f);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        onPasteImages(imageFiles);
        return;
      }
    }
    const plain = e.clipboardData.getData("text/plain");
    if (!plain) return;
    e.preventDefault();

    const el = divRef.current;
    const sel = window.getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;

    if (el && range && /^```[a-zA-Z0-9_+-]*[ \t]*\r?\n[\s\S]*?^```[ \t]*$/m.test(plain)) {
      const { before, after } = getMarkdownBeforeCaret(el, range);
      onPasteMarkdown(id, before, plain, after);
      return;
    }

    // Check if user pasted right after typing ```lang on the current line
    if (el && range && range.collapsed) {
      const { before, after } = getMarkdownBeforeCaret(el, range);
      const linesBefore = before.split("\n");
      const currentLine = linesBefore[linesBefore.length - 1] ?? "";
      const fenceMatch = /^```([a-zA-Z0-9_+-]*)$/.exec(currentLine);
      if (fenceMatch && plain.includes("\n")) {
        const lang = fenceMatch[1] ?? "";
        const preceding = linesBefore.slice(0, -1).join("\n");
        const wrapped = `\`\`\`${lang}\n${plain.replace(/\r\n/g, "\n")}\n\`\`\``;
        onPasteMarkdown(id, preceding, wrapped, after.replace(/^\n/, ""));
        return;
      }
    }

    if (!el || !range) return;

    range.deleteContents();
    const normalized = plain.replace(/\r\n/g, "\n");
    const pastedLines = normalized.split("\n");
    const activeLine = getLineAncestor(range.startContainer, el);
    const activeMeta = activeLine ? readLineBlockMeta(activeLine) : ({ type: "p" } as const);

    const beforeCheckRange = document.createRange();
    if (activeLine) {
      beforeCheckRange.selectNodeContents(activeLine);
    } else {
      beforeCheckRange.selectNodeContents(el);
    }
    beforeCheckRange.setEnd(range.startContainer, range.startOffset);
    const atEmptyLineStart = !hasVisibleContentInFragment(beforeCheckRange.cloneContents());

    const shouldUseBlockPaste =
      pastedLines.length > 1 ||
      (activeMeta.type === "p" && atEmptyLineStart && parseRichLine(normalized).type !== "p");

    if (!shouldUseBlockPaste) {
      const frag = document.createDocumentFragment();
      const lastNode = appendInlineNodes(frag, normalized);
      range.insertNode(frag);
      if (lastNode) {
        const nextRange = document.createRange();
        nextRange.setStartAfter(lastNode);
        nextRange.collapse(true);
        sel!.removeAllRanges();
        sel!.addRange(nextRange);
      }
      syncFromDom();
      return;
    }

    const { before, after } = getMarkdownBeforeCaret(el, range);
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const precedingLines = beforeLines.slice(0, -1);
    const currBeforeRaw = beforeLines[beforeLines.length - 1] ?? "";
    const currAfterInline = afterLines[0] ?? "";
    const followingLines = afterLines.slice(1);

    el.innerHTML = "";
    const frag = document.createDocumentFragment();

    for (const l of precedingLines) {
      frag.appendChild(createLineElement(parseRichLine(l)));
    }

    let caretLineEl: HTMLDivElement;
    let caretNode: Node | null = null;

    if (pastedLines.length === 1) {
      const pastedOne = pastedLines[0] ?? "";
      const parsedBeforePaste = parseRichLine(currBeforeRaw + pastedOne);
      const lineNode = createLineElement({
        ...parsedBeforePaste,
        content: parsedBeforePaste.content + currAfterInline,
      });
      if (currAfterInline) {
        lineNode.innerHTML = "";
        caretNode = appendInlineNodes(lineNode, parsedBeforePaste.content);
        appendInlineNodes(lineNode, currAfterInline);
        if (!lineHasVisibleContent(lineNode)) {
          lineNode.innerHTML = "";
          lineNode.appendChild(createSentinelBr());
        }
      }
      caretLineEl = lineNode;
      frag.appendChild(lineNode);
    } else {
      const firstLineRaw = currBeforeRaw
        ? currBeforeRaw + (pastedLines[0] ?? "")
        : (pastedLines[0] ?? "");
      frag.appendChild(createLineElement(parseRichLine(firstLineRaw)));

      for (let i = 1; i < pastedLines.length - 1; i += 1) {
        frag.appendChild(createLineElement(parseRichLine(pastedLines[i] ?? "")));
      }

      const lastPastedRaw = pastedLines[pastedLines.length - 1] ?? "";
      const lastParsed = parseRichLine(lastPastedRaw);
      const lastLineNode = createLineElement(lastParsed);
      if (currAfterInline) {
        lastLineNode.innerHTML = "";
        caretNode = appendInlineNodes(lastLineNode, lastParsed.content);
        appendInlineNodes(lastLineNode, currAfterInline);
        if (!lineHasVisibleContent(lastLineNode)) {
          lastLineNode.innerHTML = "";
          lastLineNode.appendChild(createSentinelBr());
        }
      }
      caretLineEl = lastLineNode;
      frag.appendChild(lastLineNode);
    }

    for (const l of followingLines) {
      frag.appendChild(createLineElement(parseRichLine(l)));
    }

    el.appendChild(frag);
    cleanupStaleSentinels(el);
    renumberOrderedLists(el);

    if (caretNode) {
      const nextRange = document.createRange();
      nextRange.setStartAfter(caretNode);
      nextRange.collapse(true);
      sel!.removeAllRanges();
      sel!.addRange(nextRange);
    } else if (!lineHasVisibleContent(caretLineEl)) {
      setCaretAtStartOfLine(caretLineEl);
    } else {
      setCaretAtEnd(caretLineEl);
    }

    const serialized = serializeDomToInlineMarkdown(el);
    lastDomTextRef.current = serialized;
    onTextChange(id, serialized);
  };

  return (
    <div className="relative">
      {showPlaceholder && (
        <span
          aria-hidden="true"
          className="pointer-events-none select-none absolute inset-0 text-[13.5px] leading-[1.55] text-[var(--text-muted)] truncate"
        >
          {placeholder}
        </span>
      )}
      <div
        ref={setRef}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        enterKeyHint={submitMode === "enter" && !isMobileComposer ? "send" : "enter"}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={syncFromDom}
        onMouseDown={handleMouseDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          syncFromDom();
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        className={`w-full text-[13.5px] leading-[1.55] text-[var(--text-primary)] focus:outline-none whitespace-pre-wrap break-words ${
          hasCodeBlocks ? "min-h-[22px]" : "min-h-[24px]"
        } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
      />
    </div>
  );
}

interface CodeSegmentCardProps {
  id: string;
  lang: string;
  code: string;
  disabled: boolean;
  submitMode: RichPromptSubmitMode;
  isMobileComposer: boolean;
  onChange: (id: string, patch: { lang?: string; code?: string }) => void;
  onRemove: (id: string, unwrapToText?: boolean) => void;
  onExitBelow: (id: string) => void;
  onExitAbove: (id: string) => void;
  onSubmit: () => void;
  registerRef: (id: string, el: HTMLTextAreaElement | null) => void;
}

function CodeSegmentCard({
  id,
  lang,
  code,
  disabled,
  submitMode,
  isMobileComposer,
  onChange,
  onRemove,
  onExitBelow,
  onExitAbove,
  onSubmit,
  registerRef,
}: CodeSegmentCardProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      taRef.current = node;
      registerRef(id, node);
    },
    [id, registerRef],
  );

  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 56), 240)}px`;
  }, [code]);

  const lineCount = code ? code.split("\n").length : 1;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    const el = e.currentTarget;

    // Cmd/Ctrl + Enter submits the message directly from inside a code block (desktop only)
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      !e.nativeEvent.isComposing &&
      submitMode !== "button-only" &&
      !isMobileComposerDevice()
    ) {
      e.preventDefault();
      onSubmit();
      return;
    }

    // Typing ``` on its own line + Enter exits the code block cleanly
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      const pos = el.selectionStart;
      if (pos === el.selectionEnd) {
        const before = code.slice(0, pos);
        const after = code.slice(pos);
        const lines = before.split("\n");
        const currLine = lines[lines.length - 1] ?? "";
        if (currLine.trim() === "```" && !after.trim()) {
          e.preventDefault();
          const trimmedCode = lines.slice(0, -1).join("\n");
          onChange(id, { code: trimmedCode });
          onExitBelow(id);
          return;
        }
        // Promote ```lang + Enter muscle-memory into the code block language badge
        const trimmedLang = code.trim().toLowerCase();
        if (!lang && !code.includes("\n") && pos === code.length && KNOWN_CODE_LANGS.has(trimmedLang)) {
          e.preventDefault();
          onChange(id, { lang: trimmedLang, code: "" });
          return;
        }
      }
    }

    // Tab inserts 2 spaces
    if (e.key === "Tab") {
      e.preventDefault();
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = `${code.slice(0, start)}  ${code.slice(end)}`;
      onChange(id, { code: next });
      window.requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 2;
      });
      return;
    }

    // Backspace on empty code block removes it
    if (e.key === "Backspace" && !code && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      onRemove(id, false);
      return;
    }

    // ArrowUp on first line -> exit above
    if (e.key === "ArrowUp" && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      onExitAbove(id);
      return;
    }

    // ArrowDown at very end -> exit below
    if (e.key === "ArrowDown" && el.selectionStart === code.length && el.selectionEnd === code.length) {
      e.preventDefault();
      onExitBelow(id);
    }
  };

  return (
    <div className="my-1.5 rounded-xl rd-plate overflow-hidden">
      <div className="h-7 px-2.5 border-b border-[var(--border-subtle)]/80 bg-[var(--rd-tray)]/85 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon name="code-2" size={12} className="text-indigo-500 shrink-0" />
          <input
            type="text"
            value={lang}
            disabled={disabled}
            onChange={(e) =>
              onChange(id, { lang: e.target.value.replace(/[^a-zA-Z0-9_+-]/g, "").slice(0, 24) })
            }
            placeholder="text"
            aria-label="代码块语言"
            spellCheck={false}
            className="w-20 bg-transparent text-[11px] font-mono text-[var(--text-secondary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:text-[var(--text-primary)]"
          />
          <span className="text-[10.5px] font-mono text-[var(--text-muted)]">
            {lineCount} 行
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {!isMobileComposer && submitMode !== "button-only" && (
            <span className="hidden sm:inline text-[10.5px] text-[var(--text-muted)]">
              Enter 换行 · ⌘↵ 发送
            </span>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRemove(id, Boolean(code.trim()))}
            title={code.trim() ? "还原为普通文本" : "移除代码块"}
            aria-label={code.trim() ? "还原为普通文本" : "移除代码块"}
            className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      </div>
      <textarea
        ref={setRef}
        rows={2}
        value={code}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(id, { code: e.target.value })}
        onKeyDown={handleKeyDown}
        placeholder="输入或粘贴代码 / 配置片段…"
        className="w-full px-3 py-2 bg-transparent font-mono text-[12px] leading-[1.55] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-none focus:outline-none rd-scroll"
      />
    </div>
  );
}

interface RichPromptEditorProps {
  value: string;
  disabled?: boolean;
  placeholder: string;
  ariaLabel?: string;
  submitMode?: RichPromptSubmitMode;
  className?: string;
  onChange: (nextMarkdown: string) => void;
  onSubmit: () => void;
  onInterceptKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => boolean;
  onPasteImages?: (files: File[]) => void;
}

export const RichPromptEditor = forwardRef<RichPromptEditorHandle, RichPromptEditorProps>(
  function RichPromptEditor(
    {
      value,
      disabled = false,
      placeholder,
      ariaLabel = "对话输入框",
      submitMode = "enter",
      className,
      onChange,
      onSubmit,
      onInterceptKeyDown,
      onPasteImages,
    },
    ref,
  ) {
    const isMobileComposer = useIsMobileComposer();
    const [blocks, setBlocks] = useState<EditorBlock[]>(() => parseMarkdownToBlocks(value));
    const blocksRef = useRef<EditorBlock[]>(blocks);
    blocksRef.current = blocks;
    const lastEmittedRef = useRef<string>(value);
    const textRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const codeRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
    const pendingFocusRef = useRef<{ id: string; position: "start" | "end" } | null>(null);

    // Sync when parent changes `value` externally (clear after send, starter prompt, @mention cleanup)
    useEffect(() => {
      if (value === lastEmittedRef.current) return;
      lastEmittedRef.current = value;
      const parsed = parseMarkdownToBlocks(value);
      blocksRef.current = parsed;
      setBlocks(parsed);
    }, [value]);

    const commitBlocks = useCallback(
      (updater: (prev: EditorBlock[]) => EditorBlock[]) => {
        const next = ensureTextBoundaries(updater(blocksRef.current));
        blocksRef.current = next;
        const serialized = serializeBlocksToMarkdown(next);
        lastEmittedRef.current = serialized;
        setBlocks(next);
        onChange(serialized);
      },
      [onChange],
    );

    const applyFocusToDom = useCallback((blockId: string, position: "start" | "end"): boolean => {
      const textEl = textRefs.current.get(blockId);
      if (textEl) {
        textEl.focus();
        if (position === "start") setCaretAtStart(textEl);
        else setCaretAtEnd(textEl);
        return true;
      }
      const codeEl = codeRefs.current.get(blockId);
      if (codeEl) {
        codeEl.focus();
        const pos = position === "start" ? 0 : codeEl.value.length;
        codeEl.selectionStart = codeEl.selectionEnd = pos;
        return true;
      }
      return false;
    }, []);

    useLayoutEffect(() => {
      const pending = pendingFocusRef.current;
      if (!pending) return;
      if (applyFocusToDom(pending.id, pending.position)) {
        pendingFocusRef.current = null;
      }
    }, [blocks, applyFocusToDom]);

    const focusBlock = useCallback(
      (blockId: string, position: "start" | "end" = "end") => {
        if (!applyFocusToDom(blockId, position)) {
          pendingFocusRef.current = { id: blockId, position };
        }
      },
      [applyFocusToDom],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          const lastText = [...blocks].reverse().find((b) => b.type === "text");
          if (lastText) {
            focusBlock(lastText.id, "end");
          }
        },
      }),
      [blocks, focusBlock],
    );

    const registerTextRef = useCallback((id: string, el: HTMLDivElement | null) => {
      if (el) textRefs.current.set(id, el);
      else textRefs.current.delete(id);
    }, []);

    const registerCodeRef = useCallback((id: string, el: HTMLTextAreaElement | null) => {
      if (el) codeRefs.current.set(id, el);
      else codeRefs.current.delete(id);
    }, []);

    const handleTextChange = useCallback(
      (id: string, nextText: string) => {
        commitBlocks((prev) =>
          prev.map((b) => (b.id === id && b.type === "text" ? { ...b, text: nextText } : b)),
        );
      },
      [commitBlocks],
    );

    const handleConvertToCodeBlock = useCallback(
      (id: string, beforeText: string, lang: string, afterText: string) => {
        const codeId = makeBlockId("c");
        const afterId = makeBlockId("t");
        commitBlocks((prev) => {
          const idx = prev.findIndex((b) => b.id === id);
          if (idx === -1) return prev;
          const replacement: EditorBlock[] = [
            { id, type: "text", text: beforeText },
            { id: codeId, type: "code", lang, code: "" },
            { id: afterId, type: "text", text: afterText },
          ];
          return [...prev.slice(0, idx), ...replacement, ...prev.slice(idx + 1)];
        });
        focusBlock(codeId, "start");
      },
      [commitBlocks, focusBlock],
    );

    const handlePasteMarkdown = useCallback(
      (id: string, beforeText: string, pasted: string, afterText: string) => {
        const combined = [beforeText, pasted, afterText].filter(Boolean).join("\n");
        const parsed = parseMarkdownToBlocks(combined);
        const focusTarget = parsed[parsed.length - 1]?.id;
        commitBlocks((prev) => {
          const idx = prev.findIndex((b) => b.id === id);
          if (idx === -1) return prev;
          return [...prev.slice(0, idx), ...parsed, ...prev.slice(idx + 1)];
        });
        if (focusTarget) focusBlock(focusTarget, "end");
      },
      [commitBlocks, focusBlock],
    );

    const handleCodeChange = useCallback(
      (id: string, patch: { lang?: string; code?: string }) => {
        commitBlocks((prev) =>
          prev.map((b) => (b.id === id && b.type === "code" ? { ...b, ...patch } : b)),
        );
      },
      [commitBlocks],
    );

    const handleRemoveCode = useCallback(
      (id: string, unwrapToText = false) => {
        let targetFocusId: string | null = null;
        commitBlocks((prev) => {
          const idx = prev.findIndex((b) => b.id === id);
          if (idx === -1) return prev;
          const block = prev[idx]!;
          const prevBlock = prev[idx - 1];
          targetFocusId = prevBlock?.id ?? null;
          if (unwrapToText && block.type === "code" && block.code.trim()) {
            const unwrapped: EditorBlock = { id: makeBlockId("t"), type: "text", text: block.code };
            return [...prev.slice(0, idx), unwrapped, ...prev.slice(idx + 1)];
          }
          return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        });
        if (targetFocusId) focusBlock(targetFocusId, "end");
      },
      [commitBlocks, focusBlock],
    );

    const handleExitCodeAbove = useCallback(
      (id: string) => {
        const idx = blocks.findIndex((b) => b.id === id);
        const prevBlock = idx > 0 ? blocks[idx - 1] : null;
        if (prevBlock) focusBlock(prevBlock.id, "end");
      },
      [blocks, focusBlock],
    );

    const handleExitCodeBelow = useCallback(
      (id: string) => {
        const idx = blocks.findIndex((b) => b.id === id);
        const nextBlock = idx >= 0 && idx < blocks.length - 1 ? blocks[idx + 1] : null;
        if (nextBlock) focusBlock(nextBlock.id, "start");
      },
      [blocks, focusBlock],
    );

    const handleFocusPrevCode = useCallback(
      (id: string) => {
        const idx = blocks.findIndex((b) => b.id === id);
        const prevBlock = idx > 0 ? blocks[idx - 1] : null;
        if (prevBlock) focusBlock(prevBlock.id, "end");
      },
      [blocks, focusBlock],
    );

    const handleFocusNextCode = useCallback(
      (id: string) => {
        const idx = blocks.findIndex((b) => b.id === id);
        const nextBlock = idx >= 0 && idx < blocks.length - 1 ? blocks[idx + 1] : null;
        if (nextBlock) focusBlock(nextBlock.id, "start");
      },
      [blocks, focusBlock],
    );

    const hasCodeBlocks = blocks.some((b) => b.type === "code");
    const isCompletelyEmpty =
      !hasCodeBlocks && blocks.every((b) => b.type === "text" && !b.text.replaceAll(ZERO_WIDTH, ""));

    return (
      <div
        className={
          className ??
          "w-full px-3.5 pt-3 pb-2 max-h-[260px] overflow-y-auto rd-scroll cursor-text"
        }
        onClick={(e) => {
          if (e.target === e.currentTarget && !disabled) {
            const lastText = [...blocks].reverse().find((b) => b.type === "text");
            if (lastText) focusBlock(lastText.id, "end");
          }
        }}
      >
        {blocks.map((block, idx) =>
          block.type === "text" ? (
            <TextSegment
              key={block.id}
              id={block.id}
              text={block.text}
              disabled={disabled}
              showPlaceholder={isCompletelyEmpty && idx === 0}
              placeholder={placeholder}
              ariaLabel={ariaLabel}
              submitMode={submitMode}
              isMobileComposer={isMobileComposer}
              isFirst={idx === 0}
              isLast={idx === blocks.length - 1}
              hasCodeBlocks={hasCodeBlocks}
              onTextChange={handleTextChange}
              onConvertToCodeBlock={handleConvertToCodeBlock}
              onPasteMarkdown={handlePasteMarkdown}
              onPasteImages={onPasteImages}
              onInterceptKeyDown={onInterceptKeyDown}
              onSubmit={onSubmit}
              onFocusPrevCode={handleFocusPrevCode}
              onFocusNextCode={handleFocusNextCode}
              registerRef={registerTextRef}
            />
          ) : (
            <CodeSegmentCard
              key={block.id}
              id={block.id}
              lang={block.lang}
              code={block.code}
              disabled={disabled}
              submitMode={submitMode}
              isMobileComposer={isMobileComposer}
              onChange={handleCodeChange}
              onRemove={handleRemoveCode}
              onExitBelow={handleExitCodeBelow}
              onExitAbove={handleExitCodeAbove}
              onSubmit={onSubmit}
              registerRef={registerCodeRef}
            />
          ),
        )}
      </div>
    );
  },
);
