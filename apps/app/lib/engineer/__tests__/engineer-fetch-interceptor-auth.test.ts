import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module-level mocks (hoisted before imports) ---

const mockGetElectronDetectionSnapshot = vi.fn();
const mockEnsureElectronDetection = vi.fn();
const mockInvalidateElectronDetectionCache = vi.fn();
const mockEnsureLocalGatewaySession = vi.fn();
const mockInvalidateLocalGatewaySession = vi.fn();
const mockGetLastExchangeError = vi.fn();
const mockEnsureLocalGatewayApiNamespace = vi.fn();
const mockInvalidateLocalGatewayApiNamespace = vi.fn();
const mockGetEngineerRoutingSelection = vi.fn();

vi.mock("../electron-detection", () => ({
  getElectronDetectionSnapshot: (...args: unknown[]) =>
    mockGetElectronDetectionSnapshot(...args),
  ensureElectronDetection: (...args: unknown[]) =>
    mockEnsureElectronDetection(...args),
  invalidateElectronDetectionCache: (...args: unknown[]) =>
    mockInvalidateElectronDetectionCache(...args),
}));

vi.mock("../local-gateway-session", () => ({
  ensureLocalGatewaySession: (...args: unknown[]) =>
    mockEnsureLocalGatewaySession(...args),
  invalidateLocalGatewaySession: (...args: unknown[]) =>
    mockInvalidateLocalGatewaySession(...args),
  getLastExchangeError: (...args: unknown[]) =>
    mockGetLastExchangeError(...args),
}));

vi.mock("../local-gateway-api-namespace", () => ({
  ensureLocalGatewayApiNamespace: (...args: unknown[]) =>
    mockEnsureLocalGatewayApiNamespace(...args),
  invalidateLocalGatewayApiNamespace: (...args: unknown[]) =>
    mockInvalidateLocalGatewayApiNamespace(...args),
}));

vi.mock("../routing-store", () => ({
  getEngineerRoutingSelection: (...args: unknown[]) =>
    mockGetEngineerRoutingSelection(...args),
}));

vi.mock("../constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../constants")>();
  return {
    ...actual,
    CLOUD_RELAY_ENABLED: false,
  };
});

import {
  installEngineerFetchInterceptor,
  resetEngineerFetchInterceptorForTests,
} from "../engineer-fetch-interceptor";

// ---------------------------------------------------------------------------

const PORT = 19_432;

function makeLocalElectronSelection() {
  return {
    mode: EngineerRoutingMode.LocalElectron,
    computeTargetId: null,
    source: "auto" as const,
    updatedAt: Date.now(),
  };
}

function makeDetectedSnapshot(port = PORT) {
  return {
    detected: true,
    loading: false,
    port,
    version: "1.0.0",
    machineName: "machine-1",
    capabilities: {},
    checkedAt: Date.now(),
  };
}

