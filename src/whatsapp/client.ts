// src/whatsapp/client.ts
// CoopAtlas Ops — Meta WhatsApp Cloud API outbound client.
// Service conversations are free within the 24h customer-service window.

import { config } from '../config';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

export function isWhatsAppArmed(): boolean {
  return Boolean(config.whatsappAccessToken && config.whatsappPhoneNumberId);
}

/** Send a plain text message to a phone number (E.164, no '+'). */
export async function sendText(to: string, body: string): Promise<boolean> {
  if (!isWhatsAppArmed()) {
    console.warn(`[ops] WhatsApp not armed — would send to ${to}: ${body.slice(0, 80)}`);
    return false;
  }

  const url = `${GRAPH_BASE}/${config.whatsappPhoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsappAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { preview_url: false, body },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(`[ops] WhatsApp send failed (${res.status}):`, detail.slice(0, 400));
      return false;
    }
    return true;
  } catch (error) {
    console.error('[ops] WhatsApp send threw:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Send a business-initiated message using an approved message template.
 * Meta REQUIRES templates for any message sent outside the 24h customer-service
 * window (i.e. when the bot texts the admin first about an incident).
 * Free-form `type: 'text'` is only allowed inside the window.
 */
export async function sendTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  components: Array<{ type: 'header' | 'body' | 'button'; parameters: Array<{ type: 'text'; text: string }> }>,
): Promise<boolean> {
  if (!isWhatsAppArmed()) {
    console.warn(`[ops] WhatsApp not armed — would send template ${templateName} to ${to}`);
    return false;
  }

  const url = `${GRAPH_BASE}/${config.whatsappPhoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsappAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(`[ops] WhatsApp template send failed (${res.status}):`, detail.slice(0, 400));
      return false;
    }
    return true;
  } catch (error) {
    console.error('[ops] WhatsApp template send threw:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Notify the ops admin about a new incident. Tries the approved template first
 * (works outside the 24h window), and falls back to free-form text inside the
 * window. Template vars: {{1}} title, {{2}} severity, {{3}} incident id.
 */
export function notifyAdmin(body: string, opts?: { title?: string; severity?: string; incidentId?: string }): Promise<boolean> {
  if (!config.opsAdminPhone) {
    console.warn('[ops] OPS_ADMIN_PHONE not set — admin notification skipped.');
    return Promise.resolve(false);
  }

  if (opts?.title && opts?.severity && opts?.incidentId) {
    return sendTemplate(config.opsAdminPhone, 'ops_incident_alert', 'en_US', [
      { type: 'header', parameters: [{ type: 'text', text: 'CoopAtlas Ops Alert' }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: opts.title },
          { type: 'text', text: opts.severity },
          { type: 'text', text: opts.incidentId },
        ],
      },
    ]);
  }

  return sendText(config.opsAdminPhone, body);
}
