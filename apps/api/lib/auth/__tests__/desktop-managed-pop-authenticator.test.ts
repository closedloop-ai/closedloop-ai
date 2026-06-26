/**
 * Tests for `authenticateDesktopManagedPopRequest` — the shared Desktop-managed
 * PoP auth helper consumed by both the heartbeat-revival fallback and the
 * execution-credentials route.
 *
 * Branch coverage:
 * - missing bearer / non-sk_live_ bearer → MissingBearer, 401
 * - verifyKeyWithMetadata returns null → InvalidKey, 401
 * - keyContext.scopes lacks "write" → InsufficientScope, 403
 * - source !== DESKTOP_MANAGED / missing boundPublicKey / missing gatewayId
 *   → NotDesktopManaged, 403
 * - user not found / user inactive → InactiveUser, 401
 * - PoP failure → PopFailed with carried status
 * - happy path → success + waitUntil scheduled with touchLastUsedAt promise
 */

import { ApiKeySource } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---

vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    verifyKeyWithMetadata: vi.fn(),
    touchLastUsedAt: vi.fn(),
  },
}));

vi.mock("@/app/users/service", () => ({
  usersService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  verifyDesktopManagedPop: vi.fn(),
  getDesktopManagedPopFailure: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

// --- Imports (after mocks) ---

import { waitUntil } from "@vercel/functions";
import { apiKeysService } from "@/app/api-keys/service";
import { usersService } from "@/app/users/service";
import {
  getDesktopManagedPopFailure,
  verifyDesktopManagedPop,
} from "@/lib/auth/desktop-managed-pop";
import {
  authenticateDesktopManagedPopRequest,
  DesktopManagedPopAuthFailure,
} from "../desktop-managed-pop-authenticator";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "org-test-1";
const USER_ID = "user-test-1";
const GATEWAY_ID = "gateway-test-1";
const API_KEY_ID = "api-key-test-1";
const BEARER = "Bearer sk_live_desktop_managed_token";
const URL = "http://localhost/api/loops/test-loop-id/heartbeat";

const validKeyContext = {
  apiKeyId: API_KEY_ID,
  organizationId: ORG_ID,
  userId: USER_ID,
  scopes: ["write"],
  source: ApiKeySource.DESKTOP_MANAGED,
  boundPublicKey:
    "-----BEGIN PUBLIC KEY-----\nfake-pem\n-----END PUBLIC KEY-----",
  gatewayId: GATEWAY_ID,
} as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>;

const activeUser = {
  id: USER_ID,
  active: true,
  clerkId: "clerk-test-1",
} as Awaited<ReturnType<typeof usersService.findById>>;

const popPassed = {
  accepted: true,
  enforceEligible: true,
  mode: "enforce" as const,
  reason: "passed" as const,
};

function buildRequest(authHeader?: string | null): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== null && authHeader !== undefined) {
    headers.authorization = authHeader;
  }
  return new Request(URL, { method: "POST", headers });
}

function applyHappyPathMocks(): void {
  vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue(
    validKeyContext
  );
  vi.mocked(apiKeysService.touchLastUsedAt).mockResolvedValue(undefined);
  vi.mocked(usersService.findById).mockResolvedValue(activeUser);
  vi.mocked(verifyDesktopManagedPop).mockReturnValue(popPassed);
  vi.mocked(getDesktopManagedPopFailure).mockReturnValue(null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authenticateDesktopManagedPopRequest — failure branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyHappyPathMocks();
  });

  it.each([
    {
      label: "no Authorization header",
      authHeader: null as string | null,
      reason: DesktopManagedPopAuthFailure.MissingBearer,
      status: 401,
    },
    {
      label: "Authorization header without Bearer prefix",
      authHeader: "sk_live_naked_token",
      reason: DesktopManagedPopAuthFailure.MissingBearer,
      status: 401,
    },
    {
      label: "Bearer token does not start with sk_live_",
      authHeader: "Bearer not-a-managed-key",
      reason: DesktopManagedPopAuthFailure.MissingBearer,
      status: 401,
    },
  ])("returns MissingBearer when $label", async ({
    authHeader,
    reason,
    status,
  }) => {
    const result = await authenticateDesktopManagedPopRequest(
      buildRequest(authHeader)
    );

    expect(result).toEqual({ ok: false, reason, status });
    expect(apiKeysService.verifyKeyWithMetadata).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("returns InvalidKey when verifyKeyWithMetadata returns null", async () => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue(null);

    const result = await authenticateDesktopManagedPopRequest(
      buildRequest(BEARER)
    );

    expect(result).toEqual({
      ok: false,
      reason: DesktopManagedPopAuthFailure.InvalidKey,
      status: 401,
    });
    expect(usersService.findById).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("returns InsufficientScope when scopes do not include write", async () => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      ...validKeyContext,
      scopes: ["read"],
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);

    const result = await authenticateDesktopManagedPopRequest(
      buildRequest(BEARER)
    );

    expect(result).toEqual({
      ok: false,
      reason: DesktopManagedPopAuthFailure.InsufficientScope,
      status: 403,
    });
    expect(usersService.findById).not.toHaveBeenCalled();
    expect(verifyDesktopManagedPop).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "source is not DESKTOP_MANAGED",
      overrides: { source: ApiKeySource.USER_CREATED },
    },
    {
      label: "boundPublicKey is missing",
      overrides: { boundPublicKey: null as string | null },
    },
    {
      label: "gatewayId is missing",
      overrides: { gatewayId: null as string | null },
    },
  ])("returns NotDesktopManaged when $label", async ({ overrides }) => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      ...validKeyContext,
      ...overrides,
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);

    const result = await authenticateDesktopManagedPopRequest(
      buildRequest(BEARER)
    );

    expect(result).toEqual({
      ok: false,
      reason: DesktopManagedPopAuthFailure.NotDesktopManaged,
      status: 403,
    });
    expect(usersService.findById).not.toHaveBeenCalled();
    expect(verifyDesktopManagedPop).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    { label: "user not found", user: null },
    {
      label: "user is inactive",
      user: { ...activeUser, active: false } as Awaited<
        ReturnType<typeof usersService.findById>
      >,
    },
  ])("returns InactiveUser when $label", async ({ user }) => {
    vi.mocked(usersService.findById).mockResolvedValue(user);

    const result = await authenticateDesktopManagedPopRequest(
      buildRequest(BEARER)
    );

    expect(result).toEqual({
      ok: false,
      reason: DesktopManagedPopAuthFailure.InactiveUser,
      status: 401,
    });
    expect(verifyDesktopManagedPop).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    { label: "invalid signature → 403", status: 403 as const },
    { label: "verifier unavailable → 503", status: 503 as const },
    { label: "missing headers → 401", status: 401 as const },
  ])("returns PopFailed carrying status $status when $label", async ({
    status,
  }) => {
    vi.mocked(verifyDesktopManagedPop).mockReturnValue({
      accepted: false,
      enforceEligible: true,
      mode: "enforce",
      reason: "invalid_signature",
      status,
    });
    vi.mocked(getDesktopManagedPopFailure).mockReturnValue({
      message: "Desktop managed PoP verification failed",
      status,
    });

    const result = await authenticateDesktopManagedPopRequest(
      buildRequest(BEARER)
    );

    expect(result).toEqual({
      ok: false,
      reason: DesktopManagedPopAuthFailure.PopFailed,
      status,
    });
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe("authenticateDesktopManagedPopRequest — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyHappyPathMocks();
  });

  it("returns success context with apiKeyId and schedules touchLastUsedAt via waitUntil", async () => {
    const touchPromise = Promise.resolve();
    vi.mocked(apiKeysService.touchLastUsedAt).mockReturnValue(touchPromise);

    const result = await authenticateDesktopManagedPopRequest(
      buildRequest(BEARER)
    );

    expect(result).toEqual({
      ok: true,
      organizationId: ORG_ID,
      userId: USER_ID,
      gatewayId: GATEWAY_ID,
      apiKeyId: API_KEY_ID,
    });
    expect(apiKeysService.touchLastUsedAt).toHaveBeenCalledWith(API_KEY_ID);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledWith(touchPromise);
    await touchPromise;
  });

  it("forwards the clerkId from the user record into the PoP verifier", async () => {
    await authenticateDesktopManagedPopRequest(buildRequest(BEARER));

    expect(verifyDesktopManagedPop).toHaveBeenCalledWith(
      expect.objectContaining({
        keyContext: expect.objectContaining({
          clerkUserId: activeUser?.clerkId,
        }),
        mode: "enforce",
      })
    );
  });
});
