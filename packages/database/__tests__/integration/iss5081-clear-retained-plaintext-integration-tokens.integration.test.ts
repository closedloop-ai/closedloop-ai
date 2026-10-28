import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

/**
 * ISS-5081: what the plaintext-clearing migration actually MOVES, against real
 * Postgres, by executing the SHIPPED migration file rather than a transcription
 * of it.
 *
 * The sibling `__tests__/iss5081-…-migration.test.ts` pins the SQL text. That
 * proves the migration SAYS the right thing, not that Postgres DOES the right
 * thing with it, and the gap is where this ticket's risk lives: these columns
 * hold live OAuth credentials, the write is irreversible, and a row whose only
 * copy is plaintext must come out untouched. `NULL` comparisons are exactly the
 * shape that quietly widens — `"access_token_encrypted" IS NOT NULL` relaxed to
 * anything row-level would clear a credential nothing else holds.
 *
 * Reading the file off disk and handing it to the server verbatim is
 * deliberate: a copy of the statements inside this test would keep passing
 * after someone edited the migration, which is the regression it exists to
 * prevent. node-pg sends a parameterless string over the simple query protocol,
 * so the multi-statement file executes as one batch.
 *
 * Every case runs inside a transaction that is rolled back, so nothing
 * persists — including the clearing, which on a seeded database would otherwise
 * be a real write against whatever integration rows it holds.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const MIGRATION =
  "20260916120000_iss5081_clear_retained_plaintext_integration_tokens";

/** The shipped file, verbatim. */
function shippedMigrationSql(): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "prisma",
      "migrations",
      MIGRATION,
      "migration.sql"
    ),
    "utf8"
  );
}

type TokenColumns = {
  access_token: string | null;
  refresh_token: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
};

const PLAINTEXT_ACCESS = "plaintext-access-token";
const PLAINTEXT_REFRESH = "plaintext-refresh-token";
const CIPHERTEXT_ACCESS = "ciphertext-access-token";
const CIPHERTEXT_REFRESH = "ciphertext-refresh-token";

