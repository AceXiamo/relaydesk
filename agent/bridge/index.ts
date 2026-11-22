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
import { chatWatchdog, chatTimeoutMessage, type ChatTimeoutReason } from "./chat-timeouts.ts";
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
export const BRIDGE_VERSION = "2.0.0";

export interface BridgeDaemonOptions {
  configPath: string;
  cacheDir?: string;
  homeDir?: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  disconnectGraceMs?: number;
  verbose?: boolean;
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
function missingResumeSession(detail: string) {
  return [
    /\bno (?:matching )?(?:conversation|session|thread|rollout) found/i,
    /\b(?:could not|cannot|unable to) find (?:a |the )?(?:conversation|session|thread|rollout)\b/i,
    /\b(?:session|thread|conversation)(?: id)?(?: ['"\w.:-]+)? (?:was not found|not found|does not exist)\b/i,
    /(?:线程|会话)(?:不存在|未找到)|未找到(?:对应的)?(?:线程|会话)/,
  ].some(pattern => pattern.test(detail));
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
    bridge_version: BRIDGE_VERSION,
    max_concurrency: c.max_concurrency ?? 2,
    accept_cli_runs: c.accept_cli_runs === true,
    ...cat,
    allowed_roots_enabled: !!c.allowed_roots?.length,
    projects: projects(c, home),
  });
  const log = (msg: string) => {
    if (o.verbose) console.log(`[relaydesk-bridge] ${new Date().toISOString()} ${msg}`);
  };
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
    const bridgeRpc = (
      type: "workspace.fetch" | "workspace.push" | "task.rpc",
      payload: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        if (signal.aborted || socket.readyState !== WebSocket.OPEN) {
          reject(new Error("Bridge RPC cancelled"));
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
          else {
            const detail = typeof reply?.error === "string" && reply.error.trim() ? reply.error.trim() : "";
            reject(
              new Error(
                detail ||
                  (reply ? `Bridge RPC rejected (${Number(reply.status) || 400})` : "Bridge RPC interrupted"),
              ),
            );
          }
        };
        pending.set(id, { type: `${type}.result`, finish });
        signal.addEventListener("abort", abort, { once: true });
        send(socket, type, payload, id);
      });
    const rpc: WorkspaceRpc = (type, payload, signal) => bridgeRpc(type, payload, signal);
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
      if (active.has(p.run_id)) return;
      // A follow-up may arrive while its cancelled predecessor is reaping children.
      // The predecessor still owns the project lock until cleanup is complete.
      const admitted = [...active.values()].filter(run =>
        !(run.abort.signal.aborted && run.session === p.session_id && run.project === p.project_id));
      if (admitted.length >= (config.max_concurrency ?? 2) || admitted.some(run => run.session === p.session_id)) {
        terminal({ status: "error", error: "Bridge or project workspace is busy", content: "", events: [], externalSessionId: p.resume_session_id || "" });
        return;
      }
      const abort = new AbortController();
      let stopReason: ChatTimeoutReason | undefined;
      const clock = chatWatchdog(reason => {
        if (abort.signal.aborted) return;
        stopReason = reason;
        abort.abort();
      });
      const c = config,
        cat = catalog;
      const job = (async () => {
        let result: RunChatTurnResult = { status: "aborted", content: "", events: [], externalSessionId: "" };
        let release: (() => void) | undefined;
        try {
          checkChat(p);
          if (!validProjectId(p.project_id) || !Object.hasOwn(c.projects ?? {}, p.project_id))
            throw new Error("Project is not locally bound");
          result.externalSessionId = p.resume_session_id || "";
          const boundDir = p.expected_workdir ?? projectWorkdir(c.projects![p.project_id], c, home);
          release = await lock(p.project_id, abort.signal);
          abort.signal.throwIfAborted();
          const project = config.projects?.[p.project_id];
          if (!project) throw new Error("Project binding was removed");
          const cwd = projectWorkdir(project, config, home);
          if (cwd !== boundDir) throw new Error("Project binding changed while waiting");
          if (!cat.runtimes[p.runtime].available) throw new Error("Requested CLI is not available");
          const onEvent = (event: unknown) => {
            clock.progress();
            send(socket, "chat.event", { ...ids, event });
          };
          const opts = {
            workdir: cwd,
            onFileSynced: () => onEvent({ type: "status", message: "已同步项目空间文件" }),
            cacheDir:
              o.cacheDir ?? (c.cache_dir ? expand(c.cache_dir, home) : join(home, ".cache/relaydesk-bridge/spaces")),
            projectId: p.project_id,
            runId: p.run_id,
            serverUrl: c.server_url,
            token: c.agent_token,
            rpc,
            signal: abort.signal,
          };
          onEvent({ type: "status", message: "正在同步本机项目空间…" });
          const mirror = await syncSpace(opts, p.workspace_manifest);
          const before = p.sandbox_mode === "workspace-write" ? snapshotShadowFiles(mirror) : null;
          const promptFor = (resumeId: string) => [
            "./ is the bound local project workdir. $RELAYDESK_SPACE_DIR/HANDBOOK.md is the project handbook; $RELAYDESK_SPACE_DIR/files/ contains cloud workspace files and SQLite databases. Never disclose credentials or database connection strings.",
            p.sandbox_mode === "read-only"
              ? "This is a read-only turn for local code and workspace files. Do not modify either workspace. You still have access to the `relaydesk` MCP server for project tasks (list_tasks, get_task, comment_task, update_task, transition_task, create_task) and strictly read-only database inspection/queries (list_datasources, describe_datasource, query_datasource)."
              : "Only changes under the shadow files/ directory can be synchronized to the cloud. Treat HANDBOOK.md as read-only. To show generated images or screenshots in chat, save them under $RELAYDESK_SPACE_DIR/files/ and embed them in Markdown as ![description](files/...). You also have access to the `relaydesk` MCP server for project tasks (list_tasks, get_task, comment_task, update_task, transition_task, create_task) and read-only database inspection/queries (list_datasources, describe_datasource, query_datasource).",
            mirror.handbook,
            databaseContext(p.workspace_manifest.databases),
            mirror.skipped.length ? `Large files not mirrored: ${mirror.skipped.join(", ")}` : "",
            resumeId ? "" : p.system_context,
            p.prompt,
          ]
            .filter(Boolean)
            .join("\n\n");
          const taskClient = {
            async call(
              action: "list_tasks" | "get_task" | "comment_task" | "update_task" | "transition_task" | "create_task",
              params: Record<string, unknown>,
            ) {
              const res = await bridgeRpc(
                "task.rpc",
                { run_id: p.run_id, project_id: p.project_id, action, params },
                abort.signal,
              );
              return res.data;
            },
          };
          const execute = (resumeId: string) => {
            const current = config.projects?.[p.project_id];
            if (!current || projectWorkdir(current, config, home) !== cwd) throw new Error("Project binding changed");
            return runLocalChat({
              config: c,
              catalog: cat,
              p: { ...p, resume_session_id: resumeId },
              cwd,
              homeDir: home,
              spaceDir: mirror.root,
              allowSecrets: current.allow_datasource_secrets !== false,
              enableMcp: true,
              taskClient,
              signal: abort.signal,
              prompt: promptFor(resumeId),
              onEvent,
            });
          };
          const resumeId = p.resume_session_id || "";
          result = await execute(resumeId);
          if (resumeId && result.status === "error" && !abort.signal.aborted && !result.content && !result.events.length &&
              missingResumeSession(result.error ?? "")) {
            result.externalSessionId = "";
            onEvent({ type: "status", message: "原 CLI 线程不存在，正在携带上下文开启新线程…", external_session_id: "" });
            result = await execute("");
          }
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
          result = { ...result, status: "error", error: message(e) };
        } finally {
          release?.();
        }
        if (abort.signal.aborted) {
          result = stopReason
            ? { ...result, status: "error", stopReason, error: chatTimeoutMessage[stopReason] }
            : { ...result, status: "aborted", error: undefined };
        }
        terminal(result);
      })().finally(() => {
        clock.close();
        active.delete(p.run_id);
      });
      active.set(p.run_id, { abort, socket, project: p.project_id, session: p.session_id, job });
    }
    function startCliRun(p: {
      run_id: string;
      project_id: string;
      mode?: string;
      runtime: "codex" | "claude";
      model?: string;
      reasoning_effort?: ChatStart["reasoning_effort"];
      prompt: string;
      system_context?: string;
      workspace_manifest?: ChatStart["workspace_manifest"];
    }) {
      if (typeof p.run_id !== "string" || !/^[\w.:\-]{1,160}$/.test(p.run_id)) return;
      const runKey = `cli:${p.run_id}`;
      const emit = (event: "heartbeat" | "progress" | "finish" | "fail", body: string, sha = "") =>
        send(socket, "cli_run.event", { run_id: p.run_id, event, body: body.slice(0, event === "progress" ? 4000 : 24000), ...(sha ? { sha } : {}) });
      if (active.has(runKey)) return;
      if (config.accept_cli_runs !== true) {
        emit("fail", "Local bridge has accept_cli_runs disabled");
        return;
      }
      if (active.size >= (config.max_concurrency ?? 2)) {
        emit("fail", "Bridge concurrency limit reached");
        return;
      }
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(new Error("Local CLI run timed out")), 8 * 60_000);
      const heartbeatTimer = setInterval(() => {
        if (!abort.signal.aborted) emit("heartbeat", "");
      }, 20_000);
      const c = config,
        cat = catalog;
      const job = (async () => {
        let release: (() => void) | undefined;
        let sha = "";
        try {
          if (!validProjectId(p.project_id) || !Object.hasOwn(c.projects ?? {}, p.project_id))
            throw new Error("Project is not locally bound");
          if (p.runtime !== "codex" && p.runtime !== "claude") throw new Error("Invalid CLI runtime");
          if (typeof p.prompt !== "string" || !p.prompt.trim()) throw new Error("Empty CLI prompt");
          release = await lock(p.project_id, abort.signal);
          abort.signal.throwIfAborted();
          const project = config.projects?.[p.project_id];
          if (!project) throw new Error("Project binding was removed");
          const cwd = projectWorkdir(project, config, home);
          if (!cat.runtimes[p.runtime].available) throw new Error("Requested CLI is not available");
          const rev = spawnSync("git", ["--no-optional-locks", "rev-parse", "HEAD"], {
            cwd,
            encoding: "utf8",
            timeout: 1500,
          });
          if (rev.status === 0 && /^[0-9a-f]{40}$/i.test(rev.stdout.trim())) sha = rev.stdout.trim();
          emit("progress", `本机节点正在执行（${p.runtime}）…`, sha);
          const manifest = p.workspace_manifest ?? { files: [] };
          const mirror = await syncSpace(
            {
              workdir: cwd,
              cacheDir:
                o.cacheDir ?? (c.cache_dir ? expand(c.cache_dir, home) : join(home, ".cache/relaydesk-bridge/spaces")),
              projectId: p.project_id,
              runId: runKey,
              serverUrl: c.server_url,
              token: c.agent_token,
              rpc,
              signal: abort.signal,
            },
            manifest,
          );
          const fullPrompt = [
            "This is a read-only discussion/audit run on the bound local project repository. Do not modify repository files or disclose any secrets.",
            mirror.handbook,
            p.system_context,
            p.prompt,
          ]
            .filter(Boolean)
            .join("\n\n");
          let lastProgressAt = 0;
          const result = await runLocalChat({
            config: c,
            catalog: cat,
            p: {
              run_id: p.run_id,
              session_id: runKey,
              project_id: p.project_id,
              runtime: p.runtime,
              model: p.model,
              reasoning_effort: p.reasoning_effort ?? "default",
              sandbox_mode: "read-only",
              network_access: false,
              prompt: p.prompt,
              workspace_manifest: manifest,
            },
            cwd,
            homeDir: home,
            spaceDir: mirror.root,
            allowSecrets: false,
            signal: abort.signal,
            prompt: fullPrompt,
            onEvent: (ev) => {
              const now = Date.now();
              if (now - lastProgressAt < 2500) return;
              if (ev.type === "status" && ev.message) {
                lastProgressAt = now;
                emit("progress", ev.message, sha);
              } else if (ev.type === "tool" && ev.event.summary) {
                lastProgressAt = now;
                emit("progress", `${ev.event.tool}: ${ev.event.summary}`, sha);
              }
            },
          });
          if (abort.signal.aborted) {
            emit("fail", abort.signal.reason?.message === "Local CLI run timed out" ? "本机 CLI 执行超时" : "本机 CLI 执行已中止", sha);
          } else if (result.status === "done" && result.content.trim()) {
            emit("finish", result.content.trim(), sha);
          } else {
            emit("fail", result.error || "本机 CLI 未返回有效结果", sha);
          }
        } catch (e) {
          emit("fail", message(e), sha);
        } finally {
          release?.();
        }
      })().finally(() => {
        clearTimeout(timeout);
        clearInterval(heartbeatTimer);
        active.delete(runKey);
      });
      active.set(runKey, { abort, socket, project: p.project_id, session: runKey, job });
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
        log(`connected as "${String(f.payload.agent_name ?? "")}" (${String(f.payload.agent_id ?? "")}) · models=${catalog.models.length} · projects=${Object.keys(config.projects ?? {}).length}`);
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
      if (f.type === "cli_run.start") startCliRun(f.payload as Parameters<typeof startCliRun>[0]);
      if (f.type === "cli_run.abort") {
        const a = active.get(`cli:${String(f.payload.run_id)}`);
        if (a && a.socket === socket) a.abort.abort();
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
        log(`disconnected (code=${code})${superseded ? " - replaced by newer connection" : closed ? "" : ` - reconnecting in ${backoff}ms`}`);
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

const isMain = (() => {
  if (!process.argv[1]) return false;
  const resolved = resolve(process.argv[1]);
  if (import.meta.url === pathToFileURL(resolved).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolved)).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        `Relaydesk Local Bridge v${BRIDGE_VERSION}`,
        "Usage: node relaydesk-bridge.mjs [--config PATH]",
        "Default config: $RELAYDESK_BRIDGE_CONFIG or ~/.config/relaydesk-bridge/config.json",
      ].join("\n"),
    );
  } else if (args.includes("--version") || args.includes("-v")) {
    console.log(BRIDGE_VERSION);
  } else if (args.length && (args[0] !== "--config" || args.length !== 2)) {
    console.error("Usage: node relaydesk-bridge.mjs [--config PATH]");
    process.exitCode = 1;
  } else {
    try {
      const configPath =
        args[1] ?? process.env.RELAYDESK_BRIDGE_CONFIG ?? join(homedir(), ".config/relaydesk-bridge/config.json");
      const daemon = await startBridgeDaemon({ configPath, verbose: true });
      for (const sig of ["SIGTERM", "SIGINT"] as const)
        process.once(sig, () => {
          void daemon.close();
        });
    } catch (err) {
      console.error(
        `Unable to start bridge: ${err instanceof Error ? err.message : "check local configuration and file permissions."}`,
      );
      process.exitCode = 1;
    }
  }
}
