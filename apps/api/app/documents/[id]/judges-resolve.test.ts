import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;

const mockGetEvaluationFeedback = vi.hoisted(() => vi.fn());
const mockResolveDocumentId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    _options?: { requiredScopes?: ApiKeyScope[] }
  ) => {
    return (request: NextRequest, ctx: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, ctx.params);
  },
}));

vi.mock("@/lib/identifier-utils", () => ({
  resolveDocumentId: mockResolveDocumentId,
}));

vi.mock("../evaluation-service", () => ({
  documentEvaluationService: {
    getEvaluationFeedback: mockGetEvaluationFeedback,
  },
}));

const { GET: planGET } = await import("./plan-judges/route");
const { GET: prdGET } = await import("./prd-judges/route");
const { GET: featureGET } = await import("./feature-judges/route");

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(url: string) {
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  mockResolveDocumentId.mockResolvedValue(null);
});

const routes = [
  {
    name: "plan-judges",
    handler: planGET,
    reportType: EvaluationReportType.Plan,
  },
  { name: "prd-judges", handler: prdGET, reportType: EvaluationReportType.Prd },
  {
    name: "feature-judges",
    handler: featureGET,
    reportType: EvaluationReportType.Feature,
  },
] as const;

describe.each(routes)(
  "GET /documents/[id]/$name (ISS-9173 S3)",
  ({ name, handler, reportType }) => {
    it("404s when resolveDocumentId returns null (unknown id)", async () => {
      mockResolveDocumentId.mockResolvedValue(null);

      const res = await handler(
        req(`http://localhost/documents/unknown-id/${name}`),
        ctx("unknown-id")
      );
      expect(res.status).toBe(404);
      expect(mockGetEvaluationFeedback).not.toHaveBeenCalled();
    });

    it("resolves a slug through resolveDocumentId", async () => {
      const resolvedUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      mockResolveDocumentId.mockResolvedValue(resolvedUuid);
      mockGetEvaluationFeedback.mockResolvedValue({
        status: "not_found",
        data: null,
      });

      const res = await handler(
        req(`http://localhost/documents/PLN-42/${name}`),
        ctx("PLN-42")
      );
      expect(res.status).toBe(200);
      expect(mockResolveDocumentId).toHaveBeenCalledWith(
        "PLN-42",
        mockAuthContext.user.organizationId
      );
      expect(mockGetEvaluationFeedback).toHaveBeenCalledWith(
        resolvedUuid,
        mockAuthContext.user.organizationId,
        reportType
      );
    });

    it("passes resolvedId (not raw id) to the service", async () => {
      const resolvedUuid = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
      mockResolveDocumentId.mockResolvedValue(resolvedUuid);
      mockGetEvaluationFeedback.mockResolvedValue({
        status: "success",
        data: [],
      });

      await handler(
        req(`http://localhost/documents/some-id/${name}`),
        ctx("some-id")
      );
      expect(mockGetEvaluationFeedback).toHaveBeenCalledWith(
        resolvedUuid,
        expect.any(String),
        reportType
      );
    });
  }
);
