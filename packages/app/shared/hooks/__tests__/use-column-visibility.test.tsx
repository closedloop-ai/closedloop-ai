import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentColumn, useColumnVisibility } from "../use-column-visibility";

afterEach(() => {
  localStorage.clear();
});

const STORAGE_KEY = "test:columns";
const ORDER_KEY = "test:column-order";

// A small canonical column list so the reorder math is easy to assert against.
const COLUMNS = [
  DocumentColumn.Type,
  DocumentColumn.Assignee,
  DocumentColumn.Priority,
] as const;

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

  it("drops unknown ids from a restored order so a stale id cannot reorder", () => {
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
  ])("falls back to the canonical order when the persisted order is %s", (_label, stored) => {
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
  });

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
