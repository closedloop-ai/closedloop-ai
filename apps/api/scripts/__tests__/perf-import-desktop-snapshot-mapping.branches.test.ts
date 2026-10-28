/**
 * ISS-11280 — branch-pinning coverage for the pure row-to-wire mapping in
 * `perf-import-desktop-snapshot-mapping.ts`. The module takes no database and
 * no filesystem, so every case here drives `mapSnapshotSession` directly with
 * hand-built `SnapshotSessionBundle` rows — no sqlite fixture required.
 */
import { describe, expect, it } from "vitest";
import {
  mapSnapshotSession,
  SkipReason,
  type SkipTally,
} from "../perf-import-desktop-snapshot-mapping";
import type {
  SnapshotSessionBundle,
  SqliteRow,
} from "../perf-import-desktop-snapshot-reads";

function validSession(overrides: Partial<SqliteRow> = {}): SqliteRow {
  return {
    id: "sess-1",
    name: "Session One",
    status: "active",
    cwd: "/repo",
    model: "claude-3",
    harness: "claude-code",
    billingMode: "subscription",
    repoFullName: "acme/repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    endedAt: null,
    awaitingInputSince: null,
    metadata: '{"foo":"bar"}',
    dataRevision: 2,
    endsWithError: 0,
    frustrationRaw: 3,
    frustrationScoreVersion: 1,
    ...overrides,
  };
}

function emptyBundle(
  sessionOverrides: Partial<SqliteRow> = {}
): SnapshotSessionBundle {
  return {
    session: validSession(sessionOverrides),
    agents: [],
    events: [],
    tokenUsage: [],
    tokenEvents: [],
    analytics: undefined,
    activitySegments: [],
    componentUsage: [],
  };
}

const baseTokenUsageRow: SqliteRow = {
  model: "claude-3",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  baselineInput: 0,
  baselineOutput: 0,
  baselineCacheRead: 0,
  baselineCacheWrite: 0,
};

