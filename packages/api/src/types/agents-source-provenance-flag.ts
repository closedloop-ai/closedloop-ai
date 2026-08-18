/**
 * ISS-5009: the single cross-surface flag key that gates the Agents catalog
 * Source column telling the truth about provenance it does not have.
 *
 * Every producer of an `AgentComponent` falls back to the component's own
 * identity key when no real provenance exists, so the Source column renders the
 * same string as the Component column — a whole column of duplicated
 * identifiers that claims to be provenance. Behind this flag, a row with no real
 * provenance renders the shared em-dash empty glyph instead of the echo, a row
 * WITH provenance renders that provenance and the source type it actually came
 * from, and the Source facet's options, counts and membership all key on the
 * same honest value so a filter option can never match zero rows.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_AGENTS_SOURCE_PROVENANCE_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition — it cannot silently split PostHog and Desktop the way two parallel
 * string literals could (wongk, PR #4202).
 */
export const AGENTS_SOURCE_PROVENANCE_FLAG_KEY =
  "agents-source-provenance-honesty" as const;
