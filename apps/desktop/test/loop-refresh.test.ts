/**
 * Unit tests for apps/desktop/src/main/loop-refresh.ts
 *
 * Covers:
 *   - refreshLoopToken: successful HTTP refresh flow (stores meta, returns success)
 *   - refreshLoopToken: 401 non-retryable failure (including JTI_ALREADY_USED body)
 *   - refreshLoopToken: 409 RACE_LOST retry-once semantics
 *   - refreshLoopToken: second consecutive 409 after retry returns non-retryable failure
 *   - refreshLoopToken: idempotency key generation, header transmission, and persistence
 *   - refreshLoopTokenSingleflight: two concurrent callers receive the same Promise
 *   - withTokenRefreshRetry: 401 from original fn triggers refresh then retries fn
 *   - withTokenRefreshRetry: non-401 results pass through without triggering refresh
 *   - withTokenRefreshRetry: refresh failure surfaces original 401 without retry
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  refreshLoopToken,
  refreshLoopTokenSingleflight,
  withTokenRefreshRetry,
} from "../src/main/loop-refresh.js";
import type { LoopTokenStore } from "../src/main/loop-token-store.js";
import type { LoopHttpResult } from "../src/server/operations/loop-http.js";
import {
  createTestLoopTokenStore,
  makeFakeJwt,
} from "./loop-token-test-utils.js";

// ---------------------------------------------------------------------------
// Shared mock infrastructure
// ---------------------------------------------------------------------------

type CapturedRefreshRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

const originalFetch = globalThis.fetch;

let capturedRequests: CapturedRefreshRequest[] = [];
let tempRoot = "";

// ---------------------------------------------------------------------------
// Store factory — every test gets a fresh store backed by a unique temp dir.
// ---------------------------------------------------------------------------

function makeStore(name: string): LoopTokenStore {
  return createTestLoopTokenStore(tempRoot, name);
}

// ---------------------------------------------------------------------------
// Fetch stub helpers
// ---------------------------------------------------------------------------

type FetchStubResponse = {
  status: number;
  body?: string;
};

/**
 * Installs a simple sequential fetch stub: each call consumes the next
 * response in `responses`.  Remaining calls return the last entry.
 * All requests are recorded in `capturedRequests`.
 */
function installSequentialFetchStub(responses: FetchStubResponse[]): void {
  let callIndex = 0;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headersObj: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      const h = new Headers(rawHeaders);
      h.forEach((value, key) => {
        headersObj[key] = value;
      });
    }
    capturedRequests.push({
      url,
      method: init?.method ?? "GET",
      headers: headersObj,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const response = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    return new Response(response?.body ?? "", {
      status: response?.status ?? 200,
    });
  }) as typeof fetch;
}

/**
 * Installs a fetch stub that always returns the same response.
 */
function installFetchStub(response: FetchStubResponse): void {
  installSequentialFetchStub([response]);
}

/**
 * Installs a hanging fetch stub for singleflight tests: resolves only when
 * `release()` is called.
 */
function installHangingFetchStub(response: FetchStubResponse): {
  release: () => void;
  waitForFirstCall: () => Promise<void>;
} {
  let releaseResolve!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  let firstCallResolve!: () => void;
  const firstCallPromise = new Promise<void>((resolve) => {
    firstCallResolve = resolve;
  });

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headersObj: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      const h = new Headers(rawHeaders);
      h.forEach((value, key) => {
        headersObj[key] = value;
      });
    }
    capturedRequests.push({
      url,
      method: init?.method ?? "GET",
      headers: headersObj,
      body: typeof init?.body === "string" ? init.body : null,
    });
    firstCallResolve();
    await releasePromise;
    return new Response(response.body ?? "", { status: response.status });
  }) as typeof fetch;

  return { release: releaseResolve, waitForFirstCall: () => firstCallPromise };
}

// ---------------------------------------------------------------------------
// Shared valid JWT for parseJwtExpiry (exp = far future)
// ---------------------------------------------------------------------------

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
const FAKE_TOKEN = makeFakeJwt({ sub: "runner", exp: FUTURE_EXP });

