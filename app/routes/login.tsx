import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "~/components/Icon";
import type { AuthStatusPayload } from "~/lib/types";

interface Eip1193RequestArgs {
  readonly method: string;
  readonly params?: readonly unknown[];
}

interface Eip1193Provider {
  request(args: Eip1193RequestArgs): Promise<unknown>;
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  isOkxWallet?: boolean;
  isTrust?: boolean;
  isPhantom?: boolean;
}

interface Eip6963ProviderInfo {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
}

interface Eip6963ProviderDetail {
  readonly info: Eip6963ProviderInfo;
  readonly provider: Eip1193Provider;
}

interface Eip6963AnnounceProviderEvent extends Event {
  readonly detail?: Eip6963ProviderDetail;
}

interface WalletOption {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
  readonly provider: Eip1193Provider;
  readonly source: "eip6963" | "injected";
}

interface ChallengeResponse {
  readonly address: string;
  readonly nonce: string;
  readonly message: string;
}

interface ApiErrorPayload {
  readonly error?: string;
}

type StepKey = "connect" | "verify_address" | "sign";
type SignInPhase = "idle" | StepKey | "complete";

interface MismatchInfo {
  readonly connected: string;
  readonly expected: string;
}

const SIGN_IN_STEPS: ReadonlyArray<{ readonly key: StepKey; readonly label: string }> = [
  { key: "connect", label: "连接钱包" },
  { key: "verify_address", label: "验证地址" },
  { key: "sign", label: "确认签名" },
];

export function meta() {
  return [{ title: "登录 · Relaydesk" }];
}

function getWindowEthereum(): Eip1193Provider | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = (window as Window & { ethereum?: unknown }).ethereum;
  if (
    candidate &&
    typeof candidate === "object" &&
    "request" in candidate &&
    typeof (candidate as Eip1193Provider).request === "function"
  ) {
    return candidate as Eip1193Provider;
  }
  return undefined;
}

function detectInjectedWalletName(provider: Eip1193Provider): string {
  if (provider.isRabby) return "Rabby Wallet";
  if (provider.isOkxWallet) return "OKX Wallet";
  if (provider.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider.isPhantom) return "Phantom";
  if (provider.isTrust) return "Trust Wallet";
  if (provider.isMetaMask) return "MetaMask";
  return "浏览器钱包";
}

function utf8ToHex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  let hex = "0x";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function resolveSafeRedirectTarget(): string {
  if (typeof window === "undefined") return "/";
  const hash = window.location.hash || "";
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next");
  if (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") && !/[\r\n]/.test(next)) {
    try {
      const parsed = new URL(next, window.location.origin);
      if (parsed.origin === window.location.origin && parsed.pathname !== "/login") {
        return parsed.hash ? `${parsed.pathname}${parsed.search}${parsed.hash}` : `${parsed.pathname}${parsed.search}${hash}`;
      }
    } catch {
      // Fall back to root path if the query parameter cannot be parsed.
    }
  }
  return `/${hash}`;
}

function extractErrorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" || typeof code === "string") return code;
  }
  if ("cause" in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "number" || typeof code === "string") return code;
    }
  }
  return undefined;
}

