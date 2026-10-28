import { locPerDollarCostMeasured } from "@repo/api/src/utils/loc-per-dollar";
import type { SessionLocEntry } from "@repo/api/src/utils/session-loc";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import {
  type SessionTotals,
  totalsCostMeasured,
} from "./session-usage-totals.js";

/**
 * The desktop-local per-session LOC and cost derivations (FEA-3090 / FEA-3633).
 * Extracted from `shared-agent-sessions-api.ts` (ISS-4667) so the per-branch
 * fallback-dedup shape lives in one small module instead of inside the serving-op
 * composition root — and so that grandfathered file shrinks. Pure derivations: no
 * source loads, no token summing, no I/O — the caller sums and hands the totals
 * in (ISS-11226).
 *
 * It no longer answers "which lines does this ratio divide cost into?" —
 * ISS-9964 / ISS-9980 (RULED 2026-09-11) retired the desktop-local
 * `sessionLocPerDollarNumeratorLoc` rather than teaching it to agree with the
 * shared helper, because there should not be a separate LOC/$ calculation for
 * desktop and web. The one derivation is `locPerDollarNumeratorLines`
 * (`@repo/api/src/utils/loc-per-dollar`), which counts merged authored PRs; a
 * desktop session before its first cloud sync carries neither PR field, so that
 * helper returns `null` and the surface renders NOT AVAILABLE. What survives
 * here is the local-git LOC and the cost, which feed other desktop reads.
 */

/**
 * Per-session local-git LOC + estimated cost, keyed by session id (FEA-3090).
 *
 * FEA-3633: extends the dedup helper's `SessionLocEntry` (loc + provenance:
 * locSource / repositoryFullName / branch) with `cost`, so the per-branch
 * fallback-dedup shape is defined once in the SSOT and stays identical to the
 * cloud's `SessionLocCost` (apps/api/app/agent-components). When `locSource ===
 * "branch_fallback"` the `loc` is a whole-branch total shared across the branch's
 * authoring sessions, so a cross-session sum must count it once per
 * (repositoryFullName, branch), not once per session.
 */
export type SharedAgentSessionLocCost = SessionLocEntry & {
  cost: number;
  /**
   * Whether `cost` is a MEASURED figure rather than a stand-in for an absent
   * one. Mirrors the cloud `SessionLocCost` field so the two LOC/$ folds share
   * one predicate.
   *
   * ISS-11226: DERIVED, by {@link resolveSessionCost} — the desktop's own
   * authoritative whole-session cost when the session carries one, and the
   * cost-coverage counters `sumTokenUsage` now carries
   * ({@link totalsCostMeasured}) when it does not. It used to be hardcoded
   * `true` because
   * `SessionTotals.estimatedCost` was a bare number and a session with no
   * token-usage rows summed to `0` exactly like one that genuinely cost nothing
   * — so the type could not represent "unknown" and the field asserted the
   * answer instead of reporting it. The totals layer can say "unknown" now, and
   * a measured $0 is reported as the real figure it is.
   */
  costMeasured: boolean;
};

/**
 * Authored local-git lines changed for a session (added + removed), preferring
 * the source-tagged `gitDiffStats` and falling back to the loose top-level
 * scalars — the same precedence the cloud applies when persisting
 * `SessionDetail.linesAdded/linesRemoved` (apps/api/app/agent-sessions).
 */
export function sessionLocalGitLoc(session: SyncedAgentSession): number {
  const git = session.gitDiffStats;
  const added = git?.linesAdded ?? session.linesAdded ?? 0;
  const removed = git?.linesRemoved ?? session.linesRemoved ?? 0;
  return added + removed;
}

/**
 * Projects one session into its `{ loc, cost, provenance }` entry. `totals` is
 * the caller's summed per-model token usage (`sumTokenUsage`), passed in so this
 * module stays a pure derivation over the session row.
 *
 * ISS-11226: it takes the whole {@link SessionTotals} rather than a bare
 * `estimatedCost: number` on purpose — the cost and the evidence that it was
 * measured are one fact, and a caller that could hand over the sum without its
 * coverage is a caller that can reintroduce the hardcoded `true`.
 */
