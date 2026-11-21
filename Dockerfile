FROM node:24-slim AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.11.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json react-router.config.ts vite.config.ts ./
COPY app/ app/
COPY public/ public/
RUN pnpm build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG CODEX_VERSION=0.140.0
ARG CLAUDE_VERSION=2.1.321
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ripgrep \
      ca-certificates \
      python3 \
      postgresql-client \
      default-mysql-client \
      sqlite3 \
      redis-tools \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm cache clean --force \
    && groupadd --gid 10001 relaydesk \
    && useradd --uid 10001 --gid 10001 --home-dir /app/data/.cli-home --no-create-home --shell /bin/bash relaydesk
RUN corepack enable && corepack prepare pnpm@9.11.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/build ./build
COPY server.ts ./
COPY server/ server/
COPY app/lib/ app/lib/
COPY public/widget.js public/widget.js
COPY public/widget-capture.js public/widget-capture.js
COPY public/widget/ public/widget/
COPY public/fonts/ public/fonts/
RUN mkdir -p /app/data/.cli-home/.codex && chown -R 10001:10001 /app/data
ENV HOME=/app/data/.cli-home
ENV RELAYDESK_CODEX_LEGACY_LANDLOCK=1
USER 10001:10001
RUN codex --version \
    && claude --version \
    && psql --version \
    && mysql --version \
    && sqlite3 --version \
    && redis-cli --version \
    && git --version \
    && rg --version \
    && python3 --version
EXPOSE 8787
CMD ["node", "server.ts", "--host", "0.0.0.0"]
