# Local Agent Bridge、优先级路由与模型/思考强度设计方案

> 本文档为 Relaydesk 下一阶段迭代的技术设计与实现交接文档，涵盖四项紧密关联的能力：
> 1. **Local Agent Bridge（WSS 长连）**：本机单实例守护进程主动外连云端，在网页端直接驱动本机 Claude Code / Codex CLI 对话与执行。
> 2. **项目空间开放与工作目录绑定**：本机 Agent 绑定项目本地工作目录，同时安全同步并访问云端项目空间（`HANDBOOK.md`、`files/`、SQLite 及可选外部数据源）。
> 3. **执行优先级排序与自动降级（Priority Routing & Failover）**：按项目自定义节点优先级（如本机主力机 → 备用机 → 云端兜底），优先消耗本地订阅额度，离线/忙碌时自动顺延。
> 4. **模型目录推送、云端自定义模型补全与深度思考强度（Reasoning Effort）**：本机配置文件声明并实时同步模型元数据（上下文窗口、思考强度档位等），补全云端模型列表配置，并在对话栏提供模型 + 思考强度即时切换。

---

## 1. 总体架构

```text
                      ┌──────────────────────────────────────────┐
                      │         Browser (CodexChatView)          │
                      │  节点选择(自动/本机/云端) · 模型 · 思考强度  │
                      └───────────────────┬──────────────────────┘
                                          │ HTTP / SSE (ChatStreamEvent)
                                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Cloud Relaydesk Server (server.ts)                   │
│                                                                         │
│  ┌────────────────┐  ┌─────────────────────┐  ┌──────────────────────┐ │
│  │  ApiRouter     │  │ ExecutionRouter     │  │ BridgeHub (WSS)      │ │
│  │  /api/...      ├─►│ 优先级排序 & 降级调度 ├─►│ /api/bridge/ws       │ │
│  └────────────────┘  └──────────┬──────────┘  └──────────┬───────────┘ │
│                                 │                        │             │
│                      ┌──────────▼──────────┐             │ WSS (JSON)  │
│                      │ Cloud Local Runner  │             │ 双向复用通道 │
│                      │ (server/codex-chat) │             │             │
│                      └─────────────────────┘             │             │
└──────────────────────────────────────────────────────────┼─────────────┘
                                                           │ (主动外连，无需公网 IP)
                                                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│             Local Machine — Global Bridge Daemon (agent/bridge)         │
│                                                                         │
│  • 配置文件: ~/.config/relaydesk-bridge/config.json (热加载)             │
│  • 模型目录: 本地配置 + 可选导入 ~/.claude/settings.json & ~/.codex/      │
│  • 项目目录映射: projectId -> /path/to/local/repo (用户预备的工作目录)    │
│  • 空间影子镜像: ~/.cache/relaydesk-bridge/spaces/<projectId>/           │
│    ├── HANDBOOK.md                                                      │
│    └── files/  (云端项目空间增量同步，不污染本地 Git 工作区)               │
│  • 执行器: spawn(codex / claude) -> 解析为标准 ChatStreamEvent 回推云端   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 核心设计原则
1. **流式协议零分叉**：本机 Bridge 与云端 `server/codex-chat.ts` 共用同一套 CLI 参数构造器与流解析器（抽离到共享模块 `server/cli-stream-parser.ts`），本机直接回推标准 `ChatStreamEvent`，云端落库并原样转发给前端 SSE。
2. **一台本机一个全局 Bridge**：单个常驻进程连接云端，维护多项目目录映射、并发控制和统一模型目录，避免按项目起多份进程。
3. **本机订阅优先，云端平滑兜底**：项目可配置节点优先级顺序；在线且已绑定目录的本机节点优先承接，不可用时自动按序降级。
4. **不污染本地代码仓**：云端项目空间同步到 Bridge 独立的影子缓存目录，通过 CLI 的 `--add-dir` 与提示词注入暴露给 Agent，保持用户本地工作目录干净。

---

## 2. 执行优先级排序、项目空间访问与工作目录（重点复盘）

### Codex subagent visibility

With Codex v2 collaboration, `exec --json` can report a `wait` without naming a child. Relaydesk shows the wait as a tool call and reads child activity from the current parent thread’s local rollout when available. A missing rollout does not block the chat or turn a successful wait into a successful child task. For local execution, update and restart the bridge after active runs finish: updating the web server alone does not update the parser on the machine running Codex. Earlier saved messages are not backfilled.

### Chat interruption and timeouts

Sending a follow-up interrupts only the active run. The next turn starts after the previous reply and tool events have been saved. Stopping without a follow-up does not start another turn. A CLI thread is reused only on a compatible runtime, execution target and permission configuration; otherwise the next prompt uses saved conversation history.

The web server and local bridge each enforce the following chat timeouts. Set these environment variables on **both** services if overriding defaults; updating just the web server does not change an already installed bridge. Update the bridge client along with the server to remove the old fixed eight-minute deadline.

| Environment variable | Default | What it limits |
| --- | --- | --- |
| `RELAYDESK_CHAT_QUEUE_TIMEOUT_MS` | 480000 (8 min) | Waiting to start; time spent here does not consume the execution budget. |
| `RELAYDESK_CHAT_IDLE_TIMEOUT_MS` | 480000 (8 min) | Execution without reported progress. Output and tool events renew it; transport heartbeats do not. |
| `RELAYDESK_CHAT_TOTAL_TIMEOUT_MS` | 0 (unlimited) | Optional hard execution limit, starting after the queue phase. |

### 2.1 工作目录绑定机制
添加/接入本地 Agent 时，每个需要由该机器承接的项目都必须指定本地工作目录（用户预先准备好的代码库与环境依赖）：

- **绑定方式（双端协作，本机安全校验）**：
  1. **本地配置声明（推荐主路径）**：在 `~/.config/relaydesk-bridge/config.json` 的 `projects` 字段中配置 `projectId -> { workdir, allow_datasource_secrets? }`。Bridge 连上云端后，在 `hello` / `status.update` 中上报已映射项目及其校验状态（`path_ok`、`git_branch`、`has_dirty_files`）。
  2. **Web 端补充/修改（可选）**：若用户在本地配置中显式设置了 `allowed_roots`（例如 `["/Users/me/work"]`），则可在云端 Web 界面直接为该 Agent 填写或修改项目的本地工作目录；云端通过 WSS 下发 `project.bind`，Bridge 校验路径位于 `allowed_roots` 内且真实存在后再写入本地配置并回执。未配置 `allowed_roots` 时 Web 端仅展示只读路径。
- **未绑定目录的护栏**：如果某个项目尚未在某台 Local Agent 上绑定有效工作目录（`path_ok !== true`），该 Agent 在此项目的优先级调度中**自动跳过**，并在前端节点列表里灰显提示「未绑定项目目录」，防止误跑在 `$HOME` 或根目录下。

### 2.2 云端项目空间向 Local Agent 开放的完整闭环
项目空间（`server/workspace.ts`）包含 `HANDBOOK.md`、`files/`（文档、CSV、Fixture、SQLite 库）与外部数据源配置。本机执行时必须完整可读，并在可写模式下支持回写：

1. **增量影子镜像（Shadow Space Mirror）**：
   - Bridge 为每个项目维护独立缓存目录：`~/.cache/relaydesk-bridge/spaces/<projectId>/`，结构与云端完全一致：
     - `HANDBOOK.md`
     - `files/...`
   - 每次执行前（`chat.start` / `cli_run.start`），云端在启动载荷里附带当前项目空间的 **Manifest**（`handbook_sha256` + `files: [{ path, size, sha256, mtime }]` + `databases` 脱敏元数据）。
   - Bridge 比对本地影子目录缓存，仅针对缺失或哈希变化的文件，通过 WSS RPC（小文件 ≤ 2 MiB 直接走 `workspace.fetch` 帧）或带 Bridge Bearer Token 的 HTTPS 接口（大文件流式下载 `GET /api/bridge/projects/:id/workspace/file?path=...`）增量拉取；默认跳过 > 20 MiB 的超大二进制文件（保留索引提示，Agent 需要时可按需拉取）。
2. **CLI 挂载方式（零 Git 污染）**：
   - 子进程 `cwd` = 该项目绑定的**本地工作目录**（用户已准备好的代码与工具链）。
   - 同时把影子空间目录通过 `--add-dir <spaceDir>` 挂载进 Codex CLI 和 Claude Code（与现有 `server/codex-chat.ts` 挂载 `reposDir` 机制一致），并注入环境变量 `RELAYDESK_SPACE_DIR=<spaceDir>`。
   - 系统提示词明确告知 Agent：
     - `./` 是本地项目工作目录（真实代码与环境）。
     - `$RELAYDESK_SPACE_DIR/HANDBOOK.md` 是项目手册（同时内联摘要）。
     - `$RELAYDESK_SPACE_DIR/files/` 是云端项目空间文件与 SQLite 数据库。
     - 对话里 `@引用` 的文件、工单内容继续内联进提示词，与云端体验完全一致。
3. **可写模式回写（`workspace-write`）**：
   - 当会话为 `workspace-write` 时，Bridge 在本轮 CLI 结束前扫描 `$RELAYDESK_SPACE_DIR` 中相对于启动快照的新增/修改文件（限制在 `HANDBOOK.md`、`DEPLOY.md` 与 `files/` 下，`HANDBOOK.md` / `DEPLOY.md` 单文件 ≤ 64 KiB、`files/` 单文件 ≤ 20 MiB，自动过滤敏感路径）。
   - 将变更通过 `workspace.push`（或 HTTPS `PUT /api/bridge/projects/:id/workspace/file`）回写到云端项目空间，并在流事件中附带一条工具摘要（例如「已同步 2 个项目空间文件到云端」），使 Web 端的项目空间视图立即可见。
4. **外部数据源凭据边界**：
   - 外部数据源的**元信息**（名称、类型、`host_preview`、只读策略、`notes` Schema 说明）始终开放给本机 Agent。
   - 真实的 `connection_url`（`RELAYDESK_DB_*` 环境变量）默认**不下发**到本机，但支持在「项目 × Local Agent 绑定」上由管理员显式开启 `allow_datasource_secrets: true`（例如自己的可信主力 Mac）。开启后仅在当次 `chat.start` 的内存载荷中下发，Bridge 注入子进程 `env` 且不落盘，同时继续执行 `redactSecrets` 输出脱敏与 `PGOPTIONS` 只读护栏。

### 2.3 执行优先级排序与自动降级（Priority Routing）
为了让关联了个人订阅的本地 Agent 优先承接任务、最大化节省云端 API 费用，为每个项目引入可排序的**执行路由表**：

```ts
export interface ProjectRoutingConfig {
  /** 按优先级从高到低排列的目标列表，例如: ["local:<agentA>", "local:<agentB>", "cloud"] */
  priority: string[];
  /** 首选目标离线/忙碌/未就绪时，是否自动顺延到下一个目标（默认 true） */
  auto_fallback: boolean;
  /** 工单讨论与 PR 审计 (cli_runs) 是否也优先派发给在线本地 Agent（默认 true） */
  route_cli_runs: boolean;
}
```

#### 调度算法（`ExecutionRouter.resolveTarget`）
1. **候选列表确定**：
   - 若会话 `execution_target === "auto"`：读取项目的 `routing.priority`（若未配置，默认顺序为：**所有已绑定该项目目录的在线 Local Agent（按注册/排序顺序） → `cloud`**）。
   - 若会话显式锁定了 `execution_target = "local:<id>"` 或 `"cloud"`：仅检查该目标；若不可用则直接返回清晰错误并提示一键切回「自动路由」或「云端兜底」。
2. **逐项资格检查**（依次遍历 `priority`）：
   - **目标为 `local:<agentId>`**：
     1. Agent 处于 `online` 状态（最近心跳在 35s 内）；
     2. 已绑定当前项目且 `path_ok === true`；
     3. 当前机器检测到所选 `runtime`（`claude` / `codex`）可用；
     4. 当前活跃任务数 `< max_concurrency`（默认 2，可配置）。
   - **目标为 `cloud`**：
     1. 满足现有 `getChatRuntimeInfo` 可用条件（`local_clis` 存在且 auth_mode !== `"unavailable"`）。
3. **命中与透明反馈**：
   - 返回 `{ target, reason, skipped: Array<{ target, reason }> }`。
   - 在会话记录中写入 `resolved_target`，并在 SSE `session_updated` / `status` 事件中告知前端实际承接节点（例如 `由 MacBook Pro 执行（优先级 #1）` 或 `MacBook Pro 离线，已降级至云端执行`）。
