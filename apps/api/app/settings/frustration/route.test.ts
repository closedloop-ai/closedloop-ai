import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  getOrganizationMembershipRole: vi.fn(),
  frustrationSettingService: {
    isFrustrationEnabled: vi.fn(),
    setFrustrationEnabled: vi.fn(),
  },
  logWarn: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(mocks.authContext, request, context?.params),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: mocks.getOrganizationMembershipRole,
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: mocks.logWarn,
    error: vi.fn(),
    info: vi.fn(),
    flush: vi.fn(async () => undefined),
  },
}));

vi.mock("../frustration-setting-service", () => ({
  frustrationSettingService: mocks.frustrationSettingService,
}));

import { ClerkOrgRoleFixture } from "@/__tests__/utils/auth-helpers";
import { GET, PUT } from "./route";

function putRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/settings/frustration", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("GET /settings/frustration", () => {
  beforeEach(() => {
    mocks.getOrganizationMembershipRole.mockReset();
    mocks.frustrationSettingService.isFrustrationEnabled.mockReset();
    mocks.frustrationSettingService.setFrustrationEnabled.mockReset();
  });

  it("returns the org's current toggle to any authed caller", async () => {
    mocks.frustrationSettingService.isFrustrationEnabled.mockResolvedValue(
      true
    );

    const response = await GET(
      new NextRequest("http://localhost/settings/frustration"),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.calculateSessionFrustration).toBe(true);
    expect(
      mocks.frustrationSettingService.isFrustrationEnabled
    ).toHaveBeenCalledWith("org-1");
  });

  it("returns false when the org has the toggle off", async () => {
    mocks.frustrationSettingService.isFrustrationEnabled.mockResolvedValue(
      false
    );

    const response = await GET(
      new NextRequest("http://localhost/settings/frustration"),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.calculateSessionFrustration).toBe(false);
  });
});

describe("PUT /settings/frustration", () => {
  beforeEach(() => {
    mocks.getOrganizationMembershipRole.mockReset();
    mocks.frustrationSettingService.setFrustrationEnabled.mockReset();
  });

  it("returns 403 and never writes the setting for a non-admin", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );

    const response = await PUT(
      putRequest({ calculateSessionFrustration: true }),
      {
        params: Promise.resolve({}),
      }
    );

    expect(response.status).toBe(403);
    expect(
      mocks.frustrationSettingService.setFrustrationEnabled
    ).not.toHaveBeenCalled();
  });

  it("persists the toggle for an admin", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Admin
    );
    mocks.frustrationSettingService.setFrustrationEnabled.mockResolvedValue(
      undefined
    );

    const response = await PUT(
      putRequest({ calculateSessionFrustration: true }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(
      mocks.frustrationSettingService.setFrustrationEnabled
    ).toHaveBeenCalledWith("org-1", true);
    const json = await response.json();
    expect(json.data.calculateSessionFrustration).toBe(true);
  });

  it("persists a disable for an admin", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Admin
    );
    mocks.frustrationSettingService.setFrustrationEnabled.mockResolvedValue(
      undefined
    );

    const response = await PUT(
      putRequest({ calculateSessionFrustration: false }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(
      mocks.frustrationSettingService.setFrustrationEnabled
    ).toHaveBeenCalledWith("org-1", false);
    const json = await response.json();
    expect(json.data.calculateSessionFrustration).toBe(false);
  });

  it("answers 500 rather than a success body when the write is refused", async () => {
    // ISS-7142 made this service throw for the first time: before it, a write
    // that matched no organization row resolved as success and the route
    // answered 200 for an organization that does not exist, and a write matching
    // MORE than one row (a widened predicate) was not detected at all. Both now
    // reject, so this pins that the new throw becomes a sane HTTP response at
    // the route boundary instead of an unhandled rejection — and, critically,
    // that the response does NOT carry the `calculateSessionFrustration: true`
    // the caller asked for, which would be the UI lying about a persisted value.
    // The rejection value is deliberately a bare Error: the route maps ANY
    // throw from the service through one `errorResponse`, so asserting the
    // guard's exact wording here would pin a string this route never reads.
    // The service-level suites own that message.
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Admin
    );
    mocks.frustrationSettingService.setFrustrationEnabled.mockRejectedValue(
      new Error("settings write was refused")
    );

    const response = await PUT(
      putRequest({ calculateSessionFrustration: true }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.data?.calculateSessionFrustration).toBeUndefined();
  });

  it("rejects a non-boolean body with 400 without writing", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Admin
    );

    const response = await PUT(
      putRequest({ calculateSessionFrustration: "yes" }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(400);
    expect(
      mocks.frustrationSettingService.setFrustrationEnabled
    ).not.toHaveBeenCalled();
  });
});
