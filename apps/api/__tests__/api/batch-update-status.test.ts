import { randomUUID } from "node:crypto";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction, AuditActorType } from "@repo/api/src/types/audit";
import { DocumentStatus } from "@repo/api/src/types/document";
import { DocumentStatusMutationErrorCode } from "@repo/api/src/types/document-status-mutation";
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentStatusMutationService } from "@/app/documents/document-status-mutation-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

const mockDispatchAuditEvents = vi.fn();
const mockCaptureArtifactFieldEditAnalytics = vi.fn();
const mockCaptureBatchStatusChange = vi.fn();
const mockResolveBlocks = vi.fn();
const mockEmitBatchFieldEditRefusalAnalytics = vi.fn();

// ISS-10993: the route opens ONE transaction for the mutation and its activity
// receipt. Every store this suite reaches is mocked, so the real `withDb` would
// only add a Postgres the unit lane does not have.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: (await import("@/__tests__/utils/mock-with-db")).mockWithDb(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));
// PARTIAL, not a bare automock: the module also exports
// `validateUndoTransactionReference`, which both routes call before writing
// (ISS-10458). Automocking it to `undefined` 500s every case here. Kept REAL —
// no request in this suite names an `undoOfTransactionId`, so it short-circuits
// without a query, which is also the proof that the field is optional.
vi.mock(
  "@/app/documents/document-status-mutation-service",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    documentStatusMutationService: {
      batchUpdateStatus: vi.fn(),
      updateDocument: vi.fn(),
    },
  })
);
vi.mock("@/app/documents/blocked-dependent-unblock-service", () => ({
  blockedDependentUnblockService: {
    resolveBlocksForChangedArtifacts: (...args: unknown[]) =>
      mockResolveBlocks(...args),
  },
}));
vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: (...args: unknown[]) => mockDispatchAuditEvents(...args),
  userAuditActor: (userId: string) => ({
    actorType: AuditActorType.User,
    actorId: userId,
  }),
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchStatusChange: (...args: unknown[]) =>
    mockCaptureBatchStatusChange(...args),
}));
vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: (...args: unknown[]) =>
    mockCaptureArtifactFieldEditAnalytics(...args),
}));
vi.mock("@/app/documents/batch-field-edit-refusal-analytics", () => ({
  emitBatchFieldEditRefusalAnalytics: (...args: unknown[]) =>
    mockEmitBatchFieldEditRefusalAnalytics(...args),
}));

import { POST } from "@/app/documents/batch-update-status/route";

