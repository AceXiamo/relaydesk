import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import { formatDateTime, formatRelativeTime } from "~/lib/format.ts";
import { effortLabels } from "~/lib/model-catalog.ts";
import type { BridgeAgentSummary, BridgeAgentTokenResponse } from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { Button, CopyButton, LivePulseDot, useToast } from "./ui.tsx";

const codeBox =
  "rounded-xl border border-zinc-800 bg-zinc-950 p-3.5 font-mono text-[12px] leading-relaxed text-zinc-100 whitespace-pre-wrap break-words overflow-x-auto max-h-72 overflow-y-auto rd-scroll";

type SetupReceipt = Pick<BridgeAgentTokenResponse, "agent" | "token"> &
  Partial<Pick<BridgeAgentTokenResponse, "quickstart_config" | "start_command" | "client_url" | "bridge_version">> & {
    isRotation?: boolean;
  };

function resolveClientUrl(receipt: SetupReceipt): string {
  if (receipt.client_url) return receipt.client_url;
  const wsUrl = typeof receipt.quickstart_config?.server_url === "string"
    ? receipt.quickstart_config.server_url
    : "";
  if (wsUrl) {
    return wsUrl
      .replace(/^wss:\/\//i, "https://")
      .replace(/^ws:\/\//i, "http://")
      .replace(/\/api\/bridge\/ws$/i, "/api/bridge/client.mjs");
  }
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/bridge/client.mjs`;
  }
  return "https://your-relaydesk-host/api/bridge/client.mjs";
}

function buildAgentOnboardingPrompt(receipt: SetupReceipt, maskToken: boolean): string {
  const maskedToken = `${receipt.agent.token_prefix}…（复制时自动填入真实凭据）`;
  const tokenValue = maskToken ? maskedToken : receipt.token;
  const clientUrl = resolveClientUrl(receipt);
  const rawConfig = receipt.quickstart_config
    ? { ...receipt.quickstart_config, agent_token: tokenValue }
    : {
        server_url: clientUrl
          .replace(/^https:\/\//i, "wss://")
          .replace(/^http:\/\//i, "ws://")
          .replace(/\/api\/bridge\/client\.mjs$/i, "/api/bridge/ws"),
        agent_token: tokenValue,
        agent_name: receipt.agent.name,
        max_concurrency: receipt.agent.max_concurrency,
        accept_cli_runs: receipt.agent.accept_cli_runs,
        auto_detect_cli_configs: true,
        allowed_roots: [],
        projects: {},
        models: [],
      };
  const configJson = JSON.stringify(rawConfig, null, 2);
  const modeHint = receipt.isRotation
    ? "本次为 Token 轮换重连：若本机已存在 `~/.config/relaydesk-bridge/config.json`，请保留已有的 `allowed_roots`、`projects`、`models` 与 `runtimes` 配置，仅更新 `server_url` 和 `agent_token`。"
    : "若本机已存在 `~/.config/relaydesk-bridge/config.json`，请合并保留已有的 `allowed_roots`、`projects`、`models` 与 `runtimes`，仅更新 `server_url` 和 `agent_token`；否则按下方 JSON 全量创建。";

  return [
    `请帮我在当前这台电脑上安装并连接 Relaydesk Local Bridge（设备名：${receipt.agent.name}），使其在后台常驻运行并自动连上服务端。全程无需 clone Relaydesk 仓库，不要把凭据写入任何代码仓库或 git，最终回复中也不要回显完整 Token。`,
    "",
    "请严格按以下步骤执行并验证：",
    "",
    "1. 检查运行环境：",
    "   - 运行 `node -v` 确认 Node.js >= 24，并记录 `NODE_BIN=$(command -v node)`；若版本低于 24，先说明并停止。",
    "   - 创建目录：`mkdir -p ~/.config/relaydesk-bridge ~/.local/share/relaydesk-bridge ~/.local/state/relaydesk-bridge && chmod 700 ~/.config/relaydesk-bridge`。",
    "",
    "2. 写入本机配置 `~/.config/relaydesk-bridge/config.json`（权限必须为 `0600`）：",
    `   - ${modeHint}`,
    "   - 建议：如果本机常用代码根目录（如当前目录或其父级工作区目录）需要允许在 Relaydesk 网页端远程绑定，请顺手将其绝对路径加入 `allowed_roots`（不要填 `/` 或整个 `$HOME`）。",
    "   - 默认配置参考：",
    "```json",
    configJson,
    "```",
    "",
    "3. 下载独立零依赖 Bridge 客户端并校验 SHA-256：",
    "   - 通过 Header 携带设备 Token 下载（禁止把 Token 放在 URL 参数中）：",
    "```bash",
    `TMP_HDR=$(mktemp) && TMP_BIN=$(mktemp)`,
    `curl -fsSL -D "$TMP_HDR" -H "Authorization: Bearer ${tokenValue}" "${clientUrl}" -o "$TMP_BIN"`,
    `EXPECTED_SHA=$(awk 'tolower($1)=="x-content-sha256:"{gsub(/\\r/,"",$2); print tolower($2)}' "$TMP_HDR")`,
    `ACTUAL_SHA=$( (shasum -a 256 "$TMP_BIN" 2>/dev/null || sha256sum "$TMP_BIN") | awk '{print tolower($1)}' )`,
    `test -n "$EXPECTED_SHA" && test "$EXPECTED_SHA" = "$ACTUAL_SHA"`,
    `mv "$TMP_BIN" ~/.local/share/relaydesk-bridge/relaydesk-bridge.mjs && chmod 755 ~/.local/share/relaydesk-bridge/relaydesk-bridge.mjs && rm -f "$TMP_HDR"`,
    "```",
    "   - 若校验失败立即停止并报告原因。",
    "",
    "4. 配置后台常驻服务并立即启动（确保继承包含 `node`、`claude`、`codex`、`git` 的完整 `PATH`）：",
    "   - **macOS**：写入 `~/Library/LaunchAgents/com.relaydesk.bridge.plist`（Label 为 `com.relaydesk.bridge`，`ProgramArguments` 为 `[$NODE_BIN, \"$HOME/.local/share/relaydesk-bridge/relaydesk-bridge.mjs\", \"--config\", \"$HOME/.config/relaydesk-bridge/config.json\"]`，`RunAtLoad=true`，`KeepAlive=true`，日志输出至 `~/.local/state/relaydesk-bridge/bridge.log`，`EnvironmentVariables.PATH` 包含当前 shell 的 `$PATH`）。先 `launchctl bootout gui/$(id -u)/com.relaydesk.bridge 2>/dev/null || true`，再 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.relaydesk.bridge.plist` 并 `launchctl kickstart -k gui/$(id -u)/com.relaydesk.bridge`。",
    "   - **Linux**：优先创建 `~/.config/systemd/user/relaydesk-bridge.service` 并执行 `systemctl --user daemon-reload && systemctl --user enable --now relaydesk-bridge.service`；若无 systemd 则先结束旧进程再用 `nohup \"$NODE_BIN\" ~/.local/share/relaydesk-bridge/relaydesk-bridge.mjs --config ~/.config/relaydesk-bridge/config.json >> ~/.local/state/relaydesk-bridge/bridge.log 2>&1 &` 后台启动。",
    "",
    "5. 验证连接成功：",
    "   - 等待 2~3 秒后查看 `~/.local/state/relaydesk-bridge/bridge.log` 末尾日志，确认已出现 `connected as` 握手成功输出。",
    "   - 向我汇报：连接状态、识别到的模型数量、已配置的 `allowed_roots` / `projects`，以及如果需要在网页端为项目绑定本机目录还差什么。",
  ].join("\n");
}

function SetupInstructions({ receipt, dismiss }: { receipt: SetupReceipt; dismiss: () => void }) {
  const [reveal, setReveal] = useState(false);
  const config = receipt.quickstart_config ? JSON.stringify(receipt.quickstart_config, null, 2) : "";
  const startCommand =
    receipt.start_command ||
    "node ~/.local/share/relaydesk-bridge/relaydesk-bridge.mjs --config ~/.config/relaydesk-bridge/config.json";
  const masked = `${receipt.agent.token_prefix}…`;

  const promptReal = useMemo(() => buildAgentOnboardingPrompt(receipt, false), [receipt]);
  const promptPreview = useMemo(
    () => buildAgentOnboardingPrompt(receipt, !reveal),
    [receipt, reveal],
  );

  return (
    <section
      className="mx-5 mb-4 space-y-3.5 rounded-xl border border-indigo-500/35 bg-indigo-500/[0.04] dark:bg-indigo-500/[0.06] p-4"
      aria-label="一次性接入凭据"
    >
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
              {receipt.isRotation
                ? `已轮换「${receipt.agent.name}」的设备凭据`
                : `一键接入「${receipt.agent.name}」`}
            </h3>
            <span className="text-[10.5px] font-medium px-1.5 py-0.5 rounded-md bg-indigo-500/15 text-indigo-700 dark:text-indigo-300">
              任意目录直接发给 Agent
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            点击下方按钮复制完整接入 Prompt，粘贴给任意目录下的 Claude Code 或 Codex，Agent 会自动下载独立客户端、写入加密配置、配置后台常驻并完成连线。凭据仅本次可见，关闭后无法找回。
          </p>
        </div>
        <Button size="xs" variant="ghost" onClick={dismiss}>
          我已保存，关闭
        </Button>
      </div>

      {/* Primary Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton
            size="sm"
            value={promptReal}
            label="一键复制 Agent 接入 Prompt"
            copiedLabel="接入 Prompt 已复制"
            className="!bg-[var(--rd-accent)] !text-white !border-transparent hover:!bg-[var(--rd-accent-hover)] shadow-xs"
          />
          <Button
            size="xs"
            variant="ghost"
            icon={reveal ? "eye-off" : "eye"}
            aria-pressed={reveal}
            onClick={() => setReveal((v) => !v)}
          >
            {reveal ? "隐藏真实凭据" : "显示真实凭据"}
          </Button>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
          <Icon name="lock" size={12} className="text-emerald-500" />
          {reveal
            ? "预览正在显示真实 Token，注意防止录屏泄露"
            : "预览默认隐藏 Token，复制时自动带入真实凭据"}
        </span>
      </div>

      <pre className={codeBox}>{promptPreview}</pre>

      {/* Collapsible Manual Reference */}
      <details className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)]/70 px-3.5 py-2.5 text-xs">
        <summary className="cursor-pointer select-none font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          手动配置参考（单项复制 Token / config.json / 启动命令）
        </summary>
        <div className="mt-3 space-y-3 border-t border-[var(--border-subtle)] pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="text-[var(--text-muted)]">设备 Token：</span>
              <code className="break-all font-mono">{reveal ? receipt.token : masked}</code>
            </div>
            <CopyButton size="xs" value={receipt.token} label="复制 Token" copiedLabel="已复制" />
          </div>

          {config && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="break-all text-[var(--text-muted)]">
                  本机配置路径 <code>~/.config/relaydesk-bridge/config.json</code>（权限 0600）
                </span>
                <CopyButton size="xs" value={config} label="复制完整配置" copiedLabel="已复制" />
              </div>
              <pre className={codeBox}>
                {reveal ? config : config.replaceAll(receipt.token, masked)}
              </pre>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="break-all text-[var(--text-muted)]">
              独立客户端启动命令：<code>{startCommand}</code>
            </span>
            <CopyButton size="xs" value={startCommand} label="复制启动命令" copiedLabel="已复制" />
          </div>
        </div>
      </details>
    </section>
  );
}

