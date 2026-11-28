import { ChatWorkspaceImage, ImageTurnStreaming } from "./ChatWorkspaceImage.tsx";
import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { preserveSoftLineBreaks } from "~/lib/chat-markdown.ts";
import { copyTextToClipboard } from "~/lib/clipboard.ts";
import { Icon } from "./Icon.tsx";
import { MarkdownExpandModal } from "./MarkdownPreviewModal.tsx";
import {
  MarkdownTableCard,
  TableCellIndexContext,
  TableLayoutContext,
  type HastLikeNode,
} from "./MarkdownTableCard.tsx";
import { MermaidDiagramCard } from "./MermaidDiagramCard.tsx";
import { MorphIcon } from "./MotionPrimitives.tsx";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const SAFE_URL_RE = /^(https?:|mailto:)/i;
const SAFE_FRAGMENT_RE = /^#[a-zA-Z0-9_.:-]+$/;
const SAFE_WORKSPACE_FILE_URL_RE =
  /^\/api\/projects\/[^/?#\s]+\/workspace\/file\?[^\s#]+$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif)$/i;

function resolveWorkspaceImagePath(raw: string, projectId?: string): string {
  if (!projectId) return "";
  let cleaned = raw.trim();
  if (!cleaned || cleaned.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(cleaned)) {
    return "";
  }
  const qIdx = cleaned.search(/[?#]/);
  if (qIdx >= 0) cleaned = cleaned.slice(0, qIdx);
  cleaned = cleaned.replace(/^\.?\//, "");
  if (cleaned.startsWith("files/")) cleaned = cleaned.slice("files/".length);
  if (!cleaned || cleaned.includes("..") || /[\\\x00-\x1f\x7f]/.test(cleaned)) {
    return "";
  }
  if (!IMAGE_EXT_RE.test(cleaned)) return "";
  return `/api/projects/${encodeURIComponent(projectId)}/workspace/file?path=${encodeURIComponent(cleaned)}&inline=1`;
}

function safeUrlTransform(url: string, key?: string, projectId?: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (key === "href" && SAFE_FRAGMENT_RE.test(trimmed)) return trimmed;
  if (SAFE_URL_RE.test(trimmed)) return trimmed;
  if (SAFE_WORKSPACE_FILE_URL_RE.test(trimmed)) return trimmed;
  if (key === "src" && projectId) {
    return resolveWorkspaceImagePath(trimmed, projectId);
  }
  return "";
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

function shouldRevertCurrencyInlineMath(
  node: MdastNode,
  nextSibling: MdastNode | undefined,
): boolean {
  const val = node.value ?? "";
  if (!val) return true;
  if (/^\s|\s$/.test(val)) return true;
  if (nextSibling?.type === "text" && /^[0-9]/.test(nextSibling.value ?? "")) {
    return true;
  }
  if (
    /^[0-9]/.test(val) &&
    /[\s\u4e00-\u9fff]/.test(val) &&
    !/[\\^_{}=+*/]/.test(val)
  ) {
    return true;
  }
  return false;
}

function revertCurrencyMathInNode(node: MdastNode): void {
  if (!Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i]!;
    if (child.type === "inlineMath") {
      if (shouldRevertCurrencyInlineMath(child, node.children[i + 1])) {
        node.children[i] = {
          type: "text",
          value: `$${child.value ?? ""}$`,
        };
      }
      continue;
    }
    revertCurrencyMathInNode(child);
  }
}

function remarkCurrencyMathGuard() {
  return (tree: MdastNode) => {
    revertCurrencyMathInNode(tree);
  };
}

const MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: Array.from(
    new Set([
      ...(defaultSchema.tagNames ?? []),
      "details",
      "summary",
      "kbd",
      "mark",
      "sub",
      "sup",
      "br",
      "abbr",
      "ins",
      "del",
      "section",
      "input",
    ]),
  ),
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-./, "math-inline", "math-display", "math"],
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className", "math-inline", "math-display", "math"],
    ],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ["className", "math-inline", "math-display", "math"],
    ],
    input: [
      ...(defaultSchema.attributes?.input ?? []),
      ["type", "checkbox"],
      ["checked", true],
      ["disabled", true],
    ],
    a: [...(defaultSchema.attributes?.a ?? []), "id"],
    li: [...(defaultSchema.attributes?.li ?? []), "id"],
    h2: [...(defaultSchema.attributes?.h2 ?? []), "id"],
    abbr: [...(defaultSchema.attributes?.abbr ?? []), "title"],
  },
};

