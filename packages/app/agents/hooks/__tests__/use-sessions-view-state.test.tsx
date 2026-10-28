import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { SessionGroupBy } from "../../lib/session-grouping";
import { SessionSortDir, SessionSortKey } from "../../lib/session-sort-group";
import {
  SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
  SESSIONS_SAVED_VIEW_VERSION,
} from "../../lib/sessions-saved-view-migration";
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

  // whitlockk (#4480): the Group-by dimension is persisted in the same saved view
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

  // FEA-4217: summary-card visibility is persisted in the same saved view and
  // switched off from the same menu as the columns, so it has to survive a
  // reload and be undone by "Reset view" for exactly the reasons Group-by does.
  it("FEA-4217: toggles a summary card off, then back on", () => {
    const { result } = renderHook(() => useSessionsViewState());
    expect(result.current.hiddenSummaryCards.has("cost")).toBe(false);

    act(() => result.current.toggleSummaryCard("cost"));
    expect(result.current.hiddenSummaryCards.has("cost")).toBe(true);
    // Only the toggled card moves.
    expect(result.current.hiddenSummaryCards.has("sessions")).toBe(false);

    act(() => result.current.toggleSummaryCard("cost"));
    expect(result.current.hiddenSummaryCards.has("cost")).toBe(false);
  });

  it("FEA-4217: persists and restores the hidden summary cards", () => {
    const { result, unmount } = renderHook(() =>
      useSessionsViewState("sessions:test")
    );
    act(() => result.current.toggleSummaryCard("prs-shipped"));
    expect(result.current.hiddenSummaryCards.has("prs-shipped")).toBe(true);
    unmount();

    const restored = renderHook(() => useSessionsViewState("sessions:test"));
    expect(restored.result.current.hiddenSummaryCards.has("prs-shipped")).toBe(
      true
    );
    // The rest of the view restored too, so the assertion above cannot pass on
    // a view that failed to restore at all.
    expect(restored.result.current.visibleColumns.has("repo")).toBe(true);
  });

  it("FEA-4217: resetView restores the hidden summary cards along with the columns", () => {
    const { result } = renderHook(() => useSessionsViewState());
    act(() => result.current.toggleSummaryCard("tokens"));
    act(() => result.current.toggleColumn("pr"));
    expect(result.current.hiddenSummaryCards.has("tokens")).toBe(true);
    expect(result.current.visibleColumns.has("pr")).toBe(true);

    act(() => result.current.resetView());

    expect(result.current.hiddenSummaryCards.has("tokens")).toBe(false);
    expect(result.current.hiddenSummaryCards.size).toBe(0);
    expect(result.current.visibleColumns.has("pr")).toBe(false);
  });

  it("FEA-4217: degrades a malformed persisted hiddenSummaryCards to nothing hidden", () => {
    localStorage.setItem(
      "sessions:saved-view:sessions:test",
      JSON.stringify({
        // Both siblings carry a NON-DEFAULT value, which is the whole point of
        // the assertions below: `repo` is not in
        // `SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS` and Group-by defaults to `none`,
        // so each of these differs between "the view was applied" and "the
        // whole view was discarded". Pinning on a default-valued key instead
        // would hold in both worlds and prove nothing about the degradation
        // being SCOPED to the malformed key.
        groupBy: SessionGroupBy.Harness,
        hiddenColumns: ["repo"],
        hiddenSummaryCards: "cost",
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );
    const { result } = renderHook(() => useSessionsViewState("sessions:test"));
    expect(result.current.hiddenSummaryCards.size).toBe(0);
    // One bad key never voids the rest of the view.
    expect(result.current.visibleColumns.has("repo")).toBe(false);
    expect(result.current.groupBy).toBe(SessionGroupBy.Harness);
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

  it("runs without any flag provider: the parser migrates unconditionally", () => {
    // These hook tests mount with NO flag provider, so the pre-migration view
    // folding to hidden here IS the proof the hidden migration does not depend
    // on a PostHog runtime.
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

  it("ISS-9447 M3: a view stamped by a NEWER build keeps that stamp AND its ids", () => {
    // The ISS-6065 regression proof the clamp removal owes, and a DELIBERATE
    // behaviour change: this asserted the marker came back clamped to this
    // build's stamp.
    //
    // ISS-6065's defect was a hidden column silently REAPPEARING after a
    // downgrade. It happened because the restore erased every hidden id this
    // build has no column for and re-persisted the filtered set under the newer
    // build's untouched marker, so the newer build short-circuited on that
    // marker and never re-hid what had been destroyed. The clamp forced the
    // re-run that healed it.
    //
    // Both halves of that precondition are asserted below: the newer build's id
    // SURVIVES the round trip (ISS-9447 D1 removed the erasure, so there is
    // nothing to heal), and its stamp survives with it (so the newer build
    // restores the column hidden without a re-run).
    //
    // That is the MOUNT route only. The other way a payload goes back to this
    // build's defaults is a reset, which the clamp also used to heal; it is
    // answered where the reset writes, and pinned by the two cases below.
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
    // Unknown persisted column ids are preserved rather than erased (ISS-9447
    // D1). This is the half that makes the clamp unnecessary: the newer build's
    // default-hidden id survives the downgrade instead of having to be
    // re-derived from the marker.
    expect(persisted.hiddenColumns).toContain("future-column");
    // And the marker is no longer rolled back, so the newer build does not
    // re-run a repair against a view that already took it.
    expect(persisted.hiddenColumnsVersion).toBe(futureVersion);
    // The canonical envelope carries the same stamp (ISS-9447 M2), which is
    // what a build reading the envelope rather than the loose field sees.
    expect(persisted.viewStateVersions).toMatchObject({
      hiddenColumns: futureVersion,
    });
    // Not vacuous: the ids this build DOES know still survive the round trip, so
    // the clamp is not standing in for a wholesale reset of the hidden set.
    expect(persisted.hiddenColumns).toEqual(
      expect.arrayContaining(["pr", "merge", "updated"])
    );
  });

  it("ISS-9447: Reset view re-stamps the axes it rewrote, on both markers and the envelope", () => {
    // The second route to ISS-6065, and the one the clamp removal left open.
    // A reader on a newer build carries a newer stamp; opening an older build
    // now PRESERVES it; "Reset view" then rewrites the hidden set and the column
    // order to the OLDER build's defaults while that newer stamp survives. Back
    // on the newer build the version guard short-circuits, its default-hide step
    // never re-runs, and the column it ships hidden renders permanently.
    //
    // The stamp has to describe what is stored, and after a reset that is this
    // build — so the reset writes both together.
    const futureHiddenVersion = SESSIONS_SAVED_VIEW_HIDDEN_VERSION + 1;
    const futureOrderVersion = SESSIONS_SAVED_VIEW_VERSION + 1;
    localStorage.setItem(
      "sessions:saved-view:sessions:reset-stamp",
      JSON.stringify({
        columnOrder: ["repo", "cost"],
        hiddenColumns: ["pr", "merge", "updated", "future-column"],
        hiddenColumnsVersion: futureHiddenVersion,
        savedViewVersion: futureOrderVersion,
        sortDir: SessionSortDir.Desc,
        sortKey: null,
        viewStateVersions: {
          axisFromANewerBuild: 9,
          columnOrder: futureOrderVersion,
          hiddenColumns: futureHiddenVersion,
        },
      })
    );

    const { result, unmount } = renderHook(() =>
      useSessionsViewState("sessions:reset-stamp")
    );
    act(() => result.current.resetView());
    unmount();

    const persisted = JSON.parse(
      localStorage.getItem("sessions:saved-view:sessions:reset-stamp") ?? "{}"
    );
    // The reset rewrote both column axes to what this build ships: the newer
    // build's id is gone (a choice the reader made and can see) and the stored
    // arrangement is back to the natural order.
    expect(persisted.hiddenColumns).not.toContain("future-column");
    expect(persisted.hiddenColumns).toEqual(
      expect.arrayContaining(["pr", "merge", "updated"])
    );
    expect(persisted.columnOrder).toEqual([]);
    // So both legacy markers and the canonical envelope say THIS build. Left at
    // the newer values they would vouch for a repair the reset just undid.
    expect(persisted.hiddenColumnsVersion).toBe(
      SESSIONS_SAVED_VIEW_HIDDEN_VERSION
    );
    expect(persisted.savedViewVersion).toBe(SESSIONS_SAVED_VIEW_VERSION);
    expect(persisted.viewStateVersions).toMatchObject({
      columnOrder: SESSIONS_SAVED_VIEW_VERSION,
      hiddenColumns: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
    });
    // An axis only a NEWER build names keeps its stamp: this reset rewrote the
    // two column axes and says nothing about anyone else's.
    expect(persisted.viewStateVersions.axisFromANewerBuild).toBe(9);
  });

  it("ISS-9447: the bare resetColumns path re-stamps too, not just resetView", () => {
    // `resetView` is Sessions' own wrapper, but the shared hook's `resetColumns`
    // is returned from this hook as well and rewrites exactly the same two axes.
    // That is why the re-stamp lives in the shared reset rather than in each
    // surface's wrapper — a consumer calling the bare reset must not be able to
    // leave a stamp behind that the wrapper would have moved.
    const futureHiddenVersion = SESSIONS_SAVED_VIEW_HIDDEN_VERSION + 1;
    localStorage.setItem(
      "sessions:saved-view:sessions:reset-columns-stamp",
      JSON.stringify({
        hiddenColumns: ["pr", "merge", "updated", "future-column"],
        hiddenColumnsVersion: futureHiddenVersion,
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );

    const { result, unmount } = renderHook(() =>
      useSessionsViewState("sessions:reset-columns-stamp")
    );
    act(() => result.current.resetColumns());
    unmount();

    const persisted = JSON.parse(
      localStorage.getItem(
        "sessions:saved-view:sessions:reset-columns-stamp"
      ) ?? "{}"
    );
    expect(persisted.hiddenColumns).not.toContain("future-column");
    expect(persisted.hiddenColumnsVersion).toBe(
      SESSIONS_SAVED_VIEW_HIDDEN_VERSION
    );
    expect(persisted.viewStateVersions).toMatchObject({
      hiddenColumns: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
    });
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

  // ISS-6382: `sortKey`/`sortDir` (and, on web, `dateRange`) feed the sessions
  // list query key, so both Sessions surfaces gate their read on this. Nothing
  // else re-exports it — return a hardcoded `true`, or the shared hook's
  // pre-ISS-4655 `restored` boolean, and the surfaces silently read against a
  // view the restore is about to replace.
  it("reports whether the view has settled, gated on auth", () => {
    const hydrating = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ isLoaded: false })}
      >
        {children}
      </AuthAdapterProvider>
    );
    const { result: pending } = renderHook(
      () => useSessionsViewState("sessions:web"),
      { wrapper: hydrating }
    );
    expect(pending.current.isViewReady).toBe(false);

    const loaded = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ userId: "user_alice" })}
      >
        {children}
      </AuthAdapterProvider>
    );
    const { result: ready } = renderHook(
      () => useSessionsViewState("sessions:web"),
      { wrapper: loaded }
    );
    expect(ready.current.isViewReady).toBe(true);
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

/**
 * ISS-9447 M0. The two Sessions version markers, pinned THROUGH THE ROUND TRIP.
 *
 * The two axes held OPPOSITE future-version policies when this block was
 * written - column order preserved a newer build's stamp, hidden columns
 * clamped it down - and only the clamp had hook-level coverage. ISS-9447 M3 put
 * both on preserve, so what these cases pin now is that the two markers still
 * advance INDEPENDENTLY: one repair must not stamp the other as done.
 */
describe("ISS-9447 M0: the Sessions saved-view version markers", () => {
  function readSavedView(key: string): Record<string, unknown> {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  }

  it("PRESERVES a column-order stamp written by a newer build, alongside that build's ids", () => {
    const storageKey = "sessions:saved-view:sessions:future-order";
    const futureVersion = SESSIONS_SAVED_VIEW_VERSION + 1;
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        columnOrder: ["cost", "future-column", "repo"],
        hiddenColumns: [],
        // Stamped current, so the hidden migration does not run and this case
        // isolates the order axis.
        hiddenColumnsVersion: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
        savedViewVersion: futureVersion,
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );

    const { unmount } = renderHook(() =>
      useSessionsViewState("sessions:future-order")
    );
    unmount();

    const persisted = readSavedView(storageKey);
    // The stamp is NOT clamped back to this build's version (unlike the hidden
    // axis). Clamp it and the newer build re-runs a migration against an order
    // the reader has since arranged by hand.
    expect(persisted.savedViewVersion).toBe(futureVersion);
    // Unknown persisted column ids are now preserved rather than erased
    // (ISS-9447 D1); the previous expectation here was `not.toContain`, which
    // encoded a data-loss path. Appended, since no slot can be held open for a
    // column this build never draws.
    expect(persisted.columnOrder).toEqual(["cost", "repo", "future-column"]);
  });

  it("advances the two markers INDEPENDENTLY - one repair cannot stamp the other as done", () => {
    const storageKey = "sessions:saved-view:sessions:markers";
    const futureOrderVersion = SESSIONS_SAVED_VIEW_VERSION + 1;
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        columnOrder: [],
        // Unstamped: the hidden axis genuinely has a migration to run here.
        hiddenColumns: [],
        savedViewVersion: futureOrderVersion,
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );

    const { unmount } = renderHook(() =>
      useSessionsViewState("sessions:markers")
    );
    unmount();

    const persisted = readSavedView(storageKey);
    // The hidden axis ran its migration and stamped itself...
    expect(persisted.hiddenColumnsVersion).toBe(
      SESSIONS_SAVED_VIEW_HIDDEN_VERSION
    );
    // ...without touching the column-order stamp, which keeps a value THIS
    // build would never write. Sharing one scalar - the thing the two constants
    // exist to avoid - would let the hidden repair certify the order axis as
    // migrated without proving it ran.
    expect(persisted.savedViewVersion).toBe(futureOrderVersion);
    // Not vacuous: the hidden migration really did run.
    expect(persisted.hiddenColumns).toEqual(
      expect.arrayContaining(["pr", "merge", "updated"])
    );
  });
});

/**
 * ISS-9447 M2 — the per-axis version envelope, through the round trip.
 *
 * Every case here reads what the hook actually WROTE to `localStorage`, because
 * the whole claim of the milestone is about the stored bytes: that a build
 * without the envelope still finds every marker in a record a build with it
 * wrote, and that a stamp for an axis this build cannot name survives its
 * write. Neither is observable from the returned view state.
 */
describe("ISS-9447 M2: the Sessions view-state version envelope", () => {
  function readSavedView(key: string): Record<string, unknown> {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  }

  function roundTrip(persistKey: string): Record<string, unknown> {
    const { unmount } = renderHook(() => useSessionsViewState(persistKey));
    unmount();
    return readSavedView(`sessions:saved-view:${persistKey}`);
  }

  it("reads a record carrying only the LEGACY markers and writes both shapes", () => {
    // Every view stored before this milestone looks like this. The write is an
    // additive superset: the envelope is added and the loose markers stay, so a
    // build that only knows the loose ones is unaffected by the upgrade.
    localStorage.setItem(
      "sessions:saved-view:sessions:legacy-markers",
      JSON.stringify({
        hiddenColumns: ["pr"],
        hiddenColumnsVersion: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
        savedViewVersion: SESSIONS_SAVED_VIEW_VERSION,
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );

    const persisted = roundTrip("sessions:legacy-markers");

    expect(persisted.viewStateVersions).toEqual({
      columnOrder: SESSIONS_SAVED_VIEW_VERSION,
      hiddenColumns: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
    });
    // The legacy mirror, still written. Drop it and a build without the
    // envelope reads no marker at all and re-runs every repair.
    expect(persisted.savedViewVersion).toBe(SESSIONS_SAVED_VIEW_VERSION);
    expect(persisted.hiddenColumnsVersion).toBe(
      SESSIONS_SAVED_VIEW_HIDDEN_VERSION
    );
    // Not vacuous: the stamps were honoured, so the hidden migration did not
    // run and the reader's one hidden id is all that is stored.
    expect(persisted.hiddenColumns).toEqual(["pr"]);
  });

  it("carries an envelope stamp for an axis this build does not name", () => {
    // Version skew on the envelope itself: a newer build versions an axis this
    // one has never heard of, and this build's write must not delete the stamp
    // that build will read back.
    localStorage.setItem(
      "sessions:saved-view:sessions:future-axis",
      JSON.stringify({
        hiddenColumns: [],
        hiddenColumnsVersion: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
        savedViewVersion: SESSIONS_SAVED_VIEW_VERSION,
        sortDir: SessionSortDir.Desc,
        sortKey: null,
        viewStateVersions: {
          axisFromANewerBuild: 9,
          columnOrder: SESSIONS_SAVED_VIEW_VERSION,
          hiddenColumns: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
        },
      })
    );

    const persisted = roundTrip("sessions:future-axis");

    expect(persisted.viewStateVersions).toEqual({
      axisFromANewerBuild: 9,
      columnOrder: SESSIONS_SAVED_VIEW_VERSION,
      hiddenColumns: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
    });
  });

  it("round-trips a stored columnWidths map instead of overwriting it with {}", () => {
    // ISS-9447 M2, the inherited finding: this schema declared no
    // `columnWidths`, so `z.object` stripped the field on read and the shared
    // hook's restore write put an empty map back — a whole axis destroyed by a
    // reader who only opened the page. Latent until a build persists Sessions
    // widths, which is precisely why it is fixed at the envelope rather than
    // after the first reader loses one.
    localStorage.setItem(
      "sessions:saved-view:sessions:widths",
      JSON.stringify({
        columnWidths: { cost: 220, "future-column": 180 },
        hiddenColumns: [],
        hiddenColumnsVersion: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
        savedViewVersion: SESSIONS_SAVED_VIEW_VERSION,
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );

    const persisted = roundTrip("sessions:widths");

    // Both halves: a width for a column this build draws, and one for a column
    // only a newer build has. The second rides in the preserved set.
    expect(persisted.columnWidths).toEqual({
      cost: 220,
      "future-column": 180,
    });
  });

  it("restores every sort key verbatim through the rename normalization", () => {
    // ISS-9447 M3 put a rename preprocess in front of the closed sort enum.
    // This pins that it did not change what a VALID stored sort key restores
    // to — the regression the change itself could introduce.
    //
    // It deliberately does not claim more. The rename map's one entry
    // (`branch` → `branches`) names a column that is not sortable, and neither
    // spelling is a sort key, so no PRODUCTION value can distinguish the
    // normalized parser from the un-normalized one. The fix is for the next
    // rename of a SORTABLE column, which today would discard every view sorted
    // by it — and that wiring, for both this key and the secondary rules'
    // `fieldId`, is pinned against a fabricated rename in
    // `use-sessions-view-state-sort-rename.test.tsx`.
    for (const key of Object.values(SessionSortKey)) {
      localStorage.setItem(
        "sessions:saved-view:sessions:sort-keys",
        JSON.stringify({
          hiddenColumns: [],
          hiddenColumnsVersion: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
          savedViewVersion: SESSIONS_SAVED_VIEW_VERSION,
          sortDir: SessionSortDir.Asc,
          sortKey: key,
        })
      );
      const { result, unmount } = renderHook(() =>
        useSessionsViewState("sessions:sort-keys")
      );
      expect(result.current.sortKey).toBe(key);
      unmount();
    }
  });
});
