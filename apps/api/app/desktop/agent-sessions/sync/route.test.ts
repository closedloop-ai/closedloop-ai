import { gzipSync } from "node:zlib";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  DesktopAgentSessionsAckReason,
  DesktopAgentSessionsSyncErrorCode,
  SYNC_CONTENT_ENCODING_HEADER,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import { DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID } from "@repo/api/src/types/desktop-sync-ack-detail";
import { Result, Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS } from "@/lib/fixed-window-rate-limiter";

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

const COMPUTE_TARGET_ID = "11111111-1111-7111-8111-111111111111";

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
    expect(mocks.sync).toHaveBeenCalledWith(
      {
        clerkUserId: "clerk-user-1",
        computeTargetId: COMPUTE_TARGET_ID,
        organizationId: "org-1",
        rawBody: payload,
        userId: "user-1",
      },
      undefined
    );
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
      details: { reason: DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID },
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  // ISS-8734: `ComputeTarget.id` is `@db.Uuid`; a malformed id used to reach
  // the ownership lookup as a P2023 and come back as a retryable 500.
  //
  // `details.reason` is asserted, not incidental. The 500 this replaced mapped
  // to `IngestionFailed` — lane-wide, budget-neutral, self-healing. A 400 maps
  // to `ValidationFailed` and is charged to the rows in flight, so without a
  // reason the desktop can discriminate on, three of these dead-letter them
  // NON-recoverably (`agent-session-sync-validation-failure.ts`). Dropping the
  // field here converts a self-healing failure into permanent local data loss.
  it("rejects a malformed computeTargetId as a 400 before invoking sync", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.example.test/desktop/agent-sessions/sync?computeTargetId=abc",
        {
          body: JSON.stringify({
            schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
            sessions: [],
          }),
          method: "POST",
        }
      ),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "computeTargetId must be a UUID",
      details: { reason: DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID },
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON before invoking sync", async () => {
    const response = await POST(
      new NextRequest(
        `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
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

  // FEA-3425: the desktop must re-resolve identity on `target_not_owned`
  // (waiting cannot fix a wrong id).
  it("maps target-ownership rejections to a coded forbidden", async () => {
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
    // ISS-10014: the throttle also states HOW LONG, per `apps/api/AGENTS.md`
    // ("assert both the body metadata and header"). The value is derived from
    // the limiter's own window rather than written down here, so a change to
    // that window cannot leave the route telling clients a stale number.
    expect(response.headers.get("Retry-After")).toBe(
      String(FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS)
    );
  });

  it("ISS-10014: sends no Retry-After on a rejection a wait cannot fix", async () => {
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

    expect(response.status).toBe(400);
    // The header is OMITTED, not sent empty or zero: a desktop that read a
    // `Retry-After` here would defer a payload rejection that waiting cannot
    // fix, and the absent case is the one an older server produces for every
    // status — so it has to stay distinguishable on the wire.
    expect(response.headers.get("Retry-After")).toBeNull();
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
    expect(mocks.sync).toHaveBeenCalledWith(
      {
        clerkUserId: "clerk-user-1",
        computeTargetId: COMPUTE_TARGET_ID,
        organizationId: "org-1",
        rawBody: payload,
        userId: "user-1",
      },
      undefined
    );
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
      expect.objectContaining({ rawBody: payload }),
      undefined
    );
  });

  // FEA-4138: a Content-Encoding: gzip header over a body that is NOT valid gzip
  // is a bad request, not a crash.
  it("rejects a gzip-declared body that is not valid gzip", async () => {
    const response = await POST(
      new NextRequest(
        `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
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
  // FEA-4138 established that a compressed request whose body stream errors or
  // is cancelled mid-read (client disconnect, aborted upload) must resolve to a
  // route envelope rather than leaking the reader rejection into the handler.
  // ISS-8688 changes WHICH envelope: a stream that failed to deliver its body is
  // a read failure, and answering 400 is the misattribution the ticket exists to
  // remove — this lane saturates under pool pressure, and calling that a client
  // error points production triage at the wrong system. The requirement that it
  // never reach `sync` is unchanged.
  it("returns a 500 when the compressed request stream errors mid-read", async () => {
    const response = await POST(erroringGzipRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Failed to read request body",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  // ISS-8688: the desktop write lanes read bodies through their own bounded
  // helpers and never reach `parseBody`, so they need the same classification.
  it("returns a 500 for an uncompressed body short of its Content-Length", async () => {
    const response = await POST(truncatedRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Failed to read request body",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("returns a 500 for a compressed body short of its Content-Length", async () => {
    const response = await POST(truncatedGzipRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Failed to read request body",
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  // The complement: a complete body is not reclassified just because a
  // Content-Length is present. Without this, a predicate that always fired
  // would pass every case above.
  it("still returns a 400 for a complete malformed uncompressed body", async () => {
    const response = await POST(malformedRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ success: false, error: "Invalid JSON body" });
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});

function shortStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function truncatedRequest(): NextRequest {
  const partial = Buffer.from('{"protocolVersion":1,"sessions":[');
  return new NextRequest(
    `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
    {
      duplex: "half",
      body: shortStream(new Uint8Array(partial)),
      method: "POST",
      headers: { "Content-Length": String(partial.byteLength + 8) },
    } as ConstructorParameters<typeof NextRequest>[1]
  );
}

function truncatedGzipRequest(): NextRequest {
  const whole = gzipSync(
    Buffer.from(JSON.stringify({ protocolVersion: 1, sessions: [] }))
  );
  const partial = whole.subarray(0, whole.byteLength - 4);
  return new NextRequest(
    `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
    {
      duplex: "half",
      body: shortStream(new Uint8Array(partial)),
      method: "POST",
      headers: {
        [SYNC_CONTENT_ENCODING_HEADER]: SyncPayloadEncoding.Gzip,
        "Content-Length": String(whole.byteLength),
      },
    } as ConstructorParameters<typeof NextRequest>[1]
  );
}

function malformedRequest(): NextRequest {
  const bytes = Buffer.from("not valid json");
  return new NextRequest(
    `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
    {
      duplex: "half",
      body: shortStream(new Uint8Array(bytes)),
      method: "POST",
      headers: { "Content-Length": String(bytes.byteLength) },
    } as ConstructorParameters<typeof NextRequest>[1]
  );
}

function request(body: unknown): NextRequest {
  return new NextRequest(
    `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
    {
      body: JSON.stringify(body),
      method: "POST",
    }
  );
}

function gzipRequest(body: unknown): NextRequest {
  return new NextRequest(
    `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
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
    `https://api.example.test/desktop/agent-sessions/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
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
