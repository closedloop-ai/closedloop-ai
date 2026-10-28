// @vitest-environment jsdom

import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { stubResponsiveNarrowViewport } from "@repo/app/test/mocks/responsive-narrow-viewport";
import { ColumnFieldKind } from "@repo/design-system/lib/column-registry";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectionSentence } from "../../../bulk-action-bar";
import { type GenericArtifact, genericArtifacts } from "../../fixtures";
import {
  type ArtifactListColumnExtension,
  columnWidthBounds,
} from "../artifact-list-model";
import { useGenericArtifactListController } from "../artifact-list-shell-controller";
import {
  GenericArtifactListShell,
  GenericArtifactListView,
} from "../artifact-shells";
import {
  ADD_ARTIFACT,
  ADD_FIELD,
  BOARD_VIEW,
  CREATE_ARTIFACT_DIALOG,
  EDIT_NAME_PREFIX,
  FILTER_MENU_ITEM,
  FIRST_ARTIFACT_TITLE,
  LIST_VIEW,
  nthElement,
  OWNER_COLUMN_OPTIONS,
  renderShell,
  rowSlugs,
  SHELL_FLOW_TIMEOUT_MS,
} from "./support/list-shell-harness";
import { openRadixMenu } from "./support/radix-menu";

const OWNER_RESIZE = /^Resize Owner column, (\d+) pixels wide/;
const LEAD_RESIZE = /^Resize Artifact column, (\d+) pixels wide/;
const OTTILIE_GROUP = /^Ottilie Eastwick\s*2$/;
const PASCOE_GROUP = /^Pascoe Birchall\s*1$/;
const NO_ARTIFACTS_SELECTED = "No artifacts selected";
const ONE_ARTIFACT_SELECTED = selectionSentence(1);
const TWO_ARTIFACTS_SELECTED = selectionSentence(2);
const NEW_ITEM = "New item";
const NEW_ITEM_INPUT = `${NEW_ITEM} name`;
const ADD_ARTIFACT_INPUT = `${ADD_ARTIFACT} name`;
const PASCOE_OWNER_CELL = "Edit owner, currently Pascoe Birchall";
const PASCOE_BIRCHALL = genericArtifacts[1]?.owner ?? "";
const FIRST_ARTIFACT_CARD_NAME = `${genericArtifacts[0]?.slug ?? ""}${FIRST_ARTIFACT_TITLE}`;
const DONE_SUBGROUP = /^Done\s*\d+$/;
const TODO_SUBGROUP = /^Todo\s*\d+$/;
const OWNER_GROUP_COUNT = 5;
const COLLAPSE_DOC = "Collapse DOC-184";

const extraColumn: ArtifactListColumnExtension = {
  id: "extra",
  kind: ColumnFieldKind.Custom,
  label: "Extra",
  renderCell: (artifact) => `${artifact.slug} extra`,
  width: columnWidthBounds(120),
};

const silentColumn: ArtifactListColumnExtension = {
  id: "silent",
  kind: ColumnFieldKind.Custom,
  label: "Silent",
  renderCell: () => null,
  width: columnWidthBounds(120),
};

function rowOf(slug: string): HTMLElement {
  const row = screen
    .getByRole("button", { name: `${EDIT_NAME_PREFIX}${slug}` })
    .closest<HTMLElement>("[data-grid-row]");
  if (!row) {
    throw new Error(`missing row ${slug}`);
  }
  return row;
}

function selectRow(slug: string): void {
  const cell = rowOf(slug).querySelector<HTMLElement>(
    '[data-column-id="updated"]'
  );
  if (!cell) {
    throw new Error(`missing selectable updated cell for ${slug}`);
  }
  act(() => {
    cell.focus();
    fireEvent.keyDown(cell, { key: " " });
  });
}

function resizeWidth(pattern: RegExp): number {
  const label = screen.getByLabelText(pattern).getAttribute("aria-label") ?? "";
  return Number(pattern.exec(label)?.[1]);
}

