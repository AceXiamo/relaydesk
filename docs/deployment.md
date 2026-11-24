# Relaydesk 生产部署与全自动迭代指南（Pier）

本文档整合 Relaydesk 在 Pier 节点上的生产部署架构、CI 镜像构建、环境变量、备份回滚，以及**通过云端 RelayDesk 驱动本机 Local Agent 对 RelayDesk 自身进行全自动迭代发布**的标准操作流程（SOP）。

> **安全边界**：Relaydesk 的生产部署**仅由本机 Local Agent 通过 Pier 工具执行**。
> - GitHub Actions（[`.github/workflows/image.yml`](../.github/workflows/image.yml)）只负责跑测试、构建并推送 GHCR 镜像，**不持有**服务器 SSH 私钥，也不自动 SSH 部署。
> - 云端 Project CLI Runner 同样**严禁**持有服务器 SSH 凭据或宿主机访问权限。

相关专项文档：
- Local Bridge 架构、首次接入与 `launchd`/`systemd` 配置：[docs/local-bridge-and-model-routing.md](local-bridge-and-model-routing.md)
- 独立 Project CLI Runner 隔离模型与首次配置：[docs/project-runner.md](project-runner.md)
- 项目 CLI 凭据与公开助手配置：[docs/assistant.md](assistant.md)

---

## 1. 生产拓扑与 Pier 约定

### 1.1 运行环境总览

| 项目 | 说明 |
| --- | --- |
| Pier 节点 | `tw-1` |
| 公网入口 | `https://relaydesk.acexiamo.com`（经 `/srv/infra/traefik` 外部 `edge` 网络终止 TLS，`certresolver=cf`） |
| 宿主机 SSH/SCP | `/Users/AceXiamo/work/project/server_manage/scripts/pier-ssh tw-1`、`scripts/pier-scp` |
| Web 项目目录 | `/srv/apps/relaydesk`（容器 `relaydesk-web-1`，监听内部 `8787`） |
| Web 镜像 | `ghcr.io/acexiamo/relaydesk:${IMAGE_TAG:-latest}`（`linux/amd64`，生产固定为 40 位完整 SHA） |
| Runner 目录示例 | `/srv/apps/relaydesk-codex-scheduling`（容器 `relaydesk-codex-scheduling-runner-1`，每个启用云端 Runner 的项目各自独立目录） |
| Runner 镜像 | `ghcr.io/acexiamo/relaydesk-runner:${IMAGE_TAG}`（与 Web 使用相同的 40 位完整 SHA） |
| 健康检查 | `GET http://127.0.0.1:8787/api/auth/status`（公网可测 `https://relaydesk.acexiamo.com/api/auth/status`） |
| 容器运行用户 | Web：`relaydesk`（UID/GID `10001:10001`）；Runner supervisor 降权到 `cli-job`（`10001:10001`） |

### 1.2 Web 持久化数据目录布局

宿主机 `/srv/apps/relaydesk/data` 挂载至容器 `/app/data`（属主必须保持 `10001:10001`）：

```text
/srv/apps/relaydesk/
├── compose.yml                  # 来源模板: deploy/compose.yml（切勿设置顶层 name:）
├── .env                         # 仅存放 IMAGE_TAG=<40位SHA>，由 `pier deploy` 维护
├── app.env                      # 运行时环境变量与密钥（chmod 600，绝不入库）
├── backup.py                    # SQLite 在线备份脚本（来源: deploy/backup.py）
└── data/                        # 挂载到容器 /app/data（严禁删除或 volume prune）
    ├── relaydesk.sqlite3        # 主 SQLite 数据库
    ├── workspaces/              # 云端项目空间文件（HANDBOOK.md、files/、SQLite 等）
    ├── cli-runners/
    │   └── <projectId>/
    │       └── settings.json    # 控制台写入的项目 CLI 凭据（0600，供对应 Runner 只读挂载）
    ├── .github-tokens.json      # GitHub PAT 存储（0600）
    ├── .r2-config.json          # Cloudflare R2 存储配置（0600）
    ├── .utility-ai-config.json  # 轻任务辅助模型配置（0600）
    └── .cli-home/               # Web 内置 CLI 的 HOME 目录（含 .codex/）
```

