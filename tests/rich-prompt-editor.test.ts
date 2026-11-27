// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RichPromptEditor } from "../app/components/agent-chat/RichPromptEditor.tsx";

vi.mock("../app/components/Icon.tsx", () => ({ Icon: () => null }));

function dispatchInput(el: HTMLElement) {
  el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
}

function dispatchShiftEnter(el: HTMLElement) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(event);
  return event;
}

function dispatchEnter(el: HTMLElement) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    shiftKey: false,
    bubbles: true,
    cancelable: true,
  });
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

describe("RichPromptEditor markdown & Shift+Enter", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
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

    const allBrs = Array.from(tb.querySelectorAll("br"));
    expect(allBrs).toHaveLength(2);
    expect(allBrs[0]!.dataset.rdSentinel).toBeUndefined();
    expect(allBrs[1]!.dataset.rdSentinel).toBe("true");
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
    expect(tb.querySelectorAll('br:not([data-rd-sentinel="true"])')).toHaveLength(2);
    expect(tb.querySelectorAll('br[data-rd-sentinel="true"]')).toHaveLength(1);
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
});
