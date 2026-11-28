// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../app/components/Icon.tsx", () => ({
  Icon: ({ name }: { name: string }) => createElement("span", { "data-icon": name }),
}));

import { ChatWorkspaceImage } from "../app/components/ChatWorkspaceImage.tsx";

const url = "/api/projects/demo/workspace/file?path=demo.png&inline=1";
let root: ReturnType<typeof createRoot>, el: HTMLElement;
const image = () => el.querySelector("img");
const render = (streaming: boolean, src = url) => act(() => root.render(createElement(ChatWorkspaceImage, { url: src, alt: "demo", className: "", streaming })));
const fail = () => act(() => { image()!.dispatchEvent(new Event("error")); });
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); el = document.createElement("main"); root = createRoot(el); });
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("bounds polling, then reloads the original image after the streaming turn ends", () => {
  render(true);
  for (const delay of [1200, 3000, 8000]) {
    fail(); expect(el.textContent).toContain("尚未就绪");
    act(() => { vi.advanceTimersByTime(delay); });
    expect(image()?.src).toContain("preview_retry=");
  }
  fail(); act(() => { vi.advanceTimersByTime(60_000); }); expect(image()).toBeNull();
  render(false); expect(image()?.src).toContain("preview_retry=4");
  expect(el.querySelector("a")?.getAttribute("href")).toBe(url);
  fail(); expect(el.textContent).toContain("未能加载");
  act(() => el.querySelector("button")!.click()); expect(image()).not.toBeNull();
});

it("never polls remote images", () => {
  render(true, "https://example.invalid/demo.png"); fail();
  act(() => { vi.advanceTimersByTime(60_000); });
  render(false, "https://example.invalid/demo.png"); expect(image()).toBeNull();
});

it("opens in-page lightbox on plain left-click and preserves modifier new-tab click", () => {
  render(false);
  const anchor = el.querySelector("a")!;
  expect(anchor.getAttribute("href")).toBe(url);

  const metaEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
  act(() => { anchor.dispatchEvent(metaEvent); });
  expect(metaEvent.defaultPrevented).toBe(false);
  expect(document.body.querySelector('[role="dialog"][aria-label="图片预览"]')).toBeNull();

  const plainEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  act(() => { anchor.dispatchEvent(plainEvent); });
  expect(plainEvent.defaultPrevented).toBe(true);
  const dialog = document.body.querySelector('[role="dialog"][aria-label="图片预览"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.querySelector("img")?.getAttribute("src")).toBe(url);

  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(document.body.querySelector('[role="dialog"][aria-label="图片预览"]')).toBeNull();
});
