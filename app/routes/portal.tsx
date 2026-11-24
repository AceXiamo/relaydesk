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
      badgeClass: "bg-[var(--p-forest-tint)] text-[var(--p-forest)] border-transparent",
      dotTone: "emerald",
      pulse: false,
    };
  }
  if (label === "已上线") {
    return {
      stepIndex: 3,
      badgeClass: "bg-[var(--p-forest-tint)] text-[var(--p-forest)] border-transparent",
      dotTone: "emerald",
      pulse: true,
    };
  }
  if (label === "正在发布上线") {
    return {
      stepIndex: 2,
      badgeClass: "bg-[var(--p-cobalt-tint)] text-[var(--p-cobalt)] border-transparent",
      dotTone: "indigo",
      pulse: true,
    };
  }
  if (label === "已修复，等待发布") {
    return {
      stepIndex: 2,
      badgeClass: "bg-[var(--p-cobalt-tint)] text-[var(--p-cobalt)] border-transparent",
      dotTone: "indigo",
      pulse: false,
    };
  }
  if (label === "发布暂缓") {
    return {
      stepIndex: 2,
      badgeClass: "bg-[var(--p-vermilion-tint)] text-[var(--p-vermilion)] border-transparent",
      dotTone: "amber",
      pulse: false,
      specialNote: "发布暂时顺延，团队会跟进处理",
    };
  }
  if (label === "等待补充信息") {
    return {
      stepIndex: 1,
      badgeClass: "bg-[var(--p-vermilion-tint)] text-[var(--p-vermilion)] border-transparent",
      dotTone: "amber",
      pulse: true,
      specialNote: "需要你补充信息后继续推进",
    };
  }
  if (label === "排查与修复中" || label === "内部复核中") {
    return {
      stepIndex: 1,
      badgeClass: "bg-[var(--p-cobalt-tint)] text-[var(--p-cobalt)] border-transparent",
      dotTone: "indigo",
      pulse: true,
    };
  }
  if (label === "已完成处理") {
    return {
      stepIndex: 4,
      badgeClass: "bg-[var(--p-forest-tint)] text-[var(--p-forest)] border-transparent",
      dotTone: "emerald",
      pulse: false,
    };
  }
  if (label === "已关联处理" || label === "已结束处理") {
    return {
      stepIndex: 4,
      badgeClass: "bg-[var(--p-field)] text-[var(--p-ink-2)] border-transparent",
      dotTone: "zinc",
      pulse: false,
    };
  }
  return {
    stepIndex: 0,
    badgeClass: "bg-[var(--p-field)] text-[var(--p-ink-2)] border-transparent",
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
      ? "bg-[var(--p-vermilion-tint)] text-[var(--p-vermilion)]"
      : meta.tone === "indigo"
        ? "bg-[var(--p-cobalt-tint)] text-[var(--p-cobalt)]"
        : "bg-[var(--p-vermilion-tint)] text-[var(--p-vermilion)]";

  return (
    <main className="rd-portal-shell min-h-dvh flex flex-col items-center justify-center p-5 bg-[var(--p-page)] text-[var(--p-ink)]">
      <div className="w-full max-w-md rd-portal-dots rounded-[20px] bg-[var(--p-canvas)] p-3 shadow-[var(--p-shadow-hairline)] animate-rd-portal-in">
        <div className="rounded-[14px] bg-[var(--p-surface)] p-6 sm:p-7 shadow-[var(--p-shadow-card)] space-y-5">
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2 text-[11.5px] font-mono text-[var(--p-ink-3)]">
              <span className="w-2 h-2 rounded-full bg-[var(--p-cobalt)]" />
              <span>RELAYDESK PORTAL</span>
            </div>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-[var(--p-field)] text-[var(--p-ink-3)]">
              {code || "unauthorized"}
            </span>
          </div>

          <div className="flex items-start gap-3.5">
            <div
              className={cn(
                "w-11 h-11 rounded-[10px] flex items-center justify-center shrink-0",
                toneClasses,
              )}
            >
              <Icon name={meta.icon} size={20} />
            </div>
            <div className="min-w-0 space-y-1.5">
              <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-[var(--p-ink)]">
                {meta.title}
              </h1>
              <p className="text-[13.5px] leading-relaxed text-[var(--p-ink-2)]">
                {message || meta.fallback}
              </p>
            </div>
          </div>

          <div className="rounded-[10px] bg-[var(--p-canvas)] px-3.5 py-3 text-[12px] leading-relaxed text-[var(--p-ink-3)] space-y-1">
            <p className="font-medium text-[var(--p-ink-2)]">如何恢复访问？</p>
            <p>
              请向项目管理员获取新的专属分享链接并直接打开；若仅是刚刚在另一标签页完成了授权，可点击下方按钮重新检测会话。
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-dashed border-[var(--p-line)]">
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
    <div className="space-y-3">
      {gate && (
        <div
          className={cn(
            "relative overflow-hidden rounded-[12px] p-4 space-y-1.5 animate-rd-portal-in",
            gate.status === "evaluating"
              ? "bg-[var(--p-cobalt-tint)]"
              : gate.status === "approved"
                ? "bg-[var(--p-forest-tint)]"
                : gate.status === "deferred"
                  ? "bg-[var(--p-vermilion-tint)]"
                  : gate.status === "escalated"
                    ? "bg-[var(--p-cobalt-tint)]"
                    : "bg-[var(--p-canvas)] shadow-[var(--p-shadow-hairline)]",
          )}
        >
          {isEvaluating && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-[var(--p-cobalt-tint)]"
            >
              <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-[var(--p-cobalt)] to-transparent animate-rd-gate-scan" />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {isEvaluating ? (
                <Icon
                  name="loader-2"
                  size={14}
                  className="animate-spin text-[var(--p-cobalt)]"
                />
              ) : gate.status === "approved" ? (
                <Icon
                  name="shield-check"
                  size={14}
                  className="text-[var(--p-forest)]"
                />
              ) : gate.status === "deferred" ? (
                <Icon
                  name="clock"
                  size={14}
                  className="text-[var(--p-vermilion)]"
                />
              ) : gate.status === "escalated" ? (
                <Icon
                  name="shield-alert"
                  size={14}
                  className="text-[var(--p-cobalt)]"
                />
              ) : (
                <Icon
                  name="alert-circle"
                  size={14}
                  className="text-[var(--p-ink-3)]"
                />
              )}
              <span className="text-[13px] font-semibold text-[var(--p-ink)]">
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
            <span className="text-[11px] font-mono text-[var(--p-ink-3)] tabular-nums">
              {formatRelativeTime(gate.finished_at || gate.created_at)}
            </span>
          </div>

          <p className="text-[12.5px] leading-relaxed text-[var(--p-ink-2)]">
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
        <div className="rounded-[12px] bg-[var(--p-surface)] shadow-[var(--p-shadow-hairline)] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--p-ink)]">
                <Icon
                  name="zap"
                  size={14}
                  className="text-[var(--p-cobalt)] shrink-0"
                />
                <span>修复已就绪，急需立即上线？</span>
              </div>
              <p className="text-[12px] text-[var(--p-ink-3)]">
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
              className="space-y-2.5 pt-2.5 border-t border-dashed border-[var(--p-line)] animate-rd-portal-in"
            >
              <input
                type="text"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="可选：简述急需立即上线的原因（例如：客户演示在即 / 影响核心下单流程）"
                className="w-full h-9.5 px-3 rounded-[10px] bg-[var(--p-page)] shadow-[var(--p-shadow-hairline)] text-[12.5px] text-[var(--p-ink)] placeholder:text-[var(--p-ink-3)] focus:outline-none focus:shadow-[0_0_0_1.5px_var(--p-cobalt)]"
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
  const [recheckingConfig, setRecheckingConfig] = useState(false);
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [accessError, setAccessError] = useState<{ code: string; message?: string } | null>(
    queryErrorCode ? { code: queryErrorCode } : null,
  );

  // Navigation
  const [tab, setTab] = useState<PortalTab>("submit");
  const [submitMode, setSubmitMode] = useState<SubmitMode>("agent");
  const [conversationActive, setConversationActive] = useState(false);

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
            prev.agent_available === cfg.agent_available &&
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

  const actionCount = useMemo(
    () => mineTasks.filter((t) => t.can_reply || t.can_accept).length,
    [mineTasks],
  );

  const returningPreviewTasks = useMemo(() => {
    if (mineTasks.length === 0) return [];
    const prioritized = [...mineTasks].sort((a, b) => {
      const aAct = a.can_reply || a.can_accept || a.can_request_deploy ? 1 : 0;
      const bAct = b.can_reply || b.can_accept || b.can_request_deploy ? 1 : 0;
      return bAct - aAct;
    });
    return prioritized.slice(0, 3);
  }, [mineTasks]);

  const navTabs = useMemo<Array<{ id: PortalTab; label: string; badge?: number; alert?: boolean }>>(() => {
    const base: Array<{ id: PortalTab; label: string; badge?: number; alert?: boolean }> = [
      {
        id: "submit",
        label: config?.agent_enabled ? "表达反馈" : "提交反馈",
      },
      {
        id: "mine",
        label: "我的反馈",
        badge: mineTasks.length || undefined,
        alert: actionCount > 0,
      },
    ];
    if (config?.can_view_team) {
      base.push({
        id: "team",
        label: "团队动态",
        badge: teamTasks.length || undefined,
      });
    }
    return base;
  }, [actionCount, config?.agent_enabled, config?.can_view_team, mineTasks.length, teamTasks.length]);

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

  const openTaskStory = useCallback((taskId: string, targetTab: "mine" | "team" = "mine") => {
    setTab(targetTab);
    setSelectedTaskId(taskId);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  if (loadingConfig) {
    return (
      <main className="rd-portal-shell min-h-dvh flex items-center justify-center bg-[var(--p-page)] text-[var(--p-ink-3)]">
        <div className="flex flex-col items-center gap-3 animate-rd-portal-in">
          <div className="w-10 h-10 rounded-[12px] bg-[var(--p-surface)] shadow-[var(--p-shadow-card)] flex items-center justify-center">
            <Icon name="loader-2" size={18} className="animate-spin text-[var(--p-cobalt)]" />
          </div>
          <p className="text-[12.5px] font-medium">正在校验访问授权…</p>
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

  const agentEnabled = config.agent_enabled === true;
  const agentOnline = agentEnabled && config.agent_available !== false;
  const agentOffline = agentEnabled && config.agent_available === false;

  const handleRecheckAvailability = async () => {
    setRecheckingConfig(true);
    try {
      await loadConfig(true);
    } finally {
      setRecheckingConfig(false);
    }
  };

  const pendingActionInList = currentList.filter(
    (t) => t.can_reply || t.can_accept || t.can_request_deploy,
  ).length;

  return (
    <div className="rd-portal-shell min-h-dvh bg-[var(--p-page)] text-[var(--p-ink)]">
      {/* Framed Architectural Canvas (Beautiful UI-inspired hairline rails + dashed dividers) */}
      <div className="relative mx-auto max-w-[920px] min-h-dvh bg-[var(--p-page)] shadow-[0_0_0_1px_var(--p-line)] flex flex-col">
        {/* Un-stuck Editorial Masthead (no sticky admin chrome) */}
        <header className="border-b border-dashed border-[var(--p-line)] px-5 sm:px-9 py-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* Brand / Project Identity */}
            <button
              type="button"
              onClick={() => {
                setTab("submit");
                setSelectedTaskId(null);
              }}
              className="group inline-flex items-center gap-3 min-w-0 text-left cursor-pointer"
            >
              {/* Minimalist 3x3 Dot Grid Mark */}
              <span
                aria-hidden="true"
                className="w-8 h-8 rounded-[9px] bg-[var(--p-surface)] shadow-[var(--p-shadow-btn)] grid grid-cols-3 place-items-center p-1.5 shrink-0 transition-transform duration-150 group-hover:scale-[1.04]"
              >
                <span className="w-[3.5px] h-[3.5px] rounded-[1px] bg-[var(--p-ink)]" />
                <span className="w-[3.5px] h-[3.5px] rounded-[1px] bg-[var(--p-cobalt)]" />
                <span className="w-[3.5px] h-[3.5px] rounded-[1px] bg-[var(--p-ink)]" />
                <span className="w-[3.5px] h-[3.5px] rounded-[1px] bg-[var(--p-forest)]" />
                <span className="w-[3.5px] h-[3.5px] rounded-[1px] bg-[var(--p-ink)]" />
                <span className="w-[3.5px] h-[3.5px] rounded-[1px] bg-[var(--p-vermilion)]" />
                <span className="w-[3.5px] h-[3.5px] rounded-[1px] bg-[var(--p-ink)]" />
                <span className="w-[3.5px] h-[3.5px] rounded-[1px] bg-[var(--p-ink)]" />
                <span className="w-[3.5px] h-[3.5px] rounded-[1px] bg-[var(--p-ink)]" />
              </span>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--p-ink)] truncate">
                    {config.project_name}
                  </h1>
                  <span className="text-[var(--p-line-strong)]">/</span>
                  <span className="font-mono text-[11.5px] text-[var(--p-ink-3)] shrink-0">
                    反馈中心
                  </span>
                </div>
              </div>
            </button>

            {/* Right Controls: Identity + Sliding Pill Theme Toggle */}
            <div className="flex items-center gap-2.5 shrink-0">
              <div
                title={`当前授权身份：${config.label}`}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-[var(--p-field)] text-[12px] font-medium text-[var(--p-ink-2)] max-w-[160px]"
              >
                <LivePulseDot tone="emerald" active />
                <span className="truncate">{config.label}</span>
              </div>

              {/* Beautiful UI-style 2-cell sliding pill theme switch */}
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={dark ? "切换浅色主题" : "切换深色主题"}
                className="relative inline-grid h-8 w-15 grid-cols-2 items-center rounded-full bg-[var(--p-field)] p-0.5 cursor-pointer"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-y-0.5 left-0.5 w-7 rounded-full bg-[var(--p-surface)] shadow-[var(--p-shadow-btn)] transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
                    dark ? "translate-x-7" : "translate-x-0",
                  )}
                />
                <span
                  className={cn(
                    "relative z-10 inline-flex items-center justify-center transition-colors",
                    !dark ? "text-[var(--p-ink)]" : "text-[var(--p-ink-3)]",
                  )}
                >
                  <Icon name="sun" size={13} />
                </span>
                <span
                  className={cn(
                    "relative z-10 inline-flex items-center justify-center transition-colors",
                    dark ? "text-[var(--p-ink)]" : "text-[var(--p-ink-3)]",
                  )}
                >
                  <Icon name="moon" size={13} />
                </span>
              </button>
            </div>
          </div>

          {/* Lightweight Editorial View Switcher */}
          <nav
            role="tablist"
            aria-label="反馈面板导航"
            className="mt-4 pt-3.5 border-t border-dashed border-[var(--p-line)]/80 flex flex-wrap items-center gap-1.5"
          >
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
                    setSelectedTaskId(null);
                  }}
                  className={cn(
                    "inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full text-[12.5px] font-medium transition-all duration-150 cursor-pointer select-none",
                    active
                      ? "bg-[var(--p-ink)] text-[var(--p-page)] shadow-xs"
                      : "text-[var(--p-ink-2)] hover:text-[var(--p-ink)] hover:bg-[var(--p-hover)]",
                  )}
                >
                  <span>{item.label}</span>
                  {item.badge !== undefined && (
                    <span
                      className={cn(
                        "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10.5px] font-mono tabular-nums",
                        active
                          ? "bg-white/20 text-[var(--p-page)] dark:bg-black/20"
                          : "bg-[var(--p-field)] text-[var(--p-ink-2)]",
                      )}
                    >
                      {item.badge}
                    </span>
                  )}
                  {item.alert && (
                    <span
                      aria-label="有待处理工单"
                      className="w-1.5 h-1.5 rounded-full bg-[var(--p-vermilion)] shrink-0"
                    />
                  )}
                </button>
              );
            })}
          </nav>
        </header>

        {/* Main Content Canvas */}
        <main className="flex-1 w-full">
          {/* ── TAB 1: EXPRESS FEEDBACK (HERO + COMPOSER + RETURNING PROGRESS DOCK) ── */}
          {tab === "submit" && (
            <div className="animate-rd-portal-in">
              <div className="px-5 sm:px-9 py-9 sm:py-13">
                {submittedDetail ? (
                  <section className="rd-portal-dots rounded-[20px] bg-[var(--p-canvas)] p-3 sm:p-4 shadow-[var(--p-shadow-hairline)] animate-rd-portal-in">
                    <div className="rounded-[14px] bg-[var(--p-surface)] p-6 sm:p-8 shadow-[var(--p-shadow-card)] space-y-6">
                      <div className="flex items-start gap-4">
                        <div className="w-11 h-11 rounded-[12px] bg-[var(--p-forest-tint)] text-[var(--p-forest)] flex items-center justify-center shrink-0 animate-rd-step-pop">
                          <Icon name="check-circle-2" size={22} />
                        </div>
                        <div className="min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <h2 className="text-[20px] font-semibold tracking-[-0.025em] text-[var(--p-ink)]">
                              反馈已收到，正在跟进处理
                            </h2>
                            <CopyButton
                              value={submittedDetail.task.code}
                              label={submittedDetail.task.code}
                              copiedLabel="已复制编号"
                              size="xs"
                              variant="secondary"
                            />
                          </div>
                          <p className="text-[14.5px] font-medium text-[var(--p-ink)]">
                            {submittedDetail.task.title}
                          </p>
                          <p className="text-[13px] leading-relaxed text-[var(--p-ink-2)]">
                            你可以随时在「我的反馈」查看排查修复与上线进度，回复团队追问或在线确认解决。
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-2.5 pt-4 border-t border-dashed border-[var(--p-line)]">
                        <button
                          type="button"
                          onClick={() => {
                            setSubmittedDetail(null);
                            if (agentEnabled) setSubmitMode("agent");
                          }}
                          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-[var(--p-field)] text-[13px] font-medium text-[var(--p-ink)] shadow-[var(--p-shadow-btn)] hover:bg-[var(--p-hover)] transition-all active:scale-[0.97] cursor-pointer"
                        >
                          <Icon name="plus" size={14} />
                          <span>继续反馈</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const targetId = submittedDetail.task.id;
                            setSubmittedDetail(null);
                            openTaskStory(targetId, "mine");
                          }}
                          className="inline-flex items-center gap-1.5 h-9 px-4.5 rounded-full bg-[var(--p-ink)] text-[var(--p-page)] text-[13px] font-medium hover:opacity-90 transition-all active:scale-[0.97] cursor-pointer shadow-xs"
                        >
                          <span>查看处理进度</span>
                          <Icon name="arrow-right" size={14} />
                        </button>
                      </div>
                    </div>
                  </section>
                ) : agentOnline && submitMode === "agent" ? (
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
                    onRefreshConfig={handleRecheckAvailability}
                    onPossibleAuthError={handlePossibleAuthError}
                    onConversationActiveChange={setConversationActive}
                  />
                ) : agentOffline && submitMode === "agent" ? (
                  <section
                    data-testid="portal-agent-offline"
                    className="space-y-7 animate-rd-portal-in"
                  >
                    <div className="space-y-4">
                      <div className="flex items-center gap-2.5 text-[12px]">
                        <span className="font-mono text-[11.5px] text-[var(--p-ink-3)] tabular-nums">
                          01
                        </span>
                        <span className="text-[var(--p-line-strong)]">/</span>
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[var(--p-vermilion-tint)] text-[var(--p-vermilion)] text-[11.5px] font-medium">
                          <LivePulseDot tone="amber" active={false} />
                          <span>诊断节点暂离线</span>
                        </span>
                      </div>
                      <h2 className="text-[28px] sm:text-[36px] font-semibold tracking-[-0.035em] leading-[1.14] text-[var(--p-ink)] text-balance">
                        反馈诊断助手暂时离线，你仍可直接留言
                      </h2>
                      <p className="text-[14.5px] leading-relaxed text-[var(--p-ink-2)] max-w-[540px]">
                        项目维护者的本地诊断节点暂时未在线。你可以稍后重新检测，或直接填写反馈进入处理队列。
                      </p>
                    </div>

                    <div className="rd-portal-dots rounded-[20px] bg-[var(--p-canvas)] p-6 sm:p-8 shadow-[var(--p-shadow-hairline)] flex flex-wrap items-center justify-between gap-4">
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div className="w-11 h-11 rounded-[12px] bg-[var(--p-surface)] text-[var(--p-vermilion)] shadow-[var(--p-shadow-card)] flex items-center justify-center shrink-0">
                          <Icon name="wifi-off" size={20} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[14px] font-semibold text-[var(--p-ink)]">
                            直接提交反馈单
                          </div>
                          <p className="text-[12.5px] text-[var(--p-ink-3)]">
                            填写现象并附带截图，提交后即可实时追踪处理进度
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2.5">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          icon="refresh-cw"
                          loading={recheckingConfig}
                          onClick={() => void handleRecheckAvailability()}
                        >
                          重新检测状态
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          icon="pen-line"
                          data-testid="portal-offline-to-manual"
                          onClick={() => setSubmitMode("manual")}
                        >
                          直接填写反馈单
                        </Button>
                      </div>
                    </div>
                  </section>
                ) : (
                  <div className="space-y-8 animate-rd-portal-in">
                    {/* Bold Editorial Hero for Direct Feedback */}
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2.5 text-[12px]">
                          <span className="font-mono text-[11.5px] font-medium text-[var(--p-ink-3)] tabular-nums">
                            01
                          </span>
                          <span className="text-[var(--p-line-strong)]">/</span>
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[var(--p-cobalt-tint)] text-[var(--p-cobalt)] text-[11.5px] font-medium">
                            <span>直接提单模式 · 提交即建单</span>
                          </span>
                          {config.release_window && (
                            <span className="hidden sm:inline-flex items-center gap-1 text-[11.5px] text-[var(--p-ink-3)]">
                              <Icon name="calendar-clock" size={12} />
                              <span>发布窗口 {config.release_window}</span>
                            </span>
                          )}
                        </div>

                        {agentOnline && (
                          <button
                            type="button"
                            data-testid="portal-switch-agent"
                            onClick={() => setSubmitMode("agent")}
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-[var(--p-field)] text-[12px] font-medium text-[var(--p-ink)] shadow-[var(--p-shadow-btn)] hover:bg-[var(--p-hover)] transition-all active:scale-[0.97] cursor-pointer"
                          >
                            <Icon name="sparkles" size={13} className="text-[var(--p-cobalt)]" />
                            <span>返回 AI 诊断对话</span>
                          </button>
                        )}
                        {agentOffline && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            icon="refresh-cw"
                            loading={recheckingConfig}
                            onClick={() => {
                              setSubmitMode("agent");
                              void handleRecheckAvailability();
                            }}
                          >
                            检测助手是否上线
                          </Button>
                        )}
                      </div>

                      <h2 className="text-[30px] sm:text-[40px] font-semibold tracking-[-0.035em] leading-[1.12] text-[var(--p-ink)] text-balance">
                        {agentEnabled
                          ? "直接写下你的反馈"
                          : `有什么想告诉 ${config.project_name} 的？`}
                      </h2>
                      <p className="text-[14.5px] sm:text-[15.5px] leading-relaxed text-[var(--p-ink-2)] max-w-[560px]">
                        {agentEnabled
                          ? "跳过对话排查，直接提交工单进入项目处理队列，支持粘贴或拖入截图。"
                          : "描述你遇到的问题、建议或使用疑问，提交后将进入处理队列并可随时回来查看进度。"}
                      </p>
                    </div>

                    {/* Recessed Dotted Showcase Well wrapping the Form */}
                    <div className="rd-portal-dots rounded-[20px] bg-[var(--p-canvas)] p-2.5 sm:p-4 shadow-[var(--p-shadow-hairline)]">
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
                          "rounded-[14px] bg-[var(--p-surface)] overflow-hidden transition-all duration-200",
                          dragOver
                            ? "shadow-[0_0_0_2px_var(--p-cobalt),var(--p-shadow-composer)]"
                            : "shadow-[var(--p-shadow-composer)]",
                        )}
                      >
                        <div className="p-5 sm:p-6 space-y-5">
                          {/* Type selector pills */}
                          <div className="space-y-2">
                            <span className="block text-[12px] font-medium text-[var(--p-ink-2)]">
                              反馈类型
                            </span>
                            <div className="grid grid-cols-3 gap-2.5">
                              {FEEDBACK_TYPES.map((item) => {
                                const active = feedbackType === item.id;
                                const activeTone =
                                  item.tone === "rose"
                                    ? "bg-[var(--p-vermilion-tint)] text-[var(--p-vermilion)] shadow-[0_0_0_1.5px_var(--p-vermilion)]"
                                    : item.tone === "amber"
                                      ? "bg-[var(--p-cobalt-tint)] text-[var(--p-cobalt)] shadow-[0_0_0_1.5px_var(--p-cobalt)]"
                                      : "bg-[var(--p-forest-tint)] text-[var(--p-forest)] shadow-[0_0_0_1.5px_var(--p-forest)]";
                                return (
                                  <button
                                    key={item.id}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => setFeedbackType(item.id)}
                                    className={cn(
                                      "flex items-center justify-center gap-1.5 h-10 px-3 rounded-[10px] text-[13px] font-medium transition-all duration-150 cursor-pointer",
                                      active
                                        ? activeTone
                                        : "bg-[var(--p-page)] text-[var(--p-ink-2)] shadow-[var(--p-shadow-hairline)] hover:bg-[var(--p-hover)] hover:text-[var(--p-ink)]",
                                    )}
                                  >
                                    <Icon name={item.icon} size={14} />
                                    <span>{item.label}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {/* Title input */}
                          <label className="block space-y-1.5">
                            <span className="text-[12px] font-medium text-[var(--p-ink-2)]">
                              简要标题（可选）
                            </span>
                            <input
                              type="text"
                              maxLength={180}
                              value={title}
                              onChange={(e) => setTitle(e.target.value)}
                              placeholder="一句话概括现象或建议，留空将自动从正文首行提取"
                              className="w-full h-10.5 px-3.5 rounded-[10px] bg-[var(--p-page)] shadow-[var(--p-shadow-hairline)] text-[14px] text-[var(--p-ink)] placeholder:text-[var(--p-ink-3)] focus:outline-none focus:shadow-[0_0_0_1.5px_var(--p-cobalt)] transition-all"
                            />
                          </label>

                          {/* Body textarea */}
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[12px] font-medium text-[var(--p-ink-2)]">
                                详细描述 <span className="text-[var(--p-vermilion)]">*</span>
                              </span>
                              <span className="text-[11px] font-mono text-[var(--p-ink-3)] tabular-nums">
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
                              className="w-full rounded-[10px] bg-[var(--p-page)] shadow-[var(--p-shadow-hairline)] p-3.5 text-[14px] leading-relaxed text-[var(--p-ink)] placeholder:text-[var(--p-ink-3)] focus:outline-none focus:shadow-[0_0_0_1.5px_var(--p-cobalt)] transition-all resize-y"
                            />

                            {/* Toolbar: Upload */}
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
                                <button
                                  type="button"
                                  disabled={!config.upload_enabled || images.length >= 6}
                                  onClick={() => fileInputRef.current?.click()}
                                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-[var(--p-field)] text-[12px] font-medium text-[var(--p-ink-2)] hover:text-[var(--p-ink)] hover:bg-[var(--p-hover)] transition-colors disabled:opacity-45 cursor-pointer"
                                >
                                  <Icon name="image" size={13.5} />
                                  <span>
                                    {config.upload_enabled
                                      ? `上传截图 (${images.length}/6)`
                                      : "图床未配置"}
                                  </span>
                                </button>
                              </div>
                              <span className="text-[11.5px] text-[var(--p-ink-3)]">
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
                                  className="group relative w-20 h-16 rounded-[10px] overflow-hidden shadow-[var(--p-shadow-hairline)] bg-[var(--p-canvas)] animate-rd-step-pop"
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
                            <div className="rounded-[12px] bg-[var(--p-cobalt-tint)] p-3.5">
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

                        <div className="px-5 sm:px-6 py-4 bg-[var(--p-page)]/80 border-t border-dashed border-[var(--p-line)] flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[12px] text-[var(--p-ink-3)]">
                            以「{config.label}」身份提交
                          </span>
                          <button
                            type="submit"
                            disabled={submitting || !body.trim() || images.some((i) => i.uploading)}
                            className="inline-flex items-center justify-center gap-1.5 h-9 px-5 rounded-full bg-[var(--p-ink)] text-[var(--p-page)] text-[13px] font-medium hover:opacity-90 active:scale-[0.97] transition-all disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer shadow-xs"
                          >
                            {submitting ? (
                              <Icon name="loader-2" size={14} className="animate-spin" />
                            ) : (
                              <Icon name="send" size={13.5} />
                            )}
                            <span>提交反馈</span>
                          </button>
                        </div>
                      </form>
                    </div>
                  </div>
                )}
              </div>

              {/* ── RETURNING USER PROGRESS DOCK (Right on Home, below dashed divider) ── */}
              {!conversationActive && !submittedDetail && returningPreviewTasks.length > 0 && (
                <section className="border-t border-dashed border-[var(--p-line)] px-5 sm:px-9 py-8 sm:py-10 space-y-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div className="flex items-baseline gap-2.5">
                      <span className="font-mono text-[11.5px] font-medium text-[var(--p-ink-3)] tabular-nums">
                        02
                      </span>
                      <h3 className="text-[15.5px] font-semibold tracking-[-0.015em] text-[var(--p-ink)]">
                        你最近的反馈进度
                      </h3>
                      {actionCount > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--p-vermilion-tint)] text-[var(--p-vermilion)] text-[11px] font-medium">
                          {actionCount} 条待你确认
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setTab("mine");
                        setSelectedTaskId(null);
                      }}
                      className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[var(--p-ink-2)] hover:text-[var(--p-ink)] transition-colors cursor-pointer"
                    >
                      <span>查看全部 {mineTasks.length} 条</span>
                      <Icon name="arrow-right" size={13.5} />
                    </button>
                  </div>

                  <div className="space-y-2.5">
                    {returningPreviewTasks.map((t) => {
                      const vis = resolveStatusVisual(t.status_label);
                      const actionHint = t.can_reply
                        ? "需要你补充说明"
                        : t.can_accept
                          ? "已上线 · 请确认是否解决"
                          : t.can_request_deploy
                            ? "修复就绪 · 可申请提前发布"
                            : null;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => openTaskStory(t.id, "mine")}
                          className="group w-full text-left rounded-[12px] bg-[var(--p-surface)] shadow-[var(--p-shadow-hairline)] hover:shadow-[var(--p-shadow-card)] hover:-translate-y-0.5 px-4 sm:px-5 py-4 transition-all duration-150 cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                        >
                          <div className="min-w-0 space-y-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-[11.5px] text-[var(--p-ink-3)] tabular-nums">
                                {t.code}
                              </span>
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border",
                                  vis.badgeClass,
                                )}
                              >
                                <LivePulseDot tone={vis.dotTone} active={vis.pulse} />
                                <span>{t.status_label}</span>
                              </span>
                              {actionHint && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--p-vermilion-tint)] text-[var(--p-vermilion)]">
                                  {actionHint}
                                </span>
                              )}
                            </div>
                            <p className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--p-ink)] truncate">
                              {t.title}
                            </p>
                          </div>

                          <div className="flex items-center gap-3 shrink-0">
                            <div className="flex items-center gap-1" aria-hidden="true">
                              {LIFECYCLE_STEPS.map((s, idx) => (
                                <span
                                  key={s.key}
                                  className={cn(
                                    "h-1.5 w-4 rounded-full transition-colors",
                                    idx < vis.stepIndex
                                      ? "bg-[var(--p-forest)]"
                                      : idx === vis.stepIndex
                                        ? vis.dotTone === "amber"
                                          ? "bg-[var(--p-vermilion)]"
                                          : vis.dotTone === "emerald"
                                            ? "bg-[var(--p-forest)]"
                                            : "bg-[var(--p-cobalt)]"
                                        : "bg-[var(--p-field)]",
                                  )}
                                />
                              ))}
                            </div>
                            <Icon
                              name="chevron-right"
                              size={15}
                              className="text-[var(--p-ink-3)] group-hover:text-[var(--p-ink)] group-hover:translate-x-0.5 transition-all"
                            />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          )}

          {/* ── TAB 2 & 3: EDITORIAL PROGRESS FEED -> FOCUSED DETAIL STORY (NO ADMIN SPLIT PANE) ── */}
          {tab !== "submit" && (
            <div className="px-5 sm:px-9 py-8 sm:py-11 animate-rd-portal-in">
              {!selectedTaskId ? (
                /* ── FEED VIEW ── */
                <div className="space-y-7">
                  {/* Editorial Section Header */}
                  <div className="pb-6 border-b border-dashed border-[var(--p-line)] flex flex-wrap items-end justify-between gap-4">
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-2 text-[12px]">
                        <span className="font-mono text-[11.5px] font-medium text-[var(--p-ink-3)] tabular-nums">
                          {tab === "mine" ? "02" : "03"}
                        </span>
                        <span className="text-[var(--p-line-strong)]">/</span>
                        <span className="font-mono text-[11.5px] text-[var(--p-ink-3)]">
                          {tab === "mine" ? "MY FEEDBACK" : "TEAM STREAM"}
                        </span>
                      </div>
                      <h2 className="text-[26px] sm:text-[34px] font-semibold tracking-[-0.03em] leading-[1.12] text-[var(--p-ink)]">
                        {tab === "mine" ? "我的反馈进度" : "团队反馈动态"}
                      </h2>
                      <p className="text-[14px] text-[var(--p-ink-2)]">
                        {currentList.length === 0
                          ? "提交反馈后，排查修复与发布上线进度会实时同步在这里。"
                          : `共 ${currentList.length} 条记录${pendingActionInList > 0 ? ` · ${pendingActionInList} 条需要你确认或补充` : " · 全部进度实时同步"}`}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void loadTasks(tab === "team" ? "team" : "mine", false)}
                        aria-label="刷新进度"
                        className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full bg-[var(--p-field)] text-[12.5px] font-medium text-[var(--p-ink-2)] hover:text-[var(--p-ink)] hover:bg-[var(--p-hover)] transition-colors cursor-pointer"
                      >
                        <Icon name="refresh-cw" size={13.5} />
                        <span>刷新</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setTab("submit");
                          setSelectedTaskId(null);
                        }}
                        className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-[var(--p-ink)] text-[var(--p-page)] text-[12.5px] font-medium hover:opacity-90 active:scale-[0.97] transition-all cursor-pointer shadow-xs"
                      >
                        <Icon name="plus" size={14} />
                        <span>写一条反馈</span>
                      </button>
                    </div>
                  </div>

                  {/* Lightweight Filter Pills + Quiet Search (only when items exist) */}
                  {currentList.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(
                          [
                            { id: "all", label: "全部" },
                            { id: "action", label: "待我操作" },
                            { id: "active", label: "处理中" },
                            { id: "deployed", label: "已上线" },
                          ] as Array<{ id: TaskFilter; label: string }>
                        ).map((f) => {
                          const active = taskFilter === f.id;
                          return (
                            <button
                              key={f.id}
                              type="button"
                              onClick={() => setTaskFilter(f.id)}
                              className={cn(
                                "h-8 px-3.5 rounded-full text-[12.5px] font-medium transition-all cursor-pointer",
                                active
                                  ? "bg-[var(--p-surface)] text-[var(--p-ink)] shadow-[var(--p-shadow-btn)]"
                                  : "text-[var(--p-ink-3)] hover:text-[var(--p-ink)] hover:bg-[var(--p-hover)]",
                              )}
                            >
                              {f.label}
                            </button>
                          );
                        })}
                      </div>

                      <div className="relative w-full sm:w-56">
                        <Icon
                          name="search"
                          size={13.5}
                          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--p-ink-3)]"
                        />
                        <input
                          type="search"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="快速查找标题或编号…"
                          className="w-full h-8.5 pl-8.5 pr-3 rounded-full bg-[var(--p-field)] text-[12.5px] text-[var(--p-ink)] placeholder:text-[var(--p-ink-3)] focus:outline-none focus:bg-[var(--p-surface)] focus:shadow-[0_0_0_1.5px_var(--p-cobalt)] transition-all"
                        />
                      </div>
                    </div>
                  )}

                  {/* Single-Column Progress Cards */}
                  {loadingList && currentList.length === 0 ? (
                    <div className="space-y-3">
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className="h-28 rounded-[14px] bg-[var(--p-canvas)] animate-pulse"
                        />
                      ))}
                    </div>
                  ) : filteredTasks.length === 0 ? (
                    <div className="rd-portal-dots rounded-[20px] bg-[var(--p-canvas)] p-10 sm:p-14 text-center shadow-[var(--p-shadow-hairline)] space-y-4">
                      <div className="w-11 h-11 rounded-[12px] bg-[var(--p-surface)] shadow-[var(--p-shadow-card)] text-[var(--p-ink-3)] flex items-center justify-center mx-auto">
                        <Icon name="inbox" size={20} />
                      </div>
                      <div className="space-y-1.5 max-w-sm mx-auto">
                        <p className="text-[15.5px] font-semibold text-[var(--p-ink)]">
                          {currentList.length === 0
                            ? tab === "team"
                              ? "还没有团队反馈动态"
                              : "还没有提交过反馈"
                            : "没有符合当前筛选的记录"}
                        </p>
                        <p className="text-[13px] text-[var(--p-ink-2)]">
                          {currentList.length === 0
                            ? "遇到问题或有产品想法？写下来后，这里会持续同步每一阶段的处理进度。"
                            : "试试切换筛选标签或清空搜索词。"}
                        </p>
                      </div>
                      {currentList.length === 0 && (
                        <div className="pt-1">
                          <button
                            type="button"
                            onClick={() => setTab("submit")}
                            className="inline-flex items-center gap-1.5 h-9 px-4.5 rounded-full bg-[var(--p-ink)] text-[var(--p-page)] text-[13px] font-medium hover:opacity-90 active:scale-[0.97] transition-all cursor-pointer"
                          >
                            <Icon name="pen-line" size={14} />
                            <span>去表达第一条反馈</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3.5">
                      {filteredTasks.map((t) => {
                        const vis = resolveStatusVisual(t.status_label);
                        const actionBanner = t.can_reply
                          ? {
                              label: "团队邀请你补充更多信息，点击回复后自动继续处理",
                              icon: "message-square-plus",
                              tone: "vermilion" as const,
                            }
                          : t.can_accept
                            ? {
                                label: "修复已发布上线，点击确认问题是否已解决",
                                icon: "rocket",
                                tone: "forest" as const,
                              }
                            : t.can_request_deploy
                              ? {
                                  label: "修复已就绪，点击可申请 AI 评估提前发布上线",
                                  icon: "zap",
                                  tone: "cobalt" as const,
                                }
                              : null;

                        return (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setSelectedTaskId(t.id)}
                            className="group w-full text-left rounded-[14px] bg-[var(--p-surface)] shadow-[var(--p-shadow-card)] hover:-translate-y-0.5 transition-all duration-150 cursor-pointer overflow-hidden"
                          >
                            <div className="p-5 sm:p-6 space-y-4">
                              {/* Meta row */}
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="font-mono text-[12px] font-medium text-[var(--p-ink-3)] tabular-nums">
                                    {t.code}
                                  </span>
                                  {tab === "team" && t.owned && (
                                    <span className="px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-[var(--p-cobalt-tint)] text-[var(--p-cobalt)]">
                                      我提交的
                                    </span>
                                  )}
                                  <span className="text-[var(--p-line-strong)]">·</span>
                                  <span className="text-[12px] text-[var(--p-ink-3)] tabular-nums">
                                    {formatRelativeTime(t.created_at)}
                                  </span>
                                </div>

                                <span
                                  className={cn(
                                    "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11.5px] font-medium border",
                                    vis.badgeClass,
                                  )}
                                >
                                  <LivePulseDot tone={vis.dotTone} active={vis.pulse} />
                                  <span>{t.status_label}</span>
                                </span>
                              </div>

                              {/* Title */}
                              <div className="flex items-start justify-between gap-4">
                                <h3 className="text-[15.5px] sm:text-[16.5px] font-semibold tracking-[-0.015em] text-[var(--p-ink)] leading-snug group-hover:text-[var(--p-cobalt)] transition-colors">
                                  {t.title}
                                </h3>
                                <Icon
                                  name="arrow-right"
                                  size={16}
                                  className="text-[var(--p-ink-3)] group-hover:text-[var(--p-ink)] group-hover:translate-x-0.5 transition-all shrink-0 mt-1"
                                />
                              </div>

                              {/* Inline 5-step visual progress bar */}
                              <div className="grid grid-cols-5 gap-1.5 pt-0.5">
                                {LIFECYCLE_STEPS.map((step, idx) => {
                                  const done = idx < vis.stepIndex;
                                  const current = idx === vis.stepIndex;
                                  return (
                                    <div key={step.key} className="space-y-1">
                                      <div className="h-1.5 rounded-full overflow-hidden bg-[var(--p-field)]">
                                        <div
                                          className={cn(
                                            "h-full rounded-full transition-all duration-500",
                                            done
                                              ? "w-full bg-[var(--p-forest)]"
                                              : current
                                                ? vis.dotTone === "amber"
                                                  ? "w-full bg-[var(--p-vermilion)]"
                                                  : vis.dotTone === "emerald"
                                                    ? "w-full bg-[var(--p-forest)]"
                                                    : "w-full bg-[var(--p-cobalt)]"
                                                : "w-0",
                                          )}
                                        />
                                      </div>
                                      <span
                                        className={cn(
                                          "block text-[10.5px] truncate",
                                          current
                                            ? "font-medium text-[var(--p-ink)]"
                                            : done
                                              ? "text-[var(--p-forest)]"
                                              : "text-[var(--p-ink-3)]",
                                        )}
                                      >
                                        {step.label}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>

                            {actionBanner && (
                              <div
                                className={cn(
                                  "px-5 sm:px-6 py-2.5 border-t border-dashed border-[var(--p-line)] flex items-center justify-between gap-2 text-[12px] font-medium",
                                  actionBanner.tone === "vermilion"
                                    ? "bg-[var(--p-vermilion-tint)] text-[var(--p-vermilion)]"
                                    : actionBanner.tone === "forest"
                                      ? "bg-[var(--p-forest-tint)] text-[var(--p-forest)]"
                                      : "bg-[var(--p-cobalt-tint)] text-[var(--p-cobalt)]",
                                )}
                              >
                                <span className="inline-flex items-center gap-1.5 min-w-0 truncate">
                                  <Icon name={actionBanner.icon} size={13.5} className="shrink-0" />
                                  <span className="truncate">{actionBanner.label}</span>
                                </span>
                                <span className="shrink-0">去处理 →</span>
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                /* ── FOCUSED STORY / DETAIL VIEW (SINGLE COLUMN) ── */
                <div className="space-y-6 animate-rd-portal-in">
                  {/* Top Breadcrumb Bar */}
                  <div className="flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => setSelectedTaskId(null)}
                      className="inline-flex items-center gap-1.5 h-8.5 px-3.5 rounded-full bg-[var(--p-field)] text-[12.5px] font-medium text-[var(--p-ink)] hover:bg-[var(--p-hover)] transition-colors cursor-pointer"
                    >
                      <Icon name="arrow-left" size={14} />
                      <span>{tab === "team" ? "返回团队动态" : "返回我的反馈"}</span>
                    </button>

                    {detail && (
                      <button
                        type="button"
                        onClick={() => void loadTaskDetail(detail.task.id, false)}
                        className="inline-flex items-center gap-1.5 h-8.5 px-3 rounded-full text-[12.5px] font-medium text-[var(--p-ink-2)] hover:text-[var(--p-ink)] hover:bg-[var(--p-hover)] transition-colors cursor-pointer"
                      >
                        <Icon name="refresh-cw" size={13} />
                        <span>刷新进度</span>
                      </button>
                    )}
                  </div>

                  {loadingDetail && !detail ? (
                    <div className="rounded-[16px] bg-[var(--p-surface)] shadow-[var(--p-shadow-card)] p-6 sm:p-8 space-y-5">
                      <div className="h-7 w-2/3 rounded-lg bg-[var(--p-canvas)] animate-pulse" />
                      <div className="h-14 rounded-xl bg-[var(--p-canvas)] animate-pulse" />
                      <div className="h-36 rounded-xl bg-[var(--p-canvas)] animate-pulse" />
                    </div>
                  ) : detail ? (
                    <article className="space-y-7">
                      {/* Story Header & Progress Track */}
                      <div className="rounded-[16px] bg-[var(--p-surface)] shadow-[var(--p-shadow-card)] p-5 sm:p-7 space-y-6">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <CopyButton
                              value={detail.task.code}
                              label={detail.task.code}
                              copiedLabel="已复制"
                              size="xs"
                              variant="secondary"
                            />
                            <span
                              title={formatDateTime(detail.task.created_at)}
                              className="text-[12px] text-[var(--p-ink-3)] tabular-nums"
                            >
                              提交于 {formatDateTime(detail.task.created_at)}
                            </span>
                          </div>

                          <h2 className="text-[22px] sm:text-[26px] font-semibold tracking-[-0.025em] leading-snug text-[var(--p-ink)]">
                            {detail.task.title}
                          </h2>

                          {(() => {
                            const vis = resolveStatusVisual(detail.task.status_label);
                            return (
                              <div className="flex flex-wrap items-center gap-2.5">
                                <span
                                  className={cn(
                                    "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium border",
                                    vis.badgeClass,
                                  )}
                                >
                                  <LivePulseDot tone={vis.dotTone} active={vis.pulse} />
                                  <span>{detail.task.status_label}</span>
                                </span>
                                {vis.specialNote && (
                                  <span className="text-[12.5px] text-[var(--p-ink-2)]">
                                    {vis.specialNote}
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                        </div>

                        {/* Numbered 5-Step Lifecycle Progress Track */}
                        {(() => {
                          const vis = resolveStatusVisual(detail.task.status_label);
                          return (
                            <div className="pt-5 border-t border-dashed border-[var(--p-line)]">
                              <div className="grid grid-cols-5 gap-2">
                                {LIFECYCLE_STEPS.map((step, idx) => {
                                  const done = idx < vis.stepIndex;
                                  const current = idx === vis.stepIndex;
                                  return (
                                    <div key={step.key} className="space-y-2">
                                      <div className="h-2 rounded-full overflow-hidden bg-[var(--p-field)]">
                                        <div
                                          className={cn(
                                            "h-full rounded-full transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
                                            done
                                              ? "w-full bg-[var(--p-forest)]"
                                              : current
                                                ? vis.dotTone === "amber"
                                                  ? "w-full bg-[var(--p-vermilion)]"
                                                  : vis.dotTone === "emerald"
                                                    ? "w-full bg-[var(--p-forest)]"
                                                    : "w-full bg-[var(--p-cobalt)]"
                                                : "w-0",
                                          )}
                                        />
                                      </div>
                                      <div className="space-y-0.5">
                                        <span className="hidden sm:block font-mono text-[10px] text-[var(--p-ink-3)] tabular-nums">
                                          0{idx + 1}
                                        </span>
                                        <div
                                          className={cn(
                                            "text-[11.5px] font-medium truncate",
                                            current
                                              ? "text-[var(--p-ink)]"
                                              : done
                                                ? "text-[var(--p-forest)]"
                                                : "text-[var(--p-ink-3)]",
                                          )}
                                        >
                                          {step.label}
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}
                      </div>

                      {/* Online Acceptance Action Card */}
                      {detail.task.can_accept && (
                        <div className="rounded-[14px] bg-[var(--p-forest-tint)] p-5 space-y-3.5 animate-rd-portal-in">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--p-ink)]">
                                <Icon
                                  name="rocket"
                                  size={15}
                                  className="text-[var(--p-forest)]"
                                />
                                <span>修复已发布上线，请确认问题是否已解决</span>
                              </div>
                              <p className="text-[12.5px] text-[var(--p-ink-2)]">
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
                            <div className="space-y-2.5 pt-3 border-t border-dashed border-[var(--p-line)] animate-rd-portal-in">
                              <textarea
                                rows={2}
                                maxLength={4000}
                                value={brokenNote}
                                onChange={(e) => setBrokenNote(e.target.value)}
                                placeholder="请简单说明仍然存在的问题或新的现象（可选）…"
                                className="w-full rounded-[10px] bg-[var(--p-surface)] shadow-[var(--p-shadow-hairline)] px-3.5 py-2.5 text-[13px] text-[var(--p-ink)] placeholder:text-[var(--p-ink-3)] focus:outline-none focus:shadow-[0_0_0_1.5px_var(--p-cobalt)]"
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

                      {/* Reply composer when team requested clarification */}
                      {detail.task.can_reply && (
                        <form
                          onSubmit={(e) => void handleReplySubmit(e)}
                          className="rounded-[14px] bg-[var(--p-vermilion-tint)] p-5 space-y-3 animate-rd-portal-in"
                        >
                          <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--p-ink)]">
                            <Icon
                              name="message-square-plus"
                              size={15}
                              className="text-[var(--p-vermilion)]"
                            />
                            <span>请补充更多信息，回复后将自动继续处理</span>
                          </div>
                          <textarea
                            required
                            rows={3}
                            maxLength={8000}
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            placeholder="输入补充说明、复现环境或操作步骤…"
                            className="w-full rounded-[10px] bg-[var(--p-surface)] shadow-[var(--p-shadow-hairline)] p-3 text-[13.5px] text-[var(--p-ink)] placeholder:text-[var(--p-ink-3)] focus:outline-none focus:shadow-[0_0_0_1.5px_var(--p-cobalt)]"
                          />
                          <div className="flex justify-end">
                            <button
                              type="submit"
                              disabled={sendingReply || !replyText.trim()}
                              className="inline-flex items-center gap-1.5 h-8.5 px-4 rounded-full bg-[var(--p-ink)] text-[var(--p-page)] text-[12.5px] font-medium hover:opacity-90 active:scale-[0.97] transition-all disabled:opacity-45 cursor-pointer"
                            >
                              {sendingReply ? (
                                <Icon name="loader-2" size={13} className="animate-spin" />
                              ) : (
                                <Icon name="send" size={13} />
                              )}
                              <span>发送补充说明</span>
                            </button>
                          </div>
                        </form>
                      )}

                      {/* Editorial Public Message Timeline */}
                      <div className="space-y-4">
                        <div className="flex items-center gap-2 text-[12px]">
                          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--p-ink-3)]">
                            沟通与进度记录
                          </span>
                          <span className="h-px flex-1 border-b border-dashed border-[var(--p-line)]" />
                        </div>

                        {detail.messages.length === 0 ? (
                          <p className="text-[13px] text-[var(--p-ink-3)] py-4">
                            暂无公开留言记录。
                          </p>
                        ) : (
                          <div className="space-y-3">
                            {detail.messages.map((msg) => {
                              const isReporter = msg.author === "reporter";
                              return (
                                <div
                                  key={msg.id}
                                  className={cn(
                                    "rounded-[14px] p-4 sm:p-5 space-y-2.5",
                                    isReporter
                                      ? "bg-[var(--p-surface)] shadow-[var(--p-shadow-hairline)]"
                                      : "bg-[var(--p-cobalt-tint)]/65 shadow-[var(--p-shadow-hairline)]",
                                  )}
                                >
                                  <div className="flex items-center justify-between gap-2 text-[12px]">
                                    <span className="inline-flex items-center gap-2 font-semibold text-[var(--p-ink)]">
                                      <span
                                        className={cn(
                                          "w-6 h-6 rounded-[7px] inline-flex items-center justify-center",
                                          isReporter
                                            ? "bg-[var(--p-field)] text-[var(--p-ink-2)]"
                                            : "bg-[var(--p-surface)] text-[var(--p-cobalt)] shadow-2xs",
                                        )}
                                      >
                                        <Icon
                                          name={isReporter ? "user" : "sparkles"}
                                          size={12.5}
                                        />
                                      </span>
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
                                      className="font-mono text-[11px] text-[var(--p-ink-3)] tabular-nums"
                                    >
                                      {formatDateTime(msg.created_at)}
                                    </span>
                                  </div>
                                  <div className="text-[13.5px] leading-relaxed text-[var(--p-ink-2)]">
                                    <MarkdownContent content={msg.body} />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </article>
                  ) : null}
                </div>
              )}
            </div>
          )}
        </main>

        {/* Minimal Editorial Footer */}
        <footer className="mt-auto border-t border-dashed border-[var(--p-line)] px-5 sm:px-9 py-4 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[var(--p-ink-3)]">
          <span className="font-mono">{config.project_name} · Feedback Portal</span>
          <span>由 Relaydesk 驱动</span>
        </footer>
      </div>

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
