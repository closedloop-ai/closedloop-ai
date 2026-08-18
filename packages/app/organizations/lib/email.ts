/**
 * Shared email collection/validation for the "Invite your team" surfaces
 * (PRD-532 §5.4). The desktop/web invite dialog (`invite-team-dialog.tsx`)
 * gathers free-form email rows and needs consistent
 * trim/lowercase/dedupe/validate semantics — keep that logic here rather than
 * inlining it in the component.
 */

/**
 * Pragmatic email shape check: a non-space/non-`@` local part, an `@`, a
 * non-space/non-`@` domain with at least one dot. Not RFC-5322-exhaustive by
 * design — Clerk performs the authoritative validation server-side; this only
 * catches obvious typos before we POST a batch.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CollectedEmails = {
  /** Deduped, trimmed, lowercased addresses that pass {@link EMAIL_REGEX}. */
  valid: string[];
  /** Deduped, trimmed, lowercased addresses that fail {@link EMAIL_REGEX}. */
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
    if (EMAIL_REGEX.test(email)) {
      valid.add(email);
    } else {
      invalid.add(email);
    }
  }

  return { valid: [...valid], invalid: [...invalid] };
}
