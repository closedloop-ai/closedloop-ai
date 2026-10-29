import {
  type BranchListResponse,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { BranchesListRolloutDecisionReason } from "@repo/api/src/types/branches-list-rollout";
import {
  GridviewRolloutDecisionOutcome,
  SharedAnalyticsComponent,
  Surface,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SurfaceAnalyticsProvider } from "../../../shared/observability/surface-analytics-context";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { makeBranchAnalytics } from "../../components/branch-analytics-fixtures";
import { useBranchesPageData } from "../../hooks/use-branches";
import type { BranchesDataSource } from "../branches-data-source";
import { BranchesDataSourceProvider } from "../provider";
import { makeBranchRow } from "./branch-row-test-fixture";

const MISSING_ADAPTER_RE = /AdapterProvider/;
const ANALYTICS_FIXTURE = makeBranchAnalytics();

/**
 * A minimal non-HTTP data source. Only `pageData` is exercised here; the
 * other reads reject so any accidental call surfaces loudly. `scope` is what
 * isolates this source's cache entries from another's.
 */
function fakeSource(scope: string, total: number): BranchesDataSource {
  return {
    scope,
    list: () => Promise.reject(new Error("list unused")),
    detail: () => Promise.reject(new Error("detail unused")),
    comments: () => Promise.reject(new Error("comments unused")),
    trace: () => Promise.reject(new Error("trace unused")),
    usage: () => Promise.reject(new Error("usage unused")),
    analytics: () => Promise.reject(new Error("analytics unused")),
    pageData: () =>
      Promise.resolve({
        list: { items: [], total, viewerScope: "self" },
        analytics: ANALYTICS_FIXTURE,
      }),
  };
}

function ListTotalProbe({ testId }: { testId: string }) {
  const { data } = useBranchesPageData({});
  return (
    <span data-testid={testId}>
      {data ? `total:${data.list.total}` : "loading"}
    </span>
  );
}

describe("branches data source provider", () => {
  it("reports measured complete-cohort work through the production HTTP source", async () => {
    const capture = vi.fn();
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/branches",
            respond: ({ searchParams }) =>
              completePage(Number(searchParams.get("offset") ?? 0), 101),
          },
          {
            method: "GET",
            path: "/branches/analytics",
            respond: () => ANALYTICS_FIXTURE,
          },
        ]}
      >
        <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
          <ListTotalProbe testId="http" />
        </SurfaceAnalyticsProvider>
      </AppCoreStoryProviders>
    );

    await waitFor(() => {
      expect(screen.getByTestId("http")).toHaveTextContent("total:101");
    });
    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.GridviewRolloutDecision,
      expect.objectContaining({
        component: SharedAnalyticsComponent.BranchesListSurfaceV2,
        outcome: GridviewRolloutDecisionOutcome.Enabled,
        peak_request_concurrency: 1,
        reason: BranchesListRolloutDecisionReason.CompleteCohortRead,
        request_count: 2,
        row_count: 101,
        surface: Surface.Web,
      })
    );
  });

  it("scopes the cache by source so two sources under one QueryClient never cross-contaminate", async () => {
    // Both probes read the same filters (`{}`) under the same QueryClient. The
    // left subtree injects a local source (total 7); the right falls through to
    // the HTTP default (total 99). Without the per-source scope segment in the
    // query key these would collide on one cache entry and the second to render
    // would show the first's rows. The injected source is also proven to be
    // used as-is (no HTTP call) by the left probe resolving to its own total.
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/branches",
            respond: () => completePage(0, 99),
          },
        ]}
      >
        <BranchesDataSourceProvider dataSource={fakeSource("local", 7)}>
          <ListTotalProbe testId="local" />
        </BranchesDataSourceProvider>
        <ListTotalProbe testId="http" />
      </AppCoreStoryProviders>
    );

    await waitFor(() => {
      expect(screen.getByTestId("local")).toHaveTextContent("total:7");
      expect(screen.getByTestId("http")).toHaveTextContent("total:99");
    });
  });

  it("requires the API/auth stack even when a non-HTTP source is injected (documented contract)", () => {
    // The accessor always constructs the fallback HTTP client (Rules of Hooks),
    // so an injected source still needs the auth/API adapters above it. This is
    // intentional — desktop keeps the stack mounted for the eventual
    // authenticated-backend path — and is pinned here so the contract can't
    // silently regress.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    expect(() =>
      render(
        <QueryClientProvider client={queryClient}>
          <BranchesDataSourceProvider dataSource={fakeSource("local", 7)}>
            <ListTotalProbe testId="local" />
          </BranchesDataSourceProvider>
        </QueryClientProvider>
      )
    ).toThrow(MISSING_ADAPTER_RE);

    errorSpy.mockRestore();
  });
});

function completePage(offset: number, total: number): BranchListResponse {
  const itemCount = Math.min(100, Math.max(0, total - offset));
  return {
    hasMore: offset + itemCount < total,
    items: Array.from({ length: itemCount }, (_, index) =>
      makeBranchRow(`branch-${offset + index}`)
    ),
    total,
    viewerScope: BranchViewerScope.Organization,
  };
}
