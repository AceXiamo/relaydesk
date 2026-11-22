import { z } from "zod";

export type AccountProvider = "codex" | "gemini";
const label = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\x00-\x1f\x7f]*$/u);
const account = z.object({
  id: label(200).regex(/^[a-zA-Z0-9:_-]+$/),
  identity: z.union([z.email().max(254), z.string().regex(/^#[a-f0-9]{8}$/)]).optional().catch(undefined),
  name: label(254).nullable(),
  avatarUrl: z.string().max(128 * 1024).transform(safeAvatar).nullable().catch(null),
  plan: label(100).nullable(),
  status: z.enum(["ready", "unverified", "unavailable"]),
  windows: z.array(z.object({
    label: label(120),
    remainingPercent: z.number().min(0).max(100).nullable(),
    resetsAt: z.iso.datetime({ offset: true }).nullable(),
  })).max(32),
});

function safeAvatar(value: string): string | null {
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/]+={0,2}$/i.test(value)) return value;
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash) return url.href;
  } catch { /* A malformed avatar should not hide the account. */ }
  return null;
}

function normalizePlan(provider: AccountProvider, plan: string | null): string | null {
  if (!plan) return null;
  const key = plan.toLowerCase();
  if (provider === "codex" && key === "prolite") return "Pro 5x";
  if (provider === "gemini" && key === "pro") return "Ultra";
  return plan;
}

// Use the same allowlist before transmission and again at the server trust boundary.
export function sanitizeSidebarAccount(provider: AccountProvider, value: unknown) {
  const parsed = account.safeParse(value);
  if (!parsed.success) return null;
  const row = parsed.data;
  return {
    ...row,
    plan: normalizePlan(provider, row.plan),
    service: provider === "codex" ? "Codex" : "Gemini",
    windows: row.status === "ready" ? row.windows : [],
  };
}
