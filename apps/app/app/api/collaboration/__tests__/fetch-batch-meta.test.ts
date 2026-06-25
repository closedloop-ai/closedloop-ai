import { DocumentType } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_API_URL: "http://localhost:3002",
  },
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks are set up
const { fetchBatchMeta } = await import("../fetch-batch-meta");

describe("fetchBatchMeta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("token guard", () => {
    it("returns empty map when getToken resolves to null", async () => {
      const getToken = vi.fn().mockResolvedValue(null);

      const result = await fetchBatchMeta(["prd-abc"], getToken);

      expect(result).toEqual({});
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("URL construction", () => {
    it("calls the correct API endpoint with slugs joined by comma", async () => {
      const getToken = vi.fn().mockResolvedValue("test-token");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce({
          success: true,
          data: { "prd-abc": { title: "My PRD", type: DocumentType.Prd } },
        }),
      });

      await fetchBatchMeta(["prd-abc", "plan-xyz"], getToken);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3002/documents/batch-meta?slugs=prd-abc,plan-xyz",
        expect.any(Object)
      );
    });

    it("sends Bearer token in Authorization header", async () => {
      const getToken = vi.fn().mockResolvedValue("my-clerk-token");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce({ success: true, data: {} }),
      });

      await fetchBatchMeta(["prd-abc"], getToken);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer my-clerk-token",
          }),
        })
      );
    });
  });

  describe("success path", () => {
    it("returns meta map from successful API response", async () => {
      const getToken = vi.fn().mockResolvedValue("test-token");
      const expectedMap = {
        "prd-abc": { title: "My PRD", type: DocumentType.Prd },
        "plan-xyz": { title: "My Plan", type: DocumentType.ImplementationPlan },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi
          .fn()
          .mockResolvedValueOnce({ success: true, data: expectedMap }),
      });

      const result = await fetchBatchMeta(["prd-abc", "plan-xyz"], getToken);

      expect(result).toEqual(expectedMap);
    });

    it("returns empty map when API returns empty data", async () => {
      const getToken = vi.fn().mockResolvedValue("test-token");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce({ success: true, data: {} }),
      });

      const result = await fetchBatchMeta(["does-not-exist"], getToken);

      expect(result).toEqual({});
    });
  });

  describe("error handling", () => {
    it("returns empty map when fetch response is not ok", async () => {
      const getToken = vi.fn().mockResolvedValue("test-token");
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const result = await fetchBatchMeta(["prd-abc"], getToken);

      expect(result).toEqual({});
    });

    it("returns empty map when API result has success: false", async () => {
      const getToken = vi.fn().mockResolvedValue("test-token");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce({
          success: false,
          error: "Something went wrong",
        }),
      });

      const result = await fetchBatchMeta(["prd-abc"], getToken);

      expect(result).toEqual({});
    });

    it("returns empty map when fetch throws a network error", async () => {
      const getToken = vi.fn().mockResolvedValue("test-token");
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await fetchBatchMeta(["prd-abc"], getToken);

      expect(result).toEqual({});
    });

    it("returns empty map when getToken throws", async () => {
      const getToken = vi.fn().mockRejectedValueOnce(new Error("Auth error"));

      const result = await fetchBatchMeta(["prd-abc"], getToken);

      expect(result).toEqual({});
    });
  });
});
