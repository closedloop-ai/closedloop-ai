import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  PROJECT_ARTIFACTS_PAGINATION_FEATURE_FLAG_KEY,
  PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { posthogFeatureFlagAdapter } from "@/lib/app-core-adapters";
import ProjectDetailPage from "../page";
import { registerProjectDetailHierarchyHostTests } from "./page-host-regressions";
import {
  PROJECT_DETAIL_TEST_PROJECT as PROJECT,
  PROJECT_DETAIL_TEST_TEAM as TEAM,
} from "./page-test-fixtures";

const columnVisibilityOptionsSpy = vi.hoisted(() => vi.fn());

const useProjectMock = vi.fn();
const useTeamMock = vi.fn();
const useProjectTreeRootPagesMock = vi.fn();
const useProjectTreeWithDetailsMock = vi.fn();
const tabParamMock = vi.fn();
const featureFlagGateMock = vi.fn();
const unsetPriorityFlagMock = vi.fn();
const portableFlagMock = vi.fn();
const projectArtifactListPropsMock = vi.fn();
const manualOrderingFlagMock = vi.fn();
const placementCapabilityMock = vi.fn();

const projectFiltersDocuments: unknown[][] = [];
const collectDocumentRowsFromTreeMock = vi.fn();
const treeHasRenderableArtifactsMock = vi.fn();

const documentsViewProps: {
  documents: unknown;
  sortPersistenceKey?: string | null;
  storageKey?: string | null;
  editHandlers?: RowEditHandlers;
  canReorderArtifacts?: boolean;
}[] = [];

const updateDocumentMutateMock = vi.hoisted(() => vi.fn());

const viewStatePersistenceKeys: (string | null)[] = [];
const scrollRestoreKeys: (string | null)[] = [];
const projectFiltersPersistenceKeys: (string | null | undefined)[] = [];
const paginationKeysSpy = vi.fn();

// Stable navigation spy pins the route's ISS-8588 redirect.
const replaceMock = vi.fn();
const routeParamsMock = vi.fn();
const searchParamsMock = vi.fn();

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: () => routeParamsMock(),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    push: vi.fn(),
    replace: replaceMock,
  }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/acme/teams/team-1/projects/project-1",
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));
vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => searchParamsMock(),
}));
vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));
vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useDeleteProject: () => ({ mutate: vi.fn(), isPending: false }),
  useIsFavorite: () => false,
  useProject: () => useProjectMock(),
  useProjectStatusHandler: () => ({
    handleUpdateStatus: vi.fn(),
    isPending: false,
  }),
  useToggleFavorite: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateProject: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateProjectAssignee: () => ({ mutate: vi.fn() }),
  useUpdateProjectPriority: () => ({ mutate: vi.fn() }),
  useUpdateProjectTargetDate: () => ({ mutate: vi.fn() }),
}));
vi.mock("@repo/app/projects/hooks/use-artifact-placement", () => ({
  useArtifactPlacementCapability: (projectId: string) =>
    placementCapabilityMock(projectId),
}));
vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeam: () => useTeamMock(),
}));
vi.mock("@repo/app/teams/hooks/use-team-members", () => ({
  useTeamMembers: () => ({ members: [], isLoading: false, error: null }),
}));

vi.mock("@repo/app/projects/hooks/use-project-tree", () => ({
  useProjectTreeRootPages: (...args: unknown[]) =>
    useProjectTreeRootPagesMock(...args),
  useProjectTreeWithDetails: (...args: unknown[]) =>
    useProjectTreeWithDetailsMock(...args),
}));

vi.mock("@repo/app/documents/lib/artifact-row-adapter", () => ({
  collectDocumentRowsFromTree: (...args: unknown[]) =>
    collectDocumentRowsFromTreeMock(...args),
}));

vi.mock("@repo/app/documents/lib/table-view-pipeline", () => ({
  treeHasRenderableArtifacts: (...args: unknown[]) =>
    treeHasRenderableArtifactsMock(...args),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: { id: "user-1" } }),
}));

vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({ data: [] }),
}));

vi.mock("@repo/app/documents/hooks/use-delete-row-item", () => ({
  useDeleteRowItem: () => vi.fn(),
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useUpdateDocument: () => ({ mutate: updateDocumentMutateMock }),
}));

