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
    findDetailById: vi.fn(),
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

// ISS-7200 moved the gate onto `getOrgAdminStatus`. Production's `isOrgAdmin`
// IS `getOrgAdminStatus(...).isAdmin`, so this stub mirrors that instead of
// adding a second lever: every `mocks.isOrgAdmin` use below still works.
vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: async (clerkOrgId: string, clerkUserId: string) => {
    const isAdmin = await mocks.isOrgAdmin(clerkOrgId, clerkUserId);
    return isAdmin
      ? { isAdmin: true, reason: "admin" }
      : { isAdmin: false, reason: "not_admin" };
  },
  isOrgAdmin: mocks.isOrgAdmin,
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    flush: vi.fn(async () => undefined),
    info: vi.fn(),
    warn: vi.fn(),
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
const CLERK_ORG_ID = "clerk-org-1";
/**
 * A Clerk org that is NOT the authenticated caller's. Fixtures that use it as
 * the organization ROW's `clerkId` split the two values an admin gate could
 * read apart, so a test can tell which one the decision actually used. A
 * fixture where both are `CLERK_ORG_ID` cannot: it passes whichever source the
 * gate reads.
 */
const FOREIGN_CLERK_ORG_ID = "clerk-org-2";
const BASE_ORGANIZATION = {
  active: true,
  clerkId: CLERK_ORG_ID,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  id: ORG_ID,
  name: "Acme",
  searchIncludeTranscripts: false,
  settings: {},
  slug: "acme",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("PUT /organizations/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authContext.user.organizationId = ORG_ID;
    mocks.organizationsService.findById.mockResolvedValue(BASE_ORGANIZATION);
    mocks.organizationsService.findDetailById.mockResolvedValue(
      BASE_ORGANIZATION
    );
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
    expect(mocks.organizationsService.findDetailById).not.toHaveBeenCalled();
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
    expect(mocks.organizationsService.findDetailById).toHaveBeenCalledWith(
      ORG_ID
    );
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
    expect(mocks.clerkUpdateOrganization).not.toHaveBeenCalled();
  });

  it("returns 404 when the organization is not found during slug update", async () => {
    mocks.organizationsService.findDetailById.mockResolvedValue(null);

    const response = await putOrganization({ slug: "new-acme" });

    expect(response.status).toBe(404);
    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  it("returns 403 for cross-organization updates before service calls", async () => {
    const response = await putOrganization({ slug: "new-acme" }, "other-org");

    expect(response.status).toBe(403);
    expect(mocks.organizationsService.findById).not.toHaveBeenCalled();
    expect(mocks.organizationsService.findDetailById).not.toHaveBeenCalled();
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
    // Consulted because this body carries `settings`, which ISS-7121 made
    // admin-only (operator decision, 2026-08-19). The caller here is an admin,
    // so the same-slug strip and the Clerk name sync this case exists to pin
    // are unaffected. The peer cases whose bodies carry no admin-only field
    // still assert the check is never reached.
    expect(mocks.isOrgAdmin).toHaveBeenCalledWith(
      "clerk-org-1",
      "clerk-user-1"
    );
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
    mocks.organizationsService.findDetailById.mockResolvedValue(
      legacyOrganization
    );

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

  // ISS-8804: the `meta` shapes, not just the target values. adapter-pg — the
  // driver this app actually runs on — populates `driverAdapterError` and
  // leaves `target` UNSET, so before the fix only the legacy rows below could
  // ever pass and the 409 was unreachable in production.
  it.each([
    {
      label: "adapter-pg index name",
      meta: {
        driverAdapterError: {
          cause: { constraint: { index: "organizations_slug_key" } },
        },
      },
    },
    {
      label: "adapter-pg column list",
      meta: {
        driverAdapterError: { cause: { constraint: { fields: ["slug"] } } },
      },
    },
    { label: "legacy meta.target column list", meta: { target: ["slug"] } },
  ])("maps Prisma slug conflicts for $label", async ({ meta }) => {
    const { waitUntil } = await import("@vercel/functions");
    mocks.organizationsService.update.mockRejectedValue({
      code: "P2002",
      meta,
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

  it.each([
    { label: "legacy meta.target", meta: { target: "Other_key" } },
    {
      label: "adapter-pg, a real sibling unique on the same table",
      meta: {
        driverAdapterError: {
          cause: { constraint: { index: "organizations_clerk_id_key" } },
        },
      },
    },
  ])(
    "does not map unrelated Prisma conflicts to slug unavailable ($label)",
    async ({ meta }) => {
      mocks.organizationsService.update.mockRejectedValue({
        code: "P2002",
        meta,
      });

      const response = await putOrganization({ slug: "new-acme" });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe("Failed to update organization");
    }
  );

  it("lets an admin toggle the transcript search gate", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    mocks.organizationsService.update.mockResolvedValue({
      ...BASE_ORGANIZATION,
      searchIncludeTranscripts: true,
    });

    const response = await putOrganization({ searchIncludeTranscripts: true });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mocks.isOrgAdmin).toHaveBeenCalledWith(
      "clerk-org-1",
      "clerk-user-1"
    );
    expect(mocks.organizationsService.update).toHaveBeenCalledWith(ORG_ID, {
      searchIncludeTranscripts: true,
    });
  });

  it("returns 403 when a non-admin tries to toggle the transcript gate", async () => {
    mocks.isOrgAdmin.mockResolvedValue(false);

    const response = await putOrganization({ searchIncludeTranscripts: true });

    expect(response.status).toBe(403);
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  it("returns 404 when toggling the transcript gate on an unknown org", async () => {
    mocks.isOrgAdmin.mockResolvedValue(true);
    mocks.organizationsService.findById.mockResolvedValue(null);

    const response = await putOrganization({ searchIncludeTranscripts: false });

    expect(response.status).toBe(404);
    expect(mocks.isOrgAdmin).not.toHaveBeenCalled();
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  describe("when the organization row's clerkId is not the caller's org", () => {
    const foreignOrganization = {
      ...BASE_ORGANIZATION,
      clerkId: FOREIGN_CLERK_ORG_ID,
    };

    beforeEach(() => {
      mocks.organizationsService.findById.mockResolvedValue(
        foreignOrganization
      );
      mocks.organizationsService.findDetailById.mockResolvedValue(
        foreignOrganization
      );
    });

    // Admin of the row's org, member of their own. Reading the row's clerkId
    // admits; reading the authenticated context denies.
    function admitOnlyTheForeignOrg() {
      mocks.isOrgAdmin.mockImplementation((clerkOrgId: string) =>
        Promise.resolve(clerkOrgId === FOREIGN_CLERK_ORG_ID)
      );
    }

    it("denies a privacy-toggle write when only the row's org admits", async () => {
      admitOnlyTheForeignOrg();

      const response = await putOrganization({
        searchIncludeTranscripts: true,
      });

      expect(response.status).toBe(403);
      expect(mocks.organizationsService.update).not.toHaveBeenCalled();
    });

    it("denies a slug change when only the row's org admits", async () => {
      admitOnlyTheForeignOrg();

      const response = await putOrganization({ slug: "new-acme" });

      expect(response.status).toBe(403);
      expect(mocks.clerkUpdateOrganization).not.toHaveBeenCalled();
      expect(mocks.organizationsService.update).not.toHaveBeenCalled();
    });

    it("writes the slug to the caller's own Clerk org, never the row's", async () => {
      mocks.isOrgAdmin.mockImplementation((clerkOrgId: string) =>
        Promise.resolve(clerkOrgId === CLERK_ORG_ID)
      );
      mocks.organizationsService.update.mockResolvedValue({
        ...foreignOrganization,
        slug: "new-acme",
      });

      const response = await putOrganization({ slug: "new-acme" });

      expect(response.status).toBe(200);
      expect(mocks.clerkUpdateOrganization).toHaveBeenCalledWith(CLERK_ORG_ID, {
        slug: "new-acme",
      });
    });

    it("syncs a name-only rename to the caller's own Clerk org", async () => {
      mocks.organizationsService.update.mockResolvedValue({
        ...foreignOrganization,
        name: "Updated Acme",
      });

      const response = await putOrganization({ name: "Updated Acme" });

      expect(response.status).toBe(200);
      expect(mocks.clerkUpdateOrganization).toHaveBeenCalledWith(CLERK_ORG_ID, {
        name: "Updated Acme",
      });
    });

    it("syncs an unchanged-slug rename to the caller's own Clerk org", async () => {
      mocks.organizationsService.update.mockResolvedValue({
        ...foreignOrganization,
        name: "Updated Acme",
      });

      const response = await putOrganization({
        name: "Updated Acme",
        slug: "acme",
      });

      expect(response.status).toBe(200);
      expect(mocks.clerkUpdateOrganization).toHaveBeenCalledWith(CLERK_ORG_ID, {
        name: "Updated Acme",
      });
    });

    it("rolls back against the Clerk org it wrote, not the row's", async () => {
      mocks.isOrgAdmin.mockImplementation((clerkOrgId: string) =>
        Promise.resolve(clerkOrgId === CLERK_ORG_ID)
      );
      mocks.organizationsService.update.mockRejectedValue(
        new Error("database down")
      );

      const response = await putOrganization({ slug: "new-acme" });

      expect(response.status).toBe(500);
      expect(mocks.clerkUpdateOrganization).toHaveBeenLastCalledWith(
        CLERK_ORG_ID,
        { slug: "acme" }
      );
    });
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
