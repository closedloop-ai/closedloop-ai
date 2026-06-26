/**
 * ephemeral-db.ts
 *
 * Setup/teardown helpers for integration tests that require a real database
 * connection. Manages the lifecycle of a PrismaClient scoped to a single test
 * run, and provides a cleanup function that removes rows inserted during the
 * test so subsequent runs start from a clean state.
 *
 * The helpers skip gracefully when DATABASE_URL is not set, so the test suite
 * can be imported without error in environments without a database.
 *
 * Usage:
 * ```ts
 * import { setupEphemeralDb, teardownEphemeralDb } from "../fixtures/ephemeral-db";
 *
 * describe.skipIf(!process.env.DATABASE_URL)("my integration test", () => {
 *   let ctx: EphemeralDbContext;
 *
 *   beforeAll(async () => { ctx = await setupEphemeralDb(); });
 *   afterAll(async () => { await teardownEphemeralDb(ctx); });
 *
 *   it("does something real", async () => {
 *     // use ctx.prisma and ctx.organizationId
 *   });
 * });
 * ```
 */

import { PrismaPg } from "@prisma/adapter-pg";
import pg, { type Pool } from "pg";
import { PrismaClient } from "../../../../generated/client";
import { isLocalhostUrl, resolveSslOption } from "../../../db-utils";
import {
  BASELINE_ORG_ID,
  BASELINE_USER_ID,
  baselineOrg,
  baselineUser,
} from "./baseline-org";

/**
 * Context object returned by `setupEphemeralDb`.
 * Holds the connected client and the seed identifiers used during setup.
 */
export type EphemeralDbContext = {
  /** A live PrismaClient connected to the test database. */
  prisma: PrismaClient;
  /** The organization ID used to scope seeded rows. */
  organizationId: string;
  /** The user ID used as the seed runner identity. */
  userId: string;
  /** Internal pg.Pool reference for cleanup on teardown. */
  _pool: Pool;
};

/**
 * Creates a PrismaClient connected to the database at `process.env.DATABASE_URL`
 * and returns an `EphemeralDbContext` for use within an integration test suite.
 *
 * Uses the same PrismaPg adapter pattern as the seed CLI entry point so
 * integration tests exercise the same code path as production.
 *
 * @throws When `DATABASE_URL` is not set — callers should guard with
 *   `describe.skipIf(!process.env.DATABASE_URL)` before calling setup.
 */
export async function setupEphemeralDb(): Promise<EphemeralDbContext> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "setupEphemeralDb: DATABASE_URL is not set. " +
        "Wrap the test suite with describe.skipIf(!process.env.DATABASE_URL)."
    );
  }

  const url = new URL(process.env.DATABASE_URL);

  // Honor the caller's explicit sslmode when present (e.g. `verify-full`).
  // Default for non-localhost connections is TLS with certificate verification;
  // set ALLOW_INSECURE_SSL=1 to opt into the legacy `rejectUnauthorized:false`
  // for self-signed or development RDS endpoints.
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");

  const ssl = resolveSslOption({
    isLocalhost: isLocalhostUrl(url),
    sslmode,
    allowInsecure: process.env.ALLOW_INSECURE_SSL === "1",
  });

  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl,
  });

  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  // ---------------------------------------------------------------------------
  // Prerequisite parent rows. The seed graph upserts Project/TeamMember/etc.
  // with `createdById` / `organizationId` FKs pointing at these IDs — without
  // these rows, the very first upsert fails with a foreign-key violation.
  // We upsert (not create) so calling setup twice in the same suite is safe.
  // ---------------------------------------------------------------------------
  await prisma.organization.upsert({
    where: { id: BASELINE_ORG_ID },
    update: {},
    create: {
      id: BASELINE_ORG_ID,
      clerkId: `seed-test-org-${BASELINE_ORG_ID}`,
      name: baselineOrg.name,
      slug: baselineOrg.slug,
    },
  });

  await prisma.user.upsert({
    where: { id: BASELINE_USER_ID },
    update: {},
    create: {
      id: BASELINE_USER_ID,
      clerkId: `seed-test-user-${BASELINE_USER_ID}`,
      organizationId: BASELINE_ORG_ID,
      email: baselineUser.email,
      firstName: "Seed",
      lastName: "Test User",
    },
  });

  return {
    prisma,
    organizationId: BASELINE_ORG_ID,
    userId: BASELINE_USER_ID,
    _pool: pool,
  };
}

/**
 * Disconnects the PrismaClient held in `ctx` and removes any rows that were
 * inserted during the test run using the baseline `organizationId`.
 *
 * Deletion order respects FK constraints — child tables are deleted before
 * their parents. Only rows matching the ephemeral `organizationId` are removed
 * so the function is safe to call against a shared development database.
 *
 * Tables without an `organizationId` column and no Prisma relation to a
 * scoped parent (e.g. GitHubPRReview) are cleaned via cascade from their
 * parent deletions.
 *
 * Call this in an `afterAll` / `afterEach` hook.
 */
