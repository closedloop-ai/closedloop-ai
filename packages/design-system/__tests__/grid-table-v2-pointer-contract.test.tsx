import {
  GridContextualAction,
  GridInteractionContract,
} from "@closedloop-ai/design-system/components/ui/grid-interaction-contract";
import { GridRowDragHandle } from "@closedloop-ai/design-system/components/ui/grid-row-drag-handle";
import {
  GridTableV2,
  type GridTableV2Column,
  type GridTableV2Group,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { GridInteractionState } from "@closedloop-ai/design-system/lib/grid-interaction-contract";
import { GRID_ROW_DRAG_TYPE } from "@closedloop-ai/design-system/lib/grid-table-v2-group-drop";
import { createEvent, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type Row = { id: string; name: string };

const ALPHA: Row = { id: "alpha", name: "Alpha" };
const BETA: Row = { id: "beta", name: "Beta" };
const COLUMNS: readonly GridTableV2Column[] = [{ id: "name", label: "Name" }];
const GROUPS: readonly GridTableV2Group<Row>[] = [
  { items: [ALPHA], key: "active", label: "Active" },
  { items: [BETA], key: "done", label: "Done" },
];

describe("GridTableV2 pointer contract", () => {
  it("sets and clears dragging only for eligible row whitespace", () => {
    const { container } = renderContractGrid();
    const row = findRow(container, ALPHA.id);
    const dataTransfer = createDataTransfer();

    beginNativeRowDrag(row);
    fireEvent.dragStart(row, { dataTransfer });
    expect(row).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Dragging
    );

    fireEvent.dragEnd(row, { dataTransfer });
    expect(row).not.toHaveAttribute("data-interaction-state");
  });

  it("does not let controls, editors, or selection surfaces start row drag", () => {
    const { container } = renderContractGrid();
    const row = findRow(container, ALPHA.id);
    const setPointerCapture = vi.fn();
    row.setPointerCapture = setPointerCapture;
    const targets = [
      row.querySelector("button"),
      row.querySelector("input"),
      row.querySelector("[data-grid-primary-editor]"),
      row.querySelector("[data-row-selection-surface]"),
      row.querySelector("[contenteditable='true']"),
    ];

    for (const target of targets) {
      if (!(target instanceof globalThis.Element)) {
        throw new Error("expected every protected drag target to render");
      }
      const dataTransfer = createDataTransfer();
      beginNativeRowDrag(target);
      expect(fireEvent.dragStart(row, { dataTransfer })).toBe(false);
      expect(dataTransfer.getData(GRID_ROW_DRAG_TYPE)).toBe("");
      expect(row).not.toHaveAttribute("data-interaction-state");
      expect(setPointerCapture).not.toHaveBeenCalled();
    }
  });

  it("does not start a row drag from disabled drag handles", () => {
    const { container } = renderContractGrid({
      renderLead: () => (
        <div>
          <GridRowDragHandle aria-label="Disabled drag handle" disabled />
          <GridRowDragHandle
            aria-disabled="true"
            aria-label="ARIA-disabled drag handle"
          />
        </div>
      ),
    });
    const row = findRow(container, ALPHA.id);
    const handles = Array.from(
      row.querySelectorAll<HTMLButtonElement>("[data-grid-row-drag-handle]")
    );

    expect(handles).toHaveLength(2);

    for (const handle of handles) {
      const dataTransfer = createDataTransfer();
      beginNativeRowDrag(handle);
      expect(fireEvent.dragStart(row, { dataTransfer })).toBe(false);
      expect(dataTransfer.getData(GRID_ROW_DRAG_TYPE)).toBe("");
      expect(row).not.toHaveAttribute("data-interaction-state");
    }
  });

  it("keeps the legacy drag path unchanged outside the mastered wrapper", () => {
    const { container } = renderLegacyGrid();
    const row = findRow(container, ALPHA.id);
    const selectionSurface = row.querySelector("[data-row-selection-surface]");
    if (!(selectionSurface instanceof globalThis.Element)) {
      throw new Error("expected the legacy selection surface to render");
    }
    const dataTransfer = createDataTransfer();
    const setPointerCapture = vi.fn();
    row.setPointerCapture = setPointerCapture;

    fireEvent.pointerDown(selectionSurface);
    fireEvent.pointerMove(selectionSurface);
    expect(fireEvent.dragStart(row, { dataTransfer })).toBe(true);
    expect(dataTransfer.getData(GRID_ROW_DRAG_TYPE)).toBe(ALPHA.id);
    expect(row).not.toHaveAttribute("data-interaction-state");
    expect(setPointerCapture).not.toHaveBeenCalled();
  });

  it("leaves native link drag uncancelled when row moves are unavailable", () => {
    const { container } = renderContractGrid({
      canDragRow: () => false,
      onGroupDrop: undefined,
      renderLead: (item) => <a href={`/sessions/${item.id}`}>{item.name}</a>,
    });
    const row = findRow(container, ALPHA.id);
    const link = row.querySelector("a");
    if (!link) {
      throw new Error("expected the session link to render");
    }
    const dataTransfer = createDataTransfer();
    const setPointerCapture = vi.fn();
    row.setPointerCapture = setPointerCapture;
    dataTransfer.setData("text/uri-list", link.href);

    beginNativeRowDrag(link);
    const dragStart = createEvent.dragStart(link, { dataTransfer });

    expect(row).not.toHaveAttribute("draggable", "true");
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(fireEvent(link, dragStart)).toBe(true);
    expect(dragStart.defaultPrevented).toBe(false);
    expect(dataTransfer.getData("text/uri-list")).toBe(link.href);
    expect(dataTransfer.getData(GRID_ROW_DRAG_TYPE)).toBe("");
    expect(row).not.toHaveAttribute("data-interaction-state");
    expect(row).not.toHaveAttribute("data-state", "selected");
  });

  it("keeps link and eligible title whitespace draggable alongside an explicit handle", () => {
    const withHandle = renderContractGrid({
      renderLead: (item) => (
        <div>
          <a href={`/sessions/${item.id}`}>{item.name}</a>
          <span data-testid="title-drag-origin">Title whitespace</span>
          <GridRowDragHandle aria-label={`Drag ${item.name}`} />
        </div>
      ),
    });
    const handledRow = findRow(withHandle.container, ALPHA.id);
    const handledLink = handledRow.querySelector("a");
    const titleDragOrigin = handledRow.querySelector(
      '[data-testid="title-drag-origin"]'
    );
    const handle = handledRow.querySelector<HTMLButtonElement>(
      "[data-grid-row-drag-handle]"
    );
    if (!(handledLink && titleDragOrigin && handle)) {
      throw new Error("expected every handled row drag origin to render");
    }
    expect(handle).toHaveAttribute("draggable", "true");

    for (const origin of [handledLink, titleDragOrigin, handle]) {
      const acceptedTransfer = createDataTransfer();
      beginNativeRowDrag(origin);
      expect(
        fireEvent.dragStart(handledRow, { dataTransfer: acceptedTransfer })
      ).toBe(true);
      expect(acceptedTransfer.getData(GRID_ROW_DRAG_TYPE)).toBe(ALPHA.id);
      fireEvent.dragEnd(handledRow, { dataTransfer: acceptedTransfer });
    }
  });

  it("waits for the native trackpad drag threshold before capture, respects Cmd/Ctrl, and cancels intent", () => {
    const { container } = renderContractGrid();
    const row = findRow(container, ALPHA.id);
    const setPointerCapture = vi.fn();
    row.setPointerCapture = setPointerCapture;

    fireEvent.pointerDown(row, pointerEvent(1, 0, 0));
    fireEvent.pointerCancel(row, pointerEvent(1, 0, 0));
    expect(
      fireEvent.dragStart(row, { dataTransfer: createDataTransfer() })
    ).toBe(false);
    expect(setPointerCapture).not.toHaveBeenCalled();

    fireEvent.pointerDown(row, pointerEvent(2, 0, 0));
    fireEvent.pointerMove(row, pointerEvent(2, 1, 0));
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(fireModifiedDragStart(row, "ctrlKey")).toBe(false);

    fireEvent.pointerDown(row, pointerEvent(3, 0, 0));
    fireEvent.pointerMove(row, pointerEvent(3, 1, 0));
    fireEvent.pointerCancel(row, pointerEvent(3, 1, 0));
    expect(
      fireEvent.dragStart(row, { dataTransfer: createDataTransfer() })
    ).toBe(false);

    fireEvent.pointerDown(row, pointerEvent(4, 0, 0));
    fireEvent.pointerMove(row, pointerEvent(4, 1, 0));
    expect(fireModifiedDragStart(row, "metaKey")).toBe(false);
  });

  it.each(["row", "link", "handle"] as const)(
    "captures an accepted native %s drag only after the platform threshold and releases on cancel",
    (origin) => {
      const { container } = renderContractGrid({
        renderLead: (item) => (
          <div>
            <a href={`/sessions/${item.id}`}>{item.name}</a>
            {origin === "handle" ? (
              <GridRowDragHandle aria-label={`Drag ${item.name}`} />
            ) : null}
          </div>
        ),
      });
      const row = findRow(container, ALPHA.id);
      const capture = stubPointerCapture(row);
      let target: Element | null = row;
      if (origin === "link") {
        target = row.querySelector("a");
      } else if (origin === "handle") {
        target = row.querySelector("[data-grid-row-drag-handle]");
      }
      if (!target) {
        throw new Error(`expected the ${origin} drag origin`);
      }

      beginNativeRowDrag(target);
      expect(capture.set).not.toHaveBeenCalled();
      const dataTransfer = createDataTransfer();
      expect(fireEvent.dragStart(target, { dataTransfer })).toBe(true);
      expect(dataTransfer.getData(GRID_ROW_DRAG_TYPE)).toBe(ALPHA.id);
      expect(capture.set).toHaveBeenCalledExactlyOnceWith(1);
      expect(row.hasPointerCapture(1)).toBe(true);

      fireEvent.pointerCancel(row, pointerEvent(2, 1, 0));
      expect(capture.release).not.toHaveBeenCalled();
      fireEvent.pointerCancel(row, pointerEvent(1, 1, 0));
      expect(capture.release).toHaveBeenCalledExactlyOnceWith(1);
      expect(row.hasPointerCapture(1)).toBe(false);
      fireEvent.dragEnd(row, { dataTransfer });
      expect(row).not.toHaveAttribute("data-interaction-state");
      expect(capture.release).toHaveBeenCalledTimes(1);
    }
  );

  it("releases accepted pointer capture on dragend and rejects reuse after lost capture", () => {
    const { container } = renderContractGrid();
    const row = findRow(container, ALPHA.id);
    const capture = stubPointerCapture(row);
    const dataTransfer = createDataTransfer();

    beginNativeRowDrag(row);
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragEnd(row, { dataTransfer });
    expect(capture.release).toHaveBeenCalledExactlyOnceWith(1);
    expect(row.hasPointerCapture(1)).toBe(false);

    beginNativeRowDrag(row);
    fireEvent.dragStart(row, { dataTransfer: createDataTransfer() });
    fireEvent.lostPointerCapture(row, pointerEvent(1, 1, 0));
    expect(row.hasPointerCapture(1)).toBe(false);
    expect(
      fireEvent.dragStart(row, { dataTransfer: createDataTransfer() })
    ).toBe(false);
    beginNativeRowDrag(row);
    expect(
      fireEvent.dragStart(row, { dataTransfer: createDataTransfer() })
    ).toBe(true);
    fireEvent.pointerUp(row, pointerEvent(1, 1, 0));
    expect(row.hasPointerCapture(1)).toBe(false);
  });

  it("leaves an eligible link click with the link until native dragstart", () => {
    const onClick = vi.fn();
    const { container } = renderContractGrid({
      renderLead: (item) => (
        <a href={`/sessions/${item.id}`} onClick={onClick}>
          {item.name}
        </a>
      ),
    });
    const row = findRow(container, ALPHA.id);
    const link = row.querySelector("a");
    const setPointerCapture = vi.fn();
    row.setPointerCapture = setPointerCapture;
    if (!link) {
      throw new Error("expected the session link to render");
    }

    fireEvent.pointerDown(link, pointerEvent(1, 0, 0));
    fireEvent.pointerMove(link, pointerEvent(1, 1, 0));
    fireEvent.pointerUp(link, pointerEvent(1, 1, 0));
    fireEvent.click(link);

    expect(onClick).toHaveBeenCalledOnce();
    expect(setPointerCapture).not.toHaveBeenCalled();
  });

  it("leaves touch scrolling unclaimed even on an otherwise draggable row", () => {
    const { container } = renderContractGrid();
    const row = findRow(container, ALPHA.id);
    const capture = stubPointerCapture(row);
    const dataTransfer = createDataTransfer();

    fireEvent.pointerDown(row, {
      ...pointerEvent(1, 0, 0),
      pointerType: "touch",
    });
    fireEvent.pointerMove(row, {
      ...pointerEvent(1, 0, 100),
      pointerType: "touch",
    });
    expect(fireEvent.dragStart(row, { dataTransfer })).toBe(false);
    expect(dataTransfer.getData(GRID_ROW_DRAG_TYPE)).toBe("");
    expect(capture.set).not.toHaveBeenCalled();
    expect(row).not.toHaveAttribute("data-interaction-state");
    expect(row).not.toHaveAttribute("data-state", "selected");
  });

  it("refuses missing row payloads without painting an accepted destination", () => {
    const onGroupDrop = vi.fn();
    const { container } = renderContractGrid({ onGroupDrop });
    const doneBand = findBand(container, "Done");
    const dataTransfer = createDataTransfer();

    fireEvent.dragOver(doneBand, { dataTransfer });
    expect(doneBand).not.toHaveAttribute("data-interaction-state");
    expect(dataTransfer.dropEffect).toBe("none");
    fireEvent.drop(doneBand, { dataTransfer });
    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("sets drag-over only for a valid destination and clears it before drop", () => {
    const onGroupDrop = vi.fn();
    const { container } = renderContractGrid({ onGroupDrop });
    const row = findRow(container, ALPHA.id);
    const doneBand = findBand(container, "Done");
    const dataTransfer = createDataTransfer();

    beginNativeRowDrag(row);
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(doneBand, { dataTransfer });
    expect(doneBand).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.DragOver
    );

    fireEvent.drop(doneBand, { dataTransfer });
    expect(doneBand).not.toHaveAttribute("data-interaction-state");
    expect(onGroupDrop).toHaveBeenCalledWith(
      ALPHA,
      expect.objectContaining({ key: "done" }),
      undefined,
      "end"
    );
  });

  it("clears refused and exited destinations without a product mutation", () => {
    const onGroupDrop = vi.fn();
    const { container } = renderContractGrid({
      canDropOnGroup: (_row, group) => group.key !== "done",
      onGroupDrop,
    });
    const row = findRow(container, ALPHA.id);
    const activeBand = findBand(container, "Active");
    const doneBand = findBand(container, "Done");
    const dataTransfer = createDataTransfer();

    beginNativeRowDrag(row);
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(activeBand, { dataTransfer });
    expect(activeBand).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.DragOver
    );
    fireEvent.dragLeave(activeBand, { dataTransfer, relatedTarget: null });
    expect(activeBand).not.toHaveAttribute("data-interaction-state");

    fireEvent.dragOver(doneBand, { dataTransfer });
    expect(doneBand).not.toHaveAttribute("data-interaction-state");
    expect(dataTransfer.dropEffect).toBe("none");
    fireEvent.drop(doneBand, { dataTransfer });
    expect(onGroupDrop).not.toHaveBeenCalled();
  });

  it("gives the innermost nested destination exclusive drag-over ownership", () => {
    const nestedGroups: readonly GridTableV2Group<Row>[] = [
      {
        items: [ALPHA],
        key: "owner",
        label: "Owner",
        subgroups: [{ items: [ALPHA], key: "active", label: "Active" }],
      },
    ];
    const { container } = renderContractGrid({ groups: [...nestedGroups] });
    const parent = findOuterBand(container, "Owner");
    const subgroup = findInnerBand(container, "Active");
    const row = findRow(container, ALPHA.id);
    const dataTransfer = createDataTransfer();

    beginNativeRowDrag(row);
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragEnter(parent, { dataTransfer });
    expect(parent).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.DragOver
    );

    fireEvent.dragEnter(subgroup, { dataTransfer });
    expect(parent).not.toHaveAttribute("data-interaction-state");
    expect(subgroup).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.DragOver
    );
  });

  it("clears an accepting parent when the nested drop predicate refuses", () => {
    const nestedGroups: readonly GridTableV2Group<Row>[] = [
      {
        items: [ALPHA],
        key: "owner",
        label: "Owner",
        subgroups: [{ items: [ALPHA], key: "unknown", label: "Unknown" }],
      },
    ];
    const { container } = renderContractGrid({
      canDropOnGroup: (_row, _group, subgroup) => subgroup?.key !== "unknown",
      groups: [...nestedGroups],
    });
    const parent = findOuterBand(container, "Owner");
    const subgroup = findInnerBand(container, "Unknown");
    const row = findRow(container, ALPHA.id);
    const dataTransfer = createDataTransfer();

    beginNativeRowDrag(row);
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragEnter(parent, { dataTransfer });
    expect(parent).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.DragOver
    );
    fireEvent.dragEnter(subgroup, { dataTransfer });

    expect(parent).not.toHaveAttribute("data-interaction-state");
    expect(subgroup).not.toHaveAttribute("data-interaction-state");
  });

  it("clears a painted destination when the drag is canceled", () => {
    const { container } = renderContractGrid();
    const row = findRow(container, ALPHA.id);
    const doneBand = findBand(container, "Done");
    const dataTransfer = createDataTransfer();

    beginNativeRowDrag(row);
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(doneBand, { dataTransfer });
    expect(doneBand).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.DragOver
    );

    fireEvent.dragEnd(row, { dataTransfer });
    expect(row).not.toHaveAttribute("data-interaction-state");
    expect(doneBand).not.toHaveAttribute("data-interaction-state");
  });

  it("clears compact card destinations after exclusive hover, drop, and cancel", () => {
    const groups: readonly GridTableV2Group<Row>[] = [
      {
        items: [ALPHA, BETA],
        key: "owner",
        label: "Owner",
        subgroups: [
          { items: [ALPHA], key: "active", label: "Active" },
          { items: [BETA], key: "done", label: "Done" },
        ],
      },
    ];
    const first = renderContractGrid({
      cardRender: (item) => <span>{item.name}</span>,
      groups: [...groups],
      mode: "compact",
    });
    const activeBand = findCompactBand(first.container, "Active");
    const doneBand = findCompactBand(first.container, "Done");
    const dataTransfer = createDataTransfer();
    dataTransfer.setData(GRID_ROW_DRAG_TYPE, ALPHA.id);

    fireEvent.dragOver(activeBand, { dataTransfer });
    fireEvent.dragOver(doneBand, { dataTransfer });
    expect(activeBand).not.toHaveAttribute("data-interaction-state");
    expect(doneBand).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.DragOver
    );

    fireEvent.drop(doneBand, { dataTransfer });
    expect(doneBand).not.toHaveAttribute("data-interaction-state");
    first.unmount();

    const canceled = renderContractGrid({
      cardRender: (item) => <span>{item.name}</span>,
      groups: [...groups],
      mode: "compact",
    });
    const canceledBand = findCompactBand(canceled.container, "Active");
    fireEvent.dragOver(canceledBand, { dataTransfer });
    fireEvent.dragLeave(canceledBand, {
      dataTransfer,
      relatedTarget: null,
    });
    expect(canceledBand).not.toHaveAttribute("data-interaction-state");
  });

  it("gives contextual actions a real compact-card reveal group", () => {
    const { container } = renderContractGrid({
      cardRender: (item) => (
        <GridContextualAction asChild>
          <button aria-label={`Edit ${item.name}`} type="button">
            Edit
          </button>
        </GridContextualAction>
      ),
      mode: "compact",
    });
    const card = findCard(container, ALPHA.id);
    const action = card.querySelector<HTMLElement>(
      "[data-grid-contextual-action]"
    );

    expect(card).toHaveClass("group/row");
    expect(action).not.toBeNull();
    expect(action).toHaveAttribute("data-grid-contextual-action", "");
    expect(action).not.toHaveClass(
      "opacity-0",
      "group-hover/row:opacity-100",
      "group-focus-within/row:opacity-100"
    );
  });
});

