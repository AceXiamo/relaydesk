#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("agy 1.5.18");
  process.exit(0);
}
if (args[0] !== "acp") process.exit(0);
const space = process.env.RELAYDESK_SPACE_DIR || process.cwd();
let facts;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  let result = {};
  if (method === "initialize")
    result = { agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } } };
  if (method === "session/new" || method === "session/resume") {
    const [server] = params.mcpServers;
    const auth = server.headers[0].value;
    const res = await fetch(server.url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_datasources", arguments: {} },
      }),
    });
    const body = await res.json();
    if (!res.ok || !body.result || body.result.isError) process.exit(2);
    facts = {
      space,
      args,
      method,
      resumeId: params.sessionId,
      tokenHash: createHash("sha256").update(auth).digest("hex"),
      handbook: existsSync(join(space, "HANDBOOK.md"))
        ? readFileSync(join(space, "HANDBOOK.md"), "utf8")
        : null,
    };
    result = { sessionId: params.sessionId || "local-agy-thread", configOptions: [] };
  }
  if (method === "session/prompt") {
    writeFileSync("facts.json", JSON.stringify(facts));
    console.log(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "fixture Agy reply" },
          },
        },
      }),
    );
    result = { stopReason: "end_turn" };
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
