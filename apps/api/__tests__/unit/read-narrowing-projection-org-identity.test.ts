import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ORG_ID } = vi.hoisted(() => ({
  ORG_ID: "11111111-1111-4111-8111-111111111111",
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: { getOrganization: vi.fn(), updateOrganization: vi.fn() },
}));

vi.mock("@/lib/auth/org-admin", () => ({
  requireOrgAdmin: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<{ id: string }> }) =>
      handler(
        {
          authMethod: "session",
          clerkOrgId: "org_clerk_1",
          clerkUserId: "user_clerk_1",
          user: {
            id: "user-1",
            clerkId: "user_clerk_1",
            organizationId: ORG_ID,
          },
        },
        request,
        context.params
      ),
}));

import {
  createModelDouble,
  type Row,
} from "@/__tests__/support/read-narrowing-projection.test-db";
import {
  GET as getOrganization,
  PUT as putOrganization,
} from "@/app/organizations/[id]/route";
import { organizationsService } from "@/app/organizations/service";
import { mockWithDbAll } from "../utils/db-helpers";

const IDENTITY_COLUMNS = ["id", "clerkId"];

const PAYLOAD_COLUMNS = [
  "id",
  "clerkId",
  "name",
  "slug",
  "active",
  "settings",
  "searchIncludeTranscripts",
  "createdAt",
  "updatedAt",
];

/**
 * Every column `organizations` has, credential columns included. They carry
 * non-null values on purpose: with `claudeApiKeyEncrypted: null` an ABSENT
 * column and a null one serialize identically and no assertion below could
 * redden on a widened select.
 */
function organizationRow(overrides: Row = {}): Row {
  return {
    id: ORG_ID,
    clerkId: "org_clerk_1",
    active: true,
    name: "Acme",
    slug: "acme",
    claudeApiKeyEncrypted: "enc-claude-key",
    claudeApiKeyLastFour: "9999",
    claudeApiKeySetAt: new Date("2026-01-01T00:00:00.000Z"),
    settings: { theme: "dark" },
    searchIncludeTranscripts: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("organization identity reads on the authenticated path", () => {
  it("resolves an org by id to the two identity columns and nothing else", async () => {
    const organization = createModelDouble([organizationRow()]);
    mockWithDbAll({ organization });

    const result = await organizationsService.findById(ORG_ID);

    // Row-level: every authenticated request runs this lookup, so the object it
    // hands back is the whole reason the encrypted key never enters memory.
    // Exact, so a widened select reddens here as well as on the query shape.
    expect(result).toEqual({ id: ORG_ID, clerkId: "org_clerk_1" });
    expect(organization.returnedColumns).toEqual([IDENTITY_COLUMNS]);
  });

  it("resolves an org by clerk id to the two identity columns and nothing else", async () => {
    const organization = createModelDouble([organizationRow()]);
    mockWithDbAll({ organization });

    const result = await organizationsService.findByClerkId("org_clerk_1");

    expect(result).toEqual({ id: ORG_ID, clerkId: "org_clerk_1" });
    expect(organization.returnedColumns).toEqual([IDENTITY_COLUMNS]);
  });

  it("resolves an org by slug to the two identity columns and nothing else", async () => {
    const organization = createModelDouble([organizationRow()]);
    mockWithDbAll({ organization });

    const result = await organizationsService.findBySlug("acme");

    expect(result).toEqual({ id: ORG_ID, clerkId: "org_clerk_1" });
    expect(organization.returnedColumns).toEqual([IDENTITY_COLUMNS]);
  });

  it("returns null for an unknown org without widening the read", async () => {
    const organization = createModelDouble([organizationRow()]);
    mockWithDbAll({ organization });

    expect(await organizationsService.findBySlug("nonexistent")).toBeNull();
    expect(organization.returnedColumns).toEqual([]);
  });
});

describe("organization payload read", () => {
  it("serves the callers that render an org without reading a credential column", async () => {
    const organization = createModelDouble([organizationRow()]);
    mockWithDbAll({ organization });

    const result = await organizationsService.findDetailById(ORG_ID);

    // The full `Organization` contract survives the narrowing field for field —
    // dropping any one of them from the select reddens here.
    expect(result).toEqual({
      id: ORG_ID,
      clerkId: "org_clerk_1",
      name: "Acme",
      slug: "acme",
      active: true,
      settings: { theme: "dark" },
      searchIncludeTranscripts: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(organization.returnedColumns).toEqual([PAYLOAD_COLUMNS]);
  });

  it("keeps the encrypted Claude key out of the GET /organizations/:id body", async () => {
    const organization = createModelDouble([organizationRow()]);
    mockWithDbAll({ organization });

    const response = await getOrganization(
      new NextRequest(`https://api.test/organizations/${ORG_ID}`),
      { params: Promise.resolve({ id: ORG_ID }) }
    );
    const body = await response.json();

    // This route serializes the service's object straight to the caller, so a
    // column on the row is a field in the response. Asserting the key set —
    // not just the absence of one name — reddens on any re-widening.
    expect(Object.keys(body.data).sort()).toEqual([...PAYLOAD_COLUMNS].sort());
    expect(organization.returnedColumns).toEqual([PAYLOAD_COLUMNS]);
  });

  it("keeps the encrypted Claude key out of the PUT /organizations/:id body", async () => {
    const organization = createModelDouble([organizationRow()]);
    mockWithDbAll({ organization });

    const response = await putOrganization(
      new NextRequest(`https://api.test/organizations/${ORG_ID}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Acme Two" }),
      }),
      { params: Promise.resolve({ id: ORG_ID }) }
    );
    const body = await response.json();

    // The write's RETURNING is the response body on every PUT branch, so the
    // write select needs the same pin the read select has. Dropping
    // `ORGANIZATION_PAYLOAD_SELECT` from `update()` reddens here and nowhere
    // else.
    expect(body.data.name).toBe("Acme Two");
    expect(Object.keys(body.data).sort()).toEqual([...PAYLOAD_COLUMNS].sort());
    expect(organization.returnedColumns).toEqual([PAYLOAD_COLUMNS]);
  });
});
