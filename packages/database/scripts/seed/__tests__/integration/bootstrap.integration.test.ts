/**
 * Bootstrap integration tests (FEA-1332)
 *
 * Exercises `ensureBootstrapUser` against a real Postgres so the synthetic
 * user/org precondition is verified end-to-end (the unit test only asserts the
 * upsert call shapes). Confirms the rows are created, queryable, and that the
 * business-key upserts are idempotent (no duplicates on rerun).
 *
 * Skips gracefully when DATABASE_URL is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BOOTSTRAP_ORG_ID,
  BOOTSTRAP_USER_ID,
  ensureBootstrapUser,
} from "../../bootstrap";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../fixtures/ephemeral-db";

describe.skipIf(!process.env.DATABASE_URL)(
  "ensureBootstrapUser integration (FEA-1332)",
  () => {
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
    });

    afterAll(async () => {
      // The shared teardown only removes the baseline org; clean up the
      // synthetic bootstrap rows this suite created. User first (User.org FK is
      // Restrict on delete).
      await ctx.prisma.user.deleteMany({ where: { id: BOOTSTRAP_USER_ID } });
      await ctx.prisma.organization.deleteMany({
        where: { id: BOOTSTRAP_ORG_ID },
      });
      await teardownEphemeralDb(ctx);
    });

    it("creates a synthetic org + user that are queryable", async () => {
      const result = await ensureBootstrapUser(ctx.prisma);
      expect(result.organizationId).toBe(BOOTSTRAP_ORG_ID);
      expect(result.userId).toBe(BOOTSTRAP_USER_ID);

      const org = await ctx.prisma.organization.findUnique({
        where: { id: BOOTSTRAP_ORG_ID },
        select: { clerkId: true, slug: true },
      });
      expect(org?.slug).toBe("preview-seed-org");
      expect(org?.clerkId).toContain("synthetic");

      const user = await ctx.prisma.user.findUnique({
        where: { id: BOOTSTRAP_USER_ID },
        select: { email: true, organizationId: true },
      });
      expect(user?.organizationId).toBe(BOOTSTRAP_ORG_ID);
      expect(user?.email).toContain("@example.com");
    });

    it("is idempotent — reruns return the same ids and create no duplicates", async () => {
      const first = await ensureBootstrapUser(ctx.prisma);
      const second = await ensureBootstrapUser(ctx.prisma);
      expect(second).toEqual(first);

      const orgCount = await ctx.prisma.organization.count({
        where: { id: BOOTSTRAP_ORG_ID },
      });
      const userCount = await ctx.prisma.user.count({
        where: { id: BOOTSTRAP_USER_ID },
      });
      expect(orgCount).toBe(1);
      expect(userCount).toBe(1);
    });
  }
);
