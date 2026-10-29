import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it } from "vitest";
import { parseBranchSavedView } from "../branch-saved-view";
import {
  BranchSortDir,
  BranchSortKey,
  DEFAULT_BRANCH_SORT_DIR,
  DEFAULT_BRANCH_SORT_KEY,
} from "../branch-sort-group";

describe("parseBranchSavedView hiddenSummaryCards (ISS-12664)", () => {
  const base = { sortKey: "name", sortDir: "asc" };

  it("keeps string ids, including ones this build does not know", () => {
    expect(
      parseBranchSavedView({
        ...base,
        hiddenSummaryCards: ["merge_rate", "card_from_a_newer_build"],
      })?.hiddenSummaryCards
    ).toEqual(["merge_rate", "card_from_a_newer_build"]);
  });

  it("drops non-string entries and degrades a non-array to []", () => {
    expect(
      parseBranchSavedView({
        ...base,
        hiddenSummaryCards: ["merge_rate", 7, null],
      })?.hiddenSummaryCards
    ).toEqual(["merge_rate"]);
    expect(
      parseBranchSavedView({ ...base, hiddenSummaryCards: "merge_rate" })
        ?.hiddenSummaryCards
    ).toEqual([]);
    expect(
      parseBranchSavedView({ ...base, hiddenSummaryCards: null })
        ?.hiddenSummaryCards
    ).toEqual([]);
  });
});

