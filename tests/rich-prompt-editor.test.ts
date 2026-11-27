// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RichPromptEditor } from "../app/components/agent-chat/RichPromptEditor.tsx";
import { MOBILE_COMPOSER_MEDIA_QUERY } from "../app/lib/mobile-input.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../app/components/Icon.tsx", () => ({ Icon: () => null }));

function dispatchInput(el: HTMLElement) {
  el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
}

function dispatchKey(
  el: HTMLElement,
  key: string,
  opts: Partial<KeyboardEventInit> = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key === "Enter" ? "Enter" : key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  el.dispatchEvent(event);
  return event;
}

function dispatchShiftEnter(el: HTMLElement) {
  return dispatchKey(el, "Enter", { shiftKey: true });
}

function dispatchEnter(el: HTMLElement, opts: Partial<KeyboardEventInit> = {}) {
  return dispatchKey(el, "Enter", { shiftKey: false, ...opts });
}

function dispatchPasteText(el: HTMLElement, text: string) {
  const clipboardData = {
    getData: (type: string) => (type === "text/plain" ? text : ""),
    items: [],
    files: [],
  };
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  el.dispatchEvent(event);
  return event;
}

function placeCaretAtEnd(node: Node) {
  const sel = window.getSelection()!;
  const range = document.createRange();
  if (node.nodeType === Node.TEXT_NODE) {
    range.setStart(node, (node as Text).data.length);
  } else {
    range.selectNodeContents(node);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtStart(node: Node) {
  const sel = window.getSelection()!;
  const range = document.createRange();
  if (node.nodeType === Node.TEXT_NODE) {
    range.setStart(node, 0);
  } else if (node.firstChild && node.firstChild.nodeType === Node.TEXT_NODE) {
    range.setStart(node.firstChild, 0);
  } else {
    range.setStart(node, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function setMobileMediaMatch(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === MOBILE_COMPOSER_MEDIA_QUERY ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe("RichPromptEditor markdown, mobile behavior & keyboard ergonomics", () => {
  let root: Root;

  beforeEach(() => {
    setMobileMediaMatch(false);
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("auto-creates a code block immediately upon typing triple backticks on empty or inline text", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const tb = document.querySelector('[role="textbox"]') as HTMLDivElement;
    const textNode = document.createTextNode("```");
    tb.appendChild(textNode);
    placeCaretAtEnd(textNode);

    act(() => {
      dispatchInput(tb);
    });

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(document.activeElement).toBe(textarea);
    expect(tb.textContent).toBe("");
    expect(onChange).toHaveBeenLastCalledWith("```\n\n```");

    // Inline prose followed immediately by ``` also converts cleanly
    act(() => {
      root.unmount();
    });
    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    root = createRoot(host2);
    const onChange2 = vi.fn();

    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "",
          placeholder: "prompt",
          onChange: onChange2,
          onSubmit: vi.fn(),
        }),
      );
    });
    const tb2 = document.querySelector('[role="textbox"]') as HTMLDivElement;
    const inlineNode = document.createTextNode("看看这个```");
    tb2.appendChild(inlineNode);
    placeCaretAtEnd(inlineNode);

    act(() => {
      dispatchInput(tb2);
    });

    expect(document.querySelectorAll("textarea")).toHaveLength(1);
    expect(tb2.textContent).toBe("看看这个");
    expect(onChange2).toHaveBeenLastCalledWith("看看这个\n```\n\n```");
  });

  it("promotes language typed on the first line + Enter into the code block language badge", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "```\n\n```",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    // Controlled update simulation: user types "ts" then hits Enter
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "```\nts\n```",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;

    act(() => {
      const ev = dispatchEnter(ta);
      expect(ev.defaultPrevented).toBe(true);
    });

    const langInput = document.querySelector('input[aria-label="代码块语言"]') as HTMLInputElement;
    expect(langInput.value).toBe("ts");
    expect(ta.value).toBe("");
    expect(onChange).toHaveBeenLastCalledWith("```ts\n\n```");
  });

  it("inserts a visible sentinel line break on first Shift+Enter even with trailing empty text node", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const tb = document.querySelector('[role="textbox"]') as HTMLDivElement;
    const helloNode = document.createTextNode("hello");
    const emptyTrailing = document.createTextNode("");
    tb.appendChild(helloNode);
    tb.appendChild(emptyTrailing);
    placeCaretAtEnd(helloNode);

    act(() => {
      const ev = dispatchShiftEnter(tb);
      expect(ev.defaultPrevented).toBe(true);
    });

    const lines = Array.from(tb.querySelectorAll('div[data-rd-line="true"]'));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toBe("hello");
    expect(lines[1]!.querySelectorAll('br[data-rd-sentinel="true"]')).toHaveLength(1);
    expect(onChange).toHaveBeenLastCalledWith("hello\n");

    // Typing after Shift+Enter cleans stale sentinel so no phantom trailing newline remains
    const sel = window.getSelection()!;
    const r = sel.getRangeAt(0);
    const worldNode = document.createTextNode("world");
    r.insertNode(worldNode);
    placeCaretAtEnd(worldNode);
    act(() => {
      dispatchInput(tb);
    });

    expect(tb.querySelectorAll('br[data-rd-sentinel="true"]')).toHaveLength(0);
    expect(onChange).toHaveBeenLastCalledWith("hello\nworld");
  });

  it("supports two consecutive Shift+Enter presses cleanly", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const tb = document.querySelector('[role="textbox"]') as HTMLDivElement;
    const helloNode = document.createTextNode("hello");
    tb.appendChild(helloNode);
    placeCaretAtEnd(helloNode);

    act(() => {
      dispatchShiftEnter(tb);
    });
    expect(onChange).toHaveBeenLastCalledWith("hello\n");

    act(() => {
      dispatchShiftEnter(tb);
    });
    expect(onChange).toHaveBeenLastCalledWith("hello\n\n");
    const lines = Array.from(tb.querySelectorAll('div[data-rd-line="true"]'));
    expect(lines).toHaveLength(3);
    expect(lines[1]!.querySelectorAll('br[data-rd-sentinel="true"]')).toHaveLength(1);
    expect(lines[2]!.querySelectorAll('br[data-rd-sentinel="true"]')).toHaveLength(1);
  });

  it("exits an inline code pill cleanly before inserting newline on Shift+Enter", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "`foo`",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const tb = document.querySelector('[role="textbox"]') as HTMLDivElement;
    const codeEl = tb.querySelector("code[data-inline-code='true']") as HTMLElement;
    expect(codeEl).not.toBeNull();
    placeCaretAtEnd(codeEl.firstChild!);

    act(() => {
      dispatchShiftEnter(tb);
    });

    expect(codeEl.querySelector("br")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith("`foo`\n");
  });

  it("inserts newline on Enter and disables Cmd/Ctrl+Enter submit on mobile devices, while desktop Enter still submits", () => {
    // Desktop: Enter submits and enterKeyHint is "send"
    const onDesktopSubmit = vi.fn();
    const onDesktopChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "hello",
          placeholder: "prompt",
          onChange: onDesktopChange,
          onSubmit: onDesktopSubmit,
        }),
      );
    });

    const desktopTb = document.querySelector('[role="textbox"]') as HTMLDivElement;
    expect(desktopTb.getAttribute("enterkeyhint")).toBe("send");
    placeCaretAtEnd(desktopTb.querySelector('div[data-rd-line="true"]')!.firstChild!);
    act(() => {
      dispatchEnter(desktopTb);
    });
    expect(onDesktopSubmit).toHaveBeenCalledTimes(1);

    // Mobile: Enter inserts newline, Cmd/Ctrl+Enter in prose and CodeSegmentCard does not submit, enterKeyHint is "enter"
    setMobileMediaMatch(true);
    act(() => {
      root.unmount();
    });
    const hostMobile = document.createElement("div");
    document.body.appendChild(hostMobile);
    root = createRoot(hostMobile);

    const onMobileSubmit = vi.fn();
    const onMobileChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "hello\n```ts\nconst a = 1;\n```",
          placeholder: "prompt",
          onChange: onMobileChange,
          onSubmit: onMobileSubmit,
        }),
      );
    });

    const mobileTb = document.querySelector('[role="textbox"]') as HTMLDivElement;
    expect(mobileTb.getAttribute("enterkeyhint")).toBe("enter");
    const line0 = mobileTb.querySelector('div[data-rd-line="true"]')!;
    placeCaretAtEnd(line0.firstChild!);

    act(() => {
      const ev = dispatchEnter(mobileTb);
      expect(ev.defaultPrevented).toBe(true);
    });
    expect(onMobileSubmit).not.toHaveBeenCalled();
    expect(onMobileChange).toHaveBeenLastCalledWith("hello\n\n```ts\nconst a = 1;\n```");

    act(() => {
      dispatchEnter(mobileTb, { metaKey: true });
      dispatchEnter(mobileTb, { ctrlKey: true });
    });
    expect(onMobileSubmit).not.toHaveBeenCalled();

    const codeTa = document.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      dispatchEnter(codeTa, { metaKey: true });
      dispatchEnter(codeTa, { ctrlKey: true });
    });
    expect(onMobileSubmit).not.toHaveBeenCalled();
  });

  it("converts line blocks live (including NBSP space) and ignores non-trigger prefixes", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const tb = document.querySelector('[role="textbox"]') as HTMLDivElement;

    // Quote with NBSP space
    const nbspQuote = document.createTextNode(">\u00A0");
    tb.appendChild(nbspQuote);
    placeCaretAtEnd(nbspQuote);
    act(() => {
      dispatchInput(tb);
    });
    let line0 = tb.querySelector('div[data-rd-line="true"]') as HTMLElement;
    expect(line0.dataset.rdBlock).toBe("quote");
    expect(line0.dataset.rdDepth).toBe("1");
    expect(onChange).toHaveBeenLastCalledWith("> ");

    // Nest quote further by typing "> " at start of existing quote
    const nestedNode = document.createTextNode("> ");
    line0.insertBefore(nestedNode, line0.firstChild);
    placeCaretAtEnd(nestedNode);
    act(() => {
      dispatchInput(tb);
    });
    expect(line0.dataset.rdBlock).toBe("quote");
    expect(line0.dataset.rdDepth).toBe("2");
    expect(onChange).toHaveBeenLastCalledWith(">> ");

    // Unordered list -> Task upgrade with "[ ] "
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "plain",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });
    const tbUl = document.querySelector('[role="textbox"]') as HTMLDivElement;
    line0 = tbUl.querySelector('div[data-rd-line="true"]') as HTMLElement;
    line0.textContent = "- ";
    placeCaretAtEnd(line0.firstChild!);
    act(() => {
      dispatchInput(tbUl);
    });
    expect(line0.dataset.rdBlock).toBe("ul");
    expect(onChange).toHaveBeenLastCalledWith("- ");

    const taskCheckNode = document.createTextNode("[ ] ");
    line0.insertBefore(taskCheckNode, line0.firstChild);
    placeCaretAtEnd(taskCheckNode);
    act(() => {
      dispatchInput(tbUl);
    });
    expect(line0.dataset.rdBlock).toBe("task");
    expect(line0.dataset.rdChecked).toBe("false");
    expect(onChange).toHaveBeenLastCalledWith("- [ ] ");

    // Non-trigger prefixes stay plain paragraphs
    for (const raw of [">", ">= 10", "-10", "1.5", "#tag"]) {
      act(() => {
        root.render(
          createElement(RichPromptEditor, {
            value: `reset-${raw}`,
            placeholder: "prompt",
            onChange,
            onSubmit: vi.fn(),
          }),
        );
      });
      const tbPlain = document.querySelector('[role="textbox"]') as HTMLDivElement;
      const pLine = tbPlain.querySelector('div[data-rd-line="true"]') as HTMLElement;
      pLine.textContent = raw;
      placeCaretAtEnd(pLine.firstChild!);
      act(() => {
        dispatchInput(tbPlain);
      });
      expect(pLine.dataset.rdBlock).toBe("p");
    }
  });

  it("renders headings, ordered lists, continues lists/quotes, auto-renumbers, and exits on double Enter", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "### 标题\n1. 第一项\n2. 第二项",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const tb = document.querySelector('[role="textbox"]') as HTMLDivElement;
    const lines = () => Array.from(tb.querySelectorAll('div[data-rd-line="true"]')) as HTMLElement[];

    expect(lines()[0]!.dataset.rdBlock).toBe("h");
    expect(lines()[0]!.dataset.rdLevel).toBe("3");
    expect(lines()[1]!.dataset.rdBlock).toBe("ol");
    expect(lines()[1]!.dataset.rdOrder).toBe("1");
    expect(lines()[2]!.dataset.rdBlock).toBe("ol");
    expect(lines()[2]!.dataset.rdOrder).toBe("2");

    // Shift+Enter inside item 1 inserts a new item 2 and renumbers old item 2 -> 3
    placeCaretAtEnd(lines()[1]!.firstChild!);
    act(() => {
      dispatchShiftEnter(tb);
    });
    expect(lines()).toHaveLength(4);
    expect(lines()[1]!.dataset.rdOrder).toBe("1");
    expect(lines()[2]!.dataset.rdBlock).toBe("ol");
    expect(lines()[2]!.dataset.rdOrder).toBe("2");
    expect(lines()[3]!.dataset.rdOrder).toBe("3");
    expect(onChange).toHaveBeenLastCalledWith("### 标题\n1. 第一项\n2. \n3. 第二项");

    // Second Shift+Enter on the empty item 2 exits list to a plain paragraph and renumbers remaining item -> 2
    act(() => {
      dispatchShiftEnter(tb);
    });
    expect(lines()[2]!.dataset.rdBlock).toBe("p");
    expect(lines()[3]!.dataset.rdBlock).toBe("ol");
    expect(lines()[3]!.dataset.rdOrder).toBe("2");
    expect(onChange).toHaveBeenLastCalledWith("### 标题\n1. 第一项\n\n2. 第二项");
  });

  it("toggles task checkboxes when clicking the left gutter and ignores clicks on text", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "- [ ] 补齐测试",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const tb = document.querySelector('[role="textbox"]') as HTMLDivElement;
    const taskLine = tb.querySelector('div[data-rd-line="true"]') as HTMLElement;

    // Click on text (outside gutter) should NOT toggle
    act(() => {
      taskLine.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 60 }));
    });
    expect(taskLine.dataset.rdChecked).toBe("false");
    expect(onChange).not.toHaveBeenCalled();

    // Click inside left gutter toggles to checked
    act(() => {
      taskLine.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 10 }));
    });
    expect(taskLine.dataset.rdChecked).toBe("true");
    expect(onChange).toHaveBeenLastCalledWith("- [x] 补齐测试");

    // Click again toggles back to unchecked
    act(() => {
      taskLine.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 10 }));
    });
    expect(taskLine.dataset.rdChecked).toBe("false");
    expect(onChange).toHaveBeenLastCalledWith("- [ ] 补齐测试");
  });

  it("supports Tab/Shift+Tab list indentation and Backspace unwrap/merge at offset 0", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "1. 第一\n2. 第二\n3. 第三",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const tb = document.querySelector('[role="textbox"]') as HTMLDivElement;
    const lines = () => Array.from(tb.querySelectorAll('div[data-rd-line="true"]')) as HTMLElement[];

    // Tab on item 2 indents it to nested 1. and renumbers item 3 -> 2.
    placeCaretAtStart(lines()[1]!);
    act(() => {
      dispatchKey(tb, "Tab");
    });
    expect(lines()[1]!.dataset.rdIndent).toBe("1");
    expect(lines()[1]!.dataset.rdOrder).toBe("1");
    expect(lines()[2]!.dataset.rdOrder).toBe("2");
    expect(onChange).toHaveBeenLastCalledWith("1. 第一\n  1. 第二\n2. 第三");

    // Backspace at offset 0 outdents back to indent 0 and renumbers
    placeCaretAtStart(lines()[1]!);
    act(() => {
      dispatchKey(tb, "Backspace");
    });
    expect(lines()[1]!.dataset.rdIndent).toBe("0");
    expect(lines()[1]!.dataset.rdOrder).toBe("2");
    expect(lines()[2]!.dataset.rdOrder).toBe("3");

    // Another Backspace at offset 0 unwraps item 2 into plain paragraph
    placeCaretAtStart(lines()[1]!);
    act(() => {
      dispatchKey(tb, "Backspace");
    });
    expect(lines()[1]!.dataset.rdBlock).toBe("p");
    expect(lines()[2]!.dataset.rdOrder).toBe("1");
    expect(onChange).toHaveBeenLastCalledWith("1. 第一\n第二\n1. 第三");

    // Backspace at offset 0 of plain paragraph merges into previous line
    placeCaretAtStart(lines()[1]!);
    act(() => {
      dispatchKey(tb, "Backspace");
    });
    expect(lines()).toHaveLength(2);
    expect(onChange).toHaveBeenLastCalledWith("1. 第一第二\n2. 第三");
  });

  it("auto-converts inline bold, italic, strike, and code while guarding partial bold & math multiplication", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const tb = document.querySelector('[role="textbox"]') as HTMLDivElement;

    // Partial bold "**bold*" must NOT convert to italic
    const partialBold = document.createTextNode("**bold*");
    tb.appendChild(partialBold);
    placeCaretAtEnd(partialBold);
    act(() => {
      dispatchInput(tb);
    });
    expect(tb.querySelector("em")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith("**bold*");

    // Complete **bold**
    partialBold.data = "**bold**";
    placeCaretAtEnd(partialBold);
    act(() => {
      dispatchInput(tb);
    });
    expect(tb.querySelector("strong[data-inline-bold='true']")?.textContent).toBe("bold");
    expect(onChange).toHaveBeenLastCalledWith("**bold**");

    // Math 2*3*4 stays plain text
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "init",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });
    const tbInline = document.querySelector('[role="textbox"]') as HTMLDivElement;
    const line0 = tbInline.querySelector('div[data-rd-line="true"]')!;
    line0.textContent = "2*3*4";
    placeCaretAtEnd(line0.firstChild!);
    act(() => {
      dispatchInput(tbInline);
    });
    expect(tbInline.querySelector("em")).toBeNull();

    // Standalone *italic* and ~~strike~~
    line0.textContent = "hello *italic*";
    placeCaretAtEnd(line0.firstChild!);
    act(() => {
      dispatchInput(tbInline);
    });
    expect(tbInline.querySelector("em[data-inline-italic='true']")?.textContent).toBe("italic");
    expect(onChange).toHaveBeenLastCalledWith("hello *italic*");

    const strikeTail = document.createTextNode(" and ~~old~~");
    line0.appendChild(strikeTail);
    placeCaretAtEnd(strikeTail);
    act(() => {
      dispatchInput(tbInline);
    });
    expect(tbInline.querySelector("del[data-inline-strike='true']")?.textContent).toBe("old");
    expect(onChange).toHaveBeenLastCalledWith("hello *italic* and ~~old~~");
  });

  it("renders multi-line pasted Markdown blocks and round-trips losslessly", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(RichPromptEditor, {
          value: "",
          placeholder: "prompt",
          onChange,
          onSubmit: vi.fn(),
        }),
      );
    });

    const tb = document.querySelector('[role="textbox"]') as HTMLDivElement;
    placeCaretAtStart(tb);

    const pasted = [
      "# 周报",
      "> 核心结论",
      "- 无序项",
      "1. 第一步",
      "2. 第二步",
      "- [x] 已完成 **加粗** 与 *斜体* 与 ~~删除~~ 和 `code`",
    ].join("\n");

    act(() => {
      dispatchPasteText(tb, pasted);
    });

    const lines = Array.from(tb.querySelectorAll('div[data-rd-line="true"]')) as HTMLElement[];
    expect(lines).toHaveLength(6);
    expect(lines[0]!.dataset.rdBlock).toBe("h");
    expect(lines[1]!.dataset.rdBlock).toBe("quote");
    expect(lines[2]!.dataset.rdBlock).toBe("ul");
    expect(lines[3]!.dataset.rdBlock).toBe("ol");
    expect(lines[4]!.dataset.rdBlock).toBe("ol");
    expect(lines[5]!.dataset.rdBlock).toBe("task");
    expect(lines[5]!.dataset.rdChecked).toBe("true");
    expect(lines[5]!.querySelector("strong")?.textContent).toBe("加粗");
    expect(lines[5]!.querySelector("em")?.textContent).toBe("斜体");
    expect(lines[5]!.querySelector("del")?.textContent).toBe("删除");
    expect(lines[5]!.querySelector("code")?.textContent).toBe("code");
    expect(onChange).toHaveBeenLastCalledWith(pasted);
  });
});
