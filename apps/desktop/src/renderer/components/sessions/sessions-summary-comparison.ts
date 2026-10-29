/**
 * ISS-6041 — the desktop Sessions strip's half of the period-over-period
 * comparison.
 *
 * ISS-5809 moved the comparison ARITHMETIC to the producer behind a
 * `comparison=prior` opt-in on the usage read, and the web Sessions page adopted
 * it. Desktop could not: the combined `pageData` port took the base filter shape,
 * so this surface had no field to ask through — even in Cloud mode, where it
 * reads the SAME `createHttpAgentSessionsDataSource` the web page does. The
 * shared `SessionsSummaryCards` therefore chipped its deltas on one surface and
 * showed nothing on the other. The port now carries the opt-in; what is left is
 * the DESKTOP-only decision of when this surface compares at all, which is these
 * two functions.
 *
 * Lives in its own module rather than inline in `SessionsView` because that
 * component is already at the cognitive-complexity ceiling, and because the
 * two-axis gate below is worth asserting on its own.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { USAGE_STRIPPED_FILTER_KEYS } from "@repo/app/agents/data-source/agent-sessions-data-source";
import {
  buildSessionSummaryDeltas,
  type SessionSummaryDeltas,
  shouldSuppressSessionComparison,
} from "@repo/app/agents/lib/session-summary-deltas";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import { useEffect, useRef } from "react";

/**
 * Does the desktop Sessions surface compare periods at all?
 *
 * One axis since ISS-8909:
 *
 *  1. **The producer.** Cloud mode reads the HTTP source, which serves the same
 *     comparison the web page renders. Local mode reads the SQLite source, whose
 *     aggregate covers the requested window only — it has no prior-window read,
 *     so asking would earn a permanent "No prior period" under figures that are
 *     never going to be graded. That, and only that, is what the original
 *     deferral covered.
 * ISS-8909 retired the second axis. The chips used to ride the shared Grid
 * Parity gate (`grid-table-v2`), closed by default, which is why desktop showed
 * none while web showed three with that flag off. Retiring the v1 desktop stack
 * settled that rollout: the gate no longer exists on this surface, so the
 * producer axis below is the whole decision and the reported asymmetry is
 * closed rather than deferred.
 */
export function isSessionComparisonEnabled({
  isCloudMode,
}: {
  isCloudMode: boolean;
}): boolean {
  return isCloudMode;
}

/**
 * The `comparison` opt-in to fold into the combined page-data filters, or
 * nothing.
 *
 * Spread rather than assigned so a non-comparing surface's filter object — and
 * therefore its React Query key — stays byte-identical to the pre-ISS-6041 one,
 * instead of growing an `undefined` entry.
 */
export function sessionComparisonQuery(enabled: boolean): {
  comparison?: AgentSessionComparisonMode;
} {
  return enabled ? { comparison: AgentSessionComparisonMode.Prior } : {};
}

/**
 * The read states the shared suppression rule inspects.
 *
 * Structurally what `shouldSuppressSessionComparison` takes; named here because
 * it is also what {@link useSessionComparisonSuppressed} narrows.
 */
type SessionComparisonRead = {
  // ISS-6382: the GATED pending flag. A read held closed by the restore gate on
  // a warm cache trips none of the other four, so without this the snapshot
  // below would be stamped for a scope this mount never fetched, and the chips
  // would grade the previous view's figures.
  isPending: boolean;
  isLoading: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  isFetching: boolean;
};

/**
 * Is the summary scope — the facet/date/search selection the usage aggregate and
 * its prior window are computed over — the one the held snapshot describes?
 *
 * **Why desktop needs this and web does not.** The shared
 * `shouldSuppressSessionComparison` drops the comparison on ANY placeholder or
 * in-flight read, because a snapshot from a previous query key may describe a
 * different scope than the figures on screen. On web that is exactly right: its
 * usage query is keyed on the SUMMARY scope alone, so the only thing that can
 * churn that key IS a scope change. Desktop reads the FEA-4157 combined
 * list + usage query, whose key additionally carries `limit`/`offset`/`sortBy`/
 * `sortDir` — none of which the usage aggregate depends on, and all of which the
 * HTTP source strips from the usage URL. Applied unnarrowed, the shared rule
 * therefore replaced every chip with the "No prior period" placeholder on every
 * page turn and every column sort: a claim that the prior period does not exist,
 * made about a comparison that was in hand and still correct.
 *
 * So the narrowing restores web's behavior rather than diverging from it — the
 * held `keepPreviousData` snapshot is one whole response (its figures AND its
 * comparison came from the same read), so it stays honest for as long as its
 * scope is the requested one. A genuine scope change still suppresses, because
 * then the figures on screen really do describe a different population.
 *
 * It COMPOSES the shared rule rather than restating it, and narrows exactly one
 * of its arms. That direction matters: the shared helper stays the authority, so
 * an arm added to it later suppresses here too by default, and only the
 * key-churn case — which is the one desktop provably reads differently, because
 * only desktop's key carries dimensions the usage read ignores — is reconsidered.
 * A new arm firing on its own therefore fails CLOSED (no chip), which is the safe
 * direction for a rule about not making claims.
 */
