import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureGatewayDetection,
  getGatewayDetectionSnapshot,
  invalidateGatewayDetectionCache,
  resetGatewayDetectionForTests,
  subscribeGatewayDetection,
} from "../detection-store";

// Mock the gateway probe
vi.mock("../gateway-probe", () => ({
  probeGateway: vi.fn(),
}));

import { probeGateway } from "../gateway-probe";

const mockProbeGateway = vi.mocked(probeGateway);

describe("detection-store", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    resetGatewayDetectionForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns default state initially", () => {
    const snapshot = getGatewayDetectionSnapshot();
    expect(snapshot.detected).toBe(false);
    expect(snapshot.loading).toBe(true);
    expect(snapshot.checkedAt).toBeNull();
  });

  it("updates snapshot after successful probe", async () => {
    mockProbeGateway.mockResolvedValueOnce({
      detected: true,
      port: 19_432,
      version: "1.0.0",
      machineName: "test-machine",
      gatewayId: "gw-123",
      capabilities: {},
      onboardingCompleted: true,
    });

    const result = await ensureGatewayDetection();

    expect(result.detected).toBe(true);
    expect(result.port).toBe(19_432);
    expect(result.version).toBe("1.0.0");
    expect(result.loading).toBe(false);
    expect(result.checkedAt).toBeTypeOf("number");
  });

  it("handles probe failure gracefully", async () => {
    mockProbeGateway.mockRejectedValueOnce(new Error("Network error"));

    const result = await ensureGatewayDetection();

    expect(result.detected).toBe(false);
    expect(result.loading).toBe(false);
    expect(result.checkedAt).toBeTypeOf("number");
  });

  it("uses cached result within TTL", async () => {
    mockProbeGateway.mockResolvedValueOnce({
      detected: true,
      port: 19_432,
      version: "1.0.0",
      machineName: "test",
      gatewayId: "gw-1",
      capabilities: {},
      onboardingCompleted: true,
    });

    await ensureGatewayDetection();
    const firstCallCount = mockProbeGateway.mock.calls.length;

    await ensureGatewayDetection();
    expect(mockProbeGateway.mock.calls.length).toBe(firstCallCount);
  });

  it("re-probes after cache invalidation", async () => {
    mockProbeGateway.mockResolvedValue({
      detected: true,
      port: 19_432,
      version: "1.0.0",
      machineName: "test",
      gatewayId: "gw-1",
      capabilities: {},
      onboardingCompleted: true,
    });

    await ensureGatewayDetection();
    const firstCallCount = mockProbeGateway.mock.calls.length;

    invalidateGatewayDetectionCache();
    await ensureGatewayDetection();
    expect(mockProbeGateway.mock.calls.length).toBe(firstCallCount + 1);
  });

  it("notifies listeners on state change", async () => {
    const listener = vi.fn();
    subscribeGatewayDetection(listener);

    mockProbeGateway.mockResolvedValueOnce({
      detected: true,
      port: 19_432,
      version: "1.0.0",
      machineName: "test",
      gatewayId: "gw-1",
      capabilities: {},
      onboardingCompleted: true,
    });

    await ensureGatewayDetection();
    expect(listener).toHaveBeenCalled();
  });

  it("returns SSR-safe state when window is undefined", async () => {
    vi.stubGlobal("window", undefined);
    resetGatewayDetectionForTests();

    const result = await ensureGatewayDetection();
    expect(result.detected).toBe(false);
    expect(result.loading).toBe(false);
  });

  it("deduplicates concurrent probes", async () => {
    const callCountBefore = mockProbeGateway.mock.calls.length;
    let resolveProbe:
      | ((value: Awaited<ReturnType<typeof probeGateway>>) => void)
      | undefined;
    mockProbeGateway.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        })
    );

    const p1 = ensureGatewayDetection({ force: true });
    const p2 = ensureGatewayDetection({ force: true });

    resolveProbe?.({
      detected: true,
      port: 19_432,
      version: "1.0.0",
      machineName: "test",
      gatewayId: "gw-1",
      capabilities: {},
      onboardingCompleted: true,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(mockProbeGateway.mock.calls.length - callCountBefore).toBe(1);
  });
});
