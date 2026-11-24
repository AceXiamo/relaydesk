import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Icon } from "~/components/Icon.tsx";
import { MarkdownContent } from "~/components/MarkdownContent.tsx";
import {
  PortalFeedbackConversation,
  type PortalUploadedImage,
} from "~/components/PortalFeedbackConversation.tsx";
import {
  Button,
  CopyButton,
  LivePulseDot,
  Switch,
  ToastProvider,
  cn,
  useToast,
} from "~/components/ui.tsx";
import { formatDateTime, formatRelativeTime } from "~/lib/format.ts";
import { createPortalApi, PortalApiError } from "~/lib/portal-api.ts";
import type {
  DeployGateEvaluation,
  FeedbackReleasePreference,
  PortalAccessErrorCode,
  PortalConfig,
  PortalTask,
  PortalTaskDetail,
} from "~/lib/portal-types.ts";

export function meta() {
  return [{ title: "反馈面板 · Relaydesk" }];
}

type PortalTab = "submit" | "mine" | "team";
type SubmitMode = "agent" | "manual";
type TaskFilter = "all" | "action" | "active" | "deployed";

type PendingImage = PortalUploadedImage;

const FEEDBACK_TYPES = [
  { id: "功能异常", label: "功能异常", icon: "alert-circle", tone: "rose" },
  { id: "改进建议", label: "改进建议", icon: "sparkles", tone: "amber" },
  { id: "使用疑问", label: "使用疑问", icon: "book-open", tone: "sky" },
] as const;

const ACCESS_ERROR_COPY: Record<
  PortalAccessErrorCode | "unknown",
  { title: string; fallback: string; icon: string; tone: "rose" | "amber" | "indigo" }
> = {
  invalid_link: {
    title: "分享链接无效",
    fallback: "此反馈面板分享链接无效或格式有误，请向项目管理员索取最新链接。",
    icon: "unlink",
    tone: "rose",
  },
  expired_link: {
    title: "分享链接已过期",
    fallback: "此分享链接已超出有效期，请联系项目管理员续期或重新签发。",
    icon: "clock",
    tone: "amber",
  },
  revoked_link: {
    title: "分享链接已停用",
    fallback: "管理员已停用此分享链接，该链接下的访问权限均已失效。",
    icon: "ban",
    tone: "rose",
  },
  removed_device: {
    title: "此设备授权已被移除",
    fallback: "管理员已移除当前浏览器的访问授权，如需继续使用请向管理员重新申请。",
    icon: "shield-alert",
    tone: "rose",
  },
  device_limit: {
    title: "链接设备名额已满",
    fallback: "此分享链接已达到允许绑定的最大设备数上限，请联系管理员移除闲置设备或提高上限。",
    icon: "monitor",
    tone: "amber",
  },
  missing_session: {
    title: "需要通过分享链接进入",
    fallback: "请使用项目管理员提供的完整鉴权分享链接打开此页面；首次打开后将自动完成本机授权。",
    icon: "key-round",
    tone: "indigo",
  },
  unknown: {
    title: "暂时无法访问反馈面板",
    fallback: "当前访问凭证无效或已失效，请重新打开管理员提供的分享链接。",
    icon: "shield-alert",
    tone: "rose",
  },
};

const LIFECYCLE_STEPS = [
  { key: "submitted", label: "已提交" },
  { key: "working", label: "排查修复" },
  { key: "pending_deploy", label: "等待发布" },
  { key: "deployed", label: "已上线" },
  { key: "accepted", label: "已确认" },
] as const;

interface StatusVisual {
  stepIndex: number; // 0..4
  badgeClass: string;
  dotTone: "emerald" | "amber" | "indigo" | "rose" | "zinc";
  pulse: boolean;
  specialNote?: string;
}

function resolveStatusVisual(label: string): StatusVisual {
  if (label === "已确认解决") {
    return {
      stepIndex: 4,
      badgeClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
      dotTone: "emerald",
      pulse: false,
    };
  }
  if (label === "已上线") {
    return {
      stepIndex: 3,
      badgeClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
      dotTone: "emerald",
      pulse: true,
    };
  }
  if (label === "正在发布上线") {
    return {
      stepIndex: 2,
      badgeClass: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/25",
      dotTone: "indigo",
      pulse: true,
    };
  }
  if (label === "已修复，等待发布") {
    return {
      stepIndex: 2,
      badgeClass: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/25",
      dotTone: "indigo",
      pulse: false,
    };
  }
  if (label === "发布暂缓") {
    return {
      stepIndex: 2,
      badgeClass: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25",
      dotTone: "amber",
      pulse: false,
      specialNote: "发布暂时顺延，团队会跟进处理",
    };
  }
  if (label === "等待补充信息") {
    return {
      stepIndex: 1,
      badgeClass: "bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/30",
      dotTone: "amber",
      pulse: true,
      specialNote: "需要你补充信息后继续推进",
    };
  }
  if (label === "排查与修复中" || label === "内部复核中") {
    return {
      stepIndex: 1,
      badgeClass: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/25",
      dotTone: "indigo",
      pulse: true,
    };
  }
  if (label === "已完成处理") {
    return {
      stepIndex: 4,
      badgeClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
      dotTone: "emerald",
      pulse: false,
    };
  }
  if (label === "已关联处理" || label === "已结束处理") {
    return {
      stepIndex: 4,
      badgeClass: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 border-zinc-500/25",
      dotTone: "zinc",
      pulse: false,
    };
  }
  return {
    stepIndex: 0,
    badgeClass: "bg-[var(--surface-subtle)] text-[var(--text-secondary)] border-[var(--border-subtle)]",
    dotTone: "zinc",
    pulse: false,
  };
}

