import { describe, expect, it } from "vitest";
import type { CloudSyncLaneRemainder } from "../../../shared/cloud-read-readiness-contract";
import { SyncLaneId } from "../../../shared/sync-burndown-contract";
import type { IngestProgress } from "../../hooks/use-ingest-progress";
import {
  describeAllLaneRemainders,
  describeImportProgress,
  describeLaneRemainders,
  describeQuarantinedSessionImpact,
  describeQuarantinedSources,
  formatCount,
  resolveCouldNotImportCount,
  resolveQuarantinedStageCounts,
} from "../import-progress-display";

const complete: IngestProgress = {
  byHarness: [],
  complete: true,
  preparing: false,
  processed: 90,
  total: 90,
};

describe("describeImportProgress", () => {
  it("clamps a processed count that overshoots its total", () => {
    expect(describeImportProgress(120, 90)).toEqual({
      processed: 90,
      total: 90,
      pct: 100,
    });
  });

  it("reports 0% rather than NaN when nothing was discovered", () => {
    expect(describeImportProgress(0, 0)).toEqual({
      processed: 0,
      total: 0,
      pct: 0,
    });
  });

  it("floors negative and non-finite counts to zero", () => {
    expect(describeImportProgress(-5, Number.NaN)).toEqual({
      processed: 0,
      total: 0,
      pct: 0,
    });
  });
});

// ISS-4444: the derived "couldn't import" count is clamped so a version-skewed or
// malformed main-process payload can never render a nonsense number. ISS-5281
// moved the helper here from `sessions/sessions-summary-cards-state.ts` so the
// React-free import-splash derivation can share the one clamp.
describe("resolveCouldNotImportCount", () => {
  it("returns a positive quarantined count", () => {
    expect(
      resolveCouldNotImportCount({ ...complete, quarantinedCount: 3 })
    ).toBe(3);
  });

  it("degrades to 0 when the field is absent (older main process)", () => {
    expect(resolveCouldNotImportCount(complete)).toBe(0);
  });

  it("degrades to 0 for null, negative, non-finite, or non-numeric values", () => {
    expect(resolveCouldNotImportCount(null)).toBe(0);
    expect(
      resolveCouldNotImportCount({ ...complete, quarantinedCount: -2 })
    ).toBe(0);
    expect(
      resolveCouldNotImportCount({
        ...complete,
        quarantinedCount: Number.NaN,
      })
    ).toBe(0);
  });

  it("floors a fractional value to a whole transcript count", () => {
    expect(
      resolveCouldNotImportCount({ ...complete, quarantinedCount: 2.9 })
    ).toBe(2);
  });
});

describe("formatCount", () => {
  it("uses the singular noun for exactly one", () => {
    expect(formatCount(1, "session")).toBe("1 session");
    expect(formatCount(1, "transcript")).toBe("1 transcript");
  });

  it("pluralizes every other count, including zero", () => {
    expect(formatCount(0, "session")).toBe("0 sessions");
    expect(formatCount(2, "transcript")).toBe("2 transcripts");
  });

  it("groups large counts for legibility", () => {
    expect(formatCount(2452, "session")).toBe("2,452 sessions");
  });
});

/**
 * ISS-6115 (wongk review): `quarantinedCount` changed meaning when the import
 * bound started charging the quarantine store, and every renderer went on saying
 * the transcript "couldn't be read". Two of those claims are false on the import
 * path: the file WAS read — the write is what did not finish — and the isolated
 * importer commits its record groups one at a time, so a later group timing out
 * leaves the earlier ones already written.
 *
 * These are the copy contract for all four surfaces that report the population
 * (the startup-readiness detail, the import splash alert, the splash body, and
 * the shared Sessions summary card), which is why the phrase is built in one
 * place instead of at each of them.
 */