### 1.3 Pier 操作铁律

1. **优先只读观察**：若当前会话具备 Pier MCP 权限，先用 `overview` / `get_project` / `get_logs` / `list_events` 核对状态；若无 MCP 权限，通过 `pier-ssh tw-1` 只读检查 `docker compose ps` 和 `docker compose logs`。
2. **版本变更必须走 `pier deploy`**：严禁手动改 `.env` 的 `IMAGE_TAG` 后直接运行 `docker compose up -d`，否则 Pier 面板丢失部署记录、提交关联与失败自动回滚能力。
3. **非发布类变更必须留痕**：修改 `app.env`、`compose.yml`、手动重启、调整定时任务等操作后，必须在 Pier 记录一条说明：
   ```bash
   # MCP 可用时优先调用 add_note；否则通过 SSH 补记：
   /Users/AceXiamo/work/project/server_manage/scripts/pier-ssh tw-1 \
     'pier event -kind note -project relaydesk -message "说明改了什么以及原因"'
   ```
4. **严禁泄露凭据**：不把 `app.env`、`runner.env`、私钥、Token、数据库连接串写入 git、commit message、HANDBOOK 或 Pier 事件备注。

---

## 2. CI 镜像构建（GitHub Actions -> GHCR）

工作流定义在 [`.github/workflows/image.yml`](../.github/workflows/image.yml)，触发条件为 `push` 到 `main` 或手动 `workflow_dispatch`。

### 2.1 推送前本地门禁检查

在提交与推送前，Local Agent 必须先在本机跑齐与 CI 一致的校验：

```bash
pnpm typecheck
pnpm test
pnpm build
node --check public/widget.js
python3 -m unittest discover -s tests -q
```

其中 `pnpm build` 会同时完成：
- `react-router build`（产出 `build/client/` 与 `build/server/`）
- `node scripts/build-bridge.mjs`（产出单文件零依赖客户端 `build/bridge/relaydesk-bridge.mjs`，由服务端 `/api/bridge/client.mjs` 分发）

### 2.2 CI 产物与镜像内容

CI 通过后会依次发布两个 `linux/amd64` 镜像：
1. **`ghcr.io/acexiamo/relaydesk-runner:<full-sha>`**（基于 [`agent/Dockerfile`](../agent/Dockerfile)）：先执行 `bash tests/cli-image-proof.sh` 验证隔离沙箱，通过后推送。
2. **`ghcr.io/acexiamo/relaydesk:<full-sha>`** 及 `:latest`（基于 [`Dockerfile`](../Dockerfile)）：内含 Node 24、`@openai/codex`、`@anthropic-ai/claude-code`、`git`、`ripgrep`、`python3`、`psql`、`mysql`、`sqlite3`、`redis-cli` 以及预打包的 `build/bridge/relaydesk-bridge.mjs`。

等待并确认构建完成：

```bash
SHA=$(git rev-parse HEAD)
RUN_ID=$(gh run list -R AceXiamo/relaydesk -w image.yml -c "$SHA" -L 1 --json databaseId --jq '.[0].databaseId // empty')
test -n "$RUN_ID" && gh run watch "$RUN_ID" -R AceXiamo/relaydesk --exit-status
```

### 查询镜像构建返回 404

先用同一会话检查身份和仓库可见性：

```bash
gh api user --jq .login
gh api repos/AceXiamo/relaydesk --jq .full_name
gh api rate_limit --jq .resources.core
```

REL-4 查询构建时，用户接口返回 401，私有仓库和工作流接口均返回 404，API 配额仍有余量。Git 能读取远端分支时，`gh` 仍可能使用另一套凭据。若用户和仓库接口均成功，再核对 Actions 读取权限、工作流路径和目标提交。遇到 403 或 429 时，按响应中的限流信息处理；Actions 计费分钟数需单独核实。[GitHub REST API 排障文档](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)

