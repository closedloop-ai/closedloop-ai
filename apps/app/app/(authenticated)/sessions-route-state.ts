"use client";

import type { ReadonlySearchParams } from "@repo/navigation/navigation-adapter";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const PAGE_PARAM = "page";
const SESSIONS_SCROLL_STATE_KEY = "__symphonySessionsScroll";
const MAX_SCROLL_RESTORE_ATTEMPTS = 30;

/**
 * Parses the sessions route's one-based `page` URL parameter into the
 * zero-based page index used by pagination controls and API offsets.
 */
export function parseSessionsPageIndex(value: string | null): number {
  if (value === null) {
    return 0;
  }

  const page = Number(value);
  if (!(Number.isFinite(page) && Number.isInteger(page) && page > 0)) {
    return 0;
  }

  return page - 1;
}

/**
 * Reads the current sessions page from the navigation snapshot, falling back to
 * the browser URL for the first client render when app-router search params can
 * still be reconciling.
 */
export function readSessionsPageIndex(
  searchParams: Pick<ReadonlySearchParams, "get">
): number {
  return parseSessionsPageIndex(
    searchParams.get(PAGE_PARAM) ?? readBrowserPageParam()
  );
}

/**
 * Writes the sessions route's canonical one-based `page` URL parameter.
 * Page index 0 is represented by omitting the parameter.
 */
export function writeSessionsPageParam(
  params: URLSearchParams,
  pageIndex: number
) {
  if (pageIndex <= 0) {
    params.delete(PAGE_PARAM);
    return;
  }

  params.set(PAGE_PARAM, String(pageIndex + 1));
}

/**
 * Clamps a requested page index to the last page currently proven by a list
 * response total.
 */
export function clampSessionsPageIndex({
  pageIndex,
  pageSize,
  total,
}: {
  pageIndex: number;
  pageSize: number;
  total: number;
}): number {
  if (!(Number.isFinite(total) && total > 0 && pageSize > 0)) {
    return 0;
  }

  return Math.min(pageIndex, Math.ceil(total / pageSize) - 1);
}

/**
 * Keeps the effective sessions page at an intended target immediately after a
 * query-domain reset or stale-page repair, even while router search params
 * still expose the old page value.
 */
export function useSessionsPageReset({
  urlPageIndex,
}: {
  urlPageIndex: number;
}) {
  const [pendingPageIndex, setPendingPageIndex] = useState<number | null>(null);

  useEffect(() => {
    if (pendingPageIndex !== null && urlPageIndex === pendingPageIndex) {
      setPendingPageIndex(null);
    }
  }, [pendingPageIndex, urlPageIndex]);

  const markPageReset = useCallback(() => {
    setPendingPageIndex(0);
  }, []);

  const markPageOverride = useCallback((pageIndex: number) => {
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
  scrollKey: string;
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
    if (savedPosition === null || savedPosition <= 0) {
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
      const maxScrollTop = Math.max(
        0,
        target.scrollHeight - target.clientHeight
      );
      if (maxScrollTop > 0) {
        target.scrollTop = Math.min(targetPosition, maxScrollTop);
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

type PendingHistoryScrollSave = {
  frame: number | null;
  scrollKey: string;
  scrollTop: number;
};

function queueHistoryScrollPosition(
  pendingScrollSaveRef: MutableRefObject<PendingHistoryScrollSave | null>,
  nextScrollState: Omit<PendingHistoryScrollSave, "frame">
) {
  pendingScrollSaveRef.current = {
    ...nextScrollState,
    frame: pendingScrollSaveRef.current?.frame ?? null,
  };

  if (pendingScrollSaveRef.current.frame !== null) {
    return;
  }

  pendingScrollSaveRef.current.frame = requestAnimationFrame(() => {
    const pending = pendingScrollSaveRef.current;
    pendingScrollSaveRef.current = null;
    if (pending) {
      writeHistoryScrollPosition(pending.scrollKey, pending.scrollTop);
    }
  });
}

function cancelPendingHistoryScrollPosition(
  pendingScrollSaveRef: MutableRefObject<PendingHistoryScrollSave | null>
) {
  const pending = pendingScrollSaveRef.current;
  if (pending?.frame !== null && pending?.frame !== undefined) {
    cancelAnimationFrame(pending.frame);
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

function readBrowserPageParam(): string | null {
  if (globalThis.window === undefined) {
    return null;
  }

  return new URLSearchParams(globalThis.location.search).get(PAGE_PARAM);
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
