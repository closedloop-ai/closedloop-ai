/**
 * ISS-5005: the single cross-surface flag key that gates the Agents catalog
 * landing on a USAGE-BEARING default sort (Invocations, descending) instead of
 * alphabetical Component ascending.
 *
 * Why the alphabetical default was a finding and not a preference: internal
 * tools are underscore-prefixed, so ascending-by-name puts every `_`-prefixed
 * internal first. A production sweep of a 2,133-component org landed on eleven
 * rows carrying 3 invocations between them out of 292,875 in the inventory, and
 * an entirely empty LOC/$ column — the primary discovery surface for what the
 * org's agents do, answering none of "which are used", "which are expensive",
 * "which earn their cost". The sibling surfaces already lead with activity
 * (Sessions defaults to most-recent, Branches to "Last active" descending);
 * Agents was the odd one out.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition — it can't silently split PostHog and Desktop the way two parallel
 * string literals could. The desktop parity test asserts each surface alias
 * resolves to this constant.
 */
export const AGENTS_DEFAULT_SORT_USAGE_FLAG_KEY =
  "agents-default-sort-usage" as const;
