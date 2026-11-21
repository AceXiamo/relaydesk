# Relaydesk

一个给项目维护者用的反馈工作台。把应用里的反馈组件和群 bot 接到同一个项目，把值得做的反馈放进队列，由你或本机的 coding agent 认领。每个项目绑定一个 GitHub 仓库。

技术栈：Node.js 24 (`node:sqlite` + TypeScript) · React Router v7 SSR · Tailwind CSS v4 · Iconify Lucide（本地离线子集）· Viem 以太坊钱包认证。

接手开发时，可先看产品决策、任务状态和代码入口：[项目交接文档](docs/agent-handoff.md)

## 在本机启动

需要 Node.js 24+ 与 pnpm：

```sh
pnpm install
pnpm dev
```

生产构建与运行：

```sh
pnpm build
pnpm start
```

打开 <http://127.0.0.1:8787>，创建项目，填入仓库名（例如 `your-account/your-app`）。数据保存在 `data/relaydesk.sqlite3`，停止并重启后反馈、讨论和认领状态均会保留。

## 配置项目 CLI 与 GitHub

- **项目 CLI**：在当前项目的设置里选择 Codex CLI 或 Claude Code，填写 API Key，可选填 API 基础地址和模型。工单讨论与 PR 审计使用这份配置。公开反馈的模型调用需单独开启。[配置与使用](docs/assistant.md)
- **GitHub 连接**：在同页保存 fine-grained PAT（仅需 Metadata Read-only 权限），即可在创建/编辑项目时下拉选择仓库。Token 以 `0600` 权限存于 `.github-token`。

## 跑通第一条反馈

1. 在工作台按 `N` 新建反馈，或在「收集入口」复制嵌入式 `<script>` 片段粘贴到你的应用页面；群聊可通过 Telegram Bot 的 `/feedback` 指令收录。
2. 在任务详情抽屉中核对原话、编辑执行要求、切换状态/优先级，或使用「询问项目 CLI」起草验收标准。重复反馈可合并到主任务。
3. 自己负责的任务点「我来处理」；交给本机 Coding Agent 的任务设为「待处理」并保持未认领。
4. 在开发机运行 `agent/relay.py` 领取任务并在独立 Git worktree 中执行。
5. Agent 执行期间可随时「请求接手」或「强制接手」；完成后进入「待验收」供本地检查验收。

| 接入 | 配置 |
| --- | --- |
| 应用反馈组件、Telegram 群机器人 | [收集端接入说明](integrations/README.md) |
| 本机 coding agent、工作树、交接与恢复 | [执行器说明](agent/README.md) |
| 本机 Local Bridge 节点、模型目录与执行优先级路由 | [架构与运维指南](docs/local-bridge-and-model-routing.md) |
| Project CLI conversations and PR audits | [Runner setup, permissions and acceptance checks](docs/project-runner.md) |
| 项目 CLI 配置、工单讨论与公开反馈 | [对话助手配置](docs/assistant.md) |

## 本机执行节点（Local Bridge）一键接入

无需在每台电脑 clone Relaydesk 仓库，`pnpm build` 会自动把 `agent/bridge/` 打包为单文件零依赖客户端 `build/bridge/relaydesk-bridge.mjs`，并由服务端通过 `GET /api/bridge/client.mjs`（设备 Bearer Token 鉴权 + `X-Content-Sha256` 校验）下发：

1. 在设置页「本机执行节点 · Local Agents」点击 **添加本机 Agent**，生成**一键复制 Agent 接入 Prompt**；
2. 将 Prompt 粘贴给任意目录下的 Claude Code 或 Codex，Agent 会自动校验 Node 24+、写入 `0600` 权限配置、下载校验单文件客户端并配置后台常驻（macOS `launchd` / Linux `systemd --user`）；
3. 在项目设置「项目执行优先级与节点绑定」卡片中排列本机节点与云端的承接顺序、校验绑定本机工作目录，以及开关自动降级与工单/PR 审计本机优先。

反向代理（Traefik / Nginx）需放行 `/api/bridge/ws` 的 WebSocket Upgrade 请求头，并保持读超时 ≥ 60s（服务端每 15s 自动 ping 保活）。

## 多台设备与钱包登录

公网部署时请通过 HTTPS 反向代理暴露服务，并设置：

- `RELAYDESK_ADMIN_WALLET`：管理员以太坊地址（EOA）
- `RELAYDESK_ORIGIN`：完整 HTTPS 来源，例如 `https://relaydesk.acexiamo.com`

登录页支持 EIP-6963 多钱包发现与 SIWE 签名验证，签发 12 小时 `HttpOnly; Secure; SameSite=Strict` 会话 Cookie。钱包模式优先于 `RELAYDESK_ADMIN_TOKEN`；未配置时仅允许本机回环访问。

## 检查与测试

```sh
pnpm typecheck
pnpm test
pnpm build
node --check public/widget.js
```

面板使用本地托管的 Geist Sans 和 Geist Mono 字体，许可证随字体分发。[Vercel Geist Design System](https://vercel.com/geist/introduction) · [字体许可](public/fonts/OFL.txt)
