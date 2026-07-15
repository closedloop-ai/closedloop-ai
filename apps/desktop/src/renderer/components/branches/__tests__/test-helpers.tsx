import {
  BranchStatus,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
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
  })
): RenderResult & { queryClient: QueryClient } {
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <ApiAdapterProvider adapter={inertApiAdapter}>
          <FeatureFlagAdapterProvider
            adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
          >
            <BranchesView dataSource={dataSource} />
          </FeatureFlagAdapterProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
  return { ...result, queryClient };
}
