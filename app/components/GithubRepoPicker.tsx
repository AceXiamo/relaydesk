import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { Button, Kbd } from "./ui.tsx";
import { api } from "~/lib/api.ts";
import { formatRelativeTime } from "~/lib/format.ts";
import type {
  GithubConnectionSummary,
  GithubOwnerInfo,
  GithubRepoItem,
  GithubRepoWarning,
} from "~/lib/types.ts";

interface GithubRepoPickerProps {
  value: string;
  onChange: (
    value: string,
    meta?: { pickedFromGithub?: boolean; repoItem?: GithubRepoItem },
  ) => void;
  githubConfigured: boolean;
  githubConnections?: GithubConnectionSummary[];
  /** Auto-open & fetch repositories immediately (used in CreateProjectModal) */
  defaultExpanded?: boolean;
  /** Jump to Settings to connect GitHub when not configured */
  onOpenGithubSettings?: () => void;
  required?: boolean;
}

interface ScopeCache {
  items: GithubRepoItem[];
  page: number;
  more: boolean;
}

const VALID_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function parseNormalizedRepoPreview(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const httpsMatch = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git|\/)?$/i,
  );
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = trimmed.match(
    /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  );
  if (sshMatch) return sshMatch[1];
  return null;
}

function mergeOwnerList(
  prev: GithubOwnerInfo[],
  incoming: GithubOwnerInfo[],
  viewerLogin?: string | null,
): GithubOwnerInfo[] {
  const map = new Map<string, GithubOwnerInfo>();
  for (const item of [...prev, ...incoming]) {
    const key = item.login.toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
    } else {
      map.set(key, {
        login: existing.login,
        type:
          existing.type === "Organization" || item.type === "Organization"
            ? "Organization"
            : "User",
        avatar_url: existing.avatar_url || item.avatar_url,
      });
    }
  }
  const vKey = viewerLogin?.toLowerCase();
  return Array.from(map.values()).sort((a, b) => {
    if (vKey && a.login.toLowerCase() === vKey) return -1;
    if (vKey && b.login.toLowerCase() === vKey) return 1;
    if (a.type !== b.type) return a.type === "Organization" ? -1 : 1;
    return a.login.localeCompare(b.login);
  });
}

function mergeRepoItems(
  prev: GithubRepoItem[],
  incoming: GithubRepoItem[],
): GithubRepoItem[] {
  const map = new Map<string, GithubRepoItem>();
  for (const item of prev) {
    map.set(item.full_name.toLowerCase(), item);
  }
  for (const item of incoming) {
    map.set(item.full_name.toLowerCase(), item);
  }
  return Array.from(map.values()).sort(
    (a, b) =>
      b.updated_at.localeCompare(a.updated_at) ||
      a.full_name.localeCompare(b.full_name),
  );
}

export interface GithubOwnerAvatarProps {
  login: string;
  type: "User" | "Organization";
  avatarUrl?: string;
  size?: "xs" | "sm" | "md";
  selected?: boolean;
  onActivePill?: boolean;
  className?: string;
}

export function GithubOwnerAvatar({
  login,
  type,
  avatarUrl,
  size = "md",
  selected = false,
  onActivePill = false,
  className = "",
}: GithubOwnerAvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const isOrg = type === "Organization";
  const showImage = Boolean(avatarUrl && failedUrl !== avatarUrl);

  const dims =
    size === "xs"
      ? "w-4 h-4"
      : size === "sm"
        ? "w-[18px] h-[18px]"
        : "w-7 h-7";
  const radius =
    size === "xs"
      ? isOrg
        ? "rounded-[4px]"
        : "rounded-full"
      : size === "sm"
        ? isOrg
          ? "rounded-[4px]"
          : "rounded-full"
        : isOrg
          ? "rounded-lg"
          : "rounded-full";
  const iconSize = size === "xs" ? 11.5 : size === "sm" ? 12 : 14;

  if (showImage) {
    return (
      <img
        src={avatarUrl}
        alt={login}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(avatarUrl ?? null)}
        className={`${dims} ${radius} shrink-0 object-cover bg-[var(--surface-subtle)] ${
          selected
            ? "ring-2 ring-indigo-500/80"
            : onActivePill
              ? "ring-1 ring-white/40"
              : "ring-1 ring-black/10 dark:ring-white/12"
        } ${className}`}
      />
    );
  }

  return (
    <span
      className={`${dims} ${radius} shrink-0 inline-flex items-center justify-center ${
        onActivePill
          ? "bg-white/20 text-white"
          : selected
            ? "bg-indigo-600 text-white"
            : isOrg
              ? "bg-indigo-500/12 text-indigo-600 dark:text-indigo-400"
              : "bg-[var(--surface-subtle)] text-[var(--text-muted)]"
      } ${className}`}
    >
      <Icon name={isOrg ? "building-2" : "user"} size={iconSize} />
    </span>
  );
}

