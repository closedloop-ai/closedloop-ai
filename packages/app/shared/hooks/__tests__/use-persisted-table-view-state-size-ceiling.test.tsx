import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_PRESERVED_COLUMN_IDS } from "../../lib/preserved-column-ids";
import {
  MAX_SERIALIZED_TABLE_VIEW_LENGTH,
  NO_OPAQUE_STORED_VIEW_FIELDS,
  serializeTableView,
  serializeTableViewWithinCeiling,
} from "../persisted-table-view-snapshot";
import {
  type RestoredTableView,
  usePersistedTableViewState,
} from "../use-persisted-table-view-state";
import {
  COLUMN_IDS,
  type ColumnId,
  type Extras,
  parse,
  render,
  type SortDir,
  type SortKey,
} from "./persisted-table-view-state.test-support";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const STORAGE_KEY = "test:view:web";
const HUGE_ID = "x".repeat(MAX_SERIALIZED_TABLE_VIEW_LENGTH);
const DECLARED_COLUMN_IDS: ReadonlySet<string> = new Set(COLUMN_IDS);

function seedSavedView(view: Record<string, unknown>) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      hiddenColumns: [],
      sortDir: "asc",
      sortKey: "name",
      ...view,
    })
  );
}

function readSavedView(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
}

function dispatchStorage(newValue: string | null) {
  act(() => {
    globalThis.dispatchEvent(
      new StorageEvent("storage", { key: STORAGE_KEY, newValue })
    );
  });
}

const SMALL_VIEW = {
  columnOrder: ["a"],
  columnWidths: {},
  extras: { revealed: false, window: "7d" },
  hiddenColumns: ["b"],
  opaqueFields: NO_OPAQUE_STORED_VIEW_FIELDS,
  pageSize: 50,
  preservedColumnIds: NO_PRESERVED_COLUMN_IDS,
  sortDir: "asc",
  sortKey: "name",
} as const;

/**
 * ISS-9449. The one serialization has a ceiling, and the persist effect answers
 * a record past it by shedding the carried ids — the half of a stored
 * arrangement the brief named droppable — then the width-only widths (tamsinb,
 * PR #8117), and, failing that, by refusing the write and leaving disk as it
 * was. Every case here asserts on STORAGE, since
 * the in-memory view is unchanged by any of it.
 */
describe("serializeTableView — the ceiling", () => {
  it("returns the record at the ceiling and null one past it", () => {
    // The literal pins the CHOSEN ceiling so moving it is a decision.
    expect(MAX_SERIALIZED_TABLE_VIEW_LENGTH).toBe(65_536);
    const withBlob = (blob: string) => ({
      ...SMALL_VIEW,
      extras: { ...SMALL_VIEW.extras, blob },
    });
    const baseLength = serializeTableView(withBlob(""))?.length ?? 0;
    const padding = MAX_SERIALIZED_TABLE_VIEW_LENGTH - baseLength;

    const atCeiling = serializeTableView(withBlob("y".repeat(padding)));
    expect(atCeiling?.length).toBe(MAX_SERIALIZED_TABLE_VIEW_LENGTH);
    expect(serializeTableView(withBlob("y".repeat(padding + 1)))).toBeNull();
  });

  it("serializeTableViewWithinCeiling sheds the carried ids, then the width-only widths, then refuses", () => {
    const withHugeCarry = {
      ...SMALL_VIEW,
      preservedColumnIds: {
        columnOrder: [HUGE_ID],
        columnWidths: {},
        hiddenColumns: [],
      },
    };
    const shed = serializeTableViewWithinCeiling(
      withHugeCarry,
      DECLARED_COLUMN_IDS
    );
    expect(shed).toBe(serializeTableView(SMALL_VIEW));
    expect(shed).not.toContain(HUGE_ID);

    // A declared width is kept; only the width-only one is shed.
    const withHugeWidthOnly = {
      ...withHugeCarry,
      columnWidths: { a: 120, [HUGE_ID]: 200 },
    };
    expect(
      serializeTableViewWithinCeiling(withHugeWidthOnly, DECLARED_COLUMN_IDS)
    ).toBe(serializeTableView({ ...SMALL_VIEW, columnWidths: { a: 120 } }));

    const withHugeExtras = {
      ...SMALL_VIEW,
      extras: { ...SMALL_VIEW.extras, blob: HUGE_ID },
    };
    expect(
      serializeTableViewWithinCeiling(withHugeExtras, DECLARED_COLUMN_IDS)
    ).toBeNull();
  });
});

