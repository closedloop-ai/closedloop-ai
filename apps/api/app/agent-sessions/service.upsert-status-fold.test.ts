/**
 * ISS-5648: the cloud ingest folds the RETIRED session statuses before they
 * reach `artifacts.status`.
 *
 * ISS-4654's backfill collapsed the stored `completed`/`abandoned` rows once,
 * but the ingest stored the client's status verbatim, so a version-skewed
 * Desktop build (pre-#4092 producer) re-introduced the spelling on its next
 * sync. Gate 3 ("no live rows carry completed/abandoned") therefore could not
 * stay met by backfilling alone.
 *
 * Covers the REAL upsert code path (service.ts) through the shared
 * agent-sessions harness: the create arm, the update arm, and the terminal-wins
 * arm where the value being written comes off the PERSISTED row rather than the
 * payload. The narrow fold's preserved cases (`waiting`, unrecognized) are
 * asserted here too, because folding them would persist a lifecycle claim the
 * payload never made.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";
import { SessionSyncMetric } from "./service/session-sync-metrics";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

import { agentSessionsService } from "./service";

const PERSISTED_ARTIFACT_ID = "persisted-session-1";
const UNRECOGNIZED_STATUS = "brand-new-status";

const CONTEXT = {
  organizationId: "org-1",
  userId: "user-1",
  computeTargetId: "target-1",
};

/**
 * The persisted row `sessionDetail.findUnique` returns, carrying the artifact
 * status that decides which `resolveGuardedStatus` branch the apply takes.
 */
function buildExistingRow(persistedArtifactStatus: string) {
  return {
    artifactId: PERSISTED_ARTIFACT_ID,
    agents: [],
    dataRevision: null,
    sessionStartedAt: SESSION_STARTED_AT,
    sessionUpdatedAt: SESSION_UPDATED_AT,
    sessionEndedAt: null,
    artifact: { status: persistedArtifactStatus },
  };
}

function buildPayload(...sessions: SyncedAgentSession[]) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba010",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

/**
 * Drive one apply and report the status each upsert arm would write. The
 * session carries no artifactRefs, prRefs, or attribution, so the branch/PR and
 * project lanes are no-ops, and no events are supplied so `maxEventCreatedAt`
 * is null and the reopen path cannot fire.
 */
async function upsertAndReadStatuses(
  existingRow: ReturnType<typeof buildExistingRow> | null,
  incomingStatus: string
): Promise<{ create: unknown; update: unknown }> {
  const upsert = vi
    .fn()
    .mockResolvedValue({ artifactId: PERSISTED_ARTIFACT_ID });

  installDb({
    slugCounter: buildSlugCounterMock(),
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue(existingRow),
      upsert,
      update: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: buildDefaultAgentSessionEventMocks(),
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  });

  await agentSessionsService.upsertSessions(
    CONTEXT,
    buildPayload(buildSyncedSession({ status: incomingStatus }))
  );

  // A THROW rather than an `expect`: an assertion inside a helper is a lint
  // violation, and — more to the point — reaching here without exactly one
  // upsert means the harness never drove the path under test. That is a setup
  // failure, not a failed expectation.
  if (upsert.mock.calls.length !== 1) {
    throw new Error(
      `expected exactly one sessionDetail.upsert, saw ${upsert.mock.calls.length}`
    );
  }
  const upsertArg = upsert.mock.calls[0][0];
  return {
    create: upsertArg.create.artifact.create.status,
    update: upsertArg.update.artifact.update.status,
  };
}

/**
 * Drive one apply over a MULTI-session payload — the shape the ingest schema
 * still accepts for version skew, and the one the fold counter is aggregated
 * over. Every session is new (`findUnique` → null), so each takes the create arm
 * independently.
 */
async function upsertBatch(
  incomingStatuses: string[],
  options: { failAfterFirstSlice?: Error } = {}
): Promise<void> {
  installDb({
    slugCounter: buildSlugCounterMock(),
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ artifactId: PERSISTED_ARTIFACT_ID }),
      update: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: buildDefaultAgentSessionEventMocks(),
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  });

  if (options.failAfterFirstSlice) {
    // The FIRST slice commits through the real harness path so its fold is
    // genuinely recorded; the second transaction then fails, which is the
    // partial-batch shape the `finally` emission exists for.
    const realTx = mocks.withDb.tx.getMockImplementation();
    if (!realTx) {
      // A setup failure, not a failed expectation: without the harness's own
      // implementation the first slice never runs and the test proves nothing.
      throw new Error("installDb did not install a withDb.tx implementation");
    }
    mocks.withDb.tx
      .mockImplementationOnce(realTx)
      .mockRejectedValueOnce(options.failAfterFirstSlice);
  }

  await agentSessionsService.upsertSessions(
    CONTEXT,
    buildPayload(
      ...incomingStatuses.map((status, index) =>
        buildSyncedSession({ externalSessionId: `sess-${index}`, status })
      )
    )
  );
}

