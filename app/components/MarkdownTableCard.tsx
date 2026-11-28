import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { copyTextToClipboard } from "~/lib/clipboard.ts";
import { Icon } from "./Icon.tsx";
import { MarkdownExpandModal } from "./MarkdownPreviewModal.tsx";
import { MorphIcon } from "./MotionPrimitives.tsx";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export type TableColumnKind = "compact" | "medium" | "wide";

export interface HastLikeNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastLikeNode[];
}

export interface TableAnalysis {
  headers: string[];
  rows: string[][];
  rowCount: number;
  colCount: number;
  colHints: TableColumnKind[];
}

export interface TableLayoutContextValue {
  colHints: TableColumnKind[];
  inTable: boolean;
  expanded: boolean;
}

export const TableLayoutContext = createContext<TableLayoutContextValue>({
  colHints: [],
  inTable: false,
  expanded: false,
});

export const TableCellIndexContext = createContext<number>(-1);

const FULLWIDTH_OR_CJK_RE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

/**
 * Estimate visual column width in half-width ASCII units (CJK/fullwidth = 1.8).
 */
export function computeVisualWidth(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return 0;
  let width = 0;
  for (const ch of normalized) {
    width += FULLWIDTH_OR_CJK_RE.test(ch) ? 1.8 : 1;
  }
  return width;
}

function extractHastText(node: HastLikeNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") {
    return typeof node.value === "string" ? node.value : "";
  }
  if (node.tagName === "br") {
    return " ";
  }
  if (!Array.isArray(node.children)) return "";
  return node.children.map(extractHastText).join("");
}

function collectRowCells(tr: HastLikeNode): string[] {
  if (!Array.isArray(tr.children)) return [];
  const cells: string[] = [];
  for (const child of tr.children) {
    if (
      child.type === "element" &&
      (child.tagName === "th" || child.tagName === "td")
    ) {
      cells.push(extractHastText(child).replace(/\s+/g, " ").trim());
    }
  }
  return cells;
}

function collectTrNodes(section: HastLikeNode): HastLikeNode[] {
  if (!Array.isArray(section.children)) return [];
  return section.children.filter(
    (child) => child.type === "element" && child.tagName === "tr",
  );
}

/**
 * Inspect HAST `<table>` AST to extract structured rows/headers and classify
 * each column as `compact`, `medium`, or `wide` so short numeric columns never
 * wrap mid-token while long narrative columns preserve readable line length.
 */
export function analyzeHastTable(node: HastLikeNode | undefined): TableAnalysis {
  if (!node || !Array.isArray(node.children)) {
    return { headers: [], rows: [], rowCount: 0, colCount: 0, colHints: [] };
  }

  let headers: string[] = [];
  const rows: string[][] = [];

  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "thead") {
      const trs = collectTrNodes(child);
      if (trs.length > 0 && headers.length === 0) {
        headers = collectRowCells(trs[0]!);
      }
      for (const extraTr of trs.slice(1)) {
        rows.push(collectRowCells(extraTr));
      }
    } else if (child.tagName === "tbody" || child.tagName === "tfoot") {
      for (const tr of collectTrNodes(child)) {
        rows.push(collectRowCells(tr));
      }
    } else if (child.tagName === "tr") {
      const cells = collectRowCells(child);
      if (headers.length === 0) {
        headers = cells;
      } else {
        rows.push(cells);
      }
    }
  }

  const colCount = Math.max(
    headers.length,
    ...rows.map((r) => r.length),
    0,
  );
  const colHints: TableColumnKind[] = [];

  for (let j = 0; j < colCount; j += 1) {
    const headerWidth = computeVisualWidth(headers[j] ?? "");
    let maxBodyWidth = 0;
    for (const row of rows) {
      const w = computeVisualWidth(row[j] ?? "");
      if (w > maxBodyWidth) maxBodyWidth = w;
    }

    if (rows.length === 0) {
      if (headerWidth <= 18) {
        colHints.push("compact");
      } else if (headerWidth <= 42) {
        colHints.push("medium");
      } else {
        colHints.push("wide");
      }
      continue;
    }

    if (maxBodyWidth <= 15 && headerWidth <= 18) {
      colHints.push("compact");
    } else if (maxBodyWidth <= 42) {
      colHints.push("medium");
    } else {
      colHints.push("wide");
    }
  }

  return {
    headers,
    rows,
    rowCount: rows.length,
    colCount,
    colHints,
  };
}

