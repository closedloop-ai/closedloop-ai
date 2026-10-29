"use client";

import { useMemo } from "react";
import { useAuthSnapshot } from "../auth/use-auth-snapshot";
import { useWaitForAuthLoaded } from "../auth/use-wait-for-auth-loaded";
import { withFeatureFlagOverrides } from "../dev-tools/lib/feature-flag-overrides-fetch";
import { useIsDevModeOn } from "../feature-flags/dev-mode/dev-mode-provider";
import { createApiClient } from "./create-api-client";
import { useApiAdapter } from "./provider";

/**
 * This hook provides an HTTP client for interacting with the REST API.
 *
 * Surface-agnostic port of the former `apps/app/hooks/use-api-client.ts`
 * (FEA-1510): the API origin comes from the transport adapter and the
 * token/org identity from the auth port, so the web and desktop shells each
 * supply their own without forking this code.
 *
 * Throws ApiError on failures. This allows TanStack Query to handle errors
 * natively via its error state and global error handlers.
 */
export function useApiClient() {
  const { getToken, orgId, userId } = useAuthSnapshot();
  const waitForAuthLoaded = useWaitForAuthLoaded();
  const {
    resolveApiOrigin,
    fetch: injectedFetch,
    deploymentId,
    honorsAbortSignal = true,
  } = useApiAdapter();
  const baseFetch = injectedFetch ?? globalThis.fetch;
  // ISS-12048: while Dev Mode is on, every API request carries the Dev Tools
  // overrides and reports back the flags the API checked.
  const isDevModeOn = useIsDevModeOn();
  const doFetch = useMemo(
    () => (isDevModeOn ? withFeatureFlagOverrides(baseFetch) : baseFetch),
    [isDevModeOn, baseFetch]
  );

  return useMemo(
    () =>
      createApiClient({
        getToken,
        userId,
        orgId,
        deploymentId,
        honorsAbortSignal,
        waitForAuthLoaded,
        resolveApiOrigin,
        doFetch,
      }),
    [
      getToken,
      userId,
      orgId,
      deploymentId,
      honorsAbortSignal,
      waitForAuthLoaded,
      resolveApiOrigin,
      doFetch,
    ]
  );
}