export async function teardownEphemeralDb(
  ctx: EphemeralDbContext
): Promise<void> {
  const { prisma, organizationId } = ctx;

  try {
    await prisma.$transaction(async (tx) => {
      // ------------------------------------------------------------------
      // Leaf tables first (no children), scoped to the ephemeral org.
      // ------------------------------------------------------------------

      await tx.loopEvent.deleteMany({
        where: { loop: { organizationId } },
      });
      await tx.artifactRating.deleteMany({ where: { organizationId } });
      await tx.fileAttachment.deleteMany({
        where: { artifact: { organizationId } },
      });
      await tx.prompt.deleteMany({ where: { organizationId } });

      // CommentReaction → scoped via comment → thread → org
      await tx.commentReaction.deleteMany({
        where: { comment: { thread: { organizationId } } },
      });
      await tx.commentAttachment.deleteMany({
        where: { comment: { thread: { organizationId } } },
      });
      await tx.comment.deleteMany({
        where: { thread: { organizationId } },
      });
      await tx.commentThread.deleteMany({ where: { organizationId } });

      await tx.customFieldValue.deleteMany({ where: { organizationId } });
      await tx.customFieldSetting.deleteMany({ where: { organizationId } });
      await tx.customFieldEnumOption.deleteMany({
        where: { customField: { organizationId } },
      });
      await tx.customField.deleteMany({ where: { organizationId } });

      await tx.judgeHumanScore.deleteMany({ where: { organizationId } });
      await tx.judgeScore.deleteMany({
        where: { evaluation: { organizationId } },
      });
      await tx.artifactEvaluation.deleteMany({ where: { organizationId } });
      await tx.artifactLink.deleteMany({ where: { organizationId } });

      await tx.loopEvent.deleteMany({
        where: { loop: { organizationId } },
      });
      await tx.loop.deleteMany({ where: { organizationId } });
      await tx.slugCounter.deleteMany({ where: { organizationId } });

      // GitHubPRReview: no org column, no Prisma
      // relation to a scoped parent that supports nested where. Cascade from
      // PullRequestDetail → Artifact → org deletion below.

      await tx.pullRequestDetail.deleteMany({
        where: { artifact: { organizationId } },
      });
      // DocumentVersion has an FK to DocumentDetail with cascade-on-delete on
      // the schema side, but Prisma's `deleteMany` doesn't trigger it for
      // some adapter configurations — delete versions explicitly first so we
      // don't depend on cascade behavior to keep teardown clean.
      await tx.documentVersion.deleteMany({
        where: { documentDetail: { artifact: { organizationId } } },
      });
      await tx.documentDetail.deleteMany({
        where: { artifact: { organizationId } },
      });
      await tx.artifact.deleteMany({ where: { organizationId } });

      // Collect ephemeral PR detail IDs for review cleanup.
      // (By this point pullRequestDetail rows were already deleted above, but
      // GitHubPRReview/Comment rows cascaded via PullRequestDetail onDelete.)

      await tx.teamMember.deleteMany({
        where: { team: { organizationId } },
      });
      // ProjectTeam: Team has no cascade on this side (Project does, but
      // teams are deleted first below), so any ProjectTeam row would block
      // the team delete with a FK violation. The current seed graph doesn't
      // populate this table, but the future scale-profile / scenario layers
      // (FEA-1329, FEA-1331) likely will — making teardown defensive now.
      await tx.projectTeam.deleteMany({
        where: { team: { organizationId } },
      });
      await tx.team.deleteMany({ where: { organizationId } });
      await tx.project.deleteMany({ where: { organizationId } });

      await tx.gitHubInstallationRepository.deleteMany({
        where: { installation: { organizationId } },
      });
      await tx.gitHubInstallation.deleteMany({ where: { organizationId } });
      await tx.gitHubUserConnection.deleteMany({ where: { organizationId } });
      await tx.linearIntegration.deleteMany({ where: { organizationId } });
      await tx.slackIntegration.deleteMany({ where: { organizationId } });

      // ComputeTarget rows must go before User deletion:
      // compute_targets.user_id has the default Restrict on delete, and the
      // seed creates one compute target for the SESSION artifact's
      // SessionDetail (FEA-1699). The session_detail rows that reference the
      // compute target (also Restrict) are already gone — they cascaded from
      // the artifact deletion above.
      await tx.computeTarget.deleteMany({ where: { organizationId } });

      // Finally remove the prerequisite User and Organization rows that
      // setupEphemeralDb upserted. Without this, the baseline rows persist
      // after teardown and leak across test runs that share a database (e.g.
      // CI's `pnpm test --filter=...` job where api#test runs after
      // @repo/database#test in the same Postgres container) — a previous
      // test's leftover Organization with slug "test-org" would block
      // unrelated tests that create an org with the same slug. User must be
      // deleted before Organization since User.organizationId has the
      // default Restrict on delete.
      await tx.user.deleteMany({
        where: { id: BASELINE_USER_ID },
      });
      await tx.organization.deleteMany({
        where: { id: BASELINE_ORG_ID },
      });
    });
  } finally {
    await prisma.$disconnect();
    await ctx._pool.end();
  }
}
