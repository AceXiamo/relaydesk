import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { clamp, prefersReducedMotion, projectVelocity, rubberband } from "~/lib/detent.ts";
import type { ChatReasoningEffort } from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* -------------------------------------------------------------------------- */
/* MorphIcon                                                                  */
/* -------------------------------------------------------------------------- */

export interface MorphIconProps {
  name: string;
  activeName: string;
  active: boolean;
  size?: number;
  className?: string;
  inactiveClassName?: string;
  activeClassName?: string;
  rotate?: boolean;
}

export function MorphIcon({
  name,
  activeName,
  active,
  size = 14,
  className,
  inactiveClassName,
  activeClassName,
  rotate = false,
}: MorphIconProps) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn("inline-grid place-items-center shrink-0", className)}
    >
      <span
        aria-hidden={active || undefined}
        style={{
          transitionTimingFunction: "var(--ease-icon)",
          transform: active
            ? `scale(0.25)${rotate ? " rotate(-45deg)" : ""}`
            : "scale(1) rotate(0deg)",
          filter: active ? "blur(4px)" : "blur(0px)",
        }}
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center justify-center transition-[opacity,transform,filter] duration-200",
          active ? "opacity-0 pointer-events-none" : "opacity-100",
          inactiveClassName,
        )}
      >
        <Icon name={name} size={size} />
      </span>
      <span
        aria-hidden={!active || undefined}
        style={{
          transitionTimingFunction: "var(--ease-icon)",
          transform: active
            ? "scale(1) rotate(0deg)"
            : `scale(0.25)${rotate ? " rotate(45deg)" : ""}`,
          filter: active ? "blur(0px)" : "blur(4px)",
        }}
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center justify-center transition-[opacity,transform,filter] duration-200",
          active ? "opacity-100" : "opacity-0 pointer-events-none",
          activeClassName,
        )}
      >
        <Icon name={activeName} size={size} />
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* RollingNumber                                                              */
/* -------------------------------------------------------------------------- */

export interface RollingNumberProps {
  value: number;
  format?: (n: number) => string;
  className?: string;
}

interface RollingTransition {
  prevText: string;
  nextText: string;
  direction: "up" | "down";
  key: number;
}

export function RollingNumber({ value, format, className }: RollingNumberProps) {
  const formatted = format ? format(value) : String(value);
  const prevValueRef = useRef<number>(value);
  const prevTextRef = useRef<string>(formatted);
  const seqRef = useRef(0);
  const [transition, setTransition] = useState<RollingTransition | null>(null);

  useEffect(() => {
    const prevValue = prevValueRef.current;
    const prevText = prevTextRef.current;
    prevValueRef.current = value;
    prevTextRef.current = formatted;

    if (prevValue === value || prevText === formatted || prefersReducedMotion()) {
      return;
    }

    seqRef.current += 1;
    setTransition({
      prevText,
      nextText: formatted,
      direction: value > prevValue ? "up" : "down",
      key: seqRef.current,
    });

    const timer = window.setTimeout(() => {
      setTransition((curr) => (curr && curr.key === seqRef.current ? null : curr));
    }, 280);
    return () => window.clearTimeout(timer);
  }, [value, formatted]);

  if (!transition || transition.nextText !== formatted) {
    return <span className={cn("tabular-nums", className)}>{formatted}</span>;
  }

  const { prevText, nextText, direction, key } = transition;
  const maxLen = Math.max(prevText.length, nextText.length);
  const inClass = direction === "up" ? "rd-digit-in-up" : "rd-digit-in-down";
  const outClass = direction === "up" ? "rd-digit-out-up" : "rd-digit-out-down";

  const cells: ReactNode[] = [];
  for (let i = 0; i < maxLen; i += 1) {
    const pIdx = i - (maxLen - prevText.length);
    const nIdx = i - (maxLen - nextText.length);
    const pCh = pIdx >= 0 ? prevText[pIdx]! : "";
    const nCh = nIdx >= 0 ? nextText[nIdx]! : "";
    if (!nCh) continue;
    if (pCh === nCh) {
      cells.push(<span key={`s-${i}`}>{nCh}</span>);
      continue;
    }
    cells.push(
      <span key={`d-${key}-${i}`} className="inline-grid overflow-hidden align-bottom">
        {pCh ? (
          <span
            aria-hidden="true"
            className={cn("col-start-1 row-start-1 pointer-events-none", outClass)}
          >
            {pCh}
          </span>
        ) : null}
        <span className={cn("col-start-1 row-start-1", inClass)}>{nCh}</span>
      </span>,
    );
  }

  return (
    <span className={cn("inline-flex items-baseline tabular-nums", className)}>
      {cells}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* SmoothCollapse                                                             */
/* -------------------------------------------------------------------------- */

export interface SmoothCollapseProps {
  open: boolean;
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  id?: string;
}

export function SmoothCollapse({
  open,
  children,
  className,
  innerClassName,
  id,
}: SmoothCollapseProps) {
  const innerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = innerRef.current;
    if (!node) return;
    if (!open) {
      node.setAttribute("inert", "");
    } else {
      node.removeAttribute("inert");
    }
  }, [open]);

  return (
    <div
      id={id}
      data-open={open ? "true" : "false"}
      aria-hidden={!open || undefined}
      className={cn("rd-collapse-grid", className)}
    >
      <div ref={innerRef} className={cn("rd-collapse-inner", innerClassName)}>
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* SegmentedDetent                                                            */
/* -------------------------------------------------------------------------- */

export interface SegmentedDetentOption<T extends string = string> {
  value: T;
  label: string;
  icon?: string;
  badge?: string | number;
  badgeClassName?: string;
  activeIconClassName?: string;
  id?: string;
  ariaControls?: string;
  disabled?: boolean;
}

export interface SegmentedDetentProps<T extends string = string> {
  options: ReadonlyArray<SegmentedDetentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: "xs" | "sm" | "md";
  role?: "group" | "tablist";
  ariaLabel?: string;
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
}

const SEGMENT_SIZES: Record<NonNullable<SegmentedDetentProps["size"]>, string> = {
  xs: "h-6 px-2 text-[11px] gap-1 rounded-[7px]",
  sm: "h-7 px-2.5 text-[12px] gap-1.5 rounded-[8px]",
  md: "h-8 px-3 text-[12.5px] gap-2 rounded-[8px]",
};

export function SegmentedDetent<T extends string = string>({
  options,
  value,
  onChange,
  size = "sm",
  role = "group",
  ariaLabel,
  fullWidth = false,
  disabled = false,
  className,
}: SegmentedDetentProps<T>) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const hasMeasuredRef = useRef(false);
  const [indicator, setIndicator] = useState<{ left: number; width: number; animate: boolean }>({
    left: 0,
    width: 0,
    animate: false,
  });

  const measure = useCallback(() => {
    const activeBtn = btnRefs.current.get(value);
    if (!activeBtn) return;
    const nextWidth = activeBtn.offsetWidth;
    const nextLeft = activeBtn.offsetLeft;
    if (nextWidth <= 0) return;
    const shouldAnimate = hasMeasuredRef.current && !prefersReducedMotion();
    hasMeasuredRef.current = true;
    setIndicator((prev) => {
      if (prev.left === nextLeft && prev.width === nextWidth && prev.animate === shouldAnimate) {
        return prev;
      }
      return { left: nextLeft, width: nextWidth, animate: shouldAnimate };
    });
  }, [value]);

  useIsomorphicLayoutEffect(() => {
    measure();
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(track);
    for (const btn of btnRefs.current.values()) {
      observer.observe(btn);
    }
    return () => observer.disconnect();
  }, [measure, options]);

  return (
    <div
      ref={trackRef}
      role={role}
      aria-label={ariaLabel}
      className={cn(
        "relative items-center rounded-[11px] border border-[var(--border-subtle)] rd-tray p-[3px] select-none",
        fullWidth ? "grid w-full" : "inline-flex",
        className,
      )}
      style={
        fullWidth
          ? { gridTemplateColumns: `repeat(${Math.max(1, options.length)}, minmax(0, 1fr))` }
          : undefined
      }
    >
      {indicator.width > 0 && (
        <span
          aria-hidden="true"
          style={{
            width: `${indicator.width}px`,
            transform: `translate3d(${indicator.left - 3}px, 0, 0)`,
            transition: indicator.animate
              ? "transform 240ms var(--ease-spring-snappy), width 240ms var(--ease-spring-snappy)"
              : "none",
          }}
          className={cn(
            "pointer-events-none absolute top-[3px] bottom-[3px] left-[3px] rd-plate",
            size === "xs" ? "rounded-[7px]" : "rounded-[8px]",
          )}
        />
      )}

      {options.map((opt) => {
        const active = opt.value === value;
        const optDisabled = Boolean(disabled || opt.disabled);
        const tabProps =
          role === "tablist"
            ? { role: "tab" as const, "aria-selected": active }
            : { "aria-pressed": active };

        return (
          <button
            key={opt.value}
            ref={(el) => {
              if (el) btnRefs.current.set(opt.value, el);
              else btnRefs.current.delete(opt.value);
            }}
            id={opt.id}
            type="button"
            disabled={optDisabled}
            aria-controls={opt.ariaControls}
            onClick={() => {
              if (!optDisabled && opt.value !== value) {
                onChange(opt.value);
              }
            }}
            {...tabProps}
            className={cn(
              "relative z-10 inline-flex items-center justify-center font-medium whitespace-nowrap rd-focus-ring transition-[color,transform] duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
              !optDisabled && "enabled:active:scale-[0.97]",
              fullWidth && "w-full min-w-0",
              SEGMENT_SIZES[size],
              active
                ? "text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              indicator.width === 0 && active && "rd-plate",
            )}
          >
            {opt.icon ? (
              <Icon
                name={opt.icon}
                size={size === "xs" ? 12 : 13.5}
                className={cn(
                  "shrink-0 transition-colors duration-150",
                  active ? opt.activeIconClassName ?? "text-indigo-500" : "text-[var(--text-muted)]",
                )}
              />
            ) : null}
            <span className="truncate">{opt.label}</span>
            {opt.badge !== undefined && opt.badge !== "" ? (
              <span
                className={cn(
                  "shrink-0 rounded-md px-1.5 py-[1px] font-mono text-[10px] tabular-nums leading-tight",
                  opt.badgeClassName ??
                    (active
                      ? "bg-[var(--surface-subtle)] text-[var(--text-primary)]"
                      : "bg-[var(--surface-card)]/60 text-[var(--text-muted)]"),
                )}
              >
                {opt.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* EffortDetentTrack                                                          */
/* -------------------------------------------------------------------------- */

export interface EffortDetentOption {
  value: ChatReasoningEffort;
  label: string;
  shortLabel: string;
  description: string;
  dotClassName?: string;
}

export interface EffortDetentTrackProps {
  options: ReadonlyArray<EffortDetentOption>;
  value: ChatReasoningEffort;
  disabled?: boolean;
  onChange: (value: ChatReasoningEffort) => void;
  className?: string;
}

export function EffortDetentTrack({
  options,
  value,
  disabled = false,
  onChange,
  className,
}: EffortDetentTrackProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    active: boolean;
    didDrag: boolean;
    pointerId: number;
    startX: number;
    startFraction: number;
    samples: Array<{ x: number; t: number }>;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragFraction, setDragFraction] = useState<number | null>(null);

  const count = Math.max(1, options.length);
  const activeIndex = Math.max(
    0,
    options.findIndex((opt) => opt.value === value),
  );
  const activeOption = options[activeIndex] ?? options[0];

  const visualFraction = dragFraction !== null ? dragFraction : activeIndex;
  const highlightedIndex = clamp(Math.round(visualFraction), 0, count - 1);
  const highlightedOption = options[highlightedIndex] ?? activeOption;

  const commitIndex = useCallback(
    (idx: number) => {
      const clampedIdx = clamp(Math.round(idx), 0, count - 1);
      const next = options[clampedIdx];
      if (next && next.value !== value) {
        onChange(next.value);
      }
    },
    [count, onChange, options, value],
  );

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || count <= 1) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    if (rect.width <= 0) return;

    try {
      rail.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore synthetic pointer errors in test environments
    }

    const slotWidth = Math.max(1, (rect.width - 6) / count);
    const relX = clamp(e.clientX - rect.left - 3, 0, rect.width - 6);
    const pressedFraction = clamp(relX / slotWidth - 0.5, 0, count - 1);

    dragStateRef.current = {
      active: true,
      didDrag: false,
      pointerId: e.pointerId,
      startX: e.clientX,
      startFraction: Math.abs(pressedFraction - activeIndex) < 0.75 ? activeIndex : pressedFraction,
      samples: [{ x: e.clientX, t: performance.now() }],
    };
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || !drag.active || drag.pointerId !== e.pointerId) return;
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    if (rect.width <= 0) return;

    const deltaX = e.clientX - drag.startX;
    if (!drag.didDrag && Math.abs(deltaX) < 4) return;
    drag.didDrag = true;

    const now = performance.now();
    drag.samples.push({ x: e.clientX, t: now });
    if (drag.samples.length > 5) drag.samples.shift();

    const slotWidth = Math.max(1, (rect.width - 6) / count);
    const rawFraction = drag.startFraction + deltaX / slotWidth;
    let bounded = rawFraction;
    if (rawFraction < 0) {
      bounded = -rubberband(-rawFraction, 1.2, 0.45);
    } else if (rawFraction > count - 1) {
      bounded = count - 1 + rubberband(rawFraction - (count - 1), 1.2, 0.45);
    }
    setDragFraction(bounded);
  };

  const finishDrag = (e: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = dragStateRef.current;
    if (!drag || !drag.active || drag.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    try {
      railRef.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    if (!drag.didDrag) {
      setDragFraction(null);
      return;
    }

    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);

    const currentFrac = dragFraction ?? drag.startFraction;
    setDragFraction(null);
    if (cancelled) return;

    let velocityPxPerSec = 0;
    const samples = drag.samples;
    if (samples.length >= 2) {
      const first = samples[0]!;
      const last = samples[samples.length - 1]!;
      const dtMs = Math.max(8, last.t - first.t);
      velocityPxPerSec = ((last.x - first.x) / dtMs) * 1000;
    }

    const rect = railRef.current?.getBoundingClientRect();
    const slotWidth = rect && rect.width > 0 ? Math.max(1, (rect.width - 6) / count) : 48;
    const projectedFrac = currentFrac + projectVelocity(velocityPxPerSec, 0.988) / slotWidth;
    commitIndex(projectedFrac);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || count <= 1) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      commitIndex(activeIndex + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      commitIndex(activeIndex - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      commitIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      commitIndex(count - 1);
    }
  };

  if (options.length === 0) return null;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-[var(--text-secondary)] shrink-0">推理强度</span>
        <span className="truncate text-[var(--text-muted)] transition-opacity duration-150">
          {highlightedOption?.description}
        </span>
      </div>

      <div
        ref={railRef}
        role="radiogroup"
        aria-label="推理强度滑块"
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => finishDrag(e, false)}
        onPointerCancel={(e) => finishDrag(e, true)}
        className={cn(
          "relative grid rounded-[10px] border border-[var(--border-subtle)] rd-tray p-[3px] select-none touch-none",
          disabled && "opacity-55 pointer-events-none",
        )}
        style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
      >
        {/* Sliding Elevated Detent Plate */}
        <div
          aria-hidden="true"
          style={{
            width: `calc((100% - 6px) / ${count})`,
            transform: `translate3d(${visualFraction * 100}%, 0, 0)`,
            transition:
              dragFraction !== null || prefersReducedMotion()
                ? "none"
                : "transform 250ms var(--ease-spring)",
          }}
          className="pointer-events-none absolute top-[3px] bottom-[3px] left-[3px] rounded-[7px] rd-plate"
        />

        {options.map((opt, idx) => {
          const isSelected = idx === activeIndex;
          const isNear = idx === highlightedIndex;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              data-effort-value={opt.value}
              tabIndex={isSelected ? 0 : -1}
              disabled={disabled}
              onClick={() => {
                if (suppressClickRef.current) return;
                commitIndex(idx);
              }}
              className={cn(
                "relative z-10 flex h-6.5 flex-col items-center justify-center rounded-[7px] px-1 text-[11px] font-medium transition-colors duration-150 rd-focus-ring cursor-pointer",
                isNear
                  ? "text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
              )}
            >
              <span className="inline-flex items-center gap-1 truncate max-w-full">
                {opt.dotClassName ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-1.5 w-1.5 rounded-full shrink-0 transition-transform duration-150",
                      opt.dotClassName,
                      isNear ? "scale-100 opacity-100" : "scale-75 opacity-55",
                    )}
                  />
                ) : null}
                <span className="truncate">{opt.shortLabel}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
