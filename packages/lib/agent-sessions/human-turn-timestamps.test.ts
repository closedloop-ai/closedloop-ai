import { describe, expect, it } from "vitest";
import {
  collectHumanTurnUnits,
  deriveHumanTurnTimestamps,
  isForkReplayedMessage,
  isHumanTurnTimestamp,
  MAX_METADATA_HUMAN_TURN_TIMESTAMPS,
  toUtcHumanTurnTimestamp,
} from "./human-turn-timestamps";

const HUMAN = (timestamp: unknown) => ({ role: "human", timestamp });
const ISO = (i: number) =>
  `2026-06-15T${String(i % 24).padStart(2, "0")}:00:00.000Z`;

describe("isHumanTurnTimestamp (ISS-7896 grammar)", () => {
  it("admits the forms Postgres accepts that a desktop parser can emit", () => {
    for (const value of [
      "2026-06-15",
      "2026-06-15T10:00:00Z",
      "2026-06-15T10:00:00",
      "2026-06-15 10:00:00",
      "2026-06-15T10:00:00.1Z",
      "2026-06-15T10:00:00.123456789012Z",
      "2026-06-15T10:00:00+00",
      "2026-06-15T10:00:00-05:00",
      "2026-06-15T10:00:00+0530",
    ]) {
      expect(isHumanTurnTimestamp(value), value).toBe(true);
    }
  });

  it("rejects a date or time the calendar does not have", () => {
    // whitlockk #6116: the grammar bounds each field to two DIGITS, not to its
    // range. `2026-02-30T00:00:00.000Z` sails through it, and `Date.parse`
    // silently rolls it over to March 2 rather than refusing. Admitting one
    // makes the array non-empty and therefore AUTHORITATIVE, while the cloud's
    // `pg_input_is_valid` drops the entry — so a session whose human turns are
    // all spelled this way reports 0 instead of falling back to `$.messages`.
    for (const value of [
      "2026-02-30T00:00:00.000Z",
      "2026-06-31",
      "2026-13-01T00:00:00Z",
      "2026-00-10T00:00:00Z",
      "2026-06-00T00:00:00Z",
      "2026-06-15T25:00:00Z",
      "2026-06-15T10:99:00Z",
      "2026-06-15T10:00:99Z",
    ]) {
      expect(isHumanTurnTimestamp(value), value).toBe(false);
    }
  });

  it("rejects an offset no zone has, and keeps every real one (ISS-9864 D7)", () => {
    // `+99:99` passes the grammar's `\d{2}` runs. Before D7 it validated, and
    // `toUtcHumanTurnTimestamp` applied it by arithmetic — a confident instant
    // four days off, which the cloud key arm would then bucket. Postgres
    // refuses the spelling, so the validator must too: the whole key goes
    // absent and the session falls back to `$.messages`.
    for (const value of [
      "2026-06-15T23:30:00+99:99",
      "2026-06-15T23:30:00+16:00",
      "2026-06-15T23:30:00+15:60",
      "2026-06-15T23:30:00-1600",
      "2026-06-15T23:30:00+16",
    ]) {
      expect(isHumanTurnTimestamp(value), value).toBe(false);
    }
    for (const value of [
      "2026-06-15T23:30:00+15:59",
      "2026-06-15T23:30:00-15:59",
      "2026-06-15T23:30:00-05:00",
      "2026-06-15T23:30:00+0530",
      "2026-06-15T23:30:00+15",
      "2026-06-15T23:30:00+00",
      // A bare date's trailing digits are a DAY, never an offset.
      "2026-06-16",
      "2026-06-30",
    ]) {
      expect(isHumanTurnTimestamp(value), value).toBe(true);
    }
  });

  it("still admits a real leap day", () => {
    // The counterfactual for the check above: 2028 is a leap year, so rejecting
    // this would be the calendar guard overreaching.
    expect(isHumanTurnTimestamp("2028-02-29T00:00:00.000Z")).toBe(true);
    expect(isHumanTurnTimestamp("2026-02-29T00:00:00.000Z")).toBe(false);
  });

  it("rejects anything that could carry prose, a secret, or a number", () => {
    for (const value of [
      "2026-06-15T10:00:00Z then I said the quiet part",
      "20260615",
      "July 1, 2026",
      "1750000000000",
      1_750_000_000_000,
      "",
      " ",
      "sk_live_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
      null,
      undefined,
      { at: "2026-06-15" },
      ["2026-06-15"],
    ]) {
      expect(isHumanTurnTimestamp(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("collectHumanTurnUnits", () => {
  it("keeps only human turns, verbatim and in traversal order", () => {
    expect(
      collectHumanTurnUnits(
        [
          HUMAN(ISO(1)),
          { role: "assistant", timestamp: ISO(2) },
          HUMAN(ISO(0)),
          { role: "human" },
          HUMAN(null),
          "not an object",
          [HUMAN(ISO(9))],
        ],
        false
      )
    ).toEqual([ISO(1), ISO(0)]);
  });

  it("stringifies a numeric timestamp rather than dropping it", () => {
    // FEA-3597 froze this half byte-identical, so the unit list must still carry
    // a numeric turn. `deriveHumanTurnTimestamps` is what refuses to SHIP it.
    expect(collectHumanTurnUnits([HUMAN(1_750_000_000_000)], false)).toEqual([
      "1750000000000",
    ]);
  });

  it("yields nothing for a headless session or a non-array", () => {
    expect(collectHumanTurnUnits([HUMAN(ISO(1))], true)).toEqual([]);
    expect(collectHumanTurnUnits("nope", false)).toEqual([]);
    expect(collectHumanTurnUnits(undefined, false)).toEqual([]);
  });

  it("skips a fork-replayed turn, which belongs to the parent session", () => {
    // ISS-8659. A Claude `/fork` child KEEPS the parent's messages so the
    // inherited conversation still renders, so this list is the one place that
    // has to tell them apart: bucketing them credits the child with the
    // parent's turns, at the parent's timestamps, on the parent's days.
    expect(
      collectHumanTurnUnits(
        [
          { ...HUMAN(ISO(1)), isForkReplayed: true },
          { ...HUMAN(ISO(2)), isForkReplayed: true },
          HUMAN(ISO(3)),
        ],
        false
      )
    ).toEqual([ISO(3)]);
  });

  it("only skips on a literal true, so an absent or falsy flag still counts", () => {
    // The flag is omitted entirely when false, and every pre-ISS-8659 message
    // blob lacks it. Treating anything truthy-ish as replayed would silently
    // drop real turns from every session recorded before the field existed.
    expect(
      collectHumanTurnUnits(
        [
          HUMAN(ISO(1)),
          { ...HUMAN(ISO(2)), isForkReplayed: false },
          { ...HUMAN(ISO(3)), isForkReplayed: "true" },
        ],
        false
      )
    ).toEqual([ISO(1), ISO(2), ISO(3)]);
  });
});

describe("deriveHumanTurnTimestamps (whole-or-absent)", () => {
  it("carries every human turn past the 100-message compaction cap", () => {
    const messages = Array.from({ length: 250 }, (_, i) => HUMAN(ISO(i)));
    expect(deriveHumanTurnTimestamps({ messages })).toHaveLength(250);
  });

  it("returns null when ONE unit is outside the grammar", () => {
    // The load-bearing case. A partial array would be read as authoritative and
    // would report fewer turns than the `$.messages` fallback it displaces.
    expect(
      deriveHumanTurnTimestamps({
        messages: [HUMAN(ISO(1)), HUMAN("20260615"), HUMAN(ISO(2))],
      })
    ).toBeNull();
    expect(
      deriveHumanTurnTimestamps({ messages: [HUMAN(1_750_000_000_000)] })
    ).toBeNull();
  });

  it("returns null past the entry cap rather than a truncated head", () => {
    const messages = Array.from(
      { length: MAX_METADATA_HUMAN_TURN_TIMESTAMPS + 1 },
      (_, i) => HUMAN(ISO(i))
    );
    expect(deriveHumanTurnTimestamps({ messages })).toBeNull();
    expect(
      deriveHumanTurnTimestamps({
        messages: messages.slice(0, MAX_METADATA_HUMAN_TURN_TIMESTAMPS),
      })
    ).toHaveLength(MAX_METADATA_HUMAN_TURN_TIMESTAMPS);
  });

  it("returns an EMPTY array for a headless session, not null", () => {
    // Distinct states with DIFFERENT cloud readings: `[]` says "zero human
    // turns" and the cloud takes it as authoritative (matching the desktop,
    // which derives no human rows here either); `null` says "cannot be carried"
    // and drops the cloud to the `$.messages` fallback.
    for (const headless of [
      { entrypoint: "sdk-python" },
      { entrypoint: "codex exec" },
      { permissionMode: "bypassPermissions" },
    ]) {
      expect(
        deriveHumanTurnTimestamps({ ...headless, messages: [HUMAN(ISO(1))] }),
        JSON.stringify(headless)
      ).toEqual([]);
    }
  });

  it("returns null for a non-object and [] for a session with no messages", () => {
    expect(deriveHumanTurnTimestamps(null)).toBeNull();
    expect(deriveHumanTurnTimestamps("nope")).toBeNull();
    expect(deriveHumanTurnTimestamps({})).toEqual([]);
    expect(deriveHumanTurnTimestamps({ messages: "malformed" })).toEqual([]);
  });

  it("ships an offset-bearing turn in UTC, so both readers bucket the same day", () => {
    // The divergence this normalization exists to close: PostgreSQL's
    // `::timestamp` cast DISCARDS the offset (bucketing the 15th) while the
    // desktop's SQLite `strftime` converts it (bucketing the 16th). Emitting
    // UTC is what makes the two surfaces agree.
    expect(
      deriveHumanTurnTimestamps({
        messages: [HUMAN("2026-06-15T23:30:00-05:00")],
      })
    ).toEqual(["2026-06-16T04:30:00.000Z"]);
  });

  it("returns null when an offset-bearing unit names no real instant", () => {
    // Grammar-valid (`\d{2}` accepts 99) but not a date. Whole-or-absent: the
    // key is suppressed rather than carrying a hole.
    expect(
      deriveHumanTurnTimestamps({
        messages: [HUMAN(ISO(1)), HUMAN("2026-99-99T10:00:00+02:00")],
      })
    ).toBeNull();
    // ISS-9864 D7: an impossible OFFSET reaches the same absence instead of a
    // normalized instant four days off.
    expect(
      deriveHumanTurnTimestamps({
        messages: [HUMAN(ISO(1)), HUMAN("2026-06-15T23:30:00+99:99")],
      })
    ).toBeNull();
  });
});

describe("toUtcHumanTurnTimestamp", () => {
  it("normalizes every offset spelling the grammar admits", () => {
    for (const [value, expected] of [
      ["2026-06-15T10:00:00-05:00", "2026-06-15T15:00:00.000Z"],
      ["2026-06-15T10:00:00+05:30", "2026-06-15T04:30:00.000Z"],
      ["2026-06-15T10:00:00+0530", "2026-06-15T04:30:00.000Z"],
      ["2026-06-15T10:00:00+05", "2026-06-15T05:00:00.000Z"],
      ["2026-06-15 10:00:00-05:00", "2026-06-15T15:00:00.000Z"],
      ["2026-06-15T10:00-05:00", "2026-06-15T15:00:00.000Z"],
      ["2026-06-15T10:00:00.123456-05:00", "2026-06-15T15:00:00.123Z"],
    ] as const) {
      expect(toUtcHumanTurnTimestamp(value), value).toBe(expected);
    }
  });

  it("returns a zone-less or Z-suffixed unit VERBATIM", () => {
    // Both readers already agree on these (each reads a zone-less date-time as
    // UTC), so rewriting them would churn the derived golden sync fixtures for
    // no behavior change.
    for (const value of [
      "2026-06-15",
      "2026-06-15T10:00:00Z",
      "2026-06-15T10:00:00",
      "2026-06-15 10:00:00",
      "2026-06-15T10:00:00.123456789012Z",
    ]) {
      expect(toUtcHumanTurnTimestamp(value), value).toBe(value);
    }
  });

  it("never misreads a bare date's trailing digits as an offset", () => {
    // `-15` closes `2026-06-15`; an offset regex without a required time part
    // would read it as a -15:00 zone and shift the day.
    expect(toUtcHumanTurnTimestamp("2026-06-15")).toBe("2026-06-15");
  });

  it("returns null for an offset-bearing value naming no real instant", () => {
    expect(toUtcHumanTurnTimestamp("2026-99-99T10:00:00+02:00")).toBeNull();
  });

  it("emits a form the grammar still admits", () => {
    const normalized = toUtcHumanTurnTimestamp("2026-06-15T10:00:00+0530");
    expect(isHumanTurnTimestamp(normalized)).toBe(true);
  });
});

describe("ISS-8659: isForkReplayedMessage", () => {
  it("is true only for the explicit flag, so an older message still counts", () => {
    // Strict `=== true` is the contract, not an implementation detail: the flag
    // is written only when true, so every message predating it -- and every
    // non-Claude producer's -- must remain countable. A truthy-ish test here
    // would silently drop a legitimate turn.
    expect(isForkReplayedMessage({ role: "human", isForkReplayed: true })).toBe(
      true
    );
    expect(isForkReplayedMessage({ role: "human" })).toBe(false);
    expect(
      isForkReplayedMessage({ role: "human", isForkReplayed: false })
    ).toBe(false);
    expect(
      isForkReplayedMessage({ role: "human", isForkReplayed: "true" })
    ).toBe(false);
  });

  it("refuses a non-object without throwing", () => {
    // It is fed raw `$.messages` elements straight out of persisted JSON, which
    // is a trust boundary: the array can hold anything.
    for (const value of [null, undefined, 7, "human", ["human"]]) {
      expect(isForkReplayedMessage(value)).toBe(false);
    }
  });
});
