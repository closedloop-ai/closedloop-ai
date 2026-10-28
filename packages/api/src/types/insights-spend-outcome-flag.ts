/**
 * ISS-4463: the single cross-surface flag key that gates the Insights
 * "Spend by outcome" tiles — the TokenOps lens that splits a period's AI spend
 * by the originating session's lifecycle outcome (ended clean / ended with error
 * / still running / not recorded).
 *
 * Scoped to the two Agents-section tiles this ships (the bar and the donut over
 * the same `spendByOutcome` data), so the whole lens flips together rather than
 * a user seeing the bar without the share view. The server always computes and
 * returns `spendByOutcome`; this flag gates only the UI rollout, so with it off
 * the Insights surface renders exactly as before.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop renderer resolves the byte-for-byte-equal key from the
 *    signed-in account's PostHog assignment, delivered over the IPC bridge,
 *    under the alias `DESKTOP_INSIGHTS_SPEND_OUTCOME_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags-labs-detail.ts`).
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition — it can't silently split the two surfaces' reads of it the way
 * two parallel string literals could.
 */
export const INSIGHTS_SPEND_OUTCOME_FLAG_KEY =
  "insights-spend-outcome" as const;
