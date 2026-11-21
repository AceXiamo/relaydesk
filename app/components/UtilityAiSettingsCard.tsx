import { useEffect, useState, type FormEvent } from "react";
import { api } from "~/lib/api.ts";
import type {
  UtilityAiConfigStatus,
  UtilityAiProvider,
  UtilityAiTestResult,
} from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { Button, Select, useToast } from "./ui.tsx";

const inputClass =
  "w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 disabled:opacity-60";

export function UtilityAiSettingsCard() {
  const toast = useToast();
  const [status, setStatus] = useState<UtilityAiConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<UtilityAiProvider>("openai");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [testResult, setTestResult] = useState<UtilityAiTestResult | null>(null);
  const [testError, setTestError] = useState("");

  useEffect(() => {
    let active = true;
    api
      .getUtilityAiConfig()
      .then((res) => {
        if (!active) return;
        setStatus(res);
        setProvider(res.provider);
        setEndpoint(res.endpoint);
        setModel(res.model);
      })
      .catch(() => {
        // non-fatal
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const destinationChanged = Boolean(
    status?.has_api_key &&
      (provider !== status.provider || endpoint.trim().replace(/\/+$/, "") !== status.endpoint),
  );

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (!model.trim()) {
      toast.error("请填写模型名称");
      return;
    }
    if (destinationChanged && !apiKey.trim()) {
      toast.error("切换协议或 API 地址时，请重新输入对应的 API Key");
      return;
    }
    if (!status?.has_api_key && !apiKey.trim()) {
      toast.error("请填写 API Key");
      return;
    }

    setSaving(true);
    setTestResult(null);
    setTestError("");
    try {
      const next = await api.saveUtilityAiConfig({
        provider,
        endpoint: endpoint.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      });
      setStatus(next);
      setProvider(next.provider);
      setEndpoint(next.endpoint);
      setModel(next.model);
      setApiKey("");
      toast.success("全局杂项模型设置已保存");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    setTestError("");
    try {
      const res = await api.testUtilityAiConfig({
        provider,
        endpoint: endpoint.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      });
      setTestResult(res);
      toast.success(`连通正常 · ${res.latency_ms}ms`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "连通性测试失败";
      setTestError(msg);
      toast.error(msg);
    } finally {
      setTesting(false);
    }
  };

  const handleClear = async () => {
    if (clearing) return;
    if (!window.confirm("确定清除已保存的全局杂项模型配置？")) return;
    setClearing(true);
    setTestResult(null);
    setTestError("");
    try {
      const next = await api.disconnectUtilityAiConfig();
      setStatus(next);
      setProvider(next.provider);
      setEndpoint(next.endpoint);
      setModel(next.model);
      setApiKey("");
      toast.success("已清除全局杂项模型配置");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "清除失败");
    } finally {
      setClearing(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSave(e)}
      autoComplete="off"
      className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs"
    >
      <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-violet-500/12 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0">
            <Icon name="sparkles" size={16} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
              全局杂项模型（标题总结 / 轻量任务）
            </h2>
            <p className="text-[12px] text-[var(--text-muted)]">
              跨项目生效，用于自动提炼对话会话标题等轻量后台任务；未配置时自动回退至项目 CLI 模型或本地规则。
            </p>
          </div>
        </div>
        {!loading && status && (
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium shrink-0 ${
              status.configured
                ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                : "bg-[var(--surface-subtle)] text-[var(--text-muted)]"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                status.configured ? "bg-emerald-500" : "bg-zinc-400"
              }`}
            />
            {status.configured
              ? `${status.source === "workspace" ? "已配置" : "环境变量"} · ${status.model}`
              : "未配置"}
          </span>
        )}
      </div>

      <div className="p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div className="space-y-1.5">
            <span
              id="utility-ai-provider-label"
              className="block text-[12.5px] font-medium text-[var(--text-primary)]"
            >
              API 协议
            </span>
            <Select<UtilityAiProvider>
              ariaLabelledBy="utility-ai-provider-label"
              fullWidth
              value={provider}
              disabled={saving || testing}
              options={[
                { value: "openai", label: "OpenAI 兼容（Chat Completions）" },
                { value: "anthropic", label: "Anthropic（Messages API）" },
              ]}
              onChange={(nextProvider) => {
                setProvider(nextProvider);
                setTestResult(null);
                setTestError("");
              }}
            />
          </div>

          <label className="block space-y-1.5">
            <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
              模型名称
            </span>
            <input
              type="text"
              required
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider === "openai" ? "例如 gpt-4o-mini / deepseek-chat" : "例如 claude-haiku-5-5"}
              spellCheck={false}
              className={`${inputClass} font-mono`}
            />
          </label>
        </div>

        <label className="block space-y-1.5">
          <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
            API Endpoint（可选）
          </span>
          <input
            type="url"
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              setTestResult(null);
              setTestError("");
            }}
            placeholder={
              provider === "openai"
                ? "留空默认 https://api.openai.com/v1（支持任意兼容网关）"
                : "留空默认 https://api.anthropic.com"
            }
            spellCheck={false}
            className={`${inputClass} font-mono`}
          />
          <span className="block text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            {provider === "openai"
              ? "支持 DeepSeek、OpenRouter、NewAPI、本地 Ollama（http://127.0.0.1:11434/v1）等 OpenAI Chat Completions 兼容端点。"
              : "支持官方或兼容 Anthropic Messages API 的基础地址（自动补齐 /v1/messages）。"}
          </span>
        </label>

        <label className="block space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
              API Key
            </span>
            {status?.has_api_key && (
              <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                {status.api_key_preview}
              </span>
            )}
          </div>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={
                destinationChanged
                  ? "协议或地址已变更，请重新输入对应的 API Key"
                  : status?.has_api_key
                    ? "已保存，留空保持不变"
                    : "输入 API Key"
              }
              className={`${inputClass} font-mono pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer p-1"
            >
              <Icon name={showKey ? "eye-off" : "eye"} size={15} />
            </button>
          </div>
        </label>

        {testResult && (
          <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/8 text-[12.5px] text-emerald-700 dark:text-emerald-300">
            <Icon name="check-circle-2" size={15} className="shrink-0" />
            <span>
              模型连通正常 · <strong className="font-mono">{testResult.model}</strong> · 延迟{" "}
              <strong className="font-mono">{testResult.latency_ms}ms</strong>
            </span>
          </div>
        )}

        {testError && (
          <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-rose-500/30 bg-rose-500/8 text-[12.5px] text-rose-600 dark:text-rose-400">
            <Icon name="alert-circle" size={15} className="shrink-0" />
            <span className="break-words">{testError}</span>
          </div>
        )}
      </div>

      <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
        <div>
          {status?.source === "workspace" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              loading={clearing}
              onClick={() => void handleClear()}
            >
              清除配置
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon="plug"
            loading={testing}
            disabled={!model.trim() || (!apiKey.trim() && (!status?.has_api_key || destinationChanged))}
            onClick={() => void handleTest()}
          >
            测试连通
          </Button>
          <Button type="submit" variant="primary" size="sm" icon="check" loading={saving}>
            保存杂项模型
          </Button>
        </div>
      </div>
    </form>
  );
}
