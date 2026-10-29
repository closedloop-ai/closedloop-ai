import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptSyncErrorReason } from "../transcript-sync-error-reason";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  planSync: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(
        { user: mocks.user, clerkUserId: null, authMethod: "api_key" },
        request
      ),
}));

// ISS-7097: the reason vocabulary lives in its own leaf module now, so this
// mock no longer has to hand-copy it to satisfy the route helper's import.
vi.mock("../service", () => ({
  transcriptSyncService: { planSync: mocks.planSync },
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
      expect.objectContaining({
        // ISS-11426: the credential kind reaches the ownership-refusal telemetry.
        authMethod: "api_key",
        organizationId: "org-1",
        userId: "user-1",
      }),
      undefined
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

  it("maps InvalidRequest to 400 after calling the service", async () => {
    mocks.planSync.mockResolvedValue({
      ok: false,
      error: TranscriptSyncErrorReason.InvalidRequest,
    });
    const response = await POST(request(VALID_BODY), ctx);
    expect(response.status).toBe(400);
    expect(mocks.planSync).toHaveBeenCalledTimes(1);
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

  // ISS-8689 / PRD-699 Appendix A: an unset TRANSCRIPTS_BUCKET is answered
  // with the same 503 status as a transient outage, but a far longer
  // Retry-After — only an admin fixing configuration resolves it.
  it("maps UpstreamNotConfigured to 503 with a long Retry-After", async () => {
    mocks.planSync.mockResolvedValue({
      ok: false,
      error: TranscriptSyncErrorReason.UpstreamNotConfigured,
    });
    const response = await POST(request(VALID_BODY), ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("3600");
  });

  // ISS-8735: an instant below Postgres's floor degrades sourceMtime to
  // undefined rather than rejecting the whole plan request.
  it.each([
    ["Postgres timestamp floor (4713 BC)", "-100000-01-01T00:00:00.000Z"],
    ["JS Date minimum", "-271821-04-20T00:00:00.000Z"],
  ])("degrades a sourceMtime below %s to undefined", async (_label, value) => {
    mocks.planSync.mockResolvedValue({
      ok: true,
      value: {
        mode: "noop",
        planEndOffset: 1000,
        syncedByteOffset: 1000,
        storedEtag: null,
      },
    });
    const response = await POST(
      request({ ...VALID_BODY, sourceMtime: value }),
      ctx
    );
    expect(response.status).toBe(200);
    expect(mocks.planSync).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ sourceMtime: undefined }),
      }),
      undefined
    );
  });

  it.each([
    ["a leap-second-style hour-24 instant", "2026-06-03T24:00:00Z"],
    ["a low 4-digit-padded year", "0050-03-04T10:00:00Z"],
  ])(
    "preserves a valid but unusual sourceMtime (%s) verbatim",
    async (_label, value) => {
      mocks.planSync.mockResolvedValue({
        ok: true,
        value: {
          mode: "noop",
          planEndOffset: 1000,
          syncedByteOffset: 1000,
          storedEtag: null,
        },
      });
      const response = await POST(
        request({ ...VALID_BODY, sourceMtime: value }),
        ctx
      );
      expect(response.status).toBe(200);
      expect(mocks.planSync).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ sourceMtime: value }),
        }),
        undefined
      );
    }
  );

  it("rejects a malformed sourceMtime with 400, without calling the service", async () => {
    const response = await POST(
      request({ ...VALID_BODY, sourceMtime: "not-a-date" }),
      ctx
    );
    expect(response.status).toBe(400);
    expect(mocks.planSync).not.toHaveBeenCalled();
  });
});
