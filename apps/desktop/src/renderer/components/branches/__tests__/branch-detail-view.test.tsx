import {
  BranchCloudHydrationStatus,
  BranchCommentsState,
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BranchDetailView } from "../branch-detail-view";

const { beginSignInMock, openGitHubConnectMock, useDesktopAuthMock } =
  vi.hoisted(() => ({
    beginSignInMock: vi.fn(),
    openGitHubConnectMock: vi.fn(),
    useDesktopAuthMock: vi.fn(),
  }));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));

const inertApiAdapter: ApiAdapter = {
  resolveApiOrigin: () => "http://test.local",
  fetch: () => Promise.reject(new Error("no remote REST API in tests")),
};
const CONNECT_GITHUB_BUTTON_NAME_PATTERN = /connect github/i;
const DETAIL_CONNECT_OPENED_MESSAGE_PATTERN = /branch details refresh/i;
const DETAIL_CONNECT_FAILED_MESSAGE_PATTERN =
  /github connect could not be opened/i;
const CLOUD_REFRESH_FAILED_MESSAGE_PATTERN = /github cloud refresh failed/i;
const OPEN_DIFF_BUTTON_NAME_PATTERN = /Open diff for/;

let commentsStateForTest: BranchCommentsState =
  BranchCommentsState.UnsyncedUnknown;

function makeDetail(
  overrides: Partial<BranchPageDetail> = {}
): BranchPageDetail {
  return {
    id: "b-1",
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
    prBody: "Body",
    prBodyHtmlUrl: "https://github.com/owner/repo/pull/42",
    headSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [
      {
        sessionId: "s1",
        slug: null,
        name: "Session one",
        harness: "claude",
        startedAt: "2026-06-17T10:00:00.000Z",
        endedAt: "2026-06-17T11:00:00.000Z",
        isPrimary: true,
        estimatedCostUsd: 1.23,
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
    mergedTrace: [{ type: "end", sessionId: "s1", text: "done" }],
    leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
    linkedPrNumbers: [42],
    linkedArtifacts: [],
    ...overrides,
  };
}

function installDesktopApi(detail: () => Promise<BranchPageDetail | null>): {
  detail: ReturnType<typeof vi.fn>;
} {
  const detailMock = vi.fn(detail);
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        branchId: "b-1",
        state: commentsStateForTest,
        comments: [],
        budget: {
          maxComments: 100,
          pageSize: 50,
          maxBodyBytes: 16_384,
          maxResponseBytes: 524_288,
          providerTruncated: false,
          responseTruncated: false,
          omittedComments: 0,
          bodyTruncatedCount: 0,
        },
        providerProofedAt: null,
        stale: false,
        mixedProjection: false,
        prNumber: 42,
        prUrl: "https://github.com/owner/repo/pull/42",
      }),
  } as Response);
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      branchesApi: {
        list: vi.fn(() =>
          Promise.resolve({ items: [], total: 0, viewerScope: "self" })
        ),
        detail: detailMock,
        // PLN-1148 Phase 2: trace is a required branchesApi method; stub it so a
        // test that opens the timeline tab gets an empty trace rather than a
        // swallowed TypeError on an undefined method.
        trace: vi.fn(() => Promise.resolve([])),
        usage: vi.fn(() => Promise.resolve({})),
        analytics: vi.fn(() => Promise.resolve({})),
      },
      openGitHubConnect: openGitHubConnectMock,
    },
  });
  return { detail: detailMock };
}

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const flagAdapter = createStaticFeatureFlagAdapter({ enabledFlags: [] });
  const navigation = createMemoryNavigation({ initialPath: "/branches/b-1" });
  const result = render(
    <NavigationProvider adapter={navigation.adapter}>
      <QueryClientProvider client={queryClient}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <ApiAdapterProvider adapter={inertApiAdapter}>
            <FeatureFlagAdapterProvider adapter={flagAdapter}>
              <BranchDetailView backHref="/branches" branchId="b-1" />
            </FeatureFlagAdapterProvider>
          </ApiAdapterProvider>
        </AuthAdapterProvider>
      </QueryClientProvider>
    </NavigationProvider>
  );
  return { ...result, queryClient };
}

afterEach(() => {
  commentsStateForTest = BranchCommentsState.UnsyncedUnknown;
  vi.restoreAllMocks();
});

beforeEach(() => {
  beginSignInMock.mockResolvedValue({ ok: true });
  openGitHubConnectMock.mockResolvedValue({
    ok: true,
    url: "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches%2Fb-1",
  });
  useDesktopAuthMock.mockReturnValue({
    state: {
      status: "authenticated",
      userId: "user-1",
      organizationId: "org-1",
    },
    beginSignIn: beginSignInMock,
  });
});