describe("grid interaction primitives", () => {
  it("publishes state and preserves contextual action layout ownership", () => {
    const { getByRole, getByTestId } = render(
      <GridInteractionContract state={GridInteractionState.Loading}>
        <div className="group/row" data-testid="row">
          <GridContextualAction asChild>
            <button type="button">Edit</button>
          </GridContextualAction>
          <GridContextualAction asChild open>
            <button type="button">Move</button>
          </GridContextualAction>
          <GridRowDragHandle aria-label="Drag to reorder" disabled />
        </div>
      </GridInteractionContract>
    );

    expect(getByTestId("row").parentElement).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Loading
    );
    expect(getByTestId("row").parentElement).toHaveAttribute(
      "aria-busy",
      "true"
    );
    expect(getByRole("button", { name: "Edit" })).toHaveAttribute(
      "data-grid-contextual-action",
      ""
    );
    expect(getByRole("button", { name: "Move" })).toHaveAttribute(
      "data-state",
      "open"
    );
    expect(getByRole("button", { name: "Drag to reorder" })).toBeDisabled();
    expect(getByRole("button", { name: "Drag to reorder" })).toHaveAttribute(
      "data-grid-row-drag-handle",
      ""
    );
  });

  it("keeps its wrapper but omits mastered state when disabled", () => {
    const { getByTestId, rerender } = render(
      <GridInteractionContract
        enabled={false}
        state={GridInteractionState.Loading}
      >
        <div data-testid="disabled-contract" />
      </GridInteractionContract>
    );
    const wrapper = getByTestId("disabled-contract").parentElement;

    expect(wrapper).not.toBeNull();
    expect(wrapper).not.toHaveAttribute("data-grid-interaction-contract");
    expect(wrapper).not.toHaveAttribute("data-interaction-state");
    expect(wrapper).not.toHaveAttribute("aria-busy");
    expect(wrapper).not.toHaveAttribute("aria-invalid");

    rerender(
      <GridInteractionContract
        enabled={false}
        state={GridInteractionState.Error}
      >
        <div data-testid="disabled-contract" />
      </GridInteractionContract>
    );
    expect(getByTestId("disabled-contract").parentElement).toBe(wrapper);
    expect(wrapper).not.toHaveAttribute("aria-invalid");
  });
});

