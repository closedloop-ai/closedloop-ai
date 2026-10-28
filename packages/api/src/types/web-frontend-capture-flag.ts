/**
 * Feature flag that gates PostHog session replay on the web surfaces (FEA-2400,
 * ISS-10650, ISS-12558).
 *
 * Targeting lives entirely in PostHog. Two readers resolve this one key:
 *  - `apps/app`'s frontend-capture controller, for identified product-app
 *    users, which also gates staff-scoped Datadog RUM enhanced capture.
 *  - `apps/web`'s marketing replay controller, for marketing visitors with no
 *    sign-in required (PRD-790 Q-002/Q-003: the same settings as web-app
 *    production replay).
 *
 * Disabling the flag stops all added capture on both. Lives in this
 * dependency-free `@repo/api` module so both apps import the same literal.
 */
export const WEB_FRONTEND_CAPTURE_FLAG_KEY = "web-frontend-capture";
