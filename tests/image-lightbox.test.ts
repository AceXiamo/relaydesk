// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/components/Icon.tsx", () => ({
  Icon: ({ name }: { name: string }) => createElement("span", { "data-icon": name }),
}));

import {
  ImageLightboxLink,
  ImageLightboxProvider,
  toImageDownloadUrl,
  toImageOpenUrl,
} from "../app/components/ImageLightbox.tsx";

describe("ImageLightbox utilities", () => {
  it("normalizes open and download URLs for workspace images and preserves external URLs", () => {
    const workspaceSrc = "/api/projects/p1/workspace/file?path=shot%201.png&inline=1&preview_retry=2";
    const openParsed = new URL(toImageOpenUrl(workspaceSrc), "http://localhost");
    expect(openParsed.pathname).toBe("/api/projects/p1/workspace/file");
    expect(openParsed.searchParams.get("path")).toBe("shot 1.png");
    expect(openParsed.searchParams.get("inline")).toBe("1");
    expect(openParsed.searchParams.has("preview_retry")).toBe(false);

    const downloadParsed = new URL(toImageDownloadUrl(workspaceSrc), "http://localhost");
    expect(downloadParsed.pathname).toBe("/api/projects/p1/workspace/file");
    expect(downloadParsed.searchParams.get("path")).toBe("shot 1.png");
    expect(downloadParsed.searchParams.get("download")).toBe("1");
    expect(downloadParsed.searchParams.has("inline")).toBe(false);
    expect(downloadParsed.searchParams.has("preview_retry")).toBe(false);

    const external = "https://cdn.example.invalid/img.png?preview_retry=2";
    expect(toImageOpenUrl(external)).toBe(external);
    expect(toImageDownloadUrl(external)).toBe(external);
  });
});

