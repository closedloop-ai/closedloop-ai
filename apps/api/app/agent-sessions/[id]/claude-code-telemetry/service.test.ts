import {
  ClaudeCodeCostSource,
  ClaudeCodeTelemetryAvailability,
} from "@repo/api/src/types/claude-code-telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claudeCodeTelemetryReadService } from "./service";

const dbState = vi.hoisted((): { db: unknown } => ({ db: undefined }));

vi.mock("@repo/database", () => ({
  withDb: vi.fn((fn: (db: unknown) => unknown) => fn(dbState.db)),
}));

const ORG_ID = "org-1";
const ARTIFACT_ID = "11111111-2222-4333-8444-555555555555";
const TARGET_ID = "22222222-3333-4444-8555-666666666666";

type SessionRow = {
  artifactId: string;
  computeTargetId: string;
  harness: string;
  estimatedCost: string | null;
  authoritativeCostUsd: string | null;
  claudeCodeTelemetry: Record<string, unknown> | null;
};

/**
 * A `findMany` that HONOURS `take`, the way the database does.
 *
 * A double that ignores it cannot distinguish a stored set of exactly the cap
 * from one that was cut there, which is the whole question the partial flags
 * answer — so the off-by-one those flags had would stay green under a double
 * that always returned the same rows.
 */
function bounded(rows: Record<string, unknown>[] | undefined) {
  return vi.fn((args?: { take?: number }) =>
    Promise.resolve(
      args?.take === undefined ? (rows ?? []) : (rows ?? []).slice(0, args.take)
    )
  );
}

function fakeDb(input: {
  session: SessionRow | null;
  components?: Record<string, unknown>[];
  drops?: Record<string, unknown>[];
  activeTime?: Record<string, unknown>[];
  linesOfCode?: Record<string, unknown>[];
}) {
  const db = {
    sessionDetail: { findFirst: vi.fn(() => Promise.resolve(input.session)) },
    claudeCodeComponentTelemetry: {
      findMany: bounded(input.components),
    },
    claudeCodeSignalDropCounter: {
      findMany: vi.fn(() => Promise.resolve(input.drops ?? [])),
    },
    claudeCodeActiveTimeTelemetry: {
      findMany: bounded(input.activeTime),
    },
    claudeCodeLinesOfCodeTelemetry: {
      findMany: bounded(input.linesOfCode),
    },
  };
  dbState.db = db;
  return db;
}

function rollup(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    costEventCount: 3,
    apiRequestCount: 0,
    errorEventCount: 0,
    permissionEventCount: 0,
    permissionModeChangeCount: 0,
    mcpServerConnectionCount: 0,
    toolResultCount: 0,
    // Omitted by the producer on every machine today: the beta table is never
    // fed, so a `0` here would assert a measured absence.
    llmRequestCount: null,
    // ISS-11322's three count families.
    authEventCount: 0,
    pluginEventCount: 0,
    sessionStartCount: 0,
    componentsTruncated: false,
    activeTimeTruncated: false,
    linesOfCodeTruncated: false,
    // Default to NOT recorded, which is the truthful state for a machine that has
    // never captured these — and the state a row written by a pre-ISS-11322 build
    // carries, since the columns default false.
    activeTimeRecorded: false,
    linesOfCodeRecorded: false,
    identityRecorded: false,
    identityOrganizationId: null,
    identitySource: null,
    identityTerminalType: null,
    identityAppVersion: null,
    identityAppEntrypoint: null,
    costEventUsd: "1.250000",
    apiRequestCostUsdMicros: 1_250_000n,
    observedFrom: new Date("2026-09-20T00:00:00.000Z"),
    observedTo: new Date("2026-09-21T00:00:00.000Z"),
    ...overrides,
  };
}

/** A Claude Code session row carrying `telemetry` as its synced rollup. */
function sessionRow(telemetry: Record<string, unknown> | null): SessionRow {
  return {
    artifactId: ARTIFACT_ID,
    computeTargetId: TARGET_ID,
    harness: "claude",
    estimatedCost: null,
    authoritativeCostUsd: null,
    claudeCodeTelemetry: telemetry,
  };
}

function read() {
  return claudeCodeTelemetryReadService.findClaudeCodeTelemetry({
    id: ARTIFACT_ID,
    organizationId: ORG_ID,
  });
}