function inlineCreate(inputName: string, title: string): void {
  const input = screen.getByRole("textbox", { name: inputName });
  fireEvent.change(input, { target: { value: title } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function createDataTransfer() {
  const store = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    getData: (type: string) => store.get(type) ?? "",
    setData: (type: string, value: string) => {
      store.set(type, value);
    },
    types: [] as string[],
  };
}

function draggableRow(slug: string): HTMLElement {
  const row = rowOf(slug).closest<HTMLElement>('[draggable="true"]');
  if (!row) {
    throw new Error(`expected ${slug} to be draggable`);
  }
  return row;
}

function isDraggable(slug: string): boolean {
  return rowOf(slug).closest('[draggable="true"]') !== null;
}

function band(groupName: RegExp): HTMLElement {
  const headerGroup = screen
    .getByRole("button", { name: groupName })
    .closest<HTMLElement>('[role="rowgroup"]');
  if (!headerGroup) {
    throw new Error(`missing band ${groupName}`);
  }
  return headerGroup.parentElement?.getAttribute("role") === "presentation"
    ? headerGroup.parentElement
    : headerGroup;
}

function subband(parent: HTMLElement, subgroupName: RegExp): HTMLElement {
  const element = within(parent)
    .getByRole("button", { name: subgroupName })
    .closest<HTMLElement>('[role="rowgroup"]');
  if (!element) {
    throw new Error(`missing subgroup ${subgroupName}`);
  }
  return element;
}

function renderedColumnIds(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="columnheader"][data-column-id]'
    ),
  ]
    .map((header) => header.dataset.columnId ?? "")
    .filter((columnId) => columnId !== "__leading__");
}

