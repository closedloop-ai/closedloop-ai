import { GitHubBackfillMode } from "@repo/api/src/types/github";
import { ApiError } from "@repo/app/shared/api/api-error";
import { LONG_RUNNING_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import { SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen, waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BranchDetailRoutePage from "../page";

const {
  apiPostMock,
  branchDetailPageMock,
  headerMock,
  routeParamsMock,
  searchParamsMock,
  useBranchAnalyticsMock,
  useBranchDetailMock,
  featureFlagEnabledMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  branchDetailPageMock: vi.fn(),
  headerMock: vi.fn(),
  routeParamsMock: vi.fn(),
  searchParamsMock: vi.fn(),
  useBranchAnalyticsMock: vi.fn(),
  useBranchDetailMock: vi.fn(),
  featureFlagEnabledMock: vi.fn(),
}));

const { invalidateQueriesMock } = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn(),
}));
const REFRESH_BUTTON_NAME_PATTERN = /refresh/i;
vi.mock("@repo/app/branches/components/branch-detail-page", () => ({
  BranchDetailErrorKind: {
    NotPresent: "not-present",
    ProviderError: "provider-error",
  },
  BranchDetailPage: branchDetailPageMock,
  BranchDetailRefreshState: {
    Idle: "idle",
    Pending: "pending",
    Success: "success",
    Error: "error",
  },
  classifyBranchDetailError: (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "isNotFound" in error &&
    typeof error.isNotFound === "function" &&
    error.isNotFound()
      ? "not-present"
      : "provider-error",
  resolveBranchDetailTab: (raw: string | null | undefined) =>
    raw === "branch-details" || raw === "sessions-timeline" ? raw : undefined,
}));

vi.mock("@repo/app/branches/hooks/use-branches", () => ({
  branchesKeys: {
    all: ["branches"],
    analyticsRoot: () => ["branches", "analytics"],
    commentsRoot: () => ["branches", "comments"],
    details: () => ["branches", "detail"],
    traces: () => ["branches", "trace"],
  },
  useBranchAnalytics: useBranchAnalyticsMock,
  useBranchDetail: useBranchDetailMock,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  // Stable identity, matching production: the real `useQueryClient` returns the
  // one client held in context, and this page's backfill effect lists
  // `queryClient` in its deps. A fresh object per render would re-run that
  // effect on every render and make invalidation call counts nondeterministic.
  const queryClient = { invalidateQueries: invalidateQueriesMock };
  return {
    ...actual,
    useQueryClient: () => queryClient,
  };
});

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

// Stable identity, matching production's `useMemo`d client — see the
// `useQueryClient` mock above for why the effect deps must not churn.
vi.mock("@repo/app/shared/api/use-api-client", () => {
  const client = { post: apiPostMock };
  return { useApiClient: () => client };
});

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  githubKeys: { all: ["github"] },
}));

// ISS-5574: this page test renders without a FeatureFlagAdapterProvider, so stub
// the flag hook. Default-off; a hoisted `vi.fn()` so a test can opt a flag on.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (flag: string) => featureFlagEnabledMock(flag),
  useFeatureFlagEnabledOptional: (flag: string) => featureFlagEnabledMock(flag),
}));

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: routeParamsMock,
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

