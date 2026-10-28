import { issueDesktopBootstrapToken } from "@repo/auth/desktop-bootstrap-jwt";
import {
  issueDesktopAccessToken,
  verifyDesktopAccessToken,
} from "@repo/auth/desktop-session-jwt";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapTestDb } from "@/__tests__/support/desktop/bootstrap.test-db";
import { bootstrapMintInput } from "@/__tests__/support/desktop/bootstrap-credentials";

vi.mock("server-only", () => ({}));
vi.mock("@repo/database", async () => {
  const { bootstrapTestDb: state } = await import(
    "@/__tests__/support/desktop/bootstrap.test-db"
  );
  return { withDb: state.withDb };
});
const clerk = vi.hoisted(() => ({
  createOrganization: vi.fn(),
  getOrganization: vi.fn(),
  findUserOrganizationBySlug: vi.fn(),
  userHasOrganization: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("@/lib/auth/clerk-service", () => ({ clerkService: clerk }));
vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(async () => ({ userId: null, orgId: null })),
}));
vi.mock("@/app/custom-fields/people-display-refresh", () => ({
  refreshPeopleDisplayValuesForUser: vi.fn(),
}));
vi.mock("@/app/desktop/onboarding-attempt/service", () => ({
  desktopOnboardingAttemptsService: {},
}));
vi.mock("./logo-service", () => ({ desktopBootstrapLogoService: {} }));
const identity = vi.hoisted(() => vi.fn());
vi.mock("@/app/desktop/identity/service", () => ({
  desktopIdentityService: { get: identity },
}));

import { GET as identityRoute } from "@/app/desktop/identity/route";
import { POST } from "./route";

