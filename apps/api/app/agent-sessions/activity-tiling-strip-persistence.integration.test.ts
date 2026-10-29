/**
 * ISS-7265 — DB ROUND-TRIP for the tiling-strip signal.
 *
 * The desktop's bounded old-server fallback ships a session WITHOUT its
 * activity-segment tiling so the rest of it can sync. It omits the key, and a
 * session that simply has no tiling omits the same key, so the two arrived as
 * the same bytes and the server took the same no-op for both — the strip was
 * undetectable by construction. PR #5456 stamped `activitySegmentRowsStripped`
 * on the wire; this closes the other half by proving the cloud actually records
 * it, and records the ABSENCE of it just as faithfully.
 *
 * Every case here has a sibling it must be distinguishable from, because the
 * defect is precisely that they were not:
 *   - a stripped payload persists TRUE, a tiling-carrying one persists FALSE;
 *   - a payload from a desktop that does not report leaves the column NULL,
 *     which is a third state and not a quiet `false`;
 *   - a later chunk that reports nothing does not clear a recorded strip, and a
 *     tiling that later arrives in full does.
 *
 * Both skew directions are covered: a NEW desktop's flag reaching this server
 * (the cases below), and an OLD desktop's flagless payload leaving the column
 * untouched rather than being read as a negative claim.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
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

const EXTERNAL_SESSION_ID = "iss7265-stripped-tiling";
const CLASSIFIER_VERSION = 7;

type Ctx = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
};

async function createComputeTarget(
  organizationId: string,
  userId: string
): Promise<string> {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "iss7265-round-trip",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  return target.id;
}

function tilingRow() {
  return {
    phase: "implement",
    startMs: 0,
    endMs: 999,
    confidence: 0.9,
    evidenceLayers: ["structural"],
    version: CLASSIFIER_VERSION,
    workItemRef: null,
    subagentId: null,
  };
}

/**
 * A tiling the persistence sanity validator rejects for OVERLAP. Each row is
 * individually well-formed, so this passes the wire schema and is turned away
 * later, by `validateActivityTiling` — which is the reachable shape that matters
 * here: rows on the wire, nothing persisted.
 */
function overlappingTiling() {
  return [
    { ...tilingRow(), startMs: 0, endMs: 1000 },
    { ...tilingRow(), startMs: 500, endMs: 1500 },
  ];
}

/**
 * One ingest-shaped session payload. `activitySegmentRows` and
 * `activitySegmentRowsStripped` are spread only when the caller supplies them,
 * so an "old desktop" payload really OMITS the keys rather than sending nulls.
 */
function sessionPayload(
  args: {
    activitySegmentRows?: ReturnType<typeof tilingRow>[];
    activitySegmentRowsStripped?: boolean;
    updatedAt?: string;
  } = {}
) {
  return {
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "Strip round-trip session",
    status: "completed",
    harness: "claude",
    cwd: "/tmp/wt",
    model: "claude-opus-4",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: args.updatedAt ?? "2026-06-10T11:00:00.000Z",
    metadata: {},
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...(args.activitySegmentRows
      ? { activitySegmentRows: args.activitySegmentRows }
      : {}),
    ...(args.activitySegmentRowsStripped === undefined
      ? {}
      : { activitySegmentRowsStripped: args.activitySegmentRowsStripped }),
  };
}

/**
 * Validate one payload through the REAL cloud ingress contract, then ingest it.
 * Returns the parse reason on a contract failure (null on success) so the test
 * body owns the assertion (biome's noMisplacedAssertion forbids asserting here).
 */
async function ingestOnePayload(
  ctx: Ctx,
  session: ReturnType<typeof sessionPayload>
): Promise<string | null> {
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000007265",
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

/** The persisted three-valued strip column: true, false, or null. */
function readBackStrip(ctx: Ctx): Promise<boolean | null> {
  return withDb((db) =>
    db.sessionDetail
      .findUniqueOrThrow({
        where: {
          computeTargetId_externalSessionId: {
            computeTargetId: ctx.computeTargetId,
            externalSessionId: EXTERNAL_SESSION_ID,
          },
        },
        select: { activitySegmentRowsStripped: true },
      })
      .then((row) => row.activitySegmentRowsStripped)
  );
}

async function newCtx(): Promise<Ctx> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(organizationId, user.id);
  return { organizationId, userId: user.id, computeTargetId };
}

