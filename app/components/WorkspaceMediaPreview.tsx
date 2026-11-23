import { memo, useEffect, useState, type CSSProperties } from "react";
import { formatRelativeTime } from "~/lib/format.ts";
import type { WorkspaceFileDetail } from "~/lib/types.ts";
import { formatMediaDuration, type WorkspaceMediaKind } from "~/lib/workspace-media.ts";
import { Icon } from "./Icon.tsx";

interface WorkspaceMediaPreviewProps {
  file: WorkspaceFileDetail;
  mediaKind: WorkspaceMediaKind;
  inlineUrl: string;
  downloadUrl: string;
  /** Live unsaved SVG source when editing `.svg` in preview mode. */
  svgDraft?: string;
  onPrevMedia?: () => void;
  onNextMedia?: () => void;
  mediaPositionLabel?: string;
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, rgba(128,128,128,0.12) 25%, transparent 25%), " +
    "linear-gradient(-45deg, rgba(128,128,128,0.12) 25%, transparent 25%), " +
    "linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.12) 75%), " +
    "linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.12) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function mediaKindLabel(kind: WorkspaceMediaKind): string {
  switch (kind) {
    case "image":
      return "图片预览";
    case "video":
      return "视频预览";
    case "audio":
      return "音频预览";
    case "pdf":
      return "PDF 预览";
  }
}

