/**
 * Canonical internal-staff identity check, shared across surfaces.
 *
 * A Closedloop employee is identified by an `@closedloop.ai` email. This is the
 * single source of truth for that check so web (`apps/app`) and the desktop
 * renderer (`apps/desktop`) gate internal-only affordances the same way, and so
 * the comment service (`apps/api/app/comments/service/`) grants the staff-only
 * `parsing_bug` comment kind by the same predicate (ISS-11212, PLN-2121
 * decision 5).
 */

/** Email domain of the internal Closedloop staff org. */
export const STAFF_EMAIL_DOMAIN = "@closedloop.ai";

/** Whether `email` belongs to the internal Closedloop staff org. */
export function isStaffEmail(email: string | undefined | null): boolean {
  return email?.toLowerCase().endsWith(STAFF_EMAIL_DOMAIN) === true;
}
