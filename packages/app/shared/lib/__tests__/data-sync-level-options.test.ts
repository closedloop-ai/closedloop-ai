import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import { describe, expect, it } from "vitest";
import {
  offeredDataSyncLevelsWithoutRedaction,
  offeredDataSyncLevelsWithRedaction,
} from "../data-sync-level-options";

// PLN-1915 Step 4: the subset rule both data-sync surfaces read. Pure and
// hook-free, so the rule itself is exercised here and the cross-surface parity
// suite only has to prove both surfaces reach it.

/**
 * Each offered level's position in the canonical list. Strictly increasing is
 * the only shape that says "filtered, never sorted or reversed" — comparing
 * against a re-derived expected array would just restate the implementation.
 */
function canonicalPositions(levels: readonly DataSyncLevel[]): number[] {
  return levels.map((level) => DATA_SYNC_LEVELS.indexOf(level));
}

function isStrictlyIncreasing(values: readonly number[]): boolean {
  return values.every(
    (value, index) => index === 0 || value > values[index - 1]
  );
}

describe("offered data-sync levels", () => {
  it("offers every canonical level, in canonical order, when redaction is on", () => {
    const levels = offeredDataSyncLevelsWithRedaction();

    expect([...levels]).toEqual([...DATA_SYNC_LEVELS]);
    expect(levels).toContain(DataSyncLevel.Redacted);
  });

  it("withholds redacted, and only redacted, when redaction is off", () => {
    const levels = offeredDataSyncLevelsWithoutRedaction(null);

    expect(levels).not.toContain(DataSyncLevel.Redacted);
    expect(levels).toHaveLength(DATA_SYNC_LEVELS.length - 1);
  });

  it("keeps redacted offered when it is the current selection", () => {
    // A profile already on `redacted` must not be orphaned by the flag: an
    // option set that cannot express the current selection leaves the picker
    // with nothing checked.
    const levels = offeredDataSyncLevelsWithoutRedaction(
      DataSyncLevel.Redacted
    );

    expect(levels).toContain(DataSyncLevel.Redacted);
    expect(levels).toHaveLength(DATA_SYNC_LEVELS.length);
  });

  it("still withholds redacted when a different level is the current selection", () => {
    const levels = offeredDataSyncLevelsWithoutRedaction(
      DataSyncLevel.Metadata
    );

    expect(levels).not.toContain(DataSyncLevel.Redacted);
    expect(levels).toHaveLength(DATA_SYNC_LEVELS.length - 1);
  });

  it("preserves canonical order on every path, and neither set sorts", () => {
    for (const levels of [
      offeredDataSyncLevelsWithRedaction(),
      offeredDataSyncLevelsWithoutRedaction(null),
      offeredDataSyncLevelsWithoutRedaction(DataSyncLevel.Redacted),
    ]) {
      expect(isStrictlyIncreasing(canonicalPositions(levels))).toBe(true);
    }
  });
});
