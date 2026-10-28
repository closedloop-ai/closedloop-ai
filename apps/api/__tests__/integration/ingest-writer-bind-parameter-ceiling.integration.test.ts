/**
 * ISS-8062 — the session-ingest writers at the Postgres bind-parameter ceiling,
 * against a real Postgres.
 *
 * THERE ARE TWO CEILINGS, and which one a statement meets depends on whether
 * Prisma gets to inspect it. A statement Prisma BUILDS is refused at 32,767
 * parameters by PRISMA CLIENT'S OWN per-statement budget. A statement passed
 * through VERBATIM (`$executeRaw`) is never inspected and reaches the wire, where
 * the `Bind` message counts parameters in a uint16 and wraps past 65,535, so the
 * server rejects it outright with `08P01`. Either way the whole payload is lost,
 * not truncated. The wire schema used to keep these writers away from both edges
 * with `.max()` bounds; ISS-8051 is removing them, so the writers have to hold on
 * their own.
 *
 * ISS-8239 corrected the RATIONALE above, not the numbers, and not one assertion
 * below. This header used to attribute the 32,767 figure to the Postgres driver
 * counting parameters in a SIGNED i16, "half the wire figure". That is refuted:
 * the wire counts in a UINT16 in both directions, which is exactly why the
 * verbatim writer below reaches 65,535 rather than stopping at half of it. The
 * two ceilings are real and measured; only the mechanism named for the first one
 * was wrong.
 *
 * FOUR PAYLOAD DIMENSIONS reach a statement here, and a cap on one does not
 * bound the others — that is the trap this suite exists to hold shut:
 *   - ROWS, via the raw `INSERT ... ON CONFLICT` (13 parameters each);
 *   - GROUPS, i.e. distinct (kind, key), via the FEA-2990 prune;
 *   - BRANCHES WITHIN ONE GROUP, which the prune's old `notIn` bound one
 *     parameter each — invisible to a cap on groups;
 *   - DISTINCT COMPONENT IDS, via the inventory FK lookup, which the other
 *     fixtures never reach because they omit `externalComponentId`.
 *
 * The two writers, and only ONE of them was ever broken:
 *
 *   - `persistSessionComponentUsage` builds a raw multi-row
 *     `INSERT ... ON CONFLICT` with `$executeRaw`, which Prisma passes through
 *     verbatim. 13 bind parameters per row, so 5,042 rows overflows. Measured on
 *     `origin/main`: 5,041 rows commit, 5,042 fail with
 *     `bind message has 10 parameter formats but 0 parameters` — 5,042 * 13 =
 *     65,546, which is 10 (mod 65,536), the wraparound made visible.
 *
 *   - `persistSessionActivitySegments` uses `createMany`, which Prisma SPLITS
 *     across statements on its own bind-value budget before anything reaches the
 *     wire. It was never at risk. This suite pins that, because the protection is
 *     Prisma's rather than this module's: a future rewrite of that lane onto raw
 *     SQL would inherit the component-usage defect silently, and this is what
 *     would catch it.
 *
 * WHY THE ASSERTIONS COUNT ROWS AND NAME THEM. A chunker that drops its tail
 * raises no error, so "it didn't throw" proves nothing. Every case below asserts
 * the persisted COUNT and then reads back the FIRST and LAST rows by identity,
 * because the tail is exactly what a fencepost bug loses.
 *
 * Deliberately NOT run inside `autoRollbackTransaction`: the behavior under test
 * is whether a payload COMMITS whole, so the commit boundary has to be real.
 * Everything is namespaced under one org and dropped in `afterAll`.
 *
 * Run against a throwaway database:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:58062/app \
 *     pnpm --filter api exec vitest run \
 *     __tests__/integration/ingest-writer-bind-parameter-ceiling.integration.test.ts \
 *     --config vitest.config.integration.mts
 */
