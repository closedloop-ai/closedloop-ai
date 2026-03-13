import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLocalGatewaySession,
  getLastExchangeError,
  invalidateLocalGatewaySession,
  resetLocalGatewaySessionForTests,
} from "../local-gateway-session";

const PORT = 19_432;

/** Build a future ISO timestamp for session expiry */
function futureExpiry(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function mockChallengeOk(token = "challenge-jwt-abc") {
  return new Response(JSON.stringify({ challengeToken: token }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockChallengeApiResultOk(token = "challenge-jwt-abc") {
  return new Response(
    JSON.stringify({
      success: true,
      data: { challengeToken: token, expiresAt: futureExpiry() },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

function mockExchangeOk(
  sessionToken = "session-tok-xyz",
  expiresAt = futureExpiry()
) {
  return new Response(JSON.stringify({ sessionToken, expiresAt }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("local-gateway-session", () => {
  beforeEach(() => {
    resetLocalGatewaySessionForTests();
    // Set location.origin so the module can read it
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { origin: "http://localhost:3000" },
    });
  });

  afterEach(() => {
    resetLocalGatewaySessionForTests();
    vi.restoreAllMocks();
  });

  it("fetches challenge and exchanges for a session token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(mockExchangeOk("tok-1"));

    const token = await ensureLocalGatewaySession(PORT);

    expect(token).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call should go to the app server challenge endpoint
    const challengeCall = fetchMock.mock.calls[0];
    expect(String(challengeCall[0])).toBe(
      "/api/engineer/local-gateway/challenge"
    );

    // Second call should go to the local gateway exchange endpoint
    const exchangeCall = fetchMock.mock.calls[1];
    expect(String(exchangeCall[0])).toBe(
      `http://localhost:${PORT}/gateway-auth/exchange`
    );
  });

  it("accepts challenge responses wrapped in the ApiResult envelope", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeApiResultOk("challenge-envelope"))
      .mockResolvedValueOnce(mockExchangeOk("tok-envelope"));

    const token = await ensureLocalGatewaySession(PORT);

    expect(token).toBe("tok-envelope");
  });

  it("returns the cached token on subsequent calls without re-fetching", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(mockExchangeOk("tok-cached"));

    const first = await ensureLocalGatewaySession(PORT);
    const second = await ensureLocalGatewaySession(PORT);

    expect(first).toBe("tok-cached");
    expect(second).toBe("tok-cached");
    // fetch should only have been called twice (one challenge + one exchange)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after invalidateLocalGatewaySession clears the cache", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeOk("challenge-1"))
      .mockResolvedValueOnce(mockExchangeOk("tok-first"))
      .mockResolvedValueOnce(mockChallengeOk("challenge-2"))
      .mockResolvedValueOnce(mockExchangeOk("tok-second"));

    const first = await ensureLocalGatewaySession(PORT);
    expect(first).toBe("tok-first");

    invalidateLocalGatewaySession();

    const second = await ensureLocalGatewaySession(PORT);
    expect(second).toBe("tok-second");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns null when the challenge fetch fails with a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("network error")
    );

    const token = await ensureLocalGatewaySession(PORT);
    expect(token).toBeNull();
  });

  it("returns null when the challenge endpoint returns a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 })
    );

    const token = await ensureLocalGatewaySession(PORT);
    expect(token).toBeNull();
  });

  it("returns null when the exchange endpoint fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(new Response("Bad Request", { status: 400 }));

    const token = await ensureLocalGatewaySession(PORT);
    expect(token).toBeNull();
  });

  it("returns null when the exchange response is missing sessionToken", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ expiresAt: futureExpiry() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const token = await ensureLocalGatewaySession(PORT);
    expect(token).toBeNull();
  });

  it("deduplicates concurrent exchange attempts (single in-flight promise)", async () => {
    let challengeCallCount = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("challenge")) {
          challengeCallCount++;
          return mockChallengeOk();
        }
        // Simulate slight delay on exchange
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return mockExchangeOk("tok-dedup");
      });

    // Fire three concurrent calls before any resolve
    const [a, b, c] = await Promise.all([
      ensureLocalGatewaySession(PORT),
      ensureLocalGatewaySession(PORT),
      ensureLocalGatewaySession(PORT),
    ]);

    expect(a).toBe("tok-dedup");
    expect(b).toBe("tok-dedup");
    expect(c).toBe("tok-dedup");
    // Only one challenge + one exchange should have been issued
    expect(challengeCallCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an in-flight exchange result for a different port", async () => {
    const nextPort = PORT + 1;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/engineer/local-gateway/challenge") {
          return mockChallengeOk(`challenge-${Math.random()}`);
        }

        if (url === `http://localhost:${PORT}/gateway-auth/exchange`) {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          return mockExchangeOk("tok-port-a");
        }

        if (url === `http://localhost:${nextPort}/gateway-auth/exchange`) {
          return mockExchangeOk("tok-port-b");
        }

        throw new Error(`Unexpected fetch: ${url}`);
      });

    const firstAttempt = ensureLocalGatewaySession(PORT);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const secondAttempt = await ensureLocalGatewaySession(nextPort);
    const firstResult = await firstAttempt;

    expect(secondAttempt).toBe("tok-port-b");
    expect(firstResult).toBeNull();

    const cachedSecondPortToken = await ensureLocalGatewaySession(nextPort);
    expect(cachedSecondPortToken).toBe("tok-port-b");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // --- Fail-closed: missing API key error tracking ---

  it("captures exchange error with status code when gateway returns 503 (API key required)", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "Local gateway auth unavailable: API key required",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      );

    const token = await ensureLocalGatewaySession(PORT);
    expect(token).toBeNull();
    expect(getLastExchangeError()).toEqual({
      message: "Local gateway auth unavailable: API key required",
      statusCode: 503,
    });
  });

  it("clears exchange error after a successful exchange", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      // First attempt: 503
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "Local gateway auth unavailable: API key required",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      )
      // Second attempt: success
      .mockResolvedValueOnce(mockChallengeOk("challenge-2"))
      .mockResolvedValueOnce(mockExchangeOk("tok-ok"));

    await ensureLocalGatewaySession(PORT);
    expect(getLastExchangeError()).not.toBeNull();

    invalidateLocalGatewaySession();
    await ensureLocalGatewaySession(PORT);
    expect(getLastExchangeError()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("clears exchange error on session invalidation", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "Local gateway auth unavailable: API key required",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      );

    await ensureLocalGatewaySession(PORT);
    expect(getLastExchangeError()).not.toBeNull();

    invalidateLocalGatewaySession();
    expect(getLastExchangeError()).toBeNull();
  });

  it("clears stale exchange error when challenge fails on next attempt", async () => {
    vi.spyOn(globalThis, "fetch")
      // First: exchange fails with 503
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "API key required" }), {
          status: 503,
        })
      )
      // Second: challenge itself fails (network error)
      .mockRejectedValueOnce(new TypeError("network error"));

    await ensureLocalGatewaySession(PORT);
    expect(getLastExchangeError()).not.toBeNull();

    invalidateLocalGatewaySession();
    await ensureLocalGatewaySession(PORT);
    // Challenge network error should have cleared the stale exchange error
    expect(getLastExchangeError()).toBeNull();
  });

  it("preserves original status code (e.g. 401) in exchange error", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid challenge token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      );

    await ensureLocalGatewaySession(PORT);
    expect(getLastExchangeError()).toEqual({
      message: "invalid challenge token",
      statusCode: 401,
    });
  });

  it("clears stale exchange error when challenge returns malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch")
      // First: exchange fails with 503
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "API key required" }), {
          status: 503,
        })
      )
      // Second: challenge returns ok but with missing challengeToken field
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    await ensureLocalGatewaySession(PORT);
    expect(getLastExchangeError()).not.toBeNull();

    invalidateLocalGatewaySession();
    await ensureLocalGatewaySession(PORT);
    expect(getLastExchangeError()).toBeNull();
  });

  it("clears stale exchange error when exchange-success response is malformed", async () => {
    vi.spyOn(globalThis, "fetch")
      // First: exchange fails with 503
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "API key required" }), {
          status: 503,
        })
      )
      // Second: challenge succeeds, exchange returns 200 but missing sessionToken
      .mockResolvedValueOnce(mockChallengeOk("c2"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ expiresAt: new Date().toISOString() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    await ensureLocalGatewaySession(PORT);
    expect(getLastExchangeError()).not.toBeNull();

    invalidateLocalGatewaySession();
    const token = await ensureLocalGatewaySession(PORT);
    expect(token).toBeNull();
    expect(getLastExchangeError()).toBeNull();
  });

  it("captures generic exchange error when response has no JSON body", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 })
      );

    const token = await ensureLocalGatewaySession(PORT);
    expect(token).toBeNull();
    expect(getLastExchangeError()).toEqual({
      message: "exchange failed (500)",
      statusCode: 500,
    });
  });
});
