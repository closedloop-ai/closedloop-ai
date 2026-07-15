// FEA-2952 / PLN-1323 — populations layer.
//
// A "population" is a named row selector over NormalizedDeliveryRows. Each one is
// a small, individually testable function that filters to the cohort a KPI is
// measured over, honoring the `window`. The registry names populations by key
// (see registry.ts), so swapping which cohort a KPI measures is a one-line data
// change, never a code change to the compute loop.

import type {
  NormalizedBranch,
  NormalizedDeliveryRows,
  NormalizedPr,
  NormalizedSession,
} from "./normalized-rows.ts";
import { NormalizedPrState } from "./normalized-rows.ts";

/** True when `ts` (epoch ms) falls inside the closed window [start, end]. */
function inWindow(ts: number, rows: NormalizedDeliveryRows): boolean {
  return ts >= rows.window.start && ts <= rows.window.end;
}

/** PRs merged within the window (mergedAt present and in range). */
function mergedPrs(rows: NormalizedDeliveryRows): NormalizedPr[] {
  return rows.prs.filter(
    (pr) =>
      pr.state === NormalizedPrState.Merged &&
      pr.mergedAt !== null &&
      inWindow(pr.mergedAt, rows)
  );
}

/**
 * PRs closed-without-merge within the window. The "closed" arm of the decided
 * denominator (a PR the team declined to land).
 */
function closedPrs(rows: NormalizedDeliveryRows): NormalizedPr[] {
  return rows.prs.filter(
    (pr) =>
      pr.state === NormalizedPrState.Closed &&
      pr.closedAt !== null &&
      inWindow(pr.closedAt, rows)
  );
}

/**
 * "Captured" PRs: every PR observed with a creation time in the window,
 * regardless of terminal state. The broadest cohort — the raw ingest count.
 */
function capturedPrs(rows: NormalizedDeliveryRows): NormalizedPr[] {
  return rows.prs.filter((pr) => inWindow(pr.createdAt, rows));
}

/**
 * "Decided" PRs: merged ∪ closed within the window — PRs whose fate is settled.
 * The denominator for merge rate = merged / (merged + closed).
 *
 * MUTUAL EXCLUSIVITY: this union is disjoint by construction and cannot
 * double-count a single PR. `state` is the AUTHORITATIVE lifecycle field:
 * `mergedPrs` selects only `state === Merged` and `closedPrs` only
 * `state === Closed`, and a PR has exactly one `NormalizedPrState`. Even though
 * GitHub can set both `mergedAt` and `closedAt` on a merged-then-closed PR, such
 * a PR normalizes to `state === Merged` and therefore appears in exactly one arm.
 * The `NormalizedPr` contract carries no stable identity (id/number) field, so a
 * dedup here is not possible; the `state` filter is the guarantee instead. If an
 * identity field is ever added, dedup this union to make the invariant defensive.
 *
 * COMPOSED POPULATION: `decidedPrs` is the union of two OTHER populations
 * (`mergedPrs`, `closedPrs`) rather than a fresh `rows.prs` filter. Its arms are
 * resolved through the optional `resolve` callback so a caller that has already
 * selected those arms for other KPIs can pass a memoized resolver and avoid
 * re-scanning `rows.prs` (FEA-2978). The default resolves each arm directly,
 * preserving the pure `(rows) => NormalizedPr[]` behavior for standalone use.
 */
function decidedPrs(
  rows: NormalizedDeliveryRows,
  resolve: PrPopulationResolver = (key) => prPopulations[key](rows)
): NormalizedPr[] {
  return [...resolve("mergedPrs"), ...resolve("closedPrs")];
}

/**
 * PRs currently open (or draft) — the active review surface. Selected by
 * `observedAt` in window since an open PR has no terminal timestamp.
 */
function activePrs(rows: NormalizedDeliveryRows): NormalizedPr[] {
  return rows.prs.filter(
    (pr) =>
      (pr.state === NormalizedPrState.Open ||
        pr.state === NormalizedPrState.Draft) &&
      inWindow(pr.observedAt, rows)
  );
}

/**
 * Open, non-draft PRs awaiting review — the review backlog cohort. Drafts are
 * excluded because they are not yet requesting review.
 */
function reviewBacklogPrs(rows: NormalizedDeliveryRows): NormalizedPr[] {
  return rows.prs.filter(
    (pr) => pr.state === NormalizedPrState.Open && inWindow(pr.observedAt, rows)
  );
}

/** Branches created within the window that have an associated PR. */
function sessionBranches(rows: NormalizedDeliveryRows): NormalizedBranch[] {
  return rows.branches.filter(
    (branch) => inWindow(branch.startedAt, rows) && branch.hasPr === true
  );
}

/** Sessions started within the window. */
function sessions(rows: NormalizedDeliveryRows): NormalizedSession[] {
  return rows.sessions.filter((session) => inWindow(session.startedAt, rows));
}

/**
 * The registry of PR-row populations. Registry entries reference these by key so
 * a KPI's cohort can be re-pointed declaratively.
 */
export const prPopulations = {
  mergedPrs,
  closedPrs,
  capturedPrs,
  decidedPrs,
  activePrs,
  reviewBacklogPrs,
} as const;
export type PrPopulationKey = keyof typeof prPopulations;

/**
 * Resolves a PR population to its selected rows by key. A composed population
 * (`decidedPrs`) resolves its arms through this so the compute engine can supply
 * a per-pass memoized resolver — each PR population then filters `rows.prs`
 * exactly once regardless of how many KPIs (or compositions) reference it.
 */
export type PrPopulationResolver = (key: PrPopulationKey) => NormalizedPr[];

/**
 * A PR population selector. The optional `resolve` lets a composed population
 * (`decidedPrs`) reuse memoized arms; base populations ignore it. Every entry of
 * `prPopulations` is assignable to this — base selectors simply take one fewer
 * parameter — so the compute engine can call any of them uniformly.
 */
export type PrPopulation = (
  rows: NormalizedDeliveryRows,
  resolve?: PrPopulationResolver
) => NormalizedPr[];

export const branchPopulations = {
  sessionBranches,
} as const;
export type BranchPopulationKey = keyof typeof branchPopulations;

export const sessionPopulations = {
  sessions,
} as const;
export type SessionPopulationKey = keyof typeof sessionPopulations;

export { inWindow };
