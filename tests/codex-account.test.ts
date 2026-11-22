import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { readCodexAccount } from "../agent/bridge/codex-account.ts";

let dir: string;
let bin: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-account-"));
  bin = join(dir, "codex.mjs");
  await writeFile(bin, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
const steps = ['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read'];
let step = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (process.cwd() !== homedir() || process.argv[2] !== 'app-server' || method !== steps[step++]) process.exit(1);
  if (method === 'initialized') continue;
  const mode = process.env.FAKE_CODEX_CASE;
  let result = {};
  if (method === 'account/read') {
    if (params.refreshToken !== false) process.exit(1);
    const workspaceName = mode === 'switched' && step === 5 ? 'second' : 'first';
    result = { userId: 'private-user-id', account: mode === 'signed-out' ? null : {
      type: 'chatgpt', workspaceName, name: mode === 'anonymous' ? null : 'Demo', email: mode === 'anonymous' ? null : 'a@example.org', planType: 'pro'
    }};
  }
  if (method === 'account/rateLimits/read') {
    if (mode === 'failed') { console.log(JSON.stringify({ id, error: {message:'private-error'} })); continue; }
    result = { rateLimitsByLimitId: { codex: {primary: { windowDurationMins: 300, usedPercent: 37, resetsAt: 3600 },
      secondary: { windowDurationMins: 10080, usedPercent: 100 }}}, token: 'private-token' };
  }
  console.log(JSON.stringify({method:'ignored/notification'}));
  console.log(JSON.stringify({ id, result }));
}
`);
  await chmod(bin, 0o700);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

function read(mode: string) {
  vi.stubEnv("RELAYDESK_CODEX_BIN", bin);
  vi.stubEnv("FAKE_CODEX_CASE", mode);
  return readCodexAccount();
}

it("returns stable scoped identity and normalized quota windows", async () => {
  const row = await read("normal");
  expect(row).toMatchObject({ id: expect.stringMatching(/^codex:[0-9a-f]{64}$/), name: "Demo", plan: "pro", status: "ready",
    windows: [{ label: "5h", remainingPercent: 63, resetsAt: "1970-01-01T01:00:00.000Z" },
      { label: "7d", remainingPercent: 0, resetsAt: null }] });
  expect(await read("anonymous")).toMatchObject({ id: row!.id, name: null, identity: expect.stringMatching(/^#[0-9a-f]{8}$/) });
  expect(JSON.stringify(row)).not.toContain("private-");
});

it("withholds quota if the workspace switches between reads", async () => {
  expect(await read("switched")).toMatchObject({ status: "unverified", windows: [] });
});

it("keeps a verified account when quota retrieval fails", async () => {
  const row = await read("failed");
  expect(row).toMatchObject({ status: "unavailable", windows: [] });
  expect(JSON.stringify(row)).not.toContain("private-error");
});

it("returns null when signed out or the CLI is missing", async () => {
  expect(await read("signed-out")).toBeNull();
  vi.stubEnv("RELAYDESK_CODEX_BIN", join(dir, "missing"));
  expect(await readCodexAccount()).toBeNull();
});