import { randomUUID } from "node:crypto";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistSessionActivitySegments } from "../../app/agent-sessions/service/activity-segment-persistence";
import { persistSessionComponentUsage } from "../../app/agent-sessions/service/component-usage";
import {
  syncedActivitySegmentRowSchema,
  syncedComponentUsageSchema,
} from "../../lib/desktop-agent-sessions-schema";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const COMPUTE_TARGET_ID = randomUUID();
const FOREIGN_COMPUTE_TARGET_ID = randomUUID();
const USAGE_SESSION_ID = randomUUID();
const PRUNE_SESSION_ID = randomUUID();
const SEGMENT_SESSION_ID = randomUUID();
const BRANCH_FANOUT_SESSION_ID = randomUUID();
const INVENTORY_SESSION_ID = randomUUID();

const SESSION_IDS = [
  USAGE_SESSION_ID,
  PRUNE_SESSION_ID,
  SEGMENT_SESSION_ID,
  BRANCH_FANOUT_SESSION_ID,
  INVENTORY_SESSION_ID,
] as const;

const USAGE_SESSION_IDS = [
  USAGE_SESSION_ID,
  PRUNE_SESSION_ID,
  BRANCH_FANOUT_SESSION_ID,
  INVENTORY_SESSION_ID,
] as const;

/**
 * The uint16 ceiling on parameters in a single `Bind` message, which is what a
 * `$executeRaw` statement meets because Prisma passes it through verbatim. A
 * literal, not an import: this is a PostgreSQL wire-protocol fact, and deriving
 * the fixture from a constant the production code owns would let a wrong
 * constant silently redefine what "over the ceiling" means.
 *
 * Measured on this stack: 40,000 parameters are accepted, 65,536 fails with
 * `08P01` (`bind message supplies 0 parameters, but prepared statement ""
 * requires 65536`).
 */
const POSTGRES_MAX_RAW_BIND_PARAMETERS = 65_535;

/**
 * THE OTHER CEILING, and it is HALF the wire figure — a coincidence of value,
 * NOT of mechanism (ISS-8239). A statement Prisma BUILDS (`findMany` /
 * `deleteMany`) never reaches the wire limit because Prisma Client's own
 * per-statement budget refuses it at 32,767 first. It is not the driver halving
 * a uint16 into a signed i16, which is what this comment used to say.
 *
 * Measured on this stack (Prisma 7.8 / `@prisma/adapter-pg` / PostgreSQL 16),
 * from both directions and in both shapes this module uses:
 *   - a bare `gitBranch: { notIn: [...] }` is accepted at 32,763 branches
 *     (32,766 parameters) and refused at 32,764 (32,767);
 *   - the grouped `OR` the prune used to build is accepted at 10,921 groups
 *     (32,764 parameters) and refused at 10,922 (32,767).
 *
 * An earlier revision of this suite put the prune's refusal at 21,845 groups, by
 * dividing the WIRE figure by 3. That was the wrong ceiling for a built
 * statement — the real one is 10,922 groups. The fixtures below were already
 * past both, so nothing was silently passing, but the arithmetic is fixed here
 * so a future reader does not size a new fixture off the wrong number.
 */
const PRISMA_MAX_BUILT_BIND_PARAMETERS = 32_767;

/** Bind parameters the component-usage row shape emits, counted off the INSERT's
 * own column list: 15 columns, of which `created_at`/`updated_at` are the SQL
 * literal `NOW()` and bind nothing. */
const COMPONENT_USAGE_BIND_PARAMETERS_PER_ROW = 13;

/** Comfortably past 5,041 — the last row count that fits in one statement. */
const OVER_CEILING_USAGE_ROWS = 5200;

/**
 * The FEA-2990 branch-bucket prune bound ~3 parameters per GROUP, against the
 * BUILT-statement ceiling — so it was refused from 10,922 groups up, long before
 * the insert's own limit. 22,000 groups is comfortably past that.
 */
const PRUNE_BIND_PARAMETERS_PER_GROUP = 3;
const OVER_CEILING_PRUNE_ROWS = 22_000;

