// src/state.ts
// CoopAtlas Ops — Supabase-backed state for incidents and patch runs.
// In-memory fallback keeps the orchestrator functional even if Supabase is
// not configured yet (pilot/testing), with a console warning per write.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';
import type { Incident, PatchRun, ExecutorCallback } from './types';

let sb: SupabaseClient | null = null;
if (config.supabaseUrl && config.supabaseServiceRoleKey) {
  sb = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

const memoryIncidents = new Map<string, Incident>();
const memoryRuns = new Map<string, PatchRun>();

function warnFallback(table: string): void {
  console.warn(`[ops] Supabase not configured — ${table} stored in memory only.`);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isStatePersisted(): boolean {
  return sb !== null;
}

// ─────────────────────────────
// INCIDENTS
// ─────────────────────────────

export async function upsertIncident(incident: Incident): Promise<Incident> {
  const row = {
    ...incident,
    raw_payload: incident.rawPayload,
    sentry_issue_id: incident.sentryIssueId,
    sentry_event_id: incident.sentryEventId,
    project_slug: incident.projectSlug,
    classification_reason: incident.classificationReason,
    run_id: incident.runId,
    created_at: incident.created_at ?? nowIso(),
    updated_at: nowIso(),
  };
  delete (row as Partial<Incident> & Record<string, unknown>).rawPayload;

  if (!sb) {
    warnFallback('ops_incidents');
    memoryIncidents.set(incident.id, incident);
    return incident;
  }

  const { data, error } = await sb.from('ops_incidents').upsert(row).select().single();
  if (error) {
    console.error('[ops] upsertIncident failed:', error.message);
    return incident;
  }
  return data as Incident;
}

export async function getIncidentById(id: string): Promise<Incident | null> {
  if (!sb) return memoryIncidents.get(id) ?? null;
  const { data, error } = await sb.from('ops_incidents').select().eq('id', id).single();
  if (error) {
    console.error('[ops] getIncidentById failed:', error.message);
    return null;
  }
  return data as Incident;
}

export async function getLatestIncidentByIssue(issueId: string): Promise<Incident | null> {
  if (!sb) {
    const all = [...memoryIncidents.values()]
      .filter((i) => i.sentryIssueId === issueId)
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
    return all[0] ?? null;
  }
  const { data, error } = await sb
    .from('ops_incidents')
    .select()
    .eq('sentry_issue_id', issueId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[ops] getLatestIncidentByIssue failed:', error.message);
    return null;
  }
  return (data as Incident) ?? null;
}

export async function listOpenIncidents(): Promise<Incident[]> {
  const open = ['received', 'classifying', 'awaiting_approval', 'approved', 'dispatched', 'executing', 'escalated', 'awaiting_merge'];
  if (!sb) {
    warnFallback('ops_incidents');
    return [...memoryIncidents.values()].filter((i) => open.includes(i.status));
  }
  const { data, error } = await sb.from('ops_incidents').select().in('status', open).order('updated_at', { ascending: false });
  if (error) {
    console.error('[ops] listOpenIncidents failed:', error.message);
    return [];
  }
  return (data as Incident[]) ?? [];
}

export async function updateIncidentStatus(
  id: string,
  status: Incident['status'],
  patch: Partial<Incident> = {},
): Promise<void> {
  const current = await getIncidentById(id);
  if (!current) return;

  const updated: Incident = { ...current, ...patch, status, updated_at: nowIso() };

  if (!sb) {
    memoryIncidents.set(id, updated);
    return;
  }

  const { error } = await sb
    .from('ops_incidents')
    .update({
      status,
      run_id: updated.runId,
      error: updated.error ?? null,
      updated_at: updated.updated_at,
    })
    .eq('id', id);
  if (error) console.error('[ops] updateIncidentStatus failed:', error.message);
}

// ─────────────────────────────
// PATCH RUNS
// ─────────────────────────────

export async function createRun(run: PatchRun): Promise<PatchRun> {
  if (!sb) {
    warnFallback('ops_patch_runs');
    memoryRuns.set(run.id, run);
    return run;
  }
  const { error } = await sb.from('ops_patch_runs').insert(run);
  if (error) console.error('[ops] createRun failed:', error.message);
  return run;
}

export async function updateRun(id: string, patch: Partial<PatchRun>): Promise<PatchRun | null> {
  const existing = !sb ? memoryRuns.get(id) : await getRunById(id);
  if (!existing) return null;
  const updated: PatchRun = { ...existing, ...patch, updated_at: nowIso() };

  if (!sb) {
    memoryRuns.set(id, updated);
    return updated;
  }

  const { data, error } = await sb.from('ops_patch_runs').update(updated).eq('id', id).select().single();
  if (error) {
    console.error('[ops] updateRun failed:', error.message);
    return updated;
  }
  return data as PatchRun;
}

export async function getRunById(id: string): Promise<PatchRun | null> {
  if (!sb) return memoryRuns.get(id) ?? null;
  const { data, error } = await sb.from('ops_patch_runs').select().eq('id', id).single();
  if (error) {
    console.error('[ops] getRunById failed:', error.message);
    return null;
  }
  return data as PatchRun;
}

/** Apply an executor callback: update the run + the owning incident. */
export async function applyCallback(cb: ExecutorCallback): Promise<void> {
  const run = await getRunById(cb.run_id);
  if (!run) {
    console.error(`[ops] callback for unknown run ${cb.run_id}`);
    return;
  }

  await updateRun(cb.run_id, {
    status: cb.status,
    prUrl: cb.pr_url ?? null,
    diffSummary: cb.diff_summary ?? null,
    output: cb.output ?? null,
    deployed: cb.deployed ?? false,
    error: cb.error ?? null,
  });

  // success + deployed          → shipped
  // success + PR open, not merged → park it for human merge approval
  // success + no PR (no-op)     → nothing to ship
  const incidentStatus: Incident['status'] =
    cb.status === 'success'
      ? cb.deployed
        ? 'deployed'
        : cb.pr_url
          ? 'awaiting_merge'
          : 'deployed'
      : cb.status === 'failure' ? 'failed' :
        cb.status === 'in_progress' ? 'executing' :
        'escalated';

  await updateIncidentStatus(cb.incident_id, incidentStatus, {
    runId: cb.run_id,
    error: cb.error ?? null,
  });
}
