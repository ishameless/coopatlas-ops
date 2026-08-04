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

/** Fire-and-forget message to the ops admin. */
export function notifyAdmin(body: string): Promise<boolean> {
  if (!config.opsAdminPhone) {
    console.warn('[ops] OPS_ADMIN_PHONE not set — admin notification skipped.');
    return Promise.resolve(false);
  }
  return sendText(config.opsAdminPhone, body);
}
