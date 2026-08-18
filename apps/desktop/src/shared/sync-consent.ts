import type { SyncObservabilityTier } from "./contracts.js";

/**
 * ISS-5489 — what this device has on disk about the user's sync-consent answer.
 *
 * Three fields, because "which level", "did they ever answer" and "was that
 * answer bound to an org" are three different questions and only one of them is
 * readable from the level. `getDataSyncLevel` NEVER returns null — it reconciles
 * a missing value against the live connectivity flags and hands back a real
 * level — so a level of `metadata` is indistinguishable from a user who has never
 * been asked. The tier is the field that stays `null` until someone actually
 * answers (`DEFAULT_DESKTOP_SETTINGS`), which makes it, not the level, the
 * consent signal.
 */
export type SyncConsentRecord = {
  /** `null` until the user has answered the consent question on this device. */
  tier: SyncObservabilityTier | null;
  /** The org the answer was recorded for. `null` is a real value — see `bound`. */
  organizationId: string | null;
  /**
   * Whether an org binding was ever WRITTEN, as opposed to absent.
   *
   * Load-bearing, not bookkeeping: `organizationId: null` is ambiguous on its own
   * — it is both what a pre-ISS-5489 install has (the key never existed) and what
   * a user signed in without an org legitimately records. Collapsing the two
   * makes a personal-account answer look like legacy consent, which then honors
   * itself for EVERY org forever and silently disables the org-switch re-prompt
   * `syncConsentOrganizationId` exists to provide.
   */
  bound: boolean;
};

/**
 * Whether this device already has a sync-consent answer that covers
 * `organizationId`, i.e. whether the post-auth takeover can stay closed.
 *
 * The `!record.bound` arm is a compatibility branch for installs that consented
 * before ISS-5489 added the org binding: they have a real tier and no binding at
 * all, and re-prompting them would ask a settled question again on the next
 * launch. It is honored as consent; the org is bound the next time the user
 * answers. It deliberately does NOT cover an answer that recorded a null org on
 * purpose (a user with no org) — that one is `bound`, so switching into an org
 * re-prompts, which is the whole point of the binding.
 */
export function hasRecordedSyncConsent(
  record: SyncConsentRecord,
  organizationId: string | null
): boolean {
  if (record.tier === null) {
    return false;
  }
  if (!record.bound) {
    return true;
  }
  return record.organizationId === organizationId;
}

/**
 * The consent tier that actually COVERS `organizationId` — `null` when this
 * device's recorded answer does not.
 *
 * The main-process egress gate's input, and the reason the takeover modal is not
 * the enforcement boundary. A modal can only decide what to render; the lanes
 * upload from main on their own timers, and they read the tier directly. Without
 * this, a device that answered Full for org A kept uploading at Full the moment
 * the session switched to org B — while the takeover was still on screen asking
 * B's question. Same predicate as {@link hasRecordedSyncConsent} so the gate and
 * the modal can never disagree about what "already answered" means.
 *
 * An UNBOUND record (a pre-ISS-5489 answer) is honored for every org, exactly as
 * the modal honors it — this narrows egress only for answers that carry a
 * binding, which is to say only for answers the takeover itself recorded.
 */
export function consentTierForOrg(
  record: SyncConsentRecord,
  organizationId: string | null
): SyncObservabilityTier | null {
  return hasRecordedSyncConsent(record, organizationId) ? record.tier : null;
}