function columnHeader(columnId: string): HTMLElement {
  const header = document.querySelector<HTMLElement>(
    `[role="columnheader"][data-column-id="${columnId}"]`
  );
  if (!header) {
    throw new Error(`missing header ${columnId}`);
  }
  return header;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("artifact list board", { timeout: SHELL_FLOW_TIMEOUT_MS }, () => {
  it("renders and counts only root cards on the production project Board", () => {
    window.history.replaceState({}, "", "/?layout=board&group=status");
    const [first, second] = genericArtifacts;
    if (!(first && second)) {
      throw new Error("expected two fixture artifacts");
    }
    const root = { ...first, parentArtifactId: null };
    const child = {
      ...second,
      parentArtifactId: root.id,
      status: root.status,
      updatedAgoMinutes: 0,
    };
    const { container } = renderShell({
      artifacts: [root, child],
      hierarchy: { maxVisibleLevels: 4 },
    });

    const lane = container.querySelector<HTMLElement>(
      '[data-status-board-cell="in_review/"]'
    );
    const grid = lane?.parentElement;
    const laneIndex = grid
      ? [
          ...grid.querySelectorAll<HTMLElement>("[data-status-board-cell]"),
        ].indexOf(lane)
      : -1;
    const header = grid?.children.item(laneIndex);
    if (!(lane && header instanceof HTMLElement)) {
      throw new Error("expected a status lane and its header");
    }
    expect(within(lane).getByText(root.title)).toBeTruthy();
    expect(within(lane).queryByText(child.title)).toBeNull();
    expect(within(header).getByText("1")).toBeTruthy();
  });

  it("offers status-lane creation only while the board is editable and the host allows it", () => {
    window.history.replaceState({}, "", "/?layout=board&group=status");
    const editable = renderShell();
    expect(screen.getAllByRole("button", { name: ADD_ARTIFACT })).toHaveLength(
      2
    );
    fireEvent.click(
      nthElement(screen.getAllByRole("button", { name: ADD_ARTIFACT }), 1)
    );
    expect(
      screen.getByRole("dialog", { name: CREATE_ARTIFACT_DIALOG })
    ).toBeTruthy();
    editable.unmount();

    const readOnly = renderShell({ statusBoard: { editable: false } });
    expect(screen.getAllByRole("button", { name: ADD_ARTIFACT })).toHaveLength(
      1
    );
    readOnly.unmount();

    renderShell({ showBoardAddButton: false });
    expect(screen.getAllByRole("button", { name: ADD_ARTIFACT })).toHaveLength(
      1
    );
  });

  it("renders no lanes for a board restored without a grouping", () => {
    window.history.replaceState({}, "", "/?layout=board");
    renderShell();

    // pins current behavior; looks odd because a board URL with no group paints an empty board while the pager still counts every row
    expect(screen.queryByText(FIRST_ARTIFACT_TITLE)).toBeNull();
    expect(screen.getByText("1–3 of 3")).toBeTruthy();
  });
});

describe("artifact list grid cells", { timeout: SHELL_FLOW_TIMEOUT_MS }, () => {
  it("renders an extension column through its own cell and falls back when it renders nothing", () => {
    renderShell({
      additionalColumns: [extraColumn, silentColumn],
      defaultVisibleColumnIds: ["extra", "silent"],
    });

    expect(screen.getByText("FEA-2481 extra")).toBeTruthy();
    const silentCell = rowOf("FEA-2481").querySelector<HTMLElement>(
      '[data-column-id="silent"]'
    );
    expect(silentCell?.textContent ?? "").toBe("");
  });

  it("toggles a row favorite from its leading utility", () => {
    renderShell();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Artifact interaction principles to favorites",
      })
    );

    expect(
      screen.getByRole("button", {
        name: "Remove Artifact interaction principles from favorites",
      })
    ).toBeTruthy();
  });

  it("opens the add-field dialog from the trailing header", () => {
    renderShell();

    fireEvent.click(
      nthElement(screen.getAllByRole("button", { name: ADD_FIELD }), 1)
    );

    expect(screen.getByRole("dialog", { name: ADD_FIELD })).toBeTruthy();
  });

  it("drops selected child and grandchild when their parent collapses", () => {
    // ISS-12640 (operator ruling 2026-10-20): rows a collapsed parent hides
    // leave the selection, as rows in a collapsed band do, and reopening the
    // parent does not restore them.
    const [first, second, third] = genericArtifacts;
    if (!(first && second && third)) {
      throw new Error("expected three fixture artifacts");
    }
    const parent: GenericArtifact = { ...first, parentArtifactId: null };
    const child: GenericArtifact = {
      ...second,
      parentArtifactId: parent.id,
      updatedAgoMinutes: 0,
    };
    const grandchild: GenericArtifact = {
      ...third,
      parentArtifactId: child.id,
      updatedAgoMinutes: 0,
    };
    renderShell({
      artifacts: [parent, child, grandchild],
      hierarchy: { maxVisibleLevels: 4 },
    });
    expect(rowSlugs()).toEqual([parent.slug, child.slug, grandchild.slug]);
    selectRow(child.slug);
    selectRow(grandchild.slug);
    expect(rowOf(child.slug).getAttribute("aria-selected")).toBe("true");
    expect(rowOf(grandchild.slug).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Collapse FEA-2481" }));
    expect(rowSlugs()).toEqual([parent.slug]);

    fireEvent.click(screen.getByRole("button", { name: "Expand FEA-2481" }));
    expect(rowSlugs()).toEqual([parent.slug, child.slug, grandchild.slug]);
    expect(rowOf(child.slug).getAttribute("aria-selected")).toBe("false");
    expect(rowOf(grandchild.slug).getAttribute("aria-selected")).toBe("false");
  });

  it("clears hidden selection when the board layout unmounts the grid", () => {
    renderShell();
    selectRow("FEA-2481");
    selectRow("DOC-184");
    expect(
      screen.getByRole("toolbar", { name: TWO_ARTIFACTS_SELECTED })
    ).toBeInTheDocument();

    fireEvent.click(
      nthElement(screen.getAllByRole("radio", { name: BOARD_VIEW }), 0)
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(
      screen.getByRole("status", { name: NO_ARTIFACTS_SELECTED })
    ).toBeInTheDocument();

    fireEvent.click(
      nthElement(screen.getAllByRole("radio", { name: LIST_VIEW }), 0)
    );
    expect(rowOf("FEA-2481").getAttribute("aria-selected")).toBe("false");
    expect(rowOf("DOC-184").getAttribute("aria-selected")).toBe("false");
  });

  it(
    "drops a selected row when its controlled group collapses",
    () => {
      window.history.replaceState({}, "", "/?group=owner");
      renderShell();
      selectRow("FEA-2481");
      selectRow("DOC-184");
      expect(
        screen.getByRole("toolbar", { name: TWO_ARTIFACTS_SELECTED })
      ).toBeInTheDocument();

      const toggle = screen.getByRole("button", { name: OTTILIE_GROUP });
      fireEvent.click(toggle);
      expect(rowSlugs()).toEqual(["DOC-184"]);
      fireEvent.click(toggle);

      expect(rowOf("FEA-2481").getAttribute("aria-selected")).toBe("false");
      expect(rowOf("DOC-184").getAttribute("aria-selected")).toBe("true");
      expect(screen.queryByRole("toolbar")).toBeNull();
      expect(
        screen.getByRole("status", { name: ONE_ARTIFACT_SELECTED })
      ).toBeInTheDocument();
    },
    SHELL_FLOW_TIMEOUT_MS
  );
});