type MarkdownPluginList = ComponentProps<typeof Markdown>["remarkPlugins"];
type RehypePluginList = ComponentProps<typeof Markdown>["rehypePlugins"];

const REMARK_PLUGINS: MarkdownPluginList = [
  remarkGfm,
  remarkMath,
  remarkCurrencyMathGuard as unknown as NonNullable<MarkdownPluginList>[number],
];

const REHYPE_PLUGINS: RehypePluginList = [
  rehypeRaw,
  [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA],
  [rehypeKatex, { strict: false, throwOnError: false }],
  [
    rehypeHighlight,
    {
      detect: false,
      ignoreMissing: true,
      plainText: ["mermaid", "text", "txt", "plain", "math"],
    },
  ],
];

/**
 * Heuristic to detect whether raw user text contains Markdown formatting
 * (headings, lists, code fences, inline code, links, tables, blockquotes, math, details, bold).
 */
export function hasMarkdownSyntax(text: string): boolean {
  if (!text) return false;
  return (
    /(^|\n)\s{0,3}#{1,6}\s+\S/.test(text) ||
    /```/.test(text) ||
    /(^|\n)\s*\$\$[\s\S]+?\$\$/m.test(text) ||
    /<details[\s>]/i.test(text) ||
    /`[^`\n]+`/.test(text) ||
    /(^|\n)\s*([-*+]|\d+\.)\s+\S/.test(text) ||
    /(^|\n)\s*>+\s+\S/.test(text) ||
    /\*\*[^*\n]+\*\*|__[^_\n]+__/.test(text) ||
    /~~[^\s~\n](?:[^~\n]*[^\s~\n])?~~/.test(text) ||
    /(^|[^A-Za-z0-9_*])\*[^\s*\n](?:[^*\n]*[^\s*\n])?\*(?![A-Za-z0-9_*])/.test(text) ||
    /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/i.test(text) ||
    /!\[[^\]\n]*\]\(https?:\/\/[^)\s]+\)/i.test(text) ||
    /(^|\n)\|.+\|\s*\n\s*\|[\s:|-]+\|/.test(text)
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  return "";
}

