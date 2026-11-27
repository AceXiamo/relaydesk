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

it("runs multi-turn diagnose (clarify -> usage -> suspected_bug) and only creates a task after explicit confirm", async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  let diagnoseTurn = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit = {}) => {
      requests.push({ url, options });
      if (url.endsWith("/widget-config")) {
        return Response.json({
          project_name: "DemoApp",
          tracking_enabled: true,
          agent_enabled: true,
          can_request_deploy: false,
          upload_enabled: true,
        });
      }
      if (url.endsWith("/widget-feedback/tasks") && (!options.method || options.method === "GET")) {
        return Response.json({ tasks: [] });
      }
      if (url.endsWith("/widget-feedback/diagnose")) {
        diagnoseTurn += 1;
        if (diagnoseTurn === 1) {
          return Response.json({
            reply: "请问你在哪个页面点击了导出按钮？有具体报错提示吗？",
            outcome: "clarify",
          });
        }
        if (diagnoseTurn === 2) {
          return Response.json({
            reply: "CSV 导出需要先勾选至少一行记录，按此操作即可正常导出。",
            outcome: "usage",
          });
        }
        return Response.json({
          reply: "勾选记录后仍返回 500 属于疑似功能故障，已为你整理可编辑工单草案。",
          outcome: "suspected_bug",
          draft: {
            title: "账单页导出 CSV 返回 500",
            body: "在账单页勾选 3 条记录后点击导出 CSV，接口返回 500。",
          },
        });
      }
      if (url.endsWith("/widget-feedback/tasks") && options.method === "POST") {
        return Response.json({
          task: {
            ...task,
            id: "created-1",
            code: "RD-99",
            title: "账单页导出 CSV 返回 500（已核对）",
          },
        });
      }
      return Response.json({});
    }),
  );

  const root = mount();
  const click = (s: string) => root.querySelector<HTMLButtonElement>(s)!.click();
  const sendText = (text: string) => {
    const input = root.querySelector<HTMLTextAreaElement>('[data-role="input"]')!;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    click('[data-action="send"]');
  };

  click('[data-action="toggle"]');
  await vi.waitFor(() =>
    expect(requests.some((r) => r.url.endsWith("/widget-config"))).toBe(true),
  );

  // Turn 1: clarify -> no ticket draft
  sendText("导出按钮点不了");
  await vi.waitFor(() =>
    expect(root.querySelector('[data-outcome="clarify"]')).not.toBeNull(),
  );
  expect(root.querySelector('[data-ticket-id]')).toBeNull();

  // Turn 2: usage -> no ticket draft, 0 POST /tasks
  sendText("在账单页没有勾选任何记录直接点导出");
  await vi.waitFor(() =>
    expect(root.querySelector('[data-outcome="usage"]')).not.toBeNull(),
  );
  expect(root.querySelector('[data-ticket-id]')).toBeNull();

  // Turn 3: suspected_bug -> editable draft appears, still 0 POST /tasks until explicit confirm
  sendText("我勾选了 3 条记录再点导出还是报错 500");
  await vi.waitFor(() =>
    expect(root.querySelector('[data-outcome="suspected_bug"]')).not.toBeNull(),
  );
  const titleInput = root.querySelector<HTMLInputElement>('[data-ticket-field="title"]')!;
  const summaryInput = root.querySelector<HTMLTextAreaElement>('[data-ticket-field="summary"]')!;
  expect(titleInput.value).toBe("账单页导出 CSV 返回 500");
  expect(summaryInput.value).toContain("接口返回 500");
  expect(
    requests.filter((r) => r.url.endsWith("/widget-feedback/tasks") && r.options.method === "POST"),
  ).toHaveLength(0);
  expect(requests.some((r) => r.url.endsWith("/chat"))).toBe(false);

  // Edit draft and explicitly confirm
  titleInput.value = "账单页导出 CSV 返回 500（已核对）";
  titleInput.dispatchEvent(new Event("input", { bubbles: true }));
  click("[data-submit-ticket]");

  await vi.waitFor(() =>
    expect(
      requests.filter((r) => r.url.endsWith("/widget-feedback/tasks") && r.options.method === "POST"),
    ).toHaveLength(1),
  );
  const diagnoseReqs = requests.filter((r) => r.url.endsWith("/widget-feedback/diagnose"));
  expect(diagnoseReqs).toHaveLength(3);
  for (const req of diagnoseReqs) {
    const h = new Headers(req.options.headers);
    expect(h.get("authorization")).toBe("Bearer public-intake");
    expect(h.get("x-visitor-id")).toMatch(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/);
  }
  const createCall = requests.find(
    (r) => r.url.endsWith("/widget-feedback/tasks") && r.options.method === "POST",
  )!;
  expect(JSON.parse(String(createCall.options.body)).title).toBe(
    "账单页导出 CSV 返回 500（已核对）",
  );
});