若本机 Git 已配置本仓库的 GitHub HTTPS 凭据，可在可信终端的子 shell 中临时复用它。以下命令按发布 SHA 查询构建并等待结束，凭据仅在子 shell 内使用。不要开启命令跟踪或单独打印 credential helper 的输出。

```bash
(
  set +x
  set -eu
  set -o pipefail
  GH_TOKEN=$(printf 'url=https://github.com/AceXiamo/relaydesk.git\n\n' |
    GIT_TERMINAL_PROMPT=0 git credential fill | sed -n 's/^password=//p')
  test -n "$GH_TOKEN"
  export GH_TOKEN
  RUN_ID=$(gh run list -R AceXiamo/relaydesk -w image.yml -c "$SHA" -L 1 --json databaseId --jq '.[0].databaseId // empty')
  test -n "$RUN_ID" && gh run watch "$RUN_ID" -R AceXiamo/relaydesk --exit-status
)
```

---

## 3. 标准发布 SOP（含云端 RelayDesk 自我迭代注意事项）

### 3.1 关键机制：为什么「自我部署」不能同步等待 Web 重建

当你在云端 `https://relaydesk.acexiamo.com` 的对话窗口里，让本机 Local Agent 迭代并发布 RelayDesk 自身时，调用链路是：

```text
Browser (SSE) <--> tw-1:relaydesk-web-1 <== WSS /api/bridge/ws ==> 本机 relaydesk-bridge.mjs --> Claude/Codex CLI
```

根据 [`agent/bridge/index.ts`](../agent/bridge/index.ts) 的当前实现：
1. `tw-1` 执行 `pier deploy -project relaydesk` 重建 `relaydesk-web-1` 的瞬间，WSS 连接立即断开；
2. 新版 Web 与 Bridge 都支持短时重连时，异常断网默认保留交互聊天最多 30 秒；只有同一个 Bridge 进程、同一个运行 ID、仍有效的绑定和原 Web 进程可以接回，不会重跑提示词、工具或已发出的 RPC。正常关闭、撤销令牌和独立 CLI 审计不使用此机制。**Web 重建会丢失内存中的原运行，不能靠重连跨过部署**；
3. 如果你在同一个命令流里「同步运行 `pier deploy -project relaydesk` 然后再执行健康检查或重启本地 bridge」，Agent 进程会在容器重启瞬间被中断，后续步骤根本不会执行；若本地 SSH 还带着 PTY/管道挂在前台，甚至可能给远端带来 `SIGHUP`/`SIGPIPE` 干扰。

因此，**Local Agent 执行自我迭代发布必须拆成三个阶段**：所有不断连的工作放在前面同步完成；Web 容器切流作为本轮的**最后一步**并以脱离进程树（detached）方式触发；验收在切流恢复后（下一轮或本机日志）完成。

### 3.2 阶段 A：构建、预检、Runner 同步与预拉镜像（不断连，同步执行）

```bash
PIER_SSH="/Users/AceXiamo/work/project/server_manage/scripts/pier-ssh"
SHA=$(git rev-parse HEAD)
MSG=$(git log -1 --pretty=%s)

# 1. 按上一节确认该 SHA 的 image.yml 构建成功后继续

# 2. 查看当前线上版本与运行状态（记录回滚基线 PREV_SHA）
$PIER_SSH tw-1 '
  echo "=== web .env ===" && cat /srv/apps/relaydesk/.env
  echo "=== web ps ==="  && docker compose -f /srv/apps/relaydesk/compose.yml ps
'

# 3. 若本次涉及 SQLite schema / 迁移变更，先手动执行一次在线备份
$PIER_SSH tw-1 'systemctl start relaydesk-backup.service && systemctl status relaydesk-backup.service --no-pager -n 10'

# 4. 如有独立 Project CLI Runner（不影响 Web WSS），先同步到同一 SHA
$PIER_SSH tw-1 "pier deploy -project relaydesk-codex-scheduling -tag $SHA -message $(printf '%q' "$MSG")"

# 5. 预拉取 Web 新镜像（只 pull 不重启，把切流中断压缩到 3~5 秒）
$PIER_SSH tw-1 "docker pull ghcr.io/acexiamo/relaydesk:$SHA"
```