function makeUid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function useThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = useCallback(() => {
    setDark((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("dark", next);
      try {
        localStorage.setItem("relaydesk.theme", next ? "dark" : "light");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return { dark, toggle };
}

function PortalAccessBlockedView({
  code,
  message,
  onRetry,
  retrying,
}: {
  code: string;
  message?: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  const meta =
    ACCESS_ERROR_COPY[code as PortalAccessErrorCode] ?? ACCESS_ERROR_COPY.unknown;
  const toneClasses =
    meta.tone === "amber"
      ? "bg-amber-500/12 text-amber-600 dark:text-amber-400 border-amber-500/25"
      : meta.tone === "indigo"
        ? "bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 border-indigo-500/25"
        : "bg-rose-500/12 text-rose-600 dark:text-rose-400 border-rose-500/25";

  return (
    <main className="min-h-dvh flex flex-col items-center justify-center p-5 bg-[var(--surface-canvas)] text-[var(--text-primary)]">
      <div className="w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 sm:p-7 shadow-[var(--rd-shadow-md)] rd-hairline-glow space-y-5 animate-rd-portal-in">
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2 text-xs font-mono text-[var(--text-muted)]">
            <span className="w-2 h-2 rounded-full bg-indigo-500/70" />
            <span>RELAYDESK PORTAL</span>
          </div>
          <span className="px-2 py-0.5 rounded-full text-[11px] font-mono border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-muted)]">
            {code || "unauthorized"}
          </span>
        </div>

        <div className="flex items-start gap-3.5">
          <div
            className={cn(
              "w-11 h-11 rounded-xl border flex items-center justify-center shrink-0",
              toneClasses,
            )}
          >
            <Icon name={meta.icon} size={20} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-[17px] font-semibold tracking-tight text-[var(--text-primary)]">
              {meta.title}
            </h1>
            <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
              {message || meta.fallback}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/70 px-3.5 py-2.5 text-[12px] leading-relaxed text-[var(--text-muted)] space-y-1">
          <p className="font-medium text-[var(--text-secondary)]">如何恢复访问？</p>
          <p>
            请向项目管理员获取新的专属分享链接并直接打开；若仅是刚刚在另一标签页完成了授权，可点击下方按钮重新检测会话。
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon="refresh-cw"
            loading={retrying}
            onClick={onRetry}
          >
            重新检测会话
          </Button>
        </div>
      </div>
    </main>
  );
}

function PortalDeployGateCard({
  gate,
  canRequestDeploy,
  releaseWindow,
  onRequestDeploy,
  requesting,
}: {
  gate: DeployGateEvaluation | null;
  canRequestDeploy: boolean;
  releaseWindow: string;
  onRequestDeploy: (reason: string) => Promise<void>;
  requesting: boolean;
}) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (!gate && !canRequestDeploy) return null;

  const isEvaluating = gate?.status === "evaluating";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onRequestDeploy(reason.trim());
    setReason("");
    setComposerOpen(false);
  };

  return (
    <div className="space-y-2.5">
      {gate && (
        <div
          className={cn(
            "relative overflow-hidden rounded-xl border p-3.5 space-y-1.5 animate-rd-portal-in",
            gate.status === "evaluating"
              ? "border-indigo-500/30 bg-indigo-500/[0.06]"
              : gate.status === "approved"
                ? "border-emerald-500/30 bg-emerald-500/[0.06]"
                : gate.status === "deferred"
                  ? "border-amber-500/30 bg-amber-500/[0.06]"
                  : gate.status === "escalated"
                    ? "border-violet-500/30 bg-violet-500/[0.06]"
                    : "border-[var(--border-subtle)] bg-[var(--surface-subtle)]",
          )}
        >
          {isEvaluating && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-indigo-500/15"
            >
              <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-indigo-500 to-transparent animate-rd-gate-scan" />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {isEvaluating ? (
                <Icon
                  name="loader-2"
                  size={14}
                  className="animate-spin text-indigo-600 dark:text-indigo-400"
                />
              ) : gate.status === "approved" ? (
                <Icon
                  name="shield-check"
                  size={14}
                  className="text-emerald-600 dark:text-emerald-400"
                />
              ) : gate.status === "deferred" ? (
                <Icon
                  name="clock"
                  size={14}
                  className="text-amber-600 dark:text-amber-400"
                />
              ) : gate.status === "escalated" ? (
                <Icon
                  name="shield-alert"
                  size={14}
                  className="text-violet-600 dark:text-violet-400"
                />
              ) : (
                <Icon
                  name="alert-circle"
                  size={14}
                  className="text-[var(--text-muted)]"
                />
              )}
              <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
                {gate.status === "evaluating"
                  ? "AI 正在只读评估是否可立即发布…"
                  : gate.status === "approved"
                    ? "AI 评估通过 · 已放行即时发布"
                    : gate.status === "deferred"
                      ? "AI 评估暂缓立即发布"
                      : gate.status === "escalated"
                        ? "已转交项目管理员确认发布"
                        : "即时发布评估未完成"}
              </span>
            </div>
            <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
              {formatRelativeTime(gate.finished_at || gate.created_at)}
            </span>
          </div>

          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
            {gate.public_reason ||
              (gate.status === "evaluating"
                ? "正在核查线上当前活跃使用情况与变更风险面，结果将自动刷新。"
                : gate.status === "approved"
                  ? "当前变更风险可控且不影响线上正常使用，系统已触发发布流水线。"
                  : gate.status === "deferred"
                    ? `为避免影响当前在线用户，已保持排入默认发布窗口${releaseWindow ? `（${releaseWindow}）` : ""}。`
                    : gate.status === "escalated"
                      ? "本次变更需要项目管理员人工复核确认，确认后将立即上线。"
                      : "本次评估未能完成，工单将按默认计划发布。")}
          </p>
        </div>
      )}

      {canRequestDeploy && !isEvaluating && (
        <div className="rounded-xl border border-indigo-500/25 bg-[var(--surface-elevated)] p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)]">
                <Icon
                  name="zap"
                  size={13.5}
                  className="text-indigo-600 dark:text-indigo-400 shrink-0"
                />
                <span>修复已就绪，急需立即上线？</span>
              </div>
              <p className="text-[11.5px] text-[var(--text-muted)]">
                {releaseWindow
                  ? `默认将在发布窗口（${releaseWindow}）上线；你可申请 AI 评估线上空闲状态后提前发布。`
                  : "可申请 AI 只读评估线上使用状态与风险，满足安全条件时将立即触发发布。"}
              </p>
            </div>
            {!composerOpen && (
              <Button
                type="button"
                variant="primary"
                size="xs"
                icon="sparkles"
                onClick={() => setComposerOpen(true)}
              >
                申请即时发布
              </Button>
            )}
          </div>

          {composerOpen && (
            <form
              onSubmit={(e) => void handleSubmit(e)}
              className="space-y-2 pt-2 border-t border-[var(--border-subtle)] animate-rd-portal-in"
            >
              <input
                type="text"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="可选：简述急需立即上线的原因（例如：客户演示在即 / 影响核心下单流程）"
                className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500"
              />
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={requesting}
                  onClick={() => setComposerOpen(false)}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="xs"
                  icon="sparkles"
                  loading={requesting}
                >
                  提交 AI 评估申请
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function PortalContent() {
  const { projectId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const { dark, toggle: toggleTheme } = useThemeToggle();
  const portalApi = useMemo(() => createPortalApi(projectId), [projectId]);

  const queryErrorCode = searchParams.get("error");
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [accessError, setAccessError] = useState<{ code: string; message?: string } | null>(
    queryErrorCode ? { code: queryErrorCode } : null,
  );

  // Navigation
  const [tab, setTab] = useState<PortalTab>("submit");
  const [submitMode, setSubmitMode] = useState<SubmitMode>("agent");

  // Submit form state
  const [feedbackType, setFeedbackType] = useState<string>("功能异常");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [releasePref, setReleasePref] = useState<FeedbackReleasePreference>("default");
  const [images, setImages] = useState<PendingImage[]>([]);
  const imagesRef = useRef<PendingImage[]>(images);
  imagesRef.current = images;
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedDetail, setSubmittedDetail] = useState<PortalTaskDetail | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Lists & detail state
  const [mineTasks, setMineTasks] = useState<PortalTask[]>([]);
  const [teamTasks, setTeamTasks] = useState<PortalTask[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectedTaskIdRef = useRef<string | null>(selectedTaskId);
  const detailReqSeqRef = useRef(0);
  const [detail, setDetail] = useState<PortalTaskDetail | null>(null);
  const detailRef = useRef<PortalTaskDetail | null>(detail);
  detailRef.current = detail;
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Detail interactive states
  const [replyText, setReplyText] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [acceptMode, setAcceptMode] = useState<"idle" | "broken">("idle");
  const [brokenNote, setBrokenNote] = useState("");
  const [submittingAccept, setSubmittingAccept] = useState(false);
  const [requestingDeploy, setRequestingDeploy] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const handlePossibleAuthError = useCallback((err: unknown): boolean => {
    if (err instanceof PortalApiError && err.status === 401) {
      detailReqSeqRef.current += 1;
      selectedTaskIdRef.current = null;
      setConfig(null);
      setMineTasks([]);
      setTeamTasks([]);
      setSelectedTaskId(null);
      setDetail(null);
      setAccessError({ code: err.code || "missing_session", message: err.message });
      return true;
    }
    return false;
  }, []);

  const handleTeamPermissionDowngrade = useCallback(
    (notify = false) => {
      setTeamTasks([]);
      setConfig((prev) =>
        prev && prev.can_view_team ? { ...prev, can_view_team: false } : prev,
      );
      setTab((prev) => (prev === "team" ? "mine" : prev));
      if (detailRef.current && !detailRef.current.task.owned) {
        detailReqSeqRef.current += 1;
        selectedTaskIdRef.current = null;
        setSelectedTaskId(null);
        setDetail(null);
      }
      if (notify) {
        toast.info("管理员已关闭「团队动态」查看权限，已切换回「我的反馈」");
      }
    },
    [toast],
  );

  const loadConfig = useCallback(
    async (silent = false) => {
      if (!projectId) {
        setAccessError({ code: "invalid_link" });
        setLoadingConfig(false);
        return;
      }
      if (!silent) setLoadingConfig(true);
      try {
        const cfg = await portalApi.getConfig();
        setConfig((prev) => {
          if (
            prev &&
            prev.project_name === cfg.project_name &&
            prev.label === cfg.label &&
            prev.can_view_team === cfg.can_view_team &&
            prev.can_request_deploy === cfg.can_request_deploy &&
            prev.upload_enabled === cfg.upload_enabled &&
            prev.ai_enabled === cfg.ai_enabled &&
            prev.agent_enabled === cfg.agent_enabled &&
            prev.release_window === cfg.release_window
          ) {
            return prev;
          }
          return cfg;
        });
        setAccessError(null);
        if (!cfg.can_view_team) {
          setTeamTasks([]);
          setTab((prev) => (prev === "team" ? "mine" : prev));
          if (detailRef.current && !detailRef.current.task.owned) {
            detailReqSeqRef.current += 1;
            selectedTaskIdRef.current = null;
            setSelectedTaskId(null);
            setDetail(null);
          }
        }
        if (!silent && searchParams.has("error")) {
          const next = new URLSearchParams(searchParams);
          next.delete("error");
          setSearchParams(next, { replace: true });
        }
      } catch (err) {
        if (handlePossibleAuthError(err)) return;
        if (!silent) {
          if (err instanceof PortalApiError) {
            setAccessError({
              code: err.code || "unknown",
              message: err.message,
            });
          } else {
            setAccessError({ code: "unknown", message: "无法连接到服务器，请稍后重试。" });
          }
        }
      } finally {
        if (!silent) setLoadingConfig(false);
      }
    },
    [portalApi, projectId, searchParams, setSearchParams, handlePossibleAuthError],
  );

  const loadTasks = useCallback(
    async (scope: "mine" | "team", silent = false) => {
      if (!silent) setLoadingList(true);
      try {
        const res = await portalApi.listTasks(scope);
        if (scope === "mine") setMineTasks(res.tasks ?? []);
        else setTeamTasks(res.tasks ?? []);
      } catch (err) {
        if (handlePossibleAuthError(err)) return;
        if (scope === "team" && err instanceof PortalApiError && err.status === 403) {
          handleTeamPermissionDowngrade(!silent);
          return;
        }
        if (!silent) {
          toast.error(err instanceof Error ? err.message : "加载反馈列表失败");
        }
      } finally {
        if (!silent) setLoadingList(false);
      }
    },
    [portalApi, handlePossibleAuthError, handleTeamPermissionDowngrade, toast],
  );

  const loadTaskDetail = useCallback(
    async (taskId: string, silent = false) => {
      const reqSeq = ++detailReqSeqRef.current;
      if (!silent) setLoadingDetail(true);
      try {
        const data = await portalApi.getTask(taskId);
        // Ignore stale or late responses if user switched to another task or closed detail
        if (reqSeq !== detailReqSeqRef.current || selectedTaskIdRef.current !== taskId) {
          return;
        }
        setDetail(data);
        setMineTasks((prev) =>
          prev.map((t) => (t.id === data.task.id ? data.task : t)),
        );
        setTeamTasks((prev) =>
          prev.map((t) => (t.id === data.task.id ? data.task : t)),
        );
      } catch (err) {
        if (handlePossibleAuthError(err)) return;
        if (reqSeq !== detailReqSeqRef.current || selectedTaskIdRef.current !== taskId) {
          return;
        }
        if (err instanceof PortalApiError && err.status === 403) {
          handleTeamPermissionDowngrade(!silent);
          detailReqSeqRef.current += 1;
          selectedTaskIdRef.current = null;
          setSelectedTaskId(null);
          setDetail(null);
          return;
        }
        if (!silent) {
          toast.error(err instanceof Error ? err.message : "加载工单详情失败");
        }
      } finally {
        if (!silent && reqSeq === detailReqSeqRef.current) {
          setLoadingDetail(false);
        }
      }
    },
    [portalApi, handlePossibleAuthError, handleTeamPermissionDowngrade, toast],
  );

  const hasConfig = Boolean(config && !accessError);
  const canViewTeam = Boolean(config?.can_view_team);

  useEffect(() => {
    if (queryErrorCode) {
      setAccessError({ code: queryErrorCode });
      setLoadingConfig(false);
      return;
    }
    void loadConfig(false);
  }, [projectId, queryErrorCode, loadConfig]);

  useEffect(() => {
    if (!hasConfig) return;
    void loadTasks("mine", true);
    if (canViewTeam) {
      void loadTasks("team", true);
    } else {
      setTeamTasks([]);
      setTab((prev) => (prev === "team" ? "mine" : prev));
    }
  }, [hasConfig, canViewTeam, loadTasks]);

  useEffect(() => {
    if (!hasConfig) return;
    if (tab === "mine") void loadTasks("mine", false);
    if (tab === "team") {
      if (canViewTeam) void loadTasks("team", false);
      else setTab("mine");
    }
  }, [tab, hasConfig, canViewTeam, loadTasks]);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
    detailReqSeqRef.current += 1;
    if (!selectedTaskId) {
      setDetail(null);
      setLoadingDetail(false);
      return;
    }
    setAcceptMode("idle");
    setBrokenNote("");
    setReplyText("");
    void loadTaskDetail(selectedTaskId, false);
  }, [selectedTaskId, loadTaskDetail]);

  // Periodic background refresh while staying on list views (and sync config permission changes)
  useEffect(() => {
    if (!hasConfig || tab === "submit") return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void loadConfig(true);
      const scope = tab === "team" && canViewTeam ? "team" : "mine";
      void loadTasks(scope, true);
    }, 20000);
    return () => window.clearInterval(timer);
  }, [hasConfig, tab, canViewTeam, loadConfig, loadTasks]);

  // Fast poll while AI Deploy Gate is evaluating, gentle poll otherwise on open detail
  const isGateEvaluating = detail?.gate?.status === "evaluating";
  useEffect(() => {
    if (!selectedTaskId || !hasConfig) return;
    const interval = isGateEvaluating ? 3500 : 20000;
    const timer = window.setInterval(() => {
      if (!document.hidden && selectedTaskIdRef.current === selectedTaskId) {
        void loadTaskDetail(selectedTaskId, true);
      }
    }, interval);
    return () => window.clearInterval(timer);
  }, [selectedTaskId, isGateEvaluating, hasConfig, loadTaskDetail]);

  // Keyboard Escape for lightbox
  useEffect(() => {
    if (!lightboxSrc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxSrc(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxSrc]);

  const uploadFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      if (!config?.upload_enabled) {
        toast.info("当前站点尚未配置图片存储，请用文字描述问题");
        return;
      }
      const MAX_IMAGES = 6;
      const remainingSlots = Math.max(0, MAX_IMAGES - imagesRef.current.length);
      if (remainingSlots <= 0) {
        toast.info("单次最多上传 6 张截图");
        return;
      }
      const sizeValidFiles: File[] = [];
      for (const file of files) {
        if (file.size > 5 * 1024 * 1024) {
          toast.error("单张图片大小不能超过 5 MB");
          continue;
        }
        sizeValidFiles.push(file);
      }
      if (sizeValidFiles.length === 0) return;
      if (sizeValidFiles.length > remainingSlots) {
        toast.info(`单次最多上传 6 张截图，已选取前 ${remainingSlots} 张`);
      }
      const batch = sizeValidFiles.slice(0, remainingSlots);
      const placeholders = batch.map((file) => ({
        file,
        entry: {
          id: makeUid(),
          previewUrl: URL.createObjectURL(file),
          remoteUrl: "",
          uploading: true,
        },
      }));
      const nextEntries = placeholders.map((p) => p.entry);
      imagesRef.current = [...imagesRef.current, ...nextEntries];
      setImages((prev) => [...prev, ...nextEntries]);

      for (const { file, entry } of placeholders) {
        try {
          const { url } = await portalApi.uploadImage(file);
          setImages((prev) =>
            prev.map((img) =>
              img.id === entry.id ? { ...img, remoteUrl: url, uploading: false } : img,
            ),
          );
        } catch (err) {
          URL.revokeObjectURL(entry.previewUrl);
          setImages((prev) => prev.filter((img) => img.id !== entry.id));
          if (!handlePossibleAuthError(err)) {
            toast.error(err instanceof Error ? err.message : "图片上传失败");
          }
        }
      }
    },
    [config?.upload_enabled, portalApi, handlePossibleAuthError, toast],
  );

  const removeImage = (id: string) => {
    setImages((prev) => {
      const found = prev.find((i) => i.id === id);
      if (found && found.previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(found.previewUrl);
      }
      return prev.filter((i) => i.id !== id);
    });
  };

  const clearStagedImages = useCallback(() => {
    setImages((prev) => {
      for (const img of prev) {
        if (img.previewUrl.startsWith("blob:")) {
          URL.revokeObjectURL(img.previewUrl);
        }
      }
      return [];
    });
  }, []);

  const handleCreateFromConversation = useCallback(
    async (payload: {
      title: string;
      body: string;
      type: string;
      images: string[];
      release_preference: FeedbackReleasePreference;
    }) => {
      const created = await portalApi.createTask({
        title: payload.title,
        body: payload.body,
        type: payload.type,
        images: payload.images,
        release_preference: payload.release_preference,
        external_id: makeUid(),
      });
      setSubmittedDetail(created);
      setMineTasks((prev) => [
        created.task,
        ...prev.filter((t) => t.id !== created.task.id),
      ]);
      toast.success(`反馈 ${created.task.code} 已确认提交`);
      return created;
    },
    [portalApi, toast],
  );

  const handleSwitchToManual = useCallback(
    (prefill: { body: string; extraImageUrls: string[] }) => {
      if (prefill.body.trim()) {
        setBody((prev) => (prev.trim() ? prev : prefill.body.trim()));
      }
      if (prefill.extraImageUrls.length > 0) {
        setImages((prev) => {
          const existing = new Set(prev.map((i) => i.remoteUrl).filter(Boolean));
          const additions: PendingImage[] = [];
          for (const url of prefill.extraImageUrls) {
            if (!url || existing.has(url)) continue;
            existing.add(url);
            additions.push({
              id: makeUid(),
              previewUrl: url,
              remoteUrl: url,
              uploading: false,
            });
          }
          return [...prev, ...additions].slice(0, 6);
        });
      }
      setSubmitMode("manual");
    },
    [],
  );

  const handleSubmitFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      toast.error("请填写详细的反馈描述");
      return;
    }
    if (images.some((i) => i.uploading)) {
      toast.info("请等待图片上传完成");
      return;
    }
    setSubmitting(true);
    try {
      const created = await portalApi.createTask({
        title: title.trim() || undefined,
        body: trimmedBody,
        type: feedbackType,
        images: images.map((i) => i.remoteUrl).filter(Boolean),
        release_preference: config?.can_request_deploy ? releasePref : "default",
        external_id: makeUid(),
      });
      setSubmittedDetail(created);
      setTitle("");
      setBody("");
      setReleasePref("default");
      for (const img of images) {
        if (img.previewUrl.startsWith("blob:")) URL.revokeObjectURL(img.previewUrl);
      }
      setImages([]);
      setMineTasks((prev) => [
        created.task,
        ...prev.filter((t) => t.id !== created.task.id),
      ]);
      toast.success(`反馈 ${created.task.code} 已提交成功`);
    } catch (err) {
      if (!handlePossibleAuthError(err)) {
        toast.error(err instanceof Error ? err.message : "提交反馈失败，请重试");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleReplySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail || !replyText.trim()) return;
    const targetTaskId = detail.task.id;
    setSendingReply(true);
    try {
      const updated = await portalApi.replyTask(targetTaskId, replyText.trim());
      if (selectedTaskIdRef.current === targetTaskId) {
        setDetail((prev) => ({
          ...updated,
          gate: updated.gate ?? prev?.gate ?? null,
        }));
        setReplyText("");
      }
      setMineTasks((prev) =>
        prev.map((t) => (t.id === updated.task.id ? updated.task : t)),
      );
      setTeamTasks((prev) =>
        prev.map((t) => (t.id === updated.task.id ? updated.task : t)),
      );
      toast.success("已发送补充说明，工单已恢复处理");
    } catch (err) {
      if (!handlePossibleAuthError(err)) {
        toast.error(err instanceof Error ? err.message : "发送回复失败");
      }
    } finally {
      setSendingReply(false);
    }
  };

  const handleAccept = async (resolved: boolean) => {
    if (!detail) return;
    const targetTaskId = detail.task.id;
    setSubmittingAccept(true);
    try {
      const updated = await portalApi.acceptTask(
        targetTaskId,
        resolved,
        resolved ? undefined : brokenNote.trim() || undefined,
      );
      if (selectedTaskIdRef.current === targetTaskId) {
        setDetail((prev) => ({
          ...updated,
          gate: updated.gate ?? prev?.gate ?? null,
        }));
        setAcceptMode("idle");
        setBrokenNote("");
      }
      setMineTasks((prev) =>
        prev.map((t) => (t.id === updated.task.id ? updated.task : t)),
      );
      setTeamTasks((prev) =>
        prev.map((t) => (t.id === updated.task.id ? updated.task : t)),
      );
      toast.success(
        resolved ? "感谢确认，该反馈已标记为已解决" : "已收到你的反馈，工单已重新进入处理队列",
      );
    } catch (err) {
      if (!handlePossibleAuthError(err)) {
        toast.error(err instanceof Error ? err.message : "提交验收结果失败");
      }
    } finally {
      setSubmittingAccept(false);
    }
  };

  const handleRequestDeploy = async (reason: string) => {
    if (!detail) return;
    const targetTaskId = detail.task.id;
    setRequestingDeploy(true);
    try {
      const { gate } = await portalApi.requestDeploy(targetTaskId, reason || undefined);
      if (selectedTaskIdRef.current === targetTaskId) {
        setDetail((prev) => (prev ? { ...prev, gate } : prev));
      }
      toast.success("已发起 AI 门禁评估，结果将实时更新");
    } catch (err) {
      if (!handlePossibleAuthError(err)) {
        toast.error(err instanceof Error ? err.message : "申请即时发布失败");
      }
    } finally {
      setRequestingDeploy(false);
    }
  };

  const navTabs = useMemo<Array<{ id: PortalTab; label: string; icon: string; badge?: number; alert?: boolean }>>(() => {
    const actionCount = mineTasks.filter((t) => t.can_reply || t.can_accept).length;
    const base: Array<{ id: PortalTab; label: string; icon: string; badge?: number; alert?: boolean }> = [
      { id: "submit", label: "提交反馈", icon: "pen-line" },
      {
        id: "mine",
        label: "我的反馈",
        icon: "inbox",
        badge: mineTasks.length || undefined,
        alert: actionCount > 0,
      },
    ];
    if (config?.can_view_team) {
      base.push({
        id: "team",
        label: "团队动态",
        icon: "layers",
        badge: teamTasks.length || undefined,
      });
    }
    return base;
  }, [config?.can_view_team, mineTasks, teamTasks]);

  const activeTabIndex = Math.max(
    0,
    navTabs.findIndex((t) => t.id === tab),
  );

  const currentList = tab === "team" ? teamTasks : mineTasks;
  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return currentList.filter((t) => {
      if (taskFilter === "action" && !(t.can_reply || t.can_accept || t.can_request_deploy)) {
        return false;
      }
      if (
        taskFilter === "active" &&
        (t.status_label === "已上线" ||
          t.status_label === "已确认解决" ||
          t.status_label === "已完成处理" ||
          t.status_label === "已结束处理")
      ) {
        return false;
      }
      if (
        taskFilter === "deployed" &&
        t.status_label !== "已上线" &&
        t.status_label !== "已确认解决"
      ) {
        return false;
      }
      if (q && !t.title.toLowerCase().includes(q) && !t.code.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [currentList, taskFilter, searchQuery]);

  if (loadingConfig) {
    return (
      <main className="min-h-dvh flex items-center justify-center bg-[var(--surface-canvas)] text-[var(--text-muted)]">
        <div className="flex flex-col items-center gap-3 animate-rd-portal-in">
          <div className="w-10 h-10 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] flex items-center justify-center shadow-xs">
            <Icon name="loader-2" size={18} className="animate-spin text-indigo-500" />
          </div>
          <p className="text-xs font-medium">正在校验访问授权…</p>
        </div>
      </main>
    );
  }

  if (accessError || !config) {
    return (
      <PortalAccessBlockedView
        code={accessError?.code || "missing_session"}
        message={accessError?.message}
        onRetry={() => void loadConfig()}
        retrying={loadingConfig}
      />
    );
  }

  return (
    <div className="min-h-dvh flex flex-col bg-[var(--surface-canvas)] text-[var(--text-primary)]">
      {/* Sticky Minimal Header */}
      <header className="sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[var(--surface-card)]/85 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center shadow-xs shrink-0">
              <Icon name="message-square" size={15} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-[14.5px] font-semibold tracking-tight text-[var(--text-primary)] truncate">
                  {config.project_name}
                </h1>
                <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded-md text-[10.5px] font-medium bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[var(--text-muted)]">
                  反馈面板
                </span>
              </div>
              {config.release_window && (
                <p className="hidden md:flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                  <Icon name="calendar-clock" size={11} />
                  <span>默认发布窗口：{config.release_window}</span>
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div
              title={`当前授权身份：${config.label}`}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[12px] font-medium text-[var(--text-primary)] max-w-[180px]"
            >
              <LivePulseDot tone="emerald" active />
              <span className="truncate">{config.label}</span>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={dark ? "切换浅色主题" : "切换深色主题"}
              className="w-8 h-8 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center justify-center transition-colors cursor-pointer"
            >
              <Icon name={dark ? "sun" : "moon"} size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-7 space-y-5">
        {/* DesignBookmark-inspired Sliding Segmented Tab Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="反馈面板导航"
            className="relative inline-grid p-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/90 shadow-2xs"
            style={{
              gridTemplateColumns: `repeat(${navTabs.length}, minmax(108px, 1fr))`,
            }}
          >
            {/* Spring Sliding Pill */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-1 bottom-1 left-1 rounded-lg bg-[var(--surface-card)] border border-[var(--border-subtle)] shadow-xs transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{
                width: `calc((100% - 8px) / ${navTabs.length})`,
                transform: `translateX(${activeTabIndex * 100}%)`,
              }}
            />
            {navTabs.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setTab(item.id);
                    if (item.id === "submit") setSelectedTaskId(null);
                  }}
                  className={cn(
                    "relative z-10 inline-flex items-center justify-center gap-1.5 h-8.5 px-3 rounded-lg text-[12.5px] font-medium transition-colors cursor-pointer select-none",
                    active
                      ? "text-[var(--text-primary)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
                  )}
                >
                  <Icon
                    name={item.icon}
                    size={13.5}
                    className={active ? "text-indigo-600 dark:text-indigo-400" : undefined}
                  />
                  <span>{item.label}</span>
                  {item.badge !== undefined && (
                    <span
                      className={cn(
                        "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-mono tabular-nums",
                        active
                          ? "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300"
                          : "bg-[var(--surface-hover)] text-[var(--text-muted)]",
                      )}
                    >
                      {item.badge}
                    </span>
                  )}
                  {item.alert && (
                    <span
                      aria-label="有待处理工单"
                      className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                    />
                  )}
                </button>
              );
            })}
          </div>

          {tab !== "submit" && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              icon="refresh-cw"
              onClick={() => {
                void loadTasks(tab === "team" ? "team" : "mine", false);
                if (selectedTaskId) void loadTaskDetail(selectedTaskId, true);
              }}
            >
              刷新进度
            </Button>
          )}
        </div>

        {/* TAB 1: SUBMIT FEEDBACK */}
        {tab === "submit" && (
          <div className="max-w-2xl mx-auto space-y-5 animate-rd-portal-in">
            {submittedDetail ? (
              <section className="rounded-2xl border border-emerald-500/30 bg-[var(--surface-card)] p-6 sm:p-7 shadow-[var(--rd-shadow-md)] rd-hairline-glow space-y-5 animate-rd-portal-in">
                <div className="flex items-start gap-3.5">
                  <div className="w-11 h-11 rounded-xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center justify-center shrink-0 animate-rd-step-pop">
                    <Icon name="check-circle-2" size={22} />
                  </div>
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">
                        反馈已提交并进入处理队列
                      </h2>
                      <CopyButton
                        value={submittedDetail.task.code}
                        label={submittedDetail.task.code}
                        copiedLabel="已复制编号"
                        size="xs"
                        variant="secondary"
                      />
                    </div>
                    <p className="text-[13px] text-[var(--text-secondary)]">
                      {submittedDetail.task.title}
                    </p>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      你可以随时在「我的反馈」中追踪排查修复、发布上线状态，回复团队追问或在线确认验收。
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    icon="plus"
                    onClick={() => {
                      setSubmittedDetail(null);
                      if (config.agent_enabled) setSubmitMode("agent");
                    }}
                  >
                    继续提交新反馈
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    icon="arrow-right"
                    onClick={() => {
                      const targetId = submittedDetail.task.id;
                      setSubmittedDetail(null);
                      setTab("mine");
                      setSelectedTaskId(targetId);
                    }}
                  >
                    查看工单进度
                  </Button>
                </div>
              </section>
            ) : config.agent_enabled === true && submitMode === "agent" ? (
              <PortalFeedbackConversation
                config={config}
                stagedImages={images}
                onUploadFiles={uploadFiles}
                onRemoveStagedImage={removeImage}
                onClearStagedImages={clearStagedImages}
                onOpenLightbox={(src) => setLightboxSrc(src)}
                onDiagnose={portalApi.diagnose}
                onCreateTask={handleCreateFromConversation}
                onSwitchToManual={handleSwitchToManual}
                onPossibleAuthError={handlePossibleAuthError}
              />
            ) : (
              <form
                data-testid="portal-manual-form"
                onSubmit={(e) => void handleSubmitFeedback(e)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (e.dataTransfer?.files?.length) {
                    void uploadFiles(e.dataTransfer.files);
                  }
                }}
                className={cn(
                  "rounded-2xl border bg-[var(--surface-card)] overflow-hidden shadow-[var(--rd-shadow-sm)] rd-hairline-glow transition-all duration-200",
                  dragOver
                    ? "border-indigo-500 ring-2 ring-indigo-500/20"
                    : "border-[var(--border-subtle)]",
                )}
              >
                <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
                      {config.agent_enabled ? "人工直接提交反馈" : "提交新反馈"}
                    </h2>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      描述遇到的问题或改进想法，支持粘贴或拖拽截图直达研发处理链路。
                    </p>
                  </div>
                  {config.agent_enabled && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      icon="message-square-text"
                      data-testid="portal-switch-agent"
                      onClick={() => setSubmitMode("agent")}
                    >
                      返回对话诊断
                    </Button>
                  )}
                </div>

                <div className="p-5 space-y-5">
                  {/* Type selector pills */}
                  <div className="space-y-2">
                    <span className="block text-[12px] font-medium text-[var(--text-secondary)]">
                      反馈类型
                    </span>
                    <div className="grid grid-cols-3 gap-2">
                      {FEEDBACK_TYPES.map((item) => {
                        const active = feedbackType === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            aria-pressed={active}
                            onClick={() => setFeedbackType(item.id)}
                            className={cn(
                              "flex items-center justify-center gap-1.5 h-9.5 px-3 rounded-xl border text-[12.5px] font-medium transition-all duration-150 cursor-pointer",
                              active
                                ? "border-indigo-500/60 bg-indigo-500/[0.08] text-[var(--text-primary)] ring-1 ring-indigo-500/20 shadow-2xs"
                                : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]",
                            )}
                          >
                            <Icon
                              name={item.icon}
                              size={14}
                              className={
                                active
                                  ? "text-indigo-600 dark:text-indigo-400"
                                  : "text-[var(--text-muted)]"
                              }
                            />
                            <span>{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Title input */}
                  <label className="block space-y-1.5">
                    <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                      简要标题（可选）
                    </span>
                    <input
                      type="text"
                      maxLength={180}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="一句话概括现象或建议，留空将自动从正文首行提取"
                      className="w-full h-10 px-3.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 transition-all"
                    />
                  </label>

                  {/* Body textarea */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                        详细描述 <span className="text-rose-500">*</span>
                      </span>
                      <span className="text-[11px] font-mono text-[var(--text-muted)] tabular-nums">
                        {body.length} / 20000
                      </span>
                    </div>
                    <textarea
                      required
                      rows={5}
                      maxLength={20000}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      onPaste={(e) => {
                        const files = e.clipboardData?.files;
                        if (files && files.length > 0) {
                          const hasImg = Array.from(files).some((f) =>
                            f.type.startsWith("image/"),
                          );
                          if (hasImg) {
                            e.preventDefault();
                            void uploadFiles(files);
                          }
                        }
                      }}
                      placeholder="请描述具体现象、复现步骤或期望效果（支持直接粘贴或拖入截图）…"
                      className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3.5 text-[13.5px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 transition-all resize-y"
                    />

                    {/* Toolbar: Upload + AI Clarify */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <div className="flex items-center gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            if (e.target.files?.length) {
                              void uploadFiles(e.target.files);
                              e.target.value = "";
                            }
                          }}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          icon="image"
                          disabled={!config.upload_enabled || images.length >= 6}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          {config.upload_enabled
                            ? `上传截图 (${images.length}/6)`
                            : "图床未配置"}
                        </Button>
                      </div>
                      <span className="text-[11px] text-[var(--text-muted)]">
                        支持 Ctrl/⌘+V 直接粘贴截图
                      </span>
                    </div>
                  </div>

                  {/* Uploaded image thumbnails */}
                  {images.length > 0 && (
                    <div className="flex flex-wrap gap-2.5">
                      {images.map((img) => (
                        <div
                          key={img.id}
                          className="group relative w-20 h-16 rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface-subtle)] animate-rd-step-pop"
                        >
                          <img
                            src={img.remoteUrl || img.previewUrl}
                            alt="上传截图"
                            onClick={() =>
                              setLightboxSrc(img.remoteUrl || img.previewUrl)
                            }
                            className="w-full h-full object-cover cursor-zoom-in transition-transform duration-150 group-hover:scale-105"
                          />
                          {img.uploading && (
                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center text-white">
                              <Icon name="loader-2" size={16} className="animate-spin" />
                            </div>
                          )}
                          <button
                            type="button"
                            aria-label="移除截图"
                            onClick={() => removeImage(img.id)}
                            className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-black cursor-pointer"
                          >
                            <Icon name="x" size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Optional Release Preference Card */}
                  {config.can_request_deploy && (
                    <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/[0.04] p-3.5 space-y-1.5">
                      <Switch
                        checked={releasePref === "request_immediate"}
                        onChange={(checked) =>
                          setReleasePref(checked ? "request_immediate" : "default")
                        }
                        label="修复完成后，若线上空闲请 AI 评估即时发布"
                        description={
                          config.release_window
                            ? `当前默认发布窗口为 ${config.release_window}；勾选后，修复完成将自动触发一次只读 AI 门禁评估，低风险且无活跃影响时立即上线。`
                            : "勾选后，修复完成将自动触发一次只读 AI 门禁评估，满足安全条件时立即触发上线。"
                        }
                      />
                    </div>
                  )}
                </div>

                <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11.5px] text-[var(--text-muted)]">
                    以「{config.label}」身份提交
                  </span>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    icon="send"
                    loading={submitting}
                    disabled={!body.trim() || images.some((i) => i.uploading)}
                  >
                    提交反馈
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* TAB 2 & 3: MY FEEDBACK / TEAM ACTIVITY */}
        {tab !== "submit" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start animate-rd-portal-in">
            {/* Left column: Ticket List */}
            <section
              className={cn(
                "lg:col-span-5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs",
                selectedTaskId ? "hidden lg:block" : "block",
              )}
            >
              {/* Filter + Search bar */}
              <div className="p-3 border-b border-[var(--border-subtle)] space-y-2.5">
                <div className="relative">
                  <Icon
                    name="search"
                    size={14}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索标题或工单编号（如 RD-21）…"
                    className="w-full h-8.5 pl-8.5 pr-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {(
                    [
                      { id: "all", label: "全部" },
                      { id: "action", label: "待我操作" },
                      { id: "active", label: "处理中" },
                      { id: "deployed", label: "已上线" },
                    ] as Array<{ id: TaskFilter; label: string }>
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setTaskFilter(f.id)}
                      className={cn(
                        "px-2.5 py-1 rounded-lg text-[11.5px] font-medium transition-colors cursor-pointer",
                        taskFilter === f.id
                          ? "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300"
                          : "text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
                      )}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Ticket rows */}
              <div className="divide-y divide-[var(--border-subtle)] max-h-[calc(100dvh-250px)] overflow-y-auto rd-scroll">
                {loadingList && currentList.length === 0 ? (
                  <div className="p-4 space-y-2.5">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="h-16 rounded-xl bg-[var(--surface-subtle)] animate-pulse"
                      />
                    ))}
                  </div>
                ) : filteredTasks.length === 0 ? (
                  <div className="px-5 py-10 text-center space-y-2.5">
                    <div className="w-10 h-10 rounded-xl bg-[var(--surface-subtle)] text-[var(--text-muted)] flex items-center justify-center mx-auto">
                      <Icon name="inbox" size={18} />
                    </div>
                    <p className="text-[13px] font-medium text-[var(--text-primary)]">
                      {currentList.length === 0
                        ? tab === "team"
                          ? "暂无团队反馈记录"
                          : "还没有提交过反馈"
                        : "没有符合筛选条件的工单"}
                    </p>
                    <p className="text-[12px] text-[var(--text-muted)]">
                      {currentList.length === 0
                        ? "提交反馈后可在此实时查看处理进度与发布状态。"
                        : "尝试切换筛选条件或清空搜索关键词。"}
                    </p>
                    {currentList.length === 0 && (
                      <div className="pt-1">
                        <Button
                          type="button"
                          variant="primary"
                          size="xs"
                          icon="pen-line"
                          onClick={() => setTab("submit")}
                        >
                          立即提交反馈
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  filteredTasks.map((t) => {
                    const selected = selectedTaskId === t.id;
                    const vis = resolveStatusVisual(t.status_label);
                    const needsAction = t.can_reply || t.can_accept || t.can_request_deploy;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setSelectedTaskId(t.id)}
                        className={cn(
                          "w-full text-left px-4 py-3.5 transition-colors cursor-pointer space-y-1.5",
                          selected
                            ? "bg-indigo-500/[0.07]"
                            : "hover:bg-[var(--surface-hover)]",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-mono text-[11px] font-medium text-[var(--text-muted)]">
                              {t.code}
                            </span>
                            {tab === "team" && t.owned && (
                              <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-indigo-500/12 text-indigo-700 dark:text-indigo-300">
                                我的
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-[var(--text-muted)] tabular-nums shrink-0">
                            {formatRelativeTime(t.created_at)}
                          </span>
                        </div>

                        <p className="text-[13px] font-medium text-[var(--text-primary)] line-clamp-2 leading-snug">
                          {t.title}
                        </p>

                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border",
                              vis.badgeClass,
                            )}
                          >
                            <LivePulseDot tone={vis.dotTone} active={vis.pulse} />
                            <span>{t.status_label}</span>
                          </span>

                          {needsAction && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10.5px] font-medium bg-amber-500/12 text-amber-700 dark:text-amber-300">
                              {t.can_reply
                                ? "待补充回复"
                                : t.can_accept
                                  ? "待验收"
                                  : "可申请即时发布"}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </section>

            {/* Right column: Ticket Detail */}
            <section
              className={cn(
                "lg:col-span-7 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs min-h-[420px]",
                selectedTaskId ? "block" : "hidden lg:flex lg:items-center lg:justify-center",
              )}
            >
              {!selectedTaskId ? (
                <div className="p-8 text-center space-y-2">
                  <div className="w-10 h-10 rounded-xl bg-[var(--surface-subtle)] text-[var(--text-muted)] flex items-center justify-center mx-auto">
                    <Icon name="message-square" size={18} />
                  </div>
                  <p className="text-[13.5px] font-medium text-[var(--text-primary)]">
                    选择左侧工单查看详情与实时进度
                  </p>
                  <p className="text-[12px] text-[var(--text-muted)]">
                    可查看脱敏后的生命周期阶段、回复团队追问、申请即时发布或在线确认解决。
                  </p>
                </div>
              ) : loadingDetail && !detail ? (
                <div className="p-6 space-y-4">
                  <div className="h-6 w-2/3 rounded-lg bg-[var(--surface-subtle)] animate-pulse" />
                  <div className="h-14 rounded-xl bg-[var(--surface-subtle)] animate-pulse" />
                  <div className="h-32 rounded-xl bg-[var(--surface-subtle)] animate-pulse" />
                </div>
              ) : detail ? (
                <div className="flex flex-col h-full animate-rd-portal-in">
                  {/* Detail Header */}
                  <div className="px-4 sm:px-5 py-4 border-b border-[var(--border-subtle)] space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <button
                          type="button"
                          onClick={() => setSelectedTaskId(null)}
                          className="lg:hidden inline-flex items-center gap-1 h-7 px-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-xs text-[var(--text-secondary)] cursor-pointer"
                        >
                          <Icon name="arrow-left" size={13} />
                          <span>返回列表</span>
                        </button>
                        <CopyButton
                          value={detail.task.code}
                          label={detail.task.code}
                          copiedLabel="已复制"
                          size="xs"
                          variant="secondary"
                        />
                        <span
                          title={formatDateTime(detail.task.created_at)}
                          className="text-[11.5px] text-[var(--text-muted)] tabular-nums"
                        >
                          提交于 {formatDateTime(detail.task.created_at)}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        icon="refresh-cw"
                        onClick={() => void loadTaskDetail(detail.task.id, false)}
                      >
                        刷新
                      </Button>
                    </div>

                    <div className="space-y-2">
                      <h2 className="text-[16px] font-semibold tracking-tight text-[var(--text-primary)] leading-snug">
                        {detail.task.title}
                      </h2>
                      {(() => {
                        const vis = resolveStatusVisual(detail.task.status_label);
                        return (
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={cn(
                                "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[12px] font-medium border",
                                vis.badgeClass,
                              )}
                            >
                              <LivePulseDot tone={vis.dotTone} active={vis.pulse} />
                              <span>{detail.task.status_label}</span>
                            </span>
                            {vis.specialNote && (
                              <span className="text-[12px] text-[var(--text-muted)]">
                                {vis.specialNote}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    {/* 5-Step Lifecycle Progress Bar */}
                    {(() => {
                      const vis = resolveStatusVisual(detail.task.status_label);
                      return (
                        <div className="pt-1">
                          <div className="grid grid-cols-5 gap-1.5">
                            {LIFECYCLE_STEPS.map((step, idx) => {
                              const done = idx < vis.stepIndex;
                              const current = idx === vis.stepIndex;
                              return (
                                <div key={step.key} className="space-y-1.5">
                                  <div className="h-1.5 rounded-full overflow-hidden bg-[var(--surface-subtle)]">
                                    <div
                                      className={cn(
                                        "h-full rounded-full transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
                                        done
                                          ? "w-full bg-emerald-500"
                                          : current
                                            ? vis.dotTone === "amber"
                                              ? "w-full bg-amber-500"
                                              : vis.dotTone === "emerald"
                                                ? "w-full bg-emerald-500"
                                                : "w-full bg-indigo-500"
                                            : "w-0",
                                      )}
                                    />
                                  </div>
                                  <div
                                    className={cn(
                                      "text-[10.5px] font-medium truncate",
                                      current
                                        ? "text-[var(--text-primary)]"
                                        : done
                                          ? "text-emerald-600 dark:text-emerald-400"
                                          : "text-[var(--text-muted)]",
                                    )}
                                  >
                                    {step.label}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Action Banners + Timeline Body */}
                  <div className="p-4 sm:p-5 space-y-4">
                    {/* Online Acceptance Action Card */}
                    {detail.task.can_accept && (
                      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-4 space-y-3 animate-rd-portal-in">
                        <div className="flex flex-wrap items-start justify-between gap-2.5">
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
                              <Icon
                                name="rocket"
                                size={14}
                                className="text-emerald-600 dark:text-emerald-400"
                              />
                              <span>修复已发布上线，请确认问题是否已解决</span>
                            </div>
                            <p className="text-[12px] text-[var(--text-secondary)]">
                              若问题仍存在，点击「仍有问题」并补充现象即可自动重新进入处理队列。
                            </p>
                          </div>
                          {acceptMode === "idle" && (
                            <div className="flex items-center gap-2 shrink-0">
                              <Button
                                type="button"
                                variant="secondary"
                                size="xs"
                                icon="alert-circle"
                                disabled={submittingAccept}
                                onClick={() => setAcceptMode("broken")}
                              >
                                仍有问题
                              </Button>
                              <Button
                                type="button"
                                variant="primary"
                                size="xs"
                                icon="check-circle-2"
                                loading={submittingAccept}
                                onClick={() => void handleAccept(true)}
                              >
                                确认已解决
                              </Button>
                            </div>
                          )}
                        </div>

                        {acceptMode === "broken" && (
                          <div className="space-y-2 pt-2 border-t border-emerald-500/20 animate-rd-portal-in">
                            <textarea
                              rows={2}
                              maxLength={4000}
                              value={brokenNote}
                              onChange={(e) => setBrokenNote(e.target.value)}
                              placeholder="请简单说明仍然存在的问题或新的现象（可选）…"
                              className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500"
                            />
                            <div className="flex justify-end gap-1.5">
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                disabled={submittingAccept}
                                onClick={() => setAcceptMode("idle")}
                              >
                                取消
                              </Button>
                              <Button
                                type="button"
                                variant="danger"
                                size="xs"
                                loading={submittingAccept}
                                onClick={() => void handleAccept(false)}
                              >
                                提交「仍有问题」并重开
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* AI Deploy Gate Status + Request Card */}
                    <PortalDeployGateCard
                      gate={detail.gate}
                      canRequestDeploy={detail.task.can_request_deploy}
                      releaseWindow={config.release_window}
                      onRequestDeploy={handleRequestDeploy}
                      requesting={requestingDeploy}
                    />

                    {/* Public Message Timeline */}
                    <div className="space-y-3">
                      <div className="text-[11.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                        沟通与进度记录
                      </div>
                      {detail.messages.length === 0 ? (
                        <p className="text-[12.5px] text-[var(--text-muted)] py-3">
                          暂无公开留言记录。
                        </p>
                      ) : (
                        <div className="space-y-2.5">
                          {detail.messages.map((msg) => {
                            const isReporter = msg.author === "reporter";
                            return (
                              <div
                                key={msg.id}
                                className={cn(
                                  "rounded-xl border px-3.5 py-3 space-y-1.5",
                                  isReporter
                                    ? "border-[var(--border-subtle)] bg-[var(--surface-elevated)]"
                                    : "border-indigo-500/20 bg-indigo-500/[0.04]",
                                )}
                              >
                                <div className="flex items-center justify-between gap-2 text-[11.5px]">
                                  <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                                    <Icon
                                      name={isReporter ? "user" : "sparkles"}
                                      size={12}
                                      className={
                                        isReporter
                                          ? "text-[var(--text-muted)]"
                                          : "text-indigo-600 dark:text-indigo-400"
                                      }
                                    />
                                    <span>
                                      {isReporter
                                        ? detail.task.owned
                                          ? "我"
                                          : "反馈者"
                                        : "项目团队"}
                                    </span>
                                  </span>
                                  <span
                                    title={formatDateTime(msg.created_at)}
                                    className="text-[11px] text-[var(--text-muted)] tabular-nums"
                                  >
                                    {formatDateTime(msg.created_at)}
                                  </span>
                                </div>
                                <div className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
                                  <MarkdownContent content={msg.body} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Reply composer when team requested clarification */}
                    {detail.task.can_reply && (
                      <form
                        onSubmit={(e) => void handleReplySubmit(e)}
                        className="rounded-xl border border-amber-500/30 bg-amber-500/[0.05] p-3.5 space-y-2.5 animate-rd-portal-in"
                      >
                        <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-800 dark:text-amber-300">
                          <Icon name="message-square-plus" size={14} />
                          <span>请补充更多信息，回复后将自动继续处理</span>
                        </div>
                        <textarea
                          required
                          rows={3}
                          maxLength={8000}
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          placeholder="输入补充说明、复现环境或操作步骤…"
                          className="w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2.5 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500"
                        />
                        <div className="flex justify-end">
                          <Button
                            type="submit"
                            variant="primary"
                            size="xs"
                            icon="send"
                            loading={sendingReply}
                            disabled={!replyText.trim()}
                          >
                            发送补充说明
                          </Button>
                        </div>
                      </form>
                    )}
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        )}
      </main>

      {/* Lightbox Modal for uploaded image preview */}
      {lightboxSrc && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setLightboxSrc(null)}
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-rd-portal-in"
        >
          <button
            type="button"
            aria-label="关闭大图"
            onClick={() => setLightboxSrc(null)}
            className="fixed top-4 right-4 w-9 h-9 rounded-full bg-black/70 border border-white/20 text-white flex items-center justify-center hover:bg-black cursor-pointer"
          >
            <Icon name="x" size={17} />
          </button>
          <img
            src={lightboxSrc}
            alt="大图预览"
            onClick={(e) => e.stopPropagation()}
            className="max-w-[92vw] max-h-[88vh] rounded-xl border border-white/15 shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}

export default function PortalRoute() {
  return (
    <ToastProvider>
      <PortalContent />
    </ToastProvider>
  );
}
