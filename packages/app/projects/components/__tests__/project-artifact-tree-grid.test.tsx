import { HierarchyAvailability } from "@repo/api/src/types/project-tree";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  GRID_TABLE_V2_FAVORITE_TRACK,
  type GridTableV2Column,
} from "@repo/design-system/components/ui/grid-table-v2";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  type ArtifactHierarchyView,
  useArtifactHierarchyView,
} from "../../../shared/components/generic-artifact-surface/preview/components/artifact-hierarchy-view";
import {
  type GenericArtifact,
  genericArtifacts,
} from "../../../shared/components/generic-artifact-surface/preview/fixtures";
import { PROJECT_ARTIFACT_LIST_RETRY_LABEL } from "../../lib/project-artifact-list-copy";
import {
  type ProjectArtifactTreeController,
  ProjectArtifactTreeGrid,
  type ProjectArtifactTreeHost,
  projectHierarchyParentReadState,
} from "../project-artifact-tree-grid";
import { ProjectTreeChildLoadState } from "../project-tree-expansion-pages";

const EXPANSION_KEY = "test:project-artifact-tree-grid:expanded";
const DRAG_HANDLE_NAME = /Drag to reorder/;
const ARTIFACTS: readonly GenericArtifact[] = [
  {
    ...genericArtifacts[0],
    id: "parent",
    parentArtifactId: null,
    title: "Parent",
  },
  {
    ...genericArtifacts[0],
    id: "child",
    parentArtifactId: "parent",
    title: "Child",
  },
  {
    ...genericArtifacts[0],
    id: "second-parent",
    parentArtifactId: null,
    title: "Second Parent",
  },
  {
    ...genericArtifacts[0],
    id: "second-child",
    parentArtifactId: "second-parent",
    title: "Second Child",
  },
];
const UNPLACED_ARTIFACTS: readonly GenericArtifact[] = [
  { ...ARTIFACTS[0], id: "target", title: "Target" },
  { ...ARTIFACTS[1], id: "moved", parentArtifactId: null, title: "Moved" },
];
const COLUMNS: GridTableV2Column[] = [{ id: "status", label: "Status" }];
const noop = () => undefined;

afterEach(() => {
  globalThis.localStorage.removeItem(EXPANSION_KEY);
  vi.restoreAllMocks();
});

it("adopts the pointer contract only for the exact gridview rollout key", () => {
  const renderWithFlags = (enabledFlags: readonly string[]) =>
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <Harness />
      </FeatureFlagAdapterProvider>
    );

  const disabled = renderWithFlags([]);
  expect(disabled.container.querySelector('[role="treegrid"]')).not.toBeNull();
  expect(
    disabled.container.querySelector(
      '[data-grid-interaction-contract="pointer-hover"]'
    )
  ).toBeNull();
  disabled.unmount();

  const wrongKey = renderWithFlags(["gridview-adoptions"]);
  expect(wrongKey.container.querySelector('[role="treegrid"]')).not.toBeNull();
  expect(
    wrongKey.container.querySelector(
      '[data-grid-interaction-contract="pointer-hover"]'
    )
  ).toBeNull();
  wrongKey.unmount();

  const enabled = renderWithFlags([GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]);
  expect(enabled.container.querySelector('[role="treegrid"]')).not.toBeNull();
  expect(
    enabled.container.querySelector(
      '[data-grid-interaction-contract="pointer-hover"]'
    )
  ).not.toBeNull();
});

it("starts collapsed and retains a parent's disclosure through expansion and remount", async () => {
  const mounted = render(<Harness />);
  expect(screen.queryByText("Child")).not.toBeInTheDocument();
  expect(screen.queryByText("Second Child")).not.toBeInTheDocument();
  expect(parentRow()).toHaveAttribute("aria-expanded", "false");
  expect(rowForTitle("Second Parent")).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  expect(
    within(rowForTitle("Second Parent")).getByRole("button", {
      name: "Expand row",
    })
  ).toBeVisible();

  fireEvent.click(
    within(parentRow()).getByRole("button", { name: "Expand row" })
  );
  await waitFor(() => expect(rowForTitle("Child")).toBeVisible());
  expect(screen.queryByText("Second Child")).not.toBeInTheDocument();

  fireEvent.click(
    within(parentRow()).getByRole("button", { name: "Collapse row" })
  );
  expect(screen.queryByText("Child")).not.toBeInTheDocument();
  expect(parentRow()).toHaveAttribute("aria-expanded", "false");
  expect(
    within(parentRow()).getByRole("button", { name: "Expand row" })
  ).toBeVisible();

  const identityCell = parentRow().querySelector("[data-grid-lead-cell]");
  if (!identityCell) {
    throw new Error("Expected the parent identity cell");
  }
  fireEvent.keyDown(identityCell, { key: "ArrowRight" });
  await waitFor(() => expect(rowForTitle("Child")).toBeVisible());

  fireEvent.click(
    within(parentRow()).getByRole("button", { name: "Collapse row" })
  );
  mounted.unmount();
  render(<Harness />);
  expect(screen.queryByText("Child")).not.toBeInTheDocument();
  expect(parentRow()).toHaveAttribute("aria-expanded", "false");
  expect(rowForTitle("Second Parent")).toHaveAttribute(
    "aria-expanded",
    "false"
  );
  fireEvent.click(
    within(parentRow()).getByRole("button", { name: "Expand row" })
  );
  await waitFor(() => expect(rowForTitle("Child")).toBeVisible());
  fireEvent.click(
    within(rowForTitle("Second Parent")).getByRole("button", {
      name: "Expand row",
    })
  );
  await waitFor(() => expect(rowForTitle("Second Child")).toBeVisible());
});

