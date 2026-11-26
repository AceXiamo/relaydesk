#!/usr/bin/env node
/**
 * Relaydesk Agent CLI — zero-dependency Node 20+ client for autonomous task execution.
 *
 * Secret isolation:
 *   - Credentials: <RELAYDESK_CONFIG_DIR | ~/.config/relaydesk>/projects/<project_id>.json (0600)
 *   - Lease state: <RELAYDESK_CONFIG_DIR | ~/.config/relaydesk>/state/<project_id>.json (0600)
 *   - Workspace:   <workspace>/.relaydesk.json (non-sensitive binding, NEVER contains agent_key)
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_DELIVERY_MODES = new Set(["direct_push", "pr_automerge", "review_only"]);
const VALID_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const NOISE_EVENTS = new Set([
  "Feedback received",
  "Task created",
  "Local agent claimed task",
  "Server AI pre-screened and promoted to ready",
]);
const STATUS_TRANSITION_RE =
  /^(triage|ready|working|handoff|waiting|review|done)\s*(?:→|->)\s*(triage|ready|working|handoff|waiting|review|done)$/;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function getConfigDir() {
  return process.env.RELAYDESK_CONFIG_DIR || join(homedir(), ".config", "relaydesk");
}

function assertSafeProjectId(projectId) {
  if (!projectId || /[/\\]|\.\./.test(projectId)) {
    throw new CliError(`Invalid project ID: ${projectId || "(empty)"}`);
  }
}

function credPath(projectId) {
  assertSafeProjectId(projectId);
  return join(getConfigDir(), "projects", `${projectId}.json`);
}

function statePath(projectId) {
  assertSafeProjectId(projectId);
  return join(getConfigDir(), "state", `${projectId}.json`);
}

function writeJsonFile(filePath, data, mode) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: mode ? 0o700 : 0o755 });
  const content = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(filePath, content, { encoding: "utf8", mode });
  if (mode !== undefined) {
    try {
      chmodSync(filePath, mode);
    } catch {
      // Best effort on platforms that do not support POSIX chmod.
    }
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new CliError(`Failed to read ${filePath}: ${err.message}`);
  }
}

function taskCode(num) {
  return `RD-${String(num).padStart(3, "0")}`;
}

function parseTaskCode(input) {
  if (!input) return null;
  const match = /^RD-(\d+)$/i.exec(String(input).trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

function normalizeUrl(raw) {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+/i.test(trimmed)) {
    throw new CliError(`Invalid Relaydesk URL: ${raw || "(empty)"}`);
  }
  return trimmed;
}

function normalizeRemoteToSlug(remoteUrl) {
  const raw = String(remoteUrl || "").trim();
  if (!raw) return null;
  let cleaned = raw.replace(/\/+$/, "").replace(/\.git$/i, "");

  // SSH scp-like syntax: git@github.com:owner/repo
  const scpMatch = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(cleaned);
  if (scpMatch) {
    cleaned = scpMatch[1];
  } else {
    try {
      const parsed = new URL(cleaned);
      cleaned = parsed.pathname.replace(/^\/+/, "");
    } catch {
      // Fallback for non-standard remote formats
    }
  }

  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

function runGit(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function isGitDir(dir) {
  return existsSync(join(dir, ".git"));
}

function scanLocalGitRepos(rootDir) {
  const found = [];

  const inspectDir = (absDir, relPath) => {
    if (!isGitDir(absDir)) return;
    const remote = runGit(absDir, ["remote", "get-url", "origin"]);
    const slug = normalizeRemoteToSlug(remote);
    if (slug) {
      found.push({ slug, slugLower: slug.toLowerCase(), path: relPath, absDir });
    }
  };

  inspectDir(rootDir, ".");

  let entries = [];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absChild = join(rootDir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = statSync(absChild).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    inspectDir(absChild, `./${entry.name}`);
  }

  return found;
}

function extractProjectRepos(project) {
  const list = [];
  const seen = new Set();
  const candidates = Array.isArray(project?.repos) && project.repos.length > 0
    ? project.repos
    : project?.repo
      ? [project.repo]
      : [];

  for (const item of candidates) {
    const trimmed = String(item || "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(trimmed);
  }
  return list;
}

function findWorkspace(startDir) {
  let current = resolve(startDir || process.cwd());
  while (true) {
    const candidate = join(current, ".relaydesk.json");
    if (existsSync(candidate)) {
      return { workspaceDir: current, bindingPath: candidate };
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new CliError(
        `No .relaydesk.json found in ${resolve(startDir || process.cwd())} or any parent directory. Run 'init' first.`,
      );
    }
    current = parent;
  }
}

function loadContext(dirOverride) {
  const { workspaceDir, bindingPath } = findWorkspace(dirOverride);
  const binding = readJsonFile(bindingPath);
  if (!binding?.project_id) {
    throw new CliError(`Invalid workspace binding in ${bindingPath}: missing project_id.`);
  }
  const cPath = credPath(binding.project_id);
  if (!existsSync(cPath)) {
    throw new CliError(
      `Credentials not found at ${cPath}. Run 'init' for project ${binding.project_id}.`,
    );
  }
  const creds = readJsonFile(cPath);
  if (!creds?.agent_key || !creds?.url) {
    throw new CliError(`Invalid credentials file at ${cPath}. Re-run 'init'.`);
  }
  return {
    workspaceDir,
    bindingPath,
    binding,
    creds,
    url: normalizeUrl(creds.url || binding.url),
    projectId: binding.project_id,
    agentKey: creds.agent_key,
  };
}

function loadActiveState(projectId) {
  const sPath = statePath(projectId);
  if (!existsSync(sPath)) {
    throw new CliError("No active claimed task for this project. Run 'claim' first.");
  }
  const state = readJsonFile(sPath);
  if (!state?.task_id || !state?.lease) {
    throw new CliError(`Corrupted state file at ${sPath}.`);
  }
  return { statePath: sPath, state };
}

function clearActiveState(projectId) {
  const sPath = statePath(projectId);
  rmSync(sPath, { force: true });
}

async function apiRequest({ url, projectId, agentKey, method = "GET", path, body }) {
  const fullUrl = `${normalizeUrl(url)}/api/projects/${encodeURIComponent(projectId)}/agent${path}`;
  const headers = {
    Authorization: `Bearer ${agentKey}`,
    Accept: "application/json",
  };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(fullUrl, { method, headers, body: payload });
  } catch (err) {
    throw new CliError(`Network error calling ${method} ${fullUrl}: ${err.message}`);
  }

  const rawText = await res.text();
  let json = null;
  if (rawText) {
    try {
      json = JSON.parse(rawText);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const detail = json?.error || json?.message || rawText.slice(0, 200) || res.statusText;
    throw new CliError(`HTTP ${res.status} on ${method} ${path}: ${detail}`);
  }

  return json ?? {};
}

function readStdinText() {
  try {
    return readFileSync(0, "utf8").trim();
  } catch (err) {
    throw new CliError(`Failed to read stdin: ${err.message}`);
  }
}

function snapshotRepoHeads(workspaceDir, bindingRepos) {
  const heads = {};
  if (!Array.isArray(bindingRepos)) return heads;
  for (const entry of bindingRepos) {
    if (!entry?.repo || !entry?.path) continue;
    const absDir = resolve(workspaceDir, entry.path);
    if (!existsSync(absDir) || !isGitDir(absDir)) continue;
    const sha = runGit(absDir, ["rev-parse", "HEAD"]);
    if (sha) heads[entry.repo] = sha;
  }
  return heads;
}

function detectGitDelivery(workspaceDir, bindingRepos, state) {
  const inspected = [];
  const modified = [];
  const claimedEpoch = state?.claimed_at ? Math.floor(Date.parse(state.claimed_at) / 1000) : null;
  const savedHeads = state?.repo_heads || {};

  if (!Array.isArray(bindingRepos)) {
    return { ref: "", notes: [] };
  }

  for (const entry of bindingRepos) {
    if (!entry?.repo || !entry?.path) continue;
    const absDir = resolve(workspaceDir, entry.path);
    if (!existsSync(absDir) || !isGitDir(absDir)) continue;

    const fullSha = runGit(absDir, ["rev-parse", "HEAD"]);
    if (!fullSha) continue;
    const shortSha = runGit(absDir, ["rev-parse", "--short", "HEAD"]) || fullSha.slice(0, 7);
    const branch = runGit(absDir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
    const commitEpochStr = runGit(absDir, ["show", "-s", "--format=%ct", "HEAD"]);
    const commitEpoch = commitEpochStr ? Number.parseInt(commitEpochStr, 10) : null;
    const statText = runGit(absDir, ["show", "--stat", "--oneline", "-1"]) || "";
    const subject = runGit(absDir, ["show", "-s", "--format=%s", "HEAD"]) || "";

    const info = {
      repo: entry.repo,
      path: entry.path,
      fullSha,
      shortSha,
      branch,
      subject,
      statText,
      ref: `${entry.repo}@${branch}:${shortSha}`,
    };
    inspected.push(info);

    const prevHead = savedHeads[entry.repo];
    const headChanged = prevHead ? prevHead !== fullSha : false;
    const committedAfterClaim =
      !prevHead &&
      claimedEpoch !== null &&
      !Number.isNaN(claimedEpoch) &&
      commitEpoch !== null &&
      !Number.isNaN(commitEpoch) &&
      commitEpoch >= claimedEpoch;

    if (headChanged || committedAfterClaim) {
      modified.push(info);
    }
  }

  const targets = modified.length > 0 ? modified : inspected.length > 0 ? [inspected[0]] : [];
  const ref = targets.map((t) => t.ref).join(", ");
  const notes = targets.map((t) => {
    const statLines = t.statText.split("\n").map((l) => l.trim()).filter(Boolean);
    const summaryLine = statLines.length > 1 ? statLines[statLines.length - 1] : "";
    const detail = [t.subject, summaryLine].filter(Boolean).join(" — ");
    return `- \`${t.ref}\`${detail ? ` (${detail})` : ""}`;
  });

  return { ref, notes, targets };
}

function formatClock(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function isRedundantThreadEvent(msg) {
  if (msg.kind !== "event") return false;
  const body = String(msg.body || "").trim();
  if (!body) return true;
  if (NOISE_EVENTS.has(body)) return true;
  if (STATUS_TRANSITION_RE.test(body)) return true;
  return false;
}

function printJson(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function formatRepoLines(project, binding, workspaceDir) {
  const projectRepos = extractProjectRepos(project);
  const mappedByLower = new Map();
  if (Array.isArray(binding?.repos)) {
    for (const r of binding.repos) {
      if (r?.repo && r?.path) {
        mappedByLower.set(r.repo.toLowerCase(), r.path);
      }
    }
  }

  const list = projectRepos.length > 0
    ? projectRepos
    : Array.isArray(binding?.repos)
      ? binding.repos.map((r) => r.repo)
      : [];

  if (list.length === 0) {
    return ["- (none configured)"];
  }

  return list.map((repo) => {
    const relPath = mappedByLower.get(repo.toLowerCase());
    if (relPath && existsSync(resolve(workspaceDir, relPath))) {
      return `- ${repo} -> ${relPath}`;
    }
    return `- ${repo} -> [MISSING]`;
  });
}

// ---------- Argument Parser ----------

const BOOLEAN_FLAGS = new Set(["json", "stdin", "force-done", "retryable", "help"]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let command = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        const key = arg.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
        } else {
          if (i + 1 >= argv.length) {
            throw new CliError(`Missing value for --${key}`);
          }
          flags[key] = argv[++i];
        }
      }
      continue;
    }
    if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

function usageText() {
  return [
    "Usage: relaydesk.mjs <command> [options]",
    "",
    "Commands:",
    "  init --url <url> --project <id> --key <agent_key> [--delivery direct_push|pr_automerge|review_only]",
    "  check                                     Check queue status (PAUSED / BUSY / NOOP / pending list)",
    "  claim [RD-001|task_id]                    Claim next (or specified) task and print compact brief",
    "  thread                                    Fetch task thread comments for active lease",
    "  triage [--title ...] [--priority ...] [--requirements ...] [--stdin]",
    "  comment <text> | --body <text> | --stdin  Post a comment on active task",
    "  heartbeat                                 Renew active task lease",
    "  complete [--summary <md>] [--ref <ref>] [--requirements <md>] [--stdin] [--force-done]",
    "  dismiss --reason <md> | --stdin           Dismiss active task as noise/already fixed",
    "  merge --target <RD-xxx|task_id>           Merge active task into an existing task",
    "  fail --reason <md> [--retryable]          Report blocker/failure on active task",
    "  status                                    Show workspace binding, local repos, lease, and queue",
    "",
    "Global options:",
    "  --dir <path>   Override working directory for .relaydesk.json lookup",
    "  --json         Print raw JSON output",
    "  -h, --help     Show help",
  ].join("\n");
}

// ---------- Commands ----------

async function cmdInit(flags) {
  const url = normalizeUrl(flags.url);
  const projectId = String(flags.project || "").trim();
  const agentKey = String(flags.key || "").trim();
  const deliveryOverride = flags.delivery ? String(flags.delivery).trim() : null;

  if (!projectId) throw new CliError("Missing required flag: --project <id>");
  if (!agentKey) throw new CliError("Missing required flag: --key <agent_key>");
  assertSafeProjectId(projectId);

  if (deliveryOverride && !VALID_DELIVERY_MODES.has(deliveryOverride)) {
    throw new CliError(
      `Invalid --delivery value '${deliveryOverride}'. Expected: direct_push, pr_automerge, or review_only.`,
    );
  }

  const targetDir = resolve(flags.dir || process.cwd());
  if (!existsSync(targetDir)) {
    throw new CliError(`Target directory does not exist: ${targetDir}`);
  }

  const res = await apiRequest({
    url,
    projectId,
    agentKey,
    method: "GET",
    path: "/project",
  });

  const project = res.project || res;
  const projectName = project.name || projectId;
  const projectRepos = extractProjectRepos(project);
  const effectiveDelivery = deliveryOverride || project.delivery_mode || "direct_push";

  const localRepos = scanLocalGitRepos(targetDir);
  const localByLower = new Map();
  for (const lr of localRepos) {
    if (!localByLower.has(lr.slugLower)) {
      localByLower.set(lr.slugLower, lr);
    }
  }

  const matched = [];
  const missing = [];
  for (const repo of projectRepos) {
    const hit = localByLower.get(repo.toLowerCase());
    if (hit) {
      matched.push({ repo, path: hit.path });
    } else {
      missing.push(repo);
    }
  }

  const cPath = credPath(projectId);
  writeJsonFile(
    cPath,
    {
      url,
      project_id: projectId,
      agent_key: agentKey,
      updated_at: new Date().toISOString(),
    },
    0o600,
  );

  const bindingPath = join(targetDir, ".relaydesk.json");
  const binding = {
    url,
    project_id: projectId,
    project_name: projectName,
    delivery_mode: effectiveDelivery,
    repos: matched,
  };
  writeJsonFile(bindingPath, binding);

  if (flags.json) {
    printJson({
      binding,
      binding_path: bindingPath,
      credentials_path: cPath,
      matched,
      missing,
      project: {
        id: project.id || projectId,
        name: projectName,
        repos: projectRepos,
        delivery_mode: project.delivery_mode || effectiveDelivery,
        automation_paused: Boolean(project.automation_paused),
      },
    });
    return;
  }

  const lines = [
    `INIT OK: ${projectName} (${projectId})`,
    `WORKSPACE: ${targetDir}`,
    `DELIVERY: ${effectiveDelivery}`,
    `CREDENTIALS: ${cPath} (0600)`,
    `BINDING: ${bindingPath}`,
  ];

  if (projectRepos.length === 0) {
    lines.push("REPOS: (none configured)");
  } else {
    lines.push("REPOS MATCHED:");
    if (matched.length === 0) {
      lines.push("- (none)");
    } else {
      for (const m of matched) {
        lines.push(`- ${m.repo} -> ${m.path}`);
      }
    }
    if (missing.length > 0) {
      lines.push("REPOS MISSING:");
      for (const repo of missing) {
        lines.push(`- ${repo} -> git clone https://github.com/${repo}.git`);
      }
    }
  }

  lines.push(
    `NEXT: Create a dedicated 1:1 scheduled automation bound to ${targetDir} to run the relaydesk skill autonomously.`,
  );

  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdCheck(flags) {
  const ctx = loadContext(flags.dir);
  const data = await apiRequest({ ...ctx, method: "GET", path: "/queue" });

  if (flags.json) {
    printJson(data);
    return;
  }

  if (data.paused) {
    process.stdout.write("PAUSED\n");
    return;
  }
  if (data.active) {
    process.stdout.write(`BUSY ${taskCode(data.active.number)} ${data.active.status}\n`);
    return;
  }
  const pending = Array.isArray(data.pending) ? data.pending : [];
  if (pending.length === 0) {
    process.stdout.write("NOOP\n");
    return;
  }
  const lines = pending.map(
    (item) => `${taskCode(item.number)} [${item.priority}] (${item.status}) ${item.title}`,
  );
  process.stdout.write(lines.join("\n") + "\n");
}

async function resolveTaskIdFromQueue(ctx, ref) {
  const num = parseTaskCode(ref);
  if (num === null) return { id: String(ref).trim(), label: String(ref).trim() };

  const queue = await apiRequest({ ...ctx, method: "GET", path: "/queue" });
  const pending = Array.isArray(queue.pending) ? queue.pending : [];
  const hit = pending.find((item) => item.number === num)
    || (queue.active && queue.active.number === num ? queue.active : null);
  if (!hit) {
    throw new CliError(`Task ${taskCode(num)} not found in queue.`);
  }
  return { id: hit.id, label: taskCode(num) };
}

async function cmdClaim(flags, positional) {
  const ctx = loadContext(flags.dir);
  const targetArg = flags.task || positional[0];
  let body = {};

  if (targetArg) {
    const num = parseTaskCode(targetArg);
    if (num !== null) {
      const queue = await apiRequest({ ...ctx, method: "GET", path: "/queue" });
      const pending = Array.isArray(queue.pending) ? queue.pending : [];
      const hit = pending.find((item) => item.number === num);
      if (!hit) {
        throw new CliError(`Task ${taskCode(num)} not found in pending queue.`);
      }
      body = { task_id: hit.id };
    } else {
      body = { task_id: String(targetArg).trim() };
    }
  }

  const data = await apiRequest({ ...ctx, method: "POST", path: "/claim", body });

  if (data.task && data.lease) {
    const repoHeads = snapshotRepoHeads(ctx.workspaceDir, ctx.binding.repos);
    writeJsonFile(
      statePath(ctx.projectId),
      {
        task_id: data.task.id,
        number: data.task.number,
        lease: data.lease,
        version: data.task.version ?? 1,
        claimed_at: new Date().toISOString(),
        repo_heads: repoHeads,
      },
      0o600,
    );
  }

  if (flags.json) {
    printJson(data);
    return;
  }

  if (data.paused) {
    process.stdout.write("PAUSED\n");
    return;
  }
  if (data.busy) {
    const code = data.active_task ? taskCode(data.active_task.number) : "ACTIVE";
    process.stdout.write(`BUSY ${code}\n`);
    return;
  }
  if (!data.task) {
    process.stdout.write("NOOP\n");
    return;
  }

  const task = data.task;
  const project = data.project || {};
  const delivery = ctx.binding.delivery_mode || project.delivery_mode || "direct_push";
  const targetBranch = String(project.target_branch || "").trim();
  const branchPrefix = String(project.branch_prefix || "").trim() || "relaydesk";
  const attempt = Math.max(1, Number(task.attempts || 1));
  const scriptPath = process.argv[1] || fileURLToPath(import.meta.url);

  const lines = [
    `TASK: ${taskCode(task.number)} | priority=${task.priority} | status=${task.status} | attempt=${attempt}/3`,
    `DELIVERY: ${delivery}`,
    ...(targetBranch ? [`TARGET_BRANCH: ${targetBranch}`] : []),
    ...(branchPrefix !== "relaydesk" ? [`BRANCH_PREFIX: ${branchPrefix}`] : []),
    `TITLE: ${task.title}`,
    "REPOS:",
    ...formatRepoLines(project, ctx.binding, ctx.workspaceDir),
  ];

  const rules = String(project.agent_instructions || "").trim();
  if (rules) {
    lines.push("PROJECT_RULES:");
    lines.push(rules);
  }

  const reqs = String(task.requirements || "").trim();
  if (reqs) {
    lines.push("REQUIREMENTS:");
    lines.push(reqs);
  }

  lines.push("FEEDBACK:");
  lines.push(String(task.body || "").trim() || "(empty)");

  const sourceUrl = String(task.source_url || "").trim();
  if (sourceUrl) {
    lines.push(`SOURCE_URL: ${sourceUrl}`);
  }

  if (Array.isArray(task.linked_feedback) && task.linked_feedback.length > 0) {
    lines.push("LINKED_FEEDBACK:");
    for (const lf of task.linked_feedback) {
      const snippet = String(lf.body || "").replace(/\s+/g, " ").trim().slice(0, 140);
      lines.push(`- ${taskCode(lf.number)}: ${lf.title}${snippet ? ` — ${snippet}` : ""}`);
    }
  }

  const msgCount = Number(task.message_count ?? 0);
  if (msgCount > 0) {
    lines.push(
      `THREAD: ${msgCount} comments (run \`node ${scriptPath} thread\` only if more context is needed)`,
    );
  } else {
    lines.push("THREAD: 0 comments");
  }

  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdThread(flags) {
  const ctx = loadContext(flags.dir);
  const { state } = loadActiveState(ctx.projectId);
  const data = await apiRequest({
    ...ctx,
    method: "GET",
    path: `/${encodeURIComponent(state.task_id)}/thread`,
  });

  if (flags.json) {
    printJson(data);
    return;
  }

  const messages = Array.isArray(data.messages) ? data.messages : [];
  const relevant = messages.filter((m) => !isRedundantThreadEvent(m));
  if (relevant.length === 0) {
    process.stdout.write("NO_MESSAGES\n");
    return;
  }

  const lines = relevant.map((m) => {
    const body = String(m.body || "").trim().replace(/\n+/g, " | ");
    return `[${m.author || "unknown"} ${formatClock(m.created_at)}] ${body}`;
  });
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdTriage(flags) {
  const ctx = loadContext(flags.dir);
  const { statePath: sPath, state } = loadActiveState(ctx.projectId);

  const payload = { lease: state.lease };
  if (flags.title !== undefined) payload.title = String(flags.title);
  if (flags.priority !== undefined) {
    const p = String(flags.priority).trim();
    if (!VALID_PRIORITIES.has(p)) {
      throw new CliError(`Invalid priority '${p}'. Expected: low, normal, high, or urgent.`);
    }
    payload.priority = p;
  }
  if (flags.requirements !== undefined) {
    payload.requirements = String(flags.requirements);
  } else if (flags.stdin) {
    payload.requirements = readStdinText();
  }

  if (
    payload.title === undefined &&
    payload.priority === undefined &&
    payload.requirements === undefined
  ) {
    throw new CliError(
      "triage requires at least one of --title, --priority, --requirements, or --stdin.",
    );
  }

  const data = await apiRequest({
    ...ctx,
    method: "POST",
    path: `/${encodeURIComponent(state.task_id)}/triage`,
    body: payload,
  });

  if (data.task?.version != null) {
    state.version = data.task.version;
    writeJsonFile(sPath, state, 0o600);
  }

  if (flags.json) {
    printJson(data);
    return;
  }
  process.stdout.write(`OK triaged ${taskCode(state.number)}\n`);
}

async function cmdComment(flags, positional) {
  const ctx = loadContext(flags.dir);
  const { statePath: sPath, state } = loadActiveState(ctx.projectId);

  const body = flags.stdin
    ? readStdinText()
    : flags.body !== undefined
      ? String(flags.body).trim()
      : positional.join(" ").trim();

  if (!body) {
    throw new CliError("comment requires text via positional arg, --body, or --stdin.");
  }

  const data = await apiRequest({
    ...ctx,
    method: "POST",
    path: `/${encodeURIComponent(state.task_id)}/comment`,
    body: { lease: state.lease, body },
  });

  if (data.task?.version != null) {
    state.version = data.task.version;
    writeJsonFile(sPath, state, 0o600);
  }

  if (flags.json) {
    printJson(data);
    return;
  }
  process.stdout.write(`OK commented ${taskCode(state.number)}\n`);
}

async function cmdHeartbeat(flags) {
  const ctx = loadContext(flags.dir);
  const { statePath: sPath, state } = loadActiveState(ctx.projectId);

  const data = await apiRequest({
    ...ctx,
    method: "POST",
    path: `/${encodeURIComponent(state.task_id)}/heartbeat`,
    body: { lease: state.lease },
  });

  if (data.task?.version != null) {
    state.version = data.task.version;
    writeJsonFile(sPath, state, 0o600);
  }

  if (flags.json) {
    printJson(data);
    return;
  }
  process.stdout.write(`OK heartbeat ${taskCode(state.number)}\n`);
}

async function cmdComplete(flags, positional) {
  const ctx = loadContext(flags.dir);
  const { state } = loadActiveState(ctx.projectId);

  let summary = flags.stdin
    ? readStdinText()
    : flags.summary !== undefined
      ? String(flags.summary).trim()
      : positional.join(" ").trim();

  if (!summary) {
    throw new CliError("complete requires a summary via --summary, --stdin, or positional text.");
  }

  const detected = detectGitDelivery(ctx.workspaceDir, ctx.binding.repos, state);
  const deliveryRef = flags.ref !== undefined ? String(flags.ref).trim() : detected.ref;

  if (detected.notes.length > 0) {
    const alreadyMentionsCommit = detected.targets?.some((t) => summary.includes(t.shortSha));
    if (!alreadyMentionsCommit && !/###\s*Git Changes/i.test(summary)) {
      summary = `${summary}\n\n### Git Changes\n${detected.notes.join("\n")}`;
    }
  }

  const payload = {
    lease: state.lease,
    summary,
  };
  if (deliveryRef) payload.delivery_ref = deliveryRef;
  if (flags.requirements !== undefined) payload.requirements = String(flags.requirements);
  if (flags["force-done"]) payload.force_done = true;

  const data = await apiRequest({
    ...ctx,
    method: "POST",
    path: `/${encodeURIComponent(state.task_id)}/complete`,
    body: payload,
  });

  clearActiveState(ctx.projectId);

  if (flags.json) {
    printJson(data);
    return;
  }

  const status = data.task?.status || "done";
  const finalRef = data.task?.delivery_ref || deliveryRef;
  process.stdout.write(
    `OK completed ${taskCode(state.number)} -> ${status}${finalRef ? ` (${finalRef})` : ""}\n`,
  );
}

async function cmdDismiss(flags, positional) {
  const ctx = loadContext(flags.dir);
  const { state } = loadActiveState(ctx.projectId);

  const reason = flags.stdin
    ? readStdinText()
    : flags.reason !== undefined
      ? String(flags.reason).trim()
      : positional.join(" ").trim();

  if (!reason) {
    throw new CliError("dismiss requires --reason <markdown> or --stdin.");
  }

  const data = await apiRequest({
    ...ctx,
    method: "POST",
    path: `/${encodeURIComponent(state.task_id)}/dismiss`,
    body: { lease: state.lease, reason },
  });

  clearActiveState(ctx.projectId);

  if (flags.json) {
    printJson(data);
    return;
  }
  process.stdout.write(`OK dismissed ${taskCode(state.number)}\n`);
}

async function cmdMerge(flags, positional) {
  const ctx = loadContext(flags.dir);
  const { state } = loadActiveState(ctx.projectId);

  const rawTarget = flags.target !== undefined ? String(flags.target).trim() : (positional[0] || "").trim();
  if (!rawTarget) {
    throw new CliError("merge requires --target <RD-xxx|task_id>.");
  }

  const resolved = await resolveTaskIdFromQueue(ctx, rawTarget);
  const data = await apiRequest({
    ...ctx,
    method: "POST",
    path: `/${encodeURIComponent(state.task_id)}/merge`,
    body: { lease: state.lease, target_id: resolved.id },
  });

  clearActiveState(ctx.projectId);

  if (flags.json) {
    printJson(data);
    return;
  }
  process.stdout.write(`OK merged ${taskCode(state.number)} -> ${resolved.label}\n`);
}

async function cmdFail(flags, positional) {
  const ctx = loadContext(flags.dir);
  const { state } = loadActiveState(ctx.projectId);

  const body = flags.stdin
    ? readStdinText()
    : flags.reason !== undefined
      ? String(flags.reason).trim()
      : flags.body !== undefined
        ? String(flags.body).trim()
        : positional.join(" ").trim();

  if (!body) {
    throw new CliError("fail requires --reason <markdown>, --body <markdown>, or --stdin.");
  }

  const payload = { lease: state.lease, body };
  if (flags.retryable) payload.retryable = true;

  const data = await apiRequest({
    ...ctx,
    method: "POST",
    path: `/${encodeURIComponent(state.task_id)}/fail`,
    body: payload,
  });

  clearActiveState(ctx.projectId);

  if (flags.json) {
    printJson(data);
    return;
  }
  const status = data.task?.status || "waiting";
  process.stdout.write(`OK failed ${taskCode(state.number)} -> ${status}\n`);
}

async function cmdStatus(flags) {
  const ctx = loadContext(flags.dir);
  const queue = await apiRequest({ ...ctx, method: "GET", path: "/queue" });
  const sPath = statePath(ctx.projectId);
  const localState = existsSync(sPath) ? readJsonFile(sPath) : null;

  const projectRepos = extractProjectRepos(queue.project);
  const mappedByLower = new Map();
  if (Array.isArray(ctx.binding.repos)) {
    for (const r of ctx.binding.repos) {
      if (r?.repo && r?.path) mappedByLower.set(r.repo.toLowerCase(), r.path);
    }
  }

  const repoList = projectRepos.length > 0
    ? projectRepos
    : (ctx.binding.repos || []).map((r) => r.repo);

  const repoStatuses = repoList.map((repo) => {
    const relPath = mappedByLower.get(repo.toLowerCase()) || null;
    if (!relPath) return { repo, path: null, present: false };
    const absDir = resolve(ctx.workspaceDir, relPath);
    if (!existsSync(absDir) || !isGitDir(absDir)) {
      return { repo, path: relPath, present: false };
    }
    const branch = runGit(absDir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
    const sha = runGit(absDir, ["rev-parse", "--short", "HEAD"]) || "none";
    const porcelain = runGit(absDir, ["status", "--porcelain"]) || "";
    const dirty = porcelain.length > 0;
    return { repo, path: relPath, present: true, branch, sha, dirty };
  });

  if (flags.json) {
    printJson({
      workspace: ctx.workspaceDir,
      binding: ctx.binding,
      local_state: localState,
      repos: repoStatuses,
      queue,
    });
    return;
  }

  const delivery = ctx.binding.delivery_mode || queue.project?.delivery_mode || "direct_push";
  const lines = [
    `PROJECT: ${ctx.binding.project_name || queue.project?.name || ctx.projectId} (${ctx.projectId})`,
    `WORKSPACE: ${ctx.workspaceDir}`,
    `DELIVERY: ${delivery}`,
    `LOCAL_LEASE: ${localState ? `${taskCode(localState.number)} (${localState.task_id}, claimed ${localState.claimed_at})` : "none"}`,
  ];

  if (queue.paused) {
    lines.push("QUEUE: PAUSED");
  } else if (queue.active) {
    lines.push(`QUEUE: BUSY ${taskCode(queue.active.number)} (${queue.active.status})`);
  } else {
    const count = Array.isArray(queue.pending) ? queue.pending.length : 0;
    lines.push(`QUEUE: ${count === 0 ? "empty" : `${count} pending`}`);
  }

  lines.push("REPOS:");
  if (repoStatuses.length === 0) {
    lines.push("- (none configured)");
  } else {
    for (const r of repoStatuses) {
      if (!r.present) {
        lines.push(`- ${r.repo} -> [MISSING]`);
      } else {
        lines.push(`- ${r.repo} -> ${r.path} (${r.branch}@${r.sha}, ${r.dirty ? "dirty" : "clean"})`);
      }
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
}

// ---------- Entrypoint ----------

async function main() {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));

  if (flags.help) {
    process.stdout.write(usageText() + "\n");
    return;
  }

  if (!command) {
    process.stderr.write(usageText() + "\n");
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case "init":
      await cmdInit(flags);
      break;
    case "check":
      await cmdCheck(flags);
      break;
    case "claim":
      await cmdClaim(flags, positional);
      break;
    case "thread":
      await cmdThread(flags);
      break;
    case "triage":
      await cmdTriage(flags);
      break;
    case "comment":
      await cmdComment(flags, positional);
      break;
    case "heartbeat":
      await cmdHeartbeat(flags);
      break;
    case "complete":
      await cmdComplete(flags, positional);
      break;
    case "dismiss":
      await cmdDismiss(flags, positional);
      break;
    case "merge":
      await cmdMerge(flags, positional);
      break;
    case "fail":
      await cmdFail(flags, positional);
      break;
    case "status":
      await cmdStatus(flags);
      break;
    default:
      throw new CliError(`Unknown command '${command}'. Run with --help for usage.`);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = err instanceof CliError ? err.exitCode : 1;
});
