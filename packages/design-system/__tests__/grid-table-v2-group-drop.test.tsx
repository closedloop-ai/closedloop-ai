import {
  GridTableV2,
  type GridTableV2Column,
  type GridTableV2Group,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { GRID_ROW_DRAG_TYPE } from "@closedloop-ai/design-system/lib/grid-table-v2-group-drop";
import { fireEvent, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lock on `GridTableV2`'s group-drop path (ISS-8296).
 *
 * `onGroupDrop` shipped with NO coverage anywhere in the repo — every existing
 * drag/drop test in this package targets COLUMN HEADERS, not rows into group
 * bands. This file pins what the band accepts TODAY, before ISS-8296 lets a
 * band decline a drop it cannot map, so the difference between "a band was
 * deliberately made undroppable" and "drops stopped working" shows up as a
 * diff here.
 *
 * Every case drives the real DOM handlers rather than calling `onGroupDrop`
 * directly: the defect these guard against is the handler never being ATTACHED,
 * which a direct call can never observe.
 */

type Row = { id: string; name: string };

const COLUMNS: GridTableV2Column[] = [{ id: "name", label: "Name" }];
const GRID_TEMPLATE = "minmax(200px, 1fr) 120px";

const ALPHA: Row = { id: "1", name: "Alpha" };
const BETA: Row = { id: "2", name: "Beta" };

const GROUPS: GridTableV2Group<Row>[] = [
  { items: [ALPHA], key: "active", label: "Active" },
  { items: [BETA], key: "done", label: "Done" },
];

const NESTED_GROUPS: GridTableV2Group<Row>[] = [
  {
    items: [ALPHA],
    key: "ada",
    label: "Ada",
    subgroups: [{ items: [ALPHA], key: "active", label: "Active" }],
  },
];

/** A band the producer could not map to a canonical value (ISS-8296). */
const REFUSING_GROUPS: GridTableV2Group<Row>[] = [
  {
    droppable: true,
    items: [ALPHA],
    key: "active",
    label: "Active",
    value: "active",
  },
  { droppable: false, items: [BETA], key: "unknown", label: "—" },
];

/**
 * The shape the plan's headline case turns on: the PARENT is refused (its rows
 * disagreed on an owner id) while its subgroups are perfectly mappable.
 */
const REFUSING_PARENT_LIVE_SUBGROUP: GridTableV2Group<Row>[] = [
  {
    droppable: false,
    items: [ALPHA],
    key: "ada",
    label: "Ada",
    subgroups: [
      {
        droppable: true,
        items: [ALPHA],
        key: "active",
        label: "Active",
        value: "active",
      },
    ],
  },
];

/**
 * jsdom fires drag events with no `dataTransfer`, and the component reads
 * `getData("text/grid-row-id")` off it, so a stand-in is mandatory. Mirrors the
 * `createDataTransfer` helper the Sessions column-reorder suites already use.
 */
function createDataTransfer() {
  const store = new Map<string, string>();
  return {
    dropEffect: "",
    effectAllowed: "",
    getData(type: string) {
      return store.get(type) ?? "";
    },
    setData(type: string, value: string) {
      store.set(type, value);
    },
    types: [] as string[],
  };
}

function renderTable(
  props: Partial<React.ComponentProps<typeof GridTableV2<Row>>>
) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={GRID_TEMPLATE}
      items={[]}
      leadingLabel="Name"
      renderCell={(_columnId, row) => row.name}
      renderLead={(row) => <span>{row.name}</span>}
      {...props}
    />
  );
}

/**
 * The `rowgroup` element the band with this label painted.
 *
 * The INNERMOST match, because a parent band's `textContent` also contains its
 * subgroup's label — taking the first match would silently drop on the parent
 * and make the nested case assert the wrong element.
 */
