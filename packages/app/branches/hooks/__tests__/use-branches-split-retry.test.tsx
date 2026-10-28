/**
 * @file use-branches-split-retry.test.tsx
 * @description ISS-9789 — the split path's retry policy, over the PRODUCTION
 * QueryClient.
 *
 * `commonQueryOptions` spread an explicit `retry: undefined` over the client
 * defaults. TanStack merges query options by object spread, so a key present
 * with an `undefined` value still overwrites: the split list query lost
 * `shouldRetryQuery` and fell back to TanStack's own 3-retry backoff, which
 * retried a 403 — the one thing that predicate exists to prevent.
 *
 * The sibling suite (`use-branches.test.tsx`) cannot observe this: its harness
 * client pins `retry: false` as a DEFAULT, so a clobbered `retry` and an
 * inherited one behave identically there. This suite injects a client built by
 * the production factory, which is what the web shell actually mounts, so the
 * inherited default is the real `shouldRetryQuery`.
 */
import type {
  BranchAnalytics,
  BranchListResponse,
} from "@repo/api/src/types/branch";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import {
  MAX_TRANSIENT_QUERY_RETRIES,
  makeQueryClient,
} from "../../../shared/query/query-client";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { useBranchesPageData } from "../use-branches";

const EMPTY_ANALYTICS = {
  kpis: {},
  series: [],
} as unknown as BranchAnalytics;

const EMPTY_LIST: BranchListResponse = {
  items: [],
  total: 0,
  viewerScope: "self",
};

/**
 * A split-capable source whose list read always rejects. `supportsSplitPageData`
 * is what routes `useBranchesPageData` down the split path, and it is the same
 * flag the web HTTP source sets.
 */
function rejectingSplitSource(rejection: unknown) {
  const listSpy = vi.fn(() => Promise.reject(rejection));
  const source = {
    scope: "http",
    supportsSplitPageData: true,
    list: listSpy,
    analytics: vi.fn(() => Promise.resolve(EMPTY_ANALYTICS)),
    pageData: vi.fn(() =>
      Promise.resolve({ list: EMPTY_LIST, analytics: EMPTY_ANALYTICS })
    ),
  } as unknown as BranchesDataSource;
  return { source, listSpy };
}

function ErrorProbe() {
  const { isError } = useBranchesPageData({ owner: "alice", limit: 25 });
  return <span data-testid="probe">{isError ? "error" : "pending"}</span>;
}

function renderSplitProbe(rejection: unknown) {
  const { source, listSpy } = rejectingSplitSource(rejection);
  render(
    <AppCoreStoryProviders>
      <BranchesDataSourceProvider
        dataSource={source}
        queryClient={makeQueryClient()}
      >
        <ErrorProbe />
      </BranchesDataSourceProvider>
    </AppCoreStoryProviders>
  );
  return listSpy;
}

describe("ISS-9789 — split-path retry policy", () => {
  it("issues exactly one request for a 403", async () => {
    const listSpy = renderSplitProbe(new ApiError("branches forbidden", 403));

    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("error")
    );

    // The decisive assertion. An error surfaces either way, so only the request
    // COUNT separates the inherited `shouldRetryQuery` from the clobber that
    // sent a 403 round TanStack's default backoff.
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it("still retries a transport failure that carried no response", async () => {
    const listSpy = renderSplitProbe(new Error("network unreachable"));

    // Pinned alongside the 403 so the fix is shown to suppress retries
    // SELECTIVELY. A suite that only pinned the 403 would stay green if someone
    // later set `retry: 0` globally — a different regression wearing the same
    // green.
    await waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThan(1), {
      timeout: 5000,
    });
    expect(listSpy.mock.calls.length).toBeLessThanOrEqual(
      MAX_TRANSIENT_QUERY_RETRIES + 1
    );
  });
});
