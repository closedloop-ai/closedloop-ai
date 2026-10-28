import { NavId } from "../../navigation/route-table";

const WORD_RE = /[a-z]+/g;
const PLURAL_ES_RE = /es$/;
const PLURAL_S_RE = /s$/;

/**
 * Every desktop page, as a reader would name it — and as a list connect-status
 * continuation therefore must NOT, since no variant renders on only one page
 * (ISS-11326).
 *
 * DERIVED from {@link NavId}, the renderer's canonical page set, rather than
 * listed. A hand-written inventory of the pages that render the banner today is
 * the same shape as the defect: `list` was written for Branches, Sessions and
 * Insights adopted it, ISS-11326 found the Dashboard on it too, and nothing
 * mechanically told the guard. Deriving means a page added to the route table
 * joins this set without anyone remembering to, so a continuation naming a page
 * that did not exist when this was written still reddens.
 *
 * Singular as well as plural, because the defect arrived in both shapes — once
 * as a page name ("Branches refresh when the connection is available.") and once
 * as a data noun ("Local branch data remains available.").
 */
export const LIST_SURFACE_PAGE_NOUNS: readonly string[] = Object.values(
  NavId
).flatMap((id) => [id, singularize(id)]);

/**
 * Which desktop pages one message names — empty when it names none, which is the
 * contract.
 *
 * Returns rather than asserts so every caller's assertion stays visible inside
 * its own `it()`, and so a caller must pair it with a positive check on the same
 * text: an empty string names no page either, and a locator that matched nothing
 * would otherwise satisfy the whole guard.
 *
 * Word-tokenized rather than substring-matched, so "branch" cannot be satisfied
 * by absence while "branches" slips through, and so an unrelated word that merely
 * contains a page id does not false-positive.
 */
export function listSurfacePageNounsNamedIn(
  message: string | null | undefined
): string[] {
  const words = new Set((message ?? "").toLowerCase().match(WORD_RE) ?? []);
  return LIST_SURFACE_PAGE_NOUNS.filter((noun) => words.has(noun));
}

/**
 * The bare page word behind a plural id, so "branches" also guards "branch". Not
 * a general inflector — the ids are known lowercase ASCII, and a word this leaves
 * mangled ("routines" → "routin") only ever over-guards, which fails loudly
 * instead of silently.
 */
function singularize(id: string): string {
  if (PLURAL_ES_RE.test(id)) {
    return id.replace(PLURAL_ES_RE, "");
  }
  return id.replace(PLURAL_S_RE, "");
}
