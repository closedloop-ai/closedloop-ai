import {
  ORGANIZATION_MEMBERS_OFFSET_MAX,
  ORGANIZATION_MEMBERS_PAGE_LIMIT_DEFAULT,
  ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX,
  OrganizationMembersErrorCode,
  OrganizationMembersSource,
} from "@repo/api/src/types/organization-members";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    authMethod: "session",
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: { id: "user-1", clerkId: "clerk-user-1", organizationId: "org-1" },
  },
  isSeededVibeEnvironmentRuntime: vi.fn(),
  listOrganizationMemberships: vi.fn(),
  listSeededRoster: vi.fn(),
  logWarn: vi.fn(),
  requireSettingsCommand: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@/lib/auth/settings-command", () => ({
  requireSettingsCommand: mocks.requireSettingsCommand,
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    listOrganizationMemberships: mocks.listOrganizationMemberships,
  },
  isClerkNotFound: (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404,
}));

vi.mock("@/lib/seeded-vibe-environment", () => ({
  isSeededVibeEnvironmentRuntime: mocks.isSeededVibeEnvironmentRuntime,
}));

vi.mock("@/lib/auth/seeded-roster", () => ({
  listSeededRoster: mocks.listSeededRoster,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    warn: mocks.logWarn,
    info: vi.fn(),
    flush: vi.fn(async () => undefined),
  },
}));

import { GET } from "./route";

const CLERK_ORG_ID = "clerk-org-1";
/**
 * A Clerk org that is NOT the authenticated caller's. Supplied as a request
 * value so a test can tell WHICH org the code read: a route that honored it
 * would reach Clerk with this id. The sibling invitations POST suite uses the
 * same split for the same reason.
 */
const FOREIGN_CLERK_ORG_ID = "clerk-org-2";
const CREATED_MS = 1_788_460_403_425;
const UPDATED_MS = 1_788_470_403_425;

function listRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/organizations/members${query}`);
}

function call(query = "") {
  return GET(listRequest(query), { params: Promise.resolve({}) });
}

function membership(overrides: Record<string, unknown> = {}) {
  return {
    id: "orgmem_1",
    userId: "user_1",
    role: "org:admin",
    identifier: "member@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    imageUrl: "https://img.clerk.com/ada",
    createdAt: CREATED_MS,
    updatedAt: UPDATED_MS,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSeededVibeEnvironmentRuntime.mockResolvedValue(false);
  mocks.listOrganizationMemberships.mockResolvedValue({
    data: [],
    totalCount: 0,
  });
});

describe("GET /organizations/members", () => {
  it("returns the roster with the provider's population count", async () => {
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [membership()],
      totalCount: 1,
    });

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      members: [
        {
          userId: "user_1",
          identifier: "member@example.com",
          firstName: "Ada",
          lastName: "Lovelace",
          imageUrl: "https://img.clerk.com/ada",
          role: "org:admin",
          createdAt: new Date(CREATED_MS).toISOString(),
        },
      ],
      total: 1,
      hasMore: false,
      source: OrganizationMembersSource.Clerk,
    });
  });

  it("reads without an admin gate, because Members is readable by every role", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(mocks.requireSettingsCommand).not.toHaveBeenCalled();
  });

  it("passes the authenticated org to Clerk, never a request value", async () => {
    await call();

    expect(mocks.listOrganizationMemberships).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: CLERK_ORG_ID })
    );
  });

  it("refuses a caller-supplied organization rather than silently ignoring it", async () => {
    const response = await call(`?organizationId=${FOREIGN_CLERK_ORG_ID}`);

    expect(response.status).toBe(400);
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
  });

  it("keeps a custom Clerk role verbatim instead of dropping or coercing the row", async () => {
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [membership({ role: "org:billing_manager" })],
      totalCount: 1,
    });

    const body = await (await call()).json();

    expect(body.data.members).toHaveLength(1);
    expect(body.data.members[0].role).toBe("org:billing_manager");
  });

  it("keeps the rest of the page when one member's timestamp is unreadable", async () => {
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [
        membership({ id: "orgmem_bad", createdAt: Number.NaN }),
        membership({ id: "orgmem_2", userId: "user_2" }),
      ],
      totalCount: 2,
    });

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.members).toHaveLength(2);
    expect(body.data.members[0]).toMatchObject({
      createdAt: null,
      userId: "user_1",
      identifier: "member@example.com",
    });
    expect(body.data.members[1].createdAt).toBe(
      new Date(CREATED_MS).toISOString()
    );
  });

  it("reports the unreadable timestamps once for the page, naming the rows", async () => {
    // One line per PAGE, not per row: any authenticated member can request a
    // full page, so a per-row log would be an amplification vector.
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [
        membership({ id: "orgmem_bad", createdAt: Number.NaN }),
        membership({ id: "orgmem_worse", createdAt: Number.NaN }),
        membership({ id: "orgmem_ok" }),
      ],
      totalCount: 3,
    });

    await call();

    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        clerkOrgId: CLERK_ORG_ID,
        affectedRows: 2,
        rowIds: ["orgmem_bad", "orgmem_worse"],
      })
    );
  });

  it("stays silent when every timestamp on the page is readable", async () => {
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [membership()],
      totalCount: 1,
    });

    await call();

    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("reports a member with no provider identity as nulls, not placeholders", async () => {
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [
        membership({
          userId: null,
          identifier: null,
          firstName: null,
          lastName: null,
          imageUrl: null,
        }),
      ],
      totalCount: 1,
    });

    const body = await (await call()).json();

    expect(body.data.members[0]).toMatchObject({
      userId: null,
      identifier: null,
      firstName: null,
      lastName: null,
      imageUrl: null,
    });
  });
});

describe("GET /organizations/members — page bounds", () => {
  // Clerk answers an out-of-range limit with 200 and its own default page
  // rather than an error, so these pin the clamp itself: without it the caller
  // receives a short page that reads as the complete roster.
  it.each([
    ["?limit=0", 1],
    ["?limit=-1", 1],
    [
      `?limit=${ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX + 1}`,
      ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX,
    ],
    ["?limit=1.9", 1],
    ["", ORGANIZATION_MEMBERS_PAGE_LIMIT_DEFAULT],
  ])("clamps %s to limit %i at the provider", async (query, expected) => {
    await call(query);

    expect(mocks.listOrganizationMemberships).toHaveBeenCalledWith(
      expect.objectContaining({ limit: expected })
    );
  });

  it.each([
    ["?offset=-5", 0],
    [
      `?offset=${ORGANIZATION_MEMBERS_OFFSET_MAX}`,
      ORGANIZATION_MEMBERS_OFFSET_MAX,
    ],
    ["", 0],
  ])("clamps %s to offset %i at the provider", async (query, expected) => {
    await call(query);

    expect(mocks.listOrganizationMemberships).toHaveBeenCalledWith(
      expect.objectContaining({ offset: expected })
    );
  });

  // Rejected, NOT clamped. A clamped offset aliases every page past the
  // ceiling onto the ceiling's own page, which still reports `hasMore: true`
  // and echoes no offset the client could check — so a paging client loops on
  // it forever. The limit above clamps because the largest legal page is a
  // truthful answer; there is no page here to be truthful about.
  it("rejects an offset past the ceiling rather than aliasing it onto the last page", async () => {
    const response = await call(
      `?offset=${ORGANIZATION_MEMBERS_OFFSET_MAX + 1}`
    );

    expect(response.status).toBe(400);
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
  });

  it("rejects a blank bound rather than reading it as zero", async () => {
    const response = await call("?limit=");

    expect(response.status).toBe(400);
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric bound", async () => {
    const response = await call("?limit=twenty");

    expect(response.status).toBe(400);
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
  });

  it("reports hasMore when the population exceeds this page", async () => {
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [membership(), membership({ id: "orgmem_2", userId: "user_2" })],
      totalCount: 7,
    });

    const body = await (await call("?limit=2")).json();

    expect(body.data).toMatchObject({ total: 7, hasMore: true });
  });

  it("reports hasMore false on the last page, where offset plus rows meets the total", async () => {
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [membership()],
      totalCount: 7,
    });

    const body = await (await call("?limit=2&offset=6")).json();

    expect(body.data).toMatchObject({ total: 7, hasMore: false });
  });
});

describe("GET /organizations/members — provider failures", () => {
  it("answers an unreachable provider with 503, never an empty roster", async () => {
    mocks.listOrganizationMemberships.mockRejectedValue(
      new Error("clerk unreachable")
    );

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe(OrganizationMembersErrorCode.ProviderUnavailable);
    expect(body.data).toBeUndefined();
  });

  it("answers a provider 404 with 404", async () => {
    mocks.listOrganizationMemberships.mockRejectedValue({ status: 404 });

    const response = await call();

    expect(response.status).toBe(404);
  });
});

// ISS-12135: a seeded vibe preview binds a real Clerk organization, so its
// roster is read from the seeded rows instead of from Clerk.
describe("GET /organizations/members on a seeded vibe preview", () => {
  const SEEDED = [
    membership({ id: "orgmem_a", userId: "user_maya", role: "org:owner" }),
    membership({ id: "orgmem_b", userId: "clerk-user-1", role: "org:admin" }),
    membership({ id: "orgmem_c", userId: "user_daveth", role: "org:member" }),
  ];

  beforeEach(() => {
    mocks.isSeededVibeEnvironmentRuntime.mockResolvedValue(true);
    mocks.listSeededRoster.mockResolvedValue(SEEDED);
  });

  it("answers from the seeded rows of the caller's org and never asks Clerk", async () => {
    const response = await call("?limit=2&offset=1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.listSeededRoster).toHaveBeenCalledWith({
      clerkOrgId: CLERK_ORG_ID,
    });
    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(
      body.data.members.map((m: { userId: string; role: string }) => [
        m.userId,
        m.role,
      ])
    ).toEqual([
      ["clerk-user-1", "org:admin"],
      ["user_daveth", "org:member"],
    ]);
    expect(body.data.total).toBe(3);
    expect(body.data.hasMore).toBe(false);
    expect(body.data.source).toBe(OrganizationMembersSource.Seeded);
  });

  it("reports a further page against the seeded population", async () => {
    const body = await (await call("?limit=1&offset=0")).json();

    expect(body.data.members).toHaveLength(1);
    expect(body.data.hasMore).toBe(true);
  });

  it("does not report a failed seeded read as a provider outage", async () => {
    mocks.listSeededRoster.mockRejectedValue(new Error("db down"));

    await expect(call()).rejects.toThrow("db down");
  });

  it("asks Clerk, and never reads the seeded rows, anywhere else", async () => {
    mocks.isSeededVibeEnvironmentRuntime.mockResolvedValue(false);

    const body = await (await call()).json();

    expect(mocks.listSeededRoster).not.toHaveBeenCalled();
    expect(mocks.listOrganizationMemberships).toHaveBeenCalled();
    expect(body.data.source).toBe(OrganizationMembersSource.Clerk);
  });
});

// ISS-12135: the Members panel decides what to mount from the `source` on a
// one-row page, a request every API version accepts.
describe("GET /organizations/members?limit=1", () => {
  it("makes at most one Clerk call, for one row, and answers clerk off a seeded preview", async () => {
    mocks.listOrganizationMemberships.mockResolvedValue({
      data: [membership()],
      totalCount: 3,
    });

    const body = await (await call("?limit=1")).json();

    expect(mocks.listOrganizationMemberships).toHaveBeenCalledTimes(1);
    expect(mocks.listOrganizationMemberships).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1, offset: 0 })
    );
    expect(mocks.listSeededRoster).not.toHaveBeenCalled();
    expect(body.data.members).toHaveLength(1);
    expect(body.data.source).toBe(OrganizationMembersSource.Clerk);
  });

  it("calls Clerk not at all and answers seeded on a seeded vibe preview", async () => {
    mocks.isSeededVibeEnvironmentRuntime.mockResolvedValue(true);
    mocks.listSeededRoster.mockResolvedValue([
      membership({ id: "orgmem_a", userId: "user_maya", role: "org:owner" }),
      membership({ id: "orgmem_b", userId: "clerk-user-1", role: "org:admin" }),
    ]);

    const body = await (await call("?limit=1")).json();

    expect(mocks.listOrganizationMemberships).not.toHaveBeenCalled();
    expect(body.data.members).toHaveLength(1);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.source).toBe(OrganizationMembersSource.Seeded);
  });
});
