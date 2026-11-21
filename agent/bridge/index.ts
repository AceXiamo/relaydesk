import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { bridgeCatalogPaths, detectBridgeCatalog, type BridgeCatalog, type BridgeCatalogConfig } from "./catalog.ts";
import { checkChat, datasourceValues, runLocalChat, type ChatStart } from "./runner.ts";
import { pushChangedShadowFiles, snapshotShadowFiles, syncSpace, validProjectId, type WorkspaceRpc } from "./space-sync.ts";
import type { RunChatTurnResult } from "../../server/codex-chat.ts";

interface Project {
  workdir: string;
  allow_datasource_secrets?: boolean;
  bound_via_web?: boolean;
}
interface Config extends BridgeCatalogConfig {
  server_url: string;
  agent_token: string;
  allowed_roots?: string[];
  max_concurrency?: number;
  accept_cli_runs?: boolean;
  cache_dir?: string;
  projects?: Record<string, Project>;
}
export interface BridgeDaemonOptions {
  configPath: string;
  cacheDir?: string;
  homeDir?: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  disconnectGraceMs?: number;
}
function load(path: string): Config {
  const fd = openSync(path, constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_RDONLY);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > 1024 * 1024) throw new Error("Invalid bridge configuration file");
    if ((st.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    let config: Config;
    try {
      config = JSON.parse(readFileSync(fd, "utf8")) as Config;
    } catch {
      throw new Error("Invalid bridge configuration JSON");
    }
    const url = new URL(config.server_url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "wss:" && !(loopback && url.protocol === "ws:")) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.pathname !== "/api/bridge/ws"
    )
      throw new Error("Use a secure bridge WebSocket URL without credentials or query parameters");
    if (typeof config.agent_token !== "string" || !/^[!-~]{1,4096}$/.test(config.agent_token))
      throw new Error("Invalid bridge credential");
    if (
      config.allowed_roots !== undefined &&
      (!Array.isArray(config.allowed_roots) || config.allowed_roots.some((p) => typeof p !== "string"))
    )
      throw new Error("Invalid allowed_roots");
    if (
      config.projects !== undefined &&
      (!config.projects || typeof config.projects !== "object" || Array.isArray(config.projects))
    )
      throw new Error("Invalid project bindings");
    if (
      config.max_concurrency !== undefined &&
      (!Number.isSafeInteger(config.max_concurrency) || config.max_concurrency < 1 || config.max_concurrency > 64)
    )
      throw new Error("Invalid max_concurrency");
    return config;
  } finally {
    closeSync(fd);
  }
}
function save(path: string, config: Config) {
  const tmp = join(dirname(path), `.relaydesk-${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try {
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
function expand(path: string, home: string) {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}
function workdir(path: unknown, home: string) {
  if (typeof path !== "string" || !path || !isAbsolute(expand(path, home)))
    throw new Error("Workdir must be an existing absolute directory");
  try {
    const real = realpathSync(expand(path, home));
    if (
      !statSync(real).isDirectory() ||
      real === parse(real).root ||
      real === (existsSync(home) ? realpathSync(home) : home)
    )
      throw new Error();
    accessSync(real, constants.R_OK | constants.X_OK);
    return real;
  } catch {
    throw new Error("Workdir is unavailable or unsafe");
  }
}
function inside(root: string, dir: string) {
  const rel = relative(root, dir);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function projectWorkdir(project: Project, config: Config, home: string) {
  const cwd = workdir(project.workdir, home);
  const roots = config.allowed_roots ?? [];
  if ((roots.length || project.bound_via_web) && !roots.some(root => {
    try {
      const path = expand(root, home);
      return isAbsolute(path) && inside(realpathSync(path), cwd);
    } catch { return false; }
  })) throw new Error("Project workdir is outside allowed roots");
  if (project.bound_via_web && cwd !== project.workdir) throw new Error("Web-bound workdir has changed");
  return cwd;
}
// One shared shadow per project: serialize pulls, CLI execution and push as a unit.
// Waiters still count towards the machine's admission limit and are independently cancellable.
function projectLocks() {
  const locks = new Map<string, Set<() => void>>();
  return (project: string, signal: AbortSignal): Promise<() => void> =>
    new Promise((accept, reject) => {
      signal.throwIfAborted();
      const existing = locks.get(project),
        queue = existing ?? new Set<() => void>();
      function release() {
        const next = queue.values().next().value;
        if (next) {
          queue.delete(next);
          next();
        } else locks.delete(project);
      }
      const claim = () => {
        signal.removeEventListener("abort", cancel);
        accept(release);
      };
      const cancel = () => {
        queue.delete(claim);
        reject(new Error("Workspace wait cancelled"));
      };
      if (!existing) {
        locks.set(project, queue);
        accept(release);
      } else {
        queue.add(claim);
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
}
function projects(config: Config, home: string) {
  return Object.entries(config.projects ?? {})
    .filter(([id]) => validProjectId(id))
    .map(([project_id, p]) => {
      try {
        const cwd = projectWorkdir(p, config, home);
        const git = (args: string[]) =>
          spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
            cwd,
            encoding: "utf8",
            timeout: 1500,
            maxBuffer: 32768,
          });
        const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
        const dirty = branch.status === 0 ? git(["status", "--porcelain", "--ignore-submodules=all"]) : undefined;
        return {
          project_id,
          workdir: cwd,
          path_ok: true,
          path_error: "",
          git_branch: branch.stdout?.trim().slice(0, 200) || "",
          has_dirty_files: Boolean(dirty?.stdout?.length),
        };
      } catch {
        return {
          project_id,
          workdir: typeof p?.workdir === "string" ? p.workdir : "",
          path_ok: false,
          path_error: "Workdir is unavailable or unsafe",
        };
      }
    });
}
function databaseContext(rows: unknown) {
  if (!Array.isArray(rows) || !rows.length) return "";
  const fields = ["name", "kind", "source", "file_path", "host_preview", "env_var", "read_only", "notes"];
  return (
    "Project datasource metadata (never print connection strings):\n" +
    rows
      .slice(0, 100)
      .map((row) => {
        if (!row || typeof row !== "object") return "";
        return JSON.stringify(
          Object.fromEntries(
            fields.flatMap((key) => {
              const value = row[key];
              return typeof value === "string"
                ? [[key, value.slice(0, 2000)]]
                : typeof value === "boolean"
                  ? [[key, String(value)]]
                  : [];
            }),
          ),
        );
      })
      .join("\n")
  );
}
const message = (error: unknown) => (error instanceof Error ? error.message : "Bridge operation failed");
type Frame = { type: string; id?: string; payload: Record<string, unknown> };
function send(ws: WebSocket, type: string, payload: unknown, id?: string) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 8 * 1024 * 1024) {
    ws.terminate();
    return;
  }
  ws.send(JSON.stringify({ type, id, ts: new Date().toISOString(), payload }));
}

export async function startBridgeDaemon(o: BridgeDaemonOptions): Promise<{ close(): Promise<void> }> {
  const path = resolve(o.configPath),
    home = resolve(o.homeDir ?? homedir()),
    options = { homeDir: home, configDir: dirname(path) };
  let config = load(path),
    catalog = await detectBridgeCatalog(config, options);
  let ws: WebSocket | undefined,
    closed = false,
    superseded = false;
  const min = Math.max(10, o.reconnectMinMs ?? 1000),
    max = Math.max(min, o.reconnectMaxMs ?? 30000);
  let backoff = min,
    reconnect: NodeJS.Timeout | undefined,
    debounce: NodeJS.Timeout | undefined;
  let watchers: FSWatcher[] = [],
    version = 0;
  const lock = projectLocks();
  const active = new Map<
    string,
    { abort: AbortController; socket: WebSocket; project: string; session: string; job: Promise<void> }
  >();
  const report = (c: Config, cat: BridgeCatalog) => ({
    hostname: hostname(),
    platform: process.platform,
    bridge_version: "2.0.0",
    max_concurrency: c.max_concurrency ?? 2,
    accept_cli_runs: c.accept_cli_runs === true,
    ...cat,
    allowed_roots_enabled: !!c.allowed_roots?.length,
    projects: projects(c, home),
  });
  function schedule() {
    if (closed || superseded || reconnect) return;
    reconnect = setTimeout(() => {
      reconnect = undefined;
      connect();
    }, backoff);
    backoff = Math.min(max, backoff * 2);
  }
  function watchConfigs() {
    watchers.forEach((w) => w.close());
    watchers = [];
    const dirs = new Map<string, Set<string>>();
    for (const target of [path, ...bridgeCatalogPaths(config, options)]) {
      let dir = dirname(target);
      while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
      if (!dirs.has(dir)) dirs.set(dir, new Set());
      dirs.get(dir)!.add(relative(dir, target).split(sep)[0]);
    }
    for (const [dir, names] of dirs) {
      try {
        const w = watch(dir, (_event, filename) => {
          if (!filename || names.has(filename)) {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
              void reload();
            }, 500);
          }
        });
        w.on("error", () => {
          /* The next refresh will re-arm removed directories. */
        });
        watchers.push(w);
      } catch {
        /* Optional catalog directory may have disappeared. */
      }
    }
  }
  async function reload(id?: string) {
    const rev = ++version;
    try {
      const next = load(path);
      const changed = config.server_url !== next.server_url || config.agent_token !== next.agent_token;
      if (changed) {
        ws?.terminate();
        superseded = false;
      }
      config = next;
      const updated = await detectBridgeCatalog(next, options);
      if (closed || rev !== version) return;
      catalog = updated;
      watchConfigs();
      if (!changed && ws) send(ws, "catalog.sync", report(config, catalog), id);
      if (!ws) schedule();
    } catch {
      /* Partial config saves must not publish secrets or crash the daemon. */
    }
  }
  function connect() {
    if (closed || superseded) return;
    const socket = new WebSocket(config.server_url, {
      headers: { Authorization: `Bearer ${config.agent_token}` },
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
    });
    ws = socket;
    let ready = false,
      lastPing = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPing > 35_000) socket.terminate();
    }, 5000);
    socket.on("ping", () => {
      lastPing = Date.now();
    }); // ws automatically sends the matching pong.
    socket.on("error", () => {
      /* close handles cleanup and backoff, including HTTP 401. */
    });
    socket.once("open", () => {
      send(socket, "hello", report(config, catalog));
    });
    const pending = new Map<string, { type: string; finish(payload?: Record<string, unknown>): void }>();
    const rpc: WorkspaceRpc = (type, payload, signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted || socket.readyState !== WebSocket.OPEN) {
          reject(new Error("Workspace RPC cancelled"));
          return;
        }
        const id = randomUUID();
        const abort = () => finish();
        const timer = setTimeout(abort, 30_000);
        const finish = (reply?: Record<string, unknown>) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          pending.delete(id);
          if (reply?.ok === true) resolve(reply);
          else
            reject(
              new Error(
                reply ? `Workspace RPC rejected (${Number(reply.status) || 400})` : "Workspace RPC interrupted",
              ),
            );
        };
        pending.set(id, { type: `${type}.result`, finish });
        signal.addEventListener("abort", abort, { once: true });
        send(socket, type, payload, id);
      });
    function bind(f: Frame) {
      const id = f.payload.project_id,
        input = f.payload.workdir;
      try {
        const c = load(path);
        if (c.agent_token !== config.agent_token || c.server_url !== config.server_url)
          throw new Error("Bridge configuration changed");
        if (!validProjectId(id) || !c.allowed_roots?.length) throw new Error("Remote project binding not permitted");
        const binding = { ...c.projects?.[id], workdir: workdir(input, home), bound_via_web: true };
        const cwd = projectWorkdir(binding, c, home);
        c.projects = { ...c.projects, [id]: binding };
        save(path, c);
        config = c;
        send(
          socket,
          "project.bind.result",
          { project_id: id, ok: true, path_ok: true, path_error: "", workdir: cwd, requested_workdir: input },
          f.id,
        );
      } catch (e) {
        send(
          socket,
          "project.bind.result",
          {
            project_id: id,
            ok: false,
            path_ok: false,
            path_error: message(e),
            error: message(e),
            workdir: input,
            requested_workdir: input,
            status: 400,
          },
          f.id,
        );
      }
    }
    function start(p: ChatStart) {
      if (![p.run_id, p.session_id].every((s) => typeof s === "string" && /^[\w.:\-]{1,160}$/.test(s))) return;
      const ids = { run_id: p.run_id, session_id: p.session_id };
      const terminal = (result: RunChatTurnResult) =>
        send(socket, "chat.event", { ...ids, event: { type: result.status === "error" ? "error" : "done" }, result });
      const fail = (error: string): RunChatTurnResult => ({
        status: "error",
        error,
        content: "",
        events: [],
        externalSessionId: "",
      });
      if (active.has(p.run_id)) return;
      if (
        active.size >= (config.max_concurrency ?? 2) ||
        [...active.values()].some((a) => a.session === p.session_id)
      ) {
        terminal(fail("Bridge or project workspace is busy"));
        return;
      }
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(new Error("Local chat timed out")), 8 * 60_000);
      const c = config,
        cat = catalog;
      const job = (async () => {
        let result: RunChatTurnResult;
        let release: (() => void) | undefined;
        try {
          checkChat(p);
          if (!validProjectId(p.project_id) || !Object.hasOwn(c.projects ?? {}, p.project_id))
            throw new Error("Project is not locally bound");
          release = await lock(p.project_id, abort.signal);
          abort.signal.throwIfAborted();
          const project = config.projects?.[p.project_id];
          if (!project) throw new Error("Project binding was removed");
          const cwd = projectWorkdir(project, config, home);
          if (!cat.runtimes[p.runtime].available) throw new Error("Requested CLI is not available");
          const opts = {
            workdir: cwd,
            cacheDir:
              o.cacheDir ?? (c.cache_dir ? expand(c.cache_dir, home) : join(home, ".cache/relaydesk-bridge/spaces")),
            projectId: p.project_id,
            runId: p.run_id,
            serverUrl: c.server_url,
            token: c.agent_token,
            rpc,
            signal: abort.signal,
          };
          const onEvent = (event: unknown) => send(socket, "chat.event", { ...ids, event });
          onEvent({ type: "status", message: "正在同步本机项目空间…" });
          const mirror = await syncSpace(opts, p.workspace_manifest);
          const before = p.sandbox_mode === "workspace-write" ? snapshotShadowFiles(mirror) : null;
          if (!config.projects?.[p.project_id] || projectWorkdir(config.projects[p.project_id], config, home) !== cwd)
            throw new Error("Project binding changed during sync");
          const prompt = [
            "./ is the bound local project workdir. $RELAYDESK_SPACE_DIR/HANDBOOK.md is the project handbook; $RELAYDESK_SPACE_DIR/files/ contains cloud workspace files and SQLite databases. Never disclose credentials or database connection strings.",
            p.sandbox_mode === "read-only"
              ? "This is a read-only turn. Do not modify either workspace."
              : "Only changes under the shadow files/ directory can be synchronized to the cloud. Treat HANDBOOK.md as read-only.",
            mirror.handbook,
            databaseContext(p.workspace_manifest.databases),
            mirror.skipped.length ? `Large files not mirrored: ${mirror.skipped.join(", ")}` : "",
            p.system_context,
            p.prompt,
          ]
            .filter(Boolean)
            .join("\n\n");
          result = await runLocalChat({
            config: c,
            catalog: cat,
            p,
            cwd,
            homeDir: home,
            spaceDir: mirror.root,
            allowSecrets: project.allow_datasource_secrets !== false,
            signal: abort.signal,
            prompt,
            onEvent,
          });
          if (!abort.signal.aborted && result.status === "done" && before) {
            const n = await pushChangedShadowFiles(opts, mirror, before, [c.agent_token, ...datasourceValues(p.datasource_env).secrets]);
            if (n) {
              const event = {
                id: `space-${p.run_id}`,
                tool: "workspace.push",
                status: "done" as const,
                summary: `已同步 ${n} 个项目空间文件到云端`,
              };
              result.events.push(event);
              onEvent({ type: "tool", event });
            }
          }
        } catch (e) {
          result = fail(message(e));
        } finally {
          release?.();
        }
        if (abort.signal.aborted)
          result =
            abort.signal.reason?.message === "Local chat timed out"
              ? { ...result, status: "error", error: "Local chat timed out" }
              : { ...result, status: "aborted", error: undefined };
        terminal(result);
      })().finally(() => {
        clearTimeout(timeout);
        active.delete(p.run_id);
      });
      active.set(p.run_id, { abort, socket, project: p.project_id, session: p.session_id, job });
    }
    socket.on("message", (data, binary) => {
      if (closed || ws !== socket || binary) return;
      let f: Frame;
      try {
        f = JSON.parse(data.toString());
      } catch {
        socket.close(1007);
        return;
      }
      if (!f || typeof f.type !== "string" || !f.payload || typeof f.payload !== "object") {
        socket.close(1007);
        return;
      }
      if (f.type === "hello.ack") {
        ready = true;
        backoff = min;
        return;
      }
      if (!ready) return;
      const reply = f.id && pending.get(f.id);
      if (reply && reply.type === f.type) {
        reply.finish(f.payload);
        return;
      }
      if (f.type === "catalog.refresh") void reload(f.id);
      if (f.type === "project.bind") bind(f);
      if (f.type === "chat.start") start(f.payload as unknown as ChatStart);
      if (f.type === "chat.abort") {
        const a = active.get(String(f.payload.run_id));
        if (a && a.socket === socket && (!f.payload.session_id || f.payload.session_id === a.session)) a.abort.abort();
      }
    });
    socket.once("close", (code) => {
      clearInterval(heartbeat);
      pending.forEach((entry) => entry.finish());
      for (const a of active.values())
        if (a.socket === socket) {
          if (!o.disconnectGraceMs || closed) a.abort.abort();
          else {
            const timer = setTimeout(() => a.abort.abort(), o.disconnectGraceMs);
            void a.job.finally(() => clearTimeout(timer));
          }
        }
      if (ws === socket) {
        ws = undefined;
        superseded = code === 4001;
        schedule();
      }
    });
  }
  watchConfigs();
  connect();
  return {
    async close() {
      closed = true;
      version++;
      watchers.forEach((w) => w.close());
      watchers = [];
      clearTimeout(reconnect);
      clearTimeout(debounce);
      const connection = ws ? new Promise<void>((resolve) => ws!.once("close", () => resolve())) : Promise.resolve();
      for (const a of active.values()) a.abort.abort();
      ws?.terminate();
      await Promise.allSettled([connection, ...[...active.values()].map((a) => a.job)]);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args[0] !== "--config" || args.length !== 2)) {
    console.error("Usage: pnpm bridge [--config PATH]");
    process.exitCode = 1;
  } else {
    try {
      const daemon = await startBridgeDaemon({
        configPath:
          args[1] ?? process.env.RELAYDESK_BRIDGE_CONFIG ?? join(homedir(), ".config/relaydesk-bridge/config.json"),
      });
      for (const sig of ["SIGTERM", "SIGINT"] as const)
        process.once(sig, () => {
          void daemon.close();
        });
    } catch {
      console.error("Unable to start bridge. Check the local configuration and file permissions.");
      process.exitCode = 1;
    }
  }
}
