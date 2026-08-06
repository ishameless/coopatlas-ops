// src/types.ts
// CoopAtlas Ops — shared types for the orchestrator.

export type IncidentSource = 'sentry' | 'whatsapp' | 'manual';

export type IncidentStatus =
  | 'received'        // webhook landed, not yet classified
  | 'classifying'     // LLM classification in flight
  | 'awaiting_approval'  // risky issue — human must pre-approve the patch
  | 'approved'
  | 'rejected'
  | 'dispatched'      // repository_dispatch sent, waiting on executor
  | 'executing'       // executor reported in_progress
  | 'awaiting_merge'  // patch PR is ready — human must approve the merge
  | 'deployed'        // PR merged + deployed
  | 'failed'          // executor reported failure
  | 'escalated'       // unresolved past escalation threshold
  | 'closed';         // manually resolved / superseded

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type Risk = 'high' | 'medium' | 'low';

export type Decision = 'auto_patch' | 'needs_approval' | 'ignore';

/** Normalized alert extracted from a Sentry webhook (legacy + new shapes). */
export interface SentryAlert {
  projectSlug: string;
  issueId: string | null;
  eventId: string | null;
  level: string;
  message: string;
  culprit: string | null;
  stacktrace: string | null;
  url: string | null;
  tags: Record<string, string>;
  raw: unknown;
}

/** Structured output from the classifier (LLM). */
export interface Classification {
  repo: string | null;
  severity: Severity;
  risk: Risk;
  summary: string;
  reason: string;
  action?: Decision;
  confidence: number; // 0..1
}

export interface Incident {
  id: string;
  source: IncidentSource;
  projectSlug: string | null;
  sentryIssueId: string | null;
  sentryEventId: string | null;
  title: string;
  level: string;
  stacktrace: string | null;
  rawPayload: unknown;
  severity: Severity | null;
  risk: Risk | null;
  summary: string | null;
  classificationReason: string | null;
  decision: Decision | null;
  status: IncidentStatus;
  repo: string | null;
  runId: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PatchRun {
  id: string;
  incidentId: string;
  repo: string;
  status: 'queued' | 'in_progress' | 'success' | 'failure' | 'timed_out';
  prUrl: string | null;
  diffSummary: string | null;
  output: string | null;
  deployed: boolean;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Payload sent via repository_dispatch. */
export interface DispatchPayload {
  event_type: string;
  client_payload: Record<string, unknown>;
}

/** Callback body the executor POSTs back to /ops/webhooks/executor. */
export interface ExecutorCallback {
  run_id: string;
  incident_id: string;
  status: 'in_progress' | 'success' | 'failure' | 'timed_out';
  pr_url?: string | null;
  diff_summary?: string | null;
  output?: string | null;
  deployed?: boolean;
  error?: string | null;
}
