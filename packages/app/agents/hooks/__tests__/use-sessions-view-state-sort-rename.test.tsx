import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSortDir, SessionSortKey } from "../../lib/session-sort-group";
import { useSessionsViewState } from "../use-sessions-view-state";

/**
 * ISS-9447 M3 — the rename normalization in front of the two closed sort enums,
 * driven by a FABRICATED rename of a column this build really does sort by.
 *
 * Its own suite because of the module mock below, and because the real rename
 * map cannot exercise this at all: its one entry (`branch` → `branches`) names a
 * column that is not sortable, and neither spelling is a `SessionSortKey`, so
 * every stored value normalizes to itself and the parser is observably
 * identical with the preprocess and without it. The wiring still has to be
 * pinned — the next rename of a SORTABLE column is when it starts mattering, and
 * discovering then that it was never connected is the whole failure mode — so
 * the map is mocked to add a rename the closed enum can actually accept.
 *
 * What the mock replaces is the rename LOOKUP, not the preprocess: the schema,
 * the enums, the hook and the storage round trip are all the production ones,
 * so deleting either `z.preprocess(normalizeStoredSortKey, …)` reddens these
 * cases.
 */
const { LEGACY_RENAME_PREFIX } = vi.hoisted(() => ({
  LEGACY_RENAME_PREFIX: "legacy:",
}));

vi.mock("../../lib/sessions-table-columns", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/sessions-table-columns")>();
  return {
    ...actual,
    // A prefix rather than a named pair so the test can spell its target with
    // the `SessionSortKey` member rather than a second copy of the string.
    normalizeSessionColumnId: (columnId: string): string =>
      columnId.startsWith(LEGACY_RENAME_PREFIX)
        ? columnId.slice(LEGACY_RENAME_PREFIX.length)
        : actual.normalizeSessionColumnId(columnId),
  };
});

const LEGACY_COST_SORT_ID = `${LEGACY_RENAME_PREFIX}${SessionSortKey.Cost}`;

afterEach(() => {
  localStorage.clear();
});

describe("ISS-9447 M3: a renamed SORTABLE column id in a stored view", () => {
  it("resolves the primary sort key instead of discarding the whole saved view", () => {
    // Without normalization the closed enum rejects the stored id, and a
    // rejected `sortKey` fails the WHOLE object parse — so the reader loses
    // their columns, window and grouping along with their sort. That blast
    // radius is why this is normalized rather than caught.
    localStorage.setItem(
      "sessions:saved-view:sessions:renamed-primary",
      JSON.stringify({
        hiddenColumns: ["repo"],
        sortDir: SessionSortDir.Asc,
        sortKey: LEGACY_COST_SORT_ID,
      })
    );

    const { result } = renderHook(() =>
      useSessionsViewState("sessions:renamed-primary")
    );

    expect(result.current.sortKey).toBe(SessionSortKey.Cost);
    expect(result.current.sortDir).toBe(SessionSortDir.Asc);
    // The rest of the view survived with it. `repo` is neither default-hidden
    // nor migrated, so it is visible on any view that failed to restore — which
    // is exactly what an un-normalized parse would have produced here.
    expect(result.current.visibleColumns.has("repo")).toBe(false);
  });

  it("resolves the field id of a stored SECONDARY sort rule", () => {
    // The undisclosed twin: `secondarySortSchema.fieldId` carries the same
    // preprocess, against a NON-nullable enum, and an unresolved id there drops
    // the whole rule list rather than one rule.
    localStorage.setItem(
      "sessions:saved-view:sessions:renamed-secondary",
      JSON.stringify({
        hiddenColumns: [],
        secondarySorts: [
          { direction: SessionSortDir.Asc, fieldId: LEGACY_COST_SORT_ID },
          { direction: SessionSortDir.Desc, fieldId: SessionSortKey.Duration },
        ],
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );

    const { result } = renderHook(() =>
      useSessionsViewState("sessions:renamed-secondary")
    );

    expect(result.current.secondarySorts).toEqual([
      { direction: SessionSortDir.Asc, fieldId: SessionSortKey.Cost },
      { direction: SessionSortDir.Desc, fieldId: SessionSortKey.Duration },
    ]);
  });

  it("costs a reader only the rule list when a field id resolves to nothing this build sorts by", () => {
    // The bound on the failure the preprocess narrows: an id normalization
    // cannot rescue still drops `secondarySorts` back to empty and no further.
    // Deliberately not a claim about the preprocess — an un-normalized parser
    // answers this case identically; what it pins is that the `.catch([])` is
    // scoped to the list and does not take the view with it.
    localStorage.setItem(
      "sessions:saved-view:sessions:unresolvable-secondary",
      JSON.stringify({
        hiddenColumns: ["repo"],
        secondarySorts: [
          { direction: SessionSortDir.Asc, fieldId: "a-column-nobody-ships" },
        ],
        sortDir: SessionSortDir.Asc,
        sortKey: SessionSortKey.Duration,
      })
    );

    const { result } = renderHook(() =>
      useSessionsViewState("sessions:unresolvable-secondary")
    );

    expect(result.current.secondarySorts).toEqual([]);
    expect(result.current.sortKey).toBe(SessionSortKey.Duration);
    expect(result.current.visibleColumns.has("repo")).toBe(false);
  });
});
