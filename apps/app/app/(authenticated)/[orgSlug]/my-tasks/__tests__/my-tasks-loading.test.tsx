import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useCurrentUser: vi.fn(),
  useDocumentsPage: vi.fn(),
  useUpdateDocument: vi.fn(),
  useProjects: vi.fn(),
  useAssignedArtifactTree: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
  useFeatureFlagsLoaded: vi.fn(),
  usePostHogDistinctId: vi.fn(),
  useUser: vi.fn(),
  refetchCurrentUser: vi.fn(),
  refetchAssignedArtifactTree: vi.fn(),
  useFavoriteArtifacts: vi.fn(),
  useProjectFilters: vi.fn(),
  useFilterCurrentUser: vi.fn(),
  useGroupBy: vi.fn(),
  useDeleteRowItem: vi.fn(),
  useColumnVisibility: vi.fn(),
  useOrgUsersAsPopoverUsers: vi.fn(),
  useLocalStorageState: vi.fn(),
  useViewStatePersistence: vi.fn(),
  useScrollRestore: vi.fn(),
  isDocumentRowItem: vi.fn(),
  enabledFeatureFlags: new Set<string>(),
  isFeatureFlagGateReady: true,
  apiGet: vi.fn(),
}));

// Presentational markers so the test asserts branch selection, not child guts.
vi.mock("@repo/app/documents/components/table/documents-view", () => ({
  DocumentsView: ({ isLoading }: { isLoading?: boolean }) => (
    <div
      data-loading={isLoading ? "true" : "false"}
      data-testid="documents-view"
    />
  ),
}));
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => <div data-testid="header" />,
}));
// vi.mock paths resolve relative to this test file, which sits one directory
// deeper (__tests__/) than page.tsx — so add one extra "../" to each relative
// specifier the page uses.
vi.mock("../../../components/onboarding-checklist", () => ({
  OnboardingChecklist: () => null,
}));
vi.mock("../../../components/invite-spotlight-host", () => ({
  InviteSpotlightHost: () => null,
}));
vi.mock("../components/my-tasks-empty-state", () => ({
  MyTasksEmptyState: () => <div data-testid="empty-state" />,
}));
vi.mock("../components/my-tasks-kanban", () => ({
  MyTasksKanban: () => <div data-testid="kanban" />,
}));
// Renders `extraChips` for real (FEA-1626): the recency chip is the page's only
// disclosure that the board is windowed, so a stub that swallowed it would let
// the chip be deleted with the suite still green.
vi.mock("@repo/app/documents/components/table/document-table-toolbar", () => ({
  DocumentTableToolbar: ({
    activeFiltersBarProps,
    leadingContent,
  }: {
    activeFiltersBarProps?: { extraChips?: ReactNode };
    leadingContent?: ReactNode;
  }) => (
    <div data-testid="toolbar">
      {activeFiltersBarProps?.extraChips}
      {leadingContent}
    </div>
  ),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: mocks.useCurrentUser,
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocumentsPage: mocks.useDocumentsPage,
  useUpdateDocument: mocks.useUpdateDocument,
  // The page threads the resolved cache key to the kanban; the real helper is
  // unit-tested in hooks/queries/__tests__/use-documents.test.ts.
  documentsPageQueryKey: (params: unknown) => ["documents", "list", params],
}));
vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: mocks.useProjects,
}));
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.apiGet }),
}));
vi.mock("@repo/app/projects/hooks/use-assigned-artifact-tree", () => ({
  useAssignedArtifactTree: mocks.useAssignedArtifactTree,
}));
vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: mocks.useFavoriteArtifacts,
}));
vi.mock("@repo/app/documents/hooks/use-project-filters", () => ({
  useProjectFilters: mocks.useProjectFilters,
}));
vi.mock("@repo/app/shared/hooks/use-filter-current-user", () => ({
  useFilterCurrentUser: mocks.useFilterCurrentUser,
}));
vi.mock("@repo/app/documents/hooks/use-group-by", () => ({
  useGroupBy: mocks.useGroupBy,
}));
vi.mock("@repo/app/documents/hooks/use-delete-row-item", () => ({
  useDeleteRowItem: mocks.useDeleteRowItem,
}));
vi.mock("@repo/app/users/hooks/use-org-users-as-popover-users", () => ({
  useOrgUsersAsPopoverUsers: mocks.useOrgUsersAsPopoverUsers,
}));
vi.mock("@repo/app/shared/hooks/use-column-visibility", () => ({
  useColumnVisibility: mocks.useColumnVisibility,
  MY_TASKS_DEFAULT_COLUMNS: ["type"],
  DocumentColumn: { Type: "type" },
}));
vi.mock("@repo/app/shared/hooks/use-local-storage-state", () => ({
  useLocalStorageState: mocks.useLocalStorageState,
}));
vi.mock("@repo/app/shared/hooks/use-view-state-persistence", () => ({
  useViewStatePersistence: mocks.useViewStatePersistence,
}));
vi.mock("@repo/app/shared/hooks/use-scroll-restore", () => ({
  useScrollRestore: mocks.useScrollRestore,
}));
vi.mock("@repo/app/documents/components/table/row-type-registry", () => ({
  isDocumentRowItem: mocks.isDocumentRowItem,
}));
vi.mock("@repo/app/documents/lib/document-filter", () => ({
  matchesFilter: () => true,
}));
vi.mock("@repo/app/documents/lib/document-navigation", () => ({
  isNavigableDocument: () => true,
}));
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ replace: vi.fn() }),
}));
vi.mock("@repo/navigation/use-path", () => ({ usePath: () => "/my-tasks" }));
vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(),
}));
// The pagination hook reads the StackRank flag and the page reads the
// copy-polish, assigned-artifact-tree, and recency-window flags; mount-free
// tests inject the value instead of a <FeatureFlagAdapterProvider>.
//
// One spy backs both per-test mechanisms, because the two suites below drive it
// differently and must not clobber each other: `setBaseMocks` gives
// `mocks.useFeatureFlagEnabled` a default implementation reading the
// `enabledFeatureFlags` set (FEA-1626 style — add a key to turn it on), while a
// test is still free to `.mockReturnValue`/`.mockImplementation` over it
// (FEA-1651 style). The set is cleared in every `beforeEach`, so the default
// stays off for every key — the closed-by-default production state the ISS-4779
// gates require.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
  // ISS-9665: the board reads `artifact-priority-unset` through the OPTIONAL
  // hook. Backed by the same key-driven spy so it obeys the closed default and
  // a case can still turn it on by adding the key to `enabledFeatureFlags`.
  useFeatureFlagEnabledOptional: mocks.useFeatureFlagEnabled,
  // FEA-1626: the board holds its documents read until the recency flag
  // resolves. `isReady` is driven per-test so the unresolved window — where the
  // query must NOT fire — is reachable, rather than being permanently true.
  useFeatureFlagGate: (key: string) => ({
    enabled: mocks.useFeatureFlagEnabled(key),
    isReady: mocks.isFeatureFlagGateReady,
  }),
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port, so this exhaustive module mock owes it an entry
  // too. Same answer as the required gate above.
  useFeatureFlagGateOptional: (key: string) => ({
    enabled: mocks.useFeatureFlagEnabled(key),
    isReady: mocks.isFeatureFlagGateReady,
  }),
}));
// The tree source withholds BOTH reads until PostHog's flags have resolved for
// the identified user (FEA-1651, whitlockk). These stubs put the suite in the
// settled/identified state so existing cases exercise the steady state; the
// transition case drives them directly.
vi.mock("@repo/analytics/client", () => ({
  // These drive the anonymous-bootstrap -> identify() handshake, which only
  // exists in a build that has a PostHog key.
  postHogFeatureFlagsEnabled: true,
  useFeatureFlagsLoaded: mocks.useFeatureFlagsLoaded,
  usePostHogDistinctId: mocks.usePostHogDistinctId,
  useFeatureFlag: () => undefined,
}));
vi.mock("@repo/auth/client", () => ({
  useUser: mocks.useUser,
}));

