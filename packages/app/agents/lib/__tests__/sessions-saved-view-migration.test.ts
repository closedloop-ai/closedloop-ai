import {
  migrateSavedColumnOrder,
  migrateSavedHiddenColumns,
  relocateColumnToCanonicalSlot,
  SESSIONS_HIDDEN_MIGRATION_COLUMN_IDS,
  SESSIONS_HIDDEN_MIGRATION_STEPS,
  SESSIONS_HIDDEN_MIGRATION_V1_VERSION,
  SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
  SESSIONS_SAVED_VIEW_UNVERSIONED,
  SESSIONS_SAVED_VIEW_VERSION,
} from "@repo/app/agents/lib/sessions-saved-view-migration";
import {
  SESSIONS_COLUMN_WIDTH_PX,
  SESSIONS_COST_COLUMN_ID,
  SESSIONS_DATA_COLUMN_ORDER,
  SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS,
  SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX,
  SESSIONS_LEGIBLE_COLUMN_BUDGET_PX,
} from "@repo/app/agents/lib/sessions-table-columns";
import { describe, expect, it } from "vitest";

/**
 * ISS-4890: ISS-4788's Cost placement only reached users who had never
 * drag-reordered a Sessions column. Anyone with a persisted `columnOrder` kept
 * Cost in its old post-fold slot — where the column is clipped and `$772.39`
 * renders as `$772.3` — and the reorder path could not self-heal it either
 * (`mergeColumnOrder` returns the visible order unchanged when every column is
 * visible, so the new canonical position never landed).
 *
 * These pin the repair's two promises: Cost moves, and NOTHING else does.
 */

/**
 * ISS-5315: the canonical data-column order AS IT STOOD when this migration
 * shipped.
 *
 * The unit contract below — "the column lands after its last surviving canonical
 * predecessor, then clamps left to the fold budget" — is a property of the pure
 * function, not of whichever order the table happens to render today. Pinning it
 * against a frozen fixture is what lets a later column reshuffle (ISS-5315 moved
 * Cost from 3rd to 9th) change the product's layout without silently rewriting
 * what this function is supposed to DO. The live order is still exercised, once,
 * by the end-to-end test at the bottom of this file, which is where a drift
 * between the two would actually matter.
 */
const ISS_4890_CANONICAL_ORDER: readonly string[] = [
  "owner",
  "status",
  "cost",
  "repo",
  "branches",
  "pr",
  "started",
  "merge",
  "harness",
  "model",
  "duration",
  "autonomy",
  "lastActivity",
];

// A realistic pre-ISS-4788 arrangement: Cost sits 6th, after PR.
const PERSISTED_COST_LATE = [
  "owner",
  "status",
  "repo",
  "branches",
  "pr",
  SESSIONS_COST_COLUMN_ID,
  "started",
  "merge",
];

