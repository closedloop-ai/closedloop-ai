import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ArtifactType } from "../../generated/enums";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../../scripts/seed/__tests__/fixtures/ephemeral-db";

/**
 * ISS-10170 — the tenant foreign key, EXERCISED against a real Postgres that
 * has had `prisma migrate deploy` applied.
 *
 * WHY IT IS HERE AND NOT IN `apps/api`. The invariant is that a
 * `pull_request_detail` row cannot claim an organization its branch artifact
 * does not belong to. No service refuses that today — the writers take
 * `organizationId` and `branchArtifactId` as INDEPENDENT inputs and nothing
 * relates them — so a test that went through a service would be asserting a
 * check that does not exist. This suite drives Prisma DIRECTLY, with no service
 * in the path, because what it has to observe is what the DATABASE does. That
 * distinction is the whole point of the ticket: before this constraint the
 * org was reached THROUGH the artifact join, so a mismatched row was
 * structurally impossible to mis-scope; once a read seeks the denormalized
 * column instead, such a row is a cross-tenant read.
 *
 * The sibling DDL suite parses `migration.sql` and pins the shape somebody
 * wrote. This one asks Postgres what it actually ENFORCES.
 *
 * Read-write, but every row it inserts is scoped to the ephemeral org or to a
 * second organization it creates and removes itself.
 */

/**
 * Literals, deliberately not derived from `schema.prisma` or the migration. The
 * duplication IS the test: a rename has to be typed here too, so it is a
 * decision rather than something that rides along.
 */
const TENANT_FK = "pull_request_detail_branch_artifact_tenant_fkey";
const ARTIFACT_ORG_ID_UNIQUE = "artifacts_org_id_key";