function AgentDetails({ agent }: { agent: BridgeAgentSummary }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
        {(["claude", "codex"] as const).map((runtime) => (
          <span key={runtime} className="inline-flex items-center gap-1">
            <span
              className={`inline-block size-1.5 rounded-full ${
                agent.runtimes[runtime]?.available ? "bg-emerald-500" : "bg-zinc-400"
              }`}
            />
            <code>{runtime}</code>{" "}
            {agent.runtimes[runtime]?.available ? agent.runtimes[runtime]?.version || "可用" : "未检测到"}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <Icon
            name={agent.capabilities.allowed_roots_enabled ? "shield-check" : "shield"}
            size={12}
            className={agent.capabilities.allowed_roots_enabled ? "text-emerald-600 dark:text-emerald-400" : ""}
          />
          {agent.capabilities.allowed_roots_enabled ? "支持 Web 远程绑定目录" : "未开启 allowed_roots"}
        </span>
      </div>
      <details className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium">模型目录 · {agent.models.length}</summary>
        {agent.models.length ? (
          <ul className="mt-2 divide-y divide-[var(--border-subtle)]">
            {agent.models.map((m) => (
              <li key={`${m.runtime}:${m.id}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2">
                <strong>{m.label || m.id}</strong>
                <code className="break-all text-[var(--text-muted)]">
                  {m.runtime} / {m.id}
                </code>
                {m.context_window && (
                  <span className="rounded bg-[var(--surface-subtle)] px-1.5 py-0.5 tabular-nums">
                    上下文 {m.context_window.toLocaleString()}
                  </span>
                )}
                {m.supports_effort === false ? (
                  <span>不可调思考强度</span>
                ) : m.effort_levels?.length ? (
                  <span>思考：{m.effort_levels.map((e) => effortLabels[e]).join(" / ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[var(--text-muted)]">此设备尚未上报模型。</p>
        )}
      </details>
      {agent.bindings.length ? (
        <ul className="space-y-1 text-xs">
          {agent.bindings.map((b) => (
            <li key={b.project_id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{b.project_name || b.project_id}</span>
              <code className="break-all text-[var(--text-muted)]">{b.workdir || "未设置目录"}</code>
              <span
                className={
                  b.enabled && b.path_ok
                    ? "text-emerald-700 dark:text-emerald-300"
                    : "text-[var(--text-muted)]"
                }
              >
                {!b.enabled ? "已禁用" : b.path_ok ? "目录已验证" : b.path_error || "目录未验证"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[var(--text-muted)]">尚未绑定项目目录（可在项目设置的「执行优先级与节点绑定」卡片中配置）。</p>
      )}
    </>
  );
}

export function LocalAgentsSettingsCard() {
  const toast = useToast();
  const [agents, setAgents] = useState<BridgeAgentSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [receipt, setReceipt] = useState<SetupReceipt | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const result = await api.listBridgeAgents();
      if (seq.current === n) {
        setAgents(result.agents);
        setError("");
      }
    } catch (err) {
      if (seq.current === n) setError(err instanceof Error ? err.message : "无法加载设备列表");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => {
      seq.current++;
      window.clearInterval(timer);
    };
  }, [load]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "设备操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-primary)] shadow-2xs">
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-teal-500/10 text-teal-700 dark:text-teal-300">
            <Icon name="monitor" size={16} />
          </span>
          <div>
            <h2 className="text-[14.5px] font-semibold">本机执行节点 · Local Agents</h2>
            <p className="text-xs text-[var(--text-muted)]">
              注册设备后一键复制接入 Prompt 发给任意目录下的 Agent，自动安装独立客户端并完成连接。
            </p>
          </div>
        </div>
        {!adding && (
          <Button size="sm" icon="plus" disabled={busy || !!receipt} onClick={() => setAdding(true)}>
            添加本机 Agent
          </Button>
        )}
      </header>

      {adding && (
        <form
          className="flex flex-wrap items-end gap-2 px-5 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || busy) return;
            void run(async () => {
              const result = await api.createBridgeAgent(name.trim());
              setReceipt({ ...result, isRotation: false });
              setAdding(false);
              setName("");
            });
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            设备名称
            <input
              autoFocus
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：工作室 Mac"
              className="h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-2 text-sm"
            />
          </label>
          <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
            生成一键接入 Prompt
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setAdding(false)}>
            取消
          </Button>
        </form>
      )}

      {receipt && <SetupInstructions key={receipt.token} receipt={receipt} dismiss={() => setReceipt(null)} />}

      {error && (
        <div role="alert" className="flex items-center gap-2 px-5 pb-3 text-xs text-rose-600">
          {error}
          <Button size="xs" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}

      {!agents?.length && !error && (
        <p className="border-t border-[var(--border-subtle)] px-5 py-4 text-xs text-[var(--text-muted)]">
          {agents ? "尚未注册本机执行节点。" : "正在读取设备列表…"}
        </p>
      )}

      {agents?.map((agent) => (
        <article key={agent.id} className="space-y-3 border-t border-[var(--border-subtle)] px-5 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <LivePulseDot active={agent.online} tone={agent.online ? "emerald" : "zinc"} />
              <h3 className="break-all text-sm font-semibold">{agent.name}</h3>
              <span className="text-xs text-[var(--text-muted)]">
                {agent.online ? "在线" : "离线"} · 运行 {agent.active_runs} / {agent.max_concurrency}
              </span>
            </div>
            <span className="text-xs text-[var(--text-muted)]" title={formatDateTime(agent.last_seen_at)}>
              {agent.last_seen_at ? `最近在线 ${formatRelativeTime(agent.last_seen_at)}` : "尚未连接"}
            </span>
          </div>

          <p className="break-all font-mono text-xs text-[var(--text-muted)]">
            {[agent.hostname, agent.platform, agent.bridge_version && `Bridge ${agent.bridge_version}`]
              .filter(Boolean)
              .join(" · ") || "等待设备上报主机信息"}
          </p>

          <AgentDetails agent={agent} />

          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              icon="refresh-cw"
              disabled={!agent.online || busy}
              onClick={() =>
                void run(async () => {
                  await api.refreshBridgeAgent(agent.id);
                  toast.success("已请求设备刷新目录");
                })
              }
            >
              刷新目录
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy || !!receipt}
              onClick={() => {
                if (
                  window.confirm(
                    `轮换「${agent.name}」的 Token？旧凭据将立即失效，可用新生成的一键 Prompt 让 Agent 自动更新重连。`,
                  )
                ) {
                  void run(async () => {
                    const rotated = await api.rotateBridgeAgentToken(agent.id);
                    setReceipt({ ...rotated, isRotation: true });
                  });
                }
              }}
            >
              轮换 Token（生成重连 Prompt）
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`删除「${agent.name}」？连接将断开，该设备的项目目录绑定也会被移除。`)) {
                  void run(async () => {
                    await api.deleteBridgeAgent(agent.id);
                    if (receipt?.agent.id === agent.id) setReceipt(null);
                    toast.info("设备已删除");
                  });
                }
              }}
            >
              删除
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
