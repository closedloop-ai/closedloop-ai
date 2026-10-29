/**
 * ISS-7229 (marisolashgrove on #6393): an OMITTED `authoritativeCostUsd` must not
 * reach the database as a write.
 *
 * The three-point guard on this field is (1) the desktop omits the key rather
 * than sending `null`, (2) the wire schema refuses `null`, and (3) the slice
 * patches the column only when the payload carries a figure. Points 1 and 2 had
 * counterfactuals; point 3 had none — and it is the leg with real data loss
 * behind it. Swapping `toAuthoritativeCostPatch` for a plain
 * `authoritativeCostUsd: session.authoritativeCostUsd` left every existing suite
 * green while a session that synced again from a build with OTel capture off
 * started nulling the figure an earlier sync had recorded.
 *
 * So this drives the REAL `upsertSessions` path — not the helper — and asserts
 * the shape that actually reaches `sessionDetail.upsert`. A helper-only test
 * cannot catch the regression, because the regression is the CALL SITE ceasing
 * to use the helper.
 *
 * Mirrors the transaction-level mock in `service.upsert-watermark.test.ts`,
 * trimmed to what the slice needs to reach its upsert.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistedSessionDetail } from "@/__tests__/support/agent-sessions/service.test-harness";

const mocks = vi.hoisted(() => ({
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
  generateSlug: vi.fn().mockResolvedValue("SES-0001"),
  /**
   * Stand-in for `Prisma.Decimal` recording its constructor argument, mirroring
   * `authoritative-cost-projection.test.ts`. The contract is that the value
   * reaches the driver as an exact six-place STRING rather than as the double it
   * arrived as, so the constructor input is the whole assertion — decimal
   * arithmetic would only re-derive it.
   */
  RecordingDecimal: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("@repo/database", () => ({
  ArtifactType: { DOCUMENT: "DOCUMENT", BRANCH: "BRANCH", SESSION: "SESSION" },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  Prisma: { DbNull: mocks.dbNull, Decimal: mocks.RecordingDecimal },
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

vi.mock("@/lib/slug-generator", () => ({ generateSlug: mocks.generateSlug }));

vi.mock("./service/session-ingest-metadata-activity", () => ({
  writeSessionArtifactMetadata: vi.fn().mockResolvedValue(null),
  captureCommittedSessionMetadata: vi.fn(),
}));

import { agentSessionsService } from "./service";

const SESSION_STARTED_AT = new Date("2026-07-24T09:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-07-24T09:30:00.000Z");
/** Strictly BEFORE the stored watermark — a redelivered older sync. */
const SESSION_UPDATED_AT_EARLIER = new Date("2026-07-24T09:15:00.000Z");
/** Strictly AFTER it — a later capture, whatever figure it carries. */
const SESSION_UPDATED_AT_LATER = new Date("2026-07-24T09:45:00.000Z");
const PERSISTED_ARTIFACT_ID = "artifact-authoritative-cost-1";
const COMPUTE_TARGET_ID = "target-authoritative-cost-1";
const ORG_ID = "org-authoritative-cost-1";
const USER_ID = "user-authoritative-cost-1";
const REPORTED_COST_USD = 12.5;

function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "ext-sess-authoritative-cost-1",
    name: "Authoritative Cost Session",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/project",
    model: "claude-sonnet-4",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function buildPayload(sessions: SyncedAgentSession[]) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-authoritative-cost-1",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

function buildContext() {
  return {
    organizationId: ORG_ID,
    userId: USER_ID,
    computeTargetId: COMPUTE_TARGET_ID,
  };
}

/** Minimal tx-level mock driving `upsertSessions` to `sessionDetail.upsert`. */
function installDb(storedDetail: unknown = null) {
  const sessionDetailUpsert = vi
    .fn()
    .mockResolvedValue(persistedSessionDetail(PERSISTED_ARTIFACT_ID));

  const db = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([{ toolUseCount: 0n, errorCount: 0n }]),
    organization: { findUnique: vi.fn().mockResolvedValue({ settings: null }) },
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: COMPUTE_TARGET_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue(storedDetail),
      upsert: sessionDetailUpsert,
      update: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _max: { eventCreatedAt: null } }),
    },
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    artifactLink: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    sessionTranscript: { findMany: vi.fn().mockResolvedValue([]) },
  };

  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );

  return { sessionDetailUpsert };
}