describe.skipIf(!process.env.DATABASE_URL)(
  "pull_request_detail tenant foreign key (integration)",
  () => {
    let ctx: EphemeralDbContext;
    let foreignOrganizationId: string;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
    }, 120_000);

    beforeAll(async () => {
      foreignOrganizationId = randomUUID();
      // A REAL second organization, not a dangling id. Without the row the
      // insert below would be refused by `pull_request_detail_organization_id_fkey`
      // instead, and the test would pass without ever reaching the constraint
      // it claims to cover.
      await ctx.prisma.organization.create({
        data: {
          id: foreignOrganizationId,
          clerkId: `iss10170-${foreignOrganizationId}`,
          name: "ISS-10170 foreign tenant",
          slug: `iss10170-${foreignOrganizationId}`,
        },
        select: { id: true },
      });
    }, 120_000);

    afterEach(async () => {
      if (ctx) {
        await ctx.prisma.pullRequestDetail.deleteMany({
          where: {
            organizationId: { in: [ctx.organizationId, foreignOrganizationId] },
          },
        });
        await ctx.prisma.artifact.deleteMany({
          where: {
            organizationId: { in: [ctx.organizationId, foreignOrganizationId] },
          },
        });
      }
    }, 30_000);

    afterAll(async () => {
      if (ctx) {
        await ctx.prisma.organization.deleteMany({
          where: { id: foreignOrganizationId },
        });
        await teardownEphemeralDb(ctx);
      }
    }, 120_000);

    it("REFUSES a pull request detail whose organization is not its branch artifact's", async () => {
      const branchArtifact = await createBranchArtifact(
        ctx,
        ctx.organizationId
      );

      // The exact shape the writers can produce today: the two inputs are
      // independent, so nothing in the application stops these disagreeing.
      // No service is in the path — what this observes is the DATABASE's answer.
      const crossTenantWrite = ctx.prisma.pullRequestDetail.create({
        data: {
          organizationId: foreignOrganizationId,
          branchArtifactId: branchArtifact.id,
          number: 1,
        },
        select: { id: true },
      });

      // P2003 is Prisma's foreign-key violation. THROWING is the assertion, and
      // the constraint NAME is what makes it attributable: the organization FK
      // and the single-column branch FK would both also throw P2003 here, and
      // either could pass a bare `rejects.toThrow()` while this constraint was
      // missing entirely.
      await expect(crossTenantWrite).rejects.toMatchObject({
        code: "P2003",
      });
      await expect(crossTenantWrite).rejects.toThrow(TENANT_FK);

      // The invariant on the STORED table: a rejection that still wrote a row
      // would satisfy the throw above.
      const stored = await ctx.prisma.pullRequestDetail.findMany({
        where: { branchArtifactId: branchArtifact.id },
        select: { id: true },
      });
      expect(stored).toEqual([]);
    });

    it("ACCEPTS a pull request detail in its branch artifact's own organization", async () => {
      const branchArtifact = await createBranchArtifact(
        ctx,
        ctx.organizationId
      );

      // The counterpart that makes the refusal above meaningful: a constraint
      // that rejected everything would pass the first test on its own.
      const detail = await ctx.prisma.pullRequestDetail.create({
        data: {
          organizationId: ctx.organizationId,
          branchArtifactId: branchArtifact.id,
          number: 2,
        },
        select: { id: true, organizationId: true, branchArtifactId: true },
      });

      expect(detail.organizationId).toBe(ctx.organizationId);
      expect(detail.branchArtifactId).toBe(branchArtifact.id);
    });

    it("REFUSES moving a stored row's organization away from its branch artifact", async () => {
      const branchArtifact = await createBranchArtifact(
        ctx,
        ctx.organizationId
      );
      const detail = await ctx.prisma.pullRequestDetail.create({
        data: {
          organizationId: ctx.organizationId,
          branchArtifactId: branchArtifact.id,
          number: 3,
        },
        select: { id: true },
      });

      // The insert is not the only way in. `organization_id` is documented as
      // write-once, but nothing enforced that either — an UPDATE could re-tenant
      // an existing row, and a constraint checked only on INSERT would let it.
      await expect(
        ctx.prisma.pullRequestDetail.update({
          where: { id: detail.id },
          data: { organizationId: foreignOrganizationId },
          select: { id: true },
        })
      ).rejects.toMatchObject({ code: "P2003" });

      const stored = await ctx.prisma.pullRequestDetail.findUniqueOrThrow({
        where: { id: detail.id },
        select: { organizationId: true },
      });
      expect(stored.organizationId).toBe(ctx.organizationId);
    });

    it("cascades the branch artifact's delete through the new constraint", async () => {
      const branchArtifact = await createBranchArtifact(
        ctx,
        ctx.organizationId
      );
      await ctx.prisma.pullRequestDetail.create({
        data: {
          organizationId: ctx.organizationId,
          branchArtifactId: branchArtifact.id,
          number: 4,
        },
        select: { id: true },
      });

      // Two FKs now cascade from the same parent row. A RESTRICT on the new one
      // would make this delete fail, turning an additive constraint into a
      // behavior change for every branch-artifact delete in the product.
      await ctx.prisma.artifact.delete({
        where: { id: branchArtifact.id },
        select: { id: true },
      });

      const stored = await ctx.prisma.pullRequestDetail.findMany({
        where: { branchArtifactId: branchArtifact.id },
        select: { id: true },
      });
      expect(stored).toEqual([]);
    });

    it("built the unique key the constraint references, VALID and UNIQUE", async () => {
      const rows = await ctx.prisma.$queryRawUnsafe<
        { indisunique: boolean; indisvalid: boolean }[]
      >(
        `SELECT i.indisunique, i.indisvalid
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = $1`,
        ARTIFACT_ORG_ID_UNIQUE
      );

      expect(rows).toHaveLength(1);
      // Not decoration: a non-unique index of the same name cannot be a foreign
      // key target at all, and an INVALID one left by a cancelled concurrent
      // build looks identical to a healthy one in every other check.
      expect(rows[0].indisunique).toBe(true);
      expect(rows[0].indisvalid).toBe(true);
    });

    it("recorded the constraint as VALIDATED, not merely declared", async () => {
      const rows = await ctx.prisma.$queryRawUnsafe<
        { convalidated: boolean }[]
      >("SELECT convalidated FROM pg_constraint WHERE conname = $1", TENANT_FK);

      expect(rows).toHaveLength(1);
      // A constraint left NOT VALID polices new writes while tolerating every
      // row already stored. Every behavioral assertion above passes in that
      // state, because they all write new rows — this is the only one that can
      // tell the two apart, and it is what proves the migration's VALIDATE ran.
      expect(rows[0].convalidated).toBe(true);
    });
  }
);

/** A minimal BRANCH artifact in `organizationId` — only the required columns. */
function createBranchArtifact(ctx: EphemeralDbContext, organizationId: string) {
  return ctx.prisma.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.BRANCH,
      name: "iss10170-branch",
      status: "active",
    },
    select: { id: true },
  });
}
