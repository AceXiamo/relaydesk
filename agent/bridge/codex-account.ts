import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import type { SidebarAccount } from "../../app/lib/types.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function accountIdentity(response: unknown) {
  const result = record(response);
  const account = record(result.account);
  if (account.type !== "chatgpt") return null;
  const email = text(account.email)?.toLowerCase() ?? null;
  const user = text(result.userId);
  const workspace = text(account.workspaceName);
  const accountId = text(account.accountId) ?? text(result.accountId);
  if (!user && !email && !accountId) return null;
  const key = JSON.stringify(["codex", user ?? email, accountId ?? workspace]);
  const id = `codex:${createHash("sha256").update(key).digest("hex")}`;
  return { id, user, email, workspace, accountId, name: text(account.name) ?? text(account.displayName),
    avatarUrl: text(account.avatarUrl) ?? text(account.picture), plan: text(account.planType) };
}

function windowsFor(response: unknown): SidebarAccount["windows"] {
  const result = record(response);
  const limits = record(record(result.rateLimitsByLimitId).codex ?? result.rateLimits);
  return ["primary", "secondary"].flatMap((slot) => {
    if (!limits[slot] || typeof limits[slot] !== "object") return [];
    const { usedPercent, windowDurationMins: mins, resetsAt } = record(limits[slot]);
    const reset = typeof resetsAt === "number" ? new Date(resetsAt * 1000) : null;
    let label = slot === "primary" ? "Primary" : "Secondary";
    if (typeof mins === "number" && Number.isSafeInteger(mins) && mins > 0) {
      label = mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
    }
    return [{ label, remainingPercent: typeof usedPercent === "number" && Number.isFinite(usedPercent)
      ? Math.max(0, Math.min(100, 100 - usedPercent)) : null,
    resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null }];
  });
}

export async function readCodexAccount(): Promise<SidebarAccount | null> {
  const child = spawn(process.env.RELAYDESK_CODEX_BIN || "codex", ["app-server"], {
    cwd: homedir(), stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = lines[Symbol.asyncIterator]();
  const stop = () => { lines.close(); child.kill("SIGKILL"); };
  child.on("error", stop);
  child.stdin.on("error", stop);
  const timeout = setTimeout(stop, 12_000);
  let nextId = 0;
  async function request(method: string, params?: unknown): Promise<unknown> {
    const id = ++nextId;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    for (;;) {
      const line = await replies.next();
      if (line.done) throw new Error("Codex disconnected");
      const reply = record(JSON.parse(line.value));
      if (reply.id !== id || "method" in reply) continue;
      if (reply.error) throw new Error("Codex request failed");
      return reply.result;
    }
  }
  try {
    await request("initialize", { clientInfo: { name: "relaydesk_bridge", version: "1" } });
    child.stdin.write('{"method":"initialized"}\n');
    const readIdentity = async () => accountIdentity(await request("account/read", { refreshToken: false }));
    const before = await readIdentity();
    if (!before) return null;
    const identity = before.email ?? `#${before.id.slice(6, 14)}`;
    const row = { id: before.id, service: "Codex", name: before.name, identity,
      avatarUrl: before.avatarUrl, plan: before.plan, windows: [] };
    const limits = await request("account/rateLimits/read").catch(() => null);
    const after = await readIdentity().catch(() => null);
    const usageAccount = text(record(limits).accountId);
    if (!after || before.id !== after.id || before.email !== after.email || before.workspace !== after.workspace ||
        (before.accountId && usageAccount && before.accountId !== usageAccount)) {
      return { ...row, status: "unverified" };
    }
    const windows = windowsFor(limits);
    return { ...row, plan: after.plan, windows, status: windows.length ? "ready" : "unavailable" };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    stop();
  }
}
