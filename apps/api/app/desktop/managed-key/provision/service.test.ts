/**
 * PRD-532 §5.5 (PR-K / M8) security coverage for the session-authenticated
 * DESKTOP_MANAGED key provisioning service.
 *
 * Only the auth boundary and the external collaborators (session lookup, PoP
 * verification, the shared mint) are mocked — the handler's own org-scoping,
 * device-key binding, and error mapping run for real. Verifies:
 *  - authenticated desktop session → mints a DESKTOP_MANAGED key bound to the
 *    session's device key, scoped to the session's org (never the request body)
 *  - a mismatched device pubkey, missing live session, or rejected PoP → 403
 *    (fails closed, no mint)
 *  - a non-desktop-session identity → 403
 *  - input validation (bad gateway id / missing pubkey) → 400
 *  - rotation conflict → 409; underlying failure → 500
 *  - the shared rotateDesktopManagedKey is reused (no parallel mint) with the
 *    org/user taken from the session
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rotateDesktopManagedKey: vi.fn(),
  findActiveDeviceSession: vi.fn(),
  verifyDesktopSessionPop: vi.fn(),
  normalizeEd25519SpkiPublicKeyPem: vi.fn(),
}));

vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: { rotateDesktopManagedKey: mocks.rotateDesktopManagedKey },
  DesktopManagedKeyRotationConflictError: class extends Error {},
}));
vi.mock("@/app/desktop/session/service", () => ({
  findActiveDeviceSession: mocks.findActiveDeviceSession,
}));
vi.mock("@/lib/auth/desktop-session-pop", () => ({
  verifyDesktopSessionPop: mocks.verifyDesktopSessionPop,
}));
vi.mock("@/lib/auth/ed25519-spki-pem", () => ({
  normalizeEd25519SpkiPublicKeyPem: mocks.normalizeEd25519SpkiPublicKeyPem,
}));

import { DesktopManagedKeyRotationConflictError } from "@/app/api-keys/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import { handleManagedKeyProvision } from "./service";

const GATEWAY_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_PEM =
  "-----BEGIN PUBLIC KEY-----\nDEVICE\n-----END PUBLIC KEY-----";
const NORMALIZED_PEM = "normalized-device-pem";

function makeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: {
      id: "user-1",
      clerkId: "clerk-user-1",
      organizationId: "org-1",
      email: "u@example.com",
      firstName: null,
      lastName: null,
      avatarUrl: null,
      phoneNumber: null,
      role: "APPROVER",
      linearId: null,
      slackId: null,
      githubUsername: null,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    clerkUserId: "clerk-user-1",
    clerkOrgId: "clerk-org-1",
    orgRole: undefined,
    authMethod: "desktop_session",
    apiKeyScopes: undefined,
    ...overrides,
  } as AuthContext;
}

function makeRequest(body: unknown): Request {
  return new Request("https://api.example.com/desktop/managed-key/provision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("handleManagedKeyProvision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy path: the supplied PEM normalizes to a stable value that
    // matches the session's bound key, PoP passes, and the mint succeeds.
    mocks.normalizeEd25519SpkiPublicKeyPem.mockImplementation((pem: string) =>
      pem === DEVICE_PEM || pem === NORMALIZED_PEM ? NORMALIZED_PEM : null
    );
    mocks.findActiveDeviceSession.mockResolvedValue({
      id: "session-1",
      gatewayId: GATEWAY_ID,
      boundPublicKey: NORMALIZED_PEM,
    });
    mocks.verifyDesktopSessionPop.mockReturnValue({
      ok: true,
      reason: "passed",
    });
    mocks.rotateDesktopManagedKey.mockResolvedValue({
      id: "key-1",
      plaintext: "sk_live_managed_key",
    });
  });

  it("mints a DESKTOP_MANAGED key bound to the session device key, scoped to the session org", async () => {
    const response = await handleManagedKeyProvision(
      makeAuthContext(),
      makeRequest({ gatewayId: GATEWAY_ID, gatewayPublicKeyPem: DEVICE_PEM })
    );

    expect(response.status).toBe(200);
    const json = await bodyOf(response);
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject({
      apiKey: "sk_live_managed_key",
      source: "DESKTOP_MANAGED",
      gatewayId: GATEWAY_ID,
    });

    // Reuses the shared mint with org/user from the SESSION, not the body.
    expect(mocks.rotateDesktopManagedKey).toHaveBeenCalledTimes(1);
    expect(mocks.rotateDesktopManagedKey).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      gatewayId: GATEWAY_ID,
      boundPublicKey: NORMALIZED_PEM,
    });
    // Session lookup is org-scoped to the authenticated identity.
    expect(mocks.findActiveDeviceSession).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
      gatewayId: GATEWAY_ID,
    });
  });

  it("rejects a non-desktop-session identity with 403 and never mints", async () => {
    const response = await handleManagedKeyProvision(
      makeAuthContext({ authMethod: "api_key" }),
      makeRequest({ gatewayId: GATEWAY_ID, gatewayPublicKeyPem: DEVICE_PEM })
    );

    expect(response.status).toBe(403);
    expect(mocks.rotateDesktopManagedKey).not.toHaveBeenCalled();
  });

  it("fails closed with 403 when no live session exists for the device", async () => {
    mocks.findActiveDeviceSession.mockResolvedValue(null);

    const response = await handleManagedKeyProvision(
      makeAuthContext(),
      makeRequest({ gatewayId: GATEWAY_ID, gatewayPublicKeyPem: DEVICE_PEM })
    );

    expect(response.status).toBe(403);
    expect(mocks.verifyDesktopSessionPop).not.toHaveBeenCalled();
    expect(mocks.rotateDesktopManagedKey).not.toHaveBeenCalled();
  });

  it("rejects a device pubkey that does not match the session's bound key", async () => {
    mocks.findActiveDeviceSession.mockResolvedValue({
      id: "session-1",
      gatewayId: GATEWAY_ID,
      boundPublicKey: "a-different-bound-key",
    });
    // The different bound key normalizes to something other than NORMALIZED_PEM.
    mocks.normalizeEd25519SpkiPublicKeyPem.mockImplementation((pem: string) => {
      if (pem === DEVICE_PEM) {
        return NORMALIZED_PEM;
      }
      if (pem === "a-different-bound-key") {
        return "other-normalized";
      }
      return null;
    });

    const response = await handleManagedKeyProvision(
      makeAuthContext(),
      makeRequest({ gatewayId: GATEWAY_ID, gatewayPublicKeyPem: DEVICE_PEM })
    );

    expect(response.status).toBe(403);
    expect(mocks.rotateDesktopManagedKey).not.toHaveBeenCalled();
  });

  it("rejects when the PoP signature does not verify", async () => {
    mocks.verifyDesktopSessionPop.mockReturnValue({
      ok: false,
      reason: "invalid_signature",
    });

    const response = await handleManagedKeyProvision(
      makeAuthContext(),
      makeRequest({ gatewayId: GATEWAY_ID, gatewayPublicKeyPem: DEVICE_PEM })
    );

    expect(response.status).toBe(403);
    expect(mocks.rotateDesktopManagedKey).not.toHaveBeenCalled();
  });

  it("rejects a malformed gateway id with 400", async () => {
    const response = await handleManagedKeyProvision(
      makeAuthContext(),
      makeRequest({ gatewayId: "not-a-uuid", gatewayPublicKeyPem: DEVICE_PEM })
    );

    expect(response.status).toBe(400);
    expect(mocks.findActiveDeviceSession).not.toHaveBeenCalled();
    expect(mocks.rotateDesktopManagedKey).not.toHaveBeenCalled();
  });

  it("rejects an unnormalizable public key with 400", async () => {
    mocks.normalizeEd25519SpkiPublicKeyPem.mockReturnValue(null);

    const response = await handleManagedKeyProvision(
      makeAuthContext(),
      makeRequest({ gatewayId: GATEWAY_ID, gatewayPublicKeyPem: "junk" })
    );

    expect(response.status).toBe(400);
    expect(mocks.rotateDesktopManagedKey).not.toHaveBeenCalled();
  });

  it("maps a concurrent rotation conflict to 409", async () => {
    mocks.rotateDesktopManagedKey.mockRejectedValue(
      new DesktopManagedKeyRotationConflictError()
    );

    const response = await handleManagedKeyProvision(
      makeAuthContext(),
      makeRequest({ gatewayId: GATEWAY_ID, gatewayPublicKeyPem: DEVICE_PEM })
    );

    expect(response.status).toBe(409);
  });

  it("maps an unexpected mint failure to 500", async () => {
    mocks.rotateDesktopManagedKey.mockRejectedValue(new Error("db down"));

    const response = await handleManagedKeyProvision(
      makeAuthContext(),
      makeRequest({ gatewayId: GATEWAY_ID, gatewayPublicKeyPem: DEVICE_PEM })
    );

    expect(response.status).toBe(500);
  });
});