export const WorkspaceMediaPreview = memo(function WorkspaceMediaPreview({
  file,
  mediaKind,
  inlineUrl,
  downloadUrl,
  svgDraft,
  onPrevMedia,
  onNextMedia,
  mediaPositionLabel,
}: WorkspaceMediaPreviewProps) {
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [checkerboard, setCheckerboard] = useState(true);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [svgBlobUrl, setSvgBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    setZoom("fit");
    setDimensions(null);
    setDuration(null);
    setLoadError(false);
    setRetryKey(0);
  }, [file.path, inlineUrl]);

  useEffect(() => {
    if (svgDraft === undefined) {
      setSvgBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([svgDraft], { type: "image/svg+xml" }));
    setSvgBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [svgDraft]);

  const effectiveSrc = svgBlobUrl ?? inlineUrl;

  const stepZoom = (dir: -1 | 1) => {
    const current = zoom === "fit" ? 1 : zoom;
    if (dir > 0) {
      const next = ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
      setZoom(next);
    } else {
      const rev = [...ZOOM_STEPS].reverse();
      const next = rev.find((z) => z < current - 0.001) ?? ZOOM_STEPS[0];
      setZoom(next);
    }
  };

  const toggleFitOrActual = () => {
    setZoom((curr) => (curr === "fit" ? 1 : "fit"));
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-base)]">
      {/* Compact media toolbar */}
      <div className="shrink-0 px-3 sm:px-4 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-[var(--text-secondary)]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="px-1.5 py-0.5 rounded bg-[var(--surface-card)] border border-[var(--border-subtle)] font-medium text-[var(--text-primary)]">
            {mediaKindLabel(mediaKind)}
          </span>
          {dimensions && (
            <span className="font-mono text-[var(--text-muted)]">
              {dimensions.width} × {dimensions.height} px
            </span>
          )}
          {duration !== null && (
            <span className="font-mono text-[var(--text-muted)]">
              时长 {formatMediaDuration(duration)}
            </span>
          )}
          <span className="hidden sm:inline text-[var(--text-muted)]">
            更新于 {formatRelativeTime(file.updated_at)}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {(onPrevMedia || onNextMedia) && (
            <div className="inline-flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
              <button
                type="button"
                title="上一个媒体文件"
                disabled={!onPrevMedia}
                onClick={onPrevMedia}
                className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
              >
                <Icon name="chevron-left" size={13} />
              </button>
              {mediaPositionLabel && (
                <span className="px-1.5 font-mono text-[11px] text-[var(--text-muted)] select-none">
                  {mediaPositionLabel}
                </span>
              )}
              <button
                type="button"
                title="下一个媒体文件"
                disabled={!onNextMedia}
                onClick={onNextMedia}
                className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
              >
                <Icon name="chevron-right" size={13} />
              </button>
            </div>
          )}

          {mediaKind === "image" && !loadError && (
            <>
              <div className="inline-flex items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
                <button
                  type="button"
                  title="缩小"
                  onClick={() => stepZoom(-1)}
                  className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <Icon name="zoom-out" size={13} />
                </button>
                <button
                  type="button"
                  title={zoom === "fit" ? "切换为 1:1 原始尺寸" : "切换为适应窗口"}
                  onClick={toggleFitOrActual}
                  className="px-2 py-0.5 font-mono text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] border-x border-[var(--border-subtle)] cursor-pointer min-w-[46px]"
                >
                  {zoom === "fit" ? "适应" : `${Math.round(zoom * 100)}%`}
                </button>
                <button
                  type="button"
                  title="放大"
                  onClick={() => stepZoom(1)}
                  className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <Icon name="zoom-in" size={13} />
                </button>
              </div>
              <button
                type="button"
                title={checkerboard ? "关闭透明网格背景" : "显示透明网格背景"}
                onClick={() => setCheckerboard((v) => !v)}
                className={`px-2 py-1 rounded-md border text-[11px] transition cursor-pointer ${
                  checkerboard
                    ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
                    : "border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                网格
              </button>
            </>
          )}

          <a
            href={inlineUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          >
            <Icon name="external-link" size={12} />
            <span>新窗口</span>
          </a>
        </div>
      </div>

      {/* Preview stage */}
      {loadError ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 text-center space-y-3">
            <div className="w-11 h-11 rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto">
              <Icon name="alert-triangle" size={22} />
            </div>
            <h3 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
              无法在线预览该媒体文件
            </h3>
            <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed">
              文件可能已损坏，或当前浏览器不支持该编码格式。你可以重试加载或下载到本地查看。
            </p>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setLoadError(false);
                  setRetryKey((k) => k + 1);
                }}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[12.5px] font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] cursor-pointer"
              >
                <Icon name="refresh-cw" size={13} />
                重试
              </button>
              <a
                href={downloadUrl}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-indigo-600 text-white text-[12.5px] font-medium hover:bg-indigo-500"
              >
                <Icon name="download" size={13} />
                下载文件
              </a>
            </div>
          </div>
        </div>
      ) : mediaKind === "image" ? (
        <div
          className={`flex-1 min-h-0 p-4 sm:p-6 ${
            zoom === "fit"
              ? "flex items-center justify-center overflow-hidden"
              : "overflow-auto flex items-start justify-center"
          }`}
        >
          <div
            style={checkerboard ? CHECKERBOARD_STYLE : undefined}
            className={`rounded-xl border border-[var(--border-subtle)] shadow-sm overflow-hidden flex items-center justify-center ${
              checkerboard ? "" : "bg-[var(--surface-card)]"
            } ${zoom === "fit" ? "max-w-full max-h-full" : ""}`}
          >
            <img
              key={`${effectiveSrc}:${retryKey}`}
              src={effectiveSrc}
              alt={file.name}
              decoding="async"
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
                }
              }}
              onError={() => setLoadError(true)}
              style={
                zoom === "fit"
                  ? undefined
                  : dimensions
                    ? {
                        width: `${Math.max(1, Math.round(dimensions.width * zoom))}px`,
                        maxWidth: "none",
                      }
                    : { transform: `scale(${zoom})`, transformOrigin: "top center" }
              }
              className={
                zoom === "fit"
                  ? "max-w-full max-h-[calc(100vh-14rem)] object-contain select-none"
                  : "h-auto select-none"
              }
            />
          </div>
        </div>
      ) : mediaKind === "video" ? (
        <div className="flex-1 min-h-0 p-4 sm:p-6 flex items-center justify-center overflow-hidden">
          <video
            key={`${inlineUrl}:${retryKey}`}
            src={inlineUrl}
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) => {
              const video = e.currentTarget;
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                setDimensions({ width: video.videoWidth, height: video.videoHeight });
              }
              if (Number.isFinite(video.duration)) {
                setDuration(video.duration);
              }
            }}
            onError={() => setLoadError(true)}
            className="max-w-full max-h-full rounded-xl border border-[var(--border-subtle)] bg-black shadow-sm"
          />
        </div>
      ) : mediaKind === "audio" ? (
        <div className="flex-1 min-h-0 p-6 flex items-center justify-center">
          <div className="max-w-lg w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 space-y-4 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-indigo-500/12 text-indigo-500 flex items-center justify-center shrink-0">
                <Icon name="music" size={22} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[13.5px] font-semibold text-[var(--text-primary)] truncate">
                  {file.name}
                </div>
                <div className="text-[12px] text-[var(--text-muted)]">
                  {formatBytes(file.size)}
                  {duration !== null ? ` · ${formatMediaDuration(duration)}` : ""}
                  {` · 更新于 ${formatRelativeTime(file.updated_at)}`}
                </div>
              </div>
            </div>
            <audio
              key={`${inlineUrl}:${retryKey}`}
              src={inlineUrl}
              controls
              preload="metadata"
              onLoadedMetadata={(e) => {
                if (Number.isFinite(e.currentTarget.duration)) {
                  setDuration(e.currentTarget.duration);
                }
              }}
              onError={() => setLoadError(true)}
              className="w-full"
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 p-3 sm:p-4 flex flex-col">
          <iframe
            key={`${inlineUrl}:${retryKey}`}
            src={inlineUrl}
            title={file.name}
            onError={() => setLoadError(true)}
            className="flex-1 w-full rounded-xl border border-[var(--border-subtle)] bg-white"
          />
        </div>
      )}
    </div>
  );
});