/**
 * ONE component, many BRANCHES (whitlockk review). The prune's old predicate bound
 * one parameter per KEPT BRANCH, and slicing by group could not touch that: a
 * single group carries its whole branch set into one statement however few
 * groups a slice holds. 34,000 branches is 34,002 parameters in one `notIn` —
 * past the 32,767 a built statement is refused at, while still being ONE group,
 * so a group-count cap cannot help it.
 */
const OVER_CEILING_BRANCH_COUNT = 34_000;

/**
 * DISTINCT inventory ids, for the lookup `resolveAgentComponentIdMap` builds
 * (codex review). Before ISS-8391 it bound 2 parameters per pair plus the
 * compute target, so 17,000 pairs reached 34,001 before either write ran.
 */
const OVER_CEILING_INVENTORY_ROWS = 17_000;
const PRE_ISS_8391_INVENTORY_BIND_PARAMETERS_PER_PAIR = 2;

/**
 * Past the row count ISS-8062 predicted would break the segment writer (~7,281),
 * so a regression that moved this lane onto an unchunked raw INSERT could not
 * hide under the threshold.
 */
const OVER_CEILING_SEGMENT_ROWS = 7400;

/**
 * Prisma's interactive-transaction default is 5s, which the writes below do
 * exceed, so these transactions need an explicit bound.
 *
 * It must stay UNDER the tier's 30s `testTimeout`, not merely within it
 * (ISS-8542). Prisma arms this clock after BEGIN, later than Vitest arms the
 * test's, so at equal values Vitest always wins: the test is failed while the
 * transaction runs on, detached, still holding one of the pool's 10 connections
 * and naming nothing. Losing that race deliberately is what makes the failure
 * say `Transaction ... timed out` instead of an anonymous test timeout.
 *
 * What has to fit the test bound is the SUM of the transactions one test
 * awaits, not the largest of them. The branch-bucket prune below runs two syncs
 * in sequence — the second has to observe the bucket the first seeded — and at
 * the previous 20s each they declared 40s inside a 30s test: if the first spent
 * 11s the second could not finish before Vitest reaped the test, which is the
 * detached transaction this bound exists to avoid. So the budget is half the
 * test bound with room to spare, and any test here may await two of them.
 * Slowest whole test measured across 14 green CI runs is 7.6s, so one
 * transaction still gets ~1.6x the observed cost of an entire test.
 *
 * The ceiling itself is the point: a suite whose declared budget outlasts the
 * 15-minute job cap cannot fail — it reaps the job instead, and the reap loses
 * the per-file results of all ~124 suites. `integration-suite-timeout-budget`
 * holds this strictly below the resolved config, sequences summed.
 */
const TRANSACTION_TIMEOUT_MS = 12_000;

/** Zero-padded so lexical order matches insertion order for the tail reads. */
function usageKey(index: number): string {
  return `iss8062-component-${String(index).padStart(6, "0")}`;
}

/**
 * Rows are PARSED through the real per-ROW ingest schemas rather than hand-cast
 * past them, so the fixtures carry exactly what a desktop payload would.
 *
 * The row schemas, not the session schema: the array-level `.max()` bounds are
 * what ISS-8051 is in the middle of removing, and a fixture that had to satisfy
 * one could not describe the world these writers must survive. Nothing here
 * asserts anything about those bounds in either direction.
 */
function usageSession(
  rowCount: number,
  gitBranch: string | null = null
): SyncedAgentSession {
  return {
    components: Array.from({ length: rowCount }, (_, index) =>
      syncedComponentUsageSchema.parse({
        componentKind: "skill",
        componentKey: usageKey(index),
        // Distinct per row, so a read-back can prove THIS row survived rather
        // than merely that some row with the right key did.
        invocations: index + 1,
        errorCount: 0,
        gitBranch,
      })
    ),
  } as SyncedAgentSession;
}

/** Zero-padded for the same reason as {@link usageKey}. */
function branchName(index: number): string {
  return `feat/iss8062-branch-${String(index).padStart(6, "0")}`;
}

