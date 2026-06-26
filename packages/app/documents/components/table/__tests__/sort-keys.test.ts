import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { describe, expect, it } from "vitest";
import {
  getRankInteractionMode,
  RankInteractionMode,
  SORT_KEYS,
  SortKey,
  shouldShowRankSlot,
} from "../sort-keys";

describe("SortKey", () => {
  it("declares StackRank as a distinct sentinel value", () => {
    expect(SortKey.StackRank).toBe("stackRank");
    expect(SORT_KEYS).toContain(SortKey.StackRank);
  });

  it("covers every existing column-sort key", () => {
    // Lock in the canonical column list so adding/removing a sortable column
    // becomes a deliberate test update — `useSortParams.validColumns` and the
    // table header click handlers both rely on this list staying complete.
    expect(SORT_KEYS).toEqual([
      "stackRank",
      "title",
      "type",
      "dueDate",
      "assignee",
      "priority",
      "score",
      "status",
      "slug",
    ]);
  });
});

describe("getRankInteractionMode", () => {
  it("returns Enabled when sort is StackRank and grouping is off", () => {
    expect(getRankInteractionMode(SortKey.StackRank, GroupByMode.None)).toBe(
      RankInteractionMode.Enabled
    );
  });

  it("returns Enabled when no explicit sort and grouping is off", () => {
    // No URL param + flag-on default falls back to StackRank, but a caller
    // that explicitly passes `null` should still get the enabled affordance
    // because the underlying ordering is still server-supplied stack rank.
    expect(getRankInteractionMode(null, GroupByMode.None)).toBe(
      RankInteractionMode.Enabled
    );
  });

  it("returns Hidden when a column sort is active", () => {
    expect(getRankInteractionMode(SortKey.Title, GroupByMode.None)).toBe(
      RankInteractionMode.Hidden
    );
    expect(getRankInteractionMode(SortKey.Status, GroupByMode.None)).toBe(
      RankInteractionMode.Hidden
    );
  });

  it("returns DisabledGrouped when grouping is active regardless of sort", () => {
    expect(getRankInteractionMode(SortKey.StackRank, GroupByMode.Status)).toBe(
      RankInteractionMode.DisabledGrouped
    );
    expect(getRankInteractionMode(SortKey.Title, GroupByMode.Priority)).toBe(
      RankInteractionMode.DisabledGrouped
    );
    expect(getRankInteractionMode(null, GroupByMode.Assignee)).toBe(
      RankInteractionMode.DisabledGrouped
    );
  });
});

describe("shouldShowRankSlot", () => {
  it("reserves a slot for Enabled and DisabledGrouped", () => {
    expect(shouldShowRankSlot(RankInteractionMode.Enabled)).toBe(true);
    expect(shouldShowRankSlot(RankInteractionMode.DisabledGrouped)).toBe(true);
  });

  it("reserves no slot for Hidden or undefined", () => {
    // The header and body rows must agree here: a reserved-but-empty header
    // column with no matching body column shifts every label one slot.
    expect(shouldShowRankSlot(RankInteractionMode.Hidden)).toBe(false);
    expect(shouldShowRankSlot(undefined)).toBe(false);
  });
});
