import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  effortLabels,
  resolveDefaultModelForTarget,
  resolveLocalTaskAgent,
  resolveLocalTaskModelCatalog,
  validCatalogId,
} from "~/lib/model-catalog.ts";
import type {
  BridgeAgentSummary,
  ChatReasoningEffort,
  ChatRuntime,
  ModelCatalogItem,
} from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { LivePulseDot, Select, type SelectOption } from "./ui.tsx";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const ALL_EFFORT_LEVELS = ["off", "low", "medium", "high", "max"] as const;

const EFFORT_META: Record<
  ChatReasoningEffort,
  { description: string; badge?: string; dotClassName: string }
> = {
  default: { description: "跟随节点或模型默认设定", dotClassName: "bg-zinc-400" },
  off: { description: "关闭深度思考，响应最快", badge: "Off", dotClassName: "bg-slate-400" },
  low: { description: "轻量推理，适合简单改动", badge: "Low", dotClassName: "bg-sky-400" },
  medium: { description: "均衡推理质量与响应速度", badge: "Med", dotClassName: "bg-indigo-400" },
  high: { description: "深度严谨推理，适合复杂排查", badge: "High", dotClassName: "bg-violet-500" },
  max: { description: "最高推理预算，攻克复杂难题", badge: "Max", dotClassName: "bg-amber-500" },
};

const CONTEXT_FORMAT = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function runtimeLabel(runtime: ChatRuntime): string {
  return runtime === "claude" ? "Claude Code" : "Codex CLI";
}

export function adaptSelectionForRuntimeSwitch(options: {
  nextRuntime: ChatRuntime;
  agent: BridgeAgentSummary | null;
  currentModel: string;
  currentEffort: ChatReasoningEffort;
}): { model: string; effort: ChatReasoningEffort } {
  const { nextRuntime, agent, currentModel, currentEffort } = options;
  const catalog = resolveLocalTaskModelCatalog({
    runtime: nextRuntime,
    agent,
    includeSelectedFallback: false,
  });
  const matched = currentModel ? catalog.find((item) => item.id === currentModel) : undefined;
  const nextModel = matched ? currentModel : "";
  const effectiveId =
    nextModel || resolveDefaultModelForTarget(nextRuntime, agent, undefined);
  const entry = catalog.find((item) => item.id === effectiveId);
  const effortAllowed =
    currentEffort === "default" ||
    (entry?.supports_effort !== false &&
      (!entry?.effort_levels || entry.effort_levels.includes(currentEffort)));
  return {
    model: nextModel,
    effort: effortAllowed ? currentEffort : "default",
  };
}

export function LocalAgentTargetSelect({
  projectId,
  runtime,
  agents,
  effectivePriority,
  value,
  disabled,
  size = "sm",
  fullWidth = false,
  className,
  onChange,
}: {
  projectId?: string;
  runtime: ChatRuntime;
  agents: BridgeAgentSummary[];
  effectivePriority?: string[];
  value: string;
  disabled?: boolean;
  size?: "xs" | "sm";
  fullWidth?: boolean;
  className?: string;
  onChange: (target: string) => void;
}) {
  const autoResolved = useMemo(
    () =>
      resolveLocalTaskAgent({
        agents,
        effectivePriority,
        projectId,
        executionTarget: "auto",
        runtime,
      }),
    [agents, effectivePriority, projectId, runtime],
  );

  const selectedResolved = useMemo(
    () =>
      resolveLocalTaskAgent({
        agents,
        effectivePriority,
        projectId,
        executionTarget: value,
        runtime,
      }),
    [agents, effectivePriority, projectId, value, runtime],
  );

  const options = useMemo<Array<SelectOption<string>>>(() => {
    const list: Array<SelectOption<string>> = [
      {
        value: "auto",
        label: "自动路由（按优先级）",
        triggerLabel:
          autoResolved.ready && autoResolved.agent
            ? `自动 · ${autoResolved.agent.name}`
            : "自动路由",
        description:
          autoResolved.ready && autoResolved.agent
            ? `将由本机「${autoResolved.agent.name}」承接`
            : autoResolved.reason || "按项目本机优先级自动选择",
        icon: "sparkles",
        badge: "推荐",
      },
    ];

    for (const agent of agents) {
      const binding = projectId
        ? agent.bindings.find((b) => b.project_id === projectId)
        : undefined;
      const bindingReady = !projectId || Boolean(binding?.enabled && binding?.path_ok);
      const runtimeReady = Boolean(agent.runtimes[runtime]?.available);
      const hasCapacity = agent.active_runs < agent.max_concurrency;
      const ready = agent.online && bindingReady && runtimeReady && hasCapacity;

      const statusText = !agent.online
        ? "离线"
        : !bindingReady
          ? "未绑定或未启用本项目目录"
          : !runtimeReady
            ? `未检测到 ${runtimeLabel(runtime)}`
            : !hasCapacity
              ? `并发已满 ${agent.active_runs}/${agent.max_concurrency}`
              : `就绪 · 并发 ${agent.active_runs}/${agent.max_concurrency}`;

      list.push({
        value: `local:${agent.id}`,
        label: agent.name,
        triggerLabel: agent.name,
        description: binding?.workdir ? `${statusText} · ${binding.workdir}` : statusText,
        dotClassName: ready ? "bg-emerald-500" : "bg-zinc-400",
        badge: agent.online ? "本机" : "离线",
        group: "指定本机节点",
      });
    }

    return list;
  }, [agents, projectId, runtime, autoResolved]);

  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
      size={size}
      fullWidth={fullWidth}
      minMenuWidth={256}
      maxMenuWidth={320}
      leadingIcon={value.startsWith("local:") ? "monitor" : "sparkles"}
      leadingIconClassName={
        selectedResolved.ready ? "text-emerald-500" : "text-[var(--text-muted)]"
      }
      ariaLabel="Local Agent 节点"
      className={className}
    />
  );
}

