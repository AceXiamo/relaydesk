# Relaydesk

一个给项目维护者用的反馈工作台。把应用里的反馈组件和群 bot 接到同一个项目，把值得做的反馈放进队列，由你或本机的 coding agent 认领。每个项目绑定一个 GitHub 仓库。

接手开发时，可先看产品决策、任务状态和代码入口。[项目交接文档](docs/agent-handoff.md)

## 在本机启动

需要 Python 3.10 或更新版本。默认本机模式和两个适配器使用 Python 标准库。钱包认证使用 eth-account。面板和组件随源码提供，无需前端构建。

```sh
python3 server.py
```

打开 <http://127.0.0.1:8787>，创建项目，填入仓库名（例如 `your-account/your-app`）。本地启动时，数据保存在 `data/` 下的 SQLite 数据库中。停止并重新启动服务后，反馈、讨论和认领信息都保留。

## 跑通第一条反馈

1. 在工作台新建一条反馈，或在「收集入口」复制当前项目的脚本片段，粘到应用页面。群反馈可以通过 Telegram bot 的显式收集指令进入同一队列。
2. 在任务详情里核对原话，在讨论串补充上下文。将最终约定保存为任务要求。多条反馈涉及同一问题时，可以合并到一个主任务。
3. 自己负责的任务点「我来处理」。准备交给 agent 的任务设为「待处理」，负责人留空。队列按优先级和提交顺序派发。
4. 在开发机上对已绑定仓库启动本地执行器。它从服务端领取任务，创建独立的 Git 工作树，把要求交给你配置的 coding agent。开发机离线时，服务端仍可收件。
5. 在 agent 工作期间可以申请接手，交接信息会写回任务。正常完成的任务进入待验收，你可以在本地检查改动并完成验收。

| 接入 | 配置 |
| --- | --- |
| 应用反馈组件、Telegram 群机器人 | [收集端接入说明](integrations/README.md) |
| 本机 coding agent、工作树、交接与恢复 | [执行器说明](agent/README.md) |
| 任务对话、可选模型服务、收集端追问 | [对话助手配置](docs/assistant.md) |

## 多台设备使用

在不同设备上收集和执行任务时，请在它们都能访问的主机上运行 Relaydesk，并通过 HTTPS 反向代理提供服务。钱包登录使用浏览器中的 EVM 钱包或钱包内置浏览器。设置 `RELAYDESK_ADMIN_WALLET` 为管理员的外部账户（EOA），`RELAYDESK_ORIGIN` 为工作台的完整 HTTPS 来源，例如 `https://relaydesk.acexiamo.com`。容器内已安装依赖；从源码启用钱包认证时先运行 `python3 -m pip install -r requirements.txt`。服务端签发五分钟有效的一次性登录消息，验证签名后创建十二小时会话。退出、重启或重新部署会使相应会话失效。钱包模式优先于旧版 `RELAYDESK_ADMIN_TOKEN`。仅在本机直连时可以使用默认免登录模式。

在「项目设置 → GitHub 连接」保存 fine-grained personal access token，选定仓库并授予 Metadata 读取权限，即可在创建或编辑项目时从列表中选仓库。Token 保存在服务端 SQLite 同目录下权限为 0600 的 `.github-token` 文件中。断开连接会删除它。已绑定仓库继续按项目记录；本地执行器仍使用自己的 Git 凭据。

SQLite 数据目录应使用持久磁盘；备份运行中的数据库时可使用 SQLite 的 backup 功能。

在项目设置中登记要嵌入组件的网站来源。前端片段使用项目的收集 key，bot 和执行器分别使用自己的 key。反馈里的只言片语先进入「待整理」，由维护者决定要不要把它送给开发机执行。运行外部 coding agent 时，其本地权限与账号由开发者配置。

## 检查

```sh
python3 -m pip install -r requirements.txt
python3 -m unittest discover -s tests -v
node --check public/app.js
node --check public/widget.js
```

面板使用本地托管的 Geist Sans 和 Geist Mono 字体，许可证随字体分发。[Vercel Geist Design System](https://vercel.com/geist/introduction) · [字体许可](public/fonts/OFL.txt)
