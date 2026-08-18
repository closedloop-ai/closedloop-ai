import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  complete: vi.fn(),
  indexAfterCommit: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler({ user: mocks.user, clerkUserId: null }, request),
}));

vi.mock("../service", () => ({
  transcriptSyncService: { complete: mocks.complete },
  TranscriptSyncErrorReason: {
    Forbidden: "forbidden",
    RateLimited: "rate_limited",
    InvalidRequest: "invalid_request",
    StaleUpload: "stale_upload",
    Internal: "internal",
  },
}));

vi.mock("@/app/search/transcript-search-indexer", () => ({
  transcriptSearchIndexService: { indexAfterCommit: mocks.indexAfterCommit },
}));

import { POST } from "./route";

const VALID_BODY = {
  computeTargetId: "11111111-1111-7111-8111-111111111111",
  externalSessionId: "session-abc",
  fileKey: "main",
  mode: "multipart",
  uploadId: "u",
  planEndOffset: 1000,
  sha256: "a".repeat(64),
  crc64nvme: "crc-1",
};

function request(body: unknown) {
  return new NextRequest(
    "https://api.closedloop.ai/desktop/transcripts/complete",
    { method: "POST", body: JSON.stringify(body) }
  );
}

const ctx = { params: Promise.resolve({}) };

describe("POST /desktop/transcripts/complete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the verified state on success and schedules transcript search indexing", async () => {
    const value = {
      status: "uploaded",
      syncedByteOffset: 1000,
      storedEtag: "final",
      sessionDetailId: "art-1",
    };
    mocks.complete.mockResolvedValue({ ok: true, value });
    const response = await POST(request(VALID_BODY), ctx);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toEqual(value);
    // FEA-3930: a verified upload triggers the (org-gated, best-effort) index
    // with the session identity — the indexer itself decides whether to index.
    expect(mocks.indexAfterCommit).toHaveBeenCalledWith({
      organizationId: "org-1",
      computeTargetId: VALID_BODY.computeTargetId,
      externalSessionId: VALID_BODY.externalSessionId,
      fileKey: "main",
    });
  });

  it("does NOT schedule transcript search indexing for a non-uploaded result", async () => {
    // A skipped/idempotent-noop terminal state that is not `uploaded` must not
    // trigger indexing (nothing new to index).
    mocks.complete.mockResolvedValue({
      ok: true,
      value: {
        status: "skipped",
        syncedByteOffset: 0,
        storedEtag: null,
        sessionDetailId: "art-1",
      },
    });
    const response = await POST(request(VALID_BODY), ctx);
    expect(response.status).toBe(200);
    expect(mocks.indexAfterCommit).not.toHaveBeenCalled();
  });

  it("rejects a multipart completion without an uploadId (400)", async () => {
    // The contract's refine (multipart requires uploadId) is enforced here.
    const response = await POST(
      request({ ...VALID_BODY, uploadId: undefined }),
      ctx
    );
    expect(response.status).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
