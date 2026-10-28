/**
 * Shared email collection/validation for the "Invite your team" surfaces
 * (PRD-532 §5.4). The desktop/web invite dialog (`invite-team-dialog.tsx`)
 * gathers free-form email rows and needs consistent
 * trim/lowercase/dedupe/validate semantics — keep that logic here rather than
 * inlining it in the component. The address check itself is
 * `shared/lib/email-address.ts`, shared with the download step's "notify me"
 * capture (ISS-12364).
 */

import { isValidEmailAddress } from "../../shared/lib/email-address";

export type CollectedEmails = {
  /** Deduped, trimmed, lowercased addresses that pass {@link isValidEmailAddress}. */
  valid: string[];
  /** Deduped, trimmed, lowercased addresses that fail {@link isValidEmailAddress}. */
  invalid: string[];
};

/**
 * Normalizes (trim + lowercase), skips blanks, dedupes, and partitions raw
 * email strings into valid/invalid buckets. Callers pass the flattened set of
 * candidate addresses (e.g. selected contributor rows + manual rows).
 */
export function collectEmails(rawEmails: Iterable<string>): CollectedEmails {
  const valid = new Set<string>();
  const invalid = new Set<string>();

  for (const raw of rawEmails) {
    const email = raw.trim().toLowerCase();
    if (!email) {
      continue;
    }
    if (isValidEmailAddress(email)) {
      valid.add(email);
    } else {
      invalid.add(email);
    }
  }

  return { valid: [...valid], invalid: [...invalid] };
}
