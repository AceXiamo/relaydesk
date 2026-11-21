import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bearer, fixture, sha256, type Fixture } from "./bridge-fixture.ts";

let f: Fixture | undefined;
let tempDir: string | undefined;
const prevBundleEnv = process.env.RELAYDESK_BRIDGE_BUNDLE_PATH;

afterEach(async () => {
  if (prevBundleEnv === undefined) delete process.env.RELAYDESK_BRIDGE_BUNDLE_PATH;
  else process.env.RELAYDESK_BRIDGE_BUNDLE_PATH = prevBundleEnv;
  if (f) await f.close();
  f = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Standalone bridge bundle and authenticated client distribution", () => {
  it("bundles a zero-dependency standalone ESM client and serves it with Bearer auth and SHA-256", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "relaydesk-standalone-bridge-"));
    const bundlePath = join(tempDir, "relaydesk-bridge.mjs");
    execFileSync(process.execPath, [resolve("scripts/build-bridge.mjs"), bundlePath], {
      encoding: "utf8",
    });
    const builtBytes = readFileSync(bundlePath);
    const built = { size: statSync(bundlePath).size, sha256: sha256(builtBytes) };
    expect(built.size).toBeGreaterThan(20_000);

    // Execute outside the repository working directory (no local node_modules)
    const version = execFileSync(process.execPath, [bundlePath, "--version"], {
      cwd: tempDir,
      encoding: "utf8",
    }).trim();
    expect(version).toBe("2.0.0");

    const help = execFileSync(process.execPath, [bundlePath, "--help"], {
      cwd: tempDir,
      encoding: "utf8",
    });
    expect(help).toContain("Relaydesk Local Bridge");

    process.env.RELAYDESK_BRIDGE_BUNDLE_PATH = bundlePath;
    f = await fixture();

    // Register returns client_url, quickstart_config, and standalone start_command
    const created = await f.ok("/bridge/agents", "POST", { name: "Zero-Source Mac" });
    expect(created.client_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/bridge\/client\.mjs$/);
    expect(created.start_command).toContain("relaydesk-bridge.mjs");
    expect(created.quickstart_config.agent_token).toBe(created.token);

    // Unauthenticated or query-token requests are rejected
    expect((await fetch(`${f.srv.url}/api/bridge/client.mjs`)).status).toBe(401);
    expect((await fetch(`${f.srv.url}/api/bridge/client.mjs?token=${created.token}`)).status).toBe(401);

    // Authenticated device request succeeds with exact SHA-256 header
    const res = await fetch(`${f.srv.url}/api/bridge/client.mjs`, {
      headers: bearer(created.token),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    const headerSha = res.headers.get("x-content-sha256");
    const body = Buffer.from(await res.arrayBuffer());
    expect(headerSha).toBe(built.sha256);
    expect(sha256(body)).toBe(built.sha256);

    // Rotating token returns fresh client_url + quickstart_config and invalidates old token
    const rotated = await f.ok(`/bridge/agents/${created.agent.id}/rotate-token`, "POST", {});
    expect(rotated.client_url).toBe(created.client_url);
    expect(rotated.quickstart_config.agent_token).toBe(rotated.token);
    expect(rotated.token).not.toBe(created.token);

    expect(
      (await fetch(`${f.srv.url}/api/bridge/client.mjs`, { headers: bearer(created.token) })).status,
    ).toBe(401);
    expect(
      (await fetch(`${f.srv.url}/api/bridge/client.mjs`, { headers: bearer(rotated.token) })).status,
    ).toBe(200);
  });
});
