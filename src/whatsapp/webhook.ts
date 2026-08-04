// src/whatsapp/webhook.ts
// CoopAtlas Ops — WhatsApp webhook handler.
// - GET: Meta verification handshake.
// - POST: inbound user messages → command parsing → orchestrator.

import type { Request, Response } from 'express';
import { config } from '../config';
import { handleApproval, handleMergeApproval, statusSummary } from '../orchestrator';
import { sendText } from './client';

// ─────────────────────────────
// GET — verification handshake
// ─────────────────────────────

export function handleVerification(req: Request, res: Response): void {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsappVerifyToken) {
    res.status(200).send(challenge ?? '');
    return;
  }
  res.sendStatus(403);
}

// ─────────────────────────────
// POST — inbound messages
// ─────────────────────────────

export async function handleInbound(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    entry?: {
      changes?: {
        value?: {
          contacts?: { wa_id?: string }[];
          messages?: {
            id?: string;
            from?: string;
            type?: string;
            text?: { body?: string };
          }[];
        };
      }[];
    }[];
  };

  // Always 200 quickly — Meta retries on non-2xx.
  res.status(200).json({ status: 'ok' });

  const entry = body.entry?.[0];
  const value = entry?.changes?.[0]?.value;
  const messages = value?.messages ?? [];
  if (!messages.length || !value) return;

  const waId = value.contacts?.[0]?.wa_id ?? messages[0]?.from ?? '';
  if (!waId) return;

  for (const message of messages) {
    if (message.type !== 'text') continue;
    const text = (message.text?.body ?? '').trim();
    await handleCommand(waId, text);
  }
}

async function handleCommand(waId: string, text: string): Promise<void> {
  const lower = text.toLowerCase().trim();

  if (lower === 'status' || lower === 'help' || lower === 'menu') {
    const summary = await statusSummary();
    await sendText(waId, summary);
    return;
  }

  // approve / skip with optional incident id (first 8 chars)
  const approveMatch = /^(approve|yes|ok|merge)\s*([0-9a-f]{8})?\b/i.exec(text);
  const skipMatch = /^(skip|no|reject|ignore)\s*([0-9a-f]{8})?\b/i.exec(text);

  if (approveMatch) {
    const incident = await resolveIncident(waId, approveMatch[2]);
    if (!incident) {
      await sendText(waId, 'No pending incident found. Reply STATUS to see open issues.');
      return;
    }
    const { ok, message } =
      incident.status === 'awaiting_merge'
        ? await handleMergeApproval(incident.id, 'approve')
        : await handleApproval(incident.id, 'approve');
    await sendText(waId, ok ? `✅ ${message}` : `❌ ${message}`);
    return;
  }

  if (skipMatch) {
    const incident = await resolveIncident(waId, skipMatch[2]);
    if (!incident) {
      await sendText(waId, 'No pending incident found. Reply STATUS to see open issues.');
      return;
    }
    const { ok, message } =
      incident.status === 'awaiting_merge'
        ? await handleMergeApproval(incident.id, 'skip')
        : await handleApproval(incident.id, 'skip');
    await sendText(waId, ok ? `✅ ${message}` : `❌ ${message}`);
    return;
  }

  await sendText(
    waId,
    'CoopAtlasOps commands:\n• APPROVE <id> — approve patch or merge PR\n• SKIP <id> — skip patch / leave PR open\n• STATUS — open issues',
  );
}

/**
 * Resolve "approve abc123" → incident. Without an id, take the newest incident
 * awaiting a decision (approval to patch, or approval to merge). We only honour
 * requests from the ops admin phone.
 */
async function resolveIncident(waId: string, partialId?: string): Promise<import('../types').Incident | null> {
  if (config.opsAdminPhone && waId !== config.opsAdminPhone) {
    return null;
  }

  const { listOpenIncidents } = await import('../state');

  if (partialId) {
    const incidents = await listOpenIncidents();
    const match = incidents.find((i) => i.id.startsWith(partialId));
    return match ?? null;
  }

  const incidents = await listOpenIncidents();
  const awaiting =
    incidents.find((i) => i.status === 'awaiting_approval') ??
    incidents.find((i) => i.status === 'awaiting_merge') ??
    null;
  return awaiting;
}