describe("artifact list column headers", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("sorts and groups from a column menu", async () => {
    renderShell();

    openRadixMenu(screen.getByLabelText(OWNER_COLUMN_OPTIONS));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Sort ascending" })
    );
    expect(
      screen.getByRole("button", { name: "Sorted by Owner" })
    ).toBeTruthy();

    openRadixMenu(screen.getByLabelText(OWNER_COLUMN_OPTIONS));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Group" }));
    expect(screen.getByRole("button", { name: OTTILIE_GROUP })).toBeTruthy();
  });

  it("filters from a column menu that has a filter group and offers none where it has none", async () => {
    renderShell();

    openRadixMenu(screen.getByLabelText(OWNER_COLUMN_OPTIONS));
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: FILTER_MENU_ITEM }),
      {
        key: "Enter",
      }
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: PASCOE_BIRCHALL })
    );
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.getByText("Owner: Pascoe Birchall")).toBeTruthy();
    expect(rowSlugs()).toEqual(["DOC-184"]);

    openRadixMenu(screen.getByLabelText("Collaborators column options"));
    expect(
      await screen.findByRole("menuitem", { name: "Move column" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: FILTER_MENU_ITEM })
    ).toBeNull();
  });

  it("shows each column's own filter options", async () => {
    renderShell();

    openRadixMenu(screen.getByLabelText("Updated column options"));
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: FILTER_MENU_ITEM }),
      { key: "Enter" }
    );

    expect(
      await screen.findByRole("menuitem", { name: "Last 24 hours" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: PASCOE_BIRCHALL })
    ).toBeNull();
  });

  it("reorders columns when a header is dragged onto another", () => {
    renderShell({ defaultVisibleColumnIds: ["owner", "status", "tags"] });
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(columnHeader("tags"), { dataTransfer });
    fireEvent.dragOver(columnHeader("owner"), { dataTransfer });
    fireEvent.drop(columnHeader("owner"), { dataTransfer });

    expect(renderedColumnIds()).not.toEqual(["owner", "status", "tags"]);
    expect(renderedColumnIds()[0]).toBe("tags");
  });

  it("resizes a data column and the leading column from the keyboard", () => {
    renderShell();
    const ownerBefore = resizeWidth(OWNER_RESIZE);
    const leadBefore = resizeWidth(LEAD_RESIZE);

    fireEvent.keyDown(screen.getByLabelText(OWNER_RESIZE), {
      key: "ArrowRight",
    });
    fireEvent.keyDown(screen.getByLabelText(LEAD_RESIZE), {
      key: "ArrowRight",
    });

    expect(resizeWidth(OWNER_RESIZE)).toBeGreaterThan(ownerBefore);
    expect(resizeWidth(LEAD_RESIZE)).toBeGreaterThan(leadBefore);
  });
});