describe("organization bootstrap route through real materialization and session issuance", () => {
  beforeEach(() => {
    bootstrapTestDb.reset();
    vi.stubEnv(
      "DESKTOP_SESSION_JWT_SECRET",
      "bootstrap-test-secret-at-least-thirty-two-bytes"
    );
    clerk.userHasOrganization.mockResolvedValue(false);
    clerk.findUserOrganizationBySlug.mockResolvedValue(null);
    clerk.createOrganization.mockResolvedValue({
      id: "org_new",
      name: "New Organization",
      slug: "new-organization",
    });
    clerk.getOrganization.mockResolvedValue({
      id: "org_new",
      name: "New Organization",
      slug: "new-organization",
    });
    clerk.getUser.mockResolvedValue({
      email: "orgless@example.test",
      firstName: "New",
      lastName: "User",
      imageUrl: null,
      phoneNumber: null,
    });
    identity.mockResolvedValue({ userId: "user-1" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("materializes a user in the newly created organization and binds real session tokens to it", async () => {
    const response = await create(await credential());
    expect(response.status).toBe(200);
    const tokens = await response.json();
    const organization = bootstrapTestDb.tables.organization[0];
    const user = bootstrapTestDb.tables.user[0];
    expect(organization).toMatchObject({ clerkId: "org_new" });
    expect(user).toMatchObject({
      clerkId: "user_clerk",
      organizationId: organization.id,
    });
    expect(await verifyDesktopAccessToken(tokens.accessToken)).toMatchObject({
      organizationId: organization.id,
      userId: user.id,
    });
    expect(bootstrapTestDb.tables.desktopSession).toEqual([
      expect.objectContaining({
        userId: user.id,
        organizationId: organization.id,
      }),
    ]);
    expect(bootstrapTestDb.tables.desktopRefreshToken).toHaveLength(1);
  });

  it("does not reuse a same-Clerk-user row belonging to another organization", async () => {
    bootstrapTestDb.tables.organization.push({
      id: "foreign-org",
      clerkId: "org_foreign",
    });
    bootstrapTestDb.tables.user.push({
      id: "foreign-user",
      clerkId: "user_clerk",
      organizationId: "foreign-org",
      active: true,
    });
    const foreignUser = structuredClone(bootstrapTestDb.tables.user[0]);
    const response = await create(await credential());
    expect(response.status).toBe(200);
    const tokens = await response.json();
    expect(tokens.userId).not.toBe("foreign-user");
    expect(tokens.organizationId).not.toBe("foreign-org");
    expect(bootstrapTestDb.tables.user[0]).toEqual(foreignUser);
    expect(bootstrapTestDb.tables.user).toHaveLength(2);
    expect(bootstrapTestDb.tables.user[1].organizationId).toBe(
      tokens.organizationId
    );
    expect(await verifyDesktopAccessToken(tokens.accessToken)).toMatchObject({
      userId: bootstrapTestDb.tables.user[1].id,
      organizationId: tokens.organizationId,
    });
  });

  it("rejects both sequential and concurrent replay using persisted consumption state", async () => {
    const token = await credential();
    const responses = await Promise.all([create(token), create(token)]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect((await create(token)).status).toBe(409);
    expect(bootstrapTestDb.tables.organization).toHaveLength(1);
    expect(bootstrapTestDb.tables.user).toHaveLength(1);
    expect(bootstrapTestDb.tables.desktopSession).toHaveLength(1);
    expect(bootstrapTestDb.tables.desktopRefreshToken).toHaveLength(1);
    expect(
      bootstrapTestDb.tables.desktopBootstrapCode[0].completedAt
    ).toBeInstanceOf(Date);
  });

  it("rejects an existing member even if their organization matches the requested slug", async () => {
    clerk.userHasOrganization.mockResolvedValue(true);
    clerk.findUserOrganizationBySlug.mockResolvedValue({
      id: "org_existing",
      slug: "new-organization",
    });
    expect((await create(await credential())).status).toBe(409);
    expect(bootstrapTestDb.tables.organization).toHaveLength(0);
    expect(bootstrapTestDb.tables.desktopSession).toHaveLength(0);
    expect(
      bootstrapTestDb.tables.desktopBootstrapCode[0].consumedAt
    ).toBeNull();
    expect(clerk.createOrganization).not.toHaveBeenCalled();
  });

  it("refuses expired bootstrap credentials without creating rows", async () => {
    await credential();
    const expired = await issueDesktopBootstrapToken({
      bootstrapId: "bootstrap-1",
      clerkUserId: "user_clerk",
      gatewayId: "gateway-1",
      issuedAt: Math.floor(Date.now() / 1000) - 301,
    });
    expect((await create(expired.token)).status).toBe(401);
    expect(bootstrapTestDb.tables.organization).toHaveLength(0);
    expect(bootstrapTestDb.tables.desktopSession).toHaveLength(0);
  });

  it.each([
    { clerkUserId: "other-user" },
    { gatewayId: "other-gateway" },
    { redeemedAt: null },
  ])("rejects row/credential mismatch %j", async (overrides) => {
    const token = await credential();
    Object.assign(bootstrapTestDb.tables.desktopBootstrapCode[0], overrides);
    expect((await create(token)).status).toBe(401);
    expect(bootstrapTestDb.tables.organization).toHaveLength(0);
    expect(bootstrapTestDb.tables.desktopSession).toHaveLength(0);
  });

  it("clears an unprovisioned claim after Clerk create failure and allows a retry", async () => {
    const token = await credential();
    clerk.createOrganization.mockRejectedValueOnce(
      new Error("Clerk unavailable")
    );
    expect((await create(token)).status).toBe(503);
    expect(bootstrapTestDb.tables.desktopBootstrapCode[0]).toMatchObject({
      consumedAt: null,
      organizationClerkId: null,
      completedAt: null,
    });
    expect(bootstrapTestDb.tables.desktopSession).toHaveLength(0);
    expect((await create(token)).status).toBe(200);
    expect(bootstrapTestDb.tables.organization).toHaveLength(1);
    expect(bootstrapTestDb.tables.desktopSession).toHaveLength(1);
  });

  it("rolls back failed materialization and resumes the recorded Clerk organization", async () => {
    const token = await credential();
    bootstrapTestDb.failNextSessionCreate();
    expect((await create(token)).status).toBe(503);
    expect(bootstrapTestDb.tables.desktopBootstrapCode[0]).toMatchObject({
      organizationClerkId: "org_new",
      completedAt: null,
    });
    expect(bootstrapTestDb.tables.organization).toHaveLength(0);
    expect(bootstrapTestDb.tables.user).toHaveLength(0);
    expect((await create(token)).status).toBe(200);
    expect(clerk.createOrganization).toHaveBeenCalledTimes(1);
    expect(bootstrapTestDb.tables.desktopSession).toHaveLength(1);
  });

  it("refuses access tokens at bootstrap and bootstrap tokens at the ordinary authenticated route", async () => {
    const bootstrapToken = await credential();
    const access = await issueDesktopAccessToken({
      userId: "user-1",
      organizationId: "org-1",
      sessionId: "session-1",
      gatewayId: "gateway-1",
    });
    expect((await create(access.token)).status).toBe(401);
    expect((await ordinary(bootstrapToken)).status).toBe(401);
    expect(identity).not.toHaveBeenCalled();
    expect(bootstrapTestDb.tables.desktopSession).toHaveLength(0);
    // Positive control: the same route accepts the real session just issued by bootstrap.
    const created = await create(bootstrapToken);
    expect(created.status).toBe(200);
    const tokens = await created.json();
    expect((await ordinary(tokens.accessToken)).status).toBe(200);
    expect(identity).toHaveBeenCalledWith(tokens.userId, tokens.organizationId);
  });
});

async function credential() {
  await bootstrapTestDb.db.desktopBootstrapCode.create({
    data: {
      id: "bootstrap-1",
      clerkUserId: "user_clerk",
      gatewayId: "gateway-1",
      boundPublicKey: bootstrapMintInput.gatewayPublicKeyPem,
      redeemedAt: new Date(),
    },
    select: { id: true },
  });
  return (
    await issueDesktopBootstrapToken({
      bootstrapId: "bootstrap-1",
      clerkUserId: "user_clerk",
      gatewayId: "gateway-1",
    })
  ).token;
}

function create(token: string) {
  return POST(
    new Request("http://localhost:3002/desktop/organizations/bootstrap", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: "New Organization",
        slug: "new-organization",
      }),
    })
  );
}

function ordinary(token: string) {
  return identityRoute(
    new NextRequest("http://localhost:3002/desktop/identity", {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({}) }
  );
}
