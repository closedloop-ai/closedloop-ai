/**
 * ISS-5490 FR-1: the single source of truth for the pre-auth landing hero, shared
 * by the two surfaces that render it.
 *
 * Both landings are the same doorway into the same product, and ISS-5249 names
 * the hero as shared across the desktop pre-auth landing and the web onboarding
 * entrance. Before this module they were two independent string literals in two
 * apps, which is how a headline silently ends up saying two different things
 * after one of them is edited.
 *
 * Consumers:
 *  - `apps/web` marketing landing (`components/home/hero-section.tsx`)
 *  - the desktop guest landing
 *    (`apps/desktop/src/renderer/components/onboarding/guest-landing.tsx`)
 *
 * Lives in `@repo/lib` rather than `@repo/api/src/types` because it is not an
 * API contract and neither consumer is `apps/api`: that module is reserved for
 * types both `apps/app` and `apps/api` consume. This one is surface-neutral
 * copy with no imports at all, so a bundle-sensitive marketing page can
 * subpath-import these four strings without pulling anything else in.
 *
 * COPY ONLY, deliberately: the two surfaces style the headline differently and
 * that difference is intentional, so no class names or markup live here. Web
 * accents {@link LANDING_HERO_HEADLINE_ACCENT_WORD} in the primary colour, as
 * the prototype does; desktop renders one colour because its mark sits on the
 * same rail as the headline and two near-identical blues read as a mistake
 * (rationale in `guest-landing.tsx`).
 */
export const LANDING_HERO_HEADLINE = "Stop burning tokens." as const;

/**
 * The word in {@link LANDING_HERO_HEADLINE} that carries the accent colour on
 * surfaces which use one. Kept beside the headline so a copy edit that drops the
 * word is at least visible in the same diff — nothing structurally ties them, so
 * {@link splitHeadlineOnAccent} is what makes the mismatch harmless.
 */
export const LANDING_HERO_HEADLINE_ACCENT_WORD = "burning" as const;

export const LANDING_HERO_SUBTITLE =
  "We parse your agent sessions and show you where spend goes, what’s working, and how to build more efficiently." as const;

/**
 * The headline as a page title: same words, no terminal period, because a
 * browser tab and a search result render it inline rather than as a sentence.
 *
 * Kept here rather than derived by stripping punctuation off
 * {@link LANDING_HERO_HEADLINE} so a future copy change has to consider both
 * renderings explicitly instead of one silently reformatting the other.
 */
export const LANDING_PAGE_TITLE = "Stop burning tokens" as const;

/** A headline split around the word a surface emphasises. */
export type AccentedHeadline = {
  readonly before: string;
  /** `null` when the accent word is not in the headline. */
  readonly accent: string | null;
  readonly after: string;
};

/**
 * Split a headline around its accent word, for a surface that colours it.
 *
 * Total by construction. A naive `split` returns a single segment when the word
 * is absent, and a surface that renders before + accent + after then prints the
 * whole headline followed by a word that is no longer part of it. Nothing above
 * prevents a copy edit from doing exactly that, so the absent case returns the
 * headline with no accent instead.
 *
 * A headline containing the word more than once keeps every later occurrence:
 * only the first is emphasised, and `after` puts the rest back.
 */
export function splitHeadlineOnAccent(
  headline: string,
  accent: string
): AccentedHeadline {
  const [before, ...rest] = headline.split(accent);
  if (rest.length === 0) {
    return { before: headline, accent: null, after: "" };
  }
  return { before, accent, after: rest.join(accent) };
}
