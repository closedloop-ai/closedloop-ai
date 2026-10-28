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
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const mocks = vi.hoisted(() => ({
  requireOrgAdmin: vi.fn(),
  getOrgAdminStatus: vi.fn(),
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
  requireOrgAdmin: mocks.requireOrgAdmin,
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));

vi.mock("@/app/catalog/service", () => ({
  getCatalogItemDetail: mocks.getCatalogItemDetail,
  updateCatalogItem: mocks.updateCatalogItem,
  archiveCatalogItem: mocks.archiveCatalogItem,
}));

import {
  ORG_ADMIN_ADMITTED,
  ORG_ADMIN_STATUS_ADMIN,
  ORG_ADMIN_STATUS_NOT_ADMIN,
  ORG_ADMIN_STATUS_PROVIDER_ERROR,
  orgAdminRefused,
} from "@/__tests__/support/auth/org-admin-gate.test-fixtures";
import { DELETE, GET, PATCH } from "@/app/catalog/[id]/route";
import {
  OrgAdminDenialReason,
  OrgAdminGateErrorCode,
} from "@/lib/auth/org-admin-denial";

/** `CatalogItem.id` is `@db.Uuid`, so the route refuses a non-uuid segment. */
const CATALOG_ITEM_ID = "0199a000-0000-7000-8000-000000000502";

const mockItem = {
  id: CATALOG_ITEM_ID,
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
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe(CATALOG_ITEM_ID);
    expect(mocks.requireOrgAdmin).not.toHaveBeenCalled();
    expect(mocks.getCatalogItemDetail).toHaveBeenCalledWith({
      id: CATALOG_ITEM_ID,
      organizationId: "org-1",
    });
  });
});

describe("PATCH /catalog/{id}", () => {
  it("passes admin capability for an admin update", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_ADMIN);
    mocks.updateCatalogItem.mockResolvedValue(Result.ok(mockItem));

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "Renamed", enabled: false },
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    expect(response.status).toBe(200);
    expect(mocks.updateCatalogItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: CATALOG_ITEM_ID,
        organizationId: "org-1",
        userId: "user-1",
        canUpdateAny: true,
        name: "Renamed",
        enabled: false,
      }),
      undefined
    );
  });

  it("allows a non-admin update to reach service owner authorization", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
    mocks.updateCatalogItem.mockResolvedValue(Result.ok(mockItem));

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "Owner Rename" },
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    expect(response.status).toBe(200);
    expect(mocks.updateCatalogItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: CATALOG_ITEM_ID,
        organizationId: "org-1",
        userId: "user-1",
        canUpdateAny: false,
        name: "Owner Rename",
      }),
      undefined
    );
  });

  it("returns 403 when service rejects a visible unauthorized update", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
    mocks.updateCatalogItem.mockResolvedValue(Result.err(403));

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "Not Mine" },
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    expect(response.status).toBe(403);
  });

  it("returns 404 when service reports the item is not visible", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_NOT_ADMIN);
    mocks.updateCatalogItem.mockResolvedValue(Result.err(404));

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "Missing" },
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    expect(response.status).toBe(404);
  });

  /**
   * ISS-8661. The admin verdict is a CAPABILITY on this route, not a gate — a
   * creator may edit their own item without it — so the cases below are
   * different questions, and answering them all with one status is what the
   * ticket is about.
   *
   * The route does NOT re-derive which refusal it got: only the service knows
   * why it refused, so it answers 503 for the authorization-dependent refusal
   * and 403 for the immutable one, and the route maps each straight through.
   * The pair below is what stops the route collapsing them again.
   */
  it("answers 503 when the service reports it could not decide", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_PROVIDER_ERROR);
    // The service refused on the own-item path, so being an admin WOULD have
    // changed the answer — and nobody could read the role. A 403 here would
    // blame the caller for a Clerk outage.
    mocks.updateCatalogItem.mockResolvedValue(
      Result.err(Status.ServiceUnavailable)
    );

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { sortOrder: 3 },
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: OrgAdminGateErrorCode.RoleUnresolved,
    });
  });

  it("keeps an immutable item's 403 while the role is unresolved", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_PROVIDER_ERROR);
    // A curated or archived item refuses an ADMIN too, so the unreadable role
    // cannot change this answer. Re-answering it 503 would tell the caller to
    // retry a request that can never succeed.
    mocks.updateCatalogItem.mockResolvedValue(Result.err(Status.Forbidden));

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "Renamed" },
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    expect(response.status).toBe(403);
    expect(response.status).not.toBe(503);
  });

  it("forwards the denial reason so the service can tell the two apart", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_PROVIDER_ERROR);
    mocks.updateCatalogItem.mockResolvedValue(Result.ok(mockItem));

    await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "Renamed" },
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    // Without this the service has no way to know the role was unreadable, and
    // every refusal collapses back to one status.
    expect(mocks.updateCatalogItem).toHaveBeenCalledWith(
      expect.objectContaining({
        adminDenialReason: OrgAdminDenialReason.ProviderError,
      }),
      undefined
    );
  });

  it("sends no denial reason for an admitted admin", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_ADMIN);
    mocks.updateCatalogItem.mockResolvedValue(Result.ok(mockItem));

    await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { sortOrder: 3 },
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    expect(mocks.updateCatalogItem).toHaveBeenCalledWith(
      expect.objectContaining({
        canUpdateAny: true,
        adminDenialReason: undefined,
      }),
      undefined
    );
  });

  it("still lets a creator edit their own item while the role is unresolved", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue(ORG_ADMIN_STATUS_PROVIDER_ERROR);
    // The own-item path succeeds: this caller created the item and the body
    // names no admin-only field, which is exactly the case the role is
    // irrelevant to.
    mocks.updateCatalogItem.mockResolvedValue(Result.ok(mockItem));

    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "Renamed" },
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    // The own-item path never consulted the role, so an unresolved role cannot
    // change this answer — refusing it would withdraw an edit that worked
    // before ISS-8661. The gate is asked with the capability OFF, exactly as a
    // resolved non-admin would be.
    expect(response.status).toBe(200);
    expect(mocks.updateCatalogItem).toHaveBeenCalledWith(
      expect.objectContaining({ canUpdateAny: false }),
      undefined
    );
  });

  it("returns 400 for an invalid body before service work", async () => {
    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        url: "http://localhost:3002/catalog/item-1",
        body: { name: "" },
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    expect(response.status).toBe(400);
    expect(mocks.updateCatalogItem).not.toHaveBeenCalled();
  });
});

describe("DELETE /catalog/{id}", () => {
  it("still blocks non-admin archive requests before service work", async () => {
    mocks.requireOrgAdmin.mockImplementation(orgAdminRefused);

    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "http://localhost:3002/catalog/item-1",
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    expect(response.status).toBe(403);
    expect(mocks.archiveCatalogItem).not.toHaveBeenCalled();
  });

  it("archives catalog items for admins", async () => {
    mocks.requireOrgAdmin.mockResolvedValue(ORG_ADMIN_ADMITTED);
    mocks.archiveCatalogItem.mockResolvedValue(Result.ok({ archived: true }));

    const response = await DELETE(
      createMockRequest({
        method: "DELETE",
        url: "http://localhost:3002/catalog/item-1",
      }),
      createMockRouteContext({ id: CATALOG_ITEM_ID })
    );

    expect(response.status).toBe(200);
    expect(mocks.archiveCatalogItem).toHaveBeenCalledWith(
      {
        id: CATALOG_ITEM_ID,
        organizationId: "org-1",
      },
      undefined
    );
  });
});
