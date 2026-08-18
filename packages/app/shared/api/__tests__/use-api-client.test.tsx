import {
  DEPLOYMENT_ID_HEADER,
  ORG_IDENTITY_HEADER,
} from "@repo/api/src/types/headers";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AuthAdapter, AuthSnapshot } from "../../auth/auth-adapter";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import type { ApiAdapter } from "../api-adapter";
import { ApiError } from "../api-error";
import {
  type ApiRequestOptions,
  DEFAULT_API_TIMEOUT_MS,
  LONG_RUNNING_API_TIMEOUT_MS,
} from "../api-timeout";
import { ApiAdapterProvider } from "../provider";
import { useApiClient } from "../use-api-client";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const TEST_ORIGIN = "https://api.test";
const AUTH_PROVIDER_ERROR = /AuthAdapterProvider/;

describe("useApiClient (port)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("resolves against the injected origin with bearer token and org header", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { ok: true } })
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    await result.current.get("/things");

    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_ORIGIN}/things`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          [ORG_IDENTITY_HEADER]: "org_test",
        }),
      })
    );
  });

  it("forwards x-deployment-id when the adapter resolves a pin (FEA-1485)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: null })
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(createStaticAuthAdapter(), {
        resolveApiOrigin: () => TEST_ORIGIN,
        deploymentId: "dpl_api_n",
      }),
    });

    await result.current.get("/things");

    expect(lastFetchHeaders()[DEPLOYMENT_ID_HEADER]).toBe("dpl_api_n");
  });

  it("omits x-deployment-id when no pin is resolved (FEA-1485)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: null })
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    await result.current.get("/things");

    expect(lastFetchHeaders()[DEPLOYMENT_ID_HEADER]).toBeUndefined();
  });

  it("omits auth headers when signed out", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: null })
    );
    const adapter = createStaticAuthAdapter({
      orgId: null,
      userId: null,
      getToken: () => Promise.resolve(null),
    });
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(adapter),
    });

    await result.current.get("/public");

    const headers = lastFetchHeaders();
    expect(headers.Authorization).toBeUndefined();
    expect(headers[ORG_IDENTITY_HEADER]).toBeUndefined();
  });

  it("revives ISO date strings in the success envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { createdAt: "2024-01-02T03:04:05.000Z" },
      })
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    const data = await result.current.get<{ createdAt: Date }>("/things/1");

    expect(data.createdAt).toBeInstanceOf(Date);
    expect(data.createdAt.toISOString()).toBe("2024-01-02T03:04:05.000Z");
  });

  it("throws ApiError with envelope metadata on success=false", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: "Tag not found",
          code: "NOT_FOUND",
          details: { tagId: "t1" },
        },
        { status: 404 }
      )
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    const failure = await result.current.get("/tags/t1").catch((e) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      message: "Tag not found",
      status: 404,
      code: "NOT_FOUND",
      details: { tagId: "t1" },
    });
  });

  it("surfaces a non-enveloped HTTP error body (no success field) without an undefined message", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "Bad gateway", code: "GATEWAY" }, { status: 502 })
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    const failure = await result.current.get("/things").catch((e) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      message: "Bad gateway",
      status: 502,
      code: "GATEWAY",
    });
  });

  it("wraps network failures into ApiError with status 0", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection refused"));
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    const failure = await result.current.get("/things").catch((e) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ message: "connection refused", status: 0 });
  });

  it("returns un-enveloped bodies from getRaw and throws parsed raw errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ plain: true }));
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    await expect(result.current.getRaw("/raw")).resolves.toEqual({
      plain: true,
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: "gateway exploded", code: "GATEWAY_ERROR" },
        { status: 502 }
      )
    );
    const failure = await result.current.getRaw("/raw").catch((e) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      message: "gateway exploded",
      status: 502,
      code: "GATEWAY_ERROR",
    });
  });

  // ISS-5013 (split from ISS-5002). Before the deadline existed, a request that
  // never settled never rejected: the caller's promise stayed pending forever,
  // TanStack Query stayed `isLoading`, and no error state was reachable at all.
  // These drive a fetch that NEVER resolves and assert the client gives up.
  it("rejects a never-settling request once the deadline elapses", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      hangsUntilAborted(init.signal)
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    const pending = result.current
      .get("/hangs")
      .catch((error: unknown) => error);
    // Let the auth handshake settle so the request is actually in flight before
    // the clock moves — otherwise the deadline is armed after the advance
    // window has already passed and nothing fires.
    await flushUntilRequested();
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS + 1);

    const failure = await pending;
    expect(failure).toBeInstanceOf(ApiError);
    // Distinct from a server error: the server never answered, so this must not
    // claim an HTTP status the server never sent.
    expect((failure as ApiError).isTimeout()).toBe(true);
    expect((failure as ApiError).isServerError()).toBe(false);
    expect((failure as ApiError).isClientError()).toBe(false);
  });

  it("does not abort a request that is still inside its deadline", async () => {
    vi.useFakeTimers();
    let settle: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        settle = resolve;
      })
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    const pending = result.current.get<{ ok: boolean }>("/slow");
    await flushUntilRequested();
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS - 1000);
    settle?.(jsonResponse({ success: true, data: { ok: true } }));

    await expect(pending).resolves.toEqual({ ok: true });
    expect(lastFetchSignal()?.aborted).toBe(false);
  });

  it("honors a per-call timeout override for a legitimately long request", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      hangsUntilAborted(init.signal)
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    const pending = result.current
      .post("/imports", {}, { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS })
      .catch((error: unknown) => error);
    await flushUntilRequested();

    // Well past the DEFAULT deadline, the override keeps the request alive.
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS + 1);
    expect(lastFetchSignal()?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(
      LONG_RUNNING_API_TIMEOUT_MS - DEFAULT_API_TIMEOUT_MS
    );
    expect(((await pending) as ApiError).isTimeout()).toBe(true);
  });

  it("propagates a caller-initiated abort as a cancellation, not a timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      hangsUntilAborted(init.signal)
    );
    const controller = new AbortController();
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    const pending = result.current
      .get("/cancelled", { signal: controller.signal })
      .catch((error: unknown) => error);
    await flushUntilRequested();
    controller.abort();

    const failure = await pending;
    // A user/React-Query cancellation must stay a real AbortError so it is
    // treated as a cancellation rather than rendered as a failure state.
    expect(failure).not.toBeInstanceOf(ApiError);
    expect((failure as Error).name).toBe("AbortError");
  });

  it("clears the deadline timer once a request settles", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    await result.current.get("/things");

    // No pending deadline is left behind to fire against a settled request.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers requests until the auth snapshot reports loaded", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));
    const controlled = createControlledAuthAdapter({ isLoaded: false });
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(controlled.adapter),
    });

    const pending = result.current.get("/things");
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => controlled.setLoaded(true));
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for a signed-in loaded snapshot to produce a bearer token", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));
    const getToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue("late-token");
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(
        createStaticAuthAdapter({
          isLoaded: true,
          userId: "user_test",
          getToken,
        })
      ),
    });

    const pending = result.current.get("/things");
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    await pending;

    expect(getToken).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_ORIGIN}/things`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer late-token",
        }),
      })
    );
  });

  it("throws a descriptive error when mounted without its providers", () => {
    expect(() => renderHook(() => useApiClient())).toThrow(AUTH_PROVIDER_ERROR);
  });

  it("hands the resolved deadline to the transport, not the caller's raw value", async () => {
    // ISS-5082: the desktop transport cannot observe `signal` across its IPC
    // bridge, so the NUMBER on the init is the only way a per-call override can
    // reach it. It must be the deadline actually in effect (defaulted and
    // clamped here), never whatever the caller happened to pass. Fake timers
    // pin the clock so the stamped value — the REMAINING budget — equals the
    // resolved deadline exactly (no time is consumed before the transport).
    // A fresh Response per call: each request reads the body, and a shared one
    // would be unusable on the second read.
    vi.useFakeTimers();
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ success: true, data: null }))
    );
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(),
    });

    await result.current.get("/things");
    expect(lastFetchTimeoutMs()).toBe(DEFAULT_API_TIMEOUT_MS);

    await result.current.post(
      "/imports",
      {},
      { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
    );
    expect(lastFetchTimeoutMs()).toBe(LONG_RUNNING_API_TIMEOUT_MS);

    // A non-positive override is clamped to the same positive floor the timer
    // uses, so a transport reading this number cannot arm a shorter deadline
    // than the client itself did.
    await result.current.get("/things", { timeoutMs: 0 });
    expect(lastFetchTimeoutMs()).toBe(1);

    // An explicit opt-out stays distinguishable from "no override given".
    await result.current.get("/things", { timeoutMs: null });
    expect(lastFetchTimeoutMs()).toBeNull();
  });

  it("hands the transport the REMAINING budget after auth consumed part of it", async () => {
    // Review finding on ISS-5082: the deadline is armed before the auth waits,
    // but the transport (desktop main) arms a FRESH timer from the number it
    // receives. Forwarding the original duration would let a request whose
    // auth wait had nearly spent the budget run for almost a full extra
    // deadline. The token retry loop below deterministically consumes 200ms
    // (two 100ms retry delays) before the request reaches the transport.
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));
    const getToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue("late-token");
    const { result } = renderHook(() => useApiClient(), {
      wrapper: createWrapper(
        createStaticAuthAdapter({
          isLoaded: true,
          userId: "user_test",
          getToken,
        })
      ),
    });

    const pending = result.current.get("/things");
    await vi.advanceTimersByTimeAsync(200);
    await pending;

    expect(lastFetchTimeoutMs()).toBe(DEFAULT_API_TIMEOUT_MS - 200);
  });
});

