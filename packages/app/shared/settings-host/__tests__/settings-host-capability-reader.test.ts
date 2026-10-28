import type { SettingsLocalDeviceProjection } from "@repo/api/src/types/settings-host-capabilities";
import {
  SettingsLocalDeviceReason,
  SettingsLocalDeviceStatus,
  settingsLocalDeviceReady,
} from "@repo/api/src/types/settings-host-capabilities";
import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import { describe, expect, it, vi } from "vitest";
import type { SettingsHostAdapter } from "../settings-host-adapter";
import { webSettingsHostAdapter } from "../settings-host-adapter";
import {
  createSettingsHostCapabilityReader,
  SettingsHostReadOutcome,
  type SettingsHostScope,
} from "../settings-host-capability-reader";

const ALICE: SettingsHostScope = { userId: "u-alice", organizationId: "o-1" };
const ALICE_OTHER_ORG: SettingsHostScope = {
  userId: "u-alice",
  organizationId: "o-2",
};
const BOB: SettingsHostScope = { userId: "u-bob", organizationId: "o-1" };

const SNAPSHOT = {
  machineName: "workshop-mini",
  platform: "darwin",
  appVersion: "1.2.3",
  gatewayPort: 41_234,
  gatewayReachable: true,
};

/** An adapter whose in-flight read this test resolves by hand. */
function deferredAdapter(): {
  adapter: SettingsHostAdapter;
  settle: (projection: SettingsLocalDeviceProjection) => void;
  calls: () => number;
} {
  let resolveRead: ((p: SettingsLocalDeviceProjection) => void) | null = null;
  const readLocalDevice = vi.fn(
    () =>
      new Promise<SettingsLocalDeviceProjection>((resolve) => {
        resolveRead = resolve;
      })
  );
  return {
    adapter: { host: SettingsPanelHost.Desktop, readLocalDevice },
    settle: (projection) => resolveRead?.(projection),
    calls: () => readLocalDevice.mock.calls.length,
  };
}

describe("settings host capability reader (ISS-8379)", () => {
  it("applies a response that is still current", async () => {
    const reader = createSettingsHostCapabilityReader({
      host: SettingsPanelHost.Desktop,
      readLocalDevice: () =>
        Promise.resolve(settingsLocalDeviceReady(SNAPSHOT)),
    });

    expect(await reader.read(ALICE)).toEqual({
      outcome: SettingsHostReadOutcome.Applied,
      capabilities: {
        host: SettingsPanelHost.Desktop,
        localDevice: {
          status: SettingsLocalDeviceStatus.Ready,
          snapshot: SNAPSHOT,
        },
      },
    });
  });

  it("discards a response that lands after the workspace switched", async () => {
    const { adapter, settle } = deferredAdapter();
    const reader = createSettingsHostCapabilityReader(adapter);

    const inFlight = reader.read(ALICE);
    reader.switchScope(ALICE_OTHER_ORG);
    settle(settingsLocalDeviceReady(SNAPSHOT));

    // Applying it would show the previous workspace's device under the new one.
    expect(await inFlight).toEqual({
      outcome: SettingsHostReadOutcome.ScopeChanged,
    });
  });

  it("discards a response that lands after the identity switched", async () => {
    const { adapter, settle } = deferredAdapter();
    const reader = createSettingsHostCapabilityReader(adapter);

    const inFlight = reader.read(ALICE);
    reader.switchScope(BOB);
    settle(settingsLocalDeviceReady(SNAPSHOT));

    expect(await inFlight).toEqual({
      outcome: SettingsHostReadOutcome.ScopeChanged,
    });
  });

  it("marks an overtaken read superseded, distinctly from a scope change", async () => {
    const reader = createSettingsHostCapabilityReader({
      host: SettingsPanelHost.Desktop,
      readLocalDevice: () =>
        Promise.resolve(settingsLocalDeviceReady(SNAPSHOT)),
    });

    // Both reads claim their generation synchronously, so the second overtakes
    // the first with no clock involved. Same scope both times — the outcome must
    // NOT be reported as a scope change.
    const first = reader.read(ALICE);
    const second = reader.read(ALICE);

    expect(await second).toMatchObject({
      outcome: SettingsHostReadOutcome.Applied,
    });
    expect(await first).toEqual({
      outcome: SettingsHostReadOutcome.Superseded,
    });
  });

  it("discards an in-flight response after dispose and issues no further read", async () => {
    const { adapter, settle, calls } = deferredAdapter();
    const reader = createSettingsHostCapabilityReader(adapter);

    const inFlight = reader.read(ALICE);
    reader.dispose();
    settle(settingsLocalDeviceReady(SNAPSHOT));

    expect(await inFlight).toEqual({
      outcome: SettingsHostReadOutcome.Disposed,
    });
    expect(await reader.read(ALICE)).toEqual({
      outcome: SettingsHostReadOutcome.Disposed,
    });
    // The post-dispose read must not reach the host at all.
    expect(calls()).toBe(1);
  });

  it("turns an adapter that breaks its no-reject contract into a settled error", async () => {
    const reader = createSettingsHostCapabilityReader({
      host: SettingsPanelHost.Desktop,
      readLocalDevice: () => Promise.reject(new Error("bridge exploded")),
    });

    expect(await reader.read(ALICE)).toEqual({
      outcome: SettingsHostReadOutcome.Applied,
      capabilities: {
        host: SettingsPanelHost.Desktop,
        localDevice: {
          status: SettingsLocalDeviceStatus.Error,
          reason: SettingsLocalDeviceReason.ReadFailed,
        },
      },
    });
  });

  it("carries the web adapter's settled unavailable through unchanged", async () => {
    const reader = createSettingsHostCapabilityReader(webSettingsHostAdapter);

    expect(await reader.read(ALICE)).toEqual({
      outcome: SettingsHostReadOutcome.Applied,
      capabilities: {
        host: SettingsPanelHost.Web,
        localDevice: {
          status: SettingsLocalDeviceStatus.Unavailable,
          reason: SettingsLocalDeviceReason.NotDesktopHost,
        },
      },
    });
  });
});
