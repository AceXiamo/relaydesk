# 项目助手与 LLM 配置

任务讨论使用当前项目名、项目级 Agent 指令、任务内容、要求、状态、负责人和最近 12 条讨论作为上下文。点击「询问项目助手」时，回答会写入该任务的讨论串。只有维护者主动修改任务要求或执行认领等操作时，队列状态才会变化。

## 方式一：在工作台直接配置（推荐）

进入左侧菜单 **设置与 LLM → AI 助手与 LLM 配置**，选择服务商预设（OpenAI、OpenRouter、DeepSeek、Ollama 本地或任意 OpenAI 兼容端点），填写：

- **API Base URL**：例如 `https://api.openai.com/v1` 或 `http://127.0.0.1:11434/v1`
- **模型名称 (Model)**：例如 `gpt-4o-mini`、`deepseek-chat`、`qwen3:8b`
- **API Key**：点击「测试连接」验证延迟与可用性后点击「保存 AI 配置」
- **允许反馈组件使用 LLM 追问**：按需开启或关闭

配置以 `0600` 权限保存在服务端数据目录的 `.ai-config.json` 中，API Key 不会下发到浏览器。

## 方式二：通过环境变量配置（回退默认）

如果工作区未在 UI 中保存配置，服务端会自动回退读取环境变量，例如连接本机模型：

```sh
export RELAYDESK_AI_BASE_URL=http://127.0.0.1:11434/v1
export RELAYDESK_AI_MODEL=qwen3:8b
export RELAYDESK_AI_KEY=sk-...
export RELAYDESK_AI_INTAKE=1
```

远程服务必须使用 HTTPS；仅回环地址支持 HTTP。服务端向指定地址的 `/chat/completions` 路由发送请求。请求超时或模型出错时会自动退回本地规则，不影响正常整理工作流。
