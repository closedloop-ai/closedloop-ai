import { GitHubBackfillMode } from "@repo/api/src/types/github";
import { screen, waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPostConnectBackfillClaims } from "@/lib/github-post-connect-backfill";
import BranchesPage from "../page";
import {
  makeBranchRow,
  makeListResponse,
  pageDataResult,
  renderBranchesPage as render,
  renderHeaderMock,
} from "./branches-page-fixtures";

/**
 * What the Branches list does when it lands on a `?github=connected` return:
 * it fires the one Apply-mode backfill and keeps the population honest around
 * it. Split out of `page.test.tsx` (ISS-7338) because that file reached the
 * 1,000-line ceiling and this is its own concern — the OAuth return, not the
 * list's rendering, filtering, or summary arithmetic.
 */

const {
  apiPostMock,
  headerMock,
  navigationReplaceMock,
  orgSlugMock,
  searchParamsMock,
  useBranchCohortAnalyticsMock,
  useBranchesPageDataMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  headerMock: vi.fn(),
  navigationReplaceMock: vi.fn(),
  orgSlugMock: vi.fn(),
  searchParamsMock: vi.fn(),
  useBranchCohortAnalyticsMock: vi.fn(),
  useBranchesPageDataMock: vi.fn(),
}));
const { cohortRefetchMock, invalidateQueriesMock } = vi.hoisted(() => ({
  cohortRefetchMock: vi.fn(),
  invalidateQueriesMock: vi.fn(),
}));

vi.mock("@repo/app/branches/hooks/use-branches", () => ({
  branchesKeys: {
    all: ["branches"],
    analyticsRoot: () => ["branches", "analytics"],
    cohortAnalyticsRoot: () => ["branches", "cohort-analytics"],
    pageDataRoot: () => ["branches", "page-data"],
  },
  useBranchCohortAnalytics: useBranchCohortAnalyticsMock,
  useBranchesPageData: useBranchesPageDataMock,
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    React.createElement("a", { href, ...props }, children),
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    back: vi.fn(),
    navigate: vi.fn(),
    refresh: vi.fn(),
    replace: navigationReplaceMock,
  }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/acme/branches",
}));

// Stable identity, matching production: the page's backfill effect lists the
// client in its deps, so a fresh object per render would re-run it every render
// and make the call counts below nondeterministic.
vi.mock("@repo/app/shared/api/use-api-client", () => {
  const client = { post: apiPostMock };
  return { useApiClient: () => client };
});

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  // ISS-7408: `usePostConnectBackfill` reads `backfill()` on every render, so a
  // stub without it throws before any assertion in this file runs.
  githubKeys: { all: ["github"], backfill: () => ["github", "backfill"] },
  // ISS-5958: the page reads the GitHub status to decide whether its gated CTA
  // says connect or reconnect. This suite is about the connected return, not the
  // CTA, so the status stays unresolved — which the resolver reports as
  // "unknown".
  useGitHubIntegrationStatus: () => ({ data: undefined, isPending: false }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  const queryClient = { invalidateQueries: invalidateQueriesMock };
  // ISS-7408: the backfill poll is covered by its hook suite; this page suite isolates its read.
  return {
    ...actual,
    useQueryClient: () => queryClient,
    useQuery: () => ({ data: undefined, dataUpdatedAt: 0 }),
  };
});

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port. Closed and ready, matching this suite's other gates.
  useFeatureFlagGateOptional: () => ({ enabled: false, isReady: true }),
  useFeatureFlagEnabled: () => false,
  useFeatureFlagEnabledOptional: () => false,
  useFeatureFlagGate: () => ({ enabled: false, isReady: true }),
}));

// Mutable, not pinned: the claim this suite guards is keyed BY org slug, so a
// fixed slug here would let a document-global boolean pass every case below
// while still suppressing a second org's backfill.
vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: orgSlugMock,
}));

function backfillCalls() {
  return apiPostMock.mock.calls.filter(
    ([path]) => path === "/integrations/github/backfill"
  );
}

function githubInvalidations() {
  return invalidateQueriesMock.mock.calls.filter(
    ([arg]) => arg?.queryKey?.[0] === "github"
  );
}

