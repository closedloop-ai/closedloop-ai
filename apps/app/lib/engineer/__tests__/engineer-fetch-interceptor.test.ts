import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureElectronDetection = vi.fn();
const mockGetElectronDetectionSnapshot = vi.fn();
const mockGetEngineerRoutingSelection = vi.fn();
const mockEnsureLocalGatewaySession = vi.fn();
const mockGetLastExchangeError = vi.fn();
const mockEnsureLocalGatewayApiNamespace = vi.fn();

vi.mock("@/lib/engineer/electron-detection", () => ({
  ensureElectronDetection: (...args: unknown[]) =>
    mockEnsureElectronDetection(...args),
  getElectronDetectionSnapshot: (...args: unknown[]) =>
    mockGetElectronDetectionSnapshot(...args),
  invalidateElectronDetectionCache: vi.fn(),
}));

vi.mock("@/lib/engineer/local-gateway-session", () => ({
  ensureLocalGatewaySession: (...args: unknown[]) =>
    mockEnsureLocalGatewaySession(...args),
  invalidateLocalGatewaySession: vi.fn(),
  getLastExchangeError: (...args: unknown[]) =>
    mockGetLastExchangeError(...args),
}));

vi.mock("@/lib/engineer/local-gateway-api-namespace", () => ({
  ensureLocalGatewayApiNamespace: (...args: unknown[]) =>
    mockEnsureLocalGatewayApiNamespace(...args),
  invalidateLocalGatewayApiNamespace: vi.fn(),
}));

vi.mock("@/lib/engineer/routing-store", () => ({
  getEngineerRoutingSelection: (...args: unknown[]) =>
    mockGetEngineerRoutingSelection(...args),
}));

vi.mock("@/lib/engineer/constants", () => ({
  CLOUD_RELAY_ENABLED: false,
  DESKTOP_SETUP_URL: "https://closedloop.so/desktop",
  VALID_PROVIDERS: new Set(["claude", "codex"]),
  COMPUTE_TARGETS_QUERY_OPTIONS: { staleTime: 30_000, refetchInterval: 30_000 },
}));

import {
  installEngineerFetchInterceptor,
  resetEngineerFetchInterceptorForTests,
} from "@/lib/engineer/engineer-fetch-interceptor";

