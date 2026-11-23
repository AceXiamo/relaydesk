export type WorkspaceMediaKind = "image" | "video" | "audio" | "pdf";

interface MediaFormatSpec {
  kind: WorkspaceMediaKind;
  mime: string;
  chatImage?: boolean;
}

const MEDIA_FORMATS: Record<string, MediaFormatSpec> = {
  // Images
  ".png": { kind: "image", mime: "image/png", chatImage: true },
  ".jpg": { kind: "image", mime: "image/jpeg", chatImage: true },
  ".jpeg": { kind: "image", mime: "image/jpeg", chatImage: true },
  ".webp": { kind: "image", mime: "image/webp", chatImage: true },
  ".gif": { kind: "image", mime: "image/gif", chatImage: true },
  ".avif": { kind: "image", mime: "image/avif", chatImage: true },
  ".bmp": { kind: "image", mime: "image/bmp" },
  ".ico": { kind: "image", mime: "image/x-icon" },
  ".svg": { kind: "image", mime: "image/svg+xml" },

  // Videos
  ".mp4": { kind: "video", mime: "video/mp4" },
  ".m4v": { kind: "video", mime: "video/mp4" },
  ".webm": { kind: "video", mime: "video/webm" },
  ".mov": { kind: "video", mime: "video/quicktime" },
  ".ogv": { kind: "video", mime: "video/ogg" },

  // Audio
  ".mp3": { kind: "audio", mime: "audio/mpeg" },
  ".wav": { kind: "audio", mime: "audio/wav" },
  ".ogg": { kind: "audio", mime: "audio/ogg" },
  ".m4a": { kind: "audio", mime: "audio/mp4" },
  ".aac": { kind: "audio", mime: "audio/aac" },
  ".flac": { kind: "audio", mime: "audio/flac" },
  ".weba": { kind: "audio", mime: "audio/webm" },
  ".opus": { kind: "audio", mime: "audio/opus" },

  // Documents
  ".pdf": { kind: "pdf", mime: "application/pdf" },
};

function normalizeExt(ext: string): string {
  const lower = ext.trim().toLowerCase();
  if (!lower) return "";
  return lower.startsWith(".") ? lower : `.${lower}`;
}

export function getWorkspaceMediaKind(ext: string): WorkspaceMediaKind | null {
  return MEDIA_FORMATS[normalizeExt(ext)]?.kind ?? null;
}

export function getWorkspaceInlineMime(ext: string): string | undefined {
  return MEDIA_FORMATS[normalizeExt(ext)]?.mime;
}

export function isWorkspaceChatImageExt(ext: string): boolean {
  return Boolean(MEDIA_FORMATS[normalizeExt(ext)]?.chatImage);
}

export function buildWorkspaceFileUrl(
  projectId: string,
  path: string,
  mode: "inline" | "download",
  version?: string,
): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/workspace/file?path=${encodeURIComponent(path)}&${mode}=1`;
  return version ? `${base}&v=${encodeURIComponent(version)}` : base;
}

export function formatMediaDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.floor(seconds);
  const hrs = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}
