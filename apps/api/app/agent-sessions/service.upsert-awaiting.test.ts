/**
 * FEA-3810: upsert awaitingInputSince invariant (both create and update arms).
 *
 * When the guarded status is terminal (e.g. `inactive`), the upsert must force
 * awaitingInputSince to null regardless of the incoming payload, on both the
 * create arm (new session) and the update arm (existing row).
 * When the guarded status is non-terminal, the incoming value is preserved.
 *
 * Covers the REAL upsert code path (service.ts) via mocked Prisma client — not
 * the pure predicate already covered by session-reopen.test.ts.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
  type SyncedAgentSessionAgent,
} from "@repo/api/src/types/agent-session";
import {
  LEGACY_WAITING_WIRE_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistedSessionDetail } from "@/__tests__/support/agent-sessions/service.test-harness";

// ---------------------------------------------------------------------------
// Module-level mock singletons (vi.hoisted so they're available to vi.mock
// factories before any app module is imported).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
  generateSlug: vi.fn().mockResolvedValue("SES-0001"),
  writeSessionArtifactMetadata: vi.fn(() => Promise.resolve(null)),
  captureCommittedSessionMetadata: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    SESSION: "SESSION",
  },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  Prisma: { DbNull: mocks.dbNull },
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: mocks.generateSlug,
}));

vi.mock("./service/session-ingest-metadata-activity", () => ({
  writeSessionArtifactMetadata: mocks.writeSessionArtifactMetadata,
  captureCommittedSessionMetadata: mocks.captureCommittedSessionMetadata,
}));

import { agentSessionsService } from "./service";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_STARTED_AT = new Date("2026-07-24T09:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-07-24T09:30:00.000Z");
const PERSISTED_ARTIFACT_ID = "artifact-awaiting-test-1";
const COMPUTE_TARGET_ID = "target-awaiting-1";
const ORG_ID = "org-awaiting-1";
const USER_ID = "user-awaiting-1";
const AWAITING_SINCE_ISO = "2026-07-24T10:00:00.000Z";
/** The payload's own activity clock — the synthesis tier's source. */
const LAST_ACTIVITY_ISO = "2026-07-24T09:45:00.000Z";
/** Strictly newer than the fixture's `sessionEndedAt`, so a reopen can fire. */
const REOPEN_EVENT_AT = new Date("2026-07-24T11:00:00.000Z");
/** ISS-8604: the anchor on the row a sweep deletes mid-apply. */
const SWEPT_ANCHOR = new Date("2026-07-19T07:00:00.000Z");
const SWEPT_AGENT_ID = "swept-agent";
const PAYLOAD_AGENT_ID = "payload-agent";
/** The revision a staged chunk sequence is assembling. */
const CHUNK_REVISION = 42;

function buildAgent(externalAgentId: string): SyncedAgentSessionAgent {
  return {
    externalAgentId,
    name: externalAgentId,
    type: "primary",
    status: SESSION_STATUS.ACTIVE,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an existing sessionDetail row that findUnique returns, with the given
 * persisted artifact status (controls which branch guardedStatus takes).
 */
function buildExistingRow(
  persistedArtifactStatus: string,
  awaitingInputSince: Date | null = null,
  agents: SyncedAgentSessionAgent[] = [],
  // ISS-8604: the staged chunk sequence the UPDATE arm's gate reads. Absent by
  // default, which is every case that is not about chunking.
  stagedChunkSequence: {
    pendingChunkRevision: number | null;
    pendingChunkTotal: number | null;
    pendingChunkReceived: number | null;
  } = {
    pendingChunkRevision: null,
    pendingChunkTotal: null,
    pendingChunkReceived: null,
  }
) {
  return {
    artifactId: PERSISTED_ARTIFACT_ID,
    agents,
    dataRevision: null,
    ...stagedChunkSequence,
    sessionStartedAt: SESSION_STARTED_AT,
    sessionUpdatedAt: SESSION_UPDATED_AT,
    sessionEndedAt: new Date("2026-07-24T09:15:00.000Z"),
    awaitingInputSince,
    artifact: { status: persistedArtifactStatus },
  };
}

function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "ext-sess-awaiting-1",
    name: "Awaiting Test Session",
    status: LEGACY_WAITING_WIRE_STATUS,
    harness: "claude",
    cwd: "/tmp/project",
    model: "claude-sonnet-4",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    awaitingInputSince: AWAITING_SINCE_ISO,
    ...overrides,
  };
}

