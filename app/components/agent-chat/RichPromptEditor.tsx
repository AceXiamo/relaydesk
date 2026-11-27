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
  makeBlockId,
  parseMarkdownToBlocks,
  serializeBlocksToMarkdown,
  type EditorBlock,
} from "~/lib/chat-markdown.ts";
import { Icon } from "../Icon.tsx";

export interface RichPromptEditorHandle {
  focus: () => void;
}

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

function hasVisibleContentAfter(node: Node, root: HTMLElement): boolean {
  const afterRange = document.createRange();
  afterRange.selectNodeContents(root);
  afterRange.setStartAfter(node);
  const frag = afterRange.cloneContents();
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let curr: Node | null = walker.nextNode();
  while (curr) {
    if (curr.nodeType === Node.TEXT_NODE) {
      if ((curr.textContent ?? "").replaceAll(ZERO_WIDTH, "").length > 0) return true;
    } else if (curr.nodeType === Node.ELEMENT_NODE) {
      const el = curr as HTMLElement;
      if (el.tagName === "BR" && el.dataset.rdSentinel !== "true") return true;
      if (el.tagName === "CODE" || el.dataset.inlineCode === "true") {
        if ((el.textContent ?? "").replaceAll(ZERO_WIDTH, "").length > 0) return true;
      }
    }
    curr = walker.nextNode();
  }
  return false;
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
  const sentinels = Array.from(root.querySelectorAll("br[data-rd-sentinel='true']"));
  for (const s of sentinels) {
    if (hasVisibleContentAfter(s, root) || !hasRealBrBefore(s, root)) {
      s.remove();
    }
  }
}

function createInlineCodeElement(text: string): HTMLElement {
  const el = document.createElement("code");
  el.setAttribute("data-inline-code", "true");
  el.className = INLINE_CODE_CLASS;
  el.textContent = text;
  return el;
}

function renderInlineMarkdownToDom(container: HTMLElement, text: string): void {
  container.innerHTML = "";
  if (!text) return;
  const lines = text.split("\n");
  const frag = document.createDocumentFragment();
  const inlineRe = /`([^`\n]+)`/g;

  lines.forEach((line, lineIdx) => {
    if (lineIdx > 0) {
      frag.appendChild(document.createElement("br"));
    }
    let last = 0;
    let m: RegExpExecArray | null;
    inlineRe.lastIndex = 0;
    while ((m = inlineRe.exec(line)) !== null) {
      if (m.index > last) {
        frag.appendChild(document.createTextNode(line.slice(last, m.index)));
      }
      frag.appendChild(createInlineCodeElement(m[1] ?? ""));
      last = inlineRe.lastIndex;
    }
    if (last < line.length) {
      frag.appendChild(document.createTextNode(line.slice(last)));
    } else if (last > 0) {
      frag.appendChild(document.createTextNode(ZERO_WIDTH));
    }
  });

  if (text.endsWith("\n")) {
    frag.appendChild(createSentinelBr());
  }
  container.appendChild(frag);
}

function serializeDomToInlineMarkdown(container: HTMLElement): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? "").replaceAll(ZERO_WIDTH, "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "BR") {
      return el.dataset.rdSentinel === "true" ? "" : "\n";
    }
    if (tag === "CODE" || el.dataset.inlineCode === "true") {
      const inner = (el.textContent ?? "").replaceAll(ZERO_WIDTH, "").replace(/\n/g, " ");
      return inner ? `\`${inner}\`` : "";
    }
    let inner = "";
    for (const child of Array.from(el.childNodes)) {
      inner += walk(child);
    }
    if ((tag === "DIV" || tag === "P") && el !== container) {
      return `\n${inner}`;
    }
    return inner;
  };

  let out = "";
  const children = Array.from(container.childNodes);
  for (let i = 0; i < children.length; i += 1) {
    out += walk(children[i]!);
  }
  return out.replace(/^\n/, (m) => (children[0]?.nodeName === "DIV" ? "" : m));
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
  range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function getInlineCodeAncestor(node: Node | null, root: HTMLElement): HTMLElement | null {
  let curr: Node | null = node;
  while (curr && curr !== root) {
    if (curr.nodeType === Node.ELEMENT_NODE) {
      const el = curr as HTMLElement;
      if (el.tagName === "CODE" || el.dataset.inlineCode === "true") {
        return el;
      }
    }
    curr = curr.parentNode;
  }
  return null;
}

function getMarkdownBeforeCaret(root: HTMLElement, range: Range): { before: string; after: string } {
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(root);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const beforeFrag = beforeRange.cloneContents();
  const beforeDiv = document.createElement("div");
  beforeDiv.appendChild(beforeFrag);

  const afterRange = document.createRange();
  afterRange.selectNodeContents(root);
  afterRange.setStart(range.endContainer, range.endOffset);
  const afterFrag = afterRange.cloneContents();
  const afterDiv = document.createElement("div");
  afterDiv.appendChild(afterFrag);

  return {
    before: serializeDomToInlineMarkdown(beforeDiv),
    after: serializeDomToInlineMarkdown(afterDiv),
  };
}

interface TextSegmentProps {
  id: string;
  text: string;
  disabled: boolean;
  showPlaceholder: boolean;
  placeholder: string;
  ariaLabel: string;
  submitMode: "enter" | "mod-enter";
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

