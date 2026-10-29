import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  DOCUMENT_LIST_MAX_OFFSET,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOrganization } from "@/__tests__/utils/db-helpers";
import { buildDocumentListWhere } from "./document-list-query";
import { documentListService } from "./document-list-service";

/**
 * ISS-11161 — a page past `DOCUMENT_LIST_MAX_OFFSET` is served by the bounded
 * query and holds the rows the whole-corpus read held at those positions.
 *
 * Before the fix the MCP `list-documents` tool read the whole corpus for any
 * page past the ceiling and sliced it, so "the same documents, in the same
 * order, as today" means: equal to the unbounded read's rows at
 * [offset, offset + limit). That equality is a property of the SQL — two plans
 * over one ORDER BY — so it runs against a real Postgres, over a corpus larger
 * than the ceiling, with `createdAt` ties that only the `id` tiebreak orders.
 *
 * The unbounded read is taken as ids only: the same predicate and ORDER BY
 * `findAllDocuments` issues, without the include it hydrates for 10,120 rows,
 * because the projection cannot change the row order (ISS-11372: this tier runs
 * near its job cap).
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const CORPUS_SIZE = DOCUMENT_LIST_MAX_OFFSET + 120;
const PAGE_SIZE = 100;
/** Rows sharing each `createdAt`, so the `id` tiebreak decides their order. */
const TIE_WIDTH = 3;

describeIfDb("document list past the old offset ceiling (ISS-11161)", () => {
  let organizationId = "";
  let unboundedIds: string[] = [];

  beforeAll(async () => {
    organizationId = await createTestOrganization();
    await seedCorpus(organizationId);
    const unbounded = await withDb((db) =>
      db.artifact.findMany({
        where: buildDocumentListWhere({ organizationId }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      })
    );
    unboundedIds = unbounded.map((document) => document.id);
  });

  afterAll(async () => {
    if (organizationId !== "") {
      await withDb((db) =>
        db.artifact.deleteMany({ where: { organizationId } })
      );
    }
  });

  it.each([
    DOCUMENT_LIST_MAX_OFFSET - 50,
    DOCUMENT_LIST_MAX_OFFSET,
    DOCUMENT_LIST_MAX_OFFSET + 1,
    DOCUMENT_LIST_MAX_OFFSET + 50,
  ])(
    "serves offset %i with the unbounded read's rows at those positions",
    async (offset) => {
      expect(unboundedIds).toHaveLength(CORPUS_SIZE);

      const page = await documentListService.findPageWithCustomFields({
        organizationId,
        limit: PAGE_SIZE,
        offset,
      });

      const expected = unboundedIds.slice(offset, offset + PAGE_SIZE);
      expect(expected.length).toBeGreaterThan(0);
      expect(page.items.map((item) => item.id)).toEqual(expected);
      expect(page.offset).toBe(offset);
      expect(page.total).toBe(CORPUS_SIZE);
      expect(page.hasMore).toBe(offset + expected.length < CORPUS_SIZE);
    }
  );

  it("answers an offset past the whole population with an empty page", async () => {
    const offset = Number.MAX_SAFE_INTEGER;

    const page = await documentListService.findPageWithCustomFields({
      organizationId,
      limit: PAGE_SIZE,
      offset,
    });

    expect(page.items).toEqual([]);
    expect(page.offset).toBe(offset);
    expect(page.total).toBe(CORPUS_SIZE);
    expect(page.hasMore).toBe(false);
  });
});

/** One set-based INSERT: per-row Prisma serialization dominated the hook. */
async function seedCorpus(organizationId: string): Promise<void> {
  await withDb((db) =>
    db.$executeRaw(Prisma.sql`
      INSERT INTO artifacts (id, organization_id, type, subtype, name, status, created_at, updated_at)
      SELECT
        gen_random_uuid(),
        ${organizationId}::uuid,
        ${ArtifactType.Document}::"ArtifactType",
        ${DocumentType.Doc}::"ArtifactSubtype",
        'Deep offset ' || g,
        ${DocumentStatus.Draft},
        timestamp '2026-01-01' + (g / ${TIE_WIDTH}::int) * interval '1 second',
        now()
      FROM generate_series(0, ${CORPUS_SIZE - 1}::int) g
    `)
  );
}
