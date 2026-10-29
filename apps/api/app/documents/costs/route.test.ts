/**
 * ISS-12600 — `POST /documents/costs` at the ROUTE: the body boundary and the
 * Result-to-status mapping. Org scoping is proven against the real service in
 * `__tests__/document-metric-scope-org-scoping.test.ts`, not here.
 */
import { CustomFieldQueryRejection } from "@repo/api/src/types/custom-field-list-query";
import { DOCUMENT_METRIC_SCOPE_MAX_IDS } from "@repo/api/src/types/document-metric-scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createTestAuthContext,
} from "../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;
const mockRead = vi.hoisted(() => vi.fn());

vi.mock("@/app/documents/document-cost-scope-service", () => ({
  documentCostScopeService: { read: mockRead },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (auth: AuthContext, request: Request) => unknown) =>
    (request: Request) =>
      handler(mockAuthContext, request),
}));

import { POST } from "./route";

const UUID_A = "00000000-0000-4000-8000-0000000000a1";

function postCosts(body: unknown) {
  return POST(
    createMockRequest({
      url: "http://localhost:3002/documents/costs",
      method: "POST",
      body,
    }),
    { params: Promise.resolve({}) } as never
  );
}

describe("POST /documents/costs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mockRead.mockResolvedValue({ ok: true, value: { artifacts: [] } });
  });

  it("forwards the card scope with the caller's org and user", async () => {
    const body = {
      artifactIds: [],
      scope: {
        assigneeIds: [UUID_A],
        includeUnassigned: true,
        tagIds: [UUID_A],
        favoritesOnly: true,
      },
    };
    const response = await postCosts(body);
    expect(response.status).toBe(200);
    expect(mockRead).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      body
    );
  });

  it("maps a refused custom-field facet to 400", async () => {
    mockRead.mockResolvedValueOnce({
      ok: false,
      error: CustomFieldQueryRejection.NotFilterable,
    });
    const response = await postCosts({ artifactIds: [], scope: {} });
    expect(response.status).toBe(400);
  });

  it.each([
    ["an unknown scope key", { ownerIds: [UUID_A] }],
    [
      "an owner set past the bound",
      {
        assigneeIds: Array.from(
          { length: DOCUMENT_METRIC_SCOPE_MAX_IDS + 1 },
          () => UUID_A
        ),
      },
    ],
    ["a malformed tag id", { tagIds: ["not-a-uuid"] }],
  ])(
    "400s on %s rather than costing a different population",
    async (_name, scope) => {
      const response = await postCosts({ artifactIds: [], scope });
      expect(response.status).toBe(400);
      expect(mockRead).not.toHaveBeenCalled();
    }
  );
});
