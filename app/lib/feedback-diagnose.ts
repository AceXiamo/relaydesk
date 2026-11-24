import type { FeedbackDiagnoseMessage } from "./portal-types.ts";

export const DIAGNOSE_MAX_MESSAGES = 25;
export const DIAGNOSE_MAX_MESSAGE_CHARS = 6000;
export const DIAGNOSE_MAX_TOTAL_CHARS = 32000;
export const DIAGNOSE_MAX_IMAGES = 8;
export const DIAGNOSE_MAX_IMAGE_URL_CHARS = 2048;

export interface NormalizedDiagnosePayload {
  messages: FeedbackDiagnoseMessage[];
  images: string[];
  trimmedHistory: boolean;
  clampedMessage: boolean;
}

/**
 * Smoothly clamp a single message while preserving both opening context and
 * the newest trailing details when text exceeds the protocol limit.
 */
export function clampDiagnoseMessageText(
  text: string,
  limit = DIAGNOSE_MAX_MESSAGE_CHARS,
): { text: string; clamped: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= limit) {
    return { text: trimmed, clamped: false };
  }
  const marker = "\n…\n";
  const headLen = Math.min(1600, Math.floor((limit - marker.length) * 0.3));
  const tailLen = Math.max(200, limit - headLen - marker.length);
  return {
    text: `${trimmed.slice(0, headLen)}${marker}${trimmed.slice(-tailLen)}`.slice(
      0,
      limit,
    ),
    clamped: true,
  };
}

/**
 * Filter attachment URLs so only clean http(s) URLs without credentials,
 * query strings, or fragments are forwarded to /diagnose.
 */
export function sanitizeDiagnoseImages(urls: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (!raw || raw.length > DIAGNOSE_MAX_IMAGE_URL_CHARS || seen.has(raw)) {
      continue;
    }
    try {
      const parsed = new URL(raw);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      ) {
        seen.add(raw);
        out.push(raw);
        if (out.length >= DIAGNOSE_MAX_IMAGES) break;
      }
    } catch {
      // Ignore malformed URLs
    }
  }
  return out;
}

/**
 * Normalize raw UI turns into a protocol-valid /diagnose payload:
 * - Drops empty entries and any leading assistant turns
 * - Merges consecutive same-role turns (prevents 400 after stop/failure + follow-up)
 * - Guarantees strict user/assistant alternation ending on a user turn
 * - Smoothly clamps per-message length (<= 6000), history count (<= 25),
 *   and total character count (<= 32000) by dropping oldest user+assistant pairs
 */
export function normalizeDiagnosePayload(
  rawMessages: readonly FeedbackDiagnoseMessage[],
  rawImages: readonly string[] = [],
): NormalizedDiagnosePayload {
  const merged: FeedbackDiagnoseMessage[] = [];
  let clampedMessage = false;
  let trimmedHistory = false;

  for (const entry of rawMessages) {
    const trimmed = entry.text.trim();
    if (!trimmed) continue;
    if (merged.length === 0 && entry.role !== "user") {
      trimmedHistory = true;
      continue;
    }
    const prev = merged[merged.length - 1];
    if (prev && prev.role === entry.role) {
      const joined = clampDiagnoseMessageText(`${prev.text}\n\n${trimmed}`);
      prev.text = joined.text;
      if (joined.clamped) clampedMessage = true;
    } else {
      const single = clampDiagnoseMessageText(trimmed);
      if (single.clamped) clampedMessage = true;
      merged.push({ role: entry.role, text: single.text });
    }
  }

  while (merged.length > 0 && merged[merged.length - 1].role !== "user") {
    merged.pop();
    trimmedHistory = true;
  }

  while (merged.length > DIAGNOSE_MAX_MESSAGES) {
    merged.splice(0, 2);
    trimmedHistory = true;
  }

  let totalChars = merged.reduce((sum, m) => sum + m.text.length, 0);
  while (totalChars > DIAGNOSE_MAX_TOTAL_CHARS && merged.length > 1) {
    const removed = merged.splice(0, 2);
    for (const item of removed) totalChars -= item.text.length;
    trimmedHistory = true;
  }

  return {
    messages: merged,
    images: sanitizeDiagnoseImages(rawImages),
    trimmedHistory,
    clampedMessage,
  };
}
