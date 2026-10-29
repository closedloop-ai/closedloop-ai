import { ArtifactType } from "@repo/api/src/types/artifact";
import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import { screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

type Spy = ReturnType<typeof vi.fn>;

/** Keep the legacy and portable production-host matrix in one regression set. */
export function registerProjectDetailHierarchyHostTests({
  featureFlagGateMock,
  portableFlagMock,
  project,
  projectArtifactListPropsMock,
  renderPage,
  tabParamMock,
  useProjectTreeRootPagesMock,
  useProjectTreeWithDetailsMock,
}: {
  featureFlagGateMock: Spy;
  portableFlagMock: Spy;
  project: unknown;
  projectArtifactListPropsMock: Spy;
  renderPage: () => void;
  tabParamMock: Spy;
  useProjectTreeRootPagesMock: Spy;
  useProjectTreeWithDetailsMock: Spy;
}) {
  const enableHierarchy = () =>
    featureFlagGateMock.mockImplementation((key: string) => ({
      enabled: key === MANUAL_ARTIFACT_ORDERING_FLAG_KEY,
      isReady: true,
    }));
  const hierarchyTree = {
    nodes: [],
    externalParents: [],
    projectVersion: "version-1",
  };
  const setHierarchyTree = () =>
    useProjectTreeRootPagesMock.mockReturnValue({
      data: hierarchyTree,
      hasNextPage: false,
      isError: false,
      isFetchingNextPage: false,
      isLoading: false,
      loadMore: vi.fn(),
      refetch: vi.fn(),
      refetchMerged: vi.fn().mockResolvedValue(hierarchyTree),
    });

  test("requests hierarchy metadata from the production host when its flag is on", () => {
    enableHierarchy();
    renderPage();
    expect(featureFlagGateMock).toHaveBeenCalledWith(
      MANUAL_ARTIFACT_ORDERING_FLAG_KEY
    );
    expect(useProjectTreeRootPagesMock).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ enabled: true })
    );
    expect(useProjectTreeWithDetailsMock).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ enabled: false })
    );
  });

  test.each([
    { portable: false, host: "legacy" },
    { portable: true, host: "portable" },
  ])(
    "mounts the same shared tree in the $host Project Detail host",
    ({ portable }) => {
      portableFlagMock.mockReturnValue(portable);
      enableHierarchy();
      setHierarchyTree();
      renderPage();
      expect(screen.getByTestId("shared-project-tree")).toBeInTheDocument();
      expect(screen.queryByTestId("documents-view")).not.toBeInTheDocument();
      expect(projectArtifactListPropsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          project,
          tree: hierarchyTree,
          category: "all",
        })
      );
      if (portable) {
        expect(useProjectTreeWithDetailsMock).toHaveBeenCalledWith(
          "project-1",
          expect.objectContaining({ enabled: false })
        );
      }
    }
  );

  test("holds both tree paths while the hierarchy flag is unresolved", () => {
    featureFlagGateMock.mockImplementation((key: string) => ({
      enabled: false,
      isReady: key !== MANUAL_ARTIFACT_ORDERING_FLAG_KEY,
    }));
    renderPage();
    expect(useProjectTreeWithDetailsMock).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ enabled: false })
    );
    expect(useProjectTreeRootPagesMock).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ enabled: false })
    );
    expect(screen.queryByTestId("documents-view")).not.toBeInTheDocument();
  });

  test("keeps a depth-five issue in the flat Issues tab with ordering on", () => {
    const depthFiveIssue = {
      depth: 5,
      id: "ISS-3",
      type: ArtifactType.Document,
      title: "QA L5",
    };
    const flatCategoryTree = {
      nodes: [{ root: depthFiveIssue, children: [] }],
      externalParents: [],
    };
    portableFlagMock.mockReturnValue(true);
    enableHierarchy();
    tabParamMock.mockReturnValue({
      activeTab: "issues",
      setActiveTab: vi.fn(),
    });
    useProjectTreeWithDetailsMock.mockReturnValue({
      data: flatCategoryTree,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderPage();
    expect(projectArtifactListPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "issues",
        tree: flatCategoryTree,
      })
    );
    expect(useProjectTreeRootPagesMock).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ enabled: false })
    );
  });

  test("loads the next hierarchy root page from the production host", () => {
    const loadMore = vi.fn();
    enableHierarchy();
    useProjectTreeRootPagesMock.mockReturnValue({
      data: undefined,
      hasNextPage: true,
      isError: false,
      isFetchingNextPage: false,
      isLoading: false,
      loadMore,
      refetch: vi.fn(),
    });
    renderPage();
    const listProps = projectArtifactListPropsMock.mock.lastCall?.[0] as {
      hasMoreRootPages: boolean;
      loadMoreRootPages: () => void;
    };
    expect(listProps.hasMoreRootPages).toBe(true);
    listProps.loadMoreRootPages();
    expect(loadMore).toHaveBeenCalledOnce();
  });
}
