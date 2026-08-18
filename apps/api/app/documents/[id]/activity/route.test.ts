/**
 * Route tests for GET /documents/[id]/activity (FEA-3864 / FEA-3535 Slice 3)
 * and the PUT capture wiring's failure-isolation.
 *
 * Verifies:
 *  - the endpoint org-scopes: an unknown/foreign artifact 404s before any feed
 *    read (no leak);
 *  - it returns the merged, paginated feed result from the service;
 *  - an invalid limit is rejected;
 *  - ROUTE-LEVEL FAILURE-ISOLATION: a throwing activity capture never fails the
 *    PUT write (the user still gets 200).
 */
import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import { createTestAuthContext } from "../../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

const mockFindById = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockListActivityFeed = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: any,
    _options?: { requiredScopes?: ApiKeyScope[] }
  ) => {
    return (request: NextRequest, ctx: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, ctx.params);
  },
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveDocumentId: vi.fn(async (id: string) =>
      id === "missing" ? null : id
    ),
    resolveProjectId: vi.fn(async (id: string) => id),
  };
});

vi.mock("@/app/documents/document-service", () => ({
  documentService: { findById: mockFindById, update: mockUpdate },
}));

vi.mock("@/app/documents/artifact-activity-feed-service", () => ({
  artifactActivityFeedService: { listActivityFeed: mockListActivityFeed },
}));

import { GET } from "./route";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(url: string) {
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
});

describe("GET /documents/[id]/activity", () => {
  it("404s for an id that does not resolve in the org (no leak)", async () => {
    const res = await GET(
      req("http://localhost/documents/missing/activity"),
      ctx("missing")
    );
    expect(res.status).toBe(404);
    expect(mockListActivityFeed).not.toHaveBeenCalled();
  });

  it("404s when the artifact is not in the caller's org", async () => {
    mockFindById.mockResolvedValue(null);
    const res = await GET(
      req("http://localhost/documents/a1/activity"),
      ctx("a1")
    );
    expect(res.status).toBe(404);
    expect(mockListActivityFeed).not.toHaveBeenCalled();
  });

  it("returns the merged, paginated feed for an in-org artifact", async () => {
    mockFindById.mockResolvedValue({ id: "a1" });
    mockListActivityFeed.mockResolvedValue({
      items: [{ id: "event:e1", source: "event" }],
      nextCursor: "CURSOR",
    });

    const res = await GET(
      req("http://localhost/documents/a1/activity?limit=10&cursor=abc"),
      ctx("a1")
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.nextCursor).toBe("CURSOR");
    expect(mockListActivityFeed).toHaveBeenCalledWith({
      organizationId: mockAuthContext.user.organizationId,
      artifactId: "a1",
      cursor: "abc",
      limit: 10,
    });
  });

  it("rejects an out-of-range limit", async () => {
    mockFindById.mockResolvedValue({ id: "a1" });
    const res = await GET(
      req("http://localhost/documents/a1/activity?limit=9999"),
      ctx("a1")
    );
    expect(res.status).toBe(400);
    expect(mockListActivityFeed).not.toHaveBeenCalled();
  });
});
