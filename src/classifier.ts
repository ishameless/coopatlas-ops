// src/classifier.ts
// CoopAtlas Ops — issue classifier via OpenCode Zen (DeepSeek).
// Returns a Classification deciding severity/risk/repo so the policy engine
// can pick auto-patch vs. approval. Free tier, shared with the executor.

import { config } from './config';
import type { Classification, SentryAlert, Severity, Risk } from './types';

const MODEL = config.zenModel;
const CLASSIFIER_PROMPT = `You are CoopAtlasOps, the reliability engineer for the CoopAtlas platform
(a coffee & milk cooperative operating system). A Sentry alert has fired.

Classify the issue and reply with a SINGLE JSON object (no markdown, no prose):
{
  "repo": "COOPATLAS_BACKEND" | "coopatlas-mobile" | "COOPATLAS_HUB_WEBSITE" | "CoopAtlas_Coffee" | null,
  "severity": "critical" | "high" | "medium" | "low",
  "risk": "high" | "medium" | "low",
  "summary": "<one-line human summary>",
  "reason": "<1-2 sentence rationale>",
  "confidence": <0.0-1.0>
}

Rules:
- severity critical = entire workflow (milk intake, payments, login) is down or data loss.
- severity high = core feature broken for many users, no workaround.
- severity medium = partial / intermittent, affects some users.
- severity low = cosmetic, non-blocking, dev-only.
- risk high = touching auth, money, DB schema, billing, or mobile/desktop native code.
- If the alert looks like flaky infra (ECONNRESET, timeout, rate-limit, 5xx upstream) lower severity & risk.
- repo: infer from project context / stack trace filenames if possible, else null.`;

function severityRank(s: string): number {
  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return rank[s] ?? 3;
}

function normalizeSeverity(v: unknown): Severity | null {
  if (typeof v !== 'string') return null;
  const s = v.toLowerCase();
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low' ? s : null;
}

function normalizeRisk(v: unknown): Risk | null {
  if (typeof v !== 'string') return null;
  const s = v.toLowerCase();
  return s === 'high' || s === 'medium' || s === 'low' ? s : null;
}

function parseClassification(raw: string): Classification {
  const cleaned = raw
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    const json = JSON.parse(cleaned) as Record<string, unknown>;
    const severity = normalizeSeverity(json.severity) ?? 'medium';
    const risk = normalizeRisk(json.risk) ?? 'medium';
    const confidence = typeof json.confidence === 'number' ? json.confidence : 0.5;
    return {
      repo: typeof json.repo === 'string' && json.repo.length ? json.repo : null,
      severity,
      risk,
      summary: typeof json.summary === 'string' ? json.summary.slice(0, 300) : 'Classified issue',
      reason: typeof json.reason === 'string' ? json.reason.slice(0, 500) : '',
      confidence,
    };
  } catch {
    return {
      repo: null,
      severity: 'medium',
      risk: 'medium',
      summary: 'Classified issue (LLM returned non-JSON)',
      reason: raw.slice(0, 500),
      confidence: 0.3,
    };
  }
}

export function isClassifierArmed(): boolean {
  return Boolean(config.zenApiKey);
}

export async function classifyAlert(alert: SentryAlert): Promise<Classification> {
  if (!isClassifierArmed()) {
    // No LLM configured → conservative default: needs approval.
    return {
      repo: PROJECT_REPO_HINT(alert.projectSlug),
      severity: alert.level === 'error' ? 'high' : alert.level === 'warning' ? 'medium' : 'low',
      risk: 'high',
      summary: alert.message.slice(0, 300),
      reason: 'No ZEN_API_KEY configured — defaulting to needs-approval.',
      confidence: 0.2,
    };
  }

  const userPayload = JSON.stringify({
    project: alert.projectSlug,
    issue: alert.issueId,
    event: alert.eventId,
    level: alert.level,
    message: alert.message,
    culprit: alert.culprit,
    tags: alert.tags,
    stacktrace: (alert.stacktrace ?? '').slice(0, 4000),
  });

  try {
    // The Zen gateway only reliably serves the free model to the opencode
    // client (raw chat/completions HTTP returns 500), so classify by shelling
    // out to `opencode run` exactly like the executor does.
    const prompt = `${CLASSIFIER_PROMPT}\n\nAlert payload:\n${userPayload}`;
    const content = await runOpencode(prompt, 120_000);
    if (!content) throw new Error('classifier: no content');
    return parseClassification(content);
  } catch (error) {
    console.error('[ops] classifier failed:', error instanceof Error ? error.message : error);
    // Fallback: keep previous default but don't block the pipeline.
    return {
      repo: PROJECT_REPO_HINT(alert.projectSlug),
      severity: 'medium',
      risk: 'high',
      summary: alert.message.slice(0, 300),
      reason: 'Classifier unreachable — defaulting to needs-approval.',
      confidence: 0.1,
    };
  }
}

/** Run opencode headless and return the model's raw text output. */
export async function runOpencode(prompt: string, timeoutMs = 120_000): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const local = resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const bin = process.env.OPENCODE_BIN ?? (existsSync(local) ? local : 'opencode');
  const model = `opencode/${MODEL}`;
  const args = ['run', '--model', model];

  return new Promise((resolvePromise) => {
    const child = execFile(bin, args, {
      timeout: timeoutMs,
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCODE_API_KEY: config.zenApiKey ?? process.env.OPENCODE_API_KEY ?? '',
        XDG_DATA_HOME: process.env.OPENCODE_XDG_DATA_HOME,
      },
      maxBuffer: 1024 * 1024,
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      console.error('[ops] opencode spawn failed:', e.message);
      resolvePromise(null);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`[ops] opencode exited ${code}:`, err.slice(0, 500));
        resolvePromise(null);
        return;
      }
      resolvePromise(out.trim() || null);
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

function PROJECT_REPO_HINT(project: string): string | null {
  return project === 'coopatlas-backend'
    ? 'COOPATLAS_BACKEND'
    : project === 'coopatlas-mobile'
      ? 'coopatlas-mobile'
      : project === 'coopatlas-hub-website' || project === 'coopatlas-hub'
        ? 'COOPATLAS_HUB_WEBSITE'
        : null;
}

/** Re-rank a raw classification against known heuristics (never fully trust the LLM). */
export function applyHeuristics(c: Classification, alert: SentryAlert): Classification {
  let severity = c.severity;
  let risk = c.risk;

  // Known-dangerous markers override to high regardless of LLM optimism.
  const text = `${alert.message} ${alert.culprit ?? ''}`.toLowerCase();
  if (/payment|billing|money|invoice|transfer|balance/.test(text) && severityRank(severity) > 1) {
    severity = 'high';
  }
  if (/password|login|auth|token|license|encrypt/.test(text)) {
    risk = risk === 'high' ? risk : 'high';
  }

  // Flaky infra → downgrade.
  if (/ecoconnreset|timeout|econnrefused|rate.limit|429|503|socket hang up/i.test(text)) {
    if (severityRank(severity) > 1) severity = 'medium';
    risk = 'low';
  }

  return { ...c, severity, risk };
}

export function fallbackClassification(message: string): Classification {
  return {
    repo: null,
    severity: 'medium',
    risk: 'high',
    summary: message.slice(0, 300),
    reason: 'Pipeline fallback.',
    confidence: 0,
  };
}