describe("relocateColumnToCanonicalSlot (ISS-4890)", () => {
  it("moves the column to the slot after its last surviving canonical predecessor", () => {
    const next = relocateColumnToCanonicalSlot(
      PERSISTED_COST_LATE,
      ISS_4890_CANONICAL_ORDER,
      SESSIONS_COST_COLUMN_ID
    );

    // Canonical order is owner, status, cost, … so Cost lands right after
    // `status` — back in front of the fold.
    expect(next).toEqual([
      "owner",
      "status",
      SESSIONS_COST_COLUMN_ID,
      "repo",
      "branches",
      "pr",
      "started",
      "merge",
    ]);
  });

  it("leaves every other column in the exact relative order the user arranged them", () => {
    const next = relocateColumnToCanonicalSlot(
      PERSISTED_COST_LATE,
      ISS_4890_CANONICAL_ORDER,
      SESSIONS_COST_COLUMN_ID
    );

    // The whole point of relocating ONE id rather than resetting the view: strip
    // Cost from both sides and the user's arrangement must be untouched.
    const withoutCost = (ids: readonly string[]) =>
      ids.filter((id) => id !== SESSIONS_COST_COLUMN_ID);
    expect(withoutCost(next)).toEqual(withoutCost(PERSISTED_COST_LATE));
    expect(next).toHaveLength(PERSISTED_COST_LATE.length);
  });

  it("anchors to the user's own arrangement, not a fixed canonical index", () => {
    // This user dragged Repository and Branch to the front. Cost still belongs
    // beside Status — wherever Status ended up — rather than at canonical index
    // 2, which here would wedge it between two columns it has nothing to do with.
    const userOrder = [
      "repo",
      "branches",
      "owner",
      "status",
      "pr",
      SESSIONS_COST_COLUMN_ID,
      "started",
    ];

    expect(
      relocateColumnToCanonicalSlot(
        userOrder,
        ISS_4890_CANONICAL_ORDER,
        SESSIONS_COST_COLUMN_ID
      )
    ).toEqual([
      "repo",
      "branches",
      "owner",
      "status",
      SESSIONS_COST_COLUMN_ID,
      "pr",
      "started",
    ]);
  });

  it("leads with the column when none of its canonical predecessors survive", () => {
    // Owner and Status are both hidden, so every id left is one the canonical
    // order ranks AFTER Cost — the front is the only consistent placement.
    const userOrder = ["repo", "branches", SESSIONS_COST_COLUMN_ID, "pr"];

    expect(
      relocateColumnToCanonicalSlot(
        userOrder,
        ISS_4890_CANONICAL_ORDER,
        SESSIONS_COST_COLUMN_ID
      )
    ).toEqual([SESSIONS_COST_COLUMN_ID, "repo", "branches", "pr"]);
  });

  it("is a no-op for an order that already has the column in its canonical slot", () => {
    const alreadyCorrect = [
      "owner",
      "status",
      SESSIONS_COST_COLUMN_ID,
      "repo",
      "pr",
    ];

    expect(
      relocateColumnToCanonicalSlot(
        alreadyCorrect,
        ISS_4890_CANONICAL_ORDER,
        SESSIONS_COST_COLUMN_ID
      )
    ).toEqual(alreadyCorrect);
  });

  it("leaves an order that does not list the column alone", () => {
    // A user who hid Cost has no `cost` entry; the table already places an
    // unlisted column naturally, so injecting one here would invent a preference.
    const withoutCost = ["owner", "status", "repo", "pr"];

    expect(
      relocateColumnToCanonicalSlot(
        withoutCost,
        ISS_4890_CANONICAL_ORDER,
        SESSIONS_COST_COLUMN_ID
      )
    ).toEqual(withoutCost);
  });

  it("declines an id this build's canonical order does not know", () => {
    const userOrder = ["owner", "retired-column", "status"];

    expect(
      relocateColumnToCanonicalSlot(
        userOrder,
        ISS_4890_CANONICAL_ORDER,
        "retired-column"
      )
    ).toEqual(userOrder);
  });

  it("never mutates its input", () => {
    const input = [...PERSISTED_COST_LATE];
    relocateColumnToCanonicalSlot(
      input,
      ISS_4890_CANONICAL_ORDER,
      SESSIONS_COST_COLUMN_ID
    );
    expect(input).toEqual(PERSISTED_COST_LATE);
  });
});

