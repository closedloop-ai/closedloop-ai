import { fireEvent, render, screen } from "@testing-library/react";
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
  // Whether the build has a PostHog key at all. Mutable because it selects
  // between two genuinely different worlds: a live client with an
  // anonymous-bootstrap -> identify() handshake to wait on, and a
  // fixture-resolved build with no handshake and no distinct id to compare
  // against.
  postHogLive: true,
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

import { DocumentType } from "@repo/api/src/types/document";
import MyTasksPage from "../page";
import { docsResult, setBaseMocks } from "./my-tasks-page-test-harness";

/**
 * FEA-1651 (parent FEA-908): the list view's cross-project tree is the single
 * `GET /artifacts/assigned-tree` read.
 *
 * ISS-12637 retired `my-tasks-own-work-tree`, so nothing here seeds a flag.
 * Asserting the endpoint at DEFAULT CONFIG is what proves the retirement — a
 * suite that kept seeding the key would pass identically against a gate that
 * was never removed. The per-project fan-out is not asserted absent here: the
 * hook that issued it was deleted with the flag, so there is nothing left to
 * call.
 *
 * The five cases this file lost with the flag were its OFF arm, the two
 * unresolved-PostHog windows, the no-PostHog-key carve-out, and the
 * unresolved-to-on transition. Each asserted which of two reads won; there is
 * one read.
 */
describe("MyTasksPage assigned-artifact-tree endpoint (FEA-1651)", () => {
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

  function assignedEnabled(): boolean | undefined {
    return mocks.useAssignedArtifactTree.mock.calls.at(-1)?.[1]?.enabled;
  }

  it("reads the assigned-tree endpoint at default config, with no flag seeded", () => {
    mocks.useAssignedArtifactTree.mockReturnValue({
      data: { nodes: [], externalParents: [] },
      isLoading: false,
      isError: false,
      refetch: mocks.refetchAssignedArtifactTree,
    });

    render(<MyTasksPage />);

    expect(assignedEnabled()).toBe(true);
    expect(mocks.useAssignedArtifactTree.mock.calls.at(-1)?.[0]).toBe("user-1");
  });

  it("keeps the isListView gate: the tree read is not enabled in card view", () => {
    // `useLocalStorageState` backs the list/card view toggle.
    mocks.useLocalStorageState.mockReturnValue(["card", vi.fn()]);

    render(<MyTasksPage />);

    expect(assignedEnabled()).toBe(false);
  });

  it("surfaces an assigned-tree read failure through the same degraded-stream path", () => {
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

  // ISS-10472 moved this case to a FLAT tab, where its premise still holds. The
  // truncation it seeds is the UNPAGED read's anchor cap, and the All tab no
  // longer issues an unpaged read — nor would it mark a floor if it did, since
  // its total is exact and the node budget renders nothing there (operator
  // ruling 2026-10-20). The flat tabs still read the unpaged tree, so the cap
  // and its marker are still live on them; kept as a counterfactual.
  it("marks the total a floor and names the tree bound when the server truncated the walk", () => {
    // The documents stream is COMPLETE (`hasMore: false`), so any floor marker
    // here can only have come from the tree stream — this is the case where a
    // whole stream would otherwise leave the count silently.
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({
        data: [{ id: "doc-0", type: DocumentType.Feature }],
        total: 1,
        hasMore: false,
      })
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
    fireEvent.click(screen.getByText("Issues"));

    expect(screen.getByText((content) => content.includes("+"))).toBeTruthy();
    expect(
      screen.getByText("Only your first 500 tasks were expanded into the tree.")
    ).toBeTruthy();
  });

  it("retries the tree stream from Try again, not only the documents read", () => {
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
