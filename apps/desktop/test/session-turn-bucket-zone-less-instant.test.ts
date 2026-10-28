/**
 * @file session-turn-bucket-zone-less-instant.test.ts
 * @description ISS-8398 — how the legacy `$.messages` Agent arm READS a
 * timestamp, split out of session-turn-bucket-derive.test.ts.
 *
 * The split is not cosmetic. These cases pushed that file past the repo's
 * 1,000-line hard ceiling, and they are a cohesive unit on their own: every one
 * of them asks what instant `toLegacyAgentInstant` resolves a raw
 * `$.messages[].timestamp` to, and which spellings it refuses. Its sibling keeps
 * the FEA-3597 / ISS-5395 / ISS-8259 coverage of WHICH ROWS the derivation
 * counts.
 *
 * ISS-8259 rejected a ZONE-LESS instant because `Date.parse` reads a date-time
 * carrying no offset as HOST-LOCAL, which would have made desktop output depend
 * on the operator's `TZ`. That reasoning is right about `Date.parse`, and
 * rejection was not the only cure: naming the omitted zone as UTC removes the
 * host dependence outright, and UTC is what the cloud twin already reads the
 * same text as. ISS-8398 made that change; these cases are its contract.
 *
 * The OFFSET-bearing spelling is NOT covered here — it stays rejected, and its
 * case stays in the sibling file beside the ISS-8259 behavior it belongs to.
 */
// ISS-8398: pinned for the same reason the sibling file pins it — the agent `ts`
// is NORMALIZED through `toCanonicalIso`, so an unpinned zone would make these
// assertions pass on a UTC CI box and fail on a developer machine. The two cases
// that vary the zone do so through `underTimeZone`, which restores this value.
//
// The caller's zone is captured BEFORE the pin and restored in the unconditional
// `after` below, per AGENTS.md Test Practices. `underTimeZone` alone cannot do
// it: it restores whatever this module already overwrote, so without a
// suite-level hook a focused or composed run would hand the next file Chicago.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Chicago";

import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { deriveSessionTurnBuckets } from "../src/main/database/turn-buckets.js";
import {
  meta,
  NO_TOKEN_EVENTS,
  SYNCED_TOKEN_EVENTS,
  tokenRecord as ts,
} from "./session-turn-bucket-test-helpers.js";

afterAll(() => {
  if (ORIGINAL_TZ === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

/**
 * ISS-8398: run `fn` with `process.env.TZ` pinned to `tz`, restoring the
 * previous value — including its ABSENCE — afterwards.
 *
 * The restore is a `finally`, not a trailing line, because this file pins
 * `America/Chicago` at module scope for every OTHER case in it: a case that
 * threw midway while holding a different zone would hand that zone to every
 * later case in the same worker, and the report would be a file of unrelated
 * red rather than the one real failure.
 */
function underTimeZone<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
    } else {
      process.env.TZ = previous;
    }
  }
}

/** One no-round-trip session carrying a single assistant `$.messages` row. */
const legacyAgentMeta = (timestamp: unknown) =>
  meta({
    entrypoint: "cli",
    messages: [{ role: "assistant", timestamp }],
    tokenSeries: [],
  });

test("ISS-8398: a zone-less instant is read as UTC, identically under any host TZ", () => {
  // Host-TZ dependence is the WHOLE reason ISS-8259 rejected this spelling, so
  // the same fixture runs under two zones five hours apart and the rows must be
  // identical.
  //
  // Cross-zone equality ALONE would be VACUOUS: before this change the arm
  // returned [] in both zones, and [] deep-equals []. Measured on this worktree
  // before the fix, both zones gave []. So the rows are ALSO pinned against the
  // explicit UTC instant, and that assertion is the one that fails without the
  // change.
  const fixture = legacyAgentMeta("2026-06-03T23:30:00");
  const expected = [
    {
      sessionId: "zl",
      ts: "2026-06-03T23:30:00.000Z",
      turnKind: "agent",
      turnCount: 1,
    },
  ];
  const utc = underTimeZone("UTC", () =>
    deriveSessionTurnBuckets("zl", fixture, NO_TOKEN_EVENTS)
  );
  const chicago = underTimeZone("America/Chicago", () =>
    deriveSessionTurnBuckets("zl", fixture, NO_TOKEN_EVENTS)
  );
  assert.deepEqual(
    utc,
    expected,
    "a UTC host buckets the instant the text names"
  );
  assert.deepEqual(
    chicago,
    expected,
    "a UTC-5 host buckets the SAME instant, not 05:30 the next day"
  );
  assert.deepEqual(chicago, utc, "no residual host-TZ dependence");
});

