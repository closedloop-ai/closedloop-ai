import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  buildSettingsLocalDeviceSnapshot,
  registerSettingsLocalDeviceIpcHandlers,
  type SettingsLocalDeviceIpcDeps,
} from "../src/main/ipc/settings-local-device-ipc.js";
import {
  parseSettingsLocalDeviceSnapshot,
  SETTINGS_LOCAL_DEVICE_CHANNEL,
} from "../src/shared/settings-local-device-contract.js";

// ISS-8379 (PRD-691): the producer half of the Settings local-device contract.
// The renderer half (skew, malformed payloads) is covered by
// `src/renderer/settings-host/__tests__/desktop-settings-host-adapter.test.ts`.

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

const UNTRUSTED_EVENT = { sender: {} };
const TRUSTED_EVENT = { sender: { trusted: true } };
const UNTRUSTED_SENDER_ERROR = /untrusted sender/;

function makeDeps(
  overrides: Partial<SettingsLocalDeviceIpcDeps> = {}
): SettingsLocalDeviceIpcDeps {
  return {
    isTrustedSender: () => true,
    getMachineName: () => "workshop-mini",
    getPlatform: () => "darwin",
    getAppVersion: () => "1.2.3",
    getActivePort: () => 41_234,
    isServerAlive: () => true,
    getComputeTargetId: () => "ct-01",
    ...overrides,
  };
}

function registerHandler(deps: SettingsLocalDeviceIpcDeps): IpcHandler {
  const handlers = new Map<string, IpcHandler>();
  registerSettingsLocalDeviceIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    deps
  );
  // Independent literal, not the exported constant: renaming the channel on one
  // side only must fail here rather than pass by construction.
  const handler = handlers.get("desktop:get-settings-local-device");
  if (!handler) {
    throw new Error(
      "no handler registered on desktop:get-settings-local-device"
    );
  }
  return handler;
}

describe("settings local-device IPC (ISS-8379)", () => {
  test("the exported channel constant is the string both sides invoke", () => {
    assert.equal(
      SETTINGS_LOCAL_DEVICE_CHANNEL,
      "desktop:get-settings-local-device"
    );
  });

  test("an untrusted sender is refused before any host fact is read", () => {
    const getMachineName = vi.fn(() => "workshop-mini");
    const getComputeTargetId = vi.fn(() => "ct-01");
    const handler = registerHandler(
      makeDeps({
        isTrustedSender: () => false,
        getMachineName,
        getComputeTargetId,
      })
    );

    // Without the gate the handler would build the payload — which is how the
    // machine name and the cloud compute-target id would reach an untrusted
    // window — instead of throwing.
    assert.throws(() => handler(UNTRUSTED_EVENT), UNTRUSTED_SENDER_ERROR);
    assert.equal(getMachineName.mock.calls.length, 0);
    assert.equal(getComputeTargetId.mock.calls.length, 0);
  });

  test("a trusted sender receives the host facts", () => {
    const handler = registerHandler(makeDeps());

    assert.deepEqual(handler(TRUSTED_EVENT), {
      machineName: "workshop-mini",
      platform: "darwin",
      appVersion: "1.2.3",
      gatewayPort: 41_234,
      gatewayReachable: true,
      computeTargetId: "ct-01",
    });
  });

  test("an absent compute-target id is OMITTED, never serialized as null", () => {
    const snapshot = buildSettingsLocalDeviceSnapshot(
      makeDeps({ getComputeTargetId: () => null })
    );

    // `in`, not a value comparison: a `null` here would satisfy a
    // `computeTargetId == null` assertion while still shipping the key to an
    // older renderer that reads presence, which is the skew failure this
    // contract exists to prevent.
    assert.equal("computeTargetId" in snapshot, false);
    assert.equal(snapshot.gatewayReachable, true);
  });

  test("a gateway that is down is reported as unreachable, not as absent", () => {
    const snapshot = buildSettingsLocalDeviceSnapshot(
      makeDeps({ isServerAlive: () => false })
    );

    assert.equal(snapshot.gatewayReachable, false);
    assert.equal(snapshot.gatewayPort, 41_234);
  });

  test("what the producer emits round-trips through the boundary schema", () => {
    const snapshot = buildSettingsLocalDeviceSnapshot(makeDeps());

    assert.deepEqual(parseSettingsLocalDeviceSnapshot(snapshot), snapshot);
    assert.deepEqual(
      parseSettingsLocalDeviceSnapshot(
        buildSettingsLocalDeviceSnapshot(
          makeDeps({ getComputeTargetId: () => null })
        )
      ),
      {
        machineName: "workshop-mini",
        platform: "darwin",
        appVersion: "1.2.3",
        gatewayPort: 41_234,
        gatewayReachable: true,
      }
    );
  });

  test("the schema accepts an unknown field from a newer main", () => {
    const parsed = parseSettingsLocalDeviceSnapshot({
      machineName: "workshop-mini",
      platform: "darwin",
      appVersion: "1.2.3",
      gatewayPort: 41_234,
      gatewayReachable: true,
      // A field this build has never heard of. A `.strict()` object here would
      // reject the whole payload and blank the panel on every future field.
      harnessPosture: "unknown-to-this-build",
    });

    assert.deepEqual(parsed, {
      machineName: "workshop-mini",
      platform: "darwin",
      appVersion: "1.2.3",
      gatewayPort: 41_234,
      gatewayReachable: true,
    });
  });

  test("a null optional from a skewed peer degrades to absent, not to a failure", () => {
    const parsed = parseSettingsLocalDeviceSnapshot({
      machineName: "workshop-mini",
      platform: "darwin",
      appVersion: "1.2.3",
      gatewayPort: 41_234,
      gatewayReachable: true,
      computeTargetId: null,
    });

    assert.ok(parsed);
    assert.equal("computeTargetId" in parsed, false);
  });

  test("a payload missing or mistyping a required field is rejected whole", () => {
    const complete = {
      machineName: "workshop-mini",
      platform: "darwin",
      appVersion: "1.2.3",
      gatewayPort: 41_234,
      gatewayReachable: true,
    };
    const { gatewayReachable: _dropped, ...missingField } = complete;

    assert.equal(parseSettingsLocalDeviceSnapshot(missingField), null);
    assert.equal(
      parseSettingsLocalDeviceSnapshot({ ...complete, gatewayPort: "41234" }),
      null
    );
    assert.equal(
      parseSettingsLocalDeviceSnapshot({ ...complete, machineName: "" }),
      null
    );
    assert.equal(parseSettingsLocalDeviceSnapshot(null), null);
    assert.equal(parseSettingsLocalDeviceSnapshot("not-an-object"), null);
  });
});
