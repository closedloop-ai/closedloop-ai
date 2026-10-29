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

describe("useColumnVisibility column order (FEA-4165)", () => {
  it("reorders the visible columns and persists the new order", () => {
    const { result } = renderHook(() =>
      useColumnVisibility({
        storageKey: STORAGE_KEY,
        orderStorageKey: ORDER_KEY,
        columns: COLUMNS,
        // All three visible so the reordered subset is the whole set.
        defaults: {
          [DocumentColumn.Type]: true,
          [DocumentColumn.Assignee]: true,
          [DocumentColumn.Priority]: true,
        },
      })
    );

    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Type,
      DocumentColumn.Assignee,
      DocumentColumn.Priority,
    ]);

    // Move Priority to the front.
    act(() => {
      result.current.reorderColumns([
        DocumentColumn.Priority,
        DocumentColumn.Type,
        DocumentColumn.Assignee,
      ]);
    });

    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Priority,
      DocumentColumn.Type,
      DocumentColumn.Assignee,
    ]);
    // Persisted under the dedicated order key, not the visibility key.
    expect(JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]")).toEqual([
      DocumentColumn.Priority,
      DocumentColumn.Type,
      DocumentColumn.Assignee,
    ]);
  });

  it("restores a persisted order on mount", () => {
    localStorage.setItem(
      ORDER_KEY,
      JSON.stringify([
        DocumentColumn.Assignee,
        DocumentColumn.Priority,
        DocumentColumn.Type,
      ])
    );

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

    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Assignee,
      DocumentColumn.Priority,
      DocumentColumn.Type,
    ]);
  });

  it("keeps a hidden column's remembered slot when only the visible subset reorders", () => {
    const { result } = renderHook(() =>
      useColumnVisibility({
        storageKey: STORAGE_KEY,
        orderStorageKey: ORDER_KEY,
        columns: COLUMNS,
        defaults: {
          [DocumentColumn.Type]: true,
          // Assignee hidden — it is not in the header's visible subset.
          [DocumentColumn.Assignee]: false,
          [DocumentColumn.Priority]: true,
        },
      })
    );

    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Type,
      DocumentColumn.Priority,
    ]);

    // Header only knows Type + Priority; user swaps them.
    act(() => {
      result.current.reorderColumns([
        DocumentColumn.Priority,
        DocumentColumn.Type,
      ]);
    });

    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Priority,
      DocumentColumn.Type,
    ]);
    // Hidden Assignee keeps its middle slot in the persisted full order, so
    // re-showing it later lands it back between the two.
    expect(JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]")).toEqual([
      DocumentColumn.Priority,
      DocumentColumn.Assignee,
      DocumentColumn.Type,
    ]);
  });

  it("preserves a moved-then-hidden column's slot across a later reorder", () => {
    // Persisted order deviates from canonical (Assignee was moved to the front)
    // and Assignee is hidden, so it is not in the header's visible subset.
    localStorage.setItem(
      ORDER_KEY,
      JSON.stringify([
        DocumentColumn.Assignee,
        DocumentColumn.Type,
        DocumentColumn.Priority,
      ])
    );

    const { result } = renderHook(() =>
      useColumnVisibility({
        storageKey: STORAGE_KEY,
        orderStorageKey: ORDER_KEY,
        columns: COLUMNS,
        defaults: {
          [DocumentColumn.Type]: true,
          [DocumentColumn.Assignee]: false,
          [DocumentColumn.Priority]: true,
        },
      })
    );

    // Header sees only Type + Priority (in the persisted order); user swaps.
    act(() => {
      result.current.reorderColumns([
        DocumentColumn.Priority,
        DocumentColumn.Type,
      ]);
    });

    // Hidden Assignee keeps its user-moved front slot rather than snapping back
    // to its canonical middle position.
    expect(JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]")).toEqual([
      DocumentColumn.Assignee,
      DocumentColumn.Priority,
      DocumentColumn.Type,
    ]);
  });

  it("ignores an unknown id in a restored order when arranging the drawn columns", () => {
    localStorage.setItem(
      ORDER_KEY,
      JSON.stringify(["not-a-column", DocumentColumn.Priority])
    );

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

    // Priority pulled to the front; the unknown id is ignored; the remaining
    // known columns keep their natural order at the end.
    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Priority,
      DocumentColumn.Type,
      DocumentColumn.Assignee,
    ]);
  });

  it("leaves order at the canonical default and ignores reorders when ordering is disabled", () => {
    const { result } = renderHook(() =>
      useColumnVisibility({
        storageKey: STORAGE_KEY,
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
      ]);
    });

    // No orderStorageKey ⇒ reorder is a no-op; columns stay canonical.
    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Type,
      DocumentColumn.Assignee,
      DocumentColumn.Priority,
    ]);
    // The disabled-order reader must not deserialize the visibility record: the
    // visibility key still holds the record object, never an order array.
    const storedVisibility = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}"
    );
    expect(Array.isArray(storedVisibility)).toBe(false);
  });

  it.each([
    ["a JSON object", JSON.stringify({ [DocumentColumn.Priority]: 0 })],
    ["a JSON number", JSON.stringify(5)],
    ["a JSON string", JSON.stringify("priority")],
    ["an array with non-string members", JSON.stringify([1, 2, 3])],
  ])(
    "falls back to the canonical order when the persisted order is %s",
    (_label, stored) => {
      localStorage.setItem(ORDER_KEY, stored);

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

      // A malformed record must not throw during render; the order degrades to
      // the table's canonical column order.
      expect(result.current.visibleColumns).toEqual([
        DocumentColumn.Type,
        DocumentColumn.Assignee,
        DocumentColumn.Priority,
      ]);
    }
  );

  it("backfills a column the stored visibility record predates instead of hiding it", () => {
    // A legacy record written before Priority existed omits that key entirely.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        [DocumentColumn.Type]: true,
        [DocumentColumn.Assignee]: true,
      })
    );

    const { result } = renderHook(() =>
      useColumnVisibility({
        storageKey: STORAGE_KEY,
        columns: COLUMNS,
        defaults: {
          [DocumentColumn.Type]: true,
          [DocumentColumn.Assignee]: true,
          [DocumentColumn.Priority]: true,
        },
      })
    );

    // Priority is absent from the partial stored record but defaults to visible,
    // so the truthy visibility filter must still show it (not silently drop it).
    expect(result.current.visibleColumns).toContain(DocumentColumn.Priority);
    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Type,
      DocumentColumn.Assignee,
      DocumentColumn.Priority,
    ]);
  });

  it("resets the column order back to canonical", () => {
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
        DocumentColumn.Assignee,
        DocumentColumn.Type,
      ]);
    });
    expect(result.current.visibleColumns[0]).toBe(DocumentColumn.Priority);

    act(() => {
      result.current.resetColumnOrder();
    });
    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Type,
      DocumentColumn.Assignee,
      DocumentColumn.Priority,
    ]);
  });
});