describe("engineer-fetch-interceptor – auth integration", () => {
  let savedWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    // The interceptor guards on `globalThis.window !== undefined`
    savedWindow = globalThis.window;
    if (globalThis.window === undefined) {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: globalThis,
      });
    }

    // Set location.origin so URL construction works
    if (!globalThis.location) {
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { origin: "http://localhost:3000" },
      });
    }

    resetEngineerFetchInterceptorForTests();
    vi.restoreAllMocks();
    mockGetEngineerRoutingSelection.mockReset();
    mockGetElectronDetectionSnapshot.mockReset();
    mockEnsureElectronDetection.mockReset();
    mockInvalidateElectronDetectionCache.mockReset();
    mockEnsureLocalGatewaySession.mockReset();
    mockInvalidateLocalGatewaySession.mockReset();
    mockGetLastExchangeError.mockReset();
    mockEnsureLocalGatewayApiNamespace.mockReset();
    mockInvalidateLocalGatewayApiNamespace.mockReset();
    mockGetLastExchangeError.mockReturnValue(null);
    mockEnsureLocalGatewayApiNamespace.mockResolvedValue("gateway");

    // Defaults used by most tests
    mockGetEngineerRoutingSelection.mockReturnValue(
      makeLocalElectronSelection()
    );
    mockGetElectronDetectionSnapshot.mockReturnValue(makeDetectedSnapshot());
  });

  afterEach(() => {
    resetEngineerFetchInterceptorForTests();
    vi.restoreAllMocks();
    if (savedWindow === undefined) {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });

  it("attaches x-desktop-session-token header when session token is available", async () => {
    mockEnsureLocalGatewaySession.mockResolvedValue("session-tok-abc");

    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();
    await fetch("/api/gateway/health-check");

    expect(originalFetch).toHaveBeenCalledTimes(1);
    const outgoing = originalFetch.mock.calls[0][0] as Request;
    expect(outgoing.headers.get("x-desktop-session-token")).toBe(
      "session-tok-abc"
    );

    uninstall();
  });

  it("does not attach x-desktop-session-token when session is unavailable (null)", async () => {
    mockEnsureLocalGatewaySession.mockResolvedValue(null);

    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();
    await fetch("/api/gateway/health-check");

    const outgoing = originalFetch.mock.calls[0][0] as Request;
    expect(outgoing.headers.get("x-desktop-session-token")).toBeNull();

    uninstall();
  });

  it("on 401 response, invalidates session and retries with a fresh token", async () => {
    mockEnsureLocalGatewaySession
      .mockResolvedValueOnce("stale-tok")
      .mockResolvedValueOnce("fresh-tok");

    const originalFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();
    const response = await fetch("/api/gateway/git");

    // Two outbound requests: original + retry
    expect(originalFetch).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);

    // Session must have been invalidated before re-acquire
    expect(mockInvalidateLocalGatewaySession).toHaveBeenCalledTimes(1);
    expect(mockEnsureLocalGatewaySession).toHaveBeenCalledTimes(2);

    // Retry request carries the fresh token
    const retryRequest = originalFetch.mock.calls[1][0] as Request;
    expect(retryRequest.headers.get("x-desktop-session-token")).toBe(
      "fresh-tok"
    );

    uninstall();
  });

  it("returns the exchange error when session refresh after a 401 fails", async () => {
    mockEnsureLocalGatewaySession
      .mockResolvedValueOnce("stale-tok")
      .mockResolvedValueOnce(null);
    mockGetLastExchangeError.mockReturnValue({
      message: "Local gateway auth unavailable: API key required",
      statusCode: 503,
    });

    const originalFetch = vi
      .fn()
      .mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();
    const response = await fetch("/api/gateway/git");

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(mockInvalidateLocalGatewaySession).toHaveBeenCalledTimes(1);
    expect(mockEnsureLocalGatewaySession).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Local gateway auth unavailable: API key required",
    });

    uninstall();
  });

  it("retries POST requests with body without throwing 'body already read'", async () => {
    mockEnsureLocalGatewaySession
      .mockResolvedValueOnce("stale-tok")
      .mockResolvedValueOnce("fresh-tok");

    const originalFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();

    // POST with a body — the body must be reusable across retry
    const response = await fetch("/api/gateway/terminal-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });

    // Retry succeeded
    expect(response.status).toBe(200);
    expect(originalFetch).toHaveBeenCalledTimes(2);

    // Both calls should have the body
    const firstRequest = originalFetch.mock.calls[0][0] as Request;
    const secondRequest = originalFetch.mock.calls[1][0] as Request;
    expect(firstRequest.method).toBe("POST");
    expect(secondRequest.method).toBe("POST");

    // The retry should carry the fresh token
    expect(secondRequest.headers.get("x-desktop-session-token")).toBe(
      "fresh-tok"
    );

    uninstall();
  });

  it("does not retry when the initial session token was null (401 with no session)", async () => {
    // sessionToken is null → 401 should not trigger retry logic
    mockEnsureLocalGatewaySession.mockResolvedValue(null);

    const originalFetch = vi
      .fn()
      .mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();
    const response = await fetch("/api/gateway/git");

    expect(response.status).toBe(401);
    // No retry — fetch called only once
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(mockInvalidateLocalGatewaySession).not.toHaveBeenCalled();

    uninstall();
  });

  it("invalidates session cache on network TypeError", async () => {
    mockEnsureLocalGatewaySession.mockResolvedValue("tok-abc");

    const originalFetch = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();
    await expect(fetch("/api/gateway/git")).rejects.toThrow(TypeError);

    expect(mockInvalidateElectronDetectionCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateLocalGatewaySession).toHaveBeenCalledTimes(1);

    uninstall();
  });

  it("does not swallow non-TypeError errors from fetch", async () => {
    mockEnsureLocalGatewaySession.mockResolvedValue("tok-abc");

    const originalFetch = vi
      .fn()
      .mockRejectedValue(new Error("unexpected error"));

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();
    await expect(fetch("/api/gateway/git")).rejects.toThrow("unexpected error");

    // Non-TypeError: session cache should NOT be invalidated
    expect(mockInvalidateLocalGatewaySession).not.toHaveBeenCalled();

    uninstall();
  });

  it("invalidates session when electron port changes", async () => {
    // First request on port 19432
    mockEnsureLocalGatewaySession
      .mockResolvedValueOnce("tok-port-1")
      .mockResolvedValueOnce("tok-port-2");

    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();
    await fetch("/api/gateway/health-check");

    // Simulate port change
    mockGetElectronDetectionSnapshot.mockReturnValue(
      makeDetectedSnapshot(19_433)
    );
    await fetch("/api/gateway/health-check");

    // Both requests should have been sent
    expect(originalFetch).toHaveBeenCalledTimes(2);

    // Session was requested with the new port on the second call
    expect(mockEnsureLocalGatewaySession).toHaveBeenLastCalledWith(19_433);

    uninstall();
  });

  // --- Fail-closed: missing API key short-circuit ---

  it("returns synthetic response with exchange error status when session is null and exchange error exists", async () => {
    mockEnsureLocalGatewaySession.mockResolvedValue(null);
    mockGetLastExchangeError.mockReturnValue({
      message: "Local gateway auth unavailable: API key required",
      statusCode: 503,
    });

    const originalFetch = vi.fn();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();
    const response = await fetch("/api/gateway/health-check");

    // Should NOT call the original fetch — short-circuited
    expect(originalFetch).not.toHaveBeenCalled();

    // Synthetic response with the actual status code from the exchange
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Local gateway auth unavailable: API key required");

    uninstall();
  });

  it("preserves non-503 status codes in synthetic exchange error responses", async () => {
    mockEnsureLocalGatewaySession.mockResolvedValue(null);
    mockGetLastExchangeError.mockReturnValue({
      message: "invalid challenge token",
      statusCode: 401,
    });

    const originalFetch = vi.fn();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();
    const response = await fetch("/api/gateway/health-check");

    expect(originalFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid challenge token");

    uninstall();
  });

  it("sends request normally when session is null but no exchange error exists", async () => {
    mockEnsureLocalGatewaySession.mockResolvedValue(null);
    mockGetLastExchangeError.mockReturnValue(null);

    const originalFetch = vi
      .fn()
      .mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });

    const uninstall = installEngineerFetchInterceptor();
    const response = await fetch("/api/gateway/health-check");

    // Original fetch IS called (no short-circuit)
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);

    uninstall();
  });
});
