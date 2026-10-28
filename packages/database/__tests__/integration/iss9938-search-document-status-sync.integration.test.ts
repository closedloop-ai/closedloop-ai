import { IssueStatus } from "@repo/api/src/types/document";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
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
import { ArtifactType, LoopStatus } from "../../generated/enums";
import {
  readProjection,
  seedArtifact,
  seedLoop,
  seedOrganization,
  seedProjectionRow,
  seedUser,
} from "./search-document-migration-fixtures";

/**
 * ISS-9938: what the `search_document.status` sync triggers actually do,
 * against real Postgres, with the migration applied.
 *
 * The sibling `iss9938-search-document-status-sync-migration.test.ts` pins the
 * DDL text. That proves the migration SAYS the right thing; this proves
 * Postgres DOES it — the per-key scoping, the DOCUMENT gate and the
 * transactional rollback are all behaviors a text pin cannot observe.
 *
 * Projection rows are keyed with `SearchEntityType` rather than a literal, so a
 * drift between the trigger's SQL literal and the constant the app writes
 * turns the first case red: the trigger would match no row.
 *
 * Every case runs inside a transaction that is rolled back, so nothing
 * persists.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  "ISS-9938 search_document status sync triggers",
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

    it("mirrors a document's status change and touches nothing else on the row", async () => {
      const organizationId = await seedOrganization(client);
      const documentId = await seedArtifact(client, organizationId, {
        type: ArtifactType.DOCUMENT,
        status: IssueStatus.InProgress,
      });
      const row = await seedProjectionRow(client, organizationId, {
        entityType: SearchEntityType.Document,
        entityId: documentId,
        status: IssueStatus.InProgress,
      });
      const before = await readProjection(client, row);

      await setArtifactStatus(client, documentId, IssueStatus.Done);

      const after = await readProjection(client, row);
      expect(after.status).toBe(IssueStatus.Done);
      // Left alone by design (PLN-2065 §8); the migration header names the
      // reads that costs.
      expect(after.updatedAt).toEqual(before.updatedAt);
    });

    it("leaves a sibling document, another type's row and another organization's rows alone", async () => {
      const organizationId = await seedOrganization(client);
      const otherOrganizationId = await seedOrganization(client);
      const documentId = await seedArtifact(client, organizationId, {
        type: ArtifactType.DOCUMENT,
        status: IssueStatus.InProgress,
      });
      const siblingId = await seedArtifact(client, organizationId, {
        type: ArtifactType.DOCUMENT,
        status: IssueStatus.InProgress,
      });
      const otherOrgDocumentId = await seedArtifact(
        client,
        otherOrganizationId,
        { type: ArtifactType.DOCUMENT, status: IssueStatus.InProgress }
      );
      const row = await seedProjectionRow(client, organizationId, {
        entityType: SearchEntityType.Document,
        entityId: documentId,
        status: IssueStatus.InProgress,
      });
      const siblingRow = await seedProjectionRow(client, organizationId, {
        entityType: SearchEntityType.Document,
        entityId: siblingId,
        status: IssueStatus.InProgress,
      });
      // Same entity id, different entity_type: only the entity_type term
      // keeps the trigger off it.
      const otherTypeRow = await seedProjectionRow(client, organizationId, {
        entityType: SearchEntityType.Loop,
        entityId: documentId,
        status: IssueStatus.InProgress,
      });
      // Same entity id and type, different organization: only the
      // organization term keeps the trigger off it.
      const crossOrgRow = await seedProjectionRow(client, otherOrganizationId, {
        entityType: SearchEntityType.Document,
        entityId: documentId,
        status: IssueStatus.InProgress,
      });
      const otherOrgRow = await seedProjectionRow(client, otherOrganizationId, {
        entityType: SearchEntityType.Document,
        entityId: otherOrgDocumentId,
        status: IssueStatus.InProgress,
      });

      await setArtifactStatus(client, documentId, IssueStatus.Done);

      expect((await readProjection(client, row)).status).toBe(IssueStatus.Done);
      for (const untouched of [
        siblingRow,
        otherTypeRow,
        crossOrgRow,
        otherOrgRow,
      ]) {
        expect((await readProjection(client, untouched)).status).toBe(
          IssueStatus.InProgress
        );
      }
    });

    it("ignores a SESSION artifact's status write, even with a document row under its id", async () => {
      // A document-typed row under the session's id is what makes this case
      // prove the gate rather than the absence of a row to update.
      const organizationId = await seedOrganization(client);
      const sessionId = await seedArtifact(client, organizationId, {
        type: ArtifactType.SESSION,
        status: SESSION_STATUS.ACTIVE,
      });
      const row = await seedProjectionRow(client, organizationId, {
        entityType: SearchEntityType.Document,
        entityId: sessionId,
        status: SESSION_STATUS.ACTIVE,
      });

      await setArtifactStatus(client, sessionId, SESSION_STATUS.INACTIVE);

      expect((await readProjection(client, row)).status).toBe(
        SESSION_STATUS.ACTIVE
      );
    });

    it("rolls back with the status write", async () => {
      const organizationId = await seedOrganization(client);
      const documentId = await seedArtifact(client, organizationId, {
        type: ArtifactType.DOCUMENT,
        status: IssueStatus.InProgress,
      });
      const row = await seedProjectionRow(client, organizationId, {
        entityType: SearchEntityType.Document,
        entityId: documentId,
        status: IssueStatus.InProgress,
      });

      await client.query("SAVEPOINT status_write");
      await setArtifactStatus(client, documentId, IssueStatus.Done);
      expect((await readProjection(client, row)).status).toBe(IssueStatus.Done);
      await client.query("ROLLBACK TO SAVEPOINT status_write");

      expect((await readProjection(client, row)).status).toBe(
        IssueStatus.InProgress
      );
    });

    it("neither fails nor inserts when the document has no projection row", async () => {
      const organizationId = await seedOrganization(client);
      const documentId = await seedArtifact(client, organizationId, {
        type: ArtifactType.DOCUMENT,
        status: IssueStatus.InProgress,
      });

      await setArtifactStatus(client, documentId, IssueStatus.Done);

      const rows = await client.query(
        'SELECT 1 FROM "search_document" WHERE "organization_id" = $1 AND "entity_id" = $2',
        [organizationId, documentId]
      );
      expect(rows.rowCount).toBe(0);
    });

    it("does not rewrite a row that already holds the status", async () => {
      // `ctid` moves on every UPDATE, including a same-value one, so an
      // unchanged ctid is what proves no write happened.
      const organizationId = await seedOrganization(client);
      const documentId = await seedArtifact(client, organizationId, {
        type: ArtifactType.DOCUMENT,
        status: IssueStatus.InProgress,
      });
      const row = await seedProjectionRow(client, organizationId, {
        entityType: SearchEntityType.Document,
        entityId: documentId,
        status: IssueStatus.InProgress,
      });
      const initial = await readProjection(client, row);

      await setArtifactStatus(client, documentId, IssueStatus.InProgress);
      expect((await readProjection(client, row)).ctid).toBe(initial.ctid);

      // The source moves to a value the mirror already holds.
      const aheadDocumentId = await seedArtifact(client, organizationId, {
        type: ArtifactType.DOCUMENT,
        status: IssueStatus.InProgress,
      });
      const aheadRow = await seedProjectionRow(client, organizationId, {
        entityType: SearchEntityType.Document,
        entityId: aheadDocumentId,
        status: IssueStatus.Done,
      });
      const aheadInitial = await readProjection(client, aheadRow);

      await setArtifactStatus(client, aheadDocumentId, IssueStatus.Done);

      const aheadAfter = await readProjection(client, aheadRow);
      expect(aheadAfter.status).toBe(IssueStatus.Done);
      expect(aheadAfter.ctid).toBe(aheadInitial.ctid);
    });

    // ISS-12435 dropped the loop trigger with the Loops data step; a loop
    // status write no longer touches its projection row.
    it("leaves a loop's projection row alone when the loop's status changes", async () => {
      const organizationId = await seedOrganization(client);
      const userId = await seedUser(client, organizationId);
      const loopId = await seedLoop(client, organizationId, {
        userId,
        status: LoopStatus.PENDING,
      });
      const row = await seedProjectionRow(client, organizationId, {
        entityType: SearchEntityType.Loop,
        entityId: loopId,
        status: LoopStatus.PENDING,
      });

      await client.query(
        'UPDATE "loops" SET "status" = $2::"LoopStatus" WHERE "id" = $1',
        [loopId, LoopStatus.COMPLETED]
      );

      expect((await readProjection(client, row)).status).toBe(
        LoopStatus.PENDING
      );
    });
  }
);

async function setArtifactStatus(
  client: Client,
  artifactId: string,
  status: string
): Promise<void> {
  await client.query('UPDATE "artifacts" SET "status" = $2 WHERE "id" = $1', [
    artifactId,
    status,
  ]);
}
