/**
 * ISS-7259 real-Postgres round-trip for `isFirstAttributedSkill`.
 *
 * A mocked-transaction test cannot prove this. `persistSessionComponentUsage`
 * writes through a raw `INSERT ... ON CONFLICT`, so a double that records the
 * call passes identically whether the column is written, silently stripped at
 * the Zod boundary, or missing from the DDL entirely — which is the whole defect
 * class this field was at risk of. So this seeds a real relational graph, drives
 * the REAL production entry point, and reads the column back with the REAL
 * client.
 *
 * Not in the default vitest config (unit + compatibility only). Run explicitly:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:57259/app \
 *     pnpm --filter api exec vitest run \
 *     __tests__/integration/component-usage-first-attributed-skill-realdb.test.ts \
 *     --config vitest.config.mts
 *
 * Everything is namespaced under one unique org and dropped in afterAll.
 */
import { randomUUID } from "node:crypto";
import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistSessionComponentUsage } from "../../app/agent-sessions/service/component-usage";
import { syncedComponentUsageSchema } from "../../lib/desktop-agent-sessions-schema";

const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const COMPUTE_TARGET_ID = randomUUID();
const SESSION_ID = randomUUID();

const ATTRIBUTED_SKILL = "cl-produce";
const OTHER_SKILL = "logical-qa";

/**
 * The payload shape the desktop actually sends: the attributed row carries the
 * flag, every other row OMITS it (never `false`). Written as a literal rather
 * than built from the producer, so a producer that stopped emitting the field
 * cannot make this fixture agree with it.
 */
function sessionWith(
  components: readonly Record<string, unknown>[]
): SyncedAgentSession {
  // PARSED through the REAL ingest schema, not cast past it. That schema is a
  // plain (non-strict) `z.object`, so it STRIPS any field it has not declared —
  // silently, with no rejection and no log. Handing `persistSessionComponentUsage`
  // a hand-built object would skip the one boundary most able to swallow this
  // field, and the round-trip below would then prove only the DDL.
  return {
    components: components.map((c) => syncedComponentUsageSchema.parse(c)),
  } as SyncedAgentSession;
}

function usage(componentKey: string, extra: Record<string, unknown> = {}) {
  return {
    componentKind: "skill",
    componentKey,
    invocations: 3,
    errorCount: 0,
    gitBranch: null,
    ...extra,
  };
}

/** The column, read back with the real client — never from the write's return. */
async function readFlags(): Promise<Record<string, boolean | null>> {
  return await withDb(async (db) => {
    const rows = await db.agentComponentSessionUsage.findMany({
      where: { agentSessionId: SESSION_ID },
      select: { componentKey: true, isFirstAttributedSkill: true },
      orderBy: { componentKey: "asc" },
    });
    return Object.fromEntries(
      rows.map((r) => [r.componentKey, r.isFirstAttributedSkill])
    );
  });
}

beforeAll(async () => {
  await withDb(async (db) => {
    await db.organization.create({
      data: {
        id: ORG_ID,
        clerkId: `clerk_org_${ORG_ID}`,
        name: "ISS-7259 RealDB Org",
        slug: `iss7259-${ORG_ID}`,
      },
      select: { id: true },
    });
    await db.user.create({
      data: {
        id: USER_ID,
        organizationId: ORG_ID,
        clerkId: `clerk_user_${USER_ID}`,
        email: "iss7259@example.com",
      },
      select: { id: true },
    });
    await db.computeTarget.create({
      data: {
        id: COMPUTE_TARGET_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
        machineName: "iss7259-machine",
        platform: "darwin",
      },
      select: { id: true },
    });
    await db.artifact.create({
      data: {
        id: SESSION_ID,
        organizationId: ORG_ID,
        type: "SESSION",
        name: "ISS-7259 session",
        slug: `iss7259-session-${SESSION_ID.slice(0, 8)}`,
        status: "active",
      },
      select: { id: true },
    });
    await db.sessionDetail.create({
      data: {
        artifactId: SESSION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        externalSessionId: `ext-${SESSION_ID}`,
        harness: "claude",
        sessionStartedAt: new Date("2026-01-01T00:00:00Z"),
        sessionUpdatedAt: new Date("2026-01-01T01:00:00Z"),
        lastActivityAt: new Date("2026-01-01T01:00:00Z"),
      },
      // `*Detail` tables are keyed on artifactId, not id.
      select: { artifactId: true },
    });
  });
});

afterAll(async () => {
  // Explicit child-first teardown: `users.organization_id` is RESTRICT, not
  // CASCADE, so deleting the org alone leaves the run's rows behind and fails.
  await withDb(async (db) => {
    await db.agentComponentSessionUsage.deleteMany({
      where: { agentSessionId: SESSION_ID },
    });
    await db.sessionDetail.deleteMany({ where: { artifactId: SESSION_ID } });
    await db.artifact.deleteMany({ where: { organizationId: ORG_ID } });
    await db.computeTarget.deleteMany({ where: { organizationId: ORG_ID } });
    await db.user.deleteMany({ where: { organizationId: ORG_ID } });
    await db.organization.deleteMany({ where: { id: ORG_ID } });
  });
});

describe("ISS-7259 isFirstAttributedSkill round-trip (real Postgres)", () => {
  it("survives the write and is readable back on the attributed row alone", async () => {
    await withDb.tx(async (tx) => {
      await persistSessionComponentUsage(
        tx,
        COMPUTE_TARGET_ID,
        SESSION_ID,
        sessionWith([
          usage(ATTRIBUTED_SKILL, { isFirstAttributedSkill: true }),
          usage(OTHER_SKILL),
        ])
      );
    });

    // Read back from the COLUMN. If the field were stripped at the Zod boundary,
    // dropped from the INSERT, or absent from the DDL, this is where it shows —
    // and nowhere earlier, because every one of those failures is silent.
    expect(await readFlags()).toEqual({
      [ATTRIBUTED_SKILL]: true,
      // Omitted on the wire, so NULL here: an absent value covers both an older
      // desktop and a current one saying "not this row", and the column refuses
      // to invent a distinction the wire cannot carry.
      [OTHER_SKILL]: null,
    });
  });

  it("moves the flag on re-sync rather than freezing it on the first row", async () => {
    // The ON CONFLICT half. Both rows already exist from the case above, so this
    // upserts them — and if `is_first_attributed_skill` were left out of the DO
    // UPDATE SET, the stale row would stay flagged and the newly attributed one
    // would never light up, with the write reporting success either way.
    await withDb.tx(async (tx) => {
      await persistSessionComponentUsage(
        tx,
        COMPUTE_TARGET_ID,
        SESSION_ID,
        sessionWith([
          usage(ATTRIBUTED_SKILL),
          usage(OTHER_SKILL, { isFirstAttributedSkill: true }),
        ])
      );
    });

    expect(await readFlags()).toEqual({
      [ATTRIBUTED_SKILL]: null,
      [OTHER_SKILL]: true,
    });
  });
});
