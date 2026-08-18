/**
 * ISS-4890 / ISS-4906 / ISS-4901: the single cross-surface flag key that gates
 * the Sessions grid's horizontal-fold legibility pass — the one-time relocation
 * of a persisted `columnOrder`'s Cost column to its canonical pre-fold slot
 * (ISS-4890), the settle-damped fold fit that removes the resize sawtooth
 * (ISS-4906), and the scroll affordance signposting the columns past the fold
 * (ISS-4901).
 *
 * The three ship under ONE key on purpose: they are three halves of the same
 * claim — "what the Sessions grid shows at rest is whole, stable, and honest
 * about what is off-screen". Splitting them would let a build snap the fold to a
 * boundary (so nothing looks cut) while withholding the cue that anything is
 * past it, which is strictly worse than either state alone (the ISS-4901
 * premise).
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition — it can't silently split PostHog and Desktop the way two parallel
 * string literals could. The desktop parity test asserts each surface alias
 * resolves to this constant.
 */
export const SESSIONS_GRID_FOLD_LEGIBILITY_FLAG_KEY =
  "sessions-grid-fold-legibility" as const;
