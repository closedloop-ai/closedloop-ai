import {
  ORGANIZATION_MEMBERS_OFFSET_MAX,
  ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX,
  OrganizationMembersErrorCode,
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
  listOrganizationInvitations: vi.fn(),
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
  ClerkInvitationStatus: {
    Pending: "pending",
    Accepted: "accepted",
    Revoked: "revoked",
    Expired: "expired",
  },
  clerkService: {
    listOrganizationInvitations: mocks.listOrganizationInvitations,
  },
  isClerkNotFound: (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    flush: vi.fn(async () => undefined),
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("../service", () => ({
  organizationsService: { findById: vi.fn() },
}));

vi.mock("./service", () => ({
  invitationsService: { inviteMembers: vi.fn() },
}));

import { GET } from "./route";

const CLERK_ORG_ID = "clerk-org-1";
/** A Clerk org that is NOT the caller's, supplied as a request value. */
const FOREIGN_CLERK_ORG_ID = "clerk-org-2";
const CREATED_MS = 1_788_460_403_425;
const UPDATED_MS = 1_788_470_403_425;
const EXPIRES_MS = 1_789_065_203_425;

function call(query = "") {
  return GET(
    new NextRequest(`http://localhost/organizations/invitations${query}`),
    { params: Promise.resolve({}) }
  );
}

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "orginv_1",
    emailAddress: "invitee@example.com",
    role: "org:member",
    status: "pending",
    createdAt: CREATED_MS,
    updatedAt: UPDATED_MS,
    expiresAt: EXPIRES_MS,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listOrganizationInvitations.mockResolvedValue({
    data: [],
    totalCount: 0,
  });
});

describe("GET /organizations/invitations", () => {
  it("returns pending invitations with ISO timestamps and the population count", async () => {
    mocks.listOrganizationInvitations.mockResolvedValue({
      data: [invitation()],
      totalCount: 1,
    });

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      invitations: [
        {
          invitationId: "orginv_1",
          emailAddress: "invitee@example.com",
          role: "org:member",
          status: "pending",
          createdAt: new Date(CREATED_MS).toISOString(),
          updatedAt: new Date(UPDATED_MS).toISOString(),
          expiresAt: new Date(EXPIRES_MS).toISOString(),
        },
      ],
      total: 1,
      hasMore: false,
    });
  });

  it("asks the provider only for pending invitations", async () => {
    await call();

    expect(mocks.listOrganizationInvitations).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["pending"] })
    );
  });

  it("omits status when the provider reported none, rather than stamping pending", async () => {
    const { status, ...withoutStatus } = invitation();
    expect(status).toBe("pending");
    mocks.listOrganizationInvitations.mockResolvedValue({
      data: [withoutStatus],
      totalCount: 1,
    });

    const body = await (await call()).json();

    expect(body.data.invitations[0]).not.toHaveProperty("status");
    expect(body.data.invitations[0].invitationId).toBe("orginv_1");
  });

  it("keeps the rest of the page when one invitation's timestamp is unreadable", async () => {
    mocks.listOrganizationInvitations.mockResolvedValue({
      data: [
        invitation({ id: "orginv_bad", expiresAt: Number.NaN }),
        invitation({ id: "orginv_2" }),
      ],
      totalCount: 2,
    });

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.invitations).toHaveLength(2);
    expect(body.data.invitations[0]).toMatchObject({
      expiresAt: null,
      createdAt: new Date(CREATED_MS).toISOString(),
      emailAddress: "invitee@example.com",
    });
    expect(body.data.invitations[1].expiresAt).toBe(
      new Date(EXPIRES_MS).toISOString()
    );
  });

  it("reads without an admin gate, because Members is readable by every role", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(mocks.requireSettingsCommand).not.toHaveBeenCalled();
  });

  it("passes the authenticated org to Clerk, never a request value", async () => {
    await call();

    expect(mocks.listOrganizationInvitations).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: CLERK_ORG_ID })
    );
  });

  it("refuses a caller-supplied organization rather than silently ignoring it", async () => {
    const response = await call(`?organizationId=${FOREIGN_CLERK_ORG_ID}`);

    expect(response.status).toBe(400);
    expect(mocks.listOrganizationInvitations).not.toHaveBeenCalled();
  });

  it("refuses a status filter it does not honor", async () => {
    const response = await call("?status=accepted");

    expect(response.status).toBe(400);
    expect(mocks.listOrganizationInvitations).not.toHaveBeenCalled();
  });
});

describe("GET /organizations/invitations — page bounds", () => {
  // The clamp itself lives in the shared `organizationListQueryValidator` and
  // its full matrix — both ends, fractional, and the default — is pinned by the
  // sibling members suite. What is route-specific, and what these two pin, is
  // that THIS route forwards its parsed bounds to its own provider call.
  it("clamps an over-max limit before it reaches the provider", async () => {
    await call(`?limit=${ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX + 1}`);

    expect(mocks.listOrganizationInvitations).toHaveBeenCalledWith(
      expect.objectContaining({ limit: ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX })
    );
  });

  it("forwards an offset at the ceiling to the provider", async () => {
    await call(`?offset=${ORGANIZATION_MEMBERS_OFFSET_MAX}`);

    expect(mocks.listOrganizationInvitations).toHaveBeenCalledWith(
      expect.objectContaining({ offset: ORGANIZATION_MEMBERS_OFFSET_MAX })
    );
  });

  // Rejected, not clamped — see the sibling members suite for why aliasing a
  // page past the ceiling loops a paging client.
  it("rejects an offset past the ceiling rather than aliasing it onto the last page", async () => {
    const response = await call(
      `?offset=${ORGANIZATION_MEMBERS_OFFSET_MAX + 1}`
    );

    expect(response.status).toBe(400);
    expect(mocks.listOrganizationInvitations).not.toHaveBeenCalled();
  });

  it("reports hasMore when the population exceeds this page", async () => {
    mocks.listOrganizationInvitations.mockResolvedValue({
      data: [invitation(), invitation({ id: "orginv_2" })],
      totalCount: 5,
    });

    const body = await (await call("?limit=2")).json();

    expect(body.data).toMatchObject({ total: 5, hasMore: true });
  });
});

describe("GET /organizations/invitations — provider failures", () => {
  it("answers an unreachable provider with 503, never an empty list", async () => {
    mocks.listOrganizationInvitations.mockRejectedValue(
      new Error("clerk unreachable")
    );

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe(OrganizationMembersErrorCode.ProviderUnavailable);
  });

  it("answers a provider 404 with 404", async () => {
    mocks.listOrganizationInvitations.mockRejectedValue({ status: 404 });

    const response = await call();

    expect(response.status).toBe(404);
  });
});
