/**
 * @file activity-tiling-strip.test.ts
 * @description ISS-7265 — the server must be able to tell a session whose
 * activity tiling was DROPPED in transit from one that never had a tiling.
 *
 * Those two arrive as the same bytes without `activitySegmentRowsStripped`, so
 * every positive case here is paired with the negative it would otherwise be
 * indistinguishable from. The pairs fail independently: a patch that always
 * records `true` passes the first case in each pair and fails the second.
 */
import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({ log: logMock }));

const {
  ACTIVITY_TILING_STRIPPED_EVENT,
  activityTilingStrippedThrottle,
  countStrippedTilings,
  reportStrippedTilings,
  resolveActivityTilingStripPatch,
  shouldClearRecordedTilingStrip,
} = await import("./activity-tiling-strip");

const {
  EmissionRollupCause,
  FIXED_WINDOW_EMISSION_MAX_ENTRIES,
  FIXED_WINDOW_EMISSION_WINDOW_MS,
} = await import("@/lib/observability/fixed-window-emission-throttle");

const CONTEXT = {
  computeTargetId: "ct-1",
  organizationId: "org-1",
} as const;

function buildSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "sess-1",
    status: "active",
    harness: "claude",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  } as SyncedAgentSession;
}

function buildTilingRow() {
  return {
    phase: "coding",
    startMs: 0,
    endMs: 1000,
    confidence: 0.9,
    evidenceLayers: ["structural"],
    version: 7,
  };
}

describe("resolveActivityTilingStripPatch", () => {
  it("records the strip a payload declares", () => {
    expect(
      resolveActivityTilingStripPatch(
        buildSession({ activitySegmentRowsStripped: true })
      )
    ).toEqual({ activitySegmentRowsStripped: true });
  });

  it("leaves the column untouched for a payload that reports nothing", () => {
    // THE SIBLING. A session with no tiling, and an events-only chunk of a split
    // session, both arrive exactly like this. `{}` — not `{stripped: false}` —
    // because writing `false` here would let any later chunk of a stripped
    // session silently clear the strip its own first chunk recorded, and would
    // assert the negative on behalf of a desktop too old to have an opinion.
    expect(resolveActivityTilingStripPatch(buildSession())).toEqual({});
  });

  it("does not clear on a payload that merely CARRIES tiling rows", () => {
    // "Rows were on the wire" is not "rows were persisted": the persistence lane
    // rejects a sanity-invalid tiling, a stale classifier version, and an
    // append slice whose version does not match — and it runs AFTER this patch
    // has been committed by the detail upsert. Reading presence as arrival here
    // would reset a real strip on a payload whose tiling was thrown away. The
    // clear is `shouldClearRecordedTilingStrip`'s job, on the real outcome.
    expect(
      resolveActivityTilingStripPatch(
        buildSession({ activitySegmentRows: [buildTilingRow()] })
      )
    ).toEqual({});
  });

  it("keeps the declared strip when a payload contradicts itself", () => {
    // Our own producer cannot emit this — `sessionWithoutTiling` removes the
    // rows and stamps the flag in one step — but this is a wire boundary, so a
    // skewed or third-party producer can. The declaration wins: a client saying
    // it dropped the tiling is making a claim about its own payload, and
    // treating the rows as a refutation would silently downgrade a real report.
    expect(
      resolveActivityTilingStripPatch(
        buildSession({
          activitySegmentRows: [buildTilingRow()],
          activitySegmentRowsStripped: true,
        })
      )
    ).toEqual({ activitySegmentRowsStripped: true });
  });

  it("refuses a declared strip that arrives behind the watermark", () => {
    // A delayed retry of an older batch, or a stale chunk of an abandoned
    // sequence. Same guard `endsWithError` rides — arrival order must not decide
    // a session-level column.
    expect(
      resolveActivityTilingStripPatch(
        buildSession({ activitySegmentRowsStripped: true }),
        /* watermarkAllowsWrite */ false
      )
    ).toEqual({});
  });
});

