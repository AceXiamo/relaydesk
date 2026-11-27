import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRunManager } from "../server/chat-run-manager.ts";
import { startRelaydeskMcpServer } from "../server/relaydesk-mcp.ts";
import { Store } from "../server/store.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function mcpRpc(url: string, token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
}

describe("cross-harness app-owned subagents", () => {
  it("tracks parent-child session lineage in Store and hides subagents from root session list by default", () => {
    const dir = makeTempDir("rd-subagent-store-");
    const store = new Store(join(dir, "relaydesk.sqlite3"));
    const project = store.createProject({ name: "Demo", repo: "org/demo" });

    const parent = store.createChatSession(project.id, {
      title: "主会话",
      runtime: "claude",
      sandbox_mode: "workspace-write",
    });
    expect(parent.parent_session_id).toBeNull();
    expect(parent.delegation_depth).toBe(0);
    expect(parent.session_role).toBe("root");

    const child = store.createChatSession(project.id, {
      parent_session_id: parent.id,
      delegation_depth: 1,
      session_role: "subagent",
      title: "Agy 代码审查",
      runtime: "agy",
      model: "gemini-3-pro",
      sandbox_mode: "read-only",
    });
    expect(child.parent_session_id).toBe(parent.id);
    expect(child.delegation_depth).toBe(1);
    expect(child.session_role).toBe("subagent");
    expect(child.runtime).toBe("agy");

    // Main sidebar list excludes subagent sessions by default
    const rootSessions = store.listChatSessions(project.id, "chat");
    expect(rootSessions.map((s) => s.id)).toEqual([parent.id]);

    // Explicitly including subagents returns both
    const allSessions = store.listChatSessions(project.id, "chat", { includeSubagents: true });
    expect(allSessions.map((s) => s.id).sort()).toEqual([child.id, parent.id].sort());

    // Dedicated child lookup returns children ordered by creation time
    const children = store.listChildChatSessions(project.id, parent.id);
    expect(children.map((s) => s.id)).toEqual([child.id]);
  });

  it("exposes delegation MCP tools for root sessions and omits them for subagent workers", async () => {
    const spaceDir = makeTempDir("rd-mcp-delegate-");
    const delegateCall = vi.fn().mockResolvedValue({
      session_id: "child-123",
      runtime: "agy",
      status: "running",
      mode: "async",
    });

    const rootMcp = await startRelaydeskMcpServer({
      projectId: "proj-1",
      spaceDir,
      databases: [],
      allowDatasourceSecrets: false,
      delegateClient: { call: delegateCall },
    });

    const workerMcp = await startRelaydeskMcpServer({
      projectId: "proj-1",
      spaceDir,
      databases: [],
      allowDatasourceSecrets: false,
    });

    try {
      const rootList = await mcpRpc(rootMcp.url, rootMcp.token, "tools/list");
      const rootToolNames = ((rootList.result?.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
      expect(rootToolNames).toContain("delegate_task");
      expect(rootToolNames).toContain("check_delegated_task");
      expect(rootToolNames).toContain("wait_delegated_task");
      expect(rootToolNames).toContain("cancel_delegated_task");

      const workerList = await mcpRpc(workerMcp.url, workerMcp.token, "tools/list");
      const workerToolNames = ((workerList.result?.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
      expect(workerToolNames).not.toContain("delegate_task");
      expect(workerToolNames).not.toContain("check_delegated_task");

      const callRes = await mcpRpc(rootMcp.url, rootMcp.token, "tools/call", {
        name: "delegate_task",
        arguments: {
          runtime: "agy",
          prompt: "Check cache invalidation paths",
          mode: "async",
        },
      });
      expect(callRes.error).toBeUndefined();
      expect(delegateCall).toHaveBeenCalledWith("delegate_task", {
        runtime: "agy",
        prompt: "Check cache invalidation paths",
        mode: "async",
      });
    } finally {
      await rootMcp.close();
      await workerMcp.close();
    }
  });

  it("inherits parent sandbox_mode and network_access by default and narrows only when read-only is requested", async () => {
    const dir = makeTempDir("rd-delegate-perms-");
    const store = new Store(join(dir, "relaydesk.sqlite3"));
    const project = store.createProject({ name: "Demo", repo: "org/demo" });
    const manager = new ChatRunManager(store, null);

    const startTurnSpy = vi.spyOn(manager, "startTurn").mockImplementation(({ sessionId }) => {
      const now = new Date().toISOString();
      return {
        runId: `run-${sessionId}`,
        userMessage: {
          id: "msg-1",
          session_id: sessionId,
          role: "user",
          content: "mock",
          events: [],
          attachments: [],
          status: "done",
          created_at: now,
        },
        assistantMessage: {
          id: "msg-2",
          session_id: sessionId,
          role: "assistant",
          content: "",
          events: [],
          attachments: [],
          status: "streaming",
          created_at: now,
        },
        session: store.getChatSession(project.id, sessionId),
        alreadyRunning: false,
        completion: Promise.resolve(),
        subscribe: () => () => {},
        unsubscribe: () => {},
      };
    });

    const runsMap = (manager as unknown as { runs: Map<string, Record<string, unknown>> }).runs;
    const registerParentRun = (sessionId: string, runId: string) => {
      runsMap.set(sessionId, {
        id: runId,
        projectId: project.id,
        sessionId,
        session: store.getChatSession(project.id, sessionId),
        projectInfo: {
          id: project.id,
          name: project.name,
          repo: project.repo,
          delivery_mode: "direct_push",
          target_branch: "main",
          branch_prefix: "relaydesk",
        },
        text: "",
        events: new Map(),
        statusMessage: "",
        subscribers: new Set(),
        done: false,
        cancel: () => {},
      });
    };

    const writableParent = store.createChatSession(project.id, {
      title: "Writable Parent",
      runtime: "agy",
      sandbox_mode: "workspace-write",
      network_access: true,
    });
    registerParentRun(writableParent.id, "parent-run-w");

    const inherited = (await manager.handleDelegateRpc({
      projectId: project.id,
      sessionId: writableParent.id,
      runId: "parent-run-w",
      action: "delegate_task",
      params: { runtime: "codex", prompt: "Edit a file", mode: "async" },
    })) as { session_id: string };
    const inheritedChild = store.getChatSession(project.id, inherited.session_id);
    expect(inheritedChild.sandbox_mode).toBe("workspace-write");
    expect(inheritedChild.network_access).toBe(true);

    const narrowed = (await manager.handleDelegateRpc({
      projectId: project.id,
      sessionId: writableParent.id,
      runId: "parent-run-w",
      action: "delegate_task",
      params: { runtime: "codex", prompt: "Read only check", sandbox_mode: "read-only", mode: "async" },
    })) as { session_id: string };
    const narrowedChild = store.getChatSession(project.id, narrowed.session_id);
    expect(narrowedChild.sandbox_mode).toBe("read-only");
    expect(narrowedChild.network_access).toBe(true);

    const readOnlyParent = store.createChatSession(project.id, {
      title: "ReadOnly Parent",
      runtime: "agy",
      sandbox_mode: "read-only",
      network_access: false,
    });
    registerParentRun(readOnlyParent.id, "parent-run-ro");

    const capped = (await manager.handleDelegateRpc({
      projectId: project.id,
      sessionId: readOnlyParent.id,
      runId: "parent-run-ro",
      action: "delegate_task",
      params: { runtime: "codex", prompt: "Try write", sandbox_mode: "workspace-write", mode: "async" },
    })) as { session_id: string };
    const cappedChild = store.getChatSession(project.id, capped.session_id);
    expect(cappedChild.sandbox_mode).toBe("read-only");
    expect(cappedChild.network_access).toBe(false);

    expect(startTurnSpy).toHaveBeenCalledTimes(3);
  });
});