/**
 * ISS-8533. This hook holds TWO adjacent `useLocalStorageState` calls: the visibility
 * RECORD and the column ORDER. The order read has always coerced downstream; the
 * record read was the unguarded one, and it is the record that is returned RAW to
 * callers as well as merged — so a malformed value reaches `!prev[column]` here and
 * `userVisibility[c] !== false` in the projects tables.
 */
describe("useColumnVisibility malformed persisted visibility (ISS-8533)", () => {
  it("RED: a stored null does not throw, and toggling still works", () => {
    localStorage.setItem(STORAGE_KEY, "null");

    const { result } = renderHook(() =>
      useColumnVisibility({ storageKey: STORAGE_KEY, columns: COLUMNS })
    );

    // Pre-fix `userVisibility` is null and `!prev[column]` throws on toggle.
    expect(() =>
      act(() => {
        result.current.toggleColumn(DocumentColumn.Priority);
      })
    ).not.toThrow();
  });

  it("PIN: a legitimately PARTIAL record survives untouched", () => {
    // The constraint. A record written before a column existed omits that key, and
    // the merge backfills it — so a whole-record rejection here would silently reset
    // preferences the user really set. "Partial" is about KEYS, not corruption.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [DocumentColumn.Priority]: false })
    );

    const { result } = renderHook(() =>
      useColumnVisibility({ storageKey: STORAGE_KEY, columns: COLUMNS })
    );

    expect(result.current.userVisibility).toEqual({
      [DocumentColumn.Priority]: false,
    });
    expect(result.current.visibility[DocumentColumn.Priority]).toBe(false);
    expect(result.current.visibility[DocumentColumn.Assignee]).toBe(true);
  });

  it("RED: ONE non-boolean member rejects the WHOLE record, not just that key", () => {
    // Member-wise filtering would leave the key absent from the raw record handed to
    // the column menu while the backfilled copy still SHOWS the column — an
    // unchecked switch for a visible column. Wholesale keeps the two agreeing.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        [DocumentColumn.Priority]: "false",
        [DocumentColumn.Assignee]: false,
      })
    );

    const { result } = renderHook(() =>
      useColumnVisibility({ storageKey: STORAGE_KEY, columns: COLUMNS })
    );

    expect(result.current.userVisibility[DocumentColumn.Assignee]).toBe(true);
    expect(result.current.visibility[DocumentColumn.Priority]).toBe(true);
  });
});
