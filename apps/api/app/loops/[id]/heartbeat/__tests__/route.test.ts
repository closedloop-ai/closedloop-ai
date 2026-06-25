/**
 * T-4.1 — Route HTTP status code tests for POST /api/loops/:id/heartbeat
 *
 * Covers:
 * - 200 with bumped:true on successful heartbeat bump (AC-001)
 * - 200 with bumped:false on rate-limited no-op / idempotent call (AC-002)
 * - 410 Gone when loop is in a terminal status (AC-003)
 * - 403 when loop not found during auth or LoopNotFound / NotRunning service error
 *
 * T-1.2 — Revival path (handleManagedKeyPopFallback) tests
 *
 * Covers:
 * - 200 with revived:true and fresh token fields when PoP verification succeeds (AC-001)
 * - 410 when runner JWT fails and bearer token is missing or not sk_live_* prefixed
 * - 410 when runner JWT fails and PoP verification fails (bad signature)
 * - 410 when runner JWT fails and PoP verification fails (stale timestamp)
 * - 410 when runner JWT fails and PoP verification fails (wrong gateway)
 * - 410 when runner JWT fails and user is inactive
 * - 410 when gateway does not own the loop's compute target
 * - 410 when revival is refused after successful PoP auth
 */

import { ApiKeySource } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---

vi.mock("../../../service", () => ({
  heartbeatRunner: vi.fn(),
  reviveTimedOutLoop: vi.fn(),
}));

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  authenticateLoopRunnerRequest: vi.fn(),
  JTI_MISMATCH_ERROR_CODE: "jti_mismatch",
}));

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