function isTaskNodeChecked(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const hast = node as HastLikeNode;
  if (!Array.isArray(hast.children)) return false;

  for (const child of hast.children) {
    if (child.type !== "element") continue;
    if (
      child.tagName === "input" &&
      child.properties?.type === "checkbox" &&
      Boolean(child.properties?.checked)
    ) {
      return true;
    }
    if (child.tagName === "p" && Array.isArray(child.children)) {
      for (const grand of child.children) {
        if (
          grand.type === "element" &&
          grand.tagName === "input" &&
          grand.properties?.type === "checkbox" &&
          Boolean(grand.properties?.checked)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

type GithubAlertKind = "note" | "tip" | "important" | "warning" | "caution";

const GITHUB_ALERT_META: Record<
  GithubAlertKind,
  {
    label: string;
    icon: string;
    border: string;
    bg: string;
    titleColor: string;
  }
> = {
  note: {
    label: "说明",
    icon: "info",
    border: "border-sky-500/45",
    bg: "bg-sky-500/[0.06]",
    titleColor: "text-sky-700 dark:text-sky-300",
  },
  tip: {
    label: "提示",
    icon: "lightbulb",
    border: "border-emerald-500/45",
    bg: "bg-emerald-500/[0.06]",
    titleColor: "text-emerald-700 dark:text-emerald-300",
  },
  important: {
    label: "重要",
    icon: "sparkles",
    border: "border-indigo-500/45",
    bg: "bg-indigo-500/[0.06]",
    titleColor: "text-indigo-700 dark:text-indigo-300",
  },
  warning: {
    label: "注意",
    icon: "alert-triangle",
    border: "border-amber-500/50",
    bg: "bg-amber-500/[0.07]",
    titleColor: "text-amber-700 dark:text-amber-300",
  },
  caution: {
    label: "警告",
    icon: "alert-circle",
    border: "border-rose-500/50",
    bg: "bg-rose-500/[0.07]",
    titleColor: "text-rose-700 dark:text-rose-300",
  },
};

function parseGithubAlertBlockquote(
  children: ReactNode,
): { kind: GithubAlertKind; body: ReactNode[] } | null {
  const topNodes = Children.toArray(children).filter(
    (item) => !(typeof item === "string" && !item.trim()),
  );
  if (topNodes.length === 0) return null;
  const firstEl = topNodes[0];
  if (!isValidElement<{ children?: ReactNode }>(firstEl)) return null;

  const firstChildren = Children.toArray(firstEl.props.children);
  if (firstChildren.length === 0) return null;
  const leading = firstChildren[0];
  if (typeof leading !== "string") return null;

  const match =
    /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*\n|[ \t]+|$)/i.exec(
      leading,
    );
  if (!match?.[1]) return null;

  const kind = match[1].toLowerCase() as GithubAlertKind;
  const remainingText = leading.slice(match[0].length);
  const nextFirstChildren = [...firstChildren];

  if (remainingText) {
    nextFirstChildren[0] = remainingText;
  } else {
    nextFirstChildren.shift();
    if (
      nextFirstChildren[0] &&
      isValidElement(nextFirstChildren[0]) &&
      nextFirstChildren[0].type === "br"
    ) {
      nextFirstChildren.shift();
    }
    if (typeof nextFirstChildren[0] === "string") {
      const trimmedLead = nextFirstChildren[0].replace(/^\n+/, "");
      if (trimmedLead) {
        nextFirstChildren[0] = trimmedLead;
      } else {
        nextFirstChildren.shift();
      }
    }
  }

  const body: ReactNode[] = [];
  if (nextFirstChildren.length > 0) {
    body.push(cloneElement(firstEl, { key: "alert-lead" }, nextFirstChildren));
  }
  body.push(...topNodes.slice(1));
  return { kind, body };
}

function CodeBlockCard({
  language,
  code,
  highlightedNode,
  compact,
}: {
  language: string;
  code: string;
  highlightedNode?: ReactNode;
  compact: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(code);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, 1800);
  }, [code]);

  const lineCount = useMemo(() => (code ? code.split("\n").length : 0), [code]);
  const modalTitle =
    language === "text" ? "代码块预览" : `代码 · ${language}`;
  const renderedCode = highlightedNode ?? (
    <code className="font-mono text-[inherit] bg-transparent p-0 border-0">
      {code}
    </code>
  );

  return (
    <>
      <div
        className={cn(
          "max-w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--rd-plate)] overflow-hidden shadow-[var(--rd-shadow-plate)]",
          compact ? "my-1.5 first:mt-0 last:mb-0" : "my-2.5 first:mt-0 last:mb-0",
        )}
      >
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--rd-tray)]/85">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-mono font-medium text-[var(--text-muted)] select-none">
            <Icon name="code-2" size={12} className="opacity-75" />
            <span>{language}</span>
          </span>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => setWrapped((prev) => !prev)}
              aria-label={wrapped ? "取消自动换行" : "自动换行"}
              title={wrapped ? "取消自动换行" : "自动换行"}
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium transition-colors rd-press rd-focus-ring cursor-pointer",
                wrapped
                  ? "text-indigo-600 dark:text-indigo-400 bg-indigo-500/10"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
              )}
            >
              <Icon name="wrap-text" size={11} />
              <span className="hidden sm:inline">换行</span>
            </button>

            <button
              type="button"
              onClick={() => {
                void handleCopy();
              }}
              aria-label={copied ? "已复制代码" : "复制代码"}
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium transition-colors rd-press rd-focus-ring cursor-pointer",
                copied
                  ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
              )}
            >
              <MorphIcon
                name="copy"
                activeName="check"
                active={copied}
                size={11}
                activeClassName="text-emerald-600 dark:text-emerald-400"
              />
              <span>{copied ? "已复制" : "复制"}</span>
            </button>

            <button
              type="button"
              onClick={() => setModalOpen(true)}
              aria-label="放大代码块"
              title="弹框放大"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press rd-focus-ring cursor-pointer"
            >
              <Icon name="maximize-2" size={11} />
              <span>放大</span>
            </button>
          </div>
        </div>
        <pre
          className={cn(
            "m-0 overflow-x-auto rd-scroll font-mono text-[12px] leading-[1.6] text-[var(--text-primary)]",
            wrapped ? "whitespace-pre-wrap break-words" : "whitespace-pre",
            compact ? "px-3 py-2" : "px-3.5 py-2.5",
          )}
        >
          {renderedCode}
        </pre>
      </div>

      <MarkdownExpandModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={modalTitle}
        subtitle={`${lineCount} 行`}
        icon="code-2"
        zoomable
        actions={
          <div className="inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setWrapped((prev) => !prev)}
              className={cn(
                "h-7 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] inline-flex items-center gap-1.5 text-[11.5px] font-medium transition cursor-pointer",
                wrapped
                  ? "text-indigo-600 dark:text-indigo-400 border-indigo-500/35 bg-indigo-500/10"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
              )}
            >
              <Icon name="wrap-text" size={12} />
              <span>{wrapped ? "已换行" : "自动换行"}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                void handleCopy();
              }}
              className={cn(
                "h-7 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] inline-flex items-center gap-1.5 text-[11.5px] font-medium transition cursor-pointer",
                copied
                  ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/35 bg-emerald-500/10"
                  : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
              )}
            >
              <MorphIcon
                name="copy"
                activeName="check"
                active={copied}
                size={12}
                activeClassName="text-emerald-600 dark:text-emerald-400"
              />
              <span>{copied ? "已复制" : "复制代码"}</span>
            </button>
          </div>
        }
      >
        <pre
          className={cn(
            "m-0 p-4 sm:p-5 font-mono text-[0.875em] leading-[1.65] text-[var(--text-primary)]",
            wrapped ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          )}
        >
          {renderedCode}
        </pre>
      </MarkdownExpandModal>
    </>
  );
}

