import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TIMEOUT_MS,
  resolveRequestTimeoutMs,
} from "../src/main/ipc/cloud-api-fetch-ipc.js";
import {
  CLOUD_API_FETCH_MAX_TIMEOUT_MS,
  CloudApiFetchErrorReason,
} from "../src/shared/cloud-api-fetch-contract.js";
import {
  API_ORIGIN,
  createHarness,
  UNTRUSTED_EVENT,
} from "./cloud-api-fetch-ipc-test-harness.js";

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;
const ORIGIN_UNSET_ERROR = /api origin unset/;
const SOCKET_HANG_UP_ERROR = /socket hang up/;
const GET_BODY_ERROR = /request bodies are not supported for GET/;
const NOT_ALLOWLISTED_ERROR = /is not an allowlisted write endpoint/;
const BODY_READ_ERROR = /body stream aborted/;

// A representative allowlisted write target: creating a root trace comment on a
// session. The id is a single opaque segment, matching the real
// `traceCommentsPath` shape.
const TRACE_COMMENTS_PATH = "/agent-sessions/sess-1/trace-comments";
const TRACE_COMMENT_MEMBER_PATH = `${TRACE_COMMENTS_PATH}/comment-1`;
const TRACE_COMMENT_REPLIES_PATH = `${TRACE_COMMENT_MEMBER_PATH}/replies`;

test("rejects untrusted senders before touching anything", async () => {
  const { invoke, fetchCalls } = createHarness();
  await assert.rejects(
    async () => await invoke({ path: "/agent-sessions" }, UNTRUSTED_EVENT),
    UNTRUSTED_SENDER_ERROR
  );
  assert.equal(fetchCalls.length, 0);
});

test("executes an authenticated request against the configured origin", async () => {
  const { invoke, fetchCalls } = createHarness();
  const result = await invoke({
    path: "/agent-sessions?limit=10",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      // Renderer-side sentinel and any spoofed headers must be dropped.
      Authorization: "Bearer sentinel-from-renderer",
      "X-Organization-Id": "org-spoofed",
      "X-Evil": "1",
    },
  });

  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url.toString(), `${API_ORIGIN}/agent-sessions?limit=10`);
  const headers = call.init.headers as Headers;
  assert.equal(headers.get("authorization"), "Bearer real-access-token");
  assert.equal(headers.get("x-organization-id"), "org-1");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-evil"), null);

  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.equal(result.status, 200);
    assert.equal(result.statusText, "OK");
    assert.deepEqual(JSON.parse(result.bodyText), { success: true, data: [] });
    assert.ok(
      result.headers.some(
        ([name, value]) =>
          name.toLowerCase() === "content-type" && value === "application/json"
      )
    );
  }
});

test("signed-out short-circuits to a 401 ApiResult envelope without fetching", async () => {
  const { invoke, fetchCalls } = createHarness({
    getAccessToken: () => Promise.resolve(null),
  });
  const result = await invoke({ path: "/agent-sessions" });
  assert.equal(fetchCalls.length, 0);
  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.equal(result.status, 401);
    assert.deepEqual(JSON.parse(result.bodyText), {
      success: false,
      error: "Desktop is not signed in.",
    });
  }
});

test("rejects paths that escape the configured origin", async () => {
  const { invoke, fetchCalls } = createHarness();

  for (const path of [
    "//evil.example/steal",
    "https://evil.example/steal",
    "steal",
  ]) {
    const result = await invoke({ path });
    assert.equal(result.kind, "network-error", `path ${path} must not fetch`);
  }
  assert.equal(fetchCalls.length, 0);
});