import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
  type DocumentListPage,
  DocumentListRecency,
  DocumentType,
} from "@repo/api/src/types/document";
import { MY_TASKS_RECENCY_CHIP_LABEL } from "@repo/app/my-tasks/lib/my-tasks-recency-window";
import { MY_TASKS_RECENCY_WINDOW_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import MyTasksPage from "../page";
import {
  buildDocumentListPage,
  docsResult,
  serverPagedTreeResult,
  setBaseMocks,
} from "./my-tasks-page-test-harness";

describe("MyTasksPage list-view loading treatment (FEA-3938)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabledFeatureFlags.clear();
    mocks.isFeatureFlagGateReady = true;
    setBaseMocks(mocks);
  });

  it("renders the DocumentsView loading branch and NOT the empty state while the current user is still resolving (disabled-query window)", () => {
    mocks.useCurrentUser.mockReturnValue({ data: undefined, isLoading: true });
    // Query disabled while user resolves: isArtifactsLoading is false here.
    mocks.useDocumentsPage.mockReturnValue(docsResult());

    render(<MyTasksPage />);

    const view = screen.getByTestId("documents-view");
    expect(view.getAttribute("data-loading")).toBe("true");
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("renders the DocumentsView loading branch and NOT the empty state while the artifacts query is fetching", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
    });
    mocks.useDocumentsPage.mockReturnValue(docsResult({ isLoading: true }));

    render(<MyTasksPage />);

    const view = screen.getByTestId("documents-view");
    expect(view.getAttribute("data-loading")).toBe("true");
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("renders the loading branch and NOT the empty state or a blank gap while the projects list is still loading (zero tasks, user/artifacts settled)", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
    });
    mocks.useDocumentsPage.mockReturnValue(docsResult());
    // Projects list not yet settled: the empty state needs it, so we must not
    // fall through to either the empty state or a blank screen.
    mocks.useProjects.mockReturnValue({ data: [], isLoading: true });

    render(<MyTasksPage />);

    const view = screen.getByTestId("documents-view");
    expect(view.getAttribute("data-loading")).toBe("true");
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("renders the empty state (not the table) once loading settles with zero tasks", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
    });
    mocks.useDocumentsPage.mockReturnValue(docsResult());

    render(<MyTasksPage />);

    expect(screen.getByTestId("empty-state")).toBeTruthy();
    expect(screen.queryByTestId("documents-view")).toBeNull();
  });

  it("renders the table with data (loading=false) once tasks resolve", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
    });
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: [{ id: "doc-1" }] })
    );

    render(<MyTasksPage />);

    const view = screen.getByTestId("documents-view");
    expect(view.getAttribute("data-loading")).toBe("false");
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("holds the loading branch (not the empty state) during a stale-cache refetch with zero rows (isFetching, isLoading=false)", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
    });
    // A background refetch of an empty cached list: `isLoading` is already false
    // but `isFetching` is true. The empty state must not flash until the
    // refetched rows arrive.
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ isLoading: false, isFetching: true })
    );

    render(<MyTasksPage />);

    const view = screen.getByTestId("documents-view");
    expect(view.getAttribute("data-loading")).toBe("true");
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("renders the empty state (not the table) for a branch-only user: zero documents and a tree holding only a branch and its sessions (ISS-12463)", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
    });
    mocks.useDocumentsPage.mockReturnValue(docsResult());
    // Seeded on the read the page actually makes, so `pruneBranchSubtrees` runs
    // on this tree: the branch and its two sessions are the ONLY nodes, so an
    // unpruned source would hand the table three rows and fail the empty-state
    // assertion below.
    mocks.useAssignedArtifactTree.mockReturnValue({
      data: {
        nodes: [
          {
            root: { id: "b-1", type: ArtifactType.Branch },
            children: [
              { id: "s-1", type: ArtifactType.Session, parentId: "b-1" },
              { id: "s-2", type: ArtifactType.Session, parentId: "b-1" },
            ],
          },
        ],
        externalParents: [],
      },
      isLoading: false,
      isError: false,
      refetch: mocks.refetchAssignedArtifactTree,
    });

    render(<MyTasksPage />);

    expect(screen.getByTestId("empty-state")).toBeTruthy();
    expect(screen.queryByTestId("documents-view")).toBeNull();
  });

  it("renders a degraded error state (not a partial total) when the tree read fails", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
    });
    // Documents succeeded, but the tree stream failed. Folding that into
    // isTasksError means the second stream's failure surfaces the Try-again
    // state instead of a footer publishing a total missing a whole stream
    // (ISS-4466, davetho).
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: [{ id: "doc-1" }] })
    );
    mocks.useAssignedArtifactTree.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mocks.refetchAssignedArtifactTree,
    });

    render(<MyTasksPage />);

    expect(screen.getByText("Couldn't load your tasks")).toBeTruthy();
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByTestId("documents-view")).toBeNull();
  });

  it("renders a degraded error state (not the empty state) when the artifacts read fails", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
    });
    // Settled-with-error: TanStack reports isLoading=false + isError=true and
    // defaults data to []. The page must not claim the queue is clear.
    mocks.useDocumentsPage.mockReturnValue(docsResult({ isError: true }));

    render(<MyTasksPage />);

    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText("Couldn't load your tasks")).toBeTruthy();
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByTestId("documents-view")).toBeNull();
  });

  it("card Try again refetches its failed documents exactly once without automatic tree recovery", async () => {
    const refetchCurrentUser = vi.fn();
    const refetchArtifacts = vi.fn().mockResolvedValue({
      isSuccess: true,
      data: buildDocumentListPage({ items: [] }),
    });
    mocks.useLocalStorageState.mockReturnValue(["card", vi.fn()]);
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
      refetch: refetchCurrentUser,
    });
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ isError: true, refetch: refetchArtifacts })
    );

    render(<MyTasksPage />);
    expect(refetchArtifacts).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await Promise.resolve();
    });

    expect(refetchCurrentUser).toHaveBeenCalledTimes(1);
    expect(refetchArtifacts).toHaveBeenCalledTimes(1);
  });

  it("retry refetches both the user AND the artifacts read when a valid assignee exists (artifacts failure)", () => {
    const refetchCurrentUser = vi.fn();
    const refetchArtifacts = vi.fn();
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
      refetch: refetchCurrentUser,
    });
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ isError: true, refetch: refetchArtifacts })
    );

    render(<MyTasksPage />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(refetchCurrentUser).toHaveBeenCalledTimes(1);
    expect(refetchArtifacts).toHaveBeenCalledTimes(1);
  });

  it("renders a degraded error state (not the empty state) when the current-user read fails", () => {
    mocks.useCurrentUser.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    mocks.useDocumentsPage.mockReturnValue(docsResult());

    render(<MyTasksPage />);

    expect(screen.getByText("Couldn't load your tasks")).toBeTruthy();
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByTestId("documents-view")).toBeNull();
  });

  it.each(["list", "card"])(
    "retry in %s routes to the failed user query and does NOT refetch documents while the assignee is null (codex P2)",
    (view) => {
      mocks.useLocalStorageState.mockReturnValue([view, vi.fn()]);
      // When /me fails, assigneeId is null and the artifacts query is disabled.
      // Refetching it would run the queryFn with a null assignee, requesting
      // /documents WITHOUT the My Tasks assignee filter. The retry must refetch
      // the user query and leave the disabled artifacts query alone.
      const refetchCurrentUser = vi.fn();
      const refetchArtifacts = vi.fn();
      mocks.useCurrentUser.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        refetch: refetchCurrentUser,
      });
      mocks.useDocumentsPage.mockReturnValue(
        docsResult({ refetch: refetchArtifacts })
      );

      render(<MyTasksPage />);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));

      expect(refetchCurrentUser).toHaveBeenCalledTimes(1);
      expect(refetchArtifacts).not.toHaveBeenCalled();
    }
  );
});