describe("engineer-fetch-interceptor", () => {
  beforeEach(() => {
    resetEngineerFetchInterceptorForTests();
    vi.restoreAllMocks();
    mockEnsureElectronDetection.mockReset();
    mockGetElectronDetectionSnapshot.mockReset();
    mockGetEngineerRoutingSelection.mockReset();
    mockEnsureLocalGatewaySession.mockReset();
    mockGetLastExchangeError.mockReset();
    mockEnsureLocalGatewayApiNamespace.mockReset();
    // Default: session available, no exchange errors
    mockEnsureLocalGatewaySession.mockResolvedValue("test-session-token");
    mockGetLastExchangeError.mockReturnValue(null);
    mockEnsureLocalGatewayApiNamespace.mockResolvedValue("gateway");
  });

  afterEach(() => {
    resetEngineerFetchInterceptorForTests();
    vi.restoreAllMocks();
  });

  it("rewrites gateway routes to localhost when electron is detected", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    mockGetEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
      source: "auto",
      updatedAt: Date.now(),
    });

    mockGetElectronDetectionSnapshot.mockReturnValue({
      detected: true,
      loading: false,
      port: 19_432,
      version: "1.0.0",
      machineName: "machine-1",
      capabilities: {},
      checkedAt: Date.now(),
    });

    const uninstall = installEngineerFetchInterceptor();

    await fetch("/api/gateway/health-check", {
      headers: {
        Authorization: "Bearer sk_live_123",
        Cookie: "session=abc",
      },
    });

    expect(originalFetch).toHaveBeenCalledTimes(1);
    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    expect(outboundRequest.url).toBe(
      "http://localhost:19432/api/gateway/health-check"
    );
    expect(outboundRequest.headers.get("authorization")).toBeNull();
    expect(outboundRequest.headers.get("cookie")).toBeNull();

    uninstall();
  });

  it("rewrites gateway routes to the legacy engineer namespace when required", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    mockGetEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
      source: "auto",
      updatedAt: Date.now(),
    });

    mockGetElectronDetectionSnapshot.mockReturnValue({
      detected: true,
      loading: false,
      port: 19_432,
      version: "1.0.0",
      machineName: "machine-1",
      capabilities: {},
      checkedAt: Date.now(),
    });
    mockEnsureLocalGatewayApiNamespace.mockResolvedValue("engineer");

    const uninstall = installEngineerFetchInterceptor();

    await fetch("/api/gateway/terminal-chat", {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
    });

    expect(originalFetch).toHaveBeenCalledTimes(1);
    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    expect(outboundRequest.url).toBe(
      "http://localhost:19432/api/engineer/terminal-chat"
    );

    uninstall();
  });

  it("does NOT rewrite to relay endpoint when CLOUD_RELAY_ENABLED=false and cloud target is selected", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    mockGetEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-1",
      source: "manual",
      updatedAt: Date.now(),
    });

    const uninstall = installEngineerFetchInterceptor();

    await fetch("/api/gateway/git", { method: "POST" });

    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    const outboundUrl = new URL(outboundRequest.url);
    // With CLOUD_RELAY_ENABLED=false, the relay rewrite branch is skipped.
    // The catch-all sends the request as-is via originalFetch.
    expect(outboundUrl.pathname.startsWith("/api/gateway-relay/")).toBe(false);
    expect(outboundRequest.headers.get("x-compute-target")).toBeNull();

    uninstall();
  });

  it("leaves non-gateway routes untouched", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    mockGetEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
      source: "auto",
      updatedAt: Date.now(),
    });

    mockGetElectronDetectionSnapshot.mockReturnValue({
      detected: true,
      loading: false,
      port: 19_432,
      version: "1.0.0",
      machineName: "machine-1",
      capabilities: {},
      checkedAt: Date.now(),
    });

    const uninstall = installEngineerFetchInterceptor();
    await fetch("/api/health");

    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    const outboundUrl = new URL(outboundRequest.url);
    expect(outboundUrl.pathname).toBe("/api/health");
    expect(outboundUrl.port).not.toBe("19432");

    uninstall();
  });

  it("probes once when snapshot has not been initialized", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    mockGetEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
      source: "auto",
      updatedAt: Date.now(),
    });

    mockGetElectronDetectionSnapshot.mockReturnValue({
      detected: false,
      loading: true,
      port: null,
      version: null,
      machineName: null,
      capabilities: null,
      checkedAt: null,
    });
    mockEnsureElectronDetection.mockResolvedValue({
      detected: false,
      loading: false,
      port: null,
      version: null,
      machineName: null,
      capabilities: null,
      checkedAt: Date.now(),
    });

    const uninstall = installEngineerFetchInterceptor();
    await fetch("/api/gateway/git");

    expect(mockEnsureElectronDetection).toHaveBeenCalledTimes(1);
    expect(originalFetch).toHaveBeenCalledTimes(1);

    uninstall();
  });

  it("preserves provider query param through local electron rewrite", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    mockGetEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
      source: "auto",
      updatedAt: Date.now(),
    });
    mockGetElectronDetectionSnapshot.mockReturnValue({
      detected: true,
      loading: false,
      port: 19_432,
      version: "1.0.0",
      machineName: "machine-1",
      capabilities: {},
      checkedAt: Date.now(),
    });

    const uninstall = installEngineerFetchInterceptor();
    await fetch(
      "/api/gateway/symphony/chat-history/pr-42?repo=%2Ftmp%2Frepo&provider=claude"
    );

    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    const outboundUrl = new URL(outboundRequest.url);
    expect(outboundUrl.pathname).toBe(
      "/api/gateway/symphony/chat-history/pr-42"
    );
    expect(outboundUrl.searchParams.get("provider")).toBe("claude");
    expect(outboundUrl.searchParams.get("repo")).toBe("/tmp/repo");

    uninstall();
  });

  it("passes request as-is for CloudRelay mode when CLOUD_RELAY_ENABLED=false (no relay rewrite)", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    mockGetEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-1",
      source: "manual",
      updatedAt: Date.now(),
    });

    const uninstall = installEngineerFetchInterceptor();
    await fetch(
      "/api/gateway/symphony/chat-history/pr-42?repo=%2Ftmp%2Frepo&provider=codex",
      { method: "DELETE" }
    );

    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    const outboundUrl = new URL(outboundRequest.url);
    // With CLOUD_RELAY_ENABLED=false, no relay rewrite occurs — the catch-all
    // sends the request as-is via originalFetch.
    expect(outboundUrl.pathname.startsWith("/api/gateway-relay/")).toBe(false);
    expect(outboundUrl.pathname).toBe(
      "/api/gateway/symphony/chat-history/pr-42"
    );
    expect(outboundUrl.searchParams.get("provider")).toBe("codex");
    expect(outboundUrl.searchParams.get("repo")).toBe("/tmp/repo");
    expect(outboundRequest.headers.get("x-compute-target")).toBeNull();

    uninstall();
  });

  it("preserves POST body when rewriting to local electron", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    mockGetEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
      source: "manual",
      updatedAt: Date.now(),
    });
    mockGetElectronDetectionSnapshot.mockReturnValue({
      detected: true,
      loading: false,
      port: 19_432,
      version: "1.0.0",
      machineName: "machine-1",
      capabilities: {},
      checkedAt: Date.now(),
    });

    const uninstall = installEngineerFetchInterceptor();
    await fetch("/api/gateway/terminal-chat", {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
      headers: {
        Authorization: "Bearer sk_live_123",
        Cookie: "session=abc",
      },
    });

    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    expect(outboundRequest.url).toBe(
      "http://localhost:19432/api/gateway/terminal-chat"
    );
    expect(outboundRequest.method).toBe("POST");
    await expect(outboundRequest.text()).resolves.toBe(
      JSON.stringify({ message: "hello" })
    );
    expect(outboundRequest.headers.get("authorization")).toBeNull();
    expect(outboundRequest.headers.get("cookie")).toBeNull();

    uninstall();
  });
});

