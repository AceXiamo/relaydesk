// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("../app/components/Icon.tsx", () => ({
  Icon: ({ name }: { name: string }) => createElement("span", { "data-icon": name }),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: mermaidMocks.initialize,
    render: mermaidMocks.render,
  },
}));

import { MarkdownContent, hasMarkdownSyntax } from "../app/components/MarkdownContent.tsx";
import {
  analyzeHastTable,
  computeVisualWidth,
  serializeTableToCsv,
  serializeTableToMarkdown,
} from "../app/components/MarkdownTableCard.tsx";
import { detectMermaidType } from "../app/components/MermaidDiagramCard.tsx";

describe("MarkdownTableCard helpers", () => {
  it("computes visual width weighting CJK wider than ASCII", () => {
    expect(computeVisualWidth("-123.854s")).toBe(9);
    expect(computeVisualWidth("说明")).toBeCloseTo(3.6, 5);
  });

  it("serializes table headers and rows to Markdown and CSV with escaping", () => {
    const headers = ["分镜", "差额", "说明"];
    const rows = [["A | B", "-123.854s", '包含"引号", 逗号']];
    expect(serializeTableToMarkdown(headers, rows)).toBe(
      '| 分镜 | 差额 | 说明 |\n| --- | --- | --- |\n| A \\| B | -123.854s | 包含"引号", 逗号 |',
    );
    expect(serializeTableToCsv(headers, rows)).toBe(
      '\uFEFF分镜,差额,说明\r\nA | B,-123.854s,"包含""引号"", 逗号"',
    );
  });

  it("classifies compact numeric columns vs wide prose columns", () => {
    const analysis = analyzeHastTable({
      type: "element",
      tagName: "table",
      children: [
        {
          type: "element",
          tagName: "thead",
          children: [
            {
              type: "element",
              tagName: "tr",
              children: [
                { type: "element", tagName: "th", children: [{ type: "text", value: "分镜" }] },
                { type: "element", tagName: "th", children: [{ type: "text", value: "差额" }] },
                { type: "element", tagName: "th", children: [{ type: "text", value: "说明" }] },
              ],
            },
          ],
        },
        {
          type: "element",
          tagName: "tbody",
          children: [
            {
              type: "element",
              tagName: "tr",
              children: [
                { type: "element", tagName: "td", children: [{ type: "text", value: "1" }] },
                { type: "element", tagName: "td", children: [{ type: "text", value: "-123.854s" }] },
                {
                  type: "element",
                  tagName: "td",
                  children: [
                    {
                      type: "text",
                      value:
                        "批量点通过时先点了新版 v5，1 秒后又点了旧版 v4，系统把旧版 30s 当成了最终版",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(analysis.rowCount).toBe(1);
    expect(analysis.colCount).toBe(3);
    expect(analysis.colHints).toEqual(["compact", "compact", "wide"]);
  });
});

describe("Mermaid diagram detection", () => {
  it("recognizes gantt and other diagram types even with init directives", () => {
    expect(detectMermaidType("gantt\n  title 发布排期")).toEqual({
      label: "甘特图",
      icon: "chart-gantt",
    });
    expect(
      detectMermaidType("%%{init: {'theme': 'base'}}%%\n%% comment\nflowchart LR\nA-->B"),
    ).toEqual({
      label: "流程图",
      icon: "workflow",
    });
    expect(detectMermaidType("sequenceDiagram\nA->>B: Hi")).toEqual({
      label: "时序图",
      icon: "workflow",
    });
    expect(detectMermaidType("erDiagram\nUSER ||--o{ TASK : owns")).toEqual({
      label: "ER 图",
      icon: "database",
    });
  });
});

describe("MarkdownContent rendering, zoom modals, and extensions", () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.style.overflow = "";
    mermaidMocks.initialize.mockReset();
    mermaidMocks.render.mockReset();
    mermaidMocks.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 220"><text x="20" y="30">Gantt</text></svg>',
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.style.overflow = "";
    vi.unstubAllGlobals();
  });

  function renderMd(content: string, extra?: { streaming?: boolean; compact?: boolean; preserveLineBreaks?: boolean }) {
    act(() => {
      root.render(
        createElement(MarkdownContent, {
          content,
          ...extra,
        }),
      );
    });
  }

  it("renders wide Chinese tables without squishing compact numeric columns or long explanation columns", () => {
    const md = [
      "| 分镜 | 已通过版本（按版本顺序） | 实际点「通过」时间顺序（北京时间） | 最新版时长 | 审片净推送给制片 | 差额 | 说明 |",
      "| :--- | :--- | :--- | ---: | ---: | ---: | :--- |",
      "| 1 | `v2` 422.28s -> `v4` 30.05s -> `v5` 153.90s | 11-17 点 `v2` (`+422.279`) -> 11-26 15:06:44 点 `v5` (`-268.377`) -> 1 秒后 15:06:45 点旧版 `v4` (`-123.854`) | 153.902s | 30.048s | -123.854s | 批量点通过时先点了新版 `v5`，1 秒后又点了旧版 `v4`，系统把旧版 30s 当成了最终版 |",
      "| 2 | `v1` 14.05s -> `v2` 226.51s | 11-25 15:33 先点新版 `v2` (`+226.511`) -> 次日 11-26 15:06:43 补点旧版 `v1` (`-212.463`) | 226.511s | 14.048s | -212.463s | 新版 `v2` 被旧版 `v1` 覆盖，需重推终版 |",
    ].join("\n");

    renderMd(md);

    expect(container.textContent).toContain("2 行 × 7 列");

    const table = container.querySelector("table.rd-md-table")!;
    expect(table).not.toBeNull();

    const ths = Array.from(table.querySelectorAll("thead th"));
    expect(ths[3]?.className).toContain("text-right");
    expect(ths[5]?.className).toContain("text-right");

    const firstRowTds = Array.from(table.querySelectorAll("tbody tr:first-child td"));
    expect(firstRowTds[0]?.className).toContain("whitespace-nowrap");
    expect(firstRowTds[3]?.className).toContain("whitespace-nowrap");
    expect(firstRowTds[5]?.className).toContain("whitespace-nowrap");
    expect(firstRowTds[5]?.className).toContain("text-right");

    const explainCell = firstRowTds[6]?.querySelector(".rd-md-cell");
    expect(explainCell?.className).toContain("rd-md-cell-lg");

    const v5Code = Array.from(firstRowTds[6]!.querySelectorAll("code")).find(
      (c) => c.textContent === "v5",
    );
    expect(v5Code?.className).toContain("whitespace-nowrap");
  });

  it("opens table zoom modal, scales text, and isolates Escape in capture phase", () => {
    const bubbleEscapeSpy = vi.fn();
    const onBubbleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") bubbleEscapeSpy();
    };
    window.addEventListener("keydown", onBubbleEscape);

    try {
      renderMd("| 指标 | 值 |\n| --- | --- |\n| 延迟 | 12ms |");

      const expandBtn = container.querySelector<HTMLButtonElement>(
        'button[aria-label="放大表格"]',
      )!;
      act(() => {
        expandBtn.click();
      });

      const dialog = document.body.querySelector<HTMLElement>(
        '[role="dialog"][aria-label="表格全览"]',
      );
      expect(dialog).not.toBeNull();
      expect(document.body.style.overflow).toBe("hidden");
      expect(dialog?.querySelector("table.rd-md-table-expanded")).not.toBeNull();

      const resetBtn = dialog!.querySelector<HTMLButtonElement>(
        'button[aria-label="重置缩放"]',
      )!;
      const zoomInBtn = dialog!.querySelector<HTMLButtonElement>(
        'button[aria-label="放大"]',
      )!;
      expect(resetBtn.textContent).toBe("100%");
      act(() => {
        zoomInBtn.click();
      });
      expect(resetBtn.textContent).toBe("115%");

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "0", bubbles: true, cancelable: true }),
        );
      });
      expect(resetBtn.textContent).toBe("100%");

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      expect(
        document.body.querySelector('[role="dialog"][aria-label="表格全览"]'),
      ).toBeNull();
      expect(document.body.style.overflow).toBe("");
      expect(bubbleEscapeSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onBubbleEscape);
    }
  });

  it("renders Mermaid Gantt diagrams, supports source toggle and DiagramLightboxModal, and handles streaming/errors", async () => {
    const ganttMd = [
      "```mermaid",
      "gantt",
      "  title 发布排期",
      "  dateFormat YYYY-MM-DD",
      "  section 前端",
      "  表格优化 :a1, 2026-11-28, 2d",
      "```",
    ].join("\n");

    renderMd(ganttMd);
    expect(container.textContent).toContain("Mermaid · 甘特图");

    await vi.waitFor(() => {
      expect(mermaidMocks.initialize).toHaveBeenCalled();
      expect(mermaidMocks.render).toHaveBeenCalled();
      expect(container.querySelector('[data-testid="mermaid-svg-stage"] svg')).not.toBeNull();
    });

    // Toggle source view and back
    const toggleBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("源码"),
    )!;
    act(() => {
      toggleBtn.click();
    });
    expect(container.querySelector('[data-testid="mermaid-svg-stage"]')).toBeNull();
    expect(container.textContent).toContain("title 发布排期");

    act(() => {
      toggleBtn.click();
    });
    expect(container.querySelector('[data-testid="mermaid-svg-stage"] svg')).not.toBeNull();

    // Open DiagramLightboxModal
    const zoomBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="放大图表"]',
    )!;
    act(() => {
      zoomBtn.click();
    });
    const dialog = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Mermaid · 甘特图"]',
    );
    expect(dialog).not.toBeNull();

    act(() => {
      dialog!.querySelector<HTMLButtonElement>('button[aria-label="放大图表"]')?.click();
    });
    expect(
      dialog!.querySelector('button[aria-label="重置缩放"]')?.textContent,
    ).toBe("125%");

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(
      document.body.querySelector('[role="dialog"][aria-label="Mermaid · 甘特图"]'),
    ).toBeNull();

    // Streaming incomplete syntax stays calm with no error banner
    vi.useFakeTimers();
    try {
      mermaidMocks.render.mockRejectedValueOnce(new Error("Parse error"));
      renderMd("```mermaid\ngantt\n  title 流式生成中", { streaming: true });
      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });
      expect(container.textContent).toContain("正在生成图表");
      expect(container.textContent).not.toContain("图表语法未能渲染");
    } finally {
      vi.useRealTimers();
    }

    // Completed invalid diagram shows subtle fallback notice
    mermaidMocks.render.mockRejectedValueOnce(new Error("Bad gantt syntax"));
    renderMd("```mermaid\ngantt\n  broken ::::", { streaming: false });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("图表语法未能渲染，已回退源码视图");
    });
  });

  it("renders KaTeX math while protecting currency expressions", () => {
    const md = [
      "行内公式 $E = mc^2$，以及货币预算 $50 到 $100 和区间 $10-$20。",
      "",
      "$$",
      "\\sum_{i=1}^{n} x_i",
      "$$",
    ].join("\n");

    renderMd(md);

    const katexEls = container.querySelectorAll(".katex");
    expect(katexEls.length).toBe(2);
    expect(container.textContent).toContain("预算 $50 到 $100");
    expect(container.textContent).toContain("$10-$20");
    expect(hasMarkdownSyntax("$$\nx^2\n$$")).toBe(true);
  });

  it("renders GitHub Alerts, syntax-highlighted code with modal, task lists, footnotes, safe HTML, and strips XSS", () => {
    const md = [
      "> [!WARNING]",
      "> 这里是一条需要注意的提示。",
      "",
      "> 普通引用段落。",
      "",
      "```ts",
      "const count: number = 42;",
      "```",
      "",
      "- [x] 已完成事项",
      "- [ ] 待办事项",
      "",
      "支持脚注引用[^1]与安全 HTML：<details><summary>展开详情</summary>隐藏正文</details> <kbd>Esc</kbd> <mark>高亮</mark> H<sub>2</sub>O x<sup>2</sup>。",
      "",
      '<script>alert("xss")</script><img src="https://example.invalid/x.png" onerror="alert(1)"><iframe src="https://evil.invalid"></iframe>[恶意链接](javascript:alert(1))',
      "",
      "[^1]: 脚注说明内容。",
    ].join("\n");

    renderMd(md);

    const alertBox = container.querySelector('[data-rd-alert="warning"]');
    expect(alertBox).not.toBeNull();
    expect(alertBox?.textContent).toContain("注意");
    expect(alertBox?.textContent).toContain("这里是一条需要注意的提示");
    expect(container.querySelector("blockquote")?.textContent).toContain("普通引用段落");

    // Syntax highlighting + code expand modal
    expect(container.querySelector("pre code.hljs")).not.toBeNull();
    expect(container.querySelector("pre code .hljs-keyword")?.textContent).toBe("const");

    const codeExpandBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="放大代码块"]',
    )!;
    act(() => {
      codeExpandBtn.click();
    });
    const codeModal = document.body.querySelector('[role="dialog"][aria-label="代码 · ts"]');
    expect(codeModal).not.toBeNull();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    // Task list preserved through rehype-raw + rehype-sanitize
    const taskItems = container.querySelectorAll("li.task-list-item");
    expect(taskItems).toHaveLength(2);
    expect(taskItems[0]?.getAttribute("data-checked")).toBe("true");
    expect(taskItems[1]?.getAttribute("data-checked")).toBe("false");

    // Footnote anchor stays in-page (no target=_blank)
    const footnoteSection = container.querySelector("section.footnotes");
    expect(footnoteSection).not.toBeNull();
    const fnLink = container.querySelector<HTMLAnchorElement>('a[href^="#user-content-fn"]');
    expect(fnLink).not.toBeNull();
    expect(fnLink?.getAttribute("target")).toBeNull();

    // Safe HTML tags preserved
    expect(container.querySelector("details summary")?.textContent).toBe("展开详情");
    expect(container.querySelector("kbd.rd-kbd")?.textContent).toBe("Esc");
    expect(container.querySelector("mark")?.textContent).toBe("高亮");
    expect(container.querySelector("sub")?.textContent).toBe("2");
    expect(Array.from(container.querySelectorAll("sup")).map((el) => el.textContent)).toEqual([
      "1",
      "2",
    ]);

    // XSS payloads neutralized
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    const imgs = Array.from(container.querySelectorAll("img"));
    for (const img of imgs) {
      expect(img.getAttribute("onerror")).toBeNull();
    }
    const badJsLinks = Array.from(container.querySelectorAll("a")).filter((a) =>
      (a.getAttribute("href") ?? "").toLowerCase().startsWith("javascript:"),
    );
    expect(badJsLinks).toHaveLength(0);
    expect(container.textContent).toContain("恶意链接");
  });
});
