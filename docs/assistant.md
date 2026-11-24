# Project CLI settings

Open the project's settings, select Codex CLI or Claude Code, and enter the API key for that project. A custom API endpoint and model name are optional. The runner reads the saved settings before each claim. The provider key and optional read-only GitHub token are write-only in the console.

| Runtime | Gateway protocol | Example API base URL |
| --- | --- | --- |
| Codex CLI | OpenAI Responses API with tool support | `https://api.openai.com/v1` |
| Claude Code | Anthropic Messages API with tool support | `https://api.anthropic.com` |

Use the HTTPS base URL supplied by the gateway. The CLI appends the resource path. Leave the address or model empty to use the CLI default. When changing runtime or endpoint, enter the key for the new destination or explicitly clear it. Upgrading from a previous release requires entering the project settings again.

## Ask the CLI

Open a task and choose **询问项目 CLI**. The question is queued for the runner bound to that project. It checks out the repository, uses the thread as context, and posts its result in the discussion. **发起 PR 审计** queues an audit of the task's linked pull request. **发送评论** adds a human comment. A queued request waits while the runner is offline. A completed model-backed job verifies the key, model access and gateway protocol together.

## Public feedback

The **Feedback Agent** setting is independent of the operator chat, the legacy public AI switch and the global utility model. It is off by default. It runs directly on an operator's connected **Local Bridge** node—no separate `feedback-runner` sidecar container and no cloud provider API key are required.

In a project's settings, choose the Local Bridge target (`auto` to follow the project's local node priority, or a specific `local:<id>` node), CLI harness (`codex` or `claude`), optional model and reasoning effort, and an optional custom `system_prompt` describing product context or answer guidelines. Cloud execution is never used as a fallback; if the selected local node is offline or not bound to the project directory, diagnosis requests fail with HTTP `503` and visitors are guided to submit feedback manually.

Every public diagnosis turn executes in a strict read-only isolation mode on the Local Bridge:
- `sandbox_mode: "read-only"`, `network_access: false`, and `localAccess: "restricted"` (overriding any `codex_full_access` / `claude_full_access` setting on the host).
- MCP server, task RPCs, datasource credentials, `HANDBOOK.md`, `DEPLOY.md`, and private project workspace files are never exposed to the turn.
- The CLI can read the bound project repository in read-only mode and inspect visitor screenshots that pass R2 origin allowlist and magic-byte validation (staged transiently into an isolated per-turn directory and deleted immediately after completion).
- Responses stream over SSE (`Accept: text/event-stream`) or return JSON with a `clarify`, `usage`, or `suspected_bug` (with an editable ticket draft) outcome. The Agent never files a ticket automatically; visitors always review and submit manually.

For Local Bridge setup, see [Local Bridge and model routing](local-bridge-and-model-routing.md). For runner provisioning and verification, see [Project CLI runner](project-runner.md).
