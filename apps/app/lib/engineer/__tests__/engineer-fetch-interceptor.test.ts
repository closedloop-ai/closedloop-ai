import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnsureElectronDetection = vi.fn();
const mockGetElectronDetectionSnapshot = vi.fn();
const mockGetEngineerRoutingSelection = vi.fn();

vi.mock("@/lib/engineer/electron-detection", () => ({
  ensureElectronDetection: (...args: unknown[]) =>
    mockEnsureElectronDetection(...args),
  getElectronDetectionSnapshot: (...args: unknown[]) =>
    mockGetElectronDetectionSnapshot(...args),
}));

vi.mock("@/lib/engineer/routing-store", () => ({
  getEngineerRoutingSelection: (...args: unknown[]) =>
    mockGetEngineerRoutingSelection(...args),
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
  });

  afterEach(() => {
    resetEngineerFetchInterceptorForTests();
    vi.restoreAllMocks();
  });

  it("rewrites engineer routes to localhost when electron is detected", async () => {
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

    await fetch("/api/engineer/health-check", {
      headers: {
        Authorization: "Bearer sk_live_123",
        Cookie: "session=abc",
      },
    });

    expect(originalFetch).toHaveBeenCalledTimes(1);
    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    expect(outboundRequest.url).toBe(
      "http://localhost:19432/api/engineer/health-check"
    );
    expect(outboundRequest.headers.get("authorization")).toBeNull();
    expect(outboundRequest.headers.get("cookie")).toBeNull();

    uninstall();
  });

  it("routes engineer requests to relay endpoint when cloud target is selected", async () => {
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

    await fetch("/api/engineer/git", { method: "POST" });

    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    const outboundUrl = new URL(outboundRequest.url);
    expect(outboundUrl.pathname).toBe("/api/engineer-relay/git");
    expect(outboundRequest.headers.get("x-compute-target")).toBe("target-1");

    uninstall();
  });

  it("leaves non-engineer routes untouched", async () => {
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
    await fetch("/api/engineer/git");

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
      "/api/engineer/symphony/chat-history/pr-42?repo=%2Ftmp%2Frepo&provider=claude"
    );

    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    const outboundUrl = new URL(outboundRequest.url);
    expect(outboundUrl.pathname).toBe(
      "/api/engineer/symphony/chat-history/pr-42"
    );
    expect(outboundUrl.searchParams.get("provider")).toBe("claude");
    expect(outboundUrl.searchParams.get("repo")).toBe("/tmp/repo");

    uninstall();
  });

  it("preserves provider query param through cloud relay rewrite", async () => {
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
      "/api/engineer/symphony/chat-history/pr-42?repo=%2Ftmp%2Frepo&provider=codex",
      { method: "DELETE" }
    );

    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    const outboundUrl = new URL(outboundRequest.url);
    expect(outboundUrl.pathname).toBe(
      "/api/engineer-relay/symphony/chat-history/pr-42"
    );
    expect(outboundUrl.searchParams.get("provider")).toBe("codex");
    expect(outboundUrl.searchParams.get("repo")).toBe("/tmp/repo");

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
    await fetch("/api/engineer/terminal-chat", {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
      headers: {
        Authorization: "Bearer sk_live_123",
        Cookie: "session=abc",
      },
    });

    const outboundRequest = originalFetch.mock.calls[0][0] as Request;
    expect(outboundRequest.url).toBe(
      "http://localhost:19432/api/engineer/terminal-chat"
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
