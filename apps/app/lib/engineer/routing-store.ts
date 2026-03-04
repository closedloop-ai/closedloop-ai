"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useSyncExternalStore } from "react";
import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
} from "@/lib/engineer/storage";
import { appEnvironment } from "@/lib/environment";

const STORAGE_KEY = "engineer-routing-selection:v1";

type EngineerRoutingSource = "auto" | "manual";

export type EngineerRoutingSelection = {
  mode: EngineerRoutingMode;
  computeTargetId: string | null;
  source: EngineerRoutingSource;
  updatedAt: number;
};

const DEFAULT_SELECTION: EngineerRoutingSelection = {
  mode: EngineerRoutingMode.LocalDev,
  computeTargetId: null,
  source: "auto",
  updatedAt: 0,
};

let snapshot: EngineerRoutingSelection = {
  ...DEFAULT_SELECTION,
  mode:
    appEnvironment === "local"
      ? EngineerRoutingMode.LocalDev
      : EngineerRoutingMode.CloudRelay,
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
    const parsed = JSON.parse(raw) as Partial<EngineerRoutingSelection>;
    if (!isRoutingMode(parsed.mode)) {
      return;
    }

    snapshot = {
      mode: parsed.mode,
      computeTargetId:
        typeof parsed.computeTargetId === "string"
          ? parsed.computeTargetId
          : null,
      source: parsed.source === "manual" ? "manual" : "auto",
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    // Ignore corrupted local storage and keep defaults.
  }
}

function persistSelection(next: EngineerRoutingSelection): void {
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
  computeTargetId: string | null,
  source: EngineerRoutingSource
): EngineerRoutingSelection {
  return {
    mode,
    computeTargetId:
      mode === EngineerRoutingMode.CloudRelay ? computeTargetId : null,
    source,
    updatedAt: Date.now(),
  };
}

function setSnapshot(next: EngineerRoutingSelection): EngineerRoutingSelection {
  hydrateFromStorage();

  const unchanged =
    snapshot.mode === next.mode &&
    snapshot.computeTargetId === next.computeTargetId &&
    snapshot.source === next.source;

  if (unchanged) {
    return snapshot;
  }

  snapshot = next;
  persistSelection(snapshot);
  emitChange();
  return snapshot;
}

export function getEngineerRoutingSelection(): EngineerRoutingSelection {
  hydrateFromStorage();
  return snapshot;
}

export function subscribeEngineerRoutingSelection(
  listener: () => void
): () => void {
  hydrateFromStorage();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setEngineerRoutingManualSelection(
  mode: EngineerRoutingMode,
  computeTargetId: string | null = null
): EngineerRoutingSelection {
  return setSnapshot(normalizeSelection(mode, computeTargetId, "manual"));
}

export function setEngineerRoutingAutoSelection(
  mode: EngineerRoutingMode,
  computeTargetId: string | null = null,
  options?: { force?: boolean }
): EngineerRoutingSelection {
  hydrateFromStorage();

  if (!options?.force && snapshot.source === "manual") {
    return snapshot;
  }

  return setSnapshot(normalizeSelection(mode, computeTargetId, "auto"));
}

export function useEngineerRoutingSelection(): EngineerRoutingSelection {
  return useSyncExternalStore(
    subscribeEngineerRoutingSelection,
    getEngineerRoutingSelection,
    () => DEFAULT_SELECTION
  );
}

export function resetEngineerRoutingSelectionForTests(): void {
  snapshot = {
    ...DEFAULT_SELECTION,
    mode:
      appEnvironment === "local"
        ? EngineerRoutingMode.LocalDev
        : EngineerRoutingMode.CloudRelay,
  };
  hydrated = false;
  listeners.clear();
  removeStorageItem(STORAGE_KEY);
}
