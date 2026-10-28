import { beforeEach, describe, expect, it, vi } from "vitest";
import { startAgentCaptureReceivers } from "../src/main/dashboard/agent-capture-receiver-startup.js";
import { createAgentDashboardRuntimeLifecycle } from "../src/main/dashboard/agent-dashboard-runtime-lifecycle.js";
import { createSessionAnalysisConsentGate } from "../src/main/onboarding/session-analysis-consent-gate.js";
import { createSessionMeshController } from "../src/main/session-mesh/session-mesh-composition.js";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  type OtlpReceiverState,
  OtlpReceiverUnavailableReason,
} from "../src/main/telemetry/otlp-receiver-state.js";
import type { SyncConsentRecord } from "../src/shared/sync-consent.js";
import { deferred } from "./deferred.js";

const mesh = vi.hoisted(() => ({
  create: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  handle: vi.fn(),
  install: vi.fn(),
}));
vi.mock("../src/main/session-mesh/session-mesh-runtime.js", () => ({
  SessionMeshRuntime: class {
    constructor(options: unknown) {
      mesh.create(options);
    }
    start = mesh.start;
    stop = mesh.stop;
    handle = mesh.handle;
  },
}));
vi.mock("../src/main/session-mesh/session-mesh-hook-installer.js", () => ({
  startSessionMeshHookInstallation: mesh.install,
}));
vi.mock("../src/main/session-mesh/session-mesh-local-auth.js", () => ({
  sessionMeshLocalToken: () => "local-token",
}));
vi.mock("../src/main/session-mesh/session-mesh-workspace.js", () => ({
  resolveSessionMeshWorkspace: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe("Mesh startup shares collection consent and listener readiness", () => {
  it("before Welcome Start, unset boot neither starts Mesh ticks nor installs hooks, even on a hook event", async () => {
    const h = fixture();
    h.gate.startCollectorsWhenAgreed(h.capture);
    await h.controller.handle(event);
    await Promise.resolve();
    expect(h.hookListener.start).not.toHaveBeenCalled();
    expect(h.otlpReceiver.start).not.toHaveBeenCalled();
    expect(mesh.create).not.toHaveBeenCalled();
    expect(mesh.start).not.toHaveBeenCalled();
    expect(mesh.install).not.toHaveBeenCalled();
    h.gate.dispose();
    h.answerOff();
    await Promise.resolve();
    expect(mesh.create).not.toHaveBeenCalled();
  });

  it("Welcome Start releases capture and Mesh while the sync choice stays unset", async () => {
    const h = fixture();
    h.gate.startCollectorsWhenAgreed(h.capture);
    h.pressStart();
    await h.started.promise;
    h.bindHook();
    await h.meshReady.promise;
    expect(mesh.start).toHaveBeenCalledTimes(1);
    expect(mesh.install).toHaveBeenCalledTimes(1);
    expect(h.record().tier).toBeNull();
    h.controller.stop();
  });

  it("saved Off releases Mesh once the hook listener binds, before OTLP settles", async () => {
    const h = fixture();
    h.gate.startCollectorsWhenAgreed(h.capture);
    h.answerOff();
    await h.started.promise;
    expect(mesh.start).not.toHaveBeenCalled();
    h.bindHook();
    await h.meshReady.promise;
    expect(mesh.start).toHaveBeenCalledTimes(1);
    expect(mesh.install).toHaveBeenCalledTimes(1);
    expect(
      h.hookListener.publishEphemeralPort.mock.invocationCallOrder[0]
    ).toBeLessThan(mesh.start.mock.invocationCallOrder[0]!);
    expect(h.startReceivers()).toBe(h.startup());
    h.controller.start();
    expect(mesh.start).toHaveBeenCalledTimes(1);
    expect(mesh.install).toHaveBeenCalledTimes(1);
    h.otlp.resolve(available);
    await h.startup();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    await h.controller.handle(event);
    expect(mesh.handle).toHaveBeenCalledWith(event);
    h.lifecycle.beginStop();
    h.controller.stop();
    await h.controller.handle(event);
    expect(mesh.create).toHaveBeenCalledTimes(1);
    expect(mesh.handle).toHaveBeenCalledTimes(1);
    expect(mesh.stop).toHaveBeenCalledTimes(1);
  });

  it.each(["unavailable", "rejected"])(
    "OTLP %s does not prevent Mesh on a bound hook listener",
    async (outcome) => {
      const h = fixture();
      h.answerOff();
      h.gate.startCollectorsWhenAgreed(h.capture);
      await h.started.promise;
      if (outcome === "unavailable") {
        h.otlp.resolve({
          ...available,
          available: false,
          reason: OtlpReceiverUnavailableReason.BindFailed,
        });
      } else {
        h.otlp.reject(new Error("receiver failed"));
      }
      h.bindHook();
      await h.startup();
      expect(mesh.start).toHaveBeenCalledTimes(1);
      expect(mesh.install).toHaveBeenCalledTimes(1);
      expect(h.reconcile).not.toHaveBeenCalled();
      expect(h.log).toHaveBeenCalledTimes(1);
      h.controller.stop();
    }
  );

  it.each(["stop", "close"])(
    "%s while binding prevents deferred Mesh startup and reconciliation",
    async (transition) => {
      const h = fixture();
      h.answerOff();
      h.gate.startCollectorsWhenAgreed(h.capture);
      await h.started.promise;
      if (transition === "stop") {
        h.lifecycle.beginStop();
      } else {
        await h.lifecycle.close(async () => undefined);
      }
      h.controller.stop();
      h.bindHook();
      h.otlp.resolve(available);
      await h.startup();
      await h.controller.handle(event);
      expect(mesh.create).not.toHaveBeenCalled();
      expect(mesh.start).not.toHaveBeenCalled();
      expect(mesh.install).not.toHaveBeenCalled();
      expect(h.reconcile).not.toHaveBeenCalled();
      expect(h.hookListener.publishEphemeralPort).not.toHaveBeenCalled();
    }
  );

  it("a failed hook bind cannot start Mesh or install hooks", async () => {
    const h = fixture();
    h.answerOff();
    h.gate.startCollectorsWhenAgreed(h.capture);
    await h.started.promise;
    h.hook.resolve();
    h.otlp.resolve(available);
    await h.startup();
    expect(mesh.create).not.toHaveBeenCalled();
    expect(mesh.install).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("golden mode starts neither receiver nor Mesh", async () => {
    const h = fixture(true);
    h.gate.startCollectorsWhenAgreed(h.capture);
    await h.started.promise;
    await h.startup();
    expect(h.hookListener.start).not.toHaveBeenCalled();
    expect(h.otlpReceiver.start).not.toHaveBeenCalled();
    expect(mesh.create).not.toHaveBeenCalled();
    expect(mesh.install).not.toHaveBeenCalled();
  });
});

const event = {
  harness: "claude" as const,
  hookType: "SessionStart",
  data: { session_id: "native-session" },
};
const available: OtlpReceiverState = {
  available: true,
  host: DEFAULT_OTLP_RECEIVER_HOST,
  port: 4318,
};

function fixture(golden = false) {
  let record: SyncConsentRecord = {
    bound: true,
    organizationId: null,
    tier: null,
  };
  let startAgreed = false;
  let ready = false;
  let startup: Promise<void> | undefined;
  const hook = deferred<void>();
  const otlp = deferred<OtlpReceiverState>();
  const started = deferred<void>();
  const meshReady = deferred<void>();
  const log = vi.fn();
  const reconcile = vi.fn();
  const controller = createSessionMeshController({
    userDataPath: () => "/unused-mesh-fixture",
    isEnabled: () => !golden,
    getIdentity: () => null,
    getAccessToken: async () => null,
    invalidateAccessToken: () => undefined,
    getApiOrigin: () => "https://api.example.test",
    log,
  });
  const lifecycle = createAgentDashboardRuntimeLifecycle({
    beginClosing: () => undefined,
    close: async () => undefined,
  });
  const hookListener = {
    start: vi.fn(() => hook.promise),
    isReady: () => ready,
    publishEphemeralPort: vi.fn(),
  };
  const otlpReceiver = { start: vi.fn(() => otlp.promise) };
  const startReceivers = () =>
    startAgentCaptureReceivers({
      lifecycle,
      golden,
      hookListener,
      otlpReceiver,
      log,
      onSessionMeshReady: () => {
        controller.start();
        meshReady.resolve();
      },
      reconcileSessionMeshHooks: reconcile,
    });
  const gate = createSessionAnalysisConsentGate({
    isGoldenMode: () => golden,
    isShuttingDown: () => false,
    settings: () => ({
      getSessionAnalysisAgreed: () => startAgreed,
      getSyncConsentRecord: () => record,
      hasSyncObservabilityTierBeenSet: () => true,
    }),
    logWarning: log,
  });
  return {
    gate,
    controller,
    lifecycle,
    hookListener,
    otlpReceiver,
    hook,
    otlp,
    started,
    meshReady,
    log,
    reconcile,
    startReceivers,
    startup: () => startup,
    capture: {
      startCollectors: () => {
        startup = startReceivers();
        started.resolve();
      },
    },
    bindHook: () => {
      ready = true;
      hook.resolve();
    },
    record: () => record,
    pressStart: () => {
      startAgreed = true;
      gate.reconcile();
    },
    answerOff: () => {
      record = { ...record, tier: "local" };
      gate.reconcile();
    },
  };
}