/*
 * ISS-5981: the fold's fail-open branch is a coercion of a value this build
 * cannot interpret, so the root `AGENTS.md` rule on bad data requires it reach a
 * monitor rather than being absorbed. Before the total fold it was
 * self-reporting — the raw spelling stayed on the column and rendered "Unknown".
 *
 * These pin that it is counted, that it is counted SEPARATELY from the retired
 * drain gate, and that it is aggregated per batch rather than per row.
 */
/*
 * ISS-5981: the ingest's persist fold, asserted through the real service.
 *
 * These five contracts were deleted alongside the retired-status describe during
 * ISS-5592 and had nothing to do with `completed`/`abandoned` — they pin the
 * TOTAL fold and the create/update arm split, both still live. Restored here,
 * retargeted off the retired spellings, after the review found every one of them
 * absent from the repo with no replacement.
 *
 * `statuses.update` is read here and nowhere else: it is the only assertion that
 * the service runs the PERSISTED status through `resolveGuardedStatus` and writes
 * the guarded value on the update arm.
 */
describe("upsertSessions — ISS-5981 persist fold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("folds an incoming `waiting` to ACTIVE instead of storing the word", async () => {
    const statuses = await upsertAndReadStatuses(
      null,
      DISPLAYED_SESSION_STATUS.WAITING
    );

    expect(statuses.create).toBe(SESSION_STATUS.ACTIVE);
  });

  it("folds an UNRECOGNIZED status to ACTIVE instead of storing it verbatim", async () => {
    const statuses = await upsertAndReadStatuses(null, UNRECOGNIZED_STATUS);

    expect(statuses.create).toBe(SESSION_STATUS.ACTIVE);
  });

  it("leaves an already-canonical status untouched", async () => {
    const statuses = await upsertAndReadStatuses(null, SESSION_STATUS.INACTIVE);

    expect(statuses.create).toBe(SESSION_STATUS.INACTIVE);
  });

  it("still lets a terminal row win over a non-terminal incoming status", async () => {
    // FEA-3477 D4, driven through the service rather than the unit: the persisted
    // ERROR must survive a late non-terminal retry on the UPDATE arm...
    const statuses = await upsertAndReadStatuses(
      buildExistingRow(SESSION_STATUS.ERROR),
      SESSION_STATUS.ACTIVE
    );

    expect(statuses.update).toBe(SESSION_STATUS.ERROR);
    // ...while the CREATE arm still uses the INCOMING status, never the persisted
    // one — the delete-race split, in the same drive.
    expect(statuses.create).toBe(SESSION_STATUS.ACTIVE);
  });
});

