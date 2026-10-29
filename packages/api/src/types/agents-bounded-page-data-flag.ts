/**
 * ISS-6822 (ISS-4779 closed-by-default policy): the single cross-surface flag
 * key gating the Agents list's BOUNDED page-data read.
 *
 * OFF — the default — the list fetches the inventory populations in full (up to
 * three `GET /agent-components?limit=5000` calls on web, one on desktop) and
 * sorts, filters, pages, counts facets, and aggregates them in the renderer. ON,
 * it asks its data source for the page, the facet counts, and both window
 * aggregates in one bounded call, and the SAME reduction runs at the producer
 * instead.
 *
 * The two paths were meant to be indistinguishable on screen — that was the
 * ticket's acceptance — so this gate exists to make the switch reversible per
 * surface while that equivalence is confirmed against real org data.
 *
 * ISS-6409 ended that equivalence for the LOC/$ card, deliberately. The
 * summary card's LOC/$ is a ratio of sums over the session union, and only a
 * producer still holding session identities can fold it; the browser's legacy
 * reduction sees rows whose ratios cannot be recombined into that estimand. So
 * flag-OFF the card reads `—` where it used to read a number. The old number
 * was the unweighted mean of the rows' ratios — a different estimand presented
 * under the same label — so this is a wrong value withdrawn, not a right one
 * lost.
 *
 * TWO rendered things differ, not one: the figure AND its "across N
 * components" caption, which is not gated on the figure and so reads "across 0
 * components" beside the dash. Every other value on both paths still agrees,
 * and that is still the acceptance for the rest of this gate.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no heavy
 * transitive graph) precisely so BOTH surfaces import the SAME literal instead of
 * redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop renderer resolves the byte-for-byte-equal key from the
 *    signed-in account's PostHog assignment, delivered over the IPC bridge,
 *    under the alias `DESKTOP_AGENTS_BOUNDED_PAGE_DATA_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags-labs-surfaces.ts`).
 *
 * The list is rendered by the SHARED `AgentsGroupedList`, so it exists on both
 * surfaces and must be gated on both.
 */
export const AGENTS_BOUNDED_PAGE_DATA_FLAG_KEY =
  "agents-bounded-page-data" as const;
