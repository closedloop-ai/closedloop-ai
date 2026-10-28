import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  getPrismaP2002ConstraintTarget,
  getPrismaP2002Target,
} from "@/lib/db-utils";

/**
 * ISS-8556: pins the P2002 payload `@prisma/adapter-pg` actually raises, on the
 * Prisma version installed right now, against a real Postgres.
 *
 * WHY THIS IS A TEST AND NOT A ONE-OFF CHECK. A large amount of production
 * branching keys off which SHAPE arrives. `getPrismaP2002Target` reads
 * `meta.target`, which adapter-pg has never set; several callers read ONLY that
 * extractor, so their conflict branches are dead code today
 * (`isGatewayUniqueConstraintViolation` in compute-targets/service.ts is the one
 * with teeth — registration idempotency changes the day it starts firing). That
 * is a VERSION behavior, invisible to every unit test because they all build the
 * error object by hand and therefore assert the shape they already assumed.
 *
 * A Prisma upgrade that starts populating `meta.target` would silently switch
 * those branches on. This test is what makes that a red instead of a surprise.
 *
 * TWO CAVEATS, both real. `api-integration-tests` is `continue-on-error`, so a
 * failure here reports rather than blocks — the blocking half of this contract
 * is the version pin in
 * scripts/lint/partial-unique-upsert-prisma-version-contract.test.ts, which
 * reds on any Prisma move and names the suites to re-run. And this covers
 * adapter-pg only; the libsql adapter reports its own shape, which is why
 * {@link getPrismaP2002ConstraintTarget} accepts both `{ fields }` and
 * `{ index }`.
 */
const hasDatabase = Boolean(keys().DATABASE_URL);

describe.skipIf(!hasDatabase)("adapter-pg P2002 payload (realdb)", () => {
  it("raises P2002 with an unset meta.target and the constraint under driverAdapterError", async () => {
    // Random rather than time-based: a millisecond stamp collides between
    // parallel workers, and the cleanup below keys on this value.
    const slug = `p2002-payload-${randomUUID()}`;

    await withDb(async (db) => {
      try {
        await db.organization.create({
          data: { name: slug, slug, clerkId: `${slug}-a` },
          select: { id: true },
        });

        const error = await db.organization
          .create({
            data: { name: slug, slug, clerkId: `${slug}-b` },
            select: { id: true },
          })
          .catch((raised: unknown) => raised);

        // Assert the raw shape first. `getPrismaP2002Target` returns undefined
        // on a parse failure too, so "unset" and "not a P2002 at all" are
        // indistinguishable from the extractor alone — without this, the
        // headline assertion below could not fail for the right reason.
        expect(error).toMatchObject({ code: "P2002" });
        expect((error as { meta: object }).meta).not.toHaveProperty("target");

        // The claim the callers named above depend on: adapter-pg does NOT set
        // `meta.target`. If a Prisma upgrade starts setting it, this is the red.
        expect(getPrismaP2002Target(error)).toBeUndefined();

        // ...and the constraint IS reported, under the adapter's own key, so
        // the extractor that reads both shapes still resolves it. adapter-pg
        // reports an index NAME rather than a column list, and the extractor
        // unwraps it to that name.
        expect(getPrismaP2002ConstraintTarget(error)).toBe(
          "organizations_slug_key"
        );
      } finally {
        // Keyed on slug, not on a captured id: if the unique constraint ever
        // stops firing — the exact regression this test exists to catch — the
        // second create SUCCEEDS, and an id-keyed cleanup would leak that row
        // into the shared database on every failing run.
        await db.organization.deleteMany({ where: { slug } }).catch(() => {});
      }
    });
  });
});
