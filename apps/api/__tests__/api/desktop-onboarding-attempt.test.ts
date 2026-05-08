/**
 * Endpoint tests for POST /desktop/onboarding-attempt.
 *
 * Covers the exact request/response contract, session gating, origin checks,
 * and persistence failures required by PLN-319 v8.
 */
import { DesktopProvisioningPlatform } from "@repo/api/src/types/electron";
import { vi } from "vitest";
import { POST } from "@/app/desktop/onboarding-attempt/route";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { resolveSessionUser } from "@/lib/auth/session-user";
import {
  createMockRequest,
  createTestAuthContext,
} from "../utils/auth-helpers";

vi.mock("@/app/desktop/onboarding-attempt/service");
vi.mock("@/lib/auth/session-user");
vi.mock("@/lib/auth/canonical-trusted-origin", () => ({
  canonicalizeTrustedOrigin: (origin: string) =>
    origin.startsWith("https://") ? origin : null,
}));

describe("POST /desktop/onboarding-attempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("returns the exact onboarding attempt contract on success", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "https://api.closedloop.ai/desktop/onboarding-attempt",
      headers: { origin: "https://app.closedloop.ai" },
      body: {
        platform: DesktopProvisioningPlatform.Darwin,
        webAppOrigin: "https://app.closedloop.ai",
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
      webAppOrigin: "https://app.closedloop.ai",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the previous request shape compatible when platform is omitted", async () => {
    const request = createMockRequest({
      method: "POST",
      url: "https://api.closedloop.ai/desktop/onboarding-attempt",
      headers: { origin: "https://app.closedloop.ai" },
      body: { webAppOrigin: "https://app.closedloop.ai" },
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
      webAppOrigin: "https://app.closedloop.ai",
    });
  });

  it("returns 401 when no browser session is present", async () => {
    vi.mocked(resolveSessionUser).mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: "https://app.closedloop.ai",
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
          webAppOrigin: "https://app.closedloop.ai",
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
        headers: { origin: "https://app.closedloop.ai" },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: "https://app.closedloop.ai",
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

  it("returns 403 when the submitted origin is not trusted or mismatches the request origin", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: "https://app.closedloop.ai" },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: "https://admin.closedloop.ai",
        },
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "ONBOARDING_ATTEMPT_FORBIDDEN",
      retryable: false,
    });
  });

  it("ignores optional platform on the legacy onboarding-attempt contract", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: "https://app.closedloop.ai" },
        body: {
          platform: DesktopProvisioningPlatform.Linux,
          webAppOrigin: "https://app.closedloop.ai",
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
      webAppOrigin: "https://app.closedloop.ai",
    });
  });

  it("returns 503 when attempt persistence fails", async () => {
    vi.mocked(desktopOnboardingAttemptsService.create).mockRejectedValue(
      new Error("db unavailable")
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        headers: { origin: "https://app.closedloop.ai" },
        body: {
          platform: DesktopProvisioningPlatform.Darwin,
          webAppOrigin: "https://app.closedloop.ai",
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