describe("BranchDetailView", () => {
  it("mounts the data-source ancestry and renders the populated page", async () => {
    const { detail } = installDesktopApi(() => Promise.resolve(makeDetail()));
    renderView();

    expect(
      await screen.findByRole("tab", { name: "Branch details" })
    ).toBeDefined();
    // The populated page no longer renders an in-page "Back to Branches" control
    // — the Topbar breadcrumb ("Branches / <name>") is the back affordance.
    await waitFor(() => expect(detail).toHaveBeenCalledWith("b-1"));
  });

  it("overrides desktop ambient staleTime so focus can recheck detail hydration", async () => {
    installDesktopApi(() => Promise.resolve(makeDetail()));
    const { queryClient } = renderView();

    expect(
      await screen.findByRole("tab", { name: "Branch details" })
    ).toBeDefined();

    const query = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["branches", "detail"] })
      .find((candidate) => candidate.queryKey.length > 2);
    const options = query?.options as BranchQueryFreshnessOptions | undefined;
    expect(options?.staleTime).toBe(30_000);
    expect(options?.refetchOnWindowFocus).toBe(true);
  });

  it("opens GitHub connect from the connect bar when GitHub is not connected", async () => {
    // No repo identity → the shared `connect-github` banner condition holds, so
    // the standalone connect bar is the reachable connect affordance.
    installDesktopApi(() =>
      Promise.resolve(makeDetail({ repoFullName: null }))
    );
    renderView();

    fireEvent.click(
      await screen.findByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    );

    await waitFor(() =>
      expect(openGitHubConnectMock).toHaveBeenCalledWith({
        returnTo: "/branches/b-1",
      })
    );
    expect(
      screen.getByText(DETAIL_CONNECT_OPENED_MESSAGE_PATTERN)
    ).toBeDefined();
  });

  it("shows the connect-failed banner when GitHub connect IPC rejects (FEA-2782)", async () => {
    // A rejected (not resolved-false) IPC call must still flip to the Failed
    // banner instead of leaking an unhandled rejection and pinning Pending.
    installDesktopApi(() =>
      Promise.resolve(makeDetail({ repoFullName: null }))
    );
    openGitHubConnectMock.mockRejectedValue(new Error("ipc channel closed"));
    renderView();

    fireEvent.click(
      await screen.findByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    );

    expect(
      await screen.findByText(DETAIL_CONNECT_FAILED_MESSAGE_PATTERN)
    ).toBeDefined();
  });

  it("hides the duplicate connect bar when GitHub is connected (FEA-2792)", async () => {
    // Repo identity present → GitHub is connected; the standalone top bar must
    // not duplicate the CTA the shared `BranchDetailPage` already gates.
    installDesktopApi(() => Promise.resolve(makeDetail()));
    renderView();

    // Wait for the page to populate before asserting the bar is absent.
    expect(
      await screen.findByRole("tab", { name: "Branch details" })
    ).toBeDefined();
    expect(
      screen.queryByRole("button", {
        name: CONNECT_GITHUB_BUTTON_NAME_PATTERN,
      })
    ).toBeNull();
  });

  it("renders cloud-hydrated review and checks in the visible detail panel", async () => {
    installDesktopApi(() =>
      Promise.resolve(
        makeDetail({
          checksPassed: 3,
          checksTotal: 3,
          checksStatus: ChecksStatus.Passing,
          reviewDecision: ReviewDecision.Approved,
        })
      )
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const href = String(url);
      if (href.includes("/api/gateway/git/pr/reviews?")) {
        return Promise.resolve(jsonResponse(403, { error: "not connected" }));
      }
      return Promise.resolve(
        jsonResponse(200, {
          branchId: "b-1",
          state: commentsStateForTest,
          comments: [],
          budget: {
            maxComments: 100,
            pageSize: 50,
            maxBodyBytes: 16_384,
            maxResponseBytes: 524_288,
            providerTruncated: false,
            responseTruncated: false,
            omittedComments: 0,
            bodyTruncatedCount: 0,
          },
          providerProofedAt: null,
          stale: false,
          mixedProjection: false,
          prNumber: 42,
          prUrl: "https://github.com/owner/repo/pull/42",
        })
      );
    });

    renderView();

    expect(await screen.findByText("Checks & review")).toBeDefined();
    expect(await screen.findByText("Approved")).toBeDefined();
    expect(await screen.findByText("3/3 passing")).toBeDefined();
  });

  it("surfaces failed desktop cloud hydration while keeping local detail visible", async () => {
    installDesktopApi(() =>
      Promise.resolve(
        makeDetail({
          cloudHydrationStatus: BranchCloudHydrationStatus.Failed,
          cloudHydrationFailure: "cloud_pull_failed",
        })
      )
    );

    renderView();

    expect(
      await screen.findByText(CLOUD_REFRESH_FAILED_MESSAGE_PATTERN)
    ).toBeDefined();
    expect(await screen.findByText("Branch details")).toBeDefined();
  });

  it("shows a skeleton while the detail read is pending", async () => {
    // A never-resolving detail keeps useBranchDetail in its loading state.
    installDesktopApi(() => new Promise<BranchPageDetail>(() => undefined));
    const { container } = renderView();

    await waitFor(() =>
      expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull()
    );
  });

  it("renders the not-found state for missing local branches", async () => {
    installDesktopApi(() => Promise.resolve(null));

    renderView();

    expect(await screen.findByText("Branch not found")).toBeDefined();
    expect(screen.queryByText("Branch provider unavailable")).toBeNull();
  });

  it("renders desktop comments as unsynced instead of calling the local gh gateway", async () => {
    installDesktopApi(() => Promise.resolve(makeDetail()));

    renderView();

    expect(await screen.findByText("Comments not synced")).toBeDefined();
    expect(
      screen.getByText(
        "No synced comment projection or current provider proof is available yet."
      )
    ).toBeDefined();
  });

  it("does not mount local gateway live file overlays on desktop detail", async () => {
    installDesktopApi(() => Promise.resolve(makeDetail()));

    renderView();

    expect(
      await screen.findByText("Live file overlays unavailable")
    ).toBeDefined();
    expect(screen.queryByLabelText(OPEN_DIFF_BUTTON_NAME_PATTERN)).toBeNull();
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.some(([url]) =>
          String(url).includes("/api/gateway/git/pr/")
        )
    ).toBe(false);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text),
  } as Response;
}

type BranchQueryFreshnessOptions = {
  refetchOnWindowFocus?: unknown;
  staleTime?: unknown;
};