export function useSessionComparisonSuppressed({
  read,
  summaryScopeKey,
  honestLoadingEnabled = false,
}: {
  read: SessionComparisonRead;
  summaryScopeKey: string;
  /**
   * ISS-7422: forwarded to the shared rule, which flag-on stops treating a
   * background revalidation as grounds to withhold a comparison. The narrowing
   * below still runs — it covers the PLACEHOLDER arm, which desktop reaches on
   * every page turn and re-sort and the shared rule never relaxes.
   */
  honestLoadingEnabled?: boolean;
}): boolean {
  // The scope of the snapshot currently in hand. Written only on a render where
  // the data belongs to the CURRENT key (settled, not placeholder), so a
  // placeholder render always compares against the scope that actually produced
  // the figures beside it.
  const settledScopeRef = useRef<string | null>(null);
  const holdsCurrentScopeData =
    !(
      read.isPending ||
      read.isLoading ||
      read.isError ||
      read.isPlaceholderData
    ) && read.isFetching === false;
  useEffect(() => {
    if (holdsCurrentScopeData) {
      settledScopeRef.current = summaryScopeKey;
    }
  }, [holdsCurrentScopeData, summaryScopeKey]);

  if (!shouldSuppressSessionComparison(read, honestLoadingEnabled)) {
    return false;
  }
  // The shared rule says suppress. Reconsider ONLY when the sole reason is that
  // the query key churned: no failed or absent read, just a placeholder or an
  // in-flight refetch. Anything else — including an arm this file does not know
  // about — keeps the shared verdict.
  const keyChurnOnly =
    !(read.isPending || read.isLoading || read.isError) &&
    (read.isPlaceholderData || read.isFetching);
  if (!keyChurnOnly) {
    return true;
  }
  return settledScopeRef.current !== summaryScopeKey;
}

/**
 * The identity of the summary scope, for {@link useSessionComparisonSuppressed}.
 *
 * Built by DROPPING the fields the cloud usage request never carries — read from
 * the data source that builds that request, never restated here. A field that
 * does not reach the usage URL cannot move the aggregate or its prior window, so
 * re-suppressing on it would replace the chips with "No prior period" over
 * figures that did not change, the exact false claim the narrowing exists to
 * prevent. Taking the set from its owner means a usage route later taught to
 * honor one of them (`search`, say) shortens that list and widens this scope in
 * the same edit.
 *
 * Dropping rather than listing the summary fields is the other half: a facet
 * added later is part of the scope by DEFAULT, so the comparison re-suppresses on
 * it automatically instead of silently surviving a filter change nobody
 * remembered to add here.
 *
 * Key ORDER is normalized out — the filter object is assembled by spreads whose
 * order can shift without the scope changing.
 */
export function sessionSummaryScopeKey(
  filters: Record<string, unknown>
): string {
  const dropped = new Set<string>(USAGE_STRIPPED_FILTER_KEYS);
  return JSON.stringify(
    Object.keys(filters)
      .filter((key) => !dropped.has(key))
      .sort()
      .map((key) => [key, filters[key]])
  );
}

/**
 * Map the producer's percentages onto the shared cards' delta slots, or hand the
 * cards nothing.
 *
 * `undefined` is the host declaring "this surface does not compare periods",
 * which is what keeps a non-comparing strip free of even the placeholder. A usage
 * half that failed on its own leaves `usage` undefined, which
 * `buildSessionSummaryDeltas` already renders as no chip rather than a zero — so
 * the local fallback totals the cards then show are never graded by a cloud
 * comparison they did not come from.
 *
 * `comparisonV2Enabled` is passed ON rather than threaded from the caller: it is
 * one half of {@link isSessionComparisonEnabled}, so reaching this line at all
 * means the Grid Parity gate is on. The cadence captions and the `PRs Shipped`
 * chip therefore ride with the rest of the strip's comparison, which is the same
 * bundle the flag turns on for web.
 */
export function resolveSessionSummaryDeltas({
  enabled,
  dateRange,
  usage,
  suppressed,
  pending = false,
  customWindowDays,
}: {
  enabled: boolean;
  dateRange: DateRange;
  usage: AgentSessionUsageSummary | undefined;
  suppressed: boolean;
  /**
   * FEA-4201 — the inclusive day count of the explicit `?from=`/`?to=` window,
   * when one decides the rows. Present ⇒ the caption names THAT span, because
   * the producer derived the prior period from those bounds and a preset caption
   * would name a period the figures were never compared over.
   */
  customWindowDays?: number;
  /**
   * ISS-7422: whether a comparison is genuinely in flight, which is NOT what
   * `suppressed` answers — this view's cards stay settled while a failed read
   * holds last-good usage (`resolveSummaryCardsErrored` requires the usage to be
   * absent), so an errored refetch marked pending would shimmer a fetch that has
   * already stopped.
   */
  pending?: boolean;
}): SessionSummaryDeltas | undefined {
  if (!enabled) {
    return;
  }
  return buildSessionSummaryDeltas({
    comparisonV2Enabled: true,
    current: usage,
    customWindowDays,
    dateRange,
    pending,
    suppressed,
  });
}