> 若本次修改了 `deploy/compose.yml`，须在切流前先对比远端 `/srv/apps/relaydesk/compose.yml`（保留任何主机定制项）；模板中的 Traefik 域名来自 Compose `.env` 的 `RELAYDESK_HOST`（生产为 `relaydesk.acexiamo.com`），同步前确认已设置，用 `pier-scp` 同步后再记录一条 `pier event -kind note`。

### 3.3 阶段 B：触发 Web 切流（本轮最后一步，脱离当前进程树）

切流命令必须满足两点：
- 远端 `pier deploy` 经 `nohup ... </dev/null >/tmp/relaydesk-deploy.log 2>&1 &` 脱离 SSH 会话，确保即使本机 Bridge 在断连瞬间 abort 了本地进程，远端 `pier deploy` 仍能完整执行完毕并向 Pier 面板回报结果（若启动或健康检查失败，`pier deploy` 会自动回滚回旧 `IMAGE_TAG`）。
- 作为当前 Agent 回合的**最后一个工具调用**执行；紧接着立刻输出简明收尾信息（本次 `SHA`、旧基线 `PREV_SHA`、远端日志路径），不要在同回合里继续 `sleep`/轮询。

```bash
PIER_SSH="/Users/AceXiamo/work/project/server_manage/scripts/pier-ssh"
SHA=$(git rev-parse HEAD)
MSG=$(git log -1 --pretty=%s)

$PIER_SSH tw-1 "
  nohup setsid sh -c '
    pier deploy -project relaydesk -tag \"\$1\" -message \"\$2\"
  ' _ $(printf '%q' "$SHA") $(printf '%q' "$MSG") \
    </dev/null >/tmp/relaydesk-deploy-${SHA:0:8}.log 2>&1 &
  echo \"Triggered detached deploy pid=\$! log=/tmp/relaydesk-deploy-${SHA:0:8}.log\"
"
```

> **提示**：由于 Web 重建在触发后 1~3 秒内就会发生，前端当前回合可能会看到短暂断流或提示中止，这是正常现象。等待约 5~15 秒后刷新页面，`relaydesk-bridge` 会自动重连（初始 1s 退避），即可进入阶段 C 验收。

### 3.4 阶段 C：切流后验收（新回合或本机核对）

```bash
PIER_SSH="/Users/AceXiamo/work/project/server_manage/scripts/pier-ssh"

# 1. 查看远端 pier deploy 日志
$PIER_SSH tw-1 'ls -t /tmp/relaydesk-deploy-*.log | head -1 | xargs tail -n 60'

# 2. 核对 IMAGE_TAG、容器健康状态与最近日志
$PIER_SSH tw-1 '
  cat /srv/apps/relaydesk/.env
  cd /srv/apps/relaydesk && docker compose ps && docker compose logs --tail 40 web
'

# 3. 核对公网 HTTPS 入口与健康接口
curl -fsS https://relaydesk.acexiamo.com/api/auth/status && echo
```

确认以下全部通过即发布完成：
- `/srv/apps/relaydesk/.env` 中 `IMAGE_TAG` 等于目标 40 位 `SHA`；
- `relaydesk-web-1` 状态为 `Up ... (healthy)`，日志无启动异常；
- `https://relaydesk.acexiamo.com/api/auth/status` 返回 `200 OK`；
- 设置页「本机执行节点 · Local Agents」显示本机节点已重新在线；
- Pier 面板事件流已记录本次 `deploy` 成功事件。

---

## 4. 环境变量、配置与反向代理

### 4.1 Web 服务 `app.env`（`/srv/apps/relaydesk/app.env`，权限 `0600`）