describe("artifact list row dragging", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("lets only editable-status rows drag while grouped by status", () => {
    window.history.replaceState({}, "", "/?group=status");
    renderShell();

    expect(
      rowOf("FEA-2481").closest("[draggable]")?.getAttribute("draggable")
    ).toBe("true");
    expect(
      rowOf("SES-7B91").closest("[draggable]")?.getAttribute("draggable")
    ).not.toBe("true");
  });

  it("drags nothing while grouped by status on a read-only board", () => {
    window.history.replaceState({}, "", "/?group=status");
    renderShell({ statusBoard: { editable: false } });

    expect(rowOf("FEA-2481").closest('[draggable="true"]')).toBeNull();
  });

  it("drags nothing when a read-only board's status is the subgroup", () => {
    window.history.replaceState({}, "", "/?group=owner&subgroup=status");
    renderShell({ statusBoard: { editable: false } });

    expect(rowOf("FEA-2481").closest('[draggable="true"]')).toBeNull();
  });

  it("lets a read-only-status row drag while grouped by owner", () => {
    window.history.replaceState({}, "", "/?group=owner");
    renderShell();

    expect(isDraggable("SES-7B91")).toBe(true);
  });

  it("drags any row by owner on a read-only board, since status is not a grouping axis", () => {
    window.history.replaceState({}, "", "/?group=owner");
    renderShell({ statusBoard: { editable: false } });

    expect(isDraggable("FEA-2481")).toBe(true);
    expect(isDraggable("SES-7B91")).toBe(true);
  });

  it("lets only editable-status rows drag while status is the subgroup", () => {
    window.history.replaceState({}, "", "/?group=owner&subgroup=status");
    renderShell();

    expect(isDraggable("FEA-2481")).toBe(true);
    expect(isDraggable("SES-7B91")).toBe(false);
  });

  it("moves a row into both bands of the subgroup it is dropped on", () => {
    window.history.replaceState({}, "", "/?group=owner&subgroup=status");
    renderShell();
    const row = draggableRow("FEA-2481");
    const target = subband(band(PASCOE_GROUP), DONE_SUBGROUP);
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(
      screen.getAllByRole("button", { name: PASCOE_OWNER_CELL })
    ).toHaveLength(2);
    expect(
      within(rowOf("FEA-2481")).getByRole("button", { name: "Done" })
    ).toBeTruthy();
  });

  it("refuses a subgroup whose status the dragged row cannot take", () => {
    window.history.replaceState({}, "", "/?group=owner&subgroup=status");
    renderShell();
    const row = draggableRow("DOC-184");
    const target = subband(band(OTTILIE_GROUP), TODO_SUBGROUP);
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(row, { dataTransfer });
    const accepted = !fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(accepted).toBe(false);
    expect(
      screen.getAllByRole("button", { name: PASCOE_OWNER_CELL })
    ).toHaveLength(1);
  });

  it("drags nothing while ungrouped", () => {
    renderShell();

    expect(rowOf("FEA-2481").closest('[draggable="true"]')).toBeNull();
  });

  it("moves a row to the owner band it is dropped on", () => {
    window.history.replaceState({}, "", "/?group=owner");
    renderShell();
    const row = rowOf("FEA-2481").closest<HTMLElement>('[draggable="true"]');
    const parkerBand = screen
      .getByRole("button", { name: PASCOE_GROUP })
      .closest<HTMLElement>('[role="rowgroup"]');
    if (!(row && parkerBand)) {
      throw new Error("expected a draggable row and a Pascoe Birchall band");
    }
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(parkerBand, { dataTransfer });
    fireEvent.drop(parkerBand, { dataTransfer });

    expect(
      screen.getAllByRole("button", { name: PASCOE_OWNER_CELL })
    ).toHaveLength(2);
  });

  it("moves a row to the primary band it is dropped on while subgrouped", () => {
    window.history.replaceState({}, "", "/?group=owner&subgroup=tags");
    renderShell();
    const row = rowOf("FEA-2481").closest<HTMLElement>('[draggable="true"]');
    const parkerBand = screen
      .getByRole("button", { name: PASCOE_GROUP })
      .closest<HTMLElement>('[role="rowgroup"]');
    if (!(row && parkerBand)) {
      throw new Error("expected a draggable row and a Pascoe Birchall band");
    }
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(parkerBand, { dataTransfer });
    fireEvent.drop(parkerBand, { dataTransfer });

    expect(
      screen.getAllByRole("button", { name: PASCOE_OWNER_CELL })
    ).toHaveLength(2);
  });
});

