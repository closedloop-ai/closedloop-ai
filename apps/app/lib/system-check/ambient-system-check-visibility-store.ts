"use client";

import { useSyncExternalStore } from "react";

type AmbientSystemCheckVisibilitySnapshot = {
  shownTargetKeys: ReadonlySet<string>;
  dismissedTargetKeys: ReadonlySet<string>;
};

type AmbientSystemCheckVisibilityState = {
  hasBeenShown: boolean;
  isDismissed: boolean;
};

const EMPTY_SET = new Set<string>();
const SERVER_SNAPSHOT: AmbientSystemCheckVisibilitySnapshot = {
  shownTargetKeys: EMPTY_SET,
  dismissedTargetKeys: EMPTY_SET,
};

let snapshot: AmbientSystemCheckVisibilitySnapshot = {
  shownTargetKeys: new Set<string>(),
  dismissedTargetKeys: new Set<string>(),
};

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AmbientSystemCheckVisibilitySnapshot {
  return snapshot;
}

function getServerSnapshot(): AmbientSystemCheckVisibilitySnapshot {
  return SERVER_SNAPSHOT;
}

function selectTargetVisibility(
  state: AmbientSystemCheckVisibilitySnapshot,
  targetKey: string
): AmbientSystemCheckVisibilityState {
  return {
    hasBeenShown:
      state.shownTargetKeys.has(targetKey) ||
      state.dismissedTargetKeys.has(targetKey),
    isDismissed: state.dismissedTargetKeys.has(targetKey),
  };
}

/** Returns tab-scoped ambient system-check visibility for a target key. */
export function useAmbientSystemCheckVisibility(
  targetKey: string
): AmbientSystemCheckVisibilityState {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return selectTargetVisibility(state, targetKey);
}

/** Marks that the ambient advisory dialog was shown for this target in the current tab. */
export function markAmbientSystemCheckTargetShown(targetKey: string): void {
  if (snapshot.shownTargetKeys.has(targetKey)) {
    return;
  }

  snapshot = {
    shownTargetKeys: new Set(snapshot.shownTargetKeys).add(targetKey),
    dismissedTargetKeys: snapshot.dismissedTargetKeys,
  };
  emitChange();
}

/** Marks that the user dismissed the ambient advisory dialog for this target in the current tab. */
export function markAmbientSystemCheckTargetDismissed(targetKey: string): void {
  if (snapshot.dismissedTargetKeys.has(targetKey)) {
    return;
  }

  snapshot = {
    shownTargetKeys: new Set(snapshot.shownTargetKeys).add(targetKey),
    dismissedTargetKeys: new Set(snapshot.dismissedTargetKeys).add(targetKey),
  };
  emitChange();
}

export function resetAmbientSystemCheckVisibilityForTests(): void {
  snapshot = {
    shownTargetKeys: new Set<string>(),
    dismissedTargetKeys: new Set<string>(),
  };
  listeners.clear();
}
