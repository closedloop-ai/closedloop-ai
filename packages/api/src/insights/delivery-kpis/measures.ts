// FEA-2952 / PLN-1323 — measures layer.
//
// A "measure" maps a single normalized row to a scalar number (or null when the
// row cannot yield the value). Measures are the per-row math; aggregations then
// fold a measured population into one KPI value. Keeping them separate is what
// makes "median PR size" vs "mean PR size" vs "sum of lines" the same three
// composable pieces recombined by the registry.

import type {
  NormalizedBranch,
  NormalizedPr,
  NormalizedSession,
} from "./normalized-rows.ts";

/** Gross lines changed on a PR: additions + deletions. Nulls treated as 0. */
function linesGross(pr: NormalizedPr): number {
  return (pr.additions ?? 0) + (pr.deletions ?? 0);
}

/** Net lines changed on a PR: additions − deletions. Nulls treated as 0. */
function linesNet(pr: NormalizedPr): number {
  return (pr.additions ?? 0) - (pr.deletions ?? 0);
}

/** Gross lines changed on a branch: additions + deletions. Nulls treated as 0. */
function branchLinesGross(branch: NormalizedBranch): number {
  return (branch.additions ?? 0) + (branch.deletions ?? 0);
}

/**
 * Time from PR creation to merge, in milliseconds. Null when the PR is not
 * merged (no `mergedAt`) so unmerged rows drop out of a latency distribution
 * rather than contributing a fabricated 0.
 *
 * Also null when a clock-skewed PR records a merge BEFORE its creation: the
 * compute pipeline drops only nulls, not negatives, so a sub-zero interval would
 * otherwise contribute a negative latency straight into the TimeToMerge median.
 * Returning null matches the surfaces this SSOT consolidates — the cloud insights
 * surface filters these out (`ms >= 0`) and the desktop duration helpers reject
 * negatives.
 */
function mergeLatencyMs(pr: NormalizedPr): number | null {
  if (pr.mergedAt === null || pr.mergedAt < pr.createdAt) {
    return null;
  }
  return pr.mergedAt - pr.createdAt;
}

/** Cost of a session in USD. Null when the session has no cost telemetry. */
function cost(session: NormalizedSession): number | null {
  return session.costUsd;
}

/** Token usage of a session. Null when the session has no usage telemetry. */
function tokens(session: NormalizedSession): number | null {
  return session.tokens;
}

/** Constant measure of 1 — used by count aggregations over any population. */
function one(): number {
  return 1;
}

export const prMeasures = {
  linesGross,
  linesNet,
  mergeLatencyMs,
  one,
} as const;
export type PrMeasureKey = keyof typeof prMeasures;

export const branchMeasures = {
  branchLinesGross,
  one,
} as const;
export type BranchMeasureKey = keyof typeof branchMeasures;

export const sessionMeasures = {
  cost,
  tokens,
  one,
} as const;
export type SessionMeasureKey = keyof typeof sessionMeasures;