4. **跨节点续聊处理**：
   - Claude Code 与 Codex CLI 的 `--resume` 会话状态存储在各自机器本地。
   - 若本轮解析出的 `resolved_target` 与上一轮不同（如 MacBook 离线后自动降级到云端，或用户手动切机）：
     - 自动忽略旧的 `external_session_id`（不复用另一台机器的 thread ID）；
     - 沿用现有 `buildInitialPrompt(..., priorMessages)` 注入历史对话上下文，实现无感续聊；
     - 本轮完成后将新机器产生的 `external_session_id` 与新的 `resolved_target` 写回 `chat_sessions`。
5. **延伸至工单讨论 & PR 审计（`cli_runs`）**：
   - 当 `routing.route_cli_runs === true` 且管理员触发工单讨论/PR 审计时，若存在优先排前的在线 Local Agent（且其开启了 `accept_cli_runs: true` 并已绑定该项目），服务端直接通过 WSS 派发 `cli_run.start` 给该本机执行（不再强制要求云端先填 API Key！）。
   - 若无合适本机在线，则维持原有逻辑回退到云端 `cli_runs` 队列由 `agent/cli_runner.py` 领取。
   - 安全约束不变：本机执行工单讨论与 PR 审计时强制只读权限（PR 审计校验 PR Head SHA 且不修改工作树、不自动 push/merge）。

