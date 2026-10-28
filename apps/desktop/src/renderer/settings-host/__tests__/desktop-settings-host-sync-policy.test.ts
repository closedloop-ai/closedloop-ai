import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  SettingsLocalDeviceReason,
  SettingsLocalDeviceStatus,
  settingsLocalSyncPolicyReady,
} from "@repo/api/src/types/settings-host-capabilities";
import { describe, expect, it, vi } from "vitest";
import { SyncObservabilityTier } from "../../../shared/contracts";
import { createDesktopSettingsHostAdapter } from "../desktop-settings-host-adapter";

// PLN-1915 D6 — the sync-policy half of the desktop Settings host adapter.
// Types do not constrain an IPC payload at runtime, so every skewed and
// malformed shape below is genuinely reachable across that boundary. Every case
// asserts on a SETTLED projection: a rejection here would strand the panel
// rather than telling the user what this build can do.

const BRIDGE_UNAVAILABLE = {
  status: SettingsLocalDeviceStatus.Unavailable,
  reason: SettingsLocalDeviceReason.BridgeUnavailable,
};
const READ_FAILED = {
  status: SettingsLocalDeviceStatus.Error,
  reason: SettingsLocalDeviceReason.ReadFailed,
};
const MALFORMED_PAYLOAD = {
  status: SettingsLocalDeviceStatus.Error,
  reason: SettingsLocalDeviceReason.MalformedPayload,
};
const RECORDED_SYNC_CONSENT = {
  bound: false,
  organizationId: null,
  tier: SyncObservabilityTier.Full,
};

type Bridge = Parameters<typeof createDesktopSettingsHostAdapter>[0];

function syncPolicyOf(
  bridge: Bridge,
  organizationId: string | null = null,
  refreshSyncConsentRecord?: () => void
) {
  const capability = createDesktopSettingsHostAdapter(
    bridge,
    organizationId,
    refreshSyncConsentRecord
  ).localSyncPolicy;
  if (!capability) {
    throw new Error(
      "the desktop adapter must always carry the sync-policy capability"
    );
  }
  return capability;
}

describe("desktop settings host adapter — local sync policy (PLN-1915)", () => {
  it("reads a legacy record with no tier as unset despite an effective Full level", async () => {
    const policy = syncPolicyOf({
      getDataSyncLevel: () => Promise.resolve({ level: DataSyncLevel.Full }),
      getSyncConsentRecord: () =>
        Promise.resolve({ bound: false, organizationId: null }),
    });
    await expect(policy.read()).resolves.toEqual(
      settingsLocalSyncPolicyReady(DataSyncLevel.Full, false)
    );
  });

  it("settles both members as bridge-unavailable when there is no bridge at all", async () => {
    const policy = syncPolicyOf(undefined);

    await expect(policy.read()).resolves.toEqual(BRIDGE_UNAVAILABLE);
    await expect(policy.write(DataSyncLevel.Full)).resolves.toEqual(
      BRIDGE_UNAVAILABLE
    );
  });

  it("settles as bridge-unavailable on an installed build whose preload predates the channels", async () => {
    // The bridge object exists; these two methods do not. Version skew, not a
    // failure — and the capability is still PRESENT, which is what keeps the
    // control's absence on web meaning exactly one thing.
    const policy = syncPolicyOf({
      getSettingsLocalDevice: () => Promise.resolve({}),
    });

    await expect(policy.read()).resolves.toEqual(BRIDGE_UNAVAILABLE);
    await expect(policy.write(DataSyncLevel.Full)).resolves.toEqual(
      BRIDGE_UNAVAILABLE
    );
  });

  it("settles a rejecting bridge as a failed read rather than rejecting", async () => {
    const policy = syncPolicyOf({
      getDataSyncLevel: () => Promise.reject(new Error("main unreachable")),
      getSyncConsentRecord: () => Promise.resolve(RECORDED_SYNC_CONSENT),
      recordSyncConsent: () => Promise.reject(new Error("main unreachable")),
    });

    await expect(policy.read()).resolves.toEqual(READ_FAILED);
    await expect(policy.write(DataSyncLevel.Off)).resolves.toEqual(READ_FAILED);
  });

  it("settles an unrecognised level as malformed instead of passing it through", async () => {
    // A privacy control asserting a posture nobody set is worse than one saying
    // it could not read the level.
    const policy = syncPolicyOf({
      getDataSyncLevel: () => Promise.resolve({ level: "not-a-level" }),
      getSyncConsentRecord: () => Promise.resolve(RECORDED_SYNC_CONSENT),
      recordSyncConsent: () =>
        Promise.resolve({ level: "not-a-level", organizationId: null }),
    });

    await expect(policy.read()).resolves.toEqual(MALFORMED_PAYLOAD);
    await expect(policy.write(DataSyncLevel.Off)).resolves.toEqual(
      MALFORMED_PAYLOAD
    );
  });

  it("settles a non-object payload as malformed rather than throwing on it", async () => {
    // `null` is a value a skewed main can resolve with, and reading `.level`
    // off it would turn a settled projection into a rejection.
    const policy = syncPolicyOf({
      getDataSyncLevel: () => Promise.resolve(null),
      getSyncConsentRecord: () => Promise.resolve(RECORDED_SYNC_CONSENT),
    });

    await expect(policy.read()).resolves.toEqual(MALFORMED_PAYLOAD);
  });

  it("returns the level a good bridge answered with", async () => {
    const policy = syncPolicyOf({
      getDataSyncLevel: () => Promise.resolve({ level: DataSyncLevel.Off }),
      getSyncConsentRecord: () => Promise.resolve(RECORDED_SYNC_CONSENT),
    });

    await expect(policy.read()).resolves.toEqual(
      settingsLocalSyncPolicyReady(DataSyncLevel.Off)
    );
  });

  it("passes the requested level to recordSyncConsent and answers with what the host wrote", async () => {
    // The host reconciles a level down when the derived connectivity flags
    // disagree, so the projection is what it WROTE, not what was asked for.
    const recordSyncConsent = vi.fn(() =>
      Promise.resolve({ level: DataSyncLevel.Metadata, organizationId: null })
    );
    const policy = syncPolicyOf({ recordSyncConsent });

    await expect(policy.write(DataSyncLevel.Full)).resolves.toEqual(
      settingsLocalSyncPolicyReady(DataSyncLevel.Metadata)
    );
    expect(recordSyncConsent).toHaveBeenCalledWith({
      level: DataSyncLevel.Full,
      organizationId: null,
    });
  });

  it("refreshes the shared consent record after a successful write", async () => {
    const refreshSyncConsentRecord = vi.fn();
    const recordSyncConsent = vi.fn(() =>
      Promise.resolve({ level: DataSyncLevel.Off, organizationId: null })
    );
    const policy = syncPolicyOf(
      { recordSyncConsent },
      null,
      refreshSyncConsentRecord
    );

    await expect(policy.write(DataSyncLevel.Off)).resolves.toEqual(
      settingsLocalSyncPolicyReady(DataSyncLevel.Off)
    );
    expect(refreshSyncConsentRecord).toHaveBeenCalledOnce();
  });

  it("does not refresh the shared consent record after a failed write", async () => {
    const refreshSyncConsentRecord = vi.fn();
    const policy = syncPolicyOf(
      {
        recordSyncConsent: () => Promise.reject(new Error("main unreachable")),
      },
      null,
      refreshSyncConsentRecord
    );

    await expect(policy.write(DataSyncLevel.Off)).resolves.toEqual(READ_FAILED);
    expect(refreshSyncConsentRecord).not.toHaveBeenCalled();
  });
});
