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

Public AI is off by default. The project switch enables widget conversations, intake clarification and feedback prescreening for the selected runtime's official API address. Custom gateway addresses are available to the CLI. With an empty model field, the Web service uses `gpt-4.1-mini` for OpenAI Responses or `claude-sonnet-5-5` for Anthropic Messages. The CLI uses its own default. Visitors can still submit feedback manually while public AI is off or unavailable. Public requests cannot dispatch CLI jobs.

For runner provisioning and verification, see [Project CLI runner](project-runner.md).
