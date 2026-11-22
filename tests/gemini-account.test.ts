import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readGeminiAccount } from "../agent/bridge/gemini-account.ts";

let home: string;
let closeServer: (() => Promise<void>) | undefined;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "gemini-account-"));
  vi.stubEnv("HOME", home);
});
afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

const user = { name: "Example", email: "Example@test.invalid", profilePictureUrl: "data:image/png;base64,iVBORw0KGgo=",
  userTier: { name: "Google AI Ultra" }, planStatus: { planInfo: { planName: "Pro" } } };
const resetTime = "2030-11-23T12:00:00Z";
const summary = { response: { groups: [
  { displayName: "Gemini Models", buckets: [
    { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0, resetTime },
    { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.905, resetTime },
    { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1 },
  ] }, { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-5h", window: "5h", remainingFraction: 1 }] },
] } };

async function daemon(users: unknown[], quota: unknown) {
  const server = createServer((req, res) => {
    const prefix = "/exa.language_server_pb.LanguageServerService/";
    if (req.method !== "POST" || req.headers["x-codeium-csrf-token"] !== "fixture") res.writeHead(403).end();
    else if (req.url === `${prefix}GetUserStatus`) res.end(JSON.stringify({ userStatus: users.shift() }));
    else if (req.url === `${prefix}RetrieveUserQuotaSummary` && quota) res.end(JSON.stringify(quota));
    else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closeServer = () => new Promise(resolve => server.close(() => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  const dir = join(home, ".gemini", "antigravity", "daemon");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `hub_${address.port}.json`), JSON.stringify({ httpPort: address.port, csrfToken: "fixture", pid: process.pid }));
}

it("reads the profile and both Gemini windows from the same daemon", async () => {
  await daemon([user, user], summary);
  expect(await readGeminiAccount()).toEqual({ id: expect.stringMatching(/^gemini:[0-9a-f]{64}$/),
    service: "Gemini", identity: "example@test.invalid", name: user.name, plan: "Ultra", avatarUrl: user.profilePictureUrl,
    status: "ready", windows: [
      { label: "Gemini 5-hour", remainingPercent: 91, resetsAt: "2030-11-23T12:00:00.000Z" },
      { label: "Gemini weekly", remainingPercent: 0, resetsAt: "2030-11-23T12:00:00.000Z" },
    ] });
});
it("withholds quota when the account changes during the read", async () => {
  await daemon([user, { ...user, email: "other@test.invalid" }], summary);
  expect(await readGeminiAccount()).toMatchObject({ status: "unverified", windows: [] });
});
it("maps the legacy Pro plan and preserves identity when quota is unavailable", async () => {
  const legacy = { ...user, userTier: null, profilePictureUrl: null };
  await daemon([legacy, legacy], null);
  expect(await readGeminiAccount()).toMatchObject({ status: "unavailable", plan: "Ultra", avatarUrl: null, windows: [] });
});
it("uses the subscription tier when no plan name is returned", async () => {
  const free = { ...user, planStatus: null, userTier: { name: "Free" } };
  await daemon([free, free], summary);
  expect(await readGeminiAccount()).toMatchObject({ plan: "Free" });
});
it("returns null without a discoverable daemon", async () => {
  expect(await readGeminiAccount()).toBeNull();
});