function bandElement(container: HTMLElement, label: string): HTMLElement {
  const matches = Array.from(
    container.querySelectorAll<HTMLElement>('[role="rowgroup"]')
  ).filter((band) => band.textContent?.includes(label));
  const innermost = matches.find(
    (band) => !matches.some((other) => other !== band && band.contains(other))
  );
  if (!innermost) {
    throw new Error(`no rowgroup rendered for band "${label}"`);
  }
  return innermost;
}

/** Drag the row rendered for `rowId` onto the band labelled `label`. */
function dropRowOnBand(container: HTMLElement, rowId: string, label: string) {
  const dataTransfer = createDataTransfer();
  const row = container.querySelector<HTMLElement>('[draggable="true"]');
  if (!row) {
    throw new Error("no draggable row rendered");
  }
  fireEvent.dragStart(row, { dataTransfer });
  // The component sets the payload on dragStart; seed it too so a band drop is
  // observable even when the row this test drags is not the first one painted.
  dataTransfer.setData(GRID_ROW_DRAG_TYPE, rowId);
  const band = bandElement(container, label);
  fireEvent.dragOver(band, { dataTransfer });
  fireEvent.drop(band, { dataTransfer });
  return dataTransfer;
}

const onGroupDrop = vi.fn();

beforeEach(() => {
  onGroupDrop.mockClear();
});

describe("GridTableV2 group drop — what the band accepts today", () => {
  it("reports the dropped row and its destination band", () => {
    const { container } = renderTable({ groups: GROUPS, onGroupDrop });

    dropRowOnBand(container, "1", "Done");

    expect(onGroupDrop).toHaveBeenCalledTimes(1);
    // The band arrives as the WHOLE group object, which is why ISS-8296 can add
    // a canonical value to it without changing this signature.
    expect(onGroupDrop).toHaveBeenCalledWith(
      ALPHA,
      expect.objectContaining({ key: "done", label: "Done" }),
      undefined,
      expect.stringMatching(GROUP_PLACEMENT_PATTERN)
    );
  });

  it("resolves the row from `groups`, not from the ignored `items` prop", () => {
    // `items: []` is the documented grouped-mode contract. A row lookup that
    // reached through `items` would find nothing and report no drop at all.
    const { container } = renderTable({
      groups: GROUPS,
      items: [],
      onGroupDrop,
    });

    dropRowOnBand(container, "2", "Active");

    expect(onGroupDrop).toHaveBeenCalledWith(
      BETA,
      expect.objectContaining({ key: "active" }),
      undefined,
      expect.stringMatching(GROUP_PLACEMENT_PATTERN)
    );
  });

  it("reports the SUBGROUP alongside its parent band on a nested drop", () => {
    const { container } = renderTable({
      groups: NESTED_GROUPS,
      onGroupDrop,
    });

    dropRowOnBand(container, "1", "Active");

    expect(onGroupDrop).toHaveBeenCalledWith(
      ALPHA,
      expect.objectContaining({ key: "ada" }),
      expect.objectContaining({ key: "active" }),
      expect.stringMatching(GROUP_PLACEMENT_PATTERN)
    );
  });

  it("contains a subgroup drop so the PARENT band does not also fire", () => {
    // A subgroup `rowgroup` is nested INSIDE its parent's `rowgroup`, and drag
    // events bubble — so the only thing stopping one drop from being reported
    // twice, once per band, is the `stopPropagation()` in the drop handler.
    // Pinned because ISS-8296 makes a band able to REFUSE a drop, and refusing
    // by dropping the handlers would hand the event straight to the parent:
    // a drop the user was told was illegal, silently applied to the primary
    // field instead. This case is what that mistake would turn red.
    const { container } = renderTable({
      groups: NESTED_GROUPS,
      onGroupDrop,
    });

    dropRowOnBand(container, "1", "Active");

    expect(onGroupDrop).toHaveBeenCalledTimes(1);
    expect(onGroupDrop).toHaveBeenCalledWith(
      ALPHA,
      expect.objectContaining({ key: "ada" }),
      expect.objectContaining({ key: "active" }),
      expect.stringMatching(GROUP_PLACEMENT_PATTERN)
    );
  });

  it("reports nothing when the drag carries a row id the table does not render", () => {
    const { container } = renderTable({ groups: GROUPS, onGroupDrop });

    dropRowOnBand(container, "does-not-exist", "Done");

    expect(onGroupDrop).not.toHaveBeenCalled();
  });
});