function resolveAlignmentClass(align?: string, textAlign?: string): string {
  const val = (align || textAlign || "").toLowerCase();
  if (val === "center") return "text-center";
  if (val === "right") return "text-right";
  return "text-left";
}

function TableHeaderCell({
  align,
  style,
  children,
}: {
  align?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const alignClass = resolveAlignmentClass(
    align,
    typeof style?.textAlign === "string" ? style.textAlign : undefined,
  );
  return (
    <th
      className={cn(
        "px-3 py-2 text-[12px] font-medium text-[var(--text-secondary)] whitespace-nowrap",
        alignClass,
      )}
    >
      {children}
    </th>
  );
}

function TableBodyCell({
  align,
  style,
  children,
}: {
  align?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const { colHints } = useContext(TableLayoutContext);
  const colIndex = useContext(TableCellIndexContext);
  const hint = colIndex >= 0 ? colHints[colIndex] : undefined;
  const alignClass = resolveAlignmentClass(
    align,
    typeof style?.textAlign === "string" ? style.textAlign : undefined,
  );

  if (hint === "compact") {
    return (
      <td
        className={cn(
          "px-3 py-2 text-[var(--text-primary)] align-top whitespace-nowrap",
          alignClass,
        )}
      >
        {children}
      </td>
    );
  }

  const innerClass =
    hint === "wide"
      ? "rd-md-cell rd-md-cell-lg"
      : hint === "medium"
        ? "rd-md-cell rd-md-cell-md"
        : "rd-md-cell";

  return (
    <td
      className={cn(
        "px-3 py-2 text-[var(--text-primary)] align-top",
        alignClass,
      )}
    >
      <div className={innerClass}>{children}</div>
    </td>
  );
}

function InlineOrBlockCode({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { inTable } = useContext(TableLayoutContext);
  const isBlockCode = Boolean(
    className && /(?:^|\s)(?:hljs|language-)/.test(className),
  );

  if (isBlockCode) {
    return (
      <code
        className={cn(
          "font-mono text-[inherit] bg-transparent p-0 border-0",
          className,
        )}
      >
        {children}
      </code>
    );
  }

  const plain = extractText(children).trim();
  const wrapClass = inTable
    ? plain.length > 0 && plain.length <= 24
      ? "whitespace-nowrap"
      : "break-all"
    : "break-words";

  return (
    <code
      className={cn(
        "px-1.5 py-0.5 rounded-md bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[12px] font-mono text-[var(--text-primary)]",
        wrapClass,
      )}
    >
      {children}
    </code>
  );
}

export interface MarkdownContentProps {
  streaming?: boolean;
  content: string;
  compact?: boolean;
  preserveLineBreaks?: boolean;
  className?: string;
  projectId?: string;
}

export function MarkdownContent({
  content,
  compact = false,
  preserveLineBreaks = false,
  streaming = false,
  className,
  projectId,
}: MarkdownContentProps) {
  const urlTransform = useCallback(
    (url: string, key?: string) => safeUrlTransform(url, key, projectId),
    [projectId],
  );
  const components = useMemo<Components>(
    () => ({
      h1: ({ children, id }) => (
        <h1
          id={id}
          className={cn(
            "font-semibold tracking-tight text-[var(--text-primary)] border-b border-[var(--border-subtle)] pb-1 first:mt-0",
            compact ? "text-[14px] mt-2.5 mb-1" : "text-[15px] mt-3.5 mb-1.5",
          )}
        >
          {children}
        </h1>
      ),
      h2: ({ children, id, className: h2Class }) => (
        <h2
          id={id}
          className={cn(
            "font-semibold tracking-tight text-[var(--text-primary)] first:mt-0",
            compact ? "text-[13.5px] mt-2.5 mb-1" : "text-[14px] mt-3 mb-1.5",
            h2Class,
          )}
        >
          {children}
        </h2>
      ),
      h3: ({ children, id }) => (
        <h3
          id={id}
          className={cn(
            "font-semibold tracking-tight text-[var(--text-primary)] first:mt-0",
            compact ? "text-[13px] mt-2 mb-1" : "text-[13.5px] mt-2.5 mb-1",
          )}
        >
          {children}
        </h3>
      ),
      h4: ({ children, id }) => (
        <h4
          id={id}
          className={cn(
            "font-semibold tracking-tight text-[var(--text-secondary)] first:mt-0",
            compact ? "text-[12.5px] mt-2 mb-0.5" : "text-[13px] mt-2 mb-1",
          )}
        >
          {children}
        </h4>
      ),
      p: ({ children }) => (
        <p
          className={cn(
            "first:mt-0 last:mb-0 break-words",
            compact ? "leading-[1.58] my-1" : "leading-[1.65] my-1.5",
          )}
        >
          {children}
        </p>
      ),
      ul: ({ children, className: ulClass }) => {
        const isTaskList = Boolean(ulClass?.includes("contains-task-list"));
        return (
          <ul
            className={cn(
              "first:mt-0 last:mb-0",
              compact ? "my-1 space-y-1" : "my-1.5 space-y-1.5",
              isTaskList
                ? "contains-task-list list-none pl-0"
                : "list-disc pl-5 marker:text-[var(--text-muted)]",
            )}
          >
            {children}
          </ul>
        );
      },
      ol: ({ children }) => (
        <ol
          className={cn(
            "first:mt-0 last:mb-0 list-decimal pl-5 marker:text-[var(--text-muted)] marker:tabular-nums",
            compact ? "my-1 space-y-1" : "my-1.5 space-y-1",
          )}
        >
          {children}
        </ol>
      ),
      li: ({ children, className: liClass, id, node }) => {
        const isTaskItem = Boolean(liClass?.includes("task-list-item"));
        if (!isTaskItem) {
          return (
            <li
              id={id}
              className={cn(compact ? "leading-[1.55]" : "leading-[1.65]")}
            >
              {children}
            </li>
          );
        }

        const checked = isTaskNodeChecked(node);
        const childArray = Children.toArray(children);
        const firstChild = childArray[0];
        const isDirectCheckbox =
          isValidElement<{ type?: string }>(firstChild) &&
          firstChild.props.type === "checkbox";

        if (isDirectCheckbox) {
          const rest = childArray.slice(1);
          if (typeof rest[0] === "string" && rest[0].startsWith(" ")) {
            rest[0] = rest[0].slice(1);
          }
          return (
            <li
              id={id}
              data-checked={checked ? "true" : "false"}
              className="task-list-item flex items-start gap-2 leading-[1.6]"
            >
              <span className="pt-[2px] shrink-0">{firstChild}</span>
              <div className="rd-md-task-text flex-1 min-w-0">{rest}</div>
            </li>
          );
        }

        return (
          <li
            id={id}
            data-checked={checked ? "true" : "false"}
            className="task-list-item leading-[1.6]"
          >
            {children}
          </li>
        );
      },
      input: ({ type, checked }) => {
        if (type !== "checkbox") return null;
        const isChecked = Boolean(checked);
        return (
          <span
            role="checkbox"
            aria-checked={isChecked}
            aria-disabled="true"
            className={cn(
              "inline-flex items-center justify-center w-4 h-4 rounded-[5px] border align-[-2.5px] mr-1.5 last:mr-0 select-none transition-colors",
              isChecked
                ? "bg-emerald-500/15 border-emerald-500/45 text-emerald-600 dark:text-emerald-400"
                : "bg-[var(--surface-card)] border-[var(--border-strong)] text-transparent",
            )}
          >
            {isChecked ? <Icon name="check" size={11} /> : null}
          </span>
        );
      },
      pre: ({ children }) => {
        const childArray = Children.toArray(children);
        const codeChild = childArray.find((child) => isValidElement(child));
        let language = "text";
        if (
          codeChild &&
          isValidElement<{ className?: string }>(codeChild) &&
          typeof codeChild.props.className === "string"
        ) {
          const match = /language-([a-zA-Z0-9_+-]+)/.exec(
            codeChild.props.className,
          );
          if (match?.[1]) {
            language = match[1].toLowerCase();
          }
        }
        const rawCode = extractText(children).replace(/\n$/, "");
        if (language === "mermaid") {
          return (
            <MermaidDiagramCard
              code={rawCode}
              compact={compact}
              streaming={streaming}
            />
          );
        }
        return (
          <CodeBlockCard
            language={language}
            code={rawCode}
            highlightedNode={codeChild}
            compact={compact}
          />
        );
      },
      code: ({ className: codeClass, children }) => (
        <InlineOrBlockCode className={codeClass}>{children}</InlineOrBlockCode>
      ),
      blockquote: ({ children }) => {
        const alert = parseGithubAlertBlockquote(children);
        if (alert) {
          const meta = GITHUB_ALERT_META[alert.kind];
          return (
            <div
              data-rd-alert={alert.kind}
              className={cn(
                "first:mt-0 last:mb-0 rounded-r-xl border-l-[3px] px-3.5 text-[var(--text-primary)]",
                meta.border,
                meta.bg,
                compact ? "my-1.5 py-2" : "my-2.5 py-2.5",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-1.5 text-[12px] font-semibold mb-1 select-none",
                  meta.titleColor,
                )}
              >
                <Icon name={meta.icon} size={14} />
                <span>{meta.label}</span>
              </div>
              <div className="text-[var(--text-secondary)]">{alert.body}</div>
            </div>
          );
        }
        return (
          <blockquote
            className={cn(
              "first:mt-0 last:mb-0 pl-3 pr-2.5 border-l-2 border-indigo-500/50 bg-[var(--surface-subtle)]/70 rounded-r-lg text-[var(--text-secondary)]",
              compact ? "my-1.5 py-1" : "my-2 py-1.5",
            )}
          >
            {children}
          </blockquote>
        );
      },
      table: ({ children, node }) => (
        <MarkdownTableCard
          node={node as unknown as HastLikeNode}
          compact={compact}
        >
          {children}
        </MarkdownTableCard>
      ),
      thead: ({ children }) => (
        <thead className="bg-[var(--surface-subtle)]/85 border-b border-[var(--border-subtle)]">
          {children}
        </thead>
      ),
      tr: ({ children }) => {
        let cellIdx = 0;
        const indexed = Children.toArray(children).map((child) => {
          if (isValidElement(child)) {
            const idx = cellIdx;
            cellIdx += 1;
            return (
              <TableCellIndexContext.Provider
                key={child.key ?? `cell-${idx}`}
                value={idx}
              >
                {child}
              </TableCellIndexContext.Provider>
            );
          }
          return child;
        });
        return (
          <tr className="border-t border-[var(--border-subtle)]/70 first:border-t-0 hover:bg-[var(--surface-hover)]/45 transition-colors">
            {indexed}
          </tr>
        );
      },
      th: ({ children, align, style }) => (
        <TableHeaderCell align={align} style={style}>
          {children}
        </TableHeaderCell>
      ),
      td: ({ children, align, style }) => (
        <TableBodyCell align={align} style={style}>
          {children}
        </TableBodyCell>
      ),
      a: ({ href, children, id, ...rest }) => {
        const safeHref = href ? safeUrlTransform(href, "href") : "";
        if (!safeHref) {
          return (
            <span className="text-[var(--text-secondary)]">{children}</span>
          );
        }
        const isFragment = safeHref.startsWith("#");
        return (
          <a
            id={id}
            href={safeHref}
            target={isFragment ? undefined : "_blank"}
            rel={isFragment ? undefined : "noopener noreferrer"}
            className="text-indigo-600 dark:text-indigo-400 underline decoration-indigo-500/35 underline-offset-2 hover:decoration-indigo-500 transition-colors break-words"
            {...rest}
          >
            {children}
          </a>
        );
      },
      hr: () => (
        <hr className="my-3 border-0 border-t border-[var(--border-subtle)]" />
      ),
      strong: ({ children }) => (
        <strong className="font-semibold text-[var(--text-primary)]">
          {children}
        </strong>
      ),
      del: ({ children }) => (
        <del className="line-through text-[var(--text-muted)]">{children}</del>
      ),
      details: ({ children, open }) => (
        <details
          open={open}
          className={cn(
            "group rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2",
            compact ? "my-1.5 first:mt-0 last:mb-0" : "my-2.5 first:mt-0 last:mb-0",
          )}
        >
          {children}
        </details>
      ),
      summary: ({ children }) => (
        <summary className="cursor-pointer select-none font-medium text-[var(--text-primary)] hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">
          {children}
        </summary>
      ),
      kbd: ({ children }) => <kbd className="rd-kbd">{children}</kbd>,
      mark: ({ children }) => (
        <mark className="px-1 py-0.5 rounded bg-amber-500/20 text-[var(--text-primary)]">
          {children}
        </mark>
      ),
      sup: ({ children }) => (
        <sup className="text-[0.75em] align-super leading-none">{children}</sup>
      ),
      sub: ({ children }) => (
        <sub className="text-[0.75em] align-sub leading-none">{children}</sub>
      ),
      section: ({ children, className: secClass, ...rest }) => {
        const isFootnotes = Boolean(secClass?.includes("footnotes"));
        return (
          <section
            className={cn(
              isFootnotes &&
                "footnotes mt-4 pt-3 border-t border-[var(--border-subtle)] text-[12px] text-[var(--text-muted)]",
              secClass,
            )}
            {...rest}
          >
            {children}
          </section>
        );
      },
      img: ({ src, alt }) => {
        const safeSrc = src ? safeUrlTransform(src, "src", projectId) : "";
        if (!safeSrc) return null;
        return (
          <ChatWorkspaceImage
            key={safeSrc}
            url={safeSrc}
            alt={alt || "截图附件"}
            linkClassName="block my-2 group"
            className="max-h-80 w-auto max-w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] object-contain shadow-2xs group-hover:border-indigo-500/50 transition-colors"
          />
        );
      },
    }),
    [compact, projectId, streaming],
  );

  if (!content.trim()) return null;

  const renderedContent = preserveLineBreaks
    ? preserveSoftLineBreaks(content)
    : content;

  return (
    <div
      className={cn(
        "rd-md",
        compact ? "text-[12.5px]" : "text-[13px]",
        className,
      )}
    >
      <ImageTurnStreaming.Provider value={streaming}>
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          urlTransform={urlTransform}
          components={components}
        >
          {renderedContent}
        </Markdown>
      </ImageTurnStreaming.Provider>
    </div>
  );
}
