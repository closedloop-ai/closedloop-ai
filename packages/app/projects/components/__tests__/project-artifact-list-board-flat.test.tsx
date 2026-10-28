import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { ProjectTreeDetailsResponse } from "@repo/api/src/types/project-tree";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenericArtifactListView } from "../../../shared/components/generic-artifact-surface/preview/components/artifact-shells";
import { ProjectArtifactList } from "../project-artifact-list";

type ListViewProps = ComponentProps<typeof GenericArtifactListView>;

const mocks = vi.hoisted(() => ({
  board: vi.fn(),
  view: vi.fn(),
  matches: vi.fn(),
  costs: vi.fn(),
}));

vi.mock("../../../shared/feature-flags/use-manual-artifact-ordering", () => ({
  useManualArtifactOrderingEnabled: () => true,
}));
vi.mock("../../hooks/use-artifact-placement", () => ({
  useArtifactPlacement: () => ({ mutateAsync: vi.fn() }),
  useArtifactPlacementCapability: () => true,
}));
vi.mock("../../hooks/use-project-artifact-group-updates", () => ({
  useProjectArtifactGroupUpdates: () => ({
    update: { mutate: vi.fn() },
    applyGroupUpdates: vi.fn(),
  }),
}));
vi.mock("../../hooks/use-project-hierarchy-transaction", () => ({
  useProjectHierarchyTransaction: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock(
  "../../../shared/components/generic-artifact-surface/preview/components/artifact-shells",
  () => ({
    GenericArtifactListView: (props: ListViewProps) => {
      mocks.view(props);
      return null;
    },
  })
);
vi.mock("../../../documents/hooks/use-documents", () => ({
  useCreateDocument: () => ({ mutateAsync: vi.fn() }),
  useUpdateDocument: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../../documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({ data: [] }),
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../../documents/components/favorite-button", () => ({
  FavoriteButton: () => null,
}));
vi.mock("../../../users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: undefined }),
}));
vi.mock("../../../teams/hooks/use-team-members", () => ({
  useTeamMembers: () => ({ members: [] }),
}));
vi.mock("../../hooks/use-projects", () => ({
  useProjectsByTeam: () => ({ data: [] }),
}));
vi.mock("../../hooks/use-project-artifact-view-state-key", () => ({
  useProjectArtifactViewStateKey: () => null,
}));
vi.mock(
  "../../../documents/components/documents-prototype-custom-fields",
  () => ({
    documentCustomFieldCreationValues: () => ({}),
    useDocumentsPrototypeCustomFields: () => ({
      columns: [],
      renderCell: () => undefined,
      renderDialog: () => null,
    }),
  })
);
vi.mock("../../../documents/hooks/use-related-sessions", () => ({
  useRelatedSessionsMatches: mocks.matches,
  useRelatedSessionsSearch: () => ({ data: undefined }),
}));
vi.mock("../../../documents/hooks/use-documents-costs", () => ({
  useDocumentsCosts: mocks.costs,
}));
vi.mock("../../hooks/use-project-artifact-list-metadata", () => ({
  useProjectArtifactListMetadata: () => ({
    peopleByArtifactId: new Map(),
    peopleReads: { documents: { isLoading: false } },
    relatedSessions: { data: { results: {} }, isLoading: false },
  }),
}));
vi.mock("../project-artifact-list-board", () => ({
  ProjectArtifactListBoard: (props: unknown) => {
    mocks.board(props);
    return <div data-testid="project-artifact-board" />;
  },
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const parentId = "22222222-2222-4222-8222-222222222222";
const childId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-19T12:00:00Z");
const project = {
  id: projectId,
  organizationId: "44444444-4444-4444-8444-444444444444",
  name: "Hierarchy",
  description: null,
  priority: null,
  status: ProjectStatus.InProgress,
  assigneeId: null,
  createdById: "55555555-5555-4555-8555-555555555555",
  slug: "PRO-726",
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
const artifact = (id: string, name: string) => ({
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
const tree: ProjectTreeDetailsResponse = {
  nodes: [
    {
      root: artifact(parentId, "Parent"),
      children: [
        {
          ...artifact(childId, "Child"),
          parentId,
          linkType: LinkType.Produces,
          depth: 1,
        },
      ],
    },
  ],
  externalParents: [],
  projectVersion: "board-flat-version",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.matches.mockReturnValue({
    data: { matchingArtifactIds: [] },
    isFetching: false,
    isError: false,
  });
  mocks.costs.mockReturnValue({
    data: { totalEstimatedCost: 0, medianEstimatedCost: null },
    isLoading: false,
    isError: false,
  });
});

describe("ProjectArtifactList board isolation", () => {
  it("mounts the roots-only board instead of the hierarchy list when manual ordering is enabled", () => {
    const navigation = createMemoryNavigation({
      initialPath: `/teams/team/projects/${projectId}?group=status&layout=board`,
      orgSlug: "org",
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <NavigationProvider adapter={navigation.adapter}>
          <ProjectArtifactList
            failed={false}
            loading={false}
            onRefresh={async () => tree}
            onRequestCreate={() => undefined}
            onRetry={() => undefined}
            project={project}
            teamId="team"
            tree={tree}
          />
        </NavigationProvider>
      </QueryClientProvider>
    );

    expect(mocks.board).toHaveBeenCalledWith(
      expect.objectContaining({ project, teamId: "team" })
    );
    expect(screen.getByTestId("project-artifact-board")).toBeInTheDocument();
  });
});
