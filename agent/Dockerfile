FROM node:22-bookworm-slim

# The supervisor starts as container root only to drop to a separate uid, reap
# descendants and clean up. No Docker socket, host namespace or nested mounts.
ARG CODEX_VERSION=0.140.0
ARG CLAUDE_VERSION=2.1.321
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates git python3 build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund \
      "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm cache clean --force \
    && groupadd --gid 10001 cli-job \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin cli-job

WORKDIR /opt/relaydesk-agent
COPY relay.py cli_runner.py cli_sandbox.py ./
ENTRYPOINT ["/usr/bin/python3", "-E", "-s", "-B", "-u", "/opt/relaydesk-agent/cli_runner.py"]
