import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon.tsx";
import { Button, CopyButton, LivePulseDot, Modal, Switch, cn, useToast } from "./ui.tsx";
import { api, ClientApiError } from "~/lib/api.ts";
import { formatDateTime, formatRelativeTime } from "~/lib/format.ts";
import type { PortalAccessLink, PortalLinkPayload } from "~/lib/portal-types.ts";
import type { ProjectDetail } from "~/lib/types.ts";

interface PortalLinksSettingsCardProps {
  project: ProjectDetail;
}

type ExpiryPreset = "never" | "7d" | "30d" | "90d" | "custom";

function toLocalDatetimeValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildExpiresAt(preset: ExpiryPreset, customLocal: string): string | null {
  if (preset === "never") return null;
  if (preset === "custom") {
    if (!customLocal.trim()) return null;
    const ms = Date.parse(customLocal);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function isLinkExpired(link: PortalAccessLink): boolean {
  return Boolean(link.expires_at && Date.parse(link.expires_at) <= Date.now());
}

function isLinkActive(link: PortalAccessLink): boolean {
  return !link.revoked_at && !isLinkExpired(link);
}

export function PortalLinksSettingsCard({ project }: PortalLinksSettingsCardProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [links, setLinks] = useState<PortalAccessLink[]>([]);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [showInactive, setShowInactive] = useState(false);

  // One-time revealed URL immediately after creation
  const [createdBanner, setCreatedBanner] = useState<{
    label: string;
    fullUrl: string;
  } | null>(null);

  // Create / Edit modal state (reusable form!)
  const [modalOpen, setModalOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<PortalAccessLink | null>(null);
  const [formLabel, setFormLabel] = useState("");
  const [formCanViewTeam, setFormCanViewTeam] = useState(false);
  const [formCanRequestDeploy, setFormCanRequestDeploy] = useState(true);
  const [formUnlimitedDevices, setFormUnlimitedDevices] = useState(false);
  const [formMaxDevices, setFormMaxDevices] = useState("2");
  const [formExpiryPreset, setFormExpiryPreset] = useState<ExpiryPreset>("never");
  const [formCustomExpiry, setFormCustomExpiry] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Action busy states
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revokingLinkId, setRevokingLinkId] = useState<string | null>(null);
  const [revokingDeviceKey, setRevokingDeviceKey] = useState<string | null>(null);

  const loadLinks = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await api.listPortalLinks(project.id);
        setLinks(res.links ?? []);
      } catch (err) {
        if (!silent) {
          toast.error(
            err instanceof ClientApiError ? err.message : "加载反馈面板分享链接失败",
          );
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [project.id, toast],
  );

  useEffect(() => {
    setCreatedBanner(null);
    setConfirmRevokeId(null);
    void loadLinks(false);
  }, [project.id, loadLinks]);

  const { activeLinks, inactiveLinks, totalDevices } = useMemo(() => {
    const active: PortalAccessLink[] = [];
    const inactive: PortalAccessLink[] = [];
    let devices = 0;
    for (const l of links) {
      devices += l.devices.length;
      if (isLinkActive(l)) active.push(l);
      else inactive.push(l);
    }
    return { activeLinks: active, inactiveLinks: inactive, totalDevices: devices };
  }, [links]);

  const openCreateModal = () => {
    setEditingLink(null);
    setFormLabel("");
    setFormCanViewTeam(false);
    setFormCanRequestDeploy(true);
    setFormUnlimitedDevices(false);
    setFormMaxDevices("2");
    setFormExpiryPreset("never");
    setFormCustomExpiry("");
    setFormError(null);
    setModalOpen(true);
  };

  const openEditModal = (link: PortalAccessLink) => {
    setEditingLink(link);
    setFormLabel(link.label);
    setFormCanViewTeam(link.can_view_team);
    setFormCanRequestDeploy(link.can_request_deploy);
    setFormUnlimitedDevices(link.max_devices === null);
    setFormMaxDevices(link.max_devices !== null ? String(link.max_devices) : "2");
    setFormExpiryPreset(link.expires_at ? "custom" : "never");
    setFormCustomExpiry(toLocalDatetimeValue(link.expires_at));
    setFormError(null);
    setModalOpen(true);
  };

  const handleSubmitModal = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmedLabel = formLabel.trim();
    if (!trimmedLabel || trimmedLabel.length > 80) {
      setFormError("请输入 1 至 80 个字符的链接备注（如「产品-小明」或「运营测试组」）。");
      return;
    }

    let maxDevices: number | null = null;
    if (!formUnlimitedDevices) {
      const parsed = Number.parseInt(formMaxDevices, 10);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        setFormError("最大活跃设备数必须为大于 0 的整数。");
        return;
      }
      maxDevices = parsed;
    }

    let expiresAt: string | null = null;
    if (formExpiryPreset === "custom") {
      if (!formCustomExpiry.trim()) {
        setFormError("请选择具体的过期时间，或切换为「永不过期」。");
        return;
      }
      const ms = Date.parse(formCustomExpiry);
      if (!Number.isFinite(ms) || ms <= Date.now()) {
        setFormError("过期时间必须晚于当前时间。");
        return;
      }
      expiresAt = new Date(ms).toISOString();
    } else {
      expiresAt = buildExpiresAt(formExpiryPreset, formCustomExpiry);
    }

    const payload: PortalLinkPayload = {
      label: trimmedLabel,
      can_view_team: formCanViewTeam,
      can_request_deploy: formCanRequestDeploy,
      max_devices: maxDevices,
      expires_at: expiresAt,
    };

    setSubmitting(true);
    try {
      if (editingLink) {
        await api.updatePortalLink(project.id, editingLink.id, payload);
        toast.success(`已更新「${trimmedLabel}」的分享链接配置，现有设备会话已即时生效`);
        setModalOpen(false);
        await loadLinks(true);
      } else {
        const res = await api.createPortalLink(project.id, payload);
        const fullUrl =
          typeof window !== "undefined"
            ? `${window.location.origin}${res.url}`
            : res.url;
        setCreatedBanner({ label: trimmedLabel, fullUrl });
        toast.success("分享链接已生成，请立即复制发送给对应成员");
        setModalOpen(false);
        await loadLinks(true);
      }
    } catch (err) {
      const msg =
        err instanceof ClientApiError
          ? err.message
          : editingLink
            ? "更新分享链接失败，请检查参数后重试"
            : "创建分享链接失败，请稍后重试";
      setFormError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevokeLink = async (link: PortalAccessLink) => {
    setRevokingLinkId(link.id);
    try {
      await api.revokePortalLink(project.id, link.id);
      setConfirmRevokeId(null);
      toast.success(`已停用「${link.label}」并下线其名下全部设备`);
      await loadLinks(true);
    } catch (err) {
      toast.error(err instanceof ClientApiError ? err.message : "停用链接失败");
    } finally {
      setRevokingLinkId(null);
    }
  };

  const handleRevokeDevice = async (linkId: string, deviceId: string, deviceLabel: string) => {
    const key = `${linkId}:${deviceId}`;
    setRevokingDeviceKey(key);
    try {
      await api.revokePortalDevice(project.id, linkId, deviceId);
      toast.success(`已移除设备「${deviceLabel}」，该设备立即失权`);
      await loadLinks(true);
    } catch (err) {
      toast.error(err instanceof ClientApiError ? err.message : "踢出设备失败");
    } finally {
      setRevokingDeviceKey(null);
    }
  };

  const toggleExpand = (linkId: string) => {
    setExpandedIds((prev) => ({ ...prev, [linkId]: !prev[linkId] }));
  };

  const portalCleanUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/p/${encodeURIComponent(project.id)}`
      : `/p/${encodeURIComponent(project.id)}`;

  return (
    <section
      id="relaydesk-portal-links"
      className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs scroll-mt-6"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <Icon name="key-round" size={16} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                独立反馈面板与分享链接
              </h2>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[var(--text-secondary)] tabular-nums">
                {activeLinks.length} 条有效 · {totalDevices} 台设备
              </span>
            </div>
            <p className="text-[12px] text-[var(--text-muted)]">
              签发免登录鉴权分享链接，首次访问自动绑定设备并洗掉地址栏 Token；支持随时调整权限、踢出单设备或吊销整链。
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            icon="refresh-cw"
            onClick={() => void loadLinks(false)}
          >
            刷新
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            icon="plus"
            onClick={openCreateModal}
          >
            创建分享链接
          </Button>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {/* One-time generated URL reveal banner */}
        {createdBanner && (
          <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/[0.06] p-4 space-y-2.5 animate-rd-portal-in">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <Icon
                  name="check-circle-2"
                  size={15}
                  className="text-emerald-600 dark:text-emerald-400 shrink-0"
                />
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                  已为「{createdBanner.label}」生成鉴权分享链接
                </span>
              </div>
              <button
                type="button"
                onClick={() => setCreatedBanner(null)}
                aria-label="关闭提示"
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer p-0.5"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <p className="text-[12px] text-[var(--text-secondary)]">
              服务端仅保存哈希值，此完整链接<strong>仅本次展示</strong>，请立即复制发送；成员打开后会自动完成设备授权并跳转至干净路径{" "}
              <code className="font-mono text-[11.5px]">{portalCleanUrl}</code>。
            </p>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <code className="flex-1 px-3 py-2 rounded-lg border border-emerald-500/25 bg-[var(--surface-card)] font-mono text-[12px] text-[var(--text-primary)] break-all select-all">
                {createdBanner.fullUrl}
              </code>
              <div className="flex items-center gap-1.5 shrink-0">
                <CopyButton
                  value={createdBanner.fullUrl}
                  label="复制链接"
                  copiedLabel="已复制"
                  size="sm"
                  variant="secondary"
                />
                <a
                  href={createdBanner.fullUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] hover:bg-[var(--surface-hover)] text-xs font-medium text-[var(--text-primary)] transition-colors"
                >
                  <Icon name="external-link" size={13} />
                  <span>打开预览</span>
                </a>
              </div>
            </div>
          </div>
        )}

        {/* Loading / Empty / Links list */}
        {loading ? (
          <div className="space-y-2.5">
            {[0, 1].map((idx) => (
              <div
                key={idx}
                className="h-20 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/60 animate-pulse"
              />
            ))}
          </div>
        ) : activeLinks.length === 0 && inactiveLinks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-subtle)]/40 px-5 py-7 text-center space-y-2.5">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mx-auto">
              <Icon name="link-2" size={18} />
            </div>
            <div className="space-y-1">
              <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                尚未创建反馈面板分享链接
              </h3>
              <p className="text-[12px] text-[var(--text-muted)] max-w-md mx-auto leading-relaxed">
                为产品、测试或客户团队签发专属分享链接，对方免登录即可提交反馈、追踪进度、回复追问并在线验收。
              </p>
            </div>
            <div className="pt-1">
              <Button
                type="button"
                variant="primary"
                size="sm"
                icon="plus"
                onClick={openCreateModal}
              >
                生成第一条分享链接
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {activeLinks.map((link) => {
              const expanded = Boolean(expandedIds[link.id]);
              const deviceCount = link.devices.length;
              const atLimit =
                link.max_devices !== null && deviceCount >= link.max_devices;
              const confirming = confirmRevokeId === link.id;

              return (
                <div
                  key={link.id}
                  className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] overflow-hidden transition-colors hover:border-[var(--border-strong)]"
                >
                  <div className="p-3.5 sm:px-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <LivePulseDot tone="emerald" active={deviceCount > 0} />
                        <span className="text-[13.5px] font-semibold text-[var(--text-primary)] truncate">
                          {link.label}
                        </span>
                        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[var(--text-muted)]">
                          {link.token_prefix}••••
                        </span>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border tabular-nums",
                            atLimit
                              ? "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25"
                              : "bg-[var(--surface-subtle)] text-[var(--text-secondary)] border-[var(--border-subtle)]",
                          )}
                        >
                          <Icon name="monitor" size={11} />
                          {link.max_devices !== null
                            ? `${deviceCount} / ${link.max_devices} 台设备`
                            : `${deviceCount} 台设备 · 不限`}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded-md border",
                            link.can_view_team
                              ? "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20"
                              : "bg-[var(--surface-subtle)] text-[var(--text-muted)] border-[var(--border-subtle)]",
                          )}
                        >
                          <Icon name={link.can_view_team ? "eye" : "user"} size={11} />
                          {link.can_view_team ? "可看团队动态" : "仅看本人反馈"}
                        </span>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded-md border",
                            link.can_request_deploy
                              ? "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20"
                              : "bg-[var(--surface-subtle)] text-[var(--text-muted)] border-[var(--border-subtle)]",
                          )}
                        >
                          <Icon name="sparkles" size={11} />
                          {link.can_request_deploy ? "可申请 AI 即时发布" : "不可申请即时发布"}
                        </span>
                        <span className="text-[var(--text-muted)] inline-flex items-center gap-1 ml-1">
                          <Icon name="clock" size={11} />
                          {link.expires_at
                            ? `到期 ${formatDateTime(link.expires_at)}`
                            : "长期有效"}
                        </span>
                        <span className="text-[var(--text-muted)]">
                          · 创建于 {formatRelativeTime(link.created_at)}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        icon={expanded ? "chevron-down" : "monitor"}
                        onClick={() => toggleExpand(link.id)}
                      >
                        设备 ({deviceCount})
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        icon="pen-line"
                        onClick={() => openEditModal(link)}
                      >
                        编辑
                      </Button>
                      {confirming ? (
                        <div className="inline-flex items-center gap-1 pl-1">
                          <Button
                            type="button"
                            variant="danger"
                            size="xs"
                            loading={revokingLinkId === link.id}
                            onClick={() => void handleRevokeLink(link)}
                          >
                            确认吊销
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => setConfirmRevokeId(null)}
                          >
                            取消
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          icon="ban"
                          className="text-rose-600 dark:text-rose-400 hover:bg-rose-500/10"
                          onClick={() => setConfirmRevokeId(link.id)}
                        >
                          吊销
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Expandable active device sessions list */}
                  {expanded && (
                    <div className="border-t border-[var(--border-subtle)] bg-[var(--surface-subtle)]/55 px-4 py-3 space-y-2 animate-rd-portal-in">
                      <div className="flex items-center justify-between gap-2 text-[11.5px] font-medium text-[var(--text-muted)]">
                        <span>已授权活跃设备</span>
                        <span>踢出单个设备后，仅该浏览器立即失权</span>
                      </div>
                      {link.devices.length === 0 ? (
                        <p className="text-[12px] text-[var(--text-muted)] py-2">
                          暂无已激活设备。成员首次打开分享链接后会自动登记在此处。
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {link.devices.map((dev) => {
                            const busy =
                              revokingDeviceKey === `${link.id}:${dev.id}`;
                            return (
                              <div
                                key={dev.id}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-[12px]"
                              >
                                <div className="min-w-0 space-y-0.5">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium text-[var(--text-primary)]">
                                      {dev.device_label || "未知设备"}
                                    </span>
                                    {dev.last_ip && (
                                      <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] text-[var(--text-secondary)]">
                                        {dev.last_ip}
                                      </span>
                                    )}
                                    {dev.fingerprint_summary && (
                                      <span
                                        title={`设备指纹摘要：${dev.fingerprint_summary}`}
                                        className="font-mono text-[10.5px] text-[var(--text-muted)]"
                                      >
                                        #{dev.fingerprint_summary.slice(0, 8)}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-muted)] tabular-nums">
                                    <span>累计提单 {dev.ticket_count} 条</span>
                                    <span title={formatDateTime(dev.last_seen_at)}>
                                      最近活跃 {formatRelativeTime(dev.last_seen_at)}
                                    </span>
                                    <span title={formatDateTime(dev.created_at)}>
                                      首次绑定 {formatDateTime(dev.created_at)}
                                    </span>
                                  </div>
                                </div>

                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  icon="log-out"
                                  loading={busy}
                                  className="text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 shrink-0"
                                  onClick={() =>
                                    void handleRevokeDevice(
                                      link.id,
                                      dev.id,
                                      dev.device_label || "此设备",
                                    )
                                  }
                                >
                                  踢出设备
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Revoked / Expired links collapse */}
            {inactiveLinks.length > 0 && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowInactive((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                >
                  <Icon
                    name={showInactive ? "chevron-down" : "chevron-right"}
                    size={13}
                  />
                  <span>
                    已失效 / 已停用链接（{inactiveLinks.length}）
                  </span>
                </button>
                {showInactive && (
                  <div className="mt-2 space-y-2 animate-rd-portal-in">
                    {inactiveLinks.map((link) => {
                      const revoked = Boolean(link.revoked_at);
                      return (
                        <div
                          key={link.id}
                          className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/40 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 opacity-75"
                        >
                          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                            <span className="font-medium text-[var(--text-secondary)] line-through">
                              {link.label}
                            </span>
                            <span className="font-mono text-[11px] text-[var(--text-muted)]">
                              {link.token_prefix}••••
                            </span>
                            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-zinc-500/10 text-[var(--text-muted)] border border-[var(--border-subtle)]">
                              {revoked ? "已吊销" : "已过期"}
                            </span>
                          </div>
                          <span className="text-[11px] text-[var(--text-muted)]">
                            {revoked && link.revoked_at
                              ? `停用于 ${formatDateTime(link.revoked_at)}`
                              : link.expires_at
                                ? `过期于 ${formatDateTime(link.expires_at)}`
                                : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Reusable Create / Edit Link Modal */}
      <Modal
        open={modalOpen}
        onClose={() => !submitting && setModalOpen(false)}
        title={editingLink ? `编辑分享链接 · ${editingLink.label}` : "创建反馈面板分享链接"}
        subtitle={
          editingLink
            ? "修改权限、设备名额上限或有效期后，该链接下已授权的设备会话会立即生效。"
            : "生成带鉴权 Token 的专属链接，用于内部团队或指定协作方免登录访问独立反馈面板。"
        }
        maxWidth="md"
      >
        <form onSubmit={(e) => void handleSubmitModal(e)} className="space-y-4">
          {formError && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.07] px-3.5 py-2.5 flex items-start gap-2 text-[12.5px] text-rose-700 dark:text-rose-300">
              <Icon name="alert-circle" size={15} className="mt-0.5 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <label className="block space-y-1.5">
            <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
              身份 / 分组备注 <span className="text-rose-500">*</span>
            </span>
            <input
              type="text"
              required
              maxLength={80}
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              placeholder="例如：产品-小明、QA 测试组、核心内测客户"
              className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
            />
            <span className="block text-[11.5px] text-[var(--text-muted)]">
              将作为反馈来源标识展示在工单详情与 AI 门禁申请记录中。
            </span>
          </label>

          {/* Permission switches */}
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/65 p-3.5 space-y-3">
            <Switch
              checked={formCanViewTeam}
              onChange={setFormCanViewTeam}
              label="允许查看「团队动态」"
              description="开启后，对方除「我的反馈」外还可浏览本项目内其他成员提交的脱敏反馈列表。"
            />
            <div className="border-t border-[var(--border-subtle)] pt-3">
              <Switch
                checked={formCanRequestDeploy}
                onChange={setFormCanRequestDeploy}
                label="允许申请 AI 评估即时发布"
                description="当项目处于定时窗口或手动发布模式且开启 AI 门禁时，允许该成员申请评估立即上线。"
              />
            </div>
          </div>

          {/* Max devices quota */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                最大活跃设备数（防转发）
              </span>
              {editingLink && (
                <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
                  当前已绑定 {editingLink.devices.length} 台
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {[1, 2, 5].map((n) => {
                const active = !formUnlimitedDevices && formMaxDevices === String(n);
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setFormUnlimitedDevices(false);
                      setFormMaxDevices(String(n));
                    }}
                    className={cn(
                      "px-2.5 py-1 rounded-lg border text-[12px] font-medium transition-colors cursor-pointer tabular-nums",
                      active
                        ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
                        : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]",
                    )}
                  >
                    {n} 台
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setFormUnlimitedDevices(true)}
                className={cn(
                  "px-2.5 py-1 rounded-lg border text-[12px] font-medium transition-colors cursor-pointer",
                  formUnlimitedDevices
                    ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
                    : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]",
                )}
              >
                不限设备
              </button>
              {!formUnlimitedDevices && (
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={formMaxDevices}
                  onChange={(e) => setFormMaxDevices(e.target.value)}
                  aria-label="自定义设备数上限"
                  className="w-20 h-7.5 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[12.5px] font-mono text-[var(--text-primary)] focus:outline-none focus:border-indigo-500 tabular-nums"
                />
              )}
            </div>
            <p className="text-[11.5px] text-[var(--text-muted)]">
              建议个人专用设为 1–2 台；若调低上限至当前已绑定设备数以下，请先踢出闲置设备。
            </p>
          </div>

          {/* Expiry selector */}
          <div className="space-y-2">
            <span className="block text-[12.5px] font-medium text-[var(--text-primary)]">
              链接有效期
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: "never", label: "永不过期" },
                  { id: "7d", label: "7 天" },
                  { id: "30d", label: "30 天" },
                  { id: "90d", label: "90 天" },
                  { id: "custom", label: "自定义" },
                ] as Array<{ id: ExpiryPreset; label: string }>
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setFormExpiryPreset(opt.id)}
                  className={cn(
                    "px-2.5 py-1 rounded-lg border text-[12px] font-medium transition-colors cursor-pointer",
                    formExpiryPreset === opt.id
                      ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300"
                      : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {formExpiryPreset === "custom" && (
              <input
                type="datetime-local"
                value={formCustomExpiry}
                onChange={(e) => setFormCustomExpiry(e.target.value)}
                className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[12.5px] font-mono text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
              />
            )}
          </div>

          <div className="pt-2 border-t border-[var(--border-subtle)] flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={submitting}
              onClick={() => setModalOpen(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={submitting}
              icon={editingLink ? "save" : "key-round"}
            >
              {editingLink ? "保存更改" : "生成分享链接"}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