---

## 3. 模型目录推送与云端自定义模型补全

### 3.1 统一的模型元数据 Schema（`ModelCatalogItem`）
本机推送的模型与云端配置的模型统一使用同一结构，前端无需区分来源渲染：

```ts
export type ChatReasoningEffort = "default" | "off" | "low" | "medium" | "high" | "max";

export interface ModelCatalogItem {
  /** 传给 CLI 的真实 model ID，如 "claude-opus-4-6"、"gpt-5.4"、"codex/gpt-5.4" */
  id: string;
  /** 展示名称（可选，缺省展示 id） */
  label?: string;
  /** 所属运行工具 */
  runtime: "claude" | "codex";
  /** 分组或提供方标签（可选，如 "Anthropic" / "OpenAI" / "自定义网关"） */
  provider?: string;
  /** 最大上下文窗口 token 数（可选，如 200000、1000000） */
  context_window?: number;
  /** 最大输出 token 数（可选） */
  max_output_tokens?: number;
  /** 是否支持调节思考强度（默认 true） */
  supports_effort?: boolean;
  /** 该模型支持的思考强度档位 */
  effort_levels?: Array<Exclude<ChatReasoningEffort, "default">>;
  /** 该模型的默认思考强度 */
  default_effort?: Exclude<ChatReasoningEffort, "default">;
  /** 是否为该 runtime 的默认推荐模型 */
  is_default?: boolean;
  /** 标签，如 ["reasoning", "fast", "coding"] */
  tags?: string[];
  /** 元数据来源（仅展示用） */
  source?: "bridge_config" | "cli_config" | "cloud_config" | "detected";
}
```

### 3.2 本机 Bridge 配置文件与 CLI 配置自动发现

受信任节点可在本机 bridge 配置中分别启用 `codex_full_access` 和 `claude_full_access`。两项默认关闭，只有 JSON 布尔值 `true` 才生效。授权覆盖该节点承接的所有已绑定项目。每个新回合和续聊都按当前回合的权限重新判定。

| 本机回合 | Codex | Claude |
| --- | --- | --- |
| 可写、允许联网，且对应 CLI 已启用全权限 | `exec` 和 `exec resume` 均使用 `--dangerously-bypass-approvals-and-sandbox` | `bypassPermissions`，可调用本机配置的 MCP 和内置工具 |
| 可写，关闭联网或未启用对应开关 | `workspace-write` 沙箱，按本回合设置限制命令联网 | 可写工具白名单 |
| 只读对话、工单讨论、PR 审计 | `read-only` 沙箱 | 只读工具白名单 |

全权限回合可访问运行 bridge 的系统账户有权使用的文件和服务，范围可超出项目工作目录。`allowed_roots` 约束项目目录绑定。数据源凭据下发仍由项目绑定的 `allow_datasource_secrets` 单独控制。关闭对应开关后，节点加载新配置，后续回合恢复受限模式，含已有线程的续聊。云端执行沿用云端权限配置。

配置文件路径默认 `~/.config/relaydesk-bridge/config.json`（权限 `0600`，可通过 `--config` 或 `RELAYDESK_BRIDGE_CONFIG` 覆盖）：

```json
{
  "server_url": "wss://relaydesk.example.com/api/bridge/ws",
  "agent_token": "rdbr_xxxxxxxxxxxxxxxx",
  "agent_name": "MacBook Pro (主力)",
  "max_concurrency": 2,
  "accept_cli_runs": true,
  "codex_full_access": false,
  "claude_full_access": false,
  "auto_detect_cli_configs": true,
  "allowed_roots": ["/Users/you/work"],
  "runtimes": {
    "claude": {
      "bin": "claude",
      "default_model": "claude-opus-4-6",
      "default_effort": "high",
      "extra_env": {}
    },
    "codex": {
      "bin": "codex",
      "default_model": "gpt-5.4",
      "default_effort": "high",
      "extra_env": {}
    }
  },
  "projects": {
    "0123456789abcdef0123456789abcdef": {
      "workdir": "/Users/you/work/my-app"
    }
  },
  "models": [
    {
      "id": "claude-opus-4-6",
      "label": "Claude Opus 4.6",
      "runtime": "claude",
      "context_window": 1000000,
      "supports_effort": true,
      "effort_levels": ["off", "low", "medium", "high", "max"],
      "default_effort": "high",
      "is_default": true
    },
    {
      "id": "claude-sonnet-4-6",
      "label": "Claude Sonnet 4.6",
      "runtime": "claude",
      "context_window": 1000000,
      "supports_effort": true,
      "effort_levels": ["off", "low", "medium", "high"],
      "default_effort": "medium"
    },
    {
      "id": "gpt-5.4",
      "label": "GPT-5.4 (Codex)",
      "runtime": "codex",
      "context_window": 400000,
      "supports_effort": true,
      "effort_levels": ["low", "medium", "high", "max"],
      "default_effort": "high",
      "is_default": true
    }
  ]
}
```