function renderContractGrid(
  props: Partial<React.ComponentProps<typeof GridTableV2<Row>>> = {}
) {
  return render(
    <GridInteractionContract>
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="minmax(200px, 1fr) 120px"
        groups={[...GROUPS]}
        items={[]}
        leadingLabel="Name"
        onGroupDrop={() => undefined}
        renderCell={(_columnId, row) => row.name}
        renderLead={(row) => (
          <div>
            <button type="button">Open {row.name}</button>
            <input aria-label={`Edit ${row.name}`} defaultValue={row.name} />
            <span data-grid-primary-editor="">Primary editor {row.name}</span>
            <span data-row-selection-surface="">Select {row.name}</span>
            <span contentEditable suppressContentEditableWarning>
              Rich editor {row.name}
            </span>
          </div>
        )}
        {...props}
      />
    </GridInteractionContract>
  );
}

function renderLegacyGrid() {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns="minmax(200px, 1fr) 120px"
      groups={[...GROUPS]}
      items={[]}
      leadingLabel="Name"
      onGroupDrop={() => undefined}
      renderCell={(_columnId, row) => row.name}
      renderLead={(row) => (
        <span data-row-selection-surface="">Select {row.name}</span>
      )}
    />
  );
}

function findRow(container: HTMLElement, rowId: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"]`
  );
  if (!row) {
    throw new Error(`no row rendered for ${rowId}`);
  }
  return row;
}

