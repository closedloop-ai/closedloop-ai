import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentColumn, useColumnVisibility } from "../use-column-visibility";
import {
  COLUMNS,
  ORDER_KEY,
  STORAGE_KEY,
} from "./use-column-visibility.test-support";

afterEach(() => {
  localStorage.clear();
});

// A column this build's table has no entry for: a real column id that COLUMNS
// omits, which is what an order stored by a build with a wider column set looks
// like from in here — present in the record, absent from `allColumnIds`.
const FUTURE_COLUMN = DocumentColumn.DueDate;

// The same table on the build that DOES have that column.
const WIDER_COLUMNS = [...COLUMNS, FUTURE_COLUMN] as const;

/**
 * ISS-9908. A stored order can name a column this build has no entry for — written
 * by a newer build, or read after a downgrade. The READ path already ignored such an
 * id; the WRITE path DELETED it, so a reader's arrangement of that column was gone on
 * their first drag, silently and unrecoverably. These pin the write path.
 *
 * Split out of `use-column-visibility.test.tsx` (PR #6970 review): that file carries
 * the FEA-4165 order suite and the ISS-8533 malformed-record suite, and folding a
 * third contract in took it past the repo's ~500-line split-by-responsibility signal.
 */
describe("useColumnVisibility carried column ids (ISS-9908)", () => {
  it("keeps a carried id at its exact stored slot through a reorder", () => {
    const { result } = renderWithCarriedOrder();

    act(() => {
      result.current.reorderColumns([
        DocumentColumn.Priority,
        DocumentColumn.Type,
        DocumentColumn.Assignee,
      ]);
    });

    // Priority moved to the front, and the carried id is still between the two
    // columns it was between — not discarded, and not pushed to the end.
    expect(JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]")).toEqual([
      DocumentColumn.Priority,
      FUTURE_COLUMN,
      DocumentColumn.Type,
      DocumentColumn.Assignee,
    ]);
  });

  it("puts the carried column back where the reader left it on the build that has it", () => {
    const { result } = renderWithCarriedOrder();

    act(() => {
      result.current.reorderColumns([
        DocumentColumn.Priority,
        DocumentColumn.Type,
        DocumentColumn.Assignee,
      ]);
    });

    // The build that DOES draw the column mounts against the record just written.
    const { result: wider } = renderHook(() =>
      useColumnVisibility({
        storageKey: STORAGE_KEY,
        orderStorageKey: ORDER_KEY,
        columns: WIDER_COLUMNS,
        defaults: {
          [DocumentColumn.Type]: true,
          [DocumentColumn.Assignee]: true,
          [DocumentColumn.Priority]: true,
        },
      })
    );

    expect(wider.current.visibleColumns).toEqual([
      DocumentColumn.Priority,
      FUTURE_COLUMN,
      DocumentColumn.Type,
      DocumentColumn.Assignee,
    ]);
  });

  it("never lets a carried id reach the render path on the build that lacks it", () => {
    const { result } = renderWithCarriedOrder();

    act(() => {
      result.current.reorderColumns([
        DocumentColumn.Priority,
        DocumentColumn.Type,
        DocumentColumn.Assignee,
      ]);
    });

    // Only the stored record round-trips whole; the applied half stays filtered
    // to the columns this table actually has.
    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Priority,
      DocumentColumn.Type,
      DocumentColumn.Assignee,
    ]);
  });

  it("refuses a caller-supplied id that is neither a column of this table nor already stored", () => {
    const { result } = renderHook(() =>
      useColumnVisibility({
        storageKey: STORAGE_KEY,
        orderStorageKey: ORDER_KEY,
        columns: COLUMNS,
        defaults: {
          [DocumentColumn.Type]: true,
          [DocumentColumn.Assignee]: true,
          [DocumentColumn.Priority]: true,
        },
      })
    );

    act(() => {
      result.current.reorderColumns([
        DocumentColumn.Priority,
        DocumentColumn.Type,
        DocumentColumn.Assignee,
        "caller-injected",
      ]);
    });

    // Nothing stored predates this build, so this table's own columns are the
    // only ids allowed into the record — the injected one is not written, and
    // the real ones are not dropped alongside it.
    expect(JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]")).toEqual([
      DocumentColumn.Priority,
      DocumentColumn.Type,
      DocumentColumn.Assignee,
    ]);
  });

  it("still discards carried ids on reset, deliberately", () => {
    const { result } = renderWithCarriedOrder();

    act(() => {
      result.current.reorderColumns([
        DocumentColumn.Priority,
        DocumentColumn.Type,
        DocumentColumn.Assignee,
      ]);
    });

    act(() => {
      result.current.resetColumnOrder();
    });

    // A reset is the reader asking for the shipped arrangement outright, so
    // dropping the carried ids there is a choice they made and can see — the
    // opposite of the silent erasure ISS-9908 removes. Unchanged by ISS-9908,
    // and pinned here so a later "fix" cannot quietly reverse it.
    expect(JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]")).toEqual([]);
  });
});

/**
 * Mount the table on the build that has no column for {@link FUTURE_COLUMN},
 * against a stored order naming it between two columns this build does draw.
 * A function declaration so the block above can reach it.
 */
function renderWithCarriedOrder() {
  localStorage.setItem(
    ORDER_KEY,
    JSON.stringify([
      DocumentColumn.Type,
      FUTURE_COLUMN,
      DocumentColumn.Priority,
    ])
  );
  return renderHook(() =>
    useColumnVisibility({
      storageKey: STORAGE_KEY,
      orderStorageKey: ORDER_KEY,
      columns: COLUMNS,
      defaults: {
        [DocumentColumn.Type]: true,
        [DocumentColumn.Assignee]: true,
        [DocumentColumn.Priority]: true,
      },
    })
  );
}
