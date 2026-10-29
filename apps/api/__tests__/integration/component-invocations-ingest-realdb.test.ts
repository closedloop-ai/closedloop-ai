/**
 * ISS-8267 real-Postgres regression proof for the component-invocation ingest
 * generation write.
 *
 * The generation write must never be a Prisma native `upsert`: with the
 * partial unique `idx_acig_one_active_per_session` declared in schema.prisma,
 * Prisma 7.8 arbitrates `ON CONFLICT ("agent_session_id")` — the partial
 * index — instead of the five-column identity named in `where`, and Postgres
 * rejects that with 42P10, failing 100% of invocation ingest. A
 * mocked-transaction suite can never see this (the arbiter is chosen at SQL
 * generation time), so this drives the REAL production entry point against a
 * REAL migrated Postgres. On the broken write every case here fails with
 * `IngestionFailed`.
 *
 * The read-then-write replacement is safe only because `lockSessionDetail`
 * serializes same-session writers BEFORE the identity read; the contention
 * case pins that, so moving or removing the lock fails here instead of
 * resurfacing as racy `ingestion_failed` acks in production.
 *
 * Self-skips when DATABASE_URL is unset, like the sibling suites here. Run
 * explicitly:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app \
 *     pnpm --filter api exec vitest run \
 *     __tests__/integration/component-invocations-ingest-realdb.test.ts \
 *     --config vitest.config.integration.mts
 *
 * Everything is namespaced under one unique org and dropped in afterAll.
 */
import { randomUUID } from "node:crypto";
import {
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncPart,
} from "@repo/api/src/types/agent-component-invocation";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildItem,
  buildPart,
  EXTERNAL_SESSION_ID,
} from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import { phantomSessionWhere } from "@/app/agent-sessions/phantom-retention-service";
import { agentComponentInvocationsService } from "@/app/agent-sessions/service/component-invocations";
import {
  hasProjectedIndexKeyShape,
  INDEX_KEY_MAX_BYTES,
} from "@/lib/index-key-projection";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const COMPUTE_TARGET_ID = randomUUID();
const SESSION_ID = randomUUID();
// ISS-5801 staged-generation retention interleaving: one session that only
// ever receives part 0 of a 2-part generation, and one bare contrast session.
const STAGED_SESSION_ID = randomUUID();
const STAGED_EXTERNAL_SESSION_ID = `staged-${STAGED_SESSION_ID.slice(0, 8)}`;
const BARE_SESSION_ID = randomUUID();
const BARE_EXTERNAL_SESSION_ID = `bare-${BARE_SESSION_ID.slice(0, 8)}`;

function ingest(part: AgentComponentInvocationSyncPart) {
  return agentComponentInvocationsService.ingestPart({
    organizationId: ORG_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    part,
  });
}

function readGenerations() {
  return withDb((db) =>
    db.agentComponentInvocationGeneration.findMany({
      where: { agentSessionId: SESSION_ID },
      select: {
        id: true,
        externalGenerationId: true,
        activeAt: true,
        completedAt: true,
        expectedPartCount: true,
      },
    })
  );
}

/**
 * Bounded wait for a STABLE blocking state — backends parked as row-lock
 * waiters — rather than a fixed sleep that merely hopes contention happened.
 */
