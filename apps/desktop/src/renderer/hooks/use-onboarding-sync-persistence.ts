/**
 * @file The guided wizard's sync-level write (ISS-8346).
 *
 * The step itself is presentational, the same way `SyncConsent` is: this hook
 * owns the in-flight state, the failure text and the retry, and hands the step
 * back exactly what it renders. The write path is the SHIPPED
 * `desktop:record-sync-consent` IPC — nothing new is persisted here, and the
 * level that reaches the store is the one main COMMITTED rather than the one
 * this renderer asked for.
 */

import type { SyncConsentLevel } from "@repo/app/onboarding/components/sync-consent";
import { useCallback, useState } from "react";
import {
  committedSyncConsentLevel,
  SAVE_FAILED_MESSAGE,
} from "../components/onboarding/sync-consent-committed-level";
import {
  type CommittedSyncConsentReply,
  committedSyncConsentReply,
} from "../components/onboarding/sync-consent-reply";

/** The answer main actually stored, as a consent surface can represent it. */
export type CommittedSyncConsent = {
  level: SyncConsentLevel;
  organizationId: string | null;
};

export type OnboardingSyncPersistence = {
  /** Why the last write failed, or `null`. Cleared when a retry begins. */
  error: string | null;
  /**
   * Persist the chosen level. Resolves with what main COMMITTED on success, or
   * `null` on failure — the caller advances only on a committed answer.
   *
   * BOTH halves, not just the level. Main reads the organization from the
   * authenticated session and ignores the one in the payload, so a sign-in that
   * lands mid-write commits consent for a different org than the caller asked
   * for; dropping the returned id would leave the caller unable to tell.
   */
  persist: (level: SyncConsentLevel) => Promise<CommittedSyncConsent | null>;
  saving: boolean;
};

export function useOnboardingSyncPersistence(
  organizationId: string | null
): OnboardingSyncPersistence {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const persist = useCallback(
    async (level: SyncConsentLevel): Promise<CommittedSyncConsent | null> => {
      setSaving(true);
      setError(null);
      const committed = await recordSyncConsent(level, organizationId);
      setSaving(false);
      if (committed === null) {
        setError(SAVE_FAILED_MESSAGE);
        return null;
      }
      // What main COMMITTED, not what this renderer asked for: main reads the
      // org from the authenticated session and normalizes the level, so echoing
      // the request back would publish a choice that was never stored.
      return {
        level: committedSyncConsentLevel(committed.level, level),
        organizationId: committed.organizationId,
      };
    },
    [organizationId]
  );

  return { error, persist, saving };
}

/**
 * The shipped write, resolving `null` for every way it can fail to reach disk.
 *
 * Four distinct failures, all of them silent by default. `?.` RESOLVES
 * `undefined` rather than throwing, so a missing `desktopApi` and a handler that
 * returns nothing both sail through the `try` having written nothing while the
 * screen says the choice was saved; a rejection is the only one that announces
 * itself. The fourth is a reply that arrives and proves nothing — `{}` or a
 * husk from an older bridge — which a `!= null` test cannot tell from a commit
 * record, so the shape is VALIDATED rather than trusted. All four become `null`
 * here so the caller has one thing to check.
 *
 * A rejection is reported by the caller in the step, NOT logged — client debug
 * logging is banned repo-wide, and letting it escape would surface as an
 * unhandled renderer rejection instead.
 */
async function recordSyncConsent(
  level: SyncConsentLevel,
  organizationId: string | null
): Promise<CommittedSyncConsentReply | null> {
  const record = window.desktopApi?.recordSyncConsent;
  if (!record) {
    return null;
  }
  try {
    return committedSyncConsentReply(await record({ level, organizationId }));
  } catch {
    return null;
  }
}