test("ISS-8398: every zone-less spelling the grammar admits is read as UTC", () => {
  // `readZoneLessAsUtc` names the zone of anything matching
  // `YYYY-MM-DDT[digits, colons, dots]`, so the widening admits THREE spellings,
  // not just the exact-second one the day-boundary and TZ cases happen to use.
  // Each is pinned to its exact canonical instant, under the file's non-UTC TZ
  // pin, so a spelling that silently fell back to a host-local parse would be
  // visible as a five-hour shift rather than as an absent row.
  //
  // The independent SQL twin carries a seed for each of these three
  // (session-turn-bucket-equivalence.test.ts); a fourth, multi-digit fractional
  // form is admitted by production but deliberately outside the twin's GLOBs,
  // and is pinned HERE only — see that file's oracle comment for why.
  const spellings: [string, string][] = [
    ["2026-06-03T23:30:00", "2026-06-03T23:30:00.000Z"],
    ["2026-06-03T23:30", "2026-06-03T23:30:00.000Z"],
    ["2026-06-03T23:30:00.5", "2026-06-03T23:30:00.500Z"],
    ["2026-06-03T23:30:00.123", "2026-06-03T23:30:00.123Z"],
  ];
  for (const [raw, expected] of spellings) {
    const rows = deriveSessionTurnBuckets(
      "sp",
      legacyAgentMeta(raw),
      NO_TOKEN_EVENTS
    );
    assert.deepEqual(
      rows,
      [
        {
          sessionId: "sp",
          ts: expected,
          turnKind: "agent",
          turnCount: 1,
        },
      ],
      `${raw} must be read as UTC`
    );
  }
});

test("ISS-8398: a zone-less instant crossing a UTC day boundary keeps the UTC day", () => {
  // Europe/Berlin is UTC+2 in June, so a host-local read resolves this value to
  // 2026-06-03T22:30Z — the PREVIOUS day, a different heatmap cell and a
  // different autonomy-trend bar. Both the offset sign and the crossing
  // direction are opposite to the America/Chicago case above, so the two
  // together pin the reading rather than one arithmetic accident that happens
  // to cancel.
  const rows = underTimeZone("Europe/Berlin", () =>
    deriveSessionTurnBuckets(
      "dl",
      legacyAgentMeta("2026-06-04T00:30:00"),
      NO_TOKEN_EVENTS
    )
  );
  assert.deepEqual(rows, [
    {
      sessionId: "dl",
      ts: "2026-06-04T00:30:00.000Z",
      turnKind: "agent",
      turnCount: 1,
    },
  ]);
});

test("ISS-8398: the widening is the LEGACY arm's only — $.tokenSeries still rejects zone-less", () => {
  // The scope boundary, as one paired assertion. ISS-8398 widened the legacy
  // `$.messages` arm by supplying the missing zone BEFORE asking
  // `isUnambiguousInstant`; it did not widen that predicate. Widening the
  // predicate instead would pass this file's first half and silently move the
  // round-trip arm's population too — so the second half is what makes the
  // cheaper implementation fail.
  const zoneLess = "2026-06-03T23:30:00";
  const viaMessages = deriveSessionTurnBuckets(
    "sc",
    legacyAgentMeta(zoneLess),
    NO_TOKEN_EVENTS
  );
  assert.deepEqual(viaMessages, [
    {
      sessionId: "sc",
      ts: "2026-06-03T23:30:00.000Z",
      turnKind: "agent",
      turnCount: 1,
    },
  ]);
  const viaSeries = deriveSessionTurnBuckets(
    "sc",
    meta({ entrypoint: "cli", tokenSeries: [ts(zoneLess)] }),
    SYNCED_TOKEN_EVENTS
  );
  assert.deepEqual(
    viaSeries,
    [],
    "the round-trip arm is untouched by ISS-8398"
  );
});

