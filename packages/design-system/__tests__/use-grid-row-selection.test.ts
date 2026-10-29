import { useGridRowSelection } from "@closedloop-ai/design-system/hooks/use-grid-row-selection";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type Row = { id: string };

const VISIBLE_ROW_IDS = ["one", "two", "three", "four"];

const UNMODIFIED = { ctrlKey: false, metaKey: false, shiftKey: false };
const SHIFT = { ctrlKey: false, metaKey: false, shiftKey: true };
const CONTROL = { ctrlKey: true, metaKey: false, shiftKey: false };
const COMMAND = { ctrlKey: false, metaKey: true, shiftKey: false };

function row(id: string): Row {
  return { id };
}

describe("list row selection", () => {
  it("replaces selection on a plain click", () => {
    const { result } = renderHook(() =>
      useGridRowSelection<Row>({ visibleRowIds: VISIBLE_ROW_IDS })
    );
    act(() => result.current.onRowSelection(row("one"), UNMODIFIED));
    act(() => result.current.onRowSelection(row("two"), CONTROL));
    act(() => result.current.onRowSelection(row("three"), UNMODIFIED));
    expect([...result.current.selectedIds]).toEqual(["three"]);
  });

  it("toggles one row with Command or Control", () => {
    const { result } = renderHook(() =>
      useGridRowSelection<Row>({ visibleRowIds: VISIBLE_ROW_IDS })
    );
    act(() => result.current.onRowSelection(row("one"), UNMODIFIED));
    act(() => result.current.onRowSelection(row("two"), CONTROL));
    act(() => result.current.onRowSelection(row("two"), COMMAND));
    expect([...result.current.selectedIds]).toEqual(["one"]);
    act(() => result.current.onRowSelection(row("three"), CONTROL));
    expect([...result.current.selectedIds]).toEqual(["one", "three"]);
  });

  it("selects the inclusive rendered range while Shift is held", () => {
    const { result } = renderHook(() =>
      useGridRowSelection<Row>({ visibleRowIds: VISIBLE_ROW_IDS })
    );
    act(() => result.current.onRowSelection(row("one"), UNMODIFIED));
    act(() => result.current.onRowSelection(row("three"), SHIFT));
    expect([...result.current.selectedIds]).toEqual(["one", "two", "three"]);
  });
});

/**
 * The order a range is sliced from (whitlockk review).
 *
 * `GridTableV2` hands every row-activation path the list it actually PAINTED,
 * and with `groups` supplied that list is not the host's paged order: the grid
 * re-bands the same rows and owns the collapsed set. A host that drops the
 * argument and slices its own order resolves a range over a sequence nothing
 * rendered, which on screen reads as a non-contiguous selection and can reach
 * rows sitting inside another band.
 */
describe("list selection order", () => {
  it("slices the range from the rows the grid rendered, not the paged order", () => {
    const { result } = renderHook(() =>
      useGridRowSelection<Row>({ visibleRowIds: VISIBLE_ROW_IDS })
    );
    // Grouping put "four" beside "one"; the paged order still reads
    // one, two, three, four.
    const rendered = [row("one"), row("four"), row("two"), row("three")];

    act(() => {
      result.current.onRowSelection(row("one"), UNMODIFIED, rendered);
    });
    act(() => {
      result.current.onRowSelection(row("four"), SHIFT, rendered);
    });

    // Two rows, the two the reader saw adjacent. Sliced from the paged order
    // this is one→two→three→four: the whole table, including two rows the drag
    // never crossed.
    expect([...result.current.selectedIds]).toEqual(["one", "four"]);
  });

  it("falls back to the host's order when the caller supplies none", () => {
    const { result } = renderHook(() =>
      useGridRowSelection<Row>({ visibleRowIds: VISIBLE_ROW_IDS })
    );

    // The CARD path, which paints the paged order itself and passes no third
    // argument. Positive control for the case above: the fallback must still be
    // a real range, not an empty one.
    act(() => {
      result.current.onRowSelection(row("one"), UNMODIFIED);
    });
    act(() => {
      result.current.onRowSelection(row("three"), SHIFT);
    });

    expect([...result.current.selectedIds]).toEqual(["one", "two", "three"]);
  });
});

/**
 * ISS-9574 — the hook half of "a selection contains only rows the user can
 * still see". The RULE is `reconcileGridRowSelection`'s and is unit-tested in
 * `packages/design-system/__tests__/grid-table-v2-selection.test.ts`; what these
 * cases pin is that this hook calls it, on both the id axis and the anchor, so
 * deleting the effect reddens here rather than nowhere.
 */