function escapeMarkdownCell(cell: string): string {
  return cell
    .replace(/\r?\n+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

export function serializeTableToMarkdown(
  headers: string[],
  rows: string[][],
): string {
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  if (colCount === 0) return "";

  const padRow = (cells: string[]) =>
    Array.from({ length: colCount }, (_, i) => escapeMarkdownCell(cells[i] ?? ""));

  const headerLine =
    headers.length > 0
      ? `| ${padRow(headers).join(" | ")} |`
      : `| ${Array.from({ length: colCount }, (_, i) => `列 ${i + 1}`).join(" | ")} |`;
  const sepLine = `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
  const bodyLines = rows.map((row) => `| ${padRow(row).join(" | ")} |`);

  return [headerLine, sepLine, ...bodyLines].join("\n");
}

function escapeCsvCell(cell: string): string {
  const normalized = cell.replace(/\r?\n/g, " ");
  if (/[",\n\r]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

export function serializeTableToCsv(
  headers: string[],
  rows: string[][],
): string {
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  if (colCount === 0) return "";

  const lines: string[] = [];
  if (headers.length > 0) {
    lines.push(
      Array.from({ length: colCount }, (_, i) =>
        escapeCsvCell(headers[i] ?? ""),
      ).join(","),
    );
  }
  for (const row of rows) {
    lines.push(
      Array.from({ length: colCount }, (_, i) =>
        escapeCsvCell(row[i] ?? ""),
      ).join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}`;
}

export interface MarkdownTableCardProps {
  node?: HastLikeNode;
  compact: boolean;
  children: ReactNode;
}

export function MarkdownTableCard({
  node,
  compact,
  children,
}: MarkdownTableCardProps) {
  const analysis = useMemo(() => analyzeHastTable(node), [node]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const [hasOverflow, setHasOverflow] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [copied, setCopied] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const updateScrollCue = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setHasOverflow(false);
      setCanScrollRight(false);
      return;
    }
    const overflow = el.scrollWidth > el.clientWidth + 2;
    setHasOverflow(overflow);
    setCanScrollRight(
      overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    );
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollCue();

    const handleScroll = () => updateScrollCue();
    el.addEventListener("scroll", handleScroll, { passive: true });

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updateScrollCue);
      observer.observe(el);
      if (el.firstElementChild) {
        observer.observe(el.firstElementChild);
      }
    }

    return () => {
      el.removeEventListener("scroll", handleScroll);
      observer?.disconnect();
    };
  }, [updateScrollCue, analysis]);

  const handleCopyMarkdown = useCallback(async () => {
    const md = serializeTableToMarkdown(analysis.headers, analysis.rows);
    if (!md) return;
    const ok = await copyTextToClipboard(md);
    if (!ok) return;
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, 1800);
  }, [analysis.headers, analysis.rows]);

  const handleDownloadCsv = useCallback(() => {
    const csv = serializeTableToCsv(analysis.headers, analysis.rows);
    if (!csv || typeof document === "undefined" || typeof URL === "undefined") {
      return;
    }
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `relaydesk-table-${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }, [analysis.headers, analysis.rows]);

  const inlineContext = useMemo<TableLayoutContextValue>(
    () => ({
      colHints: analysis.colHints,
      inTable: true,
      expanded: false,
    }),
    [analysis.colHints],
  );

  const expandedContext = useMemo<TableLayoutContextValue>(
    () => ({
      colHints: analysis.colHints,
      inTable: true,
      expanded: true,
    }),
    [analysis.colHints],
  );

  const dimensionLabel =
    analysis.colCount > 0
      ? `${analysis.rowCount} 行 × ${analysis.colCount} 列`
      : undefined;

  return (
    <>
      <div
        className={cn(
          "max-w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--rd-plate)] overflow-hidden shadow-[var(--rd-shadow-plate)]",
          compact ? "my-1.5 first:mt-0 last:mb-0" : "my-2.5 first:mt-0 last:mb-0",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--rd-tray)]/85">
          <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)] select-none">
            <Icon name="table-2" size={12} className="opacity-80" />
            <span>表格</span>
            {dimensionLabel && (
              <span className="font-mono text-[10.5px] text-[var(--text-muted)]/85 tabular-nums">
                {dimensionLabel}
              </span>
            )}
          </div>

          <div className="inline-flex items-center gap-1">
            {hasOverflow && (
              <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[10.5px] text-[var(--text-muted)] select-none">
                可横向滚动
              </span>
            )}

            <button
              type="button"
              onClick={() => {
                void handleCopyMarkdown();
              }}
              aria-label={copied ? "已复制表格" : "复制表格"}
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
              aria-label="放大表格"
              title="弹框放大全览"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press rd-focus-ring cursor-pointer"
            >
              <Icon name="maximize-2" size={11} />
              <span>放大</span>
            </button>
          </div>
        </div>

        <div className="relative">
          <div
            ref={scrollRef}
            className="max-w-full overflow-x-auto rd-scroll bg-[var(--surface-card)]"
          >
            <TableLayoutContext.Provider value={inlineContext}>
              <table className="rd-md-table text-[12.5px] tabular-nums">
                {children}
              </table>
            </TableLayoutContext.Provider>
          </div>

          {canScrollRight && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-7 bg-gradient-to-l from-[var(--surface-card)] to-transparent"
            />
          )}
        </div>
      </div>

      <MarkdownExpandModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="表格全览"
        subtitle={dimensionLabel}
        icon="table-2"
        zoomable
        actions={
          <div className="inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                void handleCopyMarkdown();
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
              <span>{copied ? "已复制" : "复制 Markdown"}</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadCsv}
              className="h-7 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition cursor-pointer"
            >
              <Icon name="download" size={12} />
              <span>下载 CSV</span>
            </button>
          </div>
        }
      >
        <TableLayoutContext.Provider value={expandedContext}>
          <div className="p-3 sm:p-5">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-x-auto rd-scroll shadow-[var(--rd-shadow-plate)]">
              <table className="rd-md-table rd-md-table-expanded text-[1em] tabular-nums">
                {children}
              </table>
            </div>
          </div>
        </TableLayoutContext.Provider>
      </MarkdownExpandModal>
    </>
  );
}
