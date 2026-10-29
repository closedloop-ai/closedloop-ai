/**
 * ISS-9938 (PLN-2065 §6.4) — a status-filtered search answers with the status
 * the production writers just committed.
 *
 * `search_document.status` is the ANSWER to a `status:` search: that token
 * routes the request to the projection-backed unified search, which never
 * joins back to `artifacts`. None of the writers driven below
 * reindexes the projection. The first four cases pass only because the
 * `*_search_document_status_sync` triggers copy the status inside the write's
 * own transaction, so dropping those triggers turns those four red; the last
 * case does not depend on them. The last two cases cover the indexer's own
 * writes. A re-index a concurrent edit
 * schedules lands after the status write carrying the status it captured
 * before it, and must not undo the trigger's value. A first index that lands
 * after a status write finds nothing the trigger updated, so its insert must
 * read the status the source holds now, not the one it captured.
 *
 * Each case drives the real service a route calls and reads back through
 * `searchFtsService.searchUnified` with filters from the real
 * `parseSearchQuery`, which is what a user's `timeline status:DONE` reaches.
 * Projection rows are seeded through the production `documentProjection`
 * builder and `searchIndexService.upsert`, so the
 * `entity_type` they carry is the one the app writes.
 *
 * Real Postgres (self-skips without DATABASE_URL); every case runs in an
 * auto-rollback transaction. The audit ledger and activity-feed emitters are
 * stubbed because they write through `waitUntil`, which would escape that
 * rollback; neither decides a status.
 *
 * Run explicitly:
 *
 *   DATABASE_URL=... NODE_ENV=test pnpm --filter api exec vitest run \
 *     --config vitest.config.integration.mts --no-file-parallelism \
 *     __tests__/integration/iss9938-search-status-filter-wiring.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { IssueStatus } from "@repo/api/src/types/document";
import { SearchMode } from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { parseSearchQuery } from "@repo/api/src/types/search-query";
import { withDb } from "@repo/database";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/audit/audit-emit-service", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/app/audit/audit-emit-service")>();
  return { ...real, dispatchAuditEvents: vi.fn() };
});

vi.mock("@/lib/artifact-activity-capture", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/artifact-activity-capture")>();
  return {
    ...real,
    captureAutomatedUnblock: vi.fn(),
    captureBatchStatusChange: vi.fn(),
  };
});

import {
  autoRollbackTransactionJoining,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  hasDatabase,
  readStatus,
  seedArtifact,
  seedBlocksEdge,
} from "@/app/documents/__tests__/blocked-dependent-fixtures";
import { emitBatchStatusSideEffects } from "@/app/documents/batch-status-side-effects";
import { documentStatusBatchItemService } from "@/app/documents/document-status-batch-item-service";
import { documentStatusMutationService } from "@/app/documents/document-status-mutation-service";
import { searchFtsService } from "@/app/search/search-fts-service";
import {
  documentProjection,
  type SearchProjectionInput,
  searchIndexService,
} from "@/app/search/search-index-service";
import { newBulkTransactionId } from "@/lib/bulk-mutation-transaction";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin that a status write is reflected by the search filter, not the unblock resolver's per-chunk commit boundary, which is covered by the committed fixture in app/documents/blocked-dependent-unblock-chunk-boundary.integration.test.ts"
);

const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * The stored `entity_type` values, as literals: these assert against rows the
 * triggers matched, so they must not be derived from the constant whose drift
 * they exist to catch.
 */
const DOCUMENT_ENTITY = "document";
const LOOP_ENTITY = "loop";

type Hit = { entityType: string; entityId: string };