export function GithubRepoPicker({
  value,
  onChange,
  githubConfigured,
  githubConnections = [],
  defaultExpanded = false,
  onOpenGithubSettings,
  required = true,
}: GithubRepoPickerProps) {
  const repoInputId = useId();
  const seededOwners = useMemo(() => {
    const all: GithubOwnerInfo[] = [];
    for (const conn of githubConnections) {
      for (const o of conn.owners) all.push(o);
    }
    const primaryViewer = githubConnections.find((c) => c.viewer)?.viewer?.login;
    return mergeOwnerList([], all, primaryViewer);
  }, [githubConnections]);

  const connectionsSignature = useMemo(
    () => githubConnections.map((c) => `${c.id}:${c.updated_at}`).join("|"),
    [githubConnections],
  );
  const prevSigRef = useRef(connectionsSignature);

  const [expanded, setExpanded] = useState(defaultExpanded && githubConfigured);
  const [activeOwner, setActiveOwner] = useState<string>("all");
  const [owners, setOwners] = useState<GithubOwnerInfo[]>(seededOwners);
  const [viewer, setViewer] = useState<GithubOwnerInfo | null>(
    githubConnections.find((c) => c.viewer)?.viewer ?? null,
  );
  const [cache, setCache] = useState<Record<string, ScopeCache>>({});
  const [warnings, setWarnings] = useState<GithubRepoWarning[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);

  // Invalidate cached scopes whenever configured GitHub keys change
  useEffect(() => {
    if (prevSigRef.current === connectionsSignature) return;
    prevSigRef.current = connectionsSignature;
    requestSeqRef.current += 1;
    setCache({});
    setWarnings([]);
    setError("");
    setActiveOwner("all");
    setOwners(seededOwners);
    setViewer(githubConnections.find((c) => c.viewer)?.viewer ?? null);
  }, [connectionsSignature, githubConnections, seededOwners]);

  // Custom org inline input (for orgs not returned by /user/orgs, e.g. Fine-grained PAT)
  const [customOrgOpen, setCustomOrgOpen] = useState(false);
  const [customOrgInput, setCustomOrgInput] = useState("");

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const requestSeqRef = useRef(0);

  const scopeKey = activeOwner.toLowerCase();
  const activeScope = cache[scopeKey];
  const currentItems = activeScope?.items ?? [];
  const hasMore = activeScope?.more ?? false;
  const currentPage = activeScope?.page ?? 1;

  const fetchScope = useCallback(
    async (
      owner: string,
      ownerType?: "User" | "Organization",
      page = 1,
      forceRefresh = false,
    ) => {
      const key = owner.toLowerCase();
      if (!forceRefresh && page === 1 && cache[key]) {
        return;
      }

      const seq = ++requestSeqRef.current;
      if (page === 1) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError("");

      try {
        const res = await api.listGithubRepos({
          page,
          owner,
          ...(owner !== "all" && ownerType ? { owner_type: ownerType } : {}),
        });
        if (seq !== requestSeqRef.current) return;

        const nextViewer = res.viewer ?? viewer;
        if (res.viewer) setViewer(res.viewer);
        setOwners((prev) =>
          mergeOwnerList(prev, res.owners ?? [], nextViewer?.login),
        );
        if (page === 1) {
          setWarnings(res.warnings ?? []);
        }
        setCache((prev) => {
          const prevItems = page === 1 ? [] : prev[key]?.items ?? [];
          return {
            ...prev,
            [key]: {
              items: mergeRepoItems(prevItems, res.items ?? []),
              page,
              more: Boolean(res.more),
            },
          };
        });
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        setError(
          err instanceof Error ? err.message : "读取 GitHub 仓库列表失败",
        );
      } finally {
        if (seq === requestSeqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [cache, viewer],
  );

  // Auto-load on expand when GitHub is configured
  useEffect(() => {
    if (githubConfigured && expanded && !cache[scopeKey] && !loading && !error) {
      const matched = owners.find((o) => o.login.toLowerCase() === scopeKey);
      void fetchScope(activeOwner, matched?.type, 1, false);
    }
  }, [
    activeOwner,
    cache,
    error,
    expanded,
    fetchScope,
    githubConfigured,
    loading,
    owners,
    scopeKey,
  ]);

  // Sync defaultExpanded if githubConfigured toggles on
  useEffect(() => {
    if (defaultExpanded && githubConfigured) {
      setExpanded(true);
    }
  }, [defaultExpanded, githubConfigured]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return currentItems;
    const tokens = q.split(/\s+/).filter(Boolean);
    return currentItems.filter((item) => {
      const hay = `${item.full_name} ${item.description}`.toLowerCase();
      return tokens.every((tok) => hay.includes(tok));
    });
  }, [currentItems, query]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [query, activeOwner, filteredItems.length]);

  // Keep highlighted row scrolled into view during keyboard navigation
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const activeEl = container.querySelector<HTMLElement>(
      `[data-repo-index="${highlightIndex}"]`,
    );
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  const handleSelectScope = (owner: string, ownerType?: "User" | "Organization") => {
    setActiveOwner(owner);
    setError("");
    const key = owner.toLowerCase();
    if (!cache[key]) {
      void fetchScope(owner, ownerType, 1, true);
    }
  };

  const handleLoadCustomOrg = (rawOrg: string) => {
    const cleaned = rawOrg.trim().replace(/^@/, "").split("/")[0] ?? "";
    if (!VALID_OWNER_RE.test(cleaned)) {
      setError("组织名格式不正确，仅支持字母、数字与连字符。");
      return;
    }
    setCustomOrgOpen(false);
    setCustomOrgInput("");
    setQuery("");
    setActiveOwner(cleaned);
    setOwners((prev) =>
      mergeOwnerList(
        prev,
        [{ login: cleaned, type: "Organization" }],
        viewer?.login,
      ),
    );
    void fetchScope(cleaned, "Organization", 1, true);
  };

  const handlePickRepo = (item: GithubRepoItem) => {
    onChange(item.full_name, { pickedFromGithub: true, repoItem: item });
  };

  const normalizedPreview = parseNormalizedRepoPreview(value);
  const selectedLower = (normalizedPreview ?? value).trim().toLowerCase();
  const orgOwners = owners.filter((o) => o.type === "Organization");

  const ownerMap = useMemo(() => {
    const map = new Map<string, GithubOwnerInfo>();
    for (const o of owners) {
      map.set(o.login.toLowerCase(), o);
    }
    return map;
  }, [owners]);

  const inputMatchedOwner = useMemo(() => {
    const clean = (normalizedPreview ?? value).trim();
    if (!clean.includes("/")) return null;
    const ownerLogin = clean.split("/")[0]?.toLowerCase();
    if (!ownerLogin) return null;
    const knownOwner = ownerMap.get(ownerLogin);
    if (knownOwner) return knownOwner;
    const knownItem = currentItems.find(
      (item) => item.owner.toLowerCase() === ownerLogin,
    );
    if (knownItem) {
      return {
        login: knownItem.owner,
        type: knownItem.owner_type,
        avatar_url: knownItem.owner_avatar,
      };
    }
    return null;
  }, [currentItems, normalizedPreview, ownerMap, value]);

  // Detect if user typed an org prefix like "my-org" or "my-org/" that isn't loaded yet
  const candidateOrgFromQuery = useMemo(() => {
    const raw = query.trim().replace(/^@/, "");
    if (!raw) return null;
    const prefix = raw.includes("/") ? raw.split("/")[0] : raw;
    if (!VALID_OWNER_RE.test(prefix)) return null;
    const alreadyKnown = owners.some(
      (o) => o.login.toLowerCase() === prefix.toLowerCase(),
    );
    if (alreadyKnown && activeOwner.toLowerCase() === prefix.toLowerCase()) {
      return null;
    }
    return prefix;
  }, [activeOwner, owners, query]);

  return (
    <div className="space-y-2.5">
      {/* Editable Repo Input */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor={repoInputId}
            className="text-[12.5px] font-medium text-[var(--text-primary)]"
          >
            GitHub 仓库
          </label>
          {githubConfigured && !defaultExpanded && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
            >
              <Icon name="github" size={13} />
              {expanded ? "收起仓库浏览器" : "从 GitHub 浏览（个人与组织）"}
              <Icon
                name="chevron-down"
                size={13}
                className={`transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </div>

        <div className="relative">
          <div className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none flex items-center justify-center w-5 h-5">
            {inputMatchedOwner?.avatar_url ? (
              <GithubOwnerAvatar
                login={inputMatchedOwner.login}
                type={inputMatchedOwner.type}
                avatarUrl={inputMatchedOwner.avatar_url}
                size="sm"
              />
            ) : (
              <Icon
                name="github"
                size={15}
                className="text-[var(--text-muted)]"
              />
            )}
          </div>
          <input
            id={repoInputId}
            type="text"
            required={required}
            maxLength={200}
            value={value}
            onChange={(e) => onChange(e.target.value, { pickedFromGithub: false })}
            placeholder="owner/repository 或粘贴完整 GitHub 地址"
            autoComplete="off"
            spellCheck={false}
            className="w-full h-9.5 pl-9 pr-8 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
          />
          {value && (
            <button
              type="button"
              onClick={() => onChange("", { pickedFromGithub: false })}
              aria-label="清空仓库"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>

        {normalizedPreview && (
          <div className="flex items-center gap-1.5 text-[11.5px] text-emerald-600 dark:text-emerald-400">
            <Icon name="check-circle-2" size={13} />
            <span>
              将规范化绑定为{" "}
              <code className="font-mono font-medium">{normalizedPreview}</code>
            </span>
          </div>
        )}
      </div>

      {/* Not Connected Hint */}
      {!githubConfigured && (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-dashed border-[var(--border-subtle)] bg-[var(--surface-subtle)]/70">
          <div className="flex items-center gap-2 min-w-0">
            <Icon
              name="github"
              size={15}
              className="text-[var(--text-muted)] shrink-0"
            />
            <span className="text-[12px] text-[var(--text-muted)] truncate">
              连接 GitHub Token 后可直接搜索并选择个人与组织仓库
            </span>
          </div>
          {onOpenGithubSettings && (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              icon="settings"
              onClick={onOpenGithubSettings}
            >
              去连接
            </Button>
          )}
        </div>
      )}

      {/* Rich Interactive GitHub Repository Browser */}
      {githubConfigured && expanded && (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
          {/* Namespace / Organization Switcher Bar */}
          <div className="px-2.5 py-2 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]/70 flex items-center gap-1.5">
            <div className="flex-1 flex items-center gap-1 overflow-x-auto no-scrollbar min-w-0 py-0.5">
              <button
                type="button"
                onClick={() => handleSelectScope("all")}
                className={`shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium transition cursor-pointer ${
                  activeOwner === "all"
                    ? "bg-indigo-600 text-white shadow-2xs"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                <Icon name="layers" size={12.5} />
                <span>全部</span>
              </button>

              {owners.map((owner) => {
                const isSelected =
                  activeOwner.toLowerCase() === owner.login.toLowerCase();
                const isOrg = owner.type === "Organization";
                return (
                  <button
                    key={`${owner.type}:${owner.login}`}
                    type="button"
                    onClick={() => handleSelectScope(owner.login, owner.type)}
                    title={isOrg ? `组织：${owner.login}` : `个人账号：${owner.login}`}
                    className={`shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium transition cursor-pointer ${
                      isSelected
                        ? "bg-indigo-600 text-white shadow-2xs"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <GithubOwnerAvatar
                      login={owner.login}
                      type={owner.type}
                      avatarUrl={owner.avatar_url}
                      size="xs"
                      onActivePill={isSelected}
                    />
                    <span className="max-w-[130px] truncate">{owner.login}</span>
                    {isOrg && (
                      <span
                        className={`text-[10px] px-1 rounded ${
                          isSelected
                            ? "bg-white/20 text-white"
                            : "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                        }`}
                      >
                        组织
                      </span>
                    )}
                  </button>
                );
              })}

              {/* Custom Org Input Trigger */}
              {customOrgOpen ? (
                <div className="shrink-0 inline-flex items-center gap-1 h-7 pl-2 pr-1 rounded-lg border border-indigo-500 bg-[var(--surface-elevated)]">
                  <Icon
                    name="building-2"
                    size={12}
                    className="text-indigo-500"
                  />
                  <input
                    type="text"
                    autoFocus
                    value={customOrgInput}
                    onChange={(e) => setCustomOrgInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        handleLoadCustomOrg(customOrgInput);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setCustomOrgOpen(false);
                        setCustomOrgInput("");
                      }
                    }}
                    placeholder="输入组织名"
                    className="w-24 bg-transparent text-[12px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => handleLoadCustomOrg(customOrgInput)}
                    disabled={!customOrgInput.trim()}
                    aria-label="加载组织仓库"
                    className="p-0.5 rounded text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/15 disabled:opacity-40 cursor-pointer"
                  >
                    <Icon name="check" size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCustomOrgOpen(false);
                      setCustomOrgInput("");
                    }}
                    aria-label="取消"
                    className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCustomOrgOpen(true)}
                  title="手动输入组织名以加载其仓库"
                  className="shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[11.5px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] border border-dashed border-[var(--border-subtle)] transition cursor-pointer"
                >
                  <Icon name="plus" size={12} />
                  <span>组织</span>
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                const matched = owners.find(
                  (o) => o.login.toLowerCase() === scopeKey,
                );
                void fetchScope(activeOwner, matched?.type, 1, true);
              }}
              disabled={loading}
              title="刷新当前列表"
              aria-label="刷新当前仓库列表"
              className="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer disabled:opacity-50"
            >
              <Icon
                name="refresh-cw"
                size={13.5}
                className={loading ? "animate-spin" : ""}
              />
            </button>
          </div>

          {/* Search Bar */}
          <div className="px-3 h-9.5 border-b border-[var(--border-subtle)] bg-[var(--surface-elevated)]/60 flex items-center gap-2">
            <Icon
              name="search"
              size={14}
              className="text-[var(--text-muted)] shrink-0"
            />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlightIndex((i) =>
                    filteredItems.length > 0
                      ? Math.min(filteredItems.length - 1, i + 1)
                      : 0,
                  );
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlightIndex((i) => Math.max(0, i - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const target = filteredItems[highlightIndex];
                  if (target) {
                    handlePickRepo(target);
                  } else if (candidateOrgFromQuery) {
                    handleLoadCustomOrg(candidateOrgFromQuery);
                  }
                }
              }}
              placeholder={
                activeOwner === "all"
                  ? "筛选个人与组织仓库（支持名称、组织或简介）…"
                  : `在 ${activeOwner} 中筛选仓库…`
              }
              className="flex-1 bg-transparent text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none min-w-0"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
                aria-label="清空搜索"
                className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <Icon name="x" size={13} />
              </button>
            ) : (
              <span className="hidden sm:inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)] shrink-0">
                <Kbd>↑↓</Kbd>
                <Kbd>↵</Kbd>
              </span>
            )}
          </div>

          {/* Partial-key Warning Banner */}
          {warnings.length > 0 && (
            <div className="px-3 py-2 border-b border-amber-500/25 bg-amber-500/8 flex items-center justify-between gap-2 text-[11.5px] text-amber-700 dark:text-amber-300">
              <div className="flex items-center gap-1.5 min-w-0">
                <Icon name="alert-triangle" size={13} className="shrink-0" />
                <span className="truncate" title={warnings.map((w) => `${w.label}: ${w.error}`).join("；")}>
                  部分 GitHub Key 读取失败：{warnings.map((w) => w.label).join("、")}
                </span>
              </div>
              {onOpenGithubSettings && (
                <button
                  type="button"
                  onClick={onOpenGithubSettings}
                  className="shrink-0 font-medium underline underline-offset-2 hover:opacity-80 cursor-pointer"
                >
                  检查 Key
                </button>
              )}
            </div>
          )}

          {/* Repository List */}
          <div
            ref={listRef}
            role="listbox"
            aria-label="GitHub 仓库列表"
            className="max-h-[244px] overflow-y-auto rd-scroll divide-y divide-[var(--border-subtle)]/60"
          >
            {loading && currentItems.length === 0 ? (
              <div className="p-2.5 space-y-2">
                {[0, 1, 2, 3].map((idx) => (
                  <div
                    key={idx}
                    className="h-11 rounded-lg bg-[var(--surface-subtle)] animate-pulse"
                  />
                ))}
              </div>
            ) : error ? (
              <div className="px-4 py-6 text-center space-y-2.5">
                <div className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-rose-500/10 text-rose-500">
                  <Icon name="alert-circle" size={16} />
                </div>
                <p className="text-[12.5px] text-rose-600 dark:text-rose-400">
                  {error}
                </p>
                <div className="flex items-center justify-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    icon="refresh-cw"
                    onClick={() => {
                      const matched = owners.find(
                        (o) => o.login.toLowerCase() === scopeKey,
                      );
                      void fetchScope(activeOwner, matched?.type, 1, true);
                    }}
                  >
                    重试
                  </Button>
                  {activeOwner !== "all" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => handleSelectScope("all")}
                    >
                      返回全部
                    </Button>
                  )}
                </div>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="px-4 py-6 text-center space-y-2.5">
                <p className="text-[12.5px] text-[var(--text-muted)]">
                  {query.trim()
                    ? `当前列表中未找到匹配「${query.trim()}」的仓库`
                    : activeOwner === "all"
                      ? "未读取到可访问的仓库"
                      : `组织「${activeOwner}」下暂无可访问仓库`}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {candidateOrgFromQuery && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      icon="building-2"
                      onClick={() => handleLoadCustomOrg(candidateOrgFromQuery)}
                    >
                      从组织 {candidateOrgFromQuery} 拉取仓库
                    </Button>
                  )}
                  {query.trim() && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setQuery("")}
                    >
                      清空筛选
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              filteredItems.map((item, idx) => {
                const isSelected =
                  selectedLower === item.full_name.toLowerCase();
                const isHighlighted = idx === highlightIndex;
                const avatarUrl =
                  item.owner_avatar ??
                  ownerMap.get(item.owner.toLowerCase())?.avatar_url;
                return (
                  <button
                    key={item.full_name}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-repo-index={idx}
                    onMouseEnter={() => setHighlightIndex(idx)}
                    onClick={() => handlePickRepo(item)}
                    className={`w-full text-left px-3 py-2.5 flex items-center justify-between gap-3 transition cursor-pointer ${
                      isSelected
                        ? "bg-indigo-500/12"
                        : isHighlighted
                          ? "bg-[var(--surface-hover)]"
                          : "hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <GithubOwnerAvatar
                        login={item.owner}
                        type={item.owner_type}
                        avatarUrl={avatarUrl}
                        size="md"
                        selected={isSelected}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                          <span className="font-mono text-[12.5px] truncate">
                            <span className="text-[var(--text-muted)]">
                              {item.owner}/
                            </span>
                            <span
                              className={`font-semibold ${
                                isSelected
                                  ? "text-indigo-600 dark:text-indigo-400"
                                  : "text-[var(--text-primary)]"
                              }`}
                            >
                              {item.name}
                            </span>
                          </span>
                          {item.private && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[10px] font-medium bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-[var(--border-subtle)] shrink-0">
                              <Icon name="lock" size={9.5} />
                              私有
                            </span>
                          )}
                          {item.archived && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
                              <Icon name="archive" size={9.5} />
                              已归档
                            </span>
                          )}
                        </div>
                        {item.description && (
                          <p className="text-[11.5px] text-[var(--text-muted)] truncate mt-0.5">
                            {item.description}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {item.updated_at && (
                        <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
                          {formatRelativeTime(item.updated_at)}
                        </span>
                      )}
                      {isSelected && (
                        <span className="w-4.5 h-4.5 rounded-full bg-indigo-600 text-white inline-flex items-center justify-center">
                          <Icon name="check" size={11} />
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer Status & Load More */}
          <div className="px-3 py-1.5 border-t border-[var(--border-subtle)] bg-[var(--surface-subtle)]/50 flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
            <span className="truncate">
              {loading
                ? "正在同步 GitHub 仓库…"
                : query.trim()
                  ? `匹配 ${filteredItems.length} / ${currentItems.length} 个仓库`
                  : `${
                      githubConnections.length > 1
                        ? `已聚合 ${githubConnections.length} 个 Key · `
                        : ""
                    }已加载 ${currentItems.length} 个仓库${
                      orgOwners.length > 0 ? ` · ${orgOwners.length} 个组织` : ""
                    }`}
            </span>
            {hasMore && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                loading={loadingMore}
                onClick={() => {
                  const matched = owners.find(
                    (o) => o.login.toLowerCase() === scopeKey,
                  );
                  void fetchScope(activeOwner, matched?.type, currentPage + 1, true);
                }}
              >
                加载更多
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
