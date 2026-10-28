import { SlugPrefix } from "./slug-prefix.ts";

/**
 * Which slug prefixes count as typed slugs: accepted by the `uuidOrSlug`
 * validator and shown by {@link isDisplayableSlug}. Exhaustive over
 * {@link SlugPrefix} so a new prefix fails `tsc` until it is classified here —
 * ISS-10984: the hand-maintained list this replaced silently omitted `DOC`, so
 * every `uuidOrSlug` route 400'd on `DOC-*`.
 *
 * FEA-4137: `ISS` is canonical and `FEA` its compat alias; both must stay
 * accepted or every existing `FEA-*` link 404s.
 */
const TYPED_SLUG_PREFIX_ACCEPTED: Readonly<Record<SlugPrefix, boolean>> = {
  [SlugPrefix.Project]: true,
  [SlugPrefix.Prd]: true,
  [SlugPrefix.Plan]: true,
  [SlugPrefix.Feature]: true,
  [SlugPrefix.Issue]: true,
  [SlugPrefix.Workflow]: true,
  [SlugPrefix.Doc]: true,
  // SES false and WRK true only reproduce the pre-ISS-10984 list exactly (that
  // change added DOC and nothing else). Neither value claims a uuidOrSlug route
  // can resolve the prefix: the resolvers behind it find neither SES-* nor WRK-*.
  [SlugPrefix.Session]: false,
};

export const TYPED_SLUG_PREFIXES: readonly SlugPrefix[] = Object.values(
  SlugPrefix
).filter((prefix) => TYPED_SLUG_PREFIX_ACCEPTED[prefix]);

export const TYPED_SLUG_PATTERN = new RegExp(
  String.raw`^(${TYPED_SLUG_PREFIXES.join("|")})-\d+$`
);

/**
 * Returns true if the slug matches the new typed format (e.g. "PRD-42", "PROJ-1").
 * Old slugs are random nanoid strings and should not be displayed in the UI.
 */
export function isDisplayableSlug(slug: string | null | undefined): boolean {
  if (!slug) {
    return false;
  }
  return TYPED_SLUG_PATTERN.test(slug);
}
