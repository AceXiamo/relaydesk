import type {
  FeedbackDiagnoseOutcome,
  FeedbackReleasePreference,
} from "./portal-types.ts";

export interface PortalConversationTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  images?: string[];
  outcome?: FeedbackDiagnoseOutcome;
  reasoning?: string;
  traceSteps?: string[];
  thinkingDurationMs?: number;
  streaming?: boolean;
}

export interface PortalEditableDraftState {
  turnId: string;
  title: string;
  body: string;
  images: string[];
  releasePreference: FeedbackReleasePreference;
  expanded: boolean;
  dismissed: boolean;
}

export interface StoredPortalConversation {
  id: string;
  title: string;
  turns: PortalConversationTurn[];
  draft: PortalEditableDraftState | null;
  submittedTaskCode?: string;
  pendingDiagnoseAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PortalConversationStore {
  activeId: string | null;
  sessions: StoredPortalConversation[];
}

const STORAGE_PREFIX = "relaydesk:portal:conversations:v1:";
const MAX_STORED_CONVERSATIONS = 20;
const MAX_TURNS_PER_SESSION = 60;
const MAX_REASONING_STORED = 12_000;
const PENDING_DIAGNOSE_RESUME_WINDOW_MS = 5 * 60 * 1000;

export function hasUnansweredUserTurn(
  turns: readonly PortalConversationTurn[],
): boolean {
  if (turns.length === 0) return false;
  const last = turns[turns.length - 1];
  if (last.role === "user") return true;
  // An assistant turn without a finalized outcome means streaming was cut off.
  return last.role === "assistant" && !last.outcome;
}

export function isPendingDiagnoseFresh(
  pendingDiagnoseAt: number | undefined,
  now = Date.now(),
): boolean {
  if (
    typeof pendingDiagnoseAt !== "number" ||
    !Number.isFinite(pendingDiagnoseAt) ||
    pendingDiagnoseAt <= 0
  ) {
    return false;
  }
  const age = now - pendingDiagnoseAt;
  return age >= -60_000 && age <= PENDING_DIAGNOSE_RESUME_WINDOW_MS;
}

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function deriveConversationTitle(
  turns: readonly PortalConversationTurn[],
): string {
  const firstUser = turns.find((t) => t.role === "user" && t.text.trim());
  const raw = (firstUser?.text || "未命名对话").replace(/\s+/g, " ").trim();
  return raw.length > 44 ? `${raw.slice(0, 44)}…` : raw;
}

function sanitizeTurn(raw: unknown): PortalConversationTurn | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.role !== "user" && obj.role !== "assistant") return null;
  const id = typeof obj.id === "string" && obj.id ? obj.id : "";
  const text = typeof obj.text === "string" ? obj.text : "";
  const reasoning =
    typeof obj.reasoning === "string" && obj.reasoning.trim()
      ? obj.reasoning.slice(0, MAX_REASONING_STORED)
      : undefined;
  const traceSteps = Array.isArray(obj.traceSteps)
    ? obj.traceSteps
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .slice(0, 24)
    : undefined;
  if (!id || (!text.trim() && !reasoning && !(traceSteps && traceSteps.length))) {
    return null;
  }
  const images = Array.isArray(obj.images)
    ? obj.images
        .filter((u): u is string => typeof u === "string" && u.length > 0)
        .slice(0, 8)
    : undefined;
  const outcome: FeedbackDiagnoseOutcome | undefined =
    obj.outcome === "clarify" ||
    obj.outcome === "usage" ||
    obj.outcome === "suspected_bug"
      ? obj.outcome
      : undefined;
  const thinkingDurationMs =
    typeof obj.thinkingDurationMs === "number" &&
    Number.isFinite(obj.thinkingDurationMs) &&
    obj.thinkingDurationMs >= 0
      ? Math.round(obj.thinkingDurationMs)
      : undefined;

  return {
    id,
    role: obj.role,
    text,
    ...(images && images.length > 0 ? { images } : {}),
    ...(outcome ? { outcome } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(traceSteps && traceSteps.length > 0 ? { traceSteps } : {}),
    ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
  };
}

function sanitizeDraft(raw: unknown): PortalEditableDraftState | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.turnId !== "string" || !obj.turnId) return null;
  const title = typeof obj.title === "string" ? obj.title : "";
  const body = typeof obj.body === "string" ? obj.body : "";
  const images = Array.isArray(obj.images)
    ? obj.images.filter((u): u is string => typeof u === "string" && u.length > 0).slice(0, 8)
    : [];
  const releasePreference: FeedbackReleasePreference =
    obj.releasePreference === "request_immediate" ? "request_immediate" : "default";
  return {
    turnId: obj.turnId,
    title,
    body,
    images,
    releasePreference,
    expanded: Boolean(obj.expanded),
    dismissed: Boolean(obj.dismissed),
  };
}

