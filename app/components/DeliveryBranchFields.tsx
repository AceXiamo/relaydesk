import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { api } from "~/lib/api.ts";
import type { DeliveryMode, GithubBranchItem } from "~/lib/types.ts";

export const DEFAULT_BRANCH_PREFIX = "relaydesk";

export function validateGitRefInput(value: string, maxLen = 120): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) {
    return `长度不能超过 ${maxLen} 个字符`;
  }
  if (/[\x00-\x1f\x7f\s~^:?*[\]\\]/.test(trimmed)) {
    return "不能包含空格、控制字符或 ~ ^ : ? * [ ] \\";
  }
  if (
    trimmed === "@" ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.startsWith(".") ||
    trimmed.endsWith(".") ||
    trimmed.includes("..") ||
    trimmed.includes("//") ||
    trimmed.includes("@{")
  ) {
    return "不符合 Git 分支命名规范（不能以 / 或 . 开头/结尾，不能包含 .. 或 //）";
  }
  for (const part of trimmed.split("/")) {
    if (!part || part.startsWith(".") || part.endsWith(".lock")) {
      return "分支路径段不能以 . 开头或以 .lock 结尾";
    }
  }
  return null;
}

const VALID_REPO_RE = /^([\w.-]+)\/([\w.-]+)$/;

function normalizeRepoSlug(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = trimmed.match(VALID_REPO_RE);
  if (!m) return null;
  if (m[1] === "." || m[1] === ".." || m[2] === "." || m[2] === "..") return null;
  return `${m[1]}/${m[2]}`;
}

interface DeliveryBranchFieldsProps {
  repo: string | null | undefined;
  githubConfigured: boolean;
  deliveryMode: DeliveryMode;
  targetBranch: string;
  onTargetBranchChange: (value: string) => void;
  branchPrefix: string;
  onBranchPrefixChange: (value: string) => void;
  compact?: boolean;
}