describe("engineer-fetch-interceptor (CLOUD_RELAY_ENABLED=true)", () => {
  let installInterceptor: typeof installEngineerFetchInterceptor;
  let resetInterceptor: typeof resetEngineerFetchInterceptorForTests;
  let mockRoutingSelection: Mock;

  beforeEach(async () => {
    vi.resetModules();

    mockRoutingSelection = vi.fn();

    vi.doMock("@/lib/engineer/constants", () => ({
      CLOUD_RELAY_ENABLED: true,
      DESKTOP_SETUP_URL: "https://closedloop.so/desktop",
      VALID_PROVIDERS: new Set(["claude", "codex"]),
      COMPUTE_TARGETS_QUERY_OPTIONS: {
        staleTime: 30_000,
        refetchInterval: 30_000,
      },
    }));

    vi.doMock("@/lib/engineer/routing-store", () => ({
      getEngineerRoutingSelection: (...args: unknown[]) =>
        mockRoutingSelection(...args),
    }));

    vi.doMock("@/lib/engineer/electron-detection", () => ({
      ensureElectronDetection: vi.fn(),
      getElectronDetectionSnapshot: vi.fn(),
      invalidateElectronDetectionCache: vi.fn(),
    }));

    vi.doMock("@/lib/engineer/local-gateway-session", () => ({
      ensureLocalGatewaySession: vi
        .fn()
        .mockResolvedValue("test-session-token"),
      invalidateLocalGatewaySession: vi.fn(),
      getLastExchangeError: vi.fn().mockReturnValue(null),
    }));

    const mod = await import("@/lib/engineer/engineer-fetch-interceptor");
    installInterceptor = mod.installEngineerFetchInterceptor;
    resetInterceptor = mod.resetEngineerFetchInterceptorForTests;

    resetInterceptor();
  });

  afterEach(() => {
    resetInterceptor();
    vi.resetModules();
  });

  it("rewrites engineer requests to relay endpoint when cloud target is selected", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    mockRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-1",
      source: "manual",
      updatedAt: Date.now(),
    });

    const uninstall = installInterceptor();

    await fetch("/api/gateway/git", { method: "POST" });

    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    const outboundUrl = new URL(outboundRequest.url);
    expect(outboundUrl.pathname).toBe("/api/gateway-relay/git");
    expect(outboundRequest.headers.get("x-compute-target")).toBe("target-1");

    uninstall();
  });

  it("preserves query params through relay rewrite when CLOUD_RELAY_ENABLED=true", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    mockRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-2",
      source: "manual",
      updatedAt: Date.now(),
    });

    const uninstall = installInterceptor();

    await fetch(
      "/api/gateway/symphony/chat-history/pr-10?repo=%2Ftmp%2Frepo&provider=codex",
      { method: "DELETE" }
    );

    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    const outboundUrl = new URL(outboundRequest.url);
    expect(outboundUrl.pathname).toBe(
      "/api/gateway-relay/symphony/chat-history/pr-10"
    );
    expect(outboundUrl.searchParams.get("provider")).toBe("codex");
    expect(outboundUrl.searchParams.get("repo")).toBe("/tmp/repo");
    expect(outboundRequest.headers.get("x-compute-target")).toBe("target-2");

    uninstall();
  });
});
