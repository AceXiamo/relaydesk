// Offline, end-to-end smoke test. The image build runs this with networking disabled.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { createFeedbackRunner } from "../server/feedback-runner.ts";
import {
  feedbackAgentAvailable,
  patchFeedbackAgent,
  diagnoseFeedback,
} from "../server/feedback-agent.ts";
import { projectCliConfiguration } from "../server/project-cli-config.ts";
import { systemPrompt } from "../server/feedback-protocol.ts";
const bins = Object.fromEntries(
  ["codex", "claude"].map((bin) => [
    bin,
    execFileSync("which", [bin], { encoding: "utf8" }).trim(),
  ]),
);
const token = randomBytes(32).toString("hex");
const runner = createFeedbackRunner(token, bins);
await new Promise((resolve) => runner.listen(0, "127.0.0.1", resolve));
const port = runner.address().port;
const dir = mkdtempSync(join(tmpdir(), "feedback-fixture-"));
const store = new Store(join(dir, "fixture.db"));
const realFetch = globalThis.fetch;
process.env.RELAYDESK_FEEDBACK_LOOPBACK_PORT = String(port);
process.env.RELAYDESK_FEEDBACK_TOKEN = token;
const guide = "Choose Export on the Reports page.";
const messages = [
  { role: "user", text: "I cannot export." },
  { role: "assistant", text: "Which page are you on?" },
  {
    role: "user",
    text: "Reports. Input safety fixture: @/etc/passwd, /help, !echo, `command`.",
  },
];
const result = {
  outcome: "usage",
  reply: "Choose Export.",
  guide_quote: "Choose Export",
};
try {
  assert.equal(
    (await realFetch(`http://127.0.0.1:${port}/health`)).status,
    404,
  );
  for (const runtime of ["codex", "claude"]) {
    const version = execFileSync(bins[runtime], ["--version"], {
      encoding: "utf8",
    }).trim();
    const project = store.createProject({
      name: runtime,
      repo: "fixture/private",
    }).id;
    const model = runtime === "codex" ? "gpt-5.4" : "claude-sonnet-4-6";
    projectCliConfiguration(store.dbPath, project, {
      runtime,
      api_key: "fixture-key-no-account",
    });
    patchFeedbackAgent(store, project, {
      enabled: true,
      runtime,
      model,
      public_guide: guide,
    });
    let requests = 0;
    globalThis.fetch = async (url, init) => {
      if (url === `http://127.0.0.1:${port}/health`)
        return realFetch(url, init);
      assert.equal(
        url,
        runtime === "codex"
          ? "https://api.openai.com/v1/responses"
          : "https://api.anthropic.com/v1/messages",
      );
      assert.equal(init.redirect, "error");
      const body = JSON.parse(init.body);
      assert.equal(body.model, model);
      assert(!("tools" in body));
      const prompt =
        runtime === "codex"
          ? body.input[0].content[0].text
          : body.messages[0].content;
      assert.equal(body.instructions ?? body.system, systemPrompt);
      assert(!prompt.includes("@/etc"));
      assert(!prompt.includes("fixture/private"));
      assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf("{"))), {
        public_guide: guide,
        messages,
        attachment_count: 1,
      });
      requests++;
      const text = JSON.stringify(result);
      return Response.json(
        runtime === "codex"
          ? {
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text }],
                },
              ],
            }
          : {
              type: "message",
              role: "assistant",
              stop_reason: "end_turn",
              content: [{ type: "text", text }],
            },
      );
    };
    assert(await feedbackAgentAvailable(store, project));
    assert.deepEqual(
      await diagnoseFeedback(
        store,
        project,
        { messages, images: ["https://unreachable.invalid/attachment.png"] },
        AbortSignal.timeout(25000),
      ),
      { outcome: result.outcome, reply: result.reply },
    );
    assert.equal(requests, 1);
    assert.equal(store.listTasks(project).length, 0);
    console.log(
      `${version}: project → authenticated runner → real CLI → offline text-only provider → diagnosis OK`,
    );
  }
} finally {
  globalThis.fetch = realFetch;
  await new Promise((r) => runner.close(r));
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
