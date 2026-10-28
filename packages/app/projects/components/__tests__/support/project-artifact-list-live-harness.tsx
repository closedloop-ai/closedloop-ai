import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { ProjectTreeDetailsResponse } from "@repo/api/src/types/project-tree";
import {
  createMemoryNavigation,
  type MemoryNavigation,
} from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { type Mock, vi } from "vitest";
import type { GenericArtifactListView } from "../../../../shared/components/generic-artifact-surface/preview/components/artifact-shells";
import type * as StatusBoardModule from "../../../../shared/components/generic-artifact-surface/preview/components/artifact-status-board";
import { FeatureFlagAdapterProvider } from "../../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../../shared/feature-flags/static-feature-flag-adapter";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { ProjectArtifactList } from "../../project-artifact-list";

export type ListViewProps = ComponentProps<typeof GenericArtifactListView>;
export type BoardProps = ComponentProps<
  typeof StatusBoardModule.ArtifactStatusBoard
>;

type ProjectArtifactListMocks = {
  applyTag: Mock;
  board: Mock;
  capability: Mock;
  costs: Mock;
  create: Mock;
  deleteDocuments: Mock;
  customFields: {
    columns: readonly never[];
    renderCell: () => undefined;
    renderDialog: () => null;
  };
  favoriteArtifactIds: string[];
  flagEnabled: boolean;
  hierarchyTransaction: Mock;
  matches: Mock;
  mergeDocuments: Mock;
  portableSurfaceEnabled: boolean;
  metadata: {
    peopleByArtifactId: Map<string, never>;
    peopleReads: {
      branches: { isLoading: boolean };
      documents: { isLoading: boolean };
      sessions: { isLoading: boolean };
    };
    relatedSessions: {
      data: { results: Record<string, never> };
      isLoading: boolean;
    };
  };
  placement: Mock;
  portableBoard: Mock;
  realView: boolean;
  removeTag: Mock;
  update: Mock;
  view: Mock<(props: ListViewProps) => void>;
};

const mocks: ProjectArtifactListMocks = vi.hoisted(() => ({
  favoriteArtifactIds: [],
  flagEnabled: false,
  portableSurfaceEnabled: false,
  capability: vi.fn(),
  placement: vi.fn(),
  hierarchyTransaction: vi.fn(),
  applyTag: vi.fn(),
  removeTag: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  deleteDocuments: vi.fn(),
  costs: vi.fn(),
  matches: vi.fn(),
  mergeDocuments: vi.fn(),
  view: vi.fn<(props: ListViewProps) => void>(),
  board: vi.fn(),
  portableBoard: vi.fn(),
  realView: false,
  customFields: {
    columns: [],
    renderCell: () => undefined,
    renderDialog: () => null,
  },
  metadata: {
    peopleByArtifactId: new Map<string, never>(),
    peopleReads: {
      branches: { isLoading: false },
      documents: { isLoading: false },
      sessions: { isLoading: false },
    },
    relatedSessions: { data: { results: {} }, isLoading: false },
  },
}));

export function projectArtifactListMocks(): typeof mocks {
  return mocks;
}

vi.mock(
  "../../../../shared/feature-flags/use-manual-artifact-ordering",
  () => ({
    useManualArtifactOrderingEnabled: () => mocks.flagEnabled,
  })
);
vi.mock("../../../hooks/use-artifact-placement", () => ({
  useArtifactPlacement: () => ({ mutateAsync: mocks.placement }),
  useArtifactPlacementCapability: (projectId: string) =>
    mocks.capability(projectId),
}));
vi.mock("../../../hooks/use-project-hierarchy-transaction", () => ({
  useProjectHierarchyTransaction: () => ({
    mutateAsync: mocks.hierarchyTransaction,
  }),
}));
vi.mock("../../../../tags/hooks/use-tags", () => ({
  useApplyTag: () => ({ mutateAsync: mocks.applyTag }),
  useRemoveTag: () => ({ mutateAsync: mocks.removeTag }),
}));
vi.mock(
  "../../../../shared/components/generic-artifact-surface/preview/components/artifact-shells",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../shared/components/generic-artifact-surface/preview/components/artifact-shells")
      >();
    return {
      GenericArtifactListView: (props: ListViewProps) => {
        mocks.view(props);
        return mocks.realView ? (
          <actual.GenericArtifactListView {...props} />
        ) : (
          <div data-testid="project-artifact-list" />
        );
      },
    };
  }
);
vi.mock(
  "../../../../shared/components/generic-artifact-surface/preview/components/artifact-status-board",
  async (importOriginal) => {
    const actual = await importOriginal<typeof StatusBoardModule>();
    return {
      ...actual,
      ArtifactStatusBoard: (props: BoardProps) => {
        mocks.board(props);
        return <actual.ArtifactStatusBoard {...props} />;
      },
    };
  }
);
vi.mock("../../project-artifact-list-board", () => ({
  ProjectArtifactListBoard: (props: unknown) => {
    mocks.portableBoard(props);
    return <div data-testid="project-artifact-board" />;
  },
}));
vi.mock("../../../../documents/hooks/use-documents", () => ({
  useBatchDeleteDocuments: () => ({
    isPending: false,
    mutateAsync: mocks.deleteDocuments,
  }),
  useCreateDocument: () => ({ mutateAsync: mocks.create }),
  useMergeDocuments: () => ({
    isPending: false,
    mutateAsync: mocks.mergeDocuments,
  }),
  useUpdateDocument: () => ({ mutate: mocks.update }),
}));
vi.mock("../../../../documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({
    data: mocks.favoriteArtifactIds.map((id) => ({ id })),
  }),
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../../../documents/components/favorite-button", () => ({
  FavoriteButton: () => null,
}));
vi.mock("../../../../users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: undefined }),
}));
vi.mock("../../../../teams/hooks/use-team-members", () => ({
  useTeamMembers: () => ({ members: [] }),
}));
vi.mock("../../../hooks/use-projects", () => ({
  useProjectsByTeam: () => ({ data: [] }),
}));
vi.mock("../../../hooks/use-project-artifact-view-state-key", () => ({
  useProjectArtifactViewStateKey: () => null,
}));
vi.mock(
  "../../../../documents/components/documents-prototype-custom-fields",
  () => ({
    documentCustomFieldCreationValues: () => ({}),
    useDocumentsPrototypeCustomFields: () => mocks.customFields,
  })
);
vi.mock("../../../../documents/hooks/use-related-sessions", () => ({
  useRelatedSessionsMatches: mocks.matches,
  useRelatedSessionsSearch: () => ({ data: undefined }),
}));
vi.mock("../../../../documents/hooks/use-documents-costs", () => ({
  useDocumentsCosts: mocks.costs,
}));
vi.mock("../../../hooks/use-project-artifact-list-metadata", () => ({
  useProjectArtifactListMetadata: () => mocks.metadata,
}));