describeIfDb("ISS-7265: the cloud records a stripped activity tiling", () => {
  it("persists TRUE for a payload that shipped without its tiling", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const ctx = await newCtx();

      expect(
        await ingestOnePayload(
          ctx,
          sessionPayload({ activitySegmentRowsStripped: true })
        )
      ).toBeNull();
      expect(await readBackStrip(ctx)).toBe(true);
    });
  });

  it("leaves NULL for a first payload that carried its tiling", async () => {
    // THE SIBLING of the case above, and the reason the column is worth having:
    // before it, these two payloads produced identical stored state. NULL, not
    // `false`, because nothing was ever stripped — the column records a strip
    // and its repair, not a per-sync "tiling is fine" heartbeat.
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const ctx = await newCtx();

      expect(
        await ingestOnePayload(
          ctx,
          sessionPayload({ activitySegmentRows: [tilingRow()] })
        )
      ).toBeNull();
      expect(await readBackStrip(ctx)).toBeNull();
    });
  });

  it("does NOT clear the strip when the arriving tiling is rejected", async () => {
    // The distinction the clear now turns on: these rows are on the wire but
    // fail sanity validation, so `persistSessionActivitySegments` writes none of
    // them. Reading wire-presence as arrival would reset a real strip on a
    // payload whose tiling the receiver threw away.
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const ctx = await newCtx();

      await ingestOnePayload(
        ctx,
        sessionPayload({ activitySegmentRowsStripped: true })
      );
      expect(
        await ingestOnePayload(
          ctx,
          sessionPayload({ activitySegmentRows: overlappingTiling() })
        )
      ).toBeNull();
      expect(await readBackStrip(ctx)).toBe(true);
    });
  });

  it("leaves NULL for an old desktop that does not report at all", async () => {
    // Old desktop -> new server skew. Absent must stay a third state: reading it
    // as `false` would put a confident "this session's tiling is intact" on
    // every row synced by a build that has no opinion on the question.
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const ctx = await newCtx();

      expect(await ingestOnePayload(ctx, sessionPayload())).toBeNull();
      expect(await readBackStrip(ctx)).toBeNull();
    });
  });

  it("does not let a later flagless payload clear a recorded strip", async () => {
    // The fallback splits a stripped session across chunks, and an events-only
    // chunk reports neither the flag nor any rows. Clearing on that would erase
    // the strip its own first part recorded.
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const ctx = await newCtx();

      await ingestOnePayload(
        ctx,
        sessionPayload({ activitySegmentRowsStripped: true })
      );
      expect(await ingestOnePayload(ctx, sessionPayload())).toBeNull();
      expect(await readBackStrip(ctx)).toBe(true);
    });
  });

  it("does not let a STALE payload overwrite the recorded strip", async () => {
    // The column is a session-level derived fact, so it rides the same watermark
    // that guards `endsWithError`. A delayed retry of an older batch — or a
    // stale chunk of an abandoned sequence whose `(dataRevision, total)` collides
    // with the live one — must not win the column by arrival order. Ungated,
    // this payload's rows would clear a real strip.
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const ctx = await newCtx();

      await ingestOnePayload(
        ctx,
        sessionPayload({ activitySegmentRowsStripped: true })
      );
      expect(
        await ingestOnePayload(
          ctx,
          sessionPayload({
            activitySegmentRows: [tilingRow()],
            updatedAt: "2026-06-10T09:00:00.000Z",
          })
        )
      ).toBeNull();
      expect(await readBackStrip(ctx)).toBe(true);
    });
  });

  it("clears the strip once the tiling actually arrives", async () => {
    // The paired positive for the case above: the latch is not permanent. A
    // resync that carries the tiling is positive evidence and must clear it, or
    // the row would claim a loss that has since been repaired.
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const ctx = await newCtx();

      await ingestOnePayload(
        ctx,
        sessionPayload({ activitySegmentRowsStripped: true })
      );
      expect(
        await ingestOnePayload(
          ctx,
          sessionPayload({ activitySegmentRows: [tilingRow()] })
        )
      ).toBeNull();
      expect(await readBackStrip(ctx)).toBe(false);
    });
  });
});
