import { constants, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatContextUsage } from "../app/lib/types.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function codexContextUsage(info: unknown): ChatContextUsage | undefined {
  const snapshot = record(info);
  const used = record(snapshot?.last_token_usage)?.total_tokens;
  const window = snapshot?.model_context_window;
  if (count(used)) return { used_tokens: used, ...(count(window) && window > 0 && { window_tokens: window }) };
}

export function claudeContextTracker(publish: (usage: ChatContextUsage) => void) {
  let requested: string | undefined;
  let active: { id: unknown; model: unknown; usage?: Record<string, unknown>; used?: number } | undefined;
  return (obj: Record<string, unknown>) => {
    if (obj.parent_tool_use_id != null || obj.is_meta || obj.isReplay || obj.isUnmetered || obj.local_command_source) return;
    if (obj.type === "system" && obj.subtype === "init" && typeof obj.model === "string") requested = obj.model;
    if (obj.type === "result") {
      // Billing totals are never occupancy. A [1m] run has the unsuffixed model on API frames.
      const model = active?.model;
      const key = requested?.endsWith("[1m]") && requested.slice(0, -4) === model ? requested : model;
      const window = typeof key === "string" && record(record(obj.modelUsage)?.[key])?.contextWindow;
      if (active?.used !== undefined && count(window) && window > 0) publish({ used_tokens: active.used, window_tokens: window });
      return;
    }
    if (obj.type === "system" && obj.subtype === "compact_boundary") {
      active = undefined;
      const post = record(obj.compact_metadata)?.post_tokens;
      if (count(post) && post > 0) publish({ used_tokens: post });
      return;
    }
    const event = obj.type === "stream_event" ? record(obj.event) : undefined;
    const message = record(obj.type === "assistant" ? obj.message : event?.type === "message_start" ? event.message : undefined);
    let usage: Record<string, unknown> | undefined;
    if (message && message.model !== "<synthetic>") {
      if (!active || !message.id || active.id !== message.id || active.model !== message.model || event?.type === "message_start") {
        active = { id: message.id, model: message.model };
      }
      usage = record(message.usage);
    } else if (event?.type === "message_delta" && active && (obj.api_message_id == null || obj.api_message_id === active.id)) {
      const delta = record(event.usage);
      if (delta && ("input_tokens" in delta || "iterations" in delta || "cache_read_input_tokens" in delta || "cache_creation_input_tokens" in delta)) {
        usage = { ...active.usage, ...delta };
      }
    }
    if (!active || !usage) return;
    // Server-side tools can produce several model iterations within a single API message.
    if (Array.isArray(usage.iterations)) {
      const last = usage.iterations.map(record).findLast(i => i?.type === "message" || i?.type === "fallback_message");
      if (!last && usage.iterations.length) return;
      usage = last ?? usage;
    }
    const input = usage.input_tokens;
    const read = usage.cache_read_input_tokens ?? 0;
    const created = usage.cache_creation_input_tokens ?? 0;
    if (!count(input) || !count(read) || !count(created) || !count(input + read + created)) return;
    const used = input + read + created;
    if (!used) {
      // Some gateways send placeholder zeroes until message_delta supplies real cache counts.
      active.usage ??= usage;
      return;
    }
    active.usage = usage;
    active.used = used;
    publish({ used_tokens: used });
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rolloutPath(home: string, id: string): string | undefined {
  if (!uuid.test(id)) return;
  // Standard Codex UUIDv7 threads carry the local rollout creation time in their ID.
  const root = realpathSync(home);
  if (id[14] === "7") {
    const date = new Date(parseInt(id.replaceAll("-", "").slice(0, 12), 16));
    const parts = [date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, "0"));
    const [month, day, hour, minute, second] = parts;
    const year = String(date.getFullYear());
    const path = join(root, "sessions", year, month, day, `rollout-${year}-${month}-${day}T${hour}-${minute}-${second}-${id}.jsonl`);
    try {
      if (realpathSync(path) === path) return path;
    } catch { /* A different creation time or timezone can require an exact index lookup. */ }
  }
  const index = join(root, "state_5.sqlite");
  if (realpathSync(index) !== index || !statSync(index).isFile()) return;
  const db = new DatabaseSync(index, { readOnly: true });
  try {
    const path = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(id)?.rollout_path;
    if (typeof path !== "string" || !isAbsolute(path)) return;
    const allowed = new RegExp(`^sessions/(\\d{4})/(\\d{2})/(\\d{2})/rollout-\\1-\\2-\\3T\\d{2}-\\d{2}-\\d{2}-${id}\\.jsonl$`);
    const target = resolve(path);
    if (allowed.test(relative(root, target).replaceAll("\\", "/")) && realpathSync(target) === target) return target;
  } finally { db.close(); }
}

// exec --json omits last_token_usage. Follow only the rollout identified by this child process.
export function codexRolloutMonitor(env: NodeJS.ProcessEnv, resumeId: string, publish: (usage: ChatContextUsage) => void) {
  const home = env.CODEX_HOME || (env.HOME && join(env.HOME, ".codex"));
  const since = Date.now();
  let offset = 0;
  let pending = "";
  let skippingLine = false;
  let turn: "waiting" | "active" | "ended" = "waiting";
  let thread = "";
  let path: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let reading: Promise<void> | undefined;
  if (resumeId && home && isAbsolute(home)) {
    try {
      path = rolloutPath(home, resumeId);
      if (path) offset = statSync(path).size;
    } catch { /* The CLI may create its index on demand. */ }
  }
  function processLine(line: string) {
    if (!line.includes('"event_msg"')) return;
    let row;
    try { row = record(JSON.parse(line)); } catch { return; }
    if (row?.type !== "event_msg" || typeof row.timestamp !== "string" || !(Date.parse(row.timestamp) >= since)) return;
    const payload = record(row.payload);
    if (payload?.type === "task_started") turn = turn === "waiting" ? "active" : "ended";
    if (turn !== "active") return;
    if (payload?.type === "token_count") {
      const usage = codexContextUsage(payload.info);
      if (usage) publish(usage);
    }
    if (payload?.type === "task_complete" || payload?.type === "turn_aborted") turn = "ended";
  }
  async function read(id: string) {
    if (!home || !isAbsolute(home) || !uuid.test(id)) return;
    try {
      path ??= rolloutPath(home, id);
      if (!path || realpathSync(path) !== path) return;
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1) return;
        const buf = Buffer.allocUnsafe(64 * 1024);
        while (offset < stat.size) {
          const { bytesRead } = await file.read(buf, 0, Math.min(buf.length, stat.size - offset), offset);
          if (!bytesRead) break;
          offset += bytesRead;
          // All whitelisted keys, event names and numbers are ASCII. Other contents stay local.
          const parts = buf.toString("latin1", 0, bytesRead).split("\n");
          for (const [i, part] of parts.entries()) {
            if (pending.length + part.length > buf.length) skippingLine = true;
            if (!skippingLine) pending += part;
            if (i < parts.length - 1) {
              if (!skippingLine) processLine(pending);
              pending = "";
              skippingLine = false;
            }
          }
        }
      } finally { await file.close(); }
    } catch { /* Missing, inaccessible, or unsupported rollouts do not affect the chat. */ }
  }
  function poll(id: string) {
    reading ??= read(id).finally(() => { reading = undefined; });
    return reading;
  }
  return {
    start(id: string) {
      if (timer || !uuid.test(id) || (resumeId && (id !== resumeId || !path))) return;
      thread = id;
      timer = setInterval(() => { void poll(thread); }, 1000).unref();
    },
    async finish() {
      clearInterval(timer);
      await reading;
      if (thread) await poll(thread);
    },
  };
}
