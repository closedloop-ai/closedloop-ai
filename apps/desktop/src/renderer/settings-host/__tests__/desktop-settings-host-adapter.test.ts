import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  SettingsLocalDeviceReason,
  SettingsLocalDeviceStatus,
  type SettingsLocalSyncPolicyProjection,
  settingsLocalSyncPolicyReady,
} from "@repo/api/src/types/settings-host-capabilities";
import { describe, expect, it, vi } from "vitest";
import { SyncObservabilityTier } from "../../../shared/contracts";
import { createDesktopSettingsHostAdapter } from "../desktop-settings-host-adapter";

// ISS-8379 (PRD-691): the consumer half of the Settings local-device contract.
// Types do not constrain an IPC payload at runtime, so every malformed and
// version-skewed shape below is genuinely reachable across that boundary.

const VALID_PAYLOAD = {
  machineName: "workshop-mini",
  platform: "darwin",
  appVersion: "1.2.3",
  gatewayPort: 41_234,
  gatewayReachable: true,
  computeTargetId: "ct-01",
};

const ORG_A = "org-a";
const ORG_B = "org-b";

describe("desktop settings host adapter (ISS-8379)", () => {
  it("reports the desktop host", () => {
    expect(createDesktopSettingsHostAdapter(undefined).host).toBe("desktop");
  });

  it("degrades to unavailable when there is no bridge at all", async () => {
    const projection =
      await createDesktopSettingsHostAdapter(undefined).readLocalDevice();

    expect(projection).toEqual({
      status: SettingsLocalDeviceStatus.Unavailable,
      reason: SettingsLocalDeviceReason.BridgeUnavailable,
    });
  });

  it("degrades to unavailable on an installed build whose preload predates the channel", async () => {
    // The bridge object exists; this one method does not. Version skew, not a
    // failure — and settled, so a panel never waits on a method that will never
    // arrive.
    const projection = await createDesktopSettingsHostAdapter(
      {}
    ).readLocalDevice();

    expect(projection).toEqual({
      status: SettingsLocalDeviceStatus.Unavailable,
      reason: SettingsLocalDeviceReason.BridgeUnavailable,
    });
  });

  it("reports a rejected invoke as an error, never as an empty device", async () => {
    const getSettingsLocalDevice = vi.fn(() =>
      Promise.reject(new Error("main unreachable"))
    );

    const projection = await createDesktopSettingsHostAdapter({
      getSettingsLocalDevice,
    }).readLocalDevice();

    expect(projection).toEqual({
      status: SettingsLocalDeviceStatus.Error,
      reason: SettingsLocalDeviceReason.ReadFailed,
    });
    expect(getSettingsLocalDevice).toHaveBeenCalledTimes(1);
  });

  it("reports a malformed payload distinctly from a failed read", async () => {
    const projection = await createDesktopSettingsHostAdapter({
      getSettingsLocalDevice: () =>
        Promise.resolve({ ...VALID_PAYLOAD, gatewayPort: "41234" }),
    }).readLocalDevice();

    expect(projection).toEqual({
      status: SettingsLocalDeviceStatus.Error,
      reason: SettingsLocalDeviceReason.MalformedPayload,
    });
  });

  it("reports a null payload as malformed, not as a failed read", async () => {
    // `null` is a value a skewed main can resolve with; collapsing it into the
    // rejection reason would lose which half of the boundary broke.
    const projection = await createDesktopSettingsHostAdapter({
      getSettingsLocalDevice: () => Promise.resolve(null),
    }).readLocalDevice();

    expect(projection).toEqual({
      status: SettingsLocalDeviceStatus.Error,
      reason: SettingsLocalDeviceReason.MalformedPayload,
    });
  });

  it("returns the validated snapshot on the ready path", async () => {
    const projection = await createDesktopSettingsHostAdapter({
      getSettingsLocalDevice: () => Promise.resolve({ ...VALID_PAYLOAD }),
    }).readLocalDevice();

    expect(projection).toEqual({
      status: SettingsLocalDeviceStatus.Ready,
      snapshot: VALID_PAYLOAD,
    });
  });

  it("stays ready when a newer main adds a field, and omits an absent id", async () => {
    const projection = await createDesktopSettingsHostAdapter({
      getSettingsLocalDevice: () =>
        Promise.resolve({
          machineName: "workshop-mini",
          platform: "darwin",
          appVersion: "1.2.3",
          gatewayPort: 41_234,
          gatewayReachable: false,
          futureField: 7,
        }),
    }).readLocalDevice();

    expect(projection).toEqual({
      status: SettingsLocalDeviceStatus.Ready,
      snapshot: {
        machineName: "workshop-mini",
        platform: "darwin",
        appVersion: "1.2.3",
        gatewayPort: 41_234,
        gatewayReachable: false,
      },
    });
  });
});