vi.mock("@repo/app/documents/hooks/use-group-by", () => ({
  useGroupBy: () => ({ groupBy: GroupByMode.None, setGroupBy: vi.fn() }),
}));

vi.mock("@repo/app/documents/hooks/use-project-filters", () => ({
  useProjectFilters: (input: {
    documents: unknown[];
    persistenceKey?: string | null;
  }) => {
    projectFiltersDocuments.push(input.documents);
    projectFiltersPersistenceKeys.push(input.persistenceKey);
    return {
      isAnyFilterActive: false,
      applyFilters: (items: unknown[]) => items,
      clearAllFilters: vi.fn(),
      clearPersistedFilters: vi.fn(),
    };
  },
}));

const portRead = vi.hoisted(() => ({
  enabled: (_key: string): boolean => false,
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => portRead.enabled(key),
  useFeatureFlagGate: (key: string) => featureFlagGateMock(key),
  // ISS-9665: the tree hook reads `artifact-priority-unset` through the OPTIONAL
  // hook. Its own spy, NOT the gate above — that one is the category-read flag,
  // and a case that turns THAT on must not silently also unset-enable priority.
  useFeatureFlagEnabledOptional: (key: string) => {
    if (key === PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY) {
      return portableFlagMock();
    }
    if (key === MANUAL_ARTIFACT_ORDERING_FLAG_KEY) {
      return manualOrderingFlagMock() || featureFlagGateMock(key).enabled;
    }
    return unsetPriorityFlagMock();
  },
  // ISS-9692: `useTablePageSizeOptions` reads the ladder gate through the
  // provider-optional port, so this exhaustive module mock owes it an entry
  // too. Same answer as the required gate above.
  useFeatureFlagGateOptional: (key: string) => featureFlagGateMock(key),
}));
portRead.enabled = posthogFeatureFlagAdapter.useFeatureFlagEnabled;

vi.mock("@repo/app/shared/hooks/use-column-visibility", () => ({
  DocumentColumn: { Type: "type" },
  useColumnVisibility: (options: {
    storageKey: string | null;
    orderStorageKey?: string | null;
  }) => {
    columnVisibilityOptionsSpy(options);
    return {
      userVisibility: {},
      visibleColumns: [],
      toggleColumn: vi.fn(),
      reorderColumns: vi.fn(),
      resetColumnOrder: vi.fn(),
    };
  },
}));

vi.mock("@repo/app/shared/hooks/use-view-state-key", () => ({
  useViewStateKey: (baseKey: string) => `ns::${baseKey}`,
}));

vi.mock("@repo/app/shared/hooks/use-filter-current-user", () => ({
  useFilterCurrentUser: () => null,
}));

vi.mock("@repo/app/shared/hooks/use-scroll-restore", () => ({
  useScrollRestore: (key: string | null) => {
    scrollRestoreKeys.push(key);
    return { clearPosition: vi.fn() };
  },
}));

vi.mock("@repo/app/shared/hooks/use-tab-param", () => ({
  useTabParam: () => tabParamMock(),
}));

vi.mock("@repo/app/shared/hooks/use-view-state-persistence", () => ({
  useViewStatePersistence: (key: string | null) => {
    viewStatePersistenceKeys.push(key);
    return ["", vi.fn(), vi.fn()];
  },
}));

// Passes the page's OWN derived rows through as the page slice. A mock that
// returned a fixed `pagedDocuments` would answer identically no matter what the
// page derived, so the row assertion below could not observe the derivation it
// claims to pin (flagged in review).
vi.mock("../hooks/use-project-artifacts-pagination", () => ({
  useProjectArtifactsPagination: (input: {
    documents: unknown[];
    pageSizeStorageKey?: string | null;
    sortPersistenceKey?: string | null;
  }) => {
    paginationKeysSpy({
      pageSizeStorageKey: input.pageSizeStorageKey,
      sortPersistenceKey: input.sortPersistenceKey,
    });
    return {
      emptyStateTruncationNote: null,
      hasUnpagedItems: false,
      pagedDocuments: input.documents,
      pagedTreeData: undefined,
      showFooter: false,
    };
  },
}));

vi.mock("../hooks/use-stack-rank-reset", () => ({
  useStackRankReset: () => undefined,
}));

