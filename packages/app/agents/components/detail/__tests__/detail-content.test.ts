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
  deriveCacheWriteTtlBreakdown,
  EVENT_RATE_UNAVAILABLE,
  extractCodexRuntimeMetadata,
  formatSessionLocPerDollar,
  sessionOutputDiffDisplay,
} from "../detail-content";

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

type KlocInput = Pick<
  AgentSessionDetail,
  "linesAdded" | "linesRemoved" | "authoredPrLinesChanged" | "branchDiffStats"
> & {
  estimatedCost: number;
};

type SessionMetadata = AgentSessionDetail["metadata"];

function klocInput(overrides: Partial<KlocInput>): KlocInput {
  return {
    linesAdded: 0,
    linesRemoved: 0,
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
  it("computes LOC/$ for a normal session ((added+removed) / cost, no divide-by-1000)", () => {
    // ISS-4667: 800 + 200 = 1000 lines / $2.00 = 500 LOC/$.
    expect(
      computeSessionLocPerDollar(
        klocInput({ linesAdded: 800, linesRemoved: 200, estimatedCost: 2 })
      )
    ).toBeCloseTo(500, 10);
    // 5000 lines / $2.50 = 2000 LOC/$.
    expect(
      computeSessionLocPerDollar(
        klocInput({ linesAdded: 3000, linesRemoved: 2000, estimatedCost: 2.5 })
      )
    ).toBeCloseTo(2000, 10);
  });

  it("returns null (never Infinity/NaN) for a $0 or negative cost session", () => {
    expect(
      computeSessionLocPerDollar(
        klocInput({ linesAdded: 500, linesRemoved: 500, estimatedCost: 0 })
      )
    ).toBeNull();
    expect(
      computeSessionLocPerDollar(
        klocInput({ linesAdded: 500, linesRemoved: 500, estimatedCost: -1 })
      )
    ).toBeNull();
  });

  it("returns null when no lines were delivered (0 lines)", () => {
    expect(
      computeSessionLocPerDollar(
        klocInput({ linesAdded: 0, linesRemoved: 0, estimatedCost: 5 })
      )
    ).toBeNull();
  });

  it("treats missing/null line counts as zero (unpriced-lines session), not NaN", () => {
    expect(
      computeSessionLocPerDollar(
        klocInput({ linesAdded: null, linesRemoved: null, estimatedCost: 5 })
      )
    ).toBeNull();
  });

  // FEA-4250: the server now projects `locPerDollar`. When present it is
  // authoritative (computed against the reconciled cost) and returned verbatim —
  // NOT recomputed from the local lines/cost, which could disagree.
  it("prefers the server-projected locPerDollar over the local derivation", () => {
    expect(
      computeSessionLocPerDollar({
        ...klocInput({ linesAdded: 800, linesRemoved: 200, estimatedCost: 2 }),
        // Local derivation would yield 0.5; the server value must win.
        locPerDollar: 0.42,
      })
    ).toBe(0.42);
  });

  // A server-provided null is the server's honest "unavailable" — preserved, not
  // laundered back into a local recompute that might produce a number.
  it("preserves a server-projected null locPerDollar", () => {
    expect(
      computeSessionLocPerDollar({
        ...klocInput({ linesAdded: 800, linesRemoved: 200, estimatedCost: 2 }),
        locPerDollar: null,
      })
    ).toBeNull();
  });

  // Version skew: a producer that omits the field (undefined) falls back to the
  // local derivation so an older API still renders a value.
  it("falls back to the local derivation when the server omits locPerDollar", () => {
    expect(
      computeSessionLocPerDollar({
        ...klocInput({ linesAdded: 800, linesRemoved: 200, estimatedCost: 2 }),
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
        ...klocInput({ linesAdded: 800, linesRemoved: 200, estimatedCost: 2 }),
        locPerDollar: undefined,
        klocPerDollar: 0.5,
      })
    ).toBeCloseTo(500, 10);
  });

  it("preserves a version-skewed producer's explicit null klocPerDollar", () => {
    expect(
      computeSessionLocPerDollar({
        ...klocInput({ linesAdded: 800, linesRemoved: 200, estimatedCost: 2 }),
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
        klocInput({ linesAdded: 800, linesRemoved: 200, estimatedCost: 2 })
      )
    ).toBe("500");
  });

  // ISS-4667, the reported session: 4,004 lines changed against $4,574.72 of
  // cost must read a real 0.88, not the 0.00 the KLOC unit floored it to.
  it("keeps the reported 4,004-line / $4,574.72 session off 0.00", () => {
    const rendered = formatSessionLocPerDollar(
      klocInput({
        linesAdded: 3315,
        linesRemoved: 689,
        estimatedCost: 4574.72,
      })
    );
    expect(rendered).toBe("0.88");
    expect(rendered).not.toBe("0.00");
  });

  it("renders the not-applicable placeholder for the $0 / 0-line / unpriced edge cases", () => {
    expect(
      formatSessionLocPerDollar(
        klocInput({ linesAdded: 500, linesRemoved: 500, estimatedCost: 0 })
      )
    ).toBe("—");
    expect(
      formatSessionLocPerDollar(
        klocInput({ linesAdded: 0, linesRemoved: 0, estimatedCost: 5 })
      )
    ).toBe("—");
    expect(
      formatSessionLocPerDollar(
        klocInput({ linesAdded: null, linesRemoved: null, estimatedCost: 5 })
      )
    ).toBe("—");
  });
});

describe("computeSessionLocPerDollar authored-PR roll-up (FEA-4378)", () => {
  // The reported case: a tiny local working-tree diff (136 lines) alongside a
  // large authored-PR LOC sum. The client fallback (server omits locPerDollar)
  // must use max(localDiff, authoredPrLinesChanged) so LOC/$ is not ~0.
  it("prefers the authored-PR LOC over a tiny local diff in the client fallback", () => {
    const value = computeSessionLocPerDollar(
      klocInput({
        linesAdded: 134,
        linesRemoved: 2,
        authoredPrLinesChanged: 8000,
        estimatedCost: 434.69,
        // No server-projected locPerDollar → local fallback path.
      })
    );
    // ISS-4667: 8000 LINES / 434.69, NOT the 0.31 the 136-line diff would yield.
    expect(value).toBeCloseTo(8000 / 434.69, 12);
    expect(value ?? 0).toBeGreaterThan(0.01);
  });

  it("keeps the local diff when it exceeds the authored-PR LOC", () => {
    const value = computeSessionLocPerDollar(
      klocInput({
        linesAdded: 9000,
        linesRemoved: 1000,
        authoredPrLinesChanged: 400,
        estimatedCost: 100,
      })
    );
    // max(10000, 400) = 10000 lines / $100 = 100 LOC/$.
    expect(value).toBeCloseTo(100, 10);
  });

  it("still defers to a server-projected locPerDollar over the roll-up", () => {
    expect(
      computeSessionLocPerDollar({
        ...klocInput({
          linesAdded: 134,
          linesRemoved: 2,
          authoredPrLinesChanged: 8000,
          estimatedCost: 434.69,
        }),
        locPerDollar: 0.42,
      })
    ).toBe(0.42);
  });

  // ISS-4448 (codex P1): the LOC/$ numerator must weigh the branch-level diff too,
  // matching the "Lines changed" row. A merged 88-PR session with a 4,004-line
  // branch diff (3315 + 689) but a tiny 56-line working-tree residual and no
  // authored-PR LOC previously computed the ratio off the 56 lines while the row
  // read "4,004 lines changed" — the two disagreed. Now both use 4,004.
  it("uses the branch diff in the LOC/$ numerator when it is the largest signal", () => {
    const value = computeSessionLocPerDollar(
      klocInput({
        linesAdded: 51,
        linesRemoved: 5,
        authoredPrLinesChanged: 0,
        branchDiffStats: {
          linesAdded: 3315,
          linesRemoved: 689,
          filesChanged: 42,
          source: "git",
        },
        estimatedCost: 100,
      })
    );
    // ISS-4667: 4004 LINES / $100 = 40.04 — NOT the 0.56 the residual gives.
    expect(value).toBeCloseTo(4004 / 100, 10);
  });
});

describe("sessionOutputDiffDisplay (FEA-4378)", () => {
  // The pills-row LOC must surface the authored-PR delivered code — NOT the bare
  // session working-tree diff — when the roll-up exceeds the local diff, so the
  // number adjacent to the PR pills is not misread as "LOC for those PRs".
  it("returns the authored-PR total when it exceeds the local diff", () => {
    expect(
      sessionOutputDiffDisplay({
        linesAdded: 134,
        linesRemoved: 2,
        authoredPrLinesChanged: 8000,
      })
    ).toEqual({ kind: "authored-pr", linesChanged: 8000 });
  });

  it("returns the working-tree diff when no larger authored-PR roll-up exists", () => {
    expect(
      sessionOutputDiffDisplay({
        linesAdded: 200,
        linesRemoved: 40,
        authoredPrLinesChanged: 0,
      })
    ).toEqual({ kind: "working-tree", linesAdded: 200, linesRemoved: 40 });
  });

  // Version skew / desktop-local: authoredPrLinesChanged omitted → working-tree
  // shape from the local diff (never NaN, never the authored-pr shape).
  it("falls back to the working-tree diff when authoredPrLinesChanged is absent", () => {
    expect(
      sessionOutputDiffDisplay({
        linesAdded: 50,
        linesRemoved: 10,
        authoredPrLinesChanged: undefined,
      })
    ).toEqual({ kind: "working-tree", linesAdded: 50, linesRemoved: 10 });
  });

  // ISS-4448: the branch-level diff wins when it is materially larger than both
  // the local residual and the authored-PR roll-up — the 88-merged-PR case that
  // otherwise collapses to the tiny working-tree residual.
  it("returns the branch diff when it is the largest real signal (ISS-4448)", () => {
    expect(
      sessionOutputDiffDisplay({
        linesAdded: 51,
        linesRemoved: 5,
        authoredPrLinesChanged: 0,
        branchDiffStats: {
          linesAdded: 3315,
          linesRemoved: 689,
          filesChanged: 42,
          source: "git",
        },
      })
    ).toEqual({ kind: "branch-diff", linesAdded: 3315, linesRemoved: 689 });
  });
});

function codexMetadata(overrides: Record<string, unknown>): SessionMetadata {
  return { branch: "fea-3703", ...overrides } as SessionMetadata;
}

function tokenSnapshot(usage: unknown): unknown {
  return {
    timestamp: "2026-07-22T00:00:00.000Z",
    model: "gpt-5",
    lastTokenUsage: usage,
  };
}

describe("extractCodexRuntimeMetadata (FEA-3703)", () => {
  it("returns null for non-Codex sessions (no signal present)", () => {
    expect(extractCodexRuntimeMetadata(null)).toBeNull();
    expect(extractCodexRuntimeMetadata(codexMetadata({}))).toBeNull();
  });

  it("surfaces a fully populated snapshot (context window, latest usage, both rate-limit windows) with utilization", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({
        modelContextWindow: 200_000,
        codexLastTokenUsage: [
          tokenSnapshot({
            input: 40_000,
            output: 8000,
            cacheRead: 10_000,
            cacheWrite: 2000,
          }),
        ],
        codexRateLimits: {
          // resets_at values are absolute Unix epoch-seconds, matching the raw
          // Codex payload shape (see golden-sessions fixtures).
          primary: {
            used_percent: 42.6,
            window_minutes: 300,
            resets_at: 1_780_960_632,
          },
          secondary: {
            used_percent: 5,
            window_minutes: 10_080,
            resets_at: 1_782_423_905,
          },
        },
      })
    );
    expect(result).not.toBeNull();
    expect(result?.modelContextWindow).toBe(200_000);
    expect(result?.latestTokenUsage).toEqual({
      input: 40_000,
      output: 8000,
      cacheRead: 10_000,
      cacheWrite: 2000,
      total: 60_000,
    });
    // 60000 / 200000 = 30%
    expect(result?.contextWindowUtilizationPercent).toBeCloseTo(30);
    expect(result?.rateLimits?.primary).toEqual({
      usedPercent: 42.6,
      windowMinutes: 300,
      // resets_at is passed through verbatim as an absolute epoch-seconds value.
      resetsAtEpochSeconds: 1_780_960_632,
    });
    expect(result?.rateLimits?.secondary?.usedPercent).toBe(5);
  });

  it("preserves the PARTIAL case: only a context window, no usage, no rate limits", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({ modelContextWindow: 128_000 })
    );
    expect(result).toEqual({
      modelContextWindow: 128_000,
      latestTokenUsage: null,
      // utilization is undefined without a latest snapshot
      contextWindowUtilizationPercent: null,
      rateLimits: null,
    });
  });

  it("preserves the PARTIAL case: only rate limits (one window), no context window / usage", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({
        codexRateLimits: {
          primary: { used_percent: 90, window_minutes: null, resets_at: null },
          secondary: null,
        },
      })
    );
    expect(result?.modelContextWindow).toBeNull();
    expect(result?.latestTokenUsage).toBeNull();
    expect(result?.contextWindowUtilizationPercent).toBeNull();
    expect(result?.rateLimits?.primary).toEqual({
      usedPercent: 90,
      windowMinutes: null,
      resetsAtEpochSeconds: null,
    });
    expect(result?.rateLimits?.secondary).toBeNull();
  });

  it("returns null for the RESET snapshot: rate_limits present but every window null", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({ codexRateLimits: { primary: null, secondary: null } })
    );
    expect(result).toBeNull();
  });

  it("reads defensively against a MALFORMED synced blob (no throw, no bad values)", () => {
    // wrong-typed context window + non-array usage + non-object rate limits
    expect(
      extractCodexRuntimeMetadata(
        codexMetadata({
          modelContextWindow: "200000",
          codexLastTokenUsage: "nope",
          codexRateLimits: 42,
        })
      )
    ).toBeNull();
    // negative context window is dropped
    expect(
      extractCodexRuntimeMetadata(codexMetadata({ modelContextWindow: -5 }))
    ).toBeNull();
    // malformed used_percent is clamped/dropped, not leaked
    const clamped = extractCodexRuntimeMetadata(
      codexMetadata({
        codexRateLimits: {
          primary: { used_percent: 150, window_minutes: -1, resets_at: "x" },
          secondary: null,
        },
      })
    );
    expect(clamped?.rateLimits?.primary).toEqual({
      usedPercent: 100,
      windowMinutes: null,
      resetsAtEpochSeconds: null,
    });
  });

  it("falls back to the last GOOD snapshot when the freshest entry is malformed/zero (staleness/last-good)", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({
        modelContextWindow: 100_000,
        codexLastTokenUsage: [
          tokenSnapshot({
            input: 1000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
          }),
          tokenSnapshot({
            input: 9000,
            output: 1000,
            cacheRead: 0,
            cacheWrite: 0,
          }),
          // trailing garbage / zero-only entries must not blank the reading
          tokenSnapshot({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
          tokenSnapshot("garbage"),
        ],
      })
    );
    // last GOOD = the {9000,1000} snapshot, total 10000 -> 10% of 100000
    expect(result?.latestTokenUsage?.total).toBe(10_000);
    expect(result?.contextWindowUtilizationPercent).toBeCloseTo(10);
  });

  it("clamps utilization to 100% when a turn exceeds the reported window (never a >100% lie)", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({
        modelContextWindow: 1000,
        codexLastTokenUsage: [
          tokenSnapshot({
            input: 2000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
          }),
        ],
      })
    );
    expect(result?.contextWindowUtilizationPercent).toBe(100);
  });

  it("never surfaces raw reasoning content — only aggregate COUNTS are read from the snapshot", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({
        codexLastTokenUsage: [
          {
            timestamp: "2026-07-22T00:00:00.000Z",
            model: "gpt-5",
            // an attacker-shaped blob carrying prose alongside the counts
            reasoning:
              "SECRET private chain of thought that must never surface",
            text: "raw assistant message body",
            lastTokenUsage: {
              input: 5,
              output: 3,
              cacheRead: 0,
              cacheWrite: 0,
              reasoningText: "also secret",
            },
          },
        ],
      })
    );
    expect(result?.latestTokenUsage).toEqual({
      input: 5,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      total: 8,
    });
    // The view model has ONLY numeric count fields — no reasoning/text leak.
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("raw assistant message");
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
