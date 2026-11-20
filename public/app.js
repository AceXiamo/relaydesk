"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const paths = {
  layers: '<path d="m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  cube: '<path d="m3 7 9-5 9 5v10l-9 5-9-5zm0 0 9 5 9-5m-9 5v10"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  chevrons: '<path d="m8 9 4-4 4 4m-8 6 4 4 4-4"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  inbox: '<path d="M3 14 6 5h12l3 9v5H3zm0 0h5l2 3h4l2-3h5"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2c0-6.5 14-6.5 14 0v2"/>',
  terminal:
    '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m6 9 3 3-3 3m6 0h4"/>',
  plug: '<path d="m9 4 3 3m3-7 0 0m0 4 3 3M6 9l4-4 8 8-4 4a5 5 0 0 1-7-7l1-1m0 8-5 5"/>',
  sliders:
    '<path d="M4 6h5m5 0h6M4 12h10m5 0h1M4 18h3m5 0h8"/><circle cx="11.5" cy="6" r="2"/><circle cx="16.5" cy="12" r="2"/><circle cx="9.5" cy="18" r="2"/>',
  signal: '<path d="M4 19v-3m5 3v-6m5 6V9m5 10V5"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="m6 6 12 12m0-12L6 18"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 13V9m-3-8h6"/>',
  bars: '<path d="M4 20V9m7 11V3m7 17v-7"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  review:
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>',
  code: '<path d="m7 7-5 5 5 5m10-10 5 5-5 5M14 4l-4 16"/>',
  chat: '<path d="M21 11.5a8 8 0 0 1-8.5 8H9l-5.5 2 1.5-5a8.5 8.5 0 0 1-1.5-5c0-4.7 3.6-8.5 8.8-8.5 5.5 0 8.7 3.8 8.7 8.5z"/><path d="M8 10h8m-8 4h5"/>',
  pen: '<path d="m3 21 4-1 13-13-3-3L4 17zm11-14 3 3"/>',
  branch:
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10m12-8c0 5-5 6-12 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4H4v13h4"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
};
function svg(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ""}</svg>`;
}
function ico(name) {
  return `<span class="ico">${svg(name)}</span>`;
}
$$("i[data-icon]").forEach((el) => (el.innerHTML = svg(el.dataset.icon)));
function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
const labels = {
  triage: "待整理",
  ready: "待处理",
  working: "处理中",
  handoff: "交接中",
  waiting: "待补充",
  review: "待验收",
  done: "已完成",
};
const owners = { none: "未认领", human: "我", agent: "Local agent" };
const sources = { widget: "应用组件", bot: "群聊 Bot", console: "手动录入" };
const sourceIcons = { widget: "code", bot: "chat", console: "pen" };
const priorities = { low: "低", normal: "普通", high: "高", urgent: "紧急" };
const state = {
  projects: [],
  project: null,
  tasks: [],
  query: "",
  status: "",
  source: "",
  view: "queue",
  detail: null,
  epoch: 0,
  detailSeq: 0,
  connected: false,
  readError: false,
};
const main = $("#main"),
  modal = $("#form-dialog"),
  drawer = $("#detail");
const val = (id) => document.getElementById(id)?.value.trim() || "";
function options(items, current, first) {
  return (
    (first ? `<option value="">${esc(first)}</option>` : "") +
    Object.entries(items)
      .map(
        ([k, v]) =>
          `<option value="${esc(k)}"${k === current ? " selected" : ""}>${esc(v)}</option>`,
      )
      .join("")
  );
}
function select(id, items, current, first, label) {
  return `<label class="select-wrap"><select id="${id}" aria-label="${esc(label)}">${options(items, current, first)}</select>${ico("chevron")}</label>`;
}
function btn(label, action, icon, extra = "") {
  return `<button type="button" class="btn ${extra}" data-do="${action}">${icon ? ico(icon) : ""}${esc(label)}</button>`;
}
function showNotice(msg) {
  const el = $("#notice");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => (el.hidden = true), 3200);
}
async function api(path, method = "GET", data) {
  let res;
  try {
    res = await fetch(path, {
      method,
      cache: "no-store",
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
  } catch {
    throw Error("无法连接服务，请检查网络后重试。");
  }
  if (res.headers.get("X-Relaydesk-Auth") === "wallet") {
    if (res.status === 401) {
      location.replace("/login.html" + location.hash);
      throw Error("请重新登录");
    }
    document.querySelector("#sign-out").hidden = false;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Error(
      typeof json.error === "string"
        ? json.error
        : json.error?.message || `请求失败（${res.status}）`,
    );
  return json;
}
function online(ok) {
  state.connected = ok;
  $("#health-led").classList.toggle("ok", ok);
  $("#health-text").textContent = ok ? "服务已连接" : "服务连接中断";
}
function updateNav() {
  const p = state.project;
  $("#project-name").textContent = p?.name || "项目空间";
  $("#project-repo").textContent = p?.repo || "选择或创建项目";
  $("#nav-count").textContent = state.tasks.length;
  $$("[data-nav]").forEach((a) => {
    const is = a.dataset.nav === state.view;
    a.classList.toggle("active", is);
    if (is) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#project-menu").innerHTML =
    state.projects
      .map(
        (v) =>
          `<button type="button" data-project="${esc(v.id)}" class="${p?.id === v.id ? "current" : ""}">${ico("cube")}${esc(v.name)}</button>`,
      )
      .join("") +
    `<button type="button" data-do="new-project">${ico("plus")}创建项目</button>`;
}
function closeMenu() {
  $("#project-menu").hidden = true;
  $("#project-switch").setAttribute("aria-expanded", "false");
}
function closeNav() {
  document.body.classList.remove("nav-open");
  $("[data-nav-toggle]").setAttribute("aria-expanded", "false");
}
function readView() {
  const v = location.hash.slice(1);
  state.view = ["queue", "mine", "agents", "settings", "sources"].includes(v)
    ? v
    : "queue";
}
async function start(wanted) {
  const epoch = ++state.epoch;
  try {
    const { projects } = await api("/api/projects");
    if (epoch !== state.epoch) return;
    const id =
      [wanted, localStorage.getItem("relaydesk.project")].find((key) =>
        projects.some((p) => p.id === key),
      ) || projects[0]?.id;
    let project = null,
      tasks = [];
    if (id) {
      const responses = await Promise.all([
        api(`/api/projects/${encodeURIComponent(id)}`),
        api(`/api/projects/${encodeURIComponent(id)}/tasks`),
      ]);
      project = responses[0].project;
      tasks = responses[1].tasks;
    }
    if (epoch !== state.epoch) return;
    state.projects = projects;
    state.project = project;
    state.tasks = tasks;
    state.readError = false;
    if (id) localStorage.setItem("relaydesk.project", id);
    online(true);
    render();
  } catch (e) {
    if (epoch !== state.epoch) return;
    online(false);
    state.readError = true;
    main.innerHTML = `<div class="panel loading-error"><h2>无法读取项目空间</h2><p>${esc(e.message)}</p>${btn("重新连接", "retry")}</div>`;
  }
}
function render() {
  updateNav();
  if (state.readError) return;
  if (state.view === "settings" || state.view === "sources") renderSettings();
  else renderQueue();
  document.title =
    ($("#page-title")?.textContent || "项目工作台") + " · relaydesk";
}
function header(title, sub, action = "") {
  return `<div class="page-head"><div><h1 id="page-title">${esc(title)}</h1><p class="page-sub">${esc(sub)}</p></div>${action}</div>`;
}
function art() {
  return `<div class="flow-art" aria-hidden="true"><span class="node">${ico("chat")}</span><span class="wire"></span><span class="node core">${ico("layers")}</span><span class="wire"></span><span class="node">${ico("terminal")}</span></div>`;
}
function empty(title, sub, action) {
  return `<div class="empty-zone">${art()}<h2>${esc(title)}</h2><p>${esc(sub)}</p>${action}</div>`;
}
function badge(s) {
  return `<span class="badge ${esc(s)}">${esc(labels[s] || s)}</span>`;
}
function date(s, long = false) {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? "—"
    : new Intl.DateTimeFormat(
        "zh-CN",
        long
          ? {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }
          : { month: "short", day: "numeric" },
      ).format(d);
}
function taskNum(t) {
  return "RD-" + String(t.number).padStart(3, "0");
}
function scoped() {
  return state.tasks.filter((t) =>
    state.view === "mine"
      ? t.owner === "human"
      : state.view === "agents"
        ? t.owner === "agent"
        : true,
  );
}
function filtered() {
  const q = state.query.trim().toLowerCase();
  return scoped()
    .slice()
    .sort(
      (a, b) => b.updated_at.localeCompare(a.updated_at) || b.number - a.number,
    )
    .filter(
      (t) =>
        (!state.status || t.status === state.status) &&
        (!state.source || state.source === t.source) &&
        (!q ||
          [t.title, t.body, t.requirements, taskNum(t)]
            .join(" ")
            .toLowerCase()
            .includes(q)),
    );
}
function renderQueue() {
  const title = { queue: "反馈队列", mine: "我负责的", agents: "Agent 处理中" }[
    state.view
  ];
  const sub = {
    queue: "集中整理项目反馈，协调你与 local agent 的工作。",
    mine: "由你认领和接手的项目任务。",
    agents: "查看 local agent 当前领取的任务与交接进度。",
  }[state.view];
  main.innerHTML =
    header(title, sub, btn("新增反馈", "feedback", "plus", "primary")) +
    `<div class="metrics" id="metrics"></div><section class="queue-section" aria-label="任务列表"><div class="queue-toolbar"><label class="search-input">${ico("search")}<input type="search" id="search" maxlength="200" placeholder="搜索标题或编号…" aria-label="搜索标题或编号" value="${esc(state.query)}"></label><div class="tools">${select("status-filter", labels, state.status, "全部状态", "按状态筛选")}${select("source-filter", sources, state.source, "全部来源", "按反馈来源筛选")}</div></div><div id="rows"></div></section><section class="intake-section"><div class="section-heading"><h2>反馈入口</h2><a class="text-link" href="#sources">管理入口</a></div><div class="source-grid">${[
      ["widget", "收集应用内反馈"],
      ["bot", "从群聊中收集"],
      ["console", "直接录入任务"],
    ]
      .map(
        ([s, d]) =>
          `<button type="button" class="source-card" data-do="${s === "console" ? "feedback" : s}"><span class="tile">${ico(sourceIcons[s])}</span><span><strong>${sources[s]}</strong><small>${d}</small></span>${ico("right")}</button>`,
      )
      .join("")}</div></section>`;
  paintMetrics();
  paintRows();
}
function paintMetrics() {
  const tasks = scoped();
  $("#metrics").innerHTML = [
    ["", "全部任务", "layers", ""],
    ["ready", "待处理", "inbox", "amber"],
    ["working", "处理中", "terminal", "violet"],
    ["review", "待验收", "review", "green"],
  ]
    .map(
      ([s, label, icon, color]) =>
        `<button type="button" class="metric ${state.status === s ? "chosen" : ""}" data-stat="${s}" aria-pressed="${state.status === s}"><span class="metric-top"><span class="metric-icon ${color}">${ico(icon)}</span>${label}</span><strong>${s ? tasks.filter((t) => t.status === s).length : tasks.length}</strong></button>`,
    )
    .join("");
}
function paintRows() {
  const tasks = filtered(),
    hasFilters = state.status || state.query || state.source;
  let blank = "";
  if (!tasks.length) {
    if (!state.project)
      blank = empty(
        "创建你的第一个项目",
        "绑定代码仓库后，就可以在这里收集反馈、分配任务。",
        btn("创建项目", "new-project", "plus"),
      );
    else if (hasFilters)
      blank = empty(
        "没有匹配的任务",
        "调整筛选条件或尝试其他关键词。",
        btn("清除筛选", "clear"),
      );
    else if (state.view !== "queue")
      blank = empty(
        state.view === "mine" ? "还没有你负责的任务" : "Agent 暂未领取任务",
        state.view === "mine"
          ? "从反馈队列中认领任务后，会显示在这里。"
          : "未认领的待处理任务可由 local agent 领取。",
        '<a class="btn" href="#queue">查看反馈队列</a>',
      );
    else
      blank = empty(
        "队列里还没有反馈",
        "录入第一条反馈，或把收集组件接入你的应用。",
        btn("新增反馈", "feedback", "plus"),
      );
  }
  $("#rows").innerHTML =
    `<div class="table-scroll"><table class="task-table ${tasks.length ? "" : "empty-table"}"><thead class="${tasks.length ? "" : "empty-head"}"><tr>${["任务", "状态", "负责人", "来源", "更新"].map((t, i) => `<th class="${i === 4 ? "date-col" : ""}">${t}</th>`).join("")}</tr></thead><tbody>${tasks.map((t) => `<tr data-task="${esc(t.id)}"><td><button type="button" class="task-link"><span class="task-id">${esc(taskNum(t))}</span><span>${esc(t.title)}</span></button></td><td>${badge(t.status)}</td><td><span class="small-label">${t.owner === "none" ? "" : ico(t.owner === "agent" ? "terminal" : "user")}${esc(owners[t.owner] || t.owner)}</span></td><td><span class="small-label">${esc(sources[t.source] || t.source)}</span></td><td class="date-col"><span class="small-label">${esc(date(t.updated_at))}</span></td></tr>`).join("")}</tbody></table></div>${blank}<div class="table-foot"><span>共 ${tasks.length} 条任务</span><span>按最近更新排序</span></div>`;
}

const projPath = () => `/api/projects/${encodeURIComponent(state.project.id)}`;
const taskPath = (id) => `/api/tasks/${encodeURIComponent(id)}`;
function textField(id, label, value = "", attrs = "", hint = "") {
  return `<label class="field" for="${id}">${esc(label)}<input id="${id}" value="${esc(value)}" ${attrs}>${hint ? `<small>${esc(hint)}</small>` : ""}</label>`;
}
function textArea(id, label, value = "", attrs = "", hint = "") {
  return `<label class="field" for="${id}">${esc(label)}<textarea id="${id}" ${attrs}>${esc(value)}</textarea>${hint ? `<small>${esc(hint)}</small>` : ""}</label>`;
}
function projectFields(p = {}) {
  return (
    textField(
      "project-title",
      "项目名称",
      p.name,
      'required maxlength="100" placeholder="例如：客户工作台"',
    ) +
    textField(
      "project-git",
      "GitHub 仓库",
      p.repo,
      'required maxlength="200" placeholder="owner/repository"',
      "支持 owner/repository 或 GitHub 仓库地址。",
    ) + `<div class="field"><button class="btn" type="button" data-repos-page="1">从 GitHub 选择仓库</button><select aria-label="已授权仓库" data-repo-list hidden><option value="">选择仓库…</option></select><small data-repo-status role="status"></small></div>`
  );
}
function snippet(type) {
  const p = state.project,
    origin = location.origin;
  if (type === "widget")
    return `<script defer src="${origin}/widget.js" data-project="${p.id}" data-key="${p.intake_key}"><\/script>`;
  if (type === "agent")
    return `export RELAYDESK_URL='${origin}'\nexport RELAYDESK_PROJECT='${p.id}'\nread -rsp 'Agent key: ' RELAYDESK_AGENT_KEY; echo\nexport RELAYDESK_AGENT_KEY\npython3 agent/relay.py --repo ~/src/${p.repo.split("/").pop()} -- codex exec --sandbox workspace-write -`;
  return `export RELAY_URL='${origin}'\nexport RELAY_PROJECT='${p.id}'\nread -rsp 'Bot key: ' RELAY_BOT_KEY; echo\nexport RELAY_BOT_KEY\nread -rsp 'Telegram bot token: ' TELEGRAM_BOT_TOKEN; echo\nexport TELEGRAM_BOT_TOKEN\nexport TELEGRAM_CHAT_IDS='替换为群聊 ID'\npython3 integrations/telegram.py`;
}
function integrationCard(id, title, desc, icon, key) {
  return `<section class="panel" id="setup-${id}"><div class="panel-body"><div class="panel-title"><span class="tile">${ico(icon)}</span><h2>${esc(title)}</h2></div><p>${esc(desc)}</p><pre class="snippet">${esc(snippet(id))}</pre><div class="actions">${btn("复制配置", "copy-" + id, "copy")}${key ? btn("复制 " + key + " Key", "key-" + id, "lock") : ""}</div></div></section>`;
}
function renderSettings() {
  const p = state.project,
    settings = state.view === "settings";
  main.innerHTML = header(
    settings ? "项目设置" : "收集入口",
    settings
      ? "管理仓库绑定、项目级指令和 local agent 连接。"
      : "配置应用反馈组件和群聊收集机器人。",
  );
  if (settings) {
    main.insertAdjacentHTML("beforeend", `<form class="panel" data-form="github"><div class="panel-body"><h2>GitHub 连接</h2><p data-github-status role="status">正在检查连接…</p><label class="field">Personal access token<input type="password" name="token" required autocomplete="off" spellcheck="false"></label><small>工作空间共用此连接。选择需要的仓库，授予 Metadata 读取权限即可。</small><p class="error-text" role="alert"></p></div><div class="panel-foot"><button class="btn" type="button" data-do="disconnect-github" hidden>断开连接</button><button class="btn" type="submit">保存连接</button></div></form>`);
    const form = main.querySelector('[data-form="github"]');
    api("/api/github").then(({ configured }) => {
      githubStatus(form, configured);
    }).catch((error) => { form.querySelector("[data-github-status]").textContent = error.message; });
  }
  if (!p) {
    main.insertAdjacentHTML(
      "beforeend",
      `<div class="panel">${empty("先创建一个项目", "每个项目有独立的仓库、收集入口和反馈队列。", btn("创建项目", "new-project", "plus", "primary"))}</div>`,
    );
    return;
  }
  if (settings) {
    main.insertAdjacentHTML(
      "beforeend",
      `<form class="panel" data-form="settings"><div class="panel-body"><div class="panel-title"><span class="tile">${ico("branch")}</span><h2>项目配置</h2></div>${projectFields(p)}${textArea("project-instructions", "Agent 执行指令", p.agent_instructions, 'maxlength="8000" placeholder="例如：提交验收前运行项目测试。"', "项目级指令会随任务发送给本地执行器。")}<p class="hint">项目 ID <code>${esc(p.id)}</code></p><p class="error-text" role="alert"></p></div><div class="panel-foot"><button class="btn primary" type="submit">保存配置</button></div></form>` +
        integrationCard(
          "agent",
          "连接 local agent",
          "在 Relaydesk 源码目录运行。将 --repo 替换为本机绑定仓库的路径，并按提示输入 Agent Key。",
          "terminal",
          "Agent",
        ),
    );
  } else {
    main.insertAdjacentHTML(
      "beforeend",
      integrationCard(
        "widget",
        "应用反馈组件",
        "把脚本加入对应应用页面，用户即可通过反馈面板提交问题与需求。",
        "code",
      ) +
        `<form class="panel" data-form="origins"><div class="panel-body"><h2>组件允许来源</h2>${textArea("origins", "应用地址", (p.allowed_origins || []).join("\n"), 'placeholder="https://app.example.com"', "每行一个来源（协议与域名）。留空允许任意来源提交。")}<p class="error-text" role="alert"></p></div><div class="panel-foot"><button class="btn" type="submit">保存来源</button></div></form>` +
        integrationCard(
          "bot",
          "Telegram 群聊 Bot",
          "将 Bot 添加到目标群，在 Relaydesk 源码目录启动收集器。Bot Key 来自本项目，Telegram Token 由 BotFather 提供。",
          "chat",
          "Bot",
        ),
    );
  }
}
function githubStatus(form, configured) {
  form.querySelector("[data-github-status]").textContent = configured ? "已连接，可以在项目中选择仓库。" : "尚未连接";
  form.querySelector('[data-do="disconnect-github"]').hidden = !configured;
}
async function loadRepos(button) {
  const form = button.closest("form");
  const select = form.querySelector("[data-repo-list]");
  const status = form.querySelector("[data-repo-status]");
  const page = Number(button.dataset.reposPage);
  button.disabled = true;
  try {
    const { repos, more } = await api("/api/github/repos", "POST", { page });
    for (const name of repos) select.add(new Option(name, name));
    select.hidden = select.options.length <= 1;
    status.textContent = select.hidden ? "此 token 下没有可选的仓库。" : "";
    button.hidden = !more;
    button.dataset.reposPage = String(page + 1);
    button.textContent = "加载更多仓库";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
function formDialog(kind) {
  closeMenu();
  const isProject = kind === "project";
  modal.innerHTML = `<form data-form="${kind}"><div class="dialog-head"><h2 id="dialog-title">${isProject ? "创建项目" : "新增反馈"}</h2><button type="button" class="icon-btn" data-do="close-modal" aria-label="关闭">${ico("x")}</button></div><div class="dialog-body">${isProject ? projectFields() : textField("feedback-title", "标题", "", 'required maxlength="160" autofocus placeholder="简要描述问题或需求"') + textArea("feedback-body", "原始反馈", "", 'required maxlength="8000" placeholder="描述操作、观察到的结果与期望…"') + `<label class="field">优先级<select id="feedback-priority">${options(priorities, "normal")}</select></label>`}<p class="error-text" role="alert"></p></div><div class="dialog-foot">${btn("取消", "close-modal")}<button type="submit" class="btn primary">${isProject ? "创建项目" : "提交反馈"}</button></div></form>`;
  modal.setAttribute("aria-labelledby", "dialog-title");
  if (!modal.open) modal.showModal();
  modal.querySelector("input")?.focus();
}
function popDetail() {
  if (drawer.open) drawer.close();
  state.detail = null;
  state.detailSeq++;
}
async function openDetail(id, preserve = false) {
  const seq = ++state.detailSeq;
  const scroll = preserve ? drawer.scrollTop : 0;
  const previous = state.detail?.task.id;
  if (!preserve) {
    state.detail = null;
    drawer.innerHTML = `<div class="drawer-head"><h2>任务详情</h2>${btn("关闭", "close-detail")}</div><p class="loading">正在读取任务…</p>`;
  }
  if (!drawer.open) drawer.showModal();
  try {
    const result = await api(taskPath(id));
    if (seq !== state.detailSeq || !drawer.open) return;
    state.detail = result;
    renderDetail();
    drawer.scrollTop = previous === id ? scroll : 0;
  } catch (e) {
    if (seq !== state.detailSeq) return;
    drawer.innerHTML = `<div class="drawer-head"><h2>读取任务失败</h2>${btn("关闭", "close-detail")}</div><p class="panel-body">${esc(e.message)}</p>`;
  }
}
function eventBody(body) {
  const translations = {
    "Feedback received": "收到反馈",
    "Assigned to operator": "你认领了任务",
    "Released by operator": "你已释放任务",
    "Operator requested handoff": "已请求 agent 交接",
    "Operator took ownership and revoked the agent lease":
      "你已接手任务，旧 agent 的回写权已撤销",
    "Agent handed over task": "Agent 已交接",
    "Agent submitted task for review": "Agent 已提交验收",
    "Agent needs assistance": "Agent 需要补充信息",
    "Task created": "任务已创建",
  };
  if (translations[body]) return translations[body];
  if (body.startsWith("Updated requirements\n"))
    return body.replace("Updated requirements", "执行要求已更新");
  const [from, to] = body.split(" → ");
  return labels[from] && labels[to] ? `${labels[from]} → ${labels[to]}` : body;
}
function renderDetail() {
  const { task: t, messages = [], merged = [] } = state.detail;
  const eligible = state.tasks.filter(
    (o) =>
      o.id !== t.id &&
      !o.merged_into &&
      o.status !== "done" &&
      o.owner !== "agent",
  );
  const statuses = Object.fromEntries(
    Object.entries(labels).filter(
      ([s]) => s !== "handoff" && (s !== "working" || t.owner === "human"),
    ),
  );
  const ownerBtn =
    t.owner === "agent"
      ? t.status === "handoff"
        ? btn("强制接手", "force", "user", "danger")
        : btn("请求接手", "takeover", "user")
      : t.owner === "human"
        ? btn("释放认领", "release", "user")
        : t.status !== "done"
          ? btn("我来处理", "claim", "user")
          : "";
  drawer.setAttribute("aria-label", "任务详情");
  drawer.innerHTML = `<div class="drawer-head"><span>任务详情 / ${esc(taskNum(t))}</span><button type="button" class="icon-btn" data-do="close-detail" aria-label="关闭任务详情">${ico("x")}</button></div><div class="drawer-body"><h2>${esc(t.title)}</h2><div class="detail-meta">${badge(t.status)}<span class="small-label">${ico(t.owner === "agent" ? "terminal" : "user")}${esc(owners[t.owner])}</span><span class="small-label">${ico(sourceIcons[t.source])}${esc(sources[t.source])}</span><span class="small-label">优先级 · ${esc(priorities[t.priority])}</span></div><section class="drawer-section"><h3>原始反馈</h3><p>${esc(t.body || "未填写描述")}</p>${/^https?:\/\//i.test(t.source_url || "") ? `<a class="reference-link" href="${esc(t.source_url)}" target="_blank" rel="noopener noreferrer">查看反馈来源</a>` : ""}</section>
${t.merged_into ? `<section class="drawer-section"><h3>已并入主任务</h3><button type="button" class="btn" data-related="${esc(t.merged_into)}">打开主任务</button></section>` : `<section class="drawer-section"><h3>任务流转</h3><div class="actions status-row">${ownerBtn}${t.owner !== "agent" ? select("next-status", statuses, t.status, "", "任务状态") + btn("更新状态", "status") : ""}</div>${t.owner === "agent" ? `<p class="hint">最近同步 · ${date(t.last_seen, true)}</p>${t.status === "handoff" ? "<p>正在等待执行器停止并回传工作现场。</p>" : ""}` : ""}<p class="error-text" id="action-error" role="alert"></p></section><section class="drawer-section"><h3>执行要求</h3><p>${esc(t.requirements || "暂无单独确认的执行要求。")}</p><details><summary>编辑执行要求</summary><form data-form="requirements">${textArea("requirements-text", "确认后的要求", t.requirements, 'maxlength="24000"')}<p class="error-text" role="alert"></p><button class="btn" type="submit">保存要求</button></form></details></section>`}
${merged.length ? `<section class="drawer-section"><h3>关联反馈</h3><div class="actions">${merged.map((o) => `<button class="btn" type="button" data-related="${esc(o.id)}">${esc(taskNum(o))} ${esc(o.title)}</button>`).join("")}</div></section>` : ""}
<section class="drawer-section"><h3>任务讨论</h3><div class="thread-list">${messages.length ? messages.map((m) => `<article class="thread-item ${m.kind === "event" ? "log" : ""}"><div class="thread-meta"><strong>${esc({ human: "我", assistant: "项目助手", agent: "Local agent", system: "系统" }[m.author] || m.author)}</strong><time>${esc(date(m.created_at, true))}</time></div><p class="thread-body">${esc(m.kind === "event" ? eventBody(m.body) : m.body)}</p></article>`).join("") : "<p>还没有讨论记录。</p>"}</div><form data-form="message">${textArea("comment", "回复", "", 'required maxlength="8000" placeholder="留下备注，或与项目助手讨论这条反馈…"')}<div class="actions"><button type="submit" class="btn">添加备注</button><button type="submit" name="discuss" class="btn primary">询问项目助手</button></div><p class="error-text" role="alert"></p></form></section>
${!t.merged_into && t.owner !== "agent" && eligible.length ? `<section class="drawer-section"><details><summary>合并重复反馈</summary><form data-form="merge"><label class="field">主任务<select required id="merge-target"><option value="">选择主任务</option>${eligible.map((o) => `<option value="${esc(o.id)}">${esc(taskNum(o) + " " + o.title)}</option>`).join("")}</select></label><p class="hint">本单将关闭，原文与讨论会保留在关联反馈中。</p><button class="btn" type="submit">合并到主任务</button><p class="error-text" role="alert"></p></form></details></section>` : ""}</div>`;
}

async function refreshRows() {
  const p = state.project;
  if (!p) return;
  const { tasks } = await api(projPath() + "/tasks");
  if (state.project?.id !== p.id) return;
  state.tasks = tasks;
  online(true);
  updateNav();
  if ($("#rows")) {
    paintMetrics();
    paintRows();
  }
}
async function action(name, extra = {}) {
  const t = state.detail.task;
  await api(taskPath(t.id) + "/action", "POST", {
    action: name,
    version: t.version,
    ...extra,
  });
  await refreshRows();
  if (drawer.open && state.detail?.task.id === t.id)
    await openDetail(t.id, true);
}
function clearFilters() {
  state.query = "";
  state.status = "";
  state.source = "";
}
async function copyConfig(key) {
  const p = state.project;
  const value = key.startsWith("copy-")
    ? snippet(key.slice(5))
    : key === "key-agent"
      ? p.agent_key
      : p.bot_key;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.style.position = "fixed";
    field.style.left = "-9999px";
    document.body.append(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    if (!ok) throw Error("浏览器未允许复制。请检查剪贴板权限。");
  }
  showNotice(key.startsWith("copy-") ? "配置已复制" : "项目密钥已复制");
}
let requestAfterCreate = "";
async function uiAction(key, control) {
  switch (key) {
    case "disconnect-github": {
      await api("/api/github/disconnect", "POST", {});
      githubStatus(control.closest("form"), false);
      renderSettings();
      return;
    }
    case "retry":
      return start();
    case "new-project":
      requestAfterCreate = "";
      return formDialog("project");
    case "feedback":
      if (!state.project) {
        requestAfterCreate = "feedback";
        return formDialog("project");
      }
      return formDialog("feedback");
    case "close-modal":
      return modal.close();
    case "close-detail":
      return popDetail();
    case "clear":
      clearFilters();
      return render();
    case "widget":
    case "bot":
      if (!state.project) {
        requestAfterCreate = key;
        return formDialog("project");
      }
      location.hash = "sources";
      setTimeout(
        () => $("#setup-" + key)?.scrollIntoView({ block: "start" }),
        30,
      );
      return;
    case "claim":
    case "release":
    case "takeover":
      return action(key);
    case "force":
      if (
        confirm(
          "强制接手会撤销旧 agent 的回写权限。若执行器已掉线，本机进程可能仍在运行。确认接手？",
        )
      )
        return action("force_takeover");
      return;
    case "status":
      return action("status", { status: val("next-status") });
    default:
      if (key.startsWith("copy-") || key.startsWith("key-"))
        return copyConfig(key);
  }
}
async function handleForm(form, submitter) {
  const kind = form.dataset.form;
  if (kind === "github") {
    const token = form.elements.token;
    await api("/api/github/connect", "POST", { token: token.value.trim() });
    token.value = "";
    githubStatus(form, true);
    showNotice("GitHub 连接已保存");
    return;
  }
  if (kind === "project") {
    const { project } = await api("/api/projects", "POST", {
      name: form.querySelector("#project-title").value.trim(),
      repo: form.querySelector("#project-git").value.trim(),
    });
    const next = requestAfterCreate;
    requestAfterCreate = "";
    modal.close();
    clearFilters();
    await start(project.id);
    showNotice("项目已创建");
    if (next) await uiAction(next);
    return;
  }
  if (kind === "feedback") {
    const { task } = await api(projPath() + "/tasks", "POST", {
      title: val("feedback-title"),
      body: val("feedback-body"),
      priority: val("feedback-priority"),
    });
    modal.close();
    await refreshRows();
    await openDetail(task.id);
    return;
  }
  if (kind === "settings" || kind === "origins") {
    const data =
      kind === "settings"
        ? {
            name: form.querySelector("#project-title").value.trim(),
            repo: form.querySelector("#project-git").value.trim(),
            agent_instructions: val("project-instructions"),
          }
        : {
            allowed_origins: val("origins")
              .split(/\r?\n/)
              .map((v) => v.trim())
              .filter(Boolean),
          };
    const { project } = await api(projPath(), "PATCH", data);
    state.project = project;
    state.projects = state.projects.map((p) =>
      p.id === project.id ? project : p,
    );
    render();
    showNotice("项目配置已保存");
    return;
  }
  if (kind === "requirements")
    return action("requirements", { body: val("requirements-text") });
  if (kind === "merge")
    return action("merge", { target_id: val("merge-target") });
  if (kind === "message") {
    const id = state.detail.task.id;
    const mode = submitter?.name === "discuss" ? "discuss" : "messages";
    await api(`${taskPath(id)}/${mode}`, "POST", { body: val("comment") });
    await refreshRows();
    if (drawer.open && state.detail?.task.id === id) {
      await openDetail(id, true);
      drawer.scrollTop = drawer.scrollHeight;
    }
  }
}
async function quickSearch() {
  if (drawer.open) popDetail();
  if (modal.open) modal.close();
  closeNav();
  if (!$("#search")) location.hash = "queue";
  setTimeout(() => $("#search")?.focus(), 10);
}
document.addEventListener("click", async (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const picker = target.closest("[data-repos-page]");
  if (picker) return loadRepos(picker);
  if (target.closest("[data-nav-toggle]")) {
    const on = document.body.classList.toggle("nav-open");
    $("[data-nav-toggle]").setAttribute("aria-expanded", String(on));
    return;
  }
  if (target.closest("[data-quick-search]")) return quickSearch();
  if (target.closest("#project-switch")) {
    const menu = $("#project-menu");
    menu.hidden = !menu.hidden;
    $("#project-switch").setAttribute("aria-expanded", String(!menu.hidden));
    return;
  }
  if (!target.closest(".project-switch")) closeMenu();
  const project = target.closest("[data-project]");
  if (project) {
    closeMenu();
    closeNav();
    clearFilters();
    return start(project.dataset.project);
  }
  const stat = target.closest("[data-stat]");
  if (stat) {
    state.status = stat.dataset.stat;
    $("#status-filter").value = state.status;
    paintMetrics();
    paintRows();
    return;
  }
  if (target.closest("[data-nav]")) closeNav();
  const related = target.closest("[data-related]");
  if (related) return openDetail(related.dataset.related);
  const row = target.closest("[data-task]");
  if (row) return openDetail(row.dataset.task);
  const control = target.closest("[data-do]");
  if (!control) return;
  control.disabled = true;
  try {
    await uiAction(control.dataset.do, control);
  } catch (err) {
    const inline = drawer.open ? $("#action-error") : null;
    if (inline) {
      inline.textContent = err.message + " ";
      const refresh = document.createElement("button");
      refresh.className = "btn";
      refresh.textContent = "重新读取任务";
      refresh.onclick = () => openDetail(state.detail.task.id, true);
      inline.append(refresh);
    } else showNotice(err.message);
  } finally {
    control.disabled = false;
  }
});
document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (!form.dataset.form) return;
  e.preventDefault();
  if (form.dataset.busy) return;
  form.dataset.busy = "true";
  const buttons = $$("button", form);
  buttons.forEach((b) => (b.disabled = true));
  const msg = $(".error-text", form);
  if (msg) msg.textContent = "";
  try {
    await handleForm(form, e.submitter);
  } catch (err) {
    if (msg) {
      msg.textContent = err.message;
      if (state.detail && drawer.contains(form)) {
        const reload = document.createElement("button");
        reload.type = "button";
        reload.className = "btn";
        reload.textContent = "刷新任务详情";
        reload.onclick = () => openDetail(state.detail.task.id, true);
        msg.append(" ", reload);
      }
    } else showNotice(err.message);
  } finally {
    delete form.dataset.busy;
    buttons.forEach((b) => (b.disabled = false));
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    state.query = e.target.value;
    paintRows();
  }
});
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-repo-list]") && e.target.value) {
    e.target.closest("form").querySelector("#project-git").value = e.target.value;
  }
  if (e.target.id === "status-filter" || e.target.id === "source-filter") {
    state.status = val("status-filter");
    state.source = val("source-filter");
    paintMetrics();
    paintRows();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeMenu();
    closeNav();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    quickSearch();
  }
});
window.addEventListener("hashchange", () => {
  closeMenu();
  closeNav();
  if (drawer.open) popDetail();
  clearFilters();
  readView();
  render();
});
drawer.addEventListener("close", () => {
  if (!drawer.open) {
    state.detail = null;
    state.detailSeq++;
  }
});
function dialogBackdrop(e) {
  if (e.target !== this) return;
  const r = this.getBoundingClientRect();
  if (
    e.clientX < r.left ||
    e.clientX > r.right ||
    e.clientY < r.top ||
    e.clientY > r.bottom
  )
    this.close();
}
drawer.addEventListener("click", dialogBackdrop);
modal.addEventListener("click", dialogBackdrop);
$("#sign-out").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", "POST", {});
    location.replace("/login.html");
  } catch (error) {
    showNotice(error.message);
  }
});
let polling = false;
async function poll() {
  if (polling || document.hidden || modal.open || !state.project) return;
  polling = true;
  try {
    await refreshRows();
    const d = state.detail;
    if (
      drawer.open &&
      d &&
      !drawer.querySelector("details[open],form[data-busy]") &&
      !drawer.querySelector("textarea:focus,select:focus") &&
      !val("comment") &&
      !val("merge-target")
    ) {
      const fresh = state.tasks.find((t) => t.id === d.task.id);
      if (
        fresh &&
        (fresh.version !== d.task.version ||
          fresh.updated_at !== d.task.updated_at ||
          fresh.last_seen !== d.task.last_seen)
      )
        await openDetail(d.task.id, true);
    }
  } catch {
    online(false);
  } finally {
    polling = false;
  }
}
setInterval(poll, 6500);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});
readView();
start();
