import {
  OperationKind,
  OperationReceiptOutcome,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@repo/aws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/aws")>()),
  getSignedUploadUrl: (key: string) =>
    Promise.resolve(`https://upload.test/${key}`),
}));
vi.mock("@/lib/liveblocks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveblocks")>()),
  createLiveblocksRoom: () => Promise.resolve({ success: true }),
}));
vi.mock("@repo/aws/keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/aws/keys")>();
  return {
    ...actual,
    keys: () => ({
      ...actual.keys(),
      FILE_ATTACHMENTS_BUCKET: "context-attachment-receipt-bucket",
    }),
  };
});

import { POST as createContextAttachment } from "@/app/documents/[id]/context-attachments/route";

const harness = createReceiptRouteHarness();
const CONTEXT_ATTACHMENTS_ROUTE = "/documents/[id]/context-attachments";
const DIRECT_ATTACHMENT = {
  filename: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 128,
};
/** A document MIME type takes the branch that creates a linked context PRD. */
const DOCUMENT_FILE = {
  filename: "spec.md",
  mimeType: "text/markdown",
  sizeBytes: 256,
};

/**
 * ISS-12552: an API-key context attachment stored directly on a
 * document records an attach receipt in the attachment row's own transaction.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 document context attachment receipts",
  () => {
    afterEach(() => harness.cleanup());

    it("POST rolls the attachment row back when its receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      failReceiptInserts();

      const response = await postContextAttachment(documentId);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(await countAttachments(documentId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("records an attach naming the document", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");

      const response = await postContextAttachment(documentId);

      expect(response.status).toBe(200);
      expect(await countAttachments(documentId)).toBe(1);
      expect(await readReceipts(world.organizationId)).toEqual([
        {
          operationKind: OperationKind.Attach,
          outcome: OperationReceiptOutcome.Committed,
          source: OperationSource.Api,
          targetArtifactId: documentId,
          createdArtifactId: null,
          changedFields: [],
          route: CONTEXT_ATTACHMENTS_ROUTE,
        },
      ]);
    });

    it("writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      turnAttributionFlagOff();

      const response = await postContextAttachment(documentId);

      expect(response.status).toBe(200);
      expect(await countAttachments(documentId)).toBe(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST of a document file leaves no PRD, attachment or link when a receipt cannot be stored", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      failReceiptInserts();

      const response = await postContextAttachment(documentId, DOCUMENT_FILE);

      expect(response.status).toBe(500);
      expect(forcedReceiptFailures()).toBe(1);
      expect(
        await readContextDocuments(world.organizationId, documentId)
      ).toEqual([]);
      expect(await countLinksTo(documentId)).toBe(0);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("POST of a document file records its attach, link and create on the new PRD", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");

      const response = await postContextAttachment(documentId, DOCUMENT_FILE);

      expect(response.status).toBe(200);
      const [contextDocument] = await readContextDocuments(
        world.organizationId,
        documentId
      );
      expect(contextDocument?.attachments).toBe(1);
      expect(await countLinksTo(documentId)).toBe(1);
      const contextId = contextDocument?.id ?? null;
      expect(sortByKind(await readReceipts(world.organizationId))).toEqual(
        sortByKind([
          contextReceipt(OperationKind.Attach, contextId),
          contextReceipt(OperationKind.LinkCreate, contextId),
          {
            ...contextReceipt(OperationKind.Create, contextId),
            createdArtifactId: contextId,
          },
        ])
      );
    });

    it("POST of a document file writes no receipt with attribution-evidence-policy off", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      turnAttributionFlagOff();

      const response = await postContextAttachment(documentId, DOCUMENT_FILE);

      expect(response.status).toBe(200);
      expect(
        await readContextDocuments(world.organizationId, documentId)
      ).toHaveLength(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });
  }
);

function postContextAttachment(
  documentId: string,
  body: typeof DIRECT_ATTACHMENT = DIRECT_ATTACHMENT
) {
  return createContextAttachment(
    apiKeyRouteRequest(
      "POST",
      `/documents/${documentId}/context-attachments`,
      body
    ),
    receiptRouteParams({ id: documentId })
  );
}

function countAttachments(documentId: string): Promise<number> {
  return withDb((db) =>
    db.fileAttachment.count({ where: { artifactId: documentId } })
  );
}

/** Every artifact in the organization other than the source, with its attachment count. */
async function readContextDocuments(
  organizationId: string,
  sourceDocumentId: string
) {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: { organizationId, id: { not: sourceDocumentId } },
      select: { id: true, _count: { select: { fileAttachments: true } } },
    })
  );
  return rows.map((row) => ({
    id: row.id,
    attachments: row._count.fileAttachments,
  }));
}

function countLinksTo(documentId: string): Promise<number> {
  return withDb((db) =>
    db.artifactLink.count({ where: { targetId: documentId } })
  );
}

function contextReceipt(
  operationKind: OperationKind,
  contextId: string | null
) {
  return {
    operationKind,
    outcome: OperationReceiptOutcome.Committed,
    source: OperationSource.Api,
    targetArtifactId: contextId,
    createdArtifactId: null as string | null,
    changedFields: [],
    route: CONTEXT_ATTACHMENTS_ROUTE,
  };
}

function sortByKind<T extends { operationKind: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.operationKind.localeCompare(b.operationKind)
  );
}
