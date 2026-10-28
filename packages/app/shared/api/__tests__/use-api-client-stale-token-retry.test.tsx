/**
 * ISS-9701: a 401 caused by a token that merely aged out must be recovered
 * transparently — one refresh, one retry — while a 401 from a session that is
 * genuinely gone must still surface so the shell can offer sign-in.
 *
 * Nothing downstream of this client recovers a 401 on its own: `shouldRetryQuery`
 * refuses to retry any response-backed error, and the shared auth-rejection
 * boundary latches the first 401 from ANY query into the web shell's
 * "Your session expired" card. So this is the only layer where the distinction
 * between "stale token" and "dead session" can still be made.
 */
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthAdapter, AuthTokenOptions } from "../../auth/auth-adapter";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import {
  AuthRejectionReason,
  classifyAuthRejection,
} from "../../query/auth-rejection-store";
import type { ApiAdapter } from "../api-adapter";
import { ApiError } from "../api-error";
import { ApiAdapterProvider } from "../provider";
import { useApiClient } from "../use-api-client";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const TEST_ORIGIN = "https://api.test";
const STALE_TOKEN = "stale-token";
const FRESH_TOKEN = "fresh-token";
// Short enough to be realistic — `BRANCH_COMMENTS_READ_TIMEOUT_MS` is 5s and
// the trace-comments read is twice its poll interval — and the exact amount the
// deadline test advances the clock by.
const SHORT_DEADLINE_MS = 5000;

type TokenSource = (options?: AuthTokenOptions) => Promise<string | null>;