export const projectId = "11111111-1111-4111-8111-111111111111";
export const firstId = "22222222-2222-4222-8222-222222222222";
export const secondId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-19T12:00:00Z");
export const project = {
  id: projectId,
  organizationId: "44444444-4444-4444-8444-444444444444",
  name: "Manual artifact ordering",
  description: null,
  priority: null,
  status: ProjectStatus.InProgress,
  assigneeId: null,
  createdById: "55555555-5555-4555-8555-555555555555",
  slug: "PRO-725",
  targetDate: null,
  codebaseSummary: null,
  lastIndexedAt: null,
  settings: {},
  sortOrder: null,
  createdAt: now,
  updatedAt: now,
  completionPercentage: 0,
  teams: [],
};

export const artifact = (id: string, name: string) => ({
  id,
  organizationId: project.organizationId,
  projectId,
  type: ArtifactType.Document,
  subtype: ArtifactSubtype.Feature,
  name,
  slug: name,
  status: IssueStatus.Todo,
  priority: null,
  assigneeId: null,
  assignee: null,
  dueDate: null,
  externalUrl: null,
  sortOrder: 0,
  createdById: project.createdById,
  createdAt: now,
  updatedAt: now,
});

export const childArtifact = (
  id: string,
  name: string,
  parentId: string,
  depth: number
) => ({ ...artifact(id, name), parentId, linkType: LinkType.Produces, depth });

export const tree: ProjectTreeDetailsResponse = {
  nodes: [
    { root: artifact(firstId, "First"), children: [] },
    { root: artifact(secondId, "Second"), children: [] },
  ],
  externalParents: [],
  projectVersion: "version-from-rendered-tree",
  hierarchyRevision: "hierarchy-from-rendered-tree",
};

export function mountProjectArtifactList(
  query = "group=none",
  source: ProjectTreeDetailsResponse = tree,
  category: ComponentProps<typeof ProjectArtifactList>["category"] = "all",
  createNavigation: (initialPath: string) => MemoryNavigation = (initialPath) =>
    createMemoryNavigation({ initialPath, orgSlug: "org" })
) {
  const navigation = createNavigation(
    `/teams/team/projects/${projectId}?${query}`
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = () => (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: mocks.portableSurfaceEnabled
          ? [PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <QueryClientProvider client={queryClient}>
        <NavigationProvider adapter={navigation.adapter}>
          <ProjectArtifactList
            category={category}
            failed={false}
            loading={false}
            onRefresh={async () => tree}
            onRequestCreate={() => undefined}
            onRetry={() => undefined}
            project={project}
            teamId="team"
            tree={source}
          />
        </NavigationProvider>
      </QueryClientProvider>
    </FeatureFlagAdapterProvider>
  );
  const mounted = render(ui());
  // Re-renders the same tree, for a flag that resolves after mount.
  return Object.assign(navigation, { rerender: () => mounted.rerender(ui()) });
}

export function currentProjectArtifactListView(): ListViewProps {
  const view = mocks.view.mock.lastCall?.[0];
  if (!view) {
    throw new Error("Expected the project artifact list view");
  }
  return view;
}

export function resetProjectArtifactListMocks() {
  vi.clearAllMocks();
  mocks.favoriteArtifactIds = [];
  mocks.flagEnabled = false;
  mocks.portableSurfaceEnabled = false;
  mocks.capability.mockReturnValue(true);
  mocks.realView = false;
  mocks.placement.mockResolvedValue({ placed: true });
  mocks.hierarchyTransaction.mockResolvedValue({ changedArtifactIds: [] });
  mocks.applyTag.mockResolvedValue({ applied: true });
  mocks.deleteDocuments.mockResolvedValue({ failedIds: [] });
  mocks.mergeDocuments.mockResolvedValue({});
  mocks.removeTag.mockResolvedValue({ removed: true });
  mocks.matches.mockReturnValue({
    data: { matchingArtifactIds: [secondId] },
    isFetching: false,
    isError: false,
  });
  mocks.costs.mockReturnValue({
    data: { totalEstimatedCost: 0, medianEstimatedCost: null },
    isLoading: false,
    isError: false,
  });
}
