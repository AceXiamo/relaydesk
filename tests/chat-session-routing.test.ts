import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../server/store.ts";

describe("chat session routing storage", () => {
  let directory: string;
  let path: string;
  let store: Store | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "relaydesk-chat-routing-"));
    path = join(directory, "relaydesk.sqlite3");
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  it("migrates old tables, attributing only existing CLI threads to cloud", () => {
    const old = new DatabaseSync(path);
    try {
      old.exec(`
        CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, repo TEXT, intake_key TEXT,
          bot_key TEXT, agent_key TEXT, allowed_origins TEXT, created_at TEXT);
        INSERT INTO projects VALUES ('p', 'Legacy', 'example/old', '', '', '', '[]', '2026-01-01');
        CREATE TABLE chat_sessions(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
          title TEXT, runtime TEXT, model TEXT, sandbox_mode TEXT, external_session_id TEXT,
          status TEXT, created_at TEXT, updated_at TEXT);
        INSERT INTO chat_sessions VALUES
          ('resumed', 'p', 'Legacy', 'codex', 'custom/old', 'read-only', 'old-thread', 'idle', 't', 't'),
          ('empty', 'p', 'Empty', 'claude', '', 'read-only', '', 'idle', 't', 't');
      `);
    } finally {
      old.close();
    }

    store = new Store(path);
    expect(store.getProjectRow("p").execution_routing_json).toBe("{}");
    expect(store.getProjectExecutionRouting("p")).toEqual({
      priority: [],
      auto_fallback: true,
      route_cli_runs: true,
      auto_dispatch_tasks: false,
      task_network_access: true,
    });
    expect(store.getChatSession("p", "resumed")).toMatchObject({
      model: "custom/old", execution_target: "auto", resolved_target: "cloud",
      reasoning_effort: "default", fast_mode: "default", external_session_id: "old-thread", updated_at: "t",
    });
    expect(store.getChatSession("p", "empty")).toMatchObject({
      execution_target: "auto", resolved_target: "", reasoning_effort: "default", external_session_id: "",
    });
    const routing = store.updateProjectExecutionRouting("p", { priority: ["local:desktop", "cloud"], auto_fallback: false });
    expect(store.updateProjectExecutionRouting("p", { route_cli_runs: false })).toEqual({ ...routing, route_cli_runs: false });
    const changed = store.updateChatSession("p", "resumed", { reasoning_effort: "low", execution_target: "cloud" });
    store.close();
    store = new Store(path);
    expect(store.getChatSession("p", "resumed")).toEqual(changed);
    expect(store.getChatSession("p", "empty").resolved_target).toBe("");
    expect(store.getProjectExecutionRouting("p")).toEqual({
      priority: ["local:desktop", "cloud"],
      auto_fallback: false,
      route_cli_runs: false,
      auto_dispatch_tasks: false,
      task_network_access: true,
    });
  });

  it("round-trips routing preferences and the actual target in session lists and details", () => {
    store = new Store(path);
    const project = store.createProject({ name: "Chat", repo: "example/chat" });
    const defaults = store.createChatSession(project.id);
    expect(defaults).toMatchObject({ execution_target: "auto", resolved_target: "", reasoning_effort: "default" });
    const session = store.createChatSession(project.id, { reasoning_effort: "off", execution_target: "cloud" });
    expect(session).toMatchObject({ reasoning_effort: "off", execution_target: "cloud", resolved_target: "" });
    const updated = store.updateChatSession(project.id, session.id, {
      execution_target: "auto", resolved_target: "cloud", reasoning_effort: "max", external_session_id: "thread-1",
    });
    expect(updated).toMatchObject({ execution_target: "auto", resolved_target: "cloud", reasoning_effort: "max", external_session_id: "thread-1" });
    store.addChatMessage(session.id, { role: "user", content: "First turn" });
    const detail = store.getChatSession(project.id, session.id);
    expect(store.listChatSessions(project.id)).toContainEqual({ ...detail, message_count: 1, last_message_preview: "First turn" });
    store.deleteChatSession(project.id, session.id);
    expect(store.listChatSessions(project.id).map((row) => row.id)).toEqual([defaults.id]);
  });

  it("persists Fast without breaking resume and resets it when leaving Codex", () => {
    store = new Store(path);
    const { id } = store.createProject({ name: "Fast", repo: "example/chat" });
    const session = store.createChatSession(id, { fast_mode: "on" });
    expect(session.fast_mode).toBe("on");
    store.updateChatSession(id, session.id, { external_session_id: "thread-1", fast_mode: "off" });
    store.close();
    store = new Store(path);
    expect(store.listChatSessions(id)[0]).toMatchObject({ fast_mode: "off", external_session_id: "thread-1" });
    expect(store.updateChatSession(id, session.id, { runtime: "claude" }).fast_mode).toBe("default");
  });

  it("resumes across model and effort changes and clears the thread when switching runtimes", () => {
    store = new Store(path);
    const { id } = store.createProject({ name: "Continuity", repo: "example/chat" });
    const session = store.createChatSession(id);
    const update = (patch: Parameters<Store["updateChatSession"]>[2]) => store!.updateChatSession(id, session.id, patch);
    update({ external_session_id: "codex-thread", resolved_target: "cloud" });
    expect(update({ model: "custom/new" }).external_session_id).toBe("codex-thread");
    expect(update({ reasoning_effort: "high" }).external_session_id).toBe("codex-thread");
    expect(update({ execution_target: "cloud", runtime: "codex" }).external_session_id).toBe("codex-thread");
    expect(update({ runtime: "claude" }).external_session_id).toBe("");
    update({ external_session_id: "claude-thread" });
    expect(update({ model: "custom/claude", reasoning_effort: "off" }).external_session_id).toBe("claude-thread");
  });
});