describe.skipIf(!DATABASE_URL)("ISS-5081 retained-plaintext clearing", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  // ISS-11096 dropped the four plaintext columns this migration touches. DDL is
  // transactional in Postgres, so adding them back inside the case's
  // transaction restores the shape the migration ran against, and the ROLLBACK
  // removes them again.
  beforeEach(async () => {
    await client.query("BEGIN");
    await client.query(
      `ALTER TABLE "google_integrations" ADD COLUMN "access_token" TEXT,
         ADD COLUMN "refresh_token" TEXT`
    );
    await client.query(
      `ALTER TABLE "linear_integrations" ADD COLUMN "access_token" TEXT,
         ADD COLUMN "refresh_token" TEXT`
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  type SeedRow = (columns: Partial<TokenColumns>) => Promise<string>;

  const seedGoogle: SeedRow = async (columns) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO "google_integrations"
           ("id", "organization_id", "google_user_id", "access_token",
            "refresh_token", "access_token_encrypted", "refresh_token_encrypted",
            "updated_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        id,
        randomUUID(),
        `google-user-${randomUUID()}`,
        columns.access_token ?? null,
        columns.refresh_token ?? null,
        columns.access_token_encrypted ?? null,
        columns.refresh_token_encrypted ?? null,
      ]
    );
    return id;
  };

  const seedLinear: SeedRow = async (columns) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO "linear_integrations"
           ("id", "organization_id", "linear_org_id", "linear_org_name",
            "access_token", "refresh_token", "access_token_encrypted",
            "refresh_token_encrypted", "updated_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        id,
        randomUUID(),
        `lin-org-${randomUUID()}`,
        "Acme",
        columns.access_token ?? null,
        columns.refresh_token ?? null,
        columns.access_token_encrypted ?? null,
        columns.refresh_token_encrypted ?? null,
      ]
    );
    return id;
  };

  function readRow(table: string, id: string): Promise<TokenColumns> {
    return client
      .query<TokenColumns>(
        `SELECT "access_token", "refresh_token", "access_token_encrypted",
                  "refresh_token_encrypted"
             FROM "${table}" WHERE "id" = $1`,
        [id]
      )
      .then((result) => result.rows[0]);
  }

  /**
   * One parameterized body, not a helper holding the assertions: the migration
   * makes the identical claim about both tables, and a case written for only
   * one of them is how a table gets left out of a later edit.
   */
  it.each([
    ["google_integrations", seedGoogle],
    ["linear_integrations", seedLinear],
  ] as [string, SeedRow][])(
    "clears only the retained plaintext on %s",
    async (table, seed) => {
      // Both copies present: the backfill wrote the ciphertext and left the
      // plaintext. This is the population the migration exists to clear.
      const retained = await seed({
        access_token: PLAINTEXT_ACCESS,
        refresh_token: PLAINTEXT_REFRESH,
        access_token_encrypted: CIPHERTEXT_ACCESS,
        refresh_token_encrypted: CIPHERTEXT_REFRESH,
      });
      // Plaintext ONLY: never encrypted, so this is the org's only credential.
      // Clearing it logs that organization out, and nothing can put it back.
      const plaintextOnly = await seed({
        access_token: PLAINTEXT_ACCESS,
        refresh_token: PLAINTEXT_REFRESH,
      });
      // Half migrated: access encrypted, refresh still plaintext-only — what a
      // reconnect that reissued no refresh token produced before ISS-7781. A
      // row-level predicate would clear that refresh token.
      const refreshStranded = await seed({
        access_token: PLAINTEXT_ACCESS,
        refresh_token: PLAINTEXT_REFRESH,
        access_token_encrypted: CIPHERTEXT_ACCESS,
      });
      // Already fully migrated. Its plaintext columns are NULL to begin with,
      // so only the two ciphertext assertions below carry weight — they catch a
      // statement that wrote the wrong column.
      const encryptedOnly = await seed({
        access_token_encrypted: CIPHERTEXT_ACCESS,
        refresh_token_encrypted: CIPHERTEXT_REFRESH,
      });
      // The MIRROR of `refreshStranded`: the refresh half migrated, the access
      // half still plaintext-only. The migration writes to this row (it clears
      // the refresh plaintext) and must leave the access plaintext alone, so a
      // later edit that adds a row-level access guard to the refresh statement
      // reddens here instead of silently stranding the row.
      const accessStranded = await seed({
        access_token: PLAINTEXT_ACCESS,
        refresh_token: PLAINTEXT_REFRESH,
        refresh_token_encrypted: CIPHERTEXT_REFRESH,
      });
      // An EMPTY-STRING ciphertext was not a credential to the reader of the
      // time (`resolveIntegrationToken`, later removed, branched on
      // `if (encrypted)`), so the plaintext beside it is the only working copy
      // and must survive.
      const emptyCiphertext = await seed({
        access_token: PLAINTEXT_ACCESS,
        access_token_encrypted: "",
      });
      // The refresh MIRROR of the row above. The guard is per half, so a row
      // proves only the half it carries: without this one, dropping `<> ''`
      // from both refresh statements leaves every assertion here green.
      const emptyRefreshCiphertext = await seed({
        refresh_token: PLAINTEXT_REFRESH,
        refresh_token_encrypted: "",
      });

      await client.query(shippedMigrationSql());

      expect(await readRow(table, retained)).toEqual({
        access_token: null,
        refresh_token: null,
        access_token_encrypted: CIPHERTEXT_ACCESS,
        refresh_token_encrypted: CIPHERTEXT_REFRESH,
      });
      expect(await readRow(table, plaintextOnly)).toEqual({
        access_token: PLAINTEXT_ACCESS,
        refresh_token: PLAINTEXT_REFRESH,
        access_token_encrypted: null,
        refresh_token_encrypted: null,
      });
      expect(await readRow(table, refreshStranded)).toEqual({
        access_token: null,
        refresh_token: PLAINTEXT_REFRESH,
        access_token_encrypted: CIPHERTEXT_ACCESS,
        refresh_token_encrypted: null,
      });
      expect(await readRow(table, encryptedOnly)).toEqual({
        access_token: null,
        refresh_token: null,
        access_token_encrypted: CIPHERTEXT_ACCESS,
        refresh_token_encrypted: CIPHERTEXT_REFRESH,
      });
      expect(await readRow(table, accessStranded)).toEqual({
        access_token: PLAINTEXT_ACCESS,
        refresh_token: null,
        access_token_encrypted: null,
        refresh_token_encrypted: CIPHERTEXT_REFRESH,
      });
      expect(await readRow(table, emptyCiphertext)).toEqual({
        access_token: PLAINTEXT_ACCESS,
        refresh_token: null,
        access_token_encrypted: "",
        refresh_token_encrypted: null,
      });
      expect(await readRow(table, emptyRefreshCiphertext)).toEqual({
        access_token: null,
        refresh_token: PLAINTEXT_REFRESH,
        access_token_encrypted: null,
        refresh_token_encrypted: "",
      });
    }
  );

  it("is idempotent: a second run leaves every column exactly as the first did", async () => {
    const retained = await seedGoogle({
      access_token: PLAINTEXT_ACCESS,
      refresh_token: PLAINTEXT_REFRESH,
      access_token_encrypted: CIPHERTEXT_ACCESS,
      refresh_token_encrypted: CIPHERTEXT_REFRESH,
    });
    const plaintextOnly = await seedGoogle({
      access_token: PLAINTEXT_ACCESS,
      refresh_token: PLAINTEXT_REFRESH,
    });

    await client.query(shippedMigrationSql());
    // The state after ONE run is the baseline the second run is held to, so
    // this compares run 2 against run 1 rather than against expectations a
    // single run already satisfies.
    const afterFirst = {
      retained: await readRow("google_integrations", retained),
      plaintextOnly: await readRow("google_integrations", plaintextOnly),
    };

    await client.query(shippedMigrationSql());

    expect({
      retained: await readRow("google_integrations", retained),
      plaintextOnly: await readRow("google_integrations", plaintextOnly),
    }).toEqual(afterFirst);
    // And the baseline itself is the right one, so an idempotent no-op on a
    // wrong first run cannot pass this case.
    expect(afterFirst.retained.access_token).toBeNull();
    expect(afterFirst.plaintextOnly.access_token).toBe(PLAINTEXT_ACCESS);
  });
});
