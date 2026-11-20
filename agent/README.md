# 连接本地 coding agent

连接器运行在装有 Git、Python 3.10+ 和 coding agent 的 Linux、macOS 或 WSL 环境。每个实例连接一个项目，领取「待处理 · 未认领」的任务。先在项目设置里绑定 GitHub 仓库，再从本机 clone 该仓库，确认当前 HEAD 是这次工作的起点。

在 Relaydesk 源码目录下运行以下命令。项目 ID 和 agent key 在项目设置中可见。示例使用 Bash 和已登录的 Codex CLI。

```bash
export RELAYDESK_URL='http://127.0.0.1:8787'
export RELAYDESK_PROJECT='项目 ID'
read -rsp 'Agent key: ' RELAYDESK_AGENT_KEY
echo
export RELAYDESK_AGENT_KEY
python3 agent/relay.py --repo ~/src/my-app -- codex exec --sandbox workspace-write -
```

服务如果在另一台机器上，用 HTTPS 地址连接。连接器比对本地 `origin` 与绑定的 `owner/repo`，支持 GitHub 的常规 HTTPS 和 SSH 地址。把项目的仓库绑定改到另一仓库后，需要更换本地 checkout。

命令由本机操作者配置，`--` 后第一个值是可执行文件，其余值作为各自独立的参数传入。工具需接受标准输入中的 UTF-8 任务说明，在当前工作目录中执行并用退出码报告结果。保留工具自身的沙箱与权限设置。使用 `--once` 可以只轮询一次并处理领到的任务。默认每 3 秒轮询或同步一次，可传入 `--interval 1` 至 `--interval 60`。

## 工作现场

- 每张任务单使用独立 Git worktree，以领取时的本地 HEAD 创建分支。任务说明包含原始反馈、合并的反馈和已确认要求。工具的标准输出与错误写在本机。连接器将分支名、HEAD 和变更条目数写回任务单。退出码 0 后进入待验收，验证、提交与合并由操作者决定。
- 在面板点击接手后，连接器会在心跳时终止当前命令所在的进程组，保存现场并确认交接。请选用持续以前台进程运行的 CLI。断线时强制接手只能撤销服务端写回权，离线机器上的程序要等到下次同步或本地停止。通过 `git -C ~/src/my-app worktree list` 查找现场。
- 运行时修改执行要求会停止旧版本任务并退回待补充。讨论串中的普通留言不会打断执行。确认要求后把任务重新设为待处理，可继续使用原有 worktree。
- 首次运行打印状态目录，默认在 `~/.local/state/relaydesk/` 下，也支持 `XDG_STATE_HOME`。目录里的 `active.json` 保存进行中的认领凭据，`runs/` 保存任务输入和运行日志。不要提交或分享这些文件。
- 使用相同 URL、项目、checkout 和状态目录重启。已完成且尚未回写的结果会重试提交。上次执行意外中断时，连接器保留改动并标记为待补充，方便人工核对。若领取请求已到达服务器、连接器却未收到领取响应，面板会留有无心跳的认领记录，可人工接手并重新入队。