function buildPayload(session: SyncedAgentSession) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-awaiting-1",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [session],
  };
}

function buildContext() {
  return {
    organizationId: ORG_ID,
    userId: USER_ID,
    computeTargetId: COMPUTE_TARGET_ID,
  };
}

/**
 * Install a minimal transaction-level DB mock that drives the upsertSessions
 * path to the sessionDetail.upsert call. The session carries no artifactRefs,
 * prRefs, or attribution so the branch/PR/project resolution lanes are no-ops.
 * No events are supplied so maxEventCreatedAt is null, which prevents the
 * maybeReopenTerminalSession path from firing.
 *
 * When `existingRow` is null the create arm fires (slug generation is mocked
 * at module level via `mocks.generateSlug`).
 */
function installDb(existingRow: ReturnType<typeof buildExistingRow> | null) {
  const sessionDetailUpsert = vi
    .fn()
    .mockResolvedValue(persistedSessionDetail(PERSISTED_ARTIFACT_ID));
  const sessionDetailUpdate = vi.fn().mockResolvedValue({});

  const db = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([{ toolUseCount: 0n, errorCount: 0n }]),
    // FEA-4022: the pre-transaction frustration gate read (isFrustrationEnabled)
    // hits organization.findUnique. This suite does not opt in, so return an
    // org with no settings → gate defaults off and the frustration lane is a
    // no-op for these awaitingInputSince assertions.
    organization: {
      findUnique: vi.fn().mockResolvedValue({ settings: null }),
    },
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: COMPUTE_TARGET_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    // No attribution → resolveProjectResolution skips artifact.findMany.
    // No artifactRefs → resolveArtifactSlugMap and resolveSessionRepositoryIdentity are
    // no-ops and never call gitHubInstallation or artifact.findMany.
    sessionDetail: {
      // ISS-5981 (#5018 review): HONOR the `select`, do not ignore it. A mock
      // that returns the whole fixture regardless makes the production `select`
      // clause untestable — deleting `awaitingInputSince: true` from it would
      // leave every assertion below green while the stored-anchor tier silently
      // no-ops against real Prisma (`existing.awaitingInputSince === undefined`).
      findUnique: vi.fn(({ select }: { select?: Record<string, unknown> }) =>
        Promise.resolve(selectColumns(existingRow, select))
      ),
      upsert: sessionDetailUpsert,
      update: sessionDetailUpdate,
    },
    // The reopen arm writes through `artifact.update`; the ordinary upsert path
    // never touches this delegate. Mocked rather than guarded in production —
    // `apps/api/AGENTS.md` treats a missing required delegate as a mock gap.
    artifact: {
      update: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: {
      count: vi.fn().mockResolvedValue(0),
      // maxEventCreatedAt: null → shouldReopenSession returns false, EXCEPT
      // where a test overrides this to exercise the reopen path.
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
    sessionTranscript: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };

  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );

  return { db, sessionDetailUpsert, sessionDetailUpdate };
}

/**
 * Project `row` down to the columns a Prisma `select` asked for, so the mock
 * cannot hand production a field it never requested. A nested `select` (the
 * `artifact` relation) recurses; `undefined` means "no select", i.e. the whole
 * row, which matches Prisma.
 */
