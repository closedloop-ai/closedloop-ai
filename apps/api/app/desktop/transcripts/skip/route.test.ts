import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  markPermanentlySkipped: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler({ user: mocks.user, clerkUserId: null }, request),
}));

vi.mock("../service", () => ({
  transcriptSyncService: {
    markPermanentlySkipped: mocks.markPermanentlySkipped,
  },
  TranscriptSyncErrorReason: {
    Forbidden: "forbidden",
    RateLimited: "rate_limited",
    InvalidRequest: "invalid_request",
    StaleUpload: "stale_upload",
    Internal: "internal",
  },
}));

import { POST } from "./route";

const VALID_BODY = {
  computeTargetId: "11111111-1111-7111-8111-111111111111",
  externalSessionId: "session-abc",
  fileKey: "main",
  sourceHarness: "claude-code",
  reason: "too_large",
};

function request(body: unknown) {
  return new NextRequest("https://api.closedloop.ai/desktop/transcripts/skip", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({}) };

describe("POST /desktop/transcripts/skip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the recorded terminal state on success", async () => {
    const value = {
      status: "skipped",
      permanentFailureReason: "too_large",
      sessionDetailId: "art-1",
    };
    mocks.markPermanentlySkipped.mockResolvedValue({ ok: true, value });
    const response = await POST(request(VALID_BODY), ctx);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toEqual(value);
    expect(mocks.markPermanentlySkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ reason: "too_large" }),
        organizationId: "org-1",
      })
    );
  });

  it("accepts the retries_exhausted reason through the request schema (ISS-4621)", async () => {
    // The consecutive-failure dead-letter emits this reason; a schema/contract
    // drift here would leave exhausted rows retrying forever while the desktop
    // unit tests (which fake the client) stay green.
    const value = {
      status: "skipped",
      permanentFailureReason: "retries_exhausted",
      sessionDetailId: "art-1",
    };
    mocks.markPermanentlySkipped.mockResolvedValue({ ok: true, value });
    const response = await POST(
      request({ ...VALID_BODY, reason: "retries_exhausted" }),
      ctx
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toEqual(value);
    expect(mocks.markPermanentlySkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ reason: "retries_exhausted" }),
      })
    );
  });

  it("rejects an unknown skip reason (400)", async () => {
    const response = await POST(
      request({ ...VALID_BODY, reason: "bogus" }),
      ctx
    );
    expect(response.status).toBe(400);
    expect(mocks.markPermanentlySkipped).not.toHaveBeenCalled();
  });

  it("rejects a body missing the sourceHarness (400)", async () => {
    const response = await POST(
      request({ ...VALID_BODY, sourceHarness: undefined }),
      ctx
    );
    expect(response.status).toBe(400);
    expect(mocks.markPermanentlySkipped).not.toHaveBeenCalled();
  });
});
