"use client";

import {
  useFeatureFlag,
  useFeatureFlagProductionValue,
} from "@repo/analytics/client";
import type { PinnedFeatureFlags } from "@repo/analytics/feature-flag-value";
import { PinnedFeatureFlagsProvider } from "@repo/analytics/pinned-feature-flags";
import { LOCAL_TRUSTED_CLIENT_TOKEN } from "@repo/api/src/types/local-trusted-auth";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import type {
  AuthAdapter,
  AuthSnapshot,
  AuthTokenOptions,
} from "@repo/app/shared/auth/auth-adapter";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import type { LocalTrustedIdentity } from "@repo/auth/auth-mode";
import { useAuth, useOrganization, useSession } from "@repo/auth/client";
import { LocalTrustedIdentityProvider } from "@repo/auth/local-trusted-client";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { type ReactNode, useCallback, useMemo } from "react";
import { resolveApiOrigin } from "@/lib/api-origin";
import { WebDevModeProvider } from "@/lib/dev-mode/web-dev-mode-provider";
import { replaceOrgSlugSegment } from "@/lib/org-slug-path";
import { WebRealtimeHost } from "@/lib/realtime/web-realtime-host";

/**
 * Web-shell adapters for the shared app-core ports (FEA-1510). The Clerk and
 * env/preview-hostname specifics live here, in the app's own source tree —
 * `@repo/app` only ever sees the port contracts. The desktop shell mounts
 * its own adapters (FEA-1514) against the same ports.
 */
const clerkAuthAdapter: AuthAdapter = {
  useAuthSnapshot(): AuthSnapshot {
    const { isLoaded, userId, orgId, getToken } = useAuth();
    // ISS-9701: map the port's vendor-neutral `forceRefresh` onto Clerk's
    // `skipCache`. Clerk caches the session JWT it mints, so a plain
    // `getToken()` after a 401 hands back the same rejected string; only this
    // option makes the refresh-and-retry actually carry a new credential.
    // `useCallback` keeps the reference stable so the snapshot below — and the
    // `useApiClient` memo that depends on it — do not rebuild every render.
    const getAuthToken = useCallback(
      (options?: AuthTokenOptions) =>
        options?.forceRefresh ? getToken({ skipCache: true }) : getToken(),
      [getToken]
    );
    return useMemo(
      () => ({
        isLoaded,
        userId: userId ?? null,
        orgId: orgId ?? null,
        getToken: getAuthToken,
      }),
      [isLoaded, userId, orgId, getAuthToken]
    );
  },
  useOrganizationIdentityResync() {
    const { organization } = useOrganization();
    const { session } = useSession();
    // Port hooks, not `next/navigation`: an adapter member resolves at the
    // CONSUMER's render position, and every Settings consumer renders inside
    // `AppNavigationProvider` — the same reasoning the flag adapter above notes.
    const pathname = usePath();
    const searchParams = useSearchParamsValue();
    const navigation = useNavigation();

    return useCallback(
      async (nextOrgSlug: string) => {
        // `allSettled`, not `all`: the rename already committed server-side, so
        // a Clerk reload that rejects must not stop the re-anchor below and
        // strand the user on a URL whose slug no longer resolves. Carried over
        // from the legacy slug editor, where a test pins the same guarantee.
        await Promise.allSettled([organization?.reload(), session?.reload()]);

        // `usePath()` is the pathname alone, so re-anchoring on it would drop
        // the query — and Settings v2 keeps the open panel, the intent and the
        // close destination there. A rename must not silently switch panels.
        const query = searchParams.toString();
        const suffix = query ? `?${query}` : "";
        const nextHref = `${replaceOrgSlugSegment(pathname, nextOrgSlug)}${suffix}`;

        // A name-only save resyncs Clerk without moving the URL, so the href is
        // the one we are already on. Replacing onto it would be a navigation
        // that changes nothing.
        if (nextHref !== `${pathname}${suffix}`) {
          navigation.replace(nextHref);
        }
      },
      [organization, session, pathname, searchParams, navigation]
    );
  },
};

