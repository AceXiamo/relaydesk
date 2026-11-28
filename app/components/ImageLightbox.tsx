import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.tsx";
import { cn } from "./ui.tsx";

export interface LightboxImageItem {
  src: string;
  alt?: string;
  openUrl?: string;
  downloadUrl?: string;
}

interface LightboxState {
  items: LightboxImageItem[];
  index: number;
}

interface ImageLightboxContextValue {
  open: (items: LightboxImageItem[], index?: number) => void;
  close: () => void;
}

const ImageLightboxContext = createContext<ImageLightboxContextValue | null>(null);

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
const MIN_SCALE = ZOOM_STEPS[0];
const MAX_SCALE = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const WORKSPACE_FILE_RE = /^\/api\/projects\/[^/?#]+\/workspace\/file\?/;

function clampScale(value: number): number {
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  return Math.round(clamped * 100) / 100;
}

export function toImageOpenUrl(url: string): string {
  if (!url.startsWith("/api/projects/")) return url;
  try {
    const parsed = new URL(url, "http://relaydesk.local");
    parsed.searchParams.delete("preview_retry");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function toImageDownloadUrl(url: string): string {
  if (url.startsWith("/api/projects/") && WORKSPACE_FILE_RE.test(url)) {
    try {
      const parsed = new URL(url, "http://relaydesk.local");
      parsed.searchParams.delete("preview_retry");
      parsed.searchParams.delete("inline");
      parsed.searchParams.set("download", "1");
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return toImageOpenUrl(url);
    }
  }
  return toImageOpenUrl(url);
}

export function isPlainLeftClick(event: ReactMouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function collectScopedImages(
  trigger: HTMLAnchorElement,
  fallbackItem: LightboxImageItem,
): { items: LightboxImageItem[]; index: number } {
  const scope = trigger.closest("[data-rd-lightbox-scope]");
  if (!scope) {
    return { items: [fallbackItem], index: 0 };
  }

  const anchors = Array.from(
    scope.querySelectorAll<HTMLAnchorElement>("a[data-rd-lightbox-src]"),
  );
  if (anchors.length === 0) {
    return { items: [fallbackItem], index: 0 };
  }

  const items: LightboxImageItem[] = [];
  let matchedIndex = -1;

  for (const el of anchors) {
    const src = el.getAttribute("data-rd-lightbox-src");
    if (!src) continue;
    const openUrl = el.getAttribute("data-rd-lightbox-open-url") || undefined;
    const downloadUrl = el.getAttribute("data-rd-lightbox-download-url") || undefined;
    const alt = el.getAttribute("data-rd-lightbox-alt") || undefined;
    if (el === trigger) {
      matchedIndex = items.length;
    }
    items.push({ src, alt, openUrl, downloadUrl });
  }

  if (items.length === 0 || matchedIndex < 0) {
    return { items: [fallbackItem], index: 0 };
  }

  return { items, index: matchedIndex };
}

export function useImageLightbox(): ImageLightboxContextValue | null {
  return useContext(ImageLightboxContext);
}

export function ImageLightboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LightboxState | null>(null);

  const open = useCallback((items: LightboxImageItem[], index = 0) => {
    if (items.length === 0) return;
    const safeIndex = Math.max(0, Math.min(index, items.length - 1));
    setState({ items, index: safeIndex });
  }, []);

  const close = useCallback(() => {
    setState(null);
  }, []);

  const handleIndexChange = useCallback((nextIndex: number) => {
    setState((prev) => {
      if (!prev || prev.items.length === 0) return prev;
      const clamped = Math.max(0, Math.min(nextIndex, prev.items.length - 1));
      if (clamped === prev.index) return prev;
      return { ...prev, index: clamped };
    });
  }, []);

  const value = useMemo<ImageLightboxContextValue>(
    () => ({ open, close }),
    [open, close],
  );

  return (
    <ImageLightboxContext.Provider value={value}>
      {children}
      {state && (
        <ImageLightboxModal
          items={state.items}
          index={state.index}
          onIndexChange={handleIndexChange}
          onClose={close}
        />
      )}
    </ImageLightboxContext.Provider>
  );
}

export interface ImageLightboxModalProps {
  items: LightboxImageItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export function ImageLightboxModal({
  items,
  index,
  onIndexChange,
  onClose,
}: ImageLightboxModalProps) {
  const safeIndex = items.length > 0 ? Math.max(0, Math.min(index, items.length - 1)) : 0;
  const current = items[safeIndex] ?? null;
  const currentSrc = current?.src ?? "";
  const openUrl = current ? toImageOpenUrl(current.openUrl || current.src) : "";
  const downloadUrl = current ? (current.downloadUrl || toImageDownloadUrl(openUrl)) : "";

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
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const setClampedScale = useCallback((nextOrUpdater: number | ((prev: number) => number)) => {
    setScale((prev) => {
      const raw = typeof nextOrUpdater === "function" ? nextOrUpdater(prev) : nextOrUpdater;
      const next = clampScale(raw);
      if (next <= 1) {
        setPan({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  const stepZoom = useCallback(
    (dir: -1 | 1) => {
      setScale((prev) => {
        const next =
          dir > 0
            ? (ZOOM_STEPS.find((z) => z > prev + 0.01) ?? MAX_SCALE)
            : ([...ZOOM_STEPS].reverse().find((z) => z < prev - 0.01) ?? MIN_SCALE);
        if (next <= 1) {
          setPan({ x: 0, y: 0 });
        }
        return next;
      });
    },
    [],
  );

  const resetZoom = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Reset per-image transient state whenever the active image changes.
  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    dragRef.current = null;
    setNaturalSize(null);
    setLoadError(false);
    setRetryKey(0);
  }, [currentSrc, safeIndex]);

  // Body scroll lock & focus management.
  useEffect(() => {
    if (typeof document === "undefined" || !current) return;
    const previousOverflow = document.body.style.overflow;
    const previousActive = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus({ preventScroll: true });

    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousActive && previousActive.isConnected && typeof previousActive.focus === "function") {
        previousActive.focus({ preventScroll: true });
      }
    };
  }, [current !== null]);

  // Capture-phase keyboard isolation so Escape/arrows never leak to underlying drawers or modals.
  useEffect(() => {
    if (!current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onClose();
        return;
      }

      if (event.key === "ArrowLeft") {
        if (items.length > 1) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          if (safeIndex > 0) {
            onIndexChange(safeIndex - 1);
          }
        }
        return;
      }

      if (event.key === "ArrowRight") {
        if (items.length > 1) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          if (safeIndex < items.length - 1) {
            onIndexChange(safeIndex + 1);
          }
        }
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
  }, [current, items.length, onClose, onIndexChange, resetZoom, safeIndex, stepZoom]);

  // Wheel zoom on the image stage (non-passive so background never scrolls).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !current) return;

    const handleWheel = (event: WheelEvent) => {
      if (loadError) return;
      if (event.deltaY === 0) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      setClampedScale((prev) => prev * factor);
    };

    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", handleWheel);
    };
  }, [current, loadError, setClampedScale]);

  // Pointer drag pan listeners on window while dragging zoomed images.
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

  if (typeof document === "undefined" || !current) return null;

  const handleImagePointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (scale <= 1 || event.button !== 0) return;
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

  const handleImageDoubleClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    setClampedScale((prev) => (prev === 1 ? 2 : 1));
  };

  const renderSrc =
    retryKey > 0 && current.src.startsWith("/api/projects/")
      ? `${current.src}${current.src.includes("?") ? "&" : "?"}lightbox_retry=${retryKey}`
      : current.src;

  const canGoPrev = items.length > 1 && safeIndex > 0;
  const canGoNext = items.length > 1 && safeIndex < items.length - 1;

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      tabIndex={-1}
      className="fixed inset-0 z-[80] flex flex-col bg-black/82 backdrop-blur-sm select-none outline-none animate-fade-in"
    >
      {/* Top Floating Toolbar */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 text-white/90 bg-gradient-to-b from-black/60 to-transparent">
        <div className="min-w-0 flex items-center gap-2.5">
          <span className="truncate text-[13px] font-medium text-white">
            {current.alt || "图片预览"}
          </span>
          {naturalSize && (
            <span className="hidden sm:inline shrink-0 font-mono text-[11px] text-white/65 tabular-nums">
              {naturalSize.width} × {naturalSize.height}
            </span>
          )}
          {items.length > 1 && (
            <span
              data-testid="lightbox-counter"
              className="shrink-0 rounded-md bg-white/10 border border-white/15 px-1.5 py-0.5 font-mono text-[11px] text-white/85 tabular-nums"
            >
              {safeIndex + 1} / {items.length}
            </span>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-1.5 sm:gap-2">
          <div className="inline-flex items-center rounded-lg bg-white/10 border border-white/15 overflow-hidden">
            <button
              type="button"
              aria-label="缩小"
              title="缩小 (-)"
              disabled={scale <= MIN_SCALE}
              onClick={() => stepZoom(-1)}
              className="h-8 w-8 inline-flex items-center justify-center text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-35 disabled:pointer-events-none transition cursor-pointer"
            >
              <Icon name="zoom-out" size={14} />
            </button>
            <button
              type="button"
              aria-label="重置缩放"
              title="切换缩放比例 (按 0 重置)"
              onClick={() => setClampedScale((prev) => (prev === 1 ? 2 : 1))}
              className="h-8 px-2.5 border-x border-white/15 font-mono text-[11.5px] text-white/90 hover:bg-white/15 hover:text-white tabular-nums min-w-[54px] transition cursor-pointer"
            >
              {scale !== 1 ? `${Math.round(scale * 100)}%` : "适应"}
            </button>
            <button
              type="button"
              aria-label="放大"
              title="放大 (+)"
              disabled={scale >= MAX_SCALE}
              onClick={() => stepZoom(1)}
              className="h-8 w-8 inline-flex items-center justify-center text-white/85 hover:bg-white/15 hover:text-white disabled:opacity-35 disabled:pointer-events-none transition cursor-pointer"
            >
              <Icon name="zoom-in" size={14} />
            </button>
          </div>

          <a
            href={downloadUrl}
            download
            aria-label="下载图片"
            title="下载图片"
            className="h-8 w-8 rounded-lg bg-white/10 border border-white/15 inline-flex items-center justify-center text-white/85 hover:bg-white/15 hover:text-white transition"
          >
            <Icon name="download" size={15} />
          </a>

          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="新标签打开"
            title="新标签打开"
            className="h-8 w-8 rounded-lg bg-white/10 border border-white/15 inline-flex items-center justify-center text-white/85 hover:bg-white/15 hover:text-white transition"
          >
            <Icon name="external-link" size={15} />
          </a>

          <button
            type="button"
            aria-label="关闭图片预览"
            title="关闭 (Esc)"
            onClick={onClose}
            className="h-8 w-8 rounded-lg bg-white/10 border border-white/15 inline-flex items-center justify-center text-white/90 hover:bg-white/20 hover:text-white transition cursor-pointer"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>

      {/* Center Image Stage */}
      <div
        ref={stageRef}
        data-testid="lightbox-stage"
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
        {items.length > 1 && (
          <>
            <button
              type="button"
              aria-label="上一张"
              title="上一张 (←)"
              disabled={!canGoPrev}
              onClick={(event) => {
                event.stopPropagation();
                if (canGoPrev) onIndexChange(safeIndex - 1);
              }}
              className="absolute left-3 sm:left-5 top-1/2 -translate-y-1/2 z-10 h-10 w-10 rounded-full bg-black/55 border border-white/20 text-white inline-flex items-center justify-center hover:bg-black/80 disabled:opacity-30 disabled:pointer-events-none transition cursor-pointer"
            >
              <Icon name="chevron-left" size={20} />
            </button>
            <button
              type="button"
              aria-label="下一张"
              title="下一张 (→)"
              disabled={!canGoNext}
              onClick={(event) => {
                event.stopPropagation();
                if (canGoNext) onIndexChange(safeIndex + 1);
              }}
              className="absolute right-3 sm:right-5 top-1/2 -translate-y-1/2 z-10 h-10 w-10 rounded-full bg-black/55 border border-white/20 text-white inline-flex items-center justify-center hover:bg-black/80 disabled:opacity-30 disabled:pointer-events-none transition cursor-pointer"
            >
              <Icon name="chevron-right" size={20} />
            </button>
          </>
        )}

        {loadError ? (
          <div
            onClick={(event) => event.stopPropagation()}
            className="max-w-sm w-full rounded-2xl border border-white/15 bg-zinc-900/90 p-6 text-center text-white space-y-3 shadow-2xl"
          >
            <div className="mx-auto w-10 h-10 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center">
              <Icon name="alert-triangle" size={20} />
            </div>
            <p className="text-[13.5px] font-medium">图片加载失败</p>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setLoadError(false);
                  setRetryKey((k) => k + 1);
                }}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-white/12 border border-white/15 text-[12.5px] font-medium text-white hover:bg-white/20 transition cursor-pointer"
              >
                <Icon name="refresh-cw" size={13} />
                重试
              </button>
              <a
                href={openUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-indigo-600 text-[12.5px] font-medium text-white hover:bg-indigo-500 transition"
              >
                <Icon name="external-link" size={13} />
                新标签打开
              </a>
            </div>
          </div>
        ) : (
          <img
            key={`${safeIndex}:${current.src}:${retryKey}`}
            src={renderSrc}
            alt={current.alt || "大图预览"}
            draggable={false}
            onClick={(event) => {
              event.stopPropagation();
              if (suppressBackdropCloseRef.current) {
                suppressBackdropCloseRef.current = false;
              }
            }}
            onDoubleClick={handleImageDoubleClick}
            onPointerDown={handleImagePointerDown}
            onLoad={(event) => {
              const img = event.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
              }
            }}
            onError={() => setLoadError(true)}
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
            }}
            className={cn(
              "max-w-[92vw] max-h-[calc(100dvh-7.5rem)] object-contain rounded-lg shadow-2xl transition-transform duration-150 ease-out",
              dragging && "transition-none cursor-grabbing",
              !dragging && (scale > 1 ? "cursor-grab" : "cursor-zoom-in"),
            )}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

export interface ImageLightboxLinkProps {
  src: string;
  openUrl?: string;
  downloadUrl?: string;
  alt?: string;
  className?: string;
  gallery?: LightboxImageItem[];
  galleryIndex?: number;
  children?: ReactNode;
}

export function ImageLightboxLink({
  src,
  openUrl,
  downloadUrl,
  alt,
  className,
  gallery,
  galleryIndex,
  children,
}: ImageLightboxLinkProps) {
  const ctx = useImageLightbox();
  const [fallbackState, setFallbackState] = useState<LightboxState | null>(null);
  const canonicalOpenUrl = toImageOpenUrl(openUrl || src);

  const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(event)) {
      return;
    }
    event.preventDefault();

    const fallbackItem: LightboxImageItem = {
      src,
      alt,
      openUrl: canonicalOpenUrl,
      downloadUrl,
    };

    const resolved =
      gallery && gallery.length > 0
        ? {
            items: gallery,
            index: Math.max(0, Math.min(galleryIndex ?? 0, gallery.length - 1)),
          }
        : collectScopedImages(event.currentTarget, fallbackItem);

    if (ctx) {
      ctx.open(resolved.items, resolved.index);
    } else {
      setFallbackState(resolved);
    }
  };

  return (
    <>
      <a
        href={canonicalOpenUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-rd-lightbox-src={src}
        data-rd-lightbox-open-url={canonicalOpenUrl}
        data-rd-lightbox-download-url={downloadUrl}
        data-rd-lightbox-alt={alt}
        title={alt ? `点击预览大图：${alt}` : "点击预览大图"}
        className={cn("cursor-zoom-in", className)}
        onClick={handleClick}
      >
        {children}
      </a>
      {!ctx && fallbackState && (
        <ImageLightboxModal
          items={fallbackState.items}
          index={fallbackState.index}
          onIndexChange={(nextIndex) =>
            setFallbackState((prev) =>
              prev ? { ...prev, index: nextIndex } : prev,
            )
          }
          onClose={() => setFallbackState(null)}
        />
      )}
    </>
  );
}
