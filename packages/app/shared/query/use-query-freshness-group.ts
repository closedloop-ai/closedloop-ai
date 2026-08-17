"use client";

import { focusManager, onlineManager } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/**
 * One member of a freshness group: the three fields this hook reads off a
 * `UseQueryResult`. Kept structural rather than importing `UseQueryResult` so a
 * caller can group anything query-shaped (including a derived/adapter object)
 * without widening this module's dependencies.
 */
export type QueryFreshnessGroupMember = {
  isError: boolean;
  isStale: boolean;
  refetch: (options?: { cancelRefetch?: boolean }) => unknown;
};

/**
 * Re-read a set of related queries as ONE freshness group (wongk review on
 * #4825).
 *
 * The problem this exists for. `staleTime` plus the focus/reconnect triggers
 * (ISS-5976) revalidate each query INDEPENDENTLY, against that query's own
 * `dataUpdatedAt`. Two queries that back two halves of the SAME screen — the
 * Sessions table and the usage/summary tiles — start their clocks whenever each
 * one's fetch happened to resolve, which is never the same instant. So a focus
 * event landing between the two 60-second boundaries refetches exactly one of
 * them: the rows advance to a new population while the cards and the facet
 * counts still describe the old one, and the screen contradicts itself. That is
 * the failure the removed manual Refresh control was incidentally preventing by
 * calling both `refetch`es from one click, and removing the control without
 * replacing that property is what this hook replaces it with.
 *
 * The rule: on a focus or reconnect event, if ANY member is stale, re-read ALL
 * of them. That also RE-SYNCHRONIZES the clocks — every member's
 * `dataUpdatedAt` lands together — so the group converges rather than drifting
 * further apart on each pass.
 *
 * What it does NOT do, deliberately:
 *
 *  - **It does not raise the request ceiling.** A group read only happens when a
 *    member is already stale, i.e. at most once per `staleTime` window per
 *    group, which is the same bound each member had on its own. It converts N
 *    staggered reads into N simultaneous ones; it does not add a round.
 *  - **It stands down entirely while any member is in `error` state.** An
 *    errored query is stale forever (a failure advances `errorUpdatedAt`, never
 *    `dataUpdatedAt`), so a group keyed on staleness alone would re-read on
 *    every single focus event during an outage — reintroducing precisely the
 *    amplification `shouldRefetchOnFocus` was added to bound. During a failure
 *    the members are on their own per-query cooldown, and the halves are
 *    independent failure domains anyway (FEA-4177): the cards degrade without
 *    blanking the table, so there is no shared population left to keep in step.
 *  - **It does not cancel an in-flight fetch.** `refetch()` defaults to
 *    `cancelRefetch: true`, which would abort and restart the read the built-in
 *    focus trigger just started for the stale member — one user-visible refresh
 *    costing two requests. Passing `false` joins the in-flight fetch instead, so
 *    the member the default already handled is not re-requested.
 */
export function useQueryFreshnessGroup(
  members: readonly QueryFreshnessGroupMember[]
) {
  // The listeners are registered once, but must always act on the CURRENT
  // render's queries — a stale closure would read staleness off a previous
  // render's result objects and refetch the wrong generation.
  const membersRef = useRef(members);
  membersRef.current = members;

  useEffect(() => {
    const syncGroup = () => {
      const current = membersRef.current;
      if (current.some((member) => member.isError)) {
        return;
      }
      if (!current.some((member) => member.isStale)) {
        return;
      }
      for (const member of current) {
        member.refetch({ cancelRefetch: false });
      }
    };
    const unsubscribeFocus = focusManager.subscribe((focused) => {
      if (focused) {
        syncGroup();
      }
    });
    const unsubscribeOnline = onlineManager.subscribe((online) => {
      if (online) {
        syncGroup();
      }
    });
    return () => {
      unsubscribeFocus();
      unsubscribeOnline();
    };
  }, []);
}
