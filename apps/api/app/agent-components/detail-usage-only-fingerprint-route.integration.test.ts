/**
 * ISS-10815: the detail read answers the SAME component the catalog list row
 * that linked to it describes, for the bare-hash slug the list actually
 * publishes.
 *
 * This has to run against a real Postgres, because the defect lives in which
 * ROWS three org-scoped reads select, not in the shape of a `where`: the list
 * mints a routable slug from a `component_version_hash` a session carried, and
 * the detail read then walked `agent_component_versions` and `agent_components`,
 * found nothing carrying that hash, and answered from the used-only path with an
 * empty name, one invocation, no collaborators and no definition — a confident
 * record of a component nobody used, standing in for the named family with its
 * whole prompt and version history. Measured that way in production on
 * 2026-09-21 for `skill::b954ec9a…` (`portfolio-rebalance`).
 *
 * The fixture carries TWO families, each with a usage-only fingerprint of its
 * own, so "resolved the right family" is distinguishable from "resolved the only
 * family". It also seeds a real installed content hash on one of them, so the
 * pre-existing content-hash route is proved unregressed by the same run.
 *
 * Run against a database with the schema applied:
 *
 *   DATABASE_URL=… pnpm --filter api exec vitest run \
 *     app/agent-components/detail-usage-only-fingerprint-route.integration.test.ts \
 *     --config vitest.config.integration.mts
 */
import { randomUUID } from "node:crypto";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { HarnessType } from "@repo/api/src/types/compute-target";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDetailForOrg } from "./service/detail-read";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const FAMILY_KEY = "portfolio-rebalance";
const DECOY_KEY = "cl-produce";

/**
 * The hash the FAMILY's installed row and its version row actually carry — a
 * content-hash route that resolved correctly before this change and must still.
 */
const INSTALLED_HASH = "1".repeat(64);
/**
 * The hash the family's most recent SESSION carried, recorded on no inventory
 * and no version row. This is the fingerprint the list's family collapse picks
 * as the row's representative, and therefore the one its `slug` publishes.
 */
const REPRESENTATIVE_HASH = "2".repeat(64);
/** The decoy family's own usage-only fingerprint. */
const DECOY_HASH = "3".repeat(64);
/** Recorded nowhere: the honest 404. */
const UNKNOWN_HASH = "4".repeat(64);

/** The definition body a reader opens the page to see. */
const DEFINITION_BODY =
  "# portfolio-rebalance\n\nRebalance a ClosedLoop PRD.\n";

const OLD_SESSION_INVOCATIONS = 3;
const RECENT_SESSION_INVOCATIONS = 4;
const DECOY_INVOCATIONS = 9;

type Seed = { organizationId: string; sessionIds: string[] };