describe("POST /documents/batch-update-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mockResolveBlocks.mockResolvedValue({
      resolvedIds: [],
      unblockedIds: [],
    });
    vi.mocked(
      documentStatusMutationService.batchUpdateStatus
    ).mockResolvedValue(
      Result.ok({ updatedIds: [], changedIds: [], transitions: [] })
    );
  });

  describe("validation", () => {
    it("returns 400 when documentIds is empty", async () => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: { documentIds: [], status: DocumentStatus.InReview },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it("returns 400 when status is not a valid DocumentStatus value", async () => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: {
          documentIds: ["00000000-0000-0000-0000-000000000001"],
          status: "INVALID_STATUS",
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it("returns 400 when documentIds contains non-UUID strings", async () => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: { documentIds: ["not-a-uuid"], status: DocumentStatus.Approved },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });
  });

  describe("success", () => {
    it("returns 200 with updatedIds on valid request", async () => {
      const ids = [randomUUID(), randomUUID()];
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.ok({
          updatedIds: ids,
          changedIds: ids,
          transitions: ids.map((id) => ({
            documentId: id,
            before: DocumentStatus.Draft,
            after: DocumentStatus.InReview,
          })),
        })
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: { documentIds: ids, status: DocumentStatus.InReview },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual(ids);
    });

    // ISS-9436: the route is what carries the bulk surface onto the receipt, so
    // the assertion is on the capture call's shape, not on the response.
    it("forwards the bulk surface and one shared commitGroupId to the capture", async () => {
      const ids = [randomUUID(), randomUUID()];
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.ok({
          updatedIds: ids,
          changedIds: ids,
          transitions: ids.map((id) => ({
            documentId: id,
            before: DocumentStatus.Draft,
            after: DocumentStatus.InReview,
          })),
        })
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: {
          documentIds: ids,
          status: DocumentStatus.InReview,
          surface: ArtifactStatusEditSurface.Bulk,
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(200);
      expect(mockCaptureBatchStatusChange).toHaveBeenCalledTimes(1);
      const captured = mockCaptureBatchStatusChange.mock.calls[0][0];
      expect(captured.provenance.surface).toBe(ArtifactStatusEditSurface.Bulk);
      expect(typeof captured.provenance.commitGroupId).toBe("string");
      expect(captured.provenance.commitGroupId.length).toBeGreaterThan(0);
    });

    it("PRESERVES OMISSION: no surface in the body means none on the capture", async () => {
      const ids = [randomUUID()];
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.ok({
          updatedIds: ids,
          changedIds: ids,
          transitions: [
            {
              documentId: ids[0],
              before: DocumentStatus.Draft,
              after: DocumentStatus.InReview,
            },
          ],
        })
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: { documentIds: ids, status: DocumentStatus.InReview },
      });

      await POST(request, createMockRouteContext({}));

      const captured = mockCaptureBatchStatusChange.mock.calls[0][0];
      expect(captured.provenance).toBeUndefined();
      const [capturedAnalytics] =
        mockCaptureArtifactFieldEditAnalytics.mock.calls[0];
      expect(capturedAnalytics).not.toHaveProperty("provenance");
    });

    it("commits an unknown future surface without receipt or analytics provenance", async () => {
      const id = randomUUID();
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.ok({
          updatedIds: [id],
          changedIds: [id],
          transitions: [
            {
              documentId: id,
              before: DocumentStatus.Draft,
              after: DocumentStatus.InReview,
            },
          ],
        })
      );
      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: {
          documentIds: [id],
          status: DocumentStatus.InReview,
          surface: "telepathy",
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(200);
      expect(
        documentStatusMutationService.batchUpdateStatus
      ).toHaveBeenCalledTimes(1);
      expect(
        mockCaptureBatchStatusChange.mock.calls[0][0].provenance
      ).toBeUndefined();
      const [capturedAnalytics] =
        mockCaptureArtifactFieldEditAnalytics.mock.calls[0];
      expect(capturedAnalytics).not.toHaveProperty("provenance");
    });

    // ISS-9436 — the analytics half. One event per COMMIT, and an origin that
    // is a measurement rather than a blanket null.
    it("emits ONE analytics event for the whole commit, naming the shared origin", async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.ok({
          updatedIds: ids,
          changedIds: ids,
          transitions: ids.map((id) => ({
            documentId: id,
            before: DocumentStatus.Draft,
            after: DocumentStatus.InReview,
          })),
        })
      );

      await POST(
        createMockRequest({
          url: "http://localhost:3002/api/documents/batch-update-status",
          method: "POST",
          body: {
            documentIds: ids,
            status: DocumentStatus.InReview,
            surface: ArtifactStatusEditSurface.Bulk,
          },
        }),
        createMockRouteContext({})
      );

      expect(mockCaptureArtifactFieldEditAnalytics).toHaveBeenCalledTimes(1);
      expect(
        mockCaptureArtifactFieldEditAnalytics.mock.calls[0][0]
      ).toMatchObject({
        field: ArtifactFieldEditField.Status,
        result: ArtifactFieldEditOutcome.Committed,
        provenance: expect.objectContaining({
          surface: ArtifactStatusEditSurface.Bulk,
        }),
        before: DocumentStatus.Draft,
        after: DocumentStatus.InReview,
        artifactCount: 3,
      });
    });

    it("names NO origin when the commit moved rows from different statuses", async () => {
      const ids = [randomUUID(), randomUUID()];
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.ok({
          updatedIds: ids,
          changedIds: ids,
          transitions: [
            {
              documentId: ids[0],
              before: DocumentStatus.Draft,
              after: DocumentStatus.InReview,
            },
            {
              documentId: ids[1],
              before: DocumentStatus.Approved,
              after: DocumentStatus.InReview,
            },
          ],
        })
      );

      await POST(
        createMockRequest({
          url: "http://localhost:3002/api/documents/batch-update-status",
          method: "POST",
          body: {
            documentIds: ids,
            status: DocumentStatus.InReview,
            surface: ArtifactStatusEditSurface.Bulk,
          },
        }),
        createMockRouteContext({})
      );

      // Absent, never null: `null` would report this mixed commit as
      // absent-status → IN_REVIEW and corrupt the transition funnel.
      const emitted = mockCaptureArtifactFieldEditAnalytics.mock.calls[0][0];
      expect(emitted.before).toBeUndefined();
      expect(emitted.artifactCount).toBe(2);
    });

    it("emits nothing when the batch moved no artifact at all", async () => {
      const ids = [randomUUID()];
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.ok({ updatedIds: ids, changedIds: [], transitions: [] })
      );

      await POST(
        createMockRequest({
          url: "http://localhost:3002/api/documents/batch-update-status",
          method: "POST",
          body: {
            documentIds: ids,
            status: DocumentStatus.InReview,
            surface: ArtifactStatusEditSurface.Bulk,
          },
        }),
        createMockRouteContext({})
      );

      expect(mockCaptureArtifactFieldEditAnalytics).toHaveBeenCalledWith(
        expect.objectContaining({ result: ArtifactFieldEditOutcome.NoChange })
      );
    });

    it("DROPS a surface forged by an API-key caller, on both the receipt and the event", async () => {
      mockAuthContext = createTestAuthContext({ authMethod: "api_key" });
      const ids = [randomUUID()];
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.ok({
          updatedIds: ids,
          changedIds: ids,
          transitions: [
            {
              documentId: ids[0],
              before: DocumentStatus.Draft,
              after: DocumentStatus.InReview,
            },
          ],
        })
      );

      const response = await POST(
        createMockRequest({
          url: "http://localhost:3002/api/documents/batch-update-status",
          method: "POST",
          body: {
            documentIds: ids,
            status: DocumentStatus.InReview,
            surface: ArtifactStatusEditSurface.Bulk,
          },
        }),
        createMockRouteContext({})
      );

      // The write still succeeds — only the claimed provenance is refused.
      expect(response.status).toBe(200);
      expect(
        mockCaptureBatchStatusChange.mock.calls[0][0].provenance
      ).toBeUndefined();
      const [capturedAnalytics] =
        mockCaptureArtifactFieldEditAnalytics.mock.calls[0];
      expect(capturedAnalytics).not.toHaveProperty("provenance");
    });

    it("passes organizationId from auth context to service", async () => {
      const id = randomUUID();
      const ids = [id];
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.ok({
          updatedIds: ids,
          changedIds: ids,
          transitions: [
            {
              documentId: id,
              before: DocumentStatus.Draft,
              after: DocumentStatus.Approved,
            },
          ],
        })
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: { documentIds: ids, status: DocumentStatus.Approved },
      });

      await POST(request, createMockRouteContext({}));

      expect(
        documentStatusMutationService.batchUpdateStatus
      ).toHaveBeenCalledWith(
        ids,
        DocumentStatus.Approved,
        mockAuthContext.user.organizationId,
        undefined
      );
    });

    it("passes expected statuses through to the mutation service", async () => {
      const id = randomUUID();
      const expectedStatusById = { [id]: DocumentStatus.Draft };
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.ok({
          updatedIds: [id],
          changedIds: [id],
          transitions: [
            {
              documentId: id,
              before: DocumentStatus.Draft,
              after: DocumentStatus.InReview,
            },
          ],
        })
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: {
          documentIds: [id],
          expectedStatusById,
          status: DocumentStatus.InReview,
        },
      });

      await POST(request, createMockRouteContext({}));

      expect(
        documentStatusMutationService.batchUpdateStatus
      ).toHaveBeenCalledWith(
        [id],
        DocumentStatus.InReview,
        mockAuthContext.user.organizationId,
        expectedStatusById
      );
    });

    it("audits and captures activity ONLY for documents that actually changed status", async () => {
      const changed = randomUUID();
      const unchanged = randomUUID();
      // The service reports both as valid (returned to the client) but only
      // `changed` as a real transition.
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.ok({
          updatedIds: [changed, unchanged],
          changedIds: [changed],
          transitions: [
            {
              documentId: changed,
              before: DocumentStatus.InReview,
              after: DocumentStatus.Approved,
            },
          ],
        })
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: {
          documentIds: [changed, unchanged],
          status: DocumentStatus.Approved,
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      // Client still receives every valid id.
      expect((await response.json()).data).toEqual([changed, unchanged]);
      // A SINGLE bulk emit call, carrying only the changed id — no forged
      // DocumentStatusChanged event for the no-op re-apply.
      expect(mockDispatchAuditEvents).toHaveBeenCalledTimes(1);
      const emitted = mockDispatchAuditEvents.mock.calls[0][0];
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        objectId: changed,
        action: AuditAction.DocumentStatusChanged,
      });
      // The activity feed hook fires on the SAME changed-only set — one change
      // entry for `changed`, none for the no-op `unchanged` (no double-count).
      expect(mockCaptureBatchStatusChange).toHaveBeenCalledTimes(1);
      expect(mockCaptureBatchStatusChange.mock.calls[0][0].changes).toEqual([
        {
          artifactId: changed,
          before: DocumentStatus.InReview,
          after: DocumentStatus.Approved,
        },
      ]);
    });
  });

  describe("error handling", () => {
    it("returns 400 when the service reports missing batch documents", async () => {
      const id = randomUUID();
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.err({
          status: Status.BadRequest,
          code: DocumentStatusMutationErrorCode.ArtifactsNotFound,
          message: "One or more documents were not found",
          details: { missingDocuments: [{ documentId: id }] },
        })
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: {
          documentIds: [id],
          status: DocumentStatus.Approved,
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json).toMatchObject({
        success: false,
        code: DocumentStatusMutationErrorCode.ArtifactsNotFound,
      });
      expect(mockDispatchAuditEvents).not.toHaveBeenCalled();
      expect(mockCaptureBatchStatusChange).not.toHaveBeenCalled();
      expect(mockEmitBatchFieldEditRefusalAnalytics).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: DocumentStatusMutationErrorCode.ArtifactsNotFound,
          }),
        })
      );
    });

    it("returns 409 when the service rejects a stale expected status", async () => {
      const id = randomUUID();
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockResolvedValue(
        Result.err({
          status: Status.Conflict,
          code: DocumentStatusMutationErrorCode.StaleStatus,
          message: "One or more documents changed before the status update",
          details: {
            staleStatuses: [
              {
                documentId: id,
                currentStatus: DocumentStatus.InReview,
                expectedStatus: DocumentStatus.Draft,
              },
            ],
          },
        })
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: {
          documentIds: [id],
          expectedStatusById: { [id]: DocumentStatus.Draft },
          status: DocumentStatus.Approved,
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(409);
      const json = await response.json();
      expect(json).toMatchObject({
        success: false,
        code: DocumentStatusMutationErrorCode.StaleStatus,
      });
      expect(mockDispatchAuditEvents).not.toHaveBeenCalled();
      expect(mockCaptureBatchStatusChange).not.toHaveBeenCalled();
      expect(mockEmitBatchFieldEditRefusalAnalytics).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: DocumentStatusMutationErrorCode.StaleStatus,
          }),
        })
      );
    });

    it("returns 500 when service throws", async () => {
      const ids = [randomUUID()];
      vi.mocked(
        documentStatusMutationService.batchUpdateStatus
      ).mockRejectedValue(new Error("Database connection failed"));

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: {
          documentIds: ids,
          status: DocumentStatus.Approved,
        },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe("Failed to update document statuses");
    });
  });
});
