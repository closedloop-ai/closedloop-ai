import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  failReceiptInserts,
  forcedReceiptFailures,
  readReceipts,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

const google = vi.hoisted(() => ({
  /** Doc ids whose Google fetch fails. */
  unreadable: new Set<string>(),
}));

vi.mock("@/lib/attribution-evidence-policy-feature", async (importOriginal) =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteFlagMock(await importOriginal())
);
vi.mock("@/lib/auth/with-any-auth", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteAuthMock()
);
vi.mock("@vercel/functions", async () =>
  (
    await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
  ).receiptRouteWaitUntilMock()
);
vi.mock(
  "@/lib/operation-receipts/operation-receipt-writer",
  async (importOriginal) =>
    (
      await import("@/__tests__/support/lib/operation-receipt-route.test-mocks")
    ).failingReceiptWriterMock(await importOriginal())
);
vi.mock("@/lib/liveblocks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveblocks")>()),
  createLiveblocksRoom: () => Promise.resolve({ success: true }),
}));
vi.mock("@repo/google", () => ({
  getDocName: (docId: string) =>
    google.unreadable.has(docId)
      ? Promise.reject(new Error("Request failed with status code 404"))
      : Promise.resolve(`Doc ${docId}`),
  exportDocAsMarkdown: (docId: string) => Promise.resolve(`# ${docId}`),
}));
vi.mock("@/app/integrations/google/service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/integrations/google/service")
  >()),
  googleService: {
    getIntegration: () => Promise.resolve({ id: "integration-1" }),
  },
  ensureValidAccessToken: () =>
    Promise.resolve({ success: true, accessToken: "test-access-token" }),
}));

import { POST as importGDriveContext } from "@/app/documents/[id]/context-attachments/gdrive/route";

const harness = createReceiptRouteHarness();
const GDRIVE_ROUTE = "/documents/[id]/context-attachments/gdrive";

/**
 * ISS-12552: each imported Google Doc becomes a context PRD
 * whose create, link and receipts share that document's own transaction.
 * Documents stay independent: one failing never rolls back another.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 Google Drive context import receipts",
  () => {
    beforeEach(() => google.unreadable.clear());
    afterEach(() => harness.cleanup());

    it("leaves no PRD or link for any document whose receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      failReceiptInserts();

      const response = await postImport(world, documentId, ["doc-a", "doc-b"]);

      expect(response.status).toBe(200);
      expect(await importedDocIdsIn(response)).toEqual([]);
      expect(forcedReceiptFailures()).toBe(2);
      expect(await countContextDocuments(world, documentId)).toBe(0);
      expect(await countLinksTo(documentId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records a link and a create per imported document, keeping one whose sibling failed", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      google.unreadable.add("doc-missing");

      const response = await postImport(world, documentId, [
        "doc-a",
        "doc-missing",
      ]);

      expect(response.status).toBe(200);
      expect(await importedDocIdsIn(response)).toEqual(["doc-a"]);
      expect(await countLinksTo(documentId)).toBe(1);
      const [contextId] = await contextDocumentIds(world, documentId);
      const receipts = await readReceipts(world.organizationId);
      expect(
        [...receipts].sort((a, b) =>
          a.operationKind.localeCompare(b.operationKind)
        )
      ).toEqual([
        {
          operationKind: OperationKind.Create,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: contextId,
          createdArtifactId: contextId,
          changedFields: [],
          route: GDRIVE_ROUTE,
        },
        {
          operationKind: OperationKind.LinkCreate,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: contextId,
          createdArtifactId: null,
          changedFields: [],
          route: GDRIVE_ROUTE,
        },
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      turnAttributionFlagOff();

      const response = await postImport(world, documentId, ["doc-a"]);

      expect(response.status).toBe(200);
      expect(await countContextDocuments(world, documentId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function postImport(
  world: { projectId: string },
  documentId: string,
  docIds: string[]
) {
  return importGDriveContext(
    apiKeyRouteRequest(
      "POST",
      `/documents/${documentId}/context-attachments/gdrive`,
      { docIds, projectId: world.projectId }
    ),
    receiptRouteParams({ id: documentId })
  );
}

/** The doc ids the response reports as imported, sorted. */
async function importedDocIdsIn(response: Response): Promise<string[]> {
  const body = (await response.clone().json()) as {
    data: { results: { docId: string; artifactId?: string }[] };
  };
  return body.data.results
    .filter((result) => result.artifactId !== undefined)
    .map((result) => result.docId)
    .sort();
}

async function contextDocumentIds(
  world: { organizationId: string },
  sourceDocumentId: string
): Promise<string[]> {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId: world.organizationId,
        id: { not: sourceDocumentId },
      },
      select: { id: true },
    })
  );
  return rows.map((row) => row.id);
}

async function countContextDocuments(
  world: { organizationId: string },
  sourceDocumentId: string
): Promise<number> {
  return (await contextDocumentIds(world, sourceDocumentId)).length;
}

function countLinksTo(documentId: string): Promise<number> {
  return withDb((db) =>
    db.artifactLink.count({ where: { targetId: documentId } })
  );
}
