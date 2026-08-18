/**
 * ISS-5271: the single cross-surface flag key gating the Sessions summary
 * cards' honest never-loaded state — when the usage summary has not loaded yet
 * (`usage === undefined` with no error), the Sessions and Total Tokens cards
 * hold their frame and skeleton ONLY the value slot instead of confidently
 * rendering `0` for a number that was never computed. The Cost card beside them
 * already dashes in that state, so the unflagged row reads `0 / 0 / —` and
 * contradicts itself; this key closes that gap. Display only — no fetch,
 * derivation, or wire shape changes.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so BOTH surfaces import the SAME literal instead of
 * redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_SESSIONS_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition — it can't silently split PostHog and Desktop the way two parallel
 * string literals could. The desktop parity test asserts each surface alias
 * resolves to this constant.
 */
export const SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY =
  "sessions-summary-honest-loading" as const;
