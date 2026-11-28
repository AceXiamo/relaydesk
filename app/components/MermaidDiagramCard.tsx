import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { copyTextToClipboard } from "~/lib/clipboard.ts";
import { Icon } from "./Icon.tsx";
import { DiagramLightboxModal } from "./MarkdownPreviewModal.tsx";
import { MorphIcon } from "./MotionPrimitives.tsx";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export interface MermaidDiagramMeta {
  label: string;
  icon: string;
}

const MERMAID_TYPE_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
  icon: string;
}> = [
  { pattern: /^gantt\b/i, label: "甘特图", icon: "chart-gantt" },
  { pattern: /^(?:flowchart|graph)\b/i, label: "流程图", icon: "workflow" },
  { pattern: /^sequenceDiagram\b/i, label: "时序图", icon: "workflow" },
  { pattern: /^classDiagram(?:-v2)?\b/i, label: "类图", icon: "workflow" },
  { pattern: /^stateDiagram(?:-v2)?\b/i, label: "状态图", icon: "workflow" },
  { pattern: /^erDiagram\b/i, label: "ER 图", icon: "database" },
  { pattern: /^mindmap\b/i, label: "思维导图", icon: "sparkles" },
  { pattern: /^timeline\b/i, label: "时间线", icon: "calendar-clock" },
  { pattern: /^pie\b/i, label: "饼图", icon: "workflow" },
  { pattern: /^gitGraph\b/i, label: "Git 分支图", icon: "git-branch" },
  { pattern: /^quadrantChart\b/i, label: "象限图", icon: "table-2" },
  { pattern: /^journey\b/i, label: "用户旅程", icon: "workflow" },
  { pattern: /^xychart-beta\b/i, label: "数据图表", icon: "workflow" },
  { pattern: /^kanban\b/i, label: "看板", icon: "layers" },
  { pattern: /^sankey-beta\b/i, label: "桑基图", icon: "workflow" },
  { pattern: /^architecture-beta\b/i, label: "架构图", icon: "layers" },
];

/**
 * Identify the Mermaid diagram kind from the first non-comment directive line.
 */
export function detectMermaidType(code: string): MermaidDiagramMeta {
  const withoutInit = code.replace(/^\s*%%\{[\s\S]*?\}%%\s*/gm, "");
  const lines = withoutInit.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%")) continue;
    for (const entry of MERMAID_TYPE_PATTERNS) {
      if (entry.pattern.test(line)) {
        return { label: entry.label, icon: entry.icon };
      }
    }
    break;
  }
  return { label: "图表", icon: "workflow" };
}

let mermaidSeq = 0;
let mermaidQueue: Promise<unknown> = Promise.resolve();

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const next = mermaidQueue.then(task, task);
  mermaidQueue = next.catch(() => undefined);
  return next;
}

function buildMermaidThemeConfig(isDark: boolean) {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: "base" as const,
    fontFamily:
      '"Geist", -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif',
    gantt: {
      fontSize: 12,
      barHeight: 22,
      barGap: 6,
      topPadding: 44,
      leftPadding: 96,
      rightPadding: 36,
      titleTopMargin: 18,
    },
    themeVariables: isDark
      ? {
          darkMode: true,
          background: "#111215",
          primaryColor: "#1e2238",
          primaryTextColor: "#f4f4f5",
          primaryBorderColor: "#6366f1",
          secondaryColor: "#181a1f",
          secondaryTextColor: "#d4d4d8",
          secondaryBorderColor: "#323642",
          tertiaryColor: "#14161c",
          lineColor: "#a1a1aa",
          textColor: "#f4f4f5",
          mainBkg: "#1e2238",
          nodeBorder: "#6366f1",
          clusterBkg: "#15171c",
          clusterBorder: "#323642",
          titleColor: "#f4f4f5",
          gridColor: "#24272f",
          taskBkgColor: "#6366f1",
          taskTextColor: "#ffffff",
          taskTextDarkColor: "#f4f4f5",
          taskTextOutsideColor: "#f4f4f5",
          activeTaskBkgColor: "#818cf8",
          activeTaskBorderColor: "#6366f1",
          doneTaskBkgColor: "#27272a",
          doneTaskBorderColor: "#52525b",
          critBkgColor: "#dc2626",
          critBorderColor: "#f87171",
          todayLineColor: "#818cf8",
          sectionBkgColor: "#15171c",
          altSectionBkgColor: "#111215",
        }
      : {
          darkMode: false,
          background: "#ffffff",
          primaryColor: "#eef2ff",
          primaryTextColor: "#18181b",
          primaryBorderColor: "#6366f1",
          secondaryColor: "#f4f4f5",
          secondaryTextColor: "#3f3f46",
          secondaryBorderColor: "#d4d4d8",
          tertiaryColor: "#f8fafc",
          lineColor: "#71717a",
          textColor: "#18181b",
          mainBkg: "#eef2ff",
          nodeBorder: "#6366f1",
          clusterBkg: "#f4f4f5",
          clusterBorder: "#d4d4d8",
          titleColor: "#18181b",
          gridColor: "#e4e4e7",
          taskBkgColor: "#6366f1",
          taskTextColor: "#ffffff",
          taskTextDarkColor: "#18181b",
          taskTextOutsideColor: "#18181b",
          activeTaskBkgColor: "#4f46e5",
          activeTaskBorderColor: "#4338ca",
          doneTaskBkgColor: "#e4e4e7",
          doneTaskBorderColor: "#a1a1aa",
          critBkgColor: "#ef4444",
          critBorderColor: "#dc2626",
          todayLineColor: "#4f46e5",
          sectionBkgColor: "#f8fafc",
          altSectionBkgColor: "#ffffff",
        },
  };
}

