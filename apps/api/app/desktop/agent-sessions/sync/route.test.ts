import { gzipSync } from "node:zlib";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  DesktopAgentSessionsAckReason,
  DesktopAgentSessionsSyncErrorCode,
  SYNC_CONTENT_ENCODING_HEADER,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    clerkUserId: "clerk-user-1",
    user: {
      id: "user-1",
      organizationId: "org-1",
    },
  },
  sync: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(mocks.auth, request),
}));

vi.mock("./service", () => ({
  desktopAgentSessionsSyncService: {
    sync: mocks.sync,
  },
}));

import { maxDuration, POST } from "./route";

describe("POST /desktop/agent-sessions/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sync.mockResolvedValue(Result.ok({ synced: true }));
  });

  it("passes valid targeted sync payloads to the service", async () => {
    const payload = {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      sessions: [],
    };

    const response = await POST(request(payload), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { synced: true } });
    expect(mocks.sync).toHaveBeenCalledWith({
      clerkUserId: "clerk-user-1",
      computeTargetId: "target-1",
      organizationId: "org-1",
      rawBody: payload,
      userId: "user-1",
    });
  });

  it("rejects oversized payloads before invoking sync", async () => {
    const response = await POST(
      request({ padding: "x".repeat(263_000) }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body).toEqual({
      success: false,
      error: "Request body too large",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("rejects requests without computeTargetId before reading sync data", async () => {
    const response = await POST(
      new NextRequest("https://api.example.test/desktop/agent-sessions/sync", {
        body: JSON.stringify({
          schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
          sessions: [],
        }),
        method: "POST",
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "computeTargetId is required",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON before invoking sync", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/desktop/agent-sessions/sync?computeTargetId=target-1",
        {
          body: "{not-json",
          method: "POST",
        }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid JSON body",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("maps shared feature-disabled rejections to a coded forbidden", async () => {
    mocks.sync.mockResolvedValueOnce(
      Result.err({ reason: DesktopAgentSessionsAckReason.FeatureDisabled })
    );

    const response = await POST(
      request({
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        sessions: [],
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "Forbidden",
      code: DesktopAgentSessionsSyncErrorCode.FeatureDisabled,
    });
  });

  // FEA-3425: an ownership rejection must be distinguishable from a disabled
  // capability — the desktop backs off on `feature_disabled` but must
  // re-resolve identity on `target_not_owned` (waiting cannot fix a wrong id).
  it("maps target-ownership rejections to a coded forbidden distinct from feature-disabled", async () => {
    mocks.sync.mockResolvedValueOnce(Result.err({ reason: Status.Forbidden }));

    const response = await POST(
      request({
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        sessions: [],
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: "Forbidden",
      code: DesktopAgentSessionsSyncErrorCode.TargetNotOwned,
    });
  });

  it("maps shared rate-limit rejections to a coded 429 response", async () => {
    mocks.sync.mockResolvedValueOnce(
      Result.err({ reason: DesktopAgentSessionsAckReason.RateLimited })
    );

    const response = await POST(
      request({
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        sessions: [],
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toEqual({
      success: false,
      error: "Rate limited",
      code: DesktopAgentSessionsSyncErrorCode.RateLimited,
    });
  });

  it("maps shared validation rejections to a coded 400 response", async () => {
    mocks.sync.mockResolvedValueOnce(
      Result.err({ reason: DesktopAgentSessionsAckReason.ValidationFailed })
    );

    const response = await POST(
      request({
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        sessions: [],
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid agent-session sync payload",
      code: DesktopAgentSessionsSyncErrorCode.ValidationFailed,
    });
  });

  // ISS-5090: an opaque `validation_failed` cannot tell an operator whether the
  // local row is bad or the client/server disagree about the schema. The stable,
  // value-free field/path summary must reach the desktop on the 400 body.
  it("returns the server's field/path detail on a coded 400 response", async () => {
    mocks.sync.mockResolvedValueOnce(
      Result.err({
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
        detail: "session_count_mismatch",
      })
    );

    const response = await POST(
      request({
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        sessions: [],
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid agent-session sync payload",
      code: DesktopAgentSessionsSyncErrorCode.ValidationFailed,
      details: { reason: "session_count_mismatch" },
    });
  });

  // FEA-3425: transient server-side rejection vs unexpected exception must be
  // distinguishable on the envelope — both are 500.
  it("maps ingestion failures to a coded 500 response", async () => {
    mocks.sync.mockResolvedValueOnce(
      Result.err({ reason: DesktopAgentSessionsAckReason.IngestionFailed })
    );

    const response = await POST(
      request({
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        sessions: [],
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Failed to sync agent session",
      code: DesktopAgentSessionsSyncErrorCode.IngestionFailed,
    });
  });

  it("maps unexpected exceptions to a coded 500 response", async () => {
    mocks.sync.mockRejectedValueOnce(new Error("boom"));

    const response = await POST(
      request({
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        sessions: [],
      }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Failed to sync agent session",
      code: DesktopAgentSessionsSyncErrorCode.InternalError,
    });
  });

  // FEA-3425: the desktop client aborts at 30s; the function must outlive it so
  // a slow upsert commits and the retry hits the idempotent upsert.
  it("declares an explicit function duration ceiling above the client timeout", () => {
    expect(maxDuration).toBe(60);
  });

  // FEA-4138: a gzip body decompresses to the SAME rawBody the service would
  // have received uncompressed — so ingest is byte-for-byte equal across skew.
  it("decompresses a gzip body and passes the decoded payload to sync", async () => {
    const payload = {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: "550e8400-e29b-41d4-a716-446655440000",
      syncMode: "incremental",
      sessionCount: 0,
      sessions: [],
      encoding: SyncPayloadEncoding.Gzip,
    };

    const response = await POST(gzipRequest(payload), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { synced: true } });
    // The decompressed rawBody is structurally identical to the sent payload.
    expect(mocks.sync).toHaveBeenCalledWith({
      clerkUserId: "clerk-user-1",
      computeTargetId: "target-1",
      organizationId: "org-1",
      rawBody: payload,
      userId: "user-1",
    });
  });

  // FEA-4138 skew: a legacy uncompressed body (no encoding header) still ingests
  // — the same assertion set the compressed test verifies, opposite branch.
  it("still ingests a legacy uncompressed body with no encoding header", async () => {
    const payload = {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      sessions: [],
    };

    const response = await POST(request(payload), routeContext());

    expect(response.status).toBe(200);
    const call = mocks.sync.mock.calls[0][0] as { rawBody: unknown };
    expect(call.rawBody).toEqual(payload);
  });

  // FEA-4138 zip-bomb guard: a body whose decompressed size blows past the
  // ceiling is rejected with a 400, never buffered to OOM, and sync never runs.
  it("rejects an over-ceiling decompressed gzip body without reaching sync", async () => {
    // Highly-compressible payload past the 16 MiB ceiling: gzips well under the
    // 256 KiB request cap but decompresses past what the route will accept.
    // ISS-5992 raised the ceiling 4 MiB -> 16 MiB, so this case is now sized
    // against the new one — an 8 MiB body is legitimate traffic and is asserted
    // to SUCCEED by the test below.
    const bomb = { padding: "a".repeat(24 * 1024 * 1024) };
    const response = await POST(gzipRequest(bomb), routeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid compressed body",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  // ISS-5992: the behaviour the ticket asks for. A legitimate session that
  // decompresses past the OLD 4 MiB ceiling is ACCEPTED rather than answered
  // `Invalid compressed body` — which the desktop maps to `validation_failed`
  // and dead-letters, i.e. permanent loss of a real session.
  it("accepts a gzip body that decompresses past the OLD 4 MiB ceiling", async () => {
    const payload = {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: "550e8400-e29b-41d4-a716-446655440001",
      syncMode: "incremental",
      sessionCount: 0,
      sessions: [],
      encoding: SyncPayloadEncoding.Gzip,
      // 8 MiB decompressed: over the old ceiling, under the new one, and well
      // inside the 256 KiB compressed request cap once gzipped.
      padding: "a".repeat(8 * 1024 * 1024),
    };

    const response = await POST(gzipRequest(payload), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledWith(
      expect.objectContaining({ rawBody: payload })
    );
  });

  // FEA-4138: a Content-Encoding: gzip header over a body that is NOT valid gzip
  // is a bad request, not a crash.
  it("rejects a gzip-declared body that is not valid gzip", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/desktop/agent-sessions/sync?computeTargetId=target-1",
        {
          body: "not-gzip-bytes",
          method: "POST",
          headers: { [SYNC_CONTENT_ENCODING_HEADER]: SyncPayloadEncoding.Gzip },
        }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid compressed body",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  // FEA-4138: a compressed request whose body stream errors or is cancelled
  // mid-read (client disconnect, aborted upload) must resolve to the route's
  // 400 envelope, not leak the reader rejection into the handler's generic 500.
  it("returns a 400 when the compressed request stream errors mid-read", async () => {
    const response = await POST(erroringGzipRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "Invalid compressed body",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});

function request(body: unknown): NextRequest {
  return new NextRequest(
    "https://api.example.test/desktop/agent-sessions/sync?computeTargetId=target-1",
    {
      body: JSON.stringify(body),
      method: "POST",
    }
  );
}

function gzipRequest(body: unknown): NextRequest {
  return new NextRequest(
    "https://api.example.test/desktop/agent-sessions/sync?computeTargetId=target-1",
    {
      body: gzipSync(Buffer.from(JSON.stringify(body))),
      method: "POST",
      headers: { [SYNC_CONTENT_ENCODING_HEADER]: SyncPayloadEncoding.Gzip },
    }
  );
}

function erroringGzipRequest(): NextRequest {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("stream aborted"));
    },
  });
  return new NextRequest(
    "https://api.example.test/desktop/agent-sessions/sync?computeTargetId=target-1",
    {
      duplex: "half",
      body,
      method: "POST",
      headers: { [SYNC_CONTENT_ENCODING_HEADER]: SyncPayloadEncoding.Gzip },
    }
  );
}

function routeContext(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({}) };
}