  const tryAutoConvertInlineCode = useCallback((el: HTMLElement): boolean => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return false;
    if (getInlineCodeAncestor(range.startContainer, el)) return false;
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;

    const textNode = range.startContainer as Text;
    const raw = textNode.data;
    const offset = range.startOffset;
    const beforeCaret = raw.slice(0, offset);
    const afterCaret = raw.slice(offset);

    // Match `code` just closed by typing the second backtick, never matching `` or ```.
    const match = /(^|[^`])`([^`\n]+)`$/.exec(beforeCaret);
    if (!match) return false;

    const prefixKeep = beforeCaret.slice(0, match.index + (match[1]?.length ?? 0));
    const codeText = match[2] ?? "";
    if (!codeText) return false;

    const parent = textNode.parentNode;
    if (!parent) return false;

    const frag = document.createDocumentFragment();
    if (prefixKeep) {
      frag.appendChild(document.createTextNode(prefixKeep));
    }
    const codeEl = createInlineCodeElement(codeText);
    frag.appendChild(codeEl);

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
    cleanupStaleSentinels(el);
    if (!composingRef.current) {
      if (tryAutoConvertCodeFence(el)) return;
      tryAutoConvertInlineCode(el);
    }
    // Remove empty inline code tags left behind by deleting all characters inside one.
    for (const codeEl of Array.from(el.querySelectorAll("code[data-inline-code='true']"))) {
      if (!(codeEl.textContent ?? "").replaceAll(ZERO_WIDTH, "")) {
        codeEl.remove();
      }
    }
    const serialized = serializeDomToInlineMarkdown(el);
    lastDomTextRef.current = serialized;
    onTextChange(id, serialized);
  }, [id, onTextChange, tryAutoConvertCodeFence, tryAutoConvertInlineCode]);

  const insertLineBreak = useCallback(
    (el: HTMLElement, sel: Selection, range: Range) => {
      const codeAncestor = getInlineCodeAncestor(range.startContainer, el);
      if (codeAncestor) {
        range.setStartAfter(codeAncestor);
        range.collapse(true);
      } else {
        range.deleteContents();
      }

      const br = document.createElement("br");
      range.insertNode(br);

      if (!hasVisibleContentAfter(br, el)) {
        // Strip empty trailing text nodes / old sentinels so caret sits reliably on the new empty line.
        let sibling = br.nextSibling;
        while (sibling) {
          const next = sibling.nextSibling;
          if (isIgnorableEmptyNode(sibling)) {
            sibling.parentNode?.removeChild(sibling);
          }
          sibling = next;
        }
        br.after(createSentinelBr());
      }

      const nextRange = document.createRange();
      nextRange.setStartAfter(br);
      nextRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nextRange);
      br.scrollIntoView?.({ block: "nearest" });
      syncFromDom();
    },
    [syncFromDom],
  );

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
      if (selected && !selected.includes("\n") && !getInlineCodeAncestor(range.startContainer, el)) {
        e.preventDefault();
        range.deleteContents();
        const codeEl = createInlineCodeElement(selected);
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

    // 2. Exit inline code smoothly with ArrowRight or closing backtick at end of <code>
    if (range && range.collapsed) {
      const codeAncestor = getInlineCodeAncestor(range.startContainer, el);
      if (codeAncestor) {
        const atCodeEnd = (() => {
          const test = document.createRange();
          test.selectNodeContents(codeAncestor);
          test.setStart(range.endContainer, range.endOffset);
          return test.toString().replaceAll(ZERO_WIDTH, "").length === 0;
        })();

        if (atCodeEnd && (e.key === "ArrowRight" || e.key === "`")) {
          e.preventDefault();
          let nextSibling = codeAncestor.nextSibling;
          if (!nextSibling || nextSibling.nodeType !== Node.TEXT_NODE) {
            const z = document.createTextNode(ZERO_WIDTH);
            codeAncestor.after(z);
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

    // 4. Arrow navigation into adjacent code blocks
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

    // 5. Submit / newline behavior based on submitMode
    if (e.key === "Enter") {
      const shouldSubmit =
        submitMode === "mod-enter" ? e.metaKey || e.ctrlKey : !e.shiftKey;
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

    if (el && range) {
      range.deleteContents();
      const normalized = plain.replace(/\r\n/g, "\n");
      const lines = normalized.split("\n");
      const frag = document.createDocumentFragment();
      const inlineRe = /`([^`\n]+)`/g;
      let lastNode: Node | null = null;

      lines.forEach((line, idx) => {
        if (idx > 0) {
          const br = document.createElement("br");
          frag.appendChild(br);
          lastNode = br;
        }
        let last = 0;
        let m: RegExpExecArray | null;
        inlineRe.lastIndex = 0;
        while ((m = inlineRe.exec(line)) !== null) {
          if (m.index > last) {
            const tn = document.createTextNode(line.slice(last, m.index));
            frag.appendChild(tn);
            lastNode = tn;
          }
          const codeEl = createInlineCodeElement(m[1] ?? "");
          frag.appendChild(codeEl);
          const z = document.createTextNode(ZERO_WIDTH);
          frag.appendChild(z);
          lastNode = z;
          last = inlineRe.lastIndex;
        }
        if (last < line.length) {
          const tn = document.createTextNode(line.slice(last));
          frag.appendChild(tn);
          lastNode = tn;
        }
      });

      range.insertNode(frag);
      if (lastNode) {
        const nextRange = document.createRange();
        nextRange.setStartAfter(lastNode);
        nextRange.collapse(true);
        sel!.removeAllRanges();
        sel!.addRange(nextRange);
      }
      syncFromDom();
    }
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
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={syncFromDom}
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

    // Cmd/Ctrl + Enter submits the message directly from inside a code block
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
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
          <span className="hidden sm:inline text-[10.5px] text-[var(--text-muted)]">
            Enter 换行 · ⌘↵ 发送
          </span>
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
  submitMode?: "enter" | "mod-enter";
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
