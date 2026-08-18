/**
 * ISS-5500: the single cross-surface flag key that gates the Agents component
 * detail page telling the truth about WHY it has no definition body to show.
 *
 * The Definition panel renders one empty state — "We haven't captured this
 * component's definition yet." — for every reason a body can be absent, and the
 * server genuinely emits several distinct ones:
 *  - an orphan-only identity (usage rows but no inventory/version row) is
 *    `unresolved`: no definition was EVER recorded, on any device;
 *  - an `inaccessible`/`missing` row HAS a definition the collector could not
 *    read (permission-denied) or that was deleted;
 *  - a `resolved` row with a null body is a component the org demonstrably CAN
 *    read whose body nonetheless did not come through — a load failure.
 * Collapsing all of these into "not captured yet" makes a never-recorded
 * definition indistinguishable from one that failed to load, which is exactly
 * the conflation the logical-QA doctrine forbids.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * `AgentDetail` mounts on the web app AND the packaged desktop renderer, so a
 * single-surface gate would let the change leak on desktop while hidden on web
 * (ISS-4779 closed-by-default). Importing one constant on both sides means a
 * future rename touches a single definition and cannot silently split them.
 */
export const AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY =
  "agents-definition-empty-state-honesty" as const;
