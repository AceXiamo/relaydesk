import { spawn, execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import {
  MAX_WIRE,
  cliTextStream,
  cliInference,
  systemPrompt,
  validTurn,
  type CliTurn,
  type Inference,
} from "./feedback-protocol.ts";

const bins = { codex: "/usr/local/bin/codex", claude: "/usr/local/bin/claude" };
function equal(a: string | undefined, b: string) {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// The only provider visible to the CLI is this loopback, single-turn adapter. Neither the
// private service token nor the real model key is inherited by the CLI. Public conversation
// data is encoded by publicPrompt, never passed as arguments, paths or configuration.
export async function runFeedbackCli(
  t: CliTurn,
  infer: (request: Inference) => Promise<string>,
  signal: AbortSignal,
  executables = bins,
) {
  if (!validTurn(t)) throw Error("invalid turn");
  signal.throwIfAborted();
  const home = mkdtempSync(join(tmpdir(), "feedback-"));
  const key = randomBytes(32).toString("hex");
  let claimed = false,
    modelText: string | undefined;
  const proxy = createServer(async (req, res) => {
    try {
      if (
        req.method !== "POST" ||
        (t.runtime === "codex"
          ? req.url !== "/v1/responses" ||
            !equal(req.headers.authorization, `Bearer ${key}`)
          : req.url?.split("?")[0] !== "/v1/messages" ||
            !equal(String(req.headers["x-api-key"] || ""), key)) ||
        claimed
      )
        throw Error();
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        if ((bytes += chunk.length) > MAX_WIRE * 4) throw Error();
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const request = cliInference(t, payload);
      if (claimed) throw Error();
      claimed = true;
      modelText = await infer(request);
      if (
        typeof modelText !== "string" ||
        Buffer.byteLength(modelText) > MAX_WIRE / 2
      )
        throw Error();
      res
        .writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        })
        .end(cliTextStream(t, modelText));
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw Error();
    const base = `http://127.0.0.1:${address.port}`;
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, "work"));
    const instructions = join(home, "instructions.txt");
    writeFileSync(instructions, systemPrompt, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      TMPDIR: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      CI: "1",
      TERM: "dumb",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.1,localhost",
    };
    const codex = t.runtime === "codex";
    const args = codex
      ? [
          "-a",
          "never",
          "exec",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "-c",
          'web_search="disabled"',
          "-c",
          "features.shell_tool=false",
          "-c",
          "features.unified_exec=false",
          "-c",
          "features.multi_agent=false",
          "-c",
          "features.hooks=false",
          "-c",
          "features.apps=false",
          "-c",
          'shell_environment_policy.inherit="none"',
          "-c",
          `model_instructions_file=${JSON.stringify(instructions)}`,
          "-c",
          'model_provider="feedback"',
          "-c",
          'model_providers.feedback.name="Feedback"',
          "-c",
          'model_providers.feedback.env_key="FEEDBACK_TURN_KEY"',
          "-c",
          'model_providers.feedback.wire_api="responses"',
          "-c",
          `model_providers.feedback.base_url="${base}/v1"`,
          "-c",
          "model_providers.feedback.supports_websockets=false",
          "--color",
          "never",
          "--model",
          t.model,
          "-",
        ]
      : [
          "--bare",
          "--print",
          "--disable-slash-commands",
          "--no-session-persistence",
          "--setting-sources",
          "",
          "--settings",
          '{"disableAllHooks":true}',
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--permission-mode",
          "dontAsk",
          "--tools",
          "",
          "--system-prompt",
          systemPrompt,
          "--model",
          t.model,
          "--output-format",
          "text",
        ];
    Object.assign(
      env,
      codex
        ? { CODEX_HOME: join(home, ".codex"), FEEDBACK_TURN_KEY: key }
        : {
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
            ANTHROPIC_API_KEY: key,
            ANTHROPIC_BASE_URL: base,
            DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
    );
    signal.throwIfAborted();
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(executables[t.runtime], args, {
        cwd: join(home, "work"),
        env,
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const kill = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already stopped */
          }
      };
      const chunks: Buffer[] = [];
      let size = 0;
      signal.addEventListener("abort", kill, { once: true });
      child.stdout.on("data", (b: Buffer) => {
        if ((size += b.length) > MAX_WIRE) kill();
        else chunks.push(b);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(t.prompt);
      child.once("error", () => reject(Error("CLI unavailable")));
      child.once("close", (code) => {
        signal.removeEventListener("abort", kill);
        kill();
        if (
          code !== 0 ||
          signal.aborted ||
          !modelText ||
          Buffer.concat(chunks).toString().trim() !== modelText.trim()
        )
          reject(Error("CLI did not complete"));
        else resolve(modelText);
      });
    });
  } finally {
    proxy.closeAllConnections();
    proxy.close();
    rmSync(home, { recursive: true, force: true });
  }
}

export function createFeedbackRunner(token: string, executables = bins) {
  if (!/^[a-f0-9]{64}$/.test(token))
    throw Error("A private feedback runner token is required");
  if (
    [
      "/etc/claude-code",
      "/etc/codex",
      "/Library/Application Support/ClaudeCode",
    ].some((p) => existsSync(p))
  )
    throw Error("Managed CLI policies are not permitted");
  for (const bin of Object.values(executables))
    execFileSync(bin, ["--version"], {
      cwd: "/",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent" },
      stdio: "ignore",
      timeout: 5000,
    });
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WIRE,
    perMessageDeflate: false,
  });
  const server = createServer((req, res) => {
    if (
      req.method === "GET" &&
      req.url === "/health" &&
      equal(req.headers.authorization, `Bearer ${token}`)
    )
      res.writeHead(200).end("feedback-cli-v1");
    else res.writeHead(404).end();
  });
  let busy = false;
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/turn" ||
      !equal(req.headers.authorization, `Bearer ${token}`) ||
      busy
    ) {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      busy = true;
      const abort = new AbortController();
      const timer = setTimeout(() => ws.terminate(), 60_000);
      timer.unref();
      let started = false,
        complete: ((s: string) => void) | undefined;
      ws.once("error", () => ws.terminate());
      ws.once("close", () => {
        clearTimeout(timer);
        abort.abort();
        complete?.("");
        if (!started) busy = false;
      });
      ws.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (complete && msg.type === "text" && typeof msg.text === "string") {
            const take = complete;
            complete = undefined;
            take(msg.text);
            return;
          }
          if (started || msg.type !== "start" || !validTurn(msg)) throw Error();
          started = true;
          try {
            await runFeedbackCli(
              msg,
              (request) =>
                new Promise<string>((resolve, reject) => {
                  if (ws.readyState !== WebSocket.OPEN) {
                    reject(Error());
                    return;
                  }
                  complete = resolve;
                  ws.send(
                    JSON.stringify({
                      type: "infer",
                      request,
                      model: msg.model,
                    }),
                  );
                }),
              abort.signal,
              executables,
            );
            if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"done"}');
          } finally {
            busy = false;
          }
          ws.close();
        } catch {
          ws.terminate();
        }
      });
    });
  });
  return server;
}
if (import.meta.main)
  createFeedbackRunner(process.env.RELAYDESK_FEEDBACK_TOKEN || "").listen(
    8790,
    "0.0.0.0",
  );
