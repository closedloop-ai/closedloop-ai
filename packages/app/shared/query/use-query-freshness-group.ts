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
 * Re-read the stale members of a set of related queries on a focus or
 * reconnect event (whitlockk review on #4825).
 *
 * The rule: on a focus or reconnect event, re-read each member that is stale.
 * ISS-12286 (PRD-792) narrowed this from "if ANY member is stale, re-read ALL of
 * them": the Sessions list polls every 30s while a row is Active, so the list
 * was rarely stale yet the group re-read it whenever the usage summary was, and
 * the reverse. A fresh member is no longer re-read on its partner's account.
 *
 * What it does NOT do, deliberately:
 *
 *  - **It does not raise the request ceiling.** A member is re-read only when it
 *    is already stale, at most once per `staleTime` window, which is the same
 *    bound it has on its own.
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
      for (const member of current) {
        if (member.isStale) {
          member.refetch({ cancelRefetch: false });
        }
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