beforeEach(() => {
  // ISS-7338: the post-connect backfill claim lives in module scope so it can
  // survive a remount, which means it also survives a test. Without this the
  // second connected-return case in this file would see the first one's claim.
  resetPostConnectBackfillClaims();
  headerMock.mockReset();
  apiPostMock.mockReset();
  orgSlugMock.mockReset();
  orgSlugMock.mockReturnValue("acme");
  searchParamsMock.mockReset();
  useBranchesPageDataMock.mockReset();
  cohortRefetchMock.mockReset();
  navigationReplaceMock.mockReset();
  invalidateQueriesMock.mockReset();
  useBranchCohortAnalyticsMock.mockReset();
  useBranchCohortAnalyticsMock.mockReturnValue({
    data: null,
    isError: false,
    isPending: false,
    refetch: cohortRefetchMock,
  });
  headerMock.mockImplementation(renderHeaderMock);
  useBranchesPageDataMock.mockReturnValue(
    pageDataResult({ list: makeListResponse([makeBranchRow()]) })
  );
  apiPostMock.mockResolvedValue({});
  searchParamsMock.mockReturnValue(new URLSearchParams("github=connected"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BranchesPage GitHub connect return", () => {
  it("starts backfill and invalidates branches after a connected return", async () => {
    render(<BranchesPage />);

    expect(
      screen.getByText("GitHub is connected. Branch data is refreshing.")
    ).toBeInTheDocument();
    await waitFor(() =>
      // ISS-7408: two arguments, not three. Apply mode no longer runs the sweep
      // before responding — the route answers 202 in claim latency and the hook
      // polls the status surface — so there is no client deadline to opt out of.
      expect(apiPostMock).toHaveBeenCalledWith(
        "/integrations/github/backfill",
        { mode: GitHubBackfillMode.Apply }
      )
    );
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["github"],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ["branches"],
    });
  });

  // ISS-7338: the guard was a `useRef`, which lives in a component INSTANCE. A
  // remount builds a fresh instance with a fresh ref, so the guard reset and the
  // whole Apply-mode backfill fired a second time — duplicated server work
  // caused by a render-lifecycle accident.
  //
  // The `github` invalidation assertion is what stops this being vacuous. That
  // call runs BEFORE the claim check, so seeing it once after the remount proves
  // the remounted effect really executed and was stopped by the claim — rather
  // than the second mount never happening, or bailing at the status check, which
  // would leave the backfill count at 1 for the wrong reason.
  it("does not re-fire the backfill when the page remounts", async () => {
    const { unmount } = render(<BranchesPage />);
    await waitFor(() => expect(backfillCalls()).toHaveLength(1));
    unmount();
    invalidateQueriesMock.mockClear();

    render(<BranchesPage />);

    await waitFor(() => expect(githubInvalidations()).toHaveLength(1));
    expect(backfillCalls()).toHaveLength(1);
  });

  // ISS-7338 (whitlockk): the pair to the remount case above, and the reason the
  // claim is keyed rather than one document-global boolean. Every other case in
  // this file runs as `acme`, so a boolean latch satisfies them all and still
  // swallows the backfill for the next org the user connects.
  //
  // Returning to `acme` at the end is what makes this more than a two-org
  // smoke test. A single-slot latch (`let lastClaimedOrg`) also lets `globex`
  // through AND still blocks an `acme` remount, so it would pass a test that
  // stopped at two calls — only a claim that REMEMBERS `acme` while `globex`
  // holds one keeps the count at 2 here. The `github` invalidation runs before
  // the claim check, so asserting it each time proves the mount's effect
  // actually reached the claim instead of bailing at the status check.
  it("claims per org: a second org fires, and a return to the first does not", async () => {
    const acme = render(<BranchesPage />);
    await waitFor(() => expect(backfillCalls()).toHaveLength(1));
    acme.unmount();
    invalidateQueriesMock.mockClear();

    orgSlugMock.mockReturnValue("globex");
    const globex = render(<BranchesPage />);
    await waitFor(() => expect(githubInvalidations()).toHaveLength(1));
    await waitFor(() => expect(backfillCalls()).toHaveLength(2));
    globex.unmount();
    invalidateQueriesMock.mockClear();

    orgSlugMock.mockReturnValue("acme");
    render(<BranchesPage />);

    await waitFor(() => expect(githubInvalidations()).toHaveLength(1));
    expect(backfillCalls()).toHaveLength(2);
  });

  // ISS-5013 (tamsinb): the abandon path the `.finally()` was added for. The
  // effect invalidates `branchesKeys.all` eagerly BEFORE the POST, so a bare
  // `toHaveBeenCalledWith` cannot tell `.finally()` from `.then()` — only the
  // SECOND branches invalidation proves the settle-path fired. Before the client
  // deadline the POST hung and nothing settled, so this path did not exist; now
  // it rejects at LONG_RUNNING_API_TIMEOUT_MS with rows possibly written
  // server-side, and a success-only invalidation would leave the list asserting
  // "nothing here" about an org that has branches.
  it("invalidates branches even when the backfill is abandoned at the deadline", async () => {
    apiPostMock.mockRejectedValue(new Error("timed out"));

    render(<BranchesPage />);

    await waitFor(() =>
      expect(
        invalidateQueriesMock.mock.calls.filter(
          ([arg]) => arg?.queryKey?.[0] === "branches"
        )
      ).toHaveLength(2)
    );
    expect(
      screen.queryByText(
        "Branch refresh failed. Retry from the Refresh button."
      )
    ).not.toBeInTheDocument();
  });
});