export function sessionLocCost(
  session: SyncedAgentSession,
  totals: SessionTotals
): SharedAgentSessionLocCost {
  const { cost, costMeasured } = resolveSessionCost(session, totals);
  return {
    loc: sessionLocalGitLoc(session),
    cost,
    costMeasured,
    // FEA-3633: mirror the cloud's `loc_source` provenance so the desktop LOC/$
    // dedups the branch/PR-total fallback per branch exactly as the cloud does.
    // The authored gitDiffStats.source carries the "git" | "branch_fallback" tag;
    // loose top-level scalars have no tag (null), matching `resolveLocSourcePatch`
    // in apps/api/app/agent-sessions/service/persist-session-children.ts.
    locSource: session.gitDiffStats?.source ?? null,
    repositoryFullName: session.attribution?.repositoryFullName ?? null,
    branch: session.branch ?? null,
  };
}

/**
 * ISS-11226 (review: whitlockk, codex): the session's whole-session cost and whether
 * it was MEASURED, preferring the desktop's OWN authoritative figure over a
 * coverage verdict re-derived here.
 *
 * `sessionAnalytics.estimatedCostUsd` is the validated output of
 * `resolveSyncedSessionCostUsd` (`sync-source-session-analytics.ts`), which is
 * the TypeScript reading of `sessionEstimatedCostSql` (`token-cost-writes.ts`) —
 * the ONE expression both `session_analytics.est_cost` and
 * `sessions.cost_usd_estimated` are computed from, and the same number the cloud
 * persists to `SessionDetail.estimatedCost` (`persist-session-children.ts`, the
 * LAST writer of that column) and reads back as `estimatedCost !== null`
 * (`apps/api/app/agent-components/loc-per-dollar.ts`). Consuming that owner is
 * what makes Local and Cloud answer "was this priced?" with one rule instead of
 * two spellings of one.
 *
 * `null` is a VALUE there — nothing could price this session — and is distinct
 * from the section being ABSENT, which is a session carrying no analytics rollup
 * at all. Only the absent case falls back to the token-row coverage counters.
 *
 * The WEB-SEARCH-ONLY session is why the order is not cosmetic: its cost is a
 * metadata line item that by construction never appears in `tokenUsageByModel`
 * (`webSearchCostSql`), so the counters see no members and call it unmeasured
 * while both desktop stores and the cloud hold a real figure for it. Publishing
 * a measured cost as unknown is the same defect as publishing an unknown as $0,
 * pointed the other way.
 *
 * The verdict itself is NOT spelled here: `locPerDollarCostMeasured`
 * (`@repo/api/src/utils/loc-per-dollar`) is the one owner both LOC/$ folds and
 * this resolver read, so Local and Cloud cannot answer "was this priced?" two
 * different ways for the same session (review: whitlockk). Its finiteness/sign arm
 * is not redundant with `syncableCostUsd`: this field crosses the sync-source
 * boundary, where a version-skewed or corrupt row is reachable at runtime
 * regardless of what the type says. An impossible value is unmeasured, never a
 * measurement.
 */
function resolveSessionCost(
  session: SyncedAgentSession,
  totals: SessionTotals
): { cost: number; costMeasured: boolean } {
  const analyticsCost = session.sessionAnalytics?.estimatedCostUsd;
  if (analyticsCost === undefined) {
    return {
      cost: totals.estimatedCost,
      costMeasured: totalsCostMeasured(totals),
    };
  }
  if (!locPerDollarCostMeasured(analyticsCost)) {
    // The partial token sum stays in `cost` exactly as before — the verdict, not
    // the number, is what says it must not be trusted.
    return { cost: totals.estimatedCost, costMeasured: false };
  }
  return { cost: analyticsCost, costMeasured: true };
}