async function waitForLockWaiters(
  min: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await withDb(
      (db) => db.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count
        FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `
    );
    if (Number(rows[0]?.count ?? 0n) >= min) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `expected >=${min} lock waiters on the session row within ${timeoutMs}ms — is lockSessionDetail still taken before the generation identity read?`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!hasDatabase)(
  "ISS-8267 component-invocation ingest against real Postgres",
  () => {
    beforeAll(async () => {
      await withDb(async (db) => {
        await db.organization.create({
          data: {
            id: ORG_ID,
            clerkId: `clerk_org_${ORG_ID}`,
            name: "ISS-8267 RealDB Org",
            slug: `iss8267-${ORG_ID}`,
          },
          select: { id: true },
        });
        await db.user.create({
          data: {
            id: USER_ID,
            organizationId: ORG_ID,
            clerkId: `clerk_user_${USER_ID}`,
            email: `iss8267-${USER_ID}@example.test`,
          },
          select: { id: true },
        });
        await db.computeTarget.create({
          data: {
            id: COMPUTE_TARGET_ID,
            organizationId: ORG_ID,
            userId: USER_ID,
            machineName: "iss8267-machine",
            platform: "darwin",
          },
          select: { id: true },
        });
        await db.artifact.create({
          data: {
            id: SESSION_ID,
            organizationId: ORG_ID,
            type: "SESSION",
            name: "ISS-8267 session",
            slug: `iss8267-session-${SESSION_ID.slice(0, 8)}`,
            status: "active",
          },
          select: { id: true },
        });
        const seedSession = async (
          artifactId: string,
          externalSessionId: string
        ) => {
          await db.artifact.create({
            data: {
              id: artifactId,
              organizationId: ORG_ID,
              type: "SESSION",
              name: `ISS-5801 ${externalSessionId}`,
              slug: `iss5801-${externalSessionId}`,
              status: "active",
            },
            select: { id: true },
          });
          await db.sessionDetail.create({
            data: {
              artifactId,
              computeTargetId: COMPUTE_TARGET_ID,
              externalSessionId,
              harness: "claude",
              sessionStartedAt: new Date("2026-07-22T10:00:00Z"),
              sessionUpdatedAt: new Date("2026-07-22T12:00:00Z"),
              lastActivityAt: new Date("2026-07-22T12:00:00Z"),
            },
            // `*Detail` tables are keyed on artifactId, not id.
            select: { artifactId: true },
          });
        };
        await db.sessionDetail.create({
          data: {
            artifactId: SESSION_ID,
            computeTargetId: COMPUTE_TARGET_ID,
            externalSessionId: EXTERNAL_SESSION_ID,
            harness: "claude",
            sessionStartedAt: new Date("2026-07-22T10:00:00Z"),
            sessionUpdatedAt: new Date("2026-07-22T12:00:00Z"),
            lastActivityAt: new Date("2026-07-22T12:00:00Z"),
          },
          // `*Detail` tables are keyed on artifactId, not id.
          select: { artifactId: true },
        });
        await seedSession(STAGED_SESSION_ID, STAGED_EXTERNAL_SESSION_ID);
        await seedSession(BARE_SESSION_ID, BARE_EXTERNAL_SESSION_ID);
      });
    });

    afterAll(async () => {
      // Explicit child-first teardown: `users.organization_id` is RESTRICT, not
      // CASCADE. Deleting sessionDetail cascades the generation tree
      // (fk_acig_session onDelete: Cascade, then generation → parts/invocations).
      await withDb(async (db) => {
        await db.sessionDetail.deleteMany({
          where: { computeTargetId: COMPUTE_TARGET_ID },
        });
        await db.artifact.deleteMany({ where: { organizationId: ORG_ID } });
        await db.computeTarget.deleteMany({
          where: { organizationId: ORG_ID },
        });
        await db.user.deleteMany({ where: { organizationId: ORG_ID } });
        await db.organization.deleteMany({ where: { id: ORG_ID } });
      });
    });

    it("creates and activates a generation, and acks an identical retry idempotently", async () => {
      const part = buildPart({
        allItems: [
          buildItem(),
          buildItem({ externalInvocationId: "invocation-2", sequence: 1 }),
        ],
      });

      const first = await ingest(part);
      const retried = await ingest(part);

      expect(first).toEqual({
        ok: true,
        value: { state: AgentComponentInvocationSyncAckState.Activated },
      });
      expect(retried).toEqual(first);

      const generations = await readGenerations();
      expect(generations).toHaveLength(1);
      expect(generations[0]?.externalGenerationId).toBe(
        part.externalGenerationId
      );
      expect(generations[0]?.activeAt).not.toBeNull();
      expect(generations[0]?.completedAt).not.toBeNull();
      const invocationCount = await withDb((db) =>
        db.agentComponentInvocation.count({
          where: { generationId: generations[0]?.id },
        })
      );
      expect(invocationCount).toBe(2);
    });

    it("inserts a successor generation while an ACTIVE row holds the partial unique", async () => {
      // Continues from the previous case ON PURPOSE: the ACTIVE generation it
      // left is the `active_at IS NOT NULL` holder this case exists to insert
      // beside. Pin that precondition so a standalone run fails loudly here
      // instead of passing without ever proving the named scenario.
      const before = await readGenerations();
      expect(before).toHaveLength(1);
      expect(before[0]?.activeAt).not.toBeNull();

      const successor = buildPart({
        allItems: [buildItem({ externalInvocationId: "invocation-3" })],
        sourceUpdatedAt: "2026-07-22T14:00:00.000Z",
        sourceSequence: 2,
      });

      const result = await ingest(successor);

      expect(result).toEqual({
        ok: true,
        value: { state: AgentComponentInvocationSyncAckState.Activated },
      });
      const generations = await readGenerations();
      expect(generations).toHaveLength(1);
      expect(generations[0]?.externalGenerationId).toBe(
        successor.externalGenerationId
      );
      expect(generations[0]?.activeAt).not.toBeNull();
    });

    it("serializes concurrent same-session ingests on the session row lock", async () => {
      const contended = buildPart({
        allItems: [buildItem({ externalInvocationId: "invocation-4" })],
        sourceUpdatedAt: "2026-07-22T15:00:00.000Z",
        sourceSequence: 3,
      });

      let signalHeld = () => {
        /* replaced synchronously below */
      };
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      let releaseLock = () => {
        /* replaced synchronously below */
      };
      const released = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      // Hold the exact lock `lockSessionDetail` takes, in a foreign
      // transaction, so both ingests must queue behind it.
      const holder = withDb.tx(
        async (tx) => {
          await tx.$queryRaw`
            SELECT artifact_id FROM session_detail
            WHERE artifact_id = ${SESSION_ID}::uuid
            FOR UPDATE
          `;
          signalHeld();
          await released;
        },
        // Held across `waitForLockWaiters`' own 15s bound below, so this has to
        // outlast it — and 5s + 20s leaves 5s under the tier's 30s test budget,
        // which is what keeps a stall failing on the test clock rather than
        // detaching the transaction (ISS-8553). Sized off the 15s bound it must
        // outlast, not off the budget it must fit in: spending the budget down
        // to its last second is the race, and this is the one case in the file
        // that actually contends on a lock.
        { maxWait: 5000, timeout: 20_000 }
      );
      await held;

      const ingests = [ingest(contended), ingest(contended)];
      // Both duplicate deliveries must PARK on the session row before either
      // reads the generation identity — the serialization the read-then-write
      // fix leans on. If the lock is removed or taken after the read, neither
      // waiter appears and this times out.
      await waitForLockWaiters(2, 15_000);
      releaseLock();

      const [first, second] = await Promise.all(ingests);
      await holder;

      expect(first).toEqual({
        ok: true,
        value: { state: AgentComponentInvocationSyncAckState.Activated },
      });
      expect(second).toEqual(first);
      const generations = await readGenerations();
      expect(generations).toHaveLength(1);
      expect(generations[0]?.externalGenerationId).toBe(
        contended.externalGenerationId
      );
    });

    it("ISS-5801: activation folds the invocation count and retention spares the invocation-only session", async () => {
      // The seeded session is the exact slash-only shape — zero turns, tokens,
      // and tool uses — and the preceding case left a 1-invocation generation
      // ACTIVE, whose activation transaction must have folded the count onto
      // the parent row.
      const detail = await withDb((db) =>
        db.sessionDetail.findUnique({
          where: { artifactId: SESSION_ID },
          select: {
            componentInvocationCount: true,
            turns: true,
            toolUseCount: true,
          },
        })
      );
      expect(detail?.turns).toBeNull();
      expect(detail?.toolUseCount).toBe(0);
      expect(detail?.componentInvocationCount).toBe(1);

      // Cutoff AFTER the session's lastActivityAt: aged, desktop-origin, no PR,
      // no pending chunk — every other phantom condition holds, so the ONLY
      // thing keeping this session out of the destructive sweep is the widened
      // idle predicate reading the folded count. Purging it would re-orphan its
      // invocation children as terminal `session_missing` — the exact ISS-5801
      // defect.
      const phantoms = await withDb((db) =>
        db.sessionDetail.findMany({
          where: phantomSessionWhere(
            new Date("2026-08-01T00:00:00.000Z"),
            ORG_ID
          ),
          select: { artifactId: true },
        })
      );
      expect(phantoms.map((p) => p.artifactId)).not.toContain(SESSION_ID);
    });

    it("ISS-5801: a STAGED multipart generation spares its aged parent from the phantom sweep", async () => {
      // Part 0 of 2 lands and stays staged — the count folds only at
      // activation, so the parent still presents the idle shape while the
      // later part is in flight. The sweep must not cascade it away (that
      // would terminally re-orphan part 1 as `session_missing`).
      const first = buildItem({
        externalInvocationId: "staged-invocation-1",
        sequence: 0,
      });
      const second = buildItem({
        externalInvocationId: "staged-invocation-2",
        sequence: 1,
      });
      const staged = await agentComponentInvocationsService.ingestPart({
        organizationId: ORG_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        part: buildPart({
          externalSessionId: STAGED_EXTERNAL_SESSION_ID,
          allItems: [first, second],
          items: [first],
          partCount: 2,
        }),
      });
      expect(staged).toEqual({
        ok: true,
        value: { state: AgentComponentInvocationSyncAckState.Staged },
      });

      const phantoms = await withDb((db) =>
        db.sessionDetail.findMany({
          where: phantomSessionWhere(
            new Date("2026-08-01T00:00:00.000Z"),
            ORG_ID
          ),
          select: { artifactId: true },
        })
      );
      const phantomIds = phantoms.map((p) => p.artifactId);
      expect(phantomIds).not.toContain(STAGED_SESSION_ID);
      // The bare sibling — same idle shape, no generation rows — IS swept,
      // so the sparing above is the generation row, not a dead predicate.
      expect(phantomIds).toContain(BARE_SESSION_ID);
    });

    /**
     * ISS-8736 (review: davetho). The defect this fixes is a REAL Postgres
     * error — `54000 index row size ... exceeds btree version 4 maximum` — which
     * a stateful `createMany` fake cannot raise and therefore cannot prove
     * fixed. These drive the production entry point against real migrated
     * Postgres, so the btree itself accepts (or rejects) the write.
     *
     * On unprojected `main` every case here fails with `IngestionFailed`.
     */
    describe("ISS-8736: over-budget index keys", () => {
      const OVER_BUDGET = "z".repeat(3000);

      it.each([
        ["externalInvocationId", 16],
        ["componentKey", 17],
        ["branchName", 18],
      ] as const)(
        "persists and activates an over-budget %s that the btree could not hold raw",
        async (field, hour) => {
          const item = buildItem({
            externalInvocationId: `over-${field}`,
            [field]: `${field}-${OVER_BUDGET}`,
            sequence: 0,
          });
          const part = buildPart({
            allItems: [item],
            sourceUpdatedAt: `2026-07-22T${hour}:00:00.000Z`,
            sourceSequence: hour,
          });

          const result = await ingest(part);

          expect(result).toEqual({
            ok: true,
            value: { state: AgentComponentInvocationSyncAckState.Activated },
          });
          const rows = await withDb((db) =>
            db.agentComponentInvocation.findMany({
              where: {
                generation: { externalGenerationId: part.externalGenerationId },
              },
              select: {
                externalInvocationId: true,
                componentKey: true,
                branchName: true,
              },
            })
          );
          expect(rows).toHaveLength(1);
          const stored = String(rows[0]?.[field]);
          // Stored PROJECTED, and inside the budget the index can physically
          // hold — the row exists at all only because of that.
          expect(stored).not.toBe(`${field}-${OVER_BUDGET}`);
          expect(hasProjectedIndexKeyShape(stored)).toBe(true);
          expect(
            new TextEncoder().encode(stored).byteLength
          ).toBeLessThanOrEqual(INDEX_KEY_MAX_BYTES);
        }
      );

      it("acks an identical retry of an over-budget externalInvocationId idempotently", async () => {
        const item = buildItem({
          externalInvocationId: `retry-${OVER_BUDGET}`,
          sequence: 0,
        });
        const part = buildPart({
          allItems: [item],
          sourceUpdatedAt: "2026-07-22T19:00:00.000Z",
          sourceSequence: 19,
        });

        const first = await ingest(part);
        const retried = await ingest(part);

        expect(first).toEqual({
          ok: true,
          value: { state: AgentComponentInvocationSyncAckState.Activated },
        });
        expect(retried).toEqual(first);
        // The retry de-duped on the PROJECTED unique key rather than inserting
        // a second row: the projection is a pure function, so both passes land
        // on the same `(generation_id, external_invocation_id)`.
        const count = await withDb((db) =>
          db.agentComponentInvocation.count({
            where: {
              generation: { externalGenerationId: part.externalGenerationId },
            },
          })
        );
        expect(count).toBe(1);
      });

      it("rejects a second part reusing the same over-budget externalInvocationId", async () => {
        const duplicated = `dupe-${OVER_BUDGET}`;
        const first = buildItem({
          externalInvocationId: duplicated,
          sequence: 0,
        });
        const second = buildItem({
          externalInvocationId: duplicated,
          sequence: 1,
        });
        const allItems = [first, second];

        const staged = await ingest(
          buildPart({
            allItems,
            items: [first],
            partIndex: 0,
            partCount: 2,
            sourceUpdatedAt: "2026-07-22T20:00:00.000Z",
            sourceSequence: 20,
          })
        );
        expect(staged).toEqual({
          ok: true,
          value: { state: AgentComponentInvocationSyncAckState.Staged },
        });

        const conflicting = await ingest(
          buildPart({
            allItems,
            items: [second],
            partIndex: 1,
            partCount: 2,
            sourceUpdatedAt: "2026-07-22T20:00:00.000Z",
            sourceSequence: 20,
          })
        );

        // Projection is collision-resistant, so two distinct raw ids stay
        // distinct — but the SAME raw id must still collide, exactly as it did
        // before it was long enough to project.
        expect(conflicting.ok).toBe(false);
      });
    });
  }
);
