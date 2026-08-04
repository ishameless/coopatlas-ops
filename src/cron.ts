// src/cron.ts
// CoopAtlas Ops — escalation cron.
// Periodically finds incidents stuck in dispatched/executing/awaiting_approval
// beyond the escalation window and nudges the ops admin on WhatsApp.

import cron from 'node-cron';
import { config } from './config';
import { listOpenIncidents, updateIncidentStatus } from './state';
import { notifyAdmin } from './whatsapp/client';

const ESCALATED_STATUSES = new Set(['dispatched', 'executing', 'awaiting_approval', 'awaiting_merge', 'escalated']);

function minutesSince(iso: string | undefined): number {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

export async function runEscalationOnce(): Promise<void> {
  const incidents = await listOpenIncidents();
  const threshold = config.escalationMinutes;

  for (const inc of incidents) {
    if (!ESCALATED_STATUSES.has(inc.status)) continue;
    const age = minutesSince(inc.updated_at);
    if (age < threshold) continue;

    // Already escalated → only re-nudge every escalationMinutes, cap at 3 nudges.
    const nudgeCount = inc.status === 'escalated' ? 1 : 0;
    if (inc.status === 'escalated' && nudgeCount >= 1) continue;

    await updateIncidentStatus(inc.id, 'escalated');
    const body = [
      `⏰ CoopAtlasOps — escalation`,
      ``,
      `Issue ${inc.id.slice(0, 8)} still unresolved (${Math.round(age)} min):`,
      `   ${inc.title.slice(0, 80)}`,
      `   status: ${inc.status} → ${inc.repo ?? 'unknown repo'}`,
      ``,
      `Reply STATUS for details, APPROVE to patch.`,
    ].join('\n');
    await notifyAdmin(body);
  }
}

let started = false;

export function startEscalationCron(): void {
  if (started) return;
  started = true;
  cron.schedule(config.escalationCron, () => {
    runEscalationOnce().catch((error) =>
      console.error('[ops] escalation cron failed:', error instanceof Error ? error.message : error),
    );
  });
  console.log(`[ops] escalation cron scheduled: ${config.escalationCron}`);
}
