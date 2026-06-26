import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type GatewayRecoveryDeps,
  GatewayRecoveryManager,
} from "../src/main/gateway-recovery.js";

function createStubDeps(
  overrides?: Partial<GatewayRecoveryDeps>
): GatewayRecoveryDeps & {
  calls: Record<string, unknown[][]>;
  cloudState: { state: string };
  paused: boolean;
  shuttingDown: boolean;
} {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, ...args: unknown[]) => {
    calls[name] ??= [];
    calls[name].push(args);
  };

  const cloudState = { state: "online" };
  const state = {
    calls,
    cloudState,
    paused: false,
    shuttingDown: false,
    probe: async () => {
      record("probe");
      return true;
    },
    restart: async () => {
      record("restart");
    },
    getCloudStatus: () => cloudState,
    setConnected: (connected: boolean) => record("setConnected", connected),
    sendPresence: (presState: "online" | "degraded", error?: string) =>
      record("sendPresence", presState, error),
    refreshTray: (detail?: string) => record("refreshTray", detail),
    log: (level: string, msg: string) => record("log", level, msg),
    isShuttingDown: () => state.shuttingDown,
    isPaused: () => state.paused,
    ...overrides,
  };
  return state;
}

test("healthy reconnect: probe returns true, setConnected(true) called, restart NOT called", async () => {
  const deps = createStubDeps();
  const mgr = new GatewayRecoveryManager(deps);

  await mgr.onCloudOnline();

  assert.ok(
    deps.calls.setConnected?.some(([v]) => v === true),
    "setConnected(true) should be called"
  );
  assert.ok(
    deps.calls.sendPresence?.some(([s]) => s === "online"),
    "sendPresence('online') should be called"
  );
  assert.ok(!deps.calls.restart, "restart should NOT be called");
  assert.equal(mgr.gatewayHealthy, true);
});

test("failed probe triggers restart", async () => {
  const deps = createStubDeps({
    probe: async () => false,
  });
  const mgr = new GatewayRecoveryManager(deps);

  await mgr.onCloudOnline();

  assert.ok(deps.calls.restart, "restart should be called");
  assert.ok(
    deps.calls.setConnected?.some(([v]) => v === true),
    "setConnected(true) should be called after recovery"
  );
  assert.equal(mgr.gatewayHealthy, true);
});

test("failed probe + failed restart leaves degraded", async () => {
  const deps = createStubDeps({
    probe: async () => false,
    restart: async () => {
      throw new Error("bind failed");
    },
  });
  const mgr = new GatewayRecoveryManager(deps);

  await mgr.onCloudOnline();

  assert.equal(mgr.gatewayHealthy, false);
  assert.ok(
    deps.calls.setConnected?.some(([v]) => v === false),
    "setConnected(false) should be called"
  );
  assert.ok(
    deps.calls.sendPresence?.some(([s]) => s === "degraded"),
    "sendPresence('degraded') should be called"
  );
});

test("concurrent recovery is deduplicated", async () => {
  let restartCount = 0;
  const deps = createStubDeps({
    restart: async () => {
      restartCount++;
    },
  });
  const mgr = new GatewayRecoveryManager(deps);

  const p1 = mgr.recoverGateway("reason 1");
  const p2 = mgr.recoverGateway("reason 2");
  await Promise.all([p1, p2]);

  assert.equal(restartCount, 1, "restart should only be called once");
});

test("stale epoch cancels reconnect", async () => {
  let probeResolve: (() => void) | null = null;
  const deps = createStubDeps({
    probe: () =>
      new Promise<boolean>((resolve) => {
        probeResolve = () => resolve(true);
      }),
  });
  const mgr = new GatewayRecoveryManager(deps);

  const promise = mgr.onCloudOnline();

  // Simulate cloud going offline during probe
  deps.cloudState.state = "degraded";
  probeResolve!();
  await promise;

  // setConnected(true) should NOT have been called because epoch/state changed
  const setConnectedTrue =
    deps.calls.setConnected?.filter(([v]) => v === true) ?? [];
  assert.equal(
    setConnectedTrue.length,
    0,
    "setConnected(true) should not be called when cloud went offline during probe"
  );
});

test("unexpected close during in-flight reconnect probe deduplicates restart", async () => {
  let restartCount = 0;
  let probeResolve: (() => void) | null = null;
  const deps = createStubDeps({
    probe: () =>
      new Promise<boolean>((resolve) => {
        probeResolve = () => resolve(false);
      }),
    restart: async () => {
      restartCount++;
    },
  });
  const mgr = new GatewayRecoveryManager(deps);

  const onlinePromise = mgr.onCloudOnline();

  // Fire unexpected close while probe is in-flight
  mgr.onUnexpectedClose();

  // Resolve the probe (returns false)
  probeResolve!();
  await onlinePromise;

  // Wait for the recovery triggered by onUnexpectedClose to also complete
  // The onCloudOnline's recoverGateway should join the existing recovery from onUnexpectedClose
  // or vice versa (single-flight guarantee)
  assert.equal(
    restartCount,
    1,
    "restart should only be called once despite concurrent triggers"
  );
});