test("rejects malformed requests and disallowed methods", async () => {
  const { invoke, fetchCalls } = createHarness();

  for (const request of [
    null,
    "GET /x",
    { path: 42 },
    { path: "/x", headers: { a: 1 } },
    { path: "/x", body: { json: true } },
    // The request schema is strict: unknown fields are rejected rather than
    // silently ignored.
    { path: "/x", upstreamUrl: "https://evil.example" },
  ]) {
    const result = await invoke(request);
    assert.equal(result.kind, "network-error");
  }
  // Methods outside the understood set are rejected regardless of path.
  for (const method of ["TRACE", "PUT", "OPTIONS", "HEAD"]) {
    const result = await invoke({ path: TRACE_COMMENTS_PATH, method });
    assert.equal(result.kind, "network-error", `${method} must be rejected`);
  }
  // The mutating methods ARE understood now, but only against an allowlisted
  // path: `/x` is not a trace-comment route, so each is rejected before fetch.
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const result = await invoke({ path: "/x", method });
    assert.equal(result.kind, "network-error", `${method} /x must be rejected`);
    if (result.kind === "network-error") {
      assert.match(result.message, NOT_ALLOWLISTED_ERROR);
    }
  }
  assert.equal(fetchCalls.length, 0);
});

test("rejects a GET request body (bodies are for mutations only)", async () => {
  const { invoke, fetchCalls } = createHarness();
  const result = await invoke({ path: "/agent-sessions", body: '{"a":1}' });
  assert.equal(result.kind, "network-error");
  if (result.kind === "network-error") {
    assert.match(result.message, GET_BODY_ERROR);
  }
  assert.equal(fetchCalls.length, 0);
});

test("POST to an allowlisted trace-comments path round-trips with body + auth", async () => {
  const { invoke, fetchCalls } = createHarness(
    {},
    new Response(JSON.stringify({ id: "comment-1", body: "hi" }), {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json" },
    })
  );
  const body = JSON.stringify({ anchor: { traceId: "t" }, body: "hi" });
  const result = await invoke({
    path: TRACE_COMMENTS_PATH,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // A compromised renderer's spoofed credential/org must still be dropped
      // on the write path exactly as on the read path.
      Authorization: "Bearer sentinel-from-renderer",
      "X-Organization-Id": "org-spoofed",
    },
    body,
  });

  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url.toString(), `${API_ORIGIN}${TRACE_COMMENTS_PATH}`);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body, body);
  const headers = call.init.headers as Headers;
  // Main-injected credential + org, renderer values dropped.
  assert.equal(headers.get("authorization"), "Bearer real-access-token");
  assert.equal(headers.get("x-organization-id"), "org-1");
  assert.equal(headers.get("content-type"), "application/json");

  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.equal(result.status, 201);
    assert.deepEqual(JSON.parse(result.bodyText), {
      id: "comment-1",
      body: "hi",
    });
  }
});

test("POST reply, PATCH edit, and DELETE reach their allowlisted trace-comment routes", async () => {
  for (const { path, method } of [
    { path: TRACE_COMMENT_REPLIES_PATH, method: "POST" },
    { path: TRACE_COMMENT_MEMBER_PATH, method: "PATCH" },
    { path: TRACE_COMMENT_MEMBER_PATH, method: "DELETE" },
    // Branch-scoped targets are allowlisted too.
    { path: "/branches/br-1/trace-comments", method: "POST" },
    { path: "/branches/br-1/trace-comments/c-1", method: "DELETE" },
  ]) {
    const { invoke, fetchCalls } = createHarness();
    const result = await invoke({
      path,
      method,
      ...(method === "DELETE" ? {} : { body: "{}" }),
    });
    assert.equal(result.kind, "response", `${method} ${path} must fetch`);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].init.method, method);
  }
});