function inventoryExternalId(index: number): string {
  return `iss8062-ext-${String(index).padStart(6, "0")}`;
}

function foreignOnlyInventoryExternalId(): string {
  return "iss8062-foreign-only-ext";
}

/**
 * ONE component across many branches, carrying a populated
 * `externalComponentId` — the exact shape BOTH review findings describe, and it
 * defeats a group-count cap twice over:
 *
 *   - the prune puts every branch into the SAME group's `notIn`, so slicing by
 *     group leaves one statement binding a parameter per branch;
 *   - the inventory lookup sees the same (kind, externalComponentId) repeated
 *     once per branch, because `usages` is deduped on a natural key that
 *     INCLUDES the branch. Undeduped that is one `OR` branch per bucket.
 */
function branchFanoutSession(
  componentKey: string,
  branches: readonly string[]
): SyncedAgentSession {
  return {
    components: branches.map((gitBranch, index) =>
      syncedComponentUsageSchema.parse({
        componentKind: AgentComponentKind.Skill,
        componentKey,
        errorCount: 0,
        externalComponentId: inventoryExternalId(0),
        gitBranch,
        invocations: index + 1,
      })
    ),
  } as SyncedAgentSession;
}

/**
 * Many DISTINCT (kind, externalComponentId) pairs. Deduping cannot help this
 * one, so it is the half of the codex finding that `branchFanoutSession` above
 * does not reach.
 */
function inventoryUsageSession(rowCount: number): SyncedAgentSession {
  return {
    components: [
      ...Array.from({ length: rowCount }, (_, index) =>
        syncedComponentUsageSchema.parse({
          componentKind: AgentComponentKind.Skill,
          componentKey: usageKey(index),
          errorCount: 0,
          externalComponentId: inventoryExternalId(index),
          invocations: index + 1,
        })
      ),
      syncedComponentUsageSchema.parse({
        componentKind: AgentComponentKind.Skill,
        componentKey: "foreign-only-component",
        errorCount: 0,
        externalComponentId: foreignOnlyInventoryExternalId(),
        invocations: rowCount + 1,
      }),
    ],
  } as SyncedAgentSession;
}

function segmentSession(rowCount: number): SyncedAgentSession {
  return {
    activitySegmentRows: Array.from({ length: rowCount }, (_, index) =>
      syncedActivitySegmentRowSchema.parse({
        phase: "other",
        // Non-overlapping half-open spans, which the writer's tiling validation
        // requires and the unique (session, start_ms) key relies on.
        startMs: index * 10,
        endMs: index * 10 + 5,
        confidence: 0.5,
        evidenceLayers: [],
        version: 1,
      })
    ),
  } as SyncedAgentSession;
}

