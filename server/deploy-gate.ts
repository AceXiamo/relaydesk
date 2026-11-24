import { randomUUID } from "node:crypto";
import type {
  DeployGateEvaluation,
  DeployGateSource,
  DeployGateStatus,
  PublicDeployGate,
} from "../app/lib/types.ts";
import { getFeedbackDeployPresetIdentity } from "./feedback-tickets.ts";
import { ApiError } from "./errors.ts";
import {
  gateBatch,
  gateRunbook,
  GateStop,
  inspectChanges,
  judgeChanges,
  measureUsage,
  sampleFresh,
  usageSpec,
  type GateBatch,
} from "./deploy-gate-evidence.ts";
import type { Store } from "./store.ts";

const COOLDOWN = 5 * 60_000;
const LEASE = 2 * 60_000;
const reason: Record<DeployGateStatus, string> = {
  evaluating: "正在检查线上使用情况和本批次变更。",
  approved: "AI 评估通过，本批次已交给发布流程。",
  deferred: "为避免影响当前使用，本次暂缓即时发布，仍按原发布计划安排。",
  escalated: "本批次需要人工确认，已提醒项目管理员。",
  failed: "本次评估未能完成，未触发即时发布。",
};
const publicCols = "id, status, public_reason, created_at, finished_at";
const table = "deploy_gate_evaluations";
interface GateDispatcher {
  busy(projectId: string): boolean;
  prepare(
    projectId: string,
    taskIds: string[],
    target: string,
    label: string,
    base: string,
    evaluationId: string,
  ): { releaseId: string; start(): void };
}
const dispatchers = new WeakMap<Store, GateDispatcher>();
export function registerGateDispatcher(store: Store, dispatcher: GateDispatcher) {
  dispatchers.set(store, dispatcher);
  return () => {
    if (dispatchers.get(store) === dispatcher) dispatchers.delete(store);
  };
}

export function expireGateLeases(store: Store) {
  store.db
    .prepare(
      `UPDATE ${table} SET status='failed', public_reason=?, internal_evidence='{"outcome":"lease_expired"}', finished_at=? WHERE status='evaluating' AND created_at<=?`,
    )
    .run(reason.failed, new Date().toISOString(), new Date(Date.now() - LEASE).toISOString());
}
export function gateInProgress(store: Store, projectId: string) {
  return !!store.db
    .prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND status='evaluating'`)
    .get(projectId);
}
export function listDeployGates(store: Store, projectId: string): DeployGateEvaluation[] {
  store.getProjectRow(projectId);
  return store.db
    .prepare(
      `SELECT g.id,g.status,g.public_reason,g.created_at,g.finished_at,g.project_id,g.task_id,
    g.requested_by_label,g.trigger_source,g.internal_evidence,g.release_id,g.request_reason AS reason,
    t.number AS task_number,t.title AS task_title,r.number AS release_number FROM ${table} g
    JOIN tasks t ON t.id=g.task_id AND t.project_id=g.project_id
    LEFT JOIN releases r ON r.id=g.release_id AND r.project_id=g.project_id
    WHERE g.project_id=? ORDER BY g.rowid DESC LIMIT 200`,
    )
    .all(projectId) as unknown as DeployGateEvaluation[];
}
export function latestDeployGate(store: Store, projectId: string, taskId: string): PublicDeployGate | null {
  return (
    (store.db
      .prepare(
        `SELECT ${publicCols} FROM ${table} WHERE project_id=? AND task_id=? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(projectId, taskId) as unknown as PublicDeployGate) ?? null
  );
}
export function deployGateAvailable(store: Store, projectId: string, widget = false): boolean {
  const policy = store.getProjectDeployPolicy(projectId);
  if (
    !policy.allow_ai_immediate_deploy ||
    (policy.mode !== "scheduled" && policy.mode !== "manual") ||
    (widget && !policy.allow_widget_deploy_request) ||
    store.getProjectRow(projectId).automation_paused
  )
    return false;
  try {
    return !!gateRunbook(store, projectId);
  } catch {
    return false;
  }
}

