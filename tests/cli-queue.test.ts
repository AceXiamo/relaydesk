import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { CLI_LEASE_MS, Store } from "../server/store.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (cleanup.length) cleanup.pop()!();
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "cli-queue-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "queue.sqlite");
}

function open(path = ":memory:") {
  const store = new Store(path);
  cleanup.push(() => store.close());
  return store;
}

function fixture(store = open()) {
  const project = store.createProject({ name: "CLI", repos: ["org/one", "org/two"] });
  const task = store.createTask(project.id, { body: "Bug report" }, "widget");
  return { store, project, task };
}

it("persists queued work, leases and results across connection changes", () => {
  const path = tempDb();
  const a = new Store(path);
  const { project, task } = fixture(a);
  const run = a.enqueueCliRun(project.id, task.id, "pr_audit", " Review this change ");
  expect(run).toMatchObject({ status: "queued", mode: "pr_audit", question: "Review this change", started_at: null, finished_at: null });
  a.close();
  const b = open(path);
  const c = open(path);
  const claim = b.claimCliRun(project.id)!;
  expect(c.claimCliRun(project.id)).toBeNull();
  expect(claim.run).toMatchObject({ id: run.id, task_id: task.id, status: "running" });
  expect(claim.context.project.repos).toEqual(["org/one", "org/two"]);
  for (const key of ["agent_key", "bot_key", "intake_key"]) expect(claim.context.project).not.toHaveProperty(key);
  expect(claim.context.task).not.toHaveProperty("lease");
  expect(claim.context.messages.at(-1)).toMatchObject({ author: "human", body: run.question });
  expect(claim.run).not.toHaveProperty("lease");
  const send = (event: string, body?: string, sha?: string) => c.eventCliRun(project.id, run.id, { event, lease: claim.lease, body, sha });
  expect(send("progress", "Reading diff", "a1b2c3d").progress).toBe("Reading diff");
  expect(send("heartbeat")).toMatchObject({ progress: "Reading diff", sha: "a1b2c3d" });
  expect(send("finish", "No blockers")).toMatchObject({ status: "succeeded", sha: "a1b2c3d", finished_at: expect.any(String) });
  expect(() => send("finish", "Duplicate result")).toThrow(/lease/i);
  const [saved] = b.listCliRuns(project.id, task.id);
  expect(saved.progress).toBe("No blockers");
  expect(saved).not.toHaveProperty("lease");
  expect(b.getTaskMessages(task.id).filter(m => m.kind === "comment").map(m => m.body)).toEqual([run.question, "No blockers"]);
});

it("fences tenants and active leases; permits only one active run per task", () => {
  const { store, project, task } = fixture();
  const other = fixture(store);
  const pid = project.id, tid = task.id;
  const run = store.enqueueCliRun(pid, tid, "operator", "first");
  const second = store.createTask(pid, { body: "Another issue" }, "console");
  const secondRun = store.enqueueCliRun(pid, second.id, "operator", "second");
  expect(() => store.enqueueCliRun(pid, tid, "pr_audit", "duplicate")).toThrow(/active/i);
  expect(() => store.enqueueCliRun(other.project.id, tid, "operator", "leak")).toThrow(/not found/i);
  expect(() => store.listCliRuns(other.project.id, tid)).toThrow(/not found/i);
  expect(store.claimCliRun(other.project.id)).toBeNull();
  const claim = store.claimCliRun(pid)!;
  expect(claim.run.id).toBe(run.id);
  const next = store.claimCliRun(pid)!;
  expect(next.run.id).toBe(secondRun.id);
  expect(() => store.enqueueCliRun(pid, tid, "operator", "again")).toThrow(/active/i);
  const event = { event: "fail", body: "Could not read repository", lease: claim.lease };
  expect(() => store.eventCliRun(other.project.id, run.id, event)).toThrow(/not found/i);
  expect(() => store.eventCliRun(pid, run.id, { ...event, lease: next.lease })).toThrow(/lease/i);
  expect(store.eventCliRun(pid, run.id, event).status).toBe("failed");
  expect(() => store.eventCliRun(pid, run.id, event)).toThrow(/lease/i);
  const messages = store.getTaskMessages(tid).filter(m => m.kind === "comment");
  expect(messages).toHaveLength(2);
  expect(messages[1].body).toContain(event.body);
  expect(store.getTaskMessages(second.id).some(m => m.author === "assistant")).toBe(false);
  expect(store.enqueueCliRun(pid, tid, "pr_audit", "explicit retry").status).toBe("queued");
  expect(store.listCliRuns(pid, tid).map(r => r.status)).toEqual(["queued", "failed"]);
});

