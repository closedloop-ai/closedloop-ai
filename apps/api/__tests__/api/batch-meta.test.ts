import { DocumentType } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/documents/batch-meta/route";
import { documentService } from "@/app/documents/document-service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));
vi.mock("@/app/documents/document-service");

describe("GET /api/artifacts/batch-meta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  describe("missing or invalid query params", () => {
    it("returns 400 when slugs param is absent", async () => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/artifacts/batch-meta",
      });
      const response = await GET(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe("slugs query parameter is required");
    });

    it("returns 400 when slugs param is whitespace only", async () => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/artifacts/batch-meta?slugs=%20%2C%20",
      });
      const response = await GET(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it("returns 400 when slugs param is an empty string", async () => {
      const request = createMockRequest({
        url: "http://localhost:3002/api/artifacts/batch-meta?slugs=",
      });
      const response = await GET(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
    });

    it("returns 400 when slug count exceeds 50", async () => {
      const slugs = Array.from({ length: 51 }, (_, i) => `slug-${i}`).join(",");
      const request = createMockRequest({
        url: `http://localhost:3002/api/artifacts/batch-meta?slugs=${slugs}`,
      });
      const response = await GET(request, createMockRouteContext({}));

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Too many slugs");
      expect(json.error).toContain("50");
    });
  });

  describe("success path", () => {
    it("returns title map for valid slugs", async () => {
      const titleMap = {
        "prd-abc": { title: "My PRD", type: DocumentType.Prd },
        "plan-xyz": { title: "My Plan", type: DocumentType.ImplementationPlan },
      };
      vi.mocked(documentService.batchFetchDocumentMeta).mockResolvedValue(
        titleMap
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/artifacts/batch-meta?slugs=prd-abc,plan-xyz",
      });
      const response = await GET(request, createMockRouteContext({}));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual(titleMap);
    });

    it("passes organizationId from auth context to service", async () => {
      vi.mocked(documentService.batchFetchDocumentMeta).mockResolvedValue({});

      const request = createMockRequest({
        url: "http://localhost:3002/api/artifacts/batch-meta?slugs=prd-abc",
      });
      await GET(request, createMockRouteContext({}));

      expect(documentService.batchFetchDocumentMeta).toHaveBeenCalledWith(
        mockAuthContext.user.organizationId,
        ["prd-abc"]
      );
    });

    it("trims whitespace from individual slugs", async () => {
      vi.mocked(documentService.batchFetchDocumentMeta).mockResolvedValue({});

      const request = createMockRequest({
        url: "http://localhost:3002/api/artifacts/batch-meta?slugs=prd-abc%20%2C%20plan-xyz",
      });
      await GET(request, createMockRouteContext({}));

      expect(documentService.batchFetchDocumentMeta).toHaveBeenCalledWith(
        expect.any(String),
        ["prd-abc", "plan-xyz"]
      );
    });

    it("returns empty map when no slugs match artifacts in org", async () => {
      vi.mocked(documentService.batchFetchDocumentMeta).mockResolvedValue({});

      const request = createMockRequest({
        url: "http://localhost:3002/api/artifacts/batch-meta?slugs=does-not-exist",
      });
      const response = await GET(request, createMockRouteContext({}));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual({});
    });

    it("accepts exactly 50 slugs (boundary check)", async () => {
      vi.mocked(documentService.batchFetchDocumentMeta).mockResolvedValue({});

      const slugs = Array.from({ length: 50 }, (_, i) => `slug-${i}`).join(",");
      const request = createMockRequest({
        url: `http://localhost:3002/api/artifacts/batch-meta?slugs=${slugs}`,
      });
      const response = await GET(request, createMockRouteContext({}));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.success).toBe(true);
    });
  });

  describe("error handling", () => {
    it("returns 500 when service throws", async () => {
      vi.mocked(documentService.batchFetchDocumentMeta).mockRejectedValue(
        new Error("Database connection failed")
      );

      const request = createMockRequest({
        url: "http://localhost:3002/api/artifacts/batch-meta?slugs=prd-abc",
      });
      const response = await GET(request, createMockRouteContext({}));

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe("Failed to fetch artifact titles");
    });
  });
});
