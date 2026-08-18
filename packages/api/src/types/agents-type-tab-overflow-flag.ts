/**
 * ISS-4803: the single cross-surface flag key that gates the Agents catalog
 * type-tab strip disclosing the tabs it cannot fit.
 *
 * FEA-4019 grew the strip to eight segments (All + the seven
 * `SCOPED_CORE_KINDS`). At a phone width only the first few fit; the rest are
 * clipped by the strip's horizontal scroll track, which offers an edge fade and
 * nothing else. A fade is a hint that something is cut off, not a control that
 * reaches it, and the strip is a Radix `ToggleGroup` — a roving-tabindex control
 * that is ONE tab stop, so Tab does not step through the segments either. The
 * clipped kinds are therefore reachable only by arrowing blind inside a control
 * that never says there is more.
 *
 * With the flag ON the strip fits itself to its measured width and collapses the
 * remainder behind a real, focusable overflow menu that names what it is hiding.
 * With it OFF the strip renders exactly as it ships today.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * `AgentsGroupedList` is the DEFAULT layout for both the web `/[orgSlug]/agents`
 * route and the packaged desktop Agents view, so a single-surface gate would let
 * the change leak on desktop while hidden on web (ISS-4779 closed-by-default).
 */
export const AGENTS_TYPE_TAB_OVERFLOW_FLAG_KEY =
  "agents-type-tab-overflow" as const;