describe("MyTasksPage pagination footer (ISS-4466)", () => {
  const PAGE_SIZE = 50;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabledFeatureFlags.clear();
    mocks.isFeatureFlagGateReady = true;
    setBaseMocks(mocks);
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
    });
  });

  function pageOf(count: number) {
    return Array.from({ length: count }, (_u, i) => ({ id: `doc-${i}` }));
  }

  /**
   * Rows that survive a FLAT tab. Those tabs narrow by document type, so a row
   * with no `type` is filtered out of every one of them — which the All tab,
   * narrowing by nothing, never revealed.
   */
  function issuePageOf(count: number) {
    return Array.from({ length: count }, (_u, i) => ({
      id: `doc-${i}`,
      type: DocumentType.Feature,
    }));
  }

  it("shows an honest range readout of the full task total for a single page", () => {
    // ISS-10472: the All tab's rows and total come from the SERVER-paged tree,
    // so that is what this seeds. The contract is unchanged — the footer states
    // a range that covers every row and a total that matches it.
    mocks.useDocumentsPage.mockReturnValue(docsResult({ data: pageOf(30) }));
    mocks.useAssignedArtifactTree.mockReturnValue(serverPagedTreeResult(30));

    render(<MyTasksPage />);

    // Range covers every row; no page controls when it all fits on one page.
    // The readout is "Showing 1-30 of 30 groups" (the paged unit label rides
    // along) — match the range + honest total without pinning the trailing noun.
    expect(
      screen.getByText((content) => content.startsWith("Showing 1-30 of 30"))
    ).toBeTruthy();
  });

  it("caps the visible range at the page size and exposes page controls when the total exceeds one page", () => {
    // 51 root groups behind the predicate; the server returns one page of 50
    // and counts 51, so a second page exists.
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: pageOf(PAGE_SIZE + 1) })
    );
    mocks.useAssignedArtifactTree.mockReturnValue(
      serverPagedTreeResult(PAGE_SIZE, { total: PAGE_SIZE + 1 })
    );

    render(<MyTasksPage />);

    expect(
      screen.getByText((content) =>
        content.startsWith(`Showing 1-${PAGE_SIZE} of ${PAGE_SIZE + 1}`)
      )
    ).toBeTruthy();
    // TablePagination renders numbered page links only when totalPages > 1.
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("does not render the removed truncation notice wording", () => {
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: pageOf(PAGE_SIZE + 1) })
    );

    render(<MyTasksPage />);

    expect(
      screen.queryByText("most recently created tasks.", { exact: false })
    ).toBeNull();
  });

  // ISS-10472 moved this case to a FLAT tab, where its premise still holds. The
  // All tab's total is now the server's exact count over the predicate the page
  // was drawn from, so it has no floor to mark; the flat tabs keep the bounded
  // `GET /documents` read and therefore keep the marker (operator ruling
  // 2026-10-20). Kept as a counterfactual rather than deleted, because the
  // marker is still live — on a different tab.
  it("marks the total a floor and names what was left out when the server reports rows beyond the fetched window (ISS-4576)", () => {
    // The bounded list read returned 500 rows but the server counts 1204
    // assigned artifacts. A bare "of 500" would read as the whole queue.
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: issuePageOf(500), total: 1204, hasMore: true })
    );

    render(<MyTasksPage />);
    fireEvent.click(screen.getByText("Issues"));

    expect(
      screen.getByText((content) =>
        content.startsWith(`Showing 1-${PAGE_SIZE} of 500+`)
      )
    ).toBeTruthy();
    // The floor marker never appears without the line that explains it.
    // ISS-4682 item 5 / ISS-5280: the note states ONE number, and neither
    // superseded wording may come back — the ISS-4576 one stacked a third and
    // fourth count and ended in "are loaded"; the first ISS-5280 one claimed
    // 500 tasks "are shown" while this very render shows a 50-row page, and
    // reused the anchor line's noun for a different population.
    expect(
      screen.getByText("Counted from the first 500 assigned tasks.")
    ).toBeTruthy();
    expect(
      screen.queryByText("Only the first 500 of 1,204 are loaded.")
    ).toBeNull();
    expect(
      screen.queryByText("Only the first 500 tasks are shown.")
    ).toBeNull();
  });

  it("states a plain total (no floor marker or note) when the whole assigned set was loaded", () => {
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: pageOf(PAGE_SIZE + 1), total: PAGE_SIZE + 1 })
    );
    mocks.useAssignedArtifactTree.mockReturnValue(
      serverPagedTreeResult(PAGE_SIZE, { total: PAGE_SIZE + 1 })
    );

    render(<MyTasksPage />);

    expect(
      screen.getByText((content) =>
        content.startsWith(`Showing 1-${PAGE_SIZE} of ${PAGE_SIZE + 1} `)
      )
    ).toBeTruthy();
    expect(
      screen.queryByText((content) => content.startsWith("Counted from "))
    ).toBeNull();
  });

  it("requests only a screen-sized page in CARD view — the bound that stops the FEA-4373 crash (ISS-4576)", () => {
    // This is the real guard: the card board cannot mount more cards than the
    // read returns, and the read is bounded HERE, in the page's query params.
    // A component-level card-count assertion could not fail, because the card
    // view does no slicing of its own.
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: pageOf(PAGE_SIZE), total: 1204, hasMore: true })
    );
    mocks.useLocalStorageState.mockReturnValue(["card", vi.fn()]);

    render(<MyTasksPage />);

    expect(mocks.useDocumentsPage).toHaveBeenCalledWith(
      expect.objectContaining({ limit: PAGE_SIZE, offset: 0 }),
      expect.anything()
    );
  });

  it("keeps a same-size previous page mounted (control does not vanish) but drops a wider page across a view switch (crash guard)", () => {
    // The board passes a SCOPED placeholder, not unconditional keepPreviousData
    // (davetho): reusing the wide list page across a list → card switch would
    // transiently mount all 500 draggable cards. Assert the placeholder function
    // holds a same-`limit` previous page (an offset-only page turn) and drops a
    // different-`limit` one (the view switch).
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: pageOf(PAGE_SIZE + 1) })
    );

    render(<MyTasksPage />);

    const lastCall = mocks.useDocumentsPage.mock.calls.at(-1);
    if (!lastCall) {
      throw new Error("useDocumentsPage was never called");
    }
    const options = lastCall[1];
    expect(options).toBeDefined();
    const placeholderData = options?.placeholderData as
      | ((
          previous: DocumentListPage | undefined
        ) => DocumentListPage | undefined)
      | undefined;
    expect(typeof placeholderData).toBe("function");

    const requestedLimit = (lastCall[0] as { limit?: number }).limit;
    expect(requestedLimit).toBeDefined();

    const sameSizePrevious = buildDocumentListPage({ limit: requestedLimit });
    expect(placeholderData?.(sameSizePrevious)).toBe(sameSizePrevious);

    const widerPrevious = buildDocumentListPage({
      limit: (requestedLimit ?? PAGE_SIZE) + 450,
    });
    expect(placeholderData?.(widerPrevious)).toBeUndefined();
  });

  it("withholds the honest 'of N' total while the tree stream is still loading (no partial count)", () => {
    // Documents have landed (a page-worth), but the second task stream is still
    // loading — so the total does not yet cover every stream. The footer must
    // not publish a partial "of N" until both streams settle (davetho).
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: pageOf(PAGE_SIZE + 1) })
    );
    mocks.useAssignedArtifactTree.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: mocks.refetchAssignedArtifactTree,
    });

    render(<MyTasksPage />);

    expect(
      screen.queryByText((content) => content.startsWith("Showing "))
    ).toBeNull();
  });
});

