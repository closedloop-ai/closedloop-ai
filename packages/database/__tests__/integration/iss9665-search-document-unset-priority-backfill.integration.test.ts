import { randomUUID } from "node:crypto";
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
import {
  migrationWithCeiling,
  seedOrganization,
  shippedMigrationSql,
  TEST_CEILING,
} from "./search-document-migration-fixtures";

/**
 * ISS-9665: what the search-projection priority repair actually MOVES, against
 * real Postgres, by executing the SHIPPED migration file rather than a
 * transcription of it.
 *
 * The sibling `iss9665-...-migration.test.ts` pins the SQL text. That proves the
 * migration SAYS the right thing, not that Postgres DOES the right thing with
 * it — and the gap is where this repair's risk lives, because the predicate
 * leans on three-valued logic (`a."priority" IS NULL` against a nullable enum
 * column, joined) that reads correctly and behaves surprisingly. `NULL =
 * 'MEDIUM'` is NULL, not FALSE; a projection row with no matching artifact
 * disappears from an inner join rather than being "skipped".
 *
 * SEEDED IN THE OLD SHAPE ON PURPOSE. Every stale case below writes
 * `search_document.priority = 'MEDIUM'` beside an artifact whose column is
 * NULL — the corpus the pre-ISS-9665 `toDocument()` fold actually produced. A
 * fixture seeded through today's correct projection would already hold NULL and
 * would prove nothing about the rows that exist in production.
 *
 * Reading the file off disk and handing it to the server verbatim is
 * deliberate: a copy of the statement inside this test would keep passing after
 * someone edited the migration, which is the one regression this file exists to
 * prevent.
 *
 * Every case runs inside a transaction that is rolled back, so nothing
 * persists — including the repair, which on a seeded database would otherwise
 * be a real whole-table write.
 *
 * MEASURED BY MUTATION, and one result is worth stating because it is easy to
 * over-claim. `sd."priority" = 'MEDIUM'` ships TWICE — in the candidate CTE and
 * again in the UPDATE's own re-check — and widening ONE copy to `IS NOT NULL`
 * moves no row at all, because the other still refuses. Only widening BOTH
 * reaches the `otherDrift` case below. So the single-copy widening is killed by
 * the sibling TEXT PIN, not by anything here; that pin holds the whole statement
 * as one constant for exactly this reason. Dropping `a."priority" IS NULL`
 * (caught by `genuineMedium`) and dropping the organization term from the join
 * (caught by the cross-org case) each fail here on their own.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const MIGRATION =
  "20260907140000_iss9665_search_document_unset_priority_backfill";

const CEILING_RAISE_RE = /ISS-9665: more than 2 search_document rows/;

/** `ArtifactType` members are irrelevant here; any DOCUMENT-ish one will do. */
const ARTIFACT_TYPE = "DOCUMENT";

