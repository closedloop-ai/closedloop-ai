"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import type {
  AuthAdapter,
  AuthSnapshot,
} from "@repo/app/shared/auth/auth-adapter";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { useAuth } from "@repo/auth/client";
import { type ReactNode, useMemo } from "react";
import { resolveApiOrigin } from "@/lib/api-origin";

/**
 * Web-shell adapters for the shared app-core ports (FEA-1510). The Clerk and
 * env/preview-hostname specifics live here, in the app's own source tree —
 * `@repo/app` only ever sees the port contracts. The desktop shell mounts
 * its own adapters (FEA-1514) against the same ports.
 */
const clerkAuthAdapter: AuthAdapter = {
  useAuthSnapshot(): AuthSnapshot {
    const { isLoaded, userId, orgId, getToken } = useAuth();
    return useMemo(
      () => ({
        isLoaded,
        userId: userId ?? null,
        orgId: orgId ?? null,
        getToken,
      }),
      [isLoaded, userId, orgId, getToken]
    );
  },
};

const posthogFeatureFlagAdapter: FeatureFlagAdapter = {
  useFeatureFlagEnabled: (key: string) => useFeatureFlag(key)?.enabled === true,
};

export function AppCoreAdapterProvider({
  children,
  apiDeploymentId,
}: {
  children: ReactNode;
  /**
   * api deployment uid resolved server-side from the FEA-1484 Edge Config pin
   * store (FEA-1485). Forwarded as `x-deployment-id` on app→api fetches;
   * `null`/undefined off app-prod → no pin.
   */
  apiDeploymentId?: string | null;
}) {
  const apiAdapter = useMemo<ApiAdapter>(
    () => ({
      resolveApiOrigin: () => resolveApiOrigin(),
      deploymentId: apiDeploymentId ?? null,
    }),
    [apiDeploymentId]
  );

  return (
    <AuthAdapterProvider adapter={clerkAuthAdapter}>
      <FeatureFlagAdapterProvider adapter={posthogFeatureFlagAdapter}>
        <ApiAdapterProvider adapter={apiAdapter}>{children}</ApiAdapterProvider>
      </FeatureFlagAdapterProvider>
    </AuthAdapterProvider>
  );
}
