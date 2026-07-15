/**
 * Feature flag that gates enhanced web-app frontend capture (FEA-2400).
 *
 * Targeting lives in PostHog (release condition: person `email` contains
 * `@closedloop.ai`), not in code. When enabled for the identified user, the
 * frontend-capture controller starts staff-scoped PostHog session replay +
 * dead-click autocapture and Datadog RUM interaction/replay capture. Disabling
 * the flag stops all added capture.
 */
export const WEB_FRONTEND_CAPTURE_FLAG_KEY = "web-frontend-capture";

/** Email domain of the internal staff org this capture is scoped to. */
export const STAFF_EMAIL_DOMAIN = "@closedloop.ai";

/**
 * Defense-in-depth staff check. The PostHog flag is the primary gate (its
 * cohort targeting lives in PostHog), but `useFeatureFlag` **fails open** when
 * `NEXT_PUBLIC_POSTHOG_KEY` is unset — its fallback defaults unknown flags to
 * `enabled: true` (see `packages/analytics/client.ts`). Requiring a staff email
 * in code keeps capture fail-CLOSED for customers even in that misconfiguration
 * (e.g. Datadog RUM keys present but PostHog key absent), and enforces the
 * FEA-2400 "staff org only" guarantee at the call site rather than trusting the
 * flag alone.
 */
export function isStaffEmail(email: string | undefined): boolean {
  return email?.toLowerCase().endsWith(STAFF_EMAIL_DOMAIN) === true;
}
