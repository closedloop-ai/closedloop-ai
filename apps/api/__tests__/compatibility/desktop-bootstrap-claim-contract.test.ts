/**
 * Compatibility coverage for the PLN-319 v8 claim contract.
 *
 * Verifies the old bootstrap-JWT payload no longer matches the route contract.
 */
import { vi } from "vitest";
import { POST } from "@/app/desktop/bootstrap/claim/route";
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

describe("POST /desktop/bootstrap/claim contract compatibility", () => {
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
});
