import { randomUUID } from "node:crypto";
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

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));
vi.mock("@/app/documents/document-service");

import { POST } from "@/app/documents/batch-update-status/route";

describe("POST /documents/batch-update-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
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
      vi.mocked(documentService.batchUpdateStatus).mockResolvedValue(ids);

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
      vi.mocked(documentService.batchUpdateStatus).mockResolvedValue(ids);

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
