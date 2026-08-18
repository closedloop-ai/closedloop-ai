import { randomUUID } from "node:crypto";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransactionClient } from "../../index";
import {
  type ProjectionRow,
  toSearchBackfillClient,
} from "../../scripts/backfill-search-documents";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../../scripts/seed/__tests__/fixtures/ephemeral-db";

/**
 * The raw `INSERT ... ON CONFLICT DO UPDATE` behind `upsertProjectionRows`,
 * against a real Postgres.
 *
 * This path is only meaningfully testable against a live database. Its risky
 * parts are all things a mock cannot judge: whether an app-generated UUIDv7 is
 * accepted by a `uuid` column, whether an absent optional id lands as SQL NULL
 * rather than the string "null", whether the conflict target really is
 * (organization_id, entity_type, entity_id), and whether the Postgres-generated
 * `tsv` column is recomputed on update. Asserting on a constructed `Prisma.sql`
 * object would prove none of them.
 *
 * Rows are written under a throwaway organization and deleted in afterAll, so
 * the suite is re-runnable and does not disturb the baseline org.
 */

const ORG_ID = randomUUID();

function row(overrides: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    organizationId: ORG_ID,
    entityType: SearchEntityType.Project,
    entityId: randomUUID(),
    title: "Widget rollout",
    body: "ship the widget",
    projectId: null,
    assigneeId: null,
    status: null,
    priority: null,
    updatedAt: new Date("2026-08-08T12:00:00.000Z"),
    slug: null,
    entitySubtype: null,
    teamId: null,
    anchorEntityId: null,
    ...overrides,
  };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "search_document raw upsert (integration)",
  () => {
    let ctx: EphemeralDbContext;
    let client: ReturnType<typeof toSearchBackfillClient>;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
      client = toSearchBackfillClient(
        ctx.prisma as unknown as TransactionClient
      );
    });

    afterAll(async () => {
      await ctx.prisma.$executeRawUnsafe(
        'DELETE FROM "search_document" WHERE "organization_id" = $1::uuid',
        ORG_ID
      );
      await teardownEphemeralDb(ctx);
    });

    // Columns are named and cast explicitly: `SELECT *` fails because Prisma
    // cannot deserialize the generated `tsvector` column, and casting the uuid
    // columns to text keeps the comparisons plain string equality.
    async function read(entityId: string) {
      const rows = await ctx.prisma.$queryRawUnsafe<
        Record<string, string | null>[]
      >(
        `SELECT "id"::text AS id, "title", "body",
                "project_id"::text AS project_id,
                "assignee_id"::text AS assignee_id,
                "team_id"::text AS team_id,
                "anchor_entity_id"::text AS anchor_entity_id,
                "tsv"::text AS tsv
           FROM "search_document"
          WHERE "organization_id" = $1::uuid AND "entity_id" = $2::uuid`,
        ORG_ID,
        entityId
      );
      return rows[0];
    }

    it("writes a row and reports how many it wrote", async () => {
      const r = row();

      const written = await client.upsertProjectionRows([r]);

      expect(written).toBe(1);
      const stored = await read(r.entityId);
      expect(stored?.title).toBe("Widget rollout");
      expect(stored?.body).toBe("ship the widget");
    });

    it("generates a PK that Postgres accepts as a uuid, versioned 7", async () => {
      // The raw INSERT bypasses Prisma's client-side @default(uuid(7)), so the
      // id is generated app-side. If it were malformed the insert would fail
      // outright; if it were v4 it would still insert, silently losing the
      // time-ordered B-tree property.
      const r = row();

      await client.upsertProjectionRows([r]);

      const id = String((await read(r.entityId))?.id);
      expect(id[14]).toBe("7");
    });

    it("writes absent optional ids as SQL NULL, not a string", async () => {
      // The four nullable-uuid ternaries in the VALUES tuple. A regression here
      // writes the text "null" into a uuid column (an error) or, worse, drops a
      // real id.
      const r = row();

      await client.upsertProjectionRows([r]);

      const stored = await read(r.entityId);
      expect(stored?.project_id).toBeNull();
      expect(stored?.assignee_id).toBeNull();
      expect(stored?.team_id).toBeNull();
      expect(stored?.anchor_entity_id).toBeNull();
    });

    it("round-trips every optional id when present", async () => {
      const projectId = randomUUID();
      const assigneeId = randomUUID();
      const teamId = randomUUID();
      const anchorEntityId = randomUUID();
      const r = row({ anchorEntityId, assigneeId, projectId, teamId });

      await client.upsertProjectionRows([r]);

      const stored = await read(r.entityId);
      expect(stored?.project_id).toBe(projectId);
      expect(stored?.assignee_id).toBe(assigneeId);
      expect(stored?.team_id).toBe(teamId);
      expect(stored?.anchor_entity_id).toBe(anchorEntityId);
    });

    it("is idempotent — a re-run updates in place rather than duplicating", async () => {
      // The backfill's headline contract: re-runnable with zero net change.
      const r = row({ title: "First" });

      await client.upsertProjectionRows([r]);
      const first = await read(r.entityId);
      await client.upsertProjectionRows([{ ...r, title: "Second" }]);

      const rows = await ctx.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        'SELECT count(*) AS n FROM "search_document" WHERE "organization_id" = $1::uuid AND "entity_id" = $2::uuid',
        ORG_ID,
        r.entityId
      );
      expect(Number(rows[0].n)).toBe(1);
      const second = await read(r.entityId);
      expect(second?.title).toBe("Second");
      // Same conflict target ⇒ same row, so the PK must survive the update.
      expect(second?.id).toBe(first?.id);
    });

    it("recomputes the Postgres-owned tsv column on update", async () => {
      // `tsv` is GENERATED ALWAYS and never named by the INSERT. If the upsert
      // ever started writing it, this is where that breaks.
      const r = row({ body: "alpha", title: "alpha" });

      await client.upsertProjectionRows([r]);
      const before = String((await read(r.entityId))?.tsv);
      await client.upsertProjectionRows([
        { ...r, body: "omega", title: "omega" },
      ]);
      const after = String((await read(r.entityId))?.tsv);

      expect(before).toContain("alpha");
      expect(after).toContain("omega");
      expect(after).not.toContain("alpha");
    });

    it("separates the same entity id under different entity types", async () => {
      // entity_type participates in the unique key, so one id appearing as both
      // a project and a loop is two rows, not a collision.
      const entityId = randomUUID();

      await client.upsertProjectionRows([
        row({
          entityId,
          entityType: SearchEntityType.Project,
          title: "As project",
        }),
        row({ entityId, entityType: SearchEntityType.Loop, title: "As loop" }),
      ]);

      const rows = await ctx.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        'SELECT count(*) AS n FROM "search_document" WHERE "organization_id" = $1::uuid AND "entity_id" = $2::uuid',
        ORG_ID,
        entityId
      );
      expect(Number(rows[0].n)).toBe(2);
    });

    it("writes a whole page in one statement", async () => {
      const page = Array.from({ length: 25 }, (_, i) =>
        row({ title: `Bulk ${i}` })
      );

      const written = await client.upsertProjectionRows(page);

      expect(written).toBe(25);
    });

    it("short-circuits an empty page without touching the database", async () => {
      // Guards against emitting `VALUES ()`, which is a syntax error.
      await expect(client.upsertProjectionRows([])).resolves.toBe(0);
    });
  }
);
