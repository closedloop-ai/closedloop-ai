"use client";

import { useEffect, useSyncExternalStore } from "react";

export type ElectronDetectionState = {
  detected: boolean;
  loading: boolean;
  port: number | null;
  version: string | null;
  machineName: string | null;
  gatewayId: string | null;
  capabilities: Record<string, unknown> | null;
  onboardingCompleted: boolean | null;
  checkedAt: number | null;
};

const PROBE_PORTS = [19_432, 19_433, 19_434, 19_435] as const;
const PROBE_TIMEOUT_MS = 2000;
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

type ElectronProbeResult = Pick<
  ElectronDetectionState,
  | "detected"
  | "port"
  | "version"
  | "machineName"
  | "gatewayId"
  | "capabilities"
  | "onboardingCompleted"
>;

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHealthPayload(
  payload: Record<string, unknown> | null,
  fallbackPort: number
): ElectronProbeResult | null {
  if (!(payload && payload.status === "ok")) {
    return null;
  }

  const reportedPort =
    typeof payload.port === "number" ? payload.port : fallbackPort;
  if (reportedPort !== fallbackPort) {
    return null;
  }

  return {
    detected: true,
    port: reportedPort,
    version: typeof payload.version === "string" ? payload.version : null,
    machineName:
      typeof payload.machineName === "string" ? payload.machineName : null,
    gatewayId:
      typeof payload.gatewayId === "string" && payload.gatewayId.trim()
        ? payload.gatewayId
        : null,
    capabilities: isObject(payload.capabilities) ? payload.capabilities : {},
    onboardingCompleted:
      typeof payload.onboardingCompleted === "boolean"
        ? payload.onboardingCompleted
        : null,
  };
}

async function probeElectron(): Promise<ElectronProbeResult> {
  for (const port of PROBE_PORTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const response = await fetch(`http://localhost:${port}/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const result = parseHealthPayload(payload, port);
      if (result) {
        return result;
      }
    } catch {
      // Ignore probe errors and continue to next fallback port.
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    detected: false,
    port: null,
    version: null,
    machineName: null,
    gatewayId: null,
    capabilities: null,
    onboardingCompleted: null,
  };
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
  if (typeof window === "undefined") {
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
