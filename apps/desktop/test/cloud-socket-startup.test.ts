import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { CloudSocketStatus } from "../src/main/cloud/cloud-protocol.js";
import type { ApiKeyDiagnostic } from "../src/main/cloud/cloud-socket.js";
import { CloudSocketService } from "../src/main/cloud/cloud-socket.js";
import { CloudSocketStartupCoordinator } from "../src/main/cloud/cloud-socket-startup.js";
import { BOOT_ADMISSION_DEADLINE_MS } from "../src/main/lifecycle/boot-admission-deadline.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { CloudSocketError } from "../src/shared/cloud-socket-error.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

afterEach(() => {
  gatewayLog.clear();
});

describe("delayed cloud socket startup", () => {
  test("surfaces a missing API key through the canonical socket failure path", async () => {
    const statuses: CloudSocketStatus[] = [];
    const service = createMissingKeyService((status) => statuses.push(status));
    const startup = new CloudSocketStartupCoordinator();

    await startup.startAfterInitialUi({
      isCloudConnectionEnabled: () => true,
      isShuttingDown: () => false,
      startCloudSocket: () => service.start(),
      waitForWindowReveal: () => Promise.resolve(),
      waitForInitialUi: () => Promise.resolve(),
      yieldToMainLoop: () => Promise.resolve(),
    });

    assert.deepEqual(statuses, [
      {
        state: "degraded",
        error: CloudSocketError.MissingApiKey,
      },
    ]);
    assert.deepEqual(
      gatewayLog
        .getEntries()
        .filter((entry) => entry.tag === "cloud-socket")
        .map(({ level, message }) => ({ level, message })),
      [
        {
          level: "warn",
          message: CloudSocketError.MissingApiKey,
        },
      ]
    );
  });

  test("distinguishes an undecryptable stored key from a genuinely missing key", async () => {
    const statuses: CloudSocketStatus[] = [];
    const service = createMissingKeyService(
      (status) => statuses.push(status),
      "undecryptable"
    );
    const startup = new CloudSocketStartupCoordinator();

    await startup.startAfterInitialUi({
      isCloudConnectionEnabled: () => true,
      isShuttingDown: () => false,
      startCloudSocket: () => service.start(),
      waitForWindowReveal: () => Promise.resolve(),
      waitForInitialUi: () => Promise.resolve(),
      yieldToMainLoop: () => Promise.resolve(),
    });

    assert.deepEqual(statuses, [
      {
        state: "degraded",
        error: CloudSocketError.DecryptionFailed,
      },
    ]);
    assert.deepEqual(
      gatewayLog
        .getEntries()
        .filter((entry) => entry.tag === "cloud-socket")
        .map(({ level, message }) => ({ level, message })),
      [
        {
          level: "warn",
          message: CloudSocketError.DecryptionFailed,
        },
      ]
    );
  });

  test("does not start after shutdown or while the cloud connection is disabled", async () => {
    let startCount = 0;
    const startup = new CloudSocketStartupCoordinator();
    const startCloudSocket = () => {
      startCount += 1;
      return Promise.resolve();
    };

    await startup.startAfterInitialUi({
      isCloudConnectionEnabled: () => true,
      isShuttingDown: () => true,
      startCloudSocket,
      waitForWindowReveal: () => Promise.resolve(),
      waitForInitialUi: () => Promise.resolve(),
      yieldToMainLoop: () => Promise.resolve(),
    });
    await startup.startAfterInitialUi({
      isCloudConnectionEnabled: () => false,
      isShuttingDown: () => false,
      startCloudSocket,
      waitForWindowReveal: () => Promise.resolve(),
      waitForInitialUi: () => Promise.resolve(),
      yieldToMainLoop: () => Promise.resolve(),
    });

    assert.equal(startCount, 0);
  });

  test("does not start a superseded continuation after readiness resolves", async () => {
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let startCount = 0;
    const startup = new CloudSocketStartupCoordinator();
    const pending = startup.startAfterInitialUi({
      isCloudConnectionEnabled: () => true,
      isShuttingDown: () => false,
      startCloudSocket: () => {
        startCount += 1;
        return Promise.resolve();
      },
      waitForWindowReveal: () => Promise.resolve(),
      waitForInitialUi: () => ready,
      yieldToMainLoop: () => Promise.resolve(),
    });

    startup.invalidate();
    resolveReady();
    await pending;

    assert.equal(startCount, 0);
  });

  test("ISS-5990 HEADLESS BOOT: starts the socket when the window never reveals", async () => {
    // The counterpart to the ISS-5346 ordering test below, on the path that test
    // cannot reach. `waitForWindowReveal` is `whenInitiallyShown()`, armed only
    // by the renderer-ready IPC or an explicit show, so a boot where the renderer
    // never signals left this await pending for the life of the process and the
    // cloud socket simply never started. The coordinator now bounds the hop.
    const events: string[] = [];
    const startup = new CloudSocketStartupCoordinator();

    nodeTestTimers.enable(["setTimeout"]);
    try {
      const pending = startup.startAfterInitialUi({
        isCloudConnectionEnabled: () => true,
        isShuttingDown: () => false,
        startCloudSocket: () => {
          events.push("socket-start");
          return Promise.resolve();
        },
        waitForWindowReveal: () => new Promise<void>(() => undefined),
        waitForInitialUi: () => Promise.resolve(),
        yieldToMainLoop: () => Promise.resolve(),
      });

      nodeTestTimers.tick(BOOT_ADMISSION_DEADLINE_MS - 1);
      await Promise.resolve();
      // Still held one tick short of the bound: the reveal remains the fast path
      // and the socket's first burst still yields to first paint when there is one.
      assert.deepEqual(events, []);

      nodeTestTimers.tick(1);
      await pending;
    } finally {
      nodeTestTimers.reset();
    }

    assert.deepEqual(events, ["socket-start"]);
  });

  test("ISS-5346: holds the socket behind the window reveal, then the readiness gates", async () => {
    // The ordering regression. `waitForInitialUi` (the dashboard readiness
    // gates) fails open on its own 2s bound, so on a slow renderer it can
    // resolve BEFORE the window has been revealed. If the reveal hop is dropped
    // — or moved after it — the socket's first burst lands in first paint,
    // which is the contention this sequence exists to prevent.
    const events: string[] = [];
    let revealWindow: () => void = () => undefined;
    const revealed = new Promise<void>((resolve) => {
      revealWindow = resolve;
    });
    const startup = new CloudSocketStartupCoordinator();

    const pending = startup.startAfterInitialUi({
      isCloudConnectionEnabled: () => true,
      isShuttingDown: () => false,
      startCloudSocket: () => {
        events.push("socket-start");
        return Promise.resolve();
      },
      waitForWindowReveal: () => revealed,
      waitForInitialUi: () => {
        events.push("readiness-wait");
        return Promise.resolve();
      },
      yieldToMainLoop: () => Promise.resolve(),
    });

    // The readiness gates would have failed open by now; nothing may have run,
    // because the window has not been revealed.
    await Promise.resolve();
    assert.deepEqual(events, []);

    revealWindow();
    await pending;

    assert.deepEqual(events, ["readiness-wait", "socket-start"]);
  });
});

function createMissingKeyService(
  onStatusChange: (status: CloudSocketStatus) => void,
  diagnostic: ApiKeyDiagnostic = "missing"
): CloudSocketService {
  return new CloudSocketService({
    getRelayOrigin: () => "https://relay.example.com",
    getApiKey: () => null,
    getApiKeyDiagnostic: () => diagnostic,
    getAllowedDirectories: () => ["/tmp"],
    getMaxInFlightCommands: () => 5,
    getEnabledOperations: () => ["test_op"],
    machineName: "test-machine",
    pluginVersion: "1.0.0-test",
    desktopClientVersion: "0.16.0-test",
    gatewayProtocolVersion: "0.1.0",
    onStatusChange,
  });
}
