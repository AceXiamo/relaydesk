import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.tsx";

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Compact display text inside the trigger button when selected. */
  triggerLabel?: string;
  /** Secondary line displayed inside the dropdown list. */
  description?: string;
  /** Compact trailing metadata shown inside the dropdown row. */
  badge?: string;
  /** Optional leading Lucide icon name. */
  icon?: string;
  /** Extra classes applied to the leading icon. */
  iconClassName?: string;
  /** Optional leading status dot color class (e.g. "bg-emerald-500"). */
  dotClassName?: string;
  /** Optional section heading; consecutive options share the same group header. */
  group?: string;
  disabled?: boolean;
}

export type SelectSize = "xs" | "sm" | "md";
export type SelectVariant = "default" | "elevated" | "pill";

export interface SelectProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  placeholder?: string;
  disabled?: boolean;
  size?: SelectSize;
  variant?: SelectVariant;
  fullWidth?: boolean;
  align?: "start" | "end";
  /** Minimum dropdown popover width in pixels; always at least trigger width. */
  minMenuWidth?: number;
  /** Maximum dropdown popover width in pixels. */
  maxMenuWidth?: number;
  /** Fixed leading icon displayed on the trigger button. */
  leadingIcon?: string;
  leadingIconClassName?: string;
  /** Use monospace font for the trigger label. */
  mono?: boolean;
  id?: string;
  name?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  className?: string;
  menuClassName?: string;
  emptyText?: string;
}

interface MenuCoords {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
  placement: "bottom" | "top";
}

const SIZE_CLASSES: Record<SelectSize, string> = {
  xs: "h-7 px-2.5 text-[11.5px] gap-1.5",
  sm: "h-8.5 px-2.5 text-[12.5px] gap-1.5",
  md: "h-9 px-3 text-[12.5px] gap-2",
};

const VARIANT_CLASSES: Record<SelectVariant, string> = {
  default:
    "rounded-lg bg-[var(--surface-card)] border-[var(--border-subtle)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]/45",
  elevated:
    "rounded-lg bg-[var(--surface-elevated)] border-[var(--border-subtle)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]/55",
  pill: "rounded-full bg-[var(--surface-card)] border-[var(--border-subtle)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]/60",
};

function findNextEnabledIndex<T extends string>(
  options: ReadonlyArray<SelectOption<T>>,
  startIndex: number,
  direction: 1 | -1,
): number {
  const len = options.length;
  if (len === 0) return -1;
  for (let step = 0; step < len; step += 1) {
    const idx = (startIndex + step * direction + len) % len;
    if (!options[idx]?.disabled) return idx;
  }
  return -1;
}

