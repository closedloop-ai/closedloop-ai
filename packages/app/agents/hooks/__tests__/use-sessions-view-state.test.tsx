import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionGroupBy } from "../../lib/session-grouping";
import { SessionSortDir, SessionSortKey } from "../../lib/session-sort-group";
import { SESSIONS_SAVED_VIEW_HIDDEN_VERSION } from "../../lib/sessions-saved-view-migration";
import { useSessionsViewState } from "../use-sessions-view-state";

afterEach(() => {
  localStorage.clear();
});

describe("useSessionsViewState", () => {
  it("defaults to last-activity (desc), 7d window, and the ISS-5315 default column set", () => {
    const { result } = renderHook(() => useSessionsViewState());
    expect(result.current.sortKey).toBe(SessionSortKey.LastActivity);
    expect(result.current.sortDir).toBe(SessionSortDir.Desc);
    expect(result.current.dateRange).toBe("7d");
    // FEA-4194: the unapproved quality segment was removed — the hook no longer
    // exposes a `quality` value or `setQuality` setter.
    expect("quality" in result.current).toBe(false);
    expect("setQuality" in result.current).toBe(false);
    expect(result.current.visibleColumns.has("repo")).toBe(true);
    // ISS-5770: the column id is `branches` (the prototype's spelling).
    expect(result.current.visibleColumns.has("branches")).toBe(true);
    expect(result.current.visibleColumns.has("branch")).toBe(false);
    expect(result.current.visibleColumns.has("cost")).toBe(true);
    // ISS-5315: PR, Merge and Started ship HIDDEN — the ticket's ask, and safe
    // because the renamed "Linked branches" cell folds the PR summary and merge
    // state into its tooltip. Still one click away in the View menu.
    expect(result.current.visibleColumns.has("pr")).toBe(false);
    expect(result.current.visibleColumns.has("merge")).toBe(false);
    expect(result.current.visibleColumns.has("started")).toBe(false);
    // ISS-6005: the new `Updated` column ships hidden on a fresh profile too.
    expect(result.current.visibleColumns.has("updated")).toBe(false);
    expect(result.current.groupBy).toBe(SessionGroupBy.None);
  });

  // ISS-6005 (supersedes the ISS-5315 "saved view wins" expectation here, a
  // DELIBERATE contract change at operator direction): a saved view whose
  // hidden set predates the hidden-columns migration is migrated ONCE — PR and
  // Merge fold back to hidden, because persisted state cannot distinguish
  // "never touched before ISS-5315 changed the default" from "deliberately
  // re-enabled", and the View menu remains the one-click way back. A view that
  // shows them AFTER the migration stamp keeps the user's choice — see the
  // "re-enable sticks" test below.
  //
  // ISS-6065 widened WHICH ids fold, on the same operator direction: `started`
  // (ISS-5315), `projects` and `issues` (ISS-5770) are default-hidden too, and
  // v1 named none of them. This test previously asserted `started` stayed
  // VISIBLE as its "untouched" control — that expectation was the defect, so
  // `repo` (never default-hidden, never migrated) carries the control now.
  it("ISS-6005 + ISS-6065: a pre-migration saved view has every default-hidden column folded to hidden once", () => {
    localStorage.setItem(
      "sessions:saved-view:sessions:test",
      JSON.stringify({
        hiddenColumns: [],
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );
    const { result } = renderHook(() => useSessionsViewState("sessions:test"));
    expect(result.current.visibleColumns.has("pr")).toBe(false);
    expect(result.current.visibleColumns.has("merge")).toBe(false);
    expect(result.current.visibleColumns.has("updated")).toBe(false);
    expect(result.current.visibleColumns.has("started")).toBe(false);
    expect(result.current.visibleColumns.has("projects")).toBe(false);
    expect(result.current.visibleColumns.has("issues")).toBe(false);
    // Only the migrated ids fold — the rest of the view is untouched.
    expect(result.current.visibleColumns.has("repo")).toBe(true);
  });

  // "Reset view" means "back to how the surface ships", not "everything on" —
  // otherwise the reset lands the user on a layout they have never seen.
  it("ISS-5315: resetColumns restores the default-hidden set, not every column", () => {
    const { result } = renderHook(() => useSessionsViewState());
    act(() => result.current.toggleColumn("pr"));
    expect(result.current.visibleColumns.has("pr")).toBe(true);
    act(() => result.current.resetColumns());
    expect(result.current.visibleColumns.has("pr")).toBe(false);
    expect(result.current.visibleColumns.has("status")).toBe(true);
  });

  // wongk (#4480): the Group-by dimension is persisted in the same saved view
  // and chosen from the same menu as the columns, so a "Reset view" that left
  // the rows banded was not a reset.
  it("resetView restores the Group-by dimension along with the columns", () => {
    const { result } = renderHook(() => useSessionsViewState());
    act(() => result.current.setGroupBy(SessionGroupBy.Harness));
    act(() => result.current.toggleColumn("pr"));
    expect(result.current.groupBy).toBe(SessionGroupBy.Harness);
    expect(result.current.visibleColumns.has("pr")).toBe(true);

    act(() => result.current.resetView());

    expect(result.current.groupBy).toBe(SessionGroupBy.None);
    expect(result.current.visibleColumns.has("pr")).toBe(false);
  });

  it("ISS-5315: persists and restores the Group-by dimension", () => {
    const { result, unmount } = renderHook(() =>
      useSessionsViewState("sessions:test")
    );
    act(() => result.current.setGroupBy(SessionGroupBy.Harness));
    expect(result.current.groupBy).toBe(SessionGroupBy.Harness);
    unmount();

    const restored = renderHook(() => useSessionsViewState("sessions:test"));
    expect(restored.result.current.groupBy).toBe(SessionGroupBy.Harness);
  });

  it("ISS-5315: degrades an unknown persisted Group-by to None", () => {
    localStorage.setItem(
      "sessions:saved-view:sessions:test",
      JSON.stringify({
        groupBy: "repository",
        hiddenColumns: [],
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );
    const { result } = renderHook(() => useSessionsViewState("sessions:test"));
    expect(result.current.groupBy).toBe(SessionGroupBy.None);
    // The rest of the view still restores — one bad key never voids it.
    // (ISS-6005: `repo`, not `pr` — the unversioned view's PR column now folds
    // hidden through the hidden-columns migration.)
    expect(result.current.visibleColumns.has("repo")).toBe(true);
  });

  it("FEA-4194: gracefully ignores a legacy persisted quality/showIdle saved view", () => {
    // A saved view written by the removed FEA-4145 segment (or its FEA-3284
    // `showIdle` predecessor) must still restore its sort/columns without error
    // — the removed keys are simply dropped, not rejected.
    localStorage.setItem(
      "sessions:saved-view:sessions:test",
      JSON.stringify({
        sortKey: null,
        sortDir: SessionSortDir.Desc,
        hiddenColumns: ["branch"],
        quality: "idle",
        showIdle: false,
      })
    );
    const { result } = renderHook(() => useSessionsViewState("sessions:test"));
    expect("quality" in result.current).toBe(false);
    expect(result.current.dateRange).toBe("7d");
    expect(result.current.visibleColumns.has("branch")).toBe(false);
    expect(result.current.visibleColumns.has("repo")).toBe(true);
  });

  it("sets and persists the time window", () => {
    const first = renderHook(() => useSessionsViewState("sessions:test"));
    act(() => first.result.current.setDateRange("30d"));
    expect(first.result.current.dateRange).toBe("30d");

    const second = renderHook(() => useSessionsViewState("sessions:test"));
    expect(second.result.current.dateRange).toBe("30d");
  });

  it("sets the sort key (from unsorted) and toggles direction", () => {
    const { result } = renderHook(() => useSessionsViewState());
    act(() => result.current.setSort(SessionSortKey.Cost, SessionSortDir.Desc));
    expect(result.current.sortKey).toBe(SessionSortKey.Cost);
    act(() => result.current.toggleSortDir());
    expect(result.current.sortDir).toBe(SessionSortDir.Asc);
  });

  it("toggles a column's visibility", () => {
    const { result } = renderHook(() => useSessionsViewState());
    act(() => result.current.toggleColumn("branch"));
    expect(result.current.visibleColumns.has("branch")).toBe(false);
    act(() => result.current.toggleColumn("branch"));
    // ISS-5770: the column id is `branches` (the prototype's spelling).
    expect(result.current.visibleColumns.has("branches")).toBe(true);
    expect(result.current.visibleColumns.has("branch")).toBe(false);
  });

  // FEA-4006: Owner became a shown-by-default column (was per-surface injected).
  // Both adapters (the web Sessions page and the desktop SessionsView) drive the
  // View menu → this hook's `toggleColumn` and feed `visibleColumns` back into
  // the shared SessionsTable, so proving hide-Owner survives round-trip here
  // covers the parity both surfaces buy from this wiring.
  it("FEA-4006: Owner is visible by default and can be hidden + persisted via toggleColumn", () => {
    const first = renderHook(() => useSessionsViewState("sessions:test"));
    expect(first.result.current.visibleColumns.has("owner")).toBe(true);

    act(() => first.result.current.toggleColumn("owner"));
    expect(first.result.current.visibleColumns.has("owner")).toBe(false);

    const second = renderHook(() => useSessionsViewState("sessions:test"));
    expect(second.result.current.visibleColumns.has("owner")).toBe(false);
  });

  it("persists and restores view state by surface key", () => {
    const first = renderHook(() => useSessionsViewState("sessions:test"));
    act(() => {
      first.result.current.setSort(SessionSortKey.User, SessionSortDir.Asc);
      first.result.current.toggleColumn("model");
    });

    const second = renderHook(() => useSessionsViewState("sessions:test"));
    expect(second.result.current.sortKey).toBe(SessionSortKey.User);
    expect(second.result.current.sortDir).toBe(SessionSortDir.Asc);
    expect(second.result.current.visibleColumns.has("model")).toBe(false);
  });

  it("FEA-4150: persists a reordered columnOrder, keeping the always-shown Autonomy column", () => {
    const first = renderHook(() => useSessionsViewState("sessions:test"));
    act(() => {
      // A reorder emits the full data order, INCLUDING the always-shown,
      // non-toggleable `autonomy` column. The shared setter's valid-id filter
      // must keep `autonomy` (it is in SESSIONS_ORDERABLE_COLUMN_IDS) — before
      // FEA-4150 it was stripped on persist and re-appended at the end on the
      // next render, silently relocating Autonomy after any reorder.
      first.result.current.setColumnOrder([
        "status",
        "autonomy",
        "owner",
        "future-column",
      ]);
    });

    const second = renderHook(() => useSessionsViewState("sessions:test"));
    // `autonomy` survives (kept in its persisted slot); an unknown id is dropped.
    expect(second.result.current.columnOrder).toEqual([
      "status",
      "autonomy",
      "owner",
    ]);
  });

  it("restores persisted hidden Branch state and filters unknown columns", () => {
    localStorage.setItem(
      "sessions:saved-view:sessions:test",
      JSON.stringify({
        sortKey: null,
        sortDir: SessionSortDir.Desc,
        hiddenColumns: ["branch", "future-column"],
      })
    );

    const { result } = renderHook(() => useSessionsViewState("sessions:test"));
    expect(result.current.visibleColumns.has("branch")).toBe(false);
    expect(result.current.visibleColumns.has("repo")).toBe(true);
    // ISS-6005: this unversioned view's PR/Merge now fold hidden through the
    // hidden-columns migration (previously asserted visible here).
    expect(result.current.visibleColumns.has("pr")).toBe(false);
    expect(result.current.visibleColumns.has("merge")).toBe(false);
    expect([...result.current.visibleColumns]).not.toContain("future-column");
  });

  it("can explicitly hide restored PR and Merge columns", () => {
    localStorage.setItem(
      "sessions:saved-view:sessions:test",
      JSON.stringify({
        sortKey: null,
        sortDir: SessionSortDir.Desc,
        hiddenColumns: ["pr", "merge"],
      })
    );

    const { result } = renderHook(() => useSessionsViewState("sessions:test"));
    expect(result.current.visibleColumns.has("pr")).toBe(false);
    expect(result.current.visibleColumns.has("merge")).toBe(false);
    // ISS-5770: the column id is `branches` (the prototype's spelling).
    expect(result.current.visibleColumns.has("branches")).toBe(true);
    expect(result.current.visibleColumns.has("branch")).toBe(false);
  });
});

describe("ISS-6005: the hidden-columns saved-view migration", () => {
  it("fixture proof: WITHOUT the migration a persisted view auto-shows a new default-hidden id", () => {
    // A view already stamped at the current hidden version whose hiddenColumns
    // deliberately lack `updated` — the post-migration shape of a user who
    // re-enabled it. Visibility is columnIds MINUS the persisted hidden set, so
    // the id is VISIBLE. This is the mechanism that would have auto-shown
    // `updated` (and kept showing pr/merge) for every pre-existing saved view —
    // the reason the migration exists and includes the new id, rather than
    // assuming "off-by-default needs no migration".
    localStorage.setItem(
      "sessions:saved-view:sessions:stamped",
      JSON.stringify({
        hiddenColumns: [],
        // Read from the constant, not a literal: the fixture's whole point is a
        // view the migration will NOT touch, and a hardcoded stamp stops being
        // that the moment the version is bumped (ISS-6065 bumped it to 2).
        hiddenColumnsVersion: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );
    const { result } = renderHook(() =>
      useSessionsViewState("sessions:stamped")
    );
    expect(result.current.visibleColumns.has("updated")).toBe(true);
    expect(result.current.visibleColumns.has("pr")).toBe(true);
  });

  it("a View-menu re-enable AFTER the migration sticks across reloads", () => {
    // Pre-migration persisted view: restore migrates (pr hidden) and the hook
    // re-persists the migrated view with its version stamp.
    localStorage.setItem(
      "sessions:saved-view:sessions:reenable",
      JSON.stringify({
        hiddenColumns: [],
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );
    const first = renderHook(() => useSessionsViewState("sessions:reenable"));
    expect(first.result.current.visibleColumns.has("pr")).toBe(false);

    // The user deliberately shows PR again from the View menu.
    act(() => first.result.current.toggleColumn("pr"));
    expect(first.result.current.visibleColumns.has("pr")).toBe(true);
    first.unmount();

    // Next load: the stored version is stamped, so the migration does not
    // re-run and the user's choice survives — they are not fought on every load.
    const second = renderHook(() => useSessionsViewState("sessions:reenable"));
    expect(second.result.current.visibleColumns.has("pr")).toBe(true);
    expect(second.result.current.visibleColumns.has("merge")).toBe(false);
  });

  it("runs without the fold-legibility flag: the parser migrates unconditionally", () => {
    // The ISS-4890 column-ORDER migration is flag-gated; this one must not be.
    // These hook tests mount with NO flag provider (every gate resolves off),
    // so the pre-migration view folding to hidden here IS the proof the hidden
    // migration runs on the ungated parser path.
    localStorage.setItem(
      "sessions:saved-view:sessions:ungated",
      JSON.stringify({
        hiddenColumns: ["model"],
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );
    const { result } = renderHook(() =>
      useSessionsViewState("sessions:ungated")
    );
    expect(result.current.visibleColumns.has("pr")).toBe(false);
    expect(result.current.visibleColumns.has("merge")).toBe(false);
    expect(result.current.visibleColumns.has("updated")).toBe(false);
    // The user's own hide is preserved alongside the migrated ids.
    expect(result.current.visibleColumns.has("model")).toBe(false);
  });

  it("ISS-6065: a view stamped by a NEWER build is re-stamped at this build's version, so the ids this build drops are re-migrated", () => {
    // Driven through the HOOK, not the pure migration, because the defect only
    // exists in the round trip (wongk). `usePersistedTableViewState` restores a
    // saved view by filtering `hiddenColumns` against THIS build's `columnIds`,
    // then re-persists that filtered set with the `extras` marker untouched. So a
    // future build's default-hidden id is destroyed here while the stamp it was
    // written under survives — and back on that build the version guard
    // short-circuits, leaving the column visible. That is ISS-6065 itself,
    // reintroduced by a downgrade rather than by a missing payload.
    const futureVersion = SESSIONS_SAVED_VIEW_HIDDEN_VERSION + 1;
    localStorage.setItem(
      "sessions:saved-view:sessions:future",
      JSON.stringify({
        hiddenColumns: ["pr", "merge", "updated", "future-column"],
        hiddenColumnsVersion: futureVersion,
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );

    const { unmount } = renderHook(() =>
      useSessionsViewState("sessions:future")
    );
    unmount();

    const persisted = JSON.parse(
      localStorage.getItem("sessions:saved-view:sessions:future") ?? "{}"
    );
    // The loss itself: this build cannot keep an id it has no column for.
    expect(persisted.hiddenColumns).not.toContain("future-column");
    // …so it must not leave behind a marker certifying that it did. Clamped, the
    // newer build sees an out-of-date view and re-runs the step that hides the
    // id again. Preserved (the pre-fix behaviour), this reads `futureVersion`
    // and the column silently returns.
    expect(persisted.hiddenColumnsVersion).toBe(
      SESSIONS_SAVED_VIEW_HIDDEN_VERSION
    );
    // Not vacuous: the ids this build DOES know still survive the round trip, so
    // the clamp is not standing in for a wholesale reset of the hidden set.
    expect(persisted.hiddenColumns).toEqual(
      expect.arrayContaining(["pr", "merge", "updated"])
    );
  });
});

describe("ISS-5770: the branch -> branches rename absorbs persisted legacy ids", () => {
  it("keeps a legacy `branch` entry hiding the renamed column", () => {
    // A saved view written by a build that predates the rename.
    localStorage.setItem(
      "sessions:saved-view:sessions:legacy-hidden",
      JSON.stringify({
        hiddenColumns: ["branch"],
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );
    const { result } = renderHook(() =>
      useSessionsViewState("sessions:legacy-hidden")
    );
    // Without the read-time alias the stale id matches no column, so the user's
    // hide silently stops applying and the column comes back.
    expect(result.current.visibleColumns.has("branches")).toBe(false);
  });

  it("keeps a legacy `branch` entry in its remembered slot in the column order", () => {
    // The user dragged Linked branches to the front, under the old spelling.
    localStorage.setItem(
      "sessions:saved-view:sessions:legacy-order",
      JSON.stringify({
        columnOrder: ["branch", "status", "owner"],
        hiddenColumns: [],
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );
    const { result } = renderHook(() =>
      useSessionsViewState("sessions:legacy-order")
    );
    // Normalised on read, so the remembered slot survives the rename instead of
    // the column being appended at the end of the arrangement.
    expect(result.current.columnOrder[0]).toBe("branches");
    expect(result.current.columnOrder).not.toContain("branch");
  });
});