export function LocalAgentModelCombobox({
  runtime,
  agent,
  model,
  currentEffort = "default",
  disabled = false,
  direction = "down",
  size = "sm",
  fullWidth = false,
  ariaLabel = "选择模型",
  className,
  onChange,
}: {
  runtime: ChatRuntime;
  agent: BridgeAgentSummary | null;
  model: string;
  currentEffort?: ChatReasoningEffort;
  disabled?: boolean;
  direction?: "up" | "down";
  size?: "xs" | "sm";
  fullWidth?: boolean;
  ariaLabel?: string;
  className?: string;
  onChange: (modelId: string, nextEffort: ChatReasoningEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const strictCatalog = useMemo(
    () =>
      resolveLocalTaskModelCatalog({
        runtime,
        agent,
        includeSelectedFallback: false,
      }),
    [runtime, agent],
  );
  const catalog = useMemo(
    () =>
      resolveLocalTaskModelCatalog({
        runtime,
        agent,
        selectedModel: model,
        includeSelectedFallback: true,
      }),
    [runtime, agent, model],
  );
  const strictIds = useMemo(
    () => new Set(strictCatalog.map((item) => item.id)),
    [strictCatalog],
  );
  const nodeDefaultModel = resolveDefaultModelForTarget(runtime, agent, undefined);
  const currentEntry = catalog.find((item) => item.id === model);
  const search = query.trim();

  const options = useMemo<ModelCatalogItem[]>(() => {
    const matches = catalog.filter((item) =>
      `${item.id} ${item.label ?? ""} ${item.provider ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
    const list: ModelCatalogItem[] = [];
    if (!search || "默认 default node".includes(search.toLowerCase())) {
      list.push({
        runtime,
        id: "",
        label: nodeDefaultModel ? `节点默认（${nodeDefaultModel}）` : "使用节点默认模型",
      });
    }
    if (validCatalogId(search)) {
      const exact = matches.find((item) => item.id === search);
      list.push(exact ?? { runtime, id: search, label: "使用自定义模型 ID" });
      for (const item of matches) {
        if (item !== exact) list.push(item);
      }
    } else {
      list.push(...matches);
    }
    return list;
  }, [catalog, search, runtime, nodeDefaultModel]);

  const selectedIndex = Math.min(Math.max(index, 0), Math.max(options.length - 1, 0));

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open, runtime]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (modelId: string) => {
    const effectiveId = modelId || nodeDefaultModel;
    const entry = catalog.find((item) => item.id === effectiveId);
    const nextEffort: ChatReasoningEffort =
      entry?.supports_effort === false ||
      (currentEffort !== "default" &&
        entry?.effort_levels &&
        !entry.effort_levels.includes(currentEffort))
        ? "default"
        : currentEffort;
    onChange(modelId, nextEffort);
    setQuery("");
    setIndex(0);
    close();
  };

  const triggerText = model
    ? currentEntry?.label && currentEntry.label !== model
      ? `${currentEntry.label} (${model})`
      : model
    : nodeDefaultModel
      ? `默认 · ${nodeDefaultModel}`
      : "节点默认模型";

  return (
    <div
      ref={rootRef}
      className={cn("relative", fullWidth ? "w-full" : "inline-block", className)}
      onKeyDown={(e) => {
        if (open && e.key === "Escape" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`当前模型：${model || nodeDefaultModel || "使用节点默认模型"}`}
        onClick={() => {
          setQuery("");
          setIndex(0);
          setOpen((v) => !v);
        }}
        className={cn(
          "rd-focus-ring inline-flex items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-left text-[var(--text-primary)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]/60 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer",
          size === "xs" ? "h-7 px-2 text-xs" : "h-8 px-2.5 text-xs",
          fullWidth ? "w-full" : "max-w-[240px]",
          open && "border-[var(--rd-accent)]",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon name="cpu" size={12} className="shrink-0 text-[var(--text-muted)]" />
          <span className={cn("truncate", model ? "font-mono text-[11.5px]" : "text-[var(--text-secondary)]")}>
            {triggerText}
          </span>
        </span>
        <Icon name="chevron-down" size={12} className="shrink-0 text-[var(--text-muted)]" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="选择模型"
          className={cn(
            "absolute left-0 z-40 w-[min(340px,85vw)] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--rd-shadow-lg)] overflow-hidden",
            direction === "up"
              ? "bottom-full mb-1.5 animate-popover-in-up"
              : "top-full mt-1.5",
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
              {agent ? (
                <>
                  <LivePulseDot tone={agent.online ? "emerald" : "zinc"} active={agent.online} />
                  <span className="truncate">
                    本机目录 · {agent.name} ({runtimeLabel(runtime)})
                  </span>
                </>
              ) : (
                <>
                  <Icon name="sparkles" size={11} className="shrink-0" />
                  <span className="truncate">内置建议 · {runtimeLabel(runtime)}</span>
                </>
              )}
            </span>
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
              {strictCatalog.length} 个模型
            </span>
          </div>

          <label className="mx-3 flex items-center gap-2 py-2 text-[var(--text-muted)]">
            <Icon name="search" size={13} />
            <input
              ref={inputRef}
              role="combobox"
              aria-label="搜索或输入模型 ID"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                options.length > 0 ? `${listId}-${selectedIndex}` : undefined
              }
              value={query}
              maxLength={160}
              placeholder="搜索模型或输入自定义 ID…"
              className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              onKeyDown={(e) => {
                if (disabled || e.nativeEvent.isComposing || !options.length) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  choose(options[selectedIndex].id);
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const next =
                    (selectedIndex + options.length + (e.key === "ArrowDown" ? 1 : -1)) %
                    options.length;
                  setIndex(next);
                  document
                    .getElementById(`${listId}-${next}`)
                    ?.scrollIntoView({ block: "nearest" });
                }
              }}
            />
            <kbd className="font-mono text-[10px]">↑↓ ↵</kbd>
          </label>

          <div
            role="listbox"
            id={listId}
            aria-label="可选模型"
            className="rd-scroll max-h-[min(36vh,15rem)] overflow-y-auto px-1.5 pb-1.5"
          >
            {agent && strictCatalog.length === 0 && !search && (
              <p className="px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">
                节点「{agent.name}」尚未上报 {runtimeLabel(runtime)} 模型，可使用节点默认或直接输入模型 ID。
              </p>
            )}
            {!options.length && (
              <p className="px-2.5 py-2 text-xs text-[var(--text-muted)]">
                无匹配模型。自定义 ID 须使用可见 ASCII 字符，不能含空格或以连字符开头。
              </p>
            )}
            {options.map((item, i) => {
              const isDefaultOption = item.id === "";
              const showSeparateLabel = Boolean(!isDefaultOption && item.label && item.label !== item.id);
              const outOfCatalog = Boolean(
                item.id && item.id === model && agent && !strictIds.has(item.id),
              );
              const isSelected = model === item.id;
              return (
                <button
                  key={item.id || "__default__"}
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={-1}
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(item.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left cursor-pointer",
                    selectedIndex === i && "bg-[var(--surface-hover)]",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    {isDefaultOption ? (
                      <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
                        {item.label}
                      </span>
                    ) : (
                      <>
                        {showSeparateLabel && (
                          <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
                            {item.label}
                          </span>
                        )}
                        <span
                          title={item.id}
                          className={cn(
                            "block truncate font-mono",
                            showSeparateLabel
                              ? "text-[11px] text-[var(--text-secondary)]"
                              : "text-xs font-medium text-[var(--text-primary)]",
                          )}
                        >
                          {item.id}
                        </span>
                      </>
                    )}
                  </span>
                  {item.context_window && (
                    <span
                      title={`${item.context_window.toLocaleString()} 个上下文 token`}
                      className="shrink-0 rounded border border-[var(--border-subtle)] px-1 font-mono text-[10px] text-[var(--text-muted)]"
                    >
                      {CONTEXT_FORMAT.format(item.context_window)}
                    </span>
                  )}
                  {outOfCatalog && (
                    <span className="shrink-0 rounded bg-amber-500/12 px-1 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                      当前配置
                    </span>
                  )}
                  {!isDefaultOption &&
                    (nodeDefaultModel ? item.id === nodeDefaultModel : item.is_default) && (
                      <span className="shrink-0 text-[10px] text-[var(--text-muted)]">默认</span>
                    )}
                  {isSelected && (
                    <Icon name="check" size={13} className="shrink-0 text-indigo-500" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function LocalAgentEffortSelect({
  runtime,
  agent,
  model,
  value,
  disabled = false,
  size = "sm",
  fullWidth = false,
  ariaLabel = "推理强度",
  className,
  onChange,
}: {
  runtime: ChatRuntime;
  agent: BridgeAgentSummary | null;
  model: string;
  value: ChatReasoningEffort;
  disabled?: boolean;
  size?: "xs" | "sm";
  fullWidth?: boolean;
  ariaLabel?: string;
  className?: string;
  onChange: (effort: ChatReasoningEffort) => void;
}) {
  const catalog = useMemo(
    () =>
      resolveLocalTaskModelCatalog({
        runtime,
        agent,
        selectedModel: model,
        includeSelectedFallback: true,
      }),
    [runtime, agent, model],
  );
  const effectiveModelId = model || resolveDefaultModelForTarget(runtime, agent, undefined);
  const current = catalog.find((item) => item.id === effectiveModelId);
  const levels = current?.effort_levels ?? ALL_EFFORT_LEVELS;
  const adjustable = current?.supports_effort !== false && levels.length > 0;
  const displayed: ChatReasoningEffort =
    adjustable && (value === "default" || levels.includes(value)) ? value : "default";

  const options = useMemo<Array<SelectOption<ChatReasoningEffort>>>(() => {
    const nodeDefaultEffort = agent?.runtimes[runtime]?.default_effort;
    const defaultBadge =
      nodeDefaultEffort && nodeDefaultEffort !== "default"
        ? `节点：${effortLabels[nodeDefaultEffort]}`
        : undefined;
    const list: Array<SelectOption<ChatReasoningEffort>> = [
      {
        value: "default",
        label: effortLabels.default,
        triggerLabel: effortLabels.default,
        description: EFFORT_META.default.description,
        badge: defaultBadge,
        dotClassName: EFFORT_META.default.dotClassName,
      },
    ];
    for (const level of levels) {
      list.push({
        value: level,
        label: effortLabels[level],
        triggerLabel: effortLabels[level],
        description: EFFORT_META[level].description,
        badge: EFFORT_META[level].badge,
        dotClassName: EFFORT_META[level].dotClassName,
      });
    }
    return list;
  }, [levels, agent, runtime]);

  return (
    <Select
      value={displayed}
      onChange={onChange}
      options={options}
      disabled={!adjustable || disabled}
      size={size}
      fullWidth={fullWidth}
      minMenuWidth={240}
      maxMenuWidth={290}
      leadingIcon="sparkles"
      leadingIconClassName={
        displayed !== "default" && displayed !== "off"
          ? "text-indigo-500"
          : "text-[var(--text-muted)]"
      }
      ariaLabel={adjustable ? ariaLabel : "该模型不支持调节推理强度"}
      className={className}
    />
  );
}