describe("describeQuarantinedSources", () => {
  it("says 'couldn't be read' only for the parse-stage population", () => {
    expect(
      describeQuarantinedSources({ parse: 3, import: 0 }, "transcript")
    ).toBe("3 transcripts couldn't be read");
    expect(
      describeQuarantinedSources({ parse: 1, import: 0 }, "transcript")
    ).toBe("1 transcript couldn't be read");
  });

  it("says 'couldn't be saved' for an import stall, which read the file fine", () => {
    expect(
      describeQuarantinedSources({ parse: 0, import: 2 }, "transcript")
    ).toBe("2 transcripts couldn't be saved");
    expect(
      describeQuarantinedSources({ parse: 0, import: 1 }, "history file")
    ).toBe("1 history file couldn't be saved");
  });

  it("names the shared outcome when both stages contributed", () => {
    // Neither verb is true of the whole population, so it claims neither.
    expect(
      describeQuarantinedSources({ parse: 2, import: 1 }, "transcript")
    ).toBe("3 transcripts couldn't be imported");
  });

  it("returns null when nothing is quarantined, so no caveat renders at all", () => {
    expect(
      describeQuarantinedSources({ parse: 0, import: 0 }, "transcript")
    ).toBeNull();
  });
});

describe("describeQuarantinedSessionImpact", () => {
  it("keeps the 'unchanged' claim only while nothing reached the write", () => {
    expect(describeQuarantinedSessionImpact({ parse: 3, import: 0 })).toBe(
      "Existing sessions are unchanged."
    );
  });

  it("stops claiming sessions are unchanged once an import stalled", () => {
    // The isolated importer can commit earlier record groups before a later one
    // times out, so "unchanged" would be the UI lying about its own data.
    expect(describeQuarantinedSessionImpact({ parse: 0, import: 1 })).toBe(
      "Some sessions may be partly imported."
    );
    expect(describeQuarantinedSessionImpact({ parse: 5, import: 1 })).toBe(
      "Some sessions may be partly imported."
    );
  });
});

describe("resolveQuarantinedStageCounts", () => {
  it("splits the population the main process reported", () => {
    expect(
      resolveQuarantinedStageCounts({
        ...complete,
        quarantinedCount: 5,
        quarantinedByStage: { parse: 2, import: 3 },
      })
    ).toEqual({ parse: 2, import: 3 });
  });

  it("attributes the whole population to parse when the split is absent", () => {
    // Cross-process rule: an older main process sends no split, and before the
    // import bound charged the store every quarantine WAS a parse wedge — so the
    // absent field must mean the prior behaviour, never a guess.
    expect(
      resolveQuarantinedStageCounts({ ...complete, quarantinedCount: 4 })
    ).toEqual({ parse: 4, import: 0 });
  });

  it("clamps malformed per-stage values instead of rendering nonsense", () => {
    expect(
      resolveQuarantinedStageCounts({
        ...complete,
        quarantinedCount: 3,
        quarantinedByStage: { parse: -2, import: Number.NaN },
      })
    ).toEqual({ parse: 0, import: 0 });
  });
});

function remainder(
  lane: SyncLaneId,
  itemsRemaining: number,
  itemsRemainingIsLowerBound = false
): CloudSyncLaneRemainder {
  return { lane, itemsRemaining, itemsRemainingIsLowerBound };
}

/**
 * ISS-6206 (thadeusb review on #5050): the collapse path had no unit coverage —
 * the integration tests only ever fed it two lanes, so the comma/and/tail
 * formatting was unpinned for exactly the case it exists to handle.
 */
