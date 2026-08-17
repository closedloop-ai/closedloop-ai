import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useCurrentUser: vi.fn(),
  useDocumentsPage: vi.fn(),
  useUpdateDocument: vi.fn(),
  useProjects: vi.fn(),
  useBranchList: vi.fn(),
  useMergedProjectTrees: vi.fn(),
  useAssignedArtifactTree: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
  useFeatureFlagsLoaded: vi.fn(),
  usePostHogDistinctId: vi.fn(),
  useUser: vi.fn(),
  refetchCurrentUser: vi.fn(),
  refetchContributorBranches: vi.fn(),
  refetchMergedProjectTrees: vi.fn(),
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
  // Whether the build has a PostHog key at all. Mutable because it selects
  // between two genuinely different worlds: a live client with an
  // anonymous-bootstrap -> identify() handshake to wait on, and a
  // fixture-resolved build with no handshake and no distinct id to compare
  // against.
  postHogLive: true,
}));

// Presentational markers so the test asserts branch selection, not child guts.
vi.mock(
  "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/documents-view",
  () => ({
    DocumentsView: ({ isLoading }: { isLoading?: boolean }) => (
      <div
        data-loading={isLoading ? "true" : "false"}
        data-testid="documents-view"
      />
    ),
  })
);
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => <div data-testid="header" />,
}));
// vi.mock paths resolve relative to this test file, which sits one directory
// deeper (__tests__/) than page.tsx — so add one extra "../" to each relative
// specifier the page uses.
vi.mock("../../../components/agent-onboarding-card", () => ({
  AgentOnboardingCard: () => null,
}));
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
  }: {
    activeFiltersBarProps?: { extraChips?: ReactNode };
  }) => <div data-testid="toolbar">{activeFiltersBarProps?.extraChips}</div>,
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
vi.mock("@repo/app/branches/hooks/use-branches", () => ({
  useBranchList: mocks.useBranchList,
}));
vi.mock("@repo/app/projects/hooks/use-merged-project-trees", () => ({
  useMergedProjectTrees: mocks.useMergedProjectTrees,
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
  // FEA-1626: the board holds its documents read until the recency flag
  // resolves. `isReady` is driven per-test so the unresolved window — where the
  // query must NOT fire — is reachable, rather than being permanently true.
  useFeatureFlagGate: (key: string) => ({
    enabled: mocks.useFeatureFlagEnabled(key),
    isReady: mocks.isFeatureFlagGateReady,
  }),
}));
// The tree source withholds BOTH reads until PostHog's flags have resolved for
// the identified user (FEA-1651, wongk). These stubs put the suite in the
// settled/identified state so existing cases exercise the steady state; the
// transition case drives them directly.
vi.mock("@repo/analytics/client", () => ({
  // These drive the anonymous-bootstrap -> identify() handshake, which only
  // exists in a build that has a PostHog key. A getter, not a literal: the
  // module is evaluated once, and the PostHog-disabled build is a per-test
  // condition.
  get postHogFeatureFlagsEnabled() {
    return mocks.postHogLive;
  },
  useFeatureFlagsLoaded: mocks.useFeatureFlagsLoaded,
  usePostHogDistinctId: mocks.usePostHogDistinctId,
  useFeatureFlag: () => undefined,
}));
vi.mock("@repo/auth/client", () => ({
  useUser: mocks.useUser,
}));

import { MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import MyTasksPage from "../page";
import { docsResult, setBaseMocks } from "./my-tasks-page-test-harness";

/**
 * FEA-1651 (parent FEA-908): the list view's cross-project tree moves from an
 * N-request per-project fan-out to the single `GET /artifacts/assigned-tree`
 * read, behind a closed-by-default flag (ISS-4779). Both hooks are always
 * mounted, so what matters is which one is ENABLED — a disabled hook issues no
 * request at all.
 */
describe("MyTasksPage assigned-artifact-tree endpoint gate (FEA-1651)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabledFeatureFlags.clear();
    mocks.isFeatureFlagGateReady = true;
    mocks.postHogLive = true;
    setBaseMocks(mocks);
    mocks.useCurrentUser.mockReturnValue({
      data: { id: "user-1" },
      isLoading: false,
      refetch: mocks.refetchCurrentUser,
    });
    mocks.useDocumentsPage.mockReturnValue(docsResult());
  });

  function enabledFlags(): {
    merged: boolean | undefined;
    assigned: boolean | undefined;
  } {
    return {
      merged: mocks.useMergedProjectTrees.mock.calls.at(-1)?.[1]?.enabled,
      assigned: mocks.useAssignedArtifactTree.mock.calls.at(-1)?.[1]?.enabled,
    };
  }

  it("reads the per-project fan-out and never the assigned-tree endpoint with the flag off", () => {
    mocks.useFeatureFlagEnabled.mockReturnValue(false);

    render(<MyTasksPage />);

    expect(enabledFlags()).toEqual({ merged: true, assigned: false });
  });

  it("reads the single assigned-tree endpoint and never the fan-out with the flag on", () => {
    mocks.useFeatureFlagEnabled.mockImplementation(
      (key: string) => key === MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY
    );
    const tree = { nodes: [], externalParents: [] };
    mocks.useAssignedArtifactTree.mockReturnValue({
      data: tree,
      isLoading: false,
      isError: false,
      refetch: mocks.refetchAssignedArtifactTree,
    });

    render(<MyTasksPage />);

    expect(enabledFlags()).toEqual({ merged: false, assigned: true });
    expect(mocks.useAssignedArtifactTree.mock.calls.at(-1)?.[0]).toBe("user-1");
  });

  it("keeps the isListView gate: neither tree read is enabled in card view", () => {
    // `useLocalStorageState` backs the list/card view toggle.
    mocks.useLocalStorageState.mockReturnValue(["card", vi.fn()]);
    mocks.useFeatureFlagEnabled.mockImplementation(
      (key: string) => key === MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY
    );

    render(<MyTasksPage />);

    expect(enabledFlags()).toEqual({ merged: false, assigned: false });
  });

  it("surfaces an assigned-tree read failure through the same degraded-stream path", () => {
    mocks.useFeatureFlagEnabled.mockImplementation(
      (key: string) => key === MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY
    );
    mocks.useAssignedArtifactTree.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      refetch: mocks.refetchAssignedArtifactTree,
    });

    render(<MyTasksPage />);

    expect(screen.getByText("Couldn't load your tasks")).toBeTruthy();
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("starts NEITHER read while the flag is still unresolved for the identified user", () => {
    // The cold-PostHog window: flags have not been delivered yet, so the web
    // adapter reports the flag as `false`. Keying off that raw value would start
    // the LEGACY fan-out here and never cancel it when the flag resolves true
    // (wongk). Both reads must stay disabled instead.
    mocks.useFeatureFlagsLoaded.mockReturnValue(false);
    mocks.useFeatureFlagEnabled.mockReturnValue(false);

    render(<MyTasksPage />);

    expect(enabledFlags()).toEqual({ merged: false, assigned: false });
  });

  it("reads the assigned-tree endpoint immediately in a build with no PostHog key", () => {
    // The only case the `postHogFeatureFlagsEnabled` carve-out changes, and the
    // one every other test here pins away: with no key, `useFeatureFlag` is
    // bound to the local fixture, so flags are decided from the first render —
    // there is no bootstrap, no `identify()`, and no distinct id. Reading the
    // handshake signals literally instead would report "never settled" forever
    // and hold both reads off for the whole life of every containerized-E2E and
    // local-dev session. The handshake mocks stay in their UNSETTLED state on
    // purpose: with the carve-out removed this asserts `assigned: false`.
    mocks.postHogLive = false;
    mocks.useFeatureFlagsLoaded.mockReturnValue(false);
    mocks.usePostHogDistinctId.mockReturnValue(undefined);
    mocks.useFeatureFlagEnabled.mockImplementation(
      (key: string) => key === MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY
    );

    render(<MyTasksPage />);

    expect(enabledFlags()).toEqual({ merged: false, assigned: true });
  });

  it("starts NEITHER read while PostHog is not yet keyed on the signed-in user", () => {
    // Flags delivered, but for the ANONYMOUS bootstrap id — identify() has not
    // landed, so this flag value is not this user's.
    mocks.useFeatureFlagsLoaded.mockReturnValue(true);
    mocks.usePostHogDistinctId.mockReturnValue("anon-bootstrap-id");
    mocks.useFeatureFlagEnabled.mockReturnValue(false);

    render(<MyTasksPage />);

    expect(enabledFlags()).toEqual({ merged: false, assigned: false });
  });

  it("never starts the legacy fan-out across the unresolved to flag-on transition", () => {
    mocks.useFeatureFlagsLoaded.mockReturnValue(false);
    mocks.useFeatureFlagEnabled.mockReturnValue(false);
    const { rerender } = render(<MyTasksPage />);
    expect(enabledFlags()).toEqual({ merged: false, assigned: false });

    // The flags resolve, and they resolve ON.
    mocks.useFeatureFlagsLoaded.mockReturnValue(true);
    mocks.useFeatureFlagEnabled.mockImplementation(
      (key: string) => key === MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY
    );
    rerender(<MyTasksPage />);

    expect(enabledFlags()).toEqual({ merged: false, assigned: true });
    // Across the WHOLE transition the fan-out was never enabled once, so there
    // are no already-issued legacy reads left running beside the new one.
    const everEnabledMerged = mocks.useMergedProjectTrees.mock.calls.some(
      (call) => call[1]?.enabled === true
    );
    expect(everEnabledMerged).toBe(false);
  });

  it("does not issue the contributor-branch read under the flag, or let it hold the table", () => {
    mocks.useFeatureFlagEnabled.mockImplementation(
      (key: string) => key === MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY
    );
    // The branch read is reporting "still loading". Under the flag the endpoint
    // resolves contributor branches server-side, so this read is not issued and
    // must not gate the table behind a skeleton for a read nothing consumes.
    mocks.useBranchList.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: mocks.refetchContributorBranches,
    });
    mocks.useAssignedArtifactTree.mockReturnValue({
      data: { nodes: [], externalParents: [] },
      isLoading: false,
      isError: false,
      refetch: mocks.refetchAssignedArtifactTree,
    });
    // A real row, so the board renders the table rather than the empty state.
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: [{ id: "doc-0" }] })
    );

    render(<MyTasksPage />);

    expect(mocks.useBranchList.mock.calls.at(-1)?.[1]?.enabled).toBe(false);
    expect(
      screen.getByTestId("documents-view").getAttribute("data-loading")
    ).toBe("false");
  });

  it("marks the total a floor and names the tree bound when the server truncated the walk", () => {
    mocks.useFeatureFlagEnabled.mockImplementation(
      (key: string) => key === MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY
    );
    // The documents stream is COMPLETE (`hasMore: false`), so any floor marker
    // here can only have come from the tree stream — this is the case where a
    // whole stream would otherwise leave the count silently.
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: [{ id: "doc-0" }], total: 1, hasMore: false })
    );
    mocks.useAssignedArtifactTree.mockReturnValue({
      data: {
        nodes: [],
        externalParents: [],
        truncation: {
          anchorsIncluded: 500,
          anchorsMatchedAtLeast: 501,
          reasons: ["anchor_cap"],
        },
      },
      isLoading: false,
      isError: false,
      refetch: mocks.refetchAssignedArtifactTree,
    });

    render(<MyTasksPage />);

    expect(screen.getByText((content) => content.includes("+"))).toBeTruthy();
    expect(
      screen.getByText("Only your first 500 tasks were expanded into the tree.")
    ).toBeTruthy();
  });

  it("retries the tree stream from Try again, not only the documents read", () => {
    mocks.useFeatureFlagEnabled.mockImplementation(
      (key: string) => key === MY_TASKS_ASSIGNED_ARTIFACT_TREE_FEATURE_FLAG_KEY
    );
    mocks.useAssignedArtifactTree.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      refetch: mocks.refetchAssignedArtifactTree,
    });

    render(<MyTasksPage />);
    fireEvent.click(screen.getByText("Try again"));

    // The failure shown is the TREE read's, so Try again has to be able to
    // clear it.
    expect(mocks.refetchAssignedArtifactTree).toHaveBeenCalled();
  });
});