// The composed page's heavy children have their own coverage; doubled here so
// this suite asserts what the PAGE derives and hands down, not their internals.
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({
    breadcrumbs,
  }: {
    breadcrumbs: { label: string; href?: string }[];
  }) => (
    <div data-testid="page-header">
      {breadcrumbs.map((crumb) => (
        <span key={crumb.label}>{crumb.label}</span>
      ))}
    </div>
  ),
}));

vi.mock("@repo/app/documents/components/table/documents-view", () => ({
  DocumentsView: (props: {
    documents: unknown;
    sortPersistenceKey?: string | null;
    storageKey?: string | null;
    editHandlers?: RowEditHandlers;
    canReorderArtifacts?: boolean;
  }) => {
    documentsViewProps.push({
      documents: props.documents,
      sortPersistenceKey: props.sortPersistenceKey,
      storageKey: props.storageKey,
      editHandlers: props.editHandlers,
      canReorderArtifacts: props.canReorderArtifacts,
    });
    return <div data-testid="documents-view" />;
  },
}));

vi.mock("@repo/app/projects/components/project-artifact-list", () => ({
  ProjectArtifactList: (props: { tree: unknown }) => {
    projectArtifactListPropsMock(props);
    return <div data-testid="shared-project-tree" />;
  },
}));

// The filter/view controls only mount once the project HAS artifacts, and they
// reach for the auth-backed API client. Doubled so the composed-state tests
// exercise the page's own composition rather than the table toolbar's.
vi.mock("@repo/app/documents/components/table/filter-popover", () => ({
  FilterPopover: () => <div data-testid="filter-popover" />,
}));

vi.mock("@repo/app/documents/components/table/active-filters-bar", () => ({
  ActiveFiltersBar: () => null,
}));

vi.mock("@repo/app/documents/components/table/table-view-menu", () => ({
  TableViewMenu: () => null,
}));

vi.mock("@repo/app/tags/components/tag-picker", () => ({
  TagPicker: () => null,
}));

vi.mock("../components/overview-properties", () => ({
  OverviewProperties: () => <div data-testid="overview-properties" />,
}));

vi.mock("../components/project-active-sessions-status", () => ({
  ProjectActiveSessionsStatus: () => <div data-testid="active-sessions" />,
}));

vi.mock("../components/create-document-modal", () => ({
  CreateDocumentModal: () => null,
}));

vi.mock("@repo/app/issues/components/create-issue-modal", () => ({
  CreateIssueModal: () => null,
}));
vi.mock("@repo/app/projects/components/detail/create-document-modal", () => ({
  CreateDocumentModal: () => null,
}));
vi.mock(
  "@repo/app/projects/components/detail/project-active-sessions-status",
  () => ({
    ProjectActiveSessionsStatus: () => null,
  })
);
vi.mock("@repo/app/projects/components/detail/project-rename-dialog", () => ({
  ProjectRenameDialog: () => null,
}));

vi.mock("../components/project-rename-dialog", () => ({
  ProjectRenameDialog: () => null,
}));

