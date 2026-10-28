import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { getPrismaErrorCode, getPrismaRawQuerySqlState } from "@/lib/db-utils";

/**
 * ISS-8556: pins the RAW-QUERY error envelope on the Prisma version installed
 * right now, against a real Postgres — the sibling of the P2002 pin next to it.
 *
 * The contract under test is WHERE the driver SQLSTATE lives, which is version
 * dependent. For a raw query Prisma sets its own `P2010` on `code` and puts the
 * SQLSTATE in `meta` — but 7.10's `@prisma/adapter-pg` puts it at
 * `meta.driverAdapterError.cause.originalCode` and sets no `meta.code` at all,
 * where earlier versions used `meta.code`. The assertions below pin both halves
 * of that, which is the point: pinning only the extractor's OUTPUT would pass
 * under either envelope and so could not detect the next relocation.
 *
 * Raw-query callers branch on it — the stale-session reaper on 55P03, the
 * commit batch update on 23505 — to tell Postgres declining or colliding from a
 * genuine error worth paging on.
 *
 * WHY IT NEEDS A REAL DATABASE. Every existing test for this extractor
 * (`__tests__/unit/db-utils-sqlstate.test.ts`) constructs the error by hand, so
 * it asserts the shape it already assumed and cannot notice the envelope
 * moving. Prisma 7.9 introduced `P2039` for previously-unmapped driver-adapter
 * errors, which is exactly the kind of change that relocates a SQLSTATE — and
 * nothing in this repo matches on `P2039` today. If the SQLSTATE ever stops
 * arriving where the extractor looks, contention drops silently reclassify as
 * `errored` and the sweep pages on behaving as designed.
 *
 * The specific SQLSTATE here is incidental: `42P01` is used because it is
 * deterministic and needs no lock contention. What is pinned is that a driver
 * SQLSTATE survives the round trip and is retrievable, not which one.
 *
 * Caveat, same as its sibling: `api-integration-tests` is `continue-on-error`,
 * so this reports rather than blocks. The blocking half is the Prisma version
 * pin in scripts/lint/partial-unique-upsert-prisma-version-contract.test.ts.
 */
const hasDatabase = Boolean(keys().DATABASE_URL);

describe.skipIf(!hasDatabase)("raw-query SQLSTATE envelope (realdb)", () => {
  it("keeps the driver SQLSTATE retrievable from a failed raw query", async () => {
    await withDb(async (db) => {
      const error = await db
        .$executeRawUnsafe('SELECT 1 FROM "iss8556_table_that_does_not_exist"')
        .then(
          () => null,
          (raised: unknown) => raised
        );

      expect(error).not.toBeNull();
      // Prisma's own code, NOT the driver's — matching on this is the mistake
      // `getPrismaRawQuerySqlState` exists to avoid.
      expect(getPrismaErrorCode(error)).toBe("P2010");

      // Assert WHERE the SQLSTATE lives, before asserting the extractor finds
      // it. Without this the test passes under the old `meta.code` shape, the
      // new one, or any future third the extractor happens to accept — it would
      // pin our own output rather than the adapter's payload, and so could not
      // detect the next relocation. This is the shape the fix was written for.
      expect(error).toMatchObject({
        meta: { driverAdapterError: { cause: { originalCode: "42P01" } } },
      });
      expect(
        (error as { meta: Record<string, unknown> }).meta
      ).not.toHaveProperty("code");

      // ...and the extractor resolves it. 42P01 = undefined_table.
      expect(getPrismaRawQuerySqlState(error)).toBe("42P01");
    });
  });
});
