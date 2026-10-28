/**
 * The plugin child-usage rollup answers the SAME numbers after the identity
 * prefilter moved from a case-insensitive `contains` on the raw `component_key`
 * to an equality on the persisted `component_key_normalized` fold.
 *
 * It has to run against a real Postgres, because the whole equivalence rests on
 * something no double can supply: `component_key_normalized` is written by the
 * ISS-6756 BEFORE INSERT/UPDATE trigger, from the same `lower(trim(…))`
 * definition `normalizeComponentKey` applies on the query side. A unit double
 * asserts the predicate SHAPE (`__tests__/child-usage-identity-prefilter-index`);
 * only the database can say whether the value the trigger stored is the value the
 * query asks for.
 *
 * The population is chosen so that the narrowing is visible in both directions:
 * a row the old `contains` admitted and the JS re-match then discarded, and a row
 * that only the fold — not a raw-column equality — can admit.
 *
 * Run against a database with the schema applied:
 *
 *   DATABASE_URL=… pnpm --filter api exec vitest run \
 *     app/agent-components/child-usage-normalized-prefilter.integration.test.ts \
 *     --config vitest.config.integration.mts
 */
import { randomUUID } from "node:crypto";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadChildUsageByPackId } from "./plugin-child-usage";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const PACK_ID = "iss-child-prefilter-pack";

/** The child this pack installs. The inventory key is already folded. */
const CHILD_KEY = "reviewer";
/**
 * A second child whose key carries a `_`. Under the former spelling Prisma bound
 * the key as an UNESCAPED ILIKE pattern, so `_` was a single-character wildcard
 * and `webXsearch` matched it — a DIFFERENT component's rows, admitted by SQL and
 * then dropped by the JS re-match. An equality has no wildcards.
 */
const WILDCARD_CHILD_KEY = "web_search";

/** Invocations that MUST reach the pack's bucket. */
const VARIANT_INVOCATIONS = 4;
const EXACT_INVOCATIONS = 3;
/** Invocations that must NOT, on either spelling. */
const SUBSTRING_INVOCATIONS = 100;
const WILDCARD_INVOCATIONS = 200;

type Seed = {
  organizationId: string;
  variantSessionId: string;
  exactSessionId: string;
  sessionIds: string[];
};

describe.skipIf(!hasDatabase)(
  "plugin child-usage rollup over the persisted key fold",
  () => {
    let seed: Seed;

    beforeAll(async () => {
      seed = await seedPack();
    });

    afterAll(async () => {
      // Child-first: `users.organization_id` is RESTRICT, so the org delete
      // alone would fail, and the inventory FK from `compute_targets` is too.
      // The org id is a fresh uuid per run, so without this every run would
      // leave another orphaned tree in the shared integration database.
      await withDb(async (db) => {
        await db.agentComponentSessionUsage.deleteMany({
          where: { agentSessionId: { in: seed.sessionIds } },
        });
        await db.sessionDetail.deleteMany({
          where: { artifactId: { in: seed.sessionIds } },
        });
        await db.artifact.deleteMany({
          where: { organizationId: seed.organizationId },
        });
        await db.agentComponent.deleteMany({
          where: { organizationId: seed.organizationId },
        });
        await db.computeTarget.deleteMany({
          where: { organizationId: seed.organizationId },
        });
        await db.user.deleteMany({
          where: { organizationId: seed.organizationId },
        });
        await db.organization.deleteMany({
          where: { id: seed.organizationId },
        });
      });
    });

    it("counts a case/whitespace-variant usage key through the fold", async () => {
      const byPack = await withDb((db) =>
        loadChildUsageByPackId(db, [PACK_ID], seed.organizationId)
      );

      const bucket = byPack.get(PACK_ID);
      // The variant row (`"  ReViEwEr  "`) and the exact row, and nothing else.
      // A raw-column equality would drop the variant and report 3; the former
      // `contains` reported 7 too, by reading the two excluded rows and
      // discarding them in JS.
      expect(bucket?.invocations).toBe(VARIANT_INVOCATIONS + EXACT_INVOCATIONS);
      expect([...(bucket?.sessionIds ?? [])].sort()).toStrictEqual(
        [seed.variantSessionId, seed.exactSessionId].sort()
      );
    });

    it("excludes a longer key that merely CONTAINS a child key", async () => {
      const byPack = await withDb((db) =>
        loadChildUsageByPackId(db, [PACK_ID], seed.organizationId)
      );

      // Stated as its own case rather than left implicit in the sum above: these
      // are the two rows the former predicate READ and then threw away, and the
      // number that proves they are still excluded is a number they would each
      // move by a lot if they were not.
      const bucket = byPack.get(PACK_ID);
      expect(bucket?.invocations).toBeLessThan(SUBSTRING_INVOCATIONS);
      expect(bucket?.invocations).toBeLessThan(WILDCARD_INVOCATIONS);
    });
  }
);