function findBand(container: HTMLElement, label: string): HTMLElement {
  const bands = Array.from(
    container.querySelectorAll<HTMLElement>('[role="rowgroup"]')
  );
  const band = bands.find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!band) {
    throw new Error(`no band rendered for ${label}`);
  }
  return band;
}

function findOuterBand(container: HTMLElement, label: string): HTMLElement {
  const band = Array.from(
    container.querySelectorAll<HTMLElement>('[role="rowgroup"]')
  ).find((candidate) =>
    candidate.firstElementChild?.textContent?.includes(label)
  );
  if (!band) {
    throw new Error(`no outer band rendered for ${label}`);
  }
  return band;
}

function findInnerBand(container: HTMLElement, label: string): HTMLElement {
  const bands = Array.from(
    container.querySelectorAll<HTMLElement>('[role="rowgroup"]')
  ).filter((candidate) => candidate.textContent?.includes(label));
  const band = bands.find(
    (candidate) =>
      !bands.some((other) => other !== candidate && candidate.contains(other))
  );
  if (!band) {
    throw new Error(`no inner band rendered for ${label}`);
  }
  return band;
}

function findCompactBand(container: HTMLElement, label: string): HTMLElement {
  const bands = Array.from(
    container.querySelectorAll<HTMLElement>("div.border-l")
  ).filter((candidate) => candidate.textContent?.includes(label));
  const band = bands.find(
    (candidate) =>
      !bands.some((other) => other !== candidate && candidate.contains(other))
  );
  if (!band) {
    throw new Error(`no compact band rendered for ${label}`);
  }
  return band;
}

