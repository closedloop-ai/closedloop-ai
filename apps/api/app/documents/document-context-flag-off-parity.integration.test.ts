import { AuditAction, AuditActorType } from "@repo/api/src/types/audit";
import type { ApiResult } from "@repo/api/src/types/common";
import type { ImportGDriveContextResponse } from "@repo/api/src/types/context-attachment";
import { Status } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyRouteRequest,
  countReceipts,
  createReceiptRouteHarness,
  receiptRouteParams,
  turnAttributionFlagOff,
} from "@/__tests__/support/lib/operation-receipt-route.test-helpers";

const external = vi.hoisted(() => ({
  signingFails: false,
  deletedRooms: [] as string[],
  order: [] as string[],
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
vi.mock("@repo/aws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/aws")>()),
  getSignedUploadUrl: (key: string) => {
    external.order.push("sign");
    return external.signingFails
      ? Promise.reject(new Error("forced signing failure"))
      : Promise.resolve(`https://upload.test/${key}`);
  },
}));
vi.mock("@repo/aws/keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/aws/keys")>();
  return {
    ...actual,
    keys: () => ({
      ...actual.keys(),
      FILE_ATTACHMENTS_BUCKET: "context-flag-off-parity-bucket",
    }),
  };
});
vi.mock("@/lib/liveblocks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveblocks")>()),
  createLiveblocksRoom: () => {
    external.order.push("room");
    return Promise.resolve({ success: true });
  },
  deleteLiveblocksRoom: (roomId: string) => {
    external.deletedRooms.push(roomId);
    return Promise.resolve();
  },
}));
vi.mock("@/app/doc-sync/internal/delete-state", () => ({
  deleteDocSyncDocument: () => Promise.resolve(),
}));
vi.mock("@repo/google", () => ({
  getDocName: (docId: string) => Promise.resolve(`Doc ${docId}`),
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

import { artifactLinksService } from "@/app/artifact-links/service";
import { POST as importGDriveContext } from "@/app/documents/[id]/context-attachments/gdrive/route";
import { POST as createContextAttachment } from "@/app/documents/[id]/context-attachments/route";
import { searchIndexService } from "@/app/search/search-index-service";

const harness = createReceiptRouteHarness();
/** A document MIME type takes the branch that creates a linked context PRD. */
const DOCUMENT_FILE = {
  filename: "spec.md",
  mimeType: "text/markdown",
  sizeBytes: 256,
};

type World = Awaited<ReturnType<typeof harness.seedWorld>>;

/**
 * ISS-12552: flag-off behavior equals main for context PRDs. With
 * `attribution-evidence-policy` off, the PRD commits first, so a later failure
 * deletes it again as the `system` actor, leaving a `document.deleted` audit
 * entry and a room delete.
 */
describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 context PRDs match main with attribution evidence off",
  () => {
    beforeEach(() => {
      external.signingFails = false;
      external.deletedRooms = [];
      external.order = [];
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
    });

    it("creates, publishes and indexes the PRD before signing its upload and linking it", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      turnAttributionFlagOff();
      observeIndexAndLink();

      const response = await postDocumentFile(documentId);

      expect(response.status).toBe(200);
      expect(external.order).toEqual(["room", "index", "sign", "link"]);
      expect(await contextDocumentCount(world, documentId)).toBe(1);
    });

    it("creates, publishes and indexes a Google Doc's PRD before linking it", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      turnAttributionFlagOff();
      observeIndexAndLink();

      const response = await postGDriveImport(world, documentId);

      expect(response.status).toBe(200);
      expect(external.order).toEqual(["room", "index", "link"]);
      expect(await contextDocumentCount(world, documentId)).toBe(1);
    });

    it("a signing failure deletes the committed PRD like main", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      turnAttributionFlagOff();
      external.signingFails = true;

      const response = await postDocumentFile(documentId);

      expect(response.status).toBe(500);
      expect(await contextDocumentCount(world, documentId)).toBe(0);
      expect(await systemDocumentDeletes(world)).toBe(1);
      expect(external.deletedRooms).toHaveLength(1);
      expect(await countReceipts(world.organizationId)).toBe(0);
    });

    it("a rejected link deletes the committed PRD like main", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      turnAttributionFlagOff();
      rejectLinks();

      const response = await postDocumentFile(documentId);

      expect(response.status).toBe(500);
      expect(await contextDocumentCount(world, documentId)).toBe(0);
      expect(await systemDocumentDeletes(world)).toBe(1);
      expect(external.deletedRooms).toHaveLength(1);
    });

    it("a rejected Google Doc link deletes that doc's committed PRD like main", async () => {
      const world = await harness.seedWorld();
      const documentId = await harness.seedDocument(world, "Context");
      turnAttributionFlagOff();
      rejectLinks();

      const response = await postGDriveImport(world, documentId);

      expect(response.status).toBe(200);
      const body =
        (await response.json()) as ApiResult<ImportGDriveContextResponse>;
      expect(body.success && body.data.results).toEqual([
        { docId: "doc-a", error: expect.any(String) },
      ]);
      expect(await contextDocumentCount(world, documentId)).toBe(0);
      expect(await systemDocumentDeletes(world)).toBe(1);
      expect(external.deletedRooms).toHaveLength(1);
    });
  }
);

function postDocumentFile(documentId: string) {
  return createContextAttachment(
    apiKeyRouteRequest(
      "POST",
      `/documents/${documentId}/context-attachments`,
      DOCUMENT_FILE
    ),
    receiptRouteParams({ id: documentId })
  );
}

function postGDriveImport(world: World, documentId: string) {
  return importGDriveContext(
    apiKeyRouteRequest(
      "POST",
      `/documents/${documentId}/context-attachments/gdrive`,
      { projectId: world.projectId, docIds: ["doc-a"] }
    ),
    receiptRouteParams({ id: documentId })
  );
}

/** Records the search index and the link call in `external.order`. */
function observeIndexAndLink(): void {
  vi.spyOn(searchIndexService, "indexAfterCommit").mockImplementation(() => {
    external.order.push("index");
  });
  const createLink = artifactLinksService.createLink.bind(artifactLinksService);
  vi.spyOn(artifactLinksService, "createLink").mockImplementation((...args) => {
    external.order.push("link");
    return createLink(...args);
  });
}

function rejectLinks(): void {
  vi.spyOn(artifactLinksService, "createLink").mockResolvedValue({
    ok: false,
    error: Status.BadRequest,
  });
}

function contextDocumentCount(
  world: World,
  sourceDocumentId: string
): Promise<number> {
  return withDb((db) =>
    db.artifact.count({
      where: {
        organizationId: world.organizationId,
        id: { not: sourceDocumentId },
      },
    })
  );
}

function systemDocumentDeletes(world: World): Promise<number> {
  return withDb((db) =>
    db.auditOutbox.count({
      where: {
        organizationId: world.organizationId,
        action: AuditAction.DocumentDeleted,
        actorType: AuditActorType.System,
      },
    })
  );
}
