/**
 * Routing selection store -- manages which routing mode is active.
 *
 * Persists to localStorage with SSR-safe guards. Uses useSyncExternalStore
 * for React integration.
 */

import { useSyncExternalStore } from "react";
import { getStorageItem, removeStorageItem, setStorageItem } from "./storage";
import { EngineerRoutingMode, type RoutingSelection } from "./types";

const STORAGE_KEY = "engineer-routing-selection:v1";

const DEFAULT_SELECTION: RoutingSelection = {
  mode: EngineerRoutingMode.CloudRelay,
  computeTargetId: null,
  updatedAt: 0,
};

let snapshot: RoutingSelection = {
  ...DEFAULT_SELECTION,
};

let hydrated = false;
const listeners = new Set<() => void>();

const ROUTING_MODE_VALUES: Set<string> = new Set(
  Object.values(EngineerRoutingMode)
);

function isRoutingMode(value: unknown): value is EngineerRoutingMode {
  return typeof value === "string" && ROUTING_MODE_VALUES.has(value);
}

function hydrateFromStorage(): void {
  if (hydrated || globalThis.window === undefined) {
    return;
  }
  hydrated = true;

  const raw = getStorageItem(STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RoutingSelection>;
    if (!isRoutingMode(parsed.mode)) {
      return;
    }

    // A stored `source` (older builds wrote "auto" or "manual") is ignored:
    // ISS-12617 removed the manual selection, so every stored value loads as
    // an ordinary selection the surface may repair.
    snapshot = {
      mode: parsed.mode,
      computeTargetId:
        typeof parsed.computeTargetId === "string"
          ? parsed.computeTargetId
          : null,
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    // Ignore corrupted local storage and keep defaults.
  }
}

function persistSelection(next: RoutingSelection): void {
  if (globalThis.window === undefined) {
    return;
  }
  setStorageItem(STORAGE_KEY, JSON.stringify(next));
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function normalizeSelection(
  mode: EngineerRoutingMode,
  computeTargetId: string | null
): RoutingSelection {
  return {
    mode,
    // Preserve computeTargetId for both CloudRelay and LocalElectron modes.
    computeTargetId:
      mode === EngineerRoutingMode.CloudRelay ||
      mode === EngineerRoutingMode.LocalElectron
        ? computeTargetId
        : null,
    updatedAt: Date.now(),
  };
}

function setSnapshot(next: RoutingSelection): RoutingSelection {
  hydrateFromStorage();

  const unchanged =
    snapshot.mode === next.mode &&
    snapshot.computeTargetId === next.computeTargetId;

  if (unchanged) {
    return snapshot;
  }

  snapshot = next;
  persistSelection(snapshot);
  emitChange();
  return snapshot;
}

export function getRoutingSelection(): RoutingSelection {
  hydrateFromStorage();
  return snapshot;
}

export function subscribeRoutingSelection(listener: () => void): () => void {
  hydrateFromStorage();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setRoutingAutoSelection(
  mode: EngineerRoutingMode,
  computeTargetId: string | null = null
): RoutingSelection {
  return setSnapshot(normalizeSelection(mode, computeTargetId));
}

export function useRoutingSelection(): RoutingSelection {
  return useSyncExternalStore(
    subscribeRoutingSelection,
    getRoutingSelection,
    () => DEFAULT_SELECTION
  );
}

export function resetRoutingSelectionForTests(): void {
  snapshot = { ...DEFAULT_SELECTION };
  hydrated = false;
  listeners.clear();
  removeStorageItem(STORAGE_KEY);
}