beforeEach(async () => {
  capturedRequests = [];
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loop-refresh-test-"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// refreshLoopToken — successful flow
// ---------------------------------------------------------------------------

describe("refreshLoopToken: successful refresh", () => {
  test("returns success:true with populated meta and persists meta to store", async () => {
    const jti = "test-jti-001";
    const responseBody = JSON.stringify({
      token: FAKE_TOKEN,
      jti,
      expiresAt: FUTURE_EXP,
    });
    installFetchStub({ status: 200, body: responseBody });

    const store = makeStore("refresh-success");
    store.setLoopToken("loop-1", { token: "old-token" });

    const result = await refreshLoopToken(
      "loop-1",
      "https://api.example.com",
      () => "old-token",
      store
    );

    assert.equal(result.success, true);
    if (!result.success) {
      assert.fail("Expected success:true");
    }
    assert.equal(result.meta.token, FAKE_TOKEN);
    assert.equal(result.meta.jti, jti);
    assert.equal(typeof result.meta.expiresAt, "number");
    assert.ok(
      (result.meta.expiresAt ?? 0) > 0,
      "Expected expiresAt to be a positive number (ms)"
    );

    // The store should now contain the new meta
    const stored = store.getLoopToken("loop-1");
    assert.ok(stored, "Expected loop token to be stored after refresh");
    assert.equal(stored.token, FAKE_TOKEN);
    assert.equal(stored.jti, jti);
  });

  test("POSTs to the correct URL with Authorization, Content-Type, and Idempotency-Key headers", async () => {
    const responseBody = JSON.stringify({ token: FAKE_TOKEN, jti: "jti-1" });
    installFetchStub({ status: 200, body: responseBody });

    const store = makeStore("refresh-headers");
    store.setLoopToken("loop-abc", { token: "bearer-token" });

    await refreshLoopToken(
      "loop-abc",
      "https://api.example.com",
      () => "bearer-token",
      store
    );

    assert.equal(capturedRequests.length, 1);
    const req = capturedRequests[0];
    assert.ok(req, "Expected at least one captured request");
    assert.equal(
      req.url,
      "https://api.example.com/loops/loop-abc/refresh-token"
    );
    assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, "Bearer bearer-token");
    assert.equal(req.headers["content-type"], "application/json");
    assert.ok(
      typeof req.headers["idempotency-key"] === "string" &&
        req.headers["idempotency-key"].length > 0,
      `Expected non-empty Idempotency-Key header, got: ${JSON.stringify(req.headers["idempotency-key"])}`
    );
  });

  test("returns success:false with error:'missing_token' when getToken() returns null", async () => {
    installFetchStub({ status: 200, body: "{}" });

    const store = makeStore("refresh-null-token");
    const result = await refreshLoopToken(
      "loop-1",
      "https://api.example.com",
      () => null,
      store
    );

    assert.equal(result.success, false);
    if (result.success) {
      assert.fail("Expected success:false");
    }
    assert.equal(result.retryable, false);
    assert.equal(result.error, "missing_token");
    assert.equal(
      capturedRequests.length,
      0,
      "fetch must not be called when token is null"
    );
  });
});

// ---------------------------------------------------------------------------
// refreshLoopToken — 401 non-retryable failure
// ---------------------------------------------------------------------------

describe("refreshLoopToken: 401 non-retryable failure", () => {
  const cases = [
    {
      name: "plain 401 response",
      body: "Unauthorized",
    },
    {
      name: "JTI_ALREADY_USED body",
      body: JSON.stringify({
        code: "JTI_ALREADY_USED",
        message: "Token JTI already used",
      }),
    },
    {
      name: "empty body",
      body: "",
    },
  ] as const;

  for (const { name, body } of cases) {
    test(`returns success:false retryable:false on 401 (${name}) — no retry issued`, async () => {
      installFetchStub({ status: 401, body });

      const store = makeStore(`refresh-401-${name.replace(/\s/g, "-")}`);
      store.setLoopToken("loop-1", { token: "old-token" });

      const result = await refreshLoopToken(
        "loop-1",
        "https://api.example.com",
        () => "old-token",
        store
      );

      assert.equal(result.success, false);
      if (result.success) {
        assert.fail("Expected success:false");
      }
      assert.equal(result.retryable, false);
      assert.ok(
        result.error.includes("HTTP 401"),
        `Expected error to include 'HTTP 401', got: ${JSON.stringify(result.error)}`
      );
      // Must NOT retry: only one fetch call
      assert.equal(capturedRequests.length, 1, "Must not retry on 401");
    });
  }
});

// ---------------------------------------------------------------------------
// refreshLoopToken — 409 RACE_LOST retry-once semantics
// ---------------------------------------------------------------------------

describe("refreshLoopToken: 409 RACE_LOST retry", () => {
  test("retries exactly once on 409 RACE_LOST and succeeds on second attempt", async () => {
    const successBody = JSON.stringify({ token: FAKE_TOKEN, jti: "jti-retry" });
    const raceBody = JSON.stringify({ code: "RACE_LOST" });

    installSequentialFetchStub([
      { status: 409, body: raceBody },
      { status: 200, body: successBody },
    ]);

    const store = makeStore("refresh-409-race-retry");
    store.setLoopToken("loop-1", { token: "current-token" });

    const result = await refreshLoopToken(
      "loop-1",
      "https://api.example.com",
      () => "current-token",
      store
    );

    assert.equal(result.success, true);
    if (!result.success) {
      assert.fail("Expected success:true after retry");
    }
    assert.equal(result.meta.token, FAKE_TOKEN);

    // Two fetch calls: first attempt (409) + retry (200)
    assert.equal(
      capturedRequests.length,
      2,
      "Expected exactly two fetch calls (attempt + retry)"
    );
  });

  test("uses a fresh idempotency key on the retry after RACE_LOST", async () => {
    const successBody = JSON.stringify({
      token: FAKE_TOKEN,
      jti: "jti-new-key",
    });
    const raceBody = JSON.stringify({ code: "RACE_LOST" });

    installSequentialFetchStub([
      { status: 409, body: raceBody },
      { status: 200, body: successBody },
    ]);

    const store = makeStore("refresh-409-fresh-key");
    store.setLoopToken("loop-1", { token: "token" });

    await refreshLoopToken(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store
    );

    assert.equal(capturedRequests.length, 2);
    const firstKey = capturedRequests[0]?.headers["idempotency-key"];
    const retryKey = capturedRequests[1]?.headers["idempotency-key"];

    assert.ok(
      typeof firstKey === "string" && firstKey.length > 0,
      "First request must have a non-empty Idempotency-Key"
    );
    assert.ok(
      typeof retryKey === "string" && retryKey.length > 0,
      "Retry request must have a non-empty Idempotency-Key"
    );
    assert.notEqual(
      firstKey,
      retryKey,
      "Retry must use a fresh (different) Idempotency-Key after RACE_LOST"
    );
  });

  test("does NOT retry on 409 with a code other than RACE_LOST", async () => {
    const conflictBody = JSON.stringify({ code: "SOME_OTHER_CONFLICT" });
    installFetchStub({ status: 409, body: conflictBody });

    const store = makeStore("refresh-409-other-code");
    store.setLoopToken("loop-1", { token: "token" });

    const result = await refreshLoopToken(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store
    );

    assert.equal(result.success, false);
    if (result.success) {
      assert.fail("Expected success:false");
    }
    assert.ok(result.error.includes("HTTP 409"));
    assert.equal(
      capturedRequests.length,
      1,
      "Must not retry on 409 with unknown code"
    );
  });
});

// ---------------------------------------------------------------------------
// refreshLoopToken — second consecutive 409 (retry also fails)
// ---------------------------------------------------------------------------

describe("refreshLoopToken: second consecutive 409 failure", () => {
  test("returns non-retryable failure when both first attempt and retry return 409 RACE_LOST", async () => {
    const raceBody = JSON.stringify({ code: "RACE_LOST" });
    installSequentialFetchStub([
      { status: 409, body: raceBody },
      { status: 409, body: raceBody },
    ]);

    const store = makeStore("refresh-409-double");
    store.setLoopToken("loop-1", { token: "token" });

    const result = await refreshLoopToken(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store
    );

    assert.equal(result.success, false);
    if (result.success) {
      assert.fail("Expected success:false");
    }
    assert.equal(result.retryable, false);
    assert.ok(
      result.error.includes("HTTP 409"),
      `Expected error to include 'HTTP 409', got: ${JSON.stringify(result.error)}`
    );
    // Two fetch calls: first attempt (409) + retry (409)
    assert.equal(
      capturedRequests.length,
      2,
      "Expected exactly two fetch calls"
    );
  });

  test("no further retry after second 409 — stops at two network calls", async () => {
    const raceBody = JSON.stringify({ code: "RACE_LOST" });
    // Provide three responses; if a third retry is issued we want to detect it.
    installSequentialFetchStub([
      { status: 409, body: raceBody },
      { status: 409, body: raceBody },
      { status: 200, body: JSON.stringify({ token: FAKE_TOKEN }) },
    ]);

    const store = makeStore("refresh-409-no-third-retry");
    store.setLoopToken("loop-1", { token: "token" });

    const result = await refreshLoopToken(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store
    );

    // Should fail — only two attempts are allowed (first + one retry)
    assert.equal(result.success, false);
    assert.equal(
      capturedRequests.length,
      2,
      "Must stop after exactly two fetch calls"
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotency key: generation and persistence
// ---------------------------------------------------------------------------

describe("refreshLoopToken: idempotency key persistence", () => {
  test("persists the idempotency key to the store before the network call when meta exists", async () => {
    // We track whether the key was persisted BEFORE the network call by
    // inspecting the store inside the fetch stub.
    let storedKeyDuringFetch: string | undefined;
    let fetchStoreRef: LoopTokenStore;

    const responseBody = JSON.stringify({
      token: FAKE_TOKEN,
      jti: "jti-persist",
    });
    globalThis.fetch = (async (
      input: URL | RequestInfo,
      init?: RequestInit
    ) => {
      const h = new Headers(init?.headers);
      capturedRequests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries([...h.entries()]),
        body: typeof init?.body === "string" ? init.body : null,
      });
      // Capture stored key at the moment of the network call
      storedKeyDuringFetch =
        fetchStoreRef.getLoopToken("loop-1")?.lastIdempotencyKey;
      return new Response(responseBody, { status: 200 });
    }) as typeof fetch;

    const store = makeStore("refresh-idem-persist");
    fetchStoreRef = store;
    store.setLoopToken("loop-1", { token: "token" });

    await refreshLoopToken(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store
    );

    const sentKey = capturedRequests[0]?.headers["idempotency-key"];
    assert.ok(
      typeof sentKey === "string" && sentKey.length > 0,
      "Expected idempotency key sent"
    );
    assert.equal(
      storedKeyDuringFetch,
      sentKey,
      "The idempotency key must be persisted to the store before the network call completes"
    );
  });

  test("reuses a stored lastIdempotencyKey from prior interrupted attempt", async () => {
    // Pre-seed the store with an existing idempotency key (simulates a
    // force-quit mid-refresh where the key was persisted but no response came).
    const preseededKey = "00000000-0000-0000-0000-000000000001";
    const responseBody = JSON.stringify({
      token: FAKE_TOKEN,
      jti: "jti-reuse",
    });
    installFetchStub({ status: 200, body: responseBody });

    const store = makeStore("refresh-idem-reuse");
    store.setLoopToken("loop-1", {
      token: "token",
      lastIdempotencyKey: preseededKey,
    });

    await refreshLoopToken(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store
    );

    const sentKey = capturedRequests[0]?.headers["idempotency-key"];
    assert.equal(
      sentKey,
      preseededKey,
      "Must reuse the persisted idempotency key from prior interrupted attempt (AC-008)"
    );
  });

  test("final stored meta contains lastIdempotencyKey matching what was sent", async () => {
    const responseBody = JSON.stringify({
      token: FAKE_TOKEN,
      jti: "jti-final",
    });
    installFetchStub({ status: 200, body: responseBody });

    const store = makeStore("refresh-idem-final-meta");
    store.setLoopToken("loop-1", { token: "old-token" });

    await refreshLoopToken(
      "loop-1",
      "https://api.example.com",
      () => "old-token",
      store
    );

    const sentKey = capturedRequests[0]?.headers["idempotency-key"];
    const storedMeta = store.getLoopToken("loop-1");

    assert.ok(storedMeta, "Expected meta to be persisted after success");
    assert.equal(
      storedMeta.lastIdempotencyKey,
      sentKey,
      "lastIdempotencyKey in store must match the key sent in the request"
    );
  });
});

// ---------------------------------------------------------------------------
// refreshLoopTokenSingleflight — deduplication
// ---------------------------------------------------------------------------

describe("refreshLoopTokenSingleflight: deduplication", () => {
  test("two concurrent callers for the same loopId receive the same Promise (single network call)", async () => {
    const { release, waitForFirstCall } = installHangingFetchStub({
      status: 200,
      body: JSON.stringify({ token: FAKE_TOKEN, jti: "jti-sf" }),
    });

    const store = makeStore("refresh-sf-dedup");
    store.setLoopToken("loop-1", { token: "token" });

    // Start first call — it will hang until we release
    const promise1 = refreshLoopTokenSingleflight(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store
    );

    // Wait until the first fetch call is in flight
    await waitForFirstCall();

    // Second call during inflight — should return the same Promise
    const promise2 = refreshLoopTokenSingleflight(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store
    );

    assert.equal(
      promise1,
      promise2,
      "refreshLoopTokenSingleflight must return the same Promise for concurrent calls to the same loopId (AC-003)"
    );

    // Release the hanging fetch so both promises resolve
    release();
    const [result1, result2] = await Promise.all([promise1, promise2]);

    assert.equal(result1.success, true);
    assert.equal(result2.success, true);

    // Only one network call should have been made
    assert.equal(
      capturedRequests.length,
      1,
      "Expected exactly one network call for singleflight"
    );
  });

  test("two concurrent callers for different loopIds issue independent network calls", async () => {
    const successBody = JSON.stringify({ token: FAKE_TOKEN, jti: "jti-ind" });
    installFetchStub({ status: 200, body: successBody });

    const store = makeStore("refresh-sf-independent");
    store.setLoopToken("loop-a", { token: "token-a" });
    store.setLoopToken("loop-b", { token: "token-b" });

    const [result1, result2] = await Promise.all([
      refreshLoopTokenSingleflight(
        "loop-a",
        "https://api.example.com",
        () => "token-a",
        store
      ),
      refreshLoopTokenSingleflight(
        "loop-b",
        "https://api.example.com",
        () => "token-b",
        store
      ),
    ]);

    assert.equal(result1.success, true);
    assert.equal(result2.success, true);
    assert.equal(
      capturedRequests.length,
      2,
      "Independent loopIds must each issue their own network call"
    );
  });

  test("second sequential call (after first completes) issues a new network call", async () => {
    const successBody = JSON.stringify({ token: FAKE_TOKEN, jti: "jti-seq" });
    installFetchStub({ status: 200, body: successBody });

    const store = makeStore("refresh-sf-sequential");
    store.setLoopToken("loop-1", { token: "token" });

    // First call — completes normally
    const result1 = await refreshLoopTokenSingleflight(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store
    );
    assert.equal(result1.success, true);

    // Second call — inflight map should have been cleared; a new call is issued
    const result2 = await refreshLoopTokenSingleflight(
      "loop-1",
      "https://api.example.com",
      () => store.getLoopToken("loop-1")?.token ?? null,
      store
    );
    assert.equal(result2.success, true);

    assert.equal(
      capturedRequests.length,
      2,
      "Sequential (non-concurrent) calls should each issue their own network call"
    );
  });
});

// ---------------------------------------------------------------------------
// withTokenRefreshRetry — 401 triggers refresh then retries original fn
// ---------------------------------------------------------------------------

describe("withTokenRefreshRetry: 401 interception", () => {
  test("retries the original fn once after a successful token refresh on 401", async () => {
    // Network calls:
    //   1. The original fn issues (simulated via a second fetch stub) — we
    //      control this via the `fn` lambda directly.
    //   2. The refresh endpoint returns a new token.
    //   3. The retried fn call returns 200.
    //
    // For withTokenRefreshRetry we provide `fn` as a closure rather than
    // routing through global fetch, so we only need the refresh endpoint in
    // the fetch stub.
    const store = makeStore("wtrr-401-retry");
    store.setLoopToken("loop-1", { token: "old-token" });

    const refreshBody = JSON.stringify({ token: FAKE_TOKEN, jti: "jti-wtrr" });
    installFetchStub({ status: 200, body: refreshBody });

    let callCount = 0;
    const fn = async (
      _getToken: () => string | null
    ): Promise<LoopHttpResult> => {
      callCount++;
      if (callCount === 1) {
        // First call: simulate 401
        return {
          success: false,
          kind: "http",
          status: 401,
          error: "HTTP 401 Unauthorized",
        };
      }
      // Retry call: simulate success
      return { success: true, status: 200 };
    };

    const result = await withTokenRefreshRetry(
      "loop-1",
      "https://api.example.com",
      () => store.getLoopToken("loop-1")?.token ?? null,
      store,
      fn
    );

    assert.equal(result.success, true);
    assert.equal(
      callCount,
      2,
      "fn must be called twice: once for original, once for retry"
    );
    // The refresh endpoint must have been called
    assert.equal(
      capturedRequests.length,
      1,
      "Expected exactly one network call to the refresh endpoint"
    );
    assert.ok(
      capturedRequests[0]?.url.includes("/refresh-token"),
      "Expected the network call to target the refresh-token endpoint"
    );
  });

  test("does NOT call refresh or retry when original fn succeeds (non-401)", async () => {
    const store = makeStore("wtrr-passthrough-success");
    store.setLoopToken("loop-1", { token: "token" });

    installFetchStub({ status: 200, body: "{}" });

    let callCount = 0;
    const fn = async (
      _getToken: () => string | null
    ): Promise<LoopHttpResult> => {
      callCount++;
      return { success: true, status: 200 };
    };

    const result = await withTokenRefreshRetry(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store,
      fn
    );

    assert.equal(result.success, true);
    assert.equal(
      callCount,
      1,
      "fn must be called only once when result is success"
    );
    assert.equal(
      capturedRequests.length,
      0,
      "No refresh fetch must be issued on success"
    );
  });

  test("passes through non-401 HTTP errors without triggering refresh", async () => {
    const store = makeStore("wtrr-passthrough-500");
    store.setLoopToken("loop-1", { token: "token" });

    installFetchStub({ status: 200, body: "{}" });

    let callCount = 0;
    const fn = async (
      _getToken: () => string | null
    ): Promise<LoopHttpResult> => {
      callCount++;
      return {
        success: false,
        kind: "http",
        status: 500,
        error: "HTTP 500 Server Error",
      };
    };

    const result = await withTokenRefreshRetry(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store,
      fn
    );

    assert.equal(result.success, false);
    if (result.success) {
      assert.fail("Expected success:false");
    }
    assert.equal(callCount, 1, "fn must be called only once for non-401 error");
    assert.equal(
      capturedRequests.length,
      0,
      "No refresh fetch must be issued for non-401 error"
    );
  });

  test("surfaces the original 401 when the token refresh itself fails", async () => {
    // Refresh endpoint returns 401 (e.g. JTI_ALREADY_USED) — the original
    // 401 from fn must be returned, and fn must NOT be retried.
    const store = makeStore("wtrr-refresh-fail");
    store.setLoopToken("loop-1", { token: "bad-token" });

    const refreshFailBody = JSON.stringify({ code: "JTI_ALREADY_USED" });
    installFetchStub({ status: 401, body: refreshFailBody });

    let callCount = 0;
    const originalResult: LoopHttpResult = {
      success: false,
      kind: "http",
      status: 401,
      error: "HTTP 401 Unauthorized",
    };
    const fn = async (
      _getToken: () => string | null
    ): Promise<LoopHttpResult> => {
      callCount++;
      return originalResult;
    };

    const result = await withTokenRefreshRetry(
      "loop-1",
      "https://api.example.com",
      () => "bad-token",
      store,
      fn
    );

    // Should surface the original 401
    assert.equal(result.success, false);
    if (result.success) {
      assert.fail("Expected success:false");
    }
    assert.equal(result.kind, "http");
    assert.equal(result.status, 401);
    // fn was only called once (no retry because refresh failed)
    assert.equal(callCount, 1, "fn must NOT be retried when refresh fails");
  });

  test("passes through network error from original fn without triggering refresh", async () => {
    const store = makeStore("wtrr-passthrough-network");
    store.setLoopToken("loop-1", { token: "token" });

    installFetchStub({ status: 200, body: "{}" });

    let callCount = 0;
    const fn = async (
      _getToken: () => string | null
    ): Promise<LoopHttpResult> => {
      callCount++;
      return { success: false, kind: "network", error: "ECONNREFUSED" };
    };

    const result = await withTokenRefreshRetry(
      "loop-1",
      "https://api.example.com",
      () => "token",
      store,
      fn
    );

    assert.equal(result.success, false);
    if (result.success) {
      assert.fail("Expected success:false");
    }
    assert.equal(callCount, 1, "fn must be called only once for network error");
    assert.equal(
      capturedRequests.length,
      0,
      "No refresh fetch for network errors"
    );
  });
});
