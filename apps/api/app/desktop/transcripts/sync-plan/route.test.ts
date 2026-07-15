import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  planSync: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler({ user: mocks.user, clerkUserId: null }, request),
}));

vi.mock("../service", () => ({
  transcriptSyncService: { planSync: mocks.planSync },
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
  sourceHarness: "claude_code",
  sourcePathHash: "path-hash",
  planEndOffset: 1000,
  sha256: "a".repeat(64),
  crc64nvme: "crc-1",
  sourceMtime: new Date(1_700_000_000_000).toISOString(),
};

function request(body: unknown) {
  return new NextRequest(
    "https://api.closedloop.ai/desktop/transcripts/sync-plan",
    { method: "POST", body: JSON.stringify(body) }
  );
}

const ctx = { params: Promise.resolve({}) };

describe("POST /desktop/transcripts/sync-plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the plan on success", async () => {
    const value = {
      mode: "fullPut",
      url: "https://s3/put",
      planEndOffset: 1000,
      syncedByteOffset: 0,
      storedEtag: null,
    };
    mocks.planSync.mockResolvedValue({ ok: true, value });
    const response = await POST(request(VALID_BODY), ctx);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toEqual(value);
    expect(mocks.planSync).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", userId: "user-1" })
    );
  });

  it("returns 400 for an invalid body without calling the service", async () => {
    const response = await POST(request({ fileKey: "main" }), ctx);
    expect(response.status).toBe(400);
    expect(mocks.planSync).not.toHaveBeenCalled();
  });

  it("rejects a path-unsafe externalSessionId (S3-key-collision guard)", async () => {
    const response = await POST(
      request({ ...VALID_BODY, externalSessionId: "a/b" }),
      ctx
    );
    expect(response.status).toBe(400);
    expect(mocks.planSync).not.toHaveBeenCalled();
  });

  it("maps Forbidden to 403", async () => {
    mocks.planSync.mockResolvedValue({ ok: false, error: "forbidden" });
    const response = await POST(request(VALID_BODY), ctx);
    expect(response.status).toBe(403);
  });

  it("maps RateLimited to 429 with Retry-After", async () => {
    mocks.planSync.mockResolvedValue({ ok: false, error: "rate_limited" });
    const response = await POST(request(VALID_BODY), ctx);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("maps StaleUpload to 409", async () => {
    mocks.planSync.mockResolvedValue({ ok: false, error: "stale_upload" });
    const response = await POST(request(VALID_BODY), ctx);
    expect(response.status).toBe(409);
  });
});
