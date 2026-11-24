import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Icon } from "./Icon.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { Button, LivePulseDot, Switch, cn, useToast } from "./ui.tsx";
import { PortalApiError } from "~/lib/portal-api.ts";
import {
  DIAGNOSE_MAX_MESSAGE_CHARS,
  normalizeDiagnosePayload,
} from "~/lib/feedback-diagnose.ts";
import type {
  FeedbackDiagnoseMessage,
  FeedbackDiagnoseOutcome,
  FeedbackDiagnoseResponse,
  FeedbackReleasePreference,
  PortalConfig,
  PortalTaskDetail,
} from "~/lib/portal-types.ts";

export interface PortalUploadedImage {
  id: string;
  previewUrl: string;
  remoteUrl: string;
  uploading: boolean;
}

interface ConversationTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  images?: string[];
  outcome?: FeedbackDiagnoseOutcome;
}

interface EditableDraftState {
  turnId: string;
  title: string;
  body: string;
  images: string[];
  releasePreference: FeedbackReleasePreference;
  dismissed: boolean;
}

interface PortalFeedbackConversationProps {
  config: PortalConfig;
  stagedImages: PortalUploadedImage[];
  onUploadFiles: (files: FileList | File[]) => Promise<void>;
  onRemoveStagedImage: (id: string) => void;
  onClearStagedImages: () => void;
  onOpenLightbox: (src: string) => void;
  onDiagnose: (
    payload: { messages: FeedbackDiagnoseMessage[]; images?: string[] },
    signal?: AbortSignal,
  ) => Promise<FeedbackDiagnoseResponse>;
  onCreateTask: (payload: {
    title: string;
    body: string;
    type: string;
    images: string[];
    release_preference: FeedbackReleasePreference;
  }) => Promise<PortalTaskDetail>;
  onSwitchToManual: (prefill: {
    body: string;
    extraImageUrls: string[];
  }) => void;
  onPossibleAuthError: (err: unknown) => boolean;
}

const STARTERS = [
  {
    id: "bug",
    icon: "alert-circle",
    label: "页面或功能异常",
    prompt: "我在这个页面遇到了一个异常：",
  },
  {
    id: "usage",
    icon: "book-open",
    label: "这个功能怎么用",
    prompt: "请问这个功能应该怎么操作或配置：",
  },
  {
    id: "check",
    icon: "search",
    label: "帮忙排查问题原因",
    prompt: "我按常规步骤操作但结果和预期不符：",
  },
] as const;

const OUTCOME_META: Record<
  FeedbackDiagnoseOutcome,
  { label: string; icon: string; badgeClass: string }
> = {
  clarify: {
    label: "需要补充信息",
    icon: "help-circle",
    badgeClass:
      "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  usage: {
    label: "使用指导 · 无需建单",
    icon: "book-open",
    badgeClass:
      "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  suspected_bug: {
    label: "疑似功能故障 · 待确认草稿",
    icon: "file-warning",
    badgeClass:
      "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-300",
  },
};