export function DeliveryBranchFields({
  repo,
  githubConfigured,
  deliveryMode,
  targetBranch,
  onTargetBranchChange,
  branchPrefix,
  onBranchPrefixChange,
  compact = false,
}: DeliveryBranchFieldsProps) {
  const normalizedRepo = useMemo(() => normalizeRepoSlug(repo), [repo]);
  const [branches, setBranches] = useState<GithubBranchItem[]>([]);
  const [defaultBranch, setDefaultBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [fetchedRepo, setFetchedRepo] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);

  const loadBranches = useCallback(
    async (targetRepo: string, signal?: AbortSignal) => {
      const seq = ++seqRef.current;
      setLoading(true);
      setFetchError("");
      try {
        const res = await api.getGithubBranches(targetRepo, signal);
        if (seq !== seqRef.current) return;
        setBranches(res.items ?? []);
        setDefaultBranch(res.default_branch ?? "");
        setFetchedRepo(targetRepo);
      } catch (err) {
        if (seq !== seqRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setBranches([]);
        setDefaultBranch("");
        setFetchedRepo(targetRepo);
        setFetchError(err instanceof Error ? err.message : "拉取远程分支失败");
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!githubConfigured || !normalizedRepo) {
      setBranches([]);
      setDefaultBranch("");
      setFetchError("");
      setFetchedRepo(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadBranches(normalizedRepo, controller.signal);
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [githubConfigured, normalizedRepo, loadBranches]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDropdownOpen(false);
    };
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [dropdownOpen]);

  const filteredBranches = useMemo(() => {
    const q = targetBranch.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, targetBranch]);

  const targetBranchError = useMemo(
    () => validateGitRefInput(targetBranch, 120),
    [targetBranch],
  );
  const branchPrefixError = useMemo(
    () => validateGitRefInput(branchPrefix, 64),
    [branchPrefix],
  );

  const effectivePrefix = branchPrefix.trim() || DEFAULT_BRANCH_PREFIX;
  const previewBranchName = `${effectivePrefix}/rd-42`;
  const hasRemoteBranches = branches.length > 0;
  const canQueryGithub = githubConfigured && Boolean(normalizedRepo);

  const targetHint =
    deliveryMode === "pr_automerge"
      ? "基于 origin/<目标分支> 切工作分支并作为 PR base 分支；留空则使用仓库默认分支。"
      : deliveryMode === "review_only"
        ? "基于 origin/<目标分支> 切出验收分支；留空则沿用仓库默认分支。"
        : "直推模式将在该目标分支提交并推送；留空则使用当前工作分支。";

  return (
    <div
      className={`grid grid-cols-1 ${compact ? "sm:grid-cols-2 gap-3" : "sm:grid-cols-2 gap-3.5"} rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/55 ${compact ? "p-3" : "p-3.5"}`}
    >
      {/* Target Branch */}
      <div ref={containerRef} className="space-y-1.5 relative">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-[var(--text-primary)] inline-flex items-center gap-1.5">
            <Icon name="git-branch" size={12.5} className="text-[var(--text-muted)]" />
            目标分支
          </span>
          {canQueryGithub && (
            <button
              type="button"
              onClick={() => normalizedRepo && void loadBranches(normalizedRepo)}
              disabled={loading}
              title="刷新远程分支列表"
              className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition cursor-pointer disabled:opacity-50"
            >
              <Icon
                name="refresh-cw"
                size={11}
                className={loading ? "animate-spin" : ""}
              />
              {loading
                ? "拉取中…"
                : hasRemoteBranches
                  ? `${branches.length} 个分支`
                  : "刷新分支"}
            </button>
          )}
        </div>

        <div className="relative flex items-center">
          <input
            type="text"
            maxLength={120}
            value={targetBranch}
            onChange={(e) => {
              onTargetBranchChange(e.target.value);
              if (hasRemoteBranches && !dropdownOpen) setDropdownOpen(true);
            }}
            onFocus={() => {
              if (hasRemoteBranches) setDropdownOpen(true);
            }}
            placeholder={
              defaultBranch
                ? `留空使用仓库默认分支（${defaultBranch}）`
                : "留空使用仓库默认分支"
            }
            className={`w-full h-9 pl-3 ${
              targetBranch && hasRemoteBranches
                ? "pr-14"
                : targetBranch || hasRemoteBranches
                  ? "pr-8"
                  : "pr-3"
            } rounded-lg border bg-[var(--surface-elevated)] font-mono text-[12.5px] text-[var(--text-primary)] placeholder:font-sans placeholder:text-[12px] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 ${
              targetBranchError
                ? "border-rose-500/70 focus:border-rose-500 focus:ring-rose-500/15"
                : "border-[var(--border-subtle)] focus:border-indigo-500 focus:ring-indigo-500/15"
            }`}
          />

          <div className="absolute right-1.5 flex items-center gap-0.5">
            {targetBranch && (
              <button
                type="button"
                onClick={() => onTargetBranchChange("")}
                title="清空（恢复使用仓库默认分支）"
                aria-label="清空目标分支"
                className="w-6 h-6 rounded-md inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
              >
                <Icon name="x" size={12.5} />
              </button>
            )}
            {hasRemoteBranches && (
              <button
                type="button"
                onClick={() => setDropdownOpen((v) => !v)}
                title="选择远程分支"
                aria-label="展开远程分支列表"
                aria-expanded={dropdownOpen}
                className="w-6 h-6 rounded-md inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition cursor-pointer"
              >
                <Icon
                  name="chevron-down"
                  size={13}
                  className={`transition-transform duration-150 ${dropdownOpen ? "rotate-180" : ""}`}
                />
              </button>
            )}
          </div>
        </div>

        {/* Remote Branch Dropdown */}
        {dropdownOpen && hasRemoteBranches && (
          <div className="absolute left-0 right-0 top-[62px] z-30 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-card)] shadow-lg overflow-hidden">
            <div className="max-h-52 overflow-y-auto rd-scroll py-1">
              <button
                type="button"
                onClick={() => {
                  onTargetBranchChange("");
                  setDropdownOpen(false);
                }}
                className={`w-full px-3 py-1.5 text-left text-[12px] flex items-center justify-between gap-2 hover:bg-[var(--surface-hover)] transition cursor-pointer ${
                  !targetBranch.trim()
                    ? "bg-indigo-500/[0.08] text-indigo-600 dark:text-indigo-400 font-medium"
                    : "text-[var(--text-secondary)]"
                }`}
              >
                <span className="truncate">
                  留空（使用仓库默认分支{defaultBranch ? `：${defaultBranch}` : ""}）
                </span>
                {!targetBranch.trim() && <Icon name="check" size={12.5} />}
              </button>

              {filteredBranches.length > 0 ? (
                filteredBranches.map((branch) => {
                  const isSelected = targetBranch.trim() === branch.name;
                  const isDefault = Boolean(defaultBranch) && branch.name === defaultBranch;
                  return (
                    <button
                      key={branch.name}
                      type="button"
                      onClick={() => {
                        onTargetBranchChange(branch.name);
                        setDropdownOpen(false);
                      }}
                      className={`w-full px-3 py-1.5 text-left text-[12px] flex items-center justify-between gap-2 hover:bg-[var(--surface-hover)] transition cursor-pointer ${
                        isSelected
                          ? "bg-indigo-500/[0.08] text-indigo-600 dark:text-indigo-400 font-medium"
                          : "text-[var(--text-primary)]"
                      }`}
                    >
                      <span className="inline-flex items-center gap-1.5 min-w-0">
                        <code className="font-mono truncate">{branch.name}</code>
                        {isDefault && (
                          <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.25 rounded bg-indigo-500/12 text-indigo-600 dark:text-indigo-300">
                            默认
                          </span>
                        )}
                        {branch.protected && (
                          <Icon
                            name="lock"
                            size={10.5}
                            className="text-[var(--text-muted)] shrink-0"
                          />
                        )}
                      </span>
                      {isSelected && <Icon name="check" size={12.5} className="shrink-0" />}
                    </button>
                  );
                })
              ) : (
                <div className="px-3 py-2 text-[11.5px] text-[var(--text-muted)]">
                  未匹配到远程分支，将按手动输入的{" "}
                  <code className="font-mono text-[var(--text-primary)]">
                    {targetBranch.trim()}
                  </code>{" "}
                  保存
                </div>
              )}
            </div>
          </div>
        )}

        {targetBranchError ? (
          <p className="text-[11px] text-rose-600 dark:text-rose-400 leading-snug">
            {targetBranchError}
          </p>
        ) : fetchError && fetchedRepo === normalizedRepo ? (
          <p className="text-[11px] text-[var(--text-muted)] leading-snug">
            未能拉取远程分支（可直接手填）：{fetchError}
          </p>
        ) : (
          <p className="text-[11px] text-[var(--text-muted)] leading-snug">
            {targetHint}
          </p>
        )}
      </div>

      {/* Working Branch Prefix */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-[var(--text-primary)] inline-flex items-center gap-1.5">
            <Icon name="git-pull-request" size={12.5} className="text-[var(--text-muted)]" />
            工作分支前缀
          </span>
          <span
            className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)] truncate max-w-[60%]"
            title={`预览工作分支名：${previewBranchName}`}
          >
            {previewBranchName}
          </span>
        </div>

        <input
          type="text"
          maxLength={64}
          value={branchPrefix}
          onChange={(e) => onBranchPrefixChange(e.target.value)}
          placeholder={DEFAULT_BRANCH_PREFIX}
          className={`w-full h-9 px-3 rounded-lg border bg-[var(--surface-elevated)] font-mono text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 ${
            branchPrefixError
              ? "border-rose-500/70 focus:border-rose-500 focus:ring-rose-500/15"
              : "border-[var(--border-subtle)] focus:border-indigo-500 focus:ring-indigo-500/15"
          }`}
        />

        {branchPrefixError ? (
          <p className="text-[11px] text-rose-600 dark:text-rose-400 leading-snug">
            {branchPrefixError}
          </p>
        ) : (
          <p className="text-[11px] text-[var(--text-muted)] leading-snug">
            PR / 验收模式自动创建{" "}
            <code className="font-mono text-[var(--text-secondary)]">{previewBranchName}</code>{" "}
            格式的工作分支，留空默认 <code className="font-mono">{DEFAULT_BRANCH_PREFIX}</code>。
          </p>
        )}
      </div>
    </div>
  );
}
