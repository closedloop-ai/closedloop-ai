import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAuthContext } from "@/__tests__/utils/auth-helpers";
import type { AuthContext } from "@/lib/auth/with-auth";

let mockAuthContext: AuthContext;

const mockGetBatchJudgeScores = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    _options?: { requiredScopes?: ApiKeyScope[] }
  ) => {
    return (request: NextRequest, _ctx: unknown) =>
      handler(mockAuthContext, request);
  },
}));

vi.mock("../evaluation-service", () => ({
  documentEvaluationService: {
    getBatchJudgeScores: mockGetBatchJudgeScores,
  },
}));

import { GET } from "./route";

function req(url: string) {
  return new NextRequest(url, { method: "GET" });
}

const emptyCtx = {} as Parameters<typeof GET>[1];

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
});

describe("GET /documents/judge-scores (ISS-9173 S2)", () => {
  it("400s when projectId is a slug (PRO-123)", async () => {
    const res = await GET(
      req("http://localhost/documents/judge-scores?projectId=PRO-123"),
      emptyCtx
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain("UUID");
    expect(mockGetBatchJudgeScores).not.toHaveBeenCalled();
  });

  it("400s when projectId is arbitrary text", async () => {
    const res = await GET(
      req("http://localhost/documents/judge-scores?projectId=abc"),
      emptyCtx
    );
    expect(res.status).toBe(400);
    expect(mockGetBatchJudgeScores).not.toHaveBeenCalled();
  });

  it("400s when projectId is missing", async () => {
    const res = await GET(
      req("http://localhost/documents/judge-scores"),
      emptyCtx
    );
    expect(res.status).toBe(400);
    expect(mockGetBatchJudgeScores).not.toHaveBeenCalled();
  });

  it("passes a valid UUID projectId to the service", async () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    mockGetBatchJudgeScores.mockResolvedValue({});

    const res = await GET(
      req(`http://localhost/documents/judge-scores?projectId=${uuid}`),
      emptyCtx
    );
    expect(res.status).toBe(200);
    expect(mockGetBatchJudgeScores).toHaveBeenCalledWith(
      uuid,
      mockAuthContext.user.organizationId,
      expect.any(Array)
    );
  });
});