beforeAll(async () => {
  await withDb(async (db) => {
    await db.organization.create({
      data: {
        id: ORG_ID,
        clerkId: `clerk_org_${ORG_ID}`,
        name: "ISS-8062 bind-parameter org",
        slug: `iss8062-${ORG_ID}`,
      },
      select: { id: true },
    });
    await db.user.create({
      data: {
        id: USER_ID,
        organizationId: ORG_ID,
        clerkId: `clerk_user_${USER_ID}`,
        email: "iss8062@example.com",
      },
      select: { id: true },
    });
    await db.computeTarget.create({
      data: {
        id: COMPUTE_TARGET_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        machineName: "iss8062-machine",
        platform: "darwin",
      },
      select: { id: true },
    });
    await db.computeTarget.create({
      data: {
        id: FOREIGN_COMPUTE_TARGET_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        machineName: "iss8062-foreign-machine",
        platform: "darwin",
      },
      select: { id: true },
    });
    for (const sessionId of SESSION_IDS) {
      await db.artifact.create({
        data: {
          id: sessionId,
          organizationId: ORG_ID,
          type: "SESSION",
          name: `ISS-8062 session ${sessionId.slice(0, 8)}`,
          slug: `iss8062-session-${sessionId.slice(0, 8)}`,
          status: "active",
        },
        select: { id: true },
      });
      await db.sessionDetail.create({
        data: {
          artifactId: sessionId,
          computeTargetId: COMPUTE_TARGET_ID,
          externalSessionId: `ext-${sessionId}`,
          harness: "claude",
          sessionStartedAt: new Date("2026-01-01T00:00:00Z"),
          sessionUpdatedAt: new Date("2026-01-01T01:00:00Z"),
          lastActivityAt: new Date("2026-01-01T01:00:00Z"),
        },
        // `*Detail` tables are keyed on artifactId, not id.
        select: { artifactId: true },
      });
    }

    // Inventory rows for the FK the usage writer resolves. Seeded via
    // `createMany`, which Prisma splits on its own bind budget — the seed is not
    // what is under test.
    await db.agentComponent.createMany({
      data: Array.from({ length: OVER_CEILING_INVENTORY_ROWS }, (_, index) => ({
        componentKind: AgentComponentKind.Skill,
        computeTargetId: COMPUTE_TARGET_ID,
        externalComponentId: inventoryExternalId(index),
        organizationId: ORG_ID,
      })),
    });
    await db.agentComponent.createMany({
      data: [
        {
          componentKind: AgentComponentKind.Skill,
          computeTargetId: FOREIGN_COMPUTE_TARGET_ID,
          externalComponentId: inventoryExternalId(0),
          organizationId: ORG_ID,
        },
        {
          componentKind: AgentComponentKind.Skill,
          computeTargetId: FOREIGN_COMPUTE_TARGET_ID,
          externalComponentId: inventoryExternalId(
            OVER_CEILING_INVENTORY_ROWS - 1
          ),
          organizationId: ORG_ID,
        },
        {
          componentKind: AgentComponentKind.Skill,
          computeTargetId: FOREIGN_COMPUTE_TARGET_ID,
          externalComponentId: foreignOnlyInventoryExternalId(),
          organizationId: ORG_ID,
        },
      ],
    });
  });
});

