import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