export interface MermaidDiagramCardProps {
  code: string;
  compact: boolean;
  streaming?: boolean;
}

export function MermaidDiagramCard({
  code,
  compact,
  streaming = false,
}: MermaidDiagramCardProps) {
  const reactId = useId();
  const meta = useMemo(() => detectMermaidType(code), [code]);
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : false,
  );
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
      return;
    }
    const rootEl = document.documentElement;
    const syncTheme = () => setIsDark(rootEl.classList.contains("dark"));
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(rootEl, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const trimmed = code.trim();
    if (!trimmed) {
      setSvg("");
      setError("");
      return;
    }

    let cancelled = false;
    const runRender = () => {
      void enqueueMermaidRender(async () => {
        const mod = await import("mermaid");
        const mermaid = mod.default ?? (mod as unknown as typeof mod.default);
        const safePrefix = reactId.replace(/[^a-zA-Z0-9_-]/g, "");
        mermaidSeq += 1;
        const renderId = `rd-mermaid-${safePrefix}-${mermaidSeq}`;
        try {
          mermaid.initialize(buildMermaidThemeConfig(isDark));
          const result = await mermaid.render(renderId, trimmed);
          if (!cancelled && result?.svg) {
            setSvg(result.svg);
            setError("");
          }
        } catch (err) {
          if (!cancelled) {
            if (!streaming) {
              setSvg("");
              setError(
                err instanceof Error ? err.message : "Mermaid 语法解析失败",
              );
            }
          }
        } finally {
          // Clean up any temporary error container Mermaid may append to document.body
          if (typeof document !== "undefined") {
            const stray = document.getElementById(`d${renderId}`);
            stray?.remove();
            const strayDirect = document.getElementById(renderId);
            if (strayDirect && strayDirect.parentElement === document.body) {
              strayDirect.remove();
            }
          }
        }
      });
    };

    if (!streaming) {
      runRender();
      return () => {
        cancelled = true;
      };
    }

    const timer = window.setTimeout(runRender, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, isDark, reactId, streaming]);

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(code);
    if (!ok) return;
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, 1800);
  }, [code]);

  const handleDownloadSvg = useCallback(() => {
    if (!svg || typeof document === "undefined" || typeof URL === "undefined") {
      return;
    }
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `relaydesk-diagram-${Date.now()}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }, [svg]);

  const titleText = `Mermaid · ${meta.label}`;
  const isWaitingRender = !svg && !error;

  return (
    <>
      <div
        className={cn(
          "max-w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--rd-plate)] overflow-hidden shadow-[var(--rd-shadow-plate)]",
          compact ? "my-1.5 first:mt-0 last:mb-0" : "my-2.5 first:mt-0 last:mb-0",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--rd-tray)]/85">
          <div className="inline-flex items-center gap-1.5 text-[11px] font-mono font-medium text-[var(--text-muted)] select-none">
            <Icon name={meta.icon} size={12} className="text-indigo-500" />
            <span>{titleText}</span>
            {streaming && isWaitingRender && (
              <span className="ml-1 inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] px-1.5 py-0.5 text-[10.5px] font-sans text-[var(--text-muted)]">
                正在生成图表...
              </span>
            )}
          </div>

          <div className="inline-flex items-center gap-1">
            {svg && (
              <button
                type="button"
                onClick={() => setShowSource((prev) => !prev)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press rd-focus-ring cursor-pointer"
              >
                <Icon name={showSource ? "eye" : "code-2"} size={11} />
                <span>{showSource ? "图表" : "源码"}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                void handleCopy();
              }}
              aria-label={copied ? "已复制图表源码" : "复制图表源码"}
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

            {svg && (
              <>
                <button
                  type="button"
                  onClick={handleDownloadSvg}
                  aria-label="下载 SVG"
                  title="下载 SVG"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press rd-focus-ring cursor-pointer"
                >
                  <Icon name="download" size={11} />
                  <span className="hidden sm:inline">SVG</span>
                </button>

                <button
                  type="button"
                  onClick={() => setLightboxOpen(true)}
                  aria-label="放大图表"
                  title="放大图表"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors rd-press rd-focus-ring cursor-pointer"
                >
                  <Icon name="maximize-2" size={11} />
                  <span>放大</span>
                </button>
              </>
            )}
          </div>
        </div>

        {svg && !showSource ? (
          <div
            data-testid="mermaid-svg-stage"
            onClick={() => setLightboxOpen(true)}
            title="点击放大并拖拽查看"
            className={cn(
              "max-w-full max-h-[460px] overflow-auto rd-scroll bg-[var(--surface-card)] rd-mermaid-svg cursor-zoom-in",
              compact ? "p-3" : "p-3.5 sm:p-4",
            )}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="bg-[var(--surface-card)]">
            {error && !streaming && (
              <div className="px-3 py-2 border-b border-amber-500/25 bg-amber-500/[0.07] text-[12px] text-amber-700 dark:text-amber-300 space-y-1">
                <div className="flex items-center gap-1.5 font-medium">
                  <Icon name="alert-triangle" size={13} />
                  <span>图表语法未能渲染，已回退源码视图</span>
                </div>
                <details className="text-[11px] text-[var(--text-muted)]">
                  <summary className="cursor-pointer select-none hover:text-[var(--text-primary)]">
                    查看解析详情
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">
                    {error}
                  </pre>
                </details>
              </div>
            )}
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
        )}
      </div>

      {svg && (
        <DiagramLightboxModal
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          title={titleText}
          subtitle="滚轮缩放 · 拖拽平移"
          svg={svg}
          code={code}
          onCopyCode={() => {
            void handleCopy();
          }}
          copied={copied}
          onDownloadSvg={handleDownloadSvg}
        />
      )}
    </>
  );
}