describe.skipIf(!hasDatabase)(
  "agent-component detail for a usage-only fingerprint route (ISS-10815)",
  () => {
    let seed: Seed;

    beforeAll(async () => {
      seed = await seedTwoFamilies();
    });

    afterAll(async () => {
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
        await db.agentComponentVersion.deleteMany({
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

    it("answers the named family, with its definition, for the bare-hash slug the list publishes", async () => {
      const detail = await getDetailForOrg(
        seed.organizationId,
        `${AgentComponentKind.Skill}::${REPRESENTATIVE_HASH}`
      );

      // Before this change every one of these read the other way: name "",
      // prompt null, one invocation, one session.
      expect(detail?.name).toBe(FAMILY_KEY);
      expect(detail?.prompt).toBe(DEFINITION_BODY);
      expect(detail?.invocations).toBe(
        OLD_SESSION_INVOCATIONS + RECENT_SESSION_INVOCATIONS
      );
      expect(detail?.sessions).toBe(2);
      expect(detail?.versions.length).toBeGreaterThan(0);
    });

    it("answers the SAME record for the name-qualified id the list emits", async () => {
      const bare = await getDetailForOrg(
        seed.organizationId,
        `${AgentComponentKind.Skill}::${REPRESENTATIVE_HASH}`
      );
      const qualified = await getDetailForOrg(
        seed.organizationId,
        `${AgentComponentKind.Skill}::${FAMILY_KEY}@${REPRESENTATIVE_HASH}`
      );

      // That spelling used to 404 outright, and it is published: the list emits
      // it as the `id` of a usage-only row (`foldOrphanUsageIntoMerged` seeds a
      // synthetic entry's id with `fingerprintIdentityKey`), beside the
      // bare-hash `slug` the href builders actually link with.
      expect(qualified?.id).toBe(bare?.id);
      expect(qualified?.name).toBe(FAMILY_KEY);
      expect(qualified?.invocations).toBe(bare?.invocations);
      expect(qualified?.prompt).toBe(DEFINITION_BODY);
    });

    it("answers the DECOY family for the decoy's own fingerprint", async () => {
      const detail = await getDetailForOrg(
        seed.organizationId,
        `${AgentComponentKind.Skill}::${DECOY_HASH}`
      );

      expect(detail?.name).toBe(DECOY_KEY);
      expect(detail?.invocations).toBe(DECOY_INVOCATIONS);
    });

    it("still resolves the installed content-hash route unchanged", async () => {
      const detail = await getDetailForOrg(
        seed.organizationId,
        `${AgentComponentKind.Skill}::${INSTALLED_HASH}`
      );

      expect(detail?.name).toBe(FAMILY_KEY);
      expect(detail?.prompt).toBe(DEFINITION_BODY);
    });

    it("still resolves the legacy name-level link", async () => {
      const detail = await getDetailForOrg(
        seed.organizationId,
        `${AgentComponentKind.Skill}::${FAMILY_KEY}`
      );

      expect(detail?.name).toBe(FAMILY_KEY);
      expect(detail?.prompt).toBe(DEFINITION_BODY);
    });

    it("404s a fingerprint nothing in the org records, rather than guessing", async () => {
      const detail = await getDetailForOrg(
        seed.organizationId,
        `${AgentComponentKind.Skill}::${UNKNOWN_HASH}`
      );

      expect(detail).toBeNull();
    });

    it("never answers across organizations", async () => {
      const detail = await getDetailForOrg(
        randomUUID(),
        `${AgentComponentKind.Skill}::${REPRESENTATIVE_HASH}`
      );

      expect(detail).toBeNull();
    });
  }
);

/**
 * One org, two skill families. The family under test is installed (so it has a
 * definition body and a version row) and has been invoked in two sessions: an
 * older one carrying the installed hash, and a more recent one carrying a hash
 * no inventory or version row records — which is what makes it the family's
 * representative in the list's collapse, and so what its published slug is.
 *
 * `component_key_normalized` is never written here: the ISS-6756 trigger derives
 * it, and the resolution under test reads exactly that column.
 */
async function seedTwoFamilies(): Promise<Seed> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const computeTargetId = randomUUID();
  const oldSessionId = randomUUID();
  const recentSessionId = randomUUID();
  const decoySessionId = randomUUID();

  await withDb(async (db) => {
    await db.organization.create({
      data: {
        id: organizationId,
        clerkId: `clerk-${organizationId}`,
        name: "ISS-10815 org",
        slug: `iss-10815-${organizationId}`,
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
        machineName: "iss-10815",
        platform: "darwin",
      },
      select: { id: true },
    });

    for (const [key, content, contentHash] of [
      [FAMILY_KEY, DEFINITION_BODY, INSTALLED_HASH],
      [DECOY_KEY, "# cl-produce\n", null],
    ] as const) {
      await db.agentComponent.create({
        data: {
          organizationId,
          computeTargetId,
          componentKind: AgentComponentKind.Skill,
          externalComponentId: `skill-${key}-${organizationId}`,
          name: key,
          componentKey: key,
          content,
          contentHash,
          installPath: `.claude/skills/${key}/SKILL.md`,
        },
        select: { id: true },
      });
    }
    await db.agentComponentVersion.create({
      data: {
        organizationId,
        componentKind: AgentComponentKind.Skill,
        componentKey: FAMILY_KEY,
        contentHash: INSTALLED_HASH,
        content: DEFINITION_BODY,
      },
      select: { id: true },
    });

    for (const sessionId of [oldSessionId, recentSessionId, decoySessionId]) {
      await db.artifact.create({
        data: {
          id: sessionId,
          organizationId,
          type: ArtifactType.Session,
          name: `session-${sessionId}`,
          status: SESSION_STATUS.ACTIVE,
        },
        select: { id: true },
      });
      await db.sessionDetail.create({
        data: {
          artifactId: sessionId,
          computeTargetId,
          externalSessionId: `ext-${sessionId}`,
          harness: HarnessType.Claude,
          sessionStartedAt: new Date("2026-09-01T00:00:00Z"),
          sessionUpdatedAt: new Date("2026-09-01T00:00:00Z"),
          lastActivityAt: new Date("2026-09-01T00:00:00Z"),
        },
        select: { artifactId: true },
      });
    }

    for (const row of [
      {
        sessionId: oldSessionId,
        key: FAMILY_KEY,
        hash: INSTALLED_HASH,
        invocations: OLD_SESSION_INVOCATIONS,
      },
      {
        sessionId: recentSessionId,
        key: FAMILY_KEY,
        hash: REPRESENTATIVE_HASH,
        invocations: RECENT_SESSION_INVOCATIONS,
      },
      {
        sessionId: decoySessionId,
        key: DECOY_KEY,
        hash: DECOY_HASH,
        invocations: DECOY_INVOCATIONS,
      },
    ]) {
      await db.agentComponentSessionUsage.create({
        data: {
          agentSessionId: row.sessionId,
          componentKind: AgentComponentKind.Skill,
          componentKey: row.key,
          componentVersionHash: row.hash,
          harness: HarnessType.Claude,
          invocationCount: row.invocations,
          firstInvokedAt: new Date("2026-09-01T00:00:00Z"),
          lastInvokedAt: new Date("2026-09-02T00:00:00Z"),
        },
        select: { id: true },
      });
    }
  });

  return {
    organizationId,
    sessionIds: [oldSessionId, recentSessionId, decoySessionId],
  };
}
