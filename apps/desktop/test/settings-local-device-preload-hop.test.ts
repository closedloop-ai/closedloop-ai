/**
 * @file settings-local-device-preload-hop.test.ts
 * @description ISS-8379 (davetho review, `preload-common.ts:843`): nothing
 * exercised `createDesktopApi().getSettingsLocalDevice` through the PRODUCTION
 * preload hop. The suites that existed drove the two ENDS — the main registrar
 * directly (`settings-local-device-ipc.test.ts`) or a stubbed
 * `window.desktopApi` in the renderer
 * (`renderer/settings-host/__tests__/desktop-settings-host-adapter.test.ts`) —
 * so the one link between them, the `createSettingsLocalDeviceDesktopApi`
 * spread that names the channel, was the only part nothing covered. Dropping
 * that spread, or aiming it at a channel main does not register, left every one
 * of those suites green while every shipped build answered `BridgeUnavailable`.
 *
 * So this drives the chain in one pass: `createDesktopApi` → an `ipcRenderer`
 * stand-in wired to the REAL registered `ipcMain` handler → the REAL snapshot
 * builder → the REAL boundary parser the renderer adapter uses. The only test
 * double is the IPC transport edge; every production module between the two
 * ends is the shipped one.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSettingsLocalDeviceSnapshot,
  registerSettingsLocalDeviceIpcHandlers,
  type SettingsLocalDeviceIpcDeps,
} from "../src/main/ipc/settings-local-device-ipc.js";
import { createDesktopApi } from "../src/main/preload-common.js";
import { parseSettingsLocalDeviceSnapshot } from "../src/shared/settings-local-device-contract.js";

const TRUSTED_SENDER = { id: "trusted-renderer" };

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

function makeDeps(
  overrides: Partial<SettingsLocalDeviceIpcDeps> = {}
): SettingsLocalDeviceIpcDeps {
  return {
    isTrustedSender: (sender) => sender === TRUSTED_SENDER,
    getMachineName: () => "workshop-mini",
    getPlatform: () => "darwin",
    getAppVersion: () => "1.2.3",
    getActivePort: () => 41_234,
    isServerAlive: () => true,
    getComputeTargetId: () => "ct-01",
    ...overrides,
  };
}

/**
 * Everything between the two process edges, wired the way
 * `desktop-ipc-registration.ts` wires it. The renderer never sees a handler
 * map: it only ever holds what `createDesktopApi` composed.
 */
function createHop(overrides: Partial<SettingsLocalDeviceIpcDeps> = {}) {
  const handlers = new Map<string, IpcHandler>();
  const invokedChannels: string[] = [];

  registerSettingsLocalDeviceIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    makeDeps(overrides)
  );

  const desktopApi = createDesktopApi({
    // The transport edge: carry the channel to the registered main handler
    // exactly as Electron's `ipcRenderer.invoke` would.
    invoke: (channel: string, ...args: unknown[]) => {
      invokedChannels.push(channel);
      const handler = handlers.get(channel);
      if (!handler) {
        return Promise.reject(
          new Error(`no main handler registered for ${channel}`)
        );
      }
      return Promise.resolve(handler({ sender: TRUSTED_SENDER }, ...args));
    },
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
  });

  return { desktopApi, invokedChannels };
}

describe("settings local-device preload hop (ISS-8379)", () => {
  test("createDesktopApi composes getSettingsLocalDevice onto the channel main registers", async () => {
    const { desktopApi, invokedChannels } = createHop();

    assert.equal(
      typeof desktopApi.getSettingsLocalDevice,
      "function",
      "createDesktopApi must expose getSettingsLocalDevice; a dropped spread ships as BridgeUnavailable"
    );

    const payload = await desktopApi.getSettingsLocalDevice();

    // Independent literal, not the exported constant: a channel renamed on the
    // preload side only must fail here rather than pass by construction.
    assert.deepEqual(invokedChannels, ["desktop:get-settings-local-device"]);
    assert.deepEqual(payload, buildSettingsLocalDeviceSnapshot(makeDeps()));
  });

  test("the payload crossing the preload hop satisfies the renderer's boundary parser", async () => {
    const { desktopApi } = createHop();

    const parsed = parseSettingsLocalDeviceSnapshot(
      await desktopApi.getSettingsLocalDevice()
    );

    assert.notEqual(
      parsed,
      null,
      "the shipped producer's payload must clear the renderer's own parser"
    );
    assert.equal(parsed?.machineName, "workshop-mini");
    assert.equal(parsed?.gatewayPort, 41_234);
    assert.equal(parsed?.computeTargetId, "ct-01");
  });

  test("an absent compute target crosses the hop omitted, never null", async () => {
    const { desktopApi } = createHop({ getComputeTargetId: () => null });

    const payload = (await desktopApi.getSettingsLocalDevice()) as Record<
      string,
      unknown
    >;

    assert.equal(
      Object.hasOwn(payload, "computeTargetId"),
      false,
      "an absent identity must be omitted; null reads as present-but-empty on a skewed peer"
    );
    assert.notEqual(parseSettingsLocalDeviceSnapshot(payload), null);
  });
});
