import {
  type BranchListResponse,
  type BranchPageDetail,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type {
  BranchesDataSource,
  BranchQueryFilters,
} from "../../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../../data-source/provider";
import {
  branchesKeys,
  useBranchDetail,
  useBranches,
} from "../../../hooks/use-branches";
import { branchesOverlayKeys } from "../overlay-keys";
import {
  BranchesOverlayRefreshProvider,
  type OverlayRefreshSignal,
} from "../overlay-refresh-provider";
import { useOverlayRefresh } from "../use-overlay-refresh";

const TEST_BRANCH_ID = "repo%2Fowner::main";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function invalidatedKeys(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) =>
    JSON.stringify((call[0] as { queryKey?: unknown })?.queryKey)
  );
}

function makeListResponse(): BranchListResponse {
  return {
    items: [],
    total: 0,
    viewerScope: BranchViewerScope.Self,
    hasMore: false,
  };
}

function makeDetail(id: string): BranchPageDetail {
  return {
    id,
    branchName: "main",
    baseBranch: null,
    repoFullName: null,
    owner: null,
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
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
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    sessionIds: [],
    prBody: null,
    prBodyHtmlUrl: null,
    headSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [],
    mergedTrace: [],
    leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
    linkedPrNumbers: [],
    linkedArtifacts: [],
  };
}

function refreshableSource(): BranchesDataSource & {
  listSpy: ReturnType<typeof vi.fn>;
  detailSpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn((_filters: BranchQueryFilters) =>
    Promise.resolve(makeListResponse())
  );
  const detailSpy = vi.fn((id: string) => Promise.resolve(makeDetail(id)));
  return {
    scope: "local",
    list: listSpy,
    detail: detailSpy,
    comments: vi.fn(() =>
      Promise.reject(new Error("comments are not used in this test"))
    ),
    trace: vi.fn(() => Promise.resolve([])),
    usage: vi.fn(() =>
      Promise.reject(new Error("usage is not used in this test"))
    ),
    analytics: vi.fn(() =>
      Promise.reject(new Error("analytics is not used in this test"))
    ),
    listSpy,
    detailSpy,
  };
}

function ForceRefreshProbe() {
  const list = useBranches({ owner: "alice" });
  const detail = useBranchDetail(TEST_BRANCH_ID);
  const { refresh } = useOverlayRefresh();
  return (
    <button onClick={refresh} type="button">
      {list.isSuccess && detail.isSuccess ? "refresh" : "loading"}
    </button>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useOverlayRefresh", () => {
  it("refresh() invalidates overlays, persisted branches, and PR comments keys", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useOverlayRefresh(), {
      wrapper: wrapper(client),
    });

    act(() => result.current.refresh());

    const keys = invalidatedKeys(spy);
    expect(keys).toContain(JSON.stringify(branchesOverlayKeys.all()));
    expect(keys).toContain(JSON.stringify(branchesKeys.lists()));
    expect(keys).toContain(JSON.stringify(branchesKeys.details()));
    expect(keys).toContain(JSON.stringify(branchesKeys.commentsRoot()));
  });

  it("passes forceRefresh to active persisted list and detail reads", async () => {
    const source = refreshableSource();
    render(
      <AppCoreStoryProviders>
        <BranchesDataSourceProvider dataSource={source}>
          <ForceRefreshProbe />
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    const button = await screen.findByRole("button", { name: "refresh" });
    expect(source.listSpy).toHaveBeenLastCalledWith({ owner: "alice" });
    expect(source.detailSpy).toHaveBeenLastCalledWith(TEST_BRANCH_ID);

    act(() => {
      button.click();
    });

    await waitFor(() =>
      expect(source.listSpy).toHaveBeenCalledWith({
        owner: "alice",
        forceRefresh: true,
      })
    );
    await waitFor(() =>
      expect(source.detailSpy).toHaveBeenCalledWith(TEST_BRANCH_ID, {
        forceRefresh: true,
      })
    );
  });

  it("reports isChecking false when no overlay query is in flight", () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useOverlayRefresh(), {
      wrapper: wrapper(client),
    });
    expect(result.current.isChecking).toBe(false);
  });
});

describe("BranchesOverlayRefreshProvider", () => {
  it("refreshes the overlays on a window focus event", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <BranchesOverlayRefreshProvider>
          <div />
        </BranchesOverlayRefreshProvider>
      </QueryClientProvider>
    );
    spy.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(invalidatedKeys(spy)).toContain(
        JSON.stringify(branchesOverlayKeys.all())
      )
    );
  });

  it("refreshes the overlays when the injected enrichment signal fires", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    let fire: (() => void) | null = null;
    const signal: OverlayRefreshSignal = {
      subscribe: (onSignal) => {
        fire = onSignal;
        return () => {
          fire = null;
        };
      },
    };
    render(
      <QueryClientProvider client={client}>
        <BranchesOverlayRefreshProvider signal={signal}>
          <div />
        </BranchesOverlayRefreshProvider>
      </QueryClientProvider>
    );
    spy.mockClear();
    expect(fire).not.toBeNull();

    act(() => {
      fire?.();
    });

    await waitFor(() =>
      expect(invalidatedKeys(spy)).toContain(
        JSON.stringify(branchesOverlayKeys.all())
      )
    );
  });
});