describeIfDb(
  "ISS-9938 status-filtered search after a real status write",
  () => {
    it("bulk status v1: the new status matches and the old one no longer does", async () => {
      await joinAmbientTransaction(async () => {
        const organizationId = await createTestOrganization();
        const term = searchTerm();
        const [first, second, untouched] = await Promise.all([
          seedIndexedDocument(organizationId, term, IssueStatus.InProgress),
          seedIndexedDocument(organizationId, term, IssueStatus.InProgress),
          seedIndexedDocument(organizationId, term, IssueStatus.InProgress),
        ]);

        const result = await documentStatusMutationService.batchUpdateStatus(
          [first, second],
          IssueStatus.Done,
          organizationId
        );
        expect(result.ok).toBe(true);

        expect(
          await searchByStatus(organizationId, term, IssueStatus.Done)
        ).toEqual(documentHits([first, second]));
        expect(
          await searchByStatus(organizationId, term, IssueStatus.InProgress)
        ).toEqual(documentHits([untouched]));
      });
    });

    it("bulk status v2 per-item: only the applied item moves in search", async () => {
      await joinAmbientTransaction(async () => {
        const organizationId = await createTestOrganization();
        const term = searchTerm();
        const [applied, refused] = await Promise.all([
          seedIndexedDocument(organizationId, term, IssueStatus.InProgress),
          seedIndexedDocument(organizationId, term, IssueStatus.InProgress),
        ]);

        // `refused` carries a stale expected status, so v2 refuses that item and
        // writes the other.
        const outcome = await documentStatusBatchItemService.batchUpdateStatus(
          [applied, refused],
          IssueStatus.Done,
          organizationId,
          {
            [applied]: IssueStatus.InProgress,
            [refused]: IssueStatus.Todo,
          }
        );
        expect(outcome.changedIds).toEqual([applied]);

        expect(
          await searchByStatus(organizationId, term, IssueStatus.Done)
        ).toEqual(documentHits([applied]));
        expect(
          await searchByStatus(organizationId, term, IssueStatus.InProgress)
        ).toEqual(documentHits([refused]));
      });
    });

    it("auto-unblock: a dependent released by a bulk DONE is found as TODO", async () => {
      await joinAmbientTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const term = searchTerm();
        const blocker = await seedIndexedDocument(
          organizationId,
          term,
          IssueStatus.InProgress
        );
        const dependent = await seedIndexedDocument(
          organizationId,
          term,
          IssueStatus.Blocked
        );
        await seedBlocksEdge({
          organizationId,
          sourceId: blocker,
          targetId: dependent,
        });

        // The bulk route's two halves, in its order: the guarded write, then the
        // post-commit side effects that run the unblock.
        const result = await documentStatusMutationService.batchUpdateStatus(
          [blocker],
          IssueStatus.Done,
          organizationId
        );
        if (!result.ok) {
          throw new Error(`bulk status write failed: ${result.error.code}`);
        }
        await emitBatchStatusSideEffects({
          user: { id: user.id, organizationId },
          authMethod: "session",
          status: IssueStatus.Done,
          surface: undefined,
          transitions: result.value.transitions,
          changedIds: result.value.changedIds,
          transactionId: newBulkTransactionId(),
        });
        expect(await readStatus(dependent)).toBe(IssueStatus.Todo);

        expect(
          await searchByStatus(organizationId, term, IssueStatus.Todo)
        ).toEqual(documentHits([dependent]));
        expect(
          await searchByStatus(organizationId, term, IssueStatus.Blocked)
        ).toEqual([]);
      });
    });

    it("a re-index carrying the pre-transition status leaves the trigger's value", async () => {
      await joinAmbientTransaction(async () => {
        const organizationId = await createTestOrganization();
        const term = searchTerm();
        const documentId = await seedIndexedDocument(
          organizationId,
          term,
          IssueStatus.InProgress
        );
        const staleDocument = await readDocumentProjection(
          organizationId,
          documentId
        );

        const result = await documentStatusMutationService.batchUpdateStatus(
          [documentId],
          IssueStatus.Done,
          organizationId
        );
        expect(result.ok).toBe(true);

        const renamed = `${term} renamed`;
        await searchIndexService.upsertMany([
          { ...staleDocument, title: renamed },
        ]);

        expect(
          await searchByStatus(organizationId, term, IssueStatus.Done)
        ).toEqual(documentHits([documentId]));
        expect(
          await searchByStatus(organizationId, term, IssueStatus.InProgress)
        ).toEqual([]);
        // The rest of the row is still the re-index's to write.
        expect(await readDocumentRowTitle(organizationId, documentId)).toBe(
          renamed
        );
      });
    });

    it("a first index landing after a status write inserts the current status", async () => {
      await joinAmbientTransaction(async () => {
        const organizationId = await createTestOrganization();
        const term = searchTerm();
        const documentId = await seedArtifact({
          organizationId,
          status: IssueStatus.InProgress,
          name: `${term} document`,
        });
        const capturedDocument = await readDocumentProjection(
          organizationId,
          documentId
        );

        const result = await documentStatusMutationService.batchUpdateStatus(
          [documentId],
          IssueStatus.Done,
          organizationId
        );
        expect(result.ok).toBe(true);

        // The row did not exist when that write fired its trigger, so only the
        // insert itself can bring the new status in.
        expect(capturedDocument.status).toBe(IssueStatus.InProgress);
        await searchIndexService.upsertMany([capturedDocument]);

        expect(
          await searchByStatus(organizationId, term, IssueStatus.Done)
        ).toEqual(documentHits([documentId]));
        expect(
          await searchByStatus(organizationId, term, IssueStatus.InProgress)
        ).toEqual([]);
      });
    });

    // ISS-12435: rows an old API wrote under the retired `loop` kind can outlive
    // the data step. They must not reach the over-fetch: three higher-ranked
    // leftover loop rows would otherwise fill a one-hit page's candidate window
    // and push the document out of it.
    it("a leftover loop row neither surfaces nor crowds out a document", async () => {
      await joinAmbientTransaction(async () => {
        const organizationId = await createTestOrganization();
        const term = searchTerm();
        const documentId = await seedIndexedDocument(
          organizationId,
          term,
          IssueStatus.InProgress
        );
        await seedLeftoverLoopRows(organizationId, term, 3);

        const everyKind = await searchOnePage(organizationId, term, []);
        expect(hitsOf(everyKind)).toEqual(documentHits([documentId]));
        expect(everyKind.nextCursor).toBeNull();

        const loopOnly = await searchOnePage(organizationId, term, [
          SearchEntityType.Loop,
        ]);
        expect(loopOnly.results).toEqual([]);
        expect(loopOnly.nextCursor).toBeNull();
      });
    });
  }
);

