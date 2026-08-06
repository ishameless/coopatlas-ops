// src/router.ts
// CoopAtlas Ops — Express router mounted into the host backend at /ops.
// The host app owns helmet/cors/body-parsing/error handling; this router is
// intentionally dependency-light so it can't interfere with the host's flows.

import { Router } from 'express';
import { config, logConfigSummary } from './config';
import { parseSentryWebhook } from './sentry/parse';
import { handleSentryAlert, handleExecutorCallback } from './orchestrator';
import { handleVerification, handleInbound } from './whatsapp/webhook';
import type { ExecutorCallback } from './types';
import { startEscalationCron } from './cron';

export function createOpsRouter(opts?: { startCron?: boolean }): Router {
  const router = Router();

  logConfigSummary();

  // ── Health ──────────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    res.json({ service: 'coopatlas-ops', status: 'ok', time: new Date().toISOString() });
  });

  // ── Sentry webhook ──────────────────────────────────────────────
  router.post('/webhooks/sentry', async (req, res) => {
    const secret = config.sentryWebhookSecret;
    if (secret) {
      const auth = req.header('authorization');
      const headerSecret =
        (auth && auth.startsWith('Bearer ') ? auth.slice(7) : null) ??
        req.header('x-sentry-webhook-secret') ??
        req.query.secret;
      if (headerSecret !== secret) {
        res.sendStatus(401);
        return;
      }
    }

    const alert = parseSentryWebhook(req.body as never);
    if (!alert) {
      res.status(422).json({ error: 'unrecognized payload' });
      return;
    }
    if (!alert.projectSlug) {
      res.status(422).json({ error: 'missing project' });
      return;
    }

    try {
      const result = await handleSentryAlert(alert);
      res.json({ ok: true, incident: result });
    } catch (error) {
      console.error('[ops] sentry webhook failed:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'processing failed' });
    }
  });

  // ── WhatsApp webhook ────────────────────────────────────────────
  router.get('/webhooks/whatsapp', handleVerification);
  router.post('/webhooks/whatsapp', handleInbound);

  // ── Executor callback (GitHub Actions → POST result back) ───────
  router.post('/webhooks/executor', async (req, res) => {
    const token = req.header('x-ops-token');
    if (token !== config.callbackToken) {
      res.sendStatus(401);
      return;
    }

    const cb = req.body as ExecutorCallback;
    if (!cb.run_id || !cb.incident_id) {
      res.status(422).json({ error: 'missing run_id/incident_id' });
      return;
    }

    try {
      await handleExecutorCallback(cb);
      res.json({ ok: true });
    } catch (error) {
      console.error('[ops] executor callback failed:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'callback failed' });
    }
  });

  if (opts?.startCron !== false) {
    startEscalationCron();
  }

  return router;
}
