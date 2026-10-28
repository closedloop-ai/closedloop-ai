"use client";

import {
  parseSessionDateRangeParam,
  SESSION_DATE_RANGE_PARAM,
} from "@repo/app/agents/lib/session-date-range-param";
import {
  parseSessionsPageIndex,
  SESSIONS_PAGE_PARAM,
} from "@repo/app/agents/lib/session-pagination";
import { rumPeriodForRange } from "@repo/app/insights/lib/dashboard-range";
import { useIsMounted } from "@repo/app/shared/hooks/use-is-mounted";
import { browserSearchParams } from "@repo/app/shared/lib/facet-filter-params";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import {
  clampScrollRestoreTarget,
  computeMaxScrollTop,
  SESSIONS_SCROLL_RESTORE_MAX_ATTEMPTS,
  type SessionsScrollKey,
} from "@repo/app/shared/lib/sessions-scroll-contract";
import type { ReadonlySearchParams } from "@repo/navigation/navigation-adapter";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRumViewRange } from "@/lib/datadog-rum/view-range";

const SESSIONS_SCROLL_STATE_KEY = "__symphonySessionsScroll";
// Declared once in the shared contract module (PLN-1950 slice 5) -- this
// alias keeps every existing reference in this file unchanged.
export const MAX_SCROLL_RESTORE_ATTEMPTS = SESSIONS_SCROLL_RESTORE_MAX_ATTEMPTS;

/**
 * Reads the current sessions page from the navigation snapshot.
 *
 * The `page` param is omitted for page 1, so an absent param normally means
 * page 1. The one exception is the initial client render, when the app-router
 * `useSearchParams()` snapshot can still be empty while the real URL carries
 * `?page=N` — only then do we consult the (non-reactive) browser URL, gated by
 * `allowBrowserFallback`.
 *
 * FEA-3664: after mount the snapshot is authoritative and reactive, so we must
 * NOT fall back to the browser URL there. Doing so made an absent `page` param
 * read the stale browser URL instead of page 1, so returning to page 1 (the only
 * param-absent page) stuck on the previous page. The original hydration fallback
 * is FEA-2083. Prefer {@link useSessionsUrlPageIndex} in components; it wires
 * `allowBrowserFallback` to the mount state.
 */
export function readSessionsPageIndex(
  searchParams: Pick<ReadonlySearchParams, "get">,
  routePath: string,
  options?: { allowBrowserFallback?: boolean }
): number {
  const fromSnapshot = searchParams.get(SESSIONS_PAGE_PARAM);
  if (fromSnapshot !== null) {
    return parseSessionsPageIndex(fromSnapshot);
  }
  if (options?.allowBrowserFallback ?? true) {
    return parseSessionsPageIndex(readBrowserPageParam(routePath));
  }
  return 0;
}

/**
 * Reactive page index for the sessions route. Consults the browser URL only
 * until the client has mounted (the FEA-2083 hydration window); afterwards the
 * reactive search-params snapshot is the single source of truth, so an absent
 * `page` param resolves to page 1 (FEA-3664).
 */
export function useSessionsUrlPageIndex(
  searchParams: Pick<ReadonlySearchParams, "get">,
  routePath: string
): number {
  const mounted = useIsMounted();
  return readSessionsPageIndex(searchParams, routePath, {
    allowBrowserFallback: !mounted,
  });
}

/**
 * Keeps the effective sessions page at an intended target immediately after a
 * query-domain reset or stale-page repair, even while router search params
 * still expose the old page value.
 *
 * FEA-3655: the override masks the URL only while the URL still shows the
 * pre-override (baseline) value it was set against. As soon as the URL moves off
 * that baseline the override is dropped — whether the URL caught up to the
 * target, OR a newer navigation (a Next/page click, whose `replacePage` writes a
 * value other than the pending target) superseded it. The previous logic cleared
 * only on exact `urlPageIndex === pendingPageIndex` equality, so a click that
 * moved the URL to any other value orphaned the override forever and froze
 * `effectivePageIndex` — the "pagination does nothing after filtering by Owner"
 * bug, where the Owner filter narrows the list, fires the stale-page clamp, and
 * the clamp's in-flight URL round-trip races the user's next click.
 */
