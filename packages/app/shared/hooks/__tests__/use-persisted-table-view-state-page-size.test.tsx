import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import { TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY } from "../../lib/feature-flags";
import { usePersistedTableViewState } from "../use-persisted-table-view-state";
import {
  COLUMN_IDS,
  type ColumnId,
  type SortDir,
  type SortKey,
  useTestView,
} from "./persisted-table-view-state.test-support";

/**
 * ISS-9692 — the rows-per-page is a reserved persisted dimension of the shared
 * table-view machinery, restored through the REAL storage path (a fresh mount
 * reading what the first one wrote), not carried in memory.
 *
 * Its own file because the sibling suite is at the repo's file-size ceiling; both
 * drive the ONE configuration in `persisted-table-view-state.test-support`.
 */
afterEach(() => {
  localStorage.clear();
});

// The gate the hook reads for itself. Every durability case mounts with it OPEN;
// the closed cases assert the shipped behaviour a reader without it still gets.
function ladderWrapper(enabled: boolean) {
  return ({ children }: { children: ReactNode }) => (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled ? [TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY] : [],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

const renderGated = (persistKey: string, enabled = true) =>
  renderHook(() => useTestView(persistKey), {
    wrapper: ladderWrapper(enabled),
  });

// An `extras` blob that carries the reserved `pageSize` key, for the clobber
// case. Module level for the same identity reason.
type ClobberingExtras = { pageSize: number; window: string };
const CLOBBERING_EXTRAS: ClobberingExtras = { pageSize: 999, window: "7d" };
const parseNothing = (): null => null;

function useClobberingExtrasView() {
  return usePersistedTableViewState<
    SortKey,
    SortDir,
    ColumnId,
    ClobberingExtras
  >({
    columnIds: COLUMN_IDS,
    defaultExtras: CLOBBERING_EXTRAS,
    defaultSortDir: "asc",
    defaultSortKey: "name",
    keyPrefix: "test:view:",
    parse: parseNothing,
    persistKey: "clobber",
    sortDirs: ["asc", "desc"],
  });
}

describe("usePersistedTableViewState page size", () => {
  it("persists the page size and restores it on a later mount", () => {
    const first = renderGated("web");
    expect(first.result.current.pageSize).toBe(25);

    act(() => first.result.current.setPageSize(250));
    expect(first.result.current.pageSize).toBe(250);
    first.unmount();

    const second = renderGated("web");
    expect(second.result.current.pageSize).toBe(250);
  });

  it("keeps one surface's page size off another's", () => {
    const sessions = renderGated("web");
    act(() => sessions.result.current.setPageSize(500));
    sessions.unmount();

    const other = renderGated("other-surface");
    expect(other.result.current.pageSize).toBe(25);
  });

  it("restores the feature default for a saved view written before page size existed", () => {
    // Exactly the bytes a pre-ISS-9692 build wrote: a real saved view with no
    // `pageSize` key. Absent is "nothing was stored", not "the reader chose 25",
    // and the two only look the same until the default moves.
    localStorage.setItem(
      "test:view:web",
      JSON.stringify({
        columnOrder: [],
        columnWidths: {},
        hiddenColumns: ["b"],
        revealed: false,
        sortDir: "desc",
        sortKey: "date",
        window: "30d",
      })
    );

    const { result } = renderGated("web");

    expect(result.current.pageSize).toBe(25);
    // The rest of that older view still restored, so the fallback above is not
    // a whole-view parse failure wearing a default's clothes.
    expect(result.current.sortKey).toBe("date");
    expect(result.current.visibleColumns.has("b")).toBe(false);
  });

  it("moves the page size without storing it when persistence is withheld", () => {
    const gatedOff = renderGated("web", false);
    act(() => gatedOff.result.current.setPageSize(100));
    // The control still works for this visit.
    expect(gatedOff.result.current.pageSize).toBe(100);
    gatedOff.unmount();

    const later = renderGated("web");
    expect(later.result.current.pageSize).toBe(25);
  });

  it("preserves a stored page size across a session that may not write one", () => {
    // A reader whose gate was open, then closed. Shaping the view on another
    // dimension must not take their stored choice with it.
    const open = renderGated("web");
    act(() => open.result.current.setPageSize(100));
    open.unmount();

    const gatedOff = renderGated("web", false);
    act(() => gatedOff.result.current.setSort("date", "desc"));
    gatedOff.unmount();

    const reopened = renderGated("web");
    expect(reopened.result.current.pageSize).toBe(100);
  });

  it("writes the reserved page size over an extras blob that carries the same key", () => {
    // The repo has shipped this defect once: a trailing `...extras` spread
    // clobbering a reserved canonical key. The reserved fields are spread AFTER
    // extras, so the real page size always wins on serialization.
    const { result } = renderHook(() => useClobberingExtrasView(), {
      wrapper: ladderWrapper(true),
    });

    act(() => result.current.setPageSize(100));

    const stored = JSON.parse(
      localStorage.getItem("test:view:clobber") ?? "{}"
    ) as { pageSize?: number };
    expect(stored.pageSize).toBe(100);
  });
});