describe("usePersistedTableViewState — writes past the ceiling", () => {
  it("sheds a pathologically LONG carried id on the first write and pins the loss", () => {
    // With the per-axis cap in force only LENGTH, never count, can carry a
    // record past the ceiling: this is the one shape the shed rung exists for.
    seedSavedView({ columnOrder: ["c", HUGE_ID, "a"] });

    const { result } = render("web");

    const stored = readSavedView();
    expect(stored.columnOrder).toEqual(["c", "a"]);
    expect(localStorage.getItem(STORAGE_KEY)?.length).toBeLessThanOrEqual(
      MAX_SERIALIZED_TABLE_VIEW_LENGTH
    );
    // The applied half is intact and the carried id is GONE from disk — the
    // trade the brief sanctioned, pinned rather than incidental.
    expect(result.current.columnOrder).toEqual(["c", "a"]);
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(HUGE_ID);
  });

  it("dedupes a shed write against the bytes actually written", () => {
    seedSavedView({ columnOrder: ["c", HUGE_ID, "a"] });
    const setItem = vi.spyOn(localStorage, "setItem");

    const { result } = render("web");
    const writesAfterMount = setItem.mock.calls.length;
    act(() => result.current.toggleSortDir());
    act(() => result.current.toggleSortDir());

    // Two edits, two writes: the second edit lands the ORIGINAL bytes again and
    // must not be deduped against a stale, pre-shed serialization.
    expect(setItem.mock.calls.length - writesAfterMount).toBe(2);
    expect(readSavedView().sortDir).toBe("asc");
  });
});

/**
 * ISS-9449 (review). The shed rungs drop only the carry and the width-only
 * widths, never a declared column's arrangement, so an applied order
 * long enough to pass the ceiling would be refused on every write — the reader
 * would keep restoring the bad record and no edit of theirs would ever reach
 * disk. `filterValidColumnOrder`'s dedupe is what makes that record
 * unrepresentable: the applied order can never be longer than the build's own
 * column ids.
 */
describe("usePersistedTableViewState — a corrupt applied order", () => {
  // One KNOWN id repeated past the ceiling: nothing here is droppable carry.
  const REPEATED_KNOWN_ORDER = Array.from(
    { length: MAX_SERIALIZED_TABLE_VIEW_LENGTH },
    () => "a"
  );

  it("bounds the order on restore, so the write is not refused", () => {
    seedSavedView({ columnOrder: REPEATED_KNOWN_ORDER });
    const oversized = localStorage.getItem(STORAGE_KEY) ?? "";
    expect(oversized.length).toBeGreaterThan(MAX_SERIALIZED_TABLE_VIEW_LENGTH);

    const { result } = render("web");

    expect(result.current.columnOrder).toEqual(["a"]);
    // The corrective write landed: disk is under the ceiling, not the bytes
    // that were seeded.
    const stored = localStorage.getItem(STORAGE_KEY) ?? "";
    expect(stored.length).toBeLessThanOrEqual(MAX_SERIALIZED_TABLE_VIEW_LENGTH);
    expect(readSavedView().columnOrder).toEqual(["a"]);
  });

  it("persists the reader's next edit instead of refusing it forever", () => {
    seedSavedView({ columnOrder: REPEATED_KNOWN_ORDER });
    const { result } = render("web");

    act(() => result.current.toggleSortDir());

    // The failure this pins: with the order unbounded every serialization is
    // past the ceiling, so the persist effect refuses, and the reader's edit
    // lives in memory while the bad record stays on disk.
    expect(readSavedView().sortDir).toBe("desc");
    expect(result.current.sortDir).toBe("desc");
  });

  it("bounds an order applied from a named saved view too", () => {
    // `applyView` reads an arrangement out of `usePersistedSavedViews`, which is
    // the same untrusted localStorage, so it takes the same bound.
    const { result } = render("web");

    act(() =>
      result.current.applyView({
        columnOrder: [...REPEATED_KNOWN_ORDER, "b"],
        extras: { revealed: false, window: "7d" },
        hiddenColumns: [],
        sortDir: "asc",
        sortKey: "name",
      })
    );

    expect(result.current.columnOrder).toEqual(["a", "b"]);
    expect(localStorage.getItem(STORAGE_KEY)?.length).toBeLessThanOrEqual(
      MAX_SERIALIZED_TABLE_VIEW_LENGTH
    );
  });
});

/**
 * The refuse arm: `extras` alone past the ceiling. No feature parser in this
 * repo passes a blob like this through, so the case is driven with its own
 * config — a corruption backstop, exercised on purpose.
 */
type BlobExtras = { blob: string };

