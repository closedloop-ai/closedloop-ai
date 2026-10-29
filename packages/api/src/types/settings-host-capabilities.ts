import type { DataSyncLevel } from "./data-sync-level.ts";
import { SettingsPanelHost } from "./settings-panel.ts";

/**
 * ISS-8379 (PRD-691) — the Settings HOST capability projection: what the
 * surface rendering Settings can say about the machine it is running on.
 *
 * Deliberately narrow. Cloud device records (the `ComputeTarget` rows behind
 * Connected Devices) stay owned by `apps/api` and are read through the
 * authorized cloud API on both surfaces; nothing here
 * duplicates or substitutes for that authorization. What only the host can
 * answer — which local machine am I, is my local gateway up, and which cloud
 * compute-target row do I correspond to — is what this projection carries, so a
 * panel can mark "this device" without a second authorization path.
 *
 * Values only, no Zod: a `"use client"` panel imports these without pulling a
 * parser into its bundle. The wire schema that validates a Desktop IPC payload
 * against {@link SettingsLocalDeviceSnapshot} lives beside the channel, in
 * `apps/desktop/src/shared/settings-local-device-contract.ts`.
 */

/**
 * Whether the host could answer at all, kept distinct from what it answered.
 *
 * `Unavailable` is a settled "this host has no local device to describe" — the
 * web app, or a Desktop build whose preload predates the channel. `Error` is a
 * read that was supposed to work and did not. Neither may be rendered as an
 * empty, zero, or authorized state (PRD-692).
 */
export const SettingsLocalDeviceStatus = {
  Ready: "ready",
  Unavailable: "unavailable",
  Error: "error",
} as const;

export type SettingsLocalDeviceStatus =
  (typeof SettingsLocalDeviceStatus)[keyof typeof SettingsLocalDeviceStatus];

/**
 * Why a non-ready projection is non-ready. Host-derived, never carried on the
 * IPC wire — the Desktop main process sends facts, and the renderer adapter
 * classifies what it got — so there is no unknown-reason value a version-skewed
 * peer can introduce here.
 */
export const SettingsLocalDeviceReason = {
  /** The surface is the web app, which has no local device by construction. */
  NotDesktopHost: "not-desktop-host",
  /** An installed Desktop build whose preload predates this channel. */
  BridgeUnavailable: "bridge-unavailable",
  /** The bridge exists and the read failed. */
  ReadFailed: "read-failed",
  /** The bridge answered with something this build cannot validate. */
  MalformedPayload: "malformed-payload",
} as const;

export type SettingsLocalDeviceReason =
  (typeof SettingsLocalDeviceReason)[keyof typeof SettingsLocalDeviceReason];

/**
 * The host-local facts themselves.
 *
 * `computeTargetId` is OPTIONAL and OMITTED when this desktop is not currently
 * online in the cloud — serializing `null` across the IPC boundary would make an
 * older renderer read a present-but-empty identity. It is a correlation key
 * only: the row it names is still fetched, and still authorized, through the
 * cloud API. `machineName` is the offline correlation key, since a cloud
 * compute-target row is unique per owner and machine name.
 */
export type SettingsLocalDeviceSnapshot = {
  machineName: string;
  platform: string;
  appVersion: string;
  gatewayPort: number;
  /** Whether the local gateway server is currently accepting requests. */
  gatewayReachable: boolean;
  computeTargetId?: string;
};

export type SettingsLocalDeviceProjection =
  | {
      status: typeof SettingsLocalDeviceStatus.Ready;
      snapshot: SettingsLocalDeviceSnapshot;
    }
  | {
      status:
        | typeof SettingsLocalDeviceStatus.Unavailable
        | typeof SettingsLocalDeviceStatus.Error;
      reason: SettingsLocalDeviceReason;
    };

export type SettingsHostCapabilities = {
  host: SettingsPanelHost;
  localDevice: SettingsLocalDeviceProjection;
};

export function settingsLocalDeviceReady(
  snapshot: SettingsLocalDeviceSnapshot
): SettingsLocalDeviceProjection {
  return { status: SettingsLocalDeviceStatus.Ready, snapshot };
}

export function settingsLocalDeviceUnavailable(
  reason: SettingsLocalDeviceReason
): SettingsLocalDeviceProjection {
  return { status: SettingsLocalDeviceStatus.Unavailable, reason };
}

export function settingsLocalDeviceError(
  reason: SettingsLocalDeviceReason
): SettingsLocalDeviceProjection {
  return { status: SettingsLocalDeviceStatus.Error, reason };
}

/**
 * The web surface's whole answer. It is a constant rather than a read because
 * the web app has no local device to describe and must never acquire a code
 * path that asks a host for one (PRD-691: Desktop gateway operations only for
 * local compute/device capabilities).
 */
export const WEB_SETTINGS_HOST_CAPABILITIES: SettingsHostCapabilities =
  Object.freeze({
    host: SettingsPanelHost.Web,
    localDevice: Object.freeze(
      settingsLocalDeviceUnavailable(SettingsLocalDeviceReason.NotDesktopHost)
    ),
  });

/**
 * THIS machine's own data-sync level, as the host can report and change it
 * (ISS-8366 / PLN-1915 D6).
 *
 * Reuses {@link SettingsLocalDeviceStatus} and {@link SettingsLocalDeviceReason}
 * rather than minting a parallel pair: it is the same question about the same
 * host — could this surface answer, and if not, why — asked about a second
 * local fact. A build whose preload predates the sync channels reports
 * `bridge-unavailable`, exactly as the local-device read does.
 *
 * There is deliberately NO projection for another device's policy. Production
 * has no per-device sync policy to report: `ComputeTarget` carries no such
 * column, and deriving one from a device's most recent session would render a
 * fabricated measurement (ISS-8366's v1 scope ruling).
 */
export type SettingsLocalSyncPolicyProjection =
  | {
      status: typeof SettingsLocalDeviceStatus.Ready;
      level: DataSyncLevel;
      recorded: boolean;
    }
  | {
      status:
        | typeof SettingsLocalDeviceStatus.Unavailable
        | typeof SettingsLocalDeviceStatus.Error;
      reason: SettingsLocalDeviceReason;
    };

export function settingsLocalSyncPolicyReady(
  level: DataSyncLevel,
  recorded = true
): SettingsLocalSyncPolicyProjection {
  return { status: SettingsLocalDeviceStatus.Ready, level, recorded };
}

export function settingsLocalSyncPolicyUnavailable(
  reason: SettingsLocalDeviceReason
): SettingsLocalSyncPolicyProjection {
  return { status: SettingsLocalDeviceStatus.Unavailable, reason };
}

export function settingsLocalSyncPolicyError(
  reason: SettingsLocalDeviceReason
): SettingsLocalSyncPolicyProjection {
  return { status: SettingsLocalDeviceStatus.Error, reason };
}