it("recovers from diagnose failure via retry and merges consecutive user turns on follow-up", async () => {
  const diagnoseBodies: Array<{ messages: Array<{ role: string; text: string }> }> = [];
  let attempt = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit = {}) => {
      if (url.endsWith("/widget-config")) {
        return Response.json({
          project_name: "DemoApp",
          tracking_enabled: true,
          agent_enabled: true,
          upload_enabled: false,
        });
      }
      if (url.endsWith("/widget-feedback/tasks")) {
        return Response.json({ tasks: [] });
      }
      if (url.endsWith("/widget-feedback/diagnose")) {
        diagnoseBodies.push(JSON.parse(String(options.body)));
        attempt += 1;
        if (attempt === 1) {
          return Response.json(
            { error: "安全反馈执行器暂不可用，请稍后重试。" },
            { status: 503 },
          );
        }
        if (attempt === 2) {
          return Response.json({ error: "上游超时" }, { status: 502 });
        }
        return Response.json({
          reply: "收到两条补充信息，请确认你的账号角色。",
          outcome: "clarify",
        });
      }
      return Response.json({});
    }),
  );

  const root = mount();
  const click = (s: string) => root.querySelector<HTMLButtonElement>(s)!.click();
  const sendText = (text: string) => {
    const input = root.querySelector<HTMLTextAreaElement>('[data-role="input"]')!;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    click('[data-action="send"]');
  };

  click('[data-action="toggle"]');
  await vi.waitFor(() =>
    expect(root.querySelector('[data-role="subtitle"]')?.textContent).toContain("先诊断问题"),
  );

  // Attempt 1 fails -> inline recovery card renders
  sendText("点击保存没有反应");
  await vi.waitFor(() =>
    expect(root.querySelector('[data-role="diagnose-error"]')?.textContent).toContain(
      "安全反馈执行器暂不可用",
    ),
  );

  // Attempt 2 via retry button -> does not duplicate user message
  click('[data-action="retry-diagnose"]');
  await vi.waitFor(() =>
    expect(root.querySelector('[data-role="diagnose-error"]')?.textContent).toContain("上游超时"),
  );
  expect(diagnoseBodies[1]?.messages).toEqual([{ role: "user", text: "点击保存没有反应" }]);

  // Attempt 3 via sending a new follow-up message after failure -> consecutive user messages merged!
  sendText("控制台报 403 权限不足");
  await vi.waitFor(() =>
    expect(root.querySelector('[data-outcome="clarify"]')).not.toBeNull(),
  );
  expect(diagnoseBodies[2]?.messages).toEqual([
    { role: "user", text: "点击保存没有反应\n\n控制台报 403 权限不足" },
  ]);
});

it("falls back honestly to manual ticket card when agent_enabled is false", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url);
      if (url.endsWith("/widget-config")) {
        return Response.json({
          project_name: "ManualOnly",
          tracking_enabled: true,
          agent_enabled: false,
          ai_enabled: false,
          upload_enabled: false,
        });
      }
      return Response.json({ tasks: [] });
    }),
  );

  const root = mount();
  const click = (s: string) => root.querySelector<HTMLButtonElement>(s)!.click();
  click('[data-action="toggle"]');
  await vi.waitFor(() =>
    expect(requests.some((u) => u.endsWith("/widget-config"))).toBe(true),
  );

  const input = root.querySelector<HTMLTextAreaElement>('[data-role="input"]')!;
  input.value = "关闭代理时直接填写反馈";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  click('[data-action="send"]');

  await vi.waitFor(() =>
    expect(root.querySelector('[data-draft-source="manual"]')).not.toBeNull(),
  );
  expect(requests.some((u) => u.includes("/diagnose"))).toBe(false);
  expect(requests.some((u) => u.endsWith("/chat"))).toBe(false);
  const summary = root.querySelector<HTMLTextAreaElement>('[data-ticket-field="summary"]')!;
  expect(summary.value).toContain("关闭代理时直接填写反馈");
});

