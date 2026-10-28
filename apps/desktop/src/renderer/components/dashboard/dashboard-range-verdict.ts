import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  InsightsScope,
  type UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { utilizationWindowSessionCount } from "@repo/app/insights/lib/dashboard-range-hides-sessions";
import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

export type LocalWindowSessionVerdict = {
  /** The selected range's sessions KPI, or `null` while it is not settled. */
  windowSessionCount: number | null;
  /**
   * Whether the same windowed cohort holds any session over all time, or `null`
   * when this hook did not establish it.
   */
  hasSessionsOutsideWindow: boolean | null;
};

type SettleCheck = {
  key: string;
  windowSessionCount: number | null;
  allTimeSessionCount: number | null;
};

/**
 * ISS-11927 asks for a SETTLED zero, and for sessions established outside the
 * window, before the Dashboard says its range hides sessions. On the local
 * store neither holds by default: the insights queries never go stale on their
 * own and `InsightsLiveBridge` holds and throttles their re-reads (ISS-11611),
 * so a cached zero can be a snapshot of an older store; and the session list
 * counts sessions the windowed cohort cannot place yet (no last activity), so
 * its total is not evidence of a session outside the window.
 *
 * A cached zero therefore reads as `null` until one paired re-read answers for
 * the current session count: the all-time sessions KPI first, then the selected
 * range's, so a session placed between the two reads is counted in the window.
 */
export function useLocalWindowSessionVerdict({
  enabled,
  period,
  readAllTime,
  sessionsTotal,
  utilization,
}: {
  enabled: boolean;
  period: string;
  readAllTime: () => Promise<UtilizationInsightsResponse>;
  sessionsTotal: number;
  utilization: Pick<
    UseQueryResult<UtilizationInsightsResponse>,
    "data" | "isPlaceholderData" | "refetch"
  >;
}): LocalWindowSessionVerdict {
  const cached = utilizationWindowSessionCount(
    utilization.data,
    utilization.isPlaceholderData
  );
  const key = `${period}:${sessionsTotal}`;
  const needsCheck = enabled && cached === 0;
  const [check, setCheck] = useState<SettleCheck | null>(null);
  const startedFor = useRef<string | null>(null);
  const readAllTimeRef = useRef(readAllTime);
  readAllTimeRef.current = readAllTime;
  const { refetch } = utilization;

  useEffect(() => {
    if (!needsCheck || startedFor.current === key) {
      return;
    }
    startedFor.current = key;
    let cancelled = false;
    settleWindowSessionCount(readAllTimeRef.current, refetch)
      .then((result) => {
        if (!cancelled) {
          setCheck({ key, ...result });
        }
      })
      // Unreachable in practice: a failed read is already folded to null.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      startedFor.current = null;
    };
  }, [needsCheck, key, refetch]);

  if (!needsCheck) {
    return { windowSessionCount: cached, hasSessionsOutsideWindow: null };
  }
  if (check?.key !== key) {
    return { windowSessionCount: null, hasSessionsOutsideWindow: null };
  }
  return {
    windowSessionCount: check.windowSessionCount,
    hasSessionsOutsideWindow:
      check.allTimeSessionCount === null ? null : check.allTimeSessionCount > 0,
  };
}

async function settleWindowSessionCount(
  readAllTime: () => Promise<UtilizationInsightsResponse>,
  refetch: UseQueryResult<UtilizationInsightsResponse>["refetch"]
): Promise<Omit<SettleCheck, "key">> {
  try {
    const allTime = await readAllTime();
    const window = await refetch();
    return {
      allTimeSessionCount: utilizationWindowSessionCount(allTime, false),
      windowSessionCount: window.isSuccess
        ? utilizationWindowSessionCount(window.data, false)
        : null,
    };
  } catch {
    // A failed read settles nothing; the queries' own error state reports it.
    return { allTimeSessionCount: null, windowSessionCount: null };
  }
}

/**
 * ISS-11927: whether the reader has sessions of their own over all time, in the
 * SAME viewer scope the KPIs read, for the date-range empty's "Show all time".
 *
 * Cloud mode only. The page's session read carries no viewer scope, so there it
 * counts the whole org while the KPIs follow Me: a reader with only a
 * teammate's history was offered a widen that could reveal nothing of theirs
 * (whitlockk, review of #8982). `me` maps to `self` and every other scope to the
 * org view, as the web Dashboard's Recent Sessions read does (FEA-3534). Local
 * mode answers from {@link useLocalWindowSessionVerdict}.
 *
 * Issued only when the verdict needs it: a bounded range whose own sessions KPI
 * is a settled zero. `null` while it has not answered; a failed read is
 * `false`, so it cannot hold the page in loading.
 */
export function useViewerSessionHistory({
  enabled,
  localHasSessions,
  readsCloud,
  scope,
}: {
  enabled: boolean;
  localHasSessions: boolean;
  readsCloud: boolean;
  scope: InsightsScope;
}): boolean | null {
  const query = useAgentSessions(
    {
      countOnly: true,
      limit: 1,
      viewerScope:
        scope === InsightsScope.Me
          ? AgentSessionViewerScope.Self
          : AgentSessionViewerScope.Organization,
    },
    { enabled }
  );
  if (!readsCloud) {
    return localHasSessions;
  }
  if (query.isError) {
    return false;
  }
  return query.isSuccess ? (query.data?.total ?? 0) > 0 : null;
}