describe("ProjectDetailPage", () => {
  beforeEach(() => {
    documentsViewProps.length = 0;
    projectFiltersDocuments.length = 0;
    updateDocumentMutateMock.mockReset();
    tabParamMock.mockReset();
    featureFlagGateMock.mockReset();
    unsetPriorityFlagMock.mockReset();
    portableFlagMock.mockReset();
    projectArtifactListPropsMock.mockReset();
    portableFlagMock.mockReturnValue(false);
    manualOrderingFlagMock.mockReset();
    placementCapabilityMock.mockReset();
    tabParamMock.mockReturnValue({ activeTab: "all", setActiveTab: vi.fn() });
    featureFlagGateMock.mockReturnValue({ enabled: false, isReady: true });
    // ISS-9665 closed default (ISS-4779): the page renders as it shipped.
    unsetPriorityFlagMock.mockReturnValue(false);
    manualOrderingFlagMock.mockReturnValue(false);
    placementCapabilityMock.mockReturnValue(false);
    useProjectMock.mockReset();
    useTeamMock.mockReset();
    useProjectTreeRootPagesMock.mockReset();
    useProjectTreeWithDetailsMock.mockReset();
    collectDocumentRowsFromTreeMock.mockReset();
    treeHasRenderableArtifactsMock.mockReset();
    replaceMock.mockReset();
    routeParamsMock.mockReset();
    searchParamsMock.mockReset();

    routeParamsMock.mockReturnValue({
      orgSlug: "acme",
      teamId: "team-1",
      projectId: "project-1",
    });
    searchParamsMock.mockReturnValue(new URLSearchParams());

    useProjectMock.mockReturnValue({
      data: PROJECT,
      isLoading: false,
      error: null,
    });
    useTeamMock.mockReturnValue({ data: TEAM, isLoading: false, error: null });
    useProjectTreeWithDetailsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    useProjectTreeRootPagesMock.mockReturnValue({
      data: undefined,
      hasNextPage: false,
      isError: false,
      isFetchingNextPage: false,
      isLoading: false,
      loadMore: vi.fn(),
      refetch: vi.fn(),
      refetchMerged: vi.fn(),
    });
    collectDocumentRowsFromTreeMock.mockReturnValue([]);
    treeHasRenderableArtifactsMock.mockReturnValue(false);
  });

  registerProjectDetailHierarchyHostTests({
    featureFlagGateMock,
    portableFlagMock,
    project: PROJECT,
    projectArtifactListPropsMock,
    renderPage: () => render(<ProjectDetailPage />),
    tabParamMock,
    useProjectTreeRootPagesMock,
    useProjectTreeWithDetailsMock,
  });

  test("keeps the production tree request legacy-shaped when its flag is off", () => {
    render(<ProjectDetailPage />);

    const baseRead = useProjectTreeWithDetailsMock.mock.calls.find(
      ([, options]) =>
        !(options as { filters?: { category?: string } } | undefined)?.filters
          ?.category
    );
    expect(baseRead?.[1]).not.toHaveProperty("filters.hierarchy");
  });

  test("surfaces the loader's own message when the project read is REJECTED", () => {
    useProjectMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Forbidden: not a member of this project"),
    });

    render(<ProjectDetailPage />);

    // The failure branch must say what failed. The panel-absence trap this
    // ticket names is asserting only that the table is gone — which is equally
    // true of loading and of a project that simply does not exist.
    expect(
      screen.getByText("Forbidden: not a member of this project")
    ).toBeInTheDocument();
    // ...and it must be the ERROR state, not the generic not-found copy that a
    // swallowed rejection would degrade into.
    expect(screen.queryByText("Project not found")).toBeNull();
    expect(screen.queryByTestId("documents-view")).toBeNull();
    expect(screen.queryByTestId("page-header")).toBeNull();
  });

  test("surfaces the team loader's message when the TEAM read is rejected", () => {
    // The page composes a project inside a team; a rejected team read leaves it
    // unable to build breadcrumbs, so it must report rather than render a
    // half-built shell with a missing crumb.
    useTeamMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Team unavailable"),
    });

    render(<ProjectDetailPage />);

    expect(screen.getByText("Team unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("page-header")).toBeNull();
  });

  test("says 'Project not found' — not a loader error — when the read SUCCEEDS with no project", () => {
    // A settled read that returned nothing is a different fact from a failed
    // read, and the user can act on it differently (bad link vs retry). The two
    // must not collapse onto one another.
    useProjectMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });

    render(<ProjectDetailPage />);

    expect(screen.getByText("Project not found")).toBeInTheDocument();
    expect(screen.queryByTestId("documents-view")).toBeNull();
  });

  test("claims neither 'not found' nor an error while the reads are still in flight", () => {
    // The failure mode a 23-fix page produces: an unresolved read rendering as
    // a settled negative. Loading must assert nothing about whether the project
    // exists.
    useProjectMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    render(<ProjectDetailPage />);

    expect(screen.queryByText("Project not found")).toBeNull();
    expect(screen.queryByTestId("documents-view")).toBeNull();
    expect(screen.queryByTestId("page-header")).toBeNull();
  });

  test("composes the header, sessions strip and artifact table for a project WITH artifacts", () => {
    const rows = [{ id: "doc-1", title: "Kickoff PRD" }];
    useProjectTreeWithDetailsMock.mockReturnValue({
      data: { nodes: [] },
      isLoading: false,
    });
    collectDocumentRowsFromTreeMock.mockReturnValue(rows);
    treeHasRenderableArtifactsMock.mockReturnValue(true);

    render(<ProjectDetailPage />);

    // The composed state names both the team and the project — the derived
    // breadcrumb pair is data only this branch produces.
    const header = screen.getByTestId("page-header");
    expect(header).toHaveTextContent("Platform");
    expect(header).toHaveTextContent("Apollo");
    expect(screen.getByTestId("documents-view")).toBeInTheDocument();
    expect(screen.getByTestId("active-sessions")).toBeInTheDocument();
    // The rows the page derived from the tree are the ones handed to the table —
    // asserted on the table's received prop, not merely on the adapter having
    // been called, so a page that derived rows and then rendered a different
    // list fails here.
    expect(collectDocumentRowsFromTreeMock).toHaveBeenCalledWith(
      { nodes: [] },
      expect.objectContaining({ id: "project-1", name: "Apollo" })
    );
    expect(documentsViewProps.at(-1)?.documents).toEqual(rows);
    // ISS-5540: the artifact-type switcher announces `radiogroup`, which ARIA
    // requires to have a name, and this one renders no visible label — so the
    // name has to be explicit or a screen-reader user gets six unexplained
    // options. Scoped with `within` so it asserts ownership of the radios, not
    // just that a named group exists somewhere on the page.
    const typeFilter = screen.getByRole("radiogroup", {
      name: "Filter by artifact type",
    });
    expect(
      within(typeFilter)
        .getAllByRole("radio")
        .map((radio) => radio.textContent)
    ).toEqual([
      "Overview",
      "All Artifacts",
      "PRDs",
      "Issues",
      "Plans",
      "Branches",
    ]);
  });

  test.each([
    ["flag-off stack rank remains available", false, false],
    ["manual hierarchy mounts without placement capability", true, false],
    ["manual hierarchy mounts with placement capability", true, true],
  ])("%s", (_name, flagEnabled, capability) => {
    manualOrderingFlagMock.mockReturnValue(flagEnabled);
    placementCapabilityMock.mockReturnValue(capability);
    render(<ProjectDetailPage />);
    expect(placementCapabilityMock).toHaveBeenCalledWith("project-1");
    if (flagEnabled) {
      expect(screen.getByTestId("shared-project-tree")).toBeInTheDocument();
      expect(screen.queryByTestId("documents-view")).not.toBeInTheDocument();
    } else {
      expect(documentsViewProps.at(-1)?.canReorderArtifacts).toBe(true);
    }
  });

  test("mounts the overview panel, and no artifact table, on the overview tab", () => {
    // The browser tier deep-links `?tab=overview` to reach this panel, because
    // the page defaults to `all` and the panel mounts on nothing else
    // (ISS-9441). This is the half of that chain a unit test can see: the tab
    // VALUE selecting the panel. The other half — `?tab=` resolving to that
    // value — is `use-tab-param.test.tsx`, since this suite mocks the hook.
    tabParamMock.mockReturnValue({
      activeTab: "overview",
      setActiveTab: vi.fn(),
    });
    useProjectTreeWithDetailsMock.mockReturnValue({
      data: { nodes: [] },
      isLoading: false,
    });
    treeHasRenderableArtifactsMock.mockReturnValue(true);

    render(<ProjectDetailPage />);

    expect(screen.getByTestId("overview-properties")).toBeInTheDocument();
    // The sibling negative, on a tree that DOES have renderable artifacts: the
    // panel replaces the table, so a page rendering both would satisfy the line
    // above on its own.
    expect(screen.queryByTestId("documents-view")).toBeNull();
  });

  test("still composes the page — not the error state — for a project with ZERO artifacts", () => {
    // The ticket's empty-state trap. A project that legitimately has no
    // artifacts must reach the composed page with an empty table, NOT fall
    // through to "Project not found", and NOT blank.
    useProjectTreeWithDetailsMock.mockReturnValue({
      data: { nodes: [] },
      isLoading: false,
    });
    collectDocumentRowsFromTreeMock.mockReturnValue([]);
    treeHasRenderableArtifactsMock.mockReturnValue(false);

    render(<ProjectDetailPage />);

    expect(screen.getByTestId("page-header")).toHaveTextContent("Apollo");
    expect(screen.getByTestId("documents-view")).toBeInTheDocument();
    expect(screen.queryByText("Project not found")).toBeNull();
    expect(documentsViewProps.at(-1)?.documents).toEqual([]);
  });

  test("ISS-9436: this table's status writes name the inline-cell surface", () => {
    useProjectTreeWithDetailsMock.mockReturnValue({
      data: { nodes: [] },
      isLoading: false,
    });
    collectDocumentRowsFromTreeMock.mockReturnValue([
      { id: "doc-1", title: "Kickoff PRD" },
    ]);
    treeHasRenderableArtifactsMock.mockReturnValue(true);

    render(<ProjectDetailPage />);

    documentsViewProps
      .at(-1)
      ?.editHandlers?.onUpdateStatus?.(
        "doc-1",
        DocumentStatus.InReview,
        ArtifactStatusEditSurface.InlineCell
      );

    expect(updateDocumentMutateMock).toHaveBeenCalledWith({
      id: "doc-1",
      status: DocumentStatus.InReview,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
  });

  test("ISS-10189: this table's PRIORITY writes name the inline-cell surface", () => {
    useProjectTreeWithDetailsMock.mockReturnValue({
      data: { nodes: [] },
      isLoading: false,
    });
    collectDocumentRowsFromTreeMock.mockReturnValue([
      { id: "doc-1", title: "Kickoff PRD" },
    ]);
    treeHasRenderableArtifactsMock.mockReturnValue(true);

    render(<ProjectDetailPage />);

    documentsViewProps
      .at(-1)
      ?.editHandlers?.onUpdatePriority?.("doc-1", Priority.High);

    expect(updateDocumentMutateMock).toHaveBeenCalledWith({
      id: "doc-1",
      priority: Priority.High,
      surface: "inline_cell",
    });
  });

  describe("stale team segment in the permalink", () => {
    /** The link was shared while the project lived in `team-old`. */
    function arriveOnStalePermalink() {
      routeParamsMock.mockReturnValue({
        orgSlug: "acme",
        teamId: "team-old",
        projectId: "project-1",
      });
      useProjectMock.mockReturnValue({
        data: { ...PROJECT, teams: [{ id: "team-new", name: "Infra" }] },
        isLoading: false,
        error: null,
      });
      // The old team is gone — `ProjectTeam` cascades on team delete — so the
      // team read fails while the org-scoped project read still succeeds.
      useTeamMock.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: new Error("Team not found"),
      });
    }

    test("redirects the reader to the project's current location", () => {
      arriveOnStalePermalink();

      render(<ProjectDetailPage />);

      expect(replaceMock).toHaveBeenCalledWith(
        "/acme/teams/team-new/projects/project-1"
      );
    });

    test("does not flash 'Project not found' over a project that exists", () => {
      // The failure this ticket reports is user-visible copy, not just a missing
      // navigation: the page must not assert a settled negative it is about to
      // contradict one tick later.
      arriveOnStalePermalink();

      render(<ProjectDetailPage />);

      expect(screen.queryByText("Project not found")).toBeNull();
      expect(screen.queryByText("Team not found")).toBeNull();
    });

    test("announces the wait instead of going silent", () => {
      // This branch used to render a sentence for a stale permalink. Swapping it
      // for a bare spinner would leave a screen-reader user with nothing at all,
      // so the in-flight state has to carry a name of its own.
      arriveOnStalePermalink();

      render(<ProjectDetailPage />);

      // Asserted on the live region's CONTENT, not its name: `status` is not
      // name-from-content, and what a live region announces is what it contains.
      expect(screen.getByRole("status")).toHaveTextContent("Loading project");
    });

    test("preserves the query string and the deep-link fragment", () => {
      arriveOnStalePermalink();
      searchParamsMock.mockReturnValue(new URLSearchParams("tab=issues"));
      const originalHash = globalThis.location.hash;
      globalThis.location.hash = "#risks";

      try {
        render(<ProjectDetailPage />);

        expect(replaceMock).toHaveBeenCalledWith(
          "/acme/teams/team-new/projects/project-1?tab=issues#risks"
        );
      } finally {
        globalThis.location.hash = originalHash;
      }
    });

    test("leaves a permalink that still names a current team alone", () => {
      // AC5's loop half, driven through the route: the destination of a redirect
      // must itself redirect nowhere, or the reader ping-pongs.
      useProjectMock.mockReturnValue({
        data: { ...PROJECT, teams: [{ id: "team-1", name: "Platform" }] },
        isLoading: false,
        error: null,
      });

      render(<ProjectDetailPage />);

      expect(replaceMock).not.toHaveBeenCalled();
      expect(screen.getByTestId("page-header")).toHaveTextContent("Apollo");
    });

    test("still reports a genuinely missing project instead of redirecting", () => {
      // AC5. A bad project id must keep telling the reader the record is not
      // there; a redirect rule broad enough to catch it would be a worse bug
      // than the one being fixed.
      routeParamsMock.mockReturnValue({
        orgSlug: "acme",
        teamId: "team-old",
        projectId: "project-that-does-not-exist",
      });
      useProjectMock.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: null,
      });

      render(<ProjectDetailPage />);

      expect(replaceMock).not.toHaveBeenCalled();
      expect(screen.getByText("Project not found")).toBeInTheDocument();
    });
  });
  describe("category-scoped read (whitlockk, PR #6745)", () => {
    const BASE_TREE = { nodes: [{ root: { id: "base" }, children: [] }] };
    const CATEGORY_TREE = {
      nodes: [{ root: { id: "category" }, children: [] }],
    };
    const BASE_ROWS = [{ id: "base-doc", title: "From the base read" }];
    const CATEGORY_ROWS = [{ id: "prd-past-the-bound", title: "A real PRD" }];

    /** The PRDs tab, with the pagination flag ON — where the category read fires. */
    function onPrdsTabWithPaginationOn() {
      tabParamMock.mockReturnValue({
        activeTab: "documents",
        setActiveTab: vi.fn(),
      });
      featureFlagGateMock.mockImplementation((key: string) => ({
        enabled: key === PROJECT_ARTIFACTS_PAGINATION_FEATURE_FLAG_KEY,
        isReady: true,
      }));
    }

    /**
     * Answer the two reads separately: the project-wide read has no `category`
     * filter, the category-scoped one does.
     */
    function splitTreeReads(categoryResult: Record<string, unknown>) {
      useProjectTreeWithDetailsMock.mockImplementation(
        (_projectId: unknown, options?: { filters?: { category?: string } }) =>
          options?.filters?.category
            ? categoryResult
            : {
                data: BASE_TREE,
                isLoading: false,
                isError: false,
                refetch: vi.fn(),
              }
      );
      collectDocumentRowsFromTreeMock.mockImplementation((tree: unknown) => {
        if (tree === CATEGORY_TREE) {
          return CATEGORY_ROWS;
        }
        if (tree === BASE_TREE) {
          return BASE_ROWS;
        }
        return [];
      });
      treeHasRenderableArtifactsMock.mockReturnValue(true);
    }

    test("renders the ERROR state, not an empty tab, when the category read fails", () => {
      onPrdsTabWithPaginationOn();
      splitTreeReads({
        data: undefined,
        isLoading: false,
        isError: true,
        refetch: vi.fn(),
      });

      render(<ProjectDetailPage />);

      expect(screen.getByText("Couldn't load artifacts")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Try again" })
      ).toBeInTheDocument();
      expect(screen.queryByTestId("documents-view")).toBeNull();
    });

    test("retries BOTH reads the tab depends on from the failure state", () => {
      onPrdsTabWithPaginationOn();
      const refetchCategory = vi.fn();
      const refetchBase = vi.fn();
      useProjectTreeWithDetailsMock.mockImplementation(
        (_projectId: unknown, options?: { filters?: { category?: string } }) =>
          options?.filters?.category
            ? {
                data: undefined,
                isLoading: false,
                isError: true,
                refetch: refetchCategory,
              }
            : {
                data: BASE_TREE,
                isLoading: false,
                isError: false,
                refetch: refetchBase,
              }
      );
      collectDocumentRowsFromTreeMock.mockReturnValue([]);
      treeHasRenderableArtifactsMock.mockReturnValue(true);

      render(<ProjectDetailPage />);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));

      expect(refetchCategory).toHaveBeenCalled();
      expect(refetchBase).toHaveBeenCalled();
    });

    test("renders the table, not the error state, when both reads SUCCEED with no rows", () => {
      onPrdsTabWithPaginationOn();
      splitTreeReads({
        data: { nodes: [] },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });

      render(<ProjectDetailPage />);

      expect(screen.getByTestId("documents-view")).toBeInTheDocument();
      expect(screen.queryByText("Couldn't load artifacts")).toBeNull();
    });

    test("drives the filter facets from the ACTIVE tab's corpus, not the project-wide read", () => {
      onPrdsTabWithPaginationOn();
      splitTreeReads({
        data: CATEGORY_TREE,
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });

      render(<ProjectDetailPage />);

      expect(documentsViewProps.at(-1)?.documents).toEqual(CATEGORY_ROWS);
      expect(projectFiltersDocuments.at(-1)).toEqual(CATEGORY_ROWS);
    });

    test("leaves the facets on the project-wide corpus for the All tab", () => {
      splitTreeReads({
        data: undefined,
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });

      render(<ProjectDetailPage />);

      expect(projectFiltersDocuments.at(-1)).toEqual(BASE_ROWS);
    });
  });
});