describe("upsertSessions — ISS-5981 unmodelled-status telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts a spelling this build does not model", async () => {
    const statuses = await upsertAndReadStatuses(null, UNRECOGNIZED_STATUS);

    // Proves the fold actually rewrote it, so the emission below is about a
    // real coercion rather than a status that passed through untouched.
    expect(statuses.create).toBe(SESSION_STATUS.ACTIVE);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.UnmodelledStatusFolded,
        organizationId: CONTEXT.organizationId,
        computeTargetId: CONTEXT.computeTargetId,
        count: 1,
      })
    );
  });

  it.each([
    ["a canonical status", SESSION_STATUS.ACTIVE],
    ["the waiting display spelling", DISPLAYED_SESSION_STATUS.WAITING],
  ])("stays silent for %s", async (_, status) => {
    await upsertAndReadStatuses(null, status);

    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.UnmodelledStatusFolded,
      })
    );
  });

  it.each([
    "completed",
    "abandoned",
    // ISS-5592 (2026-08-15) retired these two ALIASES the same way, once the
    // desktop stopped manufacturing `failed`. A producer still sending either
    // is now visible on the same counter instead of being silently accepted.
    "running",
    "failed",
  ])("counts the unmodelled spelling %s now that nothing folds it", async (retired) => {
    // ISS-5592 removed the retired fold AND its `RetiredStatusFolded` drain
    // metric. This is what replaces that signal: the spelling is unrecognized,
    // so it takes the fail-open branch and is counted here WITH its raw text in
    // the samples — a straggler producer stays visible, under one metric.
    await upsertAndReadStatuses(null, retired);

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.UnmodelledStatusFolded,
        unmodelledStatusSamples: [retired],
      })
    );
  });

  it("carries the raw spellings so the documented fix is actionable", async () => {
    // wongk (#5047): the counter alone says skew is happening but not WHICH
    // spelling a producer is sending, so it cannot be acted on. ISS-5592
    // deleted the alias map the original note named as the place to add one —
    // the actionable response now is to fix the producer, which still needs the
    // raw word.
    await upsertBatch([UNRECOGNIZED_STATUS, "another-unmodelled-status"]);

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.UnmodelledStatusFolded,
        unmodelledStatusSamples: expect.arrayContaining([
          UNRECOGNIZED_STATUS,
          "another-unmodelled-status",
        ]),
      })
    );
  });

  it("bounds the samples — caller-supplied text cannot grow the log", async () => {
    // `session.status` is `z.string().trim().min(1)` with NO `.max()`, so both
    // dimensions are attacker-controlled: how many distinct spellings a batch
    // carries, and how long each one is. Eight distinct, one of them very long.
    const longStatus = `x${"y".repeat(500)}`;
    await upsertBatch([
      longStatus,
      ...Array.from({ length: 7 }, (_, index) => `unmodelled-${index}`),
    ]);

    const emission = mocks.emitTelemetryMetric.mock.calls
      .map((call) => call[0])
      .find(
        (candidate) =>
          candidate?.metric === SessionSyncMetric.UnmodelledStatusFolded
      );
    // The COUNT is unbounded on purpose — it is a number, and it is the signal.
    expect(emission.count).toBe(8);
    expect(emission.unmodelledStatusSamples.length).toBeLessThanOrEqual(5);
    for (const sample of emission.unmodelledStatusSamples) {
      expect(sample.length).toBeLessThanOrEqual(64);
    }
  });

  it("dedupes repeated spellings so one fleet does not fill the samples", async () => {
    await upsertBatch([
      UNRECOGNIZED_STATUS,
      UNRECOGNIZED_STATUS,
      UNRECOGNIZED_STATUS,
    ]);

    const emission = mocks.emitTelemetryMetric.mock.calls
      .map((call) => call[0])
      .find(
        (candidate) =>
          candidate?.metric === SessionSyncMetric.UnmodelledStatusFolded
      );
    expect(emission.count).toBe(3);
    expect(emission.unmodelledStatusSamples).toEqual([UNRECOGNIZED_STATUS]);
  });

  it("omits the samples field entirely when nothing was unmodelled", async () => {
    await upsertAndReadStatuses(null, SESSION_STATUS.ACTIVE);

    const emissions = mocks.emitTelemetryMetric.mock.calls.map(
      (call) => call[0]
    );
    for (const emission of emissions) {
      expect(emission).not.toHaveProperty("unmodelledStatusSamples");
    }
  });

  it("emits ONCE per batch with the aggregate count", async () => {
    // `apps/api/AGENTS.md` ("Emission and Abuse Control"): the schema accepts up
    // to 200 sessions per request, so a per-row emit on this authenticated path
    // is an amplification vector. The count stays additive.
    await upsertBatch([
      UNRECOGNIZED_STATUS,
      SESSION_STATUS.ACTIVE,
      "another-unmodelled-status",
    ]);

    const emissions = mocks.emitTelemetryMetric.mock.calls
      .map((call) => call[0])
      .filter(
        (emission) =>
          emission?.metric === SessionSyncMetric.UnmodelledStatusFolded
      );
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toEqual(expect.objectContaining({ count: 2 }));
  });

  it("still reports the committed slices when a later one rejects", async () => {
    // The emission lives in a `finally`, and this is the only case that proves
    // it (wongk, #5075). The partial-batch case was covered against
    // `RetiredStatusFolded` and went with it; without a replacement, moving the
    // emit below the loop would silently drop telemetry for slices that DID
    // commit, and every other test here would stay green because their batches
    // never fail.
    await expect(
      upsertBatch([UNRECOGNIZED_STATUS, UNRECOGNIZED_STATUS], {
        failAfterFirstSlice: new Error("second slice rejected"),
      })
    ).rejects.toThrow("second slice rejected");

    const emissions = mocks.emitTelemetryMetric.mock.calls
      .map((call) => call[0])
      .filter(
        (emission) =>
          emission?.metric === SessionSyncMetric.UnmodelledStatusFolded
      );
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toEqual(expect.objectContaining({ count: 1 }));
  });
});