afterAll(async () => {
  // Explicit child-first teardown: `users.organization_id` is RESTRICT, not
  // CASCADE, so deleting the org alone leaves the run's rows behind and fails.
  await withDb(async (db) => {
    await db.agentComponentSessionUsage.deleteMany({
      where: { agentSessionId: { in: [...USAGE_SESSION_IDS] } },
    });
    await db.agentSessionActivitySegment.deleteMany({
      where: { agentSessionId: SEGMENT_SESSION_ID },
    });
    await db.sessionDetail.deleteMany({
      where: { artifactId: { in: [...SESSION_IDS] } },
    });
    await db.artifact.deleteMany({ where: { organizationId: ORG_ID } });
    // Before `compute_targets`: the FK from inventory rows is RESTRICT.
    await db.agentComponent.deleteMany({ where: { organizationId: ORG_ID } });
    await db.computeTarget.deleteMany({ where: { organizationId: ORG_ID } });
    await db.user.deleteMany({ where: { organizationId: ORG_ID } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
  });
});

describeIfDb("ISS-8062 ingest writers past the bind-parameter ceiling", () => {
  it("component usage: the fixture actually exceeds one statement's parameter budget", () => {
    // The fixture is only discriminating if it really does overflow. Assert that
    // rather than assume it: a row shape that lost a column, or a row count
    // trimmed for speed, would leave the case below passing on `origin/main` and
    // proving nothing.
    expect(
      OVER_CEILING_USAGE_ROWS * COMPONENT_USAGE_BIND_PARAMETERS_PER_ROW
    ).toBeGreaterThan(POSTGRES_MAX_RAW_BIND_PARAMETERS);
  });

  it("component usage: persists every row past the ceiling, tail included", async () => {
    await withDb.tx(
      async (tx) => {
        await persistSessionComponentUsage(
          tx,
          COMPUTE_TARGET_ID,
          USAGE_SESSION_ID,
          usageSession(OVER_CEILING_USAGE_ROWS)
        );
      },
      { timeout: TRANSACTION_TIMEOUT_MS }
    );

    const persisted = await withDb((db) =>
      db.agentComponentSessionUsage.count({
        where: { agentSessionId: USAGE_SESSION_ID },
      })
    );
    expect(persisted).toBe(OVER_CEILING_USAGE_ROWS);

    // Identity, not just arity. A chunker that dropped its last slice would
    // still have written *a* lot of rows; only the tail read catches it.
    const edges = await withDb((db) =>
      db.agentComponentSessionUsage.findMany({
        where: {
          agentSessionId: USAGE_SESSION_ID,
          componentKey: {
            in: [usageKey(0), usageKey(OVER_CEILING_USAGE_ROWS - 1)],
          },
        },
        select: { componentKey: true, invocationCount: true },
        orderBy: { componentKey: "asc" },
      })
    );
    expect(edges).toEqual([
      { componentKey: usageKey(0), invocationCount: 1 },
      {
        componentKey: usageKey(OVER_CEILING_USAGE_ROWS - 1),
        invocationCount: OVER_CEILING_USAGE_ROWS,
      },
    ]);
  });

  it("component usage: a re-sync of the same over-ceiling payload stays idempotent", async () => {
    // Chunking must not change the upsert's identity semantics. Re-running the
    // same payload has to land on ON CONFLICT for every row and leave the count
    // unchanged — a chunker that re-inserted instead of upserting would double
    // this, and a unique-violation would surface here rather than in production.
    await withDb.tx(
      async (tx) => {
        await persistSessionComponentUsage(
          tx,
          COMPUTE_TARGET_ID,
          USAGE_SESSION_ID,
          usageSession(OVER_CEILING_USAGE_ROWS)
        );
      },
      { timeout: TRANSACTION_TIMEOUT_MS }
    );

    const persisted = await withDb((db) =>
      db.agentComponentSessionUsage.count({
        where: { agentSessionId: USAGE_SESSION_ID },
      })
    );
    expect(persisted).toBe(OVER_CEILING_USAGE_ROWS);
  });

  it("component usage: the branch-bucket prune fixture exceeds its own parameter budget", () => {
    expect(
      OVER_CEILING_PRUNE_ROWS * PRUNE_BIND_PARAMETERS_PER_GROUP
    ).toBeGreaterThan(PRISMA_MAX_BUILT_BIND_PARAMETERS);
  });

  it("component usage: the one-group and inventory fixtures exceed the built-statement budget", () => {
    // Both of these are payload dimensions a group-count or row-count cap does
    // not see. Assert each really is over the line its old statement shape
    // refused at, or the two cases below would be green on the shape they exist
    // to reject.
    expect(OVER_CEILING_BRANCH_COUNT).toBeGreaterThan(
      PRISMA_MAX_BUILT_BIND_PARAMETERS
    );
    expect(
      OVER_CEILING_INVENTORY_ROWS *
        PRE_ISS_8391_INVENTORY_BIND_PARAMETERS_PER_PAIR
    ).toBeGreaterThan(PRISMA_MAX_BUILT_BIND_PARAMETERS);
  });

  it("component usage: prunes stale branch buckets past the ceiling, all of them", async () => {
    // Seed one branch bucket per component, then re-sync the SAME components on
    // a different branch. The FEA-2990 prune has to drop every `feat/a` bucket,
    // and it binds per group — so at this size it is the prune, not the insert,
    // that decides whether the session survives.
    for (const branch of ["feat/a", "feat/b"]) {
      await withDb.tx(
        async (tx) => {
          await persistSessionComponentUsage(
            tx,
            COMPUTE_TARGET_ID,
            PRUNE_SESSION_ID,
            usageSession(OVER_CEILING_PRUNE_ROWS, branch)
          );
        },
        { timeout: TRANSACTION_TIMEOUT_MS }
      );
    }

    const byBranch = await withDb((db) =>
      db.agentComponentSessionUsage.groupBy({
        by: ["gitBranch"],
        where: { agentSessionId: PRUNE_SESSION_ID },
        _count: { _all: true },
      })
    );
    // Exactly one bucket per component, on the newest branch. A prune that
    // stopped after its first slice would leave `feat/a` rows behind here — and
    // those are precisely the orphans FEA-2990 exists to stop double-counting.
    expect(byBranch).toEqual([
      { gitBranch: "feat/b", _count: { _all: OVER_CEILING_PRUNE_ROWS } },
    ]);
  });

  it("component usage: prunes one component's stale bucket when that component alone carries more branches than the ceiling", async () => {
    // whitlockk review. ONE group, so a cap on GROUPS per statement never splits
    // it — the whole branch set lands in a single predicate. The first sync
    // seeds a bucket the second sync's payload does not list, so the prune has
    // to run and drop it; if the prune throws, nothing after it commits and
    // the counts below are wrong rather than merely stale.
    const staleBranch = "feat/iss8062-stale";
    const componentKey = usageKey(0);
    await withDb.tx(
      async (tx) => {
        await persistSessionComponentUsage(
          tx,
          COMPUTE_TARGET_ID,
          BRANCH_FANOUT_SESSION_ID,
          branchFanoutSession(componentKey, [staleBranch])
        );
      },
      { timeout: TRANSACTION_TIMEOUT_MS }
    );

    const branches = Array.from(
      { length: OVER_CEILING_BRANCH_COUNT },
      (_, index) => branchName(index)
    );
    await withDb.tx(
      async (tx) => {
        await persistSessionComponentUsage(
          tx,
          COMPUTE_TARGET_ID,
          BRANCH_FANOUT_SESSION_ID,
          branchFanoutSession(componentKey, branches)
        );
      },
      { timeout: TRANSACTION_TIMEOUT_MS }
    );

    const persisted = await withDb((db) =>
      db.agentComponentSessionUsage.count({
        where: { agentSessionId: BRANCH_FANOUT_SESSION_ID },
      })
    );
    expect(persisted).toBe(OVER_CEILING_BRANCH_COUNT);

    // The stale bucket is the one the prune exists to remove. Naming it, not
    // just counting, is what separates "the prune ran" from "the insert
    // happened to write the same number of rows".
    const stale = await withDb((db) =>
      db.agentComponentSessionUsage.count({
        where: {
          agentSessionId: BRANCH_FANOUT_SESSION_ID,
          gitBranch: staleBranch,
        },
      })
    );
    expect(stale).toBe(0);

    // Same payload also proves the deduped lookup still resolves the FK: every
    // one of these rows repeats ONE (kind, externalComponentId).
    const edges = await withDb((db) =>
      db.agentComponentSessionUsage.findMany({
        where: {
          agentSessionId: BRANCH_FANOUT_SESSION_ID,
          gitBranch: {
            in: [branchName(0), branchName(OVER_CEILING_BRANCH_COUNT - 1)],
          },
        },
        select: { gitBranch: true, agentComponent: true },
        orderBy: { gitBranch: "asc" },
      })
    );
    expect(
      edges.map((row) => ({
        externalComponentId: row.agentComponent?.externalComponentId ?? null,
        gitBranch: row.gitBranch,
      }))
    ).toEqual([
      {
        externalComponentId: inventoryExternalId(0),
        gitBranch: branchName(0),
      },
      {
        externalComponentId: inventoryExternalId(0),
        gitBranch: branchName(OVER_CEILING_BRANCH_COUNT - 1),
      },
    ]);
  });

  it("component usage: resolves the inventory FK for more distinct component ids than one statement can bind", async () => {
    // codex review. Every row carries a POPULATED externalComponentId and each
    // one is DISTINCT, so deduping cannot shrink the lookup. The pre-existing
    // fixtures omit the field entirely and never reach this path.
    await withDb.tx(
      async (tx) => {
        await persistSessionComponentUsage(
          tx,
          COMPUTE_TARGET_ID,
          INVENTORY_SESSION_ID,
          inventoryUsageSession(OVER_CEILING_INVENTORY_ROWS)
        );
      },
      { timeout: TRANSACTION_TIMEOUT_MS }
    );

    // A lookup that silently returned fewer rows would leave the FK null and
    // raise nothing, so the assertion is on RESOLVED rows, not on row count.
    // The foreign-only row proves the raw SQL still honors the compute target
    // boundary instead of linking to another device's inventory row.
    const resolved = await withDb((db) =>
      db.agentComponentSessionUsage.count({
        where: {
          agentComponentId: { not: null },
          agentSessionId: INVENTORY_SESSION_ID,
        },
      })
    );
    expect(resolved).toBe(OVER_CEILING_INVENTORY_ROWS);

    const foreignOnly = await withDb((db) =>
      db.agentComponentSessionUsage.findUnique({
        where: {
          agentSessionId_componentKind_componentKey_gitBranch: {
            agentSessionId: INVENTORY_SESSION_ID,
            componentKind: AgentComponentKind.Skill,
            componentKey: "foreign-only-component",
            gitBranch: "",
          },
        },
        select: { agentComponentId: true },
      })
    );
    expect(foreignOnly?.agentComponentId).toBeNull();

    // And on identity at both edges: a slice loop that dropped its tail, or
    // one that merged the wrong slice's rows into the map, would mis-point
    // these rather than leave them null. The foreign target carries the same
    // external ids for both edge rows, so this also catches a missing
    // compute-target predicate.
    const edges = await withDb((db) =>
      db.agentComponentSessionUsage.findMany({
        where: {
          agentSessionId: INVENTORY_SESSION_ID,
          componentKey: {
            in: [usageKey(0), usageKey(OVER_CEILING_INVENTORY_ROWS - 1)],
          },
        },
        select: {
          componentKey: true,
          agentComponent: {
            select: { computeTargetId: true, externalComponentId: true },
          },
        },
        orderBy: { componentKey: "asc" },
      })
    );
    expect(
      edges.map((row) => ({
        computeTargetId: row.agentComponent?.computeTargetId ?? null,
        componentKey: row.componentKey,
        externalComponentId: row.agentComponent?.externalComponentId ?? null,
      }))
    ).toEqual([
      {
        computeTargetId: COMPUTE_TARGET_ID,
        componentKey: usageKey(0),
        externalComponentId: inventoryExternalId(0),
      },
      {
        computeTargetId: COMPUTE_TARGET_ID,
        componentKey: usageKey(OVER_CEILING_INVENTORY_ROWS - 1),
        externalComponentId: inventoryExternalId(
          OVER_CEILING_INVENTORY_ROWS - 1
        ),
      },
    ]);
  });

  it("activity segments: persists every row past the predicted break point", async () => {
    await withDb.tx(
      async (tx) => {
        await persistSessionActivitySegments(
          tx,
          SEGMENT_SESSION_ID,
          ORG_ID,
          segmentSession(OVER_CEILING_SEGMENT_ROWS)
        );
      },
      { timeout: TRANSACTION_TIMEOUT_MS }
    );

    const persisted = await withDb((db) =>
      db.agentSessionActivitySegment.count({
        where: { agentSessionId: SEGMENT_SESSION_ID },
      })
    );
    expect(persisted).toBe(OVER_CEILING_SEGMENT_ROWS);

    const edges = await withDb((db) =>
      db.agentSessionActivitySegment.findMany({
        where: {
          agentSessionId: SEGMENT_SESSION_ID,
          startMs: { in: [0n, BigInt((OVER_CEILING_SEGMENT_ROWS - 1) * 10)] },
        },
        select: { startMs: true, endMs: true },
        orderBy: { startMs: "asc" },
      })
    );
    expect(edges).toEqual([
      { startMs: 0n, endMs: 5n },
      {
        startMs: BigInt((OVER_CEILING_SEGMENT_ROWS - 1) * 10),
        endMs: BigInt((OVER_CEILING_SEGMENT_ROWS - 1) * 10 + 5),
      },
    ]);
  });
});
