import { ArtifactType } from "@repo/api/src/types/artifact";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  artifact,
  currentProjectArtifactListView as currentView,
  firstId,
  mountProjectArtifactList as mount,
  projectArtifactListMocks,
  resetProjectArtifactListMocks,
  secondId,
  tree,
} from "./support/project-artifact-list-live-harness";

const mocks = projectArtifactListMocks();

const DOCUMENT_SLUG = "ISS-4401";
const BRANCH_SLUG = "BR-4410";
const KIND_ICON_SELECTOR = 'svg[class*="size-3.5"]';

const slugTree = {
  ...tree,
  nodes: [
    {
      root: { ...artifact(firstId, "Alpha doc"), slug: DOCUMENT_SLUG },
      children: [],
    },
    {
      root: {
        ...artifact(secondId, "Beta branch"),
        type: ArtifactType.Branch,
        subtype: null,
        slug: BRANCH_SLUG,
      },
      children: [],
    },
  ],
};

beforeEach(resetProjectArtifactListMocks);

// Fixes ship for everyone (ISS-13035, R-PD-TREE-DEFAULT, R-NO-HEADER-SELECT-ALL):
// every case below runs with projects-portable-surface OFF.
describe("Project Detail fixes that ship with projects-portable-surface off", () => {
  it("FIX-1 an untouched group opens on None with manual ordering on", () => {
    mocks.flagEnabled = true;
    mount("");

    expect(currentView().controller.groupBy).toBe("none");
  });

  it("FIX-2 an untouched group opens on Status with manual ordering off", () => {
    mocks.flagEnabled = false;
    mount("");

    expect(currentView().controller.groupBy).toBe("status");
  });

  it("FIX-3 the manual-ordering tree has no row checkboxes and no header select-all", async () => {
    mocks.flagEnabled = true;
    mocks.realView = true;
    mount("group=none");

    await screen.findByTestId("project-hierarchy-host");
    expect(screen.queryByRole("checkbox", { name: "Select First" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Select all" })).toBeNull();
  });

  it.each(["status", "owner"])(
    "FIX-4 a chosen Group of %s renders group headers, not a flat tree, with manual ordering on",
    async (group) => {
      mocks.flagEnabled = true;
      mocks.realView = true;
      mount(`group=${group}`);

      await waitFor(() =>
        expect(
          document.querySelectorAll("[data-grid-group-header]").length
        ).toBeGreaterThan(0)
      );
      expect(screen.queryByTestId("project-hierarchy-host")).toBeNull();
    }
  );

  it("FLAG-1 non-document board titles carry no kind icon lead", () => {
    mocks.flagEnabled = true;
    mount("group=none", slugTree);

    const view = currentView();
    const branchRow = view.controller.matchingArtifacts.find(
      (row) => row.id === secondId
    );
    if (!branchRow) {
      throw new Error("Expected the branch row");
    }
    const { container } = renderNode(
      view.host.renderBoardTitle?.(branchRow, "/branch")
    );
    expect(container.querySelector(KIND_ICON_SELECTOR)).toBeNull();
  });

  it("FLAG-2 a non-document tree row shows its ID but no kind icon", async () => {
    mocks.flagEnabled = true;
    mocks.realView = true;
    mount("group=none", slugTree);

    const host = await screen.findByTestId("project-hierarchy-host");
    const branchRow = within(host)
      .getAllByText(BRANCH_SLUG)[0]
      ?.closest("[data-grid-row]");
    expect(branchRow).not.toBeNull();
    expect(branchRow?.querySelector(KIND_ICON_SELECTOR)).toBeNull();
  });
});

describe("Project Detail behind projects-portable-surface (PPS)", () => {
  it("PPS-ON-1 non-document tree rows draw the kind icon before the ID", async () => {
    mocks.portableSurfaceEnabled = true;
    mocks.flagEnabled = true;
    mocks.realView = true;
    mount("group=none", slugTree);

    const host = await screen.findByTestId("project-hierarchy-host");
    const branchRow = within(host)
      .getAllByText(BRANCH_SLUG)[0]
      ?.closest("[data-grid-row]");
    expect(branchRow?.querySelector(KIND_ICON_SELECTOR)).not.toBeNull();
  });

  it("PPS-ON-2 non-document board titles draw the kind icon", () => {
    mocks.portableSurfaceEnabled = true;
    mocks.flagEnabled = true;
    mount("group=none", slugTree);

    const view = currentView();
    const branchRow = view.controller.matchingArtifacts.find(
      (row) => row.id === secondId
    );
    if (!branchRow) {
      throw new Error("Expected the branch row");
    }
    const { container } = renderNode(
      view.host.renderBoardTitle?.(branchRow, "/branch")
    );
    expect(container.querySelector(KIND_ICON_SELECTOR)).not.toBeNull();
  });
});

describe("tree rows show the artifact ID in every mode", () => {
  it.each([
    ["PPS off, manual ordering off, flat", false, false, "group=status", false],
    ["PPS off, manual ordering on, tree", false, true, "group=none", true],
    ["PPS on, manual ordering off, flat", true, false, "group=status", true],
    [
      "PPS on, manual ordering on, grouped grid",
      true,
      true,
      "group=status",
      true,
    ],
    ["PPS on, manual ordering on, tree", true, true, "group=none", true],
  ])(
    "SLUG-1 %s shows the artifact IDs",
    async (_name, portable, manualOrdering, query, branchSlugShown) => {
      mocks.portableSurfaceEnabled = portable;
      mocks.flagEnabled = manualOrdering;
      mocks.realView = true;
      mount(query, slugTree);

      await waitFor(() =>
        expect(screen.getAllByText(DOCUMENT_SLUG).length).toBeGreaterThan(0)
      );
      if (branchSlugShown) {
        expect(screen.getAllByText(BRANCH_SLUG).length).toBeGreaterThan(0);
      }
    }
  );

  it("SLUG-2 board card titles stay slug-free", () => {
    mocks.portableSurfaceEnabled = true;
    mocks.flagEnabled = true;
    mount("group=none", slugTree);

    const view = currentView();
    const documentRow = view.controller.matchingArtifacts.find(
      (row) => row.id === firstId
    );
    if (!documentRow) {
      throw new Error("Expected the document row");
    }
    const board = renderNode(view.host.renderBoardTitle?.(documentRow, "/doc"));
    expect(within(board.container).queryByText(DOCUMENT_SLUG)).toBeNull();
  });
});

function renderNode(node: ReactNode) {
  const navigation = createMemoryNavigation({
    initialPath: "/teams/team/projects/p",
    orgSlug: "org",
  });
  return render(
    <NavigationProvider adapter={navigation.adapter}>{node}</NavigationProvider>
  );
}