describe("shouldClearRecordedTilingStrip", () => {
  it("clears a recorded strip once tiling rows were actually persisted", () => {
    expect(
      shouldClearRecordedTilingStrip({
        recordedStripped: true,
        activityTilingPersisted: true,
      })
    ).toBe(true);
  });

  it("does NOT clear when the slice persisted no tiling rows", () => {
    // THE SIBLING, and the whole point of routing the clear through the
    // persistence outcome: a payload whose tiling was rejected must leave the
    // recorded strip standing.
    expect(
      shouldClearRecordedTilingStrip({
        recordedStripped: true,
        activityTilingPersisted: false,
      })
    ).toBe(false);
  });

  it("writes nothing for a row that never recorded a strip", () => {
    // Keeps the clear a rare targeted write instead of a per-sync column
    // refresh — and a NULL row must stay NULL, not be downgraded to `false`.
    for (const recordedStripped of [false, null, undefined]) {
      expect(
        shouldClearRecordedTilingStrip({
          recordedStripped,
          activityTilingPersisted: true,
        })
      ).toBe(false);
    }
  });
});

describe("countStrippedTilings", () => {
  const stripped = buildSession({
    externalSessionId: "stripped",
    activitySegmentRowsStripped: true,
  });
  const clean = buildSession({ externalSessionId: "clean" });

  it("counts a stripped session the batch actually persisted", () => {
    expect(countStrippedTilings([stripped, clean], ["stripped", "clean"])).toBe(
      1
    );
  });

  it("ignores a stripped session the batch did NOT persist", () => {
    // THE SIBLING, and the discriminating one: a slice that failed will re-send
    // its tiling in full, so counting it would report a loss that has not
    // happened. Counting the payload instead of the persisted set reads 1 here.
    expect(countStrippedTilings([stripped, clean], ["clean"])).toBe(0);
  });

  it("counts nothing for a batch that persisted nothing", () => {
    expect(countStrippedTilings([stripped], [])).toBe(0);
  });

  it("ignores a NON-FINAL chunk of a stripped session", () => {
    // The desktop stamps the strip on every part of a fallback split and each
    // part commits, so a committed-only population reports one lost tiling once
    // per chunk. This case reads 1 without the final-delivery half.
    const nonFinal = buildSession({
      externalSessionId: "stripped",
      activitySegmentRowsStripped: true,
      chunk: { index: 0, total: 3 },
    });

    expect(countStrippedTilings([nonFinal], ["stripped"])).toBe(0);
  });

  it("counts the FINAL chunk of that same split", () => {
    // THE PAIRED POSITIVE: "never count a chunked session" would satisfy the
    // case above on its own, and a stripped session that also had to chunk is
    // the compound shape this ticket is about.
    const final = buildSession({
      externalSessionId: "stripped",
      activitySegmentRowsStripped: true,
      chunk: { index: 2, total: 3 },
    });

    expect(countStrippedTilings([final], ["stripped"])).toBe(1);
  });
});

