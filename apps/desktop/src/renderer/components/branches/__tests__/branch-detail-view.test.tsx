import {
  BranchCloudHydrationStatus,
  BranchCommentsState,
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import {
  BranchSelectedPullRequestChecksAvailability,
  BranchSelectedPullRequestChecksSummary,
} from "@repo/api/src/types/branch-selected-pull-request-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
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
import { createDesktopNavigation } from "../../../navigation/desktop-adapter";
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
const SIGN_IN_TO_SYNC_MESSAGE_PATTERN =
  /sign in to closedloop desktop to sync github data/i;
const OPEN_DIFF_BUTTON_NAME_PATTERN = /Open diff for/;
const PENDING_FILE_LIST_PATTERN =
  /File evidence is unavailable for pull request #\d+/i;
// FEA-4259: the Sessions tab trigger label ("Sessions & timeline").
const SESSIONS_TAB_NAME_PATTERN = /sessions & timeline/i;

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
    prState: GitHubPRState.Open,
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
    associatedPullRequests: {
      items: [selectedPullRequest()],
      selectedId: "owner/repo#42",
      selectionReason: BranchAssociatedPullRequestSelectionReason.Active,
      completeness: {
        state: BranchAssociatedPullRequestCompletenessState.Complete,
        reasons: [],
        provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
      },
    },
    selectedPullRequest: {
      ...selectedPullRequest(),
      body: "Body",
      reviewDecision: overrides.reviewDecision ?? null,
      headRefOid: "a".repeat(40),
      mergeCommitSha: null,
      changedFiles: null,
      additions: null,
      deletions: null,
    },
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
        ownerUserName: "Session one owner",
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

function renderView(initialPath = "/branches/b-1") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const flagAdapter = createStaticFeatureFlagAdapter({ enabledFlags: [] });
  const navigation = createMemoryNavigation({ initialPath });
  const result = render(
    <NavigationProvider adapter={navigation.adapter}>
      <QueryClientProvider client={queryClient}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <ApiAdapterProvider adapter={inertApiAdapter}>
            <FeatureFlagAdapterProvider adapter={flagAdapter}>
              <BranchDetailView
                backHref="/branches"
                backLabel={BranchBackLabel.Branches}
                branchId="b-1"
              />
            </FeatureFlagAdapterProvider>
          </ApiAdapterProvider>
        </AuthAdapterProvider>
      </QueryClientProvider>
    </NavigationProvider>
  );
  return { ...result, navigation, queryClient };
}

