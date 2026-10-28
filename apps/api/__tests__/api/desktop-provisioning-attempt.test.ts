import {
  DesktopProvisioningAttemptStatus,
  DesktopProvisioningPlatform,
  DesktopProvisioningReadinessStatus,
} from "@repo/api/src/types/electron";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  stubTrustedOriginEnv,
  TRUSTED_APP_ORIGIN,
  TRUSTED_WEB_ORIGIN,
  UNTRUSTED_ORIGIN,
} from "@/__tests__/utils/trusted-origin.test-helpers";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { GET as GET_STATUS } from "@/app/desktop/provisioning-attempt/[attemptId]/route";
import { POST } from "@/app/desktop/provisioning-attempt/route";
import { GET as GET_READINESS } from "@/app/desktop/provisioning-readiness/route";
import {
  isDesktopManagedPopPlatformSupported,
  isDesktopManagedPopProvisioningEnabled,
} from "@/lib/desktop-managed-pop-provisioning";
import {
  createMockRequest,
  createTestAuthContext,
} from "../utils/auth-helpers";

let authContext = createTestAuthContext();

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(authContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("@/app/desktop/onboarding-attempt/service");
vi.mock("@/lib/desktop-managed-pop-provisioning");

describe("POST /desktop/provisioning-attempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubTrustedOriginEnv();
    authContext = createTestAuthContext();
    vi.mocked(isDesktopManagedPopPlatformSupported).mockImplementation(
      (platform) => platform === DesktopProvisioningPlatform.Darwin
    );
    vi.mocked(isDesktopManagedPopProvisioningEnabled).mockResolvedValue(true);
    vi.mocked(desktopOnboardingAttemptsService.create).mockResolvedValue({
      onboardingAttemptId: "attempt-123",
      expiresAt: new Date("2026-04-27T18:00:00.000Z"),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates an attempt only when the provisioning gate is enabled", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: TRUSTED_APP_ORIGIN },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: TRUSTED_APP_ORIGIN,
        },
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        onboardingAttemptId: "attempt-123",
        expiresAt: "2026-04-27T18:00:00.000Z",
      },
    });
    expect(desktopOnboardingAttemptsService.create).toHaveBeenCalledWith({
      organizationId: authContext.user.organizationId,
      userId: authContext.user.id,
      webAppOrigin: TRUSTED_APP_ORIGIN,
    });
  });

  it("fails closed without persisting when provisioning is disabled", async () => {
    vi.mocked(isDesktopManagedPopProvisioningEnabled).mockResolvedValue(false);

    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: TRUSTED_APP_ORIGIN },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: TRUSTED_APP_ORIGIN,
        },
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(403);
    expect(desktopOnboardingAttemptsService.create).not.toHaveBeenCalled();
  });

  it("fails closed without persisting when the platform is unsupported", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: TRUSTED_APP_ORIGIN },
        body: {
          platform: DesktopProvisioningPlatform.Linux,
          webAppOrigin: TRUSTED_APP_ORIGIN,
        },
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(403);
    expect(desktopOnboardingAttemptsService.create).not.toHaveBeenCalled();
    expect(isDesktopManagedPopProvisioningEnabled).not.toHaveBeenCalled();
  });

  it("rejects browser requests when Origin does not match webAppOrigin", async () => {
    // Both origins are allowlisted, so only the mismatch branch can 403 here.
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: TRUSTED_WEB_ORIGIN },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: TRUSTED_APP_ORIGIN,
        },
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(403);
    expect(desktopOnboardingAttemptsService.create).not.toHaveBeenCalled();
    expect(isDesktopManagedPopProvisioningEnabled).not.toHaveBeenCalled();
  });

  it("rejects browser requests carrying a self-consistent non-allowlisted origin", async () => {
    // Origin header and webAppOrigin are identical, so the mismatch branch
    // cannot fire: only the allowlist can reject this.
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: UNTRUSTED_ORIGIN },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: UNTRUSTED_ORIGIN,
        },
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(403);
    expect(desktopOnboardingAttemptsService.create).not.toHaveBeenCalled();
    expect(isDesktopManagedPopProvisioningEnabled).not.toHaveBeenCalled();
    expect(isDesktopManagedPopPlatformSupported).not.toHaveBeenCalled();
  });

  it("allows authenticated non-browser callers without an Origin header", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: TRUSTED_APP_ORIGIN,
        },
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(desktopOnboardingAttemptsService.create).toHaveBeenCalledWith({
      organizationId: authContext.user.organizationId,
      userId: authContext.user.id,
      webAppOrigin: TRUSTED_APP_ORIGIN,
    });
  });

  it("rejects a non-allowlisted webAppOrigin from a caller sending no Origin header", async () => {
    // The route skips its mismatch comparison entirely when no Origin header is
    // present, so on this path the allowlist is the only thing standing between
    // an attacker-supplied webAppOrigin and persistence. Drop the
    // canonicalizeTrustedOrigin calls and this returns 200 and persists
    // `https://evil.example.com`.
    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: UNTRUSTED_ORIGIN,
        },
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(403);
    expect(desktopOnboardingAttemptsService.create).not.toHaveBeenCalled();
    expect(isDesktopManagedPopProvisioningEnabled).not.toHaveBeenCalled();
    expect(isDesktopManagedPopPlatformSupported).not.toHaveBeenCalled();
  });

  it("uses standard body parsing for malformed JSON", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.closedloop.ai/desktop/provisioning-attempt",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: TRUSTED_APP_ORIGIN,
          },
          body: "{",
        }
      ),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Invalid JSON body",
    });
    expect(desktopOnboardingAttemptsService.create).not.toHaveBeenCalled();
    expect(isDesktopManagedPopProvisioningEnabled).not.toHaveBeenCalled();
  });
});