function selectColumns(
  row: Record<string, unknown> | null,
  select?: Record<string, unknown>
): Record<string, unknown> | null {
  if (row === null || select === undefined) {
    return row;
  }
  const projected: Record<string, unknown> = {};
  for (const [column, requested] of Object.entries(select)) {
    if (!requested) {
      continue;
    }
    const value = row[column];
    projected[column] =
      typeof requested === "object" && value !== null
        ? selectColumns(
            value as Record<string, unknown>,
            (requested as { select?: Record<string, unknown> }).select
          )
        : value;
  }
  return projected;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("upsertSessions — FEA-3810 awaitingInputSince invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forces awaitingInputSince to null when the persisted status is terminal (abandoned)", async () => {
    const existingRow = buildExistingRow(SESSION_STATUS.INACTIVE);
    const { sessionDetailUpsert } = installDb(existingRow);

    const session = buildSyncedSession({
      status: LEGACY_WAITING_WIRE_STATUS,
      awaitingInputSince: AWAITING_SINCE_ISO,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    expect(sessionDetailUpsert).toHaveBeenCalledOnce();
    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    expect(upsertArg.update.awaitingInputSince).toBeNull();
  });

  it("preserves the incoming awaitingInputSince when the persisted status is non-terminal (active)", async () => {
    const existingRow = buildExistingRow(SESSION_STATUS.ACTIVE);
    const { sessionDetailUpsert } = installDb(existingRow);

    const session = buildSyncedSession({
      status: SESSION_STATUS.ACTIVE,
      awaitingInputSince: AWAITING_SINCE_ISO,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    expect(sessionDetailUpsert).toHaveBeenCalledOnce();
    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    expect(upsertArg.update.awaitingInputSince).toEqual(
      new Date(AWAITING_SINCE_ISO)
    );
  });

  it("forces awaitingInputSince to null on the CREATE arm when the incoming status is terminal (abandoned)", async () => {
    const { sessionDetailUpsert } = installDb(null);

    const session = buildSyncedSession({
      status: SESSION_STATUS.INACTIVE,
      awaitingInputSince: AWAITING_SINCE_ISO,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    expect(sessionDetailUpsert).toHaveBeenCalledOnce();
    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    expect(upsertArg.create.awaitingInputSince).toBeNull();
  });
});

/*
 * ISS-5981: the ingest now folds `waiting` to `active`, so the WORD no longer
 * reaches the column and the TIMESTAMP is the awaiting-input signal's only
 * durable form. These pin that the fold does not take the signal with it.
 *
 * The wire schema declares `awaitingInputSince` as `.nullable().optional()`, so
 * a version-skewed desktop can legitimately send `waiting` with no timestamp —
 * that payload is the whole reason this resolution exists.
 */
describe("upsertSessions — ISS-5981 awaiting anchor survives the waiting fold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores the folded ACTIVE status but keeps the declared anchor", async () => {
    const { sessionDetailUpsert } = installDb(null);

    const session = buildSyncedSession({
      status: LEGACY_WAITING_WIRE_STATUS,
      awaitingInputSince: AWAITING_SINCE_ISO,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    // Both halves matter: the word is gone AND the signal survived. Asserting
    // only the status would pass while the run silently stopped reading Waiting.
    expect(upsertArg.create.artifact.create.status).toBe(SESSION_STATUS.ACTIVE);
    expect(upsertArg.create.awaitingInputSince).toEqual(
      new Date(AWAITING_SINCE_ISO)
    );
  });

  it("falls back to the STORED anchor when a `waiting` payload declares none", async () => {
    // The failure this prevents: the update arm rewrites this column on every
    // sync. With no stored fallback the rewrite is a null, and a run blocked for
    // three days loses its anchor on the very next batch. (ISS-8604 scoped the
    // stored tier to this arm; the create arm's is asserted further down.)
    const storedAnchor = new Date("2026-07-20T08:00:00.000Z");
    const existingRow = buildExistingRow(SESSION_STATUS.ACTIVE, storedAnchor);
    const { sessionDetailUpsert } = installDb(existingRow);

    const session = buildSyncedSession({
      status: LEGACY_WAITING_WIRE_STATUS,
      awaitingInputSince: null,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    expect(upsertArg.update.awaitingInputSince).toEqual(storedAnchor);
  });

  it("prefers the DECLARED anchor over the stored one", async () => {
    // Precedence, not just presence: the producer's own timestamp wins, so a run
    // that asked again is re-anchored rather than pinned to its first ask.
    const storedAnchor = new Date("2026-07-20T08:00:00.000Z");
    const existingRow = buildExistingRow(SESSION_STATUS.ACTIVE, storedAnchor);
    const { sessionDetailUpsert } = installDb(existingRow);

    const session = buildSyncedSession({
      status: LEGACY_WAITING_WIRE_STATUS,
      awaitingInputSince: AWAITING_SINCE_ISO,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    expect(upsertArg.update.awaitingInputSince).toEqual(
      new Date(AWAITING_SINCE_ISO)
    );
  });

  // #5018 review: the STORED tier cannot cover a FIRST sync — there is no row to
  // read — and this is the payload the tolerance exists for. Pre-ISS-5981 the
  // column held the word `waiting` and the badge came from that; folding to
  // `active` with a null anchor would drop the signal entirely.
  it("synthesizes an anchor on the CREATE arm when a `waiting` payload declares none", async () => {
    const { sessionDetailUpsert } = installDb(null);

    const session = buildSyncedSession({
      status: LEGACY_WAITING_WIRE_STATUS,
      awaitingInputSince: null,
      lastActivityAt: LAST_ACTIVITY_ISO,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    expect(upsertArg.create.artifact.create.status).toBe(SESSION_STATUS.ACTIVE);
    expect(upsertArg.create.awaitingInputSince).toEqual(
      new Date(LAST_ACTIVITY_ISO)
    );
  });

  // #5018 review: the pre-ISS-5981 stored-`waiting` population was written with
  // a NULL anchor precisely because the word carried the signal. Its next sync
  // rewrites the status to `active`, so without a synthesis tier those rows drop
  // out of the Waiting facet — a read-visible migration this fold must not make.
  it("synthesizes an anchor for a legacy stored-`waiting` row that has none", async () => {
    const existingRow = buildExistingRow(LEGACY_WAITING_WIRE_STATUS, null);
    const { sessionDetailUpsert } = installDb(existingRow);

    const session = buildSyncedSession({
      status: LEGACY_WAITING_WIRE_STATUS,
      awaitingInputSince: null,
      lastActivityAt: LAST_ACTIVITY_ISO,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    expect(upsertArg.update.awaitingInputSince).toEqual(
      new Date(LAST_ACTIVITY_ISO)
    );
  });

  /*
   * #5018 review: the REOPEN arm is the third place the anchor can be lost, and
   * the only one no ingest-level test reached — the harness nulls
   * `maxEventCreatedAt` everywhere else so the reopen never fires.
   *
   * It is also where the fold did the most damage. `maybeReopenTerminalSession`
   * reads the incoming status TWICE — once to decide whether to reopen at all,
   * once to decide whether to synthesize an anchor — and both reads want the RAW
   * spelling. These two tests pin each read against the production path.
   */
  it("anchors a reopened `waiting` run that declares none to the reopening event", async () => {
    // A reopen candidate is terminal by definition, and every writer nulls the
    // anchor on a terminal row — so the STORED tier is structurally empty here
    // and only the reopen's own synthesis can supply a value.
    const existingRow = buildExistingRow(SESSION_STATUS.INACTIVE, null);
    const { db, sessionDetailUpdate } = installDb(existingRow);
    // `maxEventCreatedAt` comes from the counts query in
    // `persistSessionChildren`, not from `agentSessionEvent.aggregate`.
    db.$queryRawUnsafe = vi.fn().mockResolvedValue([
      {
        toolUseCount: 0n,
        errorCount: 0n,
        maxEventCreatedAt: REOPEN_EVENT_AT,
      },
    ]);

    const session = buildSyncedSession({
      status: LEGACY_WAITING_WIRE_STATUS,
      awaitingInputSince: null,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    expect(sessionDetailUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sessionEndedAt: null,
          awaitingInputSince: REOPEN_EVENT_AT,
        }),
      })
    );
  });

  it("does NOT reopen when the STORED status is one this build cannot read", async () => {
    // ISS-5592 / code review #5156: the STORED-status axis, which nothing drove
    // until now. `toReopenPersistedStatus` folds the raw column at the read
    // boundary, and an unmodelled spelling fail-opens to `active` -- which is
    // NOT terminal, so there is nothing to reopen and the predicate refuses.
    //
    // This exists because a unit case feeding that spelling to the predicate is
    // no longer possible (the field is typed `SessionStatus`), and the comment
    // that deleted it claimed the coverage had moved here when it had not.
    // Driving the real upsert is the only place the fold is observable.
    const existingRow = buildExistingRow("some-unmodelled-spelling", null);
    const { db, sessionDetailUpsert, sessionDetailUpdate } =
      installDb(existingRow);
    db.$queryRawUnsafe = vi.fn().mockResolvedValue([
      {
        toolUseCount: 0n,
        errorCount: 0n,
        maxEventCreatedAt: REOPEN_EVENT_AT,
      },
    ]);

    const session = buildSyncedSession({
      status: SESSION_STATUS.ACTIVE,
      awaitingInputSince: null,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    // `sessionDetail.update` is reached ONLY from the reopen (session-reopen.ts);
    // the ordinary write goes through `sessionDetail.upsert`. So "update was not
    // called" IS "the reopen did not fire" (tamsinb, #5156).
    //
    // Asserting the upsert DID run first is what keeps this from passing
    // vacuously: an earlier draft looped over `update`'s calls and asserted on
    // each, which proves nothing when the list is empty — it would have stayed
    // green if the whole ingest had failed to execute.
    expect(sessionDetailUpsert).toHaveBeenCalled();
    expect(sessionDetailUpdate).not.toHaveBeenCalled();
  });

  it("does NOT reopen a terminal run for an unmodelled incoming status", async () => {
    // `shouldReopenSession` admits only a RAW `active`/`waiting`, which is what
    // keeps an unmodelled spelling from resurrecting a finished run. Folding
    // before that predicate would deliver `active` and reopen it — clearing
    // `sessionEndedAt` and restarting the run's duration.
    const existingRow = buildExistingRow(SESSION_STATUS.INACTIVE, null);
    const { db, sessionDetailUpdate } = installDb(existingRow);
    db.$queryRawUnsafe = vi.fn().mockResolvedValue([
      {
        toolUseCount: 0n,
        errorCount: 0n,
        maxEventCreatedAt: REOPEN_EVENT_AT,
      },
    ]);

    const session = buildSyncedSession({
      status: "brand-new-status",
      awaitingInputSince: null,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    // The reopen writes through `sessionDetail.update`; the ordinary upsert does
    // not. So no such call is the observable proof the run stayed terminal.
    expect(sessionDetailUpdate).not.toHaveBeenCalled();
  });

  it("clears a stale anchor when a NON-waiting payload declares none", async () => {
    // The stored fallback is scoped to `waiting` on purpose. A payload that no
    // longer claims to be awaiting input must be able to clear the column —
    // otherwise a resumed run would report Waiting forever.
    const storedAnchor = new Date("2026-07-20T08:00:00.000Z");
    const existingRow = buildExistingRow(SESSION_STATUS.ACTIVE, storedAnchor);
    const { sessionDetailUpsert } = installDb(existingRow);

    const session = buildSyncedSession({
      status: SESSION_STATUS.ACTIVE,
      awaitingInputSince: null,
    });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(session)
    );

    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    expect(upsertArg.update.awaitingInputSince).toBeNull();
  });
});

/*
 * ISS-8604: the CREATE arm's residue from the READ COMMITTED delete race.
 *
 * Which arm the upsert takes is decided by the DATABASE, not by the pre-upsert
 * `existing` read. `acquireSessionAdvisoryLocks` serializes every concurrent
 * INGEST writer for one `externalSessionId`, so the racer here is a deleter
 * that does not take that lock (retention, phantom retention): it commits
 * between the read and the upsert, and Postgres then takes the CREATE arm while
 * this apply still holds a snapshot of a row that no longer exists.
 *
 * `installDb(existingRow)` reproduces exactly that state — the finder returns a
 * row, and BOTH arms of the single upsert call are inspected. The create arm's
 * object is what Postgres would write had the row been swept; the update arm's
 * is what it writes when the row survives. Asserting both in one call is the
 * point: it pins that the arms disagree BY DESIGN here, rather than that a
 * guard was removed from the arm that still needs it.
 *
 * WHAT THESE DO NOT COVER, and where that coverage lives (review, whitlockk). This
 * mock never makes a database CHOOSE an arm: it asserts the object handed to
 * Prisma, so it cannot show that the read → delete → upsert ordering actually
 * lands on the create arm, nor what the created ROW then holds. That is
 * `session-create-arm-race.integration.test.ts`, which commits the sweep inside
 * the slice's read-write window against real Postgres and reads the persisted
 * row back. Read these as the per-column argument and that one as the proof.
 *
 * These cover the values whose CONTENT came off the deleted row — `metadata`'s
 * withheld-key merge is the fourth and is covered against the store in the
 * integration suite named above. The columns that only DECLINE against the stale
 * read — the token rollup, `estimatedCost`, `authoritativeCostUsd`, frustration,
 * `endsWithError`, the trace-duration triple, the tiling strip —
 * are deliberately still shared: ISS-8515 chose that suppression for this same
 * race, and splitting it needs ISS-8619's phase split because the post-upsert
 * `persistSessionChildren` shares the flag. The PR lanes are the exception and
 * are NOT in that bound (`pullRequests` here, the link lane in
 * `create-arm-race-repair.ts`) — a suppressed column is one the next fresher
 * batch simply writes, while a skipped PR link is an absence nothing recreates.
 */
describe("upsertSessions — ISS-8604 create-arm race residue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps a created row's awaiting anchor agreeing with the status it writes", async () => {
    // The residue named at the ISS-5648 create-arm comment: the read saw a
    // TERMINAL row, so the shared `detailData` nulled the anchor off
    // `guardedStatus` — while the create arm writes the INCOMING status. A row
    // born from this race read `active` carrying no awaiting timestamp, so a
    // `waiting` run was created already invisible to the Waiting facet.
    const existingRow = buildExistingRow(SESSION_STATUS.INACTIVE, SWEPT_ANCHOR);
    const { sessionDetailUpsert } = installDb(existingRow);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(
        buildSyncedSession({
          status: LEGACY_WAITING_WIRE_STATUS,
          awaitingInputSince: null,
          lastActivityAt: LAST_ACTIVITY_ISO,
        })
      )
    );

    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    expect(upsertArg.create.artifact.create.status).toBe(SESSION_STATUS.ACTIVE);
    expect(upsertArg.create.awaitingInputSince).toEqual(
      new Date(LAST_ACTIVITY_ISO)
    );
    expect(mocks.writeSessionArtifactMetadata).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        artifactId: PERSISTED_ARTIFACT_ID,
        status: SESSION_STATUS.INACTIVE,
      })
    );
    expect(upsertArg.update.awaitingInputSince).toBeNull();
  });

  it("does not seed a created row's anchor from the swept row's anchor", async () => {
    // The second residue path, with terminal-wins out of the picture: the STORED
    // tier of `resolveIngestAwaitingInputSince`. Reading a swept row's anchor
    // onto a brand-new row backdates "asked at" to a run this row never had.
    const existingRow = buildExistingRow(SESSION_STATUS.ACTIVE, SWEPT_ANCHOR);
    const { sessionDetailUpsert } = installDb(existingRow);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(
        buildSyncedSession({
          status: LEGACY_WAITING_WIRE_STATUS,
          awaitingInputSince: null,
          lastActivityAt: LAST_ACTIVITY_ISO,
        })
      )
    );

    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    // The SYNTHESIZED tier, which is what a first delivery is entitled to.
    expect(upsertArg.create.awaitingInputSince).toEqual(
      new Date(LAST_ACTIVITY_ISO)
    );
    // Same call: the stored tier is untouched for the row that survives.
    expect(upsertArg.update.awaitingInputSince).toEqual(SWEPT_ANCHOR);
  });

  it("does not stamp a created row with the swept row's chunk-sequence count", async () => {
    // The quiet half of the ack residue. The stored row is mid-sequence at
    // `(42, total 3, received 1)`; chunk 1 of 3 arrives. The shared gate reads
    // that marker off the swept row and emits `pendingChunkReceived: 2` while
    // omitting the revision and total, so a created row carried a contiguous
    // count for a sequence it has no identity for. The loud half — the FINAL
    // chunk committing `dataRevision` onto a one-chunk row — is proven against
    // the store in `session-create-arm-race.integration.test.ts`.
    const existingRow = buildExistingRow(SESSION_STATUS.ACTIVE, null, [], {
      pendingChunkRevision: CHUNK_REVISION,
      pendingChunkTotal: 3,
      pendingChunkReceived: 1,
    });
    const { sessionDetailUpsert } = installDb(existingRow);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(
        buildSyncedSession({
          status: SESSION_STATUS.ACTIVE,
          dataRevision: CHUNK_REVISION,
          chunk: { index: 1, total: 3 },
        })
      )
    );

    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    // A row with no sequence in flight and no committed revision, which is what
    // a first delivery of chunk 1 is entitled to say.
    expect(upsertArg.create).toMatchObject({
      dataRevision: null,
      pendingChunkRevision: null,
      pendingChunkTotal: null,
      pendingChunkReceived: null,
    });
    // Same call: the surviving row still advances its own staged sequence.
    expect(upsertArg.update.pendingChunkReceived).toBe(2);
    expect(upsertArg.update.dataRevision).toBeUndefined();
  });

  it("does not seed a created row's roster from the swept row's agents", async () => {
    // The payload carries no `dataRevision`, so the chunk gate does not entitle
    // it to delete-replace and the shared roster takes the MERGE path — the one
    // that reads `existing.agents`. A created row inherited agents whose events
    // went with the deleted row, and `agentCount` counted them.
    const existingRow = buildExistingRow(SESSION_STATUS.ACTIVE, null, [
      buildAgent(SWEPT_AGENT_ID),
    ]);
    const { sessionDetailUpsert } = installDb(existingRow);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload(
        buildSyncedSession({
          status: SESSION_STATUS.ACTIVE,
          agents: [buildAgent(PAYLOAD_AGENT_ID)],
        })
      )
    );

    const upsertArg = sessionDetailUpsert.mock.calls[0][0];
    expect(
      upsertArg.create.agents.map(
        (agent: SyncedAgentSessionAgent) => agent.externalAgentId
      )
    ).toEqual([PAYLOAD_AGENT_ID]);
    expect(upsertArg.create.agentCount).toBe(1);
    // Same call: the surviving row still MERGES, so an additive delivery cannot
    // drop an agent it did not carry.
    expect(
      upsertArg.update.agents.map(
        (agent: SyncedAgentSessionAgent) => agent.externalAgentId
      )
    ).toEqual([SWEPT_AGENT_ID, PAYLOAD_AGENT_ID]);
    expect(upsertArg.update.agentCount).toBe(2);
  });
});
