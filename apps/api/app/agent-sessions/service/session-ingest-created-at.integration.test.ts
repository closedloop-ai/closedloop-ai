/**
 * ISS-12251 (PLN-2176 T-6.7): the ingest writes the desktop's `createdAt` to
 * the Session artifact's `created_at`. The create arm stores a plausible value
 * in place of the first-sync time; a later delivery may only move it earlier;
 * an implausible or unparseable value is never stored; and an older desktop that
 * omits the field keeps the first-sync time (AC-012) on both arms.
 */
import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import type * as TelemetryMetrics from "@repo/observability/telemetry/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionChunk,
  type ChunkSyncContext,
  createComputeTarget,
  ingestChunk,
} from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createTestOrganization,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "@/__tests__/utils/db-helpers";
import { lowerSessionCreatedAt } from "./session-created-at";
import { SessionSyncMetric } from "./session-sync-metrics";

/** Only `emitTelemetryMetric` is replaced; the rest of the module is real. */
const emitTelemetryMetric = vi.hoisted(() => vi.fn());
vi.mock("@repo/observability/telemetry/metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryMetrics>()),
  emitTelemetryMetric,
}));

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const EXTERNAL_SESSION_ID = "iss-12251-created-at-session";
const NAME = "fix/created-at";
const CREATED_AT = "2026-06-01T09:00:00.000Z";
const EARLIER_CREATED_AT = "2026-05-20T08:00:00.000Z";
const LATER_CREATED_AT = "2026-06-05T08:00:00.000Z";
const LAST_IMPLAUSIBLE_CREATED_AT = "2015-01-01T00:00:00.000Z";
const NOT_A_TIMESTAMP = "not-a-timestamp";
const RESYNCED_UPDATED_AT = "2026-06-10T12:00:00.000Z";
/** The pinned clock: the sync timestamp and the artifact's `now()` default. */
const SYNC_NOW = "2026-10-01T12:00:00.000Z";
const FUTURE_CREATED_AT = "2026-10-01T13:00:00.000Z";
/** A later clock for a resync, so a write of `now()` would show. */
const RESYNC_NOW = "2026-10-02T12:00:00.000Z";
const IMPLAUSIBLE_CREATED_ATS = [
  LAST_IMPLAUSIBLE_CREATED_AT,
  FUTURE_CREATED_AT,
  NOT_A_TIMESTAMP,
];

type Synced = { context: ChunkSyncContext; artifactId: string };

describeIfDb("ISS-12251: ingest writes the session's createdAt", () => {
  beforeEach(() => {
    emitTelemetryMetric.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(SYNC_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores a plausible createdAt on create", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const synced = await syncNewSession({ createdAt: CREATED_AT });
      expect(await readCreatedAt(synced)).toBe(CREATED_AT);
    });
  });

  it("lowers a stored value to an earlier one and never raises it", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const synced = await syncNewSession({ createdAt: CREATED_AT });

      await resync(synced, { createdAt: LATER_CREATED_AT });
      expect(await readCreatedAt(synced)).toBe(CREATED_AT);

      await resync(synced, { createdAt: EARLIER_CREATED_AT });
      expect(await readCreatedAt(synced)).toBe(EARLIER_CREATED_AT);
    });
  });

  it("lowers only an artifact of the writer's own organization", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const own = await syncNewSession({ createdAt: CREATED_AT });
      const other = await syncNewSession({ createdAt: CREATED_AT });
      const lowerOwnArtifact = (organizationId: string) =>
        withDb.tx((tx) =>
          lowerSessionCreatedAt(tx, {
            organizationId,
            artifactId: own.artifactId,
            incoming: new Date(EARLIER_CREATED_AT),
            committed: new Date(CREATED_AT),
          })
        );

      await lowerOwnArtifact(other.context.organizationId);
      expect(await readCreatedAt(own)).toBe(CREATED_AT);

      await lowerOwnArtifact(own.context.organizationId);
      expect(await readCreatedAt(own)).toBe(EARLIER_CREATED_AT);
      expect(await readCreatedAt(other)).toBe(CREATED_AT);
    });
  });

  it("keeps the first-sync time on create for an implausible or unparseable value", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      for (const createdAt of IMPLAUSIBLE_CREATED_ATS) {
        const synced = await syncNewSession({ createdAt });
        expect(await readCreatedAt(synced), createdAt).toBe(SYNC_NOW);
      }
    });
  });

  it("leaves a stored value alone for an implausible or unparseable value on update", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const synced = await syncNewSession({ createdAt: CREATED_AT });
      for (const createdAt of IMPLAUSIBLE_CREATED_ATS) {
        await resync(synced, { createdAt });
        expect(await readCreatedAt(synced), createdAt).toBe(CREATED_AT);
      }
      expect(droppedCreatedAtCounts()).toEqual([1, 1, 1]);
    });
  });

  it("keeps the first-sync time for an older desktop that omits createdAt, on both arms", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const synced = await syncNewSession({});
      expect(await readCreatedAt(synced)).toBe(SYNC_NOW);

      vi.setSystemTime(new Date(RESYNC_NOW));
      await resync(synced, {});
      expect(await readCreatedAt(synced)).toBe(SYNC_NOW);
      expect(droppedCreatedAtCounts()).toEqual([]);
    });
  });
});

/** The `ImplausibleCreatedAtDropped` batch counts emitted so far. */
function droppedCreatedAtCounts(): unknown[] {
  return emitTelemetryMetric.mock.calls
    .map(([emission]) => emission as Record<string, unknown>)
    .filter(
      (emission) =>
        emission?.metric === SessionSyncMetric.ImplausibleCreatedAtDropped
    )
    .map((emission) => emission.count);
}

async function syncNewSession(
  extras: Record<string, unknown>
): Promise<Synced> {
  const organizationId = await createTestOrganization();
  const uploader = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    uploader.id,
    `lane-12251-${randomUUID()}`
  );
  const context = { organizationId, userId: uploader.id, computeTargetId };
  await ingestChunk(context, randomUUID(), {
    ...buildSessionChunk({
      externalSessionId: EXTERNAL_SESSION_ID,
      name: NAME,
      eventIds: ["evt-0"],
    }),
    ...extras,
  });
  const detail = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId: EXTERNAL_SESSION_ID,
        },
      },
      select: { artifactId: true },
    })
  );
  return { context, artifactId: detail.artifactId };
}

async function resync(
  synced: Synced,
  extras: Record<string, unknown>
): Promise<void> {
  await ingestChunk(synced.context, randomUUID(), {
    ...buildSessionChunk({
      externalSessionId: EXTERNAL_SESSION_ID,
      name: NAME,
      eventIds: ["evt-0"],
    }),
    updatedAt: RESYNCED_UPDATED_AT,
    ...extras,
  });
}

async function readCreatedAt(synced: Synced): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: synced.artifactId },
      select: { createdAt: true },
    })
  );
  return artifact.createdAt.toISOString();
}
