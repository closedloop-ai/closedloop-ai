/**
 * Compatibility coverage for the PLN-319 v10 claim contract.
 *
 * Verifies the route rejects the obsolete bootstrap-JWT payload while still
 * tolerating safe legacy field variations and null-bound managed keys.
 */
import { vi } from "vitest";
import { apiKeysService } from "@/app/api-keys/service";
import { POST } from "@/app/desktop/bootstrap/claim/route";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { normalizeEd25519SpkiPublicKeyPem } from "@/lib/auth/ed25519-spki-pem";
import { createMockRequest } from "../utils/auth-helpers";

vi.mock("@/app/desktop/onboarding-attempt/service", () => ({
  desktopOnboardingAttemptsService: {
    get: vi.fn(),
    consume: vi.fn(),
  },
}));
vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    rotateDesktopManagedKey: vi.fn(),
  },
  DesktopManagedKeyRotationConflictError: class extends Error {},
}));
vi.mock("@/lib/auth/ed25519-spki-pem", () => ({
  normalizeEd25519SpkiPublicKeyPem: vi.fn(),
}));
vi.mock("@/lib/auth/canonical-trusted-origin", () => ({
  canonicalizeTrustedOrigin: (origin: string) =>
    origin.startsWith("https://") ? origin : null,
}));

describe("POST /desktop/bootstrap/claim contract compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(desktopOnboardingAttemptsService.get).mockResolvedValue({
      attemptId: "attempt-123",
      organizationId: "org-1",
      userId: "user-1",
      webAppOrigin: "https://app.closedloop.ai",
      expiresAt: new Date("2099-04-23T18:00:00.000Z"),
      consumedAt: null,
    });
    vi.mocked(desktopOnboardingAttemptsService.consume).mockResolvedValue(true);
    vi.mocked(apiKeysService.rotateDesktopManagedKey).mockResolvedValue({
      plaintext: "sk_live_desktop_managed",
    } as never);
    vi.mocked(normalizeEd25519SpkiPublicKeyPem).mockImplementation((pem) =>
      pem === "valid-pem" ? "normalized-pem" : null
    );
  });

  it("rejects the obsolete bootstrapJwt payload shape with the new 400 contract", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "https://api.closedloop.ai/desktop/bootstrap/claim",
        body: {
          bootstrapJwt: "old-token",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
          webAppOrigin: "https://app.closedloop.ai",
          gatewayPublicKey: "old-key",
        },
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_BOOTSTRAP_CLAIM_REQUEST",
      retryable: false,
    });
  });

  it("accepts the legacy gatewayPublicKey field alias", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "https://api.closedloop.ai/desktop/bootstrap/claim",
        body: {
          onboardingAttemptId: "attempt-123",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
          webAppOrigin: "https://app.closedloop.ai",
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

  it("accepts an unusable legacy public-key alias as a null-bound managed key", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "https://api.closedloop.ai/desktop/bootstrap/claim",
        body: {
          onboardingAttemptId: "attempt-123",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
          webAppOrigin: "https://app.closedloop.ai",
          gatewayPublicKey: "bad-pem",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(desktopOnboardingAttemptsService.consume).toHaveBeenCalledWith(
      "attempt-123"
    );
    expect(apiKeysService.rotateDesktopManagedKey).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      gatewayId: "550e8400-e29b-41d4-a716-446655440000",
      boundPublicKey: null,
    });
  });

  it("accepts missing public keys and falls back to a null binding", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "https://api.closedloop.ai/desktop/bootstrap/claim",
        body: {
          onboardingAttemptId: "attempt-123",
          gatewayId: "550e8400-e29b-41d4-a716-446655440000",
          webAppOrigin: "https://app.closedloop.ai",
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
});
