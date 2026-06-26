/**
 * T-7.6 — JTI mismatch test for POST /api/loops/:id/upload-artifacts
 *
 * Covers auth failure paths (loop not found → 403, jti_mismatch → 401)
 * and the happy path (auth succeeds → artifacts stored).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---

vi.mock("../../../service", () => ({
  loopsService: {
    findById: vi.fn(),
    updateUploadedArtifacts: vi.fn(),
    updateMetadata: vi.fn(),
  },
}));

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  authenticateLoopRunnerRequest: vi.fn(),
  JTI_MISMATCH_ERROR_CODE: "jti_mismatch",
}));

vi.mock("@/lib/route-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/route-utils")>();
  return {
    ...actual,
    scheduleLogFlush: vi.fn(),
  };
});

// --- Imports (after mocks) ---

import {
  authenticateLoopRunnerRequest,
  JTI_MISMATCH_ERROR_CODE,
} from "@/lib/auth/loop-runner-jwt";
import {
  forbiddenResponse,
  jtiMismatchResponse,
} from "../../../../../__tests__/utils/loop-runner-test-helpers";
import { loopsService } from "../../../service";
import { POST } from "../route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(loopId = "loop-123"): Request {
  return new Request(`http://localhost/api/loops/${loopId}/upload-artifacts`, {
    method: "POST",
    headers: {
      authorization: "Bearer runner-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      artifacts: {
        plan: { content: "# Plan content" },
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/loops/:id/upload-artifacts — auth and storage", () => {
  const loopId = "loop-123";
  const orgId = "org-456";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 when loop not found", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      forbiddenResponse()
    );

    const response = await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(response.status).toBe(403);
    expect(loopsService.updateUploadedArtifacts).not.toHaveBeenCalled();
  });

  it("returns 401 with code jti_mismatch when activeTokenJti is already pinned and request bears stale jti", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      jtiMismatchResponse()
    );

    const response = await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe(JTI_MISMATCH_ERROR_CODE);
  });

  it("does not store artifacts on jti_mismatch", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      jtiMismatchResponse()
    );

    await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(loopsService.updateUploadedArtifacts).not.toHaveBeenCalled();
  });

  it("returns 200 and stores artifacts when authentication succeeds", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue({
      loopId,
      organizationId: orgId,
      tokenId: "jti-valid",
    });

    vi.mocked(loopsService.updateUploadedArtifacts).mockResolvedValue(1);
    vi.mocked(loopsService.findById).mockResolvedValue({
      id: loopId,
      computeTargetId: null,
      metadata: null,
    } as any);

    const response = await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data).toEqual({ stored: true });
    expect(loopsService.updateUploadedArtifacts).toHaveBeenCalledWith(
      loopId,
      orgId,
      expect.objectContaining({ plan: { content: "# Plan content" } })
    );
  });
});