test("rejects a mutation to a non-allowlisted path with the org token untouched", async () => {
  // Even valid-looking cloud mutations outside the trace-comment allowlist must
  // be refused: the renderer must not be able to POST/DELETE arbitrary org
  // resources with the main-held credential (no blanket mutation proxy).
  for (const { path, method } of [
    { path: "/agent-sessions/sess-1", method: "DELETE" },
    {
      path: "/agent-sessions/sess-1/trace-comments/c-1/replies",
      method: "PATCH",
    },
    { path: "/branches/br-1", method: "POST" },
    { path: "/organizations/org-1/members", method: "POST" },
    // Trace-comments as a query suffix must not widen the allowlist.
    { path: "/agent-sessions/sess-1?x=/trace-comments", method: "POST" },
    // A nested/deeper path than the allowlisted member route.
    {
      path: "/agent-sessions/sess-1/trace-comments/c-1/extra",
      method: "DELETE",
    },
  ]) {
    const { invoke, fetchCalls } = createHarness();
    const result = await invoke({ path, method, body: "{}" });
    assert.equal(
      result.kind,
      "network-error",
      `${method} ${path} must be rejected`
    );
    if (result.kind === "network-error") {
      assert.match(result.message, NOT_ALLOWLISTED_ERROR);
    }
    assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
  }
});

test("rejects a write from an untrusted sender before the allowlist check", async () => {
  const { invoke, fetchCalls } = createHarness();
  await assert.rejects(
    async () =>
      await invoke(
        { path: TRACE_COMMENTS_PATH, method: "POST", body: "{}" },
        UNTRUSTED_EVENT
      ),
    UNTRUSTED_SENDER_ERROR
  );
  assert.equal(fetchCalls.length, 0);
});

test("a signed-out write short-circuits to 401 without fetching", async () => {
  const { invoke, fetchCalls } = createHarness({
    getAccessToken: () => Promise.resolve(null),
  });
  const result = await invoke({
    path: TRACE_COMMENTS_PATH,
    method: "POST",
    body: "{}",
  });
  assert.equal(fetchCalls.length, 0);
  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.equal(result.status, 401);
  }
});

test("a cross-origin write is rejected by the origin guard before the allowlist", async () => {
  const { invoke, fetchCalls } = createHarness();
  // Protocol-relative path re-targets the host while still starting with "/".
  const result = await invoke({
    path: "//evil.example/agent-sessions/s/trace-comments",
    method: "POST",
    body: "{}",
  });
  assert.equal(result.kind, "network-error");
  assert.equal(fetchCalls.length, 0);
});

test("signed-out wins over a bad origin: 401 envelope, not a network error", async () => {
  const { invoke, fetchCalls } = createHarness({
    getAccessToken: () => Promise.resolve(null),
    resolveApiOrigin: () => {
      throw new Error("api origin unset");
    },
  });
  const result = await invoke({ path: "/agent-sessions" });
  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.equal(result.status, 401);
  }
  assert.equal(fetchCalls.length, 0);
});

test("maps an unconfigured API origin to a network error", async () => {
  const { invoke, fetchCalls } = createHarness({
    resolveApiOrigin: () => {
      throw new Error("api origin unset");
    },
  });
  const result = await invoke({ path: "/agent-sessions" });
  assert.equal(result.kind, "network-error");
  if (result.kind === "network-error") {
    assert.match(result.message, ORIGIN_UNSET_ERROR);
  }
  assert.equal(fetchCalls.length, 0);
});

test("maps a transport failure to a network error", async () => {
  const { invoke } = createHarness({
    fetchImpl: () => Promise.reject(new Error("socket hang up")),
  });
  const result = await invoke({ path: "/agent-sessions" });
  assert.equal(result.kind, "network-error");
  if (result.kind === "network-error") {
    assert.match(result.message, SOCKET_HANG_UP_ERROR);
  }
});

test("maps a response-body read failure to a network error", async () => {
  // The upstream connected and returned headers, but reading the body stream
  // failed (e.g. a mid-stream reset). This is a distinct catch branch from a
  // transport failure and must still surface as a rejected fetch, not a
  // half-built response the renderer would try to parse.
  const brokenResponse = {
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.reject(new Error("body stream aborted")),
  } as unknown as Response;
  const { invoke } = createHarness({
    fetchImpl: () => Promise.resolve(brokenResponse),
  });
  const result = await invoke({ path: "/agent-sessions" });
  assert.equal(result.kind, "network-error");
  if (result.kind === "network-error") {
    assert.match(result.message, BODY_READ_ERROR);
  }
});

