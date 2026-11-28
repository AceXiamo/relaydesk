import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.tsx";
import { MorphIcon } from "./MotionPrimitives.tsx";
import { cn } from "./ui.tsx";

const MODAL_ZOOM_STEPS = [0.75, 0.85, 1, 1.15, 1.25, 1.4] as const;
const DIAGRAM_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
const DIAGRAM_MIN_SCALE = DIAGRAM_ZOOM_STEPS[0];
const DIAGRAM_MAX_SCALE = DIAGRAM_ZOOM_STEPS[DIAGRAM_ZOOM_STEPS.length - 1];

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

function clampDiagramScale(value: number): number {
  const clamped = Math.min(DIAGRAM_MAX_SCALE, Math.max(DIAGRAM_MIN_SCALE, value));
  return Math.round(clamped * 100) / 100;
}

export interface MarkdownExpandModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon: string;
  zoomable?: boolean;
  defaultScale?: number;
  actions?: ReactNode;
  children: ReactNode | ((scale: number) => ReactNode);
}

/**
 * In-page modal for inspecting wide Markdown tables and long code blocks at full width
 * with optional font-scale zoom controls and capture-phase Escape isolation.
 */
export function MarkdownExpandModal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  zoomable = false,
  defaultScale = 1,
  actions,
  children,
}: MarkdownExpandModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(defaultScale);

  useEffect(() => {
    if (open) {
      setScale(defaultScale);
    }
  }, [open, defaultScale]);

  const stepZoom = useCallback((dir: -1 | 1) => {
    setScale((prev) => {
      if (dir > 0) {
        return (
          MODAL_ZOOM_STEPS.find((z) => z > prev + 0.01) ??
          MODAL_ZOOM_STEPS[MODAL_ZOOM_STEPS.length - 1]
        );
      }
      return (
        [...MODAL_ZOOM_STEPS].reverse().find((z) => z < prev - 0.01) ??
        MODAL_ZOOM_STEPS[0]
      );
    });
  }, []);

  const resetZoom = useCallback(() => {
    setScale(defaultScale);
  }, [defaultScale]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const previousOverflow = document.body.style.overflow;
    const previousActive = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus({ preventScroll: true });

    return () => {
      document.body.style.overflow = previousOverflow;
      if (
        previousActive &&
        previousActive.isConnected &&
        typeof previousActive.focus === "function"
      ) {
        previousActive.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onClose();
        return;
      }

      if (
        !zoomable ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        stepZoom(1);
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        stepZoom(-1);
        return;
      }

      if (event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        resetZoom();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onClose, resetZoom, stepZoom, zoomable]);

  if (!open || typeof document === "undefined") return null;

  const minModalScale = MODAL_ZOOM_STEPS[0];
  const maxModalScale = MODAL_ZOOM_STEPS[MODAL_ZOOM_STEPS.length - 1];

  return createPortal(
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-0 z-[80] flex items-center justify-center p-2.5 sm:p-5 bg-[var(--rd-backdrop)] backdrop-blur-xs animate-fade-in"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="w-[min(96vw,1480px)] max-h-[90dvh] flex flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--rd-shadow-lg)] overflow-hidden outline-none animate-modal-in"
      >
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-2.5 px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--rd-tray)]/90">
          <div className="min-w-0 flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] inline-flex items-center justify-center text-[var(--text-secondary)] shrink-0">
              <Icon name={icon} size={14} />
            </span>
            <div className="min-w-0 flex items-baseline gap-2">
              <h2 className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                {title}
              </h2>
              {subtitle && (
                <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)] tabular-nums">
                  {subtitle}
                </span>
              )}
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-1.5 sm:gap-2">
            {actions}

            {zoomable && (
              <div className="inline-flex items-center rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
                <button
                  type="button"
                  aria-label="缩小"
                  title="缩小 (-)"
                  disabled={scale <= minModalScale}
                  onClick={() => stepZoom(-1)}
                  className="h-7 w-7 inline-flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-35 disabled:pointer-events-none transition cursor-pointer"
                >
                  <Icon name="zoom-out" size={13} />
                </button>
                <button
                  type="button"
                  aria-label="重置缩放"
                  title="重置为 100% (按 0)"
                  onClick={resetZoom}
                  className="h-7 px-2 border-x border-[var(--border-subtle)] font-mono text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] tabular-nums min-w-[46px] transition cursor-pointer"
                >
                  {Math.round(scale * 100)}%
                </button>
                <button
                  type="button"
                  aria-label="放大"
                  title="放大 (+)"
                  disabled={scale >= maxModalScale}
                  onClick={() => stepZoom(1)}
                  className="h-7 w-7 inline-flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-35 disabled:pointer-events-none transition cursor-pointer"
                >
                  <Icon name="zoom-in" size={13} />
                </button>
              </div>
            )}

            <button
              type="button"
              aria-label="关闭预览"
              title="关闭 (Esc)"
              onClick={onClose}
              className="h-7 w-7 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] inline-flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition cursor-pointer rd-focus-ring"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        <div
          className="rd-md-modal flex-1 min-h-0 overflow-auto rd-scroll bg-[var(--surface-card)]"
          style={zoomable ? { fontSize: `${Math.round(scale * 100)}%` } : undefined}
        >
          {typeof children === "function" ? children(scale) : children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export interface DiagramLightboxModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  svg: string;
  code: string;
  onCopyCode?: () => void;
  copied?: boolean;
  onDownloadSvg?: () => void;
}

