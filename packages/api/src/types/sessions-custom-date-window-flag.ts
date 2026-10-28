/**
 * FEA-4201 (ISS-4779 closed-by-default): the single cross-surface flag key
 * gating the Sessions listing's EXPLICIT from/to date window — the `?from=`/
 * `?to=` URL params, the Custom entry point beside the preset pills, and the
 * clear control that hands the listing back to the preset.
 *
 * The Sessions listing exists on BOTH surfaces and both read their window from
 * the same URL, so the gate is shared: with it off, `?from=`/`?to=` are inert on
 * either surface and the listing keeps reading over the rolling `?range=` preset
 * exactly as before, so an inbound link written by a build that has the flag on
 * can never narrow a listing whose viewer has no control to see or clear it.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop renderer resolves the SAME literal from the signed-in
 *    account's PostHog assignment, delivered over the IPC bridge, via
 *    `DESKTOP_SESSIONS_CUSTOM_DATE_WINDOW_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags-labs-detail.ts`). That is the same
 *    key space the web app reads, so one PostHog flag gates both surfaces and
 *    neither can offer a Custom window the other silently ignores.
 *
 * Fail-closed on desktop in every build, dev included (ISS-8753): an unknown
 * key, an unresolved assignment, a signed-out session and an offline one all
 * resolve `false`. There is no desktop Labs toggle and no registry entry paired
 * with this key — the registry carries only its default-off main-process
 * settings metadata.
 */
export const SESSIONS_CUSTOM_DATE_WINDOW_FLAG_KEY =
  "sessions-custom-date-window" as const;
