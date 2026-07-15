import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { useBranches } from "../../hooks/use-branches";
import type { BranchesDataSource } from "../branches-data-source";
import { BranchesDataSourceProvider } from "../provider";

const MISSING_ADAPTER_RE = /AdapterProvider/;

/**
 * A minimal non-HTTP data source. Only `list` is exercised here; the other
 * reads reject so any accidental call surfaces loudly. `scope` is what isolates
 * this source's cache entries from another's.
 */
function fakeSource(scope: string, total: number): BranchesDataSource {
  return {
    scope,
    list: () => Promise.resolve({ items: [], total, viewerScope: "self" }),
    detail: () => Promise.reject(new Error("detail unused")),
    comments: () => Promise.reject(new Error("comments unused")),
    trace: () => Promise.reject(new Error("trace unused")),
    usage: () => Promise.reject(new Error("usage unused")),
    analytics: () => Promise.reject(new Error("analytics unused")),
  };
}

function ListTotalProbe({ testId }: { testId: string }) {
  const { data } = useBranches({});
  return (
    <span data-testid={testId}>{data ? `total:${data.total}` : "loading"}</span>
  );
}

describe("branches data source provider", () => {
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
            respond: () => ({ items: [], total: 99, viewerScope: "self" }),
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
