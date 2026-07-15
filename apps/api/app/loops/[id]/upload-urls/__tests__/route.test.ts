/**
 * T-7.7 — JTI mismatch / CAS-pin test for POST /api/loops/:id/upload-urls
 *
 * Covers the jti_mismatch path: returns 401 when a stale token is presented.
 * Also covers: 403 when loop not found, and that upload URL generation
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
  generateUploadUrl: vi.fn(),
  validateKeyBelongsToLoop: vi.fn(),
}));

// --- Imports (after mocks) ---

import {
  authenticateLoopRunnerRequest,
  JTI_MISMATCH_ERROR_CODE,
} from "@/lib/auth/loop-runner-jwt";
import {
  generateUploadUrl,
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
  keys = ["org-456/loops/loop-123/state.json"]
): Request {
  return new Request(`http://localhost/api/loops/${loopId}/upload-urls`, {
    method: "POST",
    headers: {
      authorization: "Bearer runner-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ keys }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/loops/:id/upload-urls — jti_mismatch / CAS-pin", () => {
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
    vi.mocked(generateUploadUrl).mockResolvedValue(
      "https://s3.example.com/presigned-put-url-1"
    );

    const response = await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.urls).toHaveLength(1);
    expect(body.data.urls[0].key).toBe("org-456/loops/loop-123/state.json");
    expect(body.data.urls[0].url).toBe(
      "https://s3.example.com/presigned-put-url-1"
    );
  });

  it("signs Content-Encoding: gzip only for keys listed in gzipKeys", async () => {
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
    vi.mocked(generateUploadUrl).mockResolvedValue(
      "https://s3.example.com/presigned-put-url"
    );

    const gzipKey = `${orgId}/loops/${loopId}/support/perf.jsonl`;
    const plainKey = `${orgId}/loops/${loopId}/metadata.json`;
    const request = new Request(
      `http://localhost/api/loops/${loopId}/upload-urls`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer runner-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          keys: [gzipKey, plainKey],
          gzipKeys: [gzipKey],
        }),
      }
    );

    const response = await POST(request, {
      params: Promise.resolve({ id: loopId }),
    });

    expect(response.status).toBe(200);
    expect(generateUploadUrl).toHaveBeenCalledWith(gzipKey, undefined, {
      contentEncoding: "gzip",
    });
    expect(generateUploadUrl).toHaveBeenCalledWith(plainKey, undefined, {});

    // The applied encoding is echoed per URL so a version-skewed client only
    // compresses when the backend confirms it signed for gzip.
    const body = await response.json();
    const byKey = new Map(
      body.data.urls.map((u: { key: string }) => [u.key, u])
    );
    expect(byKey.get(gzipKey)).toMatchObject({ contentEncoding: "gzip" });
    expect(byKey.get(plainKey)).not.toHaveProperty("contentEncoding");
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
    vi.mocked(generateUploadUrl).mockResolvedValue(
      "https://s3.example.com/presigned-put-url-1"
    );

    await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(authenticateLoopRunnerRequest).toHaveBeenCalledWith(
      expect.any(Request),
      loopId,
      "loops/[id]/upload-urls"
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

  it("does not generate upload URLs on jti_mismatch", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      jtiMismatchResponse()
    );

    await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(generateUploadUrl).not.toHaveBeenCalled();
  });

  it("returns 403 when loop not found", async () => {
    vi.mocked(authenticateLoopRunnerRequest).mockResolvedValue(
      forbiddenResponse()
    );

    const response = await POST(makeRequest(loopId), {
      params: Promise.resolve({ id: loopId }),
    });

    expect(response.status).toBe(403);
    expect(generateUploadUrl).not.toHaveBeenCalled();
  });
});