type Request = { label: string; deviceId?: string | null; source: DeployGateSource; reason?: string };
function portalAllowed(store: Store, projectId: string, deviceId: string, taskId: string) {
  return !!store.db
    .prepare(
      `SELECT 1 FROM portal_device_sessions d JOIN portal_access_links l ON l.id=d.link_id JOIN tasks t ON t.reporter_link_id=l.id
    WHERE d.project_id=? AND l.project_id=d.project_id AND t.project_id=d.project_id AND t.id=? AND d.id=? AND d.revoked_at IS NULL AND l.revoked_at IS NULL
    AND l.can_request_deploy=1 AND (l.expires_at IS NULL OR julianday(l.expires_at)>julianday('now'))`,
    )
    .get(projectId, taskId, deviceId);
}
function authorized(store: Store, projectId: string, taskId: string, r: Request) {
  const widget = r.source === "widget" || (r.source === "preset" && !r.deviceId);
  if (!deployGateAvailable(store, projectId, widget)) return false;
  if (r.source === "preset") {
    const identity = getFeedbackDeployPresetIdentity(store, projectId, taskId, widget);
    return (
      !!identity &&
      (widget ? identity.kind === "widget" : identity.kind === "portal" && identity.deviceId === r.deviceId)
    );
  }
  return widget || (!!r.deviceId && portalAllowed(store, projectId, r.deviceId, taskId));
}
function idle(store: Store, projectId: string) {
  return (
    !store.hasActiveAgentTask(projectId) &&
    !store.hasActiveRelease(projectId) &&
    !store.hasPendingReadyTasks(projectId) &&
    !dispatchers.get(store)?.busy(projectId)
  );
}
function finish(
  store: Store,
  id: string,
  status: DeployGateStatus,
  evidence: Record<string, unknown>,
  releaseId: string | null = null,
) {
  const changed = store.db
    .prepare(
      `UPDATE ${table} SET status=?, public_reason=?, internal_evidence=?, release_id=?, finished_at=? WHERE id=? AND status='evaluating'`,
    )
    .run(status, reason[status], JSON.stringify(evidence), releaseId, new Date().toISOString(), id);
  if (!changed.changes) throw new GateStop("expired_evaluation");
  if (status === "escalated") {
    const row = store.db.prepare(`SELECT task_id FROM ${table} WHERE id=?`).get(id)!;
    store.addMessage(
      String(row.task_id),
      "event",
      "system",
      "AI 发布门禁已转人工，请在发布记录检查证据后决定是否手动发布。",
    );
  }
}