describe("migrateSavedColumnOrder (ISS-4890)", () => {
  it("relocates Cost and stamps the current version for an unversioned view", () => {
    const result = migrateSavedColumnOrder(
      PERSISTED_COST_LATE,
      ISS_4890_CANONICAL_ORDER,
      SESSIONS_SAVED_VIEW_UNVERSIONED
    );

    expect(result.columnOrder.indexOf(SESSIONS_COST_COLUMN_ID)).toBe(2);
    expect(result.version).toBe(SESSIONS_SAVED_VIEW_VERSION);
  });

  it("runs ONCE: an already-migrated view is left exactly as the user left it", () => {
    // The user deliberately dragged Cost back to the end after the migration.
    // Re-running would fight them on every single load.
    const userMovedItBack = [
      "owner",
      "status",
      "repo",
      "pr",
      SESSIONS_COST_COLUMN_ID,
    ];

    const result = migrateSavedColumnOrder(
      userMovedItBack,
      ISS_4890_CANONICAL_ORDER,
      SESSIONS_SAVED_VIEW_VERSION
    );

    expect(result.columnOrder).toEqual(userMovedItBack);
    expect(result.version).toBe(SESSIONS_SAVED_VIEW_VERSION);
  });

  it("preserves a version written by a newer build rather than rolling it back", () => {
    const futureVersion = SESSIONS_SAVED_VIEW_VERSION + 5;

    const result = migrateSavedColumnOrder(
      PERSISTED_COST_LATE,
      ISS_4890_CANONICAL_ORDER,
      futureVersion
    );

    expect(result.columnOrder).toEqual(PERSISTED_COST_LATE);
    expect(result.version).toBe(futureVersion);
  });

  it("stamps an empty (natural-order) view so the check is not re-derived every load", () => {
    const result = migrateSavedColumnOrder(
      [],
      ISS_4890_CANONICAL_ORDER,
      SESSIONS_SAVED_VIEW_UNVERSIONED
    );

    expect(result.columnOrder).toEqual([]);
    expect(result.version).toBe(SESSIONS_SAVED_VIEW_VERSION);
  });
});

/**
 * ISS-4890 (wongk cid 3700596174, stage cid 3700576420, codex cid 3700572376):
 * a relative anchor alone can land Cost PAST the fold, because the anchor itself
 * may be past it. The migration then stamps version 1, so the arrangement is
 * treated as repaired forever — a permanent regression for that user, and the
 * inverse of the stated repair. These pin the budget clamp.
 *
 * The geometry is the table's own: lead 300px, each data column's declared
 * track, and SESSIONS_LEGIBLE_COLUMN_BUDGET_PX (768) as the furthest right the
 * Cost track may END.
 */
const SESSIONS_BUDGET_GEOMETRY = {
  budgetPx: SESSIONS_LEGIBLE_COLUMN_BUDGET_PX,
  leadWidthPx: SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX,
  widthsPx: SESSIONS_COLUMN_WIDTH_PX,
};

/** Where the `columnId` track ENDS, px from the table's left edge. */
function columnEndPx(
  order: readonly string[],
  columnId: string,
  hiddenColumnIds: ReadonlySet<string> = new Set()
): number {
  let endPx = SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX;
  for (const id of order) {
    if (!hiddenColumnIds.has(id)) {
      endPx += SESSIONS_COLUMN_WIDTH_PX[id] ?? 0;
    }
    if (id === columnId) {
      return endPx;
    }
  }
  return endPx;
}

