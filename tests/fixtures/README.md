# Subagent replay fixtures

These JSONL files are sanitized stdout captures from empty local workspaces. Identifiers are aliases; unrelated environment and session metadata are omitted. The prompts ask for constant strings, not repository content.

- `codex-subagents.jsonl`: Codex CLI 0.171.0, `exec --json`, v1 collaboration mode. One child returns `COPPER`. A completed spawn still reports a running child. The default v2 mode in the capture environment emitted an unaddressed wait instead. Relaydesk shows that wait as a tool call, not as evidence of a child. It does not switch collaboration modes or grant additional permissions.
- `codex-subagent-rollout.jsonl`: selected records from the parent thread's Codex v2 rollout. The matching spawn call, activity records and addressed final answer supply the task, lifecycle and result omitted by stdout. Tests supply current timestamps to replay them inside the active turn.
- `claude-subagents.jsonl`: Claude Code 2.1.330, `stream-json`. Two sequential Agent calls return `CHILD_OK` and `SECOND_OK`; only `ROOT_OK` belongs to the parent reply.

The bridge integration tests run these same files through both execution targets. Separate parser tests deliberately interleave events to exercise concurrency, failures, incomplete streams and older tool names; those event sequences are synthetic, not additional captures.