describe("useApiClient stale-token refresh (ISS-9701)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("retries a 401 once with a freshly minted token and succeeds", async () => {
    const getToken = createTokenSource();
    fetchMock
      .mockResolvedValueOnce(unauthorizedResponse())
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { ok: true } })
      );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createAdapterWrapper(getToken),
    });

    // The request SUCCEEDS — "no error surfaced" would also be true of a
    // request that never completed, so assert the payload it resolved with.
    await expect(result.current.get("/things")).resolves.toEqual({ ok: true });

    // ...and it succeeded because of the retry, not in spite of it.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorizationHeaderAt(0)).toBe(`Bearer ${STALE_TOKEN}`);
    expect(authorizationHeaderAt(1)).toBe(`Bearer ${FRESH_TOKEN}`);
    expect(forceRefreshCallCount(getToken)).toBe(1);
  });

  it("surfaces a second 401 as a terminal error, with no further retry", async () => {
    const getToken = createTokenSource();
    // A FRESH response per call, as a real transport gives. `mockResolvedValue`
    // hands back one instance to every attempt, and a `Response` body can only
    // be read once — so the retry would read a body the first attempt had
    // already consumed, a shape no fetch produces.
    fetchMock.mockImplementation(() => Promise.resolve(unauthorizedResponse()));
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createAdapterWrapper(getToken),
    });

    const error = await result.current.get("/things").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    // Exactly one retry: the refresh happened, the second answer stands.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(forceRefreshCallCount(getToken)).toBe(1);
  });

  it("does not retry when the refresh yields no token", async () => {
    // A session that is genuinely gone: the auth source can no longer mint a
    // token at all, so there is nothing fresher to retry with.
    const getToken = vi
      .fn<TokenSource>()
      .mockImplementation((options) =>
        Promise.resolve(options?.forceRefresh ? null : STALE_TOKEN)
      );
    // A FRESH response per call, as a real transport gives. `mockResolvedValue`
    // hands back one instance to every attempt, and a `Response` body can only
    // be read once — so the retry would read a body the first attempt had
    // already consumed, a shape no fetch produces.
    fetchMock.mockImplementation(() => Promise.resolve(unauthorizedResponse()));
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createAdapterWrapper(getToken),
    });

    const error = await result.current.get("/things").catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(forceRefreshCallCount(getToken)).toBe(1);
  });

  it("never refreshes or retries a bare 403 (ISS-5095 regression guard)", async () => {
    const getToken = createTokenSource();
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: "Forbidden" }, { status: 403 })
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createAdapterWrapper(getToken),
    });

    const error = await result.current
      .get("/teams/t1/repositories")
      .catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(forceRefreshCallCount(getToken)).toBe(0);
  });

  it("coalesces concurrent 401s into a single refresh (no retry storm)", async () => {
    // The refresh is held open until every request is parked on it, so the call
    // count below is measured while all three are waiting — which is the only
    // moment at which coalescing is observable at all.
    let releaseRefresh: (token: string) => void = () => {
      // Replaced synchronously by the promise executor below.
    };
    const refreshed = new Promise<string>((resolve) => {
      releaseRefresh = resolve;
    });
    const getToken = vi
      .fn<TokenSource>()
      .mockImplementation((options) =>
        options?.forceRefresh ? refreshed : Promise.resolve(STALE_TOKEN)
      );
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(
        authorizationOf(init) === `Bearer ${FRESH_TOKEN}`
          ? jsonResponse({ success: true, data: { ok: true } })
          : unauthorizedResponse()
      )
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createAdapterWrapper(getToken),
    });

    const pending = [
      result.current.get("/a"),
      result.current.get("/b"),
      result.current.get("/c"),
    ];
    // All three have been rejected and are now waiting on the shared refresh.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(forceRefreshCallCount(getToken)).toBe(1);

    releaseRefresh(FRESH_TOKEN);

    await expect(Promise.all(pending)).resolves.toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
    // Three requests, each retried exactly once...
    expect(fetchMock).toHaveBeenCalledTimes(6);
    // ...sharing ONE token mint between them.
    expect(forceRefreshCallCount(getToken)).toBe(1);
  });

  it("reuses the recovery for a 401 that lands after an earlier request already refreshed", async () => {
    // The staggered case, which in-flight coalescing alone does NOT cover. Both
    // requests leave carrying the same aged token; the first is rejected,
    // refreshes, retries and finishes — and only THEN does the second's 401
    // arrive. By that point there is no flight left to join, so an unscoped
    // recovery mints a second token for an expiry that was already recovered.
    // Under a page's worth of in-flight reads that is a mint per straggler.
    const getToken = createMintingTokenSource();
    const lateUnauthorized = deferredResponse();
    let staleRequests = 0;
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (authorizationOf(init) !== `Bearer ${STALE_TOKEN}`) {
        return Promise.resolve(
          jsonResponse({ success: true, data: { ok: true } })
        );
      }
      staleRequests += 1;
      // The late request's rejection is held open until the early one has fully
      // recovered, which is precisely the ordering the bug needs.
      return url.endsWith("/late")
        ? lateUnauthorized.promise
        : Promise.resolve(unauthorizedResponse());
    });
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createAdapterWrapper(getToken),
    });

    const early = result.current.get("/early");
    const late = result.current.get("/late");
    // Both left with the SAME stale bearer before any refresh happened.
    await waitFor(() => expect(staleRequests).toBe(2));

    await expect(early).resolves.toEqual({ ok: true });
    expect(forceRefreshCallCount(getToken)).toBe(1);

    lateUnauthorized.resolve(unauthorizedResponse());

    await expect(late).resolves.toEqual({ ok: true });
    // The data outcome: the late 401 cost no second mint...
    expect(forceRefreshCallCount(getToken)).toBe(1);
    // ...because it retried with the very token the first recovery produced,
    // rather than asking for one of its own.
    expect(authorizationOf(lastRequestInitFor("/late"))).toBe(
      `Bearer ${FRESH_TOKEN}`
    );
  });

  it("still refreshes when the token that was already refreshed is itself rejected", async () => {
    // The other side of the scoping, and the reason it is keyed on the token
    // rather than on a time window: reuse must end the moment the credential it
    // was recorded for stops being the one that failed. A memory that answered
    // every later 401 with the same already-minted token would suppress recovery
    // for good on the second expiry.
    const getToken = createMintingTokenSource();
    const rejected = new Set<string>([STALE_TOKEN, FRESH_TOKEN]);
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const bearer = authorizationOf(init) ?? "";
      return Promise.resolve(
        rejected.has(bearer.replace("Bearer ", ""))
          ? unauthorizedResponse()
          : jsonResponse({ success: true, data: { ok: true } })
      );
    });
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createAdapterWrapper(getToken),
    });

    // First expiry: STALE is refused, FRESH is minted — and refused too, so this
    // one ends terminally, recording STALE→FRESH along the way.
    await expect(result.current.get("/first")).rejects.toBeInstanceOf(ApiError);
    expect(forceRefreshCallCount(getToken)).toBe(1);

    // A later request now carries FRESH, and FRESH is what the server refuses.
    // That is a different rejected token, so it must mint again.
    await expect(result.current.get("/second")).resolves.toEqual({ ok: true });
    expect(forceRefreshCallCount(getToken)).toBe(2);
  });

  it("surfaces the server's 401 when the deadline expires during the refresh", async () => {
    // The regression this retry could introduce, and it is strictly worse than
    // not retrying at all. The first attempt carries the deadline's signal, so
    // a deadline that fires while the refresh is in flight both rejects the
    // refresh wait AND cuts off the 401's body stream. Left alone, either one
    // turns the answer the server already gave into a client TIMEOUT — which
    // `classifyAuthRejection` classifies as nothing, so `WorkspaceAuthGuard`
    // leaves a genuinely dead session on "we stopped waiting" with no way to
    // sign back in. On `main` that 401 reached the classifier immediately.
    //
    // Reachable, not hypothetical: `BRANCH_COMMENTS_READ_TIMEOUT_MS` (5s) and
    // `TRACE_COMMENTS_READ_TIMEOUT_MS` are call sites with deadlines this short
    // already.
    vi.useFakeTimers();
    try {
      // Never settles: the deadline is what ends this wait.
      const getToken = vi.fn<TokenSource>().mockImplementation((options) =>
        options?.forceRefresh
          ? new Promise<string>(() => {
              // Held open past the deadline on purpose.
            })
          : Promise.resolve(STALE_TOKEN)
      );
      fetchMock.mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve(abortableUnauthorizedResponse(init))
      );
      const { result } = renderHook(() => useApiClient(), {
        wrapper: createAdapterWrapper(getToken),
      });

      const pending = result.current
        .get("/things", { timeoutMs: SHORT_DEADLINE_MS })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SHORT_DEADLINE_MS);
      const error = await pending;

      // The refresh really was in flight when the deadline fired — otherwise
      // this test would be exercising the ordinary terminal-401 path instead.
      expect(forceRefreshCallCount(getToken)).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(401);
      // The distinction that decides which surface the user lands on.
      expect((error as ApiError).isTimeout()).toBe(false);
      expect(classifyAuthRejection(error)).toBe(
        AuthRejectionReason.SessionExpired
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

/** The `AbortError` an `AbortSignal` raises, as both platforms surface it. */
function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * A 401 whose BODY IS STILL ON THE WIRE and is cut off if `init.signal` aborts
 * — a real `fetch` response whose headers have arrived and whose body the
 * client has not read yet.
 *
 * The fidelity here is the whole test. A detached `new Response(json, {status:
 * 401})` — what the other cases in this file use, correctly, because they never
 * abort — carries its body in memory already, so it reads back fine no matter
 * what the signal does. A deadline test built on one would pass whether or not
 * the client buffers the 401 before awaiting the refresh, which is precisely
 * the half of the fix it exists to hold.
 *
 * Bytes are produced in `pull` under `highWaterMark: 0`, so nothing is enqueued
 * until a reader asks. That is what keeps the body genuinely unread — and
 * therefore genuinely abortable — for the whole window the refresh occupies.
 */
function abortableUnauthorizedResponse(
  init: RequestInit | undefined
): Response {
  const payload = new TextEncoder().encode(
    JSON.stringify({ success: false, error: "Unauthorized" })
  );
  const signal = init?.signal ?? undefined;
  // One-shot: a stream that has already delivered its body must not then be
  // errored by a later abort (that throws inside the listener), and one already
  // errored must not enqueue.
  let settled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const cutOff = () => {
          if (settled) {
            return;
          }
          settled = true;
          controller.error(abortError());
        };
        if (signal?.aborted) {
          cutOff();
          return;
        }
        signal?.addEventListener("abort", cutOff, { once: true });
      },
      pull(controller) {
        if (settled) {
          return;
        }
        settled = true;
        controller.enqueue(payload);
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(body, {
    headers: { "Content-Type": "application/json" },
    status: 401,
  });
}

/**
 * A token source that mints a NEW token on each forced refresh and serves the
 * most recent one from the plain read — the shape of a real SDK cache after a
 * refresh has landed. A source that re-served one fixed pair could not tell a
 * reused recovery apart from a second mint that happened to return the same
 * string.
 */
function createMintingTokenSource() {
  let current = STALE_TOKEN;
  let minted = 0;
  return vi.fn<TokenSource>().mockImplementation((options) => {
    if (options?.forceRefresh) {
      minted += 1;
      current = minted === 1 ? FRESH_TOKEN : `${FRESH_TOKEN}-${minted}`;
    }
    return Promise.resolve(current);
  });
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve: (response: Response) => void = () => {
    // Replaced synchronously by the promise executor below.
  };
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The init of the most recent fetch issued for `path`. */
function lastRequestInitFor(path: string): RequestInit | undefined {
  const calls = fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith(path)
  );
  return calls.at(-1)?.[1] as RequestInit | undefined;
}

/**
 * A token source that behaves like a real SDK cache: the plain read keeps
 * handing back the token the server already rejected, and only an explicit
 * refresh mints a new one. A source that returned a fresh token from the plain
 * read would let the retry pass without the refresh doing anything.
 */
function createTokenSource() {
  return vi
    .fn<TokenSource>()
    .mockImplementation((options) =>
      Promise.resolve(options?.forceRefresh ? FRESH_TOKEN : STALE_TOKEN)
    );
}

function forceRefreshCallCount(getToken: {
  mock: { calls: [AuthTokenOptions?][] };
}): number {
  return getToken.mock.calls.filter(
    ([options]) => options?.forceRefresh === true
  ).length;
}

function createAdapterWrapper(getToken: TokenSource) {
  const authAdapter: AuthAdapter = createStaticAuthAdapter({ getToken });
  const apiAdapter: ApiAdapter = { resolveApiOrigin: () => TEST_ORIGIN };
  return ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider adapter={authAdapter}>
      <ApiAdapterProvider adapter={apiAdapter}>{children}</ApiAdapterProvider>
    </AuthAdapterProvider>
  );
}

function authorizationOf(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

function authorizationHeaderAt(callIndex: number): string | undefined {
  const [, init] = fetchMock.mock.calls[callIndex] ?? [];
  return authorizationOf(init as RequestInit | undefined);
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function unauthorizedResponse(): Response {
  return jsonResponse(
    { success: false, error: "Unauthorized" },
    { status: 401 }
  );
}
