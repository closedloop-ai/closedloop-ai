/**
 * ISS-5534 (ISS-4779 closed-by-default policy): the single cross-surface flag
 * key gating the Agents list Invocations summary card's plugin de-duplication.
 *
 * A `plugin` component is never invoked directly — its `invocations` are the SUM
 * of its skill/command/subagent/mcp children's usage. On the "All" type tab both
 * the plugin AND those children are rows in the same population, so summing
 * `invocations` across every row counts each child invocation twice. With this
 * flag ON the card counts each invocation once; with it OFF (the default) the
 * card renders exactly the pre-ISS-5534 total.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no heavy
 * transitive graph) precisely so BOTH surfaces import the SAME literal instead of
 * redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_AGENTS_INVOCATIONS_DEDUPE_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * The card is rendered by the SHARED `AgentsGroupedList`, so it exists on both
 * surfaces and must be gated on both — importing one constant on each side means
 * a rename touches a single definition and cannot silently split PostHog from
 * Desktop the way two parallel string literals could.
 */
export const AGENTS_INVOCATIONS_DEDUPE_FLAG_KEY =
  "agents-invocations-dedupe" as const;
