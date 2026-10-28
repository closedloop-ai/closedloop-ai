import { GitHubBackfillMode } from "@repo/api/src/types/github";
import { RelatedSessionsSection } from "@repo/app/documents/components/related-sessions-section";
import { ApiError } from "@repo/app/shared/api/api-error";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import {
  ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY,
  SESSIONS_BRANCHES_TAB_TITLES_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { render, screen, waitFor } from "@testing-library/react";
import React, {
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetPostConnectBackfillClaims } from "@/lib/github-post-connect-backfill";
import BranchDetailRoutePage from "../page";

const {
  apiPostMock,
  branchDetailPageMock,
  headerMock,
  orgSlugMock,
  routeParamsMock,
  searchParamsMock,
  useBranchDetailMock,
  featureFlagEnabledMock,
} = vi.hoisted(() => ({
  apiPostMock: vi.fn(),
  branchDetailPageMock: vi.fn(),
  headerMock: vi.fn(),
  orgSlugMock: vi.fn(),
  routeParamsMock: vi.fn(),
  searchParamsMock: vi.fn(),
  useBranchDetailMock: vi.fn(),
  featureFlagEnabledMock: vi.fn(),
}));

const { invalidateQueriesMock, shellTab } = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn(),
  shellTab: { value: "artifact" },
}));
const REFRESH_BUTTON_NAME_PATTERN = /refresh/i;
const COMMENTS_TOGGLE = /^(Show|Hide) comments rail$/;
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
    // ISS-7408: the backfill status poll belongs to the hook's own suite
    // (packages/app/github/hooks/__tests__). Stubbing it keeps these renders
    // provider-free — the real `useQuery` reaches for a QueryClient in context
    // that this suite deliberately does not mount.
    useQuery: () => ({ data: undefined, dataUpdatedAt: 0 }),
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
  // ISS-7408: `usePostConnectBackfill` reads `backfill()` on every render, so a
  // stub without it throws before any assertion in this file runs.
  githubKeys: { all: ["github"], backfill: () => ["github", "backfill"] },
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

vi.mock("@repo/app/branches/components/branch-shell-view", () => ({
  BranchShellView: () => null,
}));
vi.mock(
  "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route",
  () => ({
    useArtifactDetailTabRoute: () => ({ activeTab: shellTab.value }),
  })
);

// Mutable, not pinned: the post-connect backfill claim is keyed BY org slug, so
// a fixed slug would let a document-global boolean pass the remount case below
// while still suppressing a second org's backfill.
vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: orgSlugMock,
}));

