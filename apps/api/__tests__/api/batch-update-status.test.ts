import { randomUUID } from "node:crypto";
import { AuditAction } from "@repo/api/src/types/audit";
import { DocumentStatus } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentService } from "@/app/documents/document-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

const mockDispatchAuditEvents = vi.fn();
const mockCaptureBatchStatusChange = vi.fn();

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/app/documents/document-service");
vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: (...args: unknown[]) => mockDispatchAuditEvents(...args),
  userAuditActor: (userId: string) => ({ actorType: "user", actorId: userId }),
}));
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureBatchStatusChange: (...args: unknown[]) =>
    mockCaptureBatchStatusChange(...args),
}));

import { POST } from "@/app/documents/batch-update-status/route";

describe("POST /documents/batch-update-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    // The route reads before-statuses for the activity feed (FEA-3864) before
    // updating. Default it to an empty map so the auto-mock returns a Map, not
    // undefined; individual tests can override.
    vi.mocked(documentService.getStatusesByIds).mockResolvedValue(new Map());
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
      vi.mocked(documentService.batchUpdateStatus).mockResolvedValue({
        updatedIds: ids,
        changedIds: ids,
      });

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

    it("passes organizationId from auth context to service", async () => {
      const ids = [randomUUID()];
      vi.mocked(documentService.batchUpdateStatus).mockResolvedValue({
        updatedIds: ids,
        changedIds: ids,
      });

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-update-status",
        method: "POST",
        body: { documentIds: ids, status: DocumentStatus.Approved },
      });

      await POST(request, createMockRouteContext({}));

      expect(documentService.batchUpdateStatus).toHaveBeenCalledWith(
        ids,
        DocumentStatus.Approved,
        mockAuthContext.user.organizationId
      );
    });

    it("audits and captures activity ONLY for documents that actually changed status", async () => {
      const changed = randomUUID();
      const unchanged = randomUUID();
      // The service reports both as valid (returned to the client) but only
      // `changed` as a real transition.
      vi.mocked(documentService.batchUpdateStatus).mockResolvedValue({
        updatedIds: [changed, unchanged],
        changedIds: [changed],
      });
      // Both ids exist with a prior status; `unchanged` is already at the
      // target status, so it must not be recorded as a transition on either
      // hook.
      vi.mocked(documentService.getStatusesByIds).mockResolvedValue(
        new Map([
          [changed, DocumentStatus.InReview],
          [unchanged, DocumentStatus.Approved],
        ])
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
    it("returns 500 when service throws", async () => {
      const ids = [randomUUID()];
      vi.mocked(documentService.batchUpdateStatus).mockRejectedValue(
        new Error("Database connection failed")
      );

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
