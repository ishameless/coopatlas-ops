// src/orchestrator.ts
// CoopAtlas Ops — main pipeline.
//   Sentry alert → normalize → dedupe → classify → decide → act
// Actions:
//   - auto_patch        → dispatch GitHub workflow immediately
//   - needs_approval    → WhatsApp the ops admin, park the incident
//   - ignore            → log + close

import { randomUUID } from 'crypto';
import { config, PROJECT_TO_REPO } from './config';
import { classifyAlert, applyHeuristics } from './classifier';
import { decide } from './policy';
import { dispatchPatch, mergePullRequest } from './github';
import { notifyAdmin } from './whatsapp/client';
import {
  upsertIncident,
  getLatestIncidentByIssue,
  createRun,
  updateIncidentStatus,
  getIncidentById,
  getRunById,
  applyCallback,
  isStatePersisted,
} from './state';
import type { Incident, SentryAlert, ExecutorCallback } from './types';

const ACTIVE_STATUSES = new Set(['received', 'classifying', 'awaiting_approval', 'approved', 'dispatched', 'executing', 'awaiting_merge', 'escalated']);

export async function handleSentryAlert(alert: SentryAlert): Promise<{ incidentId: string; decision: string }> {
  const repo = PROJECT_TO_REPO[alert.projectSlug] ?? null;

  // ── Dedupe: if this Sentry issue is already tracked & open, re-alert → bump. ──
  if (alert.issueId) {
    const existing = await getLatestIncidentByIssue(alert.issueId);
    if (existing && ACTIVE_STATUSES.has(existing.status)) {
      console.log(`[ops] dedupe: issue ${alert.issueId} already open (${existing.status}).`);
      await updateIncidentStatus(existing.id, existing.status);
      return { incidentId: existing.id, decision: existing.decision ?? 'ignored' };
    }
  }

  const incidentId = randomUUID();
  const incident: Incident = {
    id: incidentId,
    source: 'sentry',
    projectSlug: alert.projectSlug,
    sentryIssueId: alert.issueId,
    sentryEventId: alert.eventId,
    title: alert.message.slice(0, 300),
    level: alert.level,
    stacktrace: alert.stacktrace,
    rawPayload: alert.raw,
    severity: null,
    risk: null,
    summary: null,
    classificationReason: null,
    decision: null,
    status: 'received',
    repo,
    runId: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await upsertIncident(incident);
  await updateIncidentStatus(incidentId, 'classifying');

  // ── Classify (LLM if armed, else heuristic fallback). ──
  const classification = applyHeuristics(await classifyAlert(alert), alert);

  // Prefer the LLM's repo hint when the project slug didn't map.
  const resolvedRepo = repo ?? classification.repo;

  // ── Decide. ──
  const decision = decide(classification, resolvedRepo);

  await upsertIncident({
    ...incident,
    repo: resolvedRepo,
    severity: classification.severity,
    risk: classification.risk,
    summary: classification.summary,
    classificationReason: classification.reason,
    decision,
  });

  if (decision === 'ignore') {
    await updateIncidentStatus(incidentId, 'closed', { decision: 'ignore' });
    return { incidentId, decision };
  }

  if (decision === 'auto_patch') {
    await updateIncidentStatus(incidentId, 'approved', { decision: 'auto_patch' });
    await runPatch(incidentId, resolvedRepo ?? '', classification.summary, classification.severity);
    return { incidentId, decision };
  }

  // needs_approval → WhatsApp the admin
  await updateIncidentStatus(incidentId, 'awaiting_approval', { decision: 'needs_approval' });
  await notifyApprovalRequired(incidentId, resolvedRepo, classification);
  return { incidentId, decision };
}

/** Dispatch the executor workflow and park the incident on it. */
export async function runPatch(
  incidentId: string,
  repo: string,
  summary: string,
  severity: string,
): Promise<void> {
  const incident = await getIncidentById(incidentId);
  if (!incident) return;

  const { runId, ok } = await dispatchPatch({
    repo,
    incidentId,
    title: incident.title,
    severity,
    summary,
    stacktrace: incident.stacktrace,
  });

  await createRun({
    id: runId,
    incidentId,
    repo,
    status: 'queued',
    prUrl: null,
    diffSummary: null,
    output: null,
    deployed: false,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await updateIncidentStatus(incidentId, ok ? 'dispatched' : 'failed', {
    runId,
    error: ok ? null : 'dispatch failed',
  });
}

// ─────────────────────────────
// APPROVAL FLOW
// ─────────────────────────────

async function notifyApprovalRequired(
  incidentId: string,
  repo: string | null,
  c: { severity: string; risk: string; summary: string; reason: string },
): Promise<void> {
  const repoLabel = repo ?? 'unknown-repo';
  const body = [
    `⚠️ CoopAtlasOps — approval needed`,
    ``,
    `Issue: ${c.summary}`,
    `Repo: ${repoLabel}`,
    `Severity: ${c.severity.toUpperCase()} | Risk: ${c.risk.toUpperCase()}`,
    `Why: ${c.reason}`,
    ``,
    `Reply: APPROVE to auto-patch`,
    `       SKIP to ignore this alert`,
    `       STATUS for all open issues`,
  ].join('\n');
  await notifyAdmin(body, { title: c.summary, severity: c.severity, incidentId: incidentId.slice(0, 8) });
  console.log(`[ops] ${incidentId} awaiting approval (${repoLabel}).`);
}

export async function handleApproval(
  incidentId: string,
  action: 'approve' | 'skip',
): Promise<{ ok: boolean; message: string }> {
  const incident = await getIncidentById(incidentId);
  if (!incident) return { ok: false, message: `Unknown incident ${incidentId}.` };
  if (incident.status !== 'awaiting_approval') {
    return { ok: false, message: `Incident ${incidentId} is ${incident.status} — not awaiting approval.` };
  }

  if (action === 'skip') {
    await updateIncidentStatus(incidentId, 'closed', { decision: incident.decision ?? 'needs_approval' });
    return { ok: true, message: `Incident ${incidentId} skipped.` };
  }

  const repo = incident.repo;
  if (!repo || !isKnownRepoForRun(repo)) {
    await updateIncidentStatus(incidentId, 'failed', { error: 'approve: no repo mapped' });
    return { ok: false, message: `Cannot approve ${incidentId}: no repo mapped.` };
  }

  await updateIncidentStatus(incidentId, 'approved', { decision: 'needs_approval' });
  await runPatch(incidentId, repo, incident.summary ?? incident.title, incident.severity ?? 'high');
  return { ok: true, message: `Patch dispatched for ${repo} (incident ${incidentId}).` };
}

function isKnownRepoForRun(repo: string): boolean {
  return ['coopatlas-backend', 'coopatlas-mobile', 'coopatlas-hub-website', 'COOPATLAS_COFFEE'].includes(repo);
}

// ─────────────────────────────
// EXECUTOR CALLBACK
// ─────────────────────────────

/**
 * Handle the executor's POST-back. Applies the callback, then if the patch
 * finished with an un-merged PR (OPS_AUTO_MERGE=false), WhatsApp the admin
 * that a PR is ready for review — APPROVE merges it.
 */
export async function handleExecutorCallback(cb: ExecutorCallback): Promise<void> {
  await applyCallback(cb);

  const incident = await getIncidentById(cb.incident_id);
  if (incident?.status !== 'awaiting_merge') return;

  const run = incident.runId ? await getRunById(incident.runId) : null;
  const body = [
    `🔀 CoopAtlasOps — patch PR ready for review`,
    ``,
    `Issue: ${incident.title.slice(0, 200)}`,
    `Repo: ${incident.repo ?? 'unknown'}`,
    run?.prUrl ? `PR: ${run.prUrl}` : null,
    ``,
    `Reply: APPROVE to merge & deploy`,
    `       SKIP to leave the PR open`,
    `       STATUS for all open issues`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  await notifyAdmin(body, { title: incident.title, severity: 'merge', incidentId: cb.incident_id.slice(0, 8) });
  console.log(`[ops] ${cb.incident_id} awaiting merge approval.`);
}

// ─────────────────────────────
// MERGE APPROVAL FLOW
// ─────────────────────────────

export async function handleMergeApproval(
  incidentId: string,
  action: 'approve' | 'skip',
): Promise<{ ok: boolean; message: string }> {
  const incident = await getIncidentById(incidentId);
  if (!incident) return { ok: false, message: `Unknown incident ${incidentId}.` };
  if (incident.status !== 'awaiting_merge') {
    return { ok: false, message: `Incident ${incidentId} is ${incident.status} — not awaiting merge.` };
  }

  const run = incident.runId ? await getRunById(incident.runId) : null;
  const repo = run?.repo ?? incident.repo;

  if (action === 'skip') {
    await updateIncidentStatus(incidentId, 'closed', { decision: incident.decision ?? 'auto_patch' });
    return { ok: true, message: `Incident ${incidentId} — PR left open, not merged.` };
  }

  if (!repo || !run?.prUrl) {
    await updateIncidentStatus(incidentId, 'failed', { error: 'approve merge: no repo or PR url' });
    return { ok: false, message: `Cannot merge ${incidentId}: missing repo or PR url.` };
  }

  const { ok, merged, error } = await mergePullRequest(repo, run.prUrl);
  if (!ok) {
    await updateIncidentStatus(incidentId, 'failed', { error: `merge failed: ${error ?? 'unknown'}` });
    return { ok: false, message: `Merge failed: ${error ?? 'unknown'}` };
  }

  if (merged) {
    await updateIncidentStatus(incidentId, 'deployed', { decision: incident.decision ?? 'auto_patch' });
    return { ok: true, message: `Merged ${repo} PR — Render/Vercel auto-deploying.` };
  }
  await updateIncidentStatus(incidentId, 'closed', { decision: incident.decision ?? 'auto_patch' });
  return { ok: true, message: `PR for ${repo} already merged — nothing to do.` };
}

// ─────────────────────────────
// MISC
// ─────────────────────────────

export async function statusSummary(): Promise<string> {
  const persisted = isStatePersisted();
  const lines = ['📋 CoopAtlasOps — open issues'];
  if (!persisted) lines.push('(state: in-memory only — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)');

  const { listOpenIncidents } = await import('./state');
  const incidents = await listOpenIncidents();
  if (!incidents.length) {
    lines.push('   none open.');
    return lines.join('\n');
  }
  for (const inc of incidents.slice(0, 12)) {
    lines.push(`   • [${inc.status}] ${inc.id.slice(0, 8)} — ${inc.title.slice(0, 60)}`);
  }
  return lines.join('\n');
}

export { config };