describe("GridTableV2 group drop — the affordance follows host wiring", () => {
  it("marks rows draggable only when the host wired a drop handler", () => {
    const wired = renderTable({ groups: GROUPS, onGroupDrop });
    expect(
      wired.container.querySelectorAll('[draggable="true"]').length
    ).toBeGreaterThan(0);
    wired.unmount();

    const unwired = renderTable({ groups: GROUPS });
    expect(unwired.container.querySelector('[draggable="true"]')).toBeNull();
  });

  it("narrows the drag affordance and drop resolution per row", () => {
    const { container } = renderTable({
      canDragRow: (row) => row.id === ALPHA.id,
      groups: GROUPS,
      onGroupDrop,
    });
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-grid-row-id]")
    );

    expect(
      rows.find((row) => row.dataset.gridRowId === ALPHA.id)?.draggable
    ).toBe(true);
    expect(
      rows.find((row) => row.dataset.gridRowId === BETA.id)?.draggable
    ).toBe(false);

    dropRowOnBand(container, BETA.id, "Active");
    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("refuses an unsupported destination for one row without disabling its valid lanes", () => {
    const { container } = renderTable({
      canDropOnGroup: (row, group) =>
        !(row.id === ALPHA.id && group.key === "done"),
      groups: GROUPS,
      onGroupDrop,
    });

    const refusedTransfer = dropRowOnBand(container, ALPHA.id, "Done");
    expect(refusedTransfer.dropEffect).toBe("none");
    expect(onGroupDrop).not.toHaveBeenCalled();

    dropRowOnBand(container, ALPHA.id, "Active");
    expect(onGroupDrop).toHaveBeenCalledWith(
      ALPHA,
      expect.objectContaining({ key: "active" }),
      undefined,
      expect.stringMatching(GROUP_PLACEMENT_PATTERN)
    );
  });

  it("uses the dragged-item ref while dragover transfer reads are protected", () => {
    const stored = new Map<string, string>();
    let protectedMode = true;
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) =>
        protectedMode ? "" : (stored.get(type) ?? ""),
      setData: (type: string, value: string) => stored.set(type, value),
      types: [] as string[],
    };
    const canDropOnGroup = vi.fn(
      (row: Row, group: GridTableV2Group<Row>) =>
        row.id === ALPHA.id && group.key === "done"
    );
    const { container } = renderTable({
      canDropOnGroup,
      groups: GROUPS,
      onGroupDrop,
    });
    const row = [
      ...container.querySelectorAll<HTMLElement>("[data-grid-row-id]"),
    ].find((candidate) => candidate.dataset.gridRowId === ALPHA.id);
    if (!row) {
      throw new Error("no draggable Alpha row rendered");
    }
    const band = bandElement(container, "Done");

    fireEvent.dragStart(row, { dataTransfer });
    expect(fireEvent.dragOver(band, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("move");
    expect(canDropOnGroup).toHaveBeenCalledWith(
      ALPHA,
      expect.objectContaining({ key: "done" }),
      undefined
    );

    protectedMode = false;
    fireEvent.drop(band, { dataTransfer });
    expect(onGroupDrop).toHaveBeenCalledWith(
      ALPHA,
      expect.objectContaining({ key: "done" }),
      undefined,
      expect.stringMatching(GROUP_PLACEMENT_PATTERN)
    );
  });

  it("attaches no drop handler to a band when the host wired none", () => {
    const { container } = renderTable({ groups: GROUPS });

    const band = bandElement(container, "Done");
    const dataTransfer = createDataTransfer();
    dataTransfer.setData(GRID_ROW_DRAG_TYPE, "1");
    // An unhandled dragover leaves `defaultPrevented` false — which is exactly
    // how the browser paints a "cannot drop here" cursor.
    const dragOver = fireEvent.dragOver(band, { dataTransfer });

    expect(dragOver).toBe(true);
    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("accepts the dragover on a band the host DID wire", () => {
    const { container } = renderTable({ groups: GROUPS, onGroupDrop });

    const band = bandElement(container, "Done");
    const dataTransfer = createDataTransfer();
    const dragOver = fireEvent.dragOver(band, { dataTransfer });

    // `preventDefault()` on dragover is what makes an element a drop target;
    // fireEvent returns false once the default was prevented.
    expect(dragOver).toBe(false);
    expect(dataTransfer.dropEffect).toBe("move");
  });
});

describe("GridTableV2 group drop — a band may REFUSE (ISS-8296)", () => {
  it("does not accept the dragover on a band marked undroppable", () => {
    const { container } = renderTable({ groups: REFUSING_GROUPS, onGroupDrop });

    const band = bandElement(container, "—");
    const dataTransfer = createDataTransfer();
    const dragOver = fireEvent.dragOver(band, { dataTransfer });

    // `fireEvent` returns false once the default was prevented, so a TRUE here
    // is the browser being told "this is not a drop target".
    expect(dragOver).toBe(true);
    expect(dataTransfer.dropEffect).toBe("none");
  });

  it("reports no move when a row is dropped on a refused band", () => {
    const { container } = renderTable({ groups: REFUSING_GROUPS, onGroupDrop });

    dropRowOnBand(container, "1", "—");

    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("still accepts the sibling band that was not refused", () => {
    // Anti-vacuity: without this, a change that refused EVERY band would pass
    // both cases above.
    const { container } = renderTable({ groups: REFUSING_GROUPS, onGroupDrop });

    dropRowOnBand(container, "2", "Active");

    expect(onGroupDrop).toHaveBeenCalledWith(
      BETA,
      expect.objectContaining({ key: "active", value: "active" }),
      undefined,
      expect.stringMatching(GROUP_PLACEMENT_PATTERN)
    );
  });

  it("delivers the destination band's canonical value alongside its label", () => {
    const { container } = renderTable({ groups: REFUSING_GROUPS, onGroupDrop });

    dropRowOnBand(container, "2", "Active");

    const [, band] = onGroupDrop.mock.calls[0] as [
      Row,
      GridTableV2Group<Row>,
      GridTableV2Group<Row>?,
    ];
    // The label and the value are DIFFERENT strings here on purpose — a group
    // that carried only `key`/`label` could not tell a host these apart.
    expect(band.label).toBe("Active");
    expect(band.value).toBe("active");
  });

  it("lets a DROPPABLE subgroup accept even when its parent band refuses", () => {
    // The mirror of the containment case above, and the one the naive fix gets
    // wrong: the accepting handler must stop the event before the refusing
    // parent overwrites `dropEffect` to "none" and cancels the drag outright.
    const { container } = renderTable({
      groups: REFUSING_PARENT_LIVE_SUBGROUP,
      onGroupDrop,
    });

    const band = bandElement(container, "Active");
    const dataTransfer = createDataTransfer();
    dataTransfer.setData(GRID_ROW_DRAG_TYPE, ALPHA.id);
    const dragOver = fireEvent.dragOver(band, { dataTransfer });

    expect(dragOver).toBe(false);
    expect(dataTransfer.dropEffect).toBe("move");

    dropRowOnBand(container, "1", "Active");

    expect(onGroupDrop).toHaveBeenCalledTimes(1);
    expect(onGroupDrop).toHaveBeenCalledWith(
      ALPHA,
      expect.objectContaining({ key: "ada" }),
      expect.objectContaining({ key: "active", value: "active" }),
      expect.stringMatching(GROUP_PLACEMENT_PATTERN)
    );
  });
});

describe("GridTableV2 group drop — narrow mode honours the same refusal", () => {
  it("refuses a narrow-list subgroup the producer could not map", () => {
    const { container } = renderTable({
      groups: [
        {
          items: [ALPHA],
          key: "ada",
          label: "Ada",
          subgroups: [
            { droppable: false, items: [ALPHA], key: "unknown", label: "—" },
          ],
        },
      ],
      mode: "compact",
      onGroupDrop,
    });

    const band = bandElement(container, "—");
    const dataTransfer = createDataTransfer();
    const dragOver = fireEvent.dragOver(band, { dataTransfer });

    expect(dragOver).toBe(true);
    expect(dataTransfer.dropEffect).toBe("none");
    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("still accepts a narrow-list subgroup that IS mappable", () => {
    // Anti-vacuity for the case above: a card path that attached no handlers at
    // all would pass it, and this is what tells the two apart.
    const { container } = renderTable({
      groups: [
        {
          items: [ALPHA],
          key: "ada",
          label: "Ada",
          subgroups: [
            {
              droppable: true,
              items: [ALPHA],
              key: "active",
              label: "Active",
              value: "active",
            },
          ],
        },
      ],
      mode: "compact",
      onGroupDrop,
    });

    const band = bandElement(container, "Active");
    const dataTransfer = createDataTransfer();
    dataTransfer.setData(GRID_ROW_DRAG_TYPE, ALPHA.id);
    const dragOver = fireEvent.dragOver(band, { dataTransfer });

    expect(dragOver).toBe(false);
    expect(dataTransfer.dropEffect).toBe("move");
  });
});

describe("GridTableV2 group drop — an edit gesture is not a row drag (ISS-9490)", () => {
  it("cancels a drag that starts as text selected in a cell's field, so no band moves the row or the text", () => {
    const { container } = renderTable({
      groups: GROUPS,
      onGroupDrop,
      renderCell: (_columnId, row) => (
        <input aria-label={`Name of ${row.name}`} defaultValue={row.name} />
      ),
    });
    const band = bandElement(container, "Done");
    const row = container.querySelector<HTMLElement>('[data-grid-row-id="1"]');
    if (!row) {
      throw new Error("no row rendered for Alpha");
    }

    // The same row, dragged by the row: this is the drag the guard must keep.
    const rowDrag = createDataTransfer();
    expect(fireEvent.dragStart(row, { dataTransfer: rowDrag })).toBe(true);
    fireEvent.drop(band, { dataTransfer: rowDrag });
    fireEvent.dragEnd(row, { dataTransfer: rowDrag });
    expect(onGroupDrop).toHaveBeenCalledTimes(1);
    onGroupDrop.mockClear();

    const textDrag = createDataTransfer();
    const field = within(row).getByRole("textbox", { name: "Name of Alpha" });
    // `false` means `preventDefault` ran: the browser starts no drag at all, so
    // no band can accept the selected text as a move out of the field.
    expect(fireEvent.dragStart(field, { dataTransfer: textDrag })).toBe(false);
    fireEvent.drop(band, { dataTransfer: textDrag });

    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("leaves a text drag native in a grid whose rows cannot be dragged", () => {
    const { container } = renderTable({
      groups: GROUPS,
      renderCell: (_columnId, row) => (
        <input aria-label={`Name of ${row.name}`} defaultValue={row.name} />
      ),
    });
    const row = container.querySelector<HTMLElement>('[data-grid-row-id="1"]');
    if (!row) {
      throw new Error("no row rendered for Alpha");
    }
    const field = within(row).getByRole("textbox", { name: "Name of Alpha" });

    expect(row).toHaveAttribute("draggable", "false");
    expect(
      fireEvent.dragStart(field, { dataTransfer: createDataTransfer() })
    ).toBe(true);
  });
});

const GROUP_PLACEMENT_PATTERN = /^(start|end)$/;