describe("BranchDetailRoutePage", () => {
  beforeEach(() => {
    branchDetailPageMock.mockReset();
    apiPostMock.mockReset();
    headerMock.mockReset();
    routeParamsMock.mockReset();
    searchParamsMock.mockReset();
    useBranchAnalyticsMock.mockReset();
    useBranchDetailMock.mockReset();
    featureFlagEnabledMock.mockReset();
    routeParamsMock.mockReturnValue({ branchId: "branch-1" });
    headerMock.mockImplementation(({ children }: { children: ReactNode }) =>
      React.createElement("div", { "data-testid": "header" }, children)
    );
    branchDetailPageMock.mockReturnValue(
      React.createElement("div", { "data-testid": "branch-detail" })
    );
    useBranchDetailMock.mockReturnValue({
      data: { branchName: "feature/web-branches" },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    });
    useBranchAnalyticsMock.mockReturnValue({ data: { activeBranchCount: {} } });
    apiPostMock.mockResolvedValue({});
    searchParamsMock.mockReturnValue(new URLSearchParams());
  });

  // FEA-4155: the branch-detail route no longer gates its body behind the
  // `branches-nav` flag (the P0 blank-render root cause — a real false blanked
  // it). It renders the shared body directly; regression-guard that no flag gate
  // wraps it.
  // ISS-5574: every Sessions/Branches page reported the app-wide "Closedloop.ai",
  // so several open tabs were indistinguishable. Asserts the REAL document.title
  // per record state, and that the flag-off default is untouched.
  it("names the browser tab after the branch, behind the flag", () => {
    const previousTitle = document.title;
    document.title = "Closedloop.ai";
    try {
      const flaggedOff = render(<BranchDetailRoutePage />);
      expect(document.title).toBe("Closedloop.ai");
      flaggedOff.unmount();

      featureFlagEnabledMock.mockImplementation(
        (flag: string) => flag === SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY
      );
      const named = render(<BranchDetailRoutePage />);
      expect(document.title).toBe("feature/web-branches | Closedloop.ai");
      named.unmount();

      // Unresolved read: name the KIND of page, never a placeholder that would
      // read as the branch's name.
      useBranchDetailMock.mockReturnValue({
        data: undefined,
        error: null,
        isError: false,
        isFetching: false,
        isLoading: true,
      });
      render(<BranchDetailRoutePage />);
      expect(document.title).toBe("Branch | Closedloop.ai");
    } finally {
      document.title = previousTitle;
    }
  });

  it("renders the shared detail body directly with no feature-flag gate (FEA-4155)", () => {
    render(<BranchDetailRoutePage />);

    expect(
      screen.getByTestId("branch-detail").closest("[data-feature-flag]")
    ).toBeNull();
    expect(useBranchDetailMock).toHaveBeenCalledWith(
      "branch-1",
      expect.objectContaining({
        refetchOnWindowFocus: true,
        staleTime: 30_000,
      }),
      { cacheScope: "org:acme" }
    );
    expect(useBranchAnalyticsMock).toHaveBeenCalledTimes(1);
    expect(useBranchAnalyticsMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        refetchOnWindowFocus: true,
        staleTime: 30_000,
      }),
      { cacheScope: "org:acme" }
    );
    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        breadcrumbs: [
          { label: "Branches", href: "/acme/branches" },
          { label: "feature/web-branches" },
        ],
        suppressPageHeading: true,
      }),
      undefined
    );
    expect(branchDetailPageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backHref: "/acme/branches",
        branchId: "branch-1",
        errorKind: "provider-error",
        isError: false,
        isLoading: false,
        queryIdentity: { cacheScope: "org:acme" },
        refreshState: "idle",
      }),
      undefined
    );
  });

  it("points Back at the sessions list when arriving via a session cross-link (?from=session, FEA-4262)", () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("from=session"));

    render(<BranchDetailRoutePage />);

    expect(branchDetailPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ backHref: "/acme/sessions" }),
      undefined
    );
  });

  it("falls back to the static Branches list when no referrer is present (FEA-4262)", () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("from=bogus"));

    render(<BranchDetailRoutePage />);

    expect(branchDetailPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ backHref: "/acme/branches" }),
      undefined
    );
  });

  it("forwards a ?tab= deep-link as initialTab so a mention lands on the trace tab (FEA-3490)", () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams("tab=sessions-timeline")
    );

    render(<BranchDetailRoutePage />);

    expect(branchDetailPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialTab: "sessions-timeline" }),
      undefined
    );
  });

  it("ignores an unrecognized ?tab= value (falls back to the default tab)", () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("tab=bogus"));

    render(<BranchDetailRoutePage />);

    expect(branchDetailPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialTab: undefined }),
      undefined
    );
  });

  it("coerces an invalid route id to the disabled hook id", () => {
    routeParamsMock.mockReturnValue({ branchId: ["bad"] });

    render(<BranchDetailRoutePage />);

    expect(useBranchDetailMock).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ staleTime: 30_000 }),
      { cacheScope: "org:acme" }
    );
    expect(branchDetailPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: "" }),
      undefined
    );
  });

  it("classifies a 404 detail failure as not-present", () => {
    useBranchDetailMock.mockReturnValue({
      data: undefined,
      error: new ApiError("Missing branch", 404),
      isError: true,
      isFetching: false,
      isLoading: false,
    });

    render(<BranchDetailRoutePage />);

    expect(branchDetailPageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "not-present",
        isError: true,
      }),
      undefined
    );
  });

  it("does not render the removed manual Refresh action", () => {
    render(<BranchDetailRoutePage />);

    expect(
      screen.queryByRole("button", { name: REFRESH_BUTTON_NAME_PATTERN })
    ).toBeNull();
  });

  // FEA-4292: the route injects the `getArtifactHref` seam so "What was
  // delivered" links each recognized Closedloop artifact to its canonical,
  // ORG-SCOPED record. Capture the forwarded callback and exercise it directly —
  // if the injection or forwarding line is removed, this fails (it does not just
  // assert the prop exists, it asserts the resolved href for a real slug).
  it("forwards an org-scoped getArtifactHref that resolves recognized slugs to their canonical route (FEA-4292)", () => {
    render(<BranchDetailRoutePage />);

    const props = branchDetailPageMock.mock.calls.at(-1)?.[0] as {
      getArtifactHref?: (slug: string) => string | null;
    };
    expect(props.getArtifactHref).toBeInstanceOf(Function);
    // A recognized, typed slug → absolute org-scoped canonical route. Case is
    // normalized (a lowercase branch-name slug must not 404 against the stored
    // canonical row).
    expect(props.getArtifactHref?.("FEA-3595")).toBe("/acme/issues/FEA-3595");
    expect(props.getArtifactHref?.("fea-1952")).toBe("/acme/issues/FEA-1952");
    expect(props.getArtifactHref?.("PLN-988")).toBe(
      "/acme/implementation-plans/PLN-988"
    );
    // A non-navigable/untyped slug → null, so that row renders as a plain label.
    expect(props.getArtifactHref?.("WRK-12")).toBeNull();
    expect(props.getArtifactHref?.("not-a-slug")).toBeNull();
  });

  it("starts backfill and invalidates detail after a connected return", async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("github=connected"));

    render(<BranchDetailRoutePage />);

    expect(
      screen.getByText("GitHub is connected. Branch data is refreshing.")
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        "/integrations/github/backfill",
        { mode: GitHubBackfillMode.Apply },
        // ISS-5013: Apply mode runs the backfill synchronously, so it opts out
        // of the default client deadline with an explicit longer one.
        { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
      )
    );
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["github"],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["branches"],
    });
  });

  // ISS-5013 (thadeusb): the abandon path the `.finally()` was added for. The
  // effect invalidates `branchesKeys.all` eagerly BEFORE the POST, so only the
  // SECOND branches invalidation proves the settle path fired — a bare
  // `toHaveBeenCalledWith` cannot tell `.finally()` from `.then()`. An abandoned
  // Apply-mode run can still have written rows, and a stale population would
  // then assert "nothing here" about data that exists.
  it("invalidates branches even when the backfill is abandoned at the deadline", async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("github=connected"));
    apiPostMock.mockRejectedValue(new Error("timed out"));
    // `invalidateQueriesMock` is hoisted and not reset in `beforeEach`, so clear
    // the calls this assertion counts.
    invalidateQueriesMock.mockClear();

    render(<BranchDetailRoutePage />);

    await waitFor(() =>
      expect(
        invalidateQueriesMock.mock.calls.filter(
          ([arg]) => arg?.queryKey?.[0] === "branches"
        )
      ).toHaveLength(2)
    );
  });
});
