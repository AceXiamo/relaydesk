# Relaydesk Agent Skill & CLI

Token-minimized agent skill and zero-dependency Node 20+ CLI (`scripts/relaydesk.mjs`) for running autonomous 1:1 Relaydesk feedback loops in Claude Code and Codex.

## Installation

### Claude Code

Symlink (recommended) or copy `skills/relaydesk` into `~/.claude/skills/relaydesk`:

```bash
mkdir -p ~/.claude/skills
ln -s /path/to/relaydesk/skills/relaydesk ~/.claude/skills/relaydesk
```

### Codex

Symlink or copy `skills/relaydesk` into `~/.codex/skills/relaydesk`:

```bash
mkdir -p ~/.codex/skills
ln -s /path/to/relaydesk/skills/relaydesk ~/.codex/skills/relaydesk
```

## Workspace Layout (Single-Repo & Multi-Repo)

Relaydesk supports both single-repo workspaces (`.git` at workspace root) and multi-repo parent folders containing sibling repositories:

```text
~/work/acme/                  <- Workspace directory (bind 1:1 scheduled automation here)
├── .relaydesk.json           <- Non-sensitive project binding (NEVER stores agent_key)
├── acme-web/                 <- Matched via git remote origin (owner/acme-web)
└── acme-api/                 <- Matched via git remote origin (owner/acme-api)
```

### Secret Isolation

- **Credentials** (`agent_key`): `~/.config/relaydesk/projects/<project_id>.json` (`0600`)
- **Active lease state**: `~/.config/relaydesk/state/<project_id>.json` (`0600`)
- **Workspace binding**: `<workspace>/.relaydesk.json` (URL, project ID/name, delivery mode, repo paths only)
- Override config root with `RELAYDESK_CONFIG_DIR` when needed (e.g., CI or isolated tests).

## CLI Reference

Run with `node <skill_dir>/scripts/relaydesk.mjs <command> [options]`.
All commands emit ultra-compact plain text by default and accept `--json` for raw JSON and `--dir <path>` to override workspace discovery (by default, walks up parent directories for `.relaydesk.json`).

| Command | Description |
| --- | --- |
| `init --url <url> --project <id> --key <key> [--delivery direct_push\|pr_automerge\|review_only]` | Verify credentials, scan `.` and `./*` git remotes, save `0600` credentials, and write `.relaydesk.json`. |
| `check` | Ultra-compact queue check: `PAUSED`, `BUSY RD-003 <status>`, `NOOP`, or pending lines `RD-001 [high] (triage) Title`. |
| `claim [RD-001\|task_id]` | Claim next (or specified) task, persist lease state, and print a de-noised task brief (or `NOOP`/`PAUSED`/`BUSY`). |
| `thread` | Fetch task comments/events for the active lease, filtering redundant status noise. |
| `triage [--title ...] [--priority low\|normal\|high\|urgent] [--requirements ...]` | Update triaged metadata/requirements on the active task. |
| `comment <text> \| --body <text> \| --stdin` | Post a progress or clarification comment on the active task. |
| `heartbeat` | Renew the active task lease during long-running work. |
| `complete [--summary <md>] [--ref <ref>] [--stdin] [--force-done]` | Auto-detect git delivery ref (`repo@branch:shortsha`) and commit stats, complete task, and clear local lease. |
| `dismiss --reason <md> \| --stdin` | Dismiss noise, test feedback, or already-resolved items and clear local lease. |
| `merge --target <RD-xxx\|task_id>` | Merge active duplicate task into an existing task and clear local lease. |
| `fail --reason <md> [--retryable]` | Report a blocker or failure on the active task and clear local lease. |
| `status` | Show workspace binding, local repo git state, active lease, and server queue summary. |

## Recommended 1:1 Automation Prompt

Create one dedicated scheduled automation per project workspace pointing at the workspace directory with this fixed prompt:

```text
Use the relaydesk skill to autonomously handle at most 1 task in this workspace. If NOOP, PAUSED, or BUSY, reply with that exact word and stop immediately.
```