it.each(["pointer Inside", "Ctrl+ArrowRight"])(
  "keeps a new parent's disclosure after %s placement, collapse, and remount",
  async (placement) => {
    let persistedArtifacts = UNPLACED_ARTIFACTS;

    function PlacementHarness() {
      const [artifacts, setArtifacts] = useState(persistedArtifacts);
      const hierarchyView = useArtifactHierarchyView({
        artifacts,
        compareArtifacts: () => 0,
        filteredArtifacts: artifacts,
        filtersActive: false,
        hierarchy: { expansionStorageKey: EXPANSION_KEY, maxVisibleLevels: 4 },
        sortActive: false,
      });
      const moveInside = (artifactId: string, targetId: string) => {
        const next = artifacts.map((artifact) =>
          artifact.id === artifactId
            ? { ...artifact, parentArtifactId: targetId }
            : artifact
        );
        persistedArtifacts = next;
        setArtifacts(next);
        if (placement === "Ctrl+ArrowRight") {
          hierarchyView.syncExpansionAfterMove(next, targetId);
        }
      };
      return (
        <ProjectArtifactTreeGrid
          controller={{
            ...controllerFor(hierarchyView),
            manualOrderingActive: true,
            moveArtifactManually: (artifactId, direction) => {
              if (direction === "in") {
                moveInside(artifactId, "target");
              }
            },
          }}
          host={{
            canHierarchyDrop: () => true,
            onHierarchyDrop: (artifact, target, position) => {
              if (position === "inside") {
                moveInside(artifact.id, target.id);
              }
            },
          }}
        />
      );
    }

    const mounted = render(<PlacementHarness />);
    expect(
      within(rowForTitle("Target")).queryByRole("button", {
        name: "Expand row",
      })
    ).not.toBeInTheDocument();

    if (placement === "pointer Inside") {
      const transfer = {
        dropEffect: "none",
        effectAllowed: "none",
        getData: () => "",
        setData: vi.fn(),
        types: [] as string[],
      };
      vi.spyOn(rowForTitle("Target"), "getBoundingClientRect").mockReturnValue({
        height: 100,
        top: 0,
      } as DOMRect);
      fireDragWithCoordinates(
        rowForTitle("Moved"),
        "dragstart",
        0,
        0,
        transfer
      );
      fireDragWithCoordinates(
        rowForTitle("Target"),
        "dragover",
        40,
        50,
        transfer
      );
      expect(rowForTitle("Target")).toHaveAttribute("data-row-drop", "inside");
      fireEvent.drop(rowForTitle("Target"), { dataTransfer: transfer });
    } else {
      const movedHandle = within(rowForTitle("Moved")).getByRole("button", {
        name: DRAG_HANDLE_NAME,
      });
      act(() => movedHandle.focus());
      fireEvent.keyDown(movedHandle, { ctrlKey: true, key: "ArrowRight" });
      await waitFor(() =>
        expect(rowForTitle("Target")).toHaveAttribute("aria-expanded", "true")
      );
      expect(rowForTitle("Moved")).toBeVisible();
      expect(
        within(rowForTitle("Target")).getByRole("button", {
          name: DRAG_HANDLE_NAME,
        })
      ).toHaveFocus();
    }

    if (placement === "pointer Inside") {
      await waitFor(() =>
        expect(rowForTitle("Target")).toHaveAttribute("aria-expanded", "false")
      );
      fireEvent.click(
        within(rowForTitle("Target")).getByRole("button", {
          name: "Expand row",
        })
      );
    }
    expect(rowForTitle("Moved")).toBeVisible();
    fireEvent.click(
      within(rowForTitle("Target")).getByRole("button", {
        name: "Collapse row",
      })
    );
    expect(screen.queryByText("Moved")).not.toBeInTheDocument();
    expect(rowForTitle("Target")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      within(rowForTitle("Target")).getByRole("button", {
        name: "Expand row",
      })
    );
    await waitFor(() => expect(rowForTitle("Moved")).toBeVisible());

    fireEvent.click(
      within(rowForTitle("Target")).getByRole("button", {
        name: "Collapse row",
      })
    );
    mounted.unmount();
    render(<PlacementHarness />);
    expect(rowForTitle("Target")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Moved")).not.toBeInTheDocument();
    fireEvent.click(
      within(rowForTitle("Target")).getByRole("button", {
        name: "Expand row",
      })
    );
    await waitFor(() => expect(rowForTitle("Moved")).toBeVisible());
  }
);

it("keeps the star in the tree's own favorite track", () => {
  const setArtifactFavorite = vi.fn();
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
      })}
    >
      <Harness setArtifactFavorite={setArtifactFavorite} />
    </FeatureFlagAdapterProvider>
  );
  const row = parentRow();
  expect(row.getAttribute("style")).not.toContain(
    `${GRID_TABLE_V2_FAVORITE_TRACK} ${GRID_TABLE_V2_FAVORITE_TRACK}`
  );
  const star = within(row).getByRole("button", {
    name: "Remove Parent from favorites",
  });
  expect(star.closest('[aria-colindex="1"]')).not.toBeNull();
  expect(
    row.querySelector("[data-grid-lead-cell]")?.getAttribute("aria-colindex")
  ).toBe("2");
  fireEvent.click(star);
  expect(setArtifactFavorite).toHaveBeenCalledWith("parent", false);
});

