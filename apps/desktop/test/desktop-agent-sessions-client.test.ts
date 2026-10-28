/**
 * FEA-3425 (PLN-1437 Phase 1): failure-translation matrix for the HTTP
 * agent-session sync transport. This is the genuinely novel logic of the
 * write-side migration — the server handler is shared with the socket path,
 * but the mapping of HTTP outcomes onto the client ack taxonomy is new and
 * every misclassification has a durability cost (budget burn, wrong
 * dead-letter class, or a permanently parked lane).
 */
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  AgentSessionSyncMode,
  DesktopAgentSessionsSyncErrorCode,
  SYNC_CONTENT_ENCODING_HEADER,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import { DesktopClientAttributionHeader } from "@repo/api/src/types/desktop-client-attribution";
import { test } from "vitest";
import type { AgentSessionSyncTransportPayload } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncTransportError } from "../src/main/agent-sync/agent-session-sync-service-helpers.js";
import {
  AGENT_SESSIONS_HTTP_REQUEST_TIMEOUT_MS,
  createDesktopAgentSessionsClient,
} from "../src/main/agent-sync/desktop-agent-sessions-client.js";
import {
  DesktopAgentSessionsAckReason,
  UNKNOWN_ACK_REASON,
} from "../src/main/cloud/cloud-protocol.js";
import {
  resetDesktopClientAttribution,
  setDesktopClientAttributionResolver,
} from "../src/main/util/desktop-client-attribution-provider.js";

const TOKEN = "session-token-1";
const ORIGIN = "https://api.example.test";
const TARGET = "target-1";
const NETWORK_FAILURE_PATTERN = /fetch failed/;
const ORIGIN_UNAVAILABLE_PATTERN = /API origin unavailable/;
const BIGINT_SERIALIZE_PATTERN = /BigInt/;

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
    onUnauthorized?: (rejectedToken: string) => void;
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

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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
  const invalidations: string[] = [];
  const onUnauthorized = (rejectedToken: string) => {
    invalidations.push(rejectedToken);
  };
  const { client } = makeClient(
    () => jsonResponse(401, { success: false, error: "Unauthorized" }),
    { onUnauthorized }
  );

  await client.sendBatch(makeBatch(), TARGET);
  assert.deepEqual(invalidations, [TOKEN]);

  const { client: forbiddenClient } = makeClient(
    () => jsonResponse(403, { success: false, error: "Forbidden" }),
    { onUnauthorized }
  );

  await forbiddenClient.sendBatch(makeBatch(), TARGET);
  assert.deepEqual(
    invalidations,
    [TOKEN],
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

  // ISS-10014: the deep-equal is also the OMISSION assertion — a server that
  // sent no `Retry-After` must not produce a `retryAfterMs` key, because the
  // fold reads absence as "no instruction" and a present key as a real one.
  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.RateLimited,
  });
});