function sanitizeSession(raw: unknown): StoredPortalConversation | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) return null;
  if (!Array.isArray(obj.turns)) return null;
  const turns = obj.turns
    .map(sanitizeTurn)
    .filter((t): t is PortalConversationTurn => t !== null)
    .slice(-MAX_TURNS_PER_SESSION);
  if (turns.length === 0) return null;
  const now = Date.now();
  const createdAt =
    typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt)
      ? obj.createdAt
      : now;
  const updatedAt =
    typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt)
      ? obj.updatedAt
      : createdAt;
  const title =
    typeof obj.title === "string" && obj.title.trim()
      ? obj.title.trim()
      : deriveConversationTitle(turns);
  const draft = sanitizeDraft(obj.draft);
  const submittedTaskCode =
    typeof obj.submittedTaskCode === "string" && obj.submittedTaskCode.trim()
      ? obj.submittedTaskCode.trim()
      : undefined;
  const pendingDiagnoseAt =
    typeof obj.pendingDiagnoseAt === "number" &&
    Number.isFinite(obj.pendingDiagnoseAt) &&
    obj.pendingDiagnoseAt > 0
      ? obj.pendingDiagnoseAt
      : undefined;

  return {
    id: obj.id,
    title,
    turns,
    draft,
    ...(submittedTaskCode ? { submittedTaskCode } : {}),
    ...(pendingDiagnoseAt !== undefined ? { pendingDiagnoseAt } : {}),
    createdAt,
    updatedAt,
  };
}

export function loadPortalConversationStore(
  projectId: string,
): PortalConversationStore {
  if (!projectId) return { activeId: null, sessions: [] };
  const storage = getStorage();
  if (!storage) return { activeId: null, sessions: [] };
  try {
    const raw = storage.getItem(storageKey(projectId));
    if (!raw) return { activeId: null, sessions: [] };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return { activeId: null, sessions: [] };
    }
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions
          .map(sanitizeSession)
          .filter((s): s is StoredPortalConversation => s !== null)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, MAX_STORED_CONVERSATIONS)
      : [];
    const activeId =
      typeof parsed.activeId === "string" &&
      sessions.some((s) => s.id === parsed.activeId)
        ? parsed.activeId
        : null;
    return { activeId, sessions };
  } catch {
    return { activeId: null, sessions: [] };
  }
}

export function savePortalConversationStore(
  projectId: string,
  store: PortalConversationStore,
): void {
  if (!projectId) return;
  const storage = getStorage();
  if (!storage) return;
  const trimmedSessions = store.sessions
    .map((session) => ({
      ...session,
      turns: session.turns
        .map((t) => {
          const { streaming: _streaming, ...rest } = t;
          return rest;
        })
        .slice(-MAX_TURNS_PER_SESSION),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STORED_CONVERSATIONS);

  const activeId =
    store.activeId && trimmedSessions.some((s) => s.id === store.activeId)
      ? store.activeId
      : null;

  try {
    storage.setItem(
      storageKey(projectId),
      JSON.stringify({ activeId, sessions: trimmedSessions }),
    );
  } catch {
    // Gracefully degrade when quota is exceeded: keep fewer recent sessions.
    try {
      const reduced = trimmedSessions.slice(0, 5);
      storage.setItem(
        storageKey(projectId),
        JSON.stringify({
          activeId: activeId && reduced.some((s) => s.id === activeId) ? activeId : null,
          sessions: reduced,
        }),
      );
    } catch {
      // Ignore storage failures in private browsing / disabled storage.
    }
  }
}

export function upsertPortalConversation(
  projectId: string,
  session: StoredPortalConversation,
  setActive = true,
): PortalConversationStore {
  const current = loadPortalConversationStore(projectId);
  const nextSessions = [
    session,
    ...current.sessions.filter((s) => s.id !== session.id),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STORED_CONVERSATIONS);
  const next: PortalConversationStore = {
    activeId: setActive ? session.id : current.activeId,
    sessions: nextSessions,
  };
  savePortalConversationStore(projectId, next);
  return next;
}

export function setActivePortalConversation(
  projectId: string,
  activeId: string | null,
): PortalConversationStore {
  const current = loadPortalConversationStore(projectId);
  const next: PortalConversationStore = {
    activeId:
      activeId && current.sessions.some((s) => s.id === activeId)
        ? activeId
        : null,
    sessions: current.sessions,
  };
  savePortalConversationStore(projectId, next);
  return next;
}

export function deletePortalConversation(
  projectId: string,
  sessionId: string,
): PortalConversationStore {
  const current = loadPortalConversationStore(projectId);
  const nextSessions = current.sessions.filter((s) => s.id !== sessionId);
  const next: PortalConversationStore = {
    activeId: current.activeId === sessionId ? null : current.activeId,
    sessions: nextSessions,
  };
  savePortalConversationStore(projectId, next);
  return next;
}

export function clearPortalConversations(
  projectId: string,
): PortalConversationStore {
  const next: PortalConversationStore = { activeId: null, sessions: [] };
  savePortalConversationStore(projectId, next);
  return next;
}
