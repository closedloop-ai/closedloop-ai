"use client";

import {
  SessionsListAnalyticsSignal,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { useSurfaceAnalytics } from "@repo/app/shared/observability/surface-analytics-context";
import { useEffect, useRef } from "react";
import {
  analyticsCountBucket,
  analyticsDurationProperties,
  isAnalyticsCount,
} from "../../../shared/observability/analytics-performance-sample";

/**
 * ISS-9531: the Sessions v2 list's success, failure and settle-time measures,
 * through the shell-owned surface-analytics port so both hosts share one
 * catalog. Exposure is `useSharedComponentRenderedEvent` on the same mount.
 *
 * `loaded` fires once per mount, at the first settled, error-free read; its
 * duration runs from mount, or from the retry after a failed read, so it covers
 * the query and the first render.
 * `load_failure` fires on each transition into a read error.
 */
export function useSessionsListAnalytics({
  isError,
  isPending,
  isPlaceholderPage,
  isServerDriven,
  rowCount,
}: {
  isError: boolean;
  isPending: boolean;
  isPlaceholderPage: boolean;
  isServerDriven: boolean;
  rowCount: number;
}): void {
  const isSettled = !(isPending || isPlaceholderPage);
  const { capture } = useSurfaceAnalytics();
  const startedAt = useRef<number | null>(null);
  startedAt.current ??= globalThis.performance.now();
  const loadedEmitted = useRef(false);
  const wasError = useRef(false);

  useEffect(() => {
    if (isError === wasError.current) {
      return;
    }
    wasError.current = isError;
    if (!isError) {
      // Leaving an error is the retry starting: time the load from here, not
      // from mount, so the failure and the wait before retry are not counted
      // as a slow successful load (tamsinb review, #9123).
      startedAt.current = globalThis.performance.now();
      return;
    }
    capture(SurfaceAnalyticsEvent.SessionsListObserved, {
      server_driven: isServerDriven,
      signal: SessionsListAnalyticsSignal.LoadFailure,
    });
  }, [capture, isError, isServerDriven]);

  useEffect(() => {
    if (loadedEmitted.current || !isSettled || isError) {
      return;
    }
    const duration = analyticsDurationProperties(
      globalThis.performance.now() - (startedAt.current ?? 0)
    );
    if (!(duration && isAnalyticsCount(rowCount))) {
      return;
    }
    loadedEmitted.current = true;
    capture(SurfaceAnalyticsEvent.SessionsListObserved, {
      ...duration,
      row_count_bucket: analyticsCountBucket(rowCount),
      server_driven: isServerDriven,
      signal: SessionsListAnalyticsSignal.Loaded,
    });
  }, [capture, isError, isServerDriven, isSettled, rowCount]);
}
