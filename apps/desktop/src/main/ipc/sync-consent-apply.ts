import { z } from "zod";
import type {
  DataSyncLevel,
  SyncObservabilityTier,
} from "../../shared/contracts.js";
import { normalizeDataSyncLevel } from "../../shared/data-sync-level.js";
import type { SyncConsentRecord } from "../../shared/sync-consent.js";

/**
 * ISS-5489 — the collaborators the post-auth consent takeover's read and write
 * need. Kept electron-free (no `import "electron"`), following the FEA-4103
 * {@link applySyncObservabilityTier} precedent, so the logic runs in the desktop
 * `test:node` slice without booting Electron; the IPC module (which does pull in
 * `electron` for the onboarding popup) is a thin trusted-sender guard over these
 * two functions.
 */
export type SyncConsentApplyDeps = {
  /** `null` until the user has answered the consent question on this device. */
  getSyncObservabilityTier: () => SyncObservabilityTier | null;
  getSyncConsentOrganizationId: () => string | null;
  /** Whether an org binding was ever written — see {@link SyncConsentRecord.bound}. */
  hasSyncConsentOrganizationBinding: () => boolean;
  /** Return the device to the not-yet-consented state (tier `null`). */
  clearSyncObservabilityTier: () => void;
  /**
   * The org of the CURRENT authenticated session, from the main-process session
   * manager — the trusted source for the binding.
   *
   * The renderer used to supply it. Nothing else in this feature takes a value
   * from the renderer on trust (`level` goes through a closed-literal check), and
   * the org is the field the whole binding exists to get right: bind the wrong
   * one and the takeover either re-asks a settled question forever or stays shut
   * for an org that never consented. A stale renderer snapshot mid-switch is the
   * likelier cause than anything hostile, and main simply knows better.
   */
  getSessionOrganizationId: () => string | null;
  setSyncConsentOrganizationId: (organizationId: string | null) => void;
  /**
   * Persist the graduated data sync level and apply its derived
   * connectivity/sync side effects. Implemented in app.ts
   * (`applyDataSyncLevel`) — the ONE canonical write path.
   */
  applyDataSyncLevel: (level: DataSyncLevel) => void;
  /** Kick discovery for a lane whose sweep was suppressed while consent was unset. */
  onSyncObservabilityTierChanged?: () => void;
};

/**
 * Read whether this device has already answered the sync-consent question, and
 * for which org.
 *
 * Deliberately returns the raw tier rather than a precomputed boolean: the
 * renderer knows which org is signed in, and the comparison lives in one shared
 * predicate (`hasRecordedSyncConsent`) that both the main and renderer suites
 * exercise, instead of a second copy of the rule here.
 */
export function readSyncConsentRecord(
  deps: SyncConsentApplyDeps
): SyncConsentRecord {
  return {
    tier: deps.getSyncObservabilityTier(),
    organizationId: deps.getSyncConsentOrganizationId(),
    bound: deps.hasSyncConsentOrganizationBinding(),
  };
}

/**
 * Persist the takeover's answer: the level through the SAME
 * `applyDataSyncLevel` path every other consent surface uses (so all four
 * derived booleans move together, per FEA-4103), plus the org the answer was
 * given for.
 *
 * The write order is load-bearing rather than incidental, and the property it
 * has to hold is that EVERY intermediate state reads as un-consented, so a crash
 * mid-write re-asks on the next launch instead of inventing an answer.
 *
 * The org binding goes first: the tier is the consent signal, so stopping after
 * it leaves `{ tier: null, bound: true }`, which re-asks. The reverse order fails
 * the opposite way — a set tier with no binding, which `hasRecordedSyncConsent`
 * treats as a legacy answer and honors for every org forever.
 *
 * That reasoning only holds while the previous tier is null, i.e. on the FIRST
 * answer. Re-binding to a different org starts from a tier that is already set,
 * and stopping after the binding write would then leave the NEW org bound to the
 * OLD org's tier — a user who just chose Off would be recorded as Full, and the
 * takeover would never ask again because the binding now matches. So a re-bind
 * clears the tier first, restoring the every-intermediate-state-is-un-consented
 * property. Validation is defense-in-depth on top of the caller's trusted-sender
 * gate.
 */
export function applySyncConsent(
  deps: SyncConsentApplyDeps,
  rawPayload: unknown
): { level: DataSyncLevel; organizationId: string | null } {
  const payload = recordSyncConsentPayloadSchema.parse(rawPayload);
  const level = normalizeDataSyncLevel(payload.level);
  // From the session, not the payload. The renderer still sends its own value
  // (older builds always will) and it is ignored on purpose.
  const organizationId = deps.getSessionOrganizationId();
  if (isRebindingToDifferentOrg(deps, organizationId)) {
    deps.clearSyncObservabilityTier();
  }
  deps.setSyncConsentOrganizationId(organizationId);
  deps.applyDataSyncLevel(level);
  deps.onSyncObservabilityTierChanged?.();
  return { level, organizationId };
}

/**
 * Renderer payload for `desktop:record-sync-consent`. `level` stays `unknown`
 * here because {@link normalizeDataSyncLevel} owns the closed-literal check and
 * duplicating it as a zod enum would give the level two SSOTs. `organizationId`
 * is nullish so an older renderer that omits the field records the same "no org"
 * answer a personal account does.
 */
/**
 * Whether this answer moves an EXISTING binding to a different org — the case
 * where the previously recorded tier must not survive the write window.
 *
 * An unbound record is not a re-bind: it is either a first answer or a
 * pre-ISS-5489 legacy one, and both are being bound for the first time here.
 */
function isRebindingToDifferentOrg(
  deps: SyncConsentApplyDeps,
  organizationId: string | null
): boolean {
  return (
    deps.hasSyncConsentOrganizationBinding() &&
    deps.getSyncConsentOrganizationId() !== organizationId
  );
}

const recordSyncConsentPayloadSchema = z.object({
  level: z.unknown(),
  // Accepted for shape compatibility and then IGNORED — the org is read from the
  // authenticated session instead. Kept in the schema so an older renderer that
  // sends it is not rejected outright.
  organizationId: z.string().nullish(),
});