test("marshals non-2xx responses as responses, not errors", async () => {
  const { invoke } = createHarness(
    {},
    new Response(JSON.stringify({ success: false, error: "nope" }), {
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "application/json" },
    })
  );
  const result = await invoke({ path: "/agent-sessions" });
  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.equal(result.status, 403);
    assert.equal(result.statusText, "Forbidden");
  }
});

test("omits the org header when no identity is available, even if the renderer spoofs one", async () => {
  const { invoke, fetchCalls } = createHarness({ getIdentity: () => null });
  await invoke({
    path: "/agent-sessions",
    // A compromised renderer supplies its own org header. With no main identity
    // to inject, the allowlist must still drop it — org scoping is main-owned,
    // so a renderer-chosen org must never reach upstream.
    headers: { "X-Organization-Id": "org-spoofed" },
  });
  const headers = fetchCalls[0].init.headers as Headers;
  assert.equal(headers.get("x-organization-id"), null);
  assert.equal(headers.get("authorization"), "Bearer real-access-token");
});

test("a read carrying its own deadline reaches the network with that deadline armed", async () => {
  // ISS-5082: a call site that raises its deadline used to have that override
  // dropped here, so the request died at the main-process default no matter
  // what it asked for — and before that, the strict schema refused the unknown
  // `timeoutMs` field and the request never reached the network at all. Both
  // regressions are pinned clock-free: `fetchCalls.length` proves the ask was
  // not rejected as malformed, and the ARMED value proves the ask itself — not
  // the main-owned bound and not `DEFAULT_TIMEOUT_MS` — is what
  // `AbortSignal.timeout()` received. The ask is deliberately distinct from
  // both fallbacks so neither can satisfy the assertion.
  const readDeadlineMs = 120_000;
  const { invoke, fetchCalls } = createHarness({
    timeoutMs: CLOUD_API_FETCH_MAX_TIMEOUT_MS,
  });

  const { result, armedDeadlines } = await captureArmedDeadlines(() =>
    invoke({ path: "/agent-sessions", timeoutMs: readDeadlineMs })
  );

  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(armedDeadlines, [readDeadlineMs]);
  assert.equal(result.kind, "response");
});

test("a request with NO deadline reaches the network on the main-owned default", async () => {
  // The absent-deadline path is the fallback every unusable deadline degrades
  // to, so pin what it actually arms rather than inferring it from
  // `resolveRequestTimeoutMs` alone: this drives the real handler and reads the
  // number handed to `AbortSignal.timeout()`.
  const { invoke, fetchCalls } = createHarness();

  const { result, armedDeadlines } = await captureArmedDeadlines(() =>
    invoke({ path: "/agent-sessions" })
  );

  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(armedDeadlines, [DEFAULT_TIMEOUT_MS]);
  assert.equal(result.kind, "response");
});

test("an unusable deadline loses only the override, never the request", async () => {
  // A `null` (or a string, a NaN, a zero) used to sink the WHOLE request: the
  // `.strict()` schema failed, the call never reached the network, and the
  // caller was told the PATH was malformed. A deadline is the most degradable
  // field on this payload — it degrades to absent and main falls back to its
  // own bound, exactly as if the renderer had sent nothing.
  for (const timeoutMs of [null, 0, -1, Number.NaN, "300000", {}]) {
    const { invoke, fetchCalls } = createHarness();

    const { result, armedDeadlines } = await captureArmedDeadlines(() =>
      invoke({ path: "/agent-sessions", timeoutMs })
    );

    assert.equal(
      result.kind,
      "response",
      `timeoutMs ${String(timeoutMs)} must not fail the request`
    );
    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(
      armedDeadlines,
      [DEFAULT_TIMEOUT_MS],
      `timeoutMs ${String(timeoutMs)} must fall back to the main-owned default`
    );
  }
});