describe("relocateColumnToCanonicalSlot fold budget (ISS-4890 review)", () => {
  it("clamps left of an anchor that itself sits past the fold", () => {
    // wongk's case: Repository and Branch dragged to the front pushes Status —
    // Cost's last surviving predecessor — out past the fold, so anchoring after
    // it would leave Cost past the fold too and the clamp has to walk left.
    //
    // ISS-5356 moved the landing slot one place left without touching the rule:
    // Cost's track grew from 100 to 124px (then to hold a grip lane; since
    // ISS-5812 to hold its own value, at the same 124), and a wider track ends
    // further right. After Branch it would end at 784px — past the 768px budget
    // — so the same clamp that used to stop there now stops after Repository at
    // 604px.
    // The invariants either side of this expectation are what the case is about
    // and both still hold; only the index the arithmetic yields has moved.
    const userOrder = [
      "repo",
      "branches",
      "owner",
      "status",
      "pr",
      SESSIONS_COST_COLUMN_ID,
    ];
    expect(columnEndPx(userOrder, SESSIONS_COST_COLUMN_ID)).toBeGreaterThan(
      SESSIONS_LEGIBLE_COLUMN_BUDGET_PX
    );

    const next = relocateColumnToCanonicalSlot(
      userOrder,
      ISS_4890_CANONICAL_ORDER,
      SESSIONS_COST_COLUMN_ID,
      SESSIONS_BUDGET_GEOMETRY
    );

    expect(next).toEqual([
      "repo",
      SESSIONS_COST_COLUMN_ID,
      "branches",
      "owner",
      "status",
      "pr",
    ]);
    expect(columnEndPx(next, SESSIONS_COST_COLUMN_ID)).toBeLessThanOrEqual(
      SESSIONS_LEGIBLE_COLUMN_BUDGET_PX
    );
  });

  it("clamps left when a predecessor is dragged to the END of the order", () => {
    // stage's case: Owner dragged last makes the last surviving predecessor the
    // FINAL id, so the unbounded anchor is the final slot — Cost would move from
    // a legible slot out to ~2,156px.
    const userOrder = [
      "status",
      "repo",
      "branches",
      "pr",
      SESSIONS_COST_COLUMN_ID,
      "started",
      "owner",
    ];

    const next = relocateColumnToCanonicalSlot(
      userOrder,
      ISS_4890_CANONICAL_ORDER,
      SESSIONS_COST_COLUMN_ID,
      SESSIONS_BUDGET_GEOMETRY
    );

    expect(next).toEqual([
      "status",
      "repo",
      SESSIONS_COST_COLUMN_ID,
      "branches",
      "pr",
      "started",
      "owner",
    ]);
    expect(columnEndPx(next, SESSIONS_COST_COLUMN_ID)).toBeLessThanOrEqual(
      SESSIONS_LEGIBLE_COLUMN_BUDGET_PX
    );
  });

  it("leaves the canonical placement alone when it already fits the budget", () => {
    // The clamp is a ceiling, not a relocation of its own: the ordinary
    // pre-ISS-4788 arrangement still lands beside Status.
    expect(
      relocateColumnToCanonicalSlot(
        PERSISTED_COST_LATE,
        ISS_4890_CANONICAL_ORDER,
        SESSIONS_COST_COLUMN_ID,
        SESSIONS_BUDGET_GEOMETRY
      )
    ).toEqual(
      relocateColumnToCanonicalSlot(
        PERSISTED_COST_LATE,
        ISS_4890_CANONICAL_ORDER,
        SESSIONS_COST_COLUMN_ID
      )
    );
  });

  it("spends no budget on hidden columns, which render no track", () => {
    // Repository and Branch are hidden here, so the tracks in front of Status
    // cost nothing and the canonical slot beside it is legible after all.
    const userOrder = [
      "repo",
      "branches",
      "owner",
      "status",
      "pr",
      SESSIONS_COST_COLUMN_ID,
    ];
    const hiddenColumnIds = new Set(["repo", "branches"]);

    const next = relocateColumnToCanonicalSlot(
      userOrder,
      ISS_4890_CANONICAL_ORDER,
      SESSIONS_COST_COLUMN_ID,
      { ...SESSIONS_BUDGET_GEOMETRY, hiddenColumnIds }
    );

    expect(next).toEqual([
      "repo",
      "branches",
      "owner",
      "status",
      SESSIONS_COST_COLUMN_ID,
      "pr",
    ]);
    expect(
      columnEndPx(next, SESSIONS_COST_COLUMN_ID, hiddenColumnIds)
    ).toBeLessThanOrEqual(SESSIONS_LEGIBLE_COLUMN_BUDGET_PX);
  });

  it("carries the budget through migrateSavedColumnOrder", () => {
    const userOrder = [
      "repo",
      "branches",
      "owner",
      "status",
      "pr",
      SESSIONS_COST_COLUMN_ID,
    ];

    const result = migrateSavedColumnOrder(
      userOrder,
      ISS_4890_CANONICAL_ORDER,
      SESSIONS_SAVED_VIEW_UNVERSIONED,
      SESSIONS_BUDGET_GEOMETRY
    );

    expect(
      columnEndPx(result.columnOrder, SESSIONS_COST_COLUMN_ID)
    ).toBeLessThanOrEqual(SESSIONS_LEGIBLE_COLUMN_BUDGET_PX);
    expect(result.version).toBe(SESSIONS_SAVED_VIEW_VERSION);
  });
});