describe("ISS-9726 persisted view-state wiring", () => {
  beforeEach(() => {
    viewStatePersistenceKeys.length = 0;
    scrollRestoreKeys.length = 0;
    projectFiltersPersistenceKeys.length = 0;
    documentsViewProps.length = 0;
    paginationKeysSpy.mockClear();
    columnVisibilityOptionsSpy.mockClear();
    tabParamMock.mockReturnValue({ activeTab: "all", setActiveTab: vi.fn() });
    featureFlagGateMock.mockReturnValue({ enabled: false, isReady: true });
    unsetPriorityFlagMock.mockReturnValue(false);
    manualOrderingFlagMock.mockReturnValue(false);
    placementCapabilityMock.mockReturnValue(false);
    routeParamsMock.mockReturnValue({
      orgSlug: "acme",
      teamId: "team-1",
      projectId: "project-1",
    });
    searchParamsMock.mockReturnValue(new URLSearchParams());
    useProjectMock.mockReturnValue({
      data: PROJECT,
      isLoading: false,
      error: null,
    });
    useTeamMock.mockReturnValue({ data: TEAM, isLoading: false, error: null });
    useProjectTreeWithDetailsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    collectDocumentRowsFromTreeMock.mockReturnValue([
      { id: "doc-1", title: "An artifact" },
    ]);
    treeHasRenderableArtifactsMock.mockReturnValue(true);
  });

  test("addresses the identity-namespaced column keys, not the raw base literals", () => {
    render(<ProjectDetailPage />);

    expect(columnVisibilityOptionsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: "ns::table:columns:project-artifacts",
        orderStorageKey: "ns::table:column-order:project-artifacts",
      })
    );
  });

  test("namespaces the project-suffixed siblings too, which a project id alone did not separate by USER", () => {
    render(<ProjectDetailPage />);

    expect(viewStatePersistenceKeys).toContain(
      "ns::table:search:project-artifacts:project-1"
    );
    expect(viewStatePersistenceKeys).toContain(
      "ns::table:sort:project-artifacts:project-1"
    );
    expect(scrollRestoreKeys).toContain(
      "ns::table:scroll:project-artifacts:project-1:all"
    );
    expect(projectFiltersPersistenceKeys).toContain(
      "ns::table:filters:project-artifacts:project-1"
    );
    expect(paginationKeysSpy).toHaveBeenCalledWith({
      pageSizeStorageKey: "ns::table:page-size:project-artifacts:project-1",
      sortPersistenceKey: "ns::table:sort:project-artifacts:project-1",
    });
    expect(documentsViewProps.at(-1)).toMatchObject({
      sortPersistenceKey: "ns::table:sort:project-artifacts:project-1",
      storageKey: "ns::project-artifacts:project-1",
    });
  });

  test("lets no raw persistence key reach a storage hook", () => {
    render(<ProjectDetailPage />);

    const everyKey = [
      ...viewStatePersistenceKeys,
      ...scrollRestoreKeys,
      ...projectFiltersPersistenceKeys,
    ];
    expect(everyKey.length).toBeGreaterThan(0);
    const unnamespaced = everyKey.filter(
      (key) => typeof key === "string" && !key.startsWith("ns::")
    );
    expect(unnamespaced).toEqual([]);
  });
});
