/**
 * Route tests for /catalog/{id}.
 *
 * The service owns catalog source, ownership, field-level, and archive checks.
 * These tests pin the HTTP-layer contract: reads stay org-visible, PATCH passes
 * admin capability plus the internal user id to the service, and DELETE remains
 * admin-only.
 */
import {
  CatalogItemScope,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
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
  getCatalogItemDetail: vi.fn(),
  updateCatalogItem: vi.fn(),
  archiveCatalogItem: vi.fn(),
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
  getCatalogItemDetail: mocks.getCatalogItemDetail,
  updateCatalogItem: mocks.updateCatalogItem,
  archiveCatalogItem: mocks.archiveCatalogItem,
}));

import { DELETE, GET, PATCH } from "@/app/catalog/[id]/route";

const mockItem = {
  id: "item-1",
  organizationId: "org-1",
  targetKind: "plugin",
  source: CatalogItemSource.OrgCustom,
  scope: CatalogItemScope.Org,
  name: "My Plugin",
  description: null,
  version: "1.0.0",
  sortOrder: 0,
  enabled: true,
  archived: false,
  coaching: false,
  coachingConfig: null,
  parentPackId: null,
  componentUuid: null,
  content: null,
  components: [],
  agentSlug: null,
  logoUrl: null,
  createdById: "user-1",
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

describe("GET /catalog/{id}", () => {
  it("fetches a catalog item without an admin gate", async () => {
    mocks.getCatalogItemDetail.mockResolvedValue(Result.ok(mockItem));

    const response = await GET(
      createMockRequest({ url: "http://localhost:3002/catalog/item-1" }),
      createMockRouteContext({ id: "item-1" })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe("item-1");
    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
    expect(mocks.getCatalogItemDetail).toHaveBeenCalledWith({
      id: "item-1",
      organizationId: "org-1",
    });
  });
});

describe("PATCH /catalog/{id}", () => {
  it("passes admin capability for an admin update", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    mocks.updateCatalogItem.mockResolvedValue(Result.ok(mockItem));

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "Renamed", enabled: false },
      }),
      createMockRouteContext({ id: "item-1" })
    );

    expect(response.status).toBe(200);
    expect(mocks.updateCatalogItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "item-1",
        organizationId: "org-1",
        userId: "user-1",
        canUpdateAny: true,
        name: "Renamed",
        enabled: false,
      })
    );
  });

  it("allows a non-admin update to reach service owner authorization", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);
    mocks.updateCatalogItem.mockResolvedValue(Result.ok(mockItem));

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "Owner Rename" },
      }),
      createMockRouteContext({ id: "item-1" })
    );

    expect(response.status).toBe(200);
    expect(mocks.updateCatalogItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "item-1",
        organizationId: "org-1",
        userId: "user-1",
        canUpdateAny: false,
        name: "Owner Rename",
      })
    );
  });

  it("returns 403 when service rejects a visible unauthorized update", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);
    mocks.updateCatalogItem.mockResolvedValue(Result.err(403));

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "Not Mine" },
      }),
      createMockRouteContext({ id: "item-1" })
    );

    expect(response.status).toBe(403);
  });

  it("returns 404 when service reports the item is not visible", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);
    mocks.updateCatalogItem.mockResolvedValue(Result.err(404));

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "Missing" },
      }),
      createMockRouteContext({ id: "item-1" })
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 for an invalid body before service work", async () => {
    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "" },
      }),
      createMockRouteContext({ id: "item-1" })
    );

    expect(response.status).toBe(400);
    expect(mocks.updateCatalogItem).not.toHaveBeenCalled();
  });
});

describe("DELETE /catalog/{id}", () => {
  it("still blocks non-admin archive requests before service work", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);

    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "http://localhost:3002/catalog/item-1",
      }),
      createMockRouteContext({ id: "item-1" })
    );

    expect(response.status).toBe(403);
    expect(mocks.archiveCatalogItem).not.toHaveBeenCalled();
  });

  it("archives catalog items for admins", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    mocks.archiveCatalogItem.mockResolvedValue(Result.ok({ archived: true }));

    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "http://localhost:3002/catalog/item-1",
      }),
      createMockRouteContext({ id: "item-1" })
    );

    expect(response.status).toBe(200);
    expect(mocks.archiveCatalogItem).toHaveBeenCalledWith({
      id: "item-1",
      organizationId: "org-1",
    });
  });
});
