import {
  BranchStatus,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import type { FeatureFlagAdapter } from "@repo/app/shared/feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import { BranchesView } from "../branches-view";

/**
 * Shared fixtures + render helper for the `branches-view` renderer tests.
 * `branches-view.test.tsx` (row → detail links) and
 * `branches-responsive-layout.test.tsx` (FEA-2935 metric grid) both mount
 * `BranchesView` inside the same provider stack over an inert (no-network) API
 * adapter, so the fixture row, adapter, and `renderView` helper live here once
 * instead of being duplicated verbatim in each file. Each test still owns its
 * own `dataSource` (their `list`/`usage`/`analytics` behaviour differs) and
 * passes it into `renderView`.
 */

/** No-remote REST adapter: any `fetch` rejects, so the tests stay offline. */
export const inertApiAdapter: ApiAdapter = {
  resolveApiOrigin: () => "http://test.local",
  fetch: () => Promise.reject(new Error("no remote REST API in tests")),
};

/** A single open-PR branch row; the base fixture both test files build on. */
export const wireRow: WireBranchRow = {
  id: "owner%2Frepo::feature",
  branchName: "feature/x",
  baseBranch: "main",
  repoFullName: "owner/repo",
  owner: "alice",
  status: BranchStatus.Open,
  prNumber: 42,
  prTitle: "Add x",
  prState: "OPEN",
  prUrl: "https://github.com/owner/repo/pull/42",
  multiPrWarning: false,
  checksStatus: null,
  checksPassed: null,
  checksTotal: null,
  reviewDecision: null,
  ahead: null,
  behind: null,
  additions: null,
  deletions: null,
  filesChanged: null,
  estimatedCostUsd: null,
  lastActivityAt: "2026-06-17T12:00:00.000Z",
  sessionIds: ["s1"],
};

/**
 * Mounts `BranchesView` over the shared provider stack with the caller's
 * `dataSource`. Returns the RTL result plus the `QueryClient` so tests that
 * inspect the branch query cache (staleTime/refetch) can reach it.
 *
 * Pass an explicit `queryClient` to share one cache across two `renderView`
 * calls — e.g. a nav-away (unmount) + nav-back (remount) sequence, where the
 * KPI cards must keep serving the cached value rather than regressing to a
 * loading/empty read (FEA-2938).
 */
export function renderView(
  dataSource: BranchesDataSource,
  queryClient: QueryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  }),
  // Other feature flags enabled for this render. The helper models the
  // connected rollout cohort unless a test supplies its own adapter.
  enabledFlags: string[] = [],
  initialPath = "/branches",
  /**
   * ISS-9725: whether the shell has committed to this panel. Branches is kept
   * mounted across navigation, so a suite covering the hidden keep-alive tree
   * has to be able to say so — and to TOGGLE it on the same instance, which is
   * what production does (`App.tsx` never remounts the panel).
   */
  isActive = true,
  /**
   * ISS-9437: the flag adapter, for a suite that needs one reporting real
   * SETTLED-ness. `createStaticFeatureFlagAdapter` implements no
   * `useFeatureFlagResolved`, so every flag reads as already resolved under it —
   * which is right for the suites that only care about on/off, and useless for
   * one covering what a surface does while the answer has not arrived.
   */
  featureFlagAdapter?: FeatureFlagAdapter,
  surfaceAnalyticsCapture: SurfaceAnalyticsCapture = noopSurfaceAnalyticsCapture
): RenderResult & {
  queryClient: QueryClient;
  /** Toggle `isActive` on the SAME instance — the keep-alive path production takes. */
  setActive: (next: boolean) => void;
} {
  installConnectedGitHubStatusFallback();
  const tree = (active: boolean) => (
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <ApiAdapterProvider adapter={inertApiAdapter}>
          <FeatureFlagAdapterProvider
            adapter={
              featureFlagAdapter ??
              createStaticFeatureFlagAdapter({
                enabledFlags: [
                  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
                  ...enabledFlags,
                ],
              })
            }
          >
            {/* FEA-3560: the view reads/writes facet params via the navigation
                port, so mount the in-memory adapter (mirrors production, where
                the desktop shell always provides one). */}
            <NavigationProvider
              adapter={createMemoryNavigation({ initialPath }).adapter}
            >
              <SurfaceAnalyticsProvider
                capture={surfaceAnalyticsCapture}
                surface={Surface.Desktop}
              >
                <BranchesView dataSource={dataSource} isActive={active} />
              </SurfaceAnalyticsProvider>
            </NavigationProvider>
          </FeatureFlagAdapterProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
  const result = render(tree(isActive));
  return {
    ...result,
    queryClient,
    setActive: (next: boolean) => result.rerender(tree(next)),
  };
}

function installConnectedGitHubStatusFallback(): void {
  if (window.desktopApi?.getGitHubIntegrationStatus) {
    return;
  }
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      ...window.desktopApi,
      getGitHubIntegrationStatus: () => Promise.resolve({ connected: true }),
    },
  });
}

function noopSurfaceAnalyticsCapture(): void {}
