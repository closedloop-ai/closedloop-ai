import {
  DEPLOYMENT_ID_HEADER,
  ORG_IDENTITY_HEADER,
} from "@repo/api/src/types/headers";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthAdapter, AuthSnapshot } from "../../auth/auth-adapter";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import type { ApiAdapter } from "../api-adapter";
import { ApiError } from "../api-error";
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

  it("throws a descriptive error when mounted without its providers", () => {
    expect(() => renderHook(() => useApiClient())).toThrow(AUTH_PROVIDER_ERROR);
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