/** A token unique to one case, so a search can only see that case's rows. */
function searchTerm(): string {
  return `iss9938x${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function documentHits(ids: string[]): Hit[] {
  return sortHits(
    ids.map((entityId) => ({ entityType: DOCUMENT_ENTITY, entityId }))
  );
}

function sortHits(hits: Hit[]): Hit[] {
  return [...hits].sort((a, b) => a.entityId.localeCompare(b.entityId));
}

/** The unified search a user's `<term> status:<STATUS>` query reaches. */
async function searchByStatus(
  organizationId: string,
  term: string,
  status: string
): Promise<Hit[]> {
  const parsed = parseSearchQuery(`${term} status:${status}`);
  if (parsed.errors.length > 0) {
    throw new Error(`unparseable search: ${parsed.errors[0].message}`);
  }
  const response = await searchFtsService.searchUnified({
    organizationId,
    query: parsed.text,
    mode: SearchMode.Fulltext,
    types: [],
    since: null,
    until: null,
    limit: 25,
    cursor: null,
    filters: parsed.filters,
    idLookup: parsed.idLookup,
  });
  return sortHits(
    response.results.map((hit) => ({
      entityType: hit.entityType,
      entityId: hit.entityId,
    }))
  );
}

async function seedIndexedDocument(
  organizationId: string,
  term: string,
  status: string
): Promise<string> {
  const id = await seedArtifact({
    organizationId,
    status,
    name: `${term} document`,
  });
  await searchIndexService.upsert(
    await readDocumentProjection(organizationId, id)
  );
  return id;
}

/** The projection row the app's indexer builds from the document as stored. */
async function readDocumentProjection(
  organizationId: string,
  id: string
): Promise<SearchProjectionInput> {
  const artifact = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id },
      select: {
        name: true,
        slug: true,
        subtype: true,
        projectId: true,
        assigneeId: true,
        status: true,
        priority: true,
        updatedAt: true,
      },
    })
  );
  return documentProjection({
    id,
    organizationId,
    title: artifact.name,
    slug: artifact.slug ?? "",
    entitySubtype: artifact.subtype ?? "",
    body: null,
    projectId: artifact.projectId,
    assigneeId: artifact.assigneeId,
    status: artifact.status,
    priority: artifact.priority,
    updatedAt: artifact.updatedAt,
  });
}

async function readDocumentRowTitle(
  organizationId: string,
  entityId: string
): Promise<string> {
  const row = await withDb((db) =>
    db.searchDocument.findFirstOrThrow({
      where: { organizationId, entityType: DOCUMENT_ENTITY, entityId },
      select: { title: true },
    })
  );
  return row.title;
}

/** One-hit page of the unified search, so the candidate window is three rows. */
function searchOnePage(
  organizationId: string,
  term: string,
  types: SearchEntityType[]
) {
  return searchFtsService.searchUnified({
    organizationId,
    query: term,
    mode: SearchMode.Fulltext,
    types,
    since: null,
    until: null,
    limit: 1,
    cursor: null,
    filters: parseSearchQuery(term).filters,
  });
}

function hitsOf(response: {
  results: { entityType: string; entityId: string }[];
}): Hit[] {
  return sortHits(
    response.results.map((hit) => ({
      entityType: hit.entityType,
      entityId: hit.entityId,
    }))
  );
}

/**
 * Projection rows under the retired `loop` kind, ranked above the document (the
 * term repeats) and newer than it, as an old API could still write them.
 */
async function seedLeftoverLoopRows(
  organizationId: string,
  term: string,
  count: number
): Promise<void> {
  await withDb((db) =>
    db.searchDocument.createMany({
      data: Array.from({ length: count }, () => ({
        organizationId,
        entityType: LOOP_ENTITY,
        entityId: randomUUID(),
        title: `${term} ${term} ${term}`,
        body: term,
        updatedAt: new Date(Date.now() + 60_000),
      })),
    })
  );
}