test("a deadline expiry is labeled as a timeout on the way back", async () => {
  // Main owns the authoritative deadline on desktop, so main is the only side
  // that can distinguish it from a dropped socket. Without the label the
  // renderer can only ever produce a generic `ApiError(msg, 0)` and desktop
  // could never reach the ISS-5013 "we stopped waiting" surface.
  const { invoke } = createHarness({
    fetchImpl: () => Promise.reject(timeoutAbortError()),
  });

  const result = await invoke({ path: "/agent-sessions", timeoutMs: 1000 });

  assert.equal(result.kind, "network-error");
  if (result.kind === "network-error") {
    assert.equal(result.reason, CloudApiFetchErrorReason.Timeout);
  }
});

test("a cause-wrapped timeout abort is still labeled a timeout", async () => {
  // Which shape arrives depends on the bundled undici: newer versions reject
  // with the signal's reason directly, older ones wrap it as `cause`.
  const wrapped = new Error("This operation was aborted");
  wrapped.name = "AbortError";
  wrapped.cause = timeoutAbortError();
  const { invoke } = createHarness({
    fetchImpl: () => Promise.reject(wrapped),
  });

  const result = await invoke({ path: "/agent-sessions", timeoutMs: 1000 });

  assert.equal(result.kind, "network-error");
  if (result.kind === "network-error") {
    assert.equal(result.reason, CloudApiFetchErrorReason.Timeout);
  }
});

test("a deadline that expires during the body read is labeled too", async () => {
  // The same signal stays armed while the response stream drains, so a slow
  // body aborts in the body-read arm rather than at the fetch. Both arms must
  // classify identically — otherwise a timeout's reported reason would depend
  // on which millisecond it landed in.
  const { invoke } = createHarness(
    {},
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(timeoutAbortError());
        },
      })
    )
  );

  const result = await invoke({ path: "/agent-sessions", timeoutMs: 1000 });

  assert.equal(result.kind, "network-error");
  if (result.kind === "network-error") {
    assert.equal(result.reason, CloudApiFetchErrorReason.Timeout);
  }
});

test("an unclassified transport failure carries no reason at all", async () => {
  // The version-skew half: anything that is not our deadline stays exactly the
  // shape that shipped before the discriminator existed — the key is OMITTED,
  // not serialized as an explicit `undefined`.
  const { invoke } = createHarness({
    fetchImpl: () => Promise.reject(new Error("socket hang up")),
  });

  const result = await invoke({ path: "/agent-sessions", timeoutMs: 1000 });

  assert.equal(result.kind, "network-error");
  if (result.kind === "network-error") {
    assert.equal(result.reason, undefined);
    assert.equal(Object.hasOwn(result, "reason"), false);
    assert.match(result.message, SOCKET_HANG_UP_ERROR);
  }
});