test("ISS-8398: the widening stops at the zone-less spelling", () => {
  // The boundary of the change, one row per reason it is a boundary. Each of
  // these is a form the cloud's `pg_input_is_valid` would ACCEPT or a form that
  // merely looks close, so none of them is excluded by accident.
  const rejected: [string, string][] = [
    [
      "2026-06-03 23:30:00",
      "space separator: Postgres takes it, but it is outside the ECMA-262 Date Time String Format, so Date.parse is implementation-defined",
    ],
    [
      "2026-06-15T23:30:00+02:00",
      "offset-bearing: the cloud DISCARDS the offset and this side would convert it — one turn, two days. Reserved for a human ruling",
    ],
    ["2026-06-03T23:30:00z", "lowercase z is not the ISO designator"],
    [
      "2026-02-30T00:30:00",
      "a day that does not exist: Date.parse rolls it to March 2 while PostgreSQL refuses the row, so counting it puts a cell on a day the cloud has none for",
    ],
    [
      "2026-02-30T00:30:00.000Z",
      "the same roll-over on the Z spelling — the day check is the whole arm's, not just the newly-admitted spelling's",
    ],
    [
      "2026-02-29T10:00:00Z",
      "February 29 in a non-leap year — the check is a real calendar, not a digit-range test",
    ],
    [
      "0000-01-01T00:00:00",
      "year zero: JS represents it, but PostgreSQL's proleptic calendar has no year 0 — 1 BC is followed by 1 AD — so pg_input_is_valid refuses the row. Verified live against Postgres, which accepts 0001 and 0050",
    ],
    [
      "0000-06-03T23:30:00.000Z",
      "the same year-zero fork on the Z spelling — the calendar check is the whole arm's, not just the newly-admitted spelling's",
    ],
    ["", "empty string"],
    ["not-a-timestamp", "unparseable text"],
  ];
  for (const [raw, why] of rejected) {
    const rows = deriveSessionTurnBuckets(
      "bd",
      legacyAgentMeta(raw),
      NO_TOKEN_EVENTS
    );
    assert.deepEqual(
      rows.filter((r) => r.turnKind === "agent"),
      [],
      `${JSON.stringify(raw)} must contribute no agent cell — ${why}`
    );
  }
});

test("ISS-8398: the arm counts every instant PostgreSQL counts", () => {
  // Cloud parity is what this arm is FOR, so a guard that drops a form the cloud
  // COUNTS is an under-count fork, not caution — the exact defect class ISS-8259
  // and ISS-8398 exist to close.
  //
  // Both forms below pass PostgreSQL's `pg_input_is_valid(…, 'timestamp')` and
  // were counted here before ISS-8398. They are pinned because the obvious way
  // to write this arm's day check — a field-by-field calendar comparison like
  // `isRealCalendarInstant` — silently rejects BOTH: hour 24 normalizes to 0,
  // and `Date.UTC(1, …)` resolves year 1 to 1901. `namesARealCalendarDay` asks
  // about the calendar DATE only for exactly this reason, and these rows are
  // what would fail if it were ever widened back. Year 0050 also pins the
  // year-zero guard's edge from the other side: the sibling case above rejects
  // 0000 because Postgres has no year 0, and this one holds that guard to
  // rejecting 0 ALONE rather than the sub-100 years Postgres does accept.
  const accepted: [string, string][] = [
    ["2026-06-03T24:00:00Z", "2026-06-04T00:00:00.000Z"],
    ["0050-03-04T10:00:00Z", "0050-03-04T10:00:00.000Z"],
  ];
  for (const [raw, expected] of accepted) {
    const rows = deriveSessionTurnBuckets(
      "pg",
      legacyAgentMeta(raw),
      NO_TOKEN_EVENTS
    );
    assert.deepEqual(
      rows,
      [
        {
          sessionId: "pg",
          ts: expected,
          turnKind: "agent",
          turnCount: 1,
        },
      ],
      `${raw} is counted by the cloud and must be counted here`
    );
  }
});

test("ISS-8398: a zone-less and a Z spelling of ONE instant collapse to one row", () => {
  // The two spellings must land on the same aggregation key, not two rows that
  // happen to render adjacently. `add` keys on `${ts}\0${turnKind}`, so this
  // holds only because the zone-less value is canonicalized BEFORE it is added
  // — the property that would break if the arm ever added the raw text.
  const rows = deriveSessionTurnBuckets(
    "cl",
    meta({
      entrypoint: "cli",
      tokenSeries: [],
      messages: [
        { role: "assistant", timestamp: "2026-06-03T23:30:00" },
        { role: "assistant", timestamp: "2026-06-03T23:30:00.000Z" },
      ],
    }),
    NO_TOKEN_EVENTS
  );
  assert.deepEqual(rows, [
    {
      sessionId: "cl",
      ts: "2026-06-03T23:30:00.000Z",
      turnKind: "agent",
      turnCount: 2,
    },
  ]);
});