const baseTokenEventRow: SqliteRow = {
  transportId: "tr-1",
  model: "claude-3",
  createdAt: "2026-01-01T00:00:00.000Z",
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const baseActivitySegmentRow: SqliteRow = {
  phase: "implement",
  startMs: 0,
  endMs: 10,
  version: 1,
};

const baseComponentUsageRow: SqliteRow = {
  componentKind: "skill",
  componentKey: "key-1",
  invocations: 1,
  errorCount: 0,
};

describe("mapSnapshotSession — session-level fields", () => {
  it("skips a session with no status, tallying SessionMissingStatus", () => {
    const tally: SkipTally = {};
    const result = mapSnapshotSession(emptyBundle({ status: null }), tally);

    expect(result).toBeNull();
    expect(tally).toStrictEqual({ [SkipReason.SessionMissingStatus]: 1 });
  });

  it("omits attribution when repoFullName is absent", () => {
    const tally: SkipTally = {};
    const result = mapSnapshotSession(
      emptyBundle({ repoFullName: null }),
      tally
    );

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("attribution");
  });

  it("omits endsWithError when the sqlite flag is not a finite number", () => {
    const tally: SkipTally = {};
    const result = mapSnapshotSession(
      emptyBundle({ endsWithError: "yes" }),
      tally
    );

    expect(result).not.toHaveProperty("endsWithError");
  });

  it("omits dataRevision when the stored value is outside the supported range", () => {
    const tally: SkipTally = {};
    const result = mapSnapshotSession(emptyBundle({ dataRevision: 0 }), tally);

    expect(result).not.toHaveProperty("dataRevision");
  });

  it("omits frustrationRaw when the stored value is not a safe integer", () => {
    const tally: SkipTally = {};
    const result = mapSnapshotSession(
      emptyBundle({ frustrationRaw: 3.5 }),
      tally
    );

    expect(result).not.toHaveProperty("frustrationRaw");
  });

  it("maps metadata to null when the stored text is absent", () => {
    const tally: SkipTally = {};
    const result = mapSnapshotSession(emptyBundle({ metadata: null }), tally);

    expect(result?.metadata).toBeNull();
  });

  it("maps metadata to null when the stored JSON parses to a non-object", () => {
    const tally: SkipTally = {};
    const result = mapSnapshotSession(emptyBundle({ metadata: "42" }), tally);

    expect(result?.metadata).toBeNull();
  });
});

describe("mapSnapshotSession — token usage rows", () => {
  it("skips a token-usage row when the model is missing", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.tokenUsage = [{ ...baseTokenUsageRow, model: null }];

    const result = mapSnapshotSession(bundle, tally);

    expect(result?.tokenUsageByModel).toStrictEqual([]);
    expect(tally).toStrictEqual({ [SkipReason.TokenUsageUnrepresentable]: 1 });
  });

  it("skips a token-usage row when a raw count is not a safe integer", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.tokenUsage = [{ ...baseTokenUsageRow, inputTokens: "oops" }];

    const result = mapSnapshotSession(bundle, tally);

    expect(result?.tokenUsageByModel).toStrictEqual([]);
    expect(tally).toStrictEqual({ [SkipReason.TokenUsageUnrepresentable]: 1 });
  });

  it("skips a token-usage row when current plus baseline overflows the safe-integer envelope", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.tokenUsage = [
      {
        ...baseTokenUsageRow,
        inputTokens: Number.MAX_SAFE_INTEGER,
        baselineInput: Number.MAX_SAFE_INTEGER,
      },
    ];

    const result = mapSnapshotSession(bundle, tally);

    expect(result?.tokenUsageByModel).toStrictEqual([]);
    expect(tally).toStrictEqual({ [SkipReason.TokenUsageUnrepresentable]: 1 });
  });

  it("skips a token-usage row when the baseline count is not representable", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.tokenUsage = [{ ...baseTokenUsageRow, baselineInput: "oops" }];

    const result = mapSnapshotSession(bundle, tally);

    expect(result?.tokenUsageByModel).toStrictEqual([]);
    expect(tally).toStrictEqual({ [SkipReason.TokenUsageUnrepresentable]: 1 });
  });

  it("omits the cacheWrite TTL subdivision when only one half of the pair is stored", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    // The TTL split is a PAIR — only `cacheWrite5mTokens` is present here, so
    // the pair-completeness check must refuse it even though ONE half parses.
    bundle.tokenUsage = [
      { ...baseTokenUsageRow, cacheWriteTokens: 100, cacheWrite5mTokens: 60 },
    ];

    const result = mapSnapshotSession(bundle, tally);
    const rows = result?.tokenUsageByModel as Record<string, unknown>[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("cacheWrite5mTokens");
    expect(rows[0]).not.toHaveProperty("cacheWrite1hTokens");
  });

  it("keeps the cacheWrite TTL subdivision when both halves are present and within bounds", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.tokenUsage = [
      {
        ...baseTokenUsageRow,
        cacheWriteTokens: 100,
        cacheWrite5mTokens: 60,
        cacheWrite1hTokens: 40,
      },
    ];

    const result = mapSnapshotSession(bundle, tally);
    const rows = result?.tokenUsageByModel as Record<string, unknown>[];

    expect(rows[0]).toMatchObject({
      cacheWrite5mTokens: 60,
      cacheWrite1hTokens: 40,
    });
  });

  it("omits the cacheWrite TTL subdivision when the halves exceed the parent total", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    // Both halves parse individually, but 70 + 40 exceeds the 100 the parent
    // `cacheWriteTokens` reports — a subdivision cannot exceed its own total.
    bundle.tokenUsage = [
      {
        ...baseTokenUsageRow,
        cacheWriteTokens: 100,
        cacheWrite5mTokens: 70,
        cacheWrite1hTokens: 40,
      },
    ];

    const result = mapSnapshotSession(bundle, tally);
    const rows = result?.tokenUsageByModel as Record<string, unknown>[];

    expect(rows[0]).not.toHaveProperty("cacheWrite5mTokens");
    expect(rows[0]).not.toHaveProperty("cacheWrite1hTokens");
  });

  it("omits estimatedCostUsd on a token-usage row when the stored cost is negative", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.tokenUsage = [{ ...baseTokenUsageRow, costUsdEstimated: -1 }];

    const result = mapSnapshotSession(bundle, tally);
    const rows = result?.tokenUsageByModel as Record<string, unknown>[];

    expect(rows).toHaveLength(1);
    // Asserting the surrounding fields too, not just the omission, is what
    // catches the row collapsing to an empty object rather than genuinely
    // keeping everything but the one bad field.
    expect(rows[0]).toMatchObject({
      model: "claude-3",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(rows[0]).not.toHaveProperty("estimatedCostUsd");
  });
});

