/**
 * Route tests for POST /loops/summaries.
 *
 * Covers Zod body validation (UUID format, length bounds), auth wrapping,
 * and service-result passthrough.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (
      handler: (ctx: unknown, req: unknown, params: unknown) => Promise<unknown>
    ) =>
    async (request: unknown, context: { params?: unknown }) =>
      handler(mockAuthContext, request, context?.params),
}));

vi.mock("../../loop-summary-service", () => ({
  loopSummaryService: {
    getSummariesForDocuments: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

// --- Imports (after mocks) ---

import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../__tests__/utils/auth-helpers";
import { loopSummaryService } from "../../loop-summary-service";
import { POST } from "../route";

const ORG_ID = "test-org-id";
const USER_ID = "test-user-id";
const DOC_A = "11111111-1111-4111-8111-11111111111a";
const DOC_B = "22222222-2222-4222-8222-22222222222b";

const EMPTY_SUMMARY = {
  activeLoop: null,
  latestCompleted: null,
  latestFailed: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext({
    user: {
      id: USER_ID,
      organizationId: ORG_ID,
    } as never,
    authMethod: "session",
  });
  vi.mocked(loopSummaryService.getSummariesForDocuments).mockResolvedValue({
    [DOC_A]: EMPTY_SUMMARY,
  });
});

describe("POST /loops/summaries", () => {
  it("returns 200 and the service response on the happy path", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/loops/summaries",
        method: "POST",
        body: { documentIds: [DOC_A] },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data).toEqual({ [DOC_A]: EMPTY_SUMMARY });
    expect(loopSummaryService.getSummariesForDocuments).toHaveBeenCalledWith(
      ORG_ID,
      [DOC_A]
    );
  });

  it("forwards organizationId from auth context to the service", async () => {
    await POST(
      createMockRequest({
        url: "http://localhost:3002/loops/summaries",
        method: "POST",
        body: { documentIds: [DOC_A, DOC_B] },
      }),
      createMockRouteContext({})
    );

    expect(loopSummaryService.getSummariesForDocuments).toHaveBeenCalledWith(
      ORG_ID,
      [DOC_A, DOC_B]
    );
  });

  it("returns 400 when documentIds is missing", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/loops/summaries",
        method: "POST",
        body: {},
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(loopSummaryService.getSummariesForDocuments).not.toHaveBeenCalled();
  });

  it("returns 400 when documentIds is empty", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/loops/summaries",
        method: "POST",
        body: { documentIds: [] },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(loopSummaryService.getSummariesForDocuments).not.toHaveBeenCalled();
  });

  it("returns 400 when documentIds contains non-UUID values", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/loops/summaries",
        method: "POST",
        body: { documentIds: ["not-a-uuid"] },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(loopSummaryService.getSummariesForDocuments).not.toHaveBeenCalled();
  });

  it("returns 400 when documentIds exceeds the 100 ID limit", async () => {
    const tooMany = Array.from(
      { length: 101 },
      (_, i) =>
        `11111111-1111-4111-8111-${String(i).padStart(12, "0")}` as string
    );

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/loops/summaries",
        method: "POST",
        body: { documentIds: tooMany },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(loopSummaryService.getSummariesForDocuments).not.toHaveBeenCalled();
  });

  it("returns 500 when the service throws", async () => {
    vi.mocked(loopSummaryService.getSummariesForDocuments).mockRejectedValue(
      new Error("db down")
    );

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/loops/summaries",
        method: "POST",
        body: { documentIds: [DOC_A] },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
  });

  it("does not leak document existence across orgs (passes whatever IDs the caller sends)", async () => {
    // Cross-org enumeration: caller passes UUIDs they don't own. Service
    // returns empty summaries because the recursive CTE filters by
    // organization_id. Route does NOT validate ownership separately —
    // org scoping is enforced inside the service. This test locks that
    // contract.
    vi.mocked(loopSummaryService.getSummariesForDocuments).mockResolvedValue({
      [DOC_A]: EMPTY_SUMMARY,
      [DOC_B]: EMPTY_SUMMARY,
    });

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/loops/summaries",
        method: "POST",
        body: { documentIds: [DOC_A, DOC_B] },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    // Same shape regardless of whether the docs belong to the org.
    expect(json.data[DOC_A]).toEqual(EMPTY_SUMMARY);
    expect(json.data[DOC_B]).toEqual(EMPTY_SUMMARY);
  });
});
