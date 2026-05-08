"use client";

import { useEffect, useSyncExternalStore } from "react";
import { type ElectronDetectionState, probeElectron } from "./electron-probe";

const CACHE_TTL_MS = 60_000;
const POLL_INTERVAL_MS = 10_000;

const DEFAULT_STATE: ElectronDetectionState = {
  detected: false,
  loading: true,
  port: null,
  version: null,
  machineName: null,
  gatewayId: null,
  capabilities: null,
  onboardingCompleted: null,
  checkedAt: null,
};

let snapshot: ElectronDetectionState = DEFAULT_STATE;
let expiresAt = 0;
let inFlight: Promise<ElectronDetectionState> | null = null;

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getElectronDetectionSnapshot(): ElectronDetectionState {
  return snapshot;
}

export function subscribeElectronDetection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function ensureElectronDetection(options?: {
  force?: boolean;
}): Promise<ElectronDetectionState> {
  if (globalThis.window === undefined) {
    return Promise.resolve({
      ...DEFAULT_STATE,
      loading: false,
    });
  }

  const now = Date.now();
  if (!options?.force && snapshot.checkedAt && now < expiresAt) {
    return Promise.resolve(snapshot);
  }
  if (inFlight) {
    return inFlight;
  }

  if (!snapshot.checkedAt) {
    snapshot = { ...snapshot, loading: true };
    emitChange();
  }

  inFlight = probeElectron()
    .then((result) => {
      const checkedAt = Date.now();
      snapshot = {
        ...result,
        loading: false,
        checkedAt,
      };
      expiresAt = checkedAt + CACHE_TTL_MS;
      emitChange();
      return snapshot;
    })
    .catch(() => {
      const checkedAt = Date.now();
      snapshot = {
        detected: false,
        loading: false,
        port: null,
        version: null,
        machineName: null,
        gatewayId: null,
        capabilities: null,
        onboardingCompleted: null,
        checkedAt,
      };
      expiresAt = checkedAt + CACHE_TTL_MS;
      emitChange();
      return snapshot;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

const DISABLED_STATE: ElectronDetectionState = {
  detected: false,
  loading: false,
  port: null,
  version: null,
  machineName: null,
  gatewayId: null,
  capabilities: null,
  onboardingCompleted: null,
  checkedAt: null,
};

export function useElectronDetection(enabled = true): ElectronDetectionState {
  const state = useSyncExternalStore(
    subscribeElectronDetection,
    getElectronDetectionSnapshot,
    () => DEFAULT_STATE
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    ensureElectronDetection().catch(() => undefined);
    const id = setInterval(() => {
      ensureElectronDetection({ force: true }).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled]);

  if (!enabled) {
    return DISABLED_STATE;
  }

  return state;
}

export function invalidateElectronDetectionCache(): void {
  expiresAt = 0;
}

export function resetElectronDetectionForTests(): void {
  snapshot = DEFAULT_STATE;
  expiresAt = 0;
  inFlight = null;
  listeners.clear();
}