/**
 * ISS-5315 — the migration against the order this build actually renders by.
 *
 * ISS-5315 moved Cost from the 3rd canonical slot to the 9th, so the migration's
 * relative anchor now resolves late. The budget clamp is what stops that from
 * becoming a silent regression for a user with a persisted order: the resolved
 * slot is pulled left until Cost's own track ends inside the legible budget, so
 * an un-migrated saved view still lands Cost somewhere a reader can see it —
 * regardless of where the canonical order puts it.
 *
 * This is deliberately the ONE place the live order is exercised. If a future
 * reshuffle breaks the clamp's guarantee, it fails here.
 */
describe("migrateSavedColumnOrder against the live canonical order (ISS-5315)", () => {
  it("still lands Cost inside the legible budget for an un-migrated view", () => {
    const result = migrateSavedColumnOrder(
      PERSISTED_COST_LATE,
      SESSIONS_DATA_COLUMN_ORDER,
      SESSIONS_SAVED_VIEW_UNVERSIONED,
      SESSIONS_BUDGET_GEOMETRY
    );

    expect(
      columnEndPx(result.columnOrder, SESSIONS_COST_COLUMN_ID)
    ).toBeLessThanOrEqual(SESSIONS_LEGIBLE_COLUMN_BUDGET_PX);
    expect(result.version).toBe(SESSIONS_SAVED_VIEW_VERSION);
    // Nothing but Cost moves — the migration's other promise, unchanged.
    const withoutCost = (ids: readonly string[]) =>
      ids.filter((id) => id !== SESSIONS_COST_COLUMN_ID);
    expect(withoutCost(result.columnOrder)).toEqual(
      withoutCost(PERSISTED_COST_LATE)
    );
  });
});

describe("ISS-6005: migrateSavedHiddenColumns", () => {
  it("appends every migrated id to an unversioned hidden set, preserving existing entries and order", () => {
    const result = migrateSavedHiddenColumns(
      ["model", "pr"],
      SESSIONS_SAVED_VIEW_UNVERSIONED
    );
    // Existing entries keep their slots; only the missing migrated ids append,
    // deduplicated (`pr` was already hidden and is not repeated).
    expect(result.hiddenColumns).toEqual([
      "model",
      "pr",
      "merge",
      "updated",
      "started",
      "projects",
      "issues",
    ]);
    expect(result.version).toBe(SESSIONS_SAVED_VIEW_HIDDEN_VERSION);
  });

  it("is guarded on the version, not on membership: a stamped set is returned untouched", () => {
    // The post-migration shape of a user who deliberately re-enabled PR — the
    // migration must not re-hide it on any later load.
    const result = migrateSavedHiddenColumns(
      ["merge", "updated", "started", "projects", "issues"],
      SESSIONS_SAVED_VIEW_HIDDEN_VERSION
    );
    expect(result.hiddenColumns).toEqual([
      "merge",
      "updated",
      "started",
      "projects",
      "issues",
    ]);
    expect(result.version).toBe(SESSIONS_SAVED_VIEW_HIDDEN_VERSION);
  });

  it("leaves a NEWER build's payload untouched but clamps its version to this build's stamp", () => {
    // BEHAVIOUR CHANGE (ISS-6065, wongk): this previously returned `futureVersion`
    // verbatim, on the reasoning that a future migration must never silently
    // re-run. That reasoning does not survive the round trip. The shared
    // `usePersistedTableViewState` restore drops every hidden id outside this
    // build's `columnIds` and re-persists the filtered set with the marker
    // untouched, so preserving the stamp certifies a v+1 payload this build has
    // already destroyed — and the newer build then skips the step that would
    // restore it. The payload is still never rewritten here; only the stamp this
    // build is willing to vouch for is. Covered end to end through the hook in
    // `use-sessions-view-state.test.tsx`.
    const futureVersion = SESSIONS_SAVED_VIEW_HIDDEN_VERSION + 1;
    const result = migrateSavedHiddenColumns(["model"], futureVersion);
    expect(result.hiddenColumns).toEqual(["model"]);
    expect(result.version).toBe(SESSIONS_SAVED_VIEW_HIDDEN_VERSION);
  });

  it("returns a new array; the input is never mutated", () => {
    const input = ["model"];
    const result = migrateSavedHiddenColumns(
      input,
      SESSIONS_SAVED_VIEW_UNVERSIONED
    );
    expect(input).toEqual(["model"]);
    expect(result.hiddenColumns).not.toBe(input);
  });
});

