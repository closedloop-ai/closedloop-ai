/**
 * Behavior tests for the generic artifact table's column-options menu.
 *
 * These drive the real Radix menu (and its "Move column" submenu) rather than
 * calling the demo's handlers directly, so each case asserts the observable
 * result — the rendered column order, the grouped sections, the surviving rows.
 * The move cases assert the WHOLE order array, so a `moveColumn` that lands the
 * column in the wrong slot fails even when the moved column itself is correct.
 */
import { composeStory } from "@storybook/react";
import { fireEvent, userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import { GenericArtifactTableDemo } from "../../../packages/app/shared/components/generic-artifact-surface/generic-artifact-table";

const COLUMN_OPTIONS_SUFFIX = " column options";
const COLUMN_OPTIONS_PATTERN = /column options$/i;
const STATUS_COLUMN = "Status";
const MOVE_COLUMN_ITEM = "Move column";
const GROUP_ITEM = "Group";
const FILTER_ITEM = "Filter";
const OWNER_COLUMN = "Owner";
const PRIORITY_COLUMN = "Priority";

/**
 * The data columns in their default order. "Artifact" is the leading column and
 * is not reorderable, so it is deliberately absent.
 */
const DEFAULT_ORDER = [
  "Owner",
  "Priority",
  "Collaborators",
  "Status",
  "Related Sessions",
  "Comments",
  "Updated",
  "Current version",
  "Tags",
  "Repository",
  "Model",
  "Creation cost",
  "Changes",
];

async function renderTable() {
  const Story = composeStory(
    { render: () => <GenericArtifactTableDemo initialFields={[]} /> },
    {
      title: "Test/GenericArtifactTableColumnMenu",
      component: GenericArtifactTableDemo,
    }
  );
  await Story.run();
  return within(document.body);
}

/** The rendered data-column order, read off the header's per-column menus. */
function columnOrder() {
  return within(document.body)
    .getAllByLabelText(COLUMN_OPTIONS_PATTERN)
    .map((trigger) =>
      (trigger.getAttribute("aria-label") ?? "").replace(
        COLUMN_OPTIONS_SUFFIX,
        ""
      )
    )
    .filter((label) => label !== "Artifact");
}

async function openColumnMenu(label: string) {
  const screen = within(document.body);
  await userEvent.click(
    screen.getByLabelText(`${label}${COLUMN_OPTIONS_SUFFIX}`)
  );
}

function menuItem(text: string) {
  const item = within(document.body)
    .queryAllByRole("menuitem")
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!item) {
    throw new Error(`no menu item labelled "${text}"`);
  }
  return item;
}

async function moveStatus(direction: string) {
  await openColumnMenu(STATUS_COLUMN);
  await userEvent.click(menuItem(MOVE_COLUMN_ITEM));
  await userEvent.click(menuItem(direction));
}

/** `DEFAULT_ORDER` with "Status" lifted out and re-inserted at `index`. */
function orderWithStatusAt(index: number) {
  const rest = DEFAULT_ORDER.filter((label) => label !== STATUS_COLUMN);
  return [...rest.slice(0, index), STATUS_COLUMN, ...rest.slice(index)];
}

describe("GenericArtifactTableDemo column menu", () => {
  it("renders the data columns in their default order", async () => {
    await renderTable();
    expect(columnOrder()).toEqual(DEFAULT_ORDER);
  });

  it("moves a column to the start", async () => {
    await renderTable();
    await moveStatus("Move to start");
    expect(columnOrder()).toEqual(orderWithStatusAt(0));
  });

  it("moves a column one position left", async () => {
    await renderTable();
    await moveStatus("Move left");
    expect(columnOrder()).toEqual(orderWithStatusAt(2));
  });

  it("moves a column one position right", async () => {
    await renderTable();
    await moveStatus("Move right");
    expect(columnOrder()).toEqual(orderWithStatusAt(4));
  });

  it("moves a column to the end", async () => {
    await renderTable();
    await moveStatus("Move to end");
    expect(columnOrder()).toEqual(orderWithStatusAt(DEFAULT_ORDER.length - 1));
  });

  it("keeps every column when a column is moved", async () => {
    await renderTable();
    await moveStatus("Move to end");
    expect([...columnOrder()].sort()).toEqual([...DEFAULT_ORDER].sort());
  });
});