/**
 * Full-screen interactive Lightbox for Mermaid SVG diagrams with wheel/button zoom,
 * pointer drag-to-pan (useful for wide Gantt charts), and raw source toggle.
 */
export function DiagramLightboxModal({
  open,
  onClose,
  title,
  subtitle,
  svg,
  code,
  onCopyCode,
  copied = false,
  onDownloadSvg,
}: DiagramLightboxModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const suppressBackdropCloseRef = useRef(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [showSource, setShowSource] = useState(false);

  const setClampedScale = useCallback(
    (nextOrUpdater: number | ((prev: number) => number)) => {
      setScale((prev) => {
        const raw =
          typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater;
        const next = clampDiagramScale(raw);
        if (next === 1) {
          setPan({ x: 0, y: 0 });
        }
        return next;
      });
    },
    [],
  );

  const stepZoom = useCallback((dir: -1 | 1) => {
    setScale((prev) => {
      const next =
        dir > 0
          ? (DIAGRAM_ZOOM_STEPS.find((z) => z > prev + 0.01) ?? DIAGRAM_MAX_SCALE)
          : ([...DIAGRAM_ZOOM_STEPS].reverse().find((z) => z < prev - 0.01) ??
            DIAGRAM_MIN_SCALE);
      if (next === 1) {
        setPan({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (!open) return;
    setScale(1);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    setShowSource(false);
    dragRef.current = null;
  }, [open, svg]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const previousOverflow = document.body.style.overflow;
    const previousActive = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus({ preventScroll: true });

    return () => {
      document.body.style.overflow = previousOverflow;
      if (
        previousActive &&
        previousActive.isConnected &&
        typeof previousActive.focus === "function"
      ) {
        previousActive.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onClose();
        return;
      }

      if (
        showSource ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        stepZoom(1);
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        stepZoom(-1);
        return;
      }

      if (event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        resetView();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onClose, resetView, showSource, stepZoom]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!open || !stage || showSource) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      setClampedScale((prev) => prev * factor);
    };

    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", handleWheel);
    };
  }, [open, setClampedScale, showSource]);

  useEffect(() => {
    if (!dragging) return;

    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 3) {
        drag.moved = true;
      }
      setPan({
        x: drag.originX + dx,
        y: drag.originY + dy,
      });
    };

    const endDrag = () => {
      const drag = dragRef.current;
      if (drag?.moved) {
        suppressBackdropCloseRef.current = true;
        window.setTimeout(() => {
          suppressBackdropCloseRef.current = false;
        }, 0);
      }
      dragRef.current = null;
      setDragging(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [dragging]);

  if (!open || typeof document === "undefined") return null;

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
      moved: false,
    };
    setDragging(true);
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    setClampedScale((prev) => (prev === 1 ? 1.75 : 1));
  };

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="fixed inset-0 z-[80] flex flex-col bg-black/82 backdrop-blur-sm select-none outline-none animate-fade-in"
    >
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2.5 px-4 py-3 text-white/90 bg-gradient-to-b from-black/60 to-transparent">
        <div className="min-w-0 flex items-center gap-2.5">
          <span className="truncate text-[13px] font-medium text-white">
            {title}
          </span>
          {subtitle && (
            <span className="hidden sm:inline shrink-0 rounded-md bg-white/10 border border-white/15 px-1.5 py-0.5 font-mono text-[11px] text-white/80">
              {subtitle}
            </span>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-1.5 sm:gap-2">
          {!showSource && (
            <div className="inline-flex items-center rounded-lg bg-white/10 border border-white/15 overflow-hidden">
              <button
                type="button"
                aria-label="缩小图表"
                title="缩小 (-)"
                disabled={scale <= DIAGRAM_MIN_SCALE}
                onClick={() => stepZoom(-1)}
                className="h-8 w-8 inline-flex items-center justify-center text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-35 disabled:pointer-events-none transition cursor-pointer"
              >
                <Icon name="zoom-out" size={14} />
              </button>
              <button
                type="button"
                aria-label="重置缩放"
                title="重置视角 (按 0)"
                onClick={resetView}
                className="h-8 px-2.5 border-x border-white/15 font-mono text-[11.5px] text-white/90 hover:bg-white/15 hover:text-white tabular-nums min-w-[54px] transition cursor-pointer"
              >
                {scale !== 1 || pan.x !== 0 || pan.y !== 0
                  ? `${Math.round(scale * 100)}%`
                  : "适应"}
              </button>
              <button
                type="button"
                aria-label="放大图表"
                title="放大 (+)"
                disabled={scale >= DIAGRAM_MAX_SCALE}
                onClick={() => stepZoom(1)}
                className="h-8 w-8 inline-flex items-center justify-center text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-35 disabled:pointer-events-none transition cursor-pointer"
              >
                <Icon name="zoom-in" size={14} />
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowSource((prev) => !prev)}
            className="h-8 px-2.5 rounded-lg bg-white/10 border border-white/15 inline-flex items-center gap-1.5 text-[12px] font-medium text-white/90 hover:bg-white/15 hover:text-white transition cursor-pointer"
          >
            <Icon name={showSource ? "eye" : "code-2"} size={13} />
            <span>{showSource ? "返回图表" : "查看源码"}</span>
          </button>

          {onCopyCode && (
            <button
              type="button"
              onClick={onCopyCode}
              aria-label={copied ? "已复制源码" : "复制源码"}
              className="h-8 px-2.5 rounded-lg bg-white/10 border border-white/15 inline-flex items-center gap-1.5 text-[12px] font-medium text-white/90 hover:bg-white/15 hover:text-white transition cursor-pointer"
            >
              <MorphIcon
                name="copy"
                activeName="check"
                active={copied}
                size={13}
                activeClassName="text-emerald-400"
              />
              <span>{copied ? "已复制" : "复制源码"}</span>
            </button>
          )}

          {onDownloadSvg && svg && (
            <button
              type="button"
              aria-label="下载 SVG"
              title="下载 SVG"
              onClick={onDownloadSvg}
              className="h-8 w-8 rounded-lg bg-white/10 border border-white/15 inline-flex items-center justify-center text-white/85 hover:bg-white/15 hover:text-white transition cursor-pointer"
            >
              <Icon name="download" size={15} />
            </button>
          )}

          <button
            type="button"
            aria-label="关闭图表预览"
            title="关闭 (Esc)"
            onClick={onClose}
            className="h-8 w-8 rounded-lg bg-white/10 border border-white/15 inline-flex items-center justify-center text-white/90 hover:bg-white/20 hover:text-white transition cursor-pointer"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        data-testid="diagram-lightbox-stage"
        onClick={(event) => {
          if (suppressBackdropCloseRef.current) {
            suppressBackdropCloseRef.current = false;
            return;
          }
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
        className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden p-4 sm:p-8"
      >
        {showSource ? (
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-4xl max-h-[80dvh] rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-primary)] shadow-2xl overflow-auto rd-scroll select-text"
          >
            <pre className="m-0 p-4 sm:p-5 font-mono text-[12.5px] leading-[1.65]">
              <code>{code}</code>
            </pre>
          </div>
        ) : (
          <div
            onClick={(event) => {
              event.stopPropagation();
              if (suppressBackdropCloseRef.current) {
                suppressBackdropCloseRef.current = false;
              }
            }}
            onDoubleClick={handleDoubleClick}
            onPointerDown={handlePointerDown}
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
            }}
            className={cn(
              "max-w-[92vw] max-h-[calc(100dvh-7.5rem)] overflow-auto rd-scroll rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 sm:p-7 shadow-2xl transition-transform duration-150 ease-out rd-mermaid-svg",
              dragging ? "transition-none cursor-grabbing" : "cursor-grab",
            )}
          >
            <div dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
