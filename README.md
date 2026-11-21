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

## 配置 LLM API Key 与 GitHub

- **AI 助手与 LLM**：进入左侧 **设置与 LLM**，可直接配置 OpenAI / OpenRouter / DeepSeek / Ollama 或任意 OpenAI 兼容接口的 Base URL、Model 与 API Key，支持一键测试连接以及开关「反馈组件 AI 追问」。密钥以 `0600` 权限存于数据目录 `.ai-config.json`（也兼容环境变量回退）。
- **GitHub 连接**：在同页保存 fine-grained PAT（仅需 Metadata Read-only 权限），即可在创建/编辑项目时下拉选择仓库。Token 以 `0600` 权限存于 `.github-token`。

## 跑通第一条反馈

1. 在工作台按 `N` 新建反馈，或在「收集入口」复制嵌入式 `<script>` 片段粘贴到你的应用页面；群聊可通过 Telegram Bot 的 `/feedback` 指令收录。
2. 在任务详情抽屉中核对原话、编辑执行要求、切换状态/优先级，或使用「询问项目助手」起草验收标准。重复反馈可合并到主任务。
3. 自己负责的任务点「我来处理」；交给本机 Coding Agent 的任务设为「待处理」并保持未认领。
4. 在开发机运行 `agent/relay.py` 领取任务并在独立 Git worktree 中执行。
5. Agent 执行期间可随时「请求接手」或「强制接手」；完成后进入「待验收」供本地检查验收。

| 接入 | 配置 |
| --- | --- |
| 应用反馈组件、Telegram 群机器人 | [收集端接入说明](integrations/README.md) |
| 本机 coding agent、工作树、交接与恢复 | [执行器说明](agent/README.md) |
| Project CLI conversations and PR audits | [Runner setup, permissions and acceptance checks](docs/project-runner.md) |
| 任务对话、LLM API Key 配置与收集端追问 | [对话助手配置](docs/assistant.md) |

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
