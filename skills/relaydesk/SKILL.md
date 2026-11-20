---
name: relaydesk
description: Initialize a Relaydesk project workspace, configure a dedicated 1:1 autonomous project loop, or process queued Relaydesk feedback tasks with minimal token overhead.
---

# Relaydesk Autonomous Agent

Use the bundled zero-dependency CLI at `<skill_dir>/scripts/relaydesk.mjs` (Node 20+, where `<skill_dir>` is the folder containing this `SKILL.md`). Let `CLI="node <skill_dir>/scripts/relaydesk.mjs"`.

Never expose or commit `agent_key`. Credentials are stored exclusively in `~/.config/relaydesk/projects/<id>.json` (`0600`), while `.relaydesk.json` holds only non-sensitive workspace metadata.

## Workflow 1: Workspace Onboarding (`init`)

Run this workflow when setting up a Relaydesk project workspace for the first time (usually a folder containing one or more sibling git repos):

1. **Bind the workspace** inside the project workspace directory:
   ```bash
   $CLI init --url <relaydesk_url> --project <project_id> --key <agent_key> [--delivery direct_push|pr_automerge|review_only]
   ```
2. **Verify mapped repos**:
   - Inspect `REPOS MATCHED` and `REPOS MISSING` in the output.
   - If any project repos are missing locally, offer to clone them into the workspace with the printed `git clone https://github.com/<owner>/<repo>.git` command, then re-run `init` (or verify paths in `.relaydesk.json`).
   - If the workspace root itself is a git repo, suggest adding `.relaydesk.json` to `.gitignore`.
3. **Create a dedicated 1:1 scheduled automation task**:
   - Use the host harness's native scheduling/automation capability (Claude Code scheduled tasks or Codex automations) to create **one independent automation dedicated to this project workspace**, pinned to this exact working directory.
   - Register this exact fixed wake-up prompt (~25 tokens):
     ```text
     Use the relaydesk skill to autonomously handle at most 1 task in this workspace. If NOOP, PAUSED, or BUSY, reply with that exact word and stop immediately.
     ```
4. **Verify health**:
   ```bash
   $CLI check
   ```
   Confirm it returns `NOOP`, `PAUSED`, `BUSY ...`, or the pending queue list without errors.

## Workflow 2: Autonomous Execution Loop

Run this workflow on every scheduled wake-up or manual "handle next task" request. No human confirmation gate — execute end-to-end autonomously while spending minimal tokens.

### Step 1: Fast Exit (Zero Wasted Tokens)

Immediately claim at most 1 task:

```bash
$CLI claim
```

If stdout is `NOOP`, `PAUSED`, or starts with `BUSY`:
- **STOP IMMEDIATELY.**
- Do NOT read any files, do NOT run `git`, do NOT call any other tools.
- Reply with that exact status word (`NOOP`, `PAUSED`, or `BUSY`) and end the turn.

### Step 2: Autonomous Triage & Implementation

Read the printed task brief (`TASK`, `DELIVERY`, `TITLE`, `REPOS`, `PROJECT_RULES`, `REQUIREMENTS`, `FEEDBACK`, `SOURCE_URL`, `LINKED_FEEDBACK`, `THREAD`).

- Only run `$CLI thread` if `THREAD` has comments AND the brief alone lacks needed context.
- Inspect the actual codebase in the mapped repo path(s) to verify the feedback against reality:
  - **Noise / test submission / spam / already fixed**: run `$CLI dismiss --reason "<clear factual evidence>"` and stop.
  - **Duplicate of an existing open task**: run `$CLI merge --target <RD-xxx>` and stop.
  - **Valid bug or feature**:
    1. Optionally run `$CLI triage --title "..." --priority low|normal|high|urgent --requirements "..."` to record crisp acceptance criteria.
    2. Implement the minimal, clean fix across the relevant mapped repo(s) while obeying `PROJECT_RULES`.
    3. Run the repo's real verification commands (typecheck, unit/integration tests, build) and confirm they pass.
    4. For long-running work, call `$CLI heartbeat` periodically so the lease stays fresh.

### Step 3: Autonomous Delivery

Follow the `DELIVERY` mode printed in the claimed brief:

- **`direct_push` (default)**:
  1. Ensure all relevant checks pass and `git status` contains no stray or untracked junk files.
  2. Create a clean conventional commit (`fix:`, `feat:`, etc.).
  3. Run `git push` to the active branch to trigger deployment.
- **`pr_automerge`**:
  1. Checkout a new branch `relaydesk/rd-XXX` (matching the task code in lowercase).
  2. Commit cleanly and push the branch.
  3. Open a PR via `gh pr create --fill` (or explicit title/body) and enable auto-merge via `gh pr merge --auto --squash`.
- **`review_only`**:
  1. Checkout a new branch `relaydesk/rd-XXX`.
  2. Commit cleanly on that branch without pushing to the main branch.

### Step 4: Close the Loop

- **On success**: call `complete` with a concise Markdown report (root cause/changes, verification results, commit or PR link). Pass `--ref <pr_url>` for PRs; otherwise git `<repo>@<branch>:<shortsha>` is auto-detected.
  ```bash
  $CLI complete --summary "<concise Markdown report>" [--ref <pr_url>]
  ```
- **If genuinely blocked** (missing external credentials, unreachable service, or impossible/contradictory requirements after code investigation):
  ```bash
  $CLI fail --reason "<what was checked and the exact blocker>"
  ```
  Add `--retryable` only for transient failures (e.g., temporary registry outage).

## Operational Rules

- Process **at most 1 task** per wake-up; never loop to claim a second task in the same turn.
- Keep responses and tool calls lean; avoid redundant `check` or `status` calls before `claim`.
- Never fabricate test results or claim a fix without verifying it in the repo.
- Never commit secrets or `.relaydesk.json` into tracked repositories when unintended.