#### 自动读取本机 Claude / Codex 配置（`auto_detect_cli_configs: true`）
Bridge 启动及文件变更时按以下优先级合并模型目录（高优先级覆盖同 `runtime + id` 字段）：
1. **用户显式配置**：`config.json` 中的 `models`（最高优先级，支持声明自定义网关/代理的所有模型、自定义 `context_window` 与 `effort_levels`）。
2. **本机 CLI 原生配置解析（只读解析，绝不上报任何密钥/Token）**：
   - **Claude Code**：读取 `~/.claude/settings.json`（及 `~/.claude/settings.local.json`），提取 `model`、`availableModels` / `models`（如存在）、`env.ANTHROPIC_MODEL`、`env.ANTHROPIC_DEFAULT_OPUS_MODEL` / `SONNET` / `HAIKU`、`effortLevel` 等非敏感字段。
   - **Codex CLI**：读取 `~/.codex/config.toml`，提取顶级 `model`、`model_reasoning_effort`、各 `[profiles.*]` 下的 `model` 与 `model_reasoning_effort`。
   - **可选自定义模型表路径**：支持在 `config.json` 指定 `model_catalog_files: ["~/.claude/models.json"]`，方便用户复用已维护的本地模型清单。
3. **上下文窗口**按运行时和完整模型 ID 匹配。Bridge 优先保留显式填写的容量。Codex 读取顶级或对应 profile 的 `model_context_window`，其次读取 `models_cache.json` 的 `context_window`。Claude 可读取模型条目和选择器显式声明的窗口，也可从 `cache/model-capabilities.json` 的 `max_input_tokens` 补全。缓存变化会触发目录刷新。缺少可靠容量时，模型行省略窗口。内置表仍可补全 `effort_levels` 等其他元数据。
4. **热更新**：Bridge 使用 `fs.watch`（500ms 防抖）监听 `config.json` 与上述 CLI 配置文件，变更后自动推送 `catalog.sync` 给云端，无需重启；Web 端也提供「刷新目录」按钮触发 `catalog.refresh`。

### 3.3 云端自定义模型列表补全
扩展 `server/project-cli-config.ts` 与 `app/components/ProjectCliSettingsCard.tsx`：
- `ProjectCliSettings` 新增字段（保持向后兼容，老配置文件缺省为空数组和 `"default"`）：
  - `models?: ModelCatalogItem[]`（校验数量 ≤ 50、字段长度与合法字符，不含密钥；`maxSettingsBytes` 从 `16 KiB` 提升至 `64 KiB`）
  - `default_effort?: ChatReasoningEffort`
- `ProjectCliSettingsCard.tsx` 增强：
  - 保留「默认模型（可选）」输入框。
  - 新增「可选模型列表」区块：支持逐条添加/编辑/删除（模型 ID、别名、上下文窗口、是否支持思考强度及档位），也支持点击「从 API 地址拉取 `/v1/models`」一键导入（后端代为请求并遵循现有 `baseUrl` SSRF 校验）。
  - 保存后即时体现在 Web 对话栏的云端模型下拉中。

---

## 4. 深度思考强度（Reasoning / Thinking Effort）参数映射

新增会话字段 `reasoning_effort: ChatReasoningEffort`（`"default" | "off" | "low" | "medium" | "high" | "max"`）。
**重要**：同一执行节点内切换 `model` 或 `reasoning_effort` **不清空 `external_session_id`**，保持多轮连续上下文。

### 4.1 Claude Code CLI 映射
当 `reasoning_effort !== "default"` 时：
- **`"low" | "medium" | "high" | "max"`**：
  - 优先检测本机/云端 `claude --help` 是否支持 `--effort`（缓存检测结果）：
    - 支持：追加 `["--effort", effort]`；
    - 旧版回退：设置环境变量 `CLAUDE_CODE_EFFORT_LEVEL=<effort>`（或对 `max` 设置 `MAX_THINKING_TOKENS=31999`，`high=16000`，`medium=8000`，`low=2048`）。
- **`"off"`**：
  - 设置 `MAX_THINKING_TOKENS=0`（若新版 CLI 支持 `--effort none` / 关闭参数则按能力表传递）。

### 4.2 Codex CLI 映射
当 `reasoning_effort !== "default"` 时：
- 通过 `-c model_reasoning_effort="<mapped>"` 传递：
  - `"off"` → `"minimal"`（部分模型不支持 `minimal` 时降级为 `"low"`，可通过 `ModelCatalogItem.effort_levels` 约束前端选项避免无效档位）
  - `"low"` → `"low"`
  - `"medium"` → `"medium"`
  - `"high"` → `"high"`
  - `"max"` → `"xhigh"`

---

## 5. 数据模型与 SQLite Schema 变更（`server/store.ts`）

使用现有 `store.ts` 的幂等建表与 `ALTER TABLE` 迁移风格：

