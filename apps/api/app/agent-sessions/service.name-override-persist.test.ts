/**
 * ISS-8733 (review: davetho): the `nameOverride` a sync actually writes.
 *
 * `resolveNameOverridePatch`'s own unit tests prove the PRECEDENCE. This proves
 * the WIRING — that the slice keeps the seed out of the upsert's two arms and
 * issues it as its own write, and that the write carries the `nameOverride:
 * null` qualifier that is what actually refuses to overwrite the owner's rename
 * (ISS-8732 review: davetho, PR #6618 — a pre-read cannot, since
 * `sessionRenameService` shares no advisory lock with the sync transaction).
 *
 * Bounded on purpose: a DB-less harness cannot exercise a SQL predicate, so what
 * it pins is that the predicate is PRESENT. That the predicate then holds under
 * an interleaving is `session-rename.integration.test.ts`, against real Postgres.
 *
 * Same DB-less harness as the sibling `service.degraded-metadata-persist.test.ts`,
 * driving the REAL `upsertSessions` → `upsertSessionSlice`.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { SessionMetadataActivityField } from "@repo/api/src/types/artifact-activity";
import { Priority } from "@repo/api/src/types/common";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistedSessionDetail } from "@/__tests__/support/agent-sessions/service.test-harness";

const mocks = vi.hoisted(() => ({
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
  generateSlug: vi.fn().mockResolvedValue("SES-0003"),
  captureMetadataSeed: vi.fn(),
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

vi.mock("@/lib/artifact-activity-recording", () => ({
  captureSystemSessionMetadataChange: mocks.captureMetadataSeed,
}));

vi.mock("./service/session-ingest-metadata-activity", () => ({
  writeSessionArtifactMetadata: vi.fn().mockResolvedValue(null),
  captureCommittedSessionMetadata: vi.fn(),
}));

import { agentSessionsService } from "./service";

const SESSION_STARTED_AT = new Date("2026-09-01T09:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-09-01T09:30:00.000Z");
const PERSISTED_ARTIFACT_ID = "artifact-name-override-1";
const COMPUTE_TARGET_ID = "target-name-override-1";
const ORG_ID = "org-name-override-1";
const USER_ID = "user-name-override-1";
const EXTERNAL_SESSION_ID = "ext-sess-name-override-1";

/** What the OWNER renamed the session to, through `PATCH /agent-sessions/[id]`. */
const OWNER_RENAME = "Ledger rewrite, take two";
/** What the desktop payload carries — the collector's derivation. */
const SYNCED_OVERRIDE = "fix/collector-derived-title";

function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "Name Override Session",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/project",
    model: "claude-sonnet-4",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    metadata: {},
    ...overrides,
  };
}

function buildPayload(sessions: SyncedAgentSession[]) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-name-override-1",
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

/**
 * `storedNameOverride` of `undefined` means NO STORED ROW at all (the create
 * arm), which is a different case from a row whose column is `null` — the seed
 * must fire on both, and only a fixture that can express both proves it. It is
 * also what the upsert READS BACK, since the arms no longer write the column.
 */
function installDb(storedNameOverride: string | null | undefined) {
  const detailFindUnique = vi.fn(
    (args: { select: Record<string, unknown> }) => {
      if (args.select.metadata === true) {
        return Promise.resolve({ metadata: null });
      }
      if (storedNameOverride === undefined) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        artifactId: PERSISTED_ARTIFACT_ID,
        agents: [],
        dataRevision: null,
        pendingChunkRevision: null,
        pendingChunkTotal: null,
        pendingChunkReceived: null,
        sessionStartedAt: SESSION_STARTED_AT,
        sessionUpdatedAt: SESSION_UPDATED_AT,
        sessionEndedAt: null,
        artifact: { status: null },
      });
    }
  );
  const detailUpsert = vi.fn((args: { select: Record<string, unknown> }) =>
    Promise.resolve(
      persistedSessionDetail(
        PERSISTED_ARTIFACT_ID,
        // HONOURS `select`, the way Prisma does, and that is load-bearing rather
        // than fussy: a mock that returned this column unconditionally would keep
        // the skip case below green with `nameOverride` deleted from the slice's
        // upsert `select`. Correctness would survive that deletion — the write's
        // own qualifier still refuses — but the statement would be issued on every
        // re-sync of every renamed session, which is the whole point of reading it.
        args.select.nameOverride === true
          ? { nameOverride: storedNameOverride ?? null }
          : {}
      )
    )
  );
  const detailUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const artifactUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

  const db = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([{ toolUseCount: 0n, errorCount: 0n }]),
    organization: {
      findUnique: vi.fn().mockResolvedValue({ settings: null }),
    },
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: COMPUTE_TARGET_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sessionDetail: {
      findUnique: detailFindUnique,
      upsert: detailUpsert,
      update: vi.fn().mockResolvedValue({}),
      updateMany: detailUpdateMany,
    },
    artifact: { updateMany: artifactUpdateMany },
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

  return {
    artifactUpdateMany,
    detailFindUnique,
    detailUpdateMany,
    detailUpsert,
  };
}

/** The `update` arm the upsert was handed — what a re-import rewrites. */
function updateArm(
  detailUpsert: ReturnType<typeof vi.fn>
): Record<string, unknown> {
  return detailUpsert.mock.calls[0][0].update;
}

