import { createContext, useContext, useEffect, useState } from "react";
import { ImageLightboxLink } from "./ImageLightbox.tsx";

export const ImageTurnStreaming = createContext(false);
const BACKOFF = [1200, 3000, 8000];

// Only retry same-origin workspace images. Remote Markdown links are never polled.
export function ChatWorkspaceImage({ url, alt, className, linkClassName, streaming }: {
  url: string; alt: string; className: string; linkClassName?: string; streaming?: boolean;
}) {
  const fromMarkdown = useContext(ImageTurnStreaming);
  const running = streaming ?? fromMarkdown;
  const workspace = /^\/api\/projects\/[^/?#]+\/workspace\/file\?/.test(url);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failedWhileRunning, setFailedWhileRunning] = useState(false);
  const retry = () => { setFailed(false); setAttempt(n => n + 1); };
  useEffect(() => {
    if (!workspace || !failed) return;
    // Terminal delivery follows successful writeback. Try again even if the earlier budget was exhausted.
    if (!running && failedWhileRunning) {
      setFailedWhileRunning(false);
      retry();
      return;
    }
    if (!running || attempt >= BACKOFF.length) return;
    const timer = setTimeout(retry, BACKOFF[attempt]);
    return () => clearTimeout(timer);
  }, [workspace, failed, running, failedWhileRunning, attempt]);

  if (failed) return <span className="inline-flex flex-wrap items-baseline gap-x-2 text-xs text-[var(--text-muted)]">
    <span>{workspace && running ? "图片尚未就绪，回复结束后会再试。" : "图片未能加载。"}</span>
    <button type="button" className="underline" onClick={retry} aria-label={`重新加载图片：${alt}`}>重新加载</button>
  </span>;
  const src = workspace && attempt ? `${url}&preview_retry=${attempt}` : url;
  return (
    <ImageLightboxLink
      src={src}
      openUrl={url}
      alt={alt}
      className={linkClassName}
    >
      <img
        key={attempt}
        src={src}
        alt={alt}
        loading="lazy"
        className={className}
        onError={() => {
          setFailedWhileRunning(running);
          setFailed(true);
        }}
      />
    </ImageLightboxLink>
  );
}
