"use client";

/**
 * Gateway detection store -- manages the cached detection state.
 *
 * Uses useSyncExternalStore for React integration. The store itself
 * is framework-agnostic; the React hook is a thin wrapper.
 */

import { useEffect, useSyncExternalStore } from "react";
import { probeGateway } from "./gateway-probe";
import type { GatewayDetectionState } from "./types";

const CACHE_TTL_MS = 60_000;
const POLL_INTERVAL_MS = 10_000;

const DEFAULT_STATE: GatewayDetectionState = {
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

let snapshot: GatewayDetectionState = DEFAULT_STATE;
let expiresAt = 0;
let inFlight: Promise<GatewayDetectionState> | null = null;

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getGatewayDetectionSnapshot(): GatewayDetectionState {
  return snapshot;
}

export function subscribeGatewayDetection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function ensureGatewayDetection(options?: {
  force?: boolean;
}): Promise<GatewayDetectionState> {
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

  inFlight = probeGateway()
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

const DISABLED_STATE: GatewayDetectionState = {
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

export function useGatewayDetection(enabled = true): GatewayDetectionState {
  const state = useSyncExternalStore(
    subscribeGatewayDetection,
    getGatewayDetectionSnapshot,
    () => DEFAULT_STATE
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    ensureGatewayDetection().catch(() => undefined);
    const id = setInterval(() => {
      ensureGatewayDetection({ force: true }).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled]);

  if (!enabled) {
    return DISABLED_STATE;
  }

  return state;
}

export function invalidateGatewayDetectionCache(): void {
  expiresAt = 0;
}

export function resetGatewayDetectionForTests(): void {
  snapshot = DEFAULT_STATE;
  expiresAt = 0;
  inFlight = null;
  listeners.clear();
}
