/* RelayDesk AI Support & Feedback Widget (Conversational Agent + Webpage Screenshot + R2 Uploads).
 * Usage: <script defer src="https://your-relaydesk/widget.js" data-project="..." data-key="..." data-theme="auto|light|dark"></script>
 */
(() => {
  "use strict";
  const script = document.currentScript;
  if (!script?.src || !script.dataset.project || !script.dataset.key) return;
  if (document.querySelector("[data-relaydesk-widget]")) return;

  const project = script.dataset.project;
  const origin = new URL(script.src).origin;
  const baseUrl = origin + "/api/projects/" + encodeURIComponent(project);
  const configEndpoint = baseUrl + "/widget-config";
  const chatEndpoint = baseUrl + "/chat";
  const uploadEndpoint = baseUrl + "/uploads";
  const intakeEndpoint = baseUrl + "/intake";
  const captureLibUrl = origin + "/widget-capture.js";
  const ASSET_VER = "2";
  const ASSETS = {
    logo: origin + "/widget/logo.webp?v=" + ASSET_VER,
    heroDark: origin + "/widget/hero-dark.webp?v=" + ASSET_VER,
    heroLight: origin + "/widget/hero-light.webp?v=" + ASSET_VER,
    bug: origin + "/widget/illus-bug.webp?v=" + ASSET_VER,
    guide: origin + "/widget/illus-guide.webp?v=" + ASSET_VER,
    idea: origin + "/widget/illus-idea.webp?v=" + ASSET_VER,
    success: origin + "/widget/illus-success.webp?v=" + ASSET_VER,
  };
  const key = script.dataset.key;
  const rawTheme = (script.dataset.theme || "auto").trim().toLowerCase();
  const theme =
    rawTheme === "light" || rawTheme === "dark" || rawTheme === "auto"
      ? rawTheme
      : "auto";

  const MAX_CHARS = 2000;
  const MAX_ATTACHMENTS = 4;
  const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
  const KINDS = [
    { id: "功能异常", label: "功能异常", tone: "bug" },
    { id: "改进建议", label: "改进建议", tone: "idea" },
    { id: "使用疑问", label: "使用疑问", tone: "question" },
  ];

  const STARTERS = [
    {
      kind: "功能异常",
      tone: "bug",
      title: "遇到报错或异常",
      desc: "描述现象或截屏，帮你定位原因并整理 Bug 工单",
      prompt: "我在这个页面遇到了一个异常：",
      img: ASSETS.bug,
      alt: "排查异常",
    },
    {
      kind: "使用疑问",
      tone: "question",
      title: "这个功能怎么用？",
      desc: "直接提问，AI 会结合项目文档与实现即时解答",
      prompt: "请问这个功能应该怎么使用或配置：",
      img: ASSETS.guide,
      alt: "使用指南",
    },
    {
      kind: "改进建议",
      tone: "idea",
      title: "提个改进建议",
      desc: "分享你的想法或痛点，快速进入产品迭代队列",
      prompt: "我希望产品可以增加或优化这个功能：",
      img: ASSETS.idea,
      alt: "产品建议",
    },
  ];

  const ICONS = {
    chevronRight:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    chat:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>',
    close:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    send:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
    stop:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
    crop:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
    image:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
    ticket:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>',
    refresh:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
    spinner:
      '<svg aria-hidden="true" class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    check:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    copy:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    link:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    rect:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/></svg>',
    arrow:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>',
    pen:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>',
    mosaic:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    undo:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>',
    monitor:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>',
    alert:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
  };

  function uid() {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      return Array.from(crypto.getRandomValues(new Uint8Array(10)), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join("");
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function formatTicketCode(num) {
    if (num === undefined || num === null || num === "") return "";
    return "RD-" + String(num).padStart(3, "0");
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function stripLeakedToolMarkup(raw) {
    return String(raw ?? "")
      .replace(
        /[<＜]\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:function_calls|calls|invoke)[\s\S]*?(?:[<＜]\/\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:function_calls|calls)\s*[>＞]|$)/gi,
        "",
      )
      .replace(/<(?:function_calls|tool_calls?)\b[\s\S]*?(?:<\/(?:function_calls|tool_calls?)\s*>|$)/gi, "");
  }

  function renderMarkdownLite(md) {
    const src = stripLeakedToolMarkup(md).replace(/\r\n/g, "\n");
    if (!src.trim()) return "";
    const codeBlocks = [];
    let working = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || "", code: code.replace(/\n$/, "") });
      return `\u0000CODEBLOCK_${idx}\u0000`;
    });

    const formatInline = (text) => {
      const inlineCodes = [];
      let s = escapeHtml(text);
      s = s.replace(/`([^`\n]+)`/g, (_, code) => {
        const idx = inlineCodes.length;
        inlineCodes.push(code);
        return `\u0000INLINECODE_${idx}\u0000`;
      });
      s = s.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      );
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      s = s.replace(/\u0000INLINECODE_(\d+)\u0000/g, (_, idx) => `<code>${inlineCodes[Number(idx)]}</code>`);
      return s;
    };

    const lines = working.split("\n");
    const out = [];
    let inUl = false;
    let inOl = false;

    const closeLists = () => {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      const cbMatch = line.trim().match(/^\u0000CODEBLOCK_(\d+)\u0000$/);
      if (cbMatch) {
        closeLists();
        const block = codeBlocks[Number(cbMatch[1])];
        out.push(`<pre><code>${escapeHtml(block.code)}</code></pre>`);
        continue;
      }
      if (!line.trim()) {
        closeLists();
        continue;
      }
      if (/^\s*[-*_]{3,}\s*$/.test(line)) {
        closeLists();
        out.push("<hr />");
        continue;
      }
      const hMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (hMatch) {
        closeLists();
        const level = Math.min(hMatch[1].length + 2, 5);
        out.push(`<h${level}>${formatInline(hMatch[2])}</h${level}>`);
        continue;
      }
      const bqMatch = line.match(/^\s*>\s?(.*)$/);
      if (bqMatch) {
        closeLists();
        out.push(`<blockquote>${formatInline(bqMatch[1])}</blockquote>`);
        continue;
      }
      const ulMatch = line.match(/^(\s*)[-*•]\s+(.+)$/);
      if (ulMatch) {
        if (inOl) {
          out.push("</ol>");
          inOl = false;
        }
        if (!inUl) {
          out.push("<ul>");
          inUl = true;
        }
        const nested = ulMatch[1].length >= 2 ? ' class="is-nested"' : "";
        out.push(`<li${nested}>${formatInline(ulMatch[2])}</li>`);
        continue;
      }
      const olMatch = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
      if (olMatch) {
        if (inUl) {
          out.push("</ul>");
          inUl = false;
        }
        if (!inOl) {
          out.push("<ol>");
          inOl = true;
        }
        const nested = olMatch[1].length >= 2 ? ' class="is-nested"' : "";
        out.push(`<li${nested}>${formatInline(olMatch[2])}</li>`);
        continue;
      }
      closeLists();
      out.push(`<p>${formatInline(line)}</p>`);
    }
    closeLists();
    return out.join("");
  }

  let captureLibPromise = null;
  function loadCaptureLib() {
    if (window.modernScreenshot?.domToCanvas) {
      return Promise.resolve(window.modernScreenshot);
    }
    if (!captureLibPromise) {
      captureLibPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = captureLibUrl;
        s.async = true;
        s.crossOrigin = "anonymous";
        s.onload = () => {
          if (window.modernScreenshot?.domToCanvas) {
            resolve(window.modernScreenshot);
          } else {
            captureLibPromise = null;
            reject(new Error("截屏引擎加载异常"));
          }
        };
        s.onerror = () => {
          captureLibPromise = null;
          reject(new Error("无法加载截屏组件"));
        };
        document.head.appendChild(s);
      });
    }
    return captureLibPromise;
  }

  function canvasToCompressedBlob(canvas) {
    return new Promise((resolve, reject) => {
      const maxDim = 1920;
      let target = canvas;
      if (canvas.width > maxDim || canvas.height > maxDim) {
        const ratio = Math.min(maxDim / canvas.width, maxDim / canvas.height);
        const scaled = document.createElement("canvas");
        scaled.width = Math.max(1, Math.round(canvas.width * ratio));
        scaled.height = Math.max(1, Math.round(canvas.height * ratio));
        const sctx = scaled.getContext("2d");
        if (sctx) {
          sctx.imageSmoothingEnabled = true;
          sctx.imageSmoothingQuality = "high";
          sctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
          target = scaled;
        }
      }
      target.toBlob(
        (blob) => {
          if (blob && blob.type === "image/webp" && blob.size <= MAX_UPLOAD_BYTES) {
            resolve(blob);
            return;
          }
          target.toBlob(
            (pngBlob) => {
              if (!pngBlob) {
                reject(new Error("导出截图失败"));
                return;
              }
              resolve(pngBlob);
            },
            "image/png",
          );
        },
        "image/webp",
        0.86,
      );
    });
  }

  function mount() {
    const host = document.createElement("div");
    host.setAttribute("data-relaydesk-widget", "");
    host.setAttribute("data-theme", theme);
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: auto 20px 20px auto;
          z-index: 2147483645;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
          font-size: 13.5px;
          line-height: 1.5;
          -webkit-font-smoothing: antialiased;
          color-scheme: light;

          --rd-bg: rgba(255, 255, 255, 0.97);
          --rd-header-bg: rgba(255, 255, 255, 0.88);
          --rd-hero-bg: #edeef4;
          --rd-surface: #f5f6f9;
          --rd-surface-2: #eceef4;
          --rd-surface-hover: #e8ebf2;
          --rd-card-bg: #ffffff;
          --rd-input-bg: #ffffff;
          --rd-border: rgba(17, 20, 28, 0.085);
          --rd-border-strong: rgba(17, 20, 28, 0.16);
          --rd-text: #14161d;
          --rd-text-secondary: #4b5060;
          --rd-text-muted: #767c8e;
          --rd-accent: #e54d26;
          --rd-accent-2: #ff7043;
          --rd-accent-hover: #cf411c;
          --rd-accent-soft: rgba(229, 77, 38, 0.10);
          --rd-accent-border: rgba(229, 77, 38, 0.24);
          --rd-accent-text: #c93d18;
          --rd-user-bg: linear-gradient(135deg, #ed5730 0%, #d9431d 100%);
          --rd-user-text: #ffffff;
          --rd-primary-bg: #14161d;
          --rd-primary-hover: #232734;
          --rd-primary-text: #ffffff;
          --rd-success: #059669;
          --rd-success-soft: rgba(16, 185, 129, 0.09);
          --rd-danger: #dc2626;
          --rd-danger-bg: rgba(220, 38, 38, 0.07);
          --rd-danger-border: rgba(220, 38, 38, 0.22);
          --rd-bug-bg: rgba(242, 92, 54, 0.10);
          --rd-bug-ring: rgba(242, 92, 54, 0.22);
          --rd-bug-fg: #dc4520;
          --rd-idea-bg: rgba(245, 158, 11, 0.12);
          --rd-idea-ring: rgba(245, 158, 11, 0.24);
          --rd-idea-fg: #c27803;
          --rd-question-bg: rgba(14, 165, 233, 0.10);
          --rd-question-ring: rgba(14, 165, 233, 0.22);
          --rd-question-fg: #0284c7;
          --rd-shadow: 0 28px 70px -16px rgba(15, 18, 28, 0.24), 0 6px 20px -4px rgba(15, 18, 28, 0.08);
          --rd-toggle-shadow: 0 12px 30px -6px rgba(15, 18, 28, 0.34), 0 2px 8px rgba(15, 18, 28, 0.14);
        }

        :host([data-theme="dark"]) {
          color-scheme: dark;
          --rd-bg: rgba(16, 18, 25, 0.97);
          --rd-header-bg: rgba(18, 21, 29, 0.90);
          --rd-hero-bg: #0f121a;
          --rd-surface: rgba(255, 255, 255, 0.045);
          --rd-surface-2: rgba(255, 255, 255, 0.075);
          --rd-surface-hover: rgba(255, 255, 255, 0.10);
          --rd-card-bg: rgba(255, 255, 255, 0.038);
          --rd-input-bg: rgba(10, 12, 17, 0.84);
          --rd-border: rgba(255, 255, 255, 0.09);
          --rd-border-strong: rgba(255, 255, 255, 0.17);
          --rd-text: #f4f4f6;
          --rd-text-secondary: #a4a9b8;
          --rd-text-muted: #72788a;
          --rd-accent: #f25c36;
          --rd-accent-2: #ff7e52;
          --rd-accent-hover: #ff6e48;
          --rd-accent-soft: rgba(242, 92, 54, 0.15);
          --rd-accent-border: rgba(242, 92, 54, 0.34);
          --rd-accent-text: #ff9472;
          --rd-user-bg: linear-gradient(135deg, #f25c36 0%, #d94620 100%);
          --rd-user-text: #ffffff;
          --rd-primary-bg: #181b25;
          --rd-primary-hover: #222634;
          --rd-primary-text: #f7f6f2;
          --rd-success: #34d399;
          --rd-success-soft: rgba(52, 211, 153, 0.11);
          --rd-danger: #f87171;
          --rd-danger-bg: rgba(248, 113, 113, 0.12);
          --rd-danger-border: rgba(248, 113, 113, 0.28);
          --rd-bug-bg: rgba(242, 92, 54, 0.14);
          --rd-bug-ring: rgba(242, 92, 54, 0.28);
          --rd-bug-fg: #ff8c6b;
          --rd-idea-bg: rgba(245, 158, 11, 0.14);
          --rd-idea-ring: rgba(245, 158, 11, 0.26);
          --rd-idea-fg: #fbbf24;
          --rd-question-bg: rgba(56, 189, 248, 0.14);
          --rd-question-ring: rgba(56, 189, 248, 0.26);
          --rd-question-fg: #38bdf8;
          --rd-shadow: 0 32px 84px -14px rgba(0, 0, 0, 0.80), 0 0 0 1px rgba(255, 255, 255, 0.06) inset;
          --rd-toggle-shadow: 0 14px 36px -6px rgba(0, 0, 0, 0.70), 0 0 0 1px rgba(255, 255, 255, 0.12);
        }

        @media (prefers-color-scheme: dark) {
          :host([data-theme="auto"]) {
            color-scheme: dark;
            --rd-bg: rgba(16, 18, 25, 0.97);
            --rd-header-bg: rgba(18, 21, 29, 0.90);
            --rd-hero-bg: #0f121a;
            --rd-surface: rgba(255, 255, 255, 0.045);
            --rd-surface-2: rgba(255, 255, 255, 0.075);
            --rd-surface-hover: rgba(255, 255, 255, 0.10);
            --rd-card-bg: rgba(255, 255, 255, 0.038);
            --rd-input-bg: rgba(10, 12, 17, 0.84);
            --rd-border: rgba(255, 255, 255, 0.09);
            --rd-border-strong: rgba(255, 255, 255, 0.17);
            --rd-text: #f4f4f6;
            --rd-text-secondary: #a4a9b8;
            --rd-text-muted: #72788a;
            --rd-accent: #f25c36;
            --rd-accent-2: #ff7e52;
            --rd-accent-hover: #ff6e48;
            --rd-accent-soft: rgba(242, 92, 54, 0.15);
            --rd-accent-border: rgba(242, 92, 54, 0.34);
            --rd-accent-text: #ff9472;
            --rd-user-bg: linear-gradient(135deg, #f25c36 0%, #d94620 100%);
            --rd-user-text: #ffffff;
            --rd-primary-bg: #181b25;
            --rd-primary-hover: #222634;
            --rd-primary-text: #f7f6f2;
            --rd-success: #34d399;
            --rd-success-soft: rgba(52, 211, 153, 0.11);
            --rd-danger: #f87171;
            --rd-danger-bg: rgba(248, 113, 113, 0.12);
            --rd-danger-border: rgba(248, 113, 113, 0.28);
            --rd-bug-bg: rgba(242, 92, 54, 0.14);
            --rd-bug-ring: rgba(242, 92, 54, 0.28);
            --rd-bug-fg: #ff8c6b;
            --rd-idea-bg: rgba(245, 158, 11, 0.14);
            --rd-idea-ring: rgba(245, 158, 11, 0.26);
            --rd-idea-fg: #fbbf24;
            --rd-question-bg: rgba(56, 189, 248, 0.14);
            --rd-question-ring: rgba(56, 189, 248, 0.26);
            --rd-question-fg: #38bdf8;
            --rd-shadow: 0 32px 84px -14px rgba(0, 0, 0, 0.80), 0 0 0 1px rgba(255, 255, 255, 0.06) inset;
            --rd-toggle-shadow: 0 14px 36px -6px rgba(0, 0, 0, 0.70), 0 0 0 1px rgba(255, 255, 255, 0.12);
          }
        }

        .hero-art-dark { display: none; }
        .hero-art-light { display: block; }
        :host([data-theme="dark"]) .hero-art-dark { display: block; }
        :host([data-theme="dark"]) .hero-art-light { display: none; }
        @media (prefers-color-scheme: dark) {
          :host([data-theme="auto"]) .hero-art-dark { display: block; }
          :host([data-theme="auto"]) .hero-art-light { display: none; }
        }

        *, *::before, *::after { box-sizing: border-box; }
        [hidden] { display: none !important; }
        button, textarea, input { font: inherit; color: inherit; }
        button { cursor: pointer; }
        svg { display: block; flex-shrink: 0; }

        .shell {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          color: var(--rd-text);
        }

        .panel {
          display: flex;
          flex-direction: column;
          width: min(432px, calc(100vw - 24px));
          height: min(668px, calc(100dvh - 88px));
          margin-bottom: 12px;
          border-radius: 22px;
          background: var(--rd-bg);
          border: 1px solid var(--rd-border);
          box-shadow: var(--rd-shadow);
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
          overflow: hidden;
          opacity: 0;
          transform: translateY(16px) scale(0.968);
          transform-origin: bottom right;
          transition: opacity 210ms cubic-bezier(0.16, 1, 0.3, 1),
                      transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
          pointer-events: none;
        }

        .panel.is-open {
          opacity: 1;
          transform: translateY(0) scale(1);
          pointer-events: auto;
        }

        .panel.is-dragover {
          border-color: var(--rd-accent);
          box-shadow: var(--rd-shadow), 0 0 0 2px var(--rd-accent-soft);
        }

        /* Header */
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 13px 15px 12px;
          background: var(--rd-header-bg);
          border-bottom: 1px solid var(--rd-border);
          flex-shrink: 0;
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }

        .brand-logo {
          position: relative;
          width: 34px;
          height: 34px;
          border-radius: 10px;
          overflow: visible;
          flex-shrink: 0;
          box-shadow: 0 6px 14px -4px rgba(0, 0, 0, 0.32), 0 0 0 1px rgba(255, 255, 255, 0.12);
        }
        .brand-logo img {
          width: 100%;
          height: 100%;
          border-radius: 10px;
          object-fit: cover;
          display: block;
          background: #12141a;
        }
        .brand-live-dot {
          position: absolute;
          right: -2px;
          bottom: -2px;
          width: 9px;
          height: 9px;
          border-radius: 999px;
          background: var(--rd-success);
          box-shadow: 0 0 0 2px var(--rd-bg);
        }

        .header-titles {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 1px;
        }

        .header-title-row {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .header h2 {
          margin: 0;
          font-size: 14px;
          font-weight: 660;
          letter-spacing: -0.015em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .cap-pill {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 1.5px 7px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.01em;
          background: var(--rd-accent-soft);
          border: 1px solid var(--rd-accent-border);
          color: var(--rd-accent-text);
          white-space: nowrap;
        }

        .cap-dot {
          width: 5px;
          height: 5px;
          border-radius: 999px;
          background: var(--rd-accent);
        }

        .header-sub {
          font-size: 11px;
          color: var(--rd-text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 4px;
          flex-shrink: 0;
        }

        .hdr-chip-btn {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 29px;
          padding: 0 10px;
          border-radius: 9px;
          border: 1px solid var(--rd-border);
          background: var(--rd-surface);
          color: var(--rd-text-secondary);
          font-size: 11.5px;
          font-weight: 580;
          transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease, transform 120ms ease;
        }
        .hdr-chip-btn svg { width: 12.5px; height: 12.5px; }
        .hdr-chip-btn:hover {
          background: var(--rd-surface-hover);
          color: var(--rd-text);
          border-color: var(--rd-border-strong);
        }

        .icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 29px;
          height: 29px;
          border: 0;
          border-radius: 9px;
          background: transparent;
          color: var(--rd-text-secondary);
          transition: background-color 140ms ease, color 140ms ease;
        }
        .icon-btn svg { width: 15px; height: 15px; }
        .icon-btn:hover {
          background: var(--rd-surface-hover);
          color: var(--rd-text);
        }

        /* Messages Body */
        .body {
          flex: 1;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 14px 15px 14px;
          display: flex;
          flex-direction: column;
          gap: 13px;
        }

        .body::-webkit-scrollbar { width: 5px; }
        .body::-webkit-scrollbar-thumb {
          background: var(--rd-border-strong);
          border-radius: 999px;
        }

        /* Editorial Welcome Hero */
        .welcome {
          display: flex;
          flex-direction: column;
          gap: 10px;
          animation: rd-fade-up 240ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        .welcome-hero {
          position: relative;
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid var(--rd-border);
          background: var(--rd-hero-bg);
          min-height: 138px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          padding: 13px 15px 11px;
        }

        .welcome-hero-art {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: right center;
          transform: translateX(7%);
          pointer-events: none;
          user-select: none;
        }

        .welcome-hero-scrim {
          position: absolute;
          inset: 0;
          background: linear-gradient(
            96deg,
            var(--rd-hero-bg) 0%,
            var(--rd-hero-bg) 34%,
            color-mix(in srgb, var(--rd-hero-bg) 68%, transparent) 52%,
            transparent 76%
          );
          pointer-events: none;
        }

        .welcome-hero-copy {
          position: relative;
          z-index: 1;
          max-width: 58%;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .welcome-eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 10px;
          font-weight: 660;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--rd-accent-text);
        }
        .welcome-eyebrow-dot {
          width: 6px;
          height: 6px;
          border-radius: 999px;
          background: var(--rd-accent);
          box-shadow: 0 0 0 3px var(--rd-accent-soft);
        }

        .welcome-title {
          margin: 0;
          font-size: 15.5px;
          font-weight: 700;
          letter-spacing: -0.02em;
          line-height: 1.28;
          color: var(--rd-text);
        }

        .welcome-desc {
          margin: 0;
          font-size: 11.5px;
          color: var(--rd-text-secondary);
          line-height: 1.48;
        }

        .welcome-caps {
          position: relative;
          z-index: 1;
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          margin-top: 8px;
        }

        .welcome-cap-tag {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 7.5px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 580;
          color: var(--rd-text-secondary);
          background: color-mix(in srgb, var(--rd-bg) 78%, transparent);
          border: 1px solid var(--rd-border);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        .welcome-cap-tag svg { width: 10.5px; height: 10.5px; color: var(--rd-accent); }

        .starter-section-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--rd-text-muted);
          padding: 0 2px;
          letter-spacing: 0.02em;
        }

        .starter-list {
          display: flex;
          flex-direction: column;
          gap: 7px;
        }

        .starter-btn {
          display: flex;
          align-items: center;
          gap: 11px;
          width: 100%;
          padding: 8.5px 11px;
          border-radius: 13px;
          border: 1px solid var(--rd-border);
          background: var(--rd-card-bg);
          text-align: left;
          transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1),
                      border-color 150ms ease,
                      background-color 150ms ease,
                      box-shadow 160ms ease;
        }
        .starter-btn:hover {
          border-color: var(--rd-border-strong);
          background: var(--rd-surface);
          transform: translateY(-1.5px);
          box-shadow: 0 8px 20px -10px rgba(0, 0, 0, 0.22);
        }

        .starter-art-box {
          width: 42px;
          height: 42px;
          border-radius: 11px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          border: 1px solid transparent;
          overflow: visible;
          transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .starter-art-box.is-bug {
          background: var(--rd-bug-bg);
          border-color: var(--rd-bug-ring);
        }
        .starter-art-box.is-question {
          background: var(--rd-question-bg);
          border-color: var(--rd-question-ring);
        }
        .starter-art-box.is-idea {
          background: var(--rd-idea-bg);
          border-color: var(--rd-idea-ring);
        }
        .starter-art-img {
          width: 36px;
          height: 36px;
          object-fit: contain;
          display: block;
          filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.16));
          transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .starter-btn:hover .starter-art-img {
          transform: scale(1.09) translateY(-1.5px);
        }

        .starter-copy { min-width: 0; flex: 1; }
        .starter-name {
          display: block;
          font-size: 13px;
          font-weight: 630;
          color: var(--rd-text);
          letter-spacing: -0.01em;
        }
        .starter-sub {
          display: block;
          font-size: 11.5px;
          color: var(--rd-text-muted);
          margin-top: 2px;
          line-height: 1.4;
        }
        .starter-chevron {
          color: var(--rd-text-muted);
          opacity: 0.55;
          transition: transform 160ms ease, opacity 160ms ease, color 160ms ease;
        }
        .starter-chevron svg { width: 15px; height: 15px; }
        .starter-btn:hover .starter-chevron {
          transform: translateX(2.5px);
          opacity: 1;
          color: var(--rd-accent);
        }

        /* Chat Messages */
        .msg-row {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .msg-row.is-user { align-items: flex-end; }
        .msg-row.is-assistant { align-items: flex-start; }

        .msg-assistant-head {
          display: flex;
          align-items: center;
          gap: 7px;
          min-height: 20px;
        }
        .msg-avatar {
          width: 20px;
          height: 20px;
          border-radius: 6px;
          object-fit: cover;
          background: #12141a;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.22);
          flex-shrink: 0;
        }
        .msg-sender {
          font-size: 11px;
          font-weight: 600;
          color: var(--rd-text-muted);
        }

        .msg-bubble {
          max-width: 90%;
          padding: 10px 13px;
          border-radius: 15px;
          font-size: 13.5px;
          line-height: 1.6;
          word-break: break-word;
        }

        .msg-row.is-user .msg-bubble {
          background: var(--rd-user-bg);
          color: var(--rd-user-text);
          border-bottom-right-radius: 5px;
          white-space: pre-wrap;
          box-shadow: 0 6px 18px -6px rgba(229, 77, 38, 0.42);
        }

        .msg-row.is-assistant .msg-bubble {
          background: var(--rd-surface);
          border: 1px solid var(--rd-border);
          color: var(--rd-text);
          border-top-left-radius: 5px;
          max-width: 98%;
        }

        .msg-bubble p { margin: 0 0 6px; }
        .msg-bubble p:last-child { margin-bottom: 0; }
        .msg-bubble h3, .msg-bubble h4, .msg-bubble h5 {
          margin: 8px 0 4px;
          font-size: 13.5px;
          font-weight: 650;
        }
        .msg-bubble h3:first-child, .msg-bubble h4:first-child { margin-top: 0; }
        .msg-bubble ul, .msg-bubble ol {
          margin: 4px 0 6px;
          padding-left: 18px;
        }
        .msg-bubble li { margin: 2px 0; }
        .msg-bubble li.is-nested { margin-left: 14px; }
        .msg-bubble blockquote {
          margin: 6px 0;
          padding: 4px 10px;
          border-left: 2.5px solid var(--rd-accent);
          color: var(--rd-text-muted);
          background: var(--rd-surface-2);
          border-radius: 0 6px 6px 0;
        }
        .msg-bubble hr {
          border: 0;
          border-top: 1px solid var(--rd-border);
          margin: 8px 0;
        }
        .msg-bubble code {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 12px;
          padding: 1px 5px;
          border-radius: 5px;
          background: var(--rd-surface-2);
          border: 1px solid var(--rd-border);
        }
        .msg-bubble pre {
          margin: 6px 0;
          padding: 9px 10px;
          border-radius: 9px;
          background: var(--rd-input-bg);
          border: 1px solid var(--rd-border);
          overflow-x: auto;
        }
        .msg-bubble pre code {
          padding: 0;
          border: 0;
          background: transparent;
          font-size: 11.5px;
          line-height: 1.5;
        }
        .msg-bubble a {
          color: var(--rd-accent-text);
          text-decoration: underline;
          text-underline-offset: 2px;
        }

        .msg-images {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          max-width: 90%;
        }
        .msg-thumb {
          width: 78px;
          height: 58px;
          border-radius: 9px;
          object-fit: cover;
          border: 1px solid var(--rd-border-strong);
          cursor: zoom-in;
          background: var(--rd-surface);
          transition: transform 140ms ease;
        }
        .msg-thumb:hover { transform: scale(1.03); }

        .tool-pill {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 2.5px 9px;
          border-radius: 999px;
          background: var(--rd-accent-soft);
          border: 1px solid var(--rd-accent-border);
          color: var(--rd-accent-text);
          font-size: 11px;
          font-weight: 560;
        }
        .tool-pill svg { width: 11.5px; height: 11.5px; }

        /* Inline Ticket Confirmation Card */
        .ticket-card {
          position: relative;
          width: 100%;
          border-radius: 16px;
          border: 1px solid var(--rd-border-strong);
          background: var(--rd-card-bg);
          padding: 13px;
          display: flex;
          flex-direction: column;
          gap: 9px;
          box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.14);
          overflow: hidden;
        }
        .ticket-card::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 2.5px;
          background: linear-gradient(90deg, var(--rd-accent), var(--rd-accent-2));
          opacity: 0.9;
        }

        .ticket-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }

        .ticket-head-left {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12.5px;
          font-weight: 640;
          color: var(--rd-text);
        }
        .ticket-head-left svg { width: 14px; height: 14px; color: var(--rd-accent); }

        .kind-tabs {
          display: flex;
          gap: 5px;
          flex-wrap: wrap;
        }

        .kind-tab {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 3.5px 10px;
          border-radius: 999px;
          border: 1px solid var(--rd-border);
          background: var(--rd-surface);
          font-size: 11.5px;
          font-weight: 560;
          color: var(--rd-text-secondary);
          transition: all 140ms ease;
        }
        .kind-tab.is-active {
          border-color: var(--rd-accent-border);
          background: var(--rd-accent-soft);
          color: var(--rd-accent-text);
        }

        .ticket-input, .ticket-textarea {
          width: 100%;
          border: 1px solid var(--rd-border);
          border-radius: 9px;
          background: var(--rd-surface);
          padding: 7px 10px;
          font-size: 12.5px;
          color: var(--rd-text);
          outline: none;
          transition: border-color 140ms ease;
        }
        .ticket-input:focus, .ticket-textarea:focus {
          border-color: var(--rd-accent);
          background: var(--rd-input-bg);
        }
        .ticket-textarea {
          min-height: 68px;
          resize: vertical;
          line-height: 1.48;
        }

        .ticket-meta {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
          color: var(--rd-text-muted);
          overflow: hidden;
        }
        .ticket-meta svg { width: 11.5px; height: 11.5px; }
        .ticket-meta span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .ticket-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 7px;
          margin-top: 2px;
        }

        .btn-ghost {
          height: 31px;
          padding: 0 11px;
          border-radius: 9px;
          border: 1px solid var(--rd-border);
          background: transparent;
          color: var(--rd-text-secondary);
          font-size: 12px;
          font-weight: 540;
        }
        .btn-ghost:hover {
          background: var(--rd-surface-hover);
          color: var(--rd-text);
        }

        .btn-submit {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 32px;
          padding: 0 14px;
          border-radius: 10px;
          border: 0;
          background: var(--rd-user-bg);
          color: #ffffff;
          font-size: 12px;
          font-weight: 620;
          box-shadow: 0 4px 12px -4px rgba(229, 77, 38, 0.45);
          transition: filter 140ms ease, opacity 140ms ease, transform 120ms ease;
        }
        .btn-submit:hover:not(:disabled) {
          filter: brightness(1.06);
          transform: translateY(-1px);
        }
        .btn-submit:disabled { opacity: 0.55; cursor: not-allowed; }
        .btn-submit svg { width: 13px; height: 13px; }

        .ticket-done {
          width: 100%;
          border-radius: 16px;
          border: 1px solid rgba(16, 185, 129, 0.28);
          background: var(--rd-success-soft);
          padding: 13px;
          display: flex;
          align-items: center;
          gap: 12px;
          animation: rd-fade-up 220ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .ticket-done-art {
          width: 52px;
          height: 52px;
          object-fit: contain;
          flex-shrink: 0;
          filter: drop-shadow(0 6px 10px rgba(16, 185, 129, 0.22));
        }
        .ticket-done-body {
          min-width: 0;
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .ticket-done-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          flex-wrap: wrap;
        }
        .ticket-done-title {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 13px;
          font-weight: 660;
          color: var(--rd-success);
        }
        .ticket-done-title svg { width: 14px; height: 14px; }
        .ticket-code-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 8px;
          border-radius: 999px;
          border: 1px solid rgba(16, 185, 129, 0.35);
          background: var(--rd-input-bg);
          color: var(--rd-text);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          font-weight: 620;
          transition: border-color 140ms ease, background-color 140ms ease;
        }
        .ticket-code-btn:hover {
          border-color: var(--rd-success);
        }
        .ticket-code-btn svg { width: 11px; height: 11px; }
        .ticket-done-sub {
          margin: 0;
          font-size: 12px;
          color: var(--rd-text-secondary);
          line-height: 1.48;
        }

        /* Notice / Error Banner */
        .notice {
          display: flex;
          align-items: flex-start;
          gap: 7px;
          padding: 8px 11px;
          border-radius: 10px;
          border: 1px solid var(--rd-danger-border);
          background: var(--rd-danger-bg);
          color: var(--rd-danger);
          font-size: 12px;
          line-height: 1.45;
          margin: 0 12px 8px;
        }
        .notice svg { width: 14px; height: 14px; margin-top: 1px; }
        .notice .icon-btn { margin-left: auto; flex-shrink: 0; }

        /* Composer Footer */
        .composer {
          flex-shrink: 0;
          padding: 10px 12px 12px;
          border-top: 1px solid var(--rd-border);
          background: var(--rd-bg);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .att-strip {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
        }

        .att-item {
          position: relative;
          width: 60px;
          height: 46px;
          border-radius: 9px;
          overflow: hidden;
          border: 1px solid var(--rd-border-strong);
          background: var(--rd-surface);
        }
        .att-item img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .att-item.is-uploading img { opacity: 0.45; }
        .att-spinner {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0, 0, 0, 0.28);
          color: #ffffff;
        }
        .att-spinner svg { width: 16px; height: 16px; }
        .att-remove {
          position: absolute;
          top: 2px;
          right: 2px;
          width: 18px;
          height: 18px;
          border-radius: 999px;
          border: 0;
          background: rgba(9, 10, 14, 0.72);
          color: #ffffff;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
        }
        .att-remove svg { width: 11px; height: 11px; }

        .input-box {
          display: flex;
          flex-direction: column;
          border-radius: 15px;
          border: 1px solid var(--rd-border-strong);
          background: var(--rd-input-bg);
          transition: border-color 150ms ease, box-shadow 150ms ease;
        }
        .input-box:focus-within {
          border-color: var(--rd-accent);
          box-shadow: 0 0 0 3px var(--rd-accent-soft);
        }

        .chat-input {
          width: 100%;
          min-height: 44px;
          max-height: 120px;
          padding: 10px 12px 4px;
          border: 0;
          background: transparent;
          outline: none;
          resize: none;
          font-size: 13.5px;
          line-height: 1.5;
          color: var(--rd-text);
        }
        .chat-input::placeholder { color: var(--rd-text-muted); }

        .input-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 4px 8px 8px;
        }

        .tool-btns {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .tool-btn {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 29px;
          padding: 0 9px;
          border-radius: 9px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--rd-text-secondary);
          font-size: 11.5px;
          font-weight: 560;
          transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
        }
        .tool-btn svg { width: 14px; height: 14px; }
        .tool-btn:hover:not(:disabled) {
          background: var(--rd-surface-hover);
          border-color: var(--rd-border);
          color: var(--rd-text);
        }
        .tool-btn:disabled { opacity: 0.45; cursor: not-allowed; }

        .send-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 10px;
          border: 0;
          background: var(--rd-user-bg);
          color: #ffffff;
          box-shadow: 0 4px 12px -4px rgba(229, 77, 38, 0.48);
          transition: filter 140ms ease, opacity 140ms ease, transform 120ms ease;
        }
        .send-btn svg { width: 14px; height: 14px; }
        .send-btn:hover:not(:disabled) {
          filter: brightness(1.07);
          transform: translateY(-1px);
        }
        .send-btn:disabled {
          opacity: 0.32;
          box-shadow: none;
          cursor: not-allowed;
        }
        .send-btn.is-stop {
          background: var(--rd-danger);
          color: #ffffff;
          box-shadow: 0 4px 12px -4px rgba(220, 38, 38, 0.45);
        }

        /* Floating Launcher */
        .toggle {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          height: 46px;
          padding: 0 16px 0 9px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: var(--rd-primary-bg);
          color: var(--rd-primary-text);
          font-size: 13.5px;
          font-weight: 620;
          letter-spacing: -0.01em;
          box-shadow: var(--rd-toggle-shadow);
          transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1),
                      background-color 150ms ease,
                      box-shadow 180ms ease;
        }
        .toggle svg { width: 17px; height: 17px; }
        .toggle-brand {
          width: 28px;
          height: 28px;
          border-radius: 999px;
          overflow: hidden;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.14);
          flex-shrink: 0;
        }
        .toggle-brand img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .toggle:hover {
          background: var(--rd-primary-hover);
          transform: translateY(-2px);
          box-shadow: var(--rd-toggle-shadow), 0 0 0 3px var(--rd-accent-soft);
        }
        .toggle.is-open {
          width: 46px;
          padding: 0;
          justify-content: center;
        }
        .toggle.is-open .toggle-label { display: none; }

        /* Lightbox */
        .lightbox {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          background: rgba(9, 10, 14, 0.82);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }
        .lightbox img {
          max-width: min(92vw, 1280px);
          max-height: 88vh;
          border-radius: 12px;
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.65);
          border: 1px solid rgba(255, 255, 255, 0.15);
        }
        .lightbox-close {
          position: fixed;
          top: 18px;
          right: 18px;
          width: 36px;
          height: 36px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(17, 18, 22, 0.85);
          color: #ffffff;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .lightbox-close svg { width: 18px; height: 18px; }

        /* Screenshot Crop Overlay */
        .crop-overlay {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          cursor: crosshair;
          user-select: none;
          background: rgba(9, 10, 14, 0.28);
        }
        .crop-overlay.has-selection {
          background: transparent;
        }
        .crop-toolbar {
          position: fixed;
          top: 18px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 2;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border-radius: 999px;
          background: rgba(17, 18, 24, 0.92);
          color: #f4f4f5;
          border: 1px solid rgba(255, 255, 255, 0.14);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
          backdrop-filter: blur(12px);
          cursor: default;
          white-space: nowrap;
        }
        .crop-hint {
          font-size: 12px;
          color: #d4d4d8;
          padding: 0 6px;
        }
        .crop-btn {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 28px;
          padding: 0 10px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.08);
          color: #ffffff;
          font-size: 12px;
          font-weight: 550;
        }
        .crop-btn svg { width: 13px; height: 13px; }
        .crop-btn:hover { background: rgba(255, 255, 255, 0.16); }
        .crop-btn.is-cancel {
          border-color: transparent;
          background: transparent;
          color: #a1a1aa;
        }
        .crop-btn.is-cancel:hover { color: #ffffff; }

        .crop-box {
          position: fixed;
          border: 1.5px solid #f25c36;
          box-shadow: 0 0 0 99999px rgba(9, 10, 14, 0.48);
          pointer-events: none;
          border-radius: 4px;
        }
        .crop-dims {
          position: absolute;
          left: 0;
          top: -26px;
          padding: 2px 7px;
          border-radius: 6px;
          background: #e54d26;
          color: #ffffff;
          font-size: 11px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }

        /* Annotation Modal */
        .annot-backdrop {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          background: rgba(9, 10, 14, 0.80);
          backdrop-filter: blur(10px);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 14px;
          padding: 20px;
        }
        .annot-stage {
          max-width: min(92vw, 1100px);
          max-height: calc(100vh - 120px);
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 24px 70px rgba(0, 0, 0, 0.65);
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: #111216;
        }
        .annot-canvas {
          display: block;
          max-width: 100%;
          max-height: calc(100vh - 122px);
          cursor: crosshair;
          touch-action: none;
        }
        .annot-bar {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
          justify-content: center;
          padding: 7px 11px;
          border-radius: 14px;
          background: rgba(20, 21, 27, 0.94);
          border: 1px solid rgba(255, 255, 255, 0.14);
          color: #f4f4f5;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
        }
        .annot-tool {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 32px;
          padding: 0 10px;
          border-radius: 9px;
          border: 1px solid transparent;
          background: transparent;
          color: #d4d4d8;
          font-size: 12px;
          font-weight: 540;
        }
        .annot-tool svg { width: 14px; height: 14px; }
        .annot-tool:hover { background: rgba(255, 255, 255, 0.08); color: #ffffff; }
        .annot-tool.is-active {
          background: rgba(242, 92, 54, 0.22);
          border-color: rgba(242, 92, 54, 0.58);
          color: #ffb199;
        }
        .annot-sep {
          width: 1px;
          height: 18px;
          background: rgba(255, 255, 255, 0.14);
          margin: 0 2px;
        }
        .annot-confirm {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 32px;
          padding: 0 14px;
          border-radius: 9px;
          border: 0;
          background: linear-gradient(135deg, #f25c36 0%, #dc4620 100%);
          color: #ffffff;
          font-size: 12.5px;
          font-weight: 620;
        }
        .annot-confirm:hover:not(:disabled) { filter: brightness(1.07); }
        .annot-confirm:disabled { opacity: 0.6; cursor: not-allowed; }
        .annot-confirm svg { width: 14px; height: 14px; }

        .spin { animation: rd-spin 0.85s linear infinite; }
        @keyframes rd-spin { to { transform: rotate(360deg); } }
        @keyframes rd-fade-up {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @media (max-width: 480px) {
          :host { inset: auto 12px 12px auto; }
          .panel {
            width: calc(100vw - 24px);
            height: calc(100dvh - 82px);
          }
        }
      </style>

      <div class="shell">
        <section class="panel" role="dialog" aria-label="AI 助手与反馈收集" aria-modal="false">
          <header class="header">
            <div class="header-left">
              <span class="brand-logo">
                <img src="${escapeHtml(ASSETS.logo)}" alt="Relaydesk" width="34" height="34" />
                <span class="brand-live-dot" aria-hidden="true"></span>
              </span>
              <div class="header-titles">
                <div class="header-title-row">
                  <h2 data-role="title">反馈与助手</h2>
                  <span class="cap-pill" data-role="cap-pill" hidden>
                    <span class="cap-dot"></span>
                    <span data-role="cap-text">AI 助手</span>
                  </span>
                </div>
                <div class="header-sub" data-role="subtitle">在线解答功能疑问，或截屏一键提单</div>
              </div>
            </div>
            <div class="header-actions">
              <button type="button" class="hdr-chip-btn" data-action="quick-ticket" title="不经对话直接填写反馈单">
                ${ICONS.ticket}<span>直接提单</span>
              </button>
              <button type="button" class="icon-btn" data-action="reset" title="开始新对话" hidden>
                ${ICONS.refresh}
              </button>
              <button type="button" class="icon-btn" data-action="close" aria-label="关闭窗口">
                ${ICONS.close}
              </button>
            </div>
          </header>

          <div class="body" data-role="body"></div>

          <div class="notice" data-role="notice" hidden>
            ${ICONS.alert}
            <span role="alert" data-role="notice-text"></span>
            <button type="button" class="icon-btn" data-action="dismiss-notice" aria-label="关闭提示">${ICONS.close}</button>
          </div>

          <footer class="composer">
            <div class="att-strip" data-role="att-strip" hidden></div>
            <div class="input-box">
              <textarea
                class="chat-input"
                data-role="input"
                rows="1"
                maxlength="${MAX_CHARS}"
                placeholder="问问怎么用、反馈问题，或直接粘贴截图 (Ctrl/⌘+V)…"
              ></textarea>
              <div class="input-bar">
                <div class="tool-btns">
                  <button type="button" class="tool-btn" data-action="screenshot" title="自由框选网页截屏并标注">
                    ${ICONS.crop}<span>截屏</span>
                  </button>
                  <button type="button" class="tool-btn" data-action="pick-image" title="上传本地图片">
                    ${ICONS.image}<span>传图</span>
                  </button>
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-role="file-input" />
                </div>
                <button type="button" class="send-btn" data-action="send" aria-label="发送消息" disabled>
                  ${ICONS.send}
                </button>
              </div>
            </div>
          </footer>
        </section>

        <button type="button" class="toggle" data-action="toggle" aria-expanded="false">
          <span class="toggle-brand" data-role="toggle-icon"><img src="${escapeHtml(ASSETS.logo)}" alt="" width="28" height="28" /></span>
          <span class="toggle-label">反馈与助手</span>
        </button>
      </div>

      <div class="lightbox" data-role="lightbox" hidden>
        <button type="button" class="lightbox-close" data-action="close-lightbox" aria-label="关闭大图">${ICONS.close}</button>
        <img data-role="lightbox-img" alt="截图预览" />
      </div>

      <div class="crop-overlay" data-role="crop-overlay" hidden>
        <div class="crop-toolbar" data-role="crop-toolbar">
          <span class="crop-hint">拖拽框选截屏区域</span>
          <button type="button" class="crop-btn" data-action="crop-full">截取当前屏幕</button>
          <button type="button" class="crop-btn" data-action="crop-display" hidden>
            ${ICONS.monitor}<span>系统抓屏</span>
          </button>
          <button type="button" class="crop-btn is-cancel" data-action="crop-cancel">取消 (Esc)</button>
        </div>
        <div class="crop-box" data-role="crop-box" hidden>
          <span class="crop-dims" data-role="crop-dims"></span>
        </div>
      </div>

      <div class="annot-backdrop" data-role="annot-modal" hidden>
        <div class="annot-stage">
          <canvas class="annot-canvas" data-role="annot-canvas"></canvas>
        </div>
        <div class="annot-bar">
          <button type="button" class="annot-tool is-active" data-annot-tool="rect">${ICONS.rect}<span>红框</span></button>
          <button type="button" class="annot-tool" data-annot-tool="arrow">${ICONS.arrow}<span>箭头</span></button>
          <button type="button" class="annot-tool" data-annot-tool="pen">${ICONS.pen}<span>画笔</span></button>
          <button type="button" class="annot-tool" data-annot-tool="mosaic">${ICONS.mosaic}<span>打码</span></button>
          <span class="annot-sep"></span>
          <button type="button" class="annot-tool" data-action="annot-undo">${ICONS.undo}<span>撤销</span></button>
          <button type="button" class="annot-tool" data-action="annot-retake">${ICONS.crop}<span>重截</span></button>
          <button type="button" class="annot-tool" data-action="annot-cancel">取消</button>
          <button type="button" class="annot-confirm" data-action="annot-confirm">${ICONS.check}<span>确认添加截图</span></button>
        </div>
      </div>
    `;

    const q = (sel) => root.querySelector(sel);
    const panel = q(".panel");
    const toggleBtn = q('[data-action="toggle"]');
    const toggleIcon = q('[data-role="toggle-icon"]');
    const titleEl = q('[data-role="title"]');
    const subtitleEl = q('[data-role="subtitle"]');
    const capPill = q('[data-role="cap-pill"]');
    const capText = q('[data-role="cap-text"]');
    const resetBtn = q('[data-action="reset"]');
    const bodyEl = q('[data-role="body"]');
    const noticeEl = q('[data-role="notice"]');
    const noticeText = q('[data-role="notice-text"]');
    const attStrip = q('[data-role="att-strip"]');
    const inputEl = q('[data-role="input"]');
    const fileInput = q('[data-role="file-input"]');
    const sendBtn = q('[data-action="send"]');
    const screenshotBtn = q('[data-action="screenshot"]');
    const pickImageBtn = q('[data-action="pick-image"]');
    const lightbox = q('[data-role="lightbox"]');
    const lightboxImg = q('[data-role="lightbox-img"]');
    const cropOverlay = q('[data-role="crop-overlay"]');
    const cropToolbar = q('[data-role="crop-toolbar"]');
    const cropBox = q('[data-role="crop-box"]');
    const cropDims = q('[data-role="crop-dims"]');
    const cropDisplayBtn = q('[data-action="crop-display"]');
    const annotModal = q('[data-role="annot-modal"]');
    const annotCanvas = q('[data-role="annot-canvas"]');
    const annotConfirmBtn = q('[data-action="annot-confirm"]');

    if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function") {
      cropDisplayBtn.hidden = false;
    }

    const state = {
      open: false,
      configLoaded: false,
      config: {
        project_name: "",
        ai_enabled: true,
        code_context_enabled: false,
        upload_enabled: true,
        max_upload_bytes: MAX_UPLOAD_BYTES,
      },
      // items: { id, type: "user"|"assistant"|"ticket", text?, attachments?, statusLabel?, streaming?, draft?, submitted? }
      items: [],
      pendingAttachments: [], // { id, previewUrl, remoteUrl, uploading, error }
      streaming: false,
      abortController: null,
      noticeTimer: null,
    };

    function showNotice(msg, autoClearMs = 6000) {
      if (state.noticeTimer) {
        clearTimeout(state.noticeTimer);
        state.noticeTimer = null;
      }
      if (!msg) {
        noticeEl.hidden = true;
        noticeText.textContent = "";
        return;
      }
      noticeText.textContent = msg;
      noticeEl.hidden = false;
      if (autoClearMs > 0) {
        state.noticeTimer = setTimeout(() => {
          noticeEl.hidden = true;
          state.noticeTimer = null;
        }, autoClearMs);
      }
    }

    function isNearBottom() {
      return bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight <= 80;
    }

    function scrollToBottom(force = true) {
      if (!force && !isNearBottom()) return;
      requestAnimationFrame(() => {
        bodyEl.scrollTop = bodyEl.scrollHeight;
      });
    }

    function renderAssistantItemInnerHtml(item) {
      const senderName = state.config.project_name
        ? `${state.config.project_name} · AI`
        : "Relaydesk AI";
      const statusHtml = item.statusLabel
        ? `<div class="tool-pill">${ICONS.spinner}<span>${escapeHtml(item.statusLabel)}</span></div>`
        : "";
      const headHtml = `
        <div class="msg-assistant-head">
          <img class="msg-avatar" src="${escapeHtml(ASSETS.logo)}" alt="" width="20" height="20" />
          <span class="msg-sender">${escapeHtml(senderName)}</span>
          ${statusHtml}
        </div>
      `;
      const rendered = item.text ? renderMarkdownLite(item.text) : "";
      const bubbleHtml = rendered
        ? `<div class="msg-bubble">${rendered}</div>`
        : "";
      return `${headHtml}${bubbleHtml}`;
    }

    function updateAssistantItemDom(item) {
      const row = bodyEl.querySelector(`[data-item-id="${item.id}"]`);
      if (!row) {
        renderBody();
        return;
      }
      row.innerHTML = renderAssistantItemInnerHtml(item);
    }

    function autoGrowInput() {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(120, Math.max(42, inputEl.scrollHeight)) + "px";
    }

    function updateSendButton() {
      const hasText = inputEl.value.trim().length > 0;
      const hasUploaded = state.pendingAttachments.some((a) => a.remoteUrl && !a.uploading);
      const anyUploading = state.pendingAttachments.some((a) => a.uploading);
      if (state.streaming) {
        sendBtn.disabled = false;
        sendBtn.classList.add("is-stop");
        sendBtn.innerHTML = ICONS.stop;
        sendBtn.setAttribute("aria-label", "停止生成");
      } else {
        sendBtn.classList.remove("is-stop");
        sendBtn.innerHTML = ICONS.send;
        sendBtn.setAttribute("aria-label", "发送消息");
        sendBtn.disabled = anyUploading || (!hasText && !hasUploaded);
      }
    }

    function renderAttachmentsStrip() {
      if (state.pendingAttachments.length === 0) {
        attStrip.hidden = true;
        attStrip.innerHTML = "";
        updateSendButton();
        return;
      }
      attStrip.hidden = false;
      attStrip.innerHTML = state.pendingAttachments
        .map(
          (att) => `
          <div class="att-item ${att.uploading ? "is-uploading" : ""}" data-att-id="${att.id}">
            <img src="${escapeHtml(att.remoteUrl || att.previewUrl)}" alt="待发送截图" data-zoom-src="${escapeHtml(att.remoteUrl || att.previewUrl)}" />
            ${att.uploading ? `<div class="att-spinner">${ICONS.spinner}</div>` : ""}
            <button type="button" class="att-remove" data-remove-att="${att.id}" aria-label="移除截图">${ICONS.close}</button>
          </div>
        `,
        )
        .join("");
      updateSendButton();
    }

    function collectConversationImageUrls() {
      const urls = [];
      const seen = new Set();
      const push = (u) => {
        if (u && !seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      };
      for (const item of state.items) {
        if (item.attachments) {
          for (const a of item.attachments) push(a.url);
        }
      }
      for (const a of state.pendingAttachments) {
        if (a.remoteUrl) push(a.remoteUrl);
      }
      return urls.slice(-6);
    }

    function renderBody() {
      resetBtn.hidden = state.items.length === 0;
      if (state.items.length === 0) {
        const capHint = state.config.code_context_enabled
          ? "已接入项目代码上下文，实时解答使用疑问、框选截屏排查，或一键提单。"
          : "随时向 AI 助手提问、框选网页截屏，或点击右上角直接填写反馈单。";
        const eyebrow = state.config.code_context_enabled
          ? "AI · 代码感知支持"
          : "AI 在线支持";
        bodyEl.innerHTML = `
          <div class="welcome">
            <div class="welcome-hero">
              <img class="welcome-hero-art hero-art-dark" src="${escapeHtml(ASSETS.heroDark)}" alt="" />
              <img class="welcome-hero-art hero-art-light" src="${escapeHtml(ASSETS.heroLight)}" alt="" />
              <div class="welcome-hero-scrim" aria-hidden="true"></div>
              <div class="welcome-hero-copy">
                <span class="welcome-eyebrow"><span class="welcome-eyebrow-dot"></span>${escapeHtml(eyebrow)}</span>
                <p class="welcome-title">你好，有什么可以帮到你？</p>
                <p class="welcome-desc">${escapeHtml(capHint)}</p>
              </div>
              <div class="welcome-caps">
                <span class="welcome-cap-tag">${ICONS.crop}<span>框选截屏</span></span>
                ${state.config.code_context_enabled ? `<span class="welcome-cap-tag">${ICONS.check}<span>代码感知</span></span>` : ""}
                <span class="welcome-cap-tag">${ICONS.ticket}<span>一键提单</span></span>
              </div>
            </div>
            <div class="starter-section-label">快捷开始</div>
            <div class="starter-list">
              ${STARTERS.map(
                (st, idx) => `
                <button type="button" class="starter-btn" data-starter="${idx}">
                  <span class="starter-art-box is-${st.tone}">
                    <img class="starter-art-img" src="${escapeHtml(st.img)}" alt="${escapeHtml(st.alt)}" width="40" height="40" />
                  </span>
                  <span class="starter-copy">
                    <span class="starter-name">${escapeHtml(st.title)}</span>
                    <span class="starter-sub">${escapeHtml(st.desc)}</span>
                  </span>
                  <span class="starter-chevron">${ICONS.chevronRight}</span>
                </button>
              `,
              ).join("")}
            </div>
          </div>
        `;
        return;
      }

      bodyEl.innerHTML = state.items
        .map((item) => {
          if (item.type === "user") {
            const imgsHtml =
              item.attachments && item.attachments.length
                ? `<div class="msg-images">${item.attachments
                    .map(
                      (a) =>
                        `<img class="msg-thumb" src="${escapeHtml(a.url)}" alt="用户截图" data-zoom-src="${escapeHtml(a.url)}" />`,
                    )
                    .join("")}</div>`
                : "";
            const textHtml = item.text
              ? `<div class="msg-bubble">${escapeHtml(item.text)}</div>`
              : "";
            return `<div class="msg-row is-user" data-item-id="${item.id}">${imgsHtml}${textHtml}</div>`;
          }

          if (item.type === "assistant") {
            return `<div class="msg-row is-assistant" data-item-id="${item.id}">${renderAssistantItemInnerHtml(item)}</div>`;
          }

          if (item.type === "ticket") {
            if (item.submitted) {
              const code = formatTicketCode(item.submitted.number);
              return `
                <div class="ticket-done" data-item-id="${item.id}">
                  <img class="ticket-done-art" src="${escapeHtml(ASSETS.success)}" alt="" width="52" height="52" />
                  <div class="ticket-done-body">
                    <div class="ticket-done-top">
                      <span class="ticket-done-title">${ICONS.check}<span>反馈已进入处理队列</span></span>
                      ${
                        code
                          ? `<button type="button" class="ticket-code-btn" data-copy-code="${escapeHtml(code)}">${ICONS.copy}<span>${escapeHtml(code)}</span></button>`
                          : ""
                      }
                    </div>
                    <p class="ticket-done-sub">${escapeHtml(item.draft.title)} · 感谢反馈，团队与自动流水线已收到这条记录。</p>
                  </div>
                </div>
              `;
            }
            const d = item.draft;
            const imgStrip =
              d.attachments && d.attachments.length
                ? `<div class="msg-images">${d.attachments
                    .map(
                      (u) =>
                        `<img class="msg-thumb" src="${escapeHtml(u)}" alt="工单附图" data-zoom-src="${escapeHtml(u)}" />`,
                    )
                    .join("")}</div>`
                : "";
            return `
              <div class="ticket-card" data-ticket-id="${item.id}">
                <div class="ticket-head">
                  <span class="ticket-head-left">${ICONS.ticket}<span>确认提交反馈单</span></span>
                  <button type="button" class="icon-btn" data-dismiss-ticket="${item.id}" aria-label="移除卡片">${ICONS.close}</button>
                </div>
                <div class="kind-tabs">
                  ${KINDS.map(
                    (k) =>
                      `<button type="button" class="kind-tab ${d.kind === k.id ? "is-active" : ""}" data-ticket-kind="${k.id}" data-for="${item.id}">${k.label}</button>`,
                  ).join("")}
                </div>
                <input
                  type="text"
                  class="ticket-input"
                  data-ticket-field="title"
                  data-for="${item.id}"
                  maxlength="120"
                  placeholder="简要概括问题或建议标题…"
                  value="${escapeHtml(d.title)}"
                />
                <textarea
                  class="ticket-textarea"
                  data-ticket-field="summary"
                  data-for="${item.id}"
                  placeholder="详细描述现象、复现步骤或期望效果…"
                >${escapeHtml(d.summary)}</textarea>
                ${imgStrip}
                <div class="ticket-meta">
                  ${ICONS.link}<span>${escapeHtml(window.location.href)}</span>
                </div>
                <div class="ticket-actions">
                  <button type="button" class="btn-ghost" data-dismiss-ticket="${item.id}">暂不提交</button>
                  <button type="button" class="btn-submit" data-submit-ticket="${item.id}" ${item.submitting ? "disabled" : ""}>
                    ${item.submitting ? ICONS.spinner : ICONS.check}
                    <span>${item.submitting ? "提交中…" : "确认提交反馈"}</span>
                  </button>
                </div>
              </div>
            `;
          }
          return "";
        })
        .join("");
    }

    async function fetchWidgetConfig() {
      if (state.configLoaded) return;
      state.configLoaded = true;
      try {
        const res = await fetch(configEndpoint, {
          headers: { Authorization: "Bearer " + key },
        });
        if (!res.ok) return;
        const data = await res.json();
        state.config = { ...state.config, ...data };
        if (state.config.project_name) {
          titleEl.textContent = state.config.project_name;
        }
        if (state.config.code_context_enabled) {
          capText.textContent = "AI · 代码感知";
          capPill.hidden = false;
          subtitleEl.textContent = "已连接项目代码上下文，支持问答与截屏提单";
        } else if (state.config.ai_enabled) {
          capText.textContent = "AI 助手";
          capPill.hidden = false;
          subtitleEl.textContent = "在线排查问题、网页截屏或一键提单";
        } else {
          capPill.hidden = true;
          subtitleEl.textContent = "网页截屏反馈 · 直达处理队列";
        }
        if (!state.config.upload_enabled) {
          screenshotBtn.title = "站点尚未配置 R2 图床存储";
          pickImageBtn.title = "站点尚未配置 R2 图床存储";
        }
        if (state.items.length === 0) renderBody();
      } catch {
        // fail silently; defaults work
      }
    }

    async function uploadImageBlob(blob, fallbackName = "screenshot.webp") {
      if (state.pendingAttachments.length >= MAX_ATTACHMENTS) {
        showNotice(`单次最多附带 ${MAX_ATTACHMENTS} 张图片`);
        return null;
      }
      if (blob.size > (state.config.max_upload_bytes || MAX_UPLOAD_BYTES)) {
        showNotice("图片体积超过 5 MB 限制，请适当缩小截图区域");
        return null;
      }
      const attId = uid();
      const previewUrl = URL.createObjectURL(blob);
      const entry = {
        id: attId,
        name: fallbackName,
        previewUrl,
        remoteUrl: "",
        uploading: true,
        error: "",
      };
      state.pendingAttachments.push(entry);
      renderAttachmentsStrip();

      try {
        const contentType =
          blob.type && blob.type.startsWith("image/") ? blob.type : "image/png";
        const res = await fetch(uploadEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": contentType,
            Authorization: "Bearer " + key,
          },
          body: blob,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.url) {
          throw new Error(data.error || `图片上传失败（HTTP ${res.status}）`);
        }
        entry.remoteUrl = data.url;
        entry.uploading = false;
        renderAttachmentsStrip();
        // Also sync into any open unsubmitted ticket card
        for (const item of state.items) {
          if (item.type === "ticket" && !item.submitted) {
            if (!item.draft.attachments.includes(data.url)) {
              item.draft.attachments.push(data.url);
              renderBody();
            }
          }
        }
        return data.url;
      } catch (err) {
        state.pendingAttachments = state.pendingAttachments.filter((a) => a.id !== attId);
        URL.revokeObjectURL(previewUrl);
        renderAttachmentsStrip();
        showNotice(err instanceof Error ? err.message : "截图上传失败，请稍后重试");
        return null;
      }
    }

    async function handleFilesList(files) {
      const list = Array.from(files || []).filter((f) => f.type && f.type.startsWith("image/"));
      if (list.length === 0) return;
      for (const file of list) {
        if (state.pendingAttachments.length >= MAX_ATTACHMENTS) {
          showNotice(`单次最多附带 ${MAX_ATTACHMENTS} 张图片`);
          break;
        }
        await uploadImageBlob(file, file.name || "image.png");
      }
    }

    function openManualTicketCard(prefill = {}) {
      const existing = state.items.find((i) => i.type === "ticket" && !i.submitted);
      if (existing) {
        scrollToBottom();
        return;
      }
      const userTexts = state.items
        .filter((i) => i.type === "user" && i.text)
        .map((i) => i.text);
      const draftSummary = prefill.summary || userTexts.join("\n\n") || inputEl.value.trim();
      const draftTitle =
        prefill.title ||
        (draftSummary ? draftSummary.split(/\r?\n/)[0].slice(0, 72) : "");
      state.items.push({
        id: uid(),
        type: "ticket",
        draft: {
          external_id: uid(),
          title: draftTitle,
          kind: prefill.kind || "功能异常",
          priority: prefill.priority || "normal",
          summary: draftSummary,
          attachments: collectConversationImageUrls(),
        },
        submitting: false,
        submitted: null,
      });
      renderBody();
      scrollToBottom();
    }

    async function sendChatMessage(overrideText) {
      if (state.streaming) {
        state.abortController?.abort();
        return;
      }
      const text = (overrideText !== undefined ? overrideText : inputEl.value).trim();
      const readyAtts = state.pendingAttachments
        .filter((a) => a.remoteUrl && !a.uploading)
        .map((a) => ({ url: a.remoteUrl, name: a.name }));
      if (!text && readyAtts.length === 0) return;

      showNotice("");
      if (overrideText === undefined) {
        inputEl.value = "";
        autoGrowInput();
      }
      for (const a of state.pendingAttachments) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      state.pendingAttachments = [];
      renderAttachmentsStrip();

      state.items.push({
        id: uid(),
        type: "user",
        text,
        attachments: readyAtts,
      });

      const assistantItem = {
        id: uid(),
        type: "assistant",
        text: "",
        statusLabel: "正在连接 AI 助手…",
        streaming: true,
      };
      state.items.push(assistantItem);
      state.streaming = true;
      state.abortController = new AbortController();
      updateSendButton();
      renderBody();
      scrollToBottom();

      const history = state.items
        .filter((i) => (i.type === "user" || (i.type === "assistant" && !i.streaming)) && (i.text || (i.attachments && i.attachments.length)))
        .map((i) => ({
          role: i.type,
          text: i.text || "",
          ...(i.attachments && i.attachments.length ? { attachments: i.attachments } : {}),
        }));

      try {
        const res = await fetch(chatEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + key,
          },
          signal: state.abortController.signal,
          body: JSON.stringify({
            messages: history,
            page: {
              url: window.location.href,
              title: document.title || "",
              viewport: `${window.innerWidth}x${window.innerHeight}`,
              user_agent: navigator.userAgent || "",
            },
          }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `请求失败（HTTP ${res.status}）`);
        }

        const reader = res.body?.getReader();
        if (!reader) {
          throw new Error("浏览器不支持流式响应");
        }
        const decoder = new TextDecoder();
        let buffer = "";
        let pendingDraft = null;

        let receivedError = false;
        const handleSsePayload = (eventName, rawData) => {
          let evt;
          try {
            evt = JSON.parse(rawData);
          } catch {
            return;
          }
          const type = evt.type || eventName;
          if (type === "status") {
            assistantItem.statusLabel = evt.label || "正在处理…";
            const stick = isNearBottom();
            updateAssistantItemDom(assistantItem);
            if (stick) scrollToBottom(true);
          } else if (type === "delta" && evt.text) {
            assistantItem.statusLabel = "";
            assistantItem.text += evt.text;
            const stick = isNearBottom();
            updateAssistantItemDom(assistantItem);
            if (stick) scrollToBottom(true);
          } else if (type === "ticket_draft" && evt.draft) {
            pendingDraft = evt.draft;
          } else if (type === "error") {
            receivedError = true;
            showNotice(evt.error || "AI 助手响应异常，请重试或直接提单", 0);
          }
        };

        const handleBlock = (block) => {
          let eventName = "message";
          const dataLines = [];
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length) handleSsePayload(eventName, dataLines.join("\n"));
        };

        while (true) {
          const { done, value } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop();
          for (const block of blocks) handleBlock(block);
          if (done) {
            if (buffer.trim()) handleBlock(buffer);
            break;
          }
        }

        assistantItem.statusLabel = "";
        assistantItem.streaming = false;
        if (!assistantItem.text.trim() && !pendingDraft) {
          state.items = state.items.filter((i) => i.id !== assistantItem.id);
          if (!receivedError && !state.abortController?.signal.aborted) {
            showNotice("AI 助手未能生成回复，请重试或点击右上角「直接提单」", 0);
          }
        }
        if (pendingDraft) {
          const parts = [pendingDraft.summary];
          if (pendingDraft.steps) parts.push(`\n**复现步骤**\n${pendingDraft.steps}`);
          if (pendingDraft.expected) parts.push(`\n**预期结果**\n${pendingDraft.expected}`);
          state.items.push({
            id: uid(),
            type: "ticket",
            draft: {
              external_id: uid(),
              title: pendingDraft.title || "",
              kind: pendingDraft.kind || "功能异常",
              priority: pendingDraft.priority || "normal",
              summary: parts.filter(Boolean).join("\n"),
              attachments: collectConversationImageUrls(),
            },
            submitting: false,
            submitted: null,
          });
        }
      } catch (err) {
        assistantItem.statusLabel = "";
        assistantItem.streaming = false;
        if (err && err.name === "AbortError") {
          if (!assistantItem.text) {
            state.items = state.items.filter((i) => i.id !== assistantItem.id);
          }
        } else {
          if (!assistantItem.text) {
            state.items = state.items.filter((i) => i.id !== assistantItem.id);
          }
          showNotice(
            err instanceof Error ? err.message : "连接 AI 助手失败，你可以点击右上角直接提单",
            0,
          );
        }
      } finally {
        state.streaming = false;
        state.abortController = null;
        updateSendButton();
        renderBody();
        scrollToBottom();
      }
    }

    async function submitTicketCard(itemId) {
      const item = state.items.find((i) => i.id === itemId && i.type === "ticket");
      if (!item || item.submitting || item.submitted) return;
      const title = (item.draft.title || "").trim();
      const summary = (item.draft.summary || "").trim();
      if (!summary) {
        showNotice("请补充反馈内容后再提交");
        return;
      }
      item.submitting = true;
      showNotice("");
      renderBody();

      const kindLabel = item.draft.kind || "功能异常";
      const composedBody = `**[${kindLabel}]**\n\n${summary}`;
      try {
        const res = await fetch(intakeEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + key,
          },
          body: JSON.stringify({
            source: "widget",
            title: title || summary.split(/\r?\n/)[0].slice(0, 90),
            body: composedBody,
            priority: item.draft.priority || "normal",
            source_url: window.location.href,
            external_id: item.draft.external_id,
            attachments: item.draft.attachments || [],
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || `提交失败（HTTP ${res.status}）`);
        }
        item.submitted = { task_id: data.task_id, number: data.number };
      } catch (err) {
        showNotice(err instanceof Error ? err.message : "提交反馈失败，请重试");
      } finally {
        item.submitting = false;
        renderBody();
        scrollToBottom();
      }
    }

    // =========================================================================
    // Webpage Freeform Screenshot + Annotation Studio
    // =========================================================================
    let cropState = null;
    let annotState = null;

    function closeCropMode(reopenPanel = true) {
      cropOverlay.hidden = true;
      cropOverlay.classList.remove("has-selection");
      cropBox.hidden = true;
      cropState = null;
      if (reopenPanel) {
        panel.style.visibility = "";
        toggleBtn.style.visibility = "";
      }
    }

    function startCropMode() {
      showNotice("");
      panel.style.visibility = "hidden";
      toggleBtn.style.visibility = "hidden";
      cropOverlay.hidden = false;
      cropOverlay.classList.remove("has-selection");
      cropBox.hidden = true;
      cropState = { dragging: false, startX: 0, startY: 0, rect: null };
    }

    async function captureRegionDom(rect) {
      closeCropMode(false);
      // Let browser repaint without overlay before DOM snapshot
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      try {
        const lib = await loadCaptureLib();
        const docEl = document.documentElement;
        const fullHeight = Math.max(docEl.scrollHeight, window.innerHeight);
        const scale = fullHeight > 5000 ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
        const fullCanvas = await lib.domToCanvas(docEl, {
          scale,
          backgroundColor:
            getComputedStyle(document.body).backgroundColor &&
            getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)"
              ? getComputedStyle(document.body).backgroundColor
              : "#ffffff",
          filter: (node) => {
            if (node instanceof Element && node.hasAttribute("data-relaydesk-widget")) {
              return false;
            }
            return true;
          },
        });

        const sx = Math.max(0, Math.round((rect.left + window.scrollX) * scale));
        const sy = Math.max(0, Math.round((rect.top + window.scrollY) * scale));
        const sw = Math.min(fullCanvas.width - sx, Math.max(10, Math.round(rect.width * scale)));
        const sh = Math.min(fullCanvas.height - sy, Math.max(10, Math.round(rect.height * scale)));

        const cropped = document.createElement("canvas");
        cropped.width = Math.max(1, sw);
        cropped.height = Math.max(1, sh);
        const ctx = cropped.getContext("2d");
        if (!ctx) throw new Error("Canvas 初始化失败");
        ctx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
        openAnnotationStudio(cropped);
      } catch (err) {
        panel.style.visibility = "";
        toggleBtn.style.visibility = "";
        showNotice(
          (err instanceof Error ? err.message : "网页截屏失败") +
            " · 可使用「系统抓屏」或直接 Ctrl/⌘+V 粘贴截图",
        );
      }
    }

    async function captureViaDisplayMedia() {
      closeCropMode(false);
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { preferCurrentTab: true },
          audio: false,
        });
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        await new Promise((r) => setTimeout(r, 150));
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || window.innerWidth;
        canvas.height = video.videoHeight || window.innerHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        for (const track of stream.getTracks()) track.stop();
        openAnnotationStudio(canvas);
      } catch {
        panel.style.visibility = "";
        toggleBtn.style.visibility = "";
      }
    }

    function openAnnotationStudio(baseCanvas) {
      annotCanvas.width = baseCanvas.width;
      annotCanvas.height = baseCanvas.height;
      annotState = {
        base: baseCanvas,
        tool: "rect",
        ops: [],
        drawing: null,
      };
      root.querySelectorAll("[data-annot-tool]").forEach((el) => {
        el.classList.toggle("is-active", el.getAttribute("data-annot-tool") === "rect");
      });
      redrawAnnotationCanvas();
      annotModal.hidden = false;
    }

    function closeAnnotationStudio(reopenPanel = true) {
      annotModal.hidden = true;
      annotState = null;
      if (reopenPanel) {
        panel.style.visibility = "";
        toggleBtn.style.visibility = "";
      }
    }

    function drawArrow(ctx, x1, y1, x2, y2, lw) {
      const headLen = Math.max(12, lw * 4);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(
        x2 - headLen * Math.cos(angle - Math.PI / 6),
        y2 - headLen * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(
        x2 - headLen * Math.cos(angle + Math.PI / 6),
        y2 - headLen * Math.sin(angle + Math.PI / 6),
      );
      ctx.closePath();
      ctx.fill();
    }

    function applyMosaic(ctx, x, y, w, h) {
      const rx = Math.max(0, Math.floor(Math.min(x, x + w)));
      const ry = Math.max(0, Math.floor(Math.min(y, y + h)));
      const rw = Math.min(annotCanvas.width - rx, Math.ceil(Math.abs(w)));
      const rh = Math.min(annotCanvas.height - ry, Math.ceil(Math.abs(h)));
      if (rw < 4 || rh < 4) return;
      const block = Math.max(10, Math.round(Math.min(annotCanvas.width, annotCanvas.height) / 55));
      try {
        const imgData = ctx.getImageData(rx, ry, rw, rh);
        const data = imgData.data;
        for (let py = 0; py < rh; py += block) {
          for (let px = 0; px < rw; px += block) {
            const idx = (Math.min(py + Math.floor(block / 2), rh - 1) * rw + Math.min(px + Math.floor(block / 2), rw - 1)) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(rx + px, ry + py, Math.min(block, rw - px), Math.min(block, rh - py));
          }
        }
      } catch {
        ctx.fillStyle = "#18181b";
        ctx.fillRect(rx, ry, rw, rh);
      }
    }

    function renderAnnotationOp(ctx, op) {
      const lw = Math.max(2.5, Math.round(Math.max(annotCanvas.width, annotCanvas.height) / 300));
      ctx.strokeStyle = "#ef4444";
      ctx.fillStyle = "#ef4444";
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      if (op.tool === "rect") {
        ctx.strokeRect(op.x1, op.y1, op.x2 - op.x1, op.y2 - op.y1);
      } else if (op.tool === "arrow") {
        drawArrow(ctx, op.x1, op.y1, op.x2, op.y2, lw);
      } else if (op.tool === "pen" && op.points && op.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(op.points[0].x, op.points[0].y);
        for (let i = 1; i < op.points.length; i += 1) {
          ctx.lineTo(op.points[i].x, op.points[i].y);
        }
        ctx.stroke();
      } else if (op.tool === "mosaic") {
        applyMosaic(ctx, op.x1, op.y1, op.x2 - op.x1, op.y2 - op.y1);
      }
    }

    function redrawAnnotationCanvas() {
      if (!annotState) return;
      const ctx = annotCanvas.getContext("2d");
      ctx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
      ctx.drawImage(annotState.base, 0, 0);
      for (const op of annotState.ops) {
        renderAnnotationOp(ctx, op);
      }
      if (annotState.drawing) {
        renderAnnotationOp(ctx, annotState.drawing);
      }
    }

    function canvasPoint(e) {
      const r = annotCanvas.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * annotCanvas.width,
        y: ((e.clientY - r.top) / r.height) * annotCanvas.height,
      };
    }

    // Crop mouse handlers
    cropOverlay.addEventListener("pointerdown", (e) => {
      if (cropToolbar.contains(e.target)) return;
      e.preventDefault();
      cropState = {
        dragging: true,
        startX: e.clientX,
        startY: e.clientY,
        rect: { left: e.clientX, top: e.clientY, width: 0, height: 0 },
      };
      cropOverlay.classList.add("has-selection");
      cropBox.hidden = false;
      cropBox.style.left = e.clientX + "px";
      cropBox.style.top = e.clientY + "px";
      cropBox.style.width = "0px";
      cropBox.style.height = "0px";
      cropDims.textContent = "0 × 0";
      cropOverlay.setPointerCapture?.(e.pointerId);
    });

    cropOverlay.addEventListener("pointermove", (e) => {
      if (!cropState?.dragging) return;
      const left = Math.min(cropState.startX, e.clientX);
      const top = Math.min(cropState.startY, e.clientY);
      const width = Math.abs(e.clientX - cropState.startX);
      const height = Math.abs(e.clientY - cropState.startY);
      cropState.rect = { left, top, width, height };
      cropBox.style.left = left + "px";
      cropBox.style.top = top + "px";
      cropBox.style.width = width + "px";
      cropBox.style.height = height + "px";
      cropDims.textContent = `${Math.round(width)} × ${Math.round(height)}`;
    });

    cropOverlay.addEventListener("pointerup", () => {
      if (!cropState?.dragging) return;
      const rect = cropState.rect;
      cropState.dragging = false;
      if (!rect || rect.width < 16 || rect.height < 16) {
        cropOverlay.classList.remove("has-selection");
        cropBox.hidden = true;
        return;
      }
      void captureRegionDom(rect);
    });

    // Annotation canvas handlers
    annotCanvas.addEventListener("pointerdown", (e) => {
      if (!annotState) return;
      e.preventDefault();
      const pt = canvasPoint(e);
      if (annotState.tool === "pen") {
        annotState.drawing = { tool: "pen", points: [pt] };
      } else {
        annotState.drawing = {
          tool: annotState.tool,
          x1: pt.x,
          y1: pt.y,
          x2: pt.x,
          y2: pt.y,
        };
      }
      annotCanvas.setPointerCapture?.(e.pointerId);
      redrawAnnotationCanvas();
    });

    annotCanvas.addEventListener("pointermove", (e) => {
      if (!annotState?.drawing) return;
      const pt = canvasPoint(e);
      if (annotState.drawing.tool === "pen") {
        annotState.drawing.points.push(pt);
      } else {
        annotState.drawing.x2 = pt.x;
        annotState.drawing.y2 = pt.y;
      }
      redrawAnnotationCanvas();
    });

    annotCanvas.addEventListener("pointerup", () => {
      if (!annotState?.drawing) return;
      annotState.ops.push(annotState.drawing);
      annotState.drawing = null;
      redrawAnnotationCanvas();
    });

    // =========================================================================
    // Panel Open/Close & Events
    // =========================================================================
    function setOpen(next) {
      state.open = next;
      panel.classList.toggle("is-open", next);
      toggleBtn.classList.toggle("is-open", next);
      toggleBtn.setAttribute("aria-expanded", String(next));
      if (next) {
        toggleIcon.classList.remove("toggle-brand");
        toggleIcon.innerHTML = ICONS.close;
      } else {
        toggleIcon.classList.add("toggle-brand");
        toggleIcon.innerHTML = `<img src="${escapeHtml(ASSETS.logo)}" alt="" width="28" height="28" />`;
      }
      if (next) {
        void fetchWidgetConfig();
        renderBody();
        requestAnimationFrame(() => inputEl.focus());
      }
    }

    root.addEventListener("click", (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;

      const zoomImg = target.closest("[data-zoom-src]");
      if (zoomImg) {
        lightboxImg.src = zoomImg.getAttribute("data-zoom-src") || "";
        lightbox.hidden = false;
        return;
      }

      const removeAttBtn = target.closest("[data-remove-att]");
      if (removeAttBtn) {
        const id = removeAttBtn.getAttribute("data-remove-att");
        const found = state.pendingAttachments.find((a) => a.id === id);
        if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
        state.pendingAttachments = state.pendingAttachments.filter((a) => a.id !== id);
        renderAttachmentsStrip();
        return;
      }

      const starterBtn = target.closest("[data-starter]");
      if (starterBtn) {
        const st = STARTERS[Number(starterBtn.getAttribute("data-starter"))];
        if (st) {
          inputEl.value = st.prompt;
          autoGrowInput();
          updateSendButton();
          inputEl.focus();
          inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        }
        return;
      }

      const kindTab = target.closest("[data-ticket-kind]");
      if (kindTab) {
        const item = state.items.find(
          (i) => i.id === kindTab.getAttribute("data-for") && i.type === "ticket",
        );
        if (item) {
          item.draft.kind = kindTab.getAttribute("data-ticket-kind");
          renderBody();
        }
        return;
      }

      const submitBtn = target.closest("[data-submit-ticket]");
      if (submitBtn) {
        void submitTicketCard(submitBtn.getAttribute("data-submit-ticket"));
        return;
      }

      const dismissBtn = target.closest("[data-dismiss-ticket]");
      if (dismissBtn) {
        const id = dismissBtn.getAttribute("data-dismiss-ticket");
        state.items = state.items.filter((i) => i.id !== id);
        renderBody();
        return;
      }

      const copyCodeBtn = target.closest("[data-copy-code]");
      if (copyCodeBtn) {
        const code = copyCodeBtn.getAttribute("data-copy-code") || "";
        navigator.clipboard?.writeText(code).catch(() => {});
        const span = copyCodeBtn.querySelector("span");
        if (span) {
          span.textContent = "已复制";
          setTimeout(() => {
            span.textContent = code;
          }, 1500);
        }
        return;
      }

      const annotToolBtn = target.closest("[data-annot-tool]");
      if (annotToolBtn && annotState) {
        annotState.tool = annotToolBtn.getAttribute("data-annot-tool");
        root.querySelectorAll("[data-annot-tool]").forEach((el) => {
          el.classList.toggle("is-active", el === annotToolBtn);
        });
        return;
      }

      const actionBtn = target.closest("[data-action]");
      if (!actionBtn) return;
      const action = actionBtn.getAttribute("data-action");
      if (action === "toggle") {
        setOpen(!state.open);
      } else if (action === "close") {
        setOpen(false);
      } else if (action === "dismiss-notice") {
        showNotice("");
      } else if (action === "reset") {
        state.abortController?.abort();
        state.items = [];
        showNotice("");
        renderBody();
      } else if (action === "quick-ticket") {
        openManualTicketCard();
      } else if (action === "send") {
        void sendChatMessage();
      } else if (action === "screenshot") {
        startCropMode();
      } else if (action === "pick-image") {
        fileInput.click();
      } else if (action === "close-lightbox") {
        lightbox.hidden = true;
        lightboxImg.src = "";
      } else if (action === "crop-cancel") {
        closeCropMode(true);
      } else if (action === "crop-full") {
        void captureRegionDom({
          left: 0,
          top: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        });
      } else if (action === "crop-display") {
        void captureViaDisplayMedia();
      } else if (action === "annot-undo" && annotState) {
        annotState.ops.pop();
        redrawAnnotationCanvas();
      } else if (action === "annot-retake") {
        closeAnnotationStudio(false);
        startCropMode();
      } else if (action === "annot-cancel") {
        closeAnnotationStudio(true);
      } else if (action === "annot-confirm" && annotState) {
        annotConfirmBtn.disabled = true;
        canvasToCompressedBlob(annotCanvas)
          .then(async (blob) => {
            closeAnnotationStudio(true);
            await uploadImageBlob(blob, "screenshot.webp");
          })
          .catch((err) => {
            closeAnnotationStudio(true);
            showNotice(err instanceof Error ? err.message : "导出截图失败");
          })
          .finally(() => {
            annotConfirmBtn.disabled = false;
          });
      }
    });

    root.addEventListener("input", (e) => {
      const target = e.target;
      if (target === inputEl) {
        autoGrowInput();
        updateSendButton();
        return;
      }
      if (target instanceof HTMLElement && target.hasAttribute("data-ticket-field")) {
        const fieldName = target.getAttribute("data-ticket-field");
        const item = state.items.find(
          (i) => i.id === target.getAttribute("data-for") && i.type === "ticket",
        );
        if (item && fieldName && "value" in target) {
          item.draft[fieldName] = target.value;
        }
      }
    });

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!sendBtn.disabled) {
          void sendChatMessage();
        }
      }
    });

    inputEl.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void handleFilesList(files);
      }
    });

    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files.length > 0) {
        void handleFilesList(fileInput.files);
        fileInput.value = "";
      }
    });

    panel.addEventListener("dragover", (e) => {
      e.preventDefault();
      panel.classList.add("is-dragover");
    });
    panel.addEventListener("dragleave", () => {
      panel.classList.remove("is-dragover");
    });
    panel.addEventListener("drop", (e) => {
      e.preventDefault();
      panel.classList.remove("is-dragover");
      if (e.dataTransfer?.files?.length) {
        void handleFilesList(e.dataTransfer.files);
      }
    });

    lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox) {
        lightbox.hidden = true;
        lightboxImg.src = "";
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!lightbox.hidden) {
        lightbox.hidden = true;
        lightboxImg.src = "";
      } else if (!annotModal.hidden) {
        closeAnnotationStudio(true);
      } else if (!cropOverlay.hidden) {
        closeCropMode(true);
      } else if (state.open) {
        setOpen(false);
      }
    });

    renderBody();
    document.body.appendChild(host);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
