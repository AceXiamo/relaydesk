export type PortalAccessErrorCode =
  | "invalid_link"
  | "expired_link"
  | "revoked_link"
  | "removed_device"
  | "device_limit"
  | "missing_session";

export interface PortalConfig {
  project_name: string;
  label: string;
  can_view_team: boolean;
  can_request_deploy: boolean;
  upload_enabled: boolean;
  ai_enabled?: boolean;
  release_window: string;
}

export interface PortalTask {
  id: string;
  code: string;
  title: string;
  status_label: string;
  created_at: string;
  owned: boolean;
  can_reply: boolean;
  can_accept: boolean;
  can_request_deploy: boolean;
}

export interface PortalMessage {
  id: number;
  author: "reporter" | "team" | string;
  body: string;
  created_at: string;
}

export type DeployGateStatus =
  | "evaluating"
  | "approved"
  | "deferred"
  | "escalated"
  | "failed";

export interface DeployGateEvaluation {
  id: string;
  project_id?: string;
  task_id: string;
  task_code?: string;
  task_number?: number;
  task_title?: string;
  requested_by_label?: string;
  requested_by_device_id?: string | null;
  trigger_source?: "portal" | "widget" | "preset" | string;
  reason?: string;
  status: DeployGateStatus;
  public_reason?: string;
  internal_evidence?: string;
  release_id?: string | null;
  release_number?: number | null;
  created_at: string;
  finished_at?: string | null;
}

export interface PortalTaskDetail {
  task: PortalTask;
  messages: PortalMessage[];
  gate: DeployGateEvaluation | null;
}

export interface PortalDeviceSession {
  id: string;
  link_id: string;
  device_label: string;
  fingerprint_summary: string;
  last_ip: string;
  ticket_count: number;
  last_seen_at: string;
  created_at: string;
}

export interface PortalAccessLink {
  id: string;
  label: string;
  token_prefix: string;
  can_view_team: boolean;
  can_request_deploy: boolean;
  max_devices: number | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  devices: PortalDeviceSession[];
}

export interface PortalLinkPayload {
  label: string;
  can_view_team: boolean;
  can_request_deploy: boolean;
  max_devices: number | null;
  expires_at: string | null;
}

export type FeedbackReleasePreference = "default" | "request_immediate";