export function useSessionsPageReset({
  urlPageIndex,
}: {
  urlPageIndex: number;
}) {
  const [pendingPageIndex, setPendingPageIndex] = useState<number | null>(null);
  // The URL page index observed when the current override was set. The override
  // is discarded the moment the URL differs from it (see the doc comment above).
  const overrideBaselineRef = useRef<number | null>(null);
  // Mirror of the latest URL so the setters capture the current baseline without
  // being recreated on every URL change.
  const urlPageIndexRef = useRef(urlPageIndex);
  urlPageIndexRef.current = urlPageIndex;

  useEffect(() => {
    if (
      pendingPageIndex !== null &&
      urlPageIndex !== overrideBaselineRef.current
    ) {
      overrideBaselineRef.current = null;
      setPendingPageIndex(null);
    }
  }, [pendingPageIndex, urlPageIndex]);

  const markPageReset = useCallback(() => {
    overrideBaselineRef.current = urlPageIndexRef.current;
    setPendingPageIndex(0);
  }, []);

  const markPageOverride = useCallback((pageIndex: number) => {
    overrideBaselineRef.current = urlPageIndexRef.current;
    setPendingPageIndex(Math.max(0, pageIndex));
  }, []);

  return {
    effectivePageIndex: pendingPageIndex ?? urlPageIndex,
    markPageOverride,
    markPageReset,
    pendingReset: pendingPageIndex === 0,
  };
}

/**
 * Restores sessions-list scroll from the current browser history entry. The
 * state is same-tab/browser-entry only, so refreshes and unrelated visits do
 * not inherit a stale list position.
 */
