/* RelayDesk feedback widget. Load with data-project and data-key. */
(() => {
  "use strict";
  const script = document.currentScript;
  if (!script?.src || !script.dataset.project || !script.dataset.key) return;
  const project = script.dataset.project;
  const origin = new URL(script.src).origin;
  const endpoint =
    origin + "/api/projects/" + encodeURIComponent(project) + "/intake";
  const key = script.dataset.key;

  function mount() {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; position: fixed; inset: auto 20px 20px auto; z-index: 2147483646;
          font: 15px/1.5 system-ui, -apple-system, sans-serif; color: #18181b; color-scheme: light; }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        button, textarea { font: inherit; }
        button { cursor: pointer; }
        .toggle, .primary { background: #18181b; color: #fff; border: 1px solid #18181b; }
        .toggle { display: flex; gap: 9px; align-items: center; margin-left: auto; padding: 9px 17px; border-radius: 24px;
          box-shadow: 0 3px 12px #0002; font-weight: 600; }
        svg { width: 18px; height: 18px; }
        section { display: flex; flex-direction: column; width: min(370px, calc(100vw - 32px)); max-height: calc(100dvh - 95px);
          margin-bottom: 10px; overflow: auto; border-radius: 14px; background: white; border: 1px solid #dedee2;
          box-shadow: 0 12px 50px #18181b22, 0 2px 7px #18181b0d; }
        header { display: flex; align-items: center; justify-content: space-between; padding: 12px 17px; border-bottom: 1px solid #e4e4e7; }
        h2 { margin: 0; font-size: 16px; font-weight: 650; }
        .close { border: 0; background: transparent; color: #52525b; padding: 2px 8px; font-size: 23px; }
        .content { padding: 17px; }
        .prompt { margin: 0 0 14px; }
        .choices, .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .choices { justify-content: flex-start; }
        .choices button, .secondary, .primary { border-radius: 7px; padding: 7px 13px; font-weight: 550; }
        .choices button, .secondary { border: 1px solid #d4d4d8; color: #27272a; background: white; }
        .choices button:hover, .secondary:hover { background: #f4f4f5; }
        .actions { margin-top: 12px; }
        textarea { display: block; width: 100%; min-height: 86px; resize: vertical; border: 1px solid #bdbdc5; border-radius: 8px; padding: 10px; color: #18181b; background: white; }
        button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid #3868dc; outline-offset: 2px; }
        button:disabled { opacity: .55; cursor: wait; }
        .answer { white-space: pre-wrap; overflow-wrap: anywhere; background: #f5f5f6; border-radius: 8px; padding: 9px 11px; margin: 0 0 12px; max-height: 25vh; overflow: auto; }
        .muted, label { font-size: 13px; color: #52525b; }
        label { display: flex; align-items: flex-start; gap: 6px; overflow-wrap: anywhere; }
        .error { color: #aa2525; margin: 8px 0 0; }
        @media(max-width: 480px) { :host { right: 12px; bottom: 12px; } }
      </style>
      <section role="dialog" aria-labelledby="relay-title" id="relay-panel" hidden>
        <header><h2 id="relay-title">项目反馈</h2><button class="close" type="button" aria-label="收起反馈面板">×</button></header>
        <div class="content"></div>
      </section>
      <button type="button" class="toggle" aria-expanded="false" aria-controls="relay-panel">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5h16v12H9l-5 4V5z"/><path d="M8 9h8m-8 4h5"/></svg>反馈
      </button>`;
    document.body.append(host);
    const panel = root.querySelector("section");
    const content = root.querySelector(".content");
    const toggle = root.querySelector(".toggle");
    const close = root.querySelector(".close");
    function element(type, text, className) {
      const el = document.createElement(type);
      if (text !== undefined) el.textContent = text;
      if (className) el.className = className;
      return el;
    }
    function button(text, className, handler) {
      const el = element("button", text, className);
      el.type = "button";
      el.addEventListener("click", handler);
      return el;
    }
    function setOpen(open) {
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      (open
        ? content.querySelector("textarea,button") || close
        : toggle
      ).focus();
    }
    toggle.onclick = () => setOpen(panel.hidden);
    close.onclick = () => setOpen(false);
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) {
        event.stopPropagation();
        setOpen(false);
      }
    });

    const initial = () => ({
      step: "kind",
      kind: "",
      description: "",
      expected: "",
      question: "",
      includePage: false,
      page: location.origin + location.pathname,
      id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join(""),
    });
    let draft = initial();
    function go(step) {
      draft.step = step;
      render();
      if (!panel.hidden)
        (content.querySelector("textarea,button") || close).focus();
    }
    function render() {
      content.replaceChildren();
      const prompt = (text) => content.append(element("p", text, "prompt"));
      const issue = draft.kind === "问题";
      if (draft.step === "kind") {
        prompt("你想反馈什么？");
        const choices = element("div", undefined, "choices");
        for (const [kind, label] of [
          ["问题", "遇到问题"],
          ["需求", "提出需求"],
        ]) {
          choices.append(
            button(label, "secondary", () => {
              draft.kind = kind;
              go("description");
            }),
          );
        }
        content.append(choices);
        return;
      }
      if (draft.step === "sent") {
        const ref = draft.number ? " #" + draft.number : "";
        prompt("反馈" + ref + " 已进入项目队列。");
        content.append(
          button("再写一条", "secondary", () => {
            draft = initial();
            go("kind");
          }),
        );
        return;
      }
      if (draft.step === "description" || draft.step === "expected") {
        const first = draft.step === "description";
        if (!first) content.append(element("p", draft.description, "answer"));
        const question = first
          ? issue
            ? "刚才做了什么？遇到了什么问题？"
            : "你希望这个应用能帮你做什么？"
          : draft.question ||
            (issue ? "你原本期待看到什么结果？" : "在什么场景下你会用到它？");
        prompt(question);
        const field = draft.step;
        const input = element("textarea");
        input.setAttribute("aria-label", question);
        input.maxLength = 1800;
        input.value = draft[field];
        input.oninput = () => {
          draft[field] = input.value;
          input.setCustomValidity("");
        };
        async function advance() {
          if (input.disabled) return;
          if (first && !input.value.trim()) {
            input.setCustomValidity("请先写下反馈内容。");
            input.reportValidity();
            return;
          }
          draft[field] = input.value.trim();
          if (first) {
            input.disabled = true;
            actions.querySelectorAll("button").forEach((el) => {
              el.disabled = true;
            });
            next.textContent = "整理中…";
            draft.question = "";
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            try {
              const response = await fetch(
                endpoint.replace(/intake$/, "clarify"),
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + key,
                  },
                  credentials: "omit",
                  referrerPolicy: "no-referrer",
                  signal: controller.signal,
                  body: JSON.stringify({ body: draft.description }),
                },
              );
              if (response.ok) {
                const result = await response.json();
                if (typeof result.reply === "string")
                  draft.question = result.reply.trim().slice(0, 400);
              }
            } catch {
              /* Use the local follow-up if the project assistant is offline. */
            } finally {
              clearTimeout(timer);
            }
          }
          go(first ? "expected" : "review");
        }
        input.onkeydown = (e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
            e.preventDefault();
            advance();
          }
        };
        const actions = element("div", undefined, "actions");
        actions.append(
          button("上一步", "secondary", () =>
            go(first ? "kind" : "description"),
          ),
        );
        if (!first)
          actions.append(
            button("跳过", "secondary", () => {
              draft.expected = "";
              go("review");
            }),
          );
        const next = button(first ? "继续" : "预览", "primary", advance);
        actions.append(next);
        content.append(input);
        if (first)
          content.append(
            element(
              "p",
              "继续后，项目助手会根据这段描述追问一次。确认发送后才会创建反馈单。",
              "muted",
            ),
          );
        content.append(actions);
        return;
      }
      prompt("确认发送到项目队列？");
      const body =
        draft.kind +
        "记录\n" +
        draft.description +
        (draft.expected
          ? "\n\n" +
            (draft.question || (issue ? "预期结果" : "使用场景")) +
            "\n" +
            draft.expected
          : "");
      content.append(element("p", body, "answer"));
      const pageLabel = element("label");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = draft.includePage;
      checkbox.onchange = () => {
        draft.includePage = checkbox.checked;
      };
      pageLabel.append(
        checkbox,
        document.createTextNode("附上页面地址 " + draft.page),
      );
      const actions = element("div", undefined, "actions");
      const error = element("p", "", "error");
      error.setAttribute("role", "alert");
      const back = button("修改", "secondary", () => go("description"));
      const send = button("发送反馈", "primary", async () => {
        send.disabled = back.disabled = checkbox.disabled = true;
        send.textContent = "发送中…";
        error.textContent = "";
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(endpoint, {
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
          if (!response.ok) throw new Error("HTTP " + response.status);
          const result = await response.json();
          draft.number = result.number;
          go("sent");
        } catch {
          error.textContent = "暂时无法确认是否送达。你的草稿还在，可以重试。";
          send.disabled = back.disabled = checkbox.disabled = false;
          send.textContent = "重试发送";
        } finally {
          clearTimeout(timer);
        }
      });
      actions.append(back, send);
      content.append(pageLabel, actions, error);
    }
    render();
  }
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });
})();