describe("artifact list manual ordering controls", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("moves a row up, nests it under its previous sibling, and moves it back out", async () => {
    const [first, second] = genericArtifacts;
    if (!(first && second)) {
      throw new Error("expected two fixture artifacts");
    }
    renderShell({
      artifacts: [
        { ...first, parentArtifactId: null },
        { ...second, parentArtifactId: null, updatedAgoMinutes: 0 },
      ],
      hierarchy: { maxVisibleLevels: 4 },
      manualOrdering: true,
    });
    const handle = (slug: string) =>
      screen.getByRole("button", { name: `Drag to reorder ${slug}` });

    fireEvent.keyDown(handle("DOC-184"), { key: "ArrowUp", metaKey: true });
    await waitFor(() => expect(rowSlugs()).toEqual(["DOC-184", "FEA-2481"]));

    fireEvent.keyDown(handle("FEA-2481"), { key: "ArrowRight", metaKey: true });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: COLLAPSE_DOC })).toBeTruthy()
    );

    fireEvent.keyDown(handle("FEA-2481"), { key: "ArrowLeft", metaKey: true });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: COLLAPSE_DOC })).toBeNull();
      expect(rowSlugs()).toEqual(["DOC-184", "FEA-2481"]);
    });
  });
});

describe("artifact list manual ordering drag preview", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("shows the grip-and-title chip for a hosted manual-ordering row drag only", () => {
    const [first, second] = genericArtifacts;
    if (!(first && second)) {
      throw new Error("expected two fixture artifacts");
    }
    const artifacts = [
      { ...first, parentArtifactId: null },
      { ...second, parentArtifactId: null },
    ];
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: () => "",
      setData: vi.fn(),
      setDragImage: vi.fn(),
      types: [] as string[],
    };

    const unordered = render(
      <HostedPlacementShell artifacts={artifacts} manualOrdering={false} />
    );
    fireEvent.dragStart(rowOf(first.slug), { dataTransfer });
    expect(screen.queryByTestId("drag-preview-chip")).toBeNull();
    unordered.unmount();

    render(<HostedPlacementShell artifacts={artifacts} manualOrdering />);
    fireEvent.dragStart(rowOf(first.slug), { dataTransfer });
    expect(screen.getByTestId("drag-preview-chip")).toHaveTextContent(
      first.title
    );
  });
});

/** A production-shaped host: the same controller, with the placement seam. */
function HostedPlacementShell({
  artifacts: initialArtifacts,
  manualOrdering,
}: {
  artifacts: GenericArtifact[];
  manualOrdering: boolean;
}) {
  const [artifacts, setArtifacts] = useState(initialArtifacts);
  const onArtifactsChange = useCallback(
    (next: readonly GenericArtifact[]) => setArtifacts([...next]),
    []
  );
  const controller = useGenericArtifactListController({
    artifacts,
    controlledArtifacts: true,
    hierarchy: PLACEMENT_HIERARCHY,
    manualOrdering,
    onArtifactsChange,
    onOpenArtifact: noop,
  });
  return (
    <GenericArtifactListView controller={controller} host={PLACEMENT_HOST} />
  );
}

