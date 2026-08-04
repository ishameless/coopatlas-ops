// src/policy.ts
// CoopAtlas Ops — deterministic auto-patch policy.
// Decision is computed from the classification + repo, NEVER from raw LLM text.

import { APPROVAL_ONLY_REPOS } from './config';
import type { Classification, Decision } from './types';

export function decide(classification: Classification, repo: string | null): Decision {
  // Unknown repo → never auto-patch (could be an unindexed project).
  if (!repo || !isKnownRepo(repo)) return 'needs_approval';

  // Approval-only repos (e.g. desktop, native code) always ask a human.
  if (APPROVAL_ONLY_REPOS.has(repo)) return 'needs_approval';

  // Critical or high risk always require a human in the loop.
  if (classification.severity === 'critical') return 'needs_approval';
  if (classification.risk === 'high') return 'needs_approval';

  // Low-risk, medium severity and below → safe to auto-patch.
  if (classification.risk === 'low' || classification.severity === 'low' || classification.severity === 'medium') {
    return 'auto_patch';
  }

  // High severity + medium risk → conservative: ask.
  return 'needs_approval';
}

export function isKnownRepo(repo: string): boolean {
  return [
    'coopatlas-backend',
    'coopatlas-mobile',
    'coopatlas-hub-website',
    'COOPATLAS_COFFEE',
  ].includes(repo);
}