export function Select<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = "请选择…",
  disabled = false,
  size = "sm",
  variant = "default",
  fullWidth = false,
  align = "start",
  minMenuWidth,
  maxMenuWidth = 380,
  leadingIcon,
  leadingIconClassName,
  mono = false,
  id,
  name,
  ariaLabel,
  ariaLabelledBy,
  className,
  menuClassName,
  emptyText = "暂无可选项",
}: SelectProps<T>) {
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const typeaheadRef = useRef<{ buffer: string; timer: number | null }>({
    buffer: "",
    timer: null,
  });

  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  const selectedIndex = useMemo(
    () => options.findIndex((opt) => opt.value === value),
    [options, value],
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const computePosition = useCallback((): MenuCoords | null => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    // Close if the trigger scrolled completely out of the visible viewport.
    if (
      rect.bottom < 0 ||
      rect.top > viewportH ||
      rect.right < 0 ||
      rect.left > viewportW
    ) {
      return null;
    }

    const gap = 6;
    const viewportPadding = 8;
    const maxViewportWidth = Math.max(140, viewportW - viewportPadding * 2);
    const desiredMin = Math.max(rect.width, minMenuWidth ?? 0);
    const width = Math.min(
      Math.max(desiredMin, rect.width),
      Math.min(maxMenuWidth, maxViewportWidth),
    );

    let left = align === "end" ? rect.right - width : rect.left;
    left = Math.max(
      viewportPadding,
      Math.min(left, viewportW - width - viewportPadding),
    );

    const spaceBelow = viewportH - rect.bottom - gap - viewportPadding;
    const spaceAbove = rect.top - gap - viewportPadding;
    const hasDescriptions = options.some((o) => Boolean(o.description));
    const estimatedHeight = Math.min(
      320,
      options.length * (hasDescriptions ? 48 : 34) + 28,
    );
    const placement: "bottom" | "top" =
      spaceBelow < Math.min(estimatedHeight, 210) && spaceAbove > spaceBelow
        ? "top"
        : "bottom";

    const availableSpace = placement === "bottom" ? spaceBelow : spaceAbove;
    const maxHeight = Math.max(120, Math.min(320, availableSpace));

    if (placement === "top") {
      return {
        left,
        bottom: viewportH - rect.top + gap,
        width,
        maxHeight,
        placement,
      };
    }

    return {
      left,
      top: rect.bottom + gap,
      width,
      maxHeight,
      placement,
    };
  }, [align, maxMenuWidth, minMenuWidth, options]);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setCoords(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        triggerRef.current?.focus();
      });
    }
  }, []);

  const openMenu = useCallback(
    (initialDirection?: "first" | "last") => {
      if (disabled) return;
      let startIdx = selectedIndex;
      if (initialDirection === "first") {
        startIdx = findNextEnabledIndex(options, 0, 1);
      } else if (initialDirection === "last") {
        startIdx = findNextEnabledIndex(options, options.length - 1, -1);
      } else if (startIdx < 0 || options[startIdx]?.disabled) {
        startIdx = findNextEnabledIndex(options, 0, 1);
      }
      setActiveIndex(startIdx);
      setOpen(true);
    },
    [disabled, options, selectedIndex],
  );

  const commitSelection = useCallback(
    (opt: SelectOption<T>) => {
      if (opt.disabled) return;
      if (opt.value !== value) {
        onChange(opt.value);
      }
      closeMenu(true);
    },
    [closeMenu, onChange, value],
  );

  // Compute and maintain floating menu coordinates while open.
  useIsomorphicLayoutEffect(() => {
    if (!open) return;

    const update = () => {
      const next = computePosition();
      if (!next) {
        setOpen(false);
        setCoords(null);
        return;
      }
      setCoords(next);
    };

    update();

    const handleScroll = (event: Event) => {
      // Ignore scrolling inside the dropdown listbox itself.
      if (menuRef.current && event.target instanceof Node) {
        if (menuRef.current.contains(event.target)) return;
      }
      update();
    };

    window.addEventListener("resize", update);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, computePosition]);

  // Keep the highlighted option scrolled into view when navigating via keyboard.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = optionRefs.current[activeIndex];
    if (node) {
      node.scrollIntoView({ block: "nearest" });
    }
  }, [open, activeIndex]);

  // Close when clicking outside, and intercept Escape/arrow keys cleanly in capture phase
  // so pressing Escape closes the select popover without closing parent drawers or modals.
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      closeMenu(false);
    };

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeMenu(true);
        return;
      }

      if (event.key === "Tab") {
        closeMenu(false);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setActiveIndex((prev) =>
          findNextEnabledIndex(options, prev < 0 ? 0 : prev + 1, 1),
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setActiveIndex((prev) =>
          findNextEnabledIndex(
            options,
            prev < 0 ? options.length - 1 : prev - 1,
            -1,
          ),
        );
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setActiveIndex(findNextEnabledIndex(options, 0, 1));
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setActiveIndex(findNextEnabledIndex(options, options.length - 1, -1));
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const current = options[activeIndex];
        if (current && !current.disabled) {
          commitSelection(current);
        }
        return;
      }

      // Single-character typeahead navigation
      if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.stopPropagation();
        event.stopImmediatePropagation();
        const state = typeaheadRef.current;
        if (state.timer !== null) {
          window.clearTimeout(state.timer);
        }
        state.buffer = (state.buffer + event.key).toLowerCase();
        state.timer = window.setTimeout(() => {
          state.buffer = "";
          state.timer = null;
        }, 550);

        const matchIdx = options.findIndex(
          (opt) =>
            !opt.disabled &&
            (opt.label.toLowerCase().startsWith(state.buffer) ||
              (opt.description &&
                opt.description.toLowerCase().startsWith(state.buffer))),
        );
        if (matchIdx >= 0) {
          event.preventDefault();
          setActiveIndex(matchIdx);
        }
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleWindowKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleWindowKeyDown, true);
    };
  }, [open, activeIndex, options, closeMenu, commitSelection]);

  // Clear pending typeahead timer on unmount.
  useEffect(() => {
    const state = typeaheadRef.current;
    return () => {
      if (state.timer !== null) {
        window.clearTimeout(state.timer);
      }
    };
  }, []);

  // Automatically close if disabled becomes true while open.
  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
      setCoords(null);
    }
  }, [disabled, open]);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled || open) return;
    if (
      event.key === "Enter" ||
      event.key === " " ||
      event.key === "ArrowDown"
    ) {
      event.preventDefault();
      openMenu();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu("last");
    }
  };

  const triggerText = selectedOption
    ? selectedOption.triggerLabel ?? selectedOption.label
    : placeholder;

  const isPlaceholder = !selectedOption;
  const activeOptionId =
    open && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined;

  const effectiveLeadingIcon = leadingIcon ?? selectedOption?.icon;
  const effectiveLeadingIconClass =
    leadingIcon !== undefined
      ? leadingIconClassName
      : selectedOption?.iconClassName;

  return (
    <>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          if (open) {
            closeMenu(false);
          } else {
            openMenu();
          }
        }}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          "group inline-flex items-center justify-between border text-left transition-all duration-150 select-none outline-none",
          "text-[var(--text-primary)] shadow-[var(--rd-shadow-sm)]",
          "focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500/20",
          "disabled:opacity-55 disabled:pointer-events-none",
          fullWidth ? "w-full" : "max-w-full",
          SIZE_CLASSES[size],
          VARIANT_CLASSES[variant],
          open && "border-indigo-500/75 ring-2 ring-indigo-500/15",
          className,
        )}
      >
        <span className="flex items-center gap-1.5 min-w-0 flex-1">
          {selectedOption?.dotClassName ? (
            <span
              aria-hidden="true"
              className={cn(
                "h-2 w-2 rounded-full shrink-0",
                selectedOption.dotClassName,
              )}
            />
          ) : effectiveLeadingIcon ? (
            <Icon
              name={effectiveLeadingIcon}
              size={size === "xs" ? 12 : 13.5}
              className={cn(
                "shrink-0 text-[var(--text-muted)] group-hover:text-[var(--text-secondary)] transition-colors",
                effectiveLeadingIconClass,
              )}
            />
          ) : null}
          <span
            className={cn(
              "truncate leading-tight",
              mono && "font-mono",
              isPlaceholder && "text-[var(--text-muted)]",
            )}
          >
            {triggerText}
          </span>
        </span>
        <Icon
          name="chevron-down"
          size={size === "xs" ? 12 : 13.5}
          className={cn(
            "shrink-0 text-[var(--text-muted)] transition-transform duration-150",
            open && "rotate-180 text-indigo-500 dark:text-indigo-400",
          )}
        />
      </button>

      {open && coords && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel}
              style={{
                position: "fixed",
                left: coords.left,
                top: coords.top,
                bottom: coords.bottom,
                width: coords.width,
                maxHeight: coords.maxHeight,
              }}
              className={cn(
                "z-[55] overflow-y-auto rd-scroll rounded-xl border border-[var(--border-strong)]/80",
                "bg-[var(--surface-elevated)] p-1",
                "shadow-[var(--rd-shadow-lg)] dark:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.78),inset_0_1px_0_rgba(255,255,255,0.06)]",
                coords.placement === "top"
                  ? "animate-popover-in-up"
                  : "animate-popover-in",
                menuClassName,
              )}
            >
              {options.length === 0 ? (
                <div className="px-3 py-4 text-center text-[12px] text-[var(--text-muted)]">
                  {emptyText}
                </div>
              ) : (
                options.map((opt, idx) => {
                  const isSelected = opt.value === value;
                  const isHighlighted = idx === activeIndex;
                  const prevGroup = idx > 0 ? options[idx - 1]?.group : undefined;
                  const showGroupHeader = Boolean(
                    opt.group && opt.group !== prevGroup,
                  );

                  return (
                    <div key={`${opt.value}-${idx}`}>
                      {showGroupHeader && (
                        <div
                          className={cn(
                            "px-2.5 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-[var(--text-muted)] select-none",
                            idx > 0
                              ? "mt-1 pt-2 border-t border-[var(--border-subtle)]"
                              : "pt-1.5",
                          )}
                        >
                          {opt.group}
                        </div>
                      )}
                      <button
                        ref={(el) => {
                          optionRefs.current[idx] = el;
                        }}
                        id={`${listboxId}-opt-${idx}`}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        disabled={opt.disabled}
                        onMouseEnter={() => {
                          if (!opt.disabled) setActiveIndex(idx);
                        }}
                        onMouseDown={(event) => {
                          // Prevent trigger blur flicker before selection commits.
                          event.preventDefault();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          commitSelection(opt);
                        }}
                        className={cn(
                          "w-full flex items-center justify-between gap-2.5 px-2.5 py-1.5 rounded-lg text-left transition-colors duration-100",
                          "disabled:opacity-45 disabled:pointer-events-none",
                          isSelected
                            ? isHighlighted
                              ? "bg-indigo-500/14 text-indigo-700 dark:text-indigo-200"
                              : "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
                            : isHighlighted
                              ? "bg-[var(--surface-hover)] text-[var(--text-primary)]"
                              : "text-[var(--text-primary)]",
                        )}
                      >
                        <div className="flex items-start gap-2 min-w-0 flex-1">
                          {opt.dotClassName ? (
                            <span
                              aria-hidden="true"
                              className={cn(
                                "h-2 w-2 rounded-full shrink-0 mt-[5px]",
                                opt.dotClassName,
                              )}
                            />
                          ) : opt.icon ? (
                            <Icon
                              name={opt.icon}
                              size={13.5}
                              className={cn(
                                "shrink-0 mt-[2px]",
                                isSelected
                                  ? "text-indigo-500 dark:text-indigo-400"
                                  : "text-[var(--text-muted)]",
                                opt.iconClassName,
                              )}
                            />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <div
                              className={cn(
                                "text-[12.5px] leading-snug truncate",
                                isSelected ? "font-medium" : "font-normal",
                              )}
                            >
                              {opt.label}
                            </div>
                            {opt.description ? (
                              <div className="text-[11px] font-mono text-[var(--text-muted)] truncate mt-0.5">
                                {opt.description}
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {opt.badge ? (
                            <span className="px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[10.5px] font-mono text-[var(--text-muted)] max-w-[130px] truncate">
                              {opt.badge}
                            </span>
                          ) : null}
                          <span className="w-3.5 h-3.5 inline-flex items-center justify-center shrink-0">
                            {isSelected ? (
                              <Icon
                                name="check"
                                size={13.5}
                                className="text-indigo-600 dark:text-indigo-400"
                              />
                            ) : null}
                          </span>
                        </div>
                      </button>
                    </div>
                  );
                })
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
