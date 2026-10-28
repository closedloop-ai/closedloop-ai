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

const migrationSql = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260817203000_iss5269_guard_multi_session_pr_metadata",
    "migration.sql"
  ),
  "utf8"
);
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("ISS-5269 multi-PR metadata constraint", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    await client.query(
      "CREATE TEMP TABLE artifact_links (id uuid PRIMARY KEY, metadata jsonb)"
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it.each([
    ["absent", {}],
    ["null", { prRefs: null, linkKind: "session_pr" }],
    ["object", { prRefs: { unexpected: true }, linkKind: "session_pr" }],
    ["empty", { prRefs: [], linkKind: "session_pr" }],
    [
      "malformed-elements",
      { prRefs: [{ bad: true }, { alsoBad: true }], linkKind: "session_pr" },
    ],
    [
      "single",
      {
        prRefs: [canonicalRef(1)],
        linkKind: "session_pr",
      },
    ],
    [
      "multi-safe",
      {
        prRefs: [canonicalRef(1), canonicalRef(2)],
        linkKind: "session_branch",
      },
    ],
  ])("accepts %s metadata", async (_label, metadata) => {
    await client.query(migrationSql);
    await expect(insertFixture(client, metadata)).resolves.toBeUndefined();
  });

  it("rejects an old-writer scalar rewrite while the canonical set remains", async () => {
    await client.query(migrationSql);
    const metadata = {
      prRefs: [canonicalRef(1), canonicalRef(2)],
      linkKind: "session_branch",
    };
    await insertFixture(client, metadata, true);

    await expect(
      client.query(
        `UPDATE artifact_links
         SET metadata = metadata || '{"linkKind":"session_pr","repositoryFullName":"acme/web","prNumber":1}'::jsonb
         WHERE id = '019f5269-0000-7000-8000-000000000003'`
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts an old Branch-writer overlay that keeps scalar session_branch", async () => {
    await client.query(migrationSql);
    await insertFixture(
      client,
      {
        prRefs: [canonicalRef(1), canonicalRef(2)],
        linkKind: "session_branch",
      },
      true
    );

    await expect(
      client.query(
        `UPDATE artifact_links
         SET metadata = metadata || '{"linkKind":"session_branch","branchLinked":true}'::jsonb
         WHERE id = '019f5269-0000-7000-8000-000000000003'`
      )
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("blocks deployment when a violating pre-existing row exists", async () => {
    await insertFixture(
      client,
      {
        prRefs: [canonicalRef(1), canonicalRef(2)],
        linkKind: "session_pr",
      },
      true
    );

    await expect(client.query(migrationSql)).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("ISS-5269 preflight"),
    });
  });

  it("documents that CHECK does not protect DELETE", async () => {
    await client.query(migrationSql);
    await insertFixture(
      client,
      {
        prRefs: [canonicalRef(1), canonicalRef(2)],
        linkKind: "session_branch",
      },
      true
    );

    await expect(
      client.query(
        "DELETE FROM artifact_links WHERE id = '019f5269-0000-7000-8000-000000000003'"
      )
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});

async function insertFixture(
  client: Client,
  metadata: Record<string, unknown>,
  retain = false
): Promise<void> {
  await client.query("SAVEPOINT fixture");
  try {
    await client.query(
      `INSERT INTO artifact_links (
        id, metadata
      ) VALUES (
        '019f5269-0000-7000-8000-000000000003',
        $1::jsonb
      )`,
      [JSON.stringify(metadata)]
    );
    await client.query(
      retain ? "RELEASE SAVEPOINT fixture" : "ROLLBACK TO SAVEPOINT fixture"
    );
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT fixture");
    throw error;
  }
}

function canonicalRef(prNumber: number) {
  return {
    repositoryFullName: "acme/web",
    prNumber,
    relationTypes: ["CREATED"],
  };
}
