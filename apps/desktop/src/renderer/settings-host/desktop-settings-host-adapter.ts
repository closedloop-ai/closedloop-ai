import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { toDataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { SettingsLocalSyncPolicyProjection } from "@repo/api/src/types/settings-host-capabilities";
import {
  SettingsLocalDeviceReason,
  SettingsLocalDeviceStatus,
  settingsLocalDeviceError,
  settingsLocalDeviceReady,
  settingsLocalDeviceUnavailable,
  settingsLocalSyncPolicyError,
  settingsLocalSyncPolicyReady,
  settingsLocalSyncPolicyUnavailable,
} from "@repo/api/src/types/settings-host-capabilities";
import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import type {
  SettingsHostAdapter,
  SettingsLocalSyncPolicyCapability,
} from "@repo/app/shared/settings-host/settings-host-adapter";
import { z } from "zod";
import { parseSettingsLocalDeviceSnapshot } from "../../shared/settings-local-device-contract";
import { hasRecordedSyncConsent } from "../../shared/sync-consent";
import { parseSyncConsentRecord } from "../shared/sync-consent-record-boundary";

/**
 * ISS-8379 (PRD-691) — the desktop implementation of the Settings host port.
 *
 * The ONLY implementation that reaches a host-local read, and it reaches it
 * through the gated `desktop:get-settings-local-device` IPC channel. It performs
 * no gateway operation and touches no cloud record: the compute-target id it
 * returns is a correlation key, and the row behind it is still fetched through
 * the authorized cloud API by whichever panel needs it.
 */

/** The bridge members this adapter needs; each optional for version skew. */
type SettingsLocalDeviceBridge = {
  getSettingsLocalDevice?: () => Promise<unknown>;
  getDataSyncLevel?: () => Promise<unknown>;
  setDataSyncLevel?: (level: DataSyncLevel) => Promise<unknown>;
  getSyncConsentRecord?: () => Promise<unknown>;
  recordSyncConsent?: (payload: {
    level: DataSyncLevel;
    organizationId: string | null;
  }) => Promise<unknown>;
};

/**
 * Distinguishes "the invoke rejected" from "the invoke resolved with something
 * unusable" — a sentinel rather than `null`, because `null` is itself a payload
 * a skewed main could send and the two must not collapse into one reason.
 */
const UNREADABLE = Symbol("settings-local-device-unreadable");

export function createDesktopSettingsHostAdapter(
  bridge: SettingsLocalDeviceBridge | undefined,
  organizationId: string | null = null,
  refreshSyncConsentRecord?: () => void
): SettingsHostAdapter {
  return {
    host: SettingsPanelHost.Desktop,
    localSyncPolicy: createLocalSyncPolicyCapability(
      bridge,
      organizationId,
      refreshSyncConsentRecord
    ),
    readLocalDevice: async () => {
      const readLocalDevice = bridge?.getSettingsLocalDevice;
      if (typeof readLocalDevice !== "function") {
        // An installed build whose preload predates this channel, or a harness
        // that stubs part of the bridge. Settled, not pending — waiting on a
        // method that will never exist would strand the panel in loading.
        return settingsLocalDeviceUnavailable(
          SettingsLocalDeviceReason.BridgeUnavailable
        );
      }
      const raw = await readLocalDevice().catch(() => UNREADABLE);
      if (raw === UNREADABLE) {
        return settingsLocalDeviceError(SettingsLocalDeviceReason.ReadFailed);
      }
      const snapshot = parseSettingsLocalDeviceSnapshot(raw);
      if (!snapshot) {
        return settingsLocalDeviceError(
          SettingsLocalDeviceReason.MalformedPayload
        );
      }
      return settingsLocalDeviceReady(snapshot);
    },
  };
}

/**
 * THIS desktop's own sync level, over the `desktop:get-data-sync-level` read and
 * `desktop:record-sync-consent` write channels (PLN-1915 D6 / ISS-8353).
 *
 * No second writer: the main process records an active-org consent binding and
 * then reaches `applyDataSyncLevel`, so the v2 panel, the legacy Data & Sync tab,
 * and the egress gate cannot disagree about what is on.
 *
 * The capability object is always present on the desktop adapter; the MEMBERS
 * report `bridge-unavailable` when an installed build's preload predates the
 * channels. Deciding it here rather than by omitting the capability keeps the
 * absence of a control on WEB meaning exactly one thing — the web adapter has no
 * local write path at all — while an old desktop build says so out loud.
 */
function createLocalSyncPolicyCapability(
  bridge: SettingsLocalDeviceBridge | undefined,
  organizationId: string | null,
  refreshSyncConsentRecord?: () => void
): SettingsLocalSyncPolicyCapability {
  return {
    read: () => {
      const readLevel = bridge?.getDataSyncLevel;
      const readRecord = bridge?.getSyncConsentRecord;
      if (typeof readLevel !== "function" || typeof readRecord !== "function") {
        return Promise.resolve(
          settingsLocalSyncPolicyUnavailable(
            SettingsLocalDeviceReason.BridgeUnavailable
          )
        );
      }
      return settleSyncPolicyRead(readLevel(), readRecord(), organizationId);
    },
    write: (level: DataSyncLevel) => {
      const writeConsent = bridge?.recordSyncConsent;
      if (typeof writeConsent !== "function") {
        return Promise.resolve(
          settingsLocalSyncPolicyUnavailable(
            SettingsLocalDeviceReason.BridgeUnavailable
          )
        );
      }
      return settleSyncPolicyWrite(
        writeConsent({ level, organizationId })
      ).then((projection) => {
        if (projection.status === SettingsLocalDeviceStatus.Ready) {
          refreshSyncConsentRecord?.();
        }
        return projection;
      });
    },
  };
}

/**
 * Turn one bridge call into a settled projection, never a rejection.
 *
 * The level is re-validated rather than trusted: the reply crosses a process
 * boundary from a main process that may be older or newer than this renderer,
 * and an unrecognised string rendered as a level would be a privacy control
 * asserting a posture nobody set.
 */
async function settleSyncPolicyRead(
  pendingLevel: Promise<unknown>,
  pendingRecord: Promise<unknown>,
  organizationId: string | null
): Promise<SettingsLocalSyncPolicyProjection> {
  const rawLevel = await pendingLevel.catch(() => UNREADABLE);
  const rawRecord = await pendingRecord.catch(() => UNREADABLE);
  if (rawLevel === UNREADABLE || rawRecord === UNREADABLE) {
    return settingsLocalSyncPolicyError(SettingsLocalDeviceReason.ReadFailed);
  }
  const level = parseSyncPolicyLevel(rawLevel);
  const record = parseSyncConsentRecord(rawRecord);
  if (level === undefined || record === null) {
    return settingsLocalSyncPolicyError(
      SettingsLocalDeviceReason.MalformedPayload
    );
  }
  return settingsLocalSyncPolicyReady(
    level,
    hasRecordedSyncConsent(record, organizationId)
  );
}

async function settleSyncPolicyWrite(
  pending: Promise<unknown>
): Promise<SettingsLocalSyncPolicyProjection> {
  const raw = await pending.catch(() => UNREADABLE);
  if (raw === UNREADABLE) {
    return settingsLocalSyncPolicyError(SettingsLocalDeviceReason.ReadFailed);
  }
  const reply = syncConsentReplySchema.safeParse(raw);
  if (!reply.success) {
    return settingsLocalSyncPolicyError(
      SettingsLocalDeviceReason.MalformedPayload
    );
  }
  const level = toDataSyncLevel(reply.data.level);
  if (level === undefined) {
    return settingsLocalSyncPolicyError(
      SettingsLocalDeviceReason.MalformedPayload
    );
  }
  return settingsLocalSyncPolicyReady(level);
}

function parseSyncPolicyLevel(raw: unknown): DataSyncLevel | undefined {
  const parsed = syncPolicyLevelReplySchema.safeParse(raw);
  return parsed.success ? toDataSyncLevel(parsed.data.level) : undefined;
}

const syncConsentReplySchema = z.object({
  level: z.unknown(),
  organizationId: z.string().nullable(),
});

const syncPolicyLevelReplySchema = z.object({
  level: z.unknown(),
});
