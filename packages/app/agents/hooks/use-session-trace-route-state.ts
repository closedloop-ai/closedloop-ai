"use client";

import { useLinkedSearchWriter } from "@repo/app/shared/hooks/use-linked-search-writer";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback } from "react";
import {
  readSessionTraceRouteState,
  type SessionTraceRouteState,
  writeSessionTraceRouteState,
} from "../lib/session-trace/session-trace-route-state";

/**
 * ISS-10737: the Trace tab's view state, in the URL.
 *
 * WHY IT IS IN THE URL AT ALL. A trace view whose state lives only in memory
 * cannot be cited, and a finding nobody else can open is not evidence. So the
 * selected span, the visible window, the kind lens and the critical-path lens
 * all travel in the query string.
 *
 * WHAT THE PROTOTYPE COULD NOT DO AND THIS CAN. In the sandbox the selected
 * artifact and the selected tab lived in the host's React state, so a pasted
 * link reopened at the default artifact with the trace state stranded. Here both
 * halves are the URL's: the ROUTE owns the session, `useTabParam` owns the tab,
 * and this owns the view — so a cold paste restores all three, with no mounted
 * app state to fall back on.
 *
 * It goes through `@repo/navigation` for the same reason `useTabParam` does:
 * that port works on web (App Router) AND in the desktop renderer (IPC nav).
 * Writes `replace` with `scroll: false`, so scrubbing the window does not stack
 * history entries or jump the pane.
 */
export function useSessionTraceRouteState(): {
  routeState: SessionTraceRouteState;
  setRouteState: (next: SessionTraceRouteState) => void;
} {
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  const { readLatest, replaceSearch } = useLinkedSearchWriter(
    pathname,
    searchParams,
    navigation.replace
  );
  const search = searchParams.toString();
  const routeState = readSessionTraceRouteState(search);

  const setRouteState = useCallback(
    (next: SessionTraceRouteState) => {
      replaceSearch(
        new URLSearchParams(
          writeSessionTraceRouteState(next, readLatest().toString())
        )
      );
    },
    [readLatest, replaceSearch]
  );

  return { routeState, setRouteState };
}
