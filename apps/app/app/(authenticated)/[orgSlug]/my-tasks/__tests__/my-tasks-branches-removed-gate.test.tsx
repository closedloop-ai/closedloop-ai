import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useCurrentUser: vi.fn(),
  useDocumentsPage: vi.fn(),
  useUpdateDocument: vi.fn(),
  useProjects: vi.fn(),
  branchHooks: new Map<string, ReturnType<typeof vi.fn>>(),
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
  postHogLive: true,
}));

// Renders `leadingContent` for real — the toggle group IS the subject here —
// and reports whether the page supplied `filterPopoverProps`.
vi.mock("@repo/app/documents/components/table/document-table-toolbar", () => ({
  DocumentTableToolbar: ({
    filterPopoverProps,
    leadingContent,
  }: {
    filterPopoverProps?: unknown;
    leadingContent?: ReactNode;
  }) => (
    <div
      data-filter-popover={filterPopoverProps ? "offered" : "suppressed"}
      data-testid="toolbar"
    >
      {leadingContent}
    </div>
  ),
}));
vi.mock("@repo/app/documents/components/table/documents-view", () => ({
  DocumentsView: () => <div data-testid="documents-view" />,
}));
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => <div data-testid="header" />,
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
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: mocks.useCurrentUser,
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocumentsPage: mocks.useDocumentsPage,
  useUpdateDocument: mocks.useUpdateDocument,
  documentsPageQueryKey: (params: unknown) => ["documents", "list", params],
}));
vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: mocks.useProjects,
}));
// Every export of the branch hooks module becomes a recorded spy, so a branch
// read reintroduced through ANY of them fails the absence assertions below.
vi.mock("@repo/app/branches/hooks/use-branches", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => {
      if (typeof value === "function") {
        const spy = vi.fn();
        mocks.branchHooks.set(name, spy);
        return [name, spy];
      }
      return [name, value];
    })
  );
});
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
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
  useFeatureFlagEnabledOptional: mocks.useFeatureFlagEnabled,
  useFeatureFlagGate: (key: string) => ({
    enabled: mocks.useFeatureFlagEnabled(key),
    isReady: mocks.isFeatureFlagGateReady,
  }),
  useFeatureFlagGateOptional: (key: string) => ({
    enabled: mocks.useFeatureFlagEnabled(key),
    isReady: mocks.isFeatureFlagGateReady,
  }),
}));
vi.mock("@repo/analytics/client", () => ({
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

import MyTasksPage from "../page";
import {
  CLERK_USER_ID,
  docsResult,
  setBaseMocks,
} from "./my-tasks-page-test-harness";

/**
 * The one spelling of the tab this suite asserts absent, so the absence can
 * never drift into matching nothing — which is how a resurrected tab passes a
 * removal suite.
 */
const BRANCHES_TAB_LABEL = "Branches";
const SURVIVING_TAB_LABELS = ["All", "PRDs", "Issues", "Plans"];

/**
 * ISS-12463 (operator ruling 2026-10-16): branches are not tasks, so My Tasks
 * offers no Branches tab and reads no contributor branches.
 */
describe("MyTasksPage without branches (ISS-12463)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabledFeatureFlags.clear();
    mocks.isFeatureFlagGateReady = true;
    mocks.postHogLive = true;
    setBaseMocks(mocks);
    mocks.useCurrentUser.mockReturnValue({
      data: { id: CLERK_USER_ID },
      isLoading: false,
      refetch: mocks.refetchCurrentUser,
    });
    mocks.useDocumentsPage.mockReturnValue(
      docsResult({ data: [{ id: "doc-1" }] })
    );
  });

  it("offers no Branches tab, and keeps the rest", () => {
    render(<MyTasksPage />);

    expect(
      screen.queryByRole("radio", { name: BRANCHES_TAB_LABEL })
    ).toBeNull();
    // The removal takes exactly one item: a toggle group that lost its other
    // options would satisfy an absence assertion on its own.
    for (const label of SURVIVING_TAB_LABELS) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByTestId("toolbar")).toHaveAttribute(
      "data-filter-popover",
      "offered"
    );
  });

  it("issues no contributor branch read", () => {
    render(<MyTasksPage />);

    expect(calledBranchHooks()).toEqual([]);
  });
});

function calledBranchHooks(): string[] {
  return [...mocks.branchHooks]
    .filter(([, spy]) => spy.mock.calls.length > 0)
    .map(([name]) => name);
}