describe("ImageLightboxProvider and ImageLightboxLink", () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.style.overflow = "";
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

  function getDialog(): HTMLElement | null {
    return document.body.querySelector('[role="dialog"][aria-label="图片预览"]');
  }

  it("opens modal on plain left-click with download & open links and keeps modifier clicks native", () => {
    const src = "/api/projects/p1/workspace/file?path=demo.png&inline=1&preview_retry=1";
    const openUrl = "/api/projects/p1/workspace/file?path=demo.png&inline=1";
    act(() => {
      root.render(
        createElement(
          ImageLightboxProvider,
          null,
          createElement(
            ImageLightboxLink,
            { src, openUrl, alt: "测试截图" },
            createElement("img", { src, alt: "测试截图" }),
          ),
        ),
      );
    });

    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(openUrl);

    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }] as const) {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...mod });
      act(() => { link.dispatchEvent(ev); });
      expect(ev.defaultPrevented).toBe(false);
      expect(getDialog()).toBeNull();
    }

    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => { link.dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(true);

    const dialog = getDialog();
    expect(dialog).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");
    expect(dialog?.querySelector("img")?.getAttribute("src")).toBe(src);
    expect(dialog?.querySelector('a[aria-label="下载图片"]')?.getAttribute("href")).toBe(
      "/api/projects/p1/workspace/file?path=demo.png&download=1",
    );
    const externalBtn = dialog?.querySelector('a[aria-label="新标签打开"]');
    expect(externalBtn?.getAttribute("href")).toBe(openUrl);
    expect(externalBtn?.getAttribute("target")).toBe("_blank");
  });

  it("closes via close button and backdrop click and restores body overflow", () => {
    const src = "/api/projects/p1/workspace/file?path=a.png&inline=1";
    act(() => {
      root.render(
        createElement(
          ImageLightboxProvider,
          null,
          createElement(
            ImageLightboxLink,
            { src, alt: "图 A" },
            createElement("img", { src, alt: "图 A" }),
          ),
        ),
      );
    });

    const link = container.querySelector("a")!;
    act(() => { link.click(); });
    expect(getDialog()).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");

    const closeBtn = getDialog()!.querySelector<HTMLButtonElement>('button[aria-label="关闭图片预览"]')!;
    act(() => { closeBtn.click(); });
    expect(getDialog()).toBeNull();
    expect(document.body.style.overflow).toBe("");

    act(() => { link.click(); });
    expect(getDialog()).not.toBeNull();

    const stage = getDialog()!.querySelector<HTMLElement>('[data-testid="lightbox-stage"]')!;
    act(() => { stage.click(); });
    expect(getDialog()).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("intercepts Escape in capture phase without leaking to underlying bubble listeners", () => {
    const bubbleEscapeSpy = vi.fn();
    const onBubbleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") bubbleEscapeSpy();
    };
    window.addEventListener("keydown", onBubbleKeyDown);

    try {
      const src = "/api/projects/p1/workspace/file?path=escape.png&inline=1";
      act(() => {
        root.render(
          createElement(
            ImageLightboxProvider,
            null,
            createElement(
              ImageLightboxLink,
              { src, alt: "Esc 测试" },
              createElement("img", { src, alt: "Esc 测试" }),
            ),
          ),
        );
      });

      act(() => { container.querySelector("a")!.click(); });
      expect(getDialog()).not.toBeNull();

      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(getDialog()).toBeNull();
      expect(bubbleEscapeSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onBubbleKeyDown);
    }
  });

  it("navigates scoped gallery images with buttons and arrow keys and resets zoom per image", () => {
    const images = [
      { src: "/api/projects/p1/workspace/file?path=1.png&inline=1", alt: "第一张" },
      { src: "/api/projects/p1/workspace/file?path=2.png&inline=1", alt: "第二张" },
      { src: "/api/projects/p1/workspace/file?path=3.png&inline=1", alt: "第三张" },
    ];

    act(() => {
      root.render(
        createElement(
          ImageLightboxProvider,
          null,
          createElement(
            "div",
            { "data-rd-lightbox-scope": "chat-thread" },
            ...images.map((item) =>
              createElement(
                ImageLightboxLink,
                { key: item.src, src: item.src, alt: item.alt },
                createElement("img", { src: item.src, alt: item.alt }),
              ),
            ),
          ),
        ),
      );
    });

    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(3);
    act(() => { links[0]!.click(); });

    const dialog = getDialog()!;
    const counter = () => dialog.querySelector('[data-testid="lightbox-counter"]')?.textContent;
    const prevBtn = () => dialog.querySelector<HTMLButtonElement>('button[aria-label="上一张"]')!;
    const nextBtn = () => dialog.querySelector<HTMLButtonElement>('button[aria-label="下一张"]')!;
    const zoomResetBtn = () => dialog.querySelector<HTMLButtonElement>('button[aria-label="重置缩放"]')!;
    const zoomInBtn = () => dialog.querySelector<HTMLButtonElement>('button[aria-label="放大"]')!;
    const zoomOutBtn = () => dialog.querySelector<HTMLButtonElement>('button[aria-label="缩小"]')!;

    expect(counter()).toBe("1 / 3");
    expect(prevBtn().disabled).toBe(true);
    expect(nextBtn().disabled).toBe(false);
    expect(zoomResetBtn().textContent).toBe("适应");

    act(() => { zoomInBtn().click(); });
    expect(zoomResetBtn().textContent).toBe("125%");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true }));
    });
    expect(zoomResetBtn().textContent).toBe("150%");

    // Switching image resets zoom to fit ("适应")
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(counter()).toBe("2 / 3");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(images[1]!.src);
    expect(prevBtn().disabled).toBe(false);
    expect(nextBtn().disabled).toBe(false);
    expect(zoomResetBtn().textContent).toBe("适应");

    act(() => { nextBtn().click(); });
    expect(counter()).toBe("3 / 3");
    expect(nextBtn().disabled).toBe(true);

    // Zoom out to minimum disables zoom-out button, key "0" resets
    act(() => { zoomOutBtn().click(); });
    expect(zoomResetBtn().textContent).toBe("75%");
    act(() => { zoomOutBtn().click(); });
    expect(zoomResetBtn().textContent).toBe("50%");
    expect(zoomOutBtn().disabled).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true, cancelable: true }));
    });
    expect(zoomResetBtn().textContent).toBe("适应");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    expect(counter()).toBe("2 / 3");
    act(() => { prevBtn().click(); });
    expect(counter()).toBe("1 / 3");
  });
});
