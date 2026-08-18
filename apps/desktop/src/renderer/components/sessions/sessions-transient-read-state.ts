/**
 * ISS-4483 — transient-vs-fatal classification for the desktop Sessions combined
 * (list + usage) read, extracted from `SessionsView` so the view stays a thin
 * container and this decision logic is unit-testable on its own.
 *
 * The local db-host child (a forked utilityProcess) is unstable during
 * first-launch backfill: it can crash-loop / restart mid-request (ISS-4476,
 * ISS-4474, ISS-4410). A read that fails in that window is TRANSIENT — the child
 * re-forks on its own — so the Sessions surface should retry and show the quiet
 * "reconnecting / still importing" holding state rather than the hard error card.
 * These helpers derive the signals the view routes on for BOTH halves of the
 * combined read (the required list half and the best-effort usage half).
 */

import type { AgentSessionsPageData } from "@repo/api/src/types/agent-session";
import {
  MAX_TRANSIENT_QUERY_RETRIES,
  queryRetryDelay,
} from "@repo/app/shared/query/query-client";
import type { FetchStatus } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { isTransientSourceError } from "../../shared/transient-source-error.js";

type UsageErrorFlags = {
  usageError: boolean;
  usageErrorTransient: boolean;
  hasSummaryUsage: boolean;
};

/**
 * ISS-4483: normalize the best-effort usage half's optional signals off the
 * resolved combined read into concrete booleans, so the view's classification and
 * recovery calls take a single flat value instead of repeating `?? false` /
 * `!== undefined` coalesces at each call site. `undefined` page data (query not
 * yet settled) reads as no error and no usage.
 */
export function readUsageErrorFlags(
  pageData: AgentSessionsPageData | undefined
): UsageErrorFlags {
  return {
    usageError: pageData?.usageError ?? false,
    usageErrorTransient: pageData?.usageErrorTransient ?? false,
    hasSummaryUsage: pageData?.usage !== undefined,
  };
}

type ListReadErrorInput = {
  isListError: boolean;
  listError: unknown;
  usageError: boolean;
  /**
   * Whether the summary cards already hold last-good usage. When they do, a
   * transient recover keeps rendering it (like the table keeping last-good rows)
   * rather than skeletoning, so `transientReadWithoutUsage` stays false.
   */
  hasSummaryUsage: boolean;
  /**
   * ISS-4483 (review cid 3679616168, wongk): the usage half failed TRANSIENTLY
   * (a db-host lifecycle blip while the list won the race). The combined read
   * still RESOLVED, so there is no query rejection to auto-retry — the caller
   * drives a bounded refetch. While that recovery is in flight this keeps the
   * usage failure OUT of `metricReadErrored` (so the cards hold + skeleton rather
   * than dash to a fatal "—"); once the bounded retries are exhausted it falls
   * through to `metricReadErrored` like any other settled usage failure.
   */
  usageErrorTransient?: boolean;
  /**
   * ISS-4483 (review cid 3679616168, wongk): the usage half's OWN bounded recovery
   * refetches have run out (the caller drives these, since the resolved combined
   * read never advances react-query's `failureCount`). True only once every
   * attempt has RETURNED and the usage half is still failing (ISS-4561) — an
   * attempt still in flight is recovery in progress, not recovery exhausted. The
   * transient-usage window closes here the same way `transientRetriesExhausted`
   * closes the list one, so a wedged transient usage failure falls through to the
   * honest dash instead of an infinite skeleton. Defaults to `false` so it holds
   * while recovery is in flight.
   */
  usageRecoveryExhausted?: boolean;
  /**
   * ISS-4483 (review cid 3679535437): the bounded auto-retries for a transient
   * error have run out and the read has settled still-errored. A transient error
   * only routes to the quiet reconnecting surface WHILE it is still retrying;
   * once exhausted it is treated as a hard (non-transient) error so the errored
   * surface + Retry takes over instead of an infinite reconnecting skeleton.
   * Defaults to `false` so a still-retrying transient error keeps the quiet
   * surface.
   */
  transientRetriesExhausted?: boolean;
};

type ListReadErrorState = {
  isListErrorTransient: boolean;
  isUsageErrorTransient: boolean;
  metricReadErrored: boolean;
  /**
   * ISS-4483 (review cid 3679535439 / 3679616168): the summary cards route to the
   * value-only reconnecting skeleton (labels held, numbers shimmering) whenever
   * EITHER half is transiently recovering with no last-good usage to keep showing.
   * Both the transient list error (usage rides the same rejected combined read)
   * and a transient usage-half failure (the list won the race, usage omitted with
   * `usageErrorTransient`) are the db-host restarting mid-backfill — hold, not dash.
   */
  transientReadWithoutUsage: boolean;
};

/**
 * ISS-4483: classify a settled combined-read failure and derive the signals the
 * view routes on. `isListErrorTransient` is a list error whose cause is a
 * TRANSIENT db-host restart (the child crash-looping / restarting mid-backfill —
 * ISS-4476 / ISS-4474 / ISS-4410), which is not a genuine breakage: the read
 * auto-retries and the table shows the quiet reconnecting surface instead of the
 * hard error card. `isUsageErrorTransient` is the same for the best-effort usage
 * half (review cid 3679616168, wongk). `metricReadErrored` (FEA-4177) folds a
 * whole-query list failure with the usage half's `usageError`, but EXCLUDES a
 * transient failure of either half so the always-available summary cards don't
 * dash to a destructive 0/0/$0 during the recover window — only a persistent
 * failure dashes them.
 */
