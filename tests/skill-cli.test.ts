import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentProjectInfo,
  AgentQueueItem,
  TaskMessage,
  TaskRecord,
} from "../app/lib/types.ts";

const CLI_PATH = resolve(process.cwd(), "skills/relaydesk/scripts/relaydesk.mjs");
const AGENT_KEY = "rd_agent_secret_key_for_tests_12345";
const PROJECT_ID = "proj_acme";

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Relaydesk Test",
  GIT_AUTHOR_EMAIL: "test@relaydesk.dev",
  GIT_COMMITTER_NAME: "Relaydesk Test",
  GIT_COMMITTER_EMAIL: "test@relaydesk.dev",
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function makeTempDir(prefix = "relaydesk-cli-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGitRepo(dir: string, remoteUrl: string, initialFile = "README.md"): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["remote", "add", "origin", remoteUrl]);
  writeFileSync(join(dir, initialFile), "# Repo\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "chore: initial commit"]);
  return git(dir, ["rev-parse", "--short", "HEAD"]);
}

function makeTask(overrides: Partial<TaskRecord> & { id: string; number: number; title: string }): TaskRecord {
  const now = "2026-11-21T02:00:00.000Z";
  return {
    project_id: PROJECT_ID,
    body: "Feedback details",
    requirements: "",
    source: "widget",
    source_url: "",
    priority: "normal",
    status: "triage",
    owner: "none",
    version: 1,
    attempts: 0,
    resolution: null,
    delivery_ref: "",
    triaged_by: "",
    merged_into: null,
    deploy_status: "not_required",
    deployed_at: null,
    release_id: null,
    created_at: now,
    updated_at: now,
    last_seen: null,
    message_count: 0,
    ...overrides,
  };
}

interface MockRequestLog {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface MockServerState {
  project: AgentProjectInfo;
  tasks: TaskRecord[];
  messages: Record<string, TaskMessage[]>;
  activeLease: { taskId: string; lease: string } | null;
  requests: MockRequestLog[];
}

async function startMockRelaydeskServer(initial?: Partial<MockServerState>) {
  const state: MockServerState = {
    project: initial?.project ?? {
      id: PROJECT_ID,
      name: "Acme Suite",
      repo: "AcmeOrg/web",
      repos: ["AcmeOrg/web", "AcmeOrg/api", "AcmeOrg/mobile"],
      automation_paused: false,
      delivery_mode: "direct_push",
      deploy_policy: {
        mode: "none",
        window_start: "02:00",
        window_end: "06:00",
        timezone: "Asia/Shanghai",
        allow_urgent_override: true,
        doc_path: "",
      },
      widget_code_context: true,
      agent_instructions: "Always run pnpm test before pushing.",
    },
    tasks: initial?.tasks ?? [],
    messages: initial?.messages ?? {},
    activeLease: initial?.activeLease ?? null,
    requests: [],
  };

  function toQueueItem(t: TaskRecord): AgentQueueItem {
    return {
      id: t.id,
      number: t.number,
      title: t.title,
      priority: t.priority,
      status: t.status,
      owner: t.owner,
      attempts: t.attempts,
      updated_at: t.updated_at,
    };
  }

  function sendJson(res: ServerResponse, status: number, payload: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }

  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const urlPath = new URL(req.url || "/", "http://127.0.0.1").pathname;

    if (req.headers.authorization !== `Bearer ${AGENT_KEY}`) {
      sendJson(res, 401, { error: "Invalid agent key" });
      return;
    }

    const prefix = `/api/projects/${PROJECT_ID}/agent`;
    if (!urlPath.startsWith(prefix)) {
      sendJson(res, 404, { error: "Project not found" });
      return;
    }

    const subPath = urlPath.slice(prefix.length);
    const body = method === "POST" ? await readBody(req) : null;
    state.requests.push({ method, path: subPath, body });

    if (method === "GET" && subPath === "/project") {
      sendJson(res, 200, { project: state.project });
      return;
    }

    if (method === "GET" && subPath === "/queue") {
      const activeTask = state.tasks.find((t) => t.status === "working" && t.owner === "agent") ?? null;
      const pendingTasks = state.tasks.filter(
        (t) => (t.status === "triage" || t.status === "ready") && t.owner === "none",
      );
      sendJson(res, 200, {
        paused: state.project.automation_paused,
        active: activeTask ? toQueueItem(activeTask) : null,
        pending: pendingTasks.map(toQueueItem),
        project: state.project,
      });
      return;
    }

    if (method === "POST" && subPath === "/claim") {
      if (state.project.automation_paused) {
        sendJson(res, 200, { task: null, paused: true, reason: "paused", project: state.project });
        return;
      }
      const activeTask = state.tasks.find((t) => t.status === "working" && t.owner === "agent");
      if (activeTask) {
        sendJson(res, 200, {
          task: null,
          busy: true,
          active_task: activeTask,
          project: state.project,
        });
        return;
      }
      const requestedId = typeof body?.task_id === "string" ? body.task_id : null;
      const pending = state.tasks.filter(
        (t) => (t.status === "triage" || t.status === "ready") && t.owner === "none",
      );
      const picked = requestedId ? pending.find((t) => t.id === requestedId) : pending[0];
      if (!picked) {
        sendJson(res, 200, { task: null, project: state.project });
        return;
      }

      picked.owner = "agent";
      picked.status = "working";
      picked.attempts += 1;
      picked.version += 1;
      const lease = `lease_${picked.id}_v${picked.version}`;
      state.activeLease = { taskId: picked.id, lease };
      sendJson(res, 200, { task: picked, lease, project: state.project });
      return;
    }

    const taskMatch = /^\/([^/]+)\/(thread|heartbeat|comment|triage|complete|dismiss|merge|fail)$/.exec(
      subPath,
    );
    if (!taskMatch) {
      sendJson(res, 404, { error: `Unknown agent route ${subPath}` });
      return;
    }

    const [, taskId, action] = taskMatch;
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }

    if (method === "GET" && action === "thread") {
      sendJson(res, 200, {
        task_id: task.id,
        number: task.number,
        messages: state.messages[task.id] ?? [],
      });
      return;
    }

    if (!state.activeLease || state.activeLease.taskId !== taskId || body?.lease !== state.activeLease.lease) {
      sendJson(res, 409, { error: "Invalid or expired lease" });
      return;
    }

    if (action === "heartbeat") {
      task.last_seen = new Date().toISOString();
      sendJson(res, 200, { task });
      return;
    }

    if (action === "comment") {
      const msg: TaskMessage = {
        id: (state.messages[task.id]?.length ?? 0) + 1,
        task_id: task.id,
        kind: "comment",
        author: "agent",
        body: String(body?.body ?? ""),
        created_at: new Date().toISOString(),
      };
      state.messages[task.id] = [...(state.messages[task.id] ?? []), msg];
      task.version += 1;
      sendJson(res, 200, { message: msg, task });
      return;
    }

    if (action === "triage") {
      if (typeof body?.title === "string") task.title = body.title;
      if (typeof body?.priority === "string") task.priority = body.priority as TaskRecord["priority"];
      if (typeof body?.requirements === "string") task.requirements = body.requirements;
      task.triaged_by = "agent";
      task.version += 1;
      sendJson(res, 200, { task });
      return;
    }

    if (action === "complete") {
      task.delivery_ref = typeof body?.delivery_ref === "string" ? body.delivery_ref : "";
      if (typeof body?.requirements === "string") task.requirements = body.requirements;
      task.status = body?.force_done || state.project.delivery_mode !== "review_only" ? "done" : "review";
      task.resolution = "shipped";
      task.owner = "none";
      task.version += 1;
      state.activeLease = null;
      sendJson(res, 200, { task });
      return;
    }

    if (action === "dismiss") {
      task.status = "done";
      task.resolution = "dismissed";
      task.owner = "none";
      task.version += 1;
      state.activeLease = null;
      sendJson(res, 200, { task });
      return;
    }

    if (action === "merge") {
      task.status = "done";
      task.resolution = "merged";
      task.merged_into = String(body?.target_id ?? "");
      task.owner = "none";
      task.version += 1;
      state.activeLease = null;
      sendJson(res, 200, { task });
      return;
    }

    if (action === "fail") {
      task.status = body?.retryable ? "ready" : "waiting";
      task.owner = "none";
      task.version += 1;
      state.activeLease = null;
      sendJson(res, 200, { task });
      return;
    }

    sendJson(res, 400, { error: "Unhandled action" });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  cleanups.push(
    () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  );

  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    state,
  };
}

