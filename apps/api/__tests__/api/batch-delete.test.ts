import { randomUUID } from "node:crypto";
import { AuditActorType } from "@repo/api/src/types/audit";
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
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context?: { params: Promise<unknown> }) =>
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

    it("passes organizationId and the authenticated actor from auth context to service", async () => {
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

      // The actor is what every entry the batch enqueues is attributed to, so
      // the route dropping it would leave a whole batch of deletes unattributed
      // (ISS-10029).
      expect(documentService.batchDelete).toHaveBeenCalledWith(
        ids,
        mockAuthContext.user.organizationId,
        { actorType: AuditActorType.User, actorId: mockAuthContext.user.id },
        // ISS-9465: the id that groups the batch's ledger entries. Minted per
        // request, so the value is not predictable here — only that one reached
        // the service, since a delete that reached it WITHOUT one would leave
        // its entries ungroupable in an append-only table.
        expect.any(String),
        // ISS-12552: a session request records nothing, so the service gets
        // no recorder and deletes exactly as it did before receipts.
        undefined
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
