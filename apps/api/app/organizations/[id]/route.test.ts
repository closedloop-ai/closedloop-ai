import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    authMethod: "session",
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: {
      id: "user-1",
      clerkId: "clerk-user-1",
      organizationId: "org-1",
    },
  },
  clerkUpdateOrganization: vi.fn(),
  isOrgAdmin: vi.fn(),
  logError: vi.fn(),
  organizationsService: {
    findById: vi.fn(),
    findBySlug: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<{ id: string }> }) =>
      handler(mocks.authContext, request, context.params),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    updateOrganization: mocks.clerkUpdateOrganization,
  },
}));

vi.mock("@/lib/auth/org-admin", () => ({
  isOrgAdmin: mocks.isOrgAdmin,
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("../service", () => ({
  organizationsService: mocks.organizationsService,
}));

import { PUT } from "./route";

const ORG_ID = "org-1";
const BASE_ORGANIZATION = {
  active: true,
  clerkId: "clerk-org-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  id: ORG_ID,
  name: "Acme",
  settings: {},
  slug: "acme",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("PUT /organizations/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authContext.user.organizationId = ORG_ID;
    mocks.organizationsService.findById.mockResolvedValue(BASE_ORGANIZATION);
    mocks.organizationsService.findBySlug.mockResolvedValue(null);
    mocks.organizationsService.update.mockResolvedValue({
      ...BASE_ORGANIZATION,
      name: "Updated Acme",
    });
    mocks.isOrgAdmin.mockResolvedValue(true);
    mocks.clerkUpdateOrganization.mockResolvedValue({
      id: "clerk-org-1",
      name: "Acme",
      slug: "new-acme",
    });
  });

  it("preserves the non-slug update path and syncs name to Clerk", async () => {
    const response = await putOrganization({ name: "Updated Acme" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.organizationsService.update).toHaveBeenCalledWith(ORG_ID, {
      name: "Updated Acme",
    });
    expect(mocks.organizationsService.findById).not.toHaveBeenCalled();
    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
    expect(mocks.clerkUpdateOrganization).toHaveBeenCalledWith("clerk-org-1", {
      name: "Updated Acme",
    });
  });

  it("logs but does not fail when Clerk name sync fails on non-slug update", async () => {
    mocks.clerkUpdateOrganization.mockRejectedValueOnce(
      new Error("Clerk unavailable")
    );

    const response = await putOrganization({ name: "Updated Acme" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.logError).toHaveBeenCalledWith(
      "org_name_clerk_sync_failed",
      expect.objectContaining({ organizationId: ORG_ID })
    );
  });

  it("skips Clerk sync for settings-only non-slug updates", async () => {
    mocks.organizationsService.update.mockResolvedValue({
      ...BASE_ORGANIZATION,
      settings: { theme: "dark" },
    });

    const response = await putOrganization({ settings: { theme: "dark" } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.clerkUpdateOrganization).not.toHaveBeenCalled();
  });

  it("rejects invalid and reserved changed slugs before mutation calls", async () => {
    const response = await putOrganization({ slug: "api" });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(mocks.organizationsService.findById).toHaveBeenCalledWith(ORG_ID);
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
    expect(mocks.clerkUpdateOrganization).not.toHaveBeenCalled();
  });

  it("returns 404 when the organization is not found during slug update", async () => {
    mocks.organizationsService.findById.mockResolvedValue(null);

    const response = await putOrganization({ slug: "new-acme" });

    expect(response.status).toBe(404);
    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  it("returns 403 for cross-organization updates before service calls", async () => {
    const response = await putOrganization({ slug: "new-acme" }, "other-org");

    expect(response.status).toBe(403);
    expect(mocks.organizationsService.findById).not.toHaveBeenCalled();
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  it("returns 403 for changed slugs when the user is not an admin", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);

    const response = await putOrganization({ slug: "new-acme" });

    expect(response.status).toBe(403);
    expect(mocks.organizationsService.findBySlug).not.toHaveBeenCalled();
    expect(mocks.clerkUpdateOrganization).not.toHaveBeenCalled();
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  it("returns 409 when another organization already owns the slug", async () => {
    mocks.organizationsService.findBySlug.mockResolvedValue({
      ...BASE_ORGANIZATION,
      id: "org-2",
      slug: "new-acme",
    });

    const response = await putOrganization({ slug: "new-acme" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("Slug is unavailable");
    expect(mocks.clerkUpdateOrganization).not.toHaveBeenCalled();
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  it("strips same-slug and still updates other fields, syncing name to Clerk", async () => {
    const response = await putOrganization({
      name: "Updated Acme",
      settings: { theme: "dark" },
      slug: "acme",
    });

    expect(response.status).toBe(200);
    expect(mocks.organizationsService.update).toHaveBeenCalledWith(ORG_ID, {
      name: "Updated Acme",
      settings: { theme: "dark" },
    });
    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
    expect(mocks.clerkUpdateOrganization).toHaveBeenCalledWith("clerk-org-1", {
      name: "Updated Acme",
    });
  });

  it("logs but does not fail when Clerk name sync fails on same-slug update", async () => {
    mocks.clerkUpdateOrganization.mockRejectedValueOnce(
      new Error("Clerk unavailable")
    );

    const response = await putOrganization({
      name: "Updated Acme",
      slug: "acme",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.logError).toHaveBeenCalledWith(
      "org_name_clerk_sync_failed",
      expect.objectContaining({ organizationId: ORG_ID })
    );
  });

  it("skips Clerk sync for settings-only same-slug updates", async () => {
    mocks.organizationsService.update.mockResolvedValue({
      ...BASE_ORGANIZATION,
      settings: { theme: "dark" },
    });

    const response = await putOrganization({
      settings: { theme: "dark" },
      slug: "acme",
    });

    expect(response.status).toBe(200);
    expect(mocks.clerkUpdateOrganization).not.toHaveBeenCalled();
  });

  it("preserves unchanged legacy slugs before changed-slug validation", async () => {
    const legacyOrganization = {
      ...BASE_ORGANIZATION,
      slug: "org_legacy_clerk_id",
    };
    mocks.organizationsService.findById.mockResolvedValue(legacyOrganization);

    const response = await putOrganization({
      name: "Updated Acme",
      slug: "org_legacy_clerk_id",
    });

    expect(response.status).toBe(200);
    expect(mocks.organizationsService.update).toHaveBeenCalledWith(ORG_ID, {
      name: "Updated Acme",
    });
    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
    expect(mocks.clerkUpdateOrganization).toHaveBeenCalledWith("clerk-org-1", {
      name: "Updated Acme",
    });
  });

  it("returns the current organization for same-slug-only payloads", async () => {
    const response = await putOrganization({ slug: "acme" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ id: ORG_ID, slug: "acme" });
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
    expect(mocks.clerkUpdateOrganization).not.toHaveBeenCalled();
  });

  it("returns 409 when Clerk rejects the slug with a 403 status", async () => {
    const clerkError = Object.assign(new Error("Forbidden"), {
      status: 403,
      errors: [{ code: "slug_taken", message: "Slug is reserved" }],
    });
    mocks.clerkUpdateOrganization.mockRejectedValue(clerkError);

    const response = await putOrganization({ slug: "new-acme" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("Slug is unavailable");
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(
      "org_slug_clerk_update_failed",
      expect.objectContaining({
        clerkOrgId: "clerk-org-1",
        clerkStatus: 403,
        slug: "new-acme",
      })
    );
  });

  it("does not touch the DB when Clerk fails with a non-API error", async () => {
    mocks.clerkUpdateOrganization.mockRejectedValue(new Error("clerk down"));

    const response = await putOrganization({ slug: "new-acme" });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to update organization");
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(
      "org_slug_clerk_update_failed",
      expect.objectContaining({
        clerkOrgId: "clerk-org-1",
        slug: "new-acme",
      })
    );
  });

  it("updates Clerk before the local database on successful changed slugs", async () => {
    mocks.organizationsService.update.mockResolvedValue({
      ...BASE_ORGANIZATION,
      slug: "new-acme",
    });

    const response = await putOrganization({ slug: "new-acme" });

    expect(response.status).toBe(200);
    expect(mocks.clerkUpdateOrganization).toHaveBeenCalledWith("clerk-org-1", {
      slug: "new-acme",
    });
    expect(mocks.organizationsService.update).toHaveBeenCalledWith(ORG_ID, {
      slug: "new-acme",
    });
    expect(
      mocks.clerkUpdateOrganization.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.organizationsService.update.mock.invocationCallOrder[0]
    );
  });

  it("includes name in Clerk update when both slug and name change", async () => {
    mocks.organizationsService.update.mockResolvedValue({
      ...BASE_ORGANIZATION,
      slug: "new-acme",
      name: "New Name",
    });

    const response = await putOrganization({
      slug: "new-acme",
      name: "New Name",
    });

    expect(response.status).toBe(200);
    expect(mocks.clerkUpdateOrganization).toHaveBeenCalledWith("clerk-org-1", {
      slug: "new-acme",
      name: "New Name",
    });
  });

  it("triggers Clerk rollback when the local slug write fails", async () => {
    const { waitUntil } = await import("@vercel/functions");
    mocks.organizationsService.update.mockRejectedValue(
      new Error("database down")
    );

    const response = await putOrganization({ slug: "new-acme" });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to update organization");
    expect(mocks.clerkUpdateOrganization).toHaveBeenCalledWith("clerk-org-1", {
      slug: "new-acme",
    });
    expect(waitUntil).toHaveBeenCalled();
  });

  it.each([
    { target: "Organization_slug_key" },
    { target: ["slug"] },
  ])("maps Prisma slug conflicts for target $target", async ({ target }) => {
    const { waitUntil } = await import("@vercel/functions");
    mocks.organizationsService.update.mockRejectedValue({
      code: "P2002",
      meta: { target },
    });

    const response = await putOrganization({ slug: "new-acme" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("Slug is unavailable");
    expect(mocks.clerkUpdateOrganization).toHaveBeenCalledWith("clerk-org-1", {
      slug: "new-acme",
    });
    expect(waitUntil).toHaveBeenCalled();
  });

  it("does not map unrelated Prisma conflicts to slug unavailable", async () => {
    mocks.organizationsService.update.mockRejectedValue({
      code: "P2002",
      meta: { target: "Other_key" },
    });

    const response = await putOrganization({ slug: "new-acme" });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to update organization");
  });
});

function putOrganization(body: unknown, id = ORG_ID) {
  return PUT(
    new NextRequest(`https://api.example.test/organizations/${id}`, {
      body: JSON.stringify(body),
      method: "PUT",
    }),
    { params: Promise.resolve({ id }) }
  );
}
