/**
 * Client-side email address check, shared by every surface that collects an
 * address: the "Invite your team" rows (`organizations/lib/email.ts`, PRD-532
 * §5.4) and the download step's "notify me" capture
 * (`onboarding/components/desktop-availability-notify-form.tsx`, ISS-12364).
 * Moved here from `organizations/lib/email.ts` once it had a second caller, so
 * neither slice reaches into the other for it.
 */

/**
 * Pragmatic email shape check: a non-space/non-`@` local part, an `@`, a
 * non-space/non-`@` domain with at least one dot. Not RFC-5322-exhaustive by
 * design — the server performs the authoritative validation; this only
 * catches obvious typos before a request is sent.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Whether `candidate` can be an email address. Expects an already trimmed,
 * lowercased address: callers normalize first.
 */
export function isValidEmailAddress(candidate: string): boolean {
  if (candidate.length > 254 || !EMAIL_REGEX.test(candidate)) {
    return false;
  }

  const [localPart, domain] = candidate.split("@");
  if (
    !(localPart && domain) ||
    localPart.length > 64 ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..")
  ) {
    return false;
  }

  return domain.split(".").every(isValidDomainLabel);
}

function isValidDomainLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= 63 &&
    !label.startsWith("-") &&
    !label.endsWith("-") &&
    EMAIL_DOMAIN_LABEL_PATTERN.test(label)
  );
}

const EMAIL_DOMAIN_LABEL_PATTERN = /^[a-z0-9-]+$/i;
