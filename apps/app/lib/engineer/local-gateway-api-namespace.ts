"use client";

import {
  CURRENT_DESKTOP_API_NAMESPACE,
  type DesktopApiNamespace,
  LEGACY_DESKTOP_API_NAMESPACE,
  rewriteDesktopApiPath,
} from "@repo/api/src/desktop-api-namespace";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import {
  ensureElectronDetection,
  getElectronDetectionSnapshot,
} from "./electron-detection";
import { ensureLocalGatewaySession } from "./local-gateway-session";
import { getEngineerRoutingSelection } from "./routing-store";

type InterceptorWindow = Window & {
  __engineerOriginalFetch?: typeof globalThis.fetch;
};

const VERSION_PATH = "/api/gateway/version";
const CACHE_TTL_MS = 60_000;

type CacheEntry = {
  namespace: DesktopApiNamespace;
  checkedAt: number;
};

const namespaceCache = new Map<number, CacheEntry>();
const inFlight = new Map<number, Promise<DesktopApiNamespace | undefined>>();

function getRawFetch(): typeof globalThis.fetch {
  if (typeof window === "undefined") {
    return globalThis.fetch;
  }
  return (
    (window as InterceptorWindow).__engineerOriginalFetch ?? globalThis.fetch
  );
}

function getCachedNamespace(port: number): DesktopApiNamespace | null {
  const cached = namespaceCache.get(port);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.checkedAt >= CACHE_TTL_MS) {
    namespaceCache.delete(port);
    return null;
  }
  return cached.namespace;
}

function probeNamespace(
  port: number,
  sessionToken: string,
  namespace: DesktopApiNamespace
): Promise<Response> {
  const path = rewriteDesktopApiPath(VERSION_PATH, namespace);
  return getRawFetch()(`http://localhost:${port}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "x-desktop-session-token": sessionToken,
    },
    cache: "no-store",
    credentials: "omit",
    mode: "cors",
  });
}

function isRouteMissingResponse(response: Response): boolean {
  return response.status === 404 || response.status === 405;
}

export async function ensureLocalGatewayApiNamespace(
  port: number,
  sessionToken: string | null
): Promise<DesktopApiNamespace | undefined> {
  if (!sessionToken) {
    return undefined;
  }

  const cachedNamespace = getCachedNamespace(port);
  if (cachedNamespace) {
    return cachedNamespace;
  }

  const existing = inFlight.get(port);
  if (existing) {
    return await existing;
  }

  const probe: Promise<DesktopApiNamespace | undefined> = (async () => {
    try {
      const gatewayResponse = await probeNamespace(
        port,
        sessionToken,
        CURRENT_DESKTOP_API_NAMESPACE
      );
      if (gatewayResponse.ok) {
        namespaceCache.set(port, {
          namespace: CURRENT_DESKTOP_API_NAMESPACE,
          checkedAt: Date.now(),
        });
        return CURRENT_DESKTOP_API_NAMESPACE;
      }

      if (!isRouteMissingResponse(gatewayResponse)) {
        throw new Error(
          `Gateway namespace probe returned status ${gatewayResponse.status}`
        );
      }

      const legacyResponse = await probeNamespace(
        port,
        sessionToken,
        LEGACY_DESKTOP_API_NAMESPACE
      );
      if (legacyResponse.ok) {
        namespaceCache.set(port, {
          namespace: LEGACY_DESKTOP_API_NAMESPACE,
          checkedAt: Date.now(),
        });
        return LEGACY_DESKTOP_API_NAMESPACE;
      }

      throw new Error(
        `Legacy namespace probe returned status ${legacyResponse.status}`
      );
    } catch {
      return undefined;
    }
  })().finally(() => {
    inFlight.delete(port);
  });

  inFlight.set(port, probe);
  return await probe;
}

export function invalidateLocalGatewayApiNamespace(port?: number): void {
  if (typeof port === "number") {
    namespaceCache.delete(port);
    inFlight.delete(port);
    return;
  }
  namespaceCache.clear();
  inFlight.clear();
}

export async function resolveDesktopApiNamespaceHint(): Promise<
  DesktopApiNamespace | undefined
> {
  const routingSelection = getEngineerRoutingSelection();
  if (routingSelection.mode !== EngineerRoutingMode.LocalElectron) {
    return undefined;
  }

  const detectionSnapshot = getElectronDetectionSnapshot();
  const detection =
    detectionSnapshot.checkedAt === null
      ? await ensureElectronDetection()
      : detectionSnapshot;

  if (!(detection.detected && detection.port)) {
    return undefined;
  }

  const sessionToken = await ensureLocalGatewaySession(detection.port);
  if (!sessionToken) {
    return undefined;
  }

  return ensureLocalGatewayApiNamespace(detection.port, sessionToken);
}

export function resetLocalGatewayApiNamespaceForTests(): void {
  namespaceCache.clear();
  inFlight.clear();
}