describe("GenericArtifactTableDemo grouping", () => {
  it("groups the rows once a column is grouped by", async () => {
    await renderTable();
    expect(document.querySelectorAll('[role="rowgroup"]').length).toBe(0);
    await groupByColumn(STATUS_COLUMN);

    const groups = groupsSnapshot();
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.flatMap((group) => group.rowIds).sort()).toEqual(
      [...rowIds()].sort()
    );
  });

  it("makes only editable rows draggable once status grouping is on", async () => {
    await renderTable();
    expect(
      document.querySelectorAll('[data-grid-row-id][draggable="true"]').length
    ).toBe(0);
    await groupByColumn(STATUS_COLUMN);
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-grid-row-id][draggable="true"]'
        )
      ).map((row) => row.dataset.gridRowId)
    ).toEqual(["artifact-1", "artifact-2"]);
  });

  it.each([
    ["status", STATUS_COLUMN],
    ["owner", OWNER_COLUMN],
    ["priority", PRIORITY_COLUMN],
  ])(
    "reassigns an artifact's %s when dropped on another group",
    async (_axis, column) => {
      await renderTable();
      await groupByColumn(column);

      const before = groupsSnapshot();
      const moved = document
        .querySelector<HTMLElement>('[data-grid-row-id][draggable="true"]')
        ?.getAttribute("data-grid-row-id");
      if (!moved) {
        throw new Error("no draggable row rendered");
      }
      const sourceIndex = before.findIndex((group) =>
        group.rowIds.includes(moved)
      );
      const destinationIndex = sourceIndex === 0 ? 1 : 0;
      const destination = before[destinationIndex].label;
      expect(groupOf(moved)).toBe(before[sourceIndex].label);

      dropRowOnGroup(moved, destinationIndex);

      expect(groupOf(moved)).toBe(destination);
      expect(rowIds().sort()).toEqual(
        [...before.flatMap((g) => g.rowIds)].sort()
      );
    }
  );

  it("leaves the artifact where it is when dropped on its own group", async () => {
    await renderTable();
    await groupByColumn(STATUS_COLUMN);

    const before = groupsSnapshot();
    const moved = before[0].rowIds[0] as string;
    dropRowOnGroup(moved, 0);

    expect(groupOf(moved)).toBe(before[0].label);
    expect(groupsSnapshot()).toEqual(before);
  });
});

describe("GenericArtifactTableDemo column filter", () => {
  it("narrows the rows to the selected status", async () => {
    await renderTable();
    const allRows = rowIds();
    expect(allRows.length).toBe(3);

    await openColumnMenu(STATUS_COLUMN);
    await userEvent.click(menuItem(FILTER_ITEM));
    const option = within(document.body)
      .getAllByRole("menuitemcheckbox")
      .find((candidate) => candidate.textContent?.trim() === "Approved");
    if (!option) {
      throw new Error("no Approved filter option");
    }
    await userEvent.click(option);

    expect(rowIds()).toEqual(["artifact-2"]);
  });
});

async function groupByColumn(label: string) {
  await openColumnMenu(label);
  await userEvent.click(menuItem(GROUP_ITEM));
}

/** Each rendered group as `{ label, rowIds }`, in render order. */
function groupsSnapshot() {
  return Array.from(document.querySelectorAll('[role="rowgroup"]')).map(
    (group) => ({
      label:
        group.querySelector("button[aria-expanded] span")?.textContent ?? "",
      rowIds: Array.from(group.querySelectorAll("[data-grid-row-id]")).map(
        (row) => row.getAttribute("data-grid-row-id")
      ),
    })
  );
}

/** The label of the group currently holding `rowId`. */
function groupOf(rowId: string) {
  return groupsSnapshot().find((group) => group.rowIds.includes(rowId))?.label;
}

/**
 * Drag `rowId` onto the group at `targetIndex`. The grid reads the dragged row
 * off `dataTransfer`, so the stub only has to answer `getData`.
 */
function dropRowOnGroup(rowId: string, targetIndex: number) {
  const target = document.querySelectorAll('[role="rowgroup"]')[targetIndex];
  const dataTransfer = {
    getData: () => rowId,
    setData: () => undefined,
    dropEffect: "",
  };
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

function rowIds() {
  return Array.from(document.querySelectorAll("[data-grid-row-id]")).map(
    (row) => row.getAttribute("data-grid-row-id")
  );
}