describe("list selection reconciliation", () => {
  it("drops selected rows the narrowed page no longer holds", () => {
    const { rerender, result } = renderHook(
      ({ visibleRowIds }: { visibleRowIds: readonly string[] }) =>
        useGridRowSelection<Row>({ visibleRowIds }),
      { initialProps: { visibleRowIds: VISIBLE_ROW_IDS } }
    );

    act(() => {
      result.current.onRowSelection(row("one"), UNMODIFIED);
    });
    act(() => {
      result.current.onRowSelection(row("three"), SHIFT);
    });
    expect([...result.current.selectedIds]).toEqual(["one", "two", "three"]);

    // A filter, a page change or a live-row arrival — the hook sees only the
    // narrowed row set, which is the whole point of taking one input.
    rerender({ visibleRowIds: ["two", "four"] });

    expect([...result.current.selectedIds]).toEqual(["two"]);
  });

  it("drops the anchor with the rows, so clearing the filter does not revive a range from it", () => {
    const { rerender, result } = renderHook(
      ({ visibleRowIds }: { visibleRowIds: readonly string[] }) =>
        useGridRowSelection<Row>({ visibleRowIds }),
      { initialProps: { visibleRowIds: VISIBLE_ROW_IDS } }
    );

    act(() => {
      result.current.onRowSelection(row("one"), UNMODIFIED);
    });

    // A ROUND TRIP is what makes the anchor observable at all. While `one` is
    // filtered out, a Shift cannot reach it either way — `resolveGridRowSelection`
    // refuses an anchor the render does not paint, so a kept anchor and a dropped
    // one produce the same selection and a test that stopped here would pass
    // against both. It is the return that separates them.
    rerender({ visibleRowIds: ["two", "three", "four"] });
    rerender({ visibleRowIds: VISIBLE_ROW_IDS });

    act(() => {
      result.current.onRowSelection(row("three"), SHIFT);
    });

    // Dropped: a plain selection, which is what the reader could have drawn.
    // Kept: `one` is paintable again, so this extends one→three and hands back
    // three rows off a click the reader made in a result set that no longer
    // exists.
    expect([...result.current.selectedIds]).toEqual(["three"]);
  });

  it("leaves a selection alone when the row set is unchanged", () => {
    const { rerender, result } = renderHook(
      ({ visibleRowIds }: { visibleRowIds: readonly string[] }) =>
        useGridRowSelection<Row>({ visibleRowIds }),
      { initialProps: { visibleRowIds: [...VISIBLE_ROW_IDS] } }
    );

    act(() => {
      result.current.onRowSelection(row("two"), UNMODIFIED);
    });
    // A fresh array of the same ids — what every re-render of the host hands
    // this hook. The positive control for the three cases above: a rule that
    // pruned on identity rather than membership would clear this.
    rerender({ visibleRowIds: [...VISIBLE_ROW_IDS] });

    expect([...result.current.selectedIds]).toEqual(["two"]);
  });

  it("uses only the grid callback while the grid is mounted", () => {
    const onChange = vi.fn();
    const selectedIds = new Set(["one", "two"]);
    const { rerender, result } = renderHook(
      ({ visibleRowIds }: { visibleRowIds: readonly string[] }) =>
        useGridRowSelection<Row>({
          controller: { onChange, selectedIds },
          reconcileVisibleRows: false,
          visibleRowIds,
        }),
      { initialProps: { visibleRowIds: VISIBLE_ROW_IDS } }
    );

    rerender({ visibleRowIds: ["two", "three"] });
    expect(onChange).not.toHaveBeenCalled();

    act(() => result.current.reconcileSelection([row("two"), row("three")]));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect([...vi.mocked(onChange).mock.calls[0]![0]]).toEqual(["two"]);
  });

  it("emits exactly one controlled change for an unmounted row-set change", () => {
    const onChange = vi.fn();
    const selectedIds = new Set(["one", "two"]);
    const { rerender } = renderHook(
      ({ visibleRowIds }: { visibleRowIds: readonly string[] }) =>
        useGridRowSelection<Row>({
          controller: { onChange, selectedIds },
          reconcileVisibleRows: true,
          visibleRowIds,
        }),
      { initialProps: { visibleRowIds: VISIBLE_ROW_IDS } }
    );

    rerender({ visibleRowIds: ["two", "three"] });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect([...vi.mocked(onChange).mock.calls[0]![0]]).toEqual(["two"]);
  });

  it("does not revive old-page ids when an async completion retains them", () => {
    const { rerender, result } = renderHook(
      ({ visibleRowIds }: { visibleRowIds: readonly string[] }) =>
        useGridRowSelection<Row>({
          reconcileVisibleRows: false,
          visibleRowIds,
        }),
      { initialProps: { visibleRowIds: ["one", "two"] } }
    );
    act(() => result.current.onRowSelection(row("one"), UNMODIFIED));
    act(() => result.current.onRowSelection(row("two"), CONTROL));

    rerender({ visibleRowIds: ["three", "four"] });
    act(() => result.current.reconcileSelection([row("three"), row("four")]));
    expect([...result.current.selectedIds]).toEqual([]);

    act(() => result.current.retainSelection(["two"]));
    rerender({ visibleRowIds: ["one", "two"] });
    act(() => result.current.reconcileSelection([row("one"), row("two")]));

    expect([...result.current.selectedIds]).toEqual([]);
  });
});
