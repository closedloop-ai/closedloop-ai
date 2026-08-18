/**
 * FEA-3425 (PLN-1437 Phase 1): failure-translation matrix for the HTTP
 * agent-session sync transport. This is the genuinely novel logic of the
 * write-side migration — the server handler is shared with the socket path,
 * but the mapping of HTTP outcomes onto the client ack taxonomy is new and
 * every misclassification has a durability cost (budget burn, wrong
 * dead-letter class, or a permanently parked lane).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  AgentSessionSyncMode,
  DesktopAgentSessionsSyncErrorCode,
  SYNC_CONTENT_ENCODING_HEADER,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionSyncTransportPayload } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  AGENT_SESSIONS_HTTP_REQUEST_TIMEOUT_MS,
  createDesktopAgentSessionsClient,
} from "../src/main/agent-sync/desktop-agent-sessions-client.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";

const TOKEN = "session-token-1";
const ORIGIN = "https://api.example.test";
const TARGET = "target-1";
const NETWORK_FAILURE_PATTERN = /fetch failed/;
const ORIGIN_UNAVAILABLE_PATTERN = /API origin unavailable/;

function makeBatch(): AgentSessionSyncTransportPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-1",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 0,
    sessions: [],
  };
}

type FetchCall = { url: URL; init: RequestInit };

function makeClient(
  respond: (url: URL, init: RequestInit) => Response | Promise<Response>,
  overrides?: {
    getAccessToken?: () => Promise<string | null>;
    getApiOrigin?: () => string | undefined;
    onUnauthorized?: () => void;
  }
): {
  client: ReturnType<typeof createDesktopAgentSessionsClient>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const client = createDesktopAgentSessionsClient({
    fetch: ((input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input));
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url, init ?? {}));
    }) as typeof fetch,
    getAccessToken: overrides?.getAccessToken ?? (async () => TOKEN),
    getApiOrigin: overrides?.getApiOrigin ?? (() => ORIGIN),
    onUnauthorized: overrides?.onUnauthorized,
  });
  return { client, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("FEA-3425: accepted batch resolves to an accepted ack over the authenticated route", async () => {
  const { client, calls } = makeClient(() =>
    jsonResponse(200, { success: true, data: { synced: true } })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, { accepted: true });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, "/desktop/agent-sessions/sync");
  assert.equal(url.searchParams.get("computeTargetId"), TARGET);
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(init.body)), makeBatch());
});

test("goal stage 2: a success response carrying acceptedSessionIds surfaces them on the ack", async () => {
  const { client } = makeClient(() =>
    jsonResponse(200, {
      success: true,
      data: { synced: true, acceptedSessionIds: ["s-1", "s-2"] },
    })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: true,
    acceptedSessionIds: ["s-1", "s-2"],
  });
});

test("goal stage 2: a legacy success response (no echo) yields an ack WITHOUT the field — omission preserved, not undefined", async () => {
  // An older server (or a batch that did not opt in) answers `{ synced: true }`
  // alone. The ack must OMIT `acceptedSessionIds` (whole-batch fallback keys on
  // absence), never serialize an explicit `undefined`.
  const { client } = makeClient(() =>
    jsonResponse(200, { success: true, data: { synced: true } })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, { accepted: true });
  assert.ok(
    !Object.hasOwn(ack, "acceptedSessionIds"),
    "the field is omitted entirely on a legacy-shape response"
  );
});

test("FEA-3425: a missing session token short-circuits to unauthenticated without touching the network", async () => {
  const { client, calls } = makeClient(
    () => jsonResponse(200, { success: true, data: { synced: true } }),
    { getAccessToken: async () => null }
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.Unauthenticated,
  });
  assert.equal(calls.length, 0);
});

test("FEA-3425: a thrown token read maps to unauthenticated without touching the network", async () => {
  const { client, calls } = makeClient(
    () => jsonResponse(200, { success: true, data: { synced: true } }),
    {
      getAccessToken: () => Promise.reject(new Error("keychain unavailable")),
    }
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.Unauthenticated,
  });
  assert.equal(calls.length, 0);
});

test("FEA-3425: HTTP 401 maps to unauthenticated", async () => {
  const { client } = makeClient(() =>
    jsonResponse(401, { success: false, error: "Unauthorized" })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.Unauthenticated,
  });
});

test("FEA-3425: HTTP 401 reports the rejected credential via onUnauthorized; other statuses never do", async () => {
  let invalidations = 0;
  const onUnauthorized = () => {
    invalidations += 1;
  };
  const { client } = makeClient(
    () => jsonResponse(401, { success: false, error: "Unauthorized" }),
    { onUnauthorized }
  );

  await client.sendBatch(makeBatch(), TARGET);
  assert.equal(invalidations, 1);

  const { client: forbiddenClient } = makeClient(
    () => jsonResponse(403, { success: false, error: "Forbidden" }),
    { onUnauthorized }
  );

  await forbiddenClient.sendBatch(makeBatch(), TARGET);
  assert.equal(
    invalidations,
    1,
    "a non-401 failure must not invalidate the cached credential"
  );
});

test("FEA-3425: coded 403 feature_disabled maps to feature-disabled", async () => {
  const { client } = makeClient(() =>
    jsonResponse(403, {
      success: false,
      error: "Forbidden",
      code: DesktopAgentSessionsSyncErrorCode.FeatureDisabled,
    })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.FeatureDisabled,
  });
});

test("FEA-3425: coded 403 target_not_owned maps to target-not-owned", async () => {
  const { client } = makeClient(() =>
    jsonResponse(403, {
      success: false,
      error: "Forbidden",
      code: DesktopAgentSessionsSyncErrorCode.TargetNotOwned,
    })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.TargetNotOwned,
  });
});

test("FEA-3425: an UNCODED 403 (pre-FEA-3425 server) maps to target-not-owned, never feature-disabled", async () => {
  // Treating an ambiguous 403 as capability-off would park a wrong/stale
  // computeTargetId in a backoff that waiting can never clear; the
  // target-not-owned class defers with budgets intact and surfaces loudly.
  const { client } = makeClient(() =>
    jsonResponse(403, { success: false, error: "Forbidden" })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.TargetNotOwned,
  });
});

test("FEA-3425: 400 and 413 map to validation-failed", async () => {
  for (const status of [400, 413]) {
    const { client } = makeClient(() =>
      jsonResponse(status, { success: false, error: "rejected" })
    );

    const ack = await client.sendBatch(makeBatch(), TARGET);

    assert.deepEqual(ack, {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
  }
});

test("FEA-3425: 429 maps to rate-limited", async () => {
  const { client } = makeClient(() =>
    jsonResponse(429, {
      success: false,
      error: "Rate limited",
      code: DesktopAgentSessionsSyncErrorCode.RateLimited,
    })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.RateLimited,
  });
});

test("FEA-3425: 5xx (coded or not) and unexpected statuses map to ingestion-failed", async () => {
  for (const [status, body] of [
    [
      500,
      {
        success: false,
        error: "boom",
        code: DesktopAgentSessionsSyncErrorCode.IngestionFailed,
      },
    ],
    [
      500,
      {
        success: false,
        error: "boom",
        code: DesktopAgentSessionsSyncErrorCode.InternalError,
      },
    ],
    [502, { success: false, error: "bad gateway" }],
    // Deploy skew (route missing) must stay in a BOUNDED retry class — an
    // unbudgeted defer would loop quietly forever.
    [404, { success: false, error: "not found" }],
  ] as const) {
    const { client } = makeClient(() => jsonResponse(status, body));

    const ack = await client.sendBatch(makeBatch(), TARGET);

    assert.deepEqual(ack, {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
  }
});

test("FEA-3425: a 2xx with an unrecognizable body maps to ingestion-failed, not accepted", async () => {
  const { client } = makeClient(
    () => new Response("<html>proxy page</html>", { status: 200 })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.IngestionFailed,
  });
});

test("ISS-5088: a CLIENT-side abort maps to transport-timeout, not ack-timeout", async () => {
  // The local deadline fired and the server never answered, so nothing about
  // this batch was judged. Classifying it `AckTimeout` (pre-ISS-5088) charged the
  // session's dead-letter budget for what production shows to be a lane-wide
  // stall — the same windows abort the component lane's POST and ping-timeout the
  // relay socket, which one session's payload cannot cause.
  assert.equal(AGENT_SESSIONS_HTTP_REQUEST_TIMEOUT_MS, 30_000);
  const { client } = makeClient(() => {
    throw new DOMException("timed out", "TimeoutError");
  });

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.TransportTimeout,
  });
});

test("ISS-5088: a SERVER-answered 408 still maps to ack-timeout (batch-attributable)", async () => {
  // The counterpart to the test above: the server received the batch and gave up
  // on it, so the verdict IS about this payload and keeps the row-attributable
  // `MAX_CONSECUTIVE_TIMEOUTS` budget it has always had.
  const { client } = makeClient(() =>
    jsonResponse(408, { success: false, error: "Request Timeout" })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.AckTimeout,
  });
});

test("FEA-3425: a network failure THROWS (socket-drop parity) so the thrown-transport budget applies", async () => {
  const { client } = makeClient(() => {
    throw new TypeError("fetch failed");
  });

  await assert.rejects(
    () => client.sendBatch(makeBatch(), TARGET),
    NETWORK_FAILURE_PATTERN
  );
});

test("FEA-3425: a missing API origin THROWS (local config fault), never an unauthenticated defer", async () => {
  const { client, calls } = makeClient(
    () => jsonResponse(200, { success: true, data: { synced: true } }),
    { getApiOrigin: () => undefined }
  );

  await assert.rejects(
    () => client.sendBatch(makeBatch(), TARGET),
    ORIGIN_UNAVAILABLE_PATTERN
  );
  assert.equal(calls.length, 0);
});

test("FEA-4138: compress option gzips the body and stamps Content-Encoding: gzip", async () => {
  const { client, calls } = makeClient(() =>
    jsonResponse(200, { success: true, data: { synced: true } })
  );
  const batch: AgentSessionSyncTransportPayload = {
    ...makeBatch(),
    encoding: SyncPayloadEncoding.Gzip,
  };

  const ack = await client.sendBatch(batch, TARGET, { compress: true });

  assert.deepEqual(ack, { accepted: true });
  const { init } = calls[0];
  const headers = init.headers as Record<string, string>;
  assert.equal(headers[SYNC_CONTENT_ENCODING_HEADER], SyncPayloadEncoding.Gzip);
  // The body is gzip bytes, not JSON text — decompressing recovers the batch.
  const bodyBytes = Buffer.from(init.body as Uint8Array);
  assert.notEqual(bodyBytes.toString("utf8"), JSON.stringify(batch));
  assert.deepEqual(JSON.parse(gunzipSync(bodyBytes).toString("utf8")), batch);
});

test("FEA-4138 skew: without the compress option the body stays plain JSON with no encoding header", async () => {
  const { client, calls } = makeClient(() =>
    jsonResponse(200, { success: true, data: { synced: true } })
  );

  await client.sendBatch(makeBatch(), TARGET);

  const { init } = calls[0];
  const headers = init.headers as Record<string, string>;
  assert.equal(headers[SYNC_CONTENT_ENCODING_HEADER], undefined);
  assert.deepEqual(JSON.parse(String(init.body)), makeBatch());
});

// ISS-5090: an opaque `validation_failed` gave an operator no way to tell a
// genuine local-data defect from client/server schema skew. The server's stable,
// value-free field/path summary must survive the HTTP boundary onto the ack.
test("ISS-5090: a coded 400 carries the server's field/path detail onto the ack", async () => {
  const { client } = makeClient(() =>
    jsonResponse(400, {
      success: false,
      error: "Invalid agent-session sync payload",
      code: DesktopAgentSessionsSyncErrorCode.ValidationFailed,
      details: { reason: "session_count_mismatch" },
    })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.ValidationFailed,
    detail: "session_count_mismatch",
  });
});

// Version skew both ways: an OLDER server sends no `details` at all, and a
// proxy/deploy-skew body can carry a non-string one. Neither may change the
// classification, and neither may add a `detail` key the ack contract would then
// serialize as `undefined`.
test("ISS-5090 skew: a 400 without a usable detail omits the key entirely", async () => {
  for (const body of [
    {
      success: false,
      error: "Invalid agent-session sync payload",
      code: DesktopAgentSessionsSyncErrorCode.ValidationFailed,
    },
    {
      success: false,
      error: "Invalid agent-session sync payload",
      code: DesktopAgentSessionsSyncErrorCode.ValidationFailed,
      details: { reason: 42 },
    },
    {
      success: false,
      error: "Invalid agent-session sync payload",
      code: DesktopAgentSessionsSyncErrorCode.ValidationFailed,
      details: "not-an-object",
    },
  ]) {
    const { client } = makeClient(() => jsonResponse(400, body));

    const ack = await client.sendBatch(makeBatch(), TARGET);

    assert.deepEqual(ack, {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
    assert.equal(
      Object.hasOwn(ack, "detail"),
      false,
      `an absent/unusable detail must not add the key: ${JSON.stringify(body)}`
    );
  }
});