/**
 * Both arms of the upsert, since `detailData` is spread into `create` and
 * `update` alike and a regression could reach the column through either.
 *
 * ISS-8604 split three OTHER columns per arm (`agents`, `agentCount`,
 * `awaitingInputSince`); `authoritativeCostUsd` is not among them, so reading
 * one object per arm still covers it.
 */
function upsertArms(call: {
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}) {
  return [call.create, call.update];
}

describe("upsertSessions — an omitted authoritative cost is not written (ISS-7229)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omits the column entirely when the payload carries no figure", async () => {
    const { sessionDetailUpsert } = installDb();

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession()])
    );

    expect(sessionDetailUpsert).toHaveBeenCalledTimes(1);
    for (const arm of upsertArms(sessionDetailUpsert.mock.calls[0][0])) {
      // `in`, not a value check: an assigned `undefined` is the exact regression
      // this pins, and `arm.authoritativeCostUsd === undefined` would pass for
      // both the correct omission and the broken assignment.
      expect("authoritativeCostUsd" in arm).toBe(false);
    }
  });

  it("writes the column when the payload carries a figure", async () => {
    // The other half: the guard must not be a blanket refusal. Without this a
    // patch that omitted the key unconditionally would satisfy the case above.
    const { sessionDetailUpsert } = installDb();

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({ authoritativeCostUsd: REPORTED_COST_USD }),
      ])
    );

    for (const arm of upsertArms(sessionDetailUpsert.mock.calls[0][0])) {
      expect(decimalInput(arm.authoritativeCostUsd)).toBe("12.500000");
    }
  });

  it("REFUSES a redelivered older sync that would lower a stored figure", async () => {
    // ISS-7229 (review of #6406). This column takes the `sessionUpdatedAt`
    // watermark for the OVERWRITE only, so a stale slice still reaches the write
    // and still lands a first figure. What makes this payload lose is its
    // `updatedAt`, NOT its magnitude. Delivery is at-least-once and the
    // desktop re-sends only when its own sum CHANGES, so without this guard a
    // redelivered older sync landing after a newer one leaves an ended
    // session's cost silently wrong with nothing left to correct it.
    const { sessionDetailUpsert } = installDb({
      artifactId: PERSISTED_ARTIFACT_ID,
      sessionUpdatedAt: SESSION_UPDATED_AT,
      authoritativeCostUsd: new mocks.RecordingDecimal("5.000000"),
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({
          authoritativeCostUsd: 1.5,
          updatedAt: SESSION_UPDATED_AT_EARLIER.toISOString(),
        }),
      ])
    );

    for (const arm of upsertArms(sessionDetailUpsert.mock.calls[0][0])) {
      expect(arm.authoritativeCostUsd).toBeUndefined();
    }
  });

  it("ACCEPTS a figure that advances the stored one", async () => {
    // The other half: the guard must not be a blanket refusal once a row has a
    // figure, or a session's cost would freeze at whichever sync landed first.
    // An equal watermark counts as fresh (`incoming >= existing`), which is the
    // ordinary re-sync shape.
    const { sessionDetailUpsert } = installDb({
      artifactId: PERSISTED_ARTIFACT_ID,
      sessionUpdatedAt: SESSION_UPDATED_AT,
      authoritativeCostUsd: new mocks.RecordingDecimal("5.000000"),
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession({ authoritativeCostUsd: 9 })])
    );

    for (const arm of upsertArms(sessionDetailUpsert.mock.calls[0][0])) {
      expect(decimalInput(arm.authoritativeCostUsd)).toBe("9.000000");
    }
  });

  it("ACCEPTS a corrected-LOWER figure from a newer capture", async () => {
    // The case a magnitude guard got wrong, and why this one keys on delivery
    // order. The desktop rollup recomputes its sum FROM SCRATCH and re-offers it
    // whenever the value CHANGES, so a de-dup fix that stops double-counting
    // lowers the local figure and delivers it under a NEWER watermark.
    const { sessionDetailUpsert } = installDb({
      artifactId: PERSISTED_ARTIFACT_ID,
      sessionUpdatedAt: SESSION_UPDATED_AT,
      authoritativeCostUsd: new mocks.RecordingDecimal("5.000000"),
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({
          authoritativeCostUsd: 1.5,
          updatedAt: SESSION_UPDATED_AT_LATER.toISOString(),
        }),
      ])
    );

    for (const arm of upsertArms(sessionDetailUpsert.mock.calls[0][0])) {
      expect(decimalInput(arm.authoritativeCostUsd)).toBe("1.500000");
    }
  });

  it("lands a FIRST figure even when the delivery is stale", async () => {
    // Why the watermark gates the overwrite alone. OTel capture is gated on a
    // Labs setting, so a session can carry no figure for a long time and then
    // sync one from a slice the watermark calls stale. Gating the whole patch on
    // freshness would mean that row never receives a cost at all.
    const { sessionDetailUpsert } = installDb({
      artifactId: PERSISTED_ARTIFACT_ID,
      sessionUpdatedAt: SESSION_UPDATED_AT,
      authoritativeCostUsd: null,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({
          authoritativeCostUsd: REPORTED_COST_USD,
          updatedAt: SESSION_UPDATED_AT_EARLIER.toISOString(),
        }),
      ])
    );

    for (const arm of upsertArms(sessionDetailUpsert.mock.calls[0][0])) {
      expect(decimalInput(arm.authoritativeCostUsd)).toBe("12.500000");
    }
  });

  it("writes a REPORTED zero, which is a measurement rather than an absence", async () => {
    // `0` is falsy, so a guard written as `session.authoritativeCostUsd ? … : {}`
    // would drop it and silently turn "Claude charged nothing" into "Claude
    // reported nothing" — the same conflation the column's NULL semantics exist
    // to keep apart.
    const { sessionDetailUpsert } = installDb();

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession({ authoritativeCostUsd: 0 })])
    );

    for (const arm of upsertArms(sessionDetailUpsert.mock.calls[0][0])) {
      // Present and exactly zero — not omitted, not null.
      expect("authoritativeCostUsd" in arm).toBe(true);
      expect(decimalInput(arm.authoritativeCostUsd)).toBe("0.000000");
    }
  });

  /**
   * THE BOUNDARY where the guard and the value disagree.
   *
   * `canStoreAuthoritativeCostUsd` decides by rounding in JS, and the raw double
   * is a different number: the value below clears the guard — its nearest double
   * is `…99999493…`, so `toFixed(6)` gives `99999999.999999` — while the value
   * itself rounds half-up to `100000000.000000`, nine integer digits, which
   * `numeric(14, 6)` refuses with 22003.
   *
   * WHAT THIS PINS is the ARGUMENT, not a live 500, and the distinction is
   * measured rather than assumed: against a real column that raise fires when
   * the value arrives as text or as `float8`, and does NOT fire through Prisma's
   * typed Decimal path, which rounds to the field's declared scale before
   * transmitting. So this case guards the property that keeps it latent — the
   * figure the guard checked is the figure handed to the driver — instead of
   * leaving the guard's correctness resting on a rounding step in the client
   * that nothing in this repo asserts and no contract promises.
   *
   * A LITERAL, not a round number and not derived with the same `toFixed` the
   * production path uses: deriving it would assert that a call equals itself,
   * and any round number passes with or without the canonicalization.
   */
  it("hands the driver the six-place figure the guard admitted, not the raw double", async () => {
    const { sessionDetailUpsert } = installDb();

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([
        buildSyncedSession({ authoritativeCostUsd: 99_999_999.999_999_5 }),
      ])
    );

    for (const arm of upsertArms(sessionDetailUpsert.mock.calls[0][0])) {
      expect(decimalInput(arm.authoritativeCostUsd)).toBe("99999999.999999");
    }
  });
});

/**
 * The string a recording `Prisma.Decimal` stand-in was constructed with, or the
 * value itself when it is not one.
 *
 * Passing a non-Decimal THROUGH rather than asserting here is deliberate on two
 * counts: Biome's `noMisplacedAssertion` refuses an assertion outside a test
 * body, and a raw double returned unchanged still fails the caller's
 * string comparison — so the regression stays caught, in the case that owns it.
 */
function decimalInput(value: unknown): unknown {
  return value instanceof mocks.RecordingDecimal
    ? (value as { input: unknown }).input
    : value;
}
