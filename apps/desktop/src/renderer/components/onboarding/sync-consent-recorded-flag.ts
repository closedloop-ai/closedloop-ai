import { KnownFlag } from "@repo/api/src/types/onboarding-phase";
import { SyncObservabilityTier } from "../../../shared/contracts";
import {
  consentTierForOrg,
  hasAnsweredSyncConsent,
  hasRecordedSyncConsent,
  type SyncConsentRecord,
} from "../../../shared/sync-consent";

/** Maps Desktop's local sync-consent record to the guided-onboarding guard. */
export function syncConsentRecordedFlag(
  record: SyncConsentRecord | null,
  organizationId: string | null
): KnownFlag {
  if (record === null) {
    return KnownFlag.Unknown;
  }
  if (hasRecordedSyncConsent(record, organizationId)) {
    return KnownFlag.Yes;
  }
  return KnownFlag.No;
}

/**
 * ISS-11668: whether this account's sync election lets data leave this Mac.
 * Syncing only begins after that election (Marisol, #symphony-dev 2026-09-30), and
 * Local keeps everything here, so it starts no sync. Reads the same org-scoped
 * tier the main-process egress gate does.
 */
export function electedCloudSync(
  record: SyncConsentRecord | null,
  organizationId: string | null
): boolean {
  if (record === null) {
    return false;
  }
  const tier = consentTierForOrg(record, organizationId);
  return tier !== null && tier !== SyncObservabilityTier.Local;
}

/** A guest has no organization: ask whether this device answered, without granting org egress. */
export function deviceSyncConsentRecordedFlag(
  record: SyncConsentRecord | null
): KnownFlag {
  if (record === null) {
    return KnownFlag.Unknown;
  }
  return hasAnsweredSyncConsent(record) ? KnownFlag.Yes : KnownFlag.No;
}