| 变量名 | 是否必填 | 说明 |
| --- | --- | --- |
| `RELAYDESK_ADMIN_WALLET` | 公网推荐必填 | 管理员以太坊地址（EOA），启用 EIP-6963 / SIWE 登录（12 小时 `HttpOnly; Secure; SameSite=Strict` Cookie），优先级高于 Token |
| `RELAYDESK_ORIGIN` | 钱包模式必填 | 完整 HTTPS 来源，例如 `https://relaydesk.acexiamo.com` |
| `RELAYDESK_ADMIN_TOKEN` | 可选 | 备用管理员 Bearer Token；与钱包均未配置时仅允许 `127.0.0.1` 回环访问 |
| `PORT` | 可选 | 监听端口，默认 `8787`（需与 `compose.yml` 中 Traefik `server.port` 一致） |
| `RELAYDESK_CODEX_LEGACY_LANDLOCK` | 容器内置 | [`Dockerfile`](../Dockerfile) 默认设为 `1`，用于兼容容器内 Codex 沙箱 |
| `RELAYDESK_BRIDGE_BUNDLE_PATH` | 可选 | 覆盖 `/api/bridge/client.mjs` 下发文件路径，默认 `build/bridge/relaydesk-bridge.mjs` |
| `RELAYDESK_CODEX_BIN` / `RELAYDESK_CLAUDE_BIN` | 可选 | 覆盖容器内 `codex` / `claude` 可执行文件路径 |
| `RELAYDESK_GITHUB_API_BASE` | 可选 | 自定义 GitHub API Base URL |
| `RELAYDESK_R2_ACCOUNT_ID` / `BUCKET` / `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` / `PUBLIC_URL` / `ENDPOINT` | 可选兜底 | R2 截图上传配置；通常直接在控制台保存至 `data/.r2-config.json`，环境变量仅作兜底 |
| `RELAYDESK_UTILITY_AI_PROVIDER` / `ENDPOINT` / `API_KEY` / `MODEL` | 可选兜底 | 轻任务辅助模型配置；通常直接在控制台保存至 `data/.utility-ai-config.json` |

修改 `app.env` 后必须**重建容器**（仅 `restart` 不会重读 `env_file`），并向 Pier 补记事件：

```bash
# 注意：在云端自我迭代场景下，重建 web 同样会中断当前 WSS 会话，应放在最后一步并以 detached 方式执行
cd /srv/apps/relaydesk && docker compose up -d
pier event -kind note -project relaydesk -message "Updated <VAR_NAME> in app.env"
```

### 4.2 反向代理与 WSS 核对

[`deploy/compose.yml`](../deploy/compose.yml) 通过 Traefik `edge` 网络暴露服务。调整反向代理时须保持以下要求：
- 放行 `/api/bridge/ws` 的 WebSocket `Upgrade` / `Connection` 头；
- 后端读超时 `>= 60s`（或 `0`），服务端每 `15s` 发送 WS ping，`35s` 无 pong 主动断连；
- `/widget.js`、`/widget-capture.js`、`/widget/*` 由服务自身下发 CORS 头，勿在网关层覆盖掉 `Access-Control-Allow-Origin`；
- 只有 `/srv/infra/traefik` 暴露宿主机 80/443，业务容器不发布宿主机端口。

### 4.3 独立 Project CLI Runner（每项目一份）

新增或调整项目的云端 CLI Runner 时，以 [`deploy/compose.runner.yml`](../deploy/compose.runner.yml)、[`deploy/runner.env.example`](../deploy/runner.env.example) 与 [`deploy/runner-handbook.example.md`](../deploy/runner-handbook.example.md) 为模板，按 [docs/project-runner.md](project-runner.md) 在 `/srv/apps/relaydesk-<slug>/` 创建独立目录：
- `runner.env` 权限 `0600`；
- `.env` 设置 `IMAGE_TAG=<full-sha>` 与 `CLI_PROJECT_CONFIG_DIR=/srv/apps/relaydesk/data/cli-runners/<projectId>`；
- `cli-runners/<projectId>` 属主 `10001:10001`、权限 `0700`；
- 启动前先自检：`docker compose run --rm runner --self-test`。

---

