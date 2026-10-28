import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  computeCorpusShiftMs,
  findCorpusIdleGaps,
  KEPT_IDLE_GAP_MS,
  parseIsoInstant,
  shiftIsoInstant,
} from "../scripts/vibe-profile/corpus-time-shift";

const NEWEST_NOT_ISO_RE = /newestCorpusInstant/;
const NOW_NOT_ISO_RE = /now must be/;
const LABELLED_NOT_ISO_RE = /x must be/;

const NEWEST = "2026-08-31T20:34:47.267Z";
const NOW = "2026-10-05T15:30:26.000Z";

describe("computeCorpusShiftMs", () => {
  it("is now minus the newest corpus instant", () => {
    assert.equal(
      computeCorpusShiftMs(NEWEST, NOW),
      Date.parse(NOW) - Date.parse(NEWEST)
    );
  });

  it("moves the newest corpus instant exactly onto now", () => {
    const shift = computeCorpusShiftMs(NEWEST, NOW);
    assert.equal(shiftIsoInstant(NEWEST, shift), NOW);
  });

  it("keeps the gap between two corpus instants", () => {
    const shift = computeCorpusShiftMs(NEWEST, NOW);
    const earlier = "2026-03-15T18:09:00.000Z";
    assert.equal(
      Date.parse(shiftIsoInstant(NEWEST, shift)) -
        Date.parse(shiftIsoInstant(earlier, shift)),
      Date.parse(NEWEST) - Date.parse(earlier)
    );
  });

  it("is zero on a store that is already shifted", () => {
    assert.equal(computeCorpusShiftMs(NOW, NOW), 0);
  });

  it("refuses non-ISO input on either side", () => {
    assert.throws(
      () => computeCorpusShiftMs("2026-08-31", NOW),
      NEWEST_NOT_ISO_RE
    );
    assert.throws(() => computeCorpusShiftMs(NEWEST, "now"), NOW_NOT_ISO_RE);
    assert.throws(
      () => parseIsoInstant("2026-13-45T99:99:99Z", "x"),
      LABELLED_NOT_ISO_RE
    );
  });

  it("keeps the store's millisecond Z form for offset input", () => {
    assert.equal(
      shiftIsoInstant("2026-08-31T22:34:47+02:00", 1000),
      "2026-08-31T20:34:48.000Z"
    );
  });
});

describe("findCorpusIdleGaps", () => {
  const span = (startedAt: string, lastActivityAt: string) => ({
    startedAt,
    lastActivityAt,
  });

  it("closes every idle stretch longer than two days down to one day", () => {
    const gaps = findCorpusIdleGaps([
      span("2026-07-01T09:00:00.000Z", "2026-07-03T10:00:00.000Z"),
      span("2026-07-02T09:00:00.000Z", "2026-07-02T11:00:00.000Z"),
      span("2026-07-20T08:00:00.000Z", "2026-07-20T09:00:00.000Z"),
      span("2026-07-21T08:00:00.000Z", "2026-07-21T09:00:00.000Z"),
      span("2026-07-30T08:00:00.000Z", "2026-07-30T09:00:00.000Z"),
    ]);
    assert.deepEqual(gaps, [
      {
        beforeIso: "2026-07-20T08:00:00.000Z",
        closeMs:
          Date.parse("2026-07-20T08:00:00.000Z") -
          Date.parse("2026-07-03T10:00:00.000Z") -
          KEPT_IDLE_GAP_MS,
      },
      {
        beforeIso: "2026-07-30T08:00:00.000Z",
        closeMs:
          Date.parse("2026-07-30T08:00:00.000Z") -
          Date.parse("2026-07-21T09:00:00.000Z") -
          KEPT_IDLE_GAP_MS,
      },
    ]);
  });

  it("closes nothing when no stretch is longer than two days", () => {
    assert.deepEqual(
      findCorpusIdleGaps([
        span("2026-07-01T09:00:00.000Z", "2026-07-01T10:00:00.000Z"),
        span("2026-07-02T09:00:00.000Z", "2026-07-02T11:00:00.000Z"),
      ]),
      []
    );
  });
});