function renderDesktopAdapterView() {
  const setHash = vi.fn();
  const navigation = createDesktopNavigation({
    getHash: () => "#/branches/b-1",
    onHashChange: () => () => undefined,
    setHash,
  });
  setHash.mockClear();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  render(
    <NavigationProvider adapter={navigation.adapter}>
      <QueryClientProvider client={queryClient}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <ApiAdapterProvider adapter={inertApiAdapter}>
            <FeatureFlagAdapterProvider
              adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
            >
              <BranchDetailView
                backHref="/branches"
                backLabel={BranchBackLabel.Branches}
                branchId="b-1"
              />
            </FeatureFlagAdapterProvider>
          </ApiAdapterProvider>
        </AuthAdapterProvider>
      </QueryClientProvider>
    </NavigationProvider>
  );
  return { navigation, setHash };
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

  it("links delivered artifacts through the authenticated desktop web origin", async () => {
    installDesktopApi(() =>
      Promise.resolve(makeDetail({ linkedArtifacts: [{ slug: "FEA-3595" }] }))
    );
    Object.assign(window.desktopApi, {
      getDesktopIdentity: vi.fn(() =>
        Promise.resolve({
          email: "ada@example.com",
          firstName: "Ada",
          lastName: "Lovelace",
          organizationId: "org-1",
          organizationName: "Acme",
          organizationSlug: "acme",
          userId: "user-1",
        })
      ),
      getSettings: vi.fn(() =>
        Promise.resolve({ webAppOrigin: "https://app.closedloop.test" })
      ),
    });

    const { navigation, setHash } = renderDesktopAdapterView();

    const link = await screen.findByRole("link", { name: "Issue FEA-3595" });
    expect(link.getAttribute("href")).toBe(
      "https://app.closedloop.test/acme/issues/FEA-3595"
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    fireEvent.click(link);
    expect(setHash).not.toHaveBeenCalled();
    navigation.dispose();
  });

  it("honors a ?tab=sessions-timeline deep-link and opens the Sessions tab (FEA-4259)", async () => {
    // The Linked Sessions count on the branches list links here with
    // `?tab=sessions-timeline`; the desktop view must seed that as the initial
    // tab (mirroring the web route) instead of the default Branch details tab.
    installDesktopApi(() => Promise.resolve(makeDetail()));
    renderView("/branches/b-1?tab=sessions-timeline");

    const sessionsTab = await screen.findByRole("tab", {
      name: SESSIONS_TAB_NAME_PATTERN,
    });
    expect(sessionsTab.getAttribute("aria-selected")).toBe("true");
    expect(
      screen
        .getByRole("tab", { name: "Branch details" })
        .getAttribute("aria-selected")
    ).toBe("false");
  });

  it("syncs the tab when the ?tab= deep-link changes on a same-branch navigation after mount (FEA-4259)", async () => {
    // Unlike the web App-Router page (which remounts per navigation), the
    // desktop AppShell keeps this view mounted while only the branch-detail
    // query changes (the mounted branchId derives from the path, not the
    // query). `BranchDetailPage` seeds `activeTab` from `initialTab` once, so
    // without the tab-keyed remount a same-branch nav to
    // `?tab=sessions-timeline` — and the clear back to no query — would leave
    // the previously-selected tab on screen. This is wongk's review case: drive
    // the store through `navigate` (no remount by the test) and assert the tab
    // follows the query in both directions.
    installDesktopApi(() => Promise.resolve(makeDetail()));
    const { navigation } = renderView("/branches/b-1");

    // Lands on the default Branch details tab.
    const branchDetailsTab = await screen.findByRole("tab", {
      name: "Branch details",
    });
    expect(branchDetailsTab.getAttribute("aria-selected")).toBe("true");

    // Same-branch navigation to the Sessions deep-link: the mounted view must
    // follow the query and select the Sessions tab.
    navigation.navigate("/branches/b-1?tab=sessions-timeline");
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: SESSIONS_TAB_NAME_PATTERN })
          .getAttribute("aria-selected")
      ).toBe("true")
    );
    expect(
      screen
        .getByRole("tab", { name: "Branch details" })
        .getAttribute("aria-selected")
    ).toBe("false");

    // Clearing the query back to the bare branch path must restore the default
    // Branch details tab, not leave Sessions selected.
    navigation.navigate("/branches/b-1");
    await waitFor(() =>
      expect(
        screen
          .getByRole("tab", { name: "Branch details" })
          .getAttribute("aria-selected")
      ).toBe("true")
    );
    expect(
      screen
        .getByRole("tab", { name: SESSIONS_TAB_NAME_PATTERN })
        .getAttribute("aria-selected")
    ).toBe("false");
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
      .find((candidate) => candidate.state.data !== undefined);
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
          selectedPullRequestChecks: successfulChecks(),
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
          repositoryFullName: "owner/repo",
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

  // PLN-1535 M3.2 — the plan's "UX honesty fix". A repo-linked branch whose
  // hydration reports CredentialMissing means this Desktop holds no cloud
  // credential; the old code rendered that as NotConnected and offered a
  // Connect-GitHub CTA that could never resolve it. Both halves are asserted:
  // the honest sign-in copy appears AND the misleading CTA does not.
  it("asks a credential-less desktop to sign in, not to connect GitHub", async () => {
    installDesktopApi(() =>
      Promise.resolve(
        makeDetail({
          cloudHydrationStatus: BranchCloudHydrationStatus.CredentialMissing,
        })
      )
    );

    renderView();

    expect(
      await screen.findByText(SIGN_IN_TO_SYNC_MESSAGE_PATTERN)
    ).toBeDefined();
    expect(await screen.findByText("Branch details")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: CONNECT_GITHUB_BUTTON_NAME_PATTERN })
    ).toBeNull();
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

    fireEvent.click(
      await screen.findByRole("button", { name: "Show comments rail" })
    );
    expect(
      await screen.findByText("Comments are unavailable in this view.")
    ).toBeDefined();
  });

  it("does not mount local gateway live file overlays on desktop detail", async () => {
    installDesktopApi(() => Promise.resolve(makeDetail()));

    renderView();

    // PLN-1535 M5.3 replaced the "Live file overlays unavailable" block with the
    // files panel itself, which states that the per-file list is not available
    // on this screen yet (ISS-4473) and renders no file rows or diff triggers.
    expect(await screen.findByText(FILES_CHANGED_PATTERN)).toBeDefined();
    expect(await screen.findByText(PENDING_FILE_LIST_PATTERN)).toBeDefined();
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

const FILES_CHANGED_PATTERN = /^Files changed$/i;

function successfulChecks(): BranchPageDetail["selectedPullRequestChecks"] {
  return {
    status: BranchSelectedPullRequestChecksAvailability.Available,
    value: {
      identity: {
        githubId: "42",
        repositoryFullName: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      },
      revision: { headSha: "a".repeat(40) },
      checks: [],
      counts: {
        providerExpected: 3,
        providerReturned: 3,
        normalizedAttempts: 3,
        emitted: 3,
        total: 3,
        successful: 3,
        failing: 0,
        pending: 0,
        neutral: 0,
      },
      pagination: {
        pageSize: 100,
        pagesFetched: 1,
        acquisitionMaximum: 1000,
        reachedAcquisitionMaximum: false,
      },
      history: {
        mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
        providerLimit: null,
        rawAttempts: 3,
        emittedSources: 3,
      },
      coverage: {
        completeness: SelectedPullRequestChecksCompleteness.Complete,
        reasons: [],
      },
      summary: BranchSelectedPullRequestChecksSummary.Successful,
    },
  };
}

function selectedPullRequest() {
  return {
    id: "owner/repo#42",
    repositoryFullName: "owner/repo",
    number: 42,
    title: "Add x",
    url: "https://github.com/owner/repo/pull/42",
    state: GitHubPRState.Open,
    isDraft: false,
    reviewDecision: null,
    openedAt: null,
    closedAt: null,
    mergedAt: null,
  };
}
