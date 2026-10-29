/**
 * Endpoint tests for POST /desktop/onboarding-attempt.
 *
 * Covers the exact request/response contract, session gating, origin checks,
 * and persistence failures required by PLN-319 v8.
 */
import { DesktopProvisioningPlatform } from "@repo/api/src/types/electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  stubTrustedOriginEnv,
  TRUSTED_APP_ORIGIN,
  TRUSTED_WEB_ORIGIN,
  UNTRUSTED_ORIGIN,
} from "@/__tests__/utils/trusted-origin.test-helpers";
import { POST } from "@/app/desktop/onboarding-attempt/route";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { resolveSessionUser } from "@/lib/auth/session-user";
import {
  createMockRequest,
  createTestAuthContext,
} from "../utils/auth-helpers";

vi.mock("@/app/desktop/onboarding-attempt/service");
vi.mock("@/lib/auth/session-user");

describe("POST /desktop/onboarding-attempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubTrustedOriginEnv();
    vi.mocked(resolveSessionUser).mockResolvedValue({
      user: createTestAuthContext().user,
      clerkUserId: "clerk_test_user",
      clerkOrgId: "org_test",
    });
    vi.mocked(desktopOnboardingAttemptsService.create).mockResolvedValue({
      onboardingAttemptId: "attempt-123",
      expiresAt: new Date("2026-04-23T18:00:00.000Z"),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the exact onboarding attempt contract on success", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "https://api.closedloop.ai/desktop/onboarding-attempt",
      headers: { origin: TRUSTED_APP_ORIGIN },
      body: {
        platform: DesktopProvisioningPlatform.Darwin,
        webAppOrigin: TRUSTED_APP_ORIGIN,
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      onboardingAttemptId: "attempt-123",
      expiresAt: "2026-04-23T18:00:00.000Z",
    });
    expect(desktopOnboardingAttemptsService.create).toHaveBeenCalledWith({
      organizationId: "test-org-id",
      userId: "test-user-id",
      webAppOrigin: TRUSTED_APP_ORIGIN,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the previous request shape compatible when platform is omitted", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "https://api.closedloop.ai/desktop/onboarding-attempt",
      headers: { origin: TRUSTED_APP_ORIGIN },
      body: { webAppOrigin: TRUSTED_APP_ORIGIN },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      onboardingAttemptId: "attempt-123",
      expiresAt: "2026-04-23T18:00:00.000Z",
    });
    expect(desktopOnboardingAttemptsService.create).toHaveBeenCalledWith({
      organizationId: "test-org-id",
      userId: "test-user-id",
      webAppOrigin: TRUSTED_APP_ORIGIN,
    });
  });

  it("returns 401 when no browser session is present", async () => {
    vi.mocked(resolveSessionUser).mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: TRUSTED_APP_ORIGIN,
        },
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "SESSION_REQUIRED",
      retryable: false,
    });
  });

  it("returns the exact 503 contract when session resolution throws", async () => {
    vi.mocked(resolveSessionUser).mockRejectedValue(
      new Error("clerk unavailable")
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: TRUSTED_APP_ORIGIN,
        },
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "ONBOARDING_ATTEMPT_PERSIST_FAILED",
      retryable: true,
    });
  });

  it("returns 400 for malformed request bodies", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: TRUSTED_APP_ORIGIN },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: TRUSTED_APP_ORIGIN,
          extraField: true,
        },
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_ONBOARDING_ATTEMPT_REQUEST",
      retryable: false,
    });
  });

  it("returns 403 without persisting when the request origin mismatches webAppOrigin", async () => {
    // Both origins are allowlisted, so only the mismatch branch can 403 here.
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: TRUSTED_WEB_ORIGIN },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: TRUSTED_APP_ORIGIN,
        },
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "ONBOARDING_ATTEMPT_FORBIDDEN",
      retryable: false,
    });
    expect(desktopOnboardingAttemptsService.create).not.toHaveBeenCalled();
  });

  it("returns 403 without persisting a self-consistent non-allowlisted origin", async () => {
    // The Origin header and webAppOrigin are identical, so the mismatch branch
    // cannot fire: only the allowlist can reject this. Drop the
    // canonicalizeTrustedOrigin calls from the route and this returns 200 and
    // persists `https://evil.example.com` as the attempt's redirect origin.
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: UNTRUSTED_ORIGIN },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: UNTRUSTED_ORIGIN,
        },
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "ONBOARDING_ATTEMPT_FORBIDDEN",
      retryable: false,
    });
    expect(desktopOnboardingAttemptsService.create).not.toHaveBeenCalled();
  });

  it("ignores optional platform on the legacy onboarding-attempt contract", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: TRUSTED_APP_ORIGIN },
        body: {
          platform: DesktopProvisioningPlatform.Linux,
          webAppOrigin: TRUSTED_APP_ORIGIN,
        },
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      onboardingAttemptId: "attempt-123",
      expiresAt: "2026-04-23T18:00:00.000Z",
    });
    expect(desktopOnboardingAttemptsService.create).toHaveBeenCalledWith({
      organizationId: "test-org-id",
      userId: "test-user-id",
      webAppOrigin: TRUSTED_APP_ORIGIN,
    });
  });

  it("returns 503 when attempt persistence fails", async () => {
    vi.mocked(desktopOnboardingAttemptsService.create).mockRejectedValue(
      new Error("db unavailable")
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: TRUSTED_APP_ORIGIN },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: TRUSTED_APP_ORIGIN,
        },
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "ONBOARDING_ATTEMPT_PERSIST_FAILED",
      retryable: true,
    });
  });
});