/** The `create` arm, for the first-delivery cases. */
function createArm(
  detailUpsert: ReturnType<typeof vi.fn>
): Record<string, unknown> {
  return detailUpsert.mock.calls[0][0].create;
}

describe("upsertSessionSlice — name-override precedence (ISS-8733)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never carries the override on either upsert arm", async () => {
    // The arms rewrite the row wholesale from a snapshot taken many statements
    // earlier, which is exactly what a rename can commit inside. Whatever the
    // stored state, this column is not theirs to write.
    const { detailUpsert } = installDb(null);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession({ nameOverride: SYNCED_OVERRIDE })])
    );

    expect("nameOverride" in updateArm(detailUpsert)).toBe(false);
    expect("nameOverride" in createArm(detailUpsert)).toBe(false);
  });

  it("seeds the synced override onto a row that holds none, under a null-only qualifier", async () => {
    const { detailUpdateMany } = installDb(null);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession({ nameOverride: SYNCED_OVERRIDE })])
    );

    // THE CONFLICT REGRESSION davetho asked for, at its enforcement point.
    // `nameOverride: null` is what makes a rename that commits between this
    // transaction's read and this statement win: the rename does not move
    // `sessionUpdatedAt`, so the freshness gate admits the replay, and nothing
    // upstream of the write can adjudicate it.
    expect(detailUpdateMany).toHaveBeenCalledTimes(1);
    expect(detailUpdateMany).toHaveBeenCalledWith({
      where: { artifactId: PERSISTED_ARTIFACT_ID, nameOverride: null },
      data: { nameOverride: SYNCED_OVERRIDE },
    });
    expect(mocks.captureMetadataSeed).toHaveBeenCalledOnce();
    expect(mocks.captureMetadataSeed).toHaveBeenCalledWith({
      tx: expect.any(Object),
      organizationId: ORG_ID,
      artifactId: PERSISTED_ARTIFACT_ID,
      field: SessionMetadataActivityField.Name,
      before: null,
      after: SYNCED_OVERRIDE,
    });
  });

  it("does not record a name seed when the guarded write loses a rename race", async () => {
    const { detailUpdateMany } = installDb(null);
    detailUpdateMany.mockResolvedValue({ count: 0 });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession({ nameOverride: SYNCED_OVERRIDE })])
    );

    expect(detailUpdateMany).toHaveBeenCalledOnce();
    expect(mocks.captureMetadataSeed).not.toHaveBeenCalled();
  });

  it("records only a successful collector priority seed", async () => {
    const { artifactUpdateMany } = installDb(null);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession({ priority: Priority.High })])
    );

    expect(artifactUpdateMany).toHaveBeenCalledWith({
      where: {
        id: PERSISTED_ARTIFACT_ID,
        type: ArtifactType.Session,
        priority: null,
      },
      data: { priority: Priority.High },
    });
    expect(mocks.captureMetadataSeed).toHaveBeenCalledWith({
      tx: expect.any(Object),
      organizationId: ORG_ID,
      artifactId: PERSISTED_ARTIFACT_ID,
      field: SessionMetadataActivityField.Priority,
      before: null,
      after: Priority.High,
    });
  });

  it("does not record priority when the guarded write loses a priority race", async () => {
    const { artifactUpdateMany } = installDb(null);
    artifactUpdateMany.mockResolvedValue({ count: 0 });

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession({ priority: Priority.High })])
    );

    expect(artifactUpdateMany).toHaveBeenCalledOnce();
    expect(mocks.captureMetadataSeed).not.toHaveBeenCalled();
  });

  it("seeds the synced override on a first delivery, where no row exists", async () => {
    const { detailUpdateMany } = installDb(undefined);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession({ nameOverride: SYNCED_OVERRIDE })])
    );

    expect(detailUpdateMany).toHaveBeenCalledWith({
      where: { artifactId: PERSISTED_ARTIFACT_ID, nameOverride: null },
      data: { nameOverride: SYNCED_OVERRIDE },
    });
  });

  it("issues no seed statement when the committed row already holds a rename", async () => {
    // Not the refusal itself — the qualifier above is — but the read-back that
    // keeps a renamed session's every re-sync from paying for one.
    const { detailUpdateMany } = installDb(OWNER_RENAME);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession({ nameOverride: SYNCED_OVERRIDE })])
    );

    expect(detailUpdateMany).not.toHaveBeenCalled();
    expect(mocks.captureMetadataSeed).not.toHaveBeenCalled();
  });

  it("leaves the column untouched when the payload states no override", async () => {
    // ISS-8717's original refusal, driven through production: an older desktop
    // sends no override at all, and an unconditional key would carry that
    // absence onto the column and erase the rename on the very next sync. This
    // is the half no write qualifier can make — the wire value is not in the row.
    const { detailUpdateMany, detailUpsert } = installDb(null);

    await agentSessionsService.upsertSessions(
      buildContext(),
      buildPayload([buildSyncedSession()])
    );

    expect("nameOverride" in updateArm(detailUpsert)).toBe(false);
    expect(detailUpdateMany).not.toHaveBeenCalled();
  });
});
