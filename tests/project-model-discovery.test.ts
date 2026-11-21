import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinModels } from "../app/lib/model-catalog.ts";
import { projectCliConfiguration } from "../server/project-cli-config.ts";
import { discoverProjectCliModels } from "../server/project-model-discovery.ts";

const { get, lookup } = vi.hoisted(() => ({ get: vi.fn(), lookup: vi.fn() }));
vi.mock("node:https", () => ({ get }));
vi.mock("node:dns", () => ({ lookup }));
const id = "a".repeat(32);
const savedKey = "saved-api-secret", formKey = "one-time-secret", token = "git-token-secret";
let dir: string, db: string;
const discover = (body: Record<string, unknown> = {}) => discoverProjectCliModels(db, id, body);
const save = (patch: Record<string, unknown>) => projectCliConfiguration(db, id, patch);
function reply(payload: unknown, statusCode = 200) {
  const bytes = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  get.mockImplementation((_url, _options, callback) => {
    const res = Object.assign(Readable.from([bytes]), { statusCode, headers: {} });
    queueMicrotask(() => callback(res));
    return new EventEmitter();
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "model-discovery-"));
  db = join(dir, "state.sqlite");
  get.mockReset();
  lookup.mockReset();
  reply({ data: [] });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe("project CLI model discovery", () => {
  it("binds stored credentials to the runtime and normalized full endpoint", async () => {
    save({ endpoint: "https://gateway.example/route/v1", api_key: savedKey, github_token: token });
    for (const body of [{}, { endpoint: "https://GATEWAY.example/route/v1/" }]) {
      await discover(body);
      expect(get).toHaveBeenLastCalledWith("https://gateway.example/route/v1/models", expect.objectContaining({ headers: { Authorization: `Bearer ${savedKey}` } }), expect.any(Function));
    }
    get.mockClear();
    for (const body of [{ api_key: "" }, { endpoint: "" }, { endpoint: "https://gateway.example/other" }, { endpoint: "https://other.example/v1", api_key: "" },
      { endpoint: "https://gateway.example:8443/route/v1" }, { runtime: "claude", endpoint: "" }]) {
      await expect(discover(body)).rejects.toMatchObject({ status: 400 });
    }
    expect(get).not.toHaveBeenCalled();
    await discover({ endpoint: "", api_key: formKey });
    expect(get).toHaveBeenLastCalledWith("https://api.openai.com/v1/models", expect.objectContaining({ headers: { Authorization: `Bearer ${formKey}` } }), expect.any(Function));
    expect(projectCliConfiguration(db, id).endpoint).toBe("https://gateway.example/route/v1");
  });

  it("uses the official Claude base and auth headers; never sends the GitHub token", async () => {
    save({ runtime: "claude", api_key: savedKey, github_token: token });
    await discover();
    expect(get).toHaveBeenLastCalledWith("https://api.anthropic.com/v1/models", expect.objectContaining({ headers: {
      "x-api-key": savedKey, "anthropic-version": "2023-06-01",
    } }), expect.any(Function));
    save({ endpoint: "https://proxy.example/api", api_key: savedKey });
    await expect(discover({ runtime: "codex" })).rejects.toMatchObject({ status: 400 });
    await discover({ runtime: "codex", api_key: formKey });
    expect(get.mock.lastCall![0]).toBe("https://api.openai.com/v1/models");
    await discover({ endpoint: "https://other.example", api_key: formKey });
    expect(get.mock.lastCall![0]).toBe("https://other.example/v1/models");
    expect(get.mock.lastCall![1].headers).toEqual({ "x-api-key": formKey, "anthropic-version": "2023-06-01" });
  });

  it("rejects invalid inputs and unsafe URLs before network I/O", async () => {
    for (const body of [{}, { api_key: "no spaces" }, { github_token: token }, { runtime: null, api_key: formKey },
      { api_key: null }, { endpoint: null }, ...["http://public.example", "https://localhost", "https://[::1]", "https://user@public.example", "https://public.example/v1/models", `https://public.example/${formKey}`].map(endpoint => ({ endpoint, api_key: formKey }))]) {
      await expect(discover(body)).rejects.toMatchObject({ status: 400, message: expect.not.stringContaining(formKey) });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("pins only public DNS results to the connection, rejecting mixed or empty answers", async () => {
    await discover({ api_key: formKey });
    const options = get.mock.lastCall![1];
    expect(options.agent).toBe(false);
    const resolve = (options.lookup as LookupFunction);
    const cb = vi.fn();
    const addr = (address: string) => ({ address, family: address.includes(":") ? 6 : 4 });
    for (const bad of ["127.0.0.1", "10.8.0.1", "169.254.169.254", "168.63.129.16", "192.168.4.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1", "2002:a00::", "64:ff9b::a00:1"]) {
      lookup.mockImplementation((_host, _opts, done) => done(null, [addr("8.8.8.8"), addr(bad)]));
      resolve("gateway.example", { all: true }, cb);
      expect(cb.mock.lastCall![0]).toBeInstanceOf(Error);
    }
    lookup.mockImplementation((_host, _opts, done) => done(null, []));
    resolve("gateway.example", {}, cb);
    expect(cb.mock.lastCall![0]).toBeInstanceOf(Error);
    const publicAnswers = [addr("8.8.8.8"), addr("2606:4700:4700::1111")];
    lookup.mockImplementation((_host, _opts, done) => done(null, publicAnswers));
    resolve("gateway.example", { all: true }, cb);
    expect(cb).toHaveBeenLastCalledWith(null, publicAnswers);
    resolve("gateway.example", {}, cb);
    expect(cb).toHaveBeenLastCalledWith(null, "8.8.8.8", 4);
  });

  it("sorts unique safe IDs before limiting results, ignoring untrusted metadata", async () => {
    save({ api_key: savedKey, github_token: token });
    const known = builtinModels.find(model => model.runtime === "codex")!;
    const ids = Array.from({ length: 90 }, (_, i) => `z${String(90 - i).padStart(2, "0")}`);
    reply({ data: [null, { id: "-flag" }, { id: "\n" }, { id: 3 }, { id: `leaked-${token}` }, { id: savedKey }, { id: formKey },
      { id: known.id, label: token }, ...[...ids, ...ids].map(id => ({ id, owned_by: formKey, label: token }))] });
    const found = await discover({ api_key: formKey });
    expect(found.map(m => m.id)).toEqual([...ids, known.id].sort().slice(0, 80));
    expect(found.find(m => m.id === known.id)).toEqual({ ...known, source: "detected" });
    expect(found.find(m => m.id === "z01")).toEqual({ id: "z01", runtime: "codex", source: "detected" });
    for (const secret of [token, savedKey, formKey]) expect(JSON.stringify(found)).not.toContain(secret);
  });

  it("never follows redirects or exposes provider error text, and bounds the response", async () => {
    for (const [status, payload] of [[307, { location: "https://other.example", data: [] }], [401, { message: formKey }], [200, formKey],
      [200, { data: {} }], [200, JSON.stringify({ data: [], padding: "x".repeat(1024 * 1024) })]] as const) {
      get.mockClear();
      reply(payload, status);
      await expect(discover({ api_key: formKey })).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining(formKey) });
      expect(get).toHaveBeenCalledTimes(1);
    }
  });

  it("applies a 12-second absolute deadline through response streaming", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    get.mockImplementation((_url, options, callback: (res: IncomingMessage) => void) => {
      const stream = Object.assign(new Readable({ read() {} }), { statusCode: 200 });
      options.signal.addEventListener("abort", () => stream.destroy(new Error(formKey)), { once: true });
      callback(stream as IncomingMessage);
      setImmediate(() => controller.abort());
      return new EventEmitter();
    });
    await expect(discover({ api_key: formKey })).rejects.toMatchObject({ status: 504, message: expect.not.stringContaining(formKey) });
    expect(timeout).toHaveBeenCalledWith(12_000);
  });
});