function parseWithBlob(
  raw: unknown
): RestoredTableView<"name" | "date", "asc" | "desc", BlobExtras> | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  return {
    columnOrder: Array.isArray(record.columnOrder)
      ? record.columnOrder.filter((id): id is string => typeof id === "string")
      : [],
    extras: { blob: typeof record.blob === "string" ? record.blob : "" },
    hiddenColumns: [],
    sortDir: record.sortDir === "desc" ? "desc" : "asc",
    sortKey: record.sortKey === "date" ? "date" : "name",
  };
}

function useBlobView() {
  return usePersistedTableViewState<
    "name" | "date",
    "asc" | "desc",
    "a" | "b" | "c",
    BlobExtras
  >({
    columnIds: COLUMN_IDS,
    defaultExtras: { blob: "" },
    defaultSortDir: "asc",
    defaultSortKey: "name",
    keyPrefix: "test:view:",
    parse: parseWithBlob,
    persistKey: "web",
    sortDirs: ["asc", "desc"],
  });
}

describe("usePersistedTableViewState — refusing an extras-only oversize", () => {
  it("refuses the write, leaves disk untouched, and does not throw", () => {
    const oversized = JSON.stringify({
      blob: HUGE_ID,
      sortDir: "asc",
      sortKey: "date",
    });
    localStorage.setItem(STORAGE_KEY, oversized);
    const setItem = vi.spyOn(localStorage, "setItem");

    const { result } = renderHook(() => useBlobView());
    // The record restores — the read path is unchanged by the ceiling.
    expect(result.current.sortKey).toBe("date");
    act(() => result.current.toggleSortDir());

    // Nothing was written: not the mount-time re-persist, not the edit. The
    // stored bytes are byte-identical to what was seeded. This is the accepted
    // trade — a record only corruption can produce keeps its reader's view on
    // disk and their edits in memory, rather than losing either.
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(oversized);
    expect(result.current.sortDir).toBe("desc");
  });

  it("still adopts a sibling tab's valid record after a refusal", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ blob: HUGE_ID, sortDir: "asc", sortKey: "date" })
    );
    const { result } = renderHook(() => useBlobView());
    act(() => result.current.toggleSortDir());

    // The refused edit is not one disk will ever hold, so it must not hold the
    // ISS-9568 adoption gate shut: the sibling's record is the way back to a
    // record this tab can write.
    const sibling = JSON.stringify({
      blob: "",
      sortDir: "asc",
      sortKey: "name",
    });
    localStorage.setItem(STORAGE_KEY, sibling);
    dispatchStorage(sibling);
    expect(result.current.sortKey).toBe("name");
    expect(result.current.extras.blob).toBe("");

    act(() => result.current.setSort("date"));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").sortKey).toBe(
      "date"
    );
  });

  it("an oversized-by-extras adoption does not echo, and the next edit is refused", () => {
    const { result } = renderHook(() => useBlobView());
    act(() => result.current.setSort("date"));
    const healthy = localStorage.getItem(STORAGE_KEY);
    const setItem = vi.spyOn(localStorage, "setItem");

    const oversized = JSON.stringify({
      blob: HUGE_ID,
      sortDir: "asc",
      sortKey: "name",
    });
    localStorage.setItem(STORAGE_KEY, oversized);
    dispatchStorage(oversized);
    expect(result.current.sortKey).toBe("name");
    expect(setItem).toHaveBeenCalledTimes(1);
    setItem.mockClear();

    act(() => result.current.toggleSortDir());
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(oversized);
    expect(healthy).not.toBe(oversized);
  });
});

describe("usePersistedTableViewState — an oversized-by-carry adoption", () => {
  it("is re-persisted shed, and the next edit writes", () => {
    const { result } = render("web");
    act(() => result.current.setSort("date"));
    const setItem = vi.spyOn(localStorage, "setItem");

    const oversized = JSON.stringify({
      columnOrder: ["c", HUGE_ID],
      hiddenColumns: [],
      sortDir: "asc",
      sortKey: "name",
    });
    localStorage.setItem(STORAGE_KEY, oversized);
    dispatchStorage(oversized);
    expect(result.current.sortKey).toBe("name");
    // Not the write-free adoption of a record this tab could have written:
    // the sibling's oversized record seeds no dedupe bytes, so the persist run
    // sheds the carry and puts a record within the ceiling back on disk.
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain(HUGE_ID);
    expect(readSavedView().columnOrder).toEqual(["c"]);
    setItem.mockClear();

    act(() => result.current.toggleColumn("b"));
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(readSavedView().hiddenColumns).toEqual(["b"]);
  });

  it("re-persists shed even when the shed bytes match the last local write", () => {
    const { result } = render("web");
    act(() => result.current.setSort("date"));
    const healthy = localStorage.getItem(STORAGE_KEY);
    expect(healthy).not.toBeNull();
    const setItem = vi.spyOn(localStorage, "setItem");

    // The sibling's record is this tab's own view plus one huge carried id, so
    // its shed serialization is byte-identical to `healthy`. A dedupe ref
    // seeded with the SHED bytes would swallow the write and leave the
    // oversized record on disk indefinitely.
    const oversized = JSON.stringify({
      ...JSON.parse(healthy ?? "{}"),
      columnOrder: [HUGE_ID],
    });
    localStorage.setItem(STORAGE_KEY, oversized);
    dispatchStorage(oversized);

    expect(setItem).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(healthy);
  });
});