it("keeps rows stationary beneath a grip-and-title drag chip", () => {
  const { container } = render(<DragPreviewHarness />);
  const source = rowForTitle("Parent");
  const neighbor = rowForTitle("Second Parent");
  const rowCount = container.querySelectorAll("[data-grid-row]").length;
  const transfer = {
    dropEffect: "none",
    effectAllowed: "none",
    getData: () => "",
    setData: vi.fn(),
    setDragImage: vi.fn(),
    types: [] as string[],
  };
  fireDragWithCoordinates(source, "dragstart", 12, 24, transfer);
  vi.spyOn(neighbor, "getBoundingClientRect").mockReturnValue({
    height: 40,
    top: 100,
  } as DOMRect);
  fireDragWithCoordinates(neighbor, "dragover", 12, 139, transfer);

  const chip = screen.getByTestId("drag-preview-chip");
  expect(chip).toHaveTextContent("Parent");
  expect(chip).not.toHaveTextContent("Status");
  expect(chip.querySelector("svg")).not.toBeNull();
  expect(source).toHaveAttribute("data-dragging", "true");
  expect(source.style.transform).toBe("");
  expect(neighbor.style.transform).toBe("");
  expect(neighbor).toHaveAttribute("data-row-drop", "after");
  expect(neighbor).toHaveClass("data-[row-drop=after]:border-b-primary");
  expect(container.querySelectorAll("[data-grid-row]")).toHaveLength(rowCount);
  expect(transfer.setDragImage).toHaveBeenCalled();
  // WebKit aborts a drag whose image is detached (ISS-12901).
  const [dragImage] = transfer.setDragImage.mock.calls[0] ?? [];
  expect(dragImage).toBeInstanceOf(HTMLCanvasElement);
  expect((dragImage as HTMLCanvasElement).isConnected).toBe(true);
});

it("shows an affected parent's failed child read and retries only that parent", () => {
  const retry = vi.fn();
  const hierarchyReadState: NonNullable<
    ProjectArtifactTreeHost["hierarchyReadState"]
  > = {
    childLoadByParentId: new Map([
      ["parent", { state: ProjectTreeChildLoadState.Error, retry }],
    ]),
    hierarchyByArtifactId: new Map([
      [
        "parent",
        { availability: HierarchyAvailability.Partial, childCount: 3 },
      ],
    ]),
  };
  render(<Harness hierarchyReadState={hierarchyReadState} />);
  expect(
    parentRow().querySelector('[data-cell-value-state="error"]')
  ).not.toBeNull();
  fireEvent.click(
    within(parentRow()).getByRole("button", {
      name: PROJECT_ARTIFACT_LIST_RETRY_LABEL,
    })
  );
  expect(retry).toHaveBeenCalledOnce();
  expect(
    rowForTitle("Second Parent").querySelector("[data-cell-value-state]")
  ).toBeNull();
});