describe.skipIf(!DATABASE_URL)(
  "ISS-9665 search_document unset-priority backfill",
  () => {
    let client: Client;

    beforeAll(async () => {
      client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
    });

    afterAll(async () => {
      await client.end();
    });

    beforeEach(async () => {
      await client.query("BEGIN");
    });

    afterEach(async () => {
      await client.query("ROLLBACK");
    });

    it("clears the fabricated MEDIUM and nothing else", async () => {
      const organizationId = await seedOrganization(client);

      // (a) the defect: artifact holds NULL, the projection holds the fold.
      const stale = await seedProjectedDocument(client, organizationId, {
        artifactPriority: null,
        projectedPriority: "MEDIUM",
      });
      // (b) a GENUINE medium. Identical projection value, different artifact —
      // the whole reason the repair joins rather than matching on 'MEDIUM'.
      const genuineMedium = await seedProjectedDocument(
        client,
        organizationId,
        { artifactPriority: "MEDIUM", projectedPriority: "MEDIUM" }
      );
      // (c) already correct: nothing to say, and the write must not churn it.
      const alreadyNull = await seedProjectedDocument(client, organizationId, {
        artifactPriority: null,
        projectedPriority: null,
      });
      // (d) a real non-medium priority beside a NULL artifact. This is drift
      // the fold cannot have produced, so the migration deliberately leaves it
      // to the general reconcile. Asserting `'HIGH'` (not null) is what kills
      // the `sd."priority" IS NOT NULL` widening.
      const otherDrift = await seedProjectedDocument(client, organizationId, {
        artifactPriority: null,
        projectedPriority: "HIGH",
      });
      // (e) a non-document projection row carrying MEDIUM with no artifact
      // behind its entity_id at all. Six of the eight projections hardcode
      // `priority: null`, but a `project` row mirrors a real priority — and its
      // entity_id is a Project id, so an unjoined repair would strand it.
      const projectRow = await seedProjectionRow(client, organizationId, {
        entityType: "project",
        entityId: randomUUID(),
        priority: "MEDIUM",
      });

      await client.query(shippedMigrationSql(MIGRATION));

      expect(await readProjectedPriority(client, stale)).toBeNull();
      expect(await readProjectedPriority(client, genuineMedium)).toBe("MEDIUM");
      expect(await readProjectedPriority(client, alreadyNull)).toBeNull();
      expect(await readProjectedPriority(client, otherDrift)).toBe("HIGH");
      expect(await readProjectedPriority(client, projectRow)).toBe("MEDIUM");
    });

    it("does not reach across organizations", async () => {
      // The join carries `a."organization_id" = sd."organization_id"` as well
      // as the id. Dropping it would still be correct for well-formed data —
      // this case is what makes the clause non-vacuous, by putting a projection
      // row in one org against the artifact id of another.
      const ownerOrg = await seedOrganization(client);
      const otherOrg = await seedOrganization(client);
      const artifactId = await seedArtifact(client, ownerOrg, null);
      const crossOrgRow = await seedProjectionRow(client, otherOrg, {
        entityType: "document",
        entityId: artifactId,
        priority: "MEDIUM",
      });

      await client.query(shippedMigrationSql(MIGRATION));

      expect(await readProjectedPriority(client, crossOrgRow)).toBe("MEDIUM");
    });

    it("leaves updated_at alone", async () => {
      // `updated_at` mirrors the SOURCE entity's updatedAt and is the search
      // result ordering key, so bumping it would re-rank every repaired
      // document for a change no user made.
      const organizationId = await seedOrganization(client);
      const stale = await seedProjectedDocument(client, organizationId, {
        artifactPriority: null,
        projectedPriority: "MEDIUM",
      });
      const before = await readProjectedUpdatedAt(client, stale);

      await client.query(shippedMigrationSql(MIGRATION));

      expect(await readProjectedUpdatedAt(client, stale)).toEqual(before);
    });

    it("is idempotent — a second run writes nothing", async () => {
      const organizationId = await seedOrganization(client);
      const stale = await seedProjectedDocument(client, organizationId, {
        artifactPriority: null,
        projectedPriority: "MEDIUM",
      });

      await client.query(shippedMigrationSql(MIGRATION));
      // A repaired row holds NULL and so has left the population. If the second
      // run still selected it, the ceiling case below would be counting rows
      // that no longer need repair.
      await client.query(shippedMigrationSql(MIGRATION));

      expect(await readProjectedPriority(client, stale)).toBeNull();
    });

    it("aborts above the ceiling and commits nothing", async () => {
      const organizationId = await seedOrganization(client);
      const rows = [
        await seedProjectedDocument(client, organizationId, {
          artifactPriority: null,
          projectedPriority: "MEDIUM",
        }),
        await seedProjectedDocument(client, organizationId, {
          artifactPriority: null,
          projectedPriority: "MEDIUM",
        }),
        await seedProjectedDocument(client, organizationId, {
          artifactPriority: null,
          projectedPriority: "MEDIUM",
        }),
      ];

      // A savepoint, so the abort does not take down the suite's own
      // transaction and the rows stay readable afterwards.
      await client.query("SAVEPOINT before_ceiling");
      await expect(
        client.query(migrationWithCeiling(MIGRATION, TEST_CEILING))
      ).rejects.toThrow(CEILING_RAISE_RE);
      await client.query("ROLLBACK TO SAVEPOINT before_ceiling");

      // The guard fires AFTER the write, so what proves it is that nothing
      // COMMITTED — every row still holds the fold.
      for (const row of rows) {
        expect(await readProjectedPriority(client, row)).toBe("MEDIUM");
      }
    });
  }
);

async function seedArtifact(
  client: Client,
  organizationId: string,
  priority: string | null
): Promise<string> {
  const artifactId = randomUUID();
  await client.query(
    `INSERT INTO artifacts (id, organization_id, type, name, status, priority, created_at, updated_at)
     VALUES ($1, $2, $3::"ArtifactType", $4, $5, $6::"Priority", now(), now())`,
    [
      artifactId,
      organizationId,
      ARTIFACT_TYPE,
      `iss9665-${artifactId}`,
      "DRAFT",
      priority,
    ]
  );
  return artifactId;
}

async function seedProjectionRow(
  client: Client,
  organizationId: string,
  row: { entityType: string; entityId: string; priority: string | null }
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO search_document
       (id, organization_id, entity_type, entity_id, title, priority, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      id,
      organizationId,
      row.entityType,
      row.entityId,
      `iss9665-${id}`,
      row.priority,
    ]
  );
  return id;
}

/** An artifact plus the projection row a pre-ISS-9665 index pass wrote for it. */
async function seedProjectedDocument(
  client: Client,
  organizationId: string,
  values: { artifactPriority: string | null; projectedPriority: string | null }
): Promise<string> {
  const artifactId = await seedArtifact(
    client,
    organizationId,
    values.artifactPriority
  );
  return await seedProjectionRow(client, organizationId, {
    entityId: artifactId,
    entityType: "document",
    priority: values.projectedPriority,
  });
}

async function readProjectedPriority(
  client: Client,
  id: string
): Promise<string | null> {
  const result = await client.query<{ priority: string | null }>(
    'SELECT "priority" FROM "search_document" WHERE "id" = $1',
    [id]
  );
  return result.rows[0].priority;
}

async function readProjectedUpdatedAt(
  client: Client,
  id: string
): Promise<Date> {
  const result = await client.query<{ updated_at: Date }>(
    'SELECT "updated_at" FROM "search_document" WHERE "id" = $1',
    [id]
  );
  return result.rows[0].updated_at;
}