describe("usePersistedTableViewState — a refused adoption clears the dedupe ref", () => {
  it("writes the reader's next edit even when it matches the last local write byte for byte", () => {
    const { result } = renderHook(() => useBlobView());
    act(() => result.current.setSort("date"));
    const healthy = localStorage.getItem(STORAGE_KEY);
    expect(healthy).not.toBeNull();

    // A sibling's extras-only oversize is adopted but can never be written, so
    // it seeds no dedupe bytes. Were the ref left holding `healthy`, the edit
    // below — which serializes to exactly `healthy` — would be swallowed and
    // the oversized record would stay on disk.
    const oversized = JSON.stringify({
      ...JSON.parse(healthy ?? "{}"),
      blob: HUGE_ID,
    });
    localStorage.setItem(STORAGE_KEY, oversized);
    dispatchStorage(oversized);
    expect(result.current.extras.blob).toBe(HUGE_ID);
    const setItem = vi.spyOn(localStorage, "setItem");

    act(() => result.current.setExtras({ blob: "" }));

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(healthy);
  });
});

const WIDTH_ONLY_PREFIX = "width-only:";

function isPrefixedWidthOnly(id: string): boolean {
  return id.startsWith(WIDTH_ONLY_PREFIX);
}

function useWidthOnlyView() {
  return usePersistedTableViewState<SortKey, SortDir, ColumnId, Extras>({
    columnIds: COLUMN_IDS,
    defaultExtras: { revealed: false, window: "7d" },
    defaultSortDir: "asc",
    defaultSortKey: "name",
    isWidthOnlyColumnId: isPrefixedWidthOnly,
    keyPrefix: "test:view:",
    parse,
    persistKey: "web",
    sortDirs: ["asc", "desc"],
  });
}

/**
 * tamsinb, PR #8117: a width-only predicate is open-ended, and the width-only
 * cap bounds how MANY widths apply, not how long their ids are. Those widths
 * are applied, never carried, so unless a rung sheds them a record of long
 * ones is refused on every write — the ISS-9449 wedge. Driven through a
 * prefix-only predicate: the feature's own predicate is not what makes the
 * hook writable.
 */
describe("usePersistedTableViewState — applied width-only widths past the ceiling", () => {
  const LONG_WIDTH_ONLY_WIDTHS = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [
      `${WIDTH_ONLY_PREFIX}${i}-${"x".repeat(250)}`,
      200,
    ])
  );

  it("sheds them from the write, so the reader's next edit persists", () => {
    seedSavedView({ columnWidths: { a: 120, ...LONG_WIDTH_ONLY_WIDTHS } });
    expect(localStorage.getItem(STORAGE_KEY)?.length).toBeGreaterThan(
      MAX_SERIALIZED_TABLE_VIEW_LENGTH
    );
    const { result } = renderHook(() => useWidthOnlyView());

    act(() => result.current.toggleSortDir());

    expect(readSavedView().sortDir).toBe("desc");
    expect(readSavedView().columnWidths).toEqual({ a: 120 });
    // Shed from the bytes only: the widths the reader sees are still applied.
    expect(result.current.columnWidths).toEqual({
      a: 120,
      ...LONG_WIDTH_ONLY_WIDTHS,
    });
  });
});

describe("usePersistedTableViewState — the quota arm still swallows", () => {
  it("swallows a throwing setItem and writes again once it stops throwing", () => {
    const { result } = render("web");
    const setItem = vi
      .spyOn(localStorage, "setItem")
      .mockImplementationOnce(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });

    expect(() => act(() => result.current.setSort("date"))).not.toThrow();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    act(() => result.current.toggleSortDir());
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(readSavedView().sortDir).toBe("desc");
  });
});
