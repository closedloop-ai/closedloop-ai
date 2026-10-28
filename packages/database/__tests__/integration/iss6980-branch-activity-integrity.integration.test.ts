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

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("ISS-6980 migration behavior", () => {
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

  it("ships the alias column, owner trigger, and the identity plus cascade indexes", async () => {
    const columns = await client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'monitored_session_activity_quarantine'
      ORDER BY column_name
    `);
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining([
        "source_event_id",
        "target_identity",
        "target_kind",
      ])
    );
    const alias = await client.query<{ data_type: string }>(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'branch_activity_atoms'
        AND column_name = 'compatibility_alias_for_source_event_id'
    `);
    expect(alias.rows).toEqual([{ data_type: "character varying" }]);
    const trigger = await client.query<{ enabled: string }>(`
      SELECT tgenabled AS enabled
      FROM pg_trigger
      WHERE tgname = 'monitored_activity_quarantine_session_owner_check'
        AND NOT tgisinternal
    `);
    expect(trigger.rows).toEqual([{ enabled: "O" }]);
    const indexes = await client.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'monitored_session_activity_quarantine'
      ORDER BY indexname
    `);
    // Still exhaustive, so a fourth unexplained index fails here. The third
    // entry is ISS-8496 and is a deliberate addition, not drift: this table's
    // `monitored_activity_quarantine_session_fkey` is ON DELETE CASCADE, and
    // Postgres runs that referential action as `session_artifact_id = $1` with
    // no organization_id to supply — so the org-leading identity unique above
    // cannot serve it and the check degraded to a sequential scan.
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "monitored_activity_quarantine_identity_key",
      "monitored_activity_quarantine_session_artifact_idx",
      "monitored_session_activity_quarantine_pkey",
    ]);
  });

  it("accepts only an organization-owned Session artifact", async () => {
    const fixture = await seedSessionFixture(client);
    await expect(
      insertQuarantine(
        client,
        fixture.organizationId,
        fixture.sessionArtifactId
      )
    ).resolves.toMatchObject({ rowCount: 1 });

    await expect(
      insertQuarantine(
        client,
        fixture.otherOrganizationId,
        fixture.sessionArtifactId
      )
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects a non-Session artifact even in the correct organization", async () => {
    const fixture = await seedSessionFixture(client);
    const branchArtifactId = randomUUID();
    await client.query(
      `INSERT INTO artifacts (
         id, organization_id, type, name, status, created_at, updated_at
       ) VALUES ($1, $2, 'BRANCH', 'not a session', 'active', now(), now())`,
      [branchArtifactId, fixture.organizationId]
    );

    await expect(
      insertQuarantine(client, fixture.organizationId, branchArtifactId)
    ).rejects.toMatchObject({ code: "23503" });
  });
});

async function seedSessionFixture(client: Client) {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const userId = randomUUID();
  const computeTargetId = randomUUID();
  const sessionArtifactId = randomUUID();
  for (const [id, suffix] of [
    [organizationId, "owner"],
    [otherOrganizationId, "other"],
  ]) {
    await client.query(
      `INSERT INTO organizations (id, clerk_id, name, slug, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      [id, `clerk-${suffix}-${id}`, `Org ${suffix}`, `org-${suffix}-${id}`]
    );
  }
  await client.query(
    `INSERT INTO users (id, clerk_id, organization_id, email, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [userId, `user-${userId}`, organizationId, `${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO compute_targets (
       id, organization_id, user_id, machine_name, platform, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'darwin', now(), now())`,
    [computeTargetId, organizationId, userId, `machine-${computeTargetId}`]
  );
  await client.query(
    `INSERT INTO artifacts (
       id, organization_id, type, name, status, created_at, updated_at
     ) VALUES ($1, $2, 'SESSION', 'ISS-6980 session', 'inactive', now(), now())`,
    [sessionArtifactId, organizationId]
  );
  await client.query(
    `INSERT INTO session_detail (
       artifact_id, compute_target_id, external_session_id, harness,
       session_started_at, session_updated_at, last_activity_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'claude', now(), now(), now(), now(), now())`,
    [sessionArtifactId, computeTargetId, `session-${sessionArtifactId}`]
  );
  return { organizationId, otherOrganizationId, sessionArtifactId };
}

function insertQuarantine(
  client: Client,
  organizationId: string,
  sessionArtifactId: string
) {
  return client.query(
    `INSERT INTO monitored_session_activity_quarantine (
       id, organization_id, session_artifact_id, event_identity_hash,
       event_fingerprint, occurred_at, received_at
     ) VALUES ($1, $2, $3, $4, $5, now() + interval '25 hours', now())`,
    [
      randomUUID(),
      organizationId,
      sessionArtifactId,
      "a".repeat(64),
      "b".repeat(64),
    ]
  );
}