describe("describeLaneRemainders", () => {
  it("returns null for an empty breakdown so callers keep their own copy", () => {
    expect(describeLaneRemainders([])).toBeNull();
  });

  it("names a single lane with no conjunction", () => {
    expect(
      describeLaneRemainders([remainder(SyncLaneId.TranscriptArchive, 1)])
    ).toBe("1 transcript");
  });

  it("joins two lanes with 'and' and no comma", () => {
    expect(
      describeLaneRemainders([
        remainder(SyncLaneId.SessionMetadata, 2900),
        remainder(SyncLaneId.TranscriptArchive, 12),
      ])
    ).toBe("2,900 sessions and 12 transcripts");
  });

  it("collapses a third lane into a tail that names what it counts", () => {
    // wongk review on #5050: the tail counts KINDS while every clause beside it
    // counts ITEMS, so a bare "and 1 more" read as one more item — for a lane
    // that here owes a million. Its unit is not optional.
    expect(
      describeLaneRemainders([
        remainder(SyncLaneId.SessionMetadata, 2900),
        remainder(SyncLaneId.TranscriptArchive, 12),
        remainder(SyncLaneId.ComponentInventory, 1_000_000),
      ])
    ).toBe("2,900 sessions, 12 transcripts and 1 other kind");
  });

  it("counts every hidden lane in the tail, not just the first", () => {
    expect(
      describeLaneRemainders([
        remainder(SyncLaneId.SessionMetadata, 2900),
        remainder(SyncLaneId.InvocationParts, 40),
        remainder(SyncLaneId.TranscriptArchive, 12),
        remainder(SyncLaneId.ComponentInventory, 7),
        remainder(SyncLaneId.TraceComments, 3),
      ])
    ).toBe("2,900 sessions, 40 session details and 3 other kinds");
  });

  it("never ends on a bare count the reader can take for items", () => {
    // The property behind both pins above, asserted directly: whatever the tail
    // says, it may not be a number the sentence's item clauses absorb. The
    // hidden lane owes 2,985 here — the size of the misread.
    const hiddenSets = [
      [SyncLaneId.ComponentInventory],
      [SyncLaneId.ComponentInventory, SyncLaneId.TraceComments],
    ];
    for (const hidden of hiddenSets) {
      const label = describeLaneRemainders([
        remainder(SyncLaneId.SessionMetadata, 3),
        remainder(SyncLaneId.TranscriptArchive, 7),
        ...hidden.map((lane) => remainder(lane, 2985)),
      ]);
      expect(label).not.toMatch(BARE_TAIL_COUNT);
      expect(label).toMatch(NAMED_TAIL_UNIT);
    }
  });

  it("hedges a lane whose own count is a floor", () => {
    expect(
      describeLaneRemainders([
        remainder(SyncLaneId.ComponentInventory, 2985, true),
        remainder(SyncLaneId.TraceComments, 1),
      ])
    ).toBe("at least 2,985 activity records and 1 comment");
  });
});

/**
 * ISS-6206 (wongk review on #5050): the label may collapse the tail; the detail
 * may not. A third lane owing a million transcripts has to be reachable
 * somewhere on the screen, and a collapsed "and 1 other kind" in both strings is
 * nowhere.
 */
describe("describeAllLaneRemainders", () => {
  it("returns null for an empty breakdown, like the collapsed form", () => {
    expect(describeAllLaneRemainders([])).toBeNull();
  });

  it("names every lane instead of collapsing the tail", () => {
    const remainders = [
      remainder(SyncLaneId.SessionMetadata, 2900),
      remainder(SyncLaneId.TranscriptArchive, 12),
      remainder(SyncLaneId.ComponentInventory, 1_000_000),
    ];
    expect(describeAllLaneRemainders(remainders)).toBe(
      "2,900 sessions, 12 transcripts and 1,000,000 activity records"
    );
    // The actionable count the label hides is present here, and only here.
    expect(describeLaneRemainders(remainders)).not.toContain("1,000,000");
  });

  it("carries each lane's own floor through the full breakdown", () => {
    expect(
      describeAllLaneRemainders([
        remainder(SyncLaneId.SessionMetadata, 5, true),
        remainder(SyncLaneId.TranscriptArchive, 12),
        remainder(SyncLaneId.TraceComments, 3, true),
      ])
    ).toBe("at least 5 sessions, 12 transcripts and at least 3 comments");
  });
});

/** A collapsed tail whose unit the surrounding item counts would swallow. */
const BARE_TAIL_COUNT = /\band [\d,]+ more$/;
/** The same tail, saying what it counts. */
const NAMED_TAIL_UNIT = /\band [\d,]+ other kinds?$/;
