import type {
  AgentSessionDetail,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  agentSessionToSessionTableRow,
  resolveSessionRepoLabel,
} from "@repo/app/agents/lib/session-table-row";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_DURATION_ENDED_DETAIL } from "../../../lib/session-duration";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import {
  buildSessionDetailContent,
  computeSessionLocPerDollar,
  formatSessionLocPerDollar,
} from "../detail-content";
import { deriveCacheWriteTtlBreakdown } from "../session-cache-write-ttl";
import { EVENT_RATE_UNAVAILABLE } from "../session-detail-captions";
import { sessionOutputDiffDisplay } from "../session-output-diff-display";

function detailDurationLabel(session: AgentSessionDetail): string | null {
  const content = buildSessionDetailContent(session);
  const durationMetric = content.metrics.find(
    (metric) => metric.label === "Duration"
  );
  if (!durationMetric) {
    throw new Error("Duration metric missing from session detail content");
  }
  return durationMetric.value;
}

function overviewDurationLabel(session: AgentSessionDetail): string | null {
  return buildSessionDetailContent(session).overview.durationLabel;
}

/**
 * ISS-9964 / ISS-9980 (RULED 2026-09-11): the client-fallback LOC/$ numerator is
 * `mergedAuthoredPrLinesChanged` and nothing else, so the session's local
 * working-tree scalars and `branchDiffStats` are no longer terms of it and are
 * gone from this shape. They are not merely unused here — `computeSessionLocPerDollar`
 * does not accept them, so a case that seeded one would fail `tsc`.
 */
type LocPerDollarInput = Pick<
  AgentSessionDetail,
  | "locPerDollar"
  | "klocPerDollar"
  | "mergedAuthoredPrLinesChanged"
  | "authoredPrLinesChanged"
> & {
  estimatedCost: number;
};

function locPerDollarInput(
  overrides: Partial<LocPerDollarInput>
): LocPerDollarInput {
  return {
    estimatedCost: 0,
    ...overrides,
  };
}

