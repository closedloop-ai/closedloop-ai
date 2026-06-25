/**
 * T-4.2 — Route HTTP status code tests for POST /api/loops/:id/refresh-token
 *
 * Covers:
 * - 200 with { token, expiresAt, jti } on success
 * - 401 when authenticateLoopRunnerRequest rejects (jti_mismatch and missing Bearer)
 * - 403 when loop not found during auth
 * - 1:1 mapping of every RefreshTokenErrorCode to its HTTP status
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---

vi.mock("../../../service", () => ({
  refreshRunnerToken: vi.fn(),
}));

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  authenticateLoopRunnerRequest: vi.fn(),
  JTI_MISMATCH_ERROR_CODE: "jti_mismatch",
}));

// --- Imports (after mocks) ---

import { RefreshTokenErrorCode } from "@repo/api/src/types/loop";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import {
  createMockRequest,
  createMockRouteContext,
} from "../../../../../__tests__/utils/auth-helpers";
import {
  forbiddenResponse,
  jtiMismatchResponse,
} from "../../../../../__tests__/utils/loop-runner-test-helpers";
import { refreshRunnerToken } from "../../../service";
import { POST } from "../route";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const LOOP_ID = "loop-test-456";
const ORG_ID = "org-test-789";
const CURRENT_JTI = "jti-current-abc";
const NEW_JTI = "jti-new-xyz";
const NEW_TOKEN = "eyJhbGciOiJIUzI1NiJ9.new-token";
const NEW_EXPIRES_AT = new Date(Date.now() + 8 * 60 * 60 * 1000);

/** Authenticated claims returned by authenticateLoopRunnerRequest on success */
const validClaims = {
  loopId: LOOP_ID,
  organizationId: ORG_ID,
  tokenId: CURRENT_JTI,
};

function buildRequest() {
  return createMockRequest({
    url: `http://localhost/api/loops/${LOOP_ID}/refresh-token`,
    method: "POST",
    headers: { authorization: "Bearer runner-token" },
  });
}

const routeContext = () => createMockRouteContext({ id: LOOP_ID });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/loops/:id/refresh-token — HTTP status mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with {token, expiresAt, jti} on success", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(validClaims);
    vi.mocked(refreshRunnerToken).mockResolvedValue({
      ok: true,
      token: NEW_TOKEN,
      expiresAt: NEW_EXPIRES_AT,
      jti: NEW_JTI,
    });

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.token).toBe(NEW_TOKEN);
    expect(body.data.jti).toBe(NEW_JTI);
    // expiresAt is serialized to ISO string in JSON
    expect(new Date(body.data.expiresAt).getTime()).toBe(
      NEW_EXPIRES_AT.getTime()
    );
  });

  it("passes verified claims.tokenId (not a body field) to refreshRunnerToken", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(validClaims);
    vi.mocked(refreshRunnerToken).mockResolvedValue({
      ok: true,
      token: NEW_TOKEN,
      expiresAt: NEW_EXPIRES_AT,
      jti: NEW_JTI,
    });

    await POST(buildRequest(), routeContext());

    expect(refreshRunnerToken).toHaveBeenCalledWith(
      LOOP_ID,
      CURRENT_JTI,
      expect.any(Object)
    );
  });

  it("forwards Idempotency-Key, x-forwarded-for, and user-agent headers as options", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(validClaims);
    vi.mocked(refreshRunnerToken).mockResolvedValue({
      ok: true,
      token: NEW_TOKEN,
      expiresAt: NEW_EXPIRES_AT,
      jti: NEW_JTI,
    });

    const request = createMockRequest({
      url: `http://localhost/api/loops/${LOOP_ID}/refresh-token`,
      method: "POST",
      headers: {
        authorization: "Bearer runner-token",
        "idempotency-key": "idem-key-123",
        // x-forwarded-for arrives as a comma-separated chain — only the first
        // (originating client) IP is forwarded; intermediate proxies are dropped.
        "x-forwarded-for": "203.0.113.5, 10.0.0.1",
        "user-agent": "test-runner/1.0",
      },
    });

    await POST(request, routeContext());

    expect(refreshRunnerToken).toHaveBeenCalledWith(LOOP_ID, CURRENT_JTI, {
      idempotencyKey: "idem-key-123",
      requesterIp: "203.0.113.5",
      requesterUa: "test-runner/1.0",
    });
  });

  it("forwards undefined options when the request has no Idempotency-Key, x-forwarded-for, or user-agent", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(validClaims);
    vi.mocked(refreshRunnerToken).mockResolvedValue({
      ok: true,
      token: NEW_TOKEN,
      expiresAt: NEW_EXPIRES_AT,
      jti: NEW_JTI,
    });

    await POST(buildRequest(), routeContext());

    expect(refreshRunnerToken).toHaveBeenCalledWith(LOOP_ID, CURRENT_JTI, {
      idempotencyKey: undefined,
      requesterIp: undefined,
      requesterUa: undefined,
    });
  });

  it("returns 401 when authenticateLoopRunnerRequest rejects with jti_mismatch", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      jtiMismatchResponse()
    );

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(401);
    expect(refreshRunnerToken).not.toHaveBeenCalled();
  });

  it("returns 401 when authenticateLoopRunnerRequest rejects with missing Bearer", async () => {
    const missingBearer = new Response(
      JSON.stringify({ success: false, error: "Missing runner token" }),
      { status: 401, headers: { "content-type": "application/json" } }
    );
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(missingBearer);

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Missing runner token");
    expect(refreshRunnerToken).not.toHaveBeenCalled();
  });

  it("returns 403 when loop not found during auth", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      forbiddenResponse()
    );

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(403);
    expect(refreshRunnerToken).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Service-error-code → HTTP-status mapping (1:1 in the route's switch).
  // One row per RefreshTokenErrorCode keeps coverage explicit while removing
  // seven near-identical 14-line test blocks.
  // -------------------------------------------------------------------------
  it.each<[RefreshTokenErrorCode, number, string]>([
    [RefreshTokenErrorCode.LoopNotFound, 404, `Loop ${LOOP_ID} not found`],
    [RefreshTokenErrorCode.NotRunning, 409, `Loop ${LOOP_ID} is not running`],
    [
      RefreshTokenErrorCode.TokenExpired,
      401,
      `Token for loop ${LOOP_ID} has expired`,
    ],
    [
      RefreshTokenErrorCode.JtiMismatch,
      401,
      `JTI mismatch for loop ${LOOP_ID}`,
    ],
    [
      RefreshTokenErrorCode.JtiAlreadyUsed,
      401,
      `JTI ${CURRENT_JTI} has already been used`,
    ],
    [
      RefreshTokenErrorCode.GenerationFailed,
      500,
      "Failed to generate new token",
    ],
    [
      RefreshTokenErrorCode.RaceLost,
      409,
      `CAS update matched 0 rows for loop ${LOOP_ID}`,
    ],
    [
      RefreshTokenErrorCode.RateLimited,
      429,
      `Refresh rate limit exceeded for loop ${LOOP_ID}`,
    ],
  ])("maps service error %s to HTTP %d", async (code, expectedStatus, message) => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(validClaims);
    vi.mocked(refreshRunnerToken).mockResolvedValue({
      ok: false,
      code,
      message,
    });

    const response = await POST(buildRequest(), routeContext());

    expect(response.status).toBe(expectedStatus);
  });
});