async function evaluate(
  store: Store,
  projectId: string,
  taskId: string,
  request: Request,
  id: string,
  batch: GateBatch,
  hash: string,
  started: number,
) {
  const evidence: Record<string, unknown> = { runbook_hash: hash, task_ids: batch.map((t) => t.id) };
  const dispatcher = dispatchers.get(store);
  try {
    if (!store.db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND status='evaluating'`).get(id)) return;
    if (!authorized(store, projectId, taskId, request)) throw new GateStop("request_no_longer_authorized");
    const book = gateRunbook(store, projectId);
    if (book?.hash !== hash) throw new GateStop("runbook_changed");
    const spec = usageSpec(book.section);
    const changes = await inspectChanges(store, projectId, batch);
    Object.assign(evidence, {
      baseline: changes.base,
      target: changes.target,
      file_count: changes.fileCount,
      change_summary: changes.summary,
      patch_hash: changes.fingerprint,
    });
    const sample = await measureUsage(store, projectId, spec);
    Object.assign(evidence, {
      active_users: sample.active,
      observed_at: new Date(sample.observed).toISOString(),
    });
    const verdict = await judgeChanges(store, projectId, changes, sample, spec.zero_downtime === true);
    evidence.model_verdict = verdict;
    if (
      verdict.verdict !== "approved" ||
      verdict.risk !== "low" ||
      (sample.active > 0 && !spec.zero_downtime)
    ) {
      const status = verdict.risk !== "low" || verdict.verdict === "escalated" ? "escalated" : "deferred";
      store.transaction(true, () => finish(store, id, status, evidence));
      return;
    }
    // Re-sample after inference. A session may have started while the model was working.
    const current = await measureUsage(store, projectId, spec);
    if (
      current.source !== sample.source ||
      current.observed < sample.observed ||
      (current.observed === sample.observed && current.active !== sample.active)
    )
      throw new GateStop("inconsistent_telemetry");
    Object.assign(evidence, {
      active_users: current.active,
      observed_at: new Date(current.observed).toISOString(),
    });
    if (current.active && !spec.zero_downtime) {
      store.transaction(true, () => finish(store, id, "deferred", { ...evidence, outcome: "usage_changed" }));
      return;
    }
    // Compare and claim in the SAME write transaction as the approval. Starting a runner is a post-commit effect.
    const prepared = store.transaction(true, () => {
      if (
        Date.now() - started >= LEASE ||
        !sampleFresh(current) ||
        !authorized(store, projectId, taskId, request) ||
        gateRunbook(store, projectId)?.hash !== hash
      )
        throw new GateStop("policy_authorization_or_evidence_changed");
      if (!dispatcher || dispatchers.get(store) !== dispatcher || !idle(store, projectId))
        throw new GateStop("dispatcher_unavailable_or_busy");
      const last = store.getLastRelease(projectId);
      if (
        last?.id !== changes.baselineId ||
        last.target_sha !== changes.baselineRef ||
        last.status !== "succeeded" ||
        JSON.stringify(gateBatch(store, projectId)) !== JSON.stringify(batch)
      )
        throw new GateStop("batch_or_baseline_changed");
      const release = dispatcher.prepare(
        projectId,
        batch.map((t) => t.id),
        changes.target,
        request.label,
        changes.base,
        id,
      );
      finish(store, id, "approved", evidence, release.releaseId);
      return release;
    });
    prepared.start();
  } catch (err) {
    // Never copy raw provider, database, git, or network errors into task messages / HTTP responses.
    try {
      store.transaction(true, () =>
        finish(store, id, "escalated", {
          ...evidence,
          outcome: err instanceof GateStop ? err.message : "evidence_or_model_unavailable",
        }),
      );
    } catch {
      /* Already finalized/expired, or the service was stopped; leases recover on restart. */
    }
  }
}

export function requestDeployGate(
  store: Store,
  projectId: string,
  taskId: string,
  input: Request,
): PublicDeployGate {
  const saved = store.transaction(true, () => {
    const r: Request = {
      ...input,
      label:
        String(input.label || "反馈者")
          .replace(/[\p{C}`*<>\[\]]/gu, "")
          .slice(0, 80) || "反馈者",
    };
    if (!["portal", "widget", "preset"].includes(r.source) || !authorized(store, projectId, taskId, r))
      throw new ApiError(403, "当前无法申请即时发布。");
    const task = store.findProjectTask(projectId, taskId);
    if (task.status !== "done" || task.deploy_status !== "pending" || task.merged_into)
      throw new ApiError(409, "工单尚未进入待发布状态。");
    if (!idle(store, projectId)) throw new ApiError(409, "项目当前忙碌，请稍后再试。");
    expireGateLeases(store);
    if (gateInProgress(store, projectId)) throw new ApiError(409, "本项目已有评估进行中。");
    const recent = store.db
      .prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND finished_at>? LIMIT 1`)
      .get(projectId, new Date(Date.now() - COOLDOWN).toISOString());
    if (recent) throw new ApiError(429, "本项目刚完成评估，请稍后再试。");
    const id = randomUUID();
    const started = Date.now();
    const now = new Date(started).toISOString();
    const batch = gateBatch(store, projectId);
    const hash = gateRunbook(store, projectId)!.hash;
    store.db
      .prepare(
        `INSERT INTO ${table}(id,project_id,task_id,requested_by_label,requested_by_device_id,request_reason,trigger_source,status,public_reason,created_at) VALUES(?,?,?,?,?,?,?,'evaluating',?,?)`,
      )
      .run(
        id,
        projectId,
        task.id,
        r.label,
        r.deviceId ?? null,
        String(r.reason ?? "").slice(0, 500),
        r.source,
        reason.evaluating,
        now,
      );
    return {
      r,
      id,
      batch,
      hash,
      started,
      taskId: task.id,
      record: {
        id,
        status: "evaluating" as const,
        public_reason: reason.evaluating,
        created_at: now,
        finished_at: null,
      },
    };
  });
  queueMicrotask(() => {
    void evaluate(store, projectId, saved.taskId, saved.r, saved.id, saved.batch, saved.hash, saved.started);
  });
  return saved.record;
}

export function tryPresetGate(store: Store, projectId: string) {
  if (!deployGateAvailable(store, projectId) || !idle(store, projectId)) return;
  // A revoked device must not starve a later, still-authorized applicant.
  const rows = store.db
    .prepare(
      `SELECT id FROM tasks t WHERE project_id=? AND status='done' AND deploy_status='pending' AND merged_into IS NULL AND release_preference='request_immediate'
    AND NOT EXISTS (SELECT 1 FROM ${table} g WHERE g.task_id=t.id) ORDER BY number`,
    )
    .all(projectId);
  for (const t of rows) {
    const identity = getFeedbackDeployPresetIdentity(
      store,
      projectId,
      String(t.id),
      !!store.getProjectDeployPolicy(projectId).allow_widget_deploy_request,
    );
    if (!identity) continue;
    const r = {
      label: identity.kind === "portal" ? identity.label : "本机访客",
      deviceId: identity.kind === "portal" ? identity.deviceId : null,
      source: "preset" as const,
    };
    try {
      requestDeployGate(store, projectId, String(t.id), r);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
    return;
  }
}
