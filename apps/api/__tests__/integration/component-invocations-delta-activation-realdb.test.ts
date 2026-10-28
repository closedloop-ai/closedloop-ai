/**
 * ISS-12781 real-Postgres proof that activating a generation rewrites only the
 * invocation rows that changed, and that every reader still gets what the old
 * full replacement produced.
 *
 * Two users each own a session with the same external id. The DELTA session
 * receives generation 1 and then generation 2; the BASELINE session receives
 * only generation 2, which is exactly the row set a full replacement would have
 * left. The two must agree on every persisted column and on the session tree
 * read, while the delta session's unchanged row keeps its id.
 *
 * Self-skips when DATABASE_URL is unset. Run explicitly:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app \
 *     pnpm --filter api exec vitest run \
 *     __tests__/integration/component-invocations-delta-activation-realdb.test.ts \
 *     --config vitest.config.integration.mts
 */
import { randomUUID } from "node:crypto";
import {
  AgentComponentInvocationKind,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncItem,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildItem,
  buildPart,
  EXTERNAL_SESSION_ID,
} from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import { mapInvocationCreate } from "@/app/agent-sessions/service/component-invocation-wire-row";
import { agentComponentInvocationsService } from "@/app/agent-sessions/service/component-invocations";
import { loadAgentSessionInvocationTree } from "@/app/agent-sessions/service/session-invocation-tree-read";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const ORG_ID = randomUUID();
const DELTA = {
  userId: randomUUID(),
  targetId: randomUUID(),
  sessionId: randomUUID(),
};
const BASELINE = {
  userId: randomUUID(),
  targetId: randomUUID(),
  sessionId: randomUUID(),
};
const LEGACY = {
  userId: randomUUID(),
  targetId: randomUUID(),
  sessionId: randomUUID(),
};
const CONFLICT = {
  userId: randomUUID(),
  targetId: randomUUID(),
  sessionId: randomUUID(),
};
type Owner = typeof DELTA;

const GENERATION_1_AT = "2026-07-22T12:00:00.000Z";
const GENERATION_2_AT = "2026-07-22T12:05:00.000Z";

const unchanged = buildItem({
  externalInvocationId: "invocation-a",
  sequence: 0,
  invokedAt: "2026-07-22T11:59:00.123Z",
  anchor: { kind: "event", eventId: "event-a" },
  model: "claude-opus",
  inputTokens: 1200,
  outputTokens: 340,
  estimatedCost: 0.123_456,
  usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
  durationMs: 4321,
});
const changedBefore = buildItem({
  externalInvocationId: "invocation-b",
  sequence: 1,
  rawName: "before",
});
const changedAfter = { ...changedBefore, rawName: "after" };
const removed = buildItem({
  externalInvocationId: "invocation-c",
  kind: AgentComponentInvocationKind.Tool,
  componentKey: "Read",
  sequence: 2,
});
const added = buildItem({
  externalInvocationId: "invocation-d",
  kind: AgentComponentInvocationKind.Tool,
  componentKey: "Edit",
  sequence: 2,
});

const generation1Items = [unchanged, changedBefore, removed];
const generation2Items = [unchanged, changedAfter, added];

/** Generation 1 puts the surviving row in its LAST part, which generation 2 drops. */
const generation1Parts = [[changedBefore], [removed], [unchanged]].map(
  (items, partIndex) =>
    buildPart({
      allItems: generation1Items,
      items,
      partIndex,
      partCount: 3,
      sourceUpdatedAt: GENERATION_1_AT,
    })
);
const generation2Parts = [[unchanged, changedAfter], [added]].map(
  (items, partIndex) =>
    buildPart({
      allItems: generation2Items,
      items,
      partIndex,
      partCount: 2,
      sourceUpdatedAt: GENERATION_2_AT,
    })
);

function ingest(owner: Owner, part: AgentComponentInvocationSyncPart) {
  return agentComponentInvocationsService.ingestPart({
    organizationId: ORG_ID,
    computeTargetId: owner.targetId,
    part,
  });
}

async function ingestAll(
  owner: Owner,
  parts: readonly AgentComponentInvocationSyncPart[]
) {
  let last: Awaited<ReturnType<typeof ingest>> | undefined;
  for (const part of parts) {
    last = await ingest(owner, part);
  }
  return last;
}

