// src/sentry/parse.ts
// CoopAtlas Ops — normalize Sentry webhook payloads.
// Handles both the classic integration payload and the newer alert-rule
// webhook shape defensively.

import type { SentryAlert } from '../types';

interface RawPayload {
  // legacy integration
  project?: string;
  project_name?: string;
  id?: string;
  event_id?: string;
  message?: string;
  culprit?: string;
  level?: string;
  url?: string;
  // alert-rule webhook
  data?: {
    project_slug?: string;
    project_id?: string;
    group?: string;
    event?: {
      event_id?: string;
      message?: string;
      culprit?: string;
      level?: string;
      title?: string;
      tags?: Record<string, string> | null;
      exception?: {
        values?: { value?: string; type?: string; stacktrace?: { frames?: unknown[] } }[];
      };
      request?: { url?: string } | null;
      [key: string]: unknown;
    };
    triggered_at?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function extractTags(tags: unknown): Record<string, string> {
  if (typeof tags === 'object' && tags !== null) {
    return tags as Record<string, string>;
  }
  if (Array.isArray(tags)) {
    const out: Record<string, string> = {};
    for (const pair of tags) {
      if (Array.isArray(pair) && typeof pair[0] === 'string') {
        out[pair[0]] = pair[1] === undefined ? '' : String(pair[1]);
      }
    }
    return out;
  }
  return {};
}

export function parseSentryWebhook(body: RawPayload): SentryAlert | null {
  // Newer alert-rule webhook shape
  if (body.data && typeof body.data === 'object') {
    const d = body.data;
    const evt = d.event ?? {};
    const frames = evt.exception?.values?.[0]?.stacktrace?.frames ?? null;
    const stacktrace = frames?.length
      ? frames
          .slice(0, 12)
          .map((f) => `${(f as { filename?: string }).filename ?? '?'}:${(f as { lineno?: unknown }).lineno ?? '?'} ${(f as { function?: string }).function ?? ''}`)
          .join('\n')
      : null;

    return {
      projectSlug: d.project_slug ?? '',
      issueId: typeof d.group === 'string' ? d.group : String(d.group ?? ''),
      eventId: evt.event_id ?? null,
      level: evt.level ?? 'error',
      message: evt.message ?? evt.title ?? '',
      culprit: evt.culprit ?? null,
      stacktrace,
      url: evt.request?.url ?? null,
      tags: extractTags(evt.tags),
      raw: body,
    };
  }

  // Legacy integration payload
  if (body.id) {
    return {
      projectSlug: body.project ?? body.project_name ?? '',
      issueId: typeof body.id === 'string' ? body.id : String(body.id),
      eventId: body.event_id ?? null,
      level: body.level ?? 'error',
      message: body.message ?? '',
      culprit: body.culprit ?? null,
      stacktrace: null,
      url: body.url ?? null,
      tags: {},
      raw: body,
    };
  }

  return null;
}
