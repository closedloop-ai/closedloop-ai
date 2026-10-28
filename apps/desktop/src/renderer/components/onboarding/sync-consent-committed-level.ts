/**
 * @file What the main process actually COMMITTED for a sync-consent write, and
 * what to say when the write failed.
 *
 * Extracted from the retired post-auth consent takeover (ISS-8346) so the guided
 * onboarding wizard's sync step reuses the same two answers instead of copying
 * them. Both are contract-shaped rather than incidental: the level main returns
 * can differ from the one this renderer asked for, and the failure message is
 * asserted by name in the takeover gate's own suite.
 */

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { SyncConsentLevel } from "@repo/app/onboarding/components/sync-consent";

/** What `desktop:record-sync-consent` resolves with — the answer main committed. */
export type RecordSyncConsentResult = {
  level: DataSyncLevel;
  organizationId: string | null;
};

/** Shown when the write failed; the control stays live so it can be retried. */
export const SAVE_FAILED_MESSAGE =
  "We couldn't save your choice. Please try again.";

/**
 * The level main committed, when it is one a consent surface can represent.
 *
 * `DataSyncLevel` is the wider set (it carries `redacted`, which no consent
 * surface offers), so the returned value is adopted only when it lands inside
 * the three. Anything else keeps what the user actually chose rather than being
 * cast into a shape the union forbids — an unreachable branch today, and the
 * honest fallback if the normalization on the other side ever widens.
 *
 * `string | undefined` and not `DataSyncLevel | undefined`, because the caller
 * that validates the bridge reply (`committedSyncConsentReply`) deliberately
 * leaves the level open there so a newer main naming a level this build has not
 * heard of still counts as a commit. The narrowing is this function's job, and
 * a closed parameter type would only have forced a cast at that call site.
 * That fallback is for a WIDER level from a working bridge — it is not what
 * makes a broken reply safe, which is why the reply is validated first.
 */
export function committedSyncConsentLevel(
  returned: string | undefined,
  requested: SyncConsentLevel
): SyncConsentLevel {
  if (
    returned === DataSyncLevel.Off ||
    returned === DataSyncLevel.Metadata ||
    returned === DataSyncLevel.Full
  ) {
    return returned;
  }
  return requested;
}