const PLACEMENT_HIERARCHY = { maxVisibleLevels: 4 };
const PLACEMENT_HOST = {
  canHierarchyDrop: () => true,
  onHierarchyDrop: () => undefined,
};
function noop() {
  return undefined;
}

describe("artifact list inline creation", {
  timeout: SHELL_FLOW_TIMEOUT_MS,
}, () => {
  it("cancels or commits the trailing draft and keeps a draft open after a new row", () => {
    renderShell({ inlineCreate: { enabled: true, label: NEW_ITEM } });

    fireEvent.click(screen.getByRole("button", { name: NEW_ITEM }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: NEW_ITEM_INPUT }), {
      key: "Escape",
    });
    expect(screen.queryByRole("textbox", { name: NEW_ITEM_INPUT })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: NEW_ITEM }));
    inlineCreate(NEW_ITEM_INPUT, "Fresh row");

    expect(screen.getByText("Fresh row")).toBeTruthy();
    const draft = screen.getByRole("textbox", { name: NEW_ITEM_INPUT });
    expect(
      draft.closest("[data-inline-create-row]")?.previousElementSibling
        ?.textContent
    ).toContain("Fresh row");

    inlineCreate(NEW_ITEM_INPUT, "Second row");
    expect(screen.getByText("Second row")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("textbox", { name: NEW_ITEM_INPUT }), {
      key: "Escape",
    });
    expect(screen.queryByRole("textbox", { name: NEW_ITEM_INPUT })).toBeNull();
    expect(screen.getByRole("button", { name: NEW_ITEM })).toBeTruthy();
  });

  it("offers one draft per group and files the new rows into that group", () => {
    window.history.replaceState({}, "", "/?group=owner");
    renderShell({
      inlineCreate: { enabled: true },
      showAddArtifactButton: false,
    });

    const drafts = screen.getAllByRole("button", { name: ADD_ARTIFACT });
    expect(drafts).toHaveLength(OWNER_GROUP_COUNT);
    fireEvent.click(nthElement(drafts, 1));
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: ADD_ARTIFACT_INPUT }),
      { key: "Escape" }
    );
    expect(
      screen.queryByRole("textbox", { name: ADD_ARTIFACT_INPUT })
    ).toBeNull();

    fireEvent.click(
      nthElement(screen.getAllByRole("button", { name: ADD_ARTIFACT }), 1)
    );
    inlineCreate(ADD_ARTIFACT_INPUT, "Grouped row");
    inlineCreate(ADD_ARTIFACT_INPUT, "Second grouped row");

    for (const title of ["Grouped row", "Second grouped row"]) {
      const row = screen
        .getByText(title)
        .closest<HTMLElement>("[data-grid-row]");
      if (!row) {
        throw new Error(`missing row ${title}`);
      }
      expect(
        within(row).getByRole("button", { name: PASCOE_OWNER_CELL })
      ).toBeTruthy();
    }
  });

  it("labels the trailing draft Add artifact by default", () => {
    renderShell({
      inlineCreate: { enabled: true },
      showAddArtifactButton: false,
    });

    expect(screen.getAllByRole("button", { name: ADD_ARTIFACT })).toHaveLength(
      1
    );
  });

  it("renders no draft rows while inline creation is off", () => {
    renderShell({ showAddArtifactButton: false });

    expect(screen.queryByRole("button", { name: ADD_ARTIFACT })).toBeNull();
    expect(rowSlugs()).toHaveLength(3);
  });
});

