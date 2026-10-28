/**
 * ISS-4578 (honest completion of ISS-4541) — DB ROUND-TRIP fidelity for the
 * chunked activity-segment sync lane.
 *
 * The desktop-only chunking tests prove the PRODUCER paginates a tiling across
 * parts; the mocked persistence tests prove the CONSUMER's replace/append
 * gating. This test closes the loop the other two structurally cannot see:
 *   producer wire shape -> real cloud ingress contract -> upsert ->
 *   Postgres -> org-scoped cloud detail read-back,
 * asserting the FULL tiling survives end-to-end, never truncated or duplicated.
 *
 * Covered:
 *   - a multi-part tiling (3 disjoint chunks) merges into the full stored tiling
 *     and reads back in full, in order;
 *   - version skew (OLD desktop): the whole tiling replicated in every chunk's
 *     base stays exactly-once after the replace-on-open + append-idempotent
 *     merge;
 *   - P1 #4 read-cap alignment: a stored tiling ABOVE the per-payload wire cap
 *     (MAX_SYNCED_ACTIVITY_SEGMENTS) is read back IN FULL, proving the detail
 *     read bounds by MAX_STORED_ACTIVITY_SEGMENTS, not the wire cap (the old
 *     read would have clipped it);
 *   - ISS-7779: the legacy wire `activitySegmentRowsTruncated` is NOT relayed
 *     onto the read shape — the like-named detail field is derived per read.
 */
import {
  AgentSessionSyncMode,
  MAX_SYNCED_ACTIVITY_SEGMENTS,
  type SyncedActivitySegmentRow,
} from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  createTestOrganization,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  parseDesktopAgentSessionsPayload,
} from "@/lib/desktop-agent-sessions-schema";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const EXTERNAL_SESSION_ID = "iss4578-chunked-tiling";
const DATA_REVISION = 9;
const CLASSIFIER_VERSION = 7;

async function createComputeTarget(
  organizationId: string,
  userId: string
): Promise<string> {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "iss4578-round-trip",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  return target.id;
}

function segment(
  index: number,
  version: number = CLASSIFIER_VERSION
): SyncedActivitySegmentRow {
  return {
    phase: index % 2 === 0 ? "implement" : "review",
    startMs: index * 1000,
    endMs: index * 1000 + 999,
    confidence: 0.9,
    evidenceLayers: ["structural"],
    version,
    workItemRef: null,
    subagentId: null,
  };
}

function tiling(count: number): SyncedActivitySegmentRow[] {
  return Array.from({ length: count }, (_, i) => segment(i));
}

/**
 * One ingest-shaped session payload carrying a slice of the tiling and, when
 * multi-part, a `{ index, total }` chunk marker. Uses the real ingress schema
 * fields so it validates through `parseDesktopAgentSessionsPayload`.
 */
function sessionPayload(args: {
  activitySegmentRows: SyncedActivitySegmentRow[];
  activitySegmentRowsTruncated?: boolean;
  chunk?: { index: number; total: number };
  /**
   * ISS-10259: the EVENTS stream. Defaulted to none, because every case before
   * this ticket carried the tiling on chunk 0; the production shape is the
   * opposite — `appendRequiredStreamChunks` packs the events first, so chunk 0
   * is an event-bearing chunk whose tiling slice is the explicit empty clear.
   */
  events?: { externalEventId: string }[];
}) {
  return {
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "Chunked tiling session",
    status: "completed",
    harness: "claude",
    cwd: "/tmp/wt",
    model: "claude-opus-4",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    metadata: {},
    agents: [],
    events: (args.events ?? []).map(({ externalEventId }) => ({
      externalEventId,
      eventType: "ToolUse",
      toolName: "Read",
      createdAt: "2026-06-10T10:30:00.000Z",
    })),
    tokenUsageByModel: [],
    dataRevision: DATA_REVISION,
    activitySegmentRows: args.activitySegmentRows,
    ...(args.activitySegmentRowsTruncated === undefined
      ? {}
      : { activitySegmentRowsTruncated: args.activitySegmentRowsTruncated }),
    ...(args.chunk ? { chunk: args.chunk } : {}),
  };
}

