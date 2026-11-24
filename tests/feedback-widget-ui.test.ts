// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

const source = readFileSync("public/widget.js", "utf8");
const task = {
  id: "ticket1",
  code: "RD-1",
  title: "保存按钮",
  owned: true,
  created_at: new Date().toISOString(),
  status_label: "等待补充信息",
  can_reply: true,
  can_request_deploy: false,
  can_accept: false,
};
function mount() {
  const script = document.createElement("script");
  script.src = "https://desk.example/widget.js";
  script.dataset.project = "demo";
  script.dataset.key = "public-intake";
  Object.defineProperty(document, "currentScript", {
    configurable: true,
    get: () => script,
  });
  Function(source)();
  if (!document.querySelector("[data-relaydesk-widget]"))
    document.dispatchEvent(new Event("DOMContentLoaded"));
  return document.querySelector("[data-relaydesk-widget]")!.shadowRoot!;
}
afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(document, "currentScript");
  localStorage.clear();
  vi.unstubAllGlobals();
});
it("loads local ticket status and sends a follow-up with a project-scoped visitor secret", async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit = {}) => {
      requests.push({ url, options });
      const json = url.endsWith("widget-config")
        ? {
            project_name: "Fixture",
            tracking_enabled: true,
            can_request_deploy: false,
            ai_enabled: false,
            upload_enabled: false,
          }
        : url.endsWith("/tasks")
          ? { tasks: [task] }
          : url.endsWith("/reply")
            ? {
                task: {
                  ...task,
                  status_label: "已提交，等待处理",
                  can_reply: false,
                },
                messages: [
                  {
                    id: 2,
                    author: "reporter",
                    body: "刷新后重现",
                    created_at: task.created_at,
                  },
                ],
                gate: null,
              }
            : {
                task,
                messages: [
                  {
                    id: 1,
                    author: "team",
                    body: "可以补充复现步骤吗？",
                    created_at: task.created_at,
                  },
                ],
                gate: null,
              };
      return Response.json(json);
    }),
  );
  const root = mount();
  const click = (s: string) =>
    root.querySelector<HTMLButtonElement>(s)!.click();
  click('[data-action="toggle"]');
  await vi.waitFor(() =>
    expect(root.querySelector<HTMLElement>('[data-role="tabs-wrap"]')?.hidden).toBe(false),
  );
  click('[data-tab="feedback"]');
  await vi.waitFor(() =>
    expect(root.querySelector("[data-open-feedback]")?.textContent).toContain(
      "保存按钮",
    ),
  );
  click("[data-open-feedback]");
  await vi.waitFor(() =>
    expect(root.querySelector('[data-fb-field="replyDraft"]')).not.toBeNull(),
  );
  const input = root.querySelector<HTMLTextAreaElement>(
    '[data-fb-field="replyDraft"]',
  )!;
  input.value = "刷新后重现";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  click('[data-action="fb-reply-submit"]');
  await vi.waitFor(() =>
    expect(requests.some((r) => r.url.endsWith("/reply"))).toBe(true),
  );
  const calls = requests.filter((r) => r.url.includes("/widget-feedback/"));
  const proofs = calls.map((r) =>
    new Headers(r.options.headers).get("x-visitor-id"),
  );
  expect(proofs[0]).toMatch(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/);
  expect(new Set(proofs).size).toBe(1);
  expect(calls.every((r) => !r.url.includes(proofs[0]!))).toBe(true);
  expect(calls.at(-1)?.options.body).toBe(
    JSON.stringify({ body: "刷新后重现" }),
  );
  expect(root.querySelector('[data-action="fb-deploy-open"]')).toBeNull();
  click('[data-action="toggle"]');
});

it.each(["older server", "no WebCrypto"])(
  "uses legacy intake when tracking is unavailable: %s",
  async (mode) => {
    if (mode === "no WebCrypto") vi.stubGlobal("crypto", {});
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return Response.json(
          url.endsWith("/widget-config")
            ? {
                ai_enabled: false,
                upload_enabled: false,
                ...(mode === "no WebCrypto" ? { tracking_enabled: true } : {}),
              }
            : { task_id: "legacy", number: 1 },
        );
      }),
    );
    const root = mount();
    const click = (s: string) =>
      root.querySelector<HTMLButtonElement>(s)!.click();
    click('[data-action="toggle"]');
    await vi.waitFor(() =>
      expect(urls.some((url) => url.endsWith("/widget-config"))).toBe(true),
    );
    expect(
      root.querySelector<HTMLElement>('[data-role="tabs-wrap"]')?.hidden,
    ).toBe(true);
    click('[data-action="quick-ticket"]');
    const input = root.querySelector<HTMLTextAreaElement>(
      '[data-ticket-field="summary"]',
    )!;
    input.value = "旧入口兼容测试";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    click("[data-submit-ticket]");
    await vi.waitFor(() =>
      expect(urls.some((url) => url.endsWith("/intake"))).toBe(true),
    );
    expect(urls.some((url) => url.includes("/widget-feedback/"))).toBe(false);
    expect(localStorage.getItem("relaydesk_widget_visitor_demo")).toBeNull();
    click('[data-action="toggle"]');
  },
);