export function useSessionsHistoryScroll({
  scrollKey,
  container,
  restoreWhen,
}: {
  scrollKey: SessionsScrollKey;
  container: HTMLElement | null;
  restoreWhen: boolean;
}) {
  const activeScrollKeyRef = useRef<string | null>(null);
  const restoredKeyRef = useRef<string | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingScrollSaveRef = useRef<PendingHistoryScrollSave | null>(null);

  if (activeScrollKeyRef.current !== scrollKey) {
    activeScrollKeyRef.current = scrollKey;
    restoredKeyRef.current = null;
  }

  const saveScrollPosition = useCallback(() => {
    if (!container) {
      return;
    }

    queueHistoryScrollPosition(pendingScrollSaveRef, {
      scrollKey,
      scrollTop: container.scrollTop,
    });
  }, [container, scrollKey]);

  useEffect(() => {
    if (!container) {
      return;
    }

    container.addEventListener("scroll", saveScrollPosition, {
      passive: true,
    });
    return () => {
      container.removeEventListener("scroll", saveScrollPosition);
      cancelPendingHistoryScrollPosition(pendingScrollSaveRef);
    };
  }, [container, saveScrollPosition]);

  useEffect(() => {
    if (!(container && restoreWhen) || restoredKeyRef.current === scrollKey) {
      return;
    }

    const savedPosition = readHistoryScrollPosition(scrollKey);
    if (!hasWebStoredScrollPosition(savedPosition)) {
      restoredKeyRef.current = scrollKey;
      return;
    }

    const targetPosition = savedPosition;
    let attempts = 0;
    const target = container;

    function tryRestore() {
      if (restoredKeyRef.current === scrollKey) {
        return;
      }

      attempts++;
      const maxScrollTop = computeMaxScrollTop(
        target.scrollHeight,
        target.clientHeight
      );
      if (maxScrollTop > 0) {
        target.scrollTop = clampScrollRestoreTarget(
          targetPosition,
          maxScrollTop
        );
        restoredKeyRef.current = scrollKey;
        return;
      }

      if (attempts >= MAX_SCROLL_RESTORE_ATTEMPTS) {
        restoredKeyRef.current = scrollKey;
        return;
      }

      frameRef.current = requestAnimationFrame(tryRestore);
    }

    frameRef.current = requestAnimationFrame(tryRestore);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [container, restoreWhen, scrollKey]);
}

/**
 * Resolves the date window the sessions view is actually reading over, and tags
 * the RUM view with it.
 *
 * ISS-5355: an inbound link may name the window it was counted over (`?range=`),
 * which the viewer's saved range must not silently override — that is what let
 * the project-detail strip's count and the listing it opens disagree. Derived
 * during render (no Effect, no state mirror): the param wins while it is in the
 * URL, and the range picker strips it, so touching the control hands control
 * straight back to the saved preference.
 *
 * ISS-7250: the RUM tag is resolved HERE rather than at the call site, so the
 * window in effect and the window reported to Datadog cannot come to name two
 * different ranges. The saved half waits for `isViewReady` (whitlockk review): until
 * the persisted view restores, `savedRange` is still the default, and tagging a
 * saved-90d viewer's load `7` buckets it under a window they never selected. The
 * `?range=` half does NOT wait — that window is known during the first render
 * and overrides the saved one anyway, so gating it would withhold a tag that was
 * already correct.
 */
export function useSessionsEffectiveDateRange({
  isViewReady,
  savedRange,
  searchParams,
}: {
  isViewReady: boolean;
  savedRange: DateRange;
  searchParams: Pick<ReadonlySearchParams, "get">;
}): DateRange {
  const urlRange = parseSessionDateRangeParam(
    searchParams.get(SESSION_DATE_RANGE_PARAM)
  );
  const rumRange = urlRange ?? (isViewReady ? savedRange : null);
  useRumViewRange(rumRange === null ? null : rumPeriodForRange(rumRange));
  return urlRange ?? savedRange;
}

/**
 * ISS-7493: scroll restoration only needs the position the user lands on, but
 * this used to `replaceState` once per animation frame — ~60 writes/second
 * while scrolling. Browsers rate-limit that API (Safari throws a SecurityError
 * past 100 calls per 10s), so a couple of seconds of continuous scrolling in a
 * long Sessions list became a production error.
 *
 * The leading edge writes immediately, so a position is still captured when the
 * user scrolls once and navigates away; the trailing write settles the final
 * position. Between them the write rate is bounded to one per interval.
 */
const HISTORY_SCROLL_SAVE_INTERVAL_MS = 250;

type PendingHistoryScrollSave = {
  timer: ReturnType<typeof setTimeout> | null;
  lastWriteAt: number;
  pending: { scrollKey: string; scrollTop: number } | null;
};

function queueHistoryScrollPosition(
  pendingScrollSaveRef: MutableRefObject<PendingHistoryScrollSave | null>,
  nextScrollState: { scrollKey: string; scrollTop: number }
) {
  const state = pendingScrollSaveRef.current ?? {
    timer: null,
    lastWriteAt: 0,
    pending: null,
  };
  pendingScrollSaveRef.current = state;

  const elapsed = Date.now() - state.lastWriteAt;
  if (state.timer === null && elapsed >= HISTORY_SCROLL_SAVE_INTERVAL_MS) {
    state.lastWriteAt = Date.now();
    state.pending = null;
    writeHistoryScrollPosition(
      nextScrollState.scrollKey,
      nextScrollState.scrollTop
    );
    return;
  }

  state.pending = nextScrollState;
  if (state.timer !== null) {
    return;
  }

  state.timer = setTimeout(
    () => {
      const current = pendingScrollSaveRef.current;
      if (!current) {
        return;
      }
      // Clear the sentinel where the timer actually fires, so a later scroll
      // can reschedule instead of being suppressed by a stale marker.
      current.timer = null;
      const pending = current.pending;
      current.pending = null;
      if (pending) {
        current.lastWriteAt = Date.now();
        writeHistoryScrollPosition(pending.scrollKey, pending.scrollTop);
      }
    },
    Math.max(0, HISTORY_SCROLL_SAVE_INTERVAL_MS - elapsed)
  );
}

function cancelPendingHistoryScrollPosition(
  pendingScrollSaveRef: MutableRefObject<PendingHistoryScrollSave | null>
) {
  const state = pendingScrollSaveRef.current;
  if (state?.timer != null) {
    clearTimeout(state.timer);
  }
  pendingScrollSaveRef.current = null;
}

function readHistoryScrollPosition(scrollKey: string): number | null {
  const scrollState = readHistoryScrollState();
  const value = scrollState?.[scrollKey];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return value;
}

/**
 * ISS-8187: read through the shared path-scoped helper rather than a private
 * `location.search` copy. Sessions and Branches both name this param `page`
 * (`SESSIONS_PAGE_PARAM` / `BRANCH_PAGE_PARAM`), so an unscoped read let a
 * client-side navigation from `/branches?page=5` seed the Sessions list's FIRST
 * request with page 5 before the post-mount render corrected it.
 */
function readBrowserPageParam(routePath: string): string | null {
  return browserSearchParams(routePath)?.get(SESSIONS_PAGE_PARAM) ?? null;
}

function writeHistoryScrollPosition(scrollKey: string, scrollTop: number) {
  if (globalThis.window === undefined || !Number.isFinite(scrollTop)) {
    return;
  }

  const currentState = getObjectHistoryState();
  const scrollState = readHistoryScrollState();
  globalThis.history.replaceState(
    {
      ...currentState,
      [SESSIONS_SCROLL_STATE_KEY]: {
        ...scrollState,
        [scrollKey]: Math.max(0, scrollTop),
      },
    },
    "",
    globalThis.location.href
  );
}

function readHistoryScrollState(): Record<string, number> | null {
  const currentState = getObjectHistoryState();
  const value = currentState[SESSIONS_SCROLL_STATE_KEY];
  if (!isNumberRecord(value)) {
    return null;
  }

  return value;
}

function getObjectHistoryState(): Record<string, unknown> {
  if (globalThis.window === undefined) {
    return {};
  }

  const state = globalThis.history.state;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    return state as Record<string, unknown>;
  }

  return {};
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(
    (entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0
  );
}

/**
 * Web's own presence gate: unlike the shared `hasStoredScrollPosition`, a
 * remembered position of exactly 0 also counts as nothing to restore (see
 * `sessions-scroll-contract.ts`'s module header for why this narrowing stays
 * web-specific). Exported so the sessions-scroll-contract conformance test
 * exercises this exact gate rather than a hand-copied duplicate.
 */
export function hasWebStoredScrollPosition(
  value: number | null | undefined
): value is number {
  return typeof value === "number" && value > 0;
}