describe("parseBranchSavedView", () => {
  it("accepts a well-formed view", () => {
    expect(
      parseBranchSavedView({
        sortKey: "name",
        sortDir: "asc",
        dateRange: "30d",
        hiddenColumns: ["points", "checks"],
        columnOrder: ["repo", "owner"],
        columnWidths: { repo: 200 },
      })
    ).toEqual({
      sortKey: "name",
      sortDir: "asc",
      dateRange: "30d",
      hiddenColumns: ["points", "checks"],
      columnOrder: ["repo", "owner"],
      columnWidths: { repo: 200 },
      // ISS-9676: a view written before grouping existed omits the key and
      // restores ungrouped rather than failing the parse.
      grouping: EMPTY_TABLE_GROUPING,
      // ISS-9582: nor did it have collapse state, so every band restores open.
      collapsedGroups: {},
      // ISS-9447 M5: a view written before the envelope existed carries no
      // stamps, which is the never-migrated state every step runs against.
      hiddenSummaryCards: [],
      viewStateVersions: {},
    });
  });

  it("FEA-4021: defaults columnOrder to [] and drops non-string entries", () => {
    expect(
      parseBranchSavedView({
        sortKey: "name",
        sortDir: "asc",
        columnOrder: ["repo", 7, null, "owner"],
      })?.columnOrder
    ).toEqual(["repo", "owner"]);
    expect(
      parseBranchSavedView({ sortKey: "name", sortDir: "asc" })?.columnOrder
    ).toEqual([]);
  });

  it("FEA-4168: defaults columnWidths to {} and drops malformed entries", () => {
    // Missing → {}.
    expect(
      parseBranchSavedView({ sortKey: "name", sortDir: "asc" })?.columnWidths
    ).toEqual({});
    // A NaN/negative/non-number width is dropped; a valid width survives.
    expect(
      parseBranchSavedView({
        sortKey: "name",
        sortDir: "asc",
        columnWidths: { repo: 200, owner: -5, status: "wide", checks: 0 },
      })?.columnWidths
    ).toEqual({ repo: 200 });
  });

  it("FEA-4168: degrades a non-object columnWidths to {}", () => {
    expect(
      parseBranchSavedView({
        sortKey: "name",
        sortDir: "asc",
        columnWidths: ["not", "an", "object"],
      })?.columnWidths
    ).toEqual({});
  });

  it("FEA-4004: tolerates a legacy persisted showHidden key", () => {
    // The merged/agent-branch hide was removed; an install that persisted the
    // old `showHidden` extra must still restore its sort/columns/window cleanly.
    //
    // ISS-9447 M5 flipped the second half of this case DELIBERATELY. It used to
    // assert the retired key was DROPPED; the schema is now `.loose()` and keeps
    // it. That is the price of the fix and it is the right way round: a parser
    // cannot tell a key a newer build ADDED from one an older build RETIRED, and
    // guessing wrong on the first costs a reader their saved view, while
    // guessing wrong on the second costs an inert key nothing reads. The half
    // this case exists for — the retired key does not break the parse — is
    // unchanged and still pinned by the sort/columns/window assertions below.
    const parsed = parseBranchSavedView({
      sortKey: "name",
      sortDir: "asc",
      dateRange: "30d",
      hiddenColumns: ["points"],
      showHidden: true,
    });
    expect(parsed).toEqual({
      sortKey: "name",
      sortDir: "asc",
      dateRange: "30d",
      hiddenColumns: ["points"],
      columnOrder: [],
      columnWidths: {},
      grouping: EMPTY_TABLE_GROUPING,
      collapsedGroups: {},
      hiddenSummaryCards: [],
      viewStateVersions: {},
      showHidden: true,
    });
    expect(parsed).toHaveProperty("showHidden");
  });

  it("ISS-9447 M5: keeps a key only a NEWER build names", () => {
    // The parse half of the preserve posture. Without `.loose()` this key is
    // gone before the hook ever sees it, and the write half in
    // `use-branch-view-state.ts` has nothing left to carry.
    const parsed = parseBranchSavedView({
      sortKey: "name",
      sortDir: "asc",
      futureDimension: { mode: "compact" },
    });
    expect(parsed?.futureDimension).toEqual({ mode: "compact" });
    // And the known axes are unaffected by carrying it.
    expect(parsed?.sortKey).toBe(BranchSortKey.Name);
    expect(parsed?.dateRange).toBe("7d");
  });

  it("ISS-9447 M5: validates the version envelope rather than passing it through", () => {
    // Carry-only does not mean unchecked. A stamp past the corruption ceiling,
    // or one that is not a stamp at all, is dropped HERE rather than handed on
    // to the build that does have a migration it would then permanently skip.
    // `.loose()` alone would round-trip all three of these verbatim.
    expect(
      parseBranchSavedView({
        sortKey: "name",
        sortDir: "asc",
        viewStateVersions: {
          columnOrder: 2,
          sort: 5_000_000,
          hiddenColumns: "one",
        },
      })?.viewStateVersions
    ).toEqual({ columnOrder: 2 });
    // A malformed envelope costs the reader nothing beyond the stamps.
    expect(
      parseBranchSavedView({
        sortKey: "name",
        sortDir: "asc",
        viewStateVersions: "corrupt",
      })
    ).toMatchObject({ sortKey: BranchSortKey.Name, viewStateVersions: {} });
  });

  it("defaults the time window to 7d when absent", () => {
    expect(
      parseBranchSavedView({ sortKey: "name", sortDir: "asc" })?.dateRange
    ).toBe("7d");
  });

  it("rejects non-objects", () => {
    expect(parseBranchSavedView(null)).toBeNull();
    expect(parseBranchSavedView("nope")).toBeNull();
  });

  it("ISS-9447 M5: falls back on an unusable sort instead of nulling the view", () => {
    // A DELIBERATE behavior change. `sortKey`/`sortDir` were required closed
    // enums with no fallback, so one value this build cannot spell — a renamed
    // column, a sort key a newer build added, a hand-edited `localStorage` —
    // failed the whole object and returned `null`, and the reader lost their
    // columns, window and grouping along with their sort. Every other axis in
    // this schema already degrades rather than discards; the sort pair now does
    // too, which is M5's third criterion.
    const badKey = parseBranchSavedView({
      sortKey: "bogus",
      sortDir: BranchSortDir.Asc,
      dateRange: "30d",
      hiddenColumns: ["points"],
      columnOrder: ["repo"],
    });
    expect(badKey?.sortKey).toBe(DEFAULT_BRANCH_SORT_KEY);
    // The direction the reader DID store survives the key's fallback.
    expect(badKey?.sortDir).toBe(BranchSortDir.Asc);
    // And so does everything the old `null` used to take with it.
    expect(badKey?.dateRange).toBe("30d");
    expect(badKey?.hiddenColumns).toEqual(["points"]);
    expect(badKey?.columnOrder).toEqual(["repo"]);

    // ISS-10332 (PLN-2086 Milestone 2): `priority` is a key this build spells —
    // the column, its comparator arms and the sort-menu entry all landed — so a
    // stored one survives the parse instead of falling back.
    expect(
      parseBranchSavedView({
        sortKey: BranchSortKey.Priority,
        sortDir: BranchSortDir.Asc,
      })?.sortKey
    ).toBe(BranchSortKey.Priority);

    const badDir = parseBranchSavedView({
      sortKey: BranchSortKey.Name,
      sortDir: "sideways",
      hiddenColumns: ["points"],
    });
    expect(badDir?.sortDir).toBe(DEFAULT_BRANCH_SORT_DIR);
    expect(badDir?.sortKey).toBe(BranchSortKey.Name);
    expect(badDir?.hiddenColumns).toEqual(["points"]);

    // Absent is the same story, and was already the harsher of the two: an
    // object with neither key parsed to `null` outright.
    const absent = parseBranchSavedView({ dateRange: "90d" });
    expect(absent?.sortKey).toBe(DEFAULT_BRANCH_SORT_KEY);
    expect(absent?.sortDir).toBe(DEFAULT_BRANCH_SORT_DIR);
    expect(absent?.dateRange).toBe("90d");
  });

  it("defaults hiddenColumns to [] and drops non-string entries", () => {
    expect(
      parseBranchSavedView({
        sortKey: "lastActivity",
        sortDir: "desc",
        hiddenColumns: ["points", 7, null],
      })?.hiddenColumns
    ).toEqual(["points"]);
    expect(
      parseBranchSavedView({
        sortKey: "lastActivity",
        sortDir: "desc",
      })?.hiddenColumns
    ).toEqual([]);
  });
});
