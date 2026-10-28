/**
 * ISS-7477: the flag that gates the internal DEV-MODE control itself — the
 * switch an `@closedloop.ai` viewer uses to drop into the customer view and back.
 *
 * Two properties make this key unlike every other flag key in this directory:
 *
 *  - It gates a control that is ALREADY invisible to customers (the surface
 *    checks `isStaffEmail` before rendering). The flag is the ISS-4779
 *    closed-by-default rollout gate on top of that, not the access boundary.
 *  - It is the ONE key that must keep resolving normally while the customer view
 *    is active (`DEV_MODE_EXEMPT_FLAG_KEYS`). Suppressing it would hide the only
 *    way back out of the view it turned on.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module so both surfaces
 * can import the same literal rather than redeclaring it, per the convention the
 * neighbouring `*-flag.ts` modules follow. Both shells read it. The Desktop
 * question PR #5769 left open assumed Desktop read Labs config; since ISS-8024
 * the Desktop renderer reads the signed-in account's PostHog assignment through
 * the API, so ISS-12048 gave Desktop the same Dev Mode, keyed on this flag plus
 * a staff email (`desktop-dev-mode-provider.tsx` in the renderer, and
 * `desktop-feature-flag-dev-mode.ts` for main's own reads).
 */
export const DEV_MODE_FLAG_KEY = "dev-mode" as const;