function usageRow(
  overrides: Partial<SyncedAgentSessionTokenUsage>
): SyncedAgentSessionTokenUsage {
  return {
    model: "claude-opus-4-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

describe("session Duration parity: table === detail (FEA-4186 / ISS-5131)", () => {
  const NOW = new Date("2026-06-10T22:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("running session: every surface measures startedAt -> now", () => {
    const session = createAgentSessionDetailFixture({
      status: SESSION_STATUS.ACTIVE,
      startedAt: new Date("2026-06-10T12:00:00.000Z"),
      lastActivityAt: new Date("2026-06-10T13:00:00.000Z"),
      updatedAt: new Date("2026-06-10T13:00:00.000Z"),
      endedAt: null,
      wallClock: null,
    });

    const tableLabel = agentSessionToSessionTableRow(
      session,
      resolveSessionRepoLabel(session)
    ).durationLabel;

    expect(tableLabel).toBe("10h 0m");
    expect(detailDurationLabel(session)).toBe("10h 0m");
    expect(overviewDurationLabel(session)).toBe("10h 0m");
  });

  it("terminal session: every surface measures startedAt -> endedAt", () => {
    const session = createAgentSessionDetailFixture({
      status: SESSION_STATUS.INACTIVE,
      startedAt: new Date("2026-06-10T12:00:00.000Z"),
      lastActivityAt: new Date("2026-06-10T12:20:00.000Z"),
      endedAt: new Date("2026-06-10T12:30:00.000Z"),
      wallClock: null,
    });

    const tableLabel = agentSessionToSessionTableRow(
      session,
      resolveSessionRepoLabel(session)
    ).durationLabel;

    expect(tableLabel).toBe("30m 0s");
    expect(detailDurationLabel(session)).toBe("30m 0s");
    expect(overviewDurationLabel(session)).toBe("30m 0s");
  });

  it("ISS-5131: a terminal session's Duration ignores lastActivityAt, updatedAt AND wallClock", () => {
    // The reported session `019fb3e3`. Each of the three rejected inputs is set
    // to a DIFFERENT wrong answer here, so a regression to any one of them fails
    // with a distinguishable value rather than silently passing on another.
    const session = createAgentSessionDetailFixture({
      status: SESSION_STATUS.INACTIVE,
      startedAt: new Date("2026-07-28T14:58:31.028Z"),
      endedAt: new Date("2026-07-29T22:02:53.365Z"),
      lastActivityAt: new Date("2026-08-04T17:28:37.425Z"),
      updatedAt: new Date("2026-08-04T17:58:39.726Z"),
      wallClock: "170h 30m",
    });

    const tableLabel = agentSessionToSessionTableRow(
      session,
      resolveSessionRepoLabel(session)
    ).durationLabel;

    expect(tableLabel).toBe("31h 4m");
    expect(detailDurationLabel(session)).toBe("31h 4m");
    expect(overviewDurationLabel(session)).toBe("31h 4m");
    // The wallClock headline, and the ~170h span to either later timestamp.
    expect(tableLabel).not.toBe("170h 30m");
    expect(tableLabel).not.toBe("170h 19m");
  });

  it("ISS-5131: a terminal session with no end instant renders nothing on every surface", () => {
    // One instant is not a span, and a finished session must never be measured
    // against `now()` — that is the duration that grows forever.
    const session = createAgentSessionDetailFixture({
      status: SESSION_STATUS.INACTIVE,
      startedAt: new Date("2026-06-10T12:00:00.000Z"),
      lastActivityAt: new Date("2026-06-10T12:20:00.000Z"),
      endedAt: null,
      wallClock: null,
    });

    expect(
      agentSessionToSessionTableRow(session, resolveSessionRepoLabel(session))
        .durationLabel
    ).toBeNull();
    expect(detailDurationLabel(session)).toBeNull();
    expect(overviewDurationLabel(session)).toBeNull();
  });

  it("the two detail Duration surfaces share one caption", () => {
    const session = createAgentSessionDetailFixture({
      status: SESSION_STATUS.INACTIVE,
      startedAt: new Date("2026-06-10T12:00:00.000Z"),
      endedAt: new Date("2026-06-10T12:30:00.000Z"),
      wallClock: null,
    });

    const content = buildSessionDetailContent(session);
    const cardDetail = content.metrics.find(
      (metric) => metric.label === "Duration"
    )?.detail;

    expect(content.overview.durationDetail).toBe(SESSION_DURATION_ENDED_DETAIL);
    expect(cardDetail).toBe(content.overview.durationDetail);
  });

  it("ISS-4675: the Overview event RATE divides by the same span the Duration shows", () => {
    // 20 events over a displayed 5m is 4/min. A reader dividing the Events total
    // by the Duration on screen must land on the rate on screen.
    const session = createAgentSessionDetailFixture({
      status: SESSION_STATUS.INACTIVE,
      startedAt: new Date("2026-06-10T12:00:00.000Z"),
      endedAt: new Date("2026-06-10T12:05:00.000Z"),
      lastActivityAt: new Date("2026-06-10T12:20:00.000Z"),
      wallClock: "5m",
      events: buildRateEvents(20),
    });

    const content = buildSessionDetailContent(session);

    expect(content.overview.durationLabel).toBe("5m 0s");
    expect(content.overview.totalEvents).toBe(20);
    expect(content.overview.eventRateHint).toBe("4 events / min");
    // The 20m span to `lastActivityAt` would have produced this.
    expect(content.overview.eventRateHint).not.toBe("1 events / min");
  });

  it("ISS-4675: SAYS the rate is unavailable when the duration is unresolvable, rather than flooring to 1 minute or going silent", () => {
    // A malformed `startedAt` off the wire leaves the span unmeasured. Flooring
    // to 1 minute would render the whole event count as the rate ("20 events /
    // min") over a span nothing measured. Dropping the caption instead was the
    // other half of the problem: the Duration card beside it goes to its own
    // no-data slot on this same input, so two cards fell quiet at once with
    // nothing on screen explaining either.
    const session = createAgentSessionDetailFixture({
      status: SESSION_STATUS.INACTIVE,
      startedAt: new Date("not-a-date"),
      endedAt: new Date("2026-06-10T12:30:00.000Z"),
      wallClock: null,
      events: buildRateEvents(20),
    });

    const content = buildSessionDetailContent(session);

    expect(content.overview.totalEvents).toBe(20);
    expect(content.overview.eventRateHint).toBe(EVENT_RATE_UNAVAILABLE);
    expect(content.overview.eventRateHint).not.toContain("20 events");
    // The Duration card renders its OWN no-data slot rather than a hand-passed
    // em-dash string dressed up as a measured value.
    expect(content.overview.durationLabel).toBeNull();
  });

  it("ISS-4675: divides by FRACTIONAL minutes, so a sub-minute span reports the rate the reader can compute", () => {
    // 60 events over a DISPLAYED 30s is 120 events / min. The old 1-minute floor
    // reported 60 — a number that cannot be reconciled against the two values on
    // screen, which is the exact failure ISS-4675 exists to fix.
    const session = createAgentSessionDetailFixture({
      status: SESSION_STATUS.INACTIVE,
      startedAt: new Date("2026-06-10T12:00:00.000Z"),
      endedAt: new Date("2026-06-10T12:00:30.000Z"),
      wallClock: null,
      events: buildRateEvents(60),
    });

    const content = buildSessionDetailContent(session);

    expect(content.overview.durationLabel).toBe("30s");
    expect(content.overview.eventRateHint).toBe("120 events / min");
    // The floored denominator would have produced this.
    expect(content.overview.eventRateHint).not.toBe("60 events / min");
  });

  it("ISS-4675: reports NO rate for a zero-length span rather than fabricating one", () => {
    // Dividing by a zero span is not a large rate, it is an undefined one.
    const session = createAgentSessionDetailFixture({
      status: SESSION_STATUS.INACTIVE,
      startedAt: new Date("2026-06-10T12:00:00.000Z"),
      endedAt: new Date("2026-06-10T12:00:00.000Z"),
      wallClock: "0s",
      events: buildRateEvents(40),
    });

    const content = buildSessionDetailContent(session);

    expect(content.overview.durationLabel).toBeNull();
    expect(content.overview.eventRateHint).toBe(EVENT_RATE_UNAVAILABLE);
    expect(content.overview.eventRateHint).not.toContain("40 events");
  });
});

describe("deriveCacheWriteTtlBreakdown (FEA-3419)", () => {
  it("derives the 5m/1h split from the typed per-model token usage", () => {
    expect(
      deriveCacheWriteTtlBreakdown([
        usageRow({
          cacheWriteTokens: 1290,
          cacheWrite5mTokens: 1234,
          cacheWrite1hTokens: 56,
        }),
      ])
    ).toEqual({
      ephemeral5mInputTokens: 1234,
      ephemeral1hInputTokens: 56,
    });
  });

  it("sums the split across models in a mixed-model session", () => {
    expect(
      deriveCacheWriteTtlBreakdown([
        usageRow({
          model: "claude-opus-4-5",
          cacheWriteTokens: 200,
          cacheWrite5mTokens: 50,
          cacheWrite1hTokens: 150,
        }),
        usageRow({
          model: "claude-haiku-4",
          cacheWriteTokens: 400,
          cacheWrite5mTokens: 400,
          cacheWrite1hTokens: 0,
        }),
        // Absent-provenance model contributes nothing (its writes stay in the
        // unclassified residual), but does not hide the reported rows.
        usageRow({ model: "claude-sonnet-4", cacheWriteTokens: 90 }),
      ])
    ).toEqual({ ephemeral5mInputTokens: 450, ephemeral1hInputTokens: 150 });
  });

  it("returns null when the split is entirely zero (reported-zero hides the row)", () => {
    expect(
      deriveCacheWriteTtlBreakdown([
        usageRow({ cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }),
      ])
    ).toBeNull();
  });

  it("still surfaces the row when only one TTL bucket is non-zero", () => {
    expect(
      deriveCacheWriteTtlBreakdown([
        usageRow({
          cacheWriteTokens: 800,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 800,
        }),
      ])
    ).toEqual({ ephemeral5mInputTokens: 0, ephemeral1hInputTokens: 800 });
  });

  it("returns null when NO model reported a breakdown (absent provenance)", () => {
    // Legacy sessions / non-Claude harnesses: fields absent entirely.
    expect(
      deriveCacheWriteTtlBreakdown([usageRow({ cacheWriteTokens: 500 })])
    ).toBeNull();
    // Null members are the wire form of absent.
    expect(
      deriveCacheWriteTtlBreakdown([
        usageRow({
          cacheWriteTokens: 500,
          cacheWrite5mTokens: null,
          cacheWrite1hTokens: null,
        }),
      ])
    ).toBeNull();
    expect(deriveCacheWriteTtlBreakdown([])).toBeNull();
    expect(deriveCacheWriteTtlBreakdown(undefined)).toBeNull();
  });

  it("reads defensively against malformed wire values", () => {
    // Wrong-typed / negative / fractional values must not throw or leak bad
    // values — they coerce to safe non-negative integers.
    expect(
      deriveCacheWriteTtlBreakdown([
        usageRow({
          cacheWriteTokens: 100,
          cacheWrite5mTokens: 10.9,
          cacheWrite1hTokens: Number.NaN,
        }),
      ])
    ).toEqual({ ephemeral5mInputTokens: 10, ephemeral1hInputTokens: 0 });
    expect(
      deriveCacheWriteTtlBreakdown([
        usageRow({
          cacheWriteTokens: 100,
          cacheWrite5mTokens: -5,
          cacheWrite1hTokens: -7,
        }),
      ])
    ).toBeNull();
  });
});

describe("computeSessionLocPerDollar (FEA-3630)", () => {
  it("computes LOC/$ for a normal session (merged authored-PR lines / cost)", () => {
    // ISS-4667: 1000 merged lines / $2.00 = 500 LOC/$.
    expect(
      computeSessionLocPerDollar(
        locPerDollarInput({
          mergedAuthoredPrLinesChanged: 1000,
          estimatedCost: 2,
        })
      )
    ).toBeCloseTo(500, 10);
    // 5000 lines / $2.50 = 2000 LOC/$.
    expect(
      computeSessionLocPerDollar(
        locPerDollarInput({
          mergedAuthoredPrLinesChanged: 5000,
          estimatedCost: 2.5,
        })
      )
    ).toBeCloseTo(2000, 10);
  });

  it("returns null (never Infinity/NaN) for a $0 or negative cost session", () => {
    expect(
      computeSessionLocPerDollar(
        locPerDollarInput({
          mergedAuthoredPrLinesChanged: 1000,
          estimatedCost: 0,
        })
      )
    ).toBeNull();
    expect(
      computeSessionLocPerDollar(
        locPerDollarInput({
          mergedAuthoredPrLinesChanged: 1000,
          estimatedCost: -1,
        })
      )
    ).toBeNull();
  });

  // ISS-9980 (RULED 2026-09-11) moved the `null` OFF the numerator and ONTO the
  // denominator. This case previously expected `null` here; the expectation
  // changed because the RULING changed what a zero numerator MEANS, not because
  // the assertion was inconvenient. A session that merged nothing is a session
  // we measured: the honest answer to "lines delivered per dollar" is `0`, and
  // suppressing it to a placeholder hid a real and unflattering fact.
  it("divides a MEASURED zero merged population into a real 0, not a placeholder", () => {
    expect(
      computeSessionLocPerDollar(
        locPerDollarInput({ mergedAuthoredPrLinesChanged: 0, estimatedCost: 5 })
      )
    ).toBe(0);
  });

  // The other half of that ruling: a numerator nobody could resolve is NOT
  // KNOWABLE, and stays `null`. `0` would report a measurement no one took.
  it("returns null when the merged numerator is absent or explicitly null", () => {
    expect(
      computeSessionLocPerDollar(locPerDollarInput({ estimatedCost: 5 }))
    ).toBeNull();
    expect(
      computeSessionLocPerDollar(
        locPerDollarInput({
          mergedAuthoredPrLinesChanged: null,
          estimatedCost: 5,
        })
      )
    ).toBeNull();
  });

  /**
   * The cases above seed only the local-fallback numerator, so they never set
   * `locPerDollar` and never reach the branch PRODUCTION actually takes: the
   * server projects the field, so `session.locPerDollar !== undefined` and the
   * value is read through `resolveLocPerDollar`. The ruled measured-zero was
   * implemented on the producer alone and the resolver still rejected a `0`,
   * which collapsed it back to the not-available placeholder at every consumer
   * — beside a "Lines changed" row already rendering `0 in merged PRs`. These
   * cases pin the WIRE path so that gap cannot reopen.
   */
  it("passes a server-projected MEASURED zero through instead of collapsing it", () => {
    expect(
      computeSessionLocPerDollar(
        locPerDollarInput({ locPerDollar: 0, estimatedCost: 5 })
      )
    ).toBe(0);
  });

  it("keeps a server-projected null as the producer's honest unavailable", () => {
    expect(
      computeSessionLocPerDollar(
        locPerDollarInput({
          locPerDollar: null,
          mergedAuthoredPrLinesChanged: 1000,
          estimatedCost: 5,
        })
      )
    ).toBeNull();
  });

  // FEA-4250: the server now projects `locPerDollar`. When present it is
  // authoritative (computed against the reconciled cost) and returned verbatim —
  // NOT recomputed from the local lines/cost, which could disagree.
  it("prefers the server-projected locPerDollar over the local derivation", () => {
    expect(
      computeSessionLocPerDollar({
        ...locPerDollarInput({
          mergedAuthoredPrLinesChanged: 1000,
          estimatedCost: 2,
        }),
        // Local derivation would yield 500; the server value must win.
        locPerDollar: 0.42,
      })
    ).toBe(0.42);
  });

  // A server-provided null is the server's honest "unavailable" — preserved, not
  // laundered back into a local recompute that might produce a number.
  it("preserves a server-projected null locPerDollar", () => {
    expect(
      computeSessionLocPerDollar({
        ...locPerDollarInput({
          mergedAuthoredPrLinesChanged: 1000,
          estimatedCost: 2,
        }),
        locPerDollar: null,
      })
    ).toBeNull();
  });

  // Version skew: a producer that omits the field (undefined) falls back to the
  // local derivation so an older API still renders a value.
  it("falls back to the local derivation when the server omits locPerDollar", () => {
    expect(
      computeSessionLocPerDollar({
        ...locPerDollarInput({
          mergedAuthoredPrLinesChanged: 1000,
          estimatedCost: 2,
        }),
        locPerDollar: undefined,
      })
    ).toBeCloseTo(500, 10);
  });

  // ISS-4667 version skew: a producer that predates the unit fix omits
  // `locPerDollar` and sends the KLOC-unit `klocPerDollar`. That value must be
  // scaled into LOC/$, not rendered a thousand times too small, and it must not
  // be laundered into a local recompute.
  it("scales a version-skewed producer's legacy klocPerDollar into LOC/$", () => {
    expect(
      computeSessionLocPerDollar({
        ...locPerDollarInput({
          mergedAuthoredPrLinesChanged: 1000,
          estimatedCost: 2,
        }),
        locPerDollar: undefined,
        klocPerDollar: 0.5,
      })
    ).toBeCloseTo(500, 10);
  });

  it("preserves a version-skewed producer's explicit null klocPerDollar", () => {
    expect(
      computeSessionLocPerDollar({
        ...locPerDollarInput({
          mergedAuthoredPrLinesChanged: 1000,
          estimatedCost: 2,
        }),
        locPerDollar: undefined,
        klocPerDollar: null,
      })
    ).toBeNull();
  });
});

describe("formatSessionLocPerDollar (FEA-3630)", () => {
  it("formats a normal ratio with the shared adaptive precision", () => {
    expect(
      formatSessionLocPerDollar(
        locPerDollarInput({
          mergedAuthoredPrLinesChanged: 1000,
          estimatedCost: 2,
        })
      )
    ).toBe("500");
  });

  // ISS-4667, the reported session: 4,004 lines changed against $4,574.72 of
  // cost must read a real 0.88, not the 0.00 the KLOC unit floored it to. The
  // ISS-9964 numerator change re-seeds this on the merged key; the sub-cent
  // precision contract it pins is untouched and still live.
  it("keeps the reported 4,004-line / $4,574.72 session off 0.00", () => {
    const rendered = formatSessionLocPerDollar(
      locPerDollarInput({
        mergedAuthoredPrLinesChanged: 4004,
        estimatedCost: 4574.72,
      })
    );
    expect(rendered).toBe("0.88");
    expect(rendered).not.toBe("0.00");
  });

  // Both placeholder reasons, which ISS-9980 separated: NOT COMPUTABLE (no cost
  // to divide by) and NOT AVAILABLE (no resolvable merged numerator). Neither is
  // a measured zero — that case is the next one.
  it("renders the not-applicable placeholder for an unpriced or unknowable ratio", () => {
    expect(
      formatSessionLocPerDollar(
        locPerDollarInput({
          mergedAuthoredPrLinesChanged: 1000,
          estimatedCost: 0,
        })
      )
    ).toBe("—");
    expect(
      formatSessionLocPerDollar(locPerDollarInput({ estimatedCost: 5 }))
    ).toBe("—");
    expect(
      formatSessionLocPerDollar(
        locPerDollarInput({
          mergedAuthoredPrLinesChanged: null,
          estimatedCost: 5,
        })
      )
    ).toBe("—");
  });

  // ISS-9980: the rendered counterpart of the measured-zero ruling. A session
  // that merged nothing against real spend prints a number, not a dash — the
  // dash would let an unflattering fact read as missing data.
  it("renders a measured-zero merged population as a number, never the placeholder", () => {
    const rendered = formatSessionLocPerDollar(
      locPerDollarInput({ mergedAuthoredPrLinesChanged: 0, estimatedCost: 5 })
    );
    // `0.00` is the shared formatter's ordinary two-dp rendering of a real `0`,
    // and it is the honest answer here. It is NOT the ISS-4667 floor defect,
    // which was a NON-zero sub-cent ratio being crushed to the same string —
    // that contract is pinned by the 4,004-line case above.
    expect(rendered).toBe("0.00");
    expect(rendered).not.toBe("—");
  });
});

describe("computeSessionLocPerDollar merged-PR numerator (ISS-9964)", () => {
  it("derives the ratio from the merged authored-PR LOC in the client fallback", () => {
    const value = computeSessionLocPerDollar(
      locPerDollarInput({
        // ISS-6114: the CANONICAL key, and since ISS-9964 the ONLY one. Dropping
        // `mergedAuthoredPrLinesChanged` from the read in
        // `resolveSessionMergedAuthoredPrLoc` (@repo/api), which
        // `locPerDollarNumeratorLines` delegates to, reds this case.
        //
        // It does NOT guard the `Pick` type above: a key typo'd out of that
        // annotation is a `tsc` failure, not a test failure, because vitest does
        // not typecheck.
        mergedAuthoredPrLinesChanged: 8000,
        estimatedCost: 434.69,
        // No server-projected locPerDollar → local fallback path.
      })
    );
    // ISS-4667: 8000 LINES / 434.69, raw lines per dollar.
    expect(value).toBeCloseTo(8000 / 434.69, 12);
    expect(value ?? 0).toBeGreaterThan(0.01);
  });

  // EXPECTATION INVERTED by ISS-9980 (RULED 2026-09-11). This case previously
  // asserted that the deprecated `authoredPrLinesChanged` still answered the
  // numerator under version skew. It cannot: that field predates the merge gate
  // and counted OPEN PRs too, so a producer sending only it cannot answer "how
  // many lines did this session LAND". The honest answer is NOT KNOWABLE.
  //
  // The field itself is untouched — still accepted, still emitted, still on the
  // read contract (Compatibility Guardrail). It is no longer a NUMERATOR.
  it("treats a legacy-only producer as NOT KNOWABLE, not as a merged total", () => {
    expect(
      computeSessionLocPerDollar(
        locPerDollarInput({
          authoredPrLinesChanged: 8000,
          estimatedCost: 434.69,
        })
      )
    ).toBeNull();
  });

  it("still defers to a server-projected locPerDollar over the local numerator", () => {
    expect(
      computeSessionLocPerDollar({
        ...locPerDollarInput({
          mergedAuthoredPrLinesChanged: 8000,
          estimatedCost: 434.69,
        }),
        locPerDollar: 0.42,
      })
    ).toBe(0.42);
  });
});

// ISS-9964 / ISS-9980 (RULED 2026-09-11): the rendered "Lines changed" row and
// the LOC/$ numerator are now ONE derivation — this helper delegates to
// `locPerDollarNumeratorLines`. Before this change it independently
// re-implemented a largest-wins precedence over the working-tree diff, the
// branch diff, and the authored-PR roll-up, which is exactly how the row and the
// ratio beside it could disagree. The `working-tree`, `branch-diff`, and
// unmerged `authored-pr` result shapes are RETIRED, not re-homed: their
// populations are not code this session delivered. Per the Re-homing Guardrail,
// deleting the cases that pinned them is the complete and correct outcome.
describe("sessionOutputDiffDisplay (ISS-9964)", () => {
  it("reports the merged authored-PR total", () => {
    expect(
      sessionOutputDiffDisplay({ mergedAuthoredPrLinesChanged: 8000 })
    ).toEqual({ kind: "merged-pr", linesChanged: 8000 });
  });

  // The measured zero, on the row rather than the ratio. "0 lines changed" is a
  // fact about a session that merged nothing; it must not degrade to the
  // unavailable shape, which claims we could not look.
  it("reports a measured zero as a merged total of 0, not as unavailable", () => {
    expect(
      sessionOutputDiffDisplay({ mergedAuthoredPrLinesChanged: 0 })
    ).toEqual({ kind: "merged-pr", linesChanged: 0 });
  });

  it("is unavailable when no merged count was resolved", () => {
    expect(sessionOutputDiffDisplay({})).toEqual({ kind: "unavailable" });
    expect(
      sessionOutputDiffDisplay({ mergedAuthoredPrLinesChanged: null })
    ).toEqual({ kind: "unavailable" });
  });

  // Version skew, matching the ratio's ruling above: the deprecated key cannot
  // answer the merged question, so the row says so rather than printing a total
  // that includes open PRs.
  it("is unavailable when only the deprecated key answers", () => {
    expect(sessionOutputDiffDisplay({ authoredPrLinesChanged: 8000 })).toEqual({
      kind: "unavailable",
    });
  });
});

describe("session detail Cost metric honesty (ISS-4418)", () => {
  it("renders — for a zero-usage subscription session, not $0.00", () => {
    const session = createAgentSessionDetailFixture({
      billingMode: "pro",
      estimatedCost: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolUseCount: 0,
      model: null,
      tokenUsageByModel: [],
    });

    const costMetric = detailCostMetric(session);
    expect(costMetric.value).toBe("—");
    expect(costMetric.info).toBeUndefined();
  });

  it("renders — for a zero-usage unknown-billing session (unchanged)", () => {
    const session = createAgentSessionDetailFixture({
      billingMode: null,
      estimatedCost: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolUseCount: 0,
      model: null,
      tokenUsageByModel: [],
    });

    expect(detailCostMetric(session).value).toBe("—");
  });

  it("keeps the covered cost + subscription tooltip for a subscription session that did work", () => {
    const session = createAgentSessionDetailFixture({
      billingMode: "pro",
      estimatedCost: 0,
      inputTokens: 50_000,
      outputTokens: 10_000,
      model: "claude-opus-4",
    });

    const costMetric = detailCostMetric(session);
    expect(costMetric.value).toBe("$0.00");
    expect(costMetric.info?.what).toBe("Billed through your subscription");
  });
});

function detailCostMetric(session: AgentSessionDetail): {
  value: string;
  info?: { what: string };
} {
  const content = buildSessionDetailContent(session);
  const costMetric = content.metrics.find((metric) => metric.label === "Cost");
  if (!costMetric) {
    throw new Error("Cost metric missing from session detail content");
  }
  // #4291: `SessionSummaryMetric.value` is nullable now (an absent Duration
  // hands `MetricCard` a null so it renders its own no-data slot). Cost always
  // resolves to a string, so narrow here rather than widening this helper's
  // contract and weakening every assertion that reads `.value`.
  if (costMetric.value === null) {
    throw new Error("Cost metric value unexpectedly absent");
  }
  return { ...costMetric, value: costMetric.value };
}

/**
 * ISS-4675: `count` minimal session events, all inside the session window, used
 * to drive the Overview event-rate denominator. Only the event COUNT matters to
 * the rate, so these carry the minimum the projection reads.
 */
function buildRateEvents(count: number): AgentSessionDetail["events"] {
  return Array.from({ length: count }, (_unused, index) => ({
    externalEventId: `rate-event-${index}`,
    agentExternalId: "agent-main",
    eventType: "tool_use",
    summary: "Rate denominator fixture event.",
    createdAt: new Date(
      new Date("2026-06-10T12:00:00.000Z").getTime() + index * 1000
    ).toISOString(),
  }));
}
