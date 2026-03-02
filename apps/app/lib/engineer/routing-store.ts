"use client";

import type { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useSyncExternalStore } from "react";
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
  mode: "local-dev",
  computeTargetId: null,
  source: "auto",
  updatedAt: 0,
};

let snapshot: EngineerRoutingSelection = {
  ...DEFAULT_SELECTION,
  mode: appEnvironment === "local" ? "local-dev" : "local-dev",
};

let hydrated = false;
const listeners = new Set<() => void>();

function isRoutingMode(value: unknown): value is EngineerRoutingMode {
  return (
    value === "local-dev" ||
    value === "local-electron" ||
    value === "cloud-relay"
  );
}

function hydrateFromStorage(): void {
  if (hydrated || typeof window === "undefined") {
    return;
  }
  hydrated = true;

  const raw = window.localStorage.getItem(STORAGE_KEY);
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
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
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
    computeTargetId: mode === "cloud-relay" ? computeTargetId : null,
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
    mode: appEnvironment === "local" ? "local-dev" : "local-dev",
  };
  hydrated = false;
  listeners.clear();
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}