## 5. 本机 Local Bridge 客户端升级（改动 `agent/bridge/` 时）

当本次迭代修改了 `agent/bridge/*` 或 `scripts/build-bridge.mjs` 时，云端发完新版本后，本机常驻的 `~/.local/share/relaydesk-bridge/relaydesk-bridge.mjs` 也需要同步更新。

### 5.1 替换单文件客户端

**方式一（从本地刚构建的产物原子替换，推荐本机开发机）**：

```bash
pnpm build:bridge
install -m 755 build/bridge/relaydesk-bridge.mjs ~/.local/share/relaydesk-bridge/relaydesk-bridge.mjs.new
mv ~/.local/share/relaydesk-bridge/relaydesk-bridge.mjs.new ~/.local/share/relaydesk-bridge/relaydesk-bridge.mjs
```

**方式二（从线上服务端下载并校验 `X-Content-Sha256`，适用于其他未 clone 仓库的机器）**：

```bash
TOKEN=$(jq -r '.agent_token' ~/.config/relaydesk-bridge/config.json)
HDR=$(mktemp)
TMP=~/.local/share/relaydesk-bridge/relaydesk-bridge.mjs.new
curl -fsS -D "$HDR" -H "Authorization: Bearer $TOKEN" \
  https://relaydesk.acexiamo.com/api/bridge/client.mjs -o "$TMP"
EXPECTED=$(awk -F': ' 'tolower($1)=="x-content-sha256"{gsub("\r",""); print $2}' "$HDR")
ACTUAL=$(shasum -a 256 "$TMP" | awk '{print $1}')
rm -f "$HDR"
test -n "$EXPECTED" && test "$EXPECTED" = "$ACTUAL"
chmod 755 "$TMP"
mv "$TMP" ~/.local/share/relaydesk-bridge/relaydesk-bridge.mjs
```

### 5.2 安全重启本机常驻进程（避免中断当前回合）

如果是在云端 RelayDesk 驱动的 Local Agent 回合中执行重启，**直接运行 `launchctl kickstart -k` 会立刻杀死当前 Agent 子进程**。务必用延迟 detached 方式触发，作为该回合的最后一步：

```bash
# macOS (launchd)
nohup sh -c 'sleep 3 && launchctl kickstart -k "gui/$(id -u)/com.relaydesk.bridge"' \
  </dev/null >/dev/null 2>&1 &

# Linux (systemd --user)
nohup sh -c 'sleep 3 && systemctl --user restart relaydesk-bridge.service' \
  </dev/null >/dev/null 2>&1 &
```

重启完成后可在下一轮核对日志：

```bash
tail -n 30 ~/.local/state/relaydesk-bridge/bridge.log
```

---

## 6. 备份、恢复与回滚

### 6.1 SQLite 每日在线备份

仓库内提供：
- [`deploy/backup.py`](../deploy/backup.py)：使用 SQLite 在线 `backup()` API + `PRAGMA integrity_check` 校验完整性，默认保留最近 7 天副本；
- [`deploy/relaydesk-backup.service`](../deploy/relaydesk-backup.service) 与 [`deploy/relaydesk-backup.timer`](../deploy/relaydesk-backup.timer)：每日 `03:15 UTC` 自动执行。

> **路径核对提醒**：仓库里的 `deploy/backup.py` 默认写入 `/srv/backups/relaydesk`，而 `tw-1` 实际历史配置可能使用 `/var/backups/relaydesk/`。执行备份核查或恢复前，先在 `tw-1` 检查实际生效路径：
> ```bash
> /Users/AceXiamo/work/project/server_manage/scripts/pier-ssh tw-1 \
>   'systemctl list-timers relaydesk-backup.timer --no-pager; systemctl cat relaydesk-backup.service; ls -lah /srv/backups/relaydesk /var/backups/relaydesk 2>/dev/null || true'
> ```

### 6.2 标准回滚流程

先确认要回退的旧 40 位 `PREV_SHA`（可从 Pier 面板部署历史或 `gh run list -R AceXiamo/relaydesk -w image.yml` 查询）：