describe("artifact narrow list", { timeout: SHELL_FLOW_TIMEOUT_MS }, () => {
  let restoreContainerWidth: (() => void) | undefined;
  let restoreWidth: (() => void) | undefined;

  afterEach(() => {
    restoreContainerWidth?.();
    restoreContainerWidth = undefined;
    restoreWidth?.();
    restoreWidth = undefined;
  });

  it("keeps the captured-main Generic Artifact cards while the flag is off", () => {
    restoreContainerWidth = stubContainerWidthPx(390);
    const onOpenArtifact = vi.fn();
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <GenericArtifactListShell
          additionalColumns={[extraColumn]}
          artifacts={genericArtifacts}
          defaultVisibleColumnIds={["extra"]}
          onOpenArtifact={onOpenArtifact}
        />
      </FeatureFlagAdapterProvider>
    );

    expect(screen.queryByRole("grid")).toBeNull();
    expect(document.querySelectorAll("[data-grid-card-id]")).toHaveLength(3);
    expect(screen.getByText("FEA-2481 extra")).toBeVisible();

    const firstCard = document.querySelector<HTMLElement>(
      '[data-grid-card-id="artifact-1"] [data-slot="card"]'
    );
    expect(firstCard).not.toBeNull();
    if (!firstCard) {
      throw new Error("expected the first Generic Artifact compatibility card");
    }
    fireEvent.click(firstCard);
    expect(firstCard).toHaveAttribute("data-state", "selected");

    fireEvent.click(
      within(firstCard).getByRole("button", {
        name: FIRST_ARTIFACT_CARD_NAME,
      })
    );
    expect(onOpenArtifact).toHaveBeenCalledWith(genericArtifacts[0]);
  });

  it("keeps the flag-off hierarchy as a wide grid instead of falling back to cards", () => {
    restoreContainerWidth = stubContainerWidthPx(390);
    renderShell({ hierarchy: { maxVisibleLevels: 4 } });

    expect(screen.getByRole("grid")).toHaveClass("min-w-fit");
    expect(screen.getAllByRole("columnheader").length).toBeGreaterThan(1);
    expect(
      screen.getByRole("grid").querySelectorAll('[data-slot="card"]')
    ).toHaveLength(0);
  });

  it("projects Name in a narrow container and preserves row selection", () => {
    restoreWidth = stubResponsiveNarrowViewport(true).restore;
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        <GenericArtifactListShell
          additionalColumns={[extraColumn]}
          artifacts={genericArtifacts}
          defaultVisibleColumnIds={["extra"]}
          onOpenArtifact={() => undefined}
        />
      </FeatureFlagAdapterProvider>
    );

    expect(rowSlugs()).toEqual(["FEA-2481", "DOC-184", "SES-7B91"]);
    expect(screen.queryByText("FEA-2481 extra")).toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(screen.getByRole("columnheader")).toHaveTextContent("Name");
    const firstRow = rowOf("FEA-2481");
    expect(
      within(firstRow).getByRole("button", { name: "In review" })
    ).toBeVisible();
    const favorite = within(firstRow).getByRole("button", {
      name: "Remove Unified artifact experience from favorites",
    });
    expect(favorite.closest(".h-11.w-9")).not.toBeNull();

    fireEvent.click(firstRow);
    fireEvent.click(rowOf("DOC-184"), { ctrlKey: true });
    expect(
      screen.getByRole("toolbar", { name: TWO_ARTIFACTS_SELECTED })
    ).toBeInTheDocument();

    fireEvent.click(rowOf("DOC-184"), { ctrlKey: true });
    // The count bar needs two rows unless a project move is configured, so one
    // remaining selection is represented on its row alone.
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(
      screen.getByRole("status", { name: ONE_ARTIFACT_SELECTED })
    ).toBeInTheDocument();
    expect(rowOf("FEA-2481")).toHaveAttribute("aria-selected", "true");
    expect(rowOf("DOC-184")).toHaveAttribute("aria-selected", "false");
  });
});
