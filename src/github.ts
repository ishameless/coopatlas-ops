// src/github.ts
// CoopAtlas Ops — dispatch patch jobs to per-repo GitHub Actions workflows
// via repository_dispatch. The receiving workflow runs opencode in CI to
// patch, typecheck, and deploy the repo, then POSTs the executor callback.

import { randomUUID } from 'crypto';
import { config, resolveRepoName } from './config';
import type { DispatchPayload } from './types';

export function isDispatchArmed(): boolean {
  return Boolean(config.githubToken);
}

/**
 * Dispatch an LLM inference job (classifier or chat) to a GitHub Actions
 * runner instead of running opencode on the host (Render free tier OOMs).
 * The receiving workflow (coopatlas-llm) runs opencode in CI and POSTs the
 * output back to the orchestrator's `/ops/webhooks/llm` endpoint.
 */
export async function dispatchLlmRun(params: {
  runId: string;
  prompt: string;
  callbackUrl: string;
  callbackToken: string;
}): Promise<{ ok: boolean }> {
  if (!config.githubToken) {
    console.warn(`[ops] LLM dispatch not armed — would run ${params.runId}.`);
    return { ok: false };
  }

  // The LLM runner workflow lives on the backend repo (the host of the
  // classifier/chat pipeline). Keep prompting bounded to fit repository_dispatch payload limits.
  const repo = 'coopatlas-backend';
  const payload: DispatchPayload = {
    event_type: 'coopatlas-llm',
    client_payload: {
      run_id: params.runId,
      prompt: params.prompt.slice(0, 24000),
      callback_url: params.callbackUrl,
      callback_token: params.callbackToken,
    },
  };

  const url = `https://api.github.com/repos/${config.githubOwner}/${repo}/dispatches`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error(`[ops] llm dispatch failed (${res.status}):`, detail.slice(0, 400));
      return { ok: false };
    }
    return { ok: true };
  } catch (error) {
    console.error('[ops] llm dispatch threw:', error instanceof Error ? error.message : error);
    return { ok: false };
  }
}

export async function dispatchPatch(params: {
  repo: string;
  incidentId: string;
  title: string;
  severity: string;
  summary: string;
  stacktrace: string | null;
}): Promise<{ runId: string; ok: boolean }> {
  const runId = randomUUID();
  const repo = resolveRepoName(params.repo);
  if (!repo) {
    console.warn(`[ops] cannot dispatch to unknown repo "${params.repo}" (run ${runId}).`);
    return { runId, ok: false };
  }
  if (!isDispatchArmed()) {
    console.warn(
      `[ops] GitHub dispatch not armed — would dispatch to ${repo} (run ${runId}).`,
    );
    return { runId, ok: false };
  }

  const payload: DispatchPayload = {
    event_type: 'coopatlas-patch',
    client_payload: {
      incident_id: params.incidentId,
      run_id: runId,
      repo,
      title: params.title.slice(0, 200),
      severity: params.severity,
      summary: params.summary.slice(0, 500),
      stacktrace: (params.stacktrace ?? '').slice(0, 8000),
      callback_url: `${config.opsBaseUrl}/webhooks/executor`,
      callback_token: config.callbackToken,
    },
  };

  const url = `https://api.github.com/repos/${config.githubOwner}/${repo}/dispatches`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(`[ops] dispatch ${params.repo} failed (${res.status}):`, detail.slice(0, 400));
      return { runId, ok: false };
    }
    console.log(`[ops] dispatched patch → ${params.repo} (run ${runId})`);
    return { runId, ok: true };
  } catch (error) {
    console.error('[ops] dispatch threw:', error instanceof Error ? error.message : error);
    return { runId, ok: false };
  }
}

/**
 * Merge a patch PR (squash) on behalf of the admin who APPROVED it on WhatsApp.
 * The PR URL is e.g. https://github.com/ishameless/coopatlas-backend/pull/42.
 * Returns { ok, merged } — merged=false means the PR was already merged/closed.
 */
export async function mergePullRequest(
  repo: string,
  prUrl: string,
): Promise<{ ok: boolean; merged: boolean; error?: string }> {
  const normalized = resolveRepoName(repo);
  if (!normalized) {
    return { ok: false, merged: false, error: `unknown repo ${repo}` };
  }
  repo = normalized;
  if (!config.githubToken) {
    return { ok: false, merged: false, error: 'GITHUB_TOKEN not configured' };
  }

  const match = /pull\/(\d+)/.exec(prUrl);
  if (!match) {
    return { ok: false, merged: false, error: `cannot parse PR number from ${prUrl}` };
  }
  const prNumber = match[1];

  const url = `https://api.github.com/repos/${config.githubOwner}/${repo}/pulls/${prNumber}/merge`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ merge_method: 'squash' }),
    });

    if (res.ok) {
      console.log(`[ops] merged PR #${prNumber} → ${repo}`);
      return { ok: true, merged: true };
    }

    // 405 = unmergeable, 404/422 = already merged/closed. Treat "already merged"
    // as success so idempotent APPROVE replies don't error out.
    const detail = await res.text();
    if (res.status === 404 || res.status === 422) {
      console.log(`[ops] PR #${prNumber} → ${repo} not mergeable (${res.status}): ${detail.slice(0, 200)}`);
      return { ok: true, merged: false };
    }
    console.error(`[ops] merge PR #${prNumber} → ${repo} failed (${res.status}):`, detail.slice(0, 400));
    return { ok: false, merged: false, error: `merge failed (${res.status})` };
  } catch (error) {
    console.error('[ops] merge threw:', error instanceof Error ? error.message : error);
    return { ok: false, merged: false, error: 'merge threw' };
  }
}