/** Every persisted column except the surrogate keys and write timestamps. */
function activeRows(sessionId: string) {
  return withDb(async (db) => {
    const rows = await db.agentComponentInvocation.findMany({
      where: {
        generation: { agentSessionId: sessionId, activeAt: { not: null } },
      },
      orderBy: { externalInvocationId: "asc" },
    });
    return rows.map(
      ({
        id: _id,
        generationId: _generationId,
        partId: _partId,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...columns
      }) => columns
    );
  });
}

function rowIds(sessionId: string) {
  return withDb(async (db) => {
    const rows = await db.agentComponentInvocation.findMany({
      where: { generation: { agentSessionId: sessionId } },
      select: { id: true, externalInvocationId: true },
    });
    return new Map(rows.map((row) => [row.externalInvocationId, row.id]));
  });
}

async function sessionTree(sessionId: string) {
  const page = await withDb((db) =>
    loadAgentSessionInvocationTree(db, { organizationId: ORG_ID, sessionId })
  );
  return page?.items.map(({ id: _id, sessionId: _sessionId, ...row }) => row);
}

async function seedOwner(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  owner: Owner
) {
  await db.user.create({
    data: {
      id: owner.userId,
      organizationId: ORG_ID,
      clerkId: `clerk_user_${owner.userId}`,
      email: `iss12781-${owner.userId}@example.test`,
    },
    select: { id: true },
  });
  await db.computeTarget.create({
    data: {
      id: owner.targetId,
      organizationId: ORG_ID,
      userId: owner.userId,
      machineName: `iss12781-${owner.targetId.slice(0, 8)}`,
      platform: "darwin",
    },
    select: { id: true },
  });
  await db.artifact.create({
    data: {
      id: owner.sessionId,
      organizationId: ORG_ID,
      type: "SESSION",
      name: "ISS-12781 session",
      slug: `iss12781-${owner.sessionId.slice(0, 8)}`,
      status: "active",
    },
    select: { id: true },
  });
  await db.sessionDetail.create({
    data: {
      artifactId: owner.sessionId,
      computeTargetId: owner.targetId,
      externalSessionId: EXTERNAL_SESSION_ID,
      harness: "claude",
      sessionStartedAt: new Date("2026-07-22T10:00:00Z"),
      sessionUpdatedAt: new Date("2026-07-22T12:00:00Z"),
      lastActivityAt: new Date("2026-07-22T12:00:00Z"),
    },
    select: { artifactId: true },
  });
}