export function classifyListReadErrorState({
  isListError,
  listError,
  usageError,
  hasSummaryUsage,
  usageErrorTransient,
  usageRecoveryExhausted,
  transientRetriesExhausted,
}: ListReadErrorInput): ListReadErrorState {
  const isListErrorTransient =
    isListError &&
    isTransientSourceError(listError) &&
    transientRetriesExhausted !== true;
  const isUsageErrorTransient =
    usageError &&
    usageErrorTransient === true &&
    usageRecoveryExhausted !== true;
  const metricReadErrored =
    (isListError && !isListErrorTransient) ||
    (usageError && !isUsageErrorTransient);
  const transientReadWithoutUsage =
    (isListErrorTransient || isUsageErrorTransient) && !hasSummaryUsage;
  return {
    isListErrorTransient,
    isUsageErrorTransient,
    metricReadErrored,
    transientReadWithoutUsage,
  };
}

/**
 * ISS-4483 (review cid 3679535437): have the shared query client's bounded
 * transient retries been exhausted for a settled read? True only when the read
 * has settled into an error state (`isError`), no fetch is currently in flight
 * (`fetchStatus === "idle"` — so we are not mid-retry or mid-backoff-then-fetch),
 * and the observed failure count has reached the retry cap. In that state the
 * transient error is wedged: routing it back to the hard error + Retry surface
 * gives the user a move to make instead of a skeleton that never changes again.
 * While retries are still in flight this stays false, so the quiet reconnecting
 * surface holds through the auto-recover window.
 */
export function areTransientRetriesExhausted({
  isError,
  fetchStatus,
  failureCount,
}: {
  isError: boolean;
  fetchStatus: FetchStatus;
  failureCount: number;
}): boolean {
  return (
    isError &&
    fetchStatus === "idle" &&
    failureCount >= MAX_TRANSIENT_QUERY_RETRIES
  );
}

/**
 * ISS-4483 (review cid 3679616168, wongk): drive + bound the recovery for a
 * TRANSIENT usage-half failure, which runs OUTSIDE react-query's own retry. When
 * the list wins the race and the usage aggregate rejects transiently, the combined
 * read RESOLVES (list rendered, `usage` omitted, `usageErrorTransient: true`), so
 * react-query sees a success and `failureCount` never advances — its own transient
 * retry never fires. This hook refetches the combined read on the same
 * capped-exponential backoff the query client uses for a rejected transient read,
 * bounded to `MAX_TRANSIENT_QUERY_RETRIES` attempts, and returns whether that
 * bounded recovery is EXHAUSTED so the caller can re-classify a wedged transient
 * usage failure as fatal (honest dash) instead of an infinite reconnecting
 * skeleton. The attempt counter resets whenever the window closes (the usage half
 * recovered, or a fresh query key / manual retry cleared the transient condition).
 *
 * ISS-4561: an attempt counts when its refetch SETTLES, not when it is dispatched.
 * Counting at dispatch made the counter reach the cap the instant the last refetch
 * was fired, so `usageRecoveryExhausted` went true while that read was still in
 * flight and the cards dashed to "unavailable" about a read still in progress —
 * "recovering" and "recovered nothing" are different facts. Settle-counting also
 * keeps exactly one attempt in flight: the effect only reschedules once the
 * previous attempt has returned and bumped `attempts`.
 *
 * The hook derives the raw transient-usage candidate BEFORE exhaustion is folded
 * in (`usageError && usageErrorTransient`) so it owns the exhaustion edge without
 * a cyclic dependency on the classified flag — and so the caller's component body
 * stays free of the extra branches.
 */
export function useUsageTransientRecovery({
  usageError,
  usageErrorTransient,
  refetch,
}: {
  usageError: boolean;
  usageErrorTransient: boolean;
  refetch: () => Promise<unknown>;
}): { usageRecoveryExhausted: boolean } {
  const candidate = usageError && usageErrorTransient;
  const [attempts, setAttempts] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!candidate) {
      setAttempts(0);
      return;
    }
    if (attempts >= MAX_TRANSIENT_QUERY_RETRIES) {
      return;
    }
    let superseded = false;
    const timer = setTimeout(() => {
      timerRef.current = null;
      refetch()
        .catch(() => undefined)
        .finally(() => {
          // ISS-4561: count the attempt when its refetch SETTLES, never when it
          // is dispatched, so `attempts >= MAX` means "every attempt completed
          // and the usage half is still failing" rather than "the last attempt
          // is still running". Skipped when this effect run was superseded
          // (unmounted, or the transient window closed) so a canceled attempt
          // cannot advance the counter after the fact.
          if (!superseded) {
            setAttempts((current) => current + 1);
          }
        });
    }, queryRetryDelay(attempts));
    timerRef.current = timer;
    return () => {
      superseded = true;
      clearTimeout(timer);
      if (timerRef.current === timer) {
        timerRef.current = null;
      }
    };
  }, [candidate, attempts, refetch]);
  return { usageRecoveryExhausted: attempts >= MAX_TRANSIENT_QUERY_RETRIES };
}