```bash
PIER_SSH="/Users/AceXiamo/work/project/server_manage/scripts/pier-ssh"
PREV_SHA="<previous-40-char-sha>"
REASON="Rollback: <简述原因>"

# 1. 若 Runner 曾同步升级，先回滚 Runner（不影响 Web WSS）
$PIER_SSH tw-1 "pier deploy -project relaydesk-codex-scheduling -tag $PREV_SHA -action rollback -message $(printf '%q' "$REASON")"

# 2. 预拉旧版 Web 镜像（通常本地缓存仍在，秒级完成）
$PIER_SSH tw-1 "docker pull ghcr.io/acexiamo/relaydesk:$PREV_SHA"

# 3. 以 detached 方式回滚 Web（本回合最后一步）
$PIER_SSH tw-1 "
  nohup setsid sh -c '
    pier deploy -project relaydesk -tag \"\$1\" -action rollback -message \"\$2\"
  ' _ $(printf '%q' "$PREV_SHA") $(printf '%q' "$REASON") \
    </dev/null >/tmp/relaydesk-rollback-${PREV_SHA:0:8}.log 2>&1 &
  echo \"Triggered detached rollback pid=\$!\"
"
```

### 6.3 SQLite 数据恢复（极端情况）

仅在确认需要回退数据库文件时执行，执行前须先向用户确认：
1. 停止 Web 容器：`cd /srv/apps/relaydesk && docker compose stop web`；
2. 保留损坏或当前现场副本：`cp data/relaydesk.sqlite3 "data/relaydesk.sqlite3.before-restore.$(date +%s)"`（同时留意清理残留的 `-wal`/`-shm`）；
3. 拷入校验通过的备份文件并恢复属主权限：`chown 10001:10001 data/relaydesk.sqlite3 && chmod 600 data/relaydesk.sqlite3`；
4. 启动 Web：`docker compose start web`，并用 `pier event -kind note -project relaydesk -message "Restored SQLite from <backup>"` 记账。

---

## 7. 常见故障排查速查

| 现象 | 排查命令与处理思路 |
| --- | --- |
| 自我部署后对话断流，不确定是否成功 | 查看 `tw-1` 上 `/tmp/relaydesk-deploy-*.log`、`/srv/apps/relaydesk/.env` 与 `docker compose ps`；再测 `curl -fsS https://relaydesk.acexiamo.com/api/auth/status`。若新镜像健康检查失败，`pier deploy` 会自动回滚回旧 SHA。 |
| 容器反复重启 / `unhealthy` | `pier-ssh tw-1 'cd /srv/apps/relaydesk && docker compose logs --tail 100 web'`；同时检查 `docker inspect relaydesk-web-1 --format '{{.State.ExitCode}} {{.State.OOMKilled}}'` 与 `/srv/apps/relaydesk/data` 属主是否为 `10001:10001`。 |
| `docker pull` 报 `denied` | `tw-1` 的 GHCR 登录凭证失效或未登录，按 Pier `runbooks/server-bootstrap.md` 第 4 步重新登录 GHCR。 |
| Local Bridge 掉线或日志出现 `code=4001` | `4001` 表示同一个 Agent Token 被另一个连接顶号（本机起了两个实例或重复 `launchd` 配置）；检查 `ps aux \| grep relaydesk-bridge` 与 `~/.local/state/relaydesk-bridge/bridge.log`。 |
| Project CLI Runner 不领活 | 核对 `docker compose -f /srv/apps/relaydesk-codex-scheduling/compose.yml logs --tail 100 runner`；检查 `CLI_PROJECT_CONFIG_DIR` 是否存在且属主为 `10001:10001`，以及控制台是否已保存对应项目的 API Key。 |
| 宿主机磁盘告警 | `pier-ssh tw-1 'df -h / && docker system df'`；可安全清理 7 天前的悬空镜像：`docker image prune -a --filter "until=168h" -f`（**严禁**执行 `docker volume prune` 或删除 `/srv/apps/*/data`）。 |
