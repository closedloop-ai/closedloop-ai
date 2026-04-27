import { DesktopProvisioningPlatform } from "@repo/api/src/types/electron";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { POST } from "@/app/desktop/provisioning-attempt/route";
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
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(authContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("@/app/desktop/onboarding-attempt/service");
vi.mock("@/lib/desktop-managed-pop-provisioning");
vi.mock("@/lib/auth/canonical-trusted-origin", () => ({
  canonicalizeTrustedOrigin: (origin: string) =>
    origin.startsWith("https://") ? origin : null,
}));

describe("POST /desktop/provisioning-attempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("creates an attempt only when the provisioning gate is enabled", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: "https://app.closedloop.ai" },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: "https://app.closedloop.ai",
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
      webAppOrigin: "https://app.closedloop.ai",
    });
  });

  it("fails closed without persisting when provisioning is disabled", async () => {
    vi.mocked(isDesktopManagedPopProvisioningEnabled).mockResolvedValue(false);

    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: "https://app.closedloop.ai" },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: "https://app.closedloop.ai",
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
        headers: { origin: "https://app.closedloop.ai" },
        body: {
          platform: DesktopProvisioningPlatform.Linux,
          webAppOrigin: "https://app.closedloop.ai",
        },
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(403);
    expect(desktopOnboardingAttemptsService.create).not.toHaveBeenCalled();
    expect(isDesktopManagedPopProvisioningEnabled).not.toHaveBeenCalled();
  });

  it("rejects browser requests when Origin does not match webAppOrigin", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: "https://admin.closedloop.ai" },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: "https://app.closedloop.ai",
        },
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(403);
    expect(desktopOnboardingAttemptsService.create).not.toHaveBeenCalled();
    expect(isDesktopManagedPopProvisioningEnabled).not.toHaveBeenCalled();
  });

  it("allows authenticated non-browser callers without an Origin header", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: "https://app.closedloop.ai",
        },
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(desktopOnboardingAttemptsService.create).toHaveBeenCalledWith({
      organizationId: authContext.user.organizationId,
      userId: authContext.user.id,
      webAppOrigin: "https://app.closedloop.ai",
    });
  });

  it("uses standard body parsing for malformed JSON", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.closedloop.ai/desktop/provisioning-attempt",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://app.closedloop.ai",
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
