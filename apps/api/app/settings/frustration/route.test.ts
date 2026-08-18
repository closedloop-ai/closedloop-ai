import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  getOrgAdminStatus: vi.fn(),
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

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: mocks.logWarn,
    error: vi.fn(),
    info: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../frustration-setting-service", () => ({
  frustrationSettingService: mocks.frustrationSettingService,
}));

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
    mocks.getOrgAdminStatus.mockReset();
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
});

describe("PUT /settings/frustration", () => {
  beforeEach(() => {
    mocks.getOrgAdminStatus.mockReset();
    mocks.frustrationSettingService.setFrustrationEnabled.mockReset();
  });

  it("returns 403 and never writes the setting for a non-admin", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: "not_admin",
    });

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
    mocks.getOrgAdminStatus.mockResolvedValue({ isAdmin: true });
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

  it("rejects a non-boolean body with 400 without writing", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue({ isAdmin: true });

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