test("resolveRequestTimeoutMs confines the renderer's ask to clamped reads", () => {
  // A READ's own ask wins over the main-owned default — only the call site
  // knows how long its endpoint legitimately runs...
  assert.equal(resolveRequestTimeoutMs(120_000, 60_000, false), 120_000);
  // ...but a WRITE can never be LENGTHENED by it. Every long-running WRITE call
  // site is a POST that `WRITE_ALLOWLIST` already refuses, so honoring an
  // extension on a mutation would only lengthen how long a compromised renderer
  // can hold a credentialed write open.
  assert.equal(resolveRequestTimeoutMs(120_000, 60_000, true), 60_000);
  assert.equal(
    resolveRequestTimeoutMs(CLOUD_API_FETCH_MAX_TIMEOUT_MS, undefined, true),
    DEFAULT_TIMEOUT_MS
  );
  // A write's SHORTER ask is honored: this transport cannot observe the
  // renderer's abort signal, so discarding it would pin a 1s trace-comment
  // write open in main for the full main-owned bound. Same floor and
  // truncation as a read's.
  assert.equal(resolveRequestTimeoutMs(1000, 60_000, true), 1000);
  assert.equal(resolveRequestTimeoutMs(0.5, 60_000, true), 1);
  // A read's ask is never trusted: an over-long one degrades to the ceiling
  // rather than letting a compromised renderer pin the org credential open.
  assert.equal(
    resolveRequestTimeoutMs(
      CLOUD_API_FETCH_MAX_TIMEOUT_MS + 1,
      undefined,
      false
    ),
    CLOUD_API_FETCH_MAX_TIMEOUT_MS
  );
  assert.equal(
    resolveRequestTimeoutMs(Number.POSITIVE_INFINITY, undefined, false),
    CLOUD_API_FETCH_MAX_TIMEOUT_MS
  );
  // Whole milliseconds and a positive floor are enforced HERE, not inherited
  // from the schema: `z.number().positive()` admits a fractional value and
  // `AbortSignal.timeout()` throws `ERR_OUT_OF_RANGE` on one.
  assert.equal(resolveRequestTimeoutMs(1500.5, undefined, false), 1500);
  assert.equal(resolveRequestTimeoutMs(0.5, undefined, false), 1);
  // A request that asks for nothing keeps the previous behavior exactly.
  assert.equal(resolveRequestTimeoutMs(undefined, 15_000, false), 15_000);
  assert.equal(
    resolveRequestTimeoutMs(undefined, undefined, false),
    DEFAULT_TIMEOUT_MS
  );
});

test("an allowlisted write keeps the main-owned bound even when it asks for more", async () => {
  // The write path is the security-critical one: the credential is main-held,
  // so any window the renderer can widen is a window it can hold a credentialed
  // mutation open in. A trace-comment POST asking for the 5-minute ceiling must
  // still be bounded by main's own value. This is the only END-TO-END guard on
  // that rule, so it asserts the armed number rather than an abort message: if
  // the write branch regressed to the read branch the request would arm the
  // renderer's 5 minutes and still abort with an identical message, just five
  // minutes later. The bound is distinct from `DEFAULT_TIMEOUT_MS` too, so a
  // regression that fell back to the default cannot satisfy it either.
  const mainOwnedBoundMs = 30_000;
  const { invoke, fetchCalls } = createHarness({ timeoutMs: mainOwnedBoundMs });

  const { result, armedDeadlines } = await captureArmedDeadlines(() =>
    invoke({
      path: TRACE_COMMENTS_PATH,
      method: "POST",
      body: "{}",
      timeoutMs: CLOUD_API_FETCH_MAX_TIMEOUT_MS,
    })
  );

  // It reached the network (so the ask was not a malformed-request rejection),
  // and was armed on main's own bound rather than the 5 minutes the renderer
  // asked for.
  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(armedDeadlines, [mainOwnedBoundMs]);
  assert.equal(result.kind, "response");
});

/**
 * The abort a real `AbortSignal.timeout()` produces. Node rejects the fetch
 * with a `DOMException` under this exact platform-defined name; reproducing it
 * here is what lets the classification be asserted without waiting on a real
 * timer.
 */
function timeoutAbortError(): Error {
  return new DOMException(
    "The operation was aborted due to timeout",
    "TimeoutError"
  );
}

/**
 * Run `work` while recording every deadline armed via `AbortSignal.timeout()`.
 *
 * The resolved deadline is otherwise unobservable — an `AbortSignal` does not
 * expose its delay — so a handler-level test could only infer it by waiting for
 * the timer to fire, which is exactly the timing-dependent assertion the
 * desktop `test:node` determinism rule forbids. Capturing the ARGUMENT proves
 * the same fact with no clock involved. The original is restored in a `finally`
 * so a failing assertion cannot leak the patch into a later test.
 */
async function captureArmedDeadlines<T>(
  work: () => Promise<T>
): Promise<{ result: T; armedDeadlines: number[] }> {
  const armedDeadlines: number[] = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => {
    armedDeadlines.push(ms);
    return original.call(AbortSignal, ms);
  };
  try {
    return { result: await work(), armedDeadlines };
  } finally {
    AbortSignal.timeout = original;
  }
}
