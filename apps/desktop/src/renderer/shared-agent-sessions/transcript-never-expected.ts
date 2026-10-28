import {
  consentTierForOrg,
  type SyncConsentRecord,
} from "../../shared/sync-consent";
import { syncTierExcludesTranscripts } from "../../shared/sync-observability-tier";

/**
 * @description ISS-7516 — can this desktop say, of the session on screen, that
 * its transcript is never coming?
 *
 * The session-detail transcript panel had exactly one absence state for a
 * transcript the cloud has not got: "It'll show up here once the source machine
 * uploads it." For a machine on a data-sync level that keeps transcripts local
 * (`syncTierAllowsTranscripts` admits only `full`) that sentence is false and
 * permanently so — nothing was ever queued, so nothing is on its way.
 *
 * Deciding that needs TWO facts that live in different places, and the second
 * one is the one it is tempting to skip:
 *
 *  1. this machine's settled consent tier, and
 *  2. whether the session on screen was actually RECORDED ON THIS MACHINE.
 *
 * Without (2) the fix trades one false statement for another: a reader on a
 * `metadata` machine viewing a colleague's session — which the desktop does
 * show, because a `metadata` device still reads the org's cloud sessions —
 * would be told their own level is why a `full` machine's genuinely-in-flight
 * upload has not landed. Every path that cannot establish (2) therefore
 * withholds the claim and leaves the pending copy alone.
 *
 * Pure and React-free so the decision can be graded directly, without standing
 * up the provider stack the hook reads from.
 */
export type TranscriptNeverExpectedInput = {
  /**
   * Whether the consent read has SETTLED. An unsettled read is not a denial —
   * claiming a level during the IPC round trip would state a verdict the user
   * may not have given.
   */
  consentResolved: boolean;
  /**
   * The device's consent record, or `null` for a settled "could not read it"
   * (no bridge, rejected read). `null` is version skew, not a level, so it
   * yields no claim.
   */
  consentRecord: SyncConsentRecord | null;
  /**
   * The org of the CURRENT desktop session. A consent answer bound to another
   * org does not cover this one, which is why the tier is resolved through
   * {@link consentTierForOrg} rather than read off the record.
   */
  organizationId: string | null;
  /**
   * This machine's cloud identity, from the transcript status snapshot. Served
   * whether or not an archive lane exists — a metadata-level machine has no
   * lane and still has an identity — so `null` means only "cannot attribute"
   * (offline or signed out), never "not this machine".
   */
  deviceComputeTargetId: string | null;
  /** The compute target that produced the session under view. */
  sessionComputeTargetId: string | null;
};

/**
 * `true` only when BOTH facts are established and agree. Every other
 * combination — unsettled consent, an unreadable record, a level that does
 * carry transcripts, an unknown device identity, a session from another machine
 * — is `false`, which the panel renders as the unchanged "still syncing" state.
 *
 * ISS-11449: the org sync policy used to be a second, deliberately unconsulted
 * input here — a denial that also stopped transcripts but had a different remedy,
 * so reporting it as the user's own setting would have sent them to a control
 * that could not fix it. The policy is gone; the consent level is now the only
 * thing that can make a transcript never-expected.
 */
export function resolveTranscriptNeverExpected(
  input: TranscriptNeverExpectedInput
): boolean {
  if (!(input.consentResolved && input.consentRecord)) {
    return false;
  }
  if (
    input.deviceComputeTargetId === null ||
    input.sessionComputeTargetId === null ||
    input.deviceComputeTargetId !== input.sessionComputeTargetId
  ) {
    return false;
  }
  return syncTierExcludesTranscripts(
    consentTierForOrg(input.consentRecord, input.organizationId)
  );
}