/**
 * One org with a pack, two child components, and four usage rows: the two that
 * belong to the pack's children (one spelled as a case/whitespace variant) and
 * the two that only the former substring/wildcard predicate ever admitted.
 *
 * Every usage row is inserted through Prisma so the ISS-6756 trigger computes
 * `component_key_normalized`; the column is never written by this fixture, which
 * is the point — a fixture-supplied fold would prove nothing about the trigger.
 */
async function seedPack(): Promise<Seed> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const computeTargetId = randomUUID();
  const variantSessionId = randomUUID();
  const exactSessionId = randomUUID();
  const noiseSessionId = randomUUID();

  await withDb(async (db) => {
    await db.organization.create({
      data: {
        id: organizationId,
        clerkId: `clerk-${organizationId}`,
        name: "Child prefilter org",
        slug: `child-prefilter-${organizationId}`,
      },
      select: { id: true },
    });
    await db.user.create({
      data: {
        id: userId,
        clerkId: `clerk-user-${userId}`,
        organizationId,
        email: `${userId}@example.com`,
      },
      select: { id: true },
    });
    await db.computeTarget.create({
      data: {
        id: computeTargetId,
        organizationId,
        userId,
        machineName: "child-prefilter",
        platform: "darwin",
      },
      select: { id: true },
    });

    for (const [kind, key] of [
      [AgentComponentKind.Plugin, PACK_ID],
      [AgentComponentKind.Skill, CHILD_KEY],
      [AgentComponentKind.Skill, WILDCARD_CHILD_KEY],
    ] as const) {
      await db.agentComponent.create({
        data: {
          organizationId,
          computeTargetId,
          componentKind: kind,
          externalComponentId: `${kind}-${key}-${organizationId}`,
          name: key,
          componentKey: key,
          packId: PACK_ID,
        },
        select: { id: true },
      });
    }

    for (const sessionId of [
      variantSessionId,
      exactSessionId,
      noiseSessionId,
    ]) {
      await db.artifact.create({
        data: {
          id: sessionId,
          organizationId,
          type: "SESSION",
          name: `session-${sessionId}`,
          status: "active",
        },
        select: { id: true },
      });
      await db.sessionDetail.create({
        data: {
          artifactId: sessionId,
          computeTargetId,
          externalSessionId: `ext-${sessionId}`,
          harness: "claude",
          sessionStartedAt: new Date("2026-08-01T00:00:00Z"),
          sessionUpdatedAt: new Date("2026-08-01T00:00:00Z"),
          lastActivityAt: new Date("2026-08-01T00:00:00Z"),
        },
        select: { artifactId: true },
      });
    }

    for (const row of [
      // Admitted by the fold, not by a raw-column equality.
      {
        sessionId: variantSessionId,
        key: "  ReViEwEr  ",
        invocations: VARIANT_INVOCATIONS,
      },
      {
        sessionId: exactSessionId,
        key: CHILD_KEY,
        invocations: EXACT_INVOCATIONS,
      },
      // Admitted by the former `contains`, excluded by both the JS re-match then
      // and the equality now.
      {
        sessionId: noiseSessionId,
        key: `${CHILD_KEY}-extra`,
        invocations: SUBSTRING_INVOCATIONS,
      },
      // Admitted by the former unescaped `_` wildcard, same story.
      {
        sessionId: noiseSessionId,
        key: "webXsearch",
        invocations: WILDCARD_INVOCATIONS,
      },
    ]) {
      await db.agentComponentSessionUsage.create({
        data: {
          agentSessionId: row.sessionId,
          componentKind: AgentComponentKind.Skill,
          componentKey: row.key,
          harness: "claude",
          invocationCount: row.invocations,
          lastInvokedAt: new Date("2026-08-02T00:00:00Z"),
        },
        select: { id: true },
      });
    }
  });

  return {
    organizationId,
    variantSessionId,
    exactSessionId,
    sessionIds: [variantSessionId, exactSessionId, noiseSessionId],
  };
}