function findCard(container: HTMLElement, rowId: string): HTMLElement {
  const card = container.querySelector<HTMLElement>(
    `[data-grid-card-id="${rowId}"]`
  );
  if (!card) {
    throw new Error(`no compact card rendered for ${rowId}`);
  }
  return card;
}

function createDataTransfer() {
  const data = new Map<string, string>();
  const types: string[] = [];
  return {
    dropEffect: "none",
    effectAllowed: "none",
    getData: (type: string) => data.get(type) ?? "",
    setData: (type: string, value: string) => data.set(type, value),
    types,
  };
}

function beginNativeRowDrag(target: Element): void {
  fireEvent.pointerDown(target, pointerEvent(1, 0, 0));
  fireEvent.pointerMove(target, pointerEvent(1, 1, 0));
}

function pointerEvent(pointerId: number, clientX: number, clientY: number) {
  return { button: 0, clientX, clientY, pointerId, pointerType: "mouse" };
}

function fireModifiedDragStart(
  target: HTMLElement,
  modifier: "ctrlKey" | "metaKey"
): boolean {
  const event = createEvent.dragStart(target, {
    dataTransfer: createDataTransfer(),
  });
  Object.defineProperty(event, modifier, { value: true });
  return fireEvent(target, event);
}

function stubPointerCapture(row: HTMLElement) {
  const captured = new Set<number>();
  const set = vi.fn((pointerId: number) => captured.add(pointerId));
  const release = vi.fn((pointerId: number) => captured.delete(pointerId));
  row.setPointerCapture = set;
  row.releasePointerCapture = release;
  row.hasPointerCapture = (pointerId) => captured.has(pointerId);
  return { release, set };
}