describe("GET /desktop/provisioning-attempt/:attemptId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authContext = createTestAuthContext();
  });

  it("returns the authenticated user's correlated provisioning status", async () => {
    vi.mocked(desktopOnboardingAttemptsService.getStatus).mockResolvedValue({
      onboardingAttemptId: "attempt-123",
      status: DesktopProvisioningAttemptStatus.Complete,
      expiresAt: "2026-04-27T18:00:00.000Z",
      gatewayId: "gateway-1",
      computeTargetId: "target-1",
    });

    const response = await GET_STATUS(
      createMockRequest({
        method: "GET",
        url: "https://api.closedloop.ai/desktop/provisioning-attempt/attempt-123",
      }),
      { params: Promise.resolve({ attemptId: "attempt-123" }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        onboardingAttemptId: "attempt-123",
        status: DesktopProvisioningAttemptStatus.Complete,
        expiresAt: "2026-04-27T18:00:00.000Z",
        gatewayId: "gateway-1",
        computeTargetId: "target-1",
      },
    });
    expect(desktopOnboardingAttemptsService.getStatus).toHaveBeenCalledWith(
      "attempt-123",
      authContext.user.organizationId,
      authContext.user.id
    );
  });

  it("returns 404 when the attempt is not owned by the authenticated user", async () => {
    vi.mocked(desktopOnboardingAttemptsService.getStatus).mockResolvedValue(
      null
    );

    const response = await GET_STATUS(
      createMockRequest({
        method: "GET",
        url: "https://api.closedloop.ai/desktop/provisioning-attempt/attempt-123",
      }),
      { params: Promise.resolve({ attemptId: "attempt-123" }) }
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 for blank attempt ids", async () => {
    const response = await GET_STATUS(
      createMockRequest({
        method: "GET",
        url: "https://api.closedloop.ai/desktop/provisioning-attempt/%20",
      }),
      { params: Promise.resolve({ attemptId: " " }) }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Invalid attempt ID",
    });
    expect(desktopOnboardingAttemptsService.getStatus).not.toHaveBeenCalled();
  });
});

describe("GET /desktop/provisioning-readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authContext = createTestAuthContext();
  });

  it("returns the authenticated user's existing Desktop readiness", async () => {
    vi.mocked(desktopOnboardingAttemptsService.getReadiness).mockResolvedValue({
      status: DesktopProvisioningReadinessStatus.Complete,
      gatewayId: "gateway-1",
      computeTargetId: "target-1",
    });

    const response = await GET_READINESS(
      createMockRequest({
        method: "GET",
        url: "https://api.closedloop.ai/desktop/provisioning-readiness",
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        status: DesktopProvisioningReadinessStatus.Complete,
        gatewayId: "gateway-1",
        computeTargetId: "target-1",
      },
    });
    expect(desktopOnboardingAttemptsService.getReadiness).toHaveBeenCalledWith(
      authContext.user.organizationId,
      authContext.user.id
    );
  });

  it("returns incomplete when no Desktop-managed target is ready", async () => {
    vi.mocked(desktopOnboardingAttemptsService.getReadiness).mockResolvedValue({
      status: DesktopProvisioningReadinessStatus.Incomplete,
    });

    const response = await GET_READINESS(
      createMockRequest({
        method: "GET",
        url: "https://api.closedloop.ai/desktop/provisioning-readiness",
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { status: DesktopProvisioningReadinessStatus.Incomplete },
    });
  });
});