it("streams SSE status and delta frames into the assistant bubble before rendering final outcome", async () => {
  const encoder = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit = {}) => {
      if (url.endsWith("/widget-config")) {
        return Response.json({
          project_name: "StreamApp",
          tracking_enabled: true,
          agent_enabled: true,
          agent_available: true,
          upload_enabled: false,
        });
      }
      if (url.endsWith("/widget-feedback/tasks")) {
        return Response.json({ tasks: [] });
      }
      if (url.endsWith("/widget-feedback/diagnose")) {
        const accept = new Headers(options.headers).get("accept") || "";
        expect(accept).toContain("text/event-stream");
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('event: status\ndata: {"label":"正在读取项目实现…"}\n\n'),
            );
            controller.enqueue(
              encoder.encode('event: delta\ndata: {"text":"先确认你的角色权限，"}\n\n'),
            );
            controller.enqueue(
              encoder.encode('event: delta\ndata: {"text":"开启编辑权限即可保存。"}\n\n'),
            );
            controller.enqueue(
              encoder.encode(
                'event: done\ndata: {"reply":"先确认你的角色权限，开启编辑权限即可保存。","outcome":"usage"}\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json({});
    }),
  );

  const root = mount();
  const click = (s: string) => root.querySelector<HTMLButtonElement>(s)!.click();
  click('[data-action="toggle"]');
  await vi.waitFor(() =>
    expect(root.querySelector('[data-role="subtitle"]')?.textContent).toContain("先诊断问题"),
  );

  const input = root.querySelector<HTMLTextAreaElement>('[data-role="input"]')!;
  input.value = "保存按钮是灰色的";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  click('[data-action="send"]');

  await vi.waitFor(() =>
    expect(root.querySelector('[data-outcome="usage"]')).not.toBeNull(),
  );
  expect(root.textContent).toContain("先确认你的角色权限，开启编辑权限即可保存。");
  expect(root.querySelector("[data-ticket-id]")).toBeNull();
});

it("shows honest offline state and avoids calling diagnose when local node is offline", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url);
      if (url.endsWith("/widget-config")) {
        return Response.json({
          project_name: "OfflineApp",
          tracking_enabled: true,
          agent_enabled: true,
          agent_available: false,
          upload_enabled: false,
        });
      }
      return Response.json({ tasks: [] });
    }),
  );

  const root = mount();
  const click = (s: string) => root.querySelector<HTMLButtonElement>(s)!.click();
  click('[data-action="toggle"]');
  await vi.waitFor(() =>
    expect(root.querySelector('[data-role="subtitle"]')?.textContent).toContain("诊断助手离线"),
  );

  const input = root.querySelector<HTMLTextAreaElement>('[data-role="input"]')!;
  input.value = "节点离线时尝试发送";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  click('[data-action="send"]');

  await vi.waitFor(() =>
    expect(root.querySelector('[data-draft-source="manual"]')).not.toBeNull(),
  );
  expect(requests.some((u) => u.includes("/diagnose"))).toBe(false);
  expect(root.textContent).toContain("离线");
});

it("disables Enter-to-send on mobile devices in widget composer while preserving desktop Enter submit", async () => {
  const stubMedia = (isMobile: boolean) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: isMobile && query.includes("max-width: 639.98px"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  };

  let diagnoseCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/widget-config")) {
        return Response.json({
          project_name: "MobileDemo",
          tracking_enabled: true,
          agent_enabled: true,
          agent_available: true,
          upload_enabled: false,
        });
      }
      if (url.endsWith("/widget-feedback/diagnose")) {
        diagnoseCalls += 1;
        return new Response('event: done\ndata: {"reply":"ok","outcome":"usage"}\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json({ tasks: [] });
    }),
  );

  stubMedia(true);
  const root = mount();
  root.querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();
  await vi.waitFor(() =>
    expect(root.querySelector('[data-role="input"]')).not.toBeNull(),
  );
  const input = root.querySelector<HTMLTextAreaElement>('[data-role="input"]')!;
  expect(input.getAttribute("enterkeyhint")).toBe("enter");

  input.value = "移动端换行测试";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const mobileEv = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  input.dispatchEvent(mobileEv);
  expect(mobileEv.defaultPrevented).toBe(false);
  expect(diagnoseCalls).toBe(0);

  // Switch to desktop media and verify Enter submits
  stubMedia(false);
  input.dispatchEvent(new Event("focus"));
  expect(input.getAttribute("enterkeyhint")).toBe("send");
  const desktopEv = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  input.dispatchEvent(desktopEv);
  expect(desktopEv.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(diagnoseCalls).toBe(1));
});