describe("claudeCodeTelemetryReadService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers absent-by-harness for a harness that produces none of these signals", async () => {
    fakeDb({
      session: {
        artifactId: ARTIFACT_ID,
        computeTargetId: TARGET_ID,
        harness: "codex",
        estimatedCost: null,
        authoritativeCostUsd: null,
        claudeCodeTelemetry: null,
      },
    });

    const result = await read();

    // Nothing failed and nothing is missing: Codex emits no `claude_code_*`
    // signals at all. The read must answer, not error, and must not report this
    // as a capture failure.
    expect(result?.availability).toBe(
      ClaudeCodeTelemetryAvailability.AbsentByHarness
    );
    expect(result?.components).toEqual([]);
    expect(result?.signals.costEvents).toEqual({
      recorded: false,
      count: null,
    });
  });

  it("separates a Claude session with no rollup from one with no signals", async () => {
    fakeDb({
      session: {
        artifactId: ARTIFACT_ID,
        computeTargetId: TARGET_ID,
        harness: "claude",
        estimatedCost: null,
        authoritativeCostUsd: null,
        claudeCodeTelemetry: null,
      },
    });

    const result = await read();

    expect(result?.availability).toBe(
      ClaudeCodeTelemetryAvailability.NotRecorded
    );
  });

  it("reports a measured zero and an unrecorded family differently", async () => {
    fakeDb({
      session: {
        artifactId: ARTIFACT_ID,
        computeTargetId: TARGET_ID,
        harness: "claude",
        estimatedCost: "2.000000",
        authoritativeCostUsd: null,
        claudeCodeTelemetry: rollup(),
      },
    });

    const result = await read();

    expect(result?.signals.apiRequests).toEqual({ recorded: true, count: 0 });
    expect(result?.signals.llmRequests).toEqual({
      recorded: false,
      count: null,
    });
  });

  it("names the ledger on every cost it returns", async () => {
    fakeDb({
      session: {
        artifactId: ARTIFACT_ID,
        computeTargetId: TARGET_ID,
        harness: "claude",
        estimatedCost: "2.000000",
        authoritativeCostUsd: "1.900000",
        claudeCodeTelemetry: rollup(),
      },
    });

    const result = await read();

    // Four producers, four ledgers, none a second opinion of another. A bare
    // number here is the defect the ISS-7352 Q2 ruling exists to prevent.
    expect(result?.costs.map((cost) => cost.source)).toEqual([
      ClaudeCodeCostSource.DesktopEstimate,
      ClaudeCodeCostSource.HarnessResultEnvelope,
      ClaudeCodeCostSource.HarnessCostEvent,
      ClaudeCodeCostSource.ProducerApiRequestMicros,
    ]);
  });

  it("refuses to call a machine complete while it is dropping signals", async () => {
    fakeDb({
      session: {
        artifactId: ARTIFACT_ID,
        computeTargetId: TARGET_ID,
        harness: "claude",
        estimatedCost: null,
        authoritativeCostUsd: null,
        claudeCodeTelemetry: rollup(),
      },
      drops: [
        {
          harness: "claude",
          reason: "receiver_backpressure",
          droppedCount: 4n,
          firstObservedAt: new Date("2026-09-20T00:00:00.000Z"),
          lastObservedAt: new Date("2026-09-21T00:00:00.000Z"),
        },
      ],
    });

    const result = await read();

    expect(result?.completeness.complete).toBe(false);
    expect(result?.completeness.drops[0]?.droppedCount).toBe("4");
  });

  it("reports a truncated component breakdown as partial, never as complete", async () => {
    fakeDb({
      session: {
        artifactId: ARTIFACT_ID,
        computeTargetId: TARGET_ID,
        harness: "claude",
        estimatedCost: null,
        authoritativeCostUsd: null,
        claudeCodeTelemetry: rollup({ componentsTruncated: true }),
      },
    });

    const result = await read();

    // The rows returned are real; there are simply more of them than one
    // delivery carries. Presenting the slice as the session's whole attribution
    // is the defect.
    expect(result?.completeness.componentsPartial).toBe(true);
    expect(result?.completeness.complete).toBe(false);
  });

  it("counts only this session's harness against completeness", async () => {
    const db = fakeDb({
      session: {
        artifactId: ARTIFACT_ID,
        computeTargetId: TARGET_ID,
        harness: "claude",
        estimatedCost: null,
        authoritativeCostUsd: null,
        claudeCodeTelemetry: rollup(),
      },
    });

    await read();

    // Two harnesses share one per-machine counter table, so an unscoped read
    // would let a Codex eviction mark every Claude session incomplete.
    expect(db.claudeCodeSignalDropCounter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { computeTargetId: TARGET_ID, harness: "claude" },
      })
    );
  });

  it("404s a session outside the caller's org", async () => {
    fakeDb({ session: null });

    expect(await read()).toBeNull();
  });

  it("does not answer absent-by-harness for a session that has a synced rollup", async () => {
    // `session_detail.harness` is nullable at the producer and defaults to
    // "unknown" on both sides, so a real Claude Code session can carry a label
    // that is not `Harness.Claude`. Before the row was tested first, such a
    // session answered absent_by_harness — "this harness emits none of these
    // signals, nothing is missing" — on the same object whose signals and
    // components were carrying real synced counts.
    fakeDb({
      session: {
        artifactId: ARTIFACT_ID,
        computeTargetId: TARGET_ID,
        harness: "unknown",
        estimatedCost: null,
        authoritativeCostUsd: null,
        claudeCodeTelemetry: rollup(),
      },
    });

    const result = await claudeCodeTelemetryReadService.findClaudeCodeTelemetry(
      {
        id: ARTIFACT_ID,
        organizationId: ORG_ID,
      }
    );

    expect(result?.availability).toBe(ClaudeCodeTelemetryAvailability.Recorded);
    expect(result?.signals.costEvents).toEqual({ recorded: true, count: 3 });
  });

  it("bounds the component read and reports the cut as partial", async () => {
    // The stored set is NOT bounded by the per-request cap: a truncated
    // delivery deliberately skips the deleteMany, so what accumulates is the
    // union of every delivery's slice.
    const db = fakeDb({
      session: {
        artifactId: ARTIFACT_ID,
        computeTargetId: TARGET_ID,
        harness: "claude",
        estimatedCost: null,
        authoritativeCostUsd: null,
        claudeCodeTelemetry: rollup({ componentsTruncated: false }),
      },
      // ONE PAST the cap. Seeded at exactly 500 this case asserted
      // `componentsPartial: true` for a set the read returned WHOLE — the
      // off-by-one itself, written down as the expectation. The read now fetches
      // one past the ceiling so "there is more" is observed rather than assumed,
      // and only a row beyond the cap is a shortfall.
      components: Array.from({ length: 501 }, (_row, index) => ({
        attributionKey: `key-${index}`,
        attributionSource: "harness",
        agentName: null,
        skillName: null,
        pluginName: null,
        mcpServerName: null,
        mcpToolName: null,
        querySource: null,
        speed: null,
        effort: null,
        costEventCount: 1,
        costUsd: null,
      })),
    });

    const result = await claudeCodeTelemetryReadService.findClaudeCodeTelemetry(
      {
        id: ARTIFACT_ID,
        organizationId: ORG_ID,
      }
    );

    expect(db.claudeCodeComponentTelemetry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 501 })
    );
    // The producer said the breakdown was whole; the READ cut it, and the
    // reader is told so rather than handed a slice labelled complete.
    expect(result?.completeness.componentsPartial).toBe(true);
  });
});

