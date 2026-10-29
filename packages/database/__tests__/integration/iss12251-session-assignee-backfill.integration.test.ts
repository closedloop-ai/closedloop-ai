import { randomUUID } from "node:crypto";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
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
  seedUser,
  shippedMigrationSql,
  TEST_CEILING,
} from "./search-document-migration-fixtures";

/**
 * ISS-12251 (PLN-2176 T-2.1): what the session Owner backfill moves, against
 * real Postgres, by executing the SHIPPED migration file.
 *
 * The population is `assignee_id IS DISTINCT FROM session_detail.user_id`, not
 * `assignee_id IS NULL` (PR #8734 review): between the C1 and C2 deploys ingest
 * set assignee = uploader while PATCH/bulk `ownerUserId` still wrote only
 * `session_detail.user_id`, so a session reassigned in that window holds the
 * uploader as assignee and someone else as user_id.
 *
 * Every case runs inside a transaction that is rolled back.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const MIGRATION = "20261012170000_iss12251_session_assignee_backfill";

const ARM_1_CEILING_RE = /ISS-12251 arm 1 \(session Owner to assignee\)/;

const SECOND_RUN_SELECTS_NOTHING_RE =
  /arm 1 assigned 0 of 0 selected sessions .* arm 2 refreshed 0 of 0 selected/;

const FIXED_UPDATED_AT = "2026-01-01T00:00:00Z";

type Fixture = {
  organizationId: string;
  uploader: string;
  owner: string;
  computeTargetId: string;
};

describe.skipIf(!DATABASE_URL)("ISS-12251 session assignee backfill", () => {
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
    // ISS-12585 dropped the column this backfill reads; restore it for the
    // rolled-back transaction.
    await client.query(
      'ALTER TABLE "session_detail" ADD COLUMN "user_id" uuid REFERENCES "users" ("id")'
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("sets the assignee to session_detail.user_id, including a session reassigned between the C1 and C2 deploys", async () => {
    const fx = await seedFixture(client);
    const unassigned = await seedSession(client, fx, {
      assigneeId: null,
      userId: fx.owner,
    });
    const reassignedInWindow = await seedSession(client, fx, {
      assigneeId: fx.uploader,
      userId: fx.owner,
    });
    const alreadyAssigned = await seedSession(client, fx, {
      assigneeId: fx.owner,
      userId: fx.owner,
    });

    await client.query(shippedMigrationSql(MIGRATION));

    expect(await readAssignee(client, unassigned)).toBe(fx.owner);
    expect(await readAssignee(client, reassignedInWindow)).toBe(fx.owner);
    expect(await readAssignee(client, alreadyAssigned)).toBe(fx.owner);
  });

  it("leaves a session whose owner was deleted, and a non-session artifact with a detail row, alone", async () => {
    const fx = await seedFixture(client);
    const ownerDeleted = await seedSession(client, fx, {
      assigneeId: fx.uploader,
      userId: null,
    });
    const notASession = await seedSession(client, fx, {
      assigneeId: null,
      userId: fx.owner,
      type: ArtifactType.Document,
    });

    await client.query(shippedMigrationSql(MIGRATION));

    expect(await readAssignee(client, ownerDeleted)).toBe(fx.uploader);
    expect(await readAssignee(client, notASession)).toBeNull();
  });

  it("refreshes the agent-session search row's assignee and no other projection", async () => {
    const fx = await seedFixture(client);
    const session = await seedSession(client, fx, {
      assigneeId: null,
      userId: fx.owner,
    });
    const sessionRow = await seedProjectionRow(client, fx.organizationId, {
      entityType: SearchEntityType.AgentSession,
      entityId: session,
      assigneeId: null,
    });
    // The same artifact id under another org: the join's organization term
    // is what keeps it out.
    const otherOrg = await seedOrganization(client);
    const crossOrgRow = await seedProjectionRow(client, otherOrg, {
      entityType: SearchEntityType.AgentSession,
      entityId: session,
      assigneeId: null,
    });
    const documentRow = await seedProjectionRow(client, fx.organizationId, {
      entityType: SearchEntityType.Document,
      entityId: session,
      assigneeId: null,
    });

    await client.query(shippedMigrationSql(MIGRATION));

    expect(await readProjectedAssignee(client, sessionRow)).toBe(fx.owner);
    expect(await readProjectedAssignee(client, crossOrgRow)).toBeNull();
    expect(await readProjectedAssignee(client, documentRow)).toBeNull();
  });

  it("leaves updated_at alone on the artifact and the search row", async () => {
    const fx = await seedFixture(client);
    const session = await seedSession(client, fx, {
      assigneeId: null,
      userId: fx.owner,
    });
    const sessionRow = await seedProjectionRow(client, fx.organizationId, {
      entityType: SearchEntityType.AgentSession,
      entityId: session,
      assigneeId: null,
    });

    const artifactBefore = await readUpdatedAt(client, "artifacts", session);
    const rowBefore = await readUpdatedAt(
      client,
      "search_document",
      sessionRow
    );

    await client.query(shippedMigrationSql(MIGRATION));

    expect(await readAssignee(client, session)).toBe(fx.owner);
    expect(await readUpdatedAt(client, "artifacts", session)).toEqual(
      artifactBefore
    );
    expect(await readUpdatedAt(client, "search_document", sessionRow)).toEqual(
      rowBefore
    );
  });

  it("is idempotent: a second run selects nothing", async () => {
    const fx = await seedFixture(client);
    await seedSession(client, fx, { assigneeId: null, userId: fx.owner });
    const notices: string[] = [];
    client.on("notice", (notice) => notices.push(notice.message ?? ""));

    await client.query(shippedMigrationSql(MIGRATION));
    await client.query(shippedMigrationSql(MIGRATION));
    client.removeAllListeners("notice");

    expect(notices.at(-1)).toMatch(SECOND_RUN_SELECTS_NOTHING_RE);
  });

  it("aborts above the ceiling and commits nothing", async () => {
    const fx = await seedFixture(client);
    const sessions = [
      await seedSession(client, fx, { assigneeId: null, userId: fx.owner }),
      await seedSession(client, fx, { assigneeId: null, userId: fx.owner }),
      await seedSession(client, fx, {
        assigneeId: fx.uploader,
        userId: fx.owner,
      }),
    ];

    await client.query("SAVEPOINT before_ceiling");
    await expect(
      client.query(migrationWithCeiling(MIGRATION, TEST_CEILING))
    ).rejects.toThrow(ARM_1_CEILING_RE);
    await client.query("ROLLBACK TO SAVEPOINT before_ceiling");

    expect(await readAssignee(client, sessions[0])).toBeNull();
    expect(await readAssignee(client, sessions[2])).toBe(fx.uploader);
  });
});

async function seedFixture(client: Client): Promise<Fixture> {
  const organizationId = await seedOrganization(client);
  const uploader = await seedUser(client, organizationId);
  const owner = await seedUser(client, organizationId);
  const computeTargetId = randomUUID();
  await client.query(
    `INSERT INTO compute_targets (id, organization_id, user_id, machine_name, platform, updated_at)
     VALUES ($1, $2, $3, 'iss12251-machine', 'darwin', now())`,
    [computeTargetId, organizationId, uploader]
  );
  return { organizationId, uploader, owner, computeTargetId };
}

async function seedSession(
  client: Client,
  fx: Fixture,
  values: {
    assigneeId: string | null;
    userId: string | null;
    type?: ArtifactType;
  }
): Promise<string> {
  const artifactId = randomUUID();
  await client.query(
    `INSERT INTO artifacts (id, organization_id, type, name, status, created_at, updated_at, assignee_id, created_by_id)
     VALUES ($1, $2, $3::"ArtifactType", $4, 'inactive', $5, $5, $6, $7)`,
    [
      artifactId,
      fx.organizationId,
      values.type ?? ArtifactType.Session,
      `iss12251-${artifactId}`,
      FIXED_UPDATED_AT,
      values.assigneeId,
      fx.uploader,
    ]
  );
  await client.query(
    `INSERT INTO session_detail (artifact_id, compute_target_id, external_session_id, user_id,
       session_started_at, session_updated_at, updated_at, last_activity_at)
     VALUES ($1, $2, $3, $4, now(), now(), now(), now())`,
    [artifactId, fx.computeTargetId, `ext-${artifactId}`, values.userId]
  );
  return artifactId;
}

async function seedProjectionRow(
  client: Client,
  organizationId: string,
  row: {
    entityType: SearchEntityType;
    entityId: string;
    assigneeId: string | null;
  }
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO search_document
       (id, organization_id, entity_type, entity_id, title, assignee_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      organizationId,
      row.entityType,
      row.entityId,
      `iss12251-${id}`,
      row.assigneeId,
      FIXED_UPDATED_AT,
    ]
  );
  return id;
}

async function readAssignee(
  client: Client,
  artifactId: string
): Promise<string | null> {
  const result = await client.query<{ assignee_id: string | null }>(
    'SELECT "assignee_id" FROM "artifacts" WHERE "id" = $1',
    [artifactId]
  );
  return result.rows[0].assignee_id;
}

async function readProjectedAssignee(
  client: Client,
  id: string
): Promise<string | null> {
  const result = await client.query<{ assignee_id: string | null }>(
    'SELECT "assignee_id" FROM "search_document" WHERE "id" = $1',
    [id]
  );
  return result.rows[0].assignee_id;
}

async function readUpdatedAt(
  client: Client,
  table: "artifacts" | "search_document",
  id: string
): Promise<Date> {
  const result = await client.query<{ updated_at: Date }>(
    `SELECT "updated_at" FROM "${table}" WHERE "id" = $1`,
    [id]
  );
  return result.rows[0].updated_at;
}
