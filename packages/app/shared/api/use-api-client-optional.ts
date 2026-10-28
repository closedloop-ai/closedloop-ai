"use client";

import { useMemo } from "react";
import { useOptionalAuthSnapshot } from "../auth/use-auth-snapshot";
import { useWaitForLoaded } from "../auth/use-wait-for-auth-loaded";
import { type ApiClient, createApiClient } from "./create-api-client";
import { useApiAdapterOptional } from "./provider";

/**
 * Non-throwing counterpart to {@link useApiClient}: the same client when an
 * `<ApiAdapterProvider>` is mounted, else `null` (ISS-9450).
 *
 * For SHARED machinery that gains an optional server round trip and must still
 * mount where no API port exists — Storybook, mini-table tests, the
 * persisted-view unit suites. Every hook below runs unconditionally and only the
 * RESULT is withheld, so hook order never varies with whether a provider is
 * present. Auth degrades rather than gates: `useOptionalAuthSnapshot` resolves
 * to a stable signed-out-but-loaded snapshot, so a caller that needs an identity
 * checks `userId` itself instead of inferring one from a non-null client.
 */
export function useApiClientOptional(): ApiClient | null {
  const adapter = useApiAdapterOptional();
  const { getToken, orgId, userId, isLoaded } = useOptionalAuthSnapshot();
  const waitForAuthLoaded = useWaitForLoaded(isLoaded);
  const resolveApiOrigin = adapter?.resolveApiOrigin;
  const doFetch = adapter?.fetch ?? globalThis.fetch;
  const deploymentId = adapter?.deploymentId;
  const honorsAbortSignal = adapter?.honorsAbortSignal ?? true;

  return useMemo(() => {
    if (!resolveApiOrigin) {
      return null;
    }
    return createApiClient({
      deploymentId,
      doFetch,
      getToken,
      honorsAbortSignal,
      orgId,
      resolveApiOrigin,
      userId,
      waitForAuthLoaded,
    });
  }, [
    getToken,
    userId,
    orgId,
    deploymentId,
    honorsAbortSignal,
    waitForAuthLoaded,
    resolveApiOrigin,
    doFetch,
  ]);
}
