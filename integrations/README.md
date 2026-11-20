# 将反馈送进项目队列

在项目设置里确认仓库，取出对应项目 ID 和来源密钥。组件使用可公开的 `intake_key`，Telegram 进程使用 `bot_key`。每个项目的密钥只用于该项目。

## 应用内组件

在项目的允许来源中填写应用的精确 origin，如 `https://app.example.com`，保留非默认端口。然后在应用中引入脚本，将以下示例里的域名、项目 ID 和组件密钥换成实际值。

```html
<script defer src="https://relay.example.com/widget.js"
  data-project="YOUR_PROJECT_ID"
  data-key="YOUR_WIDGET_INTAKE_KEY"></script>
```

脚本会在右下角挂载反馈入口。用户选择问题或需求，写下原话，点「继续」后项目助手返回一个追问；追问可以跳过。用户在预览页点「发送反馈」才会生成任务，网络故障后在同一份草稿上重试会复用提交编号。草稿保存在当前页面内存。只有勾选「附上页面地址」才提交当前页面的域名及路径，查询参数和片段会被省略。

项目助手配置见 [项目助手说明](../docs/assistant.md)。如果应用启用了 CSP，将 RelayDesk 服务的 origin 加到已有的 `script-src` 与 `connect-src`。组件在 Shadow DOM 内使用样式；禁止内联样式的宿主需要为该段样式配置 CSP hash。请在目标浏览器中实际测试线上嵌入。通过线上应用收集时，用户的浏览器需要能够访问 RelayDesk 的 HTTPS 地址。

## Telegram 群 bot

通过 BotFather 创建 bot，把它加入需要收集反馈的群。保留群组隐私模式。此适配器使用 Bot API 长轮询，需要 Telegram API 的出站连接，每个 bot token 只运行一个轮询进程。已有 webhook 的 bot 应使用单独的新 token，或由维护者先切换到长轮询。

将以下环境变量设置在运行适配器的机器上。项目和群之间的映射仅由此处的配置决定。一个进程可以把多个群的反馈送进同一个项目。不同项目可以使用各自的 bot 和独立进程。

| 变量 | 值 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather 为该 bot 签发的 token |
| `TELEGRAM_CHAT_IDS` | 获准收集的群数字 ID，以逗号分隔，如 `-1001234567890,-1009876543210` |
| `RELAY_URL` | RelayDesk 服务根地址。同机部署可使用实际监听的 loopback HTTP 地址，远程使用 HTTPS |
| `RELAY_PROJECT` | 面板中绑定目标仓库的项目 ID |
| `RELAY_BOT_KEY` | 该项目的 Telegram / Bot 密钥 |

从仓库根目录运行：

```sh
python3 integrations/telegram.py
```

群里可以直接发 `/feedback@你的机器人用户名 导出表格缺少日期`，也可以回复一条文字或带说明的媒体消息并发送 `/feedback@你的机器人用户名`。命令后可以附加补充说明。Telegram 把简写 `/feedback` 投递给此 bot 时同样生效；多个 bot 共存的群建议指定用户名。

适配器仅采集命令文字、被明确回复的消息正文或媒体说明。公开群会附上原消息链接，私密群仅使用消息标识的摘要去重。一次命令投递重试或再次引用同一条原文，都返回现有反馈编号。群内解析和双重投递用例可运行 `python3 -m unittest discover -s tests -p test_telegram.py`。