### 5.1 新增表：`bridge_agents`（全局本机 Agent 注册表）
```sql
CREATE TABLE IF NOT EXISTS bridge_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL DEFAULT '',
    hostname TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    bridge_version TEXT NOT NULL DEFAULT '',
    max_concurrency INTEGER NOT NULL DEFAULT 2,
    accept_cli_runs INTEGER NOT NULL DEFAULT 1,
    runtimes_json TEXT NOT NULL DEFAULT '{}',       -- {"claude":{"available":true,"version":"..."},"codex":{...}}
    models_json TEXT NOT NULL DEFAULT '[]',         -- ModelCatalogItem[]
    capabilities_json TEXT NOT NULL DEFAULT '{}',   -- {"allowed_roots_enabled":true,"db_clients":[...]}
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

### 5.2 新增表：`project_agent_bindings`（项目 ↔ Local Agent 工作目录与权限绑定）
```sql
CREATE TABLE IF NOT EXISTS project_agent_bindings (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES bridge_agents(id) ON DELETE CASCADE,
    workdir TEXT NOT NULL DEFAULT '',
    path_ok INTEGER NOT NULL DEFAULT 0,
    path_error TEXT NOT NULL DEFAULT '',
    allow_datasource_secrets INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, agent_id)
);
```

### 5.3 扩展表：`projects`
新增列：
- `execution_routing_json TEXT NOT NULL DEFAULT '{}'`
  - 存储 `ProjectRoutingConfig`：`{ priority: string[], auto_fallback: boolean, route_cli_runs: boolean }`。

### 5.4 扩展表：`chat_sessions`
新增列：
- `execution_target TEXT NOT NULL DEFAULT 'auto'`（`"auto"` | `"cloud"` | `"local:<agentId>"`）
- `resolved_target TEXT NOT NULL DEFAULT ''`（实际执行上次回复的节点，如 `"local:<agentId>"` 或 `"cloud"`）
- `reasoning_effort TEXT NOT NULL DEFAULT 'default'`（`ChatReasoningEffort`）

> 兼容策略：已有历史会话自动迁移为 `execution_target='auto'`、`reasoning_effort='default'`；若之前已有 `external_session_id` 且 `resolved_target=''`，默认视作 `'cloud'`。

---

## 6. WSS 协议设计（`/api/bridge/ws`）

### 6.1 连接与鉴权
- **服务端挂载**：在 `server.ts` 的 `http.Server` 上监听 `upgrade` 事件，仅拦截路径 `/api/bridge/ws`（使用 `ws` 包的 `WebSocketServer({ noServer: true })`）。
- **鉴权**：HTTP Upgrade 请求必须携带 `Authorization: Bearer <agent_token>`，服务端计算 SHA-256 与 `bridge_agents.token_hash` 常量时间比对；失败直接返回 `HTTP/1.1 401 Unauthorized` 并销毁 socket（严禁把 token 放在 URL query 中）。
- **单连接互斥**：同一 `agent_id` 新连入时，优雅关闭旧连接（close code `4001: Replaced by newer connection`），避免僵尸连接并发冲突。
- **心跳与离线判定**：服务端每 15s 发送 WS ping，距最后一次 pong 超过 35s 后，在下一次检查时断开连接。节点离线期间不接受新回合，没有可用的项目写入租约。
- **换网后接回聊天**：新版 Bridge 在 `hello` 中上报进程随机标识 `chat_instance` 和仍持有的 `resume_runs`；新版 Web 以 `chat_reconnect_ms` 和 `resumed_runs` 确认。异常断开后默认等待 30 秒，仅允许原设备、原进程和有效的原项目绑定接回。面板保留已收到的进度，接回后以正文快照校正丢失的增量；最终结果含工具记录。不会重新启动 CLI，也不重试已发出的 RPC。超期、旧版本、服务重启或撤销授权时，原回合不会自动重跑。
- **浏览器切网**：已登记的回合只重新读取历史、订阅现有 SSE；浏览器断线不等于 CLI 失败。
- **反代注意事项（Traefik / Nginx）**：WSS 路径 `/api/bridge/ws` 需确保反代允许 Upgrade 头且读超时 ≥ 60s（15s ping 保活即可防空闲断连）。

聊天输入框中的「上下文」是本轮 Harness 最近一次上报的占用量，与模型列表里的目录容量不同。只有本次执行上报了窗口时才计算百分比；只有用量时显示 token 数，无可用数据时显示「用量未上报」。消息流重连时从快照恢复；结束后刷新页面仍可查看。之前版本的历史对话不会回填推测值。 Codex 读取当前线程的最后一次 `last_token_usage.total_tokens`，Claude 按主调用的输入（含缓存）统计；两个运行时均不使用累计账单。

Codex 输入栏中的闪电按钮控制当前会话的 GPT Fast。点亮表示已开启；可用性由所选模型和节点决定，未知或不支持时不可切换。Claude 不展示该按钮。

### 6.2 消息信封与核心帧类型
所有帧为 UTF-8 JSON，统一格式 `{ type, id?, ts, payload }`：

| 方向 | `type` | 说明 |
| --- | --- | --- |
| Bridge → Cloud | `hello` | 首帧握手：上报 `hostname`、`platform`、`bridge_version`、`max_concurrency`、`accept_cli_runs`、`runtimes`、`models: ModelCatalogItem[]`、`projects: [{ project_id, workdir, path_ok, path_error }]`、`db_clients`、`allowed_roots_enabled`。 |
| Cloud → Bridge | `hello.ack` | 握手确认：下发 `agent_id`、`agent_name`、云端记录的项目绑定覆盖项（如有）。 |
| Bridge → Cloud | `catalog.sync` | 配置文件热更新或收到刷新指令后，全量同步最新 `runtimes`、`models` 与 `projects` 绑定状态。 |
| Cloud → Bridge | `catalog.refresh` | 请求 Bridge 重新探测 CLI 与读取配置文件并回复 `catalog.sync`。 |
| Cloud → Bridge | `project.bind` | Web 端修改项目工作目录时下发 `{ project_id, workdir }`；Bridge 校验 `allowed_roots` 后回复 `project.bind.result`。 |
| Cloud → Bridge | `chat.start` | 启动一轮对话执行：`{ run_id, session_id, project_id, runtime, model, reasoning_effort, sandbox_mode, network_access, resume_session_id, prompt, system_context, workspace_manifest, datasource_env? }`。 |
| Bridge → Cloud | `chat.event` | 流式回推：`{ run_id, session_id, event: ChatStreamEvent }`（复用 `status` / `reasoning` / `tool` / `text_delta` / `text_replace` / `done` / `error`）。只有 `hello.ack.context_usage` 为 `true` 时才发送 `context_usage`，载荷仅包含 `used_tokens` 和可选的 `window_tokens`。 |
| Cloud → Bridge | `chat.received` | 已收到终态结果，Bridge 可以释放缓存；仅在协商支持重连时发送。 |
| Bridge → Cloud | `chat.lost` | 原运行在重连握手期间已结束，不再有执行可以接回。 |
| Cloud → Bridge | `chat.abort` | 中止正在运行的对话：`{ run_id, session_id }`；Bridge 终止子进程组并回推中止状态。 |
| Bridge ↔ Cloud | `workspace.fetch` / `workspace.fetch.result` | 按路径拉取 ≤ 2 MiB 的云端项目空间文件或 `HANDBOOK.md`（大于 2 MiB 走带 Bearer Token 的 HTTPS 流式下载接口）。 |
| Bridge ↔ Cloud | `workspace.push` / `workspace.push.result` | `workspace-write` 模式下将本地空间影子目录的变更文件回写至云端项目空间。 |
| Cloud → Bridge | `cli_run.start` / `cli_run.abort` | （Phase 3）优先派发工单讨论 / PR 审计任务给本机执行。 |
| Bridge → Cloud | `cli_run.progress` / `cli_run.done` | （Phase 3）回报工单讨论 / PR 审计进度与最终结果。 |

---

## 7. HTTP API 变更（`server/api.ts`）

所有操作员接口沿用现有 `checkOperator`（钱包 / Admin Token / 本机回环）鉴权：

### 7.1 全局 Local Agents 管理
- `GET /api/bridge/agents`：列出所有已注册 Local Agents（含在线态、活跃任务数、runtimes、models 数量、已绑定项目、last_seen_at）。
- `POST /api/bridge/agents`：创建新 Local Agent，返回 `{ agent, token, quickstart_config }`（**原始 token 仅此一次返回**）。
- `PATCH /api/bridge/agents/:agentId`：修改名称、启用状态或备注。
- `POST /api/bridge/agents/:agentId/rotate-token`：轮换设备 Token（立即断开旧 WSS 连接）。
- `POST /api/bridge/agents/:agentId/refresh`：向在线 Bridge 发送 `catalog.refresh`。
- `DELETE /api/bridge/agents/:agentId`：注销设备并断开连接。

### 7.2 项目路由优先级与目录绑定
- `GET /api/projects/:id/execution-routing`：获取项目当前 `routing` 排序配置、可用目标列表（含在线态、绑定目录状态、可用 runtime 及对应 `ModelCatalogItem[]` 目录）。
- `PATCH /api/projects/:id/execution-routing`：保存优先级排序 `priority`、`auto_fallback`、`route_cli_runs`。
- `PATCH /api/projects/:id/agent-bindings/:agentId`：更新该项目在某台 Agent 上的 `workdir`（需 Agent 在线且开启 `allowed_roots`）、`allow_datasource_secrets`、`enabled`。

### 7.3 云端项目 CLI 模型配置增强
- `GET / PATCH /api/projects/:id/cli-config`：扩展支持 `models: ModelCatalogItem[]` 与 `default_effort`。
- `POST /api/projects/:id/cli-config/discover-models`：使用当前保存（或本次表单提供且通过 SSRF 校验）的 Endpoint + API Key 请求 `/v1/models`，返回候选模型列表供前端勾选导入。

### 7.4 对话会话接口扩展
- `GET /api/projects/:id/codex-chat/runtime`：扩展返回：
  - `execution_targets`：按项目优先级排好序的所有目标（`auto` 虚拟项 + 各 `local:<id>` + `cloud`），含在线态、绑定状态、`models: ModelCatalogItem[]`。
  - `routing`：当前项目的 `ProjectRoutingConfig`。
- `POST / PATCH /api/projects/:id/codex-chat/sessions[/:sessionId]`：支持读写 `execution_target`、`model`、`reasoning_effort`。
- `POST /api/projects/:id/codex-chat/sessions/:sessionId/messages`：
  - 通过 `ExecutionRouter` 解析最终目标；
  - 命中 `cloud` 走本地 `runCodexChatTurn`；
  - 命中 `local:<agentId>` 走 `BridgeHub.runChatTurn`，事件流经同一套落库 + SSE 推送管道。

### 7.5 Bridge 大文件同步接口（Bearer `<agent_token>` 鉴权）
- `GET /api/bridge/projects/:id/workspace/file?path=...`：流式下载项目空间文件（校验该 Agent 已绑定此项目）。
- `PUT /api/bridge/projects/:id/workspace/file?path=...`：回写项目空间文件（校验 `workspace-write` 活跃租约 + 路径安全）。

---

## 8. 前端 UI / UX 设计

### 8.1 对话输入框底部控制栏（`app/components/agent-chat/AgentPrimitives.tsx` & `CodexChatView.tsx`）
保持当前简洁的药丸风格，将原来的「Runtime / Model」单药丸升级为三个紧凑联动控件：

1. **执行节点药丸（Target Pill）**：
   - 默认显示 `自动 · MacBook Pro`（绿色呼吸点 + 优先级命中提示；若本机离线降级则显示 `自动 · 云端兜底` 琥珀色点）。
   - 点击展开 Popover：
     - 顶部选项：`自动按优先级路由（推荐）`，下方小字列出当前项目的排序链路（如 `MacBook Pro → 云端`）。
     - 各 Local Agent 项：显示在线状态点、机器名、已绑定目录路径（未绑定目录则灰显提示）、当前忙碌数。
     - `云端执行器` 项：显示云端 CLI 就绪态。
2. **Runtime + 模型 Combobox 药丸**：
   - 切换 Claude / Codex 后，列表即时切换为**当前目标节点上报的 `ModelCatalogItem[]`**（云端目标读云端配置列表，本机目标读 Bridge 推送列表）。
   - 每条模型展示：`label`、`id`（monospace）、上下文窗口徽章（如 `1M`、`200K`）、默认标记。
   - 顶部带搜索与**自由输入**能力：输入未在列表里的自定义模型名回车即可直接生效。
3. **深度思考强度药丸（Effort Pill）**：
   - 紧挨模型选择器，图标（如 `brain` / `sparkles`）+ 当前档位（`默认` / `关闭` / `低` / `中` / `高` / `极高`）。
   - 根据选中模型的 `supports_effort` 和 `effort_levels` 动态显示可选档位（不支持思考强度的模型自动隐藏或置灰）。

### 8.2 设置页新增两个清晰板块（`app/components/SettingsView.tsx`）
1. **全局设置 → Local Agents（本机执行节点）**：
   - 新增按钮「添加本机 Agent」→ 输入机器名 → 生成一次性的 `agent_token` 与可直接复制的 `config.json` 模板 + 启动命令。
   - 列表展示每台机器：在线状态、版本、已上报模型数（可点开预览模型及上下文/思考档位）、绑定项目列表、刷新目录 / 轮换 Token / 删除操作。
2. **项目设置 → 执行优先级与节点绑定（`ProjectRoutingCard`）**：
   - **优先级排序列表**：支持上移/下移（或拖拽）排列「各 Local Agent」与「云端执行器」的承接顺序，清晰标注「排名越靠前越优先使用，优先消耗本机订阅」。
   - **每个 Local Agent 的本项目配置**：显示/编辑本地工作目录、校验状态（绿勾/红叉提示）、开关「允许向此机器下发外部数据库凭据（默认关）」。
   - **路由开关**：「首选不可用时自动降级到下一节点（默认开）」、「工单讨论与 PR 审计优先由本地 Agent 承接（默认开）」。
3. **项目设置 → 项目 CLI（`ProjectCliSettingsCard.tsx`）**：
   - 补全「云端可选模型列表」维护区与「默认思考强度」选择。

---

## 9. 代码落点与模块拆分

### 新增文件
| 文件 | 职责 |
| --- | --- |
| `server/cli-stream-parser.ts` | 从 `server/codex-chat.ts` 抽离的共享模块：CLI 参数构造（含 `reasoning_effort`）、输出脱敏、Codex/Claude JSONL 流解析为 `ChatStreamEvent`。 |
| `server/bridge-hub.ts` | WSS 服务端枢纽：Token 鉴权、连接生命周期、心跳保活、在线态缓存、`catalog.sync`、`workspace.fetch/push`、`chat.start/abort` 与 `cli_run` 派发。 |
| `server/execution-router.ts` | 项目优先级排序解析、在线/目录/并发/runtime 资格过滤、自动降级与跨节点 `external_session_id` 失效判定。 |
| `agent/bridge/index.ts` | 本机全局 Bridge 守护进程入口（直接用 Node 24 运行，零编译或单命令启动）：WSS 客户端 + 自动重连 + 心跳 + `config.json` 热加载。 |
| `agent/bridge/catalog.ts` | 本地模型目录加载器：合并 `config.json`、`~/.claude/settings.json`、`~/.codex/config.toml` 与内置模型元数据。 |
| `agent/bridge/space-sync.ts` | 项目空间影子镜像同步器（增量拉取 `HANDBOOK.md` & `files/`，及 `workspace-write` 回写）。 |
| `agent/bridge/runner.ts` | 本机 CLI 子进程执行与并发控制，复用 `server/cli-stream-parser.ts` 输出标准 `ChatStreamEvent`。 |
| `app/components/LocalAgentsSettingsCard.tsx` | 全局 Local Agents 管理卡片（注册、Token/配置生成、在线态与模型预览）。 |
| `app/components/ProjectRoutingCard.tsx` | 项目级执行优先级排序、工作目录绑定状态、自动降级与数据源凭据开关卡片。 |

### 修改现有文件
| 文件 | 变更内容 |
| --- | --- |
| `package.json` | 服务端新增 `ws`（及 devDep `@types/ws`）；补充 bridge 启动脚本（如 `"bridge": "node agent/bridge/index.ts"`）。 |
| `server.ts` | 将 `BridgeHub` 挂载到 `http.Server` 的 `upgrade` 事件并在 `close()` 时优雅关闭连接。 |
| `server/store.ts` | 新增 `bridge_agents`、`project_agent_bindings` 表；扩展 `projects` 和 `chat_sessions` 列及对应 CRUD 方法。 |
| `server/project-cli-config.ts` | 扩展 `models: ModelCatalogItem[]`、`default_effort` 及对应校验（放宽文件上限至 64 KiB）。 |
| `server/codex-chat.ts` | 抽离解析与参数构造逻辑至 `server/cli-stream-parser.ts`；支持传入 `reasoning_effort` 与跨节点续聊判断。 |
| `server/api.ts` | 注册 `/api/bridge/*`、`/api/projects/:id/execution-routing`、`/api/projects/:id/agent-bindings/*`、模型发现与对话路由分发。 |
| `app/lib/types.ts` & `app/lib/api.ts` | 补充 `ModelCatalogItem`、`ChatReasoningEffort`、`BridgeAgentSummary`、`ProjectRoutingConfig` 类型与 API 客户端方法。 |
| `app/components/ProjectCliSettingsCard.tsx` | 补全云端自定义模型列表编辑器与 `/v1/models` 导入按钮。 |
| `app/components/SettingsView.tsx` | 集成 `LocalAgentsSettingsCard` 与 `ProjectRoutingCard`。 |
| `app/components/agent-chat/AgentPrimitives.tsx` & `app/components/CodexChatView.tsx` | 升级 `PromptBar`（节点选择、模型 Combobox + 上下文窗口展示、思考强度切换）与对话页头实际执行节点徽章。 |

---

## 10. 安全与边界清单

1. **凭据不落盘不泄露**：
   - `bridge_agents.token_hash` 仅存 SHA-256；Token 仅在创建/轮换时返回一次；鉴权仅走 `Authorization` Header，不走 URL Query。
   - 本机自动读取 `~/.claude/settings.json` / `~/.codex/config.toml` 时，**严格白名单提取模型名与思考强度字段**，严禁上传任何 API Key、Auth Token 或敏感 env。
   - 云端外部数据库 `connection_url` 默认不下发给本机，仅当管理员为「该项目 × 该 Agent」显式开启 `allow_datasource_secrets` 时才在内存载荷传递，且全程走 `redactSecrets`。
2. **路径安全**：
   - 项目空间影子同步严格复用 `normalizeRelativePath` / 防路径穿越 / 符号链接检查。
   - Web 端下发 `project.bind` 修改工作目录时，Bridge 必须校验 `realpath` 位于 `allowed_roots` 内，否则拒绝。
3. **进程与断线清理**：
   - 本机 CLI 子进程以独立进程组（`detached: true`）启动；收到 `chat.abort`、超时或 WSS 断开超过宽限期时，杀掉整个进程组，不留孤儿进程。
   - 云端检测到 WSS 断开时，自动把该 Agent 上 `running` 的对话消息标为 `error`（提示本机连接中断）并结束浏览器 SSE 流。

---

## 11. 分阶段实施路线与验收标准

### Phase 1：云端模型列表 + 思考强度 + 解析器抽离（无 WSS 依赖，先见效）
- 抽离 `server/cli-stream-parser.ts`，实现 Claude / Codex 的 `reasoning_effort` 参数映射。
- 扩展 `project-cli-config.ts` 与 `ProjectCliSettingsCard.tsx` 支持云端自定义模型列表与默认思考强度。
- 扩展 `chat_sessions`（`reasoning_effort`、`execution_target`、`resolved_target`）与 `PromptBar` 的模型 Combobox + 思考强度选择器。
- **验收**：网页端可在云端对话中自由切换/输入模型、调节思考强度，切换不中断多轮连续性；`pnpm typecheck && pnpm test` 通过。

### Phase 2：Local Agent Bridge（WSS）+ 模型目录推送 + 项目空间同步
- 服务端实现 `bridge_agents` / `project_agent_bindings` 表、`BridgeHub`（`/api/bridge/ws`）及管理 API。
- 实现本机 `agent/bridge/`（WSS 自动重连、心跳、`config.json` 热加载、Claude/Codex 配置读取、模型目录推送、`space-sync.ts` 增量同步 + 可写回写）。
- **验收**：本机运行 `pnpm bridge` 连上云端后，Web 端立即可见本机在线与完整模型元数据（含上下文与思考档位）；发起对话在本机工作目录流式执行，并能读取/检索云端 `HANDBOOK.md` 与 `files/` 中的文档及 SQLite；中止与断线重连正常清理。

### Phase 3：项目级优先级排序、自动降级与 `cli_runs` 优先承接
- 实现 `ExecutionRouter` 与 `ProjectRoutingCard.tsx`（优先级拖拽/上下排序、`auto_fallback`、工作目录绑定与外部数据源凭据开关）。
- 接入跨节点自动降级与 `priorMessages` 无感续聊。
- 接入 `cli_runs`（工单讨论 & PR 审计）优先派发至在线 Local Agent，离线时自动回退云端 `cli_runner.py`。
- **验收**：优先级设为「MacBook Pro → 云端」时，默认新建会话与工单讨论优先由本机承接；关闭本机 Bridge 后下一轮自动平滑降级到云端并保留上下文；重新上线后新会话自动恢复优先本机。

### Phase 4：端到端测试与运维文档
- 补充单测与集成测试：WSS 鉴权与重连、优先级路由与降级矩阵、跨节点续聊、`space-sync` 路径安全与回写、`reasoning_effort` CLI 参数单测、独立单文件打包与 `GET /api/bridge/client.mjs` 分发校验。
- 更新 `README.md` 与部署说明（Traefik WSS 配置检查与本机 LaunchAgent/systemd 常驻示例）。

---

## 12. 运维与本机常驻指南

### 12.1 独立零依赖客户端打包与分发
- `pnpm build` 会同时执行 `react-router build` 和 `node scripts/build-bridge.mjs`，产出单文件 ESM `build/bridge/relaydesk-bridge.mjs`（仅依赖 Node 24+，内联 `ws` 与 `smol-toml`）。
- 服务端通过 `GET /api/bridge/client.mjs` 提供下载：必须携带设备 Header `Authorization: Bearer rdbr_...`，响应附带 `X-Content-Sha256` 与 `X-Bridge-Version`。
- 在设置页创建设备或轮换 Token 时，点击 **「一键复制 Agent 接入 Prompt」** 发给任意目录下的 Claude Code / Codex，即可全自动完成下载、校验、配置写入与常驻拉起。

### 12.2 反向代理（Traefik / Nginx）WSS 核对
- **Traefik**：HTTP/HTTPS Router 默认透传 WebSocket `Upgrade: websocket` / `Connection: Upgrade`，确保后端服务超时（`respondingTimeouts.readTimeout`）≥ 60s 或为 `0`（服务端每 15s 发送 WS ping，35s 无 pong 断连）。
- **Nginx**：为 `/api/bridge/ws` 配置：
  ```nginx
  location /api/bridge/ws {
      proxy_pass http://127.0.0.1:8787;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 120s;
  }
  ```

### 12.3 macOS `launchd` 常驻示例
保存为 `~/Library/LaunchAgents/com.relaydesk.bridge.plist`（将 `/opt/homebrew/bin/node` 和 `$HOME` 替换为本机实际路径）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.relaydesk.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOUR_USER/.local/share/relaydesk-bridge/relaydesk-bridge.mjs</string>
    <string>--config</string>
    <string>/Users/YOUR_USER/.config/relaydesk-bridge/config.json</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USER/.local/state/relaydesk-bridge/bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USER/.local/state/relaydesk-bridge/bridge.log</string>
</dict>
</plist>
```

加载并启动：
```bash
launchctl bootout "gui/$(id -u)/com.relaydesk.bridge" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.relaydesk.bridge.plist
launchctl kickstart -k "gui/$(id -u)/com.relaydesk.bridge"
```

### 12.4 Linux `systemd --user` 常驻示例
保存为 `~/.config/systemd/user/relaydesk-bridge.service`：

```ini
[Unit]
Description=Relaydesk Local Bridge
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env node %h/.local/share/relaydesk-bridge/relaydesk-bridge.mjs --config %h/.config/relaydesk-bridge/config.json
Restart=always
RestartSec=3
StandardOutput=append:%h/.local/state/relaydesk-bridge/bridge.log
StandardError=append:%h/.local/state/relaydesk-bridge/bridge.log

[Install]
WantedBy=default.target
```

启用并启动：
```bash
systemctl --user daemon-reload
systemctl --user enable --now relaydesk-bridge.service
```