describe("BranchDetailRoutePage", () => {
  beforeEach(() => {
    // ISS-7338: the post-connect backfill claim lives in module scope so it can
    // survive a remount, which means it also survives a test. Without this the
    // second connected-return case in this file would see the first one's claim.
    resetPostConnectBackfillClaims();
    branchDetailPageMock.mockReset();
    apiPostMock.mockReset();
    orgSlugMock.mockReset();
    orgSlugMock.mockReturnValue("acme");
    headerMock.mockReset();
    routeParamsMock.mockReset();
    searchParamsMock.mockReset();
    useBranchDetailMock.mockReset();
    featureFlagEnabledMock.mockReset();
    globalThis.localStorage.clear();
    shellTab.value = ArtifactDetailTab.Artifact;
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
  /**
   * ISS-10980: the Branch Activity tab's comment rows link with `?comment=`.
   * This shell owns the URL, so it is what reads the param and forwards it;
   * the no-address case is load-bearing, since a hard-coded id would pass the
   * first one alone.
   */
  it("forwards the comment the URL addresses", () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("comment=thread-7"));

    render(<BranchDetailRoutePage />);

    expect(lastBranchDetailProps()).toEqual(
      expect.objectContaining({ selectedThreadId: "thread-7" })
    );
  });

  it("forwards no addressed comment when the URL names none", () => {
    render(<BranchDetailRoutePage />);

    expect(lastBranchDetailProps()).toEqual(
      expect.objectContaining({ selectedThreadId: null })
    );
  });

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
    expect(useBranchDetailMock).toHaveBeenCalledWith("branch-1", undefined, {
      cacheScope: "org:acme",
    });
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

    expect(useBranchDetailMock).toHaveBeenCalledWith("", undefined, {
      cacheScope: "org:acme",
    });
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

  it.each([
    [ArtifactDetailTab.Artifact, 1],
    [ArtifactDetailTab.Sessions, 1],
    [ArtifactDetailTab.Details, 0],
  ])(
    "with the shell on, shows the header's comments button on the %s tab %i time(s) (ISS-12300 D3)",
    (tab, count) => {
      featureFlagEnabledMock.mockImplementation(
        (key: string) => key === ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY
      );
      shellTab.value = tab;
      render(<BranchDetailRoutePage />);

      expect(
        screen.queryAllByRole("button", { name: COMMENTS_TOGGLE })
      ).toHaveLength(count);
    }
  );

  it("with the shell off, keeps the legacy header button on every tab", () => {
    shellTab.value = ArtifactDetailTab.Details;
    render(<BranchDetailRoutePage />);

    expect(
      screen.getByRole("button", { name: COMMENTS_TOGGLE })
    ).toBeInTheDocument();
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

    const props = lastBranchDetailProps() as {
      getArtifactHref?: (slug: string) => string | null;
    };
    expect(props.getArtifactHref).toBeInstanceOf(Function);
    // A recognized, typed slug → absolute org-scoped canonical route. Case is
    // normalized (a lowercase branch-name slug must not 404 against the stored
    // canonical row).
    expect(props.getArtifactHref?.("FEA-3595")).toBe(
      "/acme/documents/FEA-3595"
    );
    expect(props.getArtifactHref?.("fea-1952")).toBe(
      "/acme/documents/FEA-1952"
    );
    expect(props.getArtifactHref?.("PLN-988")).toBe("/acme/documents/PLN-988");
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
    searchParamsMock.mockReturnValue(new URLSearchParams("github=connected"));
    const backfillCalls = () =>
      apiPostMock.mock.calls.filter(
        ([path]) => path === "/integrations/github/backfill"
      );

    const { unmount } = render(<BranchDetailRoutePage />);
    await waitFor(() => expect(backfillCalls()).toHaveLength(1));
    unmount();
    invalidateQueriesMock.mockClear();

    render(<BranchDetailRoutePage />);

    await waitFor(() =>
      expect(
        invalidateQueriesMock.mock.calls.filter(
          ([arg]) => arg?.queryKey?.[0] === "github"
        )
      ).toHaveLength(1)
    );
    expect(backfillCalls()).toHaveLength(1);
  });

  // ISS-7338 (whitlockk): the keyed half, asserted on THIS route as well as the
  // list. Both routes claim, and a test proving the list passes its own org
  // slug says nothing about whether this one does — a hardcoded slug here would
  // be invisible to that suite. Returning to `acme` at the end is what rules out
  // a single-slot latch, which would let `globex` through and still block an
  // `acme` remount.
  it("claims per org: a second org fires, and a return to the first does not", async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("github=connected"));
    const backfillCalls = () =>
      apiPostMock.mock.calls.filter(
        ([path]) => path === "/integrations/github/backfill"
      );
    const githubInvalidations = () =>
      invalidateQueriesMock.mock.calls.filter(
        ([arg]) => arg?.queryKey?.[0] === "github"
      );

    const acme = render(<BranchDetailRoutePage />);
    await waitFor(() => expect(backfillCalls()).toHaveLength(1));
    acme.unmount();
    invalidateQueriesMock.mockClear();

    orgSlugMock.mockReturnValue("globex");
    const globex = render(<BranchDetailRoutePage />);
    await waitFor(() => expect(githubInvalidations()).toHaveLength(1));
    await waitFor(() => expect(backfillCalls()).toHaveLength(2));
    globex.unmount();
    invalidateQueriesMock.mockClear();

    orgSlugMock.mockReturnValue("acme");
    render(<BranchDetailRoutePage />);

    await waitFor(() => expect(githubInvalidations()).toHaveLength(1));
    expect(backfillCalls()).toHaveLength(2);
  });

  // ISS-5013 (tamsinb): the abandon path the `.finally()` was added for. The
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

  // ISS-7235 AC1: BRANCH is a non-Session artifact type, so it inherits the
  // read-only Related Sessions field. The web shell injects it as a NODE rather
  // than `BranchDetailPage` mounting it, because that component also renders in
  // the packaged desktop renderer and `related-sessions-field` has no Labs
  // registration — so the route, not the shared component, is where this wiring
  // can be proven.
  //
  // What the route actually decides is WHICH artifact the node addresses, and
  // the only correct answer is the branch's canonical `artifactId`. `branchId`
  // is frequently `encodeBranchId(repo, name)` rather than a UUID, and the
  // provenance route addresses artifacts — so threading `branchId` here would
  // ask the server about an id that is not an artifact at all.
  it("injects Related Sessions addressed by the branch's canonical artifactId (ISS-7235 AC1)", () => {
    useBranchDetailMock.mockReturnValue({
      data: {
        branchName: "feature/web-branches",
        artifactId: "01a01b91-2d88-755a-9864-39e82e304b20",
      },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    });

    render(<BranchDetailRoutePage />);

    const { relatedSessionsSlot } = lastBranchDetailProps() as {
      relatedSessionsSlot?: unknown;
    };
    expect(isValidElement(relatedSessionsSlot)).toBe(true);
    const slot = relatedSessionsSlot as ReactElement<{ artifactId: string }>;
    expect(slot.type).toBe(RelatedSessionsSection);
    expect(slot.props.artifactId).toBe("01a01b91-2d88-755a-9864-39e82e304b20");
    // The encoded route id must never stand in for the artifact id.
    expect(slot.props.artifactId).not.toBe("branch-1");
  });

  // The negative half of the contract above, and it only means something beside
  // that positive sibling: `artifactId` is optional on `BranchRow` — a local or
  // legacy producer omits it. With no artifact to ask about, the field is ABSENT
  // rather than empty. "We cannot ask" and "nothing has contributed" are
  // different facts, and only absence asserts neither of them.
  it("omits Related Sessions when the branch projection carries no artifactId", () => {
    render(<BranchDetailRoutePage />);

    const { relatedSessionsSlot } = lastBranchDetailProps() as {
      relatedSessionsSlot?: unknown;
    };
    expect(relatedSessionsSlot).toBeUndefined();
  });
});

/**
 * The props `BranchDetailPage` was last rendered with. The presence check names
 * a render that never happened, rather than surfacing it as a property access
 * on undefined at whichever assertion got there first.
 */
function lastBranchDetailProps(): unknown {
  const call = branchDetailPageMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("BranchDetailPage was never rendered");
  }
  return call[0];
}
