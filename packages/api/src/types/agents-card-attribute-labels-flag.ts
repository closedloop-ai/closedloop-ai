/**
 * ISS-5532: the single cross-surface flag key that gates the Agents catalog's
 * narrow-surface card naming the attributes it promotes into its header.
 *
 * The card has no column header row to read a value against, so a promoted
 * value arrives anonymous: the card opened `Tool —`, a type word and a dash,
 * with nothing saying what the dash was the absence of. With the flag ON each
 * promoted attribute is a `dt`/`dd` pair carrying its own column's label, so the
 * pairing is announced rather than implied by proximity. With it OFF the header
 * renders exactly as it ships today.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `AGENTS_CARD_ATTRIBUTE_LABELS_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop renderer resolves the byte-for-byte-equal key from the
 *    signed-in account's PostHog assignment, delivered over the IPC bridge,
 *    under the alias `DESKTOP_AGENTS_CARD_ATTRIBUTE_LABELS_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * `AgentsGroupedList` → `AgentsTable` is the DEFAULT layout for both the web
 * `/[orgSlug]/agents` route and the packaged desktop Agents view, and the
 * desktop window resizes to the width that swaps the grid for cards, so a
 * single-surface gate would let the change leak on desktop while hidden on web
 * (ISS-4779 closed-by-default).
 */
export const AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY =
  "agents-card-attribute-labels" as const;
