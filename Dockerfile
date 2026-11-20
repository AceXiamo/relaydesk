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
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.11.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/build ./build
COPY server.ts ./
COPY server/ server/
COPY app/lib/ app/lib/
COPY public/widget.js public/widget.js
COPY public/widget-capture.js public/widget-capture.js
COPY public/fonts/ public/fonts/
RUN mkdir -p /app/data && chown -R 10001:10001 /app/data
USER 10001:10001
EXPOSE 8787
CMD ["node", "server.ts", "--host", "0.0.0.0"]
