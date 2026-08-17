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
