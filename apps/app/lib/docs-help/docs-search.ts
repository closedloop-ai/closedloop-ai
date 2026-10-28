import {
  DocsHelpMatchField,
  type DocsHelpPage,
  type DocsHelpSearchHit,
} from "@repo/app/help/lib/docs-help-payload";

const EXCERPT_CHARS = 140;
const HEADING_SCORE = 3;
const TITLE_SCORE = 2;
const BODY_SCORE = 1;
const GROUP_SCORE = 0.5;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const TOKEN_SPLIT_RE = /[^a-z0-9]+/;

/**
 * ISS-10006 — web's docs index, over the same fields desktop's main-process
 * index searches.
 *
 * HEADINGS ARE PREFERRED FOR THE ANCHOR, and that is the feature rather than a
 * ranking preference: a heading hit is the only kind that carries a
 * `headingSlug`, and that slug is what turns "open the page" into "land on the
 * section". Without it `pendingHeadingSlug` could never be anything but null and
 * the surface's deep-link path would be dead code on this host. (Desktop weights
 * title above heading; that is the one divergence here, and it is the reader's
 * anchor rather than a transport detail.)
 *
 * EVERYTHING ELSE MATCHES `apps/desktop/src/main/docs-help/docs-search-index.ts`
 * ABOVE THE TRANSPORT (tamsinb/whitlockk review), because a reader typing the same
 * words into the same box on two hosts must not get two different answers:
 *
 * - the query is TOKENIZED and the terms are ANDed, so "ghost detection" finds
 *   the "Ghost loop detection" heading and word order does not decide whether a
 *   two-word query matches at all;
 * - a term is allowed to land in the nav GROUP, so searching a group name keeps
 *   the pages under it whose title, headings and body never say it;
 * - the result set is CLAMPED, so a short common word cannot paint the whole
 *   155-page corpus into a pane that renders every row it is handed.
 */
export function searchDocsCorpus(
  pages: readonly DocsHelpPage[],
  query: string,
  limit?: number
): DocsHelpSearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return [];
  }
  const hits: DocsHelpSearchHit[] = [];
  for (const page of pages) {
    const hit = scorePage(page, terms);
    if (hit !== null) {
      hits.push(hit);
    }
  }
  hits.sort(
    (left, right) =>
      right.score - left.score || left.title.localeCompare(right.title)
  );
  return hits.slice(0, clampLimit(limit));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(TOKEN_SPLIT_RE)
    .filter((token) => token.length > 0);
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** Where one term landed on one page, or null when it landed nowhere. */
type TermPlacement = {
  readonly inHeading: string | undefined;
  readonly inTitle: boolean;
  readonly inBody: boolean;
  readonly inGroup: boolean;
};

function placeTerm(page: DocsHelpPage, term: string): TermPlacement | null {
  const heading = page.headings.find((item) =>
    item.text.toLowerCase().includes(term)
  );
  const inTitle = page.title.toLowerCase().includes(term);
  const inBody = page.body.toLowerCase().includes(term);
  const inGroup = (page.group ?? "").toLowerCase().includes(term);
  if (heading === undefined && !(inTitle || inBody || inGroup)) {
    return null;
  }
  return { inBody, inGroup, inHeading: heading?.slug, inTitle };
}

/**
 * AND semantics: a page is a hit only when EVERY term landed somewhere on it.
 * The FIELD reported is the strongest any term reached, which is what the pane
 * labels the row and — for a heading — what it scrolls to.
 */
function scorePage(
  page: DocsHelpPage,
  terms: readonly string[]
): DocsHelpSearchHit | null {
  let headingSlug: string | undefined;
  let inTitle = false;
  let inBody = false;
  for (const term of terms) {
    const placement = placeTerm(page, term);
    if (placement === null) {
      return null;
    }
    headingSlug ??= placement.inHeading;
    inTitle ||= placement.inTitle;
    inBody ||= placement.inBody;
  }
  const bodyIndex = inBody
    ? page.body.toLowerCase().indexOf(terms[0] ?? "")
    : -1;
  return {
    excerpt:
      bodyIndex >= 0
        ? page.body.slice(bodyIndex, bodyIndex + EXCERPT_CHARS)
        : page.body.slice(0, EXCERPT_CHARS),
    matchField: matchFieldOf(headingSlug !== undefined, inTitle, inBody),
    path: page.path,
    score: scoreOf(headingSlug !== undefined, inTitle, inBody),
    title: page.title,
    ...(headingSlug === undefined ? {} : { headingSlug }),
    ...(page.group === undefined ? {} : { group: page.group }),
  };
}

function matchFieldOf(
  inHeading: boolean,
  inTitle: boolean,
  inBody: boolean
): DocsHelpMatchField {
  if (inHeading) {
    return DocsHelpMatchField.Heading;
  }
  if (inTitle) {
    return DocsHelpMatchField.Title;
  }
  if (inBody) {
    return DocsHelpMatchField.Body;
  }
  // Nothing but the nav group said it — reported as a Group hit rather than
  // mislabelled as a body match the page text does not contain.
  return DocsHelpMatchField.Group;
}

function scoreOf(
  inHeading: boolean,
  inTitle: boolean,
  inBody: boolean
): number {
  if (inHeading) {
    return HEADING_SCORE;
  }
  if (inTitle) {
    return TITLE_SCORE;
  }
  if (inBody) {
    return BODY_SCORE;
  }
  return GROUP_SCORE;
}