/**
 * Exported so tests can mount the real web mapping through
 * `FeatureFlagAdapterProvider` instead of restating it.
 */
export const posthogFeatureFlagAdapter: FeatureFlagAdapter = {
  useFeatureFlagEnabled: (key: string) => useFeatureFlag(key)?.enabled === true,
  // PostHog resolves asynchronously, and `useFeatureFlag` returns `undefined`
  // until it does — indistinguishable from a resolved `false` at the
  // `useFeatureFlagEnabled` boundary. Surfaces whose DATA REQUEST depends on the
  // flag need that difference (FEA-1626): without it an enabled user fetches on
  // the closed default and refetches a beat later.
  useFeatureFlagResolved: (key: string) => useFeatureFlag(key) !== undefined,
  // ISS-12048: the real value the Dev Tools overlay shows beside each flag.
  useFeatureFlagProductionValue: (key: string) =>
    useFeatureFlagProductionValue(key),
};

export function AppCoreAdapterProvider({
  children,
  apiDeploymentId,
  localTrustedAuthIdentity,
  pinnedFeatureFlags = null,
}: {
  children: ReactNode;
  /**
   * api deployment uid resolved server-side from the FEA-1484 Edge Config pin
   * store (FEA-1485). Forwarded as `x-deployment-id` on app→api fetches;
   * `null`/undefined off app-prod → no pin.
   */
  apiDeploymentId?: string | null;
  /**
   * Server-guarded synthetic identity for `AUTH_MODE=local_trusted` harnesses.
   * Real deployments leave this absent and continue through Clerk.
   */
  localTrustedAuthIdentity?: LocalTrustedIdentity | null;
  /**
   * ISS-12048: a `$vibe` preview's production flag snapshot, resolved by the
   * root layout's server render; `null` outside such a preview.
   */
  pinnedFeatureFlags?: PinnedFeatureFlags | null;
}) {
  const apiAdapter = useMemo<ApiAdapter>(
    () => ({
      resolveApiOrigin: () => resolveApiOrigin(),
      deploymentId: apiDeploymentId ?? null,
    }),
    [apiDeploymentId]
  );
  const authAdapter = useMemo<AuthAdapter>(() => {
    if (!localTrustedAuthIdentity) {
      return clerkAuthAdapter;
    }
    return createStaticAuthAdapter({
      isLoaded: true,
      orgId: localTrustedAuthIdentity.orgId,
      userId: localTrustedAuthIdentity.userId,
      // Inert but non-empty: local_trusted has no Clerk token, and a null token
      // makes the shared API client wait through the real-Clerk hydration retry.
      getToken: () => Promise.resolve(LOCAL_TRUSTED_CLIENT_TOKEN),
    });
  }, [localTrustedAuthIdentity]);

  return (
    <LocalTrustedIdentityProvider identity={localTrustedAuthIdentity ?? null}>
      <AuthAdapterProvider adapter={authAdapter}>
        <PinnedFeatureFlagsProvider flags={pinnedFeatureFlags}>
          <FeatureFlagAdapterProvider adapter={posthogFeatureFlagAdapter}>
            <ApiAdapterProvider adapter={apiAdapter}>
              <WebRealtimeHost>
                {/* ISS-7477: innermost, so every flag consumer below — the port
                    adapter above included, since it resolves at the CONSUMER's
                    render position — reads through the customer view when it is
                    active. */}
                <WebDevModeProvider>{children}</WebDevModeProvider>
              </WebRealtimeHost>
            </ApiAdapterProvider>
          </FeatureFlagAdapterProvider>
        </PinnedFeatureFlagsProvider>
      </AuthAdapterProvider>
    </LocalTrustedIdentityProvider>
  );
}
