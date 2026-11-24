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
  FeedbackDiagnoseStreamEvent,
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
  streaming?: boolean;
}

interface EditableDraftState {
  turnId: string;
  title: string;
  body: string;
  images: string[];
  releasePreference: FeedbackReleasePreference;
  expanded: boolean;
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
    onEvent?: (event: FeedbackDiagnoseStreamEvent) => void,
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
  onRefreshConfig?: () => Promise<void> | void;
  onPossibleAuthError: (err: unknown) => boolean;
  onConversationActiveChange?: (active: boolean) => void;
}

const STARTERS = [
  {
    id: "bug",
    num: "01",
    icon: "alert-circle",
    tone: "vermilion",
    label: "页面或功能异常",
    hint: "描述操作步骤与异常表现",
    prompt: "我在这个页面遇到了一个异常：",
  },
  {
    id: "usage",
    num: "02",
    icon: "book-open",
    tone: "cobalt",
    label: "这个功能怎么用",
    hint: "不确定配置方式或操作入口",
    prompt: "请问这个功能应该怎么操作或配置：",
  },
  {
    id: "check",
    num: "03",
    icon: "search",
    tone: "forest",
    label: "结果与预期不符",
    hint: "附带截图一起定位原因",
    prompt: "我按常规步骤操作但结果和预期不符：",
  },
] as const;

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
  onRefreshConfig,
  onPossibleAuthError,
  onConversationActiveChange,
}: PortalFeedbackConversationProps) {
  const toast = useToast();
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [input, setInput] = useState("");
  const [diagnosing, setDiagnosing] = useState(false);
  const [statusLabel, setStatusLabel] = useState("正在排查问题…");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [diagnoseError, setDiagnoseError] = useState<{
    message: string;
    offline?: boolean;
  } | null>(null);
  const [historyTrimmedHint, setHistoryTrimmedHint] = useState(false);
  const [draft, setDraft] = useState<EditableDraftState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!draft || draft.dismissed) return;
    const readyStaged = stagedImages
      .filter((img) => img.remoteUrl && !img.uploading)
      .map((img) => img.remoteUrl);
    if (!readyStaged.length) return;
    setDraft((prev) => {
      if (!prev || prev.dismissed) return prev;
      const merged = dedupeUrls([...prev.images, ...readyStaged]).slice(0, 6);
      if (merged.length === prev.images.length) return prev;
      return { ...prev, images: merged };
    });
  }, [stagedImages, draft]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({ behavior, block: "nearest" });
    });
  }, []);

  const runDiagnoseTurn = useCallback(
    async (nextTurns: ConversationTurn[], allImageUrls: string[]) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const normalized = normalizeDiagnosePayload(
        nextTurns
          .filter((t) => !t.streaming)
          .map((t) => ({ role: t.role, text: t.text })),
        allImageUrls,
      );
      if (normalized.messages.length === 0) return;

      const assistantTurnId = makeTurnId();
      setHistoryTrimmedHint(normalized.trimmedHistory);
      setDiagnosing(true);
      setStatusLabel("正在分析问题与上下文…");
      setDiagnoseError(null);

      let streamed = "";
      let streamStarted = false;

      try {
        const res = await onDiagnose(
          {
            messages: normalized.messages,
            ...(normalized.images.length ? { images: normalized.images } : {}),
          },
          controller.signal,
          (ev) => {
            if (controller.signal.aborted) return;
            if (ev.type === "status") {
              setStatusLabel(ev.label || "正在排查问题…");
            } else if (ev.type === "delta" && ev.text) {
              streamed += ev.text;
              if (!streamStarted) {
                streamStarted = true;
                setTurns((prev) => [
                  ...prev,
                  {
                    id: assistantTurnId,
                    role: "assistant",
                    text: streamed,
                    streaming: true,
                  },
                ]);
              } else {
                const currentText = streamed;
                setTurns((prev) =>
                  prev.map((item) =>
                    item.id === assistantTurnId
                      ? { ...item, text: currentText }
                      : item,
                  ),
                );
              }
              scrollToLatest("auto");
            }
          },
        );
        if (controller.signal.aborted) return;

        const finalText = (res.reply || streamed).trim();
        setTurns((prev) => {
          const exists = prev.some((t) => t.id === assistantTurnId);
          if (exists) {
            return prev.map((item) =>
              item.id === assistantTurnId
                ? {
                    ...item,
                    text: finalText,
                    outcome: res.outcome,
                    streaming: false,
                  }
                : item,
            );
          }
          return [
            ...prev,
            {
              id: assistantTurnId,
              role: "assistant",
              text: finalText,
              outcome: res.outcome,
              streaming: false,
            },
          ];
        });

        if (res.outcome === "suspected_bug" && res.draft) {
          setDraft({
            turnId: assistantTurnId,
            title: res.draft.title.trim(),
            body: res.draft.body.trim(),
            images: dedupeUrls(allImageUrls).slice(0, 6),
            releasePreference: "default",
            expanded: false,
            dismissed: false,
          });
        } else {
          setDraft((prev) => (prev ? { ...prev, dismissed: true } : null));
        }

        scrollToLatest();
      } catch (err) {
        if (streamStarted) {
          setTurns((prev) =>
            prev.map((item) =>
              item.id === assistantTurnId ? { ...item, streaming: false } : item,
            ),
          );
        }
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          setDiagnoseError({
            message: "已停止本轮排查。你可以继续补充信息、重试，或直接提交工单。",
          });
          return;
        }
        if (onPossibleAuthError(err)) return;
        const isOffline =
          err instanceof PortalApiError &&
          (err.status === 503 || err.status === 409);
        const message =
          err instanceof Error
            ? err.message
            : "诊断请求失败，请稍后重试或直接提交反馈。";
        setDiagnoseError({ message, offline: isOffline });
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setDiagnosing(false);
      }
    },
    [onDiagnose, onPossibleAuthError, scrollToLatest],
  );

  const handleSend = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (diagnosing || confirming) return;
      if (stagedImages.some((img) => img.uploading)) {
        toast.info("请等待截图上传完成后再发送");
        return;
      }

      const trimmed = input.trim();
      if (!trimmed) {
        inputRef.current?.focus();
        return;
      }

      const turnImages = stagedImages
        .filter((img) => img.remoteUrl && !img.uploading)
        .map((img) => img.remoteUrl);

      const userTurn: ConversationTurn = {
        id: makeTurnId(),
        role: "user",
        text: trimmed,
        ...(turnImages.length ? { images: turnImages } : {}),
      };

      const nextTurns = [...turns, userTurn];
      const allImages = dedupeUrls([...conversationImages, ...turnImages]).slice(-6);

      setTurns(nextTurns);
      setInput("");
      if (turnImages.length) {
        onClearStagedImages();
      }
      scrollToLatest();

      await runDiagnoseTurn(nextTurns, allImages);
    },
    [
      confirming,
      conversationImages,
      diagnosing,
      input,
      onClearStagedImages,
      runDiagnoseTurn,
      scrollToLatest,
      stagedImages,
      toast,
      turns,
    ],
  );

  const handleRetryLast = () => {
    if (diagnosing || turns.length === 0) return;
    const cleanTurns = turns.filter((t) => !(t.role === "assistant" && !t.outcome));
    setTurns(cleanTurns);
    void runDiagnoseTurn(cleanTurns, conversationImages);
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleResetConversation = () => {
    abortRef.current?.abort();
    setTurns([]);
    setDraft(null);
    setDiagnoseError(null);
    setHistoryTrimmedHint(false);
    setInput("");
    onClearStagedImages();
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleSwitchManualClick = () => {
    abortRef.current?.abort();
    const userSummary = turns
      .filter((t) => t.role === "user")
      .map((t) => t.text.trim())
      .filter(Boolean)
      .join("\n\n");
    const draftBody =
      draft && !draft.dismissed && draft.body.trim()
        ? draft.body.trim()
        : [userSummary, input.trim()].filter(Boolean).join("\n\n");
    const extraImageUrls = dedupeUrls([
      ...conversationImages,
      ...(draft?.images ?? []),
    ]);
    onSwitchToManual({ body: draftBody, extraImageUrls });
  };

  const handleConfirmDraft = async () => {
    if (!draft || confirming || diagnosing) return;
    if (stagedImages.some((img) => img.uploading)) {
      toast.info("请等待截图上传完成后再提交");
      return;
    }
    const cleanTitle = draft.title.trim();
    const cleanBody = draft.body.trim();
    if (!cleanTitle || !cleanBody) {
      setDraft((prev) => (prev ? { ...prev, expanded: true } : prev));
      toast.error("请确认工单标题与详情内容不为空");
      return;
    }

    setConfirming(true);
    try {
      await onCreateTask({
        title: cleanTitle,
        body: cleanBody,
        type: "功能异常",
        images: draft.images,
        release_preference: draft.releasePreference,
      });
    } catch (err) {
      if (onPossibleAuthError(err)) return;
      toast.error(err instanceof Error ? err.message : "提交工单失败，请重试");
    } finally {
      setConfirming(false);
    }
  };

  const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  };

  const uploadingCount = stagedImages.filter((i) => i.uploading).length;
  const elapsedSeconds = (elapsedMs / 1000).toFixed(1);
  const canSend =
    Boolean(input.trim()) && !diagnosing && !confirming && uploadingCount === 0;
  const nearCharLimit = input.length >= Math.floor(DIAGNOSE_MAX_MESSAGE_CHARS * 0.75);
  const hasConversation = turns.length > 0;
  const activeStreamingTurn = turns.find((t) => t.streaming);

  useEffect(() => {
    onConversationActiveChange?.(hasConversation);
  }, [hasConversation, onConversationActiveChange]);

  const composerForm = (
    <form
      onSubmit={(e) => void handleSend(e)}
      className={cn("w-full", hasConversation ? "max-w-2xl mx-auto" : "")}
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

      <div
        className={cn(
          "rounded-[14px] bg-[var(--p-surface)] transition-all duration-200",
          dragOver
            ? "shadow-[0_0_0_2px_var(--p-cobalt),var(--p-shadow-composer)]"
            : "shadow-[var(--p-shadow-composer)] focus-within:shadow-[0_0_0_1.5px_var(--p-cobalt),var(--p-shadow-composer)]",
        )}
      >
        {/* Staged image chips inside composer */}
        {stagedImages.length > 0 && (
          <div className="px-4 pt-3.5 flex flex-wrap gap-2">
            {stagedImages.map((img) => (
              <div
                key={img.id}
                className="relative group w-15 h-12 rounded-[10px] overflow-hidden shadow-[var(--p-shadow-hairline)] bg-[var(--p-canvas)] animate-rd-chip-pop"
              >
                <img
                  src={img.previewUrl}
                  alt="待发送截图"
                  onClick={() => img.remoteUrl && onOpenLightbox(img.remoteUrl)}
                  className={cn(
                    "w-full h-full object-cover",
                    img.remoteUrl && "cursor-zoom-in",
                  )}
                />
                {img.uploading && (
                  <div className="absolute inset-0 bg-zinc-950/60 flex items-center justify-center">
                    <Icon
                      name="loader-2"
                      size={12}
                      className="animate-spin text-white"
                    />
                  </div>
                )}
                <button
                  type="button"
                  aria-label="移除截图"
                  onClick={() => onRemoveStagedImage(img.id)}
                  className="absolute top-1 right-1 w-4.5 h-4.5 rounded-full bg-zinc-950/80 text-white inline-flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <Icon name="x" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={inputRef}
          data-testid="portal-agent-input"
          rows={hasConversation ? 2 : 3}
          maxLength={DIAGNOSE_MAX_MESSAGE_CHARS}
          disabled={confirming}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleComposerKeyDown}
          onPaste={(e) => {
            if (!config.upload_enabled) return;
            const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
              f.type.startsWith("image/"),
            );
            if (files.length > 0) {
              e.preventDefault();
              void onUploadFiles(files);
            }
          }}
          placeholder={
            hasConversation
              ? "继续补充细节或追问…（Enter 发送，Shift+Enter 换行）"
              : "把你遇到的问题、操作步骤或使用疑问写在这里，支持直接粘贴截图…"
          }
          className={cn(
            "w-full resize-none bg-transparent px-4 sm:px-5 pt-4 pb-2.5 leading-relaxed text-[var(--p-ink)] placeholder:text-[var(--p-ink-3)] focus:outline-none disabled:opacity-60",
            hasConversation ? "text-[13.5px]" : "text-[14.5px]",
          )}
        />

        <div className="px-3.5 sm:px-4 pb-3 pt-1 flex items-center justify-between gap-2 border-t border-dashed border-[var(--p-line)]/80">
          <div className="flex items-center gap-1.5 min-w-0">
            {config.upload_enabled && (
              <button
                type="button"
                disabled={stagedImages.length >= 6 || confirming}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full text-[12px] font-medium text-[var(--p-ink-2)] hover:text-[var(--p-ink)] hover:bg-[var(--p-hover)] transition-colors disabled:opacity-45 cursor-pointer"
              >
                <Icon name="image-plus" size={14} />
                <span>附带截图</span>
                {stagedImages.length > 0 && (
                  <span className="font-mono text-[11px] tabular-nums text-[var(--p-ink-3)]">
                    {stagedImages.length}/6
                  </span>
                )}
              </button>
            )}

            {!hasConversation && (
              <button
                type="button"
                data-testid="portal-switch-manual"
                onClick={handleSwitchManualClick}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full text-[12px] font-medium text-[var(--p-ink-3)] hover:text-[var(--p-ink)] hover:bg-[var(--p-hover)] transition-colors cursor-pointer"
              >
                <Icon name="pen-line" size={12.5} />
                <span>跳过对话，直接提单</span>
              </button>
            )}

            {historyTrimmedHint && (
              <span className="hidden sm:inline text-[11px] text-[var(--p-ink-3)]">
                已自动保留最近对话上下文
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {nearCharLimit && (
              <span
                className={cn(
                  "text-[11px] font-mono tabular-nums",
                  input.length >= DIAGNOSE_MAX_MESSAGE_CHARS
                    ? "text-[var(--p-vermilion)] font-medium"
                    : "text-[var(--p-ink-3)]",
                )}
              >
                {input.length}/{DIAGNOSE_MAX_MESSAGE_CHARS}
              </span>
            )}
            {diagnosing ? (
              <button
                type="button"
                data-testid="portal-agent-stop"
                onClick={handleStop}
                aria-label="停止排查"
                className="inline-flex items-center gap-1.5 h-8.5 px-3.5 rounded-full bg-[var(--p-vermilion-tint)] text-[var(--p-vermilion)] hover:opacity-90 text-[12px] font-medium transition-all active:scale-[0.97] cursor-pointer"
              >
                <Icon name="square" size={10.5} />
                <span>停止</span>
              </button>
            ) : (
              <button
                type="submit"
                data-testid="portal-agent-send"
                disabled={!canSend}
                aria-label="发送消息"
                className={cn(
                  "inline-flex items-center justify-center gap-1.5 h-8.5 rounded-full font-medium text-[12.5px] transition-all duration-150",
                  hasConversation ? "w-8.5 px-0" : "px-4",
                  canSend
                    ? "bg-[var(--p-ink)] text-[var(--p-page)] hover:opacity-90 active:scale-[0.96] cursor-pointer shadow-xs"
                    : "bg-[var(--p-field)] text-[var(--p-ink-3)] opacity-60 cursor-not-allowed",
                )}
              >
                {!hasConversation && <span>开始诊断</span>}
                <Icon name="arrow-up" size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );

  return (
    <section
      data-testid="portal-agent-conversation"
      onDragOver={(e) => {
        if (!config.upload_enabled) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!config.upload_enabled) return;
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) {
          void onUploadFiles(e.dataTransfer.files);
        }
      }}
      className="w-full"
    >
      {!hasConversation ? (
        <div className="space-y-8 animate-rd-portal-in">
          {/* Bold Editorial Hero */}
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2.5 text-[12px]">
              <span className="font-mono text-[11.5px] font-medium text-[var(--p-ink-3)] tabular-nums">
                01
              </span>
              <span className="text-[var(--p-line-strong)]">/</span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[var(--p-forest-tint)] text-[var(--p-forest)] text-[11.5px] font-medium">
                <LivePulseDot tone="emerald" active />
                <span>诊断助手在线 · 确认后再建工单</span>
              </span>
              {config.release_window && (
                <span className="hidden sm:inline-flex items-center gap-1 text-[11.5px] text-[var(--p-ink-3)]">
                  <Icon name="calendar-clock" size={12} />
                  <span>发布窗口 {config.release_window}</span>
                </span>
              )}
            </div>

            <h2 className="text-[30px] sm:text-[40px] font-semibold tracking-[-0.035em] leading-[1.12] text-[var(--p-ink)] text-balance">
              有什么想告诉 {config.project_name} 的？
            </h2>

            <p className="text-[14.5px] sm:text-[15.5px] leading-relaxed text-[var(--p-ink-2)] max-w-[560px] text-pretty">
              直接描述你遇到的问题、想法或粘贴报错截图。助手会结合项目实现先帮你定位原因，确认属于产品故障后再一键生成工单。
            </p>
          </div>

          {/* Recessed Dotted Specimen Well holding the tactile composer */}
          <div className="rd-portal-dots rounded-[20px] bg-[var(--p-canvas)] p-2.5 sm:p-4 shadow-[var(--p-shadow-hairline)]">
            {composerForm}
          </div>

          {/* 3 Crafted Numbered Starter Primitives */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-[11.5px] text-[var(--p-ink-3)]">
              <span className="font-mono uppercase tracking-[0.06em]">
                快速开始 · 选一个常见场景
              </span>
              <span className="hidden sm:inline">支持直接粘贴截图</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {STARTERS.map((s, idx) => {
                const badgeStyle =
                  s.tone === "vermilion"
                    ? "bg-[var(--p-vermilion-tint)] text-[var(--p-vermilion)]"
                    : s.tone === "cobalt"
                      ? "bg-[var(--p-cobalt-tint)] text-[var(--p-cobalt)]"
                      : "bg-[var(--p-forest-tint)] text-[var(--p-forest)]";

                return (
                  <button
                    key={s.id}
                    type="button"
                    style={{ animationDelay: `${idx * 45}ms` }}
                    onClick={() => {
                      setInput(s.prompt);
                      requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                    className="animate-rd-chip-pop group text-left rounded-[12px] bg-[var(--p-surface)] shadow-[var(--p-shadow-hairline)] hover:shadow-[var(--p-shadow-card)] hover:-translate-y-0.5 p-4 transition-all duration-150 cursor-pointer space-y-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "w-7 h-7 rounded-[8px] inline-flex items-center justify-center shrink-0 transition-transform duration-150 group-hover:scale-105",
                          badgeStyle,
                        )}
                      >
                        <Icon name={s.icon} size={14} />
                      </span>
                      <span className="font-mono text-[11px] text-[var(--p-ink-3)] tabular-nums">
                        {s.num}
                      </span>
                    </div>
                    <div className="space-y-1">
                      <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-[var(--p-ink)]">
                        {s.label}
                      </div>
                      <p className="text-[12px] leading-snug text-[var(--p-ink-3)]">
                        {s.hint}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "relative flex flex-col min-h-[calc(100dvh-14rem)] rounded-[18px] bg-[var(--p-surface)] shadow-[var(--p-shadow-card)] transition-all duration-200 overflow-hidden animate-rd-portal-in",
            dragOver && "shadow-[0_0_0_2px_var(--p-cobalt),var(--p-shadow-card)]",
          )}
        >
          {/* Compact Editorial Conversation Top Bar */}
          <div className="px-5 py-3 border-b border-dashed border-[var(--p-line)] bg-[var(--p-page)]/70 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[12.5px] text-[var(--p-ink-2)] min-w-0">
              <LivePulseDot tone="emerald" active={diagnosing} />
              <span className="font-semibold text-[var(--p-ink)] truncate">
                {config.project_name} · 诊断对话
              </span>
              <span className="hidden sm:inline text-[11.5px] text-[var(--p-ink-3)]">
                确认前不建单
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleResetConversation}
                disabled={confirming}
                className="inline-flex items-center gap-1 h-7.5 px-2.5 rounded-full text-[12px] font-medium text-[var(--p-ink-2)] hover:text-[var(--p-ink)] hover:bg-[var(--p-hover)] transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Icon name="rotate-ccw" size={12.5} />
                <span>新对话</span>
              </button>
              <button
                type="button"
                data-testid="portal-switch-manual"
                onClick={handleSwitchManualClick}
                disabled={confirming}
                className="inline-flex items-center gap-1 h-7.5 px-3 rounded-full bg-[var(--p-field)] text-[12px] font-medium text-[var(--p-ink)] shadow-[var(--p-shadow-btn)] hover:bg-[var(--p-hover)] transition-all active:scale-[0.97] disabled:opacity-50 cursor-pointer"
              >
                <Icon name="pen-line" size={12.5} />
                <span>直接提单</span>
              </button>
            </div>
          </div>

          {/* Conversation Thread */}
          <div className="flex-1 overflow-y-auto px-4 sm:px-7 py-6 sm:py-7 rd-scroll">
            <div className="max-w-2xl mx-auto space-y-6 pb-4">
              {turns.map((turn) => {
                if (turn.role === "user") {
                  return (
                    <div
                      key={turn.id}
                      data-testid="portal-turn-user"
                      className="flex flex-col items-end gap-2 animate-rd-msg-in"
                    >
                      {turn.images && turn.images.length > 0 && (
                        <div className="flex flex-wrap justify-end gap-2 max-w-[85%]">
                          {turn.images.map((url) => (
                            <button
                              key={url}
                              type="button"
                              onClick={() => onOpenLightbox(url)}
                              className="w-24 h-18 rounded-[10px] overflow-hidden shadow-[var(--p-shadow-hairline)] bg-[var(--p-canvas)] hover:opacity-90 transition-opacity cursor-zoom-in"
                            >
                              <img
                                src={url}
                                alt="附带截图"
                                className="w-full h-full object-cover"
                              />
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="max-w-[85%] rounded-[16px] rounded-br-[5px] bg-[var(--p-ink)] text-[var(--p-page)] px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words shadow-xs">
                        {turn.text}
                      </div>
                    </div>
                  );
                }

                const isActiveDraftTurn =
                  draft && !draft.dismissed && draft.turnId === turn.id;

                return (
                  <div
                    key={turn.id}
                    data-testid="portal-turn-assistant"
                    data-outcome={turn.outcome || ""}
                    className="space-y-3 animate-rd-msg-in"
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-7 h-7 rounded-[8px] bg-[var(--p-cobalt-tint)] text-[var(--p-cobalt)] flex items-center justify-center shrink-0 mt-0.5">
                        <Icon name="sparkles" size={13.5} />
                      </div>
                      <div className="flex-1 min-w-0 space-y-2.5">
                        <div className="text-[14px] leading-relaxed text-[var(--p-ink)]">
                          <MarkdownContent content={turn.text} />
                          {turn.streaming && (
                            <span
                              aria-hidden="true"
                              className="inline-block w-1.5 h-4 ml-0.5 align-middle rounded-xs bg-[var(--p-cobalt)] animate-[rd-caret-blink_1s_ease-in-out_infinite]"
                            />
                          )}
                        </div>

                        {/* Usage resolved subtle strip */}
                        {turn.outcome === "usage" && !turn.streaming && (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] bg-[var(--p-forest-tint)] px-3.5 py-2.5 text-[12px]">
                            <span className="inline-flex items-center gap-1.5 font-medium text-[var(--p-forest)]">
                              <Icon name="check-circle-2" size={14} />
                              <span>已识别为使用/配置问题 · 无需建单</span>
                            </span>
                            <button
                              type="button"
                              onClick={handleResetConversation}
                              className="text-[12px] font-medium text-[var(--p-forest)] hover:underline cursor-pointer"
                            >
                              已解决，开启新对话
                            </button>
                          </div>
                        )}

                        {/* Compact Tool-Approval Suspected Bug Draft Card */}
                        {isActiveDraftTurn && (
                          <div
                            data-testid="portal-bug-draft-card"
                            className="rounded-[14px] bg-[var(--p-page)] shadow-[0_0_0_1px_color-mix(in_oklab,var(--p-vermilion)_35%,transparent),var(--p-shadow-card)] overflow-hidden animate-rd-draft-reveal scroll-mb-28"
                          >
                            {/* Header */}
                            <div className="px-4 py-3 border-b border-dashed border-[var(--p-line)] bg-[var(--p-vermilion-tint)] flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="w-6 h-6 rounded-[7px] bg-[var(--p-surface)] text-[var(--p-vermilion)] shadow-2xs inline-flex items-center justify-center shrink-0">
                                  <Icon name="file-check-2" size={13.5} />
                                </span>
                                <span className="text-[12.5px] font-semibold text-[var(--p-ink)] truncate">
                                  疑似产品故障 · 待确认提交工单
                                </span>
                              </div>
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-[var(--p-surface)] text-[var(--p-vermilion)] shadow-2xs">
                                尚未建单
                              </span>
                            </div>

                            {/* Compact Preview vs Expanded Editor */}
                            <div className="p-4 space-y-3">
                              {!draft.expanded ? (
                                <div className="space-y-2">
                                  <p
                                    data-testid="portal-draft-title-preview"
                                    className="text-[14px] font-semibold text-[var(--p-ink)]"
                                  >
                                    {draft.title}
                                  </p>
                                  <p className="text-[12.5px] leading-relaxed text-[var(--p-ink-2)] line-clamp-3 whitespace-pre-wrap">
                                    {draft.body}
                                  </p>
                                  {draft.images.length > 0 && (
                                    <div className="flex items-center gap-1.5 pt-1">
                                      {draft.images.map((url) => (
                                        <button
                                          key={url}
                                          type="button"
                                          onClick={() => onOpenLightbox(url)}
                                          className="w-11 h-9 rounded-[8px] overflow-hidden shadow-[var(--p-shadow-hairline)] cursor-zoom-in"
                                        >
                                          <img
                                            src={url}
                                            alt="工单附图"
                                            className="w-full h-full object-cover"
                                          />
                                        </button>
                                      ))}
                                      <span className="text-[11px] text-[var(--p-ink-3)] ml-1">
                                        将随工单附带 {draft.images.length} 张截图
                                      </span>
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="space-y-3 animate-rd-msg-in">
                                  <label className="block space-y-1">
                                    <span className="text-[11.5px] font-medium text-[var(--p-ink-2)]">
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
                                          prev
                                            ? { ...prev, title: e.target.value }
                                            : prev,
                                        )
                                      }
                                      placeholder="简明概括故障现象"
                                      className="w-full h-9 px-3 rounded-[10px] bg-[var(--p-surface)] shadow-[var(--p-shadow-hairline)] text-[13px] font-medium text-[var(--p-ink)] focus:outline-none focus:shadow-[0_0_0_1.5px_var(--p-cobalt)]"
                                    />
                                  </label>

                                  <label className="block space-y-1">
                                    <span className="text-[11.5px] font-medium text-[var(--p-ink-2)]">
                                      故障详情与复现步骤
                                    </span>
                                    <textarea
                                      data-testid="portal-draft-body"
                                      rows={5}
                                      maxLength={20000}
                                      required
                                      value={draft.body}
                                      onChange={(e) =>
                                        setDraft((prev) =>
                                          prev
                                            ? { ...prev, body: e.target.value }
                                            : prev,
                                        )
                                      }
                                      className="w-full p-3 rounded-[10px] bg-[var(--p-surface)] shadow-[var(--p-shadow-hairline)] text-[12.5px] leading-relaxed text-[var(--p-ink)] focus:outline-none focus:shadow-[0_0_0_1.5px_var(--p-cobalt)]"
                                    />
                                  </label>

                                  {(draft.images.length > 0 ||
                                    config.upload_enabled) && (
                                    <div className="space-y-1.5">
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="text-[11.5px] font-medium text-[var(--p-ink-2)]">
                                          附图（{draft.images.length} / 6）
                                        </span>
                                        {config.upload_enabled &&
                                          draft.images.length < 6 && (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                fileInputRef.current?.click()
                                              }
                                              className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--p-cobalt)] hover:underline cursor-pointer"
                                            >
                                              <Icon name="image-plus" size={12} />
                                              <span>补充截图</span>
                                            </button>
                                          )}
                                      </div>
                                      {draft.images.length > 0 && (
                                        <div className="flex flex-wrap gap-2">
                                          {draft.images.map((url) => (
                                            <div
                                              key={url}
                                              className="relative group w-14 h-12 rounded-[8px] overflow-hidden shadow-[var(--p-shadow-hairline)] bg-[var(--p-surface)]"
                                            >
                                              <img
                                                src={url}
                                                alt="工单附图"
                                                onClick={() => onOpenLightbox(url)}
                                                className="w-full h-full object-cover cursor-zoom-in"
                                              />
                                              <button
                                                type="button"
                                                aria-label="移除该截图"
                                                onClick={() =>
                                                  setDraft((prev) =>
                                                    prev
                                                      ? {
                                                          ...prev,
                                                          images:
                                                            prev.images.filter(
                                                              (u) => u !== url,
                                                            ),
                                                        }
                                                      : prev,
                                                  )
                                                }
                                                className="absolute top-0.5 right-0.5 w-4.5 h-4.5 rounded-full bg-zinc-950/75 text-white inline-flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                              >
                                                <Icon name="x" size={10} />
                                              </button>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}

                              {config.can_request_deploy && (
                                <div className="rounded-[10px] bg-[var(--p-cobalt-tint)] px-3 py-2.5">
                                  <Switch
                                    checked={
                                      draft.releasePreference ===
                                      "request_immediate"
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
                                    label="修复完成后由 AI 评估是否立即发布"
                                    description={
                                      config.release_window
                                        ? `当前默认发布窗口：${config.release_window}`
                                        : "修复待发时自动进入只读发布门禁评估"
                                    }
                                  />
                                </div>
                              )}

                              {/* Approval Action Row */}
                              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-dashed border-[var(--p-line)]">
                                <div className="flex items-center gap-1.5">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="xs"
                                    icon={
                                      draft.expanded ? "chevron-up" : "pen-line"
                                    }
                                    data-testid="portal-draft-toggle-edit"
                                    disabled={confirming}
                                    onClick={() =>
                                      setDraft((prev) =>
                                        prev
                                          ? { ...prev, expanded: !prev.expanded }
                                          : prev,
                                      )
                                    }
                                  >
                                    {draft.expanded ? "收起编辑" : "编辑草稿"}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="xs"
                                    disabled={confirming}
                                    onClick={() => {
                                      setDraft((prev) =>
                                        prev ? { ...prev, dismissed: true } : prev,
                                      );
                                      requestAnimationFrame(() =>
                                        inputRef.current?.focus(),
                                      );
                                    }}
                                  >
                                    继续补充
                                  </Button>
                                </div>
                                <Button
                                  type="button"
                                  variant="primary"
                                  size="sm"
                                  icon="send"
                                  data-testid="portal-draft-confirm"
                                  loading={confirming}
                                  disabled={
                                    !draft.title.trim() ||
                                    !draft.body.trim() ||
                                    diagnosing ||
                                    uploadingCount > 0
                                  }
                                  onClick={() => void handleConfirmDraft()}
                                >
                                  确认提交工单
                                </Button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Live Honest Status Indicator (while waiting before first text delta) */}
              {diagnosing && !activeStreamingTurn && (
                <div
                  data-testid="portal-diagnosing-indicator"
                  className="flex items-center gap-3 animate-rd-msg-in"
                >
                  <div className="w-7 h-7 rounded-[8px] bg-[var(--p-cobalt-tint)] text-[var(--p-cobalt)] flex items-center justify-center shrink-0">
                    <Icon name="sparkles" size={13} className="animate-pulse" />
                  </div>
                  <div className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-full bg-[var(--p-canvas)] shadow-[var(--p-shadow-hairline)]">
                    <span className="rd-shimmer-text text-[12.5px] font-medium">
                      {statusLabel}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-[var(--p-ink-3)]">
                      {elapsedSeconds}s
                    </span>
                  </div>
                </div>
              )}

              {/* Error / Offline Recovery Banner */}
              {diagnoseError && !diagnosing && (
                <div
                  role="alert"
                  data-testid="portal-diagnose-error"
                  className="rounded-[12px] bg-[var(--p-vermilion-tint)] px-4 py-3 flex flex-wrap items-center justify-between gap-2.5 animate-rd-msg-in"
                >
                  <div className="flex items-center gap-2 text-[12.5px] text-[var(--p-ink)] min-w-0">
                    <Icon
                      name="alert-triangle"
                      size={14}
                      className="text-[var(--p-vermilion)] shrink-0"
                    />
                    <span>{diagnoseError.message}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {diagnoseError.offline && onRefreshConfig ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        icon="refresh-cw"
                        onClick={() => void onRefreshConfig()}
                      >
                        重新检测状态
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        icon="refresh-cw"
                        data-testid="portal-diagnose-retry"
                        onClick={handleRetryLast}
                      >
                        重试
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      icon="pen-line"
                      onClick={handleSwitchManualClick}
                    >
                      改为直接提单
                    </Button>
                  </div>
                </div>
              )}

              <div ref={threadEndRef} />
            </div>
          </div>

          {/* Bottom Composer Dock */}
          <div className="px-4 sm:px-6 pb-4 pt-2 bg-[var(--p-canvas)]/70 border-t border-dashed border-[var(--p-line)]">
            {composerForm}
          </div>
        </div>
      )}
    </section>
  );
}