describe("mapSnapshotSession — token event rows", () => {
  it("skips a token event when the transport id is missing", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.tokenEvents = [{ ...baseTokenEventRow, transportId: null }];

    const result = mapSnapshotSession(bundle, tally);

    expect(result).not.toHaveProperty("tokenEvents");
    expect(tally).toStrictEqual({
      [SkipReason.TokenEventMissingTransportId]: 1,
    });
  });

  it("skips a token event when a count is not representable", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.tokenEvents = [{ ...baseTokenEventRow, inputTokens: "oops" }];

    const result = mapSnapshotSession(bundle, tally);

    expect(result).not.toHaveProperty("tokenEvents");
    expect(tally).toStrictEqual({
      [SkipReason.TokenEventUnrepresentable]: 1,
    });
  });
});

describe("mapSnapshotSession — activity segment rows", () => {
  it("skips a segment when a required bound is missing", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.activitySegments = [{ ...baseActivitySegmentRow, phase: null }];

    const result = mapSnapshotSession(bundle, tally);

    expect(result).not.toHaveProperty("activitySegmentRows");
    expect(tally).toStrictEqual({
      [SkipReason.ActivitySegmentBoundsInvalid]: 1,
    });
  });

  it("empties evidenceLayers when the stored value is not a string", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.activitySegments = [
      { ...baseActivitySegmentRow, evidenceLayers: 5 },
    ];

    const result = mapSnapshotSession(bundle, tally);
    const rows = result?.activitySegmentRows as Record<string, unknown>[];

    expect(rows[0]?.evidenceLayers).toStrictEqual([]);
    // No `confidence` was stored on this row either — pinning the clamp's own
    // fallback (0), not just the sibling evidenceLayers fallback.
    expect(rows[0]?.confidence).toBe(0);
  });

  it("empties evidenceLayers when the stored JSON does not parse to an array", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.activitySegments = [
      { ...baseActivitySegmentRow, evidenceLayers: '{"a":1}' },
    ];

    const result = mapSnapshotSession(bundle, tally);
    const rows = result?.activitySegmentRows as Record<string, unknown>[];

    expect(rows[0]?.evidenceLayers).toStrictEqual([]);
  });
});

describe("mapSnapshotSession — component usage rows", () => {
  it("skips a component-usage row when identity fields are missing", () => {
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.componentUsage = [{ ...baseComponentUsageRow, componentKind: null }];

    const result = mapSnapshotSession(bundle, tally);

    expect(result).not.toHaveProperty("components");
    expect(tally).toStrictEqual({
      [SkipReason.ComponentUsageMissingIdentity]: 1,
    });
  });
});

describe("mapSnapshotSession — analytics rollup", () => {
  it("reports a non-representable rollup counter as a measured zero", () => {
    // pins current behavior; looks odd because a malformed sqlite counter
    // ("oops", not a number) is silently coerced into a believable 0 rather
    // than omitted — the exact "confident but wrong measurement" shape
    // AGENTS's Handling Bad Data rule names as wrong. Pinned as-is per this
    // PR's main-is-the-spec rule; the coercion is a production follow-up.
    const tally: SkipTally = {};
    const bundle = emptyBundle();
    bundle.analytics = {
      startedAt: "2026-01-01T00:00:00.000Z",
      startedDay: "2026-01-01",
      status: "active",
      harness: "claude-code",
      isHuman: 0,
      updatedAt: "2026-01-01T00:05:00.000Z",
      runtimeMs: 4200,
      estCost: 1.5,
      humanTurns: "oops",
      agentTurns: 2,
      eventCount: 3,
      toolInvocations: 1,
      errorEvents: 0,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    const result = mapSnapshotSession(bundle, tally);
    const rollup = result?.sessionAnalytics as Record<string, unknown>;

    expect(rollup.humanTurns).toBe(0);
    // The malformed counter is only ONE key among many the rollup carries —
    // asserting the surrounding fields too is what catches the whole rollup
    // literal collapsing rather than just the one counter's fallback.
    expect(rollup).toMatchObject({
      status: "active",
      harness: "claude-code",
      isHuman: false,
      runtimeMs: 4200,
      estimatedCostUsd: 1.5,
    });
  });
});