/**
 * Validate one payload through the REAL cloud ingress contract, then ingest it.
 * Returns the parse reason on a contract failure (null on success) so the test
 * body owns the assertion (biome's noMisplacedAssertion forbids asserting here).
 */
async function ingestOnePayload(
  ctx: { organizationId: string; userId: string; computeTargetId: string },
  session: ReturnType<typeof sessionPayload>
): Promise<string | null> {
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000010",
    syncMode: AgentSessionSyncMode.Backfill,
    sessionCount: 1,
    sessions: [session],
  });
  if (!parsed.ok) {
    return parsed.reason;
  }
  await agentSessionsService.upsertSessions(
    {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      computeTargetId: ctx.computeTargetId,
    },
    parsed.payload
  );
  return null;
}

/** Read the persisted tiling back through the org-scoped cloud detail path. */
async function readBackTiling(ctx: {
  organizationId: string;
  computeTargetId: string;
}): Promise<{ starts: number[]; truncated: boolean; found: boolean }> {
  const { artifactId } = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId: ctx.computeTargetId,
          externalSessionId: EXTERNAL_SESSION_ID,
        },
      },
      select: { artifactId: true },
    })
  );
  const detail = await agentSessionsService.findSessionDetail({
    organizationId: ctx.organizationId,
    id: artifactId,
  });
  return {
    found: detail !== null,
    starts: (detail?.activitySegmentRows ?? []).map((row) => row.startMs),
    truncated: detail?.activitySegmentRowsTruncated === true,
  };
}

