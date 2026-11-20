import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequestListener } from "@react-router/node";
import type { ServerBuild } from "react-router";
import { ApiRouter } from "./server/api.ts";
import { Store } from "./server/store.ts";
import { WalletAuth } from "./server/wallet.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));

const MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  options: { immutable?: boolean; corsAny?: boolean } = {},
): boolean {
  if (!existsSync(filePath)) return false;
  const stat = statSync(filePath);
  if (!stat.isFile()) return false;
  const data = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("Content-Length", String(data.length));
  res.setHeader(
    "Cache-Control",
    options.immutable ? "public, max-age=31536000, immutable" : "no-store",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!options.corsAny) {
    res.setHeader("X-Frame-Options", "DENY");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  if ((req.method ?? "GET").toUpperCase() === "HEAD") {
    res.end();
  } else {
    res.end(data);
  }
  return true;
}

function resolveInside(baseDir: string, urlPath: string): string | null {
  const clean = urlPath.replace(/^\/+/, "");
  if (!clean) return null;
  const base = resolve(baseDir);
  const target = resolve(base, clean);
  if (!target.startsWith(base + "/") && target !== base) return null;
  return target;
}

export interface RelaydeskServerOptions {
  host?: string;
  port?: number;
  dbPath?: string;
  adminToken?: string;
  wallet?: WalletAuth | null;
  dev?: boolean;
  publicDir?: string;
  apiOnly?: boolean;
}

export interface RunningRelaydeskServer {
  server: Server;
  store: Store;
  api: ApiRouter;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startRelaydeskServer(
  options: RelaydeskServerOptions = {},
): Promise<RunningRelaydeskServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const dbPath = options.dbPath ?? join(ROOT, "data", "relaydesk.sqlite3");
  const publicDir = resolve(options.publicDir ?? join(ROOT, "public"));
  const buildClientDir = resolve(ROOT, "build", "client");
  const buildServerEntry = resolve(ROOT, "build", "server", "index.js");

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const store = new Store(dbPath);
  const api = new ApiRouter({
    store,
    adminToken: options.adminToken ?? "",
    wallet: options.wallet ?? null,
    bindHost: host,
  });

  interface ViteDevServerLike {
    middlewares: (
      req: IncomingMessage,
      res: ServerResponse,
      next: () => void,
    ) => void;
    ssrLoadModule: (id: string) => Promise<unknown>;
    close: () => Promise<void>;
  }

  let viteDevServer: ViteDevServerLike | null = null;

  let prodListener: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

  if (!options.apiOnly) {
    if (options.dev) {
      const vite = await import("vite");
      viteDevServer = (await vite.createServer({
        server: { middlewareMode: true },
        appType: "custom",
      })) as unknown as ViteDevServerLike;
    } else if (existsSync(buildServerEntry)) {
      const build = (await import(pathToFileURL(buildServerEntry).href)) as ServerBuild;
      prodListener = createRequestListener({ build, mode: "production" });
    }
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? "/";
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(rawUrl, "http://localhost").pathname);
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Malformed URL" }));
      return;
    }

    if (pathname.startsWith("/api/")) {
      await api.handle(req, res, pathname);
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();

    // Always serve widget.js, widget-capture.js & local fonts directly from public/
    if ((method === "GET" || method === "HEAD") && pathname === "/widget.js") {
      if (serveStaticFile(req, res, join(publicDir, "widget.js"), { corsAny: true })) {
        return;
      }
    }
    if ((method === "GET" || method === "HEAD") && pathname === "/widget-capture.js") {
      if (
        serveStaticFile(req, res, join(publicDir, "widget-capture.js"), {
          corsAny: true,
          immutable: true,
        })
      ) {
        return;
      }
    }
    if ((method === "GET" || method === "HEAD") && pathname.startsWith("/fonts/")) {
      const fontPath = resolveInside(publicDir, pathname);
      if (fontPath && serveStaticFile(req, res, fontPath, { immutable: true })) {
        return;
      }
    }

    // In production, serve built client static assets before SSR
    if (!options.dev && !options.apiOnly && (method === "GET" || method === "HEAD")) {
      const clientAsset = resolveInside(buildClientDir, pathname);
      if (clientAsset && existsSync(clientAsset) && statSync(clientAsset).isFile()) {
        serveStaticFile(req, res, clientAsset, {
          immutable: pathname.startsWith("/assets/"),
        });
        return;
      }
    }

    // Wallet auth gate for HTML document navigation (non-asset paths)
    if (
      api.wallet &&
      method === "GET" &&
      pathname !== "/login" &&
      !pathname.startsWith("/@") &&
      !pathname.startsWith("/assets/") &&
      !pathname.startsWith("/node_modules/") &&
      !pathname.startsWith("/app/") &&
      !pathname.endsWith(".js") &&
      !pathname.endsWith(".css") &&
      !pathname.endsWith(".ico") &&
      !pathname.endsWith(".svg") &&
      !api.isWalletAuthenticated(req)
    ) {
      res.statusCode = 302;
      res.setHeader("Location", "/login");
      res.setHeader("Cache-Control", "no-store");
      res.end();
      return;
    }

    if (options.apiOnly) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (viteDevServer) {
      viteDevServer.middlewares(req, res, async () => {
        try {
          const build = (await viteDevServer!.ssrLoadModule(
            "virtual:react-router/server-build",
          )) as ServerBuild;
          const listener = createRequestListener({ build, mode: "development" });
          listener(req, res);
        } catch (err) {
          console.error(err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(err instanceof Error ? err.stack ?? err.message : "SSR error");
          }
        }
      });
      return;
    }

    if (prodListener) {
      prodListener(req, res);
      return;
    }

    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Relaydesk frontend is not built yet. Run `pnpm build` or start with `--dev`.");
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;

  const close = async () => {
    if (viteDevServer) {
      await viteDevServer.close();
    }
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
    store.close();
  };

  return { server, store, api, port: actualPort, url, close };
}

function parseCliArgs(argv: string[]) {
  let host = "127.0.0.1";
  let port = Number(process.env.PORT ?? "8787");
  let dbPath = join(ROOT, "data", "relaydesk.sqlite3");
  let dev = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dev") {
      dev = true;
    } else if (arg === "--host" && argv[i + 1]) {
      host = argv[++i];
    } else if (arg === "--port" && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (arg === "--db" && argv[i + 1]) {
      dbPath = resolve(argv[++i]);
    }
  }
  return { host, port, dbPath, dev };
}

const isEntrypoint =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  process.umask(0o077);
  const { host, port, dbPath, dev } = parseCliArgs(process.argv.slice(2));
  let wallet: WalletAuth | null = null;
  if (process.env.RELAYDESK_ADMIN_WALLET) {
    wallet = new WalletAuth(
      process.env.RELAYDESK_ADMIN_WALLET,
      process.env.RELAYDESK_ORIGIN ?? "",
    );
  }
  const running = await startRelaydeskServer({
    host,
    port,
    dbPath,
    adminToken: process.env.RELAYDESK_ADMIN_TOKEN ?? "",
    wallet,
    dev,
  });
  console.log(`Relaydesk listening on ${running.url}`);

  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