function createWrapper(
  authAdapter: AuthAdapter = createStaticAuthAdapter(),
  apiAdapter: ApiAdapter = { resolveApiOrigin: () => TEST_ORIGIN }
) {
  return ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider adapter={authAdapter}>
      <ApiAdapterProvider adapter={apiAdapter}>{children}</ApiAdapterProvider>
    </AuthAdapterProvider>
  );
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function lastFetchHeaders(): Record<string, string> {
  const [, init] = fetchMock.mock.calls.at(-1) ?? [];
  return (init as RequestInit).headers as Record<string, string>;
}

type ControlledAuthAdapter = {
  adapter: AuthAdapter;
  setLoaded: (isLoaded: boolean) => void;
};

function createControlledAuthAdapter(
  initial: Partial<AuthSnapshot>
): ControlledAuthAdapter {
  let snapshot: AuthSnapshot = {
    isLoaded: initial.isLoaded ?? true,
    userId: initial.userId ?? "user_test",
    orgId: initial.orgId ?? "org_test",
    getToken: initial.getToken ?? (() => Promise.resolve("test-token")),
  };
  const listeners = new Set<() => void>();

  return {
    adapter: {
      useAuthSnapshot: () =>
        useSyncExternalStore(
          (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          () => snapshot,
          () => snapshot
        ),
    },
    setLoaded: (isLoaded: boolean) => {
      snapshot = { ...snapshot, isLoaded };
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

/**
 * A fetch that never settles on its own and rejects with an `AbortError` when
 * its signal aborts — i.e. exactly how a real `fetch` behaves against a server
 * that never answers. This is the production hang the deadline exists for.
 */
function hangsUntilAborted(
  signal: AbortSignal | null | undefined
): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      reject(error);
    });
  });
}

function lastFetchSignal(): AbortSignal | undefined {
  const [, init] = fetchMock.mock.calls.at(-1) ?? [];
  return (init as RequestInit | undefined)?.signal ?? undefined;
}

function lastFetchTimeoutMs(): number | null | undefined {
  const [, init] = fetchMock.mock.calls.at(-1) ?? [];
  return (init as ApiRequestOptions | undefined)?.timeoutMs;
}

/**
 * Drain the auth-handshake microtasks so the request has reached `fetch` (and
 * therefore armed its deadline) before a test advances the fake clock.
 */
async function flushUntilRequested(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (fetchMock.mock.calls.length > 0) {
      return;
    }
    await vi.advanceTimersByTimeAsync(1);
  }
  throw new Error("request was never issued to fetch");
}