it("keeps restricted parents distinct and leaves a complete parent unmarked", () => {
  const readState: NonNullable<ProjectArtifactTreeHost["hierarchyReadState"]> =
    {
      childLoadByParentId: new Map(),
      hierarchyByArtifactId: new Map([
        [
          "parent",
          { availability: HierarchyAvailability.Complete, childCount: 1 },
        ],
        [
          "second-parent",
          {
            availability: HierarchyAvailability.PermissionHidden,
            childCount: 0,
          },
        ],
      ]),
    };
  // A shared child's second parent is diagnosed as duplicate_parent by design;
  // the healthy parent row must not read as a failure.
  expect(projectHierarchyParentReadState("parent", readState)).toBeNull();
  render(<Harness hierarchyReadState={readState} />);
  expect(parentRow().querySelector("[data-cell-value-state]")).toBeNull();
  expect(
    rowForTitle("Second Parent").querySelector(
      '[data-cell-value-state="forbidden"]'
    )
  ).not.toBeNull();
});

function DragPreviewHarness() {
  const hierarchyView = useArtifactHierarchyView({
    artifacts: ARTIFACTS,
    compareArtifacts: () => 0,
    filteredArtifacts: ARTIFACTS,
    filtersActive: false,
    hierarchy: { expansionStorageKey: EXPANSION_KEY, maxVisibleLevels: 4 },
    sortActive: false,
  });
  return (
    <ProjectArtifactTreeGrid
      controller={{
        ...controllerFor(hierarchyView),
        manualOrderingActive: true,
      }}
      host={{ canHierarchyDrop: () => true, onHierarchyDrop: noop }}
    />
  );
}

function Harness({
  hierarchyReadState,
  setArtifactFavorite,
}: {
  hierarchyReadState?: ProjectArtifactTreeHost["hierarchyReadState"];
  setArtifactFavorite?: (artifactId: string, favorited: boolean) => void;
}) {
  const hierarchyView = useArtifactHierarchyView({
    artifacts: ARTIFACTS,
    compareArtifacts: () => 0,
    filteredArtifacts: ARTIFACTS,
    filtersActive: false,
    hierarchy: {
      expansionStorageKey: EXPANSION_KEY,
      initiallyExpanded: false,
      maxVisibleLevels: 4,
    },
    sortActive: false,
  });
  return (
    <ProjectArtifactTreeGrid
      controller={controllerFor(hierarchyView, setArtifactFavorite)}
      host={{ hierarchyReadState }}
    />
  );
}

function controllerFor(
  hierarchyView: ArtifactHierarchyView,
  setArtifactFavorite: (artifactId: string, favorited: boolean) => void = noop
): ProjectArtifactTreeController {
  return {
    artifactColumnWidth: 280,
    favoriteArtifactIds: new Set(["parent"]),
    favoritesUnavailable: false,
    pendingFavoriteArtifactIds: undefined,
    setArtifactFavorite,
    columnLayout: {
      gridTemplateColumns: `${GRID_TABLE_V2_FAVORITE_TRACK} 280px 120px`,
    },
    gridColumns: COLUMNS,
    createInlineArtifact: noop,
    handleArtifactRowClick: noop,
    handleArtifactRowKeyboardNavigate: noop,
    handleArtifactRowRangeDrag: noop,
    hierarchyView,
    inlineCreate: undefined,
    inlineDraftContext: null,
    manualOrderingActive: false,
    moveArtifactManually: noop,
    onOpenArtifactHref: noop,
    reconcileSelection: noop,
    selectedArtifactIds: new Set<string>(),
    selectAllVisibleArtifacts: noop,
    setInlineDraftContext: noop,
    setSelectedArtifactIds: noop,
    tagEditorContext: null,
    toggleArtifactSelection: noop,
  };
}

function parentRow(): HTMLElement {
  return rowForTitle("Parent");
}

function rowForTitle(title: string): HTMLElement {
  const row = screen.getByText(title).closest<HTMLElement>("[data-grid-row]");
  if (!row) {
    throw new Error(`Expected the ${title} treegrid row`);
  }
  return row;
}

function fireDragWithCoordinates(
  target: HTMLElement,
  type: "dragstart" | "dragover",
  clientX: number,
  clientY: number,
  dataTransfer: object
) {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  fireEvent(target, event);
}

const SELECT_ALL_NAME = /select all/i;

it.each([
  ["no flag", []],
  ["gridview-adoption only", [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]],
  ["projects-portable-surface", [PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY]],
])(
  "renders no header select-all checkbox and no row checkboxes with %s (ISS-13007 R-NO-HEADER-SELECT-ALL)",
  (_name, enabledFlags) => {
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <Harness />
      </FeatureFlagAdapterProvider>
    );
    expect(screen.getAllByRole("row").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("checkbox", { name: SELECT_ALL_NAME })
    ).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  }
);
