/**
 * ISS-8767 — a corrupt `tools` `endMs` must not silently suppress every LATER
 * merged-trace idle marker.
 *
 * ISS-8720 made `mergedTraceItemEndMs` the ONE definition of where a pause
 * begins, which is what gave a bad extent reach beyond its own row:
 * `buildMergedTrace` carries it forward as the running `activeUntilMs` MAX, so
 * one far-future value drives every subsequent `gapMs` negative and no further
 * `idle` marker is synthesized for the rest of the trace. Behind
 * `session-trace-idle-rows` that is a row that simply is not there — a missing
 * value indistinguishable from "there was no pause".
 *
 * So the load-bearing assertion in every corrupt case below is the SECOND idle
 * marker, long after the bad item. A suite that only checked the corrupt row's
 * own gap would stay green on a fix that still suppressed everything downstream,
 * which is the actual harm.
 */
import { describe, expect, it } from "vitest";
import {
  iso,
  sayTurn,
  session,
  toolsTurn,
} from "./__tests__/merged-trace-fixtures";
import {
  buildMergedTrace,
  classifyTraceExtentRejection,
  MAX_TRACE_INSTANT_MS,
  mergedTraceItemEndMs,
  TraceExtentRejection,
  untrustworthyTraceExtents,
} from "./merged-trace";

/** A year-3000-ish instant: finite, representable, and past every later item. */
const FAR_FUTURE_MS = Date.parse("3000-01-01T00:00:00.000Z");

/**
 * One session whose FIRST item is a tool run carrying `endMs`, followed by two
 * pauses of five minutes each. Both pauses clear the 2-minute threshold, so a
 * trace that trusts the extent prints ZERO markers and a trace that refuses it
 * prints TWO.
 */
function traceWithCorruptFirstExtent(endMs: number) {
  return buildMergedTrace([
    session({
      sessionId: "a",
      startedAt: iso(0),
      turnItems: [
        toolsTurn({ atSeconds: 0, endMs }),
        sayTurn(300),
        sayTurn(600),
      ],
    }),
  ]);
}

describe("buildMergedTrace — a refused tool extent leaves later idle markers intact", () => {
  const impossible: { name: string; endMs: number }[] = [
    // The projection folds an unparseable source stamp to NaN, and the wire
    // contract only checks `endMs` is a number.
    { name: "NaN", endMs: Number.NaN },
    { name: "Infinity", endMs: Number.POSITIVE_INFINITY },
    // A NANOSECOND stamp handed over as milliseconds — the realistic shape of
    // a far-future extent, and past both the safe-integer ceiling and the Date
    // range. A MICROSECOND stamp is NOT covered: it lands around year 58,000,
    // which is representable, so refusing it would need a plausibility horizon
    // rather than an impossibility. That horizon is the product decision this
    // change deliberately leaves open (ISS-8767).
    { name: "a nanosecond stamp read as ms", endMs: Date.now() * 1_000_000 },
    {
      name: "one ms past the representable range",
      endMs: MAX_TRACE_INSTANT_MS + 1,
    },
    { name: "a fractional millisecond", endMs: 1.5 },
    { name: "a pre-epoch instant", endMs: -1 },
    // `Number("")` turns a blank stamp into a measured `0` rather than refusing
    // it, which reads as "ended at the epoch".
    { name: "a blank stamp folded to 0", endMs: Number("") },
    {
      name: "an extent ending before the run started",
      endMs: Date.parse(iso(0)) - 1000,
    },
  ];

  for (const { name, endMs } of impossible) {
    it(`synthesizes BOTH later markers when the first run carries ${name}`, () => {
      const idle = traceWithCorruptFirstExtent(endMs).filter(
        (item) => item.type === "idle"
      );
      // Two, not one: the second marker is the one a fix that merely sized the
      // corrupt row correctly would still lose.
      expect(idle).toHaveLength(2);
      expect(idle.map((item) => item.gapMs)).toEqual([300_000, 300_000]);
      // Refused, never clamped — the pause is measured from the run's own
      // start, so the marker cannot describe an interval it does not span.
      expect(idle[0]).toMatchObject({ t: iso(0) });
    });
  }

  it("still trusts a healthy extent, so the rejection path cannot fire on good data", () => {
    // The run really occupies its first four minutes, so the pause after it is
    // one minute — below the threshold — and only the SECOND pause is idle.
    const idle = traceWithCorruptFirstExtent(Date.parse(iso(240))).filter(
      (item) => item.type === "idle"
    );
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ gapMs: 300_000, t: iso(300) });
  });

  it("keeps a genuinely long run's suppression, which is not the defect", () => {
    // An extent that legitimately encloses both later items still suppresses
    // both markers. Refusing THIS would be the opposite lie.
    const idle = traceWithCorruptFirstExtent(Date.parse(iso(900))).filter(
      (item) => item.type === "idle"
    );
    expect(idle).toHaveLength(0);
  });

  it("does not crash on an absent extent from a version-skewed producer", () => {
    // The wire type says `number`, but an older Desktop build can omit the
    // field; the boundary sees `undefined` even though callers cannot type it.
    const idle = traceWithCorruptFirstExtent(
      undefined as unknown as number
    ).filter((item) => item.type === "idle");
    expect(idle).toHaveLength(2);
  });
});