vi.mock("@repo/database", () => ({
  ApiKeySource: {
    DESKTOP_MANAGED: "DESKTOP_MANAGED",
    USER_CREATED: "USER_CREATED",
  },
  withDb: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

// --- Imports (after mocks) ---

import { HeartbeatErrorCode } from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { apiKeysService } from "@/app/api-keys/service";
import { usersService } from "@/app/users/service";
import {
  getDesktopManagedPopFailure,
  verifyDesktopManagedPop,
} from "@/lib/auth/desktop-managed-pop";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import {
  createMockRequest,
  createMockRouteContext,
} from "../../../../../__tests__/utils/auth-helpers";
import { forbiddenResponse } from "../../../../../__tests__/utils/loop-runner-test-helpers";
import { heartbeatRunner, reviveTimedOutLoop } from "../../../service";
import { POST } from "../route";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const LOOP_ID = "loop-test-heartbeat-123";
const ORG_ID = "org-test-heartbeat-456";
const GATEWAY_ID = "gateway-test-abc";
const CURRENT_JTI = "jti-heartbeat-abc";
const COMPUTE_TARGET_ID = "ct-test-heartbeat-789";

const REVIVAL_TOKEN = "eyJhbGciOiJIUzI1NiJ9.revival-token";
const REVIVAL_JTI = "jti-revival-new-xyz";
const REVIVAL_EXPIRES_AT = new Date(Date.now() + 8 * 60 * 60 * 1000);

/** Authenticated claims returned by authenticateLoopRunnerRequest on success */
const validClaims = {
  loopId: LOOP_ID,
  organizationId: ORG_ID,
  tokenId: CURRENT_JTI,
};

/** Verified key context for a desktop-managed key */
const validKeyContext = {
  apiKeyId: "api-key-1",
  organizationId: ORG_ID,
  userId: "user-pop-1",
  scopes: ["write"],
  source: ApiKeySource.DESKTOP_MANAGED,
  boundPublicKey:
    "-----BEGIN PUBLIC KEY-----\nfake-pem\n-----END PUBLIC KEY-----",
  gatewayId: GATEWAY_ID,
} as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>;

/** Active user record returned by usersService.findById */
const activeUser = {
  id: "user-pop-1",
  active: true,
  clerkId: "clerk-user-pop-1",
} as Awaited<ReturnType<typeof usersService.findById>>;

/** PoP decision indicating a passing verification */
const popPassed = {
  accepted: true,
  enforceEligible: true,
  mode: "enforce" as const,
  reason: "passed" as const,
};

function buildRequest(authHeader?: string) {
  return createMockRequest({
    url: `http://localhost/api/loops/${LOOP_ID}/heartbeat`,
    method: "POST",
    headers: {
      authorization: authHeader ?? "Bearer sk_live_desktop_managed_token",
    },
  });
}

function buildRequestWithoutAuth() {
  return createMockRequest({
    url: `http://localhost/api/loops/${LOOP_ID}/heartbeat`,
    method: "POST",
  });
}

const routeContext = () => createMockRouteContext({ id: LOOP_ID });

/**
 * Build a `withDb` mock keyed on the Prisma model and operation that the
 * callback invokes, so test scenarios are described by *what the queries
 * return* rather than *the order they are issued*. This keeps the tests
 * correct if `verifyGatewayOwnsLoop` is later refactored to merge the two
 * `withDb` callbacks into one — the same `loop.findUnique` /
 * `computeTarget.findFirst` mocks would be invoked, just from one callback
 * frame instead of two.
 */
function setupWithDbForGatewayOwnership(input: {
  loop: { computeTargetId: string } | null;
  computeTarget: { id: string } | null;
}) {
  const db = {
    loop: {
      findUnique: vi.fn().mockResolvedValue(input.loop),
    },
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue(input.computeTarget),
    },
  };
  vi.mocked(withDb).mockImplementation(async (callback) =>
    callback(db as never)
  );
  return db;
}

function setupWithDbGatewayOwnsLoop() {
  return setupWithDbForGatewayOwnership({
    loop: { computeTargetId: COMPUTE_TARGET_ID },
    computeTarget: { id: COMPUTE_TARGET_ID },
  });
}

function setupWithDbGatewayDoesNotOwnLoop() {
  return setupWithDbForGatewayOwnership({
    loop: { computeTargetId: COMPUTE_TARGET_ID },
    computeTarget: null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/loops/:id/heartbeat — HTTP status mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with bumped: true on successful heartbeat bump", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(validClaims);
    vi.mocked(heartbeatRunner).mockResolvedValue({ ok: true, bumped: true });

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.bumped).toBe(true);
  });

  it("returns 200 with bumped: false on rate-limited no-op", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(validClaims);
    vi.mocked(heartbeatRunner).mockResolvedValue({ ok: true, bumped: false });

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.bumped).toBe(false);
  });

  it("calls heartbeatRunner with loopId and organizationId from claims", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(validClaims);
    vi.mocked(heartbeatRunner).mockResolvedValue({ ok: true, bumped: true });

    await POST(buildRequest(), routeContext());

    expect(heartbeatRunner).toHaveBeenCalledWith(LOOP_ID, ORG_ID);
  });

  it("returns 410 Gone when loop is in a terminal status", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(validClaims);
    vi.mocked(heartbeatRunner).mockResolvedValue({
      ok: false,
      code: HeartbeatErrorCode.TerminalLoop,
    });

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(410);
    expect(heartbeatRunner).toHaveBeenCalledWith(LOOP_ID, ORG_ID);
  });

  it.each([
    HeartbeatErrorCode.LoopNotFound,
    HeartbeatErrorCode.NotRunning,
  ])("returns 403 when heartbeatRunner returns %s", async (code) => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(validClaims);
    vi.mocked(heartbeatRunner).mockResolvedValue({ ok: false, code });

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// T-1.2: Managed-PoP fallback path (handleManagedKeyPopFallback) tests
// ---------------------------------------------------------------------------

describe("POST /api/loops/:id/heartbeat — managed-PoP fallback path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // All revival tests start with a failed runner JWT (returns a Response)
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      forbiddenResponse()
    );
    // Default: happy path mocks for PoP auth
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue(
      validKeyContext
    );
    vi.mocked(apiKeysService.touchLastUsedAt).mockResolvedValue(undefined);
    vi.mocked(usersService.findById).mockResolvedValue(activeUser);
    vi.mocked(verifyDesktopManagedPop).mockReturnValue(popPassed);
    vi.mocked(getDesktopManagedPopFailure).mockReturnValue(null);
    setupWithDbGatewayOwnsLoop();
  });

  it("returns 200 with revived:true and fresh token fields when PoP verification succeeds", async () => {
    vi.mocked(reviveTimedOutLoop).mockResolvedValue({
      ok: true,
      token: REVIVAL_TOKEN,
      expiresAt: REVIVAL_EXPIRES_AT,
      jti: REVIVAL_JTI,
    });

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.revived).toBe(true);
    expect(body.data.bumped).toBe(true);
    expect(body.data.token).toBe(REVIVAL_TOKEN);
    expect(body.data.jti).toBe(REVIVAL_JTI);
    expect(reviveTimedOutLoop).toHaveBeenCalledWith(LOOP_ID, ORG_ID);
    expect(heartbeatRunner).not.toHaveBeenCalled();
  });

  it("returns 410 when bearer token is missing (no Authorization header)", async () => {
    const response = await POST(buildRequestWithoutAuth(), routeContext());

    expect(response.status).toBe(410);
    expect(apiKeysService.verifyKeyWithMetadata).not.toHaveBeenCalled();
    expect(reviveTimedOutLoop).not.toHaveBeenCalled();
  });

  it("returns 410 when bearer token does not start with sk_live_", async () => {
    const response = await POST(
      buildRequest("Bearer not-a-managed-key"),
      routeContext()
    );

    expect(response.status).toBe(410);
    expect(apiKeysService.verifyKeyWithMetadata).not.toHaveBeenCalled();
    expect(reviveTimedOutLoop).not.toHaveBeenCalled();
  });

  it("returns 410 when keyContext scopes does not include write", async () => {
    vi.mocked(apiKeysService.verifyKeyWithMetadata).mockResolvedValue({
      ...validKeyContext,
      scopes: ["read"],
    } as Awaited<ReturnType<typeof apiKeysService.verifyKeyWithMetadata>>);

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe(HeartbeatErrorCode.TerminalLoop);
    expect(verifyDesktopManagedPop).not.toHaveBeenCalled();
    expect(reviveTimedOutLoop).not.toHaveBeenCalled();
  });

  // The route collapses every PoP-failure reason (invalid_signature,
  // stale_timestamp, gateway_mismatch, etc.) to the same 410 Gone with a
  // TerminalLoop code so the desktop can finalize the job. Iterating the
  // reason space here is redundant — the per-reason carry-through is
  // exercised by the shared helper's own tests in
  // apps/api/lib/auth/__tests__/desktop-managed-pop-authenticator.test.ts.
  it("returns 410 when PoP verification fails", async () => {
    vi.mocked(verifyDesktopManagedPop).mockReturnValue({
      accepted: false,
      enforceEligible: true,
      mode: "enforce",
      reason: "invalid_signature",
      status: 403,
    });
    vi.mocked(getDesktopManagedPopFailure).mockReturnValue({
      message: "Desktop managed PoP verification failed",
      status: 403,
    });

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(410);
    expect(reviveTimedOutLoop).not.toHaveBeenCalled();
  });

  it("returns 410 when user is inactive", async () => {
    vi.mocked(usersService.findById).mockResolvedValue({
      ...activeUser,
      active: false,
    } as Awaited<ReturnType<typeof usersService.findById>>);

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(410);
    expect(verifyDesktopManagedPop).not.toHaveBeenCalled();
    expect(reviveTimedOutLoop).not.toHaveBeenCalled();
  });

  it("returns 410 when gateway does not own the loop's compute target", async () => {
    setupWithDbGatewayDoesNotOwnLoop();
    vi.mocked(reviveTimedOutLoop).mockResolvedValue({
      ok: true,
      token: REVIVAL_TOKEN,
      expiresAt: REVIVAL_EXPIRES_AT,
      jti: REVIVAL_JTI,
    });

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(410);
    expect(reviveTimedOutLoop).not.toHaveBeenCalled();
  });

  it("returns 410 when revival is refused after successful PoP auth", async () => {
    vi.mocked(reviveTimedOutLoop).mockResolvedValue({
      ok: false,
      reason: "GRACE_WINDOW_EXPIRED",
    });

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(410);
    expect(reviveTimedOutLoop).toHaveBeenCalledWith(LOOP_ID, ORG_ID);
  });
});
