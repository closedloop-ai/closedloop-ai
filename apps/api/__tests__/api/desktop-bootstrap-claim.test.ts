/**
 * Endpoint tests for POST /desktop/bootstrap/claim.
 *
 * Covers the exact PLN-319 v8 contract, including strict request validation,
 * origin checks, attempt consumption rules, and conflict/failure mapping.
 */
import { vi } from "vitest";
import {
  apiKeysService,
  DesktopManagedKeyRotationConflictError,
} from "@/app/api-keys/service";
import { POST } from "@/app/desktop/bootstrap/claim/route";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { createMockRequest } from "../utils/auth-helpers";

vi.mock("@/app/api-keys/service");
vi.mock("@/app/desktop/onboarding-attempt/service");
vi.mock("@/lib/auth/canonical-trusted-origin", () => ({
  canonicalizeTrustedOrigin: (origin: string) =>
    origin.startsWith("https://") ? origin : null,
}));
vi.mock("@/lib/auth/ed25519-spki-pem", () => ({
  normalizeEd25519SpkiPublicKeyPem: (pem: string) =>
    pem === "valid-pem" ? "normalized-pem" : null,
}));

describe("POST /desktop/bootstrap/claim", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T17:30:00.000Z"));
    vi.clearAllMocks();
    vi.mocked(desktopOnboardingAttemptsService.get).mockResolvedValue({
      attemptId: "attempt-123",
      organizationId: "org-1",
      userId: "user-1",
      webAppOrigin: "https://app.closedloop.ai",
      expiresAt: new Date("2026-04-23T18:00:00.000Z"),
      consumedAt: null,
    });
    vi.mocked(desktopOnboardingAttemptsService.consume).mockResolvedValue(true);
    vi.mocked(apiKeysService.rotateDesktopManagedKey).mockResolvedValue({
      id: "managed-key-1",
      organizationId: "org-1",
      userId: "user-1",
      name: "Desktop gateway-123",
      keyPrefix: "sk_live_",
      expiresAt: null,
      scopes: ["read", "write", "delete"],
      lastUsedAt: null,
      createdAt: new Date("2026-04-23T17:00:00.000Z"),
      revokedAt: null,
      plaintext: "sk_live_desktop_managed",
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the exact claim response on success", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "https://api.closedloop.ai/desktop/bootstrap/claim",
        body: {
          onboardingAttemptId: "attempt-123",
          webAppOrigin: "https://app.closedloop.ai",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
          gatewayPublicKeyPem: "valid-pem",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      apiKey: "sk_live_desktop_managed",
      source: "DESKTOP_MANAGED",
      gatewayId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(desktopOnboardingAttemptsService.consume).toHaveBeenCalledWith(
      "attempt-123"
    );
    expect(apiKeysService.rotateDesktopManagedKey).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      gatewayId: "550e8400-e29b-41d4-a716-446655440000",
      boundPublicKey: "normalized-pem",
    });
  });

  it("returns 400 for malformed request bodies", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          onboardingAttemptId: "attempt-123",
          webAppOrigin: "https://app.closedloop.ai",
          gatewayId: "not-a-uuid",
          gatewayPublicKeyPem: "valid-pem",
        },
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_BOOTSTRAP_CLAIM_REQUEST",
      retryable: false,
    });
    expect(desktopOnboardingAttemptsService.consume).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid gateway public keys without consuming the attempt", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          onboardingAttemptId: "attempt-123",
          webAppOrigin: "https://app.closedloop.ai",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
          gatewayPublicKeyPem: "bad-pem",
        },
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_GATEWAY_PUBLIC_KEY",
      retryable: false,
    });
    expect(desktopOnboardingAttemptsService.consume).not.toHaveBeenCalled();
  });

  it("accepts missing gatewayPublicKeyPem for older clients and rotates with a null binding", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          onboardingAttemptId: "attempt-123",
          webAppOrigin: "https://app.closedloop.ai",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(apiKeysService.rotateDesktopManagedKey).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      gatewayId: "550e8400-e29b-41d4-a716-446655440000",
      boundPublicKey: null,
    });
  });

  it("accepts the legacy gatewayPublicKey field name during staggered rollouts", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          onboardingAttemptId: "attempt-123",
          webAppOrigin: "https://app.closedloop.ai",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
          gatewayPublicKey: "valid-pem",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(apiKeysService.rotateDesktopManagedKey).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      gatewayId: "550e8400-e29b-41d4-a716-446655440000",
      boundPublicKey: "normalized-pem",
    });
  });

  it("returns 401 when the onboarding attempt is missing, consumed, or expired", async () => {
    vi.mocked(desktopOnboardingAttemptsService.get).mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          onboardingAttemptId: "attempt-123",
          webAppOrigin: "https://app.closedloop.ai",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
          gatewayPublicKeyPem: "valid-pem",
        },
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "ONBOARDING_ATTEMPT_INVALID_OR_EXPIRED",
      retryable: false,
    });
  });

  it("returns 403 when the attempt origin does not match the claim request", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          onboardingAttemptId: "attempt-123",
          webAppOrigin: "https://admin.closedloop.ai",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
          gatewayPublicKeyPem: "valid-pem",
        },
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "ONBOARDING_ATTEMPT_ORIGIN_MISMATCH",
      retryable: false,
    });
    expect(desktopOnboardingAttemptsService.consume).not.toHaveBeenCalled();
  });

  it("returns 409 when rotation hits the managed-key uniqueness conflict after attempt consumption", async () => {
    vi.mocked(apiKeysService.rotateDesktopManagedKey).mockRejectedValue(
      new DesktopManagedKeyRotationConflictError()
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          onboardingAttemptId: "attempt-123",
          webAppOrigin: "https://app.closedloop.ai",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
          gatewayPublicKeyPem: "valid-pem",
        },
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "DESKTOP_MANAGED_KEY_ROTATION_CONFLICT",
      retryable: false,
    });
    expect(desktopOnboardingAttemptsService.consume).toHaveBeenCalledWith(
      "attempt-123"
    );
  });

  it("returns 503 when key issuance fails after attempt consumption", async () => {
    vi.mocked(apiKeysService.rotateDesktopManagedKey).mockRejectedValue(
      new Error("insert failed")
    );

    const response = await POST(
      createMockRequest({
        method: "POST",
        body: {
          onboardingAttemptId: "attempt-123",
          webAppOrigin: "https://app.closedloop.ai",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
          gatewayPublicKeyPem: "valid-pem",
        },
      })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "DESKTOP_MANAGED_KEY_ISSUANCE_FAILED",
      retryable: false,
    });
    expect(desktopOnboardingAttemptsService.consume).toHaveBeenCalledWith(
      "attempt-123"
    );
  });
});