function makeTurnId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dedupeUrls(urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

export function PortalFeedbackConversation({
  config,
  stagedImages,
  onUploadFiles,
  onRemoveStagedImage,
  onClearStagedImages,
  onOpenLightbox,
  onDiagnose,
  onCreateTask,
  onSwitchToManual,
  onPossibleAuthError,
}: PortalFeedbackConversationProps) {
  const toast = useToast();
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [input, setInput] = useState("");
  const [diagnosing, setDiagnosing] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
  const [historyTrimmedHint, setHistoryTrimmedHint] = useState(false);
  const [draft, setDraft] = useState<EditableDraftState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const threadContainerRef = useRef<HTMLDivElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  // Elapsed timer while a genuine /diagnose request is in flight
  useEffect(() => {
    if (!diagnosing) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 100);
    return () => window.clearInterval(timer);
  }, [diagnosing]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const conversationImages = useMemo(() => {
    const urls: string[] = [];
    for (const t of turns) {
      if (t.images?.length) urls.push(...t.images);
    }
    for (const img of stagedImages) {
      if (img.remoteUrl && !img.uploading) urls.push(img.remoteUrl);
    }
    return dedupeUrls(urls).slice(-6);
  }, [turns, stagedImages]);

  // Keep open draft images synced when user uploads new screenshots while reviewing draft
  useEffect(() => {
    if (!draft || draft.dismissed) return;
    const readyStaged = stagedImages
      .filter((img) => img.remoteUrl && !img.uploading)
      .map((img) => img.remoteUrl);
    if (readyStaged.length === 0) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const merged = dedupeUrls([...prev.images, ...readyStaged]).slice(0, 6);
      if (merged.length === prev.images.length) return prev;
      return { ...prev, images: merged };
    });
  }, [stagedImages, draft]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const container = threadContainerRef.current;
      if (container && container.scrollHeight > container.clientHeight + 4) {
        container.scrollTop = container.scrollHeight;
        return;
      }
      threadEndRef.current?.scrollIntoView({ behavior: "auto", block: "nearest" });
    });
  }, []);

  useEffect(() => {
    if (turns.length === 0) return;
    scrollToEnd();
  }, [turns.length, draft?.turnId, draft?.dismissed, diagnosing, diagnoseError, scrollToEnd]);

  const runDiagnose = useCallback(
    async (nextTurns: ConversationTurn[], imageUrls: string[]) => {
      const normalized = normalizeDiagnosePayload(
        nextTurns.map((t) => ({ role: t.role, text: t.text })),
        imageUrls,
      );
      if (normalized.messages.length === 0) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setDiagnosing(true);
      setDiagnoseError(null);
      setHistoryTrimmedHint(normalized.trimmedHistory || normalized.clampedMessage);

      try {
        const res = await onDiagnose(
          normalized.images.length > 0
            ? { messages: normalized.messages, images: normalized.images }
            : { messages: normalized.messages },
          controller.signal,
        );
        const turnId = makeTurnId();
        const outcome: FeedbackDiagnoseOutcome =
          res.outcome === "usage" || res.outcome === "suspected_bug"
            ? res.outcome
            : "clarify";
        const replyText =
          typeof res.reply === "string" && res.reply.trim()
            ? res.reply.trim()
            : outcome === "suspected_bug"
              ? "已整理出疑似故障草稿，请核对下方内容并确认是否提交工单。"
              : "请继续补充更多细节，我会结合说明帮你进一步定位。";

        const assistantTurn: ConversationTurn = {
          id: turnId,
          role: "assistant",
          text: replyText,
          outcome,
        };
        setTurns((prev) => [...prev, assistantTurn]);

        if (outcome === "suspected_bug") {
          const fallbackBody = nextTurns
            .filter((t) => t.role === "user")
            .map((t) => t.text)
            .join("\n\n");
          const draftTitle =
            res.draft?.title?.trim() ||
            fallbackBody.split(/\r?\n/)[0]?.slice(0, 80) ||
            "功能异常反馈";
          const draftBody = res.draft?.body?.trim() || fallbackBody;
          setDraft({
            turnId,
            title: draftTitle,
            body: draftBody,
            images: normalized.images,
            releasePreference: "default",
            dismissed: false,
          });
        } else {
          setDraft(null);
        }
        scrollToEnd();
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setDiagnoseError("已取消本轮诊断。你可以点击「重试本轮」，或补充文字后重新发送。");
          return;
        }
        if (onPossibleAuthError(err)) return;
        const msg =
          err instanceof PortalApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "反馈诊断请求失败，你可以重试或直接改用人工提单。";
        setDiagnoseError(msg);
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setDiagnosing(false);
      }
    },
    [onDiagnose, onPossibleAuthError, scrollToEnd],
  );

  const handleSend = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (diagnosing) {
        abortRef.current?.abort();
        return;
      }
      const trimmed = input.trim();
      const anyUploading = stagedImages.some((i) => i.uploading);
      if (anyUploading) {
        toast.info("请等待截图上传完成后再发送");
        return;
      }
      if (!trimmed) {
        if (stagedImages.length > 0) {
          toast.info("请先用文字简述问题现象（截图将作为附件保留，当前诊断不读取图片内容）");
          inputRef.current?.focus();
        }
        return;
      }

      const turnImageUrls = stagedImages
        .filter((i) => i.remoteUrl && !i.uploading)
        .map((i) => i.remoteUrl);

      const userTurn: ConversationTurn = {
        id: makeTurnId(),
        role: "user",
        text: trimmed,
        images: turnImageUrls.length > 0 ? turnImageUrls : undefined,
      };
      const nextTurns = [...turns, userTurn];
      const allImages = dedupeUrls([
        ...turns.flatMap((t) => t.images ?? []),
        ...turnImageUrls,
      ]).slice(-6);

      setTurns(nextTurns);
      setInput("");
      setDraft(null);
      if (turnImageUrls.length > 0) {
        onClearStagedImages();
      }
      scrollToEnd();
      await runDiagnose(nextTurns, allImages);
    },
    [
      diagnosing,
      input,
      stagedImages,
      turns,
      toast,
      onClearStagedImages,
      scrollToEnd,
      runDiagnose,
    ],
  );

  const handleRetryLast = () => {
    if (diagnosing || turns.length === 0) return;
    const allImages = dedupeUrls(turns.flatMap((t) => t.images ?? [])).slice(-6);
    void runDiagnose(turns, allImages);
  };

  const handleReset = () => {
    abortRef.current?.abort();
    setTurns([]);
    setInput("");
    setDraft(null);
    setDiagnoseError(null);
    setHistoryTrimmedHint(false);
    onClearStagedImages();
    inputRef.current?.focus();
  };

  const handleManualEscalation = () => {
    abortRef.current?.abort();
    const userSummary = turns
      .filter((t) => t.role === "user")
      .map((t) => t.text)
      .join("\n\n");
    const prefillBody = draft?.body?.trim()
      ? draft.body.trim()
      : [userSummary, input.trim()].filter(Boolean).join("\n\n");
    const extraImageUrls = dedupeUrls([
      ...turns.flatMap((t) => t.images ?? []),
      ...(draft?.images ?? []),
    ]);
    onSwitchToManual({ body: prefillBody, extraImageUrls });
  };

  const handleConfirmDraft = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft || confirming) return;
    const cleanTitle = draft.title.trim();
    const cleanBody = draft.body.trim();
    if (!cleanBody) {
      toast.error("请填写工单详情描述后再确认提交");
      return;
    }
    setConfirming(true);
    try {
      await onCreateTask({
        title: cleanTitle || cleanBody.split(/\r?\n/)[0].slice(0, 80),
        body: cleanBody,
        type: "功能异常",
        images: dedupeUrls(draft.images).slice(0, 6),
        release_preference: config.can_request_deploy
          ? draft.releasePreference
          : "default",
      });
      setTurns([]);
      setInput("");
      setDraft(null);
      setDiagnoseError(null);
      setHistoryTrimmedHint(false);
      onClearStagedImages();
    } catch (err) {
      if (onPossibleAuthError(err)) return;
      toast.error(err instanceof Error ? err.message : "提交工单失败，请重试");
    } finally {
      setConfirming(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  };

  const hasUploading = stagedImages.some((img) => img.uploading);
  const canSend = !hasUploading && input.trim().length > 0;

  return (
    <section
      data-testid="portal-agent-conversation"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) {
          void onUploadFiles(e.dataTransfer.files);
        }
      }}
      className={cn(
        "rounded-2xl border bg-[var(--surface-card)] overflow-hidden shadow-[var(--rd-shadow-sm)] rd-hairline-glow transition-all duration-200 flex flex-col",
        dragOver
          ? "border-indigo-500 ring-2 ring-indigo-500/20"
          : "border-[var(--border-subtle)]",
      )}
    >
      {/* Conversation Header */}
      <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2.5 bg-[var(--surface-card)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-indigo-500/25 bg-indigo-500/[0.08] text-[11.5px] font-medium text-indigo-700 dark:text-indigo-300">
            <LivePulseDot tone="indigo" active={!diagnosing} />
            <span>反馈诊断对话</span>
          </div>
          <span className="text-[12px] text-[var(--text-muted)] hidden sm:inline truncate">
            先核实问题，疑似故障再经你确认建单
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {turns.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              icon="rotate-ccw"
              disabled={diagnosing}
              onClick={handleReset}
            >
              新对话
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="xs"
            icon="file-pen-line"
            data-testid="portal-switch-manual"
            onClick={handleManualEscalation}
          >
            人工直接提单
          </Button>
        </div>
      </div>

      {/* Thread Viewport: flow naturally on narrow mobile screens so the draft confirm CTA is never clipped/covered by the composer dock */}
      <div
        ref={threadContainerRef}
        className="px-4 sm:px-5 pt-5 pb-6 sm:pb-8 space-y-4 min-h-[260px] sm:min-h-[300px] sm:max-h-[62vh] sm:overflow-y-auto rd-scroll"
      >
        {turns.length === 0 ? (
          <div className="py-6 sm:py-8 max-w-lg mx-auto text-center space-y-5 animate-rd-msg-in">
            <div className="mx-auto w-11 h-11 rounded-2xl border border-indigo-500/20 bg-indigo-500/[0.08] text-indigo-600 dark:text-indigo-400 flex items-center justify-center shadow-2xs">
              <Icon name="message-square-text" size={20} />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-[16px] font-semibold tracking-tight text-[var(--text-primary)]">
                遇到问题或使用疑问？直接告诉我
              </h2>
              <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                我会结合「{config.project_name}」的公开使用说明与你连续排查：若属于用法或配置问题会直接解答而不建单；若信息不足会继续追问；仅当疑似功能故障时才为你生成可编辑草稿，经你确认后才会正式提单。
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              {STARTERS.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  style={{ animationDelay: `${idx * 45}ms` }}
                  onClick={() => {
                    setInput(s.prompt);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  className="animate-rd-chip-pop inline-flex items-center gap-1.5 h-8.5 px-3 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-elevated)] hover:border-indigo-500/45 hover:bg-indigo-500/[0.06] text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all cursor-pointer"
                >
                  <Icon
                    name={s.icon}
                    size={13}
                    className="text-indigo-500 shrink-0"
                  />
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {turns.map((turn) => {
              if (turn.role === "user") {
                return (
                  <div
                    key={turn.id}
                    data-testid="portal-turn-user"
                    className="flex flex-col items-end gap-1.5 animate-rd-msg-in"
                  >
                    {turn.images && turn.images.length > 0 && (
                      <div className="flex flex-wrap justify-end gap-2 max-w-[85%]">
                        {turn.images.map((url) => (
                          <button
                            key={url}
                            type="button"
                            onClick={() => onOpenLightbox(url)}
                            className="w-20 h-16 rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface-elevated)] hover:border-indigo-500/60 transition-colors cursor-zoom-in"
                          >
                            <img
                              src={url}
                              alt="已附带截图"
                              className="w-full h-full object-cover"
                            />
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-950 px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words shadow-2xs">
                      {turn.text}
                    </div>
                    {turn.images && turn.images.length > 0 && (
                      <span className="text-[11px] text-[var(--text-muted)]">
                        已附带 {turn.images.length} 张截图作为附件（确认建单时将随草稿转交研发，本轮不读图）
                      </span>
                    )}
                  </div>
                );
              }

              const meta = turn.outcome ? OUTCOME_META[turn.outcome] : null;
              const isActiveDraftTurn =
                draft && !draft.dismissed && draft.turnId === turn.id;

              return (
                <div
                  key={turn.id}
                  data-testid="portal-turn-assistant"
                  data-outcome={turn.outcome || ""}
                  className="space-y-2.5 animate-rd-msg-in"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--text-primary)]">
                      <span className="w-5 h-5 rounded-md bg-indigo-500/12 border border-indigo-500/20 text-indigo-600 dark:text-indigo-400 inline-flex items-center justify-center">
                        <Icon name="sparkles" size={11} />
                      </span>
                      <span>反馈诊断助手</span>
                    </span>
                    {meta && (
                      <span
                        data-testid={`portal-outcome-${turn.outcome}`}
                        className={cn(
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium",
                          meta.badgeClass,
                        )}
                      >
                        <Icon name={meta.icon} size={11} />
                        <span>{meta.label}</span>
                      </span>
                    )}
                  </div>

                  <div className="max-w-[92%] rounded-2xl rounded-tl-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-4 py-3 text-[13.5px] leading-relaxed text-[var(--text-primary)] shadow-2xs space-y-3">
                    <MarkdownContent content={turn.text} />

                    {turn.outcome === "usage" && (
                      <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
                        <span className="text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1.5 font-medium">
                          <Icon name="check-circle-2" size={13} />
                          <span>以上为使用指导，未创建研发工单</span>
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleReset}
                            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 cursor-pointer"
                          >
                            已解决，开始新对话
                          </button>
                          <span className="text-[var(--border-strong)]">·</span>
                          <button
                            type="button"
                            onClick={handleManualEscalation}
                            className="text-indigo-600 dark:text-indigo-400 hover:underline underline-offset-2 font-medium cursor-pointer"
                          >
                            仍未解决，人工提单
                          </button>
                        </div>
                      </div>
                    )}

                    {turn.outcome === "clarify" && (
                      <div className="pt-2 border-t border-[var(--border-subtle)] text-[11.5px] text-[var(--text-muted)] flex items-center gap-1.5">
                        <Icon name="corner-down-right" size={12} />
                        <span>请在下方继续补充细节，我会结合历史对话进一步判断。</span>
                      </div>
                    )}
                  </div>

                  {/* Tool-Approval inspired Editable Draft Confirmation Card */}
                  {isActiveDraftTurn && (
                    <form
                      data-testid="portal-draft-card"
                      onSubmit={(e) => void handleConfirmDraft(e)}
                      className="max-w-full sm:max-w-[96%] scroll-my-16 rounded-2xl border border-amber-500/35 bg-[var(--surface-card)] shadow-[var(--rd-shadow-md)] overflow-hidden animate-rd-draft-reveal"
                    >
                      <div className="px-4 py-3 border-b border-amber-500/20 bg-amber-500/[0.06] flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300 inline-flex items-center justify-center shrink-0">
                            <Icon name="file-check-2" size={14} />
                          </span>
                          <div>
                            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                              疑似故障工单草稿 · 需你确认后提交
                            </h3>
                            <p className="text-[11px] text-[var(--text-muted)]">
                              尚未创建工单。你可以先修改标题、详情或增删截图，点击确认后正式进入处理队列。
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="p-4 space-y-3.5">
                        <label className="block space-y-1">
                          <span className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                            工单标题
                          </span>
                          <input
                            type="text"
                            data-testid="portal-draft-title"
                            maxLength={180}
                            required
                            value={draft.title}
                            onChange={(e) =>
                              setDraft((prev) =>
                                prev ? { ...prev, title: e.target.value } : prev,
                              )
                            }
                            placeholder="简明概括故障现象"
                            className="w-full h-9.5 px-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] font-medium text-[var(--text-primary)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                          />
                        </label>

                        <label className="block space-y-1">
                          <span className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                            故障详情与复现信息
                          </span>
                          <textarea
                            data-testid="portal-draft-body"
                            rows={5}
                            maxLength={20000}
                            required
                            value={draft.body}
                            onChange={(e) =>
                              setDraft((prev) =>
                                prev ? { ...prev, body: e.target.value } : prev,
                              )
                            }
                            placeholder="核对或补充复现步骤、报错信息与预期行为…"
                            className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3 text-[13px] leading-relaxed text-[var(--text-primary)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
                          />
                        </label>

                        {/* Draft R2 Attachments */}
                        {(draft.images.length > 0 || config.upload_enabled) && (
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                                随草稿转交研发的截图附件（{draft.images.length} / 6）
                              </span>
                              {config.upload_enabled && draft.images.length < 6 && (
                                <button
                                  type="button"
                                  onClick={() => fileInputRef.current?.click()}
                                  className="inline-flex items-center gap-1 text-[11.5px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                                >
                                  <Icon name="image-plus" size={12.5} />
                                  <span>补充截图</span>
                                </button>
                              )}
                            </div>
                            {draft.images.length > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {draft.images.map((url) => (
                                  <div
                                    key={url}
                                    className="relative group w-20 h-16 rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface-elevated)] animate-rd-chip-pop"
                                  >
                                    <img
                                      src={url}
                                      alt="草稿附件截图"
                                      onClick={() => onOpenLightbox(url)}
                                      className="w-full h-full object-cover cursor-zoom-in"
                                    />
                                    <button
                                      type="button"
                                      aria-label="从草稿移除截图"
                                      onClick={() =>
                                        setDraft((prev) =>
                                          prev
                                            ? {
                                                ...prev,
                                                images: prev.images.filter(
                                                  (u) => u !== url,
                                                ),
                                              }
                                            : prev,
                                        )
                                      }
                                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-black cursor-pointer"
                                    >
                                      <Icon name="x" size={10} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-[11px] text-[var(--text-muted)]">
                                如需辅助研发排查，可补充上传截图附件随工单转交。
                              </p>
                            )}
                          </div>
                        )}

                        {config.can_request_deploy && (
                          <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/[0.04] p-3">
                            <Switch
                              checked={
                                draft.releasePreference === "request_immediate"
                              }
                              onChange={(checked) =>
                                setDraft((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        releasePreference: checked
                                          ? "request_immediate"
                                          : "default",
                                      }
                                    : prev,
                                )
                              }
                              label="修复完成后，若线上空闲请 AI 评估即时发布"
                              description={
                                config.release_window
                                  ? `默认发布窗口 ${config.release_window}；勾选后修复完成将触发一次只读 AI 门禁评估。`
                                  : "勾选后修复完成将自动触发只读 AI 门禁评估，低风险时即时上线。"
                              }
                            />
                          </div>
                        )}
                      </div>

                      <div className="px-4 py-3 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          data-testid="portal-draft-dismiss"
                          disabled={confirming}
                          onClick={() => {
                            setDraft((prev) =>
                              prev ? { ...prev, dismissed: true } : prev,
                            );
                            inputRef.current?.focus();
                          }}
                        >
                          暂不提单，继续补充
                        </Button>
                        <Button
                          type="submit"
                          variant="primary"
                          size="sm"
                          icon="check"
                          data-testid="portal-draft-confirm"
                          className="scroll-mb-28"
                          loading={confirming}
                          disabled={!draft.body.trim() || confirming}
                        >
                          确认并提交工单
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}

            {/* Honest Diagnosing State (No fabricated runtime steps) */}
            {diagnosing && (
              <div
                data-testid="portal-diagnosing-indicator"
                className="flex items-center gap-2.5 py-1 animate-rd-msg-in"
              >
                <span className="w-5 h-5 rounded-md bg-indigo-500/12 border border-indigo-500/20 text-indigo-600 dark:text-indigo-400 inline-flex items-center justify-center shrink-0">
                  <Icon name="loader-2" size={11.5} className="animate-spin" />
                </span>
                <span className="text-[12.5px] font-medium rd-shimmer-text">
                  正在核对产品使用说明并分析你的描述…
                </span>
                <span className="text-[11px] font-mono text-[var(--text-muted)] tabular-nums">
                  {(elapsedMs / 1000).toFixed(1)}s
                </span>
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] underline underline-offset-2 cursor-pointer ml-1"
                >
                  取消
                </button>
              </div>
            )}

            {/* Honest Error Recovery Banner */}
            {diagnoseError && !diagnosing && (
              <div
                role="alert"
                data-testid="portal-diagnose-error"
                className="rounded-xl border border-rose-500/30 bg-rose-500/[0.07] p-3.5 space-y-2.5 animate-rd-msg-in"
              >
                <div className="flex items-start gap-2 text-[12.5px] text-rose-700 dark:text-rose-300">
                  <Icon name="alert-circle" size={14.5} className="shrink-0 mt-0.5" />
                  <span>{diagnoseError}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    icon="refresh-cw"
                    onClick={handleRetryLast}
                  >
                    重试本轮
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="xs"
                    icon="file-pen-line"
                    onClick={handleManualEscalation}
                  >
                    保留内容并改用人工提单
                  </Button>
                </div>
              </div>
            )}

            <div ref={threadEndRef} />
          </div>
        )}
      </div>

      {/* Prompt-Box Inspired Composer Dock */}
      <form
        onSubmit={(e) => void handleSend(e)}
        className="px-4 py-3.5 border-t border-[var(--border-subtle)] bg-[var(--surface-subtle)]/65 space-y-2.5"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void onUploadFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {/* Staged R2 screenshot chips */}
        {stagedImages.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-2">
              {stagedImages.map((img) => (
                <div
                  key={img.id}
                  className="relative group w-16 h-12 rounded-lg overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface-elevated)] animate-rd-chip-pop"
                >
                  <img
                    src={img.remoteUrl || img.previewUrl}
                    alt="待附带截图"
                    onClick={() => onOpenLightbox(img.remoteUrl || img.previewUrl)}
                    className={cn(
                      "w-full h-full object-cover cursor-zoom-in",
                      img.uploading && "opacity-45",
                    )}
                  />
                  {img.uploading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/35 text-white">
                      <Icon name="loader-2" size={14} className="animate-spin" />
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label="移除截图"
                    onClick={() => onRemoveStagedImage(img.id)}
                    className="absolute top-0.5 right-0.5 w-4.5 h-4.5 rounded-full bg-black/75 text-white flex items-center justify-center hover:bg-black cursor-pointer"
                  >
                    <Icon name="x" size={9} />
                  </button>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-[var(--text-muted)]">
              已附带截图将作为附件保留并在确认建单时转交研发；当前轮诊断仅分析文字描述，不读取图片内容。
            </p>
          </div>
        )}

        {historyTrimmedHint && (
          <p
            data-testid="portal-history-trimmed-hint"
            className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5"
          >
            <Icon name="info" size={12} className="shrink-0" />
            <span>对话较长，发送诊断时已自动保留最新上下文（最多 25 轮 / 单条 6000 字）。</span>
          </p>
        )}

        <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--surface-card)] focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/15 transition-all">
          <textarea
            ref={inputRef}
            data-testid="portal-chat-input"
            rows={2}
            maxLength={DIAGNOSE_MAX_MESSAGE_CHARS}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const files = e.clipboardData?.files;
              if (files && files.length > 0) {
                const imgs = Array.from(files).filter((f) =>
                  f.type.startsWith("image/"),
                );
                if (imgs.length > 0) {
                  e.preventDefault();
                  void onUploadFiles(imgs);
                }
              }
            }}
            placeholder={
              turns.length === 0
                ? "描述你遇到的现象、操作步骤或使用疑问…（Enter 发送，Shift+Enter 换行）"
                : "补充更多现象、报错信息或回答助手的追问…"
            }
            className="w-full px-3.5 pt-3 pb-1.5 bg-transparent text-[13.5px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none resize-none"
          />

          <div className="px-2.5 pb-2.5 pt-1 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {config.upload_enabled && (
                <button
                  type="button"
                  disabled={conversationImages.length >= 6}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 h-7.5 px-2.5 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-45 transition-colors cursor-pointer"
                >
                  <Icon name="image-plus" size={13.5} />
                  <span>附带截图</span>
                  {conversationImages.length > 0 && (
                    <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
                      {conversationImages.length}/6
                    </span>
                  )}
                </button>
              )}
              <span className="text-[11px] text-[var(--text-muted)] hidden sm:inline">
                以「{config.label}」身份沟通
              </span>
            </div>

            <div className="flex items-center gap-2">
              {input.length >= 4800 && (
                <span
                  data-testid="portal-char-counter"
                  className={cn(
                    "text-[11px] font-mono tabular-nums",
                    input.length >= DIAGNOSE_MAX_MESSAGE_CHARS
                      ? "text-amber-600 dark:text-amber-400 font-medium"
                      : "text-[var(--text-muted)]",
                  )}
                >
                  {input.length}/{DIAGNOSE_MAX_MESSAGE_CHARS}
                </span>
              )}
              <button
                type="submit"
                data-testid="portal-chat-send"
                disabled={!diagnosing && !canSend}
                aria-label={diagnosing ? "停止诊断" : "发送消息"}
                className={cn(
                  "inline-flex items-center justify-center gap-1.5 h-8 px-3.5 rounded-lg text-[12.5px] font-medium transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed",
                  diagnosing
                    ? "bg-rose-600 hover:bg-rose-700 text-white"
                    : "bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:hover:bg-white dark:text-zinc-950 shadow-2xs",
                )}
              >
                <Icon name={diagnosing ? "square" : "arrow-up"} size={13.5} />
                <span>{diagnosing ? "停止" : "发送"}</span>
              </button>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