function extractErrorMessage(error: unknown): string {
  const code = extractErrorCode(error);
  if (code === 4001 || code === "ACTION_REJECTED") {
    return "已取消操作，可以重新连接并签名。";
  }
  if (code === -32002) {
    return "钱包扩展中已有待处理的授权请求，请先打开钱包窗口处理。";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  return "登录失败，请重试。";
}

async function postAuth<T>(action: "challenge" | "verify" | "password", payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/auth/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let result: (T & ApiErrorPayload) | null = null;
  try {
    result = (await response.json()) as T & ApiErrorPayload;
  } catch {
    result = null;
  }
  if (!response.ok) {
    throw new Error(result?.error || "登录失败，请重试。");
  }
  if (!result) {
    throw new Error("服务端返回了无效响应，请重试。");
  }
  return result;
}

export default function LoginRoute() {
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [expectedAdminAddress, setExpectedAdminAddress] = useState<string | null>(null);
  const [eip6963Wallets, setEip6963Wallets] = useState<WalletOption[]>([]);
  const [injectedWallet, setInjectedWallet] = useState<WalletOption | null>(null);
  const [selectedUuid, setSelectedUuid] = useState<string>("");
  const [brokenIcons, setBrokenIcons] = useState<Record<string, boolean>>({});
  const [phase, setPhase] = useState<SignInPhase>("idle");
  const [failedStep, setFailedStep] = useState<StepKey | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mismatchInfo, setMismatchInfo] = useState<MismatchInfo | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [scanning, setScanning] = useState(false);
  const inFlightRef = useRef(false);

  const wallets = useMemo<WalletOption[]>(() => {
    if (eip6963Wallets.length > 0) return eip6963Wallets;
    return injectedWallet ? [injectedWallet] : [];
  }, [eip6963Wallets, injectedWallet]);

  const selectedWallet = useMemo<WalletOption | null>(() => {
    if (wallets.length === 0) return null;
    return wallets.find((item) => item.uuid === selectedUuid) ?? wallets[0];
  }, [wallets, selectedUuid]);

  const refreshInjectedFallback = useCallback(() => {
    const provider = getWindowEthereum();
    if (!provider) {
      setInjectedWallet(null);
      return;
    }
    setInjectedWallet({
      uuid: "injected-ethereum",
      name: detectInjectedWalletName(provider),
      icon: "",
      rdns: "window.ethereum",
      provider,
      source: "injected",
    });
  }, []);

  const requestWalletDiscovery = useCallback(() => {
    if (typeof window === "undefined") return;
    setScanning(true);
    refreshInjectedFallback();
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    window.setTimeout(() => setScanning(false), 350);
  }, [refreshInjectedFallback]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function checkStatus() {
      try {
        const response = await fetch("/api/auth/status", {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!active) return;
        if (response.ok) {
          const data = (await response.json()) as AuthStatusPayload;
          if (!active) return;
          setPasswordEnabled(data.passwordEnabled === true);
          if (data.address) {
            setExpectedAdminAddress(data.address);
          }
          if (data.authenticated || data.mode === "none") {
            setRedirecting(true);
            window.location.replace(resolveSafeRedirectTarget());
            return;
          }
        }
      } catch {
        // Keep the login screen interactive if the status check fails.
      } finally {
        if (active) {
          setCheckingAuth(false);
        }
      }
    }

    void checkStatus();

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const onAnnounce = (event: Event) => {
      const announceEvent = event as Eip6963AnnounceProviderEvent;
      const detail = announceEvent.detail;
      if (
        !detail?.info?.uuid ||
        !detail.info.name ||
        !detail.provider ||
        typeof detail.provider.request !== "function"
      ) {
        return;
      }
      setEip6963Wallets((prev) => {
        if (prev.some((entry) => entry.uuid === detail.info.uuid)) {
          return prev;
        }
        return [
          ...prev,
          {
            uuid: detail.info.uuid,
            name: detail.info.name,
            icon: detail.info.icon || "",
            rdns: detail.info.rdns || "",
            provider: detail.provider,
            source: "eip6963",
          },
        ];
      });
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    refreshInjectedFallback();
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
    };
  }, [refreshInjectedFallback]);

  useEffect(() => {
    if (wallets.length === 0) {
      if (selectedUuid) setSelectedUuid("");
      return;
    }
    if (!wallets.some((item) => item.uuid === selectedUuid)) {
      setSelectedUuid(wallets[0].uuid);
    }
  }, [wallets, selectedUuid]);

  const handleCopyAddress = useCallback(async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddress(true);
      window.setTimeout(() => setCopiedAddress(false), 1800);
    } catch {
      // Clipboard API may be restricted in non-secure contexts.
    }
  }, []);

  const handleSignIn = useCallback(async () => {
    if (inFlightRef.current) return;
    const provider = selectedWallet?.provider ?? getWindowEthereum();
    if (!provider || typeof provider.request !== "function") {
      setErrorMessage("请启用浏览器钱包扩展，或用钱包内置浏览器打开此页。");
      setMismatchInfo(null);
      setFailedStep("connect");
      return;
    }

    inFlightRef.current = true;
    setErrorMessage(null);
    setMismatchInfo(null);
    setFailedStep(null);

    let currentStep: StepKey = "connect";
    try {
      setPhase("connect");
      setStatusMessage("请在钱包中选择并授权管理员账户…");

      const accountsResult = await provider.request({ method: "eth_requestAccounts" });
      const account =
        Array.isArray(accountsResult) && typeof accountsResult[0] === "string"
          ? accountsResult[0]
          : "";
      if (!account) {
        throw new Error("未获取到钱包账户，请在钱包中允许连接后重试。");
      }

      const chainResult = await provider.request({ method: "eth_chainId" });
      const chainId = Number(chainResult);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new Error("无法识别当前钱包网络（Chain ID），请检查网络设置后重试。");
      }

      currentStep = "verify_address";
      setPhase("verify_address");
      setStatusMessage("正在校验管理员地址并生成签名消息…");

      const challenge = await postAuth<ChallengeResponse>("challenge", {
        chain_id: chainId,
      });
      setExpectedAdminAddress(challenge.address);

      if (account.toLowerCase() !== challenge.address.toLowerCase()) {
        setMismatchInfo({
          connected: account,
          expected: challenge.address,
        });
        throw new Error(`请在钱包中切换到管理员地址 ${challenge.address} 后重试。`);
      }

      currentStep = "sign";
      setPhase("sign");
      setStatusMessage("请在钱包弹窗中确认本次登录签名…");

      const hexMessage = utf8ToHex(challenge.message);
      const signatureResult = await provider.request({
        method: "personal_sign",
        params: [hexMessage, account],
      });
      if (typeof signatureResult !== "string" || !signatureResult) {
        throw new Error("未收到有效签名，请重试。");
      }

      setStatusMessage("正在验证签名并建立安全会话…");
      await postAuth<{ ok: boolean }>("verify", {
        nonce: challenge.nonce,
        signature: signatureResult,
      });

      setPhase("complete");
      setStatusMessage("验证通过，正在进入控制台…");
      window.location.replace(resolveSafeRedirectTarget());
    } catch (error) {
      setFailedStep(currentStep);
      setPhase("idle");
      setStatusMessage("");
      setErrorMessage(extractErrorMessage(error));
    } finally {
      inFlightRef.current = false;
    }
  }, [selectedWallet]);

  const isBusy = passwordPending || phase === "connect" || phase === "verify_address" || phase === "sign" || phase === "complete";
  const activeStepIndex =
    phase === "connect"
      ? 0
      : phase === "verify_address"
        ? 1
        : phase === "sign"
          ? 2
          : phase === "complete"
            ? 3
            : -1;
  const failedStepIndex = failedStep ? SIGN_IN_STEPS.findIndex((s) => s.key === failedStep) : -1;

  const buttonLabel = (() => {
    switch (phase) {
      case "connect":
        return "正在连接钱包…";
      case "verify_address":
        return "正在验证管理员地址…";
      case "sign":
        return "请在钱包中确认签名…";
      case "complete":
        return "验证成功，正在进入…";
      default:
        return selectedWallet ? `使用 ${selectedWallet.name} 登录` : "连接钱包并签名";
    }
  })();

  return (
    <div className="relative flex min-h-dvh w-full flex-col items-center justify-center overflow-hidden bg-zinc-50 px-4 py-10 text-zinc-900 antialiased selection:bg-indigo-500/20 selection:text-indigo-700 dark:bg-[#0b0c0e] dark:text-zinc-100 dark:selection:text-indigo-200">
      {/* Subtle grid & radial ambient glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-[linear-gradient(to_right,rgba(113,113,122,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(113,113,122,0.08)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_75%_65%_at_50%_35%,#000_40%,transparent_100%)] dark:bg-[linear-gradient(to_right,rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.035)_1px,transparent_1px)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed -top-32 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-indigo-500/[0.09] blur-[110px] dark:bg-indigo-500/[0.13]"
      />

      <main className="relative z-10 w-full max-w-[432px]">
        <section className="relative overflow-hidden rounded-2xl border border-zinc-200/80 bg-white/95 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_20px_50px_-14px_rgba(24,24,27,0.10)] backdrop-blur-xl dark:border-zinc-800/80 dark:bg-[#111215]/95 dark:shadow-[0_1px_0_rgba(255,255,255,0.05)_inset,0_28px_64px_-16px_rgba(0,0,0,0.75)]">
          {/* Top hairline highlight */}
          <div
            aria-hidden="true"
            className="h-px w-full bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent"
          />

          <div className="p-6 sm:p-7">
            {/* Brand & Heading */}
            <header className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <img
                    src="/logo.png"
                    alt="Relaydesk"
                    className="h-8 w-8 rounded-lg shadow-xs ring-1 ring-black/10 dark:ring-white/15 object-cover"
                  />
                  <span className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                    Relaydesk
                  </span>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200/80 bg-zinc-50 px-2.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-400">
                  <Icon name="lucide:shield-check" size={12} className="text-indigo-500 dark:text-indigo-400" />
                  SIWE
                </span>
              </div>

              <div className="space-y-1">
                <h1 className="text-[20px] font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
                  管理员登录
                </h1>
                <p className="text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  连接管理员以太坊钱包并签署一次性登录消息，无需链上交易。
                </p>
              </div>

              {expectedAdminAddress && !mismatchInfo && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200/75 bg-zinc-50/80 px-3 py-2 text-[12px] dark:border-zinc-800/80 dark:bg-zinc-900/50">
                  <span className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
                    <Icon name="lucide:key-round" size={13} className="shrink-0 text-zinc-400 dark:text-zinc-500" />
                    管理员地址
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopyAddress(expectedAdminAddress)}
                    title={expectedAdminAddress}
                    className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[12px] text-zinc-700 transition-colors hover:bg-zinc-200/70 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    <span>{shortenAddress(expectedAdminAddress)}</span>
                    <Icon
                      name={copiedAddress ? "lucide:check" : "lucide:copy"}
                      size={12}
                      className={copiedAddress ? "text-emerald-500" : "text-zinc-400"}
                    />
                  </button>
                </div>
              )}
            </header>

            {checkingAuth || redirecting ? (
              <div className="my-8 flex flex-col items-center justify-center gap-3 py-6 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                  <Icon name="lucide:loader-2" size={18} className="animate-spin text-indigo-500 dark:text-indigo-400" />
                </div>
                <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
                  {redirecting ? "已验证登录状态，正在进入控制台…" : "正在检查当前会话状态…"}
                </p>
              </div>
            ) : (
              <div className="mt-6 space-y-5">
                {/* Step Progress Indicator */}
                <div
                  aria-label="登录步骤"
                  className="rounded-xl border border-zinc-200/75 bg-zinc-50/70 px-3.5 py-3 dark:border-zinc-800/80 dark:bg-zinc-900/40"
                >
                  <ol className="grid grid-cols-3 gap-2">
                    {SIGN_IN_STEPS.map((step, index) => {
                      const isDone =
                        activeStepIndex > index ||
                        (failedStepIndex > index && phase === "idle");
                      const isCurrent = activeStepIndex === index;
                      const isFailed = failedStepIndex === index && phase === "idle";

                      return (
                        <li key={step.key} className="flex items-center gap-2 min-w-0">
                          <span
                            className={[
                              "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-all",
                              isDone
                                ? "bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400"
                                : isCurrent
                                  ? "bg-indigo-500/15 text-indigo-600 ring-2 ring-indigo-500/20 dark:bg-indigo-500/20 dark:text-indigo-400"
                                  : isFailed
                                    ? "bg-rose-500/15 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400"
                                    : "border border-zinc-300/90 bg-white text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-500",
                            ].join(" ")}
                          >
                            {isDone ? (
                              <Icon name="lucide:check" size={12} />
                            ) : isCurrent ? (
                              <Icon name="lucide:loader-2" size={12} className="animate-spin" />
                            ) : isFailed ? (
                              <Icon name="lucide:alert-circle" size={12} />
                            ) : (
                              index + 1
                            )}
                          </span>
                          <span
                            className={[
                              "truncate text-[12px] font-medium transition-colors",
                              isDone
                                ? "text-zinc-700 dark:text-zinc-200"
                                : isCurrent
                                  ? "text-indigo-600 dark:text-indigo-400"
                                  : isFailed
                                    ? "text-rose-600 dark:text-rose-400"
                                    : "text-zinc-400 dark:text-zinc-500",
                            ].join(" ")}
                          >
                            {step.label}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                  {statusMessage && (
                    <p
                      role="status"
                      aria-live="polite"
                      className="mt-2.5 border-t border-zinc-200/70 pt-2 text-[12px] text-zinc-600 dark:border-zinc-800/70 dark:text-zinc-300"
                    >
                      {statusMessage}
                    </p>
                  )}
                </div>

                {/* Wallet Selection */}
                {passwordEnabled && (
                  <form className="space-y-2" onSubmit={async (event) => {
                    event.preventDefault();
                    if (inFlightRef.current) return;
                    const form = event.currentTarget;
                    const password = new FormData(form).get("password");
                    inFlightRef.current = true;
                    setPasswordPending(true);
                    setPasswordError("");
                    try {
                      await postAuth("password", { password });
                      form.reset();
                      window.location.replace(resolveSafeRedirectTarget());
                    } catch (error) {
                      setPasswordError(extractErrorMessage(error));
                    } finally {
                      inFlightRef.current = false;
                      setPasswordPending(false);
                    }
                  }}>
                    <label htmlFor="admin-password" className="text-sm">管理员密码</label>
                    <div className="flex gap-2">
                      <input id="admin-password" name="password" type="password" required
                        autoComplete="current-password" autoCapitalize="none" spellCheck={false}
                        className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-base" />
                      <button disabled={isBusy} className="rounded-lg bg-indigo-600 px-3 text-sm text-white">
                        {passwordPending ? "登录中…" : "密码登录"}
                      </button>
                    </div>
                    {passwordError && <p role="alert" className="text-sm text-red-600">{passwordError}</p>}
                  </form>
                )}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-300">
                        可用钱包
                      </span>
                      {wallets.length > 0 && (
                        <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400">
                          {wallets.length}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={requestWalletDiscovery}
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:pointer-events-none disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-200"
                    >
                      <Icon
                        name="lucide:refresh-cw"
                        size={12}
                        className={scanning ? "animate-spin" : undefined}
                      />
                      <span>重新检测</span>
                    </button>
                  </div>

                  {wallets.length > 0 ? (
                    <div
                      role="radiogroup"
                      aria-label="选择以太坊钱包"
                      className="space-y-2"
                    >
                      {wallets.map((wallet) => {
                        const isSelected = selectedWallet?.uuid === wallet.uuid;
                        const showImage = Boolean(wallet.icon) && !brokenIcons[wallet.uuid];

                        return (
                          <button
                            key={wallet.uuid}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            disabled={isBusy}
                            onClick={() => {
                              setSelectedUuid(wallet.uuid);
                              setErrorMessage(null);
                              setMismatchInfo(null);
                              setFailedStep(null);
                            }}
                            className={[
                              "group flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:pointer-events-none disabled:opacity-60",
                              isSelected
                                ? "border-indigo-500/70 bg-indigo-50/60 shadow-[0_0_0_1px_rgba(99,102,241,0.18)] dark:border-indigo-500/60 dark:bg-indigo-500/[0.08]"
                                : "border-zinc-200/85 bg-white hover:border-zinc-300 hover:bg-zinc-50/80 dark:border-zinc-800/90 dark:bg-zinc-900/40 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/80",
                            ].join(" ")}
                          >
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-200/80 bg-white p-1.5 dark:border-zinc-700/70 dark:bg-zinc-900">
                              {showImage ? (
                                <img
                                  src={wallet.icon}
                                  alt=""
                                  className="h-full w-full object-contain"
                                  onError={() =>
                                    setBrokenIcons((prev) => ({
                                      ...prev,
                                      [wallet.uuid]: true,
                                    }))
                                  }
                                />
                              ) : (
                                <Icon
                                  name="lucide:wallet"
                                  size={18}
                                  className="text-zinc-600 dark:text-zinc-300"
                                />
                              )}
                            </span>

                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[14px] font-medium text-zinc-900 dark:text-zinc-100">
                                {wallet.name}
                              </span>
                              <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                                {wallet.source === "eip6963"
                                  ? wallet.rdns || "EIP-6963 钱包扩展"
                                  : "默认注入式钱包"}
                              </span>
                            </span>

                            <span
                              aria-hidden="true"
                              className={[
                                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                                isSelected
                                  ? "border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500"
                                  : "border-zinc-300 bg-transparent group-hover:border-zinc-400 dark:border-zinc-700 dark:group-hover:border-zinc-500",
                              ].join(" ")}
                            >
                              {isSelected && <Icon name="lucide:check" size={11} />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-zinc-300/90 bg-zinc-50/70 px-4 py-5 text-center dark:border-zinc-800 dark:bg-zinc-900/35">
                      <div className="mx-auto mb-2.5 flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                        <Icon name="lucide:plug" size={17} />
                      </div>
                      <p className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
                        未检测到浏览器钱包扩展
                      </p>
                      <p className="mt-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                        请安装或启用 MetaMask、Rabby、Coinbase Wallet 等钱包扩展，或在移动钱包内置浏览器中打开此页面。
                      </p>
                      <button
                        type="button"
                        onClick={requestWalletDiscovery}
                        className="mt-3.5 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      >
                        <Icon
                          name="lucide:refresh-cw"
                          size={12}
                          className={scanning ? "animate-spin" : undefined}
                        />
                        重新检测钱包
                      </button>
                    </div>
                  )}
                </div>

                {/* Address Mismatch or Error Feedback */}
                {mismatchInfo ? (
                  <div
                    role="alert"
                    className="rounded-xl border border-amber-300/80 bg-amber-50/80 p-3.5 text-[12px] text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
                  >
                    <div className="flex items-start gap-2.5">
                      <Icon
                        name="lucide:shield-alert"
                        size={16}
                        className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
                      />
                      <div className="min-w-0 flex-1 space-y-2">
                        <p className="font-medium text-amber-900 dark:text-amber-200">
                          当前钱包账户不是管理员地址
                        </p>
                        <div className="space-y-1.5 rounded-lg border border-amber-200/80 bg-white/75 p-2.5 font-mono text-[11px] dark:border-amber-500/20 dark:bg-black/25">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-sans text-zinc-500 dark:text-zinc-400">当前账户</span>
                            <span className="truncate text-zinc-700 dark:text-zinc-300" title={mismatchInfo.connected}>
                              {shortenAddress(mismatchInfo.connected)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-sans text-zinc-500 dark:text-zinc-400">管理员地址</span>
                            <button
                              type="button"
                              onClick={() => void handleCopyAddress(mismatchInfo.expected)}
                              title={mismatchInfo.expected}
                              className="inline-flex items-center gap-1 text-amber-800 underline decoration-amber-400/70 underline-offset-2 hover:text-amber-950 dark:text-amber-200 dark:hover:text-white"
                            >
                              <span>{shortenAddress(mismatchInfo.expected)}</span>
                              <Icon
                                name={copiedAddress ? "lucide:check" : "lucide:copy"}
                                size={11}
                              />
                            </button>
                          </div>
                        </div>
                        <p className="text-[11px] leading-relaxed text-amber-800/90 dark:text-amber-200/80">
                          请在钱包中切换到管理员地址 <span className="font-mono break-all">{mismatchInfo.expected}</span> 后重新点击登录。
                        </p>
                      </div>
                    </div>
                  </div>
                ) : errorMessage ? (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 rounded-xl border border-rose-200/90 bg-rose-50/80 px-3.5 py-3 text-[12.5px] leading-relaxed text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
                  >
                    <Icon
                      name="lucide:alert-circle"
                      size={15}
                      className="mt-0.5 shrink-0 text-rose-500 dark:text-rose-400"
                    />
                    <span>{errorMessage}</span>
                  </div>
                ) : null}

                {/* Primary CTA */}
                <button
                  type="button"
                  disabled={isBusy || wallets.length === 0}
                  onClick={() => void handleSignIn()}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 text-[14px] font-medium text-white shadow-xs transition-all hover:bg-zinc-800 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:pointer-events-none disabled:opacity-45 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
                >
                  {isBusy ? (
                    <Icon name="lucide:loader-2" size={16} className="animate-spin" />
                  ) : (
                    <Icon name="lucide:wallet" size={16} />
                  )}
                  <span>{buttonLabel}</span>
                  {!isBusy && <Icon name="lucide:arrow-right" size={15} className="opacity-70" />}
                </button>
              </div>
            )}
          </div>

          {/* Security Footer */}
          <footer className="flex items-center justify-between border-t border-zinc-200/75 bg-zinc-50/70 px-6 py-3 text-[11px] text-zinc-500 dark:border-zinc-800/80 dark:bg-zinc-900/35 dark:text-zinc-400 sm:px-7">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="lucide:lock" size={12} className="text-zinc-400 dark:text-zinc-500" />
              离线签名 · 零 Gas 费用
            </span>
            <span className="font-mono text-[10.5px] text-zinc-400 dark:text-zinc-500">
              EIP-4361 · 12h
            </span>
          </footer>
        </section>
      </main>
    </div>
  );
}
