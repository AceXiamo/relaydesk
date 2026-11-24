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

The **Feedback Agent** setting is independent of the operator chat, the legacy public AI switch and the global utility model. It is off by default. Choose a CLI harness and an explicit model ID, and provide only product guidance that may be shared with visitors. The harness must match the runtime of the project's saved cloud API key. Changing the operator model does not change the feedback model. A local Bridge login is not a credential for this feature. A healthy runner does not guarantee the key has access to the specified model; inference failures never silently select a different model or runtime.

The feedback runner starts the selected real CLI in a fresh empty directory for every turn. It has no volume mounts, project credentials, global CLI home or public listening port. Its only Docker network is internal. The CLI uses a one-shot loopback model adapter; it receives the public guide and the bounded visitor conversation as JSON, not CLI commands or file arguments. The web broker validates the exact instructions, conversation and model against what that CLI requested, discards its auxiliary metadata and tool catalog, and sends only the approved inference to the project's bound provider. Only validated text completions can reach the CLI, never upstream tool calls or the provider's raw event stream. The sidecar is not an operations runner: do not add mounts, app.env, a Docker socket, MCP, external networks, host networking, managed policies or plugins to it.

The Agent can ask follow-up questions, answer a usage question grounded in the public guide, or suggest a bug-report **draft** with user-reported evidence. It never files a ticket. Screenshots are attachments for a later manually confirmed ticket; diagnosis does not fetch or inspect the image. Visitors can submit manually when the runner, key or model is unavailable.

### Optional production setup

1. In the deployment directory, create a dedicated, owner-only `feedback.env` containing **only** a fresh service authentication token. Keep the token out of Compose's `.env`, Pier events, shell output and git. Generate it once; the command refuses to overwrite an existing file.

   ```sh
   (set -euC; umask 077; secret=$(openssl rand -hex 32); printf 'RELAYDESK_FEEDBACK_TOKEN=%s\n' "$secret" > feedback.env)
   ```

   Only this service token is passed to both containers. The optional `RELAYDESK_FEEDBACK_GATEWAYS` policy belongs in **web `app.env`**, never in the sidecar environment. By default, only the selected runtime's official provider is reachable. To approve a trusted custom gateway use exact, canonical, runtime-bound HTTPS base URLs, e.g. `RELAYDESK_FEEDBACK_GATEWAYS={"codex":["https://gateway.example/v1"],"claude":["https://gateway.example"]}`. The project must have saved its key for that exact destination. There are no wildcard hosts, redirect following or fallback from a gateway to an official endpoint. Approval entrusts the gateway with that project's key and visitors' public conversation; use a DNS zone and TLS endpoint under trusted control.

2. Set the nonsecret selectors `RELAYDESK_FEEDBACK_ENV_FILE=./feedback.env` and `COMPOSE_PROFILES=feedback` in the project's Compose `.env`. Never point the selector at `app.env`. Validate with `docker compose --profile feedback config --quiet`. With Pier, reconcile the updated Compose template (preserving host overrides) and cut over **only via the standard Release / `pier deploy` workflow**; see [the production runbook](deployment.md). For standalone Compose installations, `docker compose --profile feedback up -d web feedback-runner` starts both at the same pinned `IMAGE_TAG`. Without either selector the old manual flow still works. Never log plain `docker compose config`, which can reveal secrets.

3. Check service-to-service authentication **from web** without printing secrets:

   ```sh
   docker compose exec -T web node --input-type=module -e 'const r=await fetch("http://feedback-runner:8790/health",{headers:{authorization:"Bearer "+process.env.RELAYDESK_FEEDBACK_TOKEN},signal:AbortSignal.timeout(2500)});if(!r.ok||await r.text()!=="feedback-cli-v1")process.exit(1);console.log("feedback runner ready")'
   ```

4. Set the matching project cloud credentials, select a feedback model/guide, and enable it. Verify the portal shows the Agent only when ready. Start with a vague report, then give a documented usage question in the next turn: expect `clarify` then `usage`, without a ticket. A reproducible contradiction of the guide may yield a draft, but only visitor confirmation submits it. In case of an invalid model, incompatible gateway, rejected tool output, timeout or busy runner, manual feedback remains available. No external provider credentials are needed for the offline CLI protocol test `node scripts/verify-feedback-clis.mjs`; the image build runs it without external networking against the pinned binaries.

**Rollback / rotation:** Disable the project feedback switch first. Stop and remove only the optional service (`docker compose --profile feedback stop feedback-runner` then `docker compose --profile feedback rm -f feedback-runner`); do not remove the web volume. Remove the nonsecret profile and env-file selectors if applicable. To rotate the token, update `feedback.env` securely and recreate both services together through the normal release workflow. A missing or mismatched token closes this inference path, never the manual intake path.

For runner provisioning and verification, see [Project CLI runner](project-runner.md).