test("ISS-10014: a 429 carrying Retry-After puts the parsed wait on the ack", async () => {
  const { client } = makeClient(() =>
    jsonResponse(
      429,
      {
        success: false,
        error: "Rate limited",
        code: DesktopAgentSessionsSyncErrorCode.RateLimited,
      },
      { "Retry-After": "600" }
    )
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(
    ack,
    {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
      retryAfterMs: 600_000,
    },
    "the delta-seconds form is read off the real response headers and carried in ms"
  );
});

test("ISS-10014: an unreadable Retry-After yields no hint rather than a fabricated one", async () => {
  const { client } = makeClient(() =>
    jsonResponse(
      429,
      {
        success: false,
        error: "Rate limited",
        code: DesktopAgentSessionsSyncErrorCode.RateLimited,
      },
      { "Retry-After": "soon" }
    )
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(
    ack,
    {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    },
    "a header we cannot parse is not evidence of any wait — inferring one from garbage is what the parser returns undefined to avoid"
  );
});

test("ISS-10014: the hint rides every rejection, including one the dispatch will not act on", async () => {
  const { client } = makeClient(() =>
    jsonResponse(
      400,
      {
        success: false,
        error: "Invalid",
        code: DesktopAgentSessionsSyncErrorCode.ValidationFailed,
      },
      { "Retry-After": "600" }
    )
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  // Not gated on the transport's class: a newer server's unknown code
  // classifies ITEM here while the dispatch routes the unknown REASON to the
  // stall fold that honors the hint, so gating here would strip it exactly on
  // the skew path. Which acks act on it is the dispatch's decision.
  assert.deepEqual(
    ack,
    {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
      retryAfterMs: 600_000,
    },
    "the transport reports what the server said; the validation branch of the dispatch simply never reads it"
  );
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

/**
 * ISS-8595 (whitlockk review) — the boundary that makes the sync lane's version-skew
 * branch reachable at all.
 *
 * Before this, `ackReasonForHttpFailure` was TOTAL over the current enum: every
 * non-2xx fell through to `ingestion_failed` and every 2xx to accepted or
 * `ingestion_failed`, so a newer cloud's rejection class could not survive
 * translation, and the lane's "treat an unrecognized reason as environmental"
 * fallback could only ever be reached by a test casting a string into the ack.
 * A branch no production input can reach changes no skew behavior.
 */
test("ISS-8595: a code NEITHER contract in this build knows survives as the version-skew class", async () => {
  const { client } = makeClient(() =>
    jsonResponse(503, {
      success: false,
      error: "quota exceeded for this tenant",
      code: "tenant_quota_exhausted",
    })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: UNKNOWN_ACK_REASON,
    // Log-only, and the reason an operator can tell which new class this was.
    unrecognizedReason: "tenant_quota_exhausted",
  });
});

/**
 * ISS-10014 (codex review) — the version-skew shape, which is the one a class
 * gate here would silently strip.
 *
 * A 422 is a status this route has never been seen to emit, so Appendix A's
 * DEFAULT table would call it ITEM; an unknown code on top of it is skew
 * evidence twice, and `ackReasonForHttpFailure` resolves it to the environmental
 * `UNKNOWN_ACK_REASON` rather than to that default. Reading `Retry-After` only
 * on the statuses this build maps to an environmental class would therefore drop
 * the hint on exactly the path the dispatch DOES honor it — the transport's
 * class and the dispatch's reason are not the same axis. Pinned with the hint
 * and the reason in ONE deep-equal so neither can regress alone.
 */
test("ISS-10014: an unknown code on a non-environmental status keeps the server's Retry-After", async () => {
  const { client } = makeClient(() =>
    jsonResponse(
      422,
      {
        success: false,
        error: "quota exceeded for this tenant",
        code: "tenant_quota_exhausted",
      },
      { "Retry-After": "600" }
    )
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(
    ack,
    {
      accepted: false,
      reason: UNKNOWN_ACK_REASON,
      retryAfterMs: 600_000,
      unrecognizedReason: "tenant_quota_exhausted",
    },
    "a newer server's unknown rejection class reaches the stall fold WITH the wait it asked for, not on the lane's own faster schedule"
  );
});

test("ISS-8595: a code the ROUTE contract already declares is not mistaken for skew", async () => {
  // The regression half, and the case that makes the negative test two-sided:
  // `internal_error` is a live route code that is deliberately NOT an ack
  // reason, so a skew check that only consulted the ack enum would reclassify
  // traffic today's server already sends. `errorCode` here is the shared const,
  // never a literal.
  for (const errorCode of Object.values(DesktopAgentSessionsSyncErrorCode)) {
    const { client } = makeClient(() =>
      jsonResponse(500, { success: false, error: "boom", code: errorCode })
    );

    const ack = await client.sendBatch(makeBatch(), TARGET);

    assert.deepEqual(
      ack,
      {
        accepted: false,
        reason: DesktopAgentSessionsAckReason.IngestionFailed,
      },
      `${errorCode} is a known route code and must keep its bounded classification`
    );
  }
});

test("ISS-8595: a recognized STATUS keeps its classification even when the body names a newer code", async () => {
  // A 400 is a verdict about these bytes whatever the server calls the class, so
  // the skew check runs only where the alternative was the catch-all. Without
  // this, a newer server that started coding its 400s would silently move
  // `validation_failed` — the one row-attributable class — onto the
  // environmental path and never dead-letter a genuinely poisoned row.
  const { client } = makeClient(() =>
    jsonResponse(400, {
      success: false,
      error: "bad",
      code: "schema_v9_violation",
    })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.ValidationFailed,
  });
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

test("ISS-5088: an HTTP 408 on the response still maps to ack-timeout", async () => {
  /* The counterpart to the test above: something answered 408 over the wire, so
     the client resolves `AckTimeout` rather than the client-abort
     `TransportTimeout`. What that classification MEANS downstream changed in
     ISS-8605 — 408 is environmental now, defers with budgets intact, and the
     `MAX_CONSECUTIVE_TIMEOUTS` budget it used to carry is deleted — but the
     mapping this test pins is unchanged. */
  const { client } = makeClient(() =>
    jsonResponse(408, { success: false, error: "Request Timeout" })
  );

  const ack = await client.sendBatch(makeBatch(), TARGET);

  assert.deepEqual(ack, {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.AckTimeout,
  });
});

test("ISS-10602: a network failure THROWS typed as a transport throw, so the lane defers instead of the row", async () => {
  const { client } = makeClient(() => {
    throw new TypeError("fetch failed");
  });

  await assert.rejects(
    () => client.sendBatch(makeBatch(), TARGET),
    (error: unknown) =>
      error instanceof AgentSessionSyncTransportError &&
      NETWORK_FAILURE_PATTERN.test(error.message)
  );
});

test("ISS-10602: a missing API origin THROWS typed as a transport throw, never an unauthenticated defer", async () => {
  const { client, calls } = makeClient(
    () => jsonResponse(200, { success: true, data: { synced: true } }),
    { getApiOrigin: () => undefined }
  );

  await assert.rejects(
    () => client.sendBatch(makeBatch(), TARGET),
    (error: unknown) =>
      error instanceof AgentSessionSyncTransportError &&
      ORIGIN_UNAVAILABLE_PATTERN.test(error.message)
  );
  assert.equal(calls.length, 0);
});

test("ISS-10602: a batch that cannot be encoded throws RAW, never typed as a transport throw", async () => {
  const { client, calls } = makeClient(() =>
    jsonResponse(200, { success: true, data: { synced: true } })
  );
  // A BigInt is what JSON.stringify refuses. Typed, this would defer the whole
  // lane on one row's bytes instead of dead-lettering that row.
  const unencodable = Object.assign(makeBatch(), { unencodable: 1n });

  await assert.rejects(
    () => client.sendBatch(unencodable, TARGET),
    (error: unknown) =>
      error instanceof TypeError &&
      !(error instanceof AgentSessionSyncTransportError) &&
      BIGINT_SERIALIZE_PATTERN.test(error.message)
  );
  assert.equal(
    calls.length,
    0,
    "an unencodable batch never reaches the network"
  );
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

/**
 * ISS-8749: the highest-volume desktop→cloud lane builds its own request init,
 * so the attribution headers have to be merged there explicitly. Asserting
 * BOTH states with the same request builder is the point — a presence-only test
 * would stay green against a client that stamped a placeholder for an install
 * that never published one.
 */
test("sync request carries the published Desktop install and build", async () => {
  resetDesktopClientAttribution();
  setDesktopClientAttributionResolver(() => ({
    installationId: "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311",
    clientVersion: "1.24.3",
  }));
  const requests: RequestInit[] = [];
  const client = createDesktopAgentSessionsClient({
    fetch: ((_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
        })
      );
    }) as typeof fetch,
    getAccessToken: () => Promise.resolve(TOKEN),
    getApiOrigin: () => ORIGIN,
  });

  await client.sendBatch(makeBatch(), TARGET);

  const headers = requests[0]?.headers as Record<string, string>;
  assert.equal(
    headers[DesktopClientAttributionHeader.InstallationId],
    "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311"
  );
  assert.equal(headers[DesktopClientAttributionHeader.ClientVersion], "1.24.3");
  // The credential must still be the credential; attribution merges beneath it.
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  resetDesktopClientAttribution();
});

test("sync request omits attribution entirely when none was published", async () => {
  resetDesktopClientAttribution();
  const requests: RequestInit[] = [];
  const client = createDesktopAgentSessionsClient({
    fetch: ((_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
        })
      );
    }) as typeof fetch,
    getAccessToken: () => Promise.resolve(TOKEN),
    getApiOrigin: () => ORIGIN,
  });

  await client.sendBatch(makeBatch(), TARGET);

  const headers = requests[0]?.headers as Record<string, string>;
  // Absent keys, not empty-string values: the server reads header presence, and
  // a blank header is a different fact from no header.
  assert.equal(
    Object.hasOwn(headers, DesktopClientAttributionHeader.InstallationId),
    false
  );
  assert.equal(
    Object.hasOwn(headers, DesktopClientAttributionHeader.ClientVersion),
    false
  );
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
});
