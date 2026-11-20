/* RelayDesk feedback widget. Load with data-project, data-key, and optional data-theme="light|dark|auto". */
(() => {
  "use strict";
  const script = document.currentScript;
  if (!script?.src || !script.dataset.project || !script.dataset.key) return;

  const project = script.dataset.project;
  const origin = new URL(script.src).origin;
  const baseUrl = origin + "/api/projects/" + encodeURIComponent(project);
  const clarifyEndpoint = baseUrl + "/clarify";
  const intakeEndpoint = baseUrl + "/intake";
  const key = script.dataset.key;
  const rawTheme = (script.dataset.theme || "auto").trim().toLowerCase();
  const theme =
    rawTheme === "light" || rawTheme === "dark" || rawTheme === "auto"
      ? rawTheme
      : "auto";
  const MAX_CHARS = 1800;
  const isMac = /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent || "",
  );
  const shortcutLabel = isMac ? "⌘ + Enter" : "Ctrl + Enter";

  const STEPS = [
    { key: "kind", label: "选择类型" },
    { key: "description", label: "描述问题" },
    { key: "expected", label: "补充细节" },
    { key: "review", label: "确认发送" },
  ];

  const KINDS = [
    {
      id: "功能异常",
      title: "功能异常",
      sublabel: "报错、卡顿或结果不符合预期",
      tone: "bug",
      prompt: "刚才做了什么？遇到了什么异常？",
      placeholder: "描述操作步骤、报错提示或异常表现…",
      fallbackQuestion: "你原本期待看到什么结果？",
      fallbackSection: "预期结果",
      icon: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
    },
    {
      id: "改进建议",
      title: "改进建议",
      sublabel: "新功能想法或交互体验优化",
      tone: "idea",
      prompt: "你希望产品增加或改进什么？",
      placeholder: "描述你的想法、痛点或更顺手的交互方式…",
      fallbackQuestion: "在什么使用场景下你会用到这个改进？",
      fallbackSection: "使用场景",
      icon: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg>',
    },
    {
      id: "使用疑问",
      title: "使用疑问",
      sublabel: "操作流程不清楚或需要说明",
      tone: "question",
      prompt: "在使用过程中遇到了什么疑问？",
      placeholder: "说明你正在尝试完成的操作或困惑的地方…",
      fallbackQuestion: "你目前尝试过哪些操作或看到了什么界面？",
      fallbackSection: "补充背景",
      icon: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
    },
  ];

  const ICONS = {
    chat: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>',
    close:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    chevronRight:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    spinner:
      '<svg aria-hidden="true" class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    check:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    sparkle:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
    alert:
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
    copy: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    link: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  };

  function formatTicketCode(num) {
    if (num === undefined || num === null || num === "") return "";
    return "RD-" + String(num).padStart(3, "0");
  }

  function createDraftId() {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      return Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join("");
    }
    return (
      Date.now().toString(16) +
      Math.random().toString(16).slice(2) +
      Math.random().toString(16).slice(2)
    ).slice(0, 32);
  }

  function getKindMeta(kindId) {
    return KINDS.find((item) => item.id === kindId) || KINDS[0];
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
          z-index: 2147483646;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
          font-size: 14px;
          line-height: 1.5;
          -webkit-font-smoothing: antialiased;
          color-scheme: light;

          --rd-bg: rgba(255, 255, 255, 0.94);
          --rd-surface: #f8f9fb;
          --rd-surface-hover: #f1f3f7;
          --rd-input-bg: #ffffff;
          --rd-border: rgba(24, 24, 27, 0.10);
          --rd-border-strong: rgba(24, 24, 27, 0.18);
          --rd-text: #18181b;
          --rd-text-secondary: #52525b;
          --rd-text-muted: #71717a;
          --rd-accent: #4f46e5;
          --rd-accent-soft: rgba(79, 70, 229, 0.10);
          --rd-accent-text: #4338ca;
          --rd-primary-bg: #18181b;
          --rd-primary-hover: #27272a;
          --rd-primary-text: #ffffff;
          --rd-track: rgba(24, 24, 27, 0.09);
          --rd-success: #059669;
          --rd-success-soft: rgba(16, 185, 129, 0.12);
          --rd-warn: #d97706;
          --rd-danger: #dc2626;
          --rd-danger-bg: rgba(220, 38, 38, 0.08);
          --rd-danger-border: rgba(220, 38, 38, 0.22);
          --rd-bug-bg: rgba(244, 63, 94, 0.10);
          --rd-bug-fg: #e11d48;
          --rd-idea-bg: rgba(99, 102, 241, 0.11);
          --rd-idea-fg: #4f46e5;
          --rd-question-bg: rgba(14, 165, 233, 0.11);
          --rd-question-fg: #0284c7;
          --rd-shadow: 0 20px 54px -14px rgba(24, 24, 27, 0.20), 0 4px 14px -2px rgba(24, 24, 27, 0.08);
          --rd-toggle-shadow: 0 8px 24px -4px rgba(24, 24, 27, 0.28), 0 2px 6px rgba(24, 24, 27, 0.12);
          --rd-kbd-bg: #f4f4f5;
          --rd-kbd-border: #d4d4d8;
        }

        :host([data-theme="dark"]) {
          color-scheme: dark;
          --rd-bg: rgba(19, 20, 24, 0.94);
          --rd-surface: rgba(255, 255, 255, 0.04);
          --rd-surface-hover: rgba(255, 255, 255, 0.075);
          --rd-input-bg: rgba(9, 10, 13, 0.72);
          --rd-border: rgba(255, 255, 255, 0.10);
          --rd-border-strong: rgba(255, 255, 255, 0.20);
          --rd-text: #f4f4f5;
          --rd-text-secondary: #a1a1aa;
          --rd-text-muted: #71717a;
          --rd-accent: #818cf8;
          --rd-accent-soft: rgba(129, 140, 248, 0.14);
          --rd-accent-text: #a5b4fc;
          --rd-primary-bg: #f4f4f5;
          --rd-primary-hover: #ffffff;
          --rd-primary-text: #09090b;
          --rd-track: rgba(255, 255, 255, 0.10);
          --rd-success: #34d399;
          --rd-success-soft: rgba(52, 211, 153, 0.14);
          --rd-warn: #fbbf24;
          --rd-danger: #f87171;
          --rd-danger-bg: rgba(248, 113, 113, 0.12);
          --rd-danger-border: rgba(248, 113, 113, 0.28);
          --rd-bug-bg: rgba(251, 113, 133, 0.14);
          --rd-bug-fg: #fb7185;
          --rd-idea-bg: rgba(129, 140, 248, 0.16);
          --rd-idea-fg: #a5b4fc;
          --rd-question-bg: rgba(56, 189, 248, 0.15);
          --rd-question-fg: #38bdf8;
          --rd-shadow: 0 24px 64px -12px rgba(0, 0, 0, 0.70), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
          --rd-toggle-shadow: 0 10px 28px -4px rgba(0, 0, 0, 0.58), 0 0 0 1px rgba(255, 255, 255, 0.09);
          --rd-kbd-bg: rgba(255, 255, 255, 0.06);
          --rd-kbd-border: rgba(255, 255, 255, 0.14);
        }

        @media (prefers-color-scheme: dark) {
          :host([data-theme="auto"]) {
            color-scheme: dark;
            --rd-bg: rgba(19, 20, 24, 0.94);
            --rd-surface: rgba(255, 255, 255, 0.04);
            --rd-surface-hover: rgba(255, 255, 255, 0.075);
            --rd-input-bg: rgba(9, 10, 13, 0.72);
            --rd-border: rgba(255, 255, 255, 0.10);
            --rd-border-strong: rgba(255, 255, 255, 0.20);
            --rd-text: #f4f4f5;
            --rd-text-secondary: #a1a1aa;
            --rd-text-muted: #71717a;
            --rd-accent: #818cf8;
            --rd-accent-soft: rgba(129, 140, 248, 0.14);
            --rd-accent-text: #a5b4fc;
            --rd-primary-bg: #f4f4f5;
            --rd-primary-hover: #ffffff;
            --rd-primary-text: #09090b;
            --rd-track: rgba(255, 255, 255, 0.10);
            --rd-success: #34d399;
            --rd-success-soft: rgba(52, 211, 153, 0.14);
            --rd-warn: #fbbf24;
            --rd-danger: #f87171;
            --rd-danger-bg: rgba(248, 113, 113, 0.12);
            --rd-danger-border: rgba(248, 113, 113, 0.28);
            --rd-bug-bg: rgba(251, 113, 133, 0.14);
            --rd-bug-fg: #fb7185;
            --rd-idea-bg: rgba(129, 140, 248, 0.16);
            --rd-idea-fg: #a5b4fc;
            --rd-question-bg: rgba(56, 189, 248, 0.15);
            --rd-question-fg: #38bdf8;
            --rd-shadow: 0 24px 64px -12px rgba(0, 0, 0, 0.70), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
            --rd-toggle-shadow: 0 10px 28px -4px rgba(0, 0, 0, 0.58), 0 0 0 1px rgba(255, 255, 255, 0.09);
            --rd-kbd-bg: rgba(255, 255, 255, 0.06);
            --rd-kbd-border: rgba(255, 255, 255, 0.14);
          }
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
          width: min(392px, calc(100vw - 24px));
          max-height: calc(100dvh - 88px);
          margin-bottom: 12px;
          border-radius: 16px;
          background: var(--rd-bg);
          border: 1px solid var(--rd-border);
          box-shadow: var(--rd-shadow);
          backdrop-filter: blur(18px);
          -webkit-backdrop-filter: blur(18px);
          overflow: hidden;
          opacity: 0;
          transform: translateY(12px) scale(0.985);
          transform-origin: bottom right;
          transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1),
                      transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
          pointer-events: none;
        }

        .panel.is-open {
          opacity: 1;
          transform: translateY(0) scale(1);
          pointer-events: auto;
        }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 13px 16px 12px;
          border-bottom: 1px solid var(--rd-border);
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }

        .brand-dot {
          width: 22px;
          height: 22px;
          border-radius: 7px;
          background: var(--rd-primary-bg);
          color: var(--rd-primary-text);
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .brand-dot svg { width: 13px; height: 13px; }

        h2 {
          margin: 0;
          font-size: 14.5px;
          font-weight: 620;
          letter-spacing: -0.01em;
          color: var(--rd-text);
        }

        .close-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: var(--rd-text-secondary);
          transition: background-color 140ms ease, color 140ms ease;
        }
        .close-btn svg { width: 16px; height: 16px; }
        .close-btn:hover {
          background: var(--rd-surface-hover);
          color: var(--rd-text);
        }

        .progress {
          padding: 10px 16px 0;
        }

        .progress-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 7px;
          font-size: 11.5px;
          color: var(--rd-text-muted);
          font-variant-numeric: tabular-nums;
        }

        .progress-step-name {
          color: var(--rd-text-secondary);
          font-weight: 550;
        }

        .progress-bars {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 5px;
        }

        .progress-seg {
          height: 3px;
          border-radius: 999px;
          background: var(--rd-track);
          transition: background-color 220ms ease;
        }

        .progress-seg.is-active { background: var(--rd-accent); }
        .progress-seg.is-done { background: var(--rd-accent); opacity: 0.55; }
        .progress-seg.is-complete { background: var(--rd-success); opacity: 1; }

        .content {
          padding: 15px 16px 16px;
          overflow-y: auto;
          overscroll-behavior: contain;
        }

        .prompt-head {
          display: flex;
          align-items: center;
          gap: 7px;
          margin: 0 0 11px;
        }

        .ai-pill {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 7px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 560;
          background: var(--rd-accent-soft);
          color: var(--rd-accent-text);
          margin-bottom: 8px;
        }
        .ai-pill svg { width: 11px; height: 11px; }

        .prompt {
          margin: 0 0 12px;
          font-size: 14.5px;
          font-weight: 560;
          line-height: 1.45;
          color: var(--rd-text);
        }

        .kind-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .kind-card {
          display: flex;
          align-items: center;
          gap: 12px;
          width: 100%;
          padding: 11px 12px;
          border-radius: 12px;
          border: 1px solid var(--rd-border);
          background: var(--rd-surface);
          text-align: left;
          transition: border-color 150ms ease, background-color 150ms ease, transform 150ms ease;
        }

        .kind-card:hover {
          background: var(--rd-surface-hover);
          border-color: var(--rd-border-strong);
        }

        .kind-card:active { transform: scale(0.99); }

        .kind-icon {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .kind-icon svg { width: 17px; height: 17px; }
        .kind-icon.tone-bug { background: var(--rd-bug-bg); color: var(--rd-bug-fg); }
        .kind-icon.tone-idea { background: var(--rd-idea-bg); color: var(--rd-idea-fg); }
        .kind-icon.tone-question { background: var(--rd-question-bg); color: var(--rd-question-fg); }

        .kind-copy {
          min-width: 0;
          flex: 1;
        }

        .kind-title {
          display: block;
          font-size: 13.5px;
          font-weight: 600;
          color: var(--rd-text);
          line-height: 1.3;
        }

        .kind-sub {
          display: block;
          margin-top: 2px;
          font-size: 12px;
          color: var(--rd-text-secondary);
          line-height: 1.35;
        }

        .kind-arrow {
          color: var(--rd-text-muted);
          transition: transform 150ms ease, color 150ms ease;
        }
        .kind-arrow svg { width: 15px; height: 15px; }
        .kind-card:hover .kind-arrow {
          transform: translateX(2px);
          color: var(--rd-text-secondary);
        }

        .quote-box {
          margin: 0 0 12px;
          padding: 9px 11px;
          border-radius: 10px;
          background: var(--rd-surface);
          border: 1px solid var(--rd-border);
          font-size: 12.5px;
          line-height: 1.45;
          color: var(--rd-text-secondary);
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          max-height: 92px;
          overflow-y: auto;
        }

        .quote-label {
          display: block;
          font-size: 11px;
          font-weight: 560;
          color: var(--rd-text-muted);
          margin-bottom: 3px;
        }

        .field-wrap {
          border: 1px solid var(--rd-border-strong);
          border-radius: 11px;
          background: var(--rd-input-bg);
          transition: border-color 140ms ease, box-shadow 140ms ease;
          overflow: hidden;
        }

        .field-wrap:focus-within {
          border-color: var(--rd-accent);
          box-shadow: 0 0 0 3px var(--rd-accent-soft);
        }

        textarea {
          display: block;
          width: 100%;
          min-height: 102px;
          max-height: 220px;
          resize: vertical;
          border: 0;
          padding: 10px 12px 6px;
          background: transparent;
          color: var(--rd-text);
          line-height: 1.5;
          outline: none;
        }

        textarea::placeholder {
          color: var(--rd-text-muted);
        }

        textarea:disabled {
          opacity: 0.65;
          cursor: wait;
        }

        .field-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 6px 11px 8px;
          font-size: 11.5px;
          color: var(--rd-text-muted);
          border-top: 1px solid var(--rd-border);
          background: var(--rd-surface);
        }

        .shortcut-hint {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }

        kbd {
          display: inline-flex;
          align-items: center;
          padding: 1px 5px;
          border-radius: 5px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 10.5px;
          line-height: 1.4;
          background: var(--rd-kbd-bg);
          border: 1px solid var(--rd-kbd-border);
          color: var(--rd-text-secondary);
        }

        .char-count {
          font-variant-numeric: tabular-nums;
          font-size: 11.5px;
          color: var(--rd-text-muted);
        }
        .char-count.is-warn { color: var(--rd-warn); font-weight: 560; }
        .char-count.is-limit { color: var(--rd-danger); font-weight: 600; }

        .helper-note {
          margin: 9px 0 0;
          font-size: 12px;
          line-height: 1.45;
          color: var(--rd-text-muted);
        }

        .helper-note.is-loading {
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--rd-accent-text);
        }
        .helper-note.is-loading svg { width: 13px; height: 13px; }

        .review-card {
          border-radius: 12px;
          border: 1px solid var(--rd-border);
          background: var(--rd-surface);
          padding: 11px 12px;
          margin-bottom: 12px;
          max-height: 210px;
          overflow-y: auto;
        }

        .review-badge {
          display: inline-flex;
          align-items: center;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
          margin-bottom: 7px;
        }
        .review-badge.tone-bug { background: var(--rd-bug-bg); color: var(--rd-bug-fg); }
        .review-badge.tone-idea { background: var(--rd-idea-bg); color: var(--rd-idea-fg); }
        .review-badge.tone-question { background: var(--rd-question-bg); color: var(--rd-question-fg); }

        .review-text {
          margin: 0;
          font-size: 13px;
          line-height: 1.5;
          color: var(--rd-text);
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .review-divider {
          height: 1px;
          background: var(--rd-border);
          margin: 9px 0;
        }

        .review-subhead {
          margin: 0 0 3px;
          font-size: 11.5px;
          font-weight: 560;
          color: var(--rd-text-muted);
        }

        .page-check {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 8px 10px;
          border-radius: 10px;
          border: 1px solid var(--rd-border);
          background: var(--rd-surface);
          font-size: 12px;
          line-height: 1.4;
          color: var(--rd-text-secondary);
          cursor: pointer;
          overflow-wrap: anywhere;
        }

        .page-check input {
          margin: 2px 0 0;
          accent-color: var(--rd-accent);
          flex-shrink: 0;
          cursor: pointer;
        }

        .page-url {
          display: block;
          margin-top: 2px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 11px;
          color: var(--rd-text-muted);
        }

        .actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 14px;
        }

        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          height: 34px;
          padding: 0 13px;
          border-radius: 9px;
          font-size: 13px;
          font-weight: 560;
          transition: background-color 140ms ease, border-color 140ms ease, opacity 140ms ease, transform 120ms ease;
        }
        .btn svg { width: 14px; height: 14px; }
        .btn:active:not(:disabled) { transform: scale(0.98); }

        .btn-primary {
          border: 1px solid transparent;
          background: var(--rd-primary-bg);
          color: var(--rd-primary-text);
        }
        .btn-primary:hover:not(:disabled) { background: var(--rd-primary-hover); }

        .btn-secondary {
          border: 1px solid var(--rd-border-strong);
          background: transparent;
          color: var(--rd-text-secondary);
        }
        .btn-secondary:hover:not(:disabled) {
          background: var(--rd-surface-hover);
          color: var(--rd-text);
        }

        .btn-ghost {
          border: 1px solid transparent;
          background: transparent;
          color: var(--rd-text-muted);
          margin-right: auto;
          padding: 0 8px;
        }
        .btn-ghost:hover:not(:disabled) {
          background: var(--rd-surface-hover);
          color: var(--rd-text);
        }

        .btn:disabled {
          opacity: 0.55;
          cursor: wait;
        }

        .alert {
          display: flex;
          align-items: flex-start;
          gap: 7px;
          margin-top: 11px;
          padding: 9px 11px;
          border-radius: 10px;
          border: 1px solid var(--rd-danger-border);
          background: var(--rd-danger-bg);
          color: var(--rd-danger);
          font-size: 12.5px;
          line-height: 1.45;
        }
        .alert svg { width: 15px; height: 15px; margin-top: 1px; }

        .sent-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          padding: 10px 4px 4px;
        }

        .sent-icon {
          width: 44px;
          height: 44px;
          border-radius: 999px;
          background: var(--rd-success-soft);
          color: var(--rd-success);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 12px;
        }
        .sent-icon svg { width: 22px; height: 22px; }

        .sent-title {
          margin: 0;
          font-size: 15.5px;
          font-weight: 620;
          color: var(--rd-text);
        }

        .sent-sub {
          margin: 5px 0 0;
          font-size: 12.5px;
          color: var(--rd-text-secondary);
        }

        .ticket-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-top: 13px;
          padding: 5px 11px;
          border-radius: 999px;
          border: 1px solid var(--rd-border-strong);
          background: var(--rd-surface);
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 12.5px;
          font-weight: 600;
          letter-spacing: 0.02em;
          color: var(--rd-text);
          transition: background-color 140ms ease, border-color 140ms ease;
        }
        .ticket-pill:hover {
          background: var(--rd-surface-hover);
        }
        .ticket-pill svg { width: 13px; height: 13px; color: var(--rd-text-muted); }

        .sent-actions {
          display: flex;
          width: 100%;
          gap: 8px;
          margin-top: 18px;
        }
        .sent-actions .btn { flex: 1; }

        .toggle {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          height: 42px;
          padding: 0 16px;
          border-radius: 999px;
          border: 1px solid transparent;
          background: var(--rd-primary-bg);
          color: var(--rd-primary-text);
          font-size: 13.5px;
          font-weight: 600;
          letter-spacing: -0.01em;
          box-shadow: var(--rd-toggle-shadow);
          transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1),
                      background-color 140ms ease,
                      box-shadow 160ms ease;
        }
        .toggle svg { width: 16px; height: 16px; }
        .toggle:hover {
          background: var(--rd-primary-hover);
          transform: translateY(-1px);
        }
        .toggle:active { transform: translateY(0) scale(0.97); }

        button:focus-visible, input:focus-visible {
          outline: 2px solid var(--rd-accent);
          outline-offset: 2px;
        }

        @keyframes rd-spin {
          to { transform: rotate(360deg); }
        }
        .spin {
          animation: rd-spin 0.8s linear infinite;
        }

        @media (max-width: 480px) {
          :host { right: 12px; bottom: 12px; }
          .panel { width: calc(100vw - 24px); max-height: calc(100dvh - 80px); }
        }

        @media (prefers-reduced-motion: reduce) {
          .panel, .toggle, .btn, .kind-card, .kind-arrow, .progress-seg {
            transition: none !important;
          }
          .spin { animation: none !important; }
        }
      </style>
      <div class="shell">
        <section class="panel" role="dialog" aria-labelledby="relay-title" id="relay-panel" hidden>
          <header class="header">
            <div class="header-left">
              <span class="brand-dot" aria-hidden="true">${ICONS.chat}</span>
              <h2 id="relay-title">项目反馈</h2>
            </div>
            <button class="close-btn" type="button" aria-label="收起反馈面板">${ICONS.close}</button>
          </header>
          <div class="progress" aria-label="反馈进度">
            <div class="progress-meta">
              <span class="progress-step-name"></span>
              <span class="progress-step-count"></span>
            </div>
            <div class="progress-bars">
              <span class="progress-seg"></span>
              <span class="progress-seg"></span>
              <span class="progress-seg"></span>
              <span class="progress-seg"></span>
            </div>
          </div>
          <div class="content"></div>
        </section>
        <button type="button" class="toggle" aria-expanded="false" aria-controls="relay-panel">
          <span class="toggle-icon">${ICONS.chat}</span>
          <span class="toggle-label">反馈</span>
        </button>
      </div>
    `;

    document.body.append(host);

    const panel = root.querySelector(".panel");
    const content = root.querySelector(".content");
    const toggle = root.querySelector(".toggle");
    const toggleIcon = root.querySelector(".toggle-icon");
    const toggleLabel = root.querySelector(".toggle-label");
    const closeBtn = root.querySelector(".close-btn");
    const progressStepName = root.querySelector(".progress-step-name");
    const progressStepCount = root.querySelector(".progress-step-count");
    const progressSegs = Array.from(root.querySelectorAll(".progress-seg"));

    let isOpen = false;
    let closeTimer = null;

    function el(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }

    function iconSpan(svgMarkup, className) {
      const span = document.createElement("span");
      if (className) span.className = className;
      span.setAttribute("aria-hidden", "true");
      span.innerHTML = svgMarkup;
      return span;
    }

    function actionButton(text, className, handler) {
      const btn = el("button", text, "btn " + className);
      btn.type = "button";
      btn.addEventListener("click", handler);
      return btn;
    }

    function setButtonLoading(btn, loading, label) {
      btn.replaceChildren();
      if (loading) {
        btn.append(iconSpan(ICONS.spinner));
      }
      btn.append(document.createTextNode(label));
    }

    const initialDraft = () => ({
      step: "kind",
      kind: "",
      description: "",
      expected: "",
      question: "",
      questionFromAi: false,
      includePage: false,
      page: location.origin + location.pathname,
      id: createDraftId(),
      number: null,
    });

    let draft = initialDraft();

    function focusFirstInteractive() {
      const target =
        content.querySelector("textarea, button:not([disabled])") || closeBtn;
      if (target && typeof target.focus === "function") {
        target.focus();
      }
    }

    function setOpen(nextOpen) {
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      isOpen = nextOpen;
      toggle.setAttribute("aria-expanded", String(nextOpen));
      toggleIcon.innerHTML = nextOpen ? ICONS.close : ICONS.chat;
      toggleLabel.textContent = nextOpen ? "收起" : "反馈";

      if (nextOpen) {
        if (draft.step === "sent") {
          draft = initialDraft();
          render();
        }
        panel.hidden = false;
        requestAnimationFrame(() => {
          panel.classList.add("is-open");
          focusFirstInteractive();
        });
      } else {
        panel.classList.remove("is-open");
        const reduced =
          window.matchMedia &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const finishClose = () => {
          if (!isOpen) panel.hidden = true;
          closeTimer = null;
        };
        if (reduced) {
          finishClose();
        } else {
          closeTimer = setTimeout(finishClose, 220);
        }
        toggle.focus();
      }
    }

    toggle.addEventListener("click", () => setOpen(!isOpen));
    closeBtn.addEventListener("click", () => setOpen(false));

    function onEscape(event) {
      if (event.key === "Escape" && isOpen) {
        event.stopPropagation();
        setOpen(false);
      }
    }
    root.addEventListener("keydown", onEscape);
    window.addEventListener("keydown", onEscape);

    function updateProgress() {
      if (draft.step === "sent") {
        progressStepName.textContent = "已提交";
        progressStepCount.textContent = "4 / 4";
        progressSegs.forEach((seg) => {
          seg.className = "progress-seg is-complete";
        });
        return;
      }
      const idx = Math.max(
        0,
        STEPS.findIndex((s) => s.key === draft.step),
      );
      progressStepName.textContent = STEPS[idx].label;
      progressStepCount.textContent = idx + 1 + " / " + STEPS.length;
      progressSegs.forEach((seg, i) => {
        if (i < idx) seg.className = "progress-seg is-done";
        else if (i === idx) seg.className = "progress-seg is-active";
        else seg.className = "progress-seg";
      });
    }

    function go(step) {
      draft.step = step;
      render();
      if (isOpen) focusFirstInteractive();
    }

    function renderKindStep() {
      content.append(el("p", "你想反馈哪一类内容？", "prompt"));
      const list = el("div", undefined, "kind-list");

      for (const item of KINDS) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "kind-card";

        const iconBox = iconSpan(item.icon, "kind-icon tone-" + item.tone);
        const copy = el("span", undefined, "kind-copy");
        copy.append(
          el("span", item.title, "kind-title"),
          el("span", item.sublabel, "kind-sub"),
        );
        const arrow = iconSpan(ICONS.chevronRight, "kind-arrow");

        card.append(iconBox, copy, arrow);
        card.addEventListener("click", () => {
          draft.kind = item.id;
          go("description");
        });
        list.append(card);
      }

      content.append(list);
    }

    function renderTextStep(isDescription) {
      const kindMeta = getKindMeta(draft.kind);
      const field = isDescription ? "description" : "expected";

      if (!isDescription) {
        const quote = el("div", undefined, "quote-box");
        quote.append(
          el("span", kindMeta.title + " · 你的描述", "quote-label"),
          document.createTextNode(draft.description),
        );
        content.append(quote);

        if (draft.questionFromAi && draft.question) {
          const pill = el("div", undefined, "ai-pill");
          pill.append(
            iconSpan(ICONS.sparkle),
            document.createTextNode("项目助手追问"),
          );
          content.append(pill);
        }
      }

      const questionText = isDescription
        ? kindMeta.prompt
        : draft.question || kindMeta.fallbackQuestion;
      content.append(el("p", questionText, "prompt"));

      const fieldWrap = el("div", undefined, "field-wrap");
      const input = el("textarea");
      input.setAttribute("aria-label", questionText);
      input.placeholder = isDescription
        ? kindMeta.placeholder
        : "补充背景、预期效果或复现条件（可选）…";
      input.maxLength = MAX_CHARS;
      input.value = draft[field];

      const footer = el("div", undefined, "field-footer");
      const hint = el("span", undefined, "shortcut-hint");
      hint.append(
        el("kbd", shortcutLabel),
        document.createTextNode(isDescription ? "继续" : "预览"),
      );
      const counter = el("span", "", "char-count");

      function syncCounter() {
        const len = input.value.length;
        counter.textContent = len + " / " + MAX_CHARS;
        counter.className =
          "char-count" +
          (len >= MAX_CHARS ? " is-limit" : len >= MAX_CHARS - 200 ? " is-warn" : "");
      }
      syncCounter();

      footer.append(hint, counter);
      fieldWrap.append(input, footer);
      content.append(fieldWrap);

      const helperNote = el(
        "p",
        isDescription
          ? "继续后，项目助手会根据描述补充追问一次；确认发送后才会创建反馈单。"
          : "如果信息已经足够清楚，也可以直接跳过这一步。",
        "helper-note",
      );
      content.append(helperNote);

      const errorBox = el("div", undefined, "alert");
      errorBox.setAttribute("role", "alert");
      errorBox.hidden = true;
      content.append(errorBox);

      function showValidation(msg) {
        errorBox.replaceChildren(iconSpan(ICONS.alert), el("span", msg));
        errorBox.hidden = false;
      }

      input.addEventListener("input", () => {
        draft[field] = input.value;
        syncCounter();
        if (!errorBox.hidden && input.value.trim()) {
          errorBox.hidden = true;
        }
      });

      const actions = el("div", undefined, "actions");
      const backBtn = actionButton("上一步", "btn-ghost", () =>
        go(isDescription ? "kind" : "description"),
      );
      actions.append(backBtn);

      let skipBtn = null;
      if (!isDescription) {
        skipBtn = actionButton("跳过", "btn-secondary", () => {
          draft.expected = "";
          go("review");
        });
        actions.append(skipBtn);
      }

      let advancing = false;
      const nextBtn = actionButton(
        isDescription ? "继续" : "预览",
        "btn-primary",
        () => {
          void advance();
        },
      );
      actions.append(nextBtn);
      content.append(actions);

      async function advance() {
        if (advancing) return;
        const trimmed = input.value.trim();
        if (isDescription && !trimmed) {
          showValidation("请先简单写下你遇到的问题或建议。");
          input.focus();
          return;
        }
        errorBox.hidden = true;
        draft[field] = trimmed;

        if (isDescription) {
          advancing = true;
          input.disabled = true;
          backBtn.disabled = true;
          nextBtn.disabled = true;
          setButtonLoading(nextBtn, true, "整理中…");
          helperNote.className = "helper-note is-loading";
          helperNote.replaceChildren(
            iconSpan(ICONS.spinner),
            document.createTextNode("项目助手正在阅读描述并准备追问…"),
          );

          draft.question = "";
          draft.questionFromAi = false;

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          try {
            const response = await fetch(clarifyEndpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + key,
              },
              credentials: "omit",
              referrerPolicy: "no-referrer",
              signal: controller.signal,
              body: JSON.stringify({
                body: draft.description,
                expected: draft.expected || "",
              }),
            });
            if (response.ok) {
              const result = await response.json();
              if (typeof result.reply === "string" && result.reply.trim()) {
                draft.question = result.reply.trim().slice(0, 400);
                draft.questionFromAi = true;
              }
            }
          } catch {
            /* Fall back to local follow-up when project assistant is offline or times out. */
          } finally {
            clearTimeout(timer);
            advancing = false;
          }
        }

        go(isDescription ? "expected" : "review");
      }

      input.addEventListener("keydown", (event) => {
        if (
          event.key === "Enter" &&
          (event.ctrlKey || event.metaKey) &&
          !event.isComposing
        ) {
          event.preventDefault();
          void advance();
        }
      });
    }

    function renderReviewStep() {
      const kindMeta = getKindMeta(draft.kind);
      content.append(el("p", "确认内容后发送到项目队列", "prompt"));

      const body =
        draft.kind +
        "记录\n" +
        draft.description +
        (draft.expected
          ? "\n\n" +
            (draft.question || kindMeta.fallbackSection) +
            "\n" +
            draft.expected
          : "");

      const reviewCard = el("div", undefined, "review-card");
      reviewCard.append(
        el("span", kindMeta.title, "review-badge tone-" + kindMeta.tone),
        el("p", draft.description, "review-text"),
      );

      if (draft.expected) {
        reviewCard.append(
          el("div", undefined, "review-divider"),
          el("p", draft.question || kindMeta.fallbackSection, "review-subhead"),
          el("p", draft.expected, "review-text"),
        );
      }
      content.append(reviewCard);

      const pageLabel = el("label", undefined, "page-check");
      const checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.checked = draft.includePage;
      checkbox.addEventListener("change", () => {
        draft.includePage = checkbox.checked;
      });
      const pageCopy = el("span");
      pageCopy.append(
        document.createTextNode("附上当前页面地址"),
        el("span", draft.page, "page-url"),
      );
      pageLabel.append(checkbox, pageCopy);
      content.append(pageLabel);

      const errorBox = el("div", undefined, "alert");
      errorBox.setAttribute("role", "alert");
      errorBox.hidden = true;

      const actions = el("div", undefined, "actions");
      const backBtn = actionButton("修改", "btn-ghost", () =>
        go("description"),
      );
      const editDetailBtn = actionButton("补充细节", "btn-secondary", () =>
        go("expected"),
      );
      let submitting = false;
      const sendBtn = actionButton("发送反馈", "btn-primary", async () => {
        if (submitting) return;
        submitting = true;
        sendBtn.disabled =
          backBtn.disabled =
          editDetailBtn.disabled =
          checkbox.disabled =
            true;
        setButtonLoading(sendBtn, true, "发送中…");
        errorBox.hidden = true;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(intakeEndpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + key,
            },
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
            body: JSON.stringify({
              source: "widget",
              title: Array.from(draft.description.split("\n")[0])
                .slice(0, 100)
                .join(""),
              body,
              external_id: draft.id,
              ...(draft.includePage ? { source_url: draft.page } : {}),
            }),
          });
          if (!response.ok) {
            throw new Error("HTTP " + response.status);
          }
          const result = await response.json();
          draft.number = result.number;
          go("sent");
        } catch {
          errorBox.replaceChildren(
            iconSpan(ICONS.alert),
            el(
              "span",
              "暂时无法确认是否送达，你的草稿已完整保留，可以重试发送。",
            ),
          );
          errorBox.hidden = false;
          sendBtn.disabled =
            backBtn.disabled =
            editDetailBtn.disabled =
            checkbox.disabled =
              false;
          setButtonLoading(sendBtn, false, "重试发送");
        } finally {
          clearTimeout(timer);
          submitting = false;
        }
      });

      actions.append(backBtn, editDetailBtn, sendBtn);
      content.append(actions, errorBox);
    }

    function renderSentStep() {
      const wrap = el("div", undefined, "sent-wrap");
      wrap.append(
        iconSpan(ICONS.check, "sent-icon"),
        el("p", "反馈已进入项目队列", "sent-title"),
        el("p", "感谢反馈，团队与项目助手会尽快跟进处理。", "sent-sub"),
      );

      const ticketCode = formatTicketCode(draft.number);
      if (ticketCode) {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "ticket-pill";
        pill.title = "点击复制反馈单号";
        const label = el("span", ticketCode);
        const iconHolder = iconSpan(ICONS.copy);
        pill.append(label, iconHolder);
        pill.addEventListener("click", async () => {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(ticketCode);
              iconHolder.innerHTML = ICONS.check;
              setTimeout(() => {
                iconHolder.innerHTML = ICONS.copy;
              }, 1600);
            }
          } catch {
            /* Clipboard may be unavailable in embedded contexts. */
          }
        });
        wrap.append(pill);
      }

      const actions = el("div", undefined, "sent-actions");
      actions.append(
        actionButton("再写一条", "btn-secondary", () => {
          draft = initialDraft();
          go("kind");
        }),
        actionButton("完成", "btn-primary", () => {
          draft = initialDraft();
          setOpen(false);
          render();
        }),
      );
      wrap.append(actions);
      content.append(wrap);
    }

    function render() {
      updateProgress();
      content.replaceChildren();
      if (draft.step === "kind") {
        renderKindStep();
      } else if (draft.step === "description") {
        renderTextStep(true);
      } else if (draft.step === "expected") {
        renderTextStep(false);
      } else if (draft.step === "review") {
        renderReviewStep();
      } else {
        renderSentStep();
      }
    }

    render();
  }

  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });
})();
