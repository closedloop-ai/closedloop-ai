import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLocalGatewaySession,
  getLastExchangeError,
  invalidateLocalGatewaySession,
  resetLocalGatewaySessionForTests,
  setLocalGatewayAuthTokenProvider,
} from "../local-gateway-session";

vi.mock("@/lib/api-origin", () => ({
  resolveApiOrigin: () => "http://localhost:3002",
}));

const PORT = 19_432;
const CHALLENGE_URL =
  "http://localhost:3002/compute-targets/local-auth/challenge";

/** Build a future ISO timestamp for session expiry */
function futureExpiry(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function mockChallengeOk(token = "challenge-jwt-abc") {
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

function mockChallengeError(
  error = "Failed to obtain challenge token",
  status = 502
) {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
    setLocalGatewayAuthTokenProvider(async () => "clerk-token-123");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: {
        origin: "http://localhost:3000",
        hostname: "localhost",
        protocol: "http:",
      },
    });
  });

  afterEach(() => {
    resetLocalGatewaySessionForTests();
    vi.restoreAllMocks();
  });

  it("fetches challenge from the API and exchanges for a session token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(mockExchangeOk("tok-1"));

    const token = await ensureLocalGatewaySession(PORT);

    expect(token).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const challengeCall = fetchMock.mock.calls[0];
    expect(String(challengeCall[0])).toBe(CHALLENGE_URL);
    expect(
      new Headers(challengeCall[1]?.headers as HeadersInit).get("authorization")
    ).toBe("Bearer clerk-token-123");

    const exchangeCall = fetchMock.mock.calls[1];
    expect(String(exchangeCall[0])).toBe(
      `http://localhost:${PORT}/gateway-auth/exchange`
    );
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

  it("starts a new exchange when the previous in-flight promise has already completed", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockChallengeOk("challenge-1"))
      .mockResolvedValueOnce(mockExchangeOk("tok-stale", futureExpiry(25_000)))
      .mockResolvedValueOnce(mockChallengeOk("challenge-2"))
      .mockResolvedValueOnce(mockExchangeOk("tok-fresh"));

    const first = await ensureLocalGatewaySession(PORT);
    const second = await ensureLocalGatewaySession(PORT);

    expect(first).toBe("tok-stale");
    expect(second).toBe("tok-fresh");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns null with an actionable 401 when the auth token is unavailable", async () => {
    setLocalGatewayAuthTokenProvider(async () => null);

    const token = await ensureLocalGatewaySession(PORT);

    expect(token).toBeNull();
    expect(getLastExchangeError()).toEqual({
      message: "Unauthorized",
      statusCode: 401,
    });
  });

  it("returns null instead of rejecting when the auth token provider throws", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    setLocalGatewayAuthTokenProvider(() =>
      Promise.reject(new Error("auth bootstrap failed"))
    );

    await expect(ensureLocalGatewaySession(PORT)).resolves.toBeNull();
    expect(getLastExchangeError()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("captures challenge error with status code when the challenge route returns an actionable error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockChallengeError("Failed to obtain challenge token", 502)
    );

    const token = await ensureLocalGatewaySession(PORT);
    expect(token).toBeNull();
    expect(getLastExchangeError()).toEqual({
      message: "Failed to obtain challenge token",
      statusCode: 502,
    });
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
        if (url === CHALLENGE_URL) {
          challengeCallCount++;
          return mockChallengeOk();
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return mockExchangeOk("tok-dedup");
      });

    const [a, b, c] = await Promise.all([
      ensureLocalGatewaySession(PORT),
      ensureLocalGatewaySession(PORT),
      ensureLocalGatewaySession(PORT),
    ]);

    expect(a).toBe("tok-dedup");
    expect(b).toBe("tok-dedup");
    expect(c).toBe("tok-dedup");
    expect(challengeCallCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a cancelled in-flight exchange and starts a new bootstrap attempt", async () => {
    let challengeCallCount = 0;
    let exchangeCallCount = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === CHALLENGE_URL) {
          challengeCallCount += 1;
          return mockChallengeOk(`challenge-${challengeCallCount}`);
        }

        exchangeCallCount += 1;
        if (exchangeCallCount === 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          return mockExchangeOk("tok-stale");
        }

        return mockExchangeOk("tok-fresh");
      });

    const firstAttempt = ensureLocalGatewaySession(PORT);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    invalidateLocalGatewaySession();

    const secondAttempt = await ensureLocalGatewaySession(PORT);
    const firstResult = await firstAttempt;

    expect(firstResult).toBeNull();
    expect(secondAttempt).toBe("tok-fresh");
    expect(await ensureLocalGatewaySession(PORT)).toBe("tok-fresh");
    expect(challengeCallCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not reuse an in-flight exchange result for a different port", async () => {
    const nextPort = PORT + 1;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === CHALLENGE_URL) {
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
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "Local gateway auth unavailable: API key required",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      )
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
      .mockResolvedValueOnce(mockChallengeOk())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "API key required" }), {
          status: 503,
        })
      )
      .mockRejectedValueOnce(new TypeError("network error"));

    await ensureLocalGatewaySession(PORT);
    expect(getLastExchangeError()).not.toBeNull();

    invalidateLocalGatewaySession();
    await ensureLocalGatewaySession(PORT);
    expect(getLastExchangeError()).toBeNull();
  });
});
