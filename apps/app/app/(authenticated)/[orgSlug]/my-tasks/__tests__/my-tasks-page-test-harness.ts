import type { DocumentListPage } from "@repo/api/src/types/document";
import { type Mock, vi } from "vitest";

// Shared harness for the My Tasks page suites. The `vi.mock` factories
// themselves stay in each test file — Vitest hoists those above imports, so
// they cannot be centralised — but everything downstream of them (fixtures and
// the baseline mock returns) lives here so the suites cannot drift apart.

/** PostHog's distinct id matches this once `identify()` has landed. */
export const CLERK_USER_ID = "user_clerk_my_tasks";

// Full `useDocumentsPage` result shape so the page can read
// `isFetching`/`isError`/`refetch` without each test respecifying them
// (defaults are the settled, success, cold-cache case). ISS-4576: `data` is the
// paged ENVELOPE — items plus the server's real total — so `total` can differ
// from `items.length` exactly the way a bounded read makes it differ in
// production.
/**
 * Return type is explicit, not inferred: `refetch` defaults to `vi.fn()`, and
 * letting that widen to `@vitest/spy`'s `Mock` makes the exported signature
 * unnameable outside this package (TS2742).
 */
export type DocsResult = {
  /**
   * The paged envelope, or `undefined` while pending. `items` stays `unknown[]`
   * so a suite can hand the page whatever row shape its assertion needs.
   */
  data:
    | {
        items: unknown[];
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
      }
    | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
};

export function docsResult(
  overrides: {
    data?: unknown[];
    isLoading?: boolean;
    isFetching?: boolean;
    isError?: boolean;
    /** Server-side total; defaults to the page length (nothing truncated). */
    total?: number;
    hasMore?: boolean;
    offset?: number;
    refetch?: () => void;
  } = {}
): DocsResult {
  const items = overrides.data ?? [];
  const isPending = overrides.isLoading ?? false;
  return {
    data: isPending
      ? undefined
      : {
          items,
          total: overrides.total ?? items.length,
          limit: 500,
          offset: overrides.offset ?? 0,
          hasMore: overrides.hasMore ?? false,
        },
    isLoading: isPending,
    isFetching: overrides.isFetching ?? false,
    isError: overrides.isError ?? false,
    refetch: overrides.refetch ?? vi.fn(),
  };
}

// A minimal `DocumentListPage` envelope for exercising the scoped placeholder
// (ISS-4576). `limit` is the axis under test — the placeholder holds a previous
// page only when its `limit` matches the incoming request's.
export function buildDocumentListPage(
  overrides: Partial<DocumentListPage>
): DocumentListPage {
  return {
    items: [],
    total: 0,
    limit: 50,
    offset: 0,
    hasMore: false,
    ...overrides,
  };
}

/** The hoisted spies each My Tasks suite hands to {@link setBaseMocks}. */
export type MyTasksPageMocks = {
  enabledFeatureFlags: Set<string>;
  useProjects: Mock;
  useBranchList: Mock;
  useMergedProjectTrees: Mock;
  useAssignedArtifactTree: Mock;
  useFeatureFlagEnabled: Mock;
  useFeatureFlagsLoaded: Mock;
  usePostHogDistinctId: Mock;
  useUser: Mock;
  useUpdateDocument: Mock;
  useFavoriteArtifacts: Mock;
  useProjectFilters: Mock;
  useFilterCurrentUser: Mock;
  useGroupBy: Mock;
  useDeleteRowItem: Mock;
  useOrgUsersAsPopoverUsers: Mock;
  useColumnVisibility: Mock;
  useLocalStorageState: Mock;
  useViewStatePersistence: Mock;
  useScrollRestore: Mock;
  isDocumentRowItem: Mock;
  refetchContributorBranches: Mock;
  refetchMergedProjectTrees: Mock;
  refetchAssignedArtifactTree: Mock;
};

/** The settled, signed-in, nothing-failing baseline every suite starts from. */
export function setBaseMocks(mocks: MyTasksPageMocks) {
  mocks.useProjects.mockReturnValue({ data: [], isLoading: false });
  mocks.useBranchList.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: mocks.refetchContributorBranches,
  });
  mocks.useMergedProjectTrees.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: mocks.refetchMergedProjectTrees,
  });
  mocks.useAssignedArtifactTree.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: mocks.refetchAssignedArtifactTree,
  });
  // Default: every key reads off, because `enabledFeatureFlags` is cleared in
  // each `beforeEach`. A test turns one on by adding its key to that set, or by
  // overriding this spy outright with `.mockReturnValue`/`.mockImplementation`.
  mocks.useFeatureFlagEnabled.mockImplementation((key: string) =>
    mocks.enabledFeatureFlags.has(key)
  );
  mocks.useFeatureFlagsLoaded.mockReturnValue(true);
  mocks.usePostHogDistinctId.mockReturnValue(CLERK_USER_ID);
  mocks.useUser.mockReturnValue({
    user: { id: CLERK_USER_ID },
    isLoaded: true,
  });
  mocks.useUpdateDocument.mockReturnValue({ mutate: vi.fn() });
  mocks.useFavoriteArtifacts.mockReturnValue({ data: [] });
  mocks.useProjectFilters.mockReturnValue({
    rootItems: [],
    isAnyFilterActive: false,
    applyFilters: (items: unknown[]) => items,
    clearAllFilters: vi.fn(),
    clearPersistedFilters: vi.fn(),
  });
  mocks.useFilterCurrentUser.mockReturnValue(null);
  mocks.useGroupBy.mockReturnValue({ groupBy: "none", setGroupBy: vi.fn() });
  mocks.useDeleteRowItem.mockReturnValue(vi.fn());
  mocks.useOrgUsersAsPopoverUsers.mockReturnValue([]);
  mocks.useColumnVisibility.mockReturnValue({
    visibility: {},
    userVisibility: {},
    toggleColumn: vi.fn(),
  });
  // list view
  mocks.useLocalStorageState.mockReturnValue(["list", vi.fn()]);
  mocks.useViewStatePersistence.mockReturnValue(["", vi.fn(), vi.fn()]);
  mocks.useScrollRestore.mockReturnValue({ clearPosition: vi.fn() });
  // Default: no row item is a navigable document, so the kanban selection is
  // empty unless a card test opts a fixture in.
  mocks.isDocumentRowItem.mockReturnValue(false);
}
