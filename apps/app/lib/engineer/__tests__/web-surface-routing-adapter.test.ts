import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_RELAY_PATH_PREFIX } from "@/lib/engineer/constants";

const mockGetRoutingSelection = vi.fn();

vi.mock("@/lib/engineer/routing-store", () => ({
  getEngineerRoutingSelection: (...args: unknown[]) =>
    mockGetRoutingSelection(...args),
}));

vi.mock("@/lib/engineer/constants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/engineer/constants")>();
  return { ...actual, CLOUD_RELAY_ENABLED: true };
});

// LocalElectron path: report "not detected" so dispatch falls through to the
// original fetch with the unmodified gateway URL (no session/namespace needed).
vi.mock("@/lib/engineer/electron-detection", () => ({
  getElectronDetectionSnapshot: () => ({
    detected: false,
    loading: false,
    port: null,
    checkedAt: Date.now(),
  }),
  ensureElectronDetection: vi.fn(),
  invalidateElectronDetectionCache: vi.fn(),
}));

vi.mock("@/lib/engineer/local-gateway-session", () => ({
  ensureLocalGatewaySession: vi.fn(),
  invalidateLocalGatewaySession: vi.fn(),
  getLastExchangeError: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/engineer/local-gateway-api-namespace", () => ({
  ensureLocalGatewayApiNamespace: vi.fn(),
  invalidateLocalGatewayApiNamespace: vi.fn(),
}));

vi.mock("@/lib/desktop-command-signing/compute-target-signing-cache", () => ({
  getCachedComputeTargetForSigning: () => null,
}));

import { createWebSurfaceRoutingAdapter } from "@/lib/engineer/web-surface-routing-adapter";

const ORIGIN = "http://localhost:3000";

describe("createWebSurfaceRoutingAdapter — supportsMode", () => {
  it("supports both CloudRelay and LocalElectron", () => {
    const adapter = createWebSurfaceRoutingAdapter(vi.fn());
    expect(adapter.surfaceName).toBe("web");
    expect(adapter.supportsMode(EngineerRoutingMode.CloudRelay)).toBe(true);
    expect(adapter.supportsMode(EngineerRoutingMode.LocalElectron)).toBe(true);
  });
});

describe("createWebSurfaceRoutingAdapter — mode change without reload", () => {
  beforeEach(() => {
    mockGetRoutingSelection.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reads the active routing selection per dispatch, so switching modes needs no re-install", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const adapter = createWebSurfaceRoutingAdapter(originalFetch);

    // First dispatch: CloudRelay with a target → rewritten to the relay path.
    mockGetRoutingSelection.mockReturnValueOnce({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-1",
      source: "manual",
      updatedAt: 0,
    });
    await adapter.dispatchGatewayRequest(`${ORIGIN}/api/gateway/git`, {
      method: "POST",
    });

    // Second dispatch on the SAME adapter instance: LocalElectron (undetected)
    // → falls through to the original gateway path. No new adapter/install.
    mockGetRoutingSelection.mockReturnValueOnce({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
      source: "manual",
      updatedAt: 0,
    });
    await adapter.dispatchGatewayRequest(`${ORIGIN}/api/gateway/git`, {
      method: "POST",
    });

    expect(originalFetch).toHaveBeenCalledTimes(2);
    const first = originalFetch.mock.calls[0][0] as Request;
    const second = originalFetch.mock.calls[1][0] as Request;
    expect(new URL(first.url).pathname).toBe(`${GATEWAY_RELAY_PATH_PREFIX}git`);
    expect(new URL(second.url).pathname).toBe("/api/gateway/git");
  });
});
