// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
