"use client";

import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import type { ApiAdapter } from "../api/api-adapter";
import { ApiAdapterProvider } from "../api/provider";
import { AuthAdapterProvider } from "../auth/provider";
import { createStaticAuthAdapter } from "../auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../feature-flags/static-feature-flag-adapter";
import { createFixtureFetch, type FixtureRoute } from "./fixture-fetch";

/**
 * Story/test harness for `@repo/app` components: mounts every port the
 * shared layer depends on (TanStack Query, navigation port with the memory
 * adapter, static auth adapter, inert API adapter). Components rendering
 * under this harness prove they run without Next.js, Clerk, or a live API
 * (FEA-1510 / AC-001.4).
 *
 * Nothing hits the network in stories: reads resolve from the cache seeded via
 * `queryData`, and mutations run their real `useApiClient` path against the
 * injected `createFixtureFetch` transport (see `apiRoutes` to customize the
 * canned responses), so create/apply/remove interactions exercise the migrated
 * code without a live API.
 */
type AppCoreStoryProvidersProps = {
  children: ReactNode;
  /** Cache entries applied to the story's QueryClient before render. */
  queryData?: ReadonlyArray<readonly [QueryKey, unknown]>;
  /** Override the harness fixture transport's canned API responses. */
  apiRoutes?: FixtureRoute[];
  /** Feature flags reported as enabled (all flags default to disabled). */
  enabledFlags?: readonly string[];
};

export function AppCoreStoryProviders({
  children,
  queryData = [],
  apiRoutes,
  enabledFlags,
}: AppCoreStoryProvidersProps) {
  const [apiAdapter] = useState<ApiAdapter>(() => ({
    resolveApiOrigin: () => "http://storybook.invalid",
    fetch: createFixtureFetch(apiRoutes),
  }));
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    for (const [key, data] of queryData) {
      client.setQueryData(key, data);
    }
    return client;
  });
  const [memoryNavigation] = useState(() =>
    createMemoryNavigation({ orgSlug: "org-test" })
  );
  const [featureFlagAdapter] = useState(() =>
    createStaticFeatureFlagAdapter({ enabledFlags })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <NavigationProvider adapter={memoryNavigation.adapter}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <FeatureFlagAdapterProvider adapter={featureFlagAdapter}>
            <ApiAdapterProvider adapter={apiAdapter}>
              {children}
            </ApiAdapterProvider>
          </FeatureFlagAdapterProvider>
        </AuthAdapterProvider>
      </NavigationProvider>
    </QueryClientProvider>
  );
}
