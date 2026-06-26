/**
 * T-7.5 — JTI mismatch / CAS-pin test for POST /api/loops/:id/download-urls
 *
 * Covers the jti_mismatch path: returns 401 when a stale token is presented.
 * Also covers: 403 when loop not found, and that download URL generation
 * is skipped on auth failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---

vi.mock("../../../service", () => ({
  loopsService: {
    findById: vi.fn(),
  },
}));

vi.mock("@/lib/auth/loop-runner-jwt", () => ({
  authenticateLoopRunnerRequest: vi.fn(),
  JTI_MISMATCH_ERROR_CODE: "jti_mismatch",
}));

vi.mock("@/lib/loops/loop-state", () => ({
  listAndGenerateDownloadUrls: vi.fn(),
  validateKeyBelongsToLoop: vi.fn(),
}));

// --- Imports (after mocks) ---

import {
  authenticateLoopRunnerRequest,
  JTI_MISMATCH_ERROR_CODE,
} from "@/lib/auth/loop-runner-jwt";
import {
  listAndGenerateDownloadUrls,
  validateKeyBelongsToLoop,
} from "@/lib/loops/loop-state";
import {
  forbiddenResponse,
  jtiMismatchResponse,
} from "../../../../../__tests__/utils/loop-runner-test-helpers";
import { loopsService } from "../../../service";
import { POST } from "../route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  loopId = "loop-123",
  prefix = "org-456/loops/loop-123/"
): Request {
  return new Request(`http://localhost/api/loops/${loopId}/download-urls`, {
    method: "POST",
    headers: {
      authorization: "Bearer runner-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ prefix }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/loops/:id/download-urls — jti_mismatch / CAS-pin", () => {
  const loopId = "loop-123";
  const orgId = "org-456";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 when authentication succeeds", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue({
      loopId,
      organizationId: orgId,
      tokenId: "jti-new",
    });

    vi.mocked(loopsService.findById).mockResolvedValue({
      id: loopId,
      parentLoopId: null,
    } as any);

    vi.mocked(validateKeyBelongsToLoop).mockReturnValue(true);
    vi.mocked(listAndGenerateDownloadUrls).mockResolvedValue([
      {
        key: "org-456/loops/loop-123/file.txt",
        url: "https://s3.example.com/presigned-url-1",
      },
    ]);

    const response = await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data).toEqual({
      urls: [
        {
          key: "org-456/loops/loop-123/file.txt",
          url: "https://s3.example.com/presigned-url-1",
        },
      ],
    });
  });

  it("passes loopId and route to authenticateLoopRunnerRequest", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue({
      loopId,
      organizationId: orgId,
      tokenId: "jti-new",
    });

    vi.mocked(loopsService.findById).mockResolvedValue({
      id: loopId,
      parentLoopId: null,
    } as any);

    vi.mocked(validateKeyBelongsToLoop).mockReturnValue(true);
    vi.mocked(listAndGenerateDownloadUrls).mockResolvedValue([]);

    await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(authenticateLoopRunnerRequest).toHaveBeenCalledWith(
      expect.any(Request),
      loopId,
      "loops/[id]/download-urls"
    );
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

  it("does not generate download URLs on jti_mismatch", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      jtiMismatchResponse()
    );

    await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(listAndGenerateDownloadUrls).not.toHaveBeenCalled();
  });

  it("returns 403 when loop not found", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      forbiddenResponse()
    );

    const response = await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(response.status).toBe(403);
    expect(listAndGenerateDownloadUrls).not.toHaveBeenCalled();
  });
});