describeIfDb("ISS-4578: chunked activity-segment sync DB round-trip", () => {
  it("merges a 3-part tiling into the full stored tiling and reads it back in order", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id
      );
      const ctx = { organizationId, userId: user.id, computeTargetId };

      const full = tiling(9);
      const parts = [full.slice(0, 3), full.slice(3, 6), full.slice(6, 9)];
      // Ingest the three chunks as separate batch requests (as the outbox does).
      for (let index = 0; index < parts.length; index++) {
        const reason = await ingestOnePayload(
          ctx,
          sessionPayload({
            activitySegmentRows: parts[index],
            chunk: { index, total: parts.length },
          })
        );
        expect(reason, `chunk ${index} failed the ingress contract`).toBeNull();
      }

      const { starts, found } = await readBackTiling(ctx);
      expect(found).toBe(true);
      // Full fidelity: every startMs is stored exactly once, in order.
      expect(starts).toEqual(full.map((row) => row.startMs));
    });
  });

  it("version skew (OLD desktop): the whole tiling replicated in every chunk stays exactly-once", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id
      );
      const ctx = { organizationId, userId: user.id, computeTargetId };

      // An OLD desktop rides the WHOLE tiling in every chunk's base (it never
      // paginated the tiling). Chunk 0 replace-alls it; the later chunk re-sends
      // the same full tiling and appends with skipDuplicates (all startMs
      // collide) — the DB must still store each row exactly once.
      const full = tiling(4);
      const reason0 = await ingestOnePayload(
        ctx,
        sessionPayload({
          activitySegmentRows: full,
          chunk: { index: 0, total: 2 },
        })
      );
      expect(reason0).toBeNull();
      const reason1 = await ingestOnePayload(
        ctx,
        sessionPayload({
          activitySegmentRows: full,
          chunk: { index: 1, total: 2 },
        })
      );
      expect(reason1).toBeNull();

      const { starts, found } = await readBackTiling(ctx);
      expect(found).toBe(true);
      expect(starts).toEqual(full.map((row) => row.startMs));
    });
  });

  it("P1 #4: a stored tiling ABOVE the per-payload wire cap reads back in full (read-cap alignment)", async () => {
    await joinAmbientTransactionForSessionSyncWrites(
      async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const computeTargetId = await createComputeTarget(
          organizationId,
          user.id
        );
        const ctx = { organizationId, userId: user.id, computeTargetId };

        // A tiling larger than ONE payload's row cap, delivered across two chunks
        // that each respect the per-payload cap. The merged stored tiling exceeds
        // MAX_SYNCED_ACTIVITY_SEGMENTS, so the OLD detail read (take = wire cap)
        // would have clipped it. The aligned read (take = MAX_STORED_...) must
        // return every row, and NOT flag truncation (well under the stored ceiling).
        const total = MAX_SYNCED_ACTIVITY_SEGMENTS + 1000;
        const full = tiling(total);
        const partA = full.slice(0, MAX_SYNCED_ACTIVITY_SEGMENTS);
        const partB = full.slice(MAX_SYNCED_ACTIVITY_SEGMENTS);
        const reasonA = await ingestOnePayload(
          ctx,
          sessionPayload({
            activitySegmentRows: partA,
            chunk: { index: 0, total: 2 },
          })
        );
        expect(reasonA).toBeNull();
        const reasonB = await ingestOnePayload(
          ctx,
          sessionPayload({
            activitySegmentRows: partB,
            chunk: { index: 1, total: 2 },
          })
        );
        expect(reasonB).toBeNull();

        const { starts, truncated, found } = await readBackTiling(ctx);
        expect(found).toBe(true);
        expect(starts.length).toBe(total);
        expect(starts[0]).toBe(0);
        expect(starts.at(-1)).toBe((total - 1) * 1000);
        expect(truncated).toBe(false);
      },
      { maxWait: 5000, timeout: 20_000 }
    );
  });

  it("whitlockk P1: a RETRIED tail chunk survives the real unique constraint and reads back the complete tiling (exactly-once)", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id
      );
      const ctx = { organizationId, userId: user.id, computeTargetId };

      // A two-part tiling. The tail (chunk 1) is delivered TWICE — modeling the
      // outbox re-sending a tail whose ack was lost. The append lane's
      // `skipDuplicates` on the real unique `(agentSessionId, startMs)` key must
      // make the retry a no-op, so the stored tiling is the complete set with
      // every row exactly once — proven against Postgres, not a mock.
      const full = tiling(6);
      const partA = full.slice(0, 3);
      const partB = full.slice(3, 6);

      const reason0 = await ingestOnePayload(
        ctx,
        sessionPayload({
          activitySegmentRows: partA,
          chunk: { index: 0, total: 2 },
        })
      );
      expect(reason0).toBeNull();
      // Tail, first delivery.
      const reason1a = await ingestOnePayload(
        ctx,
        sessionPayload({
          activitySegmentRows: partB,
          chunk: { index: 1, total: 2 },
        })
      );
      expect(reason1a).toBeNull();
      // Tail, RETRY (same chunk, same content) — must be idempotent.
      const reason1b = await ingestOnePayload(
        ctx,
        sessionPayload({
          activitySegmentRows: partB,
          chunk: { index: 1, total: 2 },
        })
      );
      expect(reason1b).toBeNull();

      const { starts, found } = await readBackTiling(ctx);
      expect(found).toBe(true);
      // Complete tiling, each startMs exactly once — the retry inserted no dupes.
      expect(starts).toEqual(full.map((row) => row.startMs));
    });
  });

  it("ISS-10259: the desktop's paginated order — an EVENTS chunk 0 with an explicit empty tiling, the tiling on chunks 1..2 — reads back whole", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id
      );
      const ctx = { organizationId, userId: user.id, computeTargetId };

      // The shape ISS-10259 is about, which no case above reaches: every one of
      // them puts tiling rows on chunk 0, so the append lane always had a stored
      // tiling to attest against. The desktop does the opposite when the tiling
      // paginates — `appendRequiredStreamChunks` packs the EVENTS stream first
      // and `createChunkBuilders.baseFor` stamps an explicit
      // `activitySegmentRows: []` on every non-tiling chunk — so chunk 0 clears
      // and stores NOTHING and the tiling's own rows ride chunks 1..N against an
      // empty stored tiling. The refusal this ticket removed dropped every one
      // of them, which is why 78 of 85 affected sessions still had zero stored
      // segments a fortnight on.
      //
      // Driven through `parseDesktopAgentSessionsPayload` + `upsertSessions` to
      // real Postgres, so the ingress contract, the sequence gate and the append
      // lane all have to agree for this to pass (review, davetho P2). The
      // PRODUCER half — that the chunker really emits the explicit `[]` rather
      // than omitting the key — is pinned on the desktop side, in
      // `apps/desktop/test/agent-session-sync-activity-segment-chunking.test.ts`;
      // `apps/api` does not depend on `apps/desktop`, so the wire shape written
      // out here is the seam between the two halves.
      // Two tiling slices, one per chunk behind the events chunk.
      const full = tiling(2);
      const reason0 = await ingestOnePayload(
        ctx,
        sessionPayload({
          activitySegmentRows: [],
          events: [{ externalEventId: "evt-0" }],
          chunk: { index: 0, total: 3 },
        })
      );
      expect(reason0).toBeNull();
      // Chunk 0 stored nothing — the state the append lane used to refuse.
      expect((await readBackTiling(ctx)).starts).toEqual([]);

      for (const [offset, slice] of full.entries()) {
        const index = offset + 1;
        const reason = await ingestOnePayload(
          ctx,
          sessionPayload({
            activitySegmentRows: [slice],
            chunk: { index, total: 3 },
          })
        );
        expect(reason, `chunk ${index} failed the ingress contract`).toBeNull();
      }

      const { starts, found } = await readBackTiling(ctx);
      expect(found).toBe(true);
      expect(starts).toEqual(full.map((slice) => slice.startMs));
    });
  });

  it("ISS-10259: a slice at a DIFFERENT classifier version than the sequence established is still refused", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id
      );
      const ctx = { organizationId, userId: user.id, computeTargetId };

      // Admitting the EMPTY stored tiling must not admit a MIXED-version one.
      // Chunk 1 establishes the sequence's classifier version against nothing
      // stored; chunk 2 arrives from a re-tile at another version and is dropped,
      // so the stored tiling holds chunk 1's span alone rather than interleaving
      // two derivations (review, davetho P2).
      const reason0 = await ingestOnePayload(
        ctx,
        sessionPayload({
          activitySegmentRows: [],
          events: [{ externalEventId: "evt-0" }],
          chunk: { index: 0, total: 3 },
        })
      );
      expect(reason0).toBeNull();
      const reason1 = await ingestOnePayload(
        ctx,
        sessionPayload({
          activitySegmentRows: [segment(1)],
          chunk: { index: 1, total: 3 },
        })
      );
      expect(reason1).toBeNull();
      const reason2 = await ingestOnePayload(
        ctx,
        sessionPayload({
          activitySegmentRows: [segment(2, CLASSIFIER_VERSION + 1)],
          chunk: { index: 2, total: 3 },
        })
      );
      expect(reason2).toBeNull();

      const { starts, found } = await readBackTiling(ctx);
      expect(found).toBe(true);
      expect(starts).toEqual([segment(1).startMs]);
    });
  });

  it("ISS-7779: a legacy wire activitySegmentRowsTruncated=true is NOT relayed onto the read shape", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTargetId = await createComputeTarget(
        organizationId,
        user.id
      );
      const ctx = { organizationId, userId: user.id, computeTargetId };

      // A version-skewed FEA-3779..ISS-4578 desktop flagging its tiling partial.
      // Nothing persists or forwards that wire key, so the like-named read-shape
      // field is not that value relayed: it is derived per read from
      // MAX_STORED_ACTIVITY_SEGMENTS, and a well-under-ceiling tiling reads back
      // whole and unflagged no matter what the producer claimed. Both docstrings
      // now say so; this is what stops the next reader wiring one to the other.
      // (The schema's round-trip of the key itself is
      // `desktop-agent-sessions-handler.test.ts`; the ingress is non-strict, so
      // `reason === null` here only proves the payload was not rejected.)
      const full = tiling(4);
      const reason = await ingestOnePayload(
        ctx,
        sessionPayload({
          activitySegmentRows: full,
          activitySegmentRowsTruncated: true,
        })
      );
      expect(reason).toBeNull();

      const { starts, truncated, found } = await readBackTiling(ctx);
      expect(found).toBe(true);
      expect(starts).toEqual(full.map((row) => row.startMs));
      expect(truncated).toBe(false);
    });
  });
});