function runCli(
  args: string[],
  opts: { cwd: string; configDir: string; input?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: opts.cwd,
      env: {
        ...GIT_ENV,
        RELAYDESK_CONFIG_DIR: opts.configDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      resolveRun({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : 1,
      });
    });
    if (opts.input !== undefined) {
      child.stdin.end(opts.input, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

describe("Relaydesk Skill CLI", () => {
  it("init scans multi-repo subdirectories, isolates credentials (0600), and writes secret-free .relaydesk.json", async () => {
    const mock = await startMockRelaydeskServer();
    const workspace = makeTempDir("rd-ws-");
    const configDir = makeTempDir("rd-cfg-");

    initGitRepo(join(workspace, "web"), "https://github.com/acmeorg/web.git");
    initGitRepo(join(workspace, "api"), "git@github.com:AcmeOrg/api.git");

    const res = await runCli(
      ["init", "--url", mock.url, "--project", PROJECT_ID, "--key", AGENT_KEY],
      { cwd: workspace, configDir },
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("INIT OK: Acme Suite (proj_acme)");
    expect(res.stdout).toContain("DELIVERY: direct_push");
    expect(res.stdout).toContain("- AcmeOrg/web -> ./web");
    expect(res.stdout).toContain("- AcmeOrg/api -> ./api");
    expect(res.stdout).toContain("- AcmeOrg/mobile -> git clone https://github.com/AcmeOrg/mobile.git");
    expect(res.stdout).toContain("scheduled automation");

    // Verify 0600 credentials file
    const credFile = join(configDir, "projects", `${PROJECT_ID}.json`);
    expect(existsSync(credFile)).toBe(true);
    const mode = statSync(credFile).mode & 0o777;
    expect(mode).toBe(0o600);
    const creds = JSON.parse(readFileSync(credFile, "utf8"));
    expect(creds.agent_key).toBe(AGENT_KEY);
    expect(creds.project_id).toBe(PROJECT_ID);

    // Verify secret-free workspace binding
    const bindingFile = join(workspace, ".relaydesk.json");
    const rawBinding = readFileSync(bindingFile, "utf8");
    expect(rawBinding).not.toContain(AGENT_KEY);
    expect(rawBinding).not.toContain("agent_key");
    const binding = JSON.parse(rawBinding);
    expect(binding).toEqual({
      url: mock.url,
      project_id: PROJECT_ID,
      project_name: "Acme Suite",
      delivery_mode: "direct_push",
      repos: [
        { repo: "AcmeOrg/web", path: "./web" },
        { repo: "AcmeOrg/api", path: "./api" },
      ],
    });

    // Verify walking up parent directories from inside a nested subdirectory
    const subCheck = await runCli(["check"], { cwd: join(workspace, "web"), configDir });
    expect(subCheck.exitCode).toBe(0);
    expect(subCheck.stdout.trim()).toBe("NOOP");
  });

  it("check prints ultra-compact NOOP, PAUSED, BUSY, pending lines, and raw --json", async () => {
    const mock = await startMockRelaydeskServer();
    const workspace = makeTempDir("rd-ws-");
    const configDir = makeTempDir("rd-cfg-");

    await runCli(["init", "--url", mock.url, "--project", PROJECT_ID, "--key", AGENT_KEY], {
      cwd: workspace,
      configDir,
    });

    // Empty queue -> NOOP
    expect((await runCli(["check"], { cwd: workspace, configDir })).stdout.trim()).toBe("NOOP");

    // Pending items
    mock.state.tasks = [
      makeTask({ id: "t1", number: 1, title: "Fix login redirect", priority: "high", status: "triage" }),
      makeTask({ id: "t2", number: 12, title: "Add dark mode toggle", priority: "normal", status: "ready" }),
    ];
    const pendingRes = await runCli(["check"], { cwd: workspace, configDir });
    expect(pendingRes.stdout.trim()).toBe(
      "RD-001 [high] (triage) Fix login redirect\nRD-012 [normal] (ready) Add dark mode toggle",
    );

    // Raw JSON mode
    const jsonRes = await runCli(["check", "--json"], { cwd: workspace, configDir });
    const parsed = JSON.parse(jsonRes.stdout);
    expect(parsed.pending).toHaveLength(2);
    expect(parsed.paused).toBe(false);

    // Active task -> BUSY
    mock.state.tasks[0].status = "working";
    mock.state.tasks[0].owner = "agent";
    expect((await runCli(["check"], { cwd: workspace, configDir })).stdout.trim()).toBe("BUSY RD-001 working");

    // Paused -> PAUSED
    mock.state.project.automation_paused = true;
    expect((await runCli(["check"], { cwd: workspace, configDir })).stdout.trim()).toBe("PAUSED");
  });

  it("claim handles NOOP/PAUSED/BUSY, claims specific RD-xxx, formats compact brief, and persists lease", async () => {
    const mock = await startMockRelaydeskServer();
    const workspace = makeTempDir("rd-ws-");
    const configDir = makeTempDir("rd-cfg-");

    initGitRepo(join(workspace, "web"), "https://github.com/AcmeOrg/web.git");

    await runCli(["init", "--url", mock.url, "--project", PROJECT_ID, "--key", AGENT_KEY], {
      cwd: workspace,
      configDir,
    });

    // Empty -> NOOP
    expect((await runCli(["claim"], { cwd: workspace, configDir })).stdout.trim()).toBe("NOOP");

    // Paused -> PAUSED
    mock.state.project.automation_paused = true;
    expect((await runCli(["claim"], { cwd: workspace, configDir })).stdout.trim()).toBe("PAUSED");
    mock.state.project.automation_paused = false;

    // Populate tasks and claim RD-003 specifically
    mock.state.tasks = [
      makeTask({ id: "t1", number: 1, title: "First task", priority: "normal", status: "triage" }),
      makeTask({
        id: "t3",
        number: 3,
        title: "Checkout button broken on Safari",
        priority: "high",
        status: "triage",
        body: "Clicking Pay does nothing on Safari 18.",
        requirements: "Ensure form submit triggers on Safari.",
        source_url: "https://acme.example/checkout",
        message_count: 2,
        linked_feedback: [
          makeTask({
            id: "t2",
            number: 2,
            title: "Cannot pay on iPhone",
            body: "Same button unresponsive on iOS Safari",
          }),
        ],
      }),
    ];

    const claimRes = await runCli(["claim", "RD-003"], { cwd: workspace, configDir });
    expect(claimRes.exitCode).toBe(0);
    expect(claimRes.stdout).toContain("TASK: RD-003 | priority=high | status=working | attempt=1/3");
    expect(claimRes.stdout).toContain("DELIVERY: direct_push");
    expect(claimRes.stdout).toContain("TITLE: Checkout button broken on Safari");
    expect(claimRes.stdout).toContain("- AcmeOrg/web -> ./web");
    expect(claimRes.stdout).toContain("- AcmeOrg/api -> [MISSING]");
    expect(claimRes.stdout).toContain("PROJECT_RULES:\nAlways run pnpm test before pushing.");
    expect(claimRes.stdout).toContain("REQUIREMENTS:\nEnsure form submit triggers on Safari.");
    expect(claimRes.stdout).toContain("FEEDBACK:\nClicking Pay does nothing on Safari 18.");
    expect(claimRes.stdout).toContain("SOURCE_URL: https://acme.example/checkout");
    expect(claimRes.stdout).toContain("LINKED_FEEDBACK:\n- RD-002: Cannot pay on iPhone");
    expect(claimRes.stdout).toContain("THREAD: 2 comments");

    // Verify lease state persisted
    const stateFile = join(configDir, "state", `${PROJECT_ID}.json`);
    expect(existsSync(stateFile)).toBe(true);
    const savedState = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(savedState.task_id).toBe("t3");
    expect(savedState.number).toBe(3);
    expect(savedState.lease).toBe("lease_t3_v2");

    // Subsequent claim while active -> BUSY
    const busyRes = await runCli(["claim"], { cwd: workspace, configDir });
    expect(busyRes.exitCode).toBe(0);
    expect(busyRes.stdout.trim()).toBe("BUSY RD-003");
  });

  it("supports triage, comment, thread filtering, heartbeat, and complete with auto-detected git ref", async () => {
    const task = makeTask({
      id: "t5",
      number: 5,
      title: "API returns 500 on empty query",
      priority: "normal",
      status: "ready",
      body: "GET /search?q= crashes.",
    });

    const mock = await startMockRelaydeskServer({
      tasks: [task],
      messages: {
        t5: [
          {
            id: 1,
            task_id: "t5",
            kind: "event",
            author: "system",
            body: "Feedback received",
            created_at: "2026-11-21T02:10:00.000Z",
          },
          {
            id: 2,
            task_id: "t5",
            kind: "event",
            author: "system",
            body: "ready → working",
            created_at: "2026-11-21T02:11:00.000Z",
          },
          {
            id: 3,
            task_id: "t5",
            kind: "comment",
            author: "human",
            body: "Reproduces on prod with empty q param.",
            created_at: "2026-11-21T02:12:00.000Z",
          },
        ],
      },
    });

    const workspace = makeTempDir("rd-ws-");
    const configDir = makeTempDir("rd-cfg-");

    initGitRepo(join(workspace, "web"), "https://github.com/AcmeOrg/web.git");
    const apiDir = join(workspace, "api");
    initGitRepo(apiDir, "git@github.com:AcmeOrg/api.git");

    await runCli(["init", "--url", mock.url, "--project", PROJECT_ID, "--key", AGENT_KEY], {
      cwd: workspace,
      configDir,
    });
    await runCli(["claim"], { cwd: workspace, configDir });

    // thread filters system noise and keeps human comment
    const threadRes = await runCli(["thread"], { cwd: workspace, configDir });
    expect(threadRes.exitCode).toBe(0);
    expect(threadRes.stdout).not.toContain("Feedback received");
    expect(threadRes.stdout).not.toContain("ready → working");
    expect(threadRes.stdout).toMatch(/\[human \d{2}:\d{2}\] Reproduces on prod with empty q param\./);

    // triage updates version in state file
    const triageRes = await runCli(
      [
        "triage",
        "--title",
        "Fix 500 on empty /search query",
        "--priority",
        "high",
        "--requirements",
        "Return 200 empty array when q is empty.",
      ],
      { cwd: workspace, configDir },
    );
    expect(triageRes.exitCode).toBe(0);
    expect(triageRes.stdout.trim()).toBe("OK triaged RD-005");
    const stateFile = join(configDir, "state", `${PROJECT_ID}.json`);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).version).toBe(3);

    // comment via --stdin
    const commentRes = await runCli(["comment", "--stdin"], {
      cwd: workspace,
      configDir,
      input: "Located crash in search handler, patching now.\n",
    });
    expect(commentRes.exitCode).toBe(0);
    expect(commentRes.stdout.trim()).toBe("OK commented RD-005");

    // heartbeat
    const hbRes = await runCli(["heartbeat"], { cwd: workspace, configDir });
    expect(hbRes.exitCode).toBe(0);
    expect(hbRes.stdout.trim()).toBe("OK heartbeat RD-005");

    // Make a real commit in ./api AFTER claim
    writeFileSync(join(apiDir, "search.js"), "export const search = (q) => (q ? [q] : []);\n", "utf8");
    git(apiDir, ["add", "."]);
    git(apiDir, ["commit", "-m", "fix: handle empty search query"]);
    const newShortSha = git(apiDir, ["rev-parse", "--short", "HEAD"]);

    // complete auto-detects the modified ./api repo commit
    const completeRes = await runCli(
      ["complete", "--summary", "Fixed empty query handling in /search. Tests pass.", "--force-done"],
      { cwd: workspace, configDir },
    );
    expect(completeRes.exitCode).toBe(0);
    expect(completeRes.stdout.trim()).toBe(`OK completed RD-005 -> done (AcmeOrg/api@main:${newShortSha})`);

    const completeReq = mock.state.requests.find((r) => r.path === "/t5/complete");
    expect(completeReq?.body?.delivery_ref).toBe(`AcmeOrg/api@main:${newShortSha}`);
    expect(completeReq?.body?.force_done).toBe(true);
    expect(String(completeReq?.body?.summary)).toContain("### Git Changes");
    expect(String(completeReq?.body?.summary)).toContain(`AcmeOrg/api@main:${newShortSha}`);

    // State file cleaned up
    expect(existsSync(stateFile)).toBe(false);
  });

  it("supports dismiss, merge (resolving RD-xxx), and fail (with --retryable), cleaning up state", async () => {
    const mock = await startMockRelaydeskServer({
      tasks: [
        makeTask({ id: "t10", number: 10, title: "Test spam submission", priority: "low" }),
        makeTask({ id: "t11", number: 11, title: "Duplicate crash report", priority: "normal" }),
        makeTask({ id: "t12", number: 12, title: "Original crash report", priority: "high" }),
        makeTask({ id: "t13", number: 13, title: "Needs Stripe live key", priority: "high" }),
      ],
    });

    const workspace = makeTempDir("rd-ws-");
    const configDir = makeTempDir("rd-cfg-");
    const stateFile = join(configDir, "state", `${PROJECT_ID}.json`);

    await runCli(["init", "--url", mock.url, "--project", PROJECT_ID, "--key", AGENT_KEY], {
      cwd: workspace,
      configDir,
    });

    // 1. dismiss RD-010
    expect((await runCli(["claim", "RD-010"], { cwd: workspace, configDir })).exitCode).toBe(0);
    const dismissRes = await runCli(["dismiss", "--reason", "Automated test noise."], {
      cwd: workspace,
      configDir,
    });
    expect(dismissRes.exitCode).toBe(0);
    expect(dismissRes.stdout.trim()).toBe("OK dismissed RD-010");
    expect(existsSync(stateFile)).toBe(false);

    // 2. merge RD-011 -> RD-012
    expect((await runCli(["claim", "RD-011"], { cwd: workspace, configDir })).exitCode).toBe(0);
    const mergeRes = await runCli(["merge", "--target", "RD-012"], { cwd: workspace, configDir });
    expect(mergeRes.exitCode).toBe(0);
    expect(mergeRes.stdout.trim()).toBe("OK merged RD-011 -> RD-012");
    const mergeReq = mock.state.requests.find((r) => r.path === "/t11/merge");
    expect(mergeReq?.body?.target_id).toBe("t12");
    expect(existsSync(stateFile)).toBe(false);

    // 3. fail RD-013 with --retryable
    expect((await runCli(["claim", "RD-013"], { cwd: workspace, configDir })).exitCode).toBe(0);
    const failRes = await runCli(
      ["fail", "--reason", "Missing Stripe sandbox credentials.", "--retryable"],
      { cwd: workspace, configDir },
    );
    expect(failRes.exitCode).toBe(0);
    expect(failRes.stdout.trim()).toBe("OK failed RD-013 -> ready");
    const failReq = mock.state.requests.find((r) => r.path === "/t13/fail");
    expect(failReq?.body?.retryable).toBe(true);
    expect(failReq?.body?.body).toBe("Missing Stripe sandbox credentials.");
    expect(existsSync(stateFile)).toBe(false);
  });

  it("supports status, --dir override, and handles --help / invalid usage cleanly", async () => {
    const mock = await startMockRelaydeskServer();
    const workspace = makeTempDir("rd-ws-");
    const otherDir = makeTempDir("rd-other-");
    const configDir = makeTempDir("rd-cfg-");

    initGitRepo(join(workspace, "web"), "https://github.com/AcmeOrg/web.git");

    await runCli(
      [
        "init",
        "--dir",
        workspace,
        "--url",
        mock.url,
        "--project",
        PROJECT_ID,
        "--key",
        AGENT_KEY,
        "--delivery",
        "pr_automerge",
      ],
      { cwd: otherDir, configDir },
    );

    const statusRes = await runCli(["status", "--dir", workspace], { cwd: otherDir, configDir });
    expect(statusRes.exitCode).toBe(0);
    expect(statusRes.stdout).toContain("PROJECT: Acme Suite (proj_acme)");
    expect(statusRes.stdout).toContain("DELIVERY: pr_automerge");
    expect(statusRes.stdout).toContain("LOCAL_LEASE: none");
    expect(statusRes.stdout).toContain("QUEUE: empty");
    expect(statusRes.stdout).toMatch(/- AcmeOrg\/web -> \.\/web \(main@[a-f0-9]+, clean\)/);

    // --help prints usage
    const helpRes = await runCli(["--help"], { cwd: otherDir, configDir });
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout).toContain("Usage: relaydesk.mjs");

    // Unknown command exits 1 with actionable stderr
    const badCmd = await runCli(["bogus"], { cwd: otherDir, configDir });
    expect(badCmd.exitCode).toBe(1);
    expect(badCmd.stderr).toContain("Unknown command 'bogus'");

    // Invalid auth key exits 1 with HTTP 401 stderr
    const badAuth = await runCli(
      ["init", "--url", mock.url, "--project", PROJECT_ID, "--key", "wrong_key"],
      { cwd: workspace, configDir },
    );
    expect(badAuth.exitCode).toBe(1);
    expect(badAuth.stderr).toContain("HTTP 401");
  });
});