describe("mergedTraceItemEndMs", () => {
  it("floors a refused extent to the item's own start rather than clamping it", () => {
    const startMs = Date.parse(iso(0));
    expect(
      mergedTraceItemEndMs(
        {
          type: "tools",
          sessionId: "a",
          t: iso(0),
          tMs: startMs,
          endMs: FAR_FUTURE_MS * 1000,
          summary: "1 tool",
          hasFail: false,
          failN: 0,
        },
        startMs
      )
    ).toBe(startMs);
  });
});

describe("classifyTraceExtentRejection", () => {
  const START_MS = Date.parse(iso(100));

  it.each([
    ["NaN", Number.NaN, TraceExtentRejection.NotFinite],
    ["Infinity", Number.POSITIVE_INFINITY, TraceExtentRejection.NotFinite],
    ["-Infinity", Number.NEGATIVE_INFINITY, TraceExtentRejection.NotFinite],
    ["a half millisecond", START_MS + 0.5, TraceExtentRejection.FractionalMs],
    ["a pre-epoch instant", -1, TraceExtentRejection.Negative],
    [
      "one ms past the representable range",
      MAX_TRACE_INSTANT_MS + 1,
      TraceExtentRejection.BeyondRepresentableInstant,
    ],
    [
      "MAX_SAFE_INTEGER",
      Number.MAX_SAFE_INTEGER,
      TraceExtentRejection.BeyondRepresentableInstant,
    ],
    ["a blank stamp folded to 0", 0, TraceExtentRejection.BeforeStart],
    ["one ms before the start", START_MS - 1, TraceExtentRejection.BeforeStart],
  ])("refuses %s as %s", (_label, endMs, reason) => {
    expect(classifyTraceExtentRejection(endMs as number, START_MS)).toBe(
      reason
    );
  });

  it.each([
    ["the exact start", START_MS],
    ["a later instant", START_MS + 1],
    [
      "a microsecond stamp read as ms — representable, so a horizon question",
      Date.now() * 1000,
    ],
    [
      "a finite far-future instant, which is a horizon question not an impossibility",
      FAR_FUTURE_MS,
    ],
    ["the last representable instant", MAX_TRACE_INSTANT_MS],
  ])("accepts %s", (_label, endMs) => {
    expect(classifyTraceExtentRejection(endMs, START_MS)).toBeNull();
  });

  it("reports the epoch floor rather than the pre-start fact for a pre-1970 run", () => {
    // `startMs` can itself be negative, so the two checks are not redundant.
    expect(classifyTraceExtentRejection(-5, -10)).toBe(
      TraceExtentRejection.Negative
    );
  });
});

describe("untrustworthyTraceExtents", () => {
  it("names each refused tools item and leaves healthy ones out", () => {
    const trace = buildMergedTrace([
      session({
        sessionId: "a",
        startedAt: iso(0),
        turnItems: [
          toolsTurn({ atSeconds: 0, endMs: Number.NaN }),
          toolsTurn({ atSeconds: 300, endMs: Date.parse(iso(360)) }),
          toolsTurn({ atSeconds: 600, endMs: Date.now() * 1_000_000 }),
          sayTurn(900),
        ],
      }),
    ]);
    expect(untrustworthyTraceExtents(trace)).toEqual([
      {
        sessionId: "a",
        t: iso(0),
        endMs: Number.NaN,
        reason: TraceExtentRejection.NotFinite,
      },
      {
        sessionId: "a",
        t: iso(600),
        endMs: expect.any(Number),
        reason: TraceExtentRejection.BeyondRepresentableInstant,
      },
    ]);
  });

  it("reports nothing for a trace whose extents are all trustworthy", () => {
    expect(
      untrustworthyTraceExtents(
        traceWithCorruptFirstExtent(Date.parse(iso(240)))
      )
    ).toEqual([]);
  });
});
