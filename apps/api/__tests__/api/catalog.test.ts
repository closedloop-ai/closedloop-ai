/**
 * Route tests for the admin catalog endpoints (FEA-2923 PR2).
 *
 * Exercises the real GET/POST /catalog route handlers and the admin RBAC gate
 * (isOrgAdmin) at the HTTP layer:
 * - GET /catalog — org-visible list (no admin gate);
 * - POST /catalog — 200 for an admin caller;
 * - POST /catalog — 403 for a non-admin caller (isOrgAdmin=false), before any
 *   service work;
 * - POST /catalog — 400 for an invalid body.
 *
 * The catalog service is mocked at the module boundary so the route logic
 * (auth wrapper, admin gate, body validation, response mapping) is what is under
 * test — not the service internals.
 */
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const mocks = vi.hoisted(() => ({
  isOrgAdmin: vi.fn(),
  listCatalogItemsForOrg: vi.fn(),
  createCatalogItem: vi.fn(),
}));

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (ctx: AuthContext, req: unknown, params: unknown) => unknown) =>
    (request: unknown, context: { params: unknown }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("@/lib/auth/org-admin", () => ({
  isOrgAdmin: mocks.isOrgAdmin,
}));

vi.mock("@/app/catalog/service", () => ({
  listCatalogItemsForOrg: mocks.listCatalogItemsForOrg,
  createCatalogItem: mocks.createCatalogItem,
}));

import { GET, POST } from "@/app/catalog/route";

const mockItem = {
  id: "item-1",
  organizationId: "org-1",
  targetKind: "plugin",
  source: "org_custom",
  scope: "org",
  name: "My Plugin",
  description: null,
  sortOrder: 0,
  enabled: true,
  archived: false,
  coaching: false,
  coachingConfig: null,
  logoUrl: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext({
    user: {
      id: "user-1",
      clerkId: "clerk-user-1",
      organizationId: "org-1",
    } as never,
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
  });
});

describe("GET /catalog", () => {
  it("lists catalog items for the org (no admin gate)", async () => {
    mocks.listCatalogItemsForOrg.mockResolvedValue([mockItem]);

    const response = await GET(
      createMockRequest({ url: "http://localhost:3002/catalog" }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    // Admin gate is NOT applied to reads.
    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
    expect(mocks.listCatalogItemsForOrg).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1" })
    );
  });
});

describe("POST /catalog", () => {
  it("creates a catalog item for an admin caller", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    mocks.createCatalogItem.mockResolvedValue(Result.ok(mockItem));

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/catalog",
        body: { targetKind: "plugin", name: "My Plugin" },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe("item-1");
    expect(mocks.createCatalogItem).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        userId: "user-1",
        targetKind: "plugin",
        name: "My Plugin",
      })
    );
  });

  it("returns 403 for a non-admin caller (isOrgAdmin=false)", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/catalog",
        body: { targetKind: "plugin", name: "My Plugin" },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(403);
    // Gate short-circuits before validating the body or touching the service.
    expect(mocks.createCatalogItem).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body (missing name)", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/catalog",
        body: { targetKind: "plugin" },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(400);
    expect(mocks.createCatalogItem).not.toHaveBeenCalled();
  });

  it("returns 404 when the service rejects an unattachable parentPackId (cross-org child-leak guard)", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    // Service returns 404 when the parent pack is missing / not visible to the org.
    mocks.createCatalogItem.mockResolvedValue(Result.err(404));

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/catalog",
        body: {
          targetKind: "agent",
          name: "Sneaky",
          parentPackId: "11111111-1111-4111-8111-111111111111",
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(404);
  });

  it("returns 403 when the service rejects a non-pack parentPackId", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    // Service returns 403 when the org-owned parent is not a Pack container.
    mocks.createCatalogItem.mockResolvedValue(Result.err(403));

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/catalog",
        body: {
          targetKind: "agent",
          name: "Child",
          parentPackId: "22222222-2222-4222-8222-222222222222",
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(403);
  });
});