describe.skipIf(!hasDatabase)(
  "ISS-12781 delta activation against real Postgres",
  () => {
    beforeAll(async () => {
      await withDb(async (db) => {
        await db.organization.create({
          data: {
            id: ORG_ID,
            clerkId: `clerk_org_${ORG_ID}`,
            name: "ISS-12781 RealDB Org",
            slug: `iss12781-${ORG_ID}`,
          },
          select: { id: true },
        });
        for (const owner of [DELTA, BASELINE, LEGACY, CONFLICT]) {
          await seedOwner(db, owner);
        }
      });
    });

    afterAll(async () => {
      await withDb(async (db) => {
        await db.sessionDetail.deleteMany({
          where: {
            computeTargetId: {
              in: [DELTA, BASELINE, LEGACY, CONFLICT].map((o) => o.targetId),
            },
          },
        });
        await db.artifact.deleteMany({ where: { organizationId: ORG_ID } });
        await db.computeTarget.deleteMany({
          where: { organizationId: ORG_ID },
        });
        await db.user.deleteMany({ where: { organizationId: ORG_ID } });
        await db.organization.deleteMany({ where: { id: ORG_ID } });
      });
    });

    it("rewrites only changed rows and leaves every reader where a full replacement would", async () => {
      const activated = {
        ok: true,
        value: { state: AgentComponentInvocationSyncAckState.Activated },
      };
      expect(await ingestAll(DELTA, generation1Parts)).toEqual(activated);
      const idsBefore = await rowIds(DELTA.sessionId);

      expect(await ingestAll(DELTA, generation2Parts)).toEqual(activated);
      expect(await ingestAll(BASELINE, generation2Parts)).toEqual(activated);

      const idsAfter = await rowIds(DELTA.sessionId);
      // The unchanged invocation was neither deleted nor re-inserted.
      expect(idsAfter.get("invocation-a")).toBe(idsBefore.get("invocation-a"));
      // The changed one was rewritten, the removed one deleted, the new one added.
      expect(idsAfter.get("invocation-b")).not.toBe(
        idsBefore.get("invocation-b")
      );
      expect([...idsAfter.keys()].sort()).toEqual([
        "invocation-a",
        "invocation-b",
        "invocation-d",
      ]);

      const baselineRows = await activeRows(BASELINE.sessionId);
      expect(baselineRows).toHaveLength(3);
      expect(await activeRows(DELTA.sessionId)).toEqual(baselineRows);
      const baselineTree = await sessionTree(BASELINE.sessionId);
      expect(baselineTree).toHaveLength(3);
      expect(await sessionTree(DELTA.sessionId)).toEqual(baselineTree);

      const generations = await withDb((db) =>
        db.agentComponentInvocationGeneration.findMany({
          where: { agentSessionId: DELTA.sessionId },
          include: { parts: { orderBy: { partIndex: "asc" } } },
        })
      );
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        externalGenerationId: generation2Parts[0]?.externalGenerationId,
        sourceUpdatedAt: new Date(GENERATION_2_AT),
        expectedPartCount: 2,
      });
      expect(generations[0]?.activeAt).not.toBeNull();
      expect(
        generations[0]?.parts.map(({ partIndex, partHash, stagedItems }) => ({
          partIndex,
          partHash,
          stagedItems,
        }))
      ).toEqual(
        generation2Parts.map(({ partIndex, partHash }) => ({
          partIndex,
          partHash,
          stagedItems: null,
        }))
      );
      const detail = await withDb((db) =>
        db.sessionDetail.findUnique({
          where: { artifactId: DELTA.sessionId },
          select: { componentInvocationCount: true },
        })
      );
      expect(detail?.componentInvocationCount).toBe(3);
    });

    it("acknowledges a re-sent part of the absorbed generation without writing a row", async () => {
      const idsBefore = await rowIds(DELTA.sessionId);

      const retried = await ingest(
        DELTA,
        generation2Parts[1] as AgentComponentInvocationSyncPart
      );

      expect(retried).toEqual({
        ok: true,
        value: { state: AgentComponentInvocationSyncAckState.Activated },
      });
      expect(await rowIds(DELTA.sessionId)).toEqual(idsBefore);
    });

    it("completes a generation whose first part an older build staged as rows", async () => {
      const [part0, part1] = generation2Parts as [
        AgentComponentInvocationSyncPart,
        AgentComponentInvocationSyncPart,
      ];
      await withDb(async (db) => {
        const generation = await db.agentComponentInvocationGeneration.create({
          data: {
            agentSessionId: LEGACY.sessionId,
            externalGenerationId: part0.externalGenerationId,
            sourceUpdatedAt: new Date(part0.sourceUpdatedAt),
            dataRevision: part0.dataRevision,
            sourceSequence: part0.sourceSequence,
            expectedPartCount: part0.partCount,
          },
          select: { id: true },
        });
        const part = await db.agentComponentInvocationPart.create({
          data: {
            generationId: generation.id,
            partIndex: 0,
            partHash: part0.partHash,
            itemCount: part0.items.length,
            payloadBytes: new TextEncoder().encode(JSON.stringify(part0))
              .byteLength,
          },
          select: { id: true },
        });
        await db.agentComponentInvocation.createMany({
          data: part0.items.map((item: AgentComponentInvocationSyncItem) =>
            mapInvocationCreate(generation.id, part.id, item)
          ),
        });
      });

      expect(await ingest(LEGACY, part1)).toEqual({
        ok: true,
        value: { state: AgentComponentInvocationSyncAckState.Activated },
      });
      expect(await activeRows(LEGACY.sessionId)).toEqual(
        await activeRows(BASELINE.sessionId)
      );
    });

    it("rejects an invocation id another part of the generation already staged", async () => {
      const duplicate = { ...unchanged, sequence: 1, rawName: "duplicate" };
      const parts = [[unchanged], [duplicate]].map((items, partIndex) =>
        buildPart({
          allItems: [unchanged, duplicate],
          items,
          partIndex,
          partCount: 2,
        })
      );

      const result = await ingestAll(CONFLICT, parts);

      expect(result).toEqual({
        ok: false,
        error: AgentComponentInvocationSyncRejectReason.GenerationConflict,
      });
      const staged = await withDb((db) =>
        db.agentComponentInvocationPart.findMany({
          where: { generation: { agentSessionId: CONFLICT.sessionId } },
          select: { partIndex: true },
        })
      );
      expect(staged).toEqual([{ partIndex: 0 }]);
    });
  }
);