describe("ISS-11322: the value-bearing breakdowns keep unknown apart from zero", () => {
  it("reports null, not [], for a family the delivering machine never recorded", async () => {
    // A rollup EXISTS — this session has cost events — and the two breakdown
    // tables are empty. That is the ordinary state of every machine that has
    // never captured active time or lines of code, so it is the case where
    // reading "no rows" as a measured zero does the damage. `null` is the only
    // honest answer, and the `*Recorded` flags are the only thing that can say so:
    // zero rows is not evidence of either claim.
    fakeDb({ session: sessionRow(rollup()) });

    const result = await read();

    expect(result?.activeTime).toBeNull();
    expect(result?.linesOfCode).toBeNull();
    expect(result?.identity).toBeNull();
  });

  it("reports [] — a measured zero — for a recorded family with no rows this session", async () => {
    // Same empty tables, opposite claim, and the ONLY difference is the flag the
    // producer's omission-vs-`[]` decision persisted. If the read derived this
    // from the rows, this case and the one above would be indistinguishable.
    fakeDb({
      session: sessionRow(
        rollup({ activeTimeRecorded: true, linesOfCodeRecorded: true })
      ),
    });

    const result = await read();

    expect(result?.activeTime).toEqual([]);
    expect(result?.linesOfCode).toEqual([]);
  });

  it("carries seconds and line counts as strings, per dimension", async () => {
    fakeDb({
      session: sessionRow(
        rollup({ activeTimeRecorded: true, linesOfCodeRecorded: true })
      ),
      activeTime: [
        { activityType: "user", seconds: "90.000" },
        { activityType: "cli", seconds: "5.500" },
      ],
      linesOfCode: [
        { model: "claude-sonnet-4-5", changeType: "added", lineCount: 100n },
        { model: "claude-sonnet-4-5", changeType: "removed", lineCount: 25n },
      ],
    });

    const result = await read();

    // PER DIMENSION, and never one blended total: a fold that dropped a
    // dimension and got lucky on the other's arithmetic would pass a sum check.
    expect(result?.activeTime).toEqual([
      { activityType: "user", seconds: "90.000" },
      { activityType: "cli", seconds: "5.500" },
    ]);
    expect(result?.linesOfCode).toEqual([
      { model: "claude-sonnet-4-5", changeType: "added", lineCount: "100" },
      { model: "claude-sonnet-4-5", changeType: "removed", lineCount: "25" },
    ]);
  });

  it("keeps an all-null identity row apart from an absent one", async () => {
    // `identityRecorded` true with every dimension NULL is "the harness stamped an
    // identity and knew none of these". Absent is a different claim. Both would be
    // five NULLs in the columns, so the flag is the only thing that separates them.
    fakeDb({ session: sessionRow(rollup({ identityRecorded: true })) });

    const result = await read();

    expect(result?.identity).toEqual({
      organizationId: null,
      identitySource: null,
      terminalType: null,
      appVersion: null,
      appEntrypoint: null,
    });
  });

  it("a truncated breakdown is reported partial AND makes the session incomplete", async () => {
    fakeDb({
      session: sessionRow(
        rollup({
          activeTimeRecorded: true,
          linesOfCodeRecorded: true,
          activeTimeTruncated: true,
        })
      ),
      activeTime: [{ activityType: "user", seconds: "90.000" }],
    });

    const result = await read();

    expect(result?.completeness.activeTimePartial).toBe(true);
    expect(result?.completeness.linesOfCodePartial).toBe(false);
    // The shortfall must reach `complete`. Reporting a session COMPLETE while one
    // of its breakdowns is a slice is the conflation the flag exists to prevent.
    expect(result?.completeness.complete).toBe(false);
  });

  it("reports a stored set of exactly the read cap as whole, not as a shortfall", async () => {
    // EXACTLY the cap, on every bounded family. Comparing `rows.length >= cap`
    // against a `take: cap` read cannot tell "the set is this big" from "the set
    // was cut here", so a complete 100-row active-time breakdown was published
    // with a shortfall the reader could not act on and that did not exist.
    fakeDb({
      session: sessionRow(
        rollup({ activeTimeRecorded: true, linesOfCodeRecorded: true })
      ),
      components: componentRows(500),
      activeTime: activeTimeRows(100),
      linesOfCode: linesOfCodeRows(300),
    });

    const result = await read();

    expect(result?.components).toHaveLength(500);
    expect(result?.activeTime).toHaveLength(100);
    expect(result?.linesOfCode).toHaveLength(300);
    expect(result?.completeness.componentsPartial).toBe(false);
    expect(result?.completeness.activeTimePartial).toBe(false);
    expect(result?.completeness.linesOfCodePartial).toBe(false);
    expect(result?.completeness.complete).toBe(true);
  });

  it("reports one row past the cap as partial, and does not publish the probe row", async () => {
    fakeDb({
      session: sessionRow(
        rollup({ activeTimeRecorded: true, linesOfCodeRecorded: true })
      ),
      components: componentRows(501),
      activeTime: activeTimeRows(101),
      linesOfCode: linesOfCodeRows(301),
    });

    const result = await read();

    // The extra row is the OBSERVATION that more exist, never part of the
    // answer: publishing it would make the cap a lie by one row.
    expect(result?.components).toHaveLength(500);
    expect(result?.activeTime).toHaveLength(100);
    expect(result?.linesOfCode).toHaveLength(300);
    expect(result?.completeness.componentsPartial).toBe(true);
    expect(result?.completeness.activeTimePartial).toBe(true);
    expect(result?.completeness.linesOfCodePartial).toBe(true);
  });
});

function componentRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    attributionKey: `skill:s-${index}`,
    attributionSource: "otel",
    agentName: null,
    skillName: `s-${index}`,
    pluginName: null,
    mcpServerName: null,
    mcpToolName: null,
    querySource: null,
    speed: null,
    effort: null,
    costEventCount: 1,
    costUsd: null,
  }));
}

function activeTimeRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    activityType: `type-${index}`,
    seconds: "1.000",
  }));
}

function linesOfCodeRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    model: `model-${index}`,
    changeType: "added",
    lineCount: 1n,
  }));
}
