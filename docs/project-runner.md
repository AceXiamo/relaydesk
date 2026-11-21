# Project CLI runner

The authenticated operator's project assistant and PR audit can use Codex CLI or Claude Code instead of a synchronous model API call. The public widget, intake bot and LLM prescreen do not have access to the CLI. The web service never starts a shell on behalf of a task. Projects default to their existing model route until the operator enables the project CLI setting.

## Deployment layout

Run the web service and runner **beside** one another. One runner is bound to one project and one GitHub repository. It calls the web API over HTTPS; it needs no inbound port, Docker socket, `edge` network, web data volume, or host checkout. Do not reuse `app.env`, developer home directories, production database credentials or cloud credentials. Task text, code read by the CLI, and the project handbook can reach the selected model provider; only enable this for repositories whose data the provider is authorized to process.

The current Pier deployment pattern uses a SHA-tagged Web image and `./data:/app/data` behind Traefik. The runner is a separate Compose project with its own configuration. Installing a new Web version alone must not start shell-capable jobs or require CLI secrets. The release workflow also builds `ghcr.io/acexiamo/relaydesk-runner:<full SHA>`. Use the matching SHA for the two images.

## Provision a runner

1. Release the matching Web and runner images. On a Linux host with Docker, Compose v2 and Landlock ABI 3 or later, create a **separate deployment directory per project**. Copy `deploy/compose.runner.yml` there as `compose.yml`, `deploy/runner.env.example` as `runner.env`, and `deploy/runner-handbook.example.md` as `runner-handbook.md`. Put `IMAGE_TAG=<full release SHA>` in that directory's `.env`. Keep the runner environment private (`0600`). Do not overwrite the Web deployment's Compose or `.env`.
2. In `runner.env`, set `RELAYDESK_URL` to the reachable HTTPS origin, the project ID and project agent key from its settings, the exact bound `owner/repository`, and `RELAYDESK_CLI=codex` or `claude`. Set only the corresponding provider credential. This is a dedicated non-interactive CLI installation; browser model profiles and desktop logins do not configure it. Private repositories need a dedicated GitHub token with read access to contents and pull requests. Do not use a token with merge, workflow or organization administration permissions. Treat any provider credential available to the CLI as potentially accessible to programs it starts. Use a revocable, budget-limited provider key, and do not run untrusted third-party PRs with that key; use a credential broker with policy-enforced egress for that threat model.
3. Edit the handbook with the environment, test commands and acceptance criteria. No credentials belong in the handbook. Configure no production database initially; only use synthetic fixtures. Local toolchains and build dependencies must be compatible with the image; bake additional system packages into an operator-maintained derivative image rather than granting the checkout root.
4. From the runner deployment directory, run the self-test and then start the service:

```bash
docker compose run --rm runner --self-test
```

```bash
docker compose up -d runner
```

5. Enable CLI execution in **this project's settings**, not the global model settings. Run one small acceptance job before enabling it for more projects. The example limits execution to one runner process, 1 CPU, 2 GiB of memory, a bounded temporary filesystem, and no inbound traffic. Repository scripts may make outbound requests; enforce egress restrictions at the network layer where required. A project with a large dependency tree may need a larger tmpfs and memory limit.

## Manage Codex credentials from the console (same-host deployment)

The Codex card in project settings saves a dedicated OpenAI API key and an optional read-only GitHub token. The browser never receives saved values. This is independent of the workspace AI Endpoint and does not enable the project CLI switch automatically. A successful save does **not** authenticate against OpenAI; only an actual test job verifies the key, quota and repository access.

One-time provisioning: deploy matching Web and runner versions. Use the normal project identity in `runner.env`, but leave the provider and repository credentials out of it. Copy `deploy/compose.runner-codex.override.yml` to the runner deployment directory as `compose.override.yml`. Set `CODEX_PROJECT_CONFIG_DIR` in the runner's Compose `.env` to the absolute host path `<web data directory>/codex-runners/<project ID>`. Only this single project's directory is mounted, read-only, outside the job sandbox. Saving credentials creates the directory automatically. To start a worker before the first save, create both `codex-runners` and its project ID subdirectory with mode `0700`, owned by the Web runtime UID/GID (10001:10001 in the provided image). Never mount the entire Web data directory. The template disables implicit host directory creation so a typo cannot silently create a root-owned directory.

The web service stores plaintext credentials in a mode-0600 file replaced atomically. Protect the host volume and any backups; an SQLite-only backup does not include these files. A managed worker rereads credentials before each claim, so saving, rotating or clearing a key needs no restart. Clearing a key stops new claims, not a job already using the previous key; revoke at the provider for immediate invalidation. Offline and missing credentials are distinct statuses. A worker using environment credentials still works, but credentials saved in the console are not used until the read-only mount is configured. Remote-host workers can continue using the environment-based setup; the agent key does not authorize downloading any provider secret over HTTP.

## Acceptance check

- From an authenticated operator session, ask the project assistant to inspect an identifiable source file in a non-sensitive fixture repository. The discussion should show that the request is queued, then running, then return the result. Closing and reopening the drawer should not cancel or duplicate the job.
- For a PR audit, use a real GitHub PR URL for the bound repository as the task delivery reference. Check the recorded full SHA against the PR at execution time. The source branch must be in the bound repository; this runner rejects forks. A missing/mismatched PR must fail, not silently fall back to the local or default branch. A newer commit requires a new audit.
- Check that the result distinguishes commands actually run from checks blocked by missing tools/data. A successful CLI exit is not approval to merge. The runner neither merges nor deploys, and an audit does not change task ownership.
- Stop the runner and enqueue another question. The UI must show that it is waiting, not invent an answer from the configured LLM. If an in-flight runner disappears and its lease expires, the run fails rather than being replayed automatically.

The project assistant uses a fresh checkout and thread context for each question, not a shared interactive home directory. Temporary edits for verification are discarded. Use the existing [coding connector](../agent/README.md) for delivery tasks whose edits must survive in a worktree. Direct production SQL, persistent CLI sessions, automatic pushes and auto-merge are not part of this execution path.

## Rollback

Stop the dedicated runner, review any in-flight or queued work, and turn off the project CLI setting to route new discussions back to the existing model API. Keep the Web database/backup in place. Do not restart a runner over unexplored pending work. Updating the Web service does not update an independent runner deployment: update its pinned SHA and rerun its self-test explicitly.