// FEA-1626 (ISS-4779 closed-by-default): the board's assigned-artifact read is
// the ONE consumer whose default response the endpoint's new recency window
// changes, so the flag has to reach the request the page actually issues — not
// just the params helper it is unit-tested against.
describe("My Tasks recency window wiring (FEA-1626)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabledFeatureFlags.clear();
    mocks.isFeatureFlagGateReady = true;
    setBaseMocks(mocks);
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
    });
    mocks.useDocumentsPage.mockReturnValue(docsResult());
  });

  it("sends neither narrowing param while the flag is off", () => {
    render(<MyTasksPage />);

    expect(mocks.useDocumentsPage).toHaveBeenCalledWith(
      expect.not.objectContaining({ recencyDays: expect.anything() }),
      expect.anything()
    );
    expect(mocks.useDocumentsPage).toHaveBeenCalledWith(
      expect.not.objectContaining({
        includeArchivedProjects: expect.anything(),
      }),
      expect.anything()
    );
  });

  it("asks the endpoint for the bounded window once the flag is on", () => {
    mocks.enabledFeatureFlags.add(MY_TASKS_RECENCY_WINDOW_FEATURE_FLAG_KEY);

    render(<MyTasksPage />);

    expect(mocks.useDocumentsPage).toHaveBeenCalledWith(
      expect.objectContaining({
        recencyDays: DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
        includeArchivedProjects: false,
      }),
      expect.anything()
    );
  });

  it("discloses the window as a removable filter chip, and drops it on remove", () => {
    mocks.enabledFeatureFlags.add(MY_TASKS_RECENCY_WINDOW_FEATURE_FLAG_KEY);

    render(<MyTasksPage />);

    // The window must be visible on screen, not only in the request: a board
    // that silently returns fewer rows publishes a bounded count as if it were
    // the whole queue (closedloop-ai-stage).
    expect(screen.getByText(MY_TASKS_RECENCY_CHIP_LABEL)).toBeInTheDocument();
    const remove = screen.getByRole("button", {
      name: `Remove ${MY_TASKS_RECENCY_CHIP_LABEL} filter`,
    });

    fireEvent.click(remove);

    // The way back out: one control that drops the window and re-reads full
    // history, stated explicitly on the wire.
    expect(mocks.useDocumentsPage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recencyDays: DocumentListRecency.All,
        includeArchivedProjects: true,
      }),
      expect.anything()
    );
    expect(
      screen.queryByText(MY_TASKS_RECENCY_CHIP_LABEL)
    ).not.toBeInTheDocument();
  });

  it("renders no recency chip at all while the flag is off", () => {
    render(<MyTasksPage />);

    expect(
      screen.queryByText(MY_TASKS_RECENCY_CHIP_LABEL)
    ).not.toBeInTheDocument();
  });

  it("holds the documents read until the recency flag has resolved", () => {
    mocks.isFeatureFlagGateReady = false;

    render(<MyTasksPage />);

    // Otherwise an enabled user issues the unbounded request first and refetches
    // once the flag lands, so first paint still pays the cost (whitlockk).
    expect(mocks.useDocumentsPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false })
    );
  });

  it("issues the read once the flag resolves, with the enabled params", () => {
    mocks.enabledFeatureFlags.add(MY_TASKS_RECENCY_WINDOW_FEATURE_FLAG_KEY);
    mocks.isFeatureFlagGateReady = true;

    render(<MyTasksPage />);

    expect(mocks.useDocumentsPage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recencyDays: DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
      }),
      expect.objectContaining({ enabled: true })
    );
  });
});
