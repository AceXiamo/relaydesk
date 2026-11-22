import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SidebarAccount } from "../../app/lib/types.ts";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function accountFrom(status: any) {
  const identity = text(status?.email)?.toLowerCase();
  if (!identity) return null;
  const tier = (text(status.planStatus?.planInfo?.planName) ?? text(status.userTier?.name))?.replace(/^Google AI\s+/i, "");
  const avatar = text(status.profilePictureUrl);
  return {
    id: `gemini:${createHash("sha256").update(identity).digest("hex")}`, identity,
    name: text(status.name), service: "Gemini",
    avatarUrl: avatar && (/^https:\/\//i.test(avatar) || /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/i.test(avatar)) ? avatar : null,
    plan: tier?.toLowerCase() === "pro" ? "Ultra" : tier ?? null,
  };
}

function quotaWindows(groups: unknown): SidebarAccount["windows"] {
  if (!Array.isArray(groups)) return [];
  const windows: SidebarAccount["windows"] = [];
  for (const group of groups) {
    if (!/^gemini\b/i.test(text(group?.displayName) ?? "") || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      if (!text(bucket?.bucketId)?.startsWith("gemini-")) continue;
      const duration = text(bucket.window);
      const label = duration === "5h" ? "Gemini 5-hour" : duration === "weekly" ? "Gemini weekly" : text(bucket.displayName);
      if (!label) continue;
      const fraction = bucket.remainingFraction;
      const reset = Date.parse(text(bucket.resetTime) ?? "");
      windows.push({ label, remainingPercent: typeof fraction === "number" && fraction >= 0 && fraction <= 1
        ? Math.round(100 * fraction) : null, resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null });
    }
  }
  return windows.sort((a, b) => a.label.localeCompare(b.label));
}

export async function readGeminiAccount(): Promise<SidebarAccount | null> {
  const dir = join(homedir(), ".gemini", "antigravity", "daemon");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const signal = AbortSignal.timeout(10_000);
  for (const entry of entries) {
    if (!entry.isFile() || !/^hub_\d+\.json$/.test(entry.name)) continue;
    try {
      const { httpPort, csrfToken, pid } = JSON.parse(await readFile(join(dir, entry.name), "utf8"));
      if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535 || entry.name !== `hub_${httpPort}.json` ||
          !Number.isSafeInteger(pid) || pid < 1 || !text(csrfToken)) continue;
      process.kill(pid, 0);
      const rpc = async (method: string) => {
        const response = await fetch(`http://127.0.0.1:${httpPort}/exa.language_server_pb.LanguageServerService/${method}`, {
          method: "POST", redirect: "error", signal, body: "{}",
          headers: { "content-type": "application/json", "x-codeium-csrf-token": csrfToken },
        });
        if (!response.ok) throw new Error("Antigravity RPC failed");
        return response.json();
      };
      const readAccount = async () => accountFrom((await rpc("GetUserStatus"))?.userStatus);
      const before = await readAccount();
      if (!before) continue;
      const summary = await rpc("RetrieveUserQuotaSummary").catch(() => null);
      const after = await readAccount().catch(() => null);
      if (before.id !== after?.id) return { ...before, status: "unverified", windows: [] };
      const windows = quotaWindows(summary?.response?.groups);
      return { ...after, windows, status: windows.length ? "ready" : "unavailable" };
    } catch {
      // A stopped daemon can leave its discovery file behind.
      if (signal.aborted) break;
    }
  }
  return null;
}
