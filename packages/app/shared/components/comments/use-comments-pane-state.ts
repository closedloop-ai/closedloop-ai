"use client";

import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { booleanOrFallback } from "@repo/app/shared/lib/local-storage-validators";
import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  COMMENTS_NARROW_QUERY,
  clampCommentsRailWidth,
} from "./comments-pane-model";

/**
 * ISS-12300 D1/D2 (Kerensa, 2026-10-08): one shown/hidden preference per page
 * type and tab, shared by every entity of that type. A fixed set, so neither
 * localStorage nor the transient store below grows per entity.
 */
export const CommentsPaneOpenKey = {
  Session: "sessions:comments-pane:open",
  BranchArtifact: "branches:comments-pane:artifact:open",
  BranchSessions: "branches:comments-pane:sessions:open",
} as const;
export type CommentsPaneOpenKey =
  (typeof CommentsPaneOpenKey)[keyof typeof CommentsPaneOpenKey];

export const CommentsPaneWidthKey = {
  Session: "sessions:comments-pane:width",
  BranchArtifact: "branches:comments-pane:artifact:width",
  BranchSessions: "branches:comments-pane:sessions:width",
} as const;
export type CommentsPaneWidthKey =
  (typeof CommentsPaneWidthKey)[keyof typeof CommentsPaneWidthKey];

/**
 * A stored width, clamped to the rail's bounds; the caller's default for
 * anything that is not a positive finite number.
 */
export function commentsPaneWidthOrFallback(
  value: unknown,
  fallback: number
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? clampCommentsRailWidth(value)
    : fallback;
}

/**
 * ISS-12300 D6: a reveal the reader did not ask for shows or hides the pane
 * for that visit only. The reader's own choice is held here for the visit too.
 * Held outside React so the header button and the pane
 * read one value without threading props.
 */
const transientByKey = new Map<CommentsPaneOpenKey, boolean>();
const transientListeners = new Set<() => void>();

function writeTransient(key: CommentsPaneOpenKey, value: boolean | null) {
  if ((transientByKey.get(key) ?? null) === value) {
    return;
  }
  if (value === null) {
    transientByKey.delete(key);
  } else {
    transientByKey.set(key, value);
  }
  for (const listener of transientListeners) {
    listener();
  }
}

function subscribeTransient(listener: () => void) {
  transientListeners.add(listener);
  return () => {
    transientListeners.delete(listener);
  };
}

export function showCommentsPaneTransiently(key: CommentsPaneOpenKey) {
  writeTransient(key, true);
}

/**
 * Effective visibility is `transient ?? (saved && wide)`: at narrow widths the
 * pane is a Sheet and never shows by itself (ISS-12300 D7, PR #8598).
 */
export function useCommentsPaneVisibility(key: CommentsPaneOpenKey) {
  const [saved, setSaved] = useLocalStorageState(key, true, booleanOrFallback);
  const transient = useSyncExternalStore(
    subscribeTransient,
    () => transientByKey.get(key) ?? null,
    () => null
  );
  const narrow = useMediaQuery(COMMENTS_NARROW_QUERY);
  // The visit keeps what the reader asked for even when localStorage refuses
  // the save; the saved value applies again once the reveal ends.
  const setOpen = useCallback(
    (open: boolean) => {
      setSaved(open);
      writeTransient(key, narrow || !isSavedAs(key, open) ? open : null);
    },
    [key, narrow, setSaved]
  );
  const showTransiently = useCallback(
    () => showCommentsPaneTransiently(key),
    [key]
  );
  const hideTransiently = useCallback(() => writeTransient(key, false), [key]);
  return {
    hideTransiently,
    open: transient ?? (saved && !narrow),
    setOpen,
    showTransiently,
  };
}

/** The pane's call: a transient reveal ends with its entity or its pane. */
export function useEndCommentsPaneTransient(
  key: CommentsPaneOpenKey,
  identity: string | null
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `identity` is the trigger; a new entity ends the reveal.
  useEffect(() => () => writeTransient(key, null), [key, identity]);
}

/** Live while dragging; persisted once per drag or keyboard step. */
export function useCommentsPaneWidth(
  key: CommentsPaneWidthKey,
  defaultWidth: number
) {
  const [saved, setSaved] = useLocalStorageState(
    key,
    defaultWidth,
    commentsPaneWidthOrFallback
  );
  const [live, setLiveWidth] = useState<number | null>(null);
  const commitWidth = useCallback(
    (width: number) => {
      setSaved(clampCommentsRailWidth(width));
      setLiveWidth(null);
    },
    [setSaved]
  );
  return { commitWidth, setLiveWidth, width: live ?? saved };
}

/** False when localStorage refused the write (quota, privacy mode). */
function isSavedAs(key: CommentsPaneOpenKey, open: boolean): boolean {
  try {
    return globalThis.localStorage.getItem(key) === JSON.stringify(open);
  } catch {
    return false;
  }
}