describe("desktop settings host adapter sync policy", () => {
  it("reports an unset consent record as ready but not recorded", async () => {
    const adapter = createDesktopSettingsHostAdapter(
      {
        getDataSyncLevel: () => Promise.resolve({ level: DataSyncLevel.Full }),
        getSyncConsentRecord: () =>
          Promise.resolve({ bound: false, organizationId: null, tier: null }),
      },
      ORG_A
    );

    expect(await readSyncPolicy(adapter)).toEqual({
      ...settingsLocalSyncPolicyReady(DataSyncLevel.Full),
      recorded: false,
    });
  });

  it("honors legacy unbound consent as recorded for the active org", async () => {
    const adapter = createDesktopSettingsHostAdapter(
      {
        getDataSyncLevel: () =>
          Promise.resolve({ level: DataSyncLevel.Metadata }),
        getSyncConsentRecord: () =>
          Promise.resolve({
            bound: false,
            organizationId: null,
            tier: SyncObservabilityTier.Metadata,
          }),
      },
      ORG_A
    );

    expect(await readSyncPolicy(adapter)).toEqual(
      settingsLocalSyncPolicyReady(DataSyncLevel.Metadata)
    );
  });

  it("keeps another organization's consent incomplete for the active org", async () => {
    const adapter = createDesktopSettingsHostAdapter(
      {
        getDataSyncLevel: () => Promise.resolve({ level: DataSyncLevel.Full }),
        getSyncConsentRecord: () =>
          Promise.resolve({
            bound: true,
            organizationId: ORG_B,
            tier: SyncObservabilityTier.Full,
          }),
      },
      ORG_A
    );

    expect(await readSyncPolicy(adapter)).toEqual({
      ...settingsLocalSyncPolicyReady(DataSyncLevel.Full),
      recorded: false,
    });
  });

  it("reports malformed consent distinctly from a failed read", async () => {
    const adapter = createDesktopSettingsHostAdapter(
      {
        getDataSyncLevel: () => Promise.resolve({ level: DataSyncLevel.Full }),
        getSyncConsentRecord: () =>
          Promise.resolve({
            bound: true,
            organizationId: ORG_A,
            tier: "analytics",
          }),
      },
      ORG_A
    );

    expect(await readSyncPolicy(adapter)).toEqual({
      status: SettingsLocalDeviceStatus.Error,
      reason: SettingsLocalDeviceReason.MalformedPayload,
    });
  });

  it("writes through the consent-recording path with the active organization", async () => {
    const recordSyncConsent = vi.fn(
      ({
        level,
        organizationId,
      }: {
        level: DataSyncLevel;
        organizationId: string | null;
      }) => Promise.resolve({ level, organizationId })
    );
    const adapter = createDesktopSettingsHostAdapter(
      { recordSyncConsent },
      ORG_A
    );

    expect(await writeSyncPolicy(adapter, DataSyncLevel.Metadata)).toEqual(
      settingsLocalSyncPolicyReady(DataSyncLevel.Metadata)
    );
    expect(recordSyncConsent).toHaveBeenCalledWith({
      level: DataSyncLevel.Metadata,
      organizationId: ORG_A,
    });
  });

  it("trusts main's committed organization when the renderer snapshot is stale", async () => {
    const adapter = createDesktopSettingsHostAdapter(
      {
        recordSyncConsent: ({ level }) =>
          Promise.resolve({ level, organizationId: ORG_B }),
      },
      ORG_A
    );

    expect(await writeSyncPolicy(adapter, DataSyncLevel.Metadata)).toEqual(
      settingsLocalSyncPolicyReady(DataSyncLevel.Metadata)
    );
  });
});

function readSyncPolicy(
  adapter: ReturnType<typeof createDesktopSettingsHostAdapter>
) {
  const capability = adapter.localSyncPolicy;
  if (!capability) {
    throw new Error("expected desktop sync-policy capability");
  }
  return capability.read();
}

function writeSyncPolicy(
  adapter: ReturnType<typeof createDesktopSettingsHostAdapter>,
  level: DataSyncLevel
): Promise<SettingsLocalSyncPolicyProjection> {
  const capability = adapter.localSyncPolicy;
  if (!capability) {
    throw new Error("expected desktop sync-policy capability");
  }
  return capability.write(level);
}
