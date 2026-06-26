"use client";

import { CURRENT_DESKTOP_API_NAMESPACE } from "@repo/api/src/desktop-api-namespace";

type InterceptorWindow = Window & {
  __engineerOriginalFetch?: typeof globalThis.fetch;
};

const CURRENT_VERSION_PATH = "/api/gateway/version";
const CACHE_TTL_MS = 60_000;

type CacheEntry = {
  namespace: string;
  checkedAt: number;
};

const namespaceCache = new Map<number, CacheEntry>();
const inFlight = new Map<number, Promise<string | undefined>>();

function getRawFetch(): typeof globalThis.fetch {
  if (typeof window === "undefined") {
    return globalThis.fetch;
  }
  return (
    (window as InterceptorWindow).__engineerOriginalFetch ?? globalThis.fetch
  );
}

function getCachedNamespace(port: number): string | null {
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
  versionPath: string
): Promise<Response> {
  return getRawFetch()(`http://localhost:${port}${versionPath}`, {
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
): Promise<string | undefined> {
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

  const probe: Promise<string | undefined> = (async () => {
    try {
      const gatewayResponse = await probeNamespace(
        port,
        sessionToken,
        CURRENT_VERSION_PATH
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

export function resetLocalGatewayApiNamespaceForTests(): void {
  namespaceCache.clear();
  inFlight.clear();
}
