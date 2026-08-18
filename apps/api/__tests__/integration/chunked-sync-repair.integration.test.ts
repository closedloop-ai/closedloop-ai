/**
 * FEA-3788 (PRD-536 D3) — chunked-session sync must be repairable after a
 * partial (half-commit) apply.
 *
 * Oversized sessions are split by the desktop `chunkOversizedSession` into N
 * chunks that each carry the SAME `dataRevision`. Before this fix the FIRST chunk
 * of a new revision delete-replaced the events AND committed the new revision, so
 * a desktop process death after chunk 1 left the cloud holding ONLY chunk-1
 * events at the current revision. A later normal resync then saw equal revisions
 * (`shouldReplace=false`) and NEVER repaired the missing chunks.
 *
 * AC-3: simulate a process death after chunk 1 of a chunked session; a subsequent
 * normal resync must FULLY repair the session's events (all chunks present).
 *
 * These tests drive the REAL cloud ingress contract (`parseDesktopAgentSessionsPayload`)
 * + `agentSessionsService.upsertSessions` against Postgres and read the persisted
 * `agent_session_events` rows back directly, so they assert on the actual delete/
 * upsert behaviour rather than a mock.
 */
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  buildEventIds,
  buildSessionChunk,
  type ChunkMeta,
  type ChunkSyncContext,
  createComputeTarget,
  ingestChunk,
  readPersistedChunkState,
} from "@/app/agent-sessions/chunked-sync-test-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const EXTERNAL_SESSION_ID = "sess-fea-3788-chunked";
const SESSION_NAME = "FEA-3788 chunked session";
const BATCH_ID = "00000000-0000-4000-8000-000000000042";
const DATA_REVISION = 42;

function chunk(params: {
  eventIds: string[];
  chunk: ChunkMeta;
  dataRevision?: number;
}): Record<string, unknown> {
  return buildSessionChunk({
    externalSessionId: EXTERNAL_SESSION_ID,
    name: SESSION_NAME,
    eventIds: params.eventIds,
    chunk: params.chunk,
    dataRevision: params.dataRevision ?? DATA_REVISION,
  });
}

/** Resolves to the batch's ack echo (`persistedSessionIds`). */
function apply(
  context: ChunkSyncContext,
  params: { eventIds: string[]; chunk: ChunkMeta; dataRevision?: number }
): Promise<string[]> {
  return ingestChunk(context, BATCH_ID, chunk(params));
}

async function readEventIdsAndRevision(
  context: ChunkSyncContext
): Promise<{ eventIds: string[]; dataRevision: number | null }> {
  const state = await readPersistedChunkState(
    context.computeTargetId,
    EXTERNAL_SESSION_ID
  );
  if (!state) {
    throw new Error("expected a persisted SessionDetail row");
  }
  return { eventIds: state.eventIds, dataRevision: state.dataRevision };
}

async function setup(): Promise<ChunkSyncContext> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    user.id,
    "fea-3788"
  );
  return { organizationId, userId: user.id, computeTargetId };
}

describeIfDb("chunked-session sync repair (FEA-3788, PRD-536 D3)", () => {
  it("repairs a half-committed chunked session on a subsequent full resync", async () => {
    await autoRollbackTransaction(async () => {
      const context = await setup();

      const allEventIds = buildEventIds(6);
      const slice0 = allEventIds.slice(0, 2);
      const slice1 = allEventIds.slice(2, 4);
      const slice2 = allEventIds.slice(4, 6);

      // ── PARTIAL SYNC: only chunk 0 lands, then the desktop process dies. ──
      await apply(context, { eventIds: slice0, chunk: { index: 0, total: 3 } });

      const afterPartial = await readEventIdsAndRevision(context);
      // Only chunk-0 events are present…
      expect(afterPartial.eventIds).toEqual([...slice0].sort());
      // …and the new revision is NOT yet committed, so the partial apply can never
      // masquerade as complete: the stored revision stays at its prior (null) value
      // and the next resync's first chunk will still see a differing revision.
      expect(afterPartial.dataRevision).toBeNull();

      // ── FULL RESYNC: the desktop re-chunks and re-sends every chunk. ──
      await apply(context, { eventIds: slice0, chunk: { index: 0, total: 3 } });
      await apply(context, { eventIds: slice1, chunk: { index: 1, total: 3 } });
      await apply(context, { eventIds: slice2, chunk: { index: 2, total: 3 } });

      const afterRepair = await readEventIdsAndRevision(context);
      // AC-3: ALL events from every chunk are present — the session is fully
      // repaired, with no loss and no double-write.
      expect(afterRepair.eventIds).toEqual([...allEventIds].sort());
      // The revision is committed only now, on the final chunk.
      expect(afterRepair.dataRevision).toBe(DATA_REVISION);
    });
  });

  it("does not lose or double-write events when a complete chunk sequence lands in one pass", async () => {
    await autoRollbackTransaction(async () => {
      const context = await setup();

      const allEventIds = buildEventIds(6);
      const slices = [
        allEventIds.slice(0, 2),
        allEventIds.slice(2, 4),
        allEventIds.slice(4, 6),
      ];
      for (const [index, slice] of slices.entries()) {
        await apply(context, {
          eventIds: slice,
          chunk: { index, total: slices.length },
        });
      }

      const persisted = await readEventIdsAndRevision(context);
      // Exactly the union of the slices — the chunk-0 delete-replace followed by
      // append-only later chunks yields no duplicates and no drops.
      expect(persisted.eventIds).toEqual([...allEventIds].sort());
      expect(persisted.dataRevision).toBe(DATA_REVISION);
    });
  });

  it("re-fires the delete-replace when a NEW revision arrives chunked over a fully-synced older revision", async () => {
    await autoRollbackTransaction(async () => {
      const context = await setup();

      // Fully sync an OLD revision (unchunked) with its own event set.
      const oldEventIds = ["old-a", "old-b", "old-c"];
      await apply(context, {
        eventIds: oldEventIds,
        chunk: { index: 0, total: 1 },
        dataRevision: DATA_REVISION - 1,
      });
      const afterOld = await readEventIdsAndRevision(context);
      expect(afterOld.eventIds).toEqual([...oldEventIds].sort());
      expect(afterOld.dataRevision).toBe(DATA_REVISION - 1);

      // A NEW revision arrives chunked, and only chunk 0 lands (half-commit). The
      // first chunk of the differing revision must delete the stale old-revision
      // events (delete-replace), leaving only chunk-0 of the new set.
      const newEventIds = buildEventIds(4);
      await apply(context, {
        eventIds: newEventIds.slice(0, 2),
        chunk: { index: 0, total: 2 },
      });
      const afterPartialNew = await readEventIdsAndRevision(context);
      expect(afterPartialNew.eventIds).toEqual(
        [...newEventIds.slice(0, 2)].sort()
      );
      // Old events are gone; the new revision is NOT yet committed (still repairable).
      expect(afterPartialNew.dataRevision).toBe(DATA_REVISION - 1);

      // Resync the full new sequence → fully repaired to the new event set + revision.
      await apply(context, {
        eventIds: newEventIds.slice(0, 2),
        chunk: { index: 0, total: 2 },
      });
      await apply(context, {
        eventIds: newEventIds.slice(2, 4),
        chunk: { index: 1, total: 2 },
      });
      const afterRepair = await readEventIdsAndRevision(context);
      expect(afterRepair.eventIds).toEqual([...newEventIds].sort());
      expect(afterRepair.dataRevision).toBe(DATA_REVISION);
    });
  });
});