describe("reportStrippedTilings", () => {
  beforeEach(() => {
    logMock.warn.mockClear();
    activityTilingStrippedThrottle.clear();
  });

  it("raises the monitored event for a batch that persisted a strip", () => {
    reportStrippedTilings(CONTEXT, 2);

    expect(logMock.warn).toHaveBeenCalledTimes(1);
    // `occurrences: 1` is new with the emission throttle (#5741): the rollup
    // below reports N on one event, so the live event has to state its own
    // weight or `sum(occurrences)` would undercount every un-suppressed batch.
    expect(logMock.warn).toHaveBeenCalledWith(ACTIVITY_TILING_STRIPPED_EVENT, {
      computeTargetId: "ct-1",
      organizationId: "org-1",
      strippedSessionCount: 2,
      occurrences: 1,
    });
  });

  it("stays silent for a batch that stripped nothing", () => {
    // THE SIBLING. Without it, dropping the guard would raise a warn-severity
    // event on every healthy batch in production and every other case here
    // would stay green.
    reportStrippedTilings(CONTEXT, 0);

    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("pins the event name the Datadog monitor keys on", () => {
    // The monitor lives in example-infrastructure and matches this literal, so a
    // rewording here silently un-monitors the signal.
    expect(ACTIVITY_TILING_STRIPPED_EVENT).toBe(
      "agent_session_activity_tiling_stripped"
    );
  });
});

/**
 * #5741 (Codex P1). One emission per BATCH is not a bound, because the batch is
 * the REQUEST: a session withheld from the ack echo by an unresolved
 * monitored-activity target is re-posted on every sync pass with its strip
 * column already durable, so an authenticated caller can mint one warn-severity
 * event per request indefinitely.
 *
 * Every case here is paired so the bound cannot be satisfied by silence: a
 * throttle that simply stopped emitting would pass the flood case and fail both
 * the fresh-key case and the rollup.
 */
describe("reportStrippedTilings emission throttle", () => {
  beforeEach(() => {
    logMock.warn.mockClear();
    activityTilingStrippedThrottle.clear();
  });

  it("emits ONCE per (org, target) window however many batches a caller drives", () => {
    for (let batch = 0; batch < 50; batch += 1) {
      reportStrippedTilings(CONTEXT, 1);
    }

    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it("still emits the first warning for a target that has not reported yet", () => {
    // THE SIBLING, and the one that stops the bound from becoming an outage: a
    // genuinely new (org, target) strip must never be the emission a flood on
    // some OTHER key ate. A throttle keyed too coarsely, or one that latches
    // after its first suppression, fails here and passes the case above.
    for (let batch = 0; batch < 50; batch += 1) {
      reportStrippedTilings(CONTEXT, 1);
    }
    logMock.warn.mockClear();

    reportStrippedTilings({ ...CONTEXT, computeTargetId: "ct-2" }, 3);

    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn).toHaveBeenCalledWith(ACTIVITY_TILING_STRIPPED_EVENT, {
      computeTargetId: "ct-2",
      organizationId: "org-1",
      strippedSessionCount: 3,
      occurrences: 1,
    });
  });

  it("flushes the batches a closed window suppressed as one aggregate rollup", () => {
    // Suppressed is not discarded: the volume still reaches the monitor as a
    // rollup, or throttling would hide the very amplification it is bounding.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
      for (let batch = 0; batch < 4; batch += 1) {
        reportStrippedTilings(CONTEXT, 1);
      }
      logMock.warn.mockClear();

      vi.setSystemTime(
        new Date(Date.now() + FIXED_WINDOW_EMISSION_WINDOW_MS + 1)
      );
      reportStrippedTilings(CONTEXT, 1);
    } finally {
      vi.useRealTimers();
    }

    expect(logMock.warn).toHaveBeenNthCalledWith(
      1,
      ACTIVITY_TILING_STRIPPED_EVENT,
      {
        computeTargetId: "ct-1",
        organizationId: "org-1",
        occurrences: 3,
        aggregated: true,
        flushedBy: EmissionRollupCause.Window,
      }
    );
    // The rollup carries no `strippedSessionCount`: the suppressed batches were
    // retries of the same stuck session as often as not, so a summed count would
    // report one lost tiling several times.
    expect(logMock.warn).toHaveBeenNthCalledWith(
      2,
      ACTIVITY_TILING_STRIPPED_EVENT,
      {
        computeTargetId: "ct-1",
        organizationId: "org-1",
        strippedSessionCount: 1,
        occurrences: 1,
      }
    );
  });

  it("bounds its own keyspace under a flood of distinct targets", () => {
    // The map that does the bounding is itself keyed on caller-reachable input,
    // so an unbounded one would trade a log leak for a memory leak (root
    // AGENTS.md). Overshoot the cap and assert the LRU evicted rather than grew.
    const overshoot = 50;
    for (let index = 0; index < FIXED_WINDOW_EMISSION_MAX_ENTRIES; index += 1) {
      reportStrippedTilings({ ...CONTEXT, computeTargetId: `ct-${index}` }, 1);
    }
    logMock.warn.mockClear();

    for (let index = 0; index < overshoot; index += 1) {
      reportStrippedTilings(
        { ...CONTEXT, computeTargetId: `late-${index}` },
        1
      );
    }

    expect(activityTilingStrippedThrottle.size).toBe(
      FIXED_WINDOW_EMISSION_MAX_ENTRIES
    );
    // Eviction must not cost the newcomers their first occurrence — the whole
    // point of the LRU order is that the keys dropped are the STALE ones.
    expect(logMock.warn).toHaveBeenCalledTimes(overshoot);
  });

  it("never lets a reporting failure escape to its caller", () => {
    // It runs from the batch's `finally`, where a throw would replace whatever
    // error the batch was already propagating.
    logMock.warn.mockImplementationOnce(() => {
      throw new Error("log sink down");
    });

    expect(() => reportStrippedTilings(CONTEXT, 1)).not.toThrow();
  });
});
