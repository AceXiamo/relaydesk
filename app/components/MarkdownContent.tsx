import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { preserveSoftLineBreaks } from "~/lib/chat-markdown.ts";
import { Icon } from "./Icon.tsx";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const SAFE_URL_RE = /^(https?:|mailto:)/i;
const SAFE_WORKSPACE_FILE_URL_RE = /^\/api\/projects\/[^/?#\s]+\/workspace\/file\?[^\s#]+$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif)$/i;

function resolveWorkspaceImagePath(raw: string, projectId?: string): string {
  if (!projectId) return "";
  let cleaned = raw.trim();
  if (!cleaned || cleaned.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return "";
  // Strip optional query/hash before validating path
  const qIdx = cleaned.search(/[?#]/);
  if (qIdx >= 0) cleaned = cleaned.slice(0, qIdx);
  cleaned = cleaned.replace(/^\.?\//, "");
  if (cleaned.startsWith("files/")) cleaned = cleaned.slice("files/".length);
  if (!cleaned || cleaned.includes("..") || /[\\\x00-\x1f\x7f]/.test(cleaned)) return "";
  if (!IMAGE_EXT_RE.test(cleaned)) return "";
  return `/api/projects/${encodeURIComponent(projectId)}/workspace/file?path=${encodeURIComponent(cleaned)}&inline=1`;
}

function safeUrlTransform(url: string, key?: string, projectId?: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (SAFE_URL_RE.test(trimmed)) return trimmed;
  if (SAFE_WORKSPACE_FILE_URL_RE.test(trimmed)) return trimmed;
  if (key === "src" && projectId) {
    return resolveWorkspaceImagePath(trimmed, projectId);
  }
  return "";
}

/**
 * Heuristic to detect whether raw user text contains Markdown formatting
 * (headings, lists, code fences, inline code, links, tables, blockquotes, bold).
 */
export function hasMarkdownSyntax(text: string): boolean {
  if (!text) return false;
  return (
    /(^|\n)\s{0,3}#{1,6}\s+\S/.test(text) ||
    /```/.test(text) ||
    /`[^`\n]+`/.test(text) ||
    /(^|\n)\s*([-*+]|\d+\.)\s+\S/.test(text) ||
    /(^|\n)\s*>\s+\S/.test(text) ||
    /\*\*[^*\n]+\*\*|__[^_\n]+__/.test(text) ||
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

interface HastLikeNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLikeNode[];
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
    // Support loose GFM task lists where the checkbox sits inside a leading <p>.
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

async function copyCodeText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to textarea fallback.
    }
  }

  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return ok;
}

function CodeBlockCard({
  language,
  code,
  compact,
}: {
  language: string;
  code: string;
  compact: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const ok = await copyCodeText(code);
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

  return (
    <div
      className={cn(
        "max-w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/70 dark:bg-[#0d0f13] overflow-hidden rd-hairline-glow",
        compact ? "my-1.5 first:mt-0 last:mb-0" : "my-2.5 first:mt-0 last:mb-0",
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]/90 dark:bg-white/[0.025]">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-mono font-medium text-[var(--text-muted)] select-none">
          <Icon name="code-2" size={12} className="opacity-75" />
          <span>{language}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            void handleCopy();
          }}
          aria-label={copied ? "已复制代码" : "复制代码"}
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium transition-colors rd-focus-ring",
            copied
              ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
              : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
          )}
        >
          <Icon name={copied ? "check" : "copy"} size={11} />
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre
        className={cn(
          "m-0 overflow-x-auto rd-scroll font-mono text-[12px] leading-[1.6] text-[var(--text-primary)]",
          compact ? "px-3 py-2" : "px-3.5 py-2.5",
        )}
      >
        <code className="font-mono text-[12px] bg-transparent p-0 border-0">
          {code}
        </code>
      </pre>
    </div>
  );
}

export interface MarkdownContentProps {
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
  className,
  projectId,
}: MarkdownContentProps) {
  const urlTransform = useCallback(
    (url: string, key?: string) => safeUrlTransform(url, key, projectId),
    [projectId],
  );
  const components = useMemo<Components>(
    () => ({
      h1: ({ children }) => (
        <h1
          className={cn(
            "font-semibold tracking-tight text-[var(--text-primary)] border-b border-[var(--border-subtle)] pb-1 first:mt-0",
            compact ? "text-[14px] mt-2.5 mb-1" : "text-[15px] mt-3.5 mb-1.5",
          )}
        >
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2
          className={cn(
            "font-semibold tracking-tight text-[var(--text-primary)] first:mt-0",
            compact ? "text-[13.5px] mt-2.5 mb-1" : "text-[14px] mt-3 mb-1.5",
          )}
        >
          {children}
        </h2>
      ),
      h3: ({ children }) => (
        <h3
          className={cn(
            "font-semibold tracking-tight text-[var(--text-primary)] first:mt-0",
            compact ? "text-[13px] mt-2 mb-1" : "text-[13.5px] mt-2.5 mb-1",
          )}
        >
          {children}
        </h3>
      ),
      h4: ({ children }) => (
        <h4
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
      li: ({ children, className: liClass, node }) => {
        const isTaskItem = Boolean(liClass?.includes("task-list-item"));
        if (!isTaskItem) {
          return (
            <li className={cn(compact ? "leading-[1.55]" : "leading-[1.65]")}>
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
          // Drop single leading space emitted by remark-gfm after checkbox input.
          if (typeof rest[0] === "string" && rest[0].startsWith(" ")) {
            rest[0] = rest[0].slice(1);
          }
          return (
            <li
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
        return (
          <CodeBlockCard
            language={language}
            code={rawCode}
            compact={compact}
          />
        );
      },
      code: ({ children }) => (
        <code className="px-1.5 py-0.5 rounded-md bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[12px] font-mono text-[var(--text-primary)] break-words">
          {children}
        </code>
      ),
      blockquote: ({ children }) => (
        <blockquote
          className={cn(
            "first:mt-0 last:mb-0 pl-3 pr-2.5 border-l-2 border-indigo-500/50 bg-[var(--surface-subtle)]/70 rounded-r-lg text-[var(--text-secondary)]",
            compact ? "my-1.5 py-1" : "my-2 py-1.5",
          )}
        >
          {children}
        </blockquote>
      ),
      table: ({ children }) => (
        <div
          className={cn(
            "max-w-full first:mt-0 last:mb-0 overflow-x-auto rd-scroll rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)]",
            compact ? "my-1.5" : "my-2.5",
          )}
        >
          <table className="w-full border-collapse text-[12.5px] tabular-nums">
            {children}
          </table>
        </div>
      ),
      thead: ({ children }) => (
        <thead className="bg-[var(--surface-subtle)]/85 border-b border-[var(--border-subtle)]">
          {children}
        </thead>
      ),
      tr: ({ children }) => (
        <tr className="border-t border-[var(--border-subtle)]/70 first:border-t-0 hover:bg-[var(--surface-hover)]/45 transition-colors">
          {children}
        </tr>
      ),
      th: ({ children }) => (
        <th className="px-3 py-1.5 text-left text-[12px] font-medium text-[var(--text-secondary)] whitespace-nowrap">
          {children}
        </th>
      ),
      td: ({ children }) => (
        <td className="px-3 py-1.5 text-[var(--text-primary)] align-top">
          {children}
        </td>
      ),
      a: ({ href, children }) => {
        const safeHref = href ? safeUrlTransform(href) : "";
        if (!safeHref) {
          return (
            <span className="text-[var(--text-secondary)]">{children}</span>
          );
        }
        return (
          <a
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-600 dark:text-indigo-400 underline decoration-indigo-500/35 underline-offset-2 hover:decoration-indigo-500 transition-colors break-words"
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
      img: ({ src, alt }) => {
        const safeSrc = src ? safeUrlTransform(src, "src", projectId) : "";
        if (!safeSrc) return null;
        return (
          <a
            href={safeSrc}
            target="_blank"
            rel="noopener noreferrer"
            className="block my-2 group"
          >
            <img
              src={safeSrc}
              alt={alt || "截图附件"}
              loading="lazy"
              className="max-h-80 w-auto max-w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] object-contain shadow-2xs group-hover:border-indigo-500/50 transition-colors"
            />
          </a>
        );
      },
    }),
    [compact, projectId],
  );

  if (!content.trim()) return null;

  const renderedContent = preserveLineBreaks ? preserveSoftLineBreaks(content) : content;

  return (
    <div
      className={cn(
        "rd-md",
        compact ? "text-[12.5px]" : "text-[13px]",
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={components}
      >
        {renderedContent}
      </Markdown>
    </div>
  );
}