describe("ISS-6065: every default-hidden column is migrated", () => {
  it("hides started/projects/issues for a view already stamped at v1", () => {
    // The population ISS-6065 is actually about: anyone who loaded Sessions
    // after ISS-6005 carries version 1, so widening the v1 payload would have
    // skipped them entirely. Only the v2 ids append; the v1 ids are not redone.
    const result = migrateSavedHiddenColumns(
      ["pr", "merge", "updated"],
      SESSIONS_HIDDEN_MIGRATION_V1_VERSION
    );
    expect(result.hiddenColumns).toEqual([
      "pr",
      "merge",
      "updated",
      "started",
      "projects",
      "issues",
    ]);
    expect(result.version).toBe(SESSIONS_SAVED_VIEW_HIDDEN_VERSION);
  });

  it("does not re-apply a step the view already took: a v1 re-enable of PR sticks", () => {
    // The per-step gate, isolated. A v1-stamped user who re-showed PR from the
    // View menu has it ABSENT from their hidden set; only the v2 ids may append.
    // Without the per-step filter the v1 payload replays and re-hides PR on the
    // next load — the "not fought on every load" promise, broken. The sibling
    // test above cannot catch that: its fixture still hides PR, so the dedupe
    // masks a replayed v1 payload.
    const result = migrateSavedHiddenColumns(
      ["merge", "updated"],
      SESSIONS_HIDDEN_MIGRATION_V1_VERSION
    );
    expect(result.hiddenColumns).not.toContain("pr");
    expect(result.hiddenColumns).toEqual([
      "merge",
      "updated",
      "started",
      "projects",
      "issues",
    ]);
  });

  it("names every default-hidden column across its migration payloads", () => {
    // The guard the ticket asks for. A column added to the default-hidden set
    // without a migration step does not stay hidden for a saved view — it
    // silently auto-shows, which is how `started`, `projects`, and `issues` were
    // missed. Fail here rather than in a user's persisted view.
    const migrated = new Set(SESSIONS_HIDDEN_MIGRATION_COLUMN_IDS);
    const unmigrated = SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS.filter(
      (id) => !migrated.has(id)
    );
    expect(unmigrated).toEqual([]);
  });

  it("pins each shipped step's payload, so a new default-hidden id needs a NEW step", () => {
    // What makes the subset guard above load-bearing rather than satisfiable the
    // wrong way: appending an id to an already-shipped payload would keep that
    // guard green while every view stamped at that step's version short-circuits
    // on the version check and never hides it — ISS-6065 recurring silently.
    // Pinned, the only green way to add a default-hidden id is a new step at a
    // new version, which is exactly what reaches the already-stamped views.
    expect(SESSIONS_HIDDEN_MIGRATION_STEPS).toEqual([
      { version: 1, columnIds: ["pr", "merge", "updated"] },
      { version: 2, columnIds: ["started", "projects", "issues"] },
    ]);
  });

  it("stamps the latest step's version, so a new step cannot be added without bumping", () => {
    // The other half: a step added below the current stamp is unreachable —
    // `migrateSavedHiddenColumns` returns early for any view already at
    // SESSIONS_SAVED_VIEW_HIDDEN_VERSION, so its ids would never be applied.
    //
    // Asserted as strictly-increasing versions whose LAST entry equals the
    // stamp, not as `Math.max(...) === stamp` (ISS-6065, wongk). A max only
    // proves SOME step matches the stamp, which a new step reusing version 2
    // also satisfies: the subset guard sees its ids, the pin above is updated
    // alongside it, every assertion stays green, and yet every view already
    // stamped 2 short-circuits and never hides them. Strict monotonicity makes
    // the duplicate itself the failure, and pinning the LAST element (rather
    // than any element) is what forbids a step appended below the stamp.
    const versions = SESSIONS_HIDDEN_MIGRATION_STEPS.map(
      (step) => step.version
    );
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.at(-1)).toBe(SESSIONS_SAVED_VIEW_HIDDEN_VERSION);
  });
});
