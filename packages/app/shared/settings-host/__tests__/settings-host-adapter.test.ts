import {
  SettingsLocalDeviceReason,
  SettingsLocalDeviceStatus,
} from "@repo/api/src/types/settings-host-capabilities";
import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import { describe, expect, it } from "vitest";
import { webSettingsHostAdapter } from "../settings-host-adapter";

describe("web settings host adapter (ISS-8379)", () => {
  it("reports the web host", () => {
    expect(webSettingsHostAdapter.host).toBe(SettingsPanelHost.Web);
  });

  it("answers with a settled unavailable rather than reaching a host", async () => {
    // The web surface has no local device, and this must be a settled state —
    // never pending, never an empty-but-ready device.
    expect(await webSettingsHostAdapter.readLocalDevice()).toEqual({
      status: SettingsLocalDeviceStatus.Unavailable,
      reason: SettingsLocalDeviceReason.NotDesktopHost,
    });
  });

  it("invokes no local operation: no bridge, fetch, or global is touched", async () => {
    // Executes the decision rather than asserting a shape. Every ambient hook a
    // local operation could take is replaced with a throwing stand-in, so a web
    // adapter that ever grew a host call would fail here instead of silently
    // reaching one from the browser.
    const globals = globalThis as unknown as Record<string, unknown>;
    const originals = new Map(
      ["fetch", "desktopApi", "electron", "require"].map((key) => [
        key,
        globals[key],
      ])
    );
    const refuse = () => {
      throw new Error(
        "the web settings host adapter reached a local operation"
      );
    };
    for (const key of originals.keys()) {
      globals[key] = refuse;
    }

    try {
      expect(await webSettingsHostAdapter.readLocalDevice()).toMatchObject({
        status: SettingsLocalDeviceStatus.Unavailable,
      });
    } finally {
      for (const [key, value] of originals) {
        if (value === undefined) {
          Reflect.deleteProperty(globals, key);
        } else {
          globals[key] = value;
        }
      }
    }
  });
});