it.each(["claim", "list", "late event"])("expires without replay or duplicate thread entries on %s", (operation) => {
  vi.useFakeTimers();
  const { store, project, task } = fixture();
  const { id } = store.enqueueCliRun(project.id, task.id, "operator", "Inspect locally");
  const { lease } = store.claimCliRun(project.id)!;
  const heartbeat = () => store.eventCliRun(project.id, id, { event: "heartbeat", lease });
  vi.advanceTimersByTime(CLI_LEASE_MS - 1);
  heartbeat();
  vi.advanceTimersByTime(CLI_LEASE_MS - 1);
  expect(store.listCliRuns(project.id, task.id)[0].status).toBe("running");
  vi.advanceTimersByTime(1);
  if (operation === "claim") expect(store.claimCliRun(project.id)).toBeNull();
  if (operation === "list") expect(store.listCliRuns(project.id, task.id)[0].status).toBe("failed");
  if (operation === "late event") expect(heartbeat).toThrow(/lease/i);
  // Inspect the thread before another queue operation can trigger cleanup.
  const replies = () => store.getTaskMessages(task.id).filter(m => m.author === "assistant");
  expect(replies()).toHaveLength(1);
  expect(replies()[0].body).toContain("租约已过期");
  expect(heartbeat).toThrow(/lease/i);
  expect(store.claimCliRun(project.id)).toBeNull();
  expect(store.listCliRuns(project.id, task.id)[0].status).toBe("failed");
  expect(replies()).toHaveLength(1);
});

it("honors project pause without losing an in-flight result", () => {
  const store = open();
  const { id } = store.createProject({ name: "Default", repo: "org/demo" });
  const task = store.createTask(id, { body: "Question" }, "console");
  const enqueue = () => store.enqueueCliRun(id, task.id, "operator", "Why?");
  store.updateProject(id, { automation_paused: true });
  expect(enqueue).toThrow(/paused/);
  store.updateProject(id, { automation_paused: false });
  const run = enqueue();
  store.updateProject(id, { automation_paused: true });
  expect(store.claimCliRun(id)).toBeNull();
  expect(store.listCliRuns(id, task.id)[0].status).toBe("queued");
  store.updateProject(id, { automation_paused: false });
  const { lease } = store.claimCliRun(id)!;
  store.updateProject(id, { automation_paused: true });
  expect(store.eventCliRun(id, run.id, { event: "finish", body: "done", lease }).status).toBe("succeeded");
});

it("opens a legacy database and preserves its tasks", () => {
  const path = tempDb();
  const original = new Store(path);
  const { project, task } = fixture(original);
  original.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE cli_runs; ALTER TABLE projects ADD COLUMN cli_enabled INTEGER NOT NULL DEFAULT 0");
  legacy.close();
  const migrated = open(path);
  expect(migrated.getTaskRow(task.id).project_id).toBe(project.id);
  expect(migrated.listCliRuns(project.id, task.id)).toEqual([]);
});

it("rejects malformed input and rolls back either half of a failed thread write", () => {
  const { store, project, task } = fixture();
  const enqueue = (question: string) => store.enqueueCliRun(project.id, task.id, "operator", question);
  expect(() => enqueue(" \n")).toThrow(/question/);
  expect(() => enqueue("x".repeat(8001))).toThrow(/question/);
  const failWrite = () => vi.spyOn(store, "addMessage").mockImplementationOnce(() => { throw new Error("write failed"); });
  failWrite();
  expect(() => enqueue("lost?")).toThrow("write failed");
  expect(store.listCliRuns(project.id, task.id)).toEqual([]);
  const { id } = enqueue("retry");
  const { lease } = store.claimCliRun(project.id)!;
  const send = (event: string, body: string, sha?: string) => store.eventCliRun(project.id, id, { lease, event, body, sha });
  expect(() => send("unknown", "bad")).toThrow(/event/);
  expect(() => send("progress", "x".repeat(4001))).toThrow(/body/);
  expect(() => send("finish", "x".repeat(24001))).toThrow(/body/);
  expect(() => send("finish", "result", "not a sha")).toThrow(/SHA/);
  failWrite();
  expect(() => send("finish", "result")).toThrow("write failed");
  expect(store.listCliRuns(project.id, task.id)[0].status).toBe("running");
  expect(send("finish", "result").status).toBe("succeeded");
  expect(store.getTaskMessages(task.id).filter(m => m.kind === "comment").map(m => m.body)).toEqual(["retry", "result"]);
});
