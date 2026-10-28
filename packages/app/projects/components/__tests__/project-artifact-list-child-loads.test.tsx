import { LinkType } from "@repo/api/src/types/artifact";
import {
  HierarchyAvailability,
  type ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_ARTIFACT_LIST_RETRY_LABEL } from "../../lib/project-artifact-list-copy";
import {
  artifact,
  firstId,
  mountProjectArtifactList as mount,
  projectArtifactListMocks,
  resetProjectArtifactListMocks,
  secondId,
  tree,
} from "./support/project-artifact-list-live-harness";

const batch = vi.hoisted(() => ({ queries: vi.fn() }));

vi.mock("../../hooks/use-project-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/use-project-tree")>()),
  useProjectTreeExpansionBatch: (...args: unknown[]) => batch.queries(...args),
}));

const mocks = projectArtifactListMocks();

beforeEach(() => {
  resetProjectArtifactListMocks();
  batch.queries.mockReset();
  batch.queries.mockReturnValue([]);
});

/** A root whose first child page carried one of its two children. */
const PARTIAL_PARENT_TREE: ProjectTreeDetailsResponse = {
  ...tree,
  nodes: [
    {
      root: artifact(firstId, "Parent"),
      hierarchy: {
        availability: HierarchyAvailability.Partial,
        childCount: 2,
      },
      children: [
        {
          ...artifact(secondId, "Loaded child"),
          parentId: firstId,
          linkType: LinkType.Produces,
          depth: 1,
        },
      ],
    },
  ],
  hierarchy: {
    contractVersion: 1,
    capabilities: {
      childPaging: true,
      exactPlacement: true,
      maxVisibleLevels: 4,
      mutationVersion: "version-1",
    },
    diagnostics: [],
    diagnosticsComplete: true,
  },
};

function parentRow(): HTMLElement {
  // The row names its artifact twice (ID and title); either text finds the row.
  const row = screen
    .getAllByText("Parent")[0]
    ?.closest<HTMLElement>("[data-grid-row]");
  if (!row) {
    throw new Error("Expected the parent treegrid row");
  }
  return row;
}

describe("ProjectArtifactList child page loading (ISS-12929 726-F5/F6)", () => {
  it("records the opened parent in the link and retries its failed child read", async () => {
    const refetch = vi.fn();
    batch.queries.mockImplementation((_projectId, parentIds: string[]) =>
      parentIds.map(() => ({ isError: true, refetch }))
    );
    mocks.flagEnabled = true;
    mocks.realView = true;
    const navigation = mount("group=none", PARTIAL_PARENT_TREE);

    fireEvent.click(
      within(parentRow()).getByRole("button", { name: "Expand row" })
    );

    await waitFor(() =>
      expect(navigation.getCurrentHref()).toContain(
        `hierarchyExpanded=${firstId}`
      )
    );
    expect(batch.queries).toHaveBeenLastCalledWith(expect.any(String), [
      firstId,
    ]);
    const retry = await within(parentRow()).findByRole("button", {
      name: PROJECT_ARTIFACT_LIST_RETRY_LABEL,
    });
    fireEvent.click(retry);
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("asks for no child page while every parent is closed", () => {
    mocks.flagEnabled = true;
    mocks.realView = true;
    mount("group=none", PARTIAL_PARENT_TREE);

    expect(batch.queries).not.toHaveBeenCalled();
    expect(
      within(parentRow()).queryByRole("button", {
        name: PROJECT_ARTIFACT_LIST_RETRY_LABEL,
      })
    ).toBeNull();
  });
});
