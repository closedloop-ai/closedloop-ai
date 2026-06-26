import { randomUUID } from "node:crypto";
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

import { POST } from "@/app/documents/batch-delete/route";

describe("POST /documents/batch-delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  describe("validation", () => {
    it("returns 400 when documentIds is empty", async () => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-delete",
        method: "POST",
        body: { documentIds: [] },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it("returns 400 when documentIds contains non-UUID strings", async () => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-delete",
        method: "POST",
        body: { documentIds: ["not-a-uuid"] },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });
  });

  describe("success", () => {
    it("returns 200 with deletedIds when all documents are found", async () => {
      const ids = [randomUUID(), randomUUID()];
      vi.mocked(documentService.batchDelete).mockResolvedValue({
        deletedIds: ids,
        failedIds: [],
      });

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-delete",
        method: "POST",
        body: { documentIds: ids },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data.deletedIds).toEqual(ids);
      expect(json.data.failedIds).toEqual([]);
    });

    it("returns 200 with partial failure when some documents are not found", async () => {
      const foundId = randomUUID();
      const missingId = randomUUID();
      vi.mocked(documentService.batchDelete).mockResolvedValue({
        deletedIds: [foundId],
        failedIds: [missingId],
      });

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-delete",
        method: "POST",
        body: { documentIds: [foundId, missingId] },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data.deletedIds).toEqual([foundId]);
      expect(json.data.failedIds).toEqual([missingId]);
    });

    it("passes organizationId from auth context to service", async () => {
      const ids = [randomUUID()];
      vi.mocked(documentService.batchDelete).mockResolvedValue({
        deletedIds: ids,
        failedIds: [],
      });

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-delete",
        method: "POST",
        body: { documentIds: ids },
      });

      await POST(request, createMockRouteContext({}));

      expect(documentService.batchDelete).toHaveBeenCalledWith(
        ids,
        mockAuthContext.user.organizationId
      );
    });
  });

  describe("error handling", () => {
    it("returns 500 when service throws", async () => {
      const ids = [randomUUID()];
      vi.mocked(documentService.batchDelete).mockRejectedValue(
        new Error("Database connection failed")
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/documents/batch-delete",
        method: "POST",
        body: { documentIds: ids },
      });

      const response = await POST(request, createMockRouteContext({}));

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe("Failed to delete documents");
    });
  });
});
