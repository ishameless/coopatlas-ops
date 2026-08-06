// src/llm-runner.ts
// CoopAtlas Ops — run model inference on a GitHub Actions runner instead of
// the host process so opencode's memory footprint never lands on Render.
//
// Pattern: the host dispatches a `coopatlas-llm` workflow, parks a pending
// promise keyed by run_id, and releases it when the workflow POSTs the output
// back to `/ops/webhooks/llm`. Clean shutdown clears all pending jobs.

import { randomUUID } from 'crypto';
import { config } from './config';
import { dispatchLlmRun } from './github';

interface PendingJob {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

const pending = new Map<string, PendingJob>();

function setTimer(runId: string, job: PendingJob, timeoutMs: number): void {
  job.timer = setTimeout(() => {
    pending.delete(runId);
    job.reject(new Error(`llm run ${runId} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  job.timer.unref?.();
}

/**
 * Run a prompt on a GitHub Actions opencode runner and return the text output.
 * Blocks (async) until the workflow calls back or the timeout elapses.
 */
export async function runOpencodeRemote(prompt: string, timeoutMs = 120_000): Promise<string | null> {
  const runId = randomUUID();
  const ok = await dispatchLlmRun({
    runId,
    prompt,
    callbackUrl: `${config.opsBaseUrl}/webhooks/llm`,
    callbackToken: config.callbackToken,
  });
  if (!ok) {
    console.warn(`[ops] llm run ${runId} could not be dispatched (not armed).`);
    return null;
  }

  return new Promise<string>((resolve, reject) => {
    const job: PendingJob = { resolve, reject, timer: null };
    pending.set(runId, job);
    setTimer(runId, job, timeoutMs);
  });
}

/**
 * Called by the `/ops/webhooks/llm` route when a workflow POSTs its output.
 * Resolves the pending promise for that run_id. Mirrors handleExecutorCallback's
 * grain: unknown/expired ids are ignored so the pipeline is never blocked.
 */
export function resolveLlmRun(runId: string, output: string): boolean {
  const job = pending.get(runId);
  if (!job) return false;
  pending.delete(runId);
  if (job.timer) clearTimeout(job.timer);
  job.resolve(output);
  return true;
}

/** Reject any in-flight jobs whose runner was torn down (host shutdown). */
export function shutdownLlmRunner(): void {
  for (const [runId, job] of pending) {
    pending.delete(runId);
    if (job.timer) clearTimeout(job.timer);
    job.reject(new Error('host shutting down — in-flight llm run cancelled'));
  }
}