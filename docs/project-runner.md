# Project CLI runner

Authenticated operators can queue discussions and PR audits for the project's selected CLI. Saving a project API key enables dispatch. The public widget, intake clarification and feedback prescreen use restricted HTTP model calls when enabled.

## Deployment layout

Run the web service and runner **beside** one another. One runner is bound to one project and one GitHub repository. It calls the web API over HTTPS; it needs no inbound port, Docker socket, `edge` network, web data volume, or host checkout. Do not reuse `app.env`, developer home directories, production database credentials or cloud credentials. Task text, code read by the CLI, and the project handbook can reach the selected model provider; only enable this for repositories whose data the provider is authorized to process.

The current Pier deployment pattern uses a SHA-tagged Web image and `./data:/app/data` behind Traefik. The runner is a separate Compose project with its own configuration. Installing a new Web version alone must not start shell-capable jobs or require CLI secrets. The release workflow also builds `ghcr.io/acexiamo/relaydesk-runner:<full SHA>`. Use the matching SHA for the two images.

## Provision a runner

1. Release the matching Web and runner images. On a Linux host with Docker, Compose v2 and Landlock ABI 3 or later, create a **separate deployment directory per project**. Copy `deploy/compose.runner.yml` there as `compose.yml`, `deploy/runner.env.example` as `runner.env`, and `deploy/runner-handbook.example.md` as `runner-handbook.md`. Put `IMAGE_TAG=<full release SHA>` in that directory's `.env`. Keep the runner environment private (`0600`). Do not overwrite the Web deployment's Compose or `.env`.
2. In `runner.env`, set the reachable HTTPS origin, project ID, project agent key and bound `owner/repository`. In the Compose `.env`, set `CLI_PROJECT_CONFIG_DIR` to the absolute host path `<web data directory>/cli-runners/<project ID>`. Save the project configuration in the console to create the directory. To provision before the first save, create both `cli-runners` and its project directory with mode `0700`, owned by the Web runtime (UID/GID 10001 in the provided image). The runner mounts this project's directory read-only and rereads `settings.json` before every claim. Keep existing site-specific TLS ingress or host-gateway settings when replacing an old Compose override. Remove the old Codex mount and environment settings from the override.
3. Edit the handbook with the environment, test commands and acceptance criteria. No credentials belong in the handbook. Configure no production database initially; only use synthetic fixtures. Local toolchains and build dependencies must be compatible with the image; bake additional system packages into an operator-maintained derivative image rather than granting the checkout root.
4. From the runner deployment directory, run the self-test and then start the service:

```bash
docker compose run --rm runner --self-test
```

```bash
docker compose up -d runner
```

5. In project settings choose Codex CLI or Claude Code, an API base URL, a model, and a dedicated API key. Empty URL and model fields select the CLI defaults. For private repositories, save a repository-scoped GitHub token with read access to contents and pull requests. Use the acceptance check below to verify provider authentication and repository access. The example limits a runner to 1 CPU, 2 GiB of memory and a bounded tmpfs. Enforce network egress restrictions at the infrastructure layer where required.

The Web service saves credentials in a mode-0600 file using atomic replacement. Protect the host volume and backups. Clearing the project API key stops new claims. A job already running retains its credentials until it exits. Claude Code shell commands can inherit the project model key. The supervisor keeps its project agent key and the repository token out of the model CLI environment; use a dedicated budget-limited key and only run authorized repository code. Worker presence and readiness describe polling and eligibility to claim a job. A successful model request verifies the credential.

## Acceptance check

- From an authenticated operator session, ask the project assistant to inspect an identifiable source file in a non-sensitive fixture repository. The discussion should show that the request is queued, then running, then return the result. Closing and reopening the drawer should not cancel or duplicate the job.
- For a PR audit, use a real GitHub PR URL for the bound repository as the task delivery reference. Check the recorded full SHA against the PR at execution time. The source branch must be in the bound repository; this runner rejects forks. A missing/mismatched PR must fail, not silently fall back to the local or default branch. A newer commit requires a new audit.
- Check that the result distinguishes commands actually run from checks blocked by missing tools/data. A successful CLI exit is not approval to merge. The runner neither merges nor deploys, and an audit does not change task ownership.
- Stop the runner and enqueue another question. The UI must show that it is waiting, not invent an answer from the configured LLM. If an in-flight runner disappears and its lease expires, the run fails rather than being replayed automatically.

The project assistant uses a fresh checkout and thread context for each question, not a shared interactive home directory. Temporary edits for verification are discarded. Use the existing [coding connector](../agent/README.md) for delivery tasks whose edits must survive in a worktree. Direct production SQL, persistent CLI sessions, automatic pushes and auto-merge are not part of this execution path.

## Rollback

Pause project automation and inspect queued and running work. Stop the dedicated runner before reverting both images and their Compose configurations to matching versions. Retain the Web data directory and a verified backup. Recheck the settings and self-test before resuming work. The new release reads only the new per-project settings path, so enter credentials in the console after upgrading.
