import {
  DocsHelpMatchField,
  type DocsHelpSearchHit,
} from "@repo/app/help/lib/docs-help-payload";
import { DOCS_PAGES } from "./mock";

// Byte-for-byte the bundle generator's own `slugify`
// (`apps/desktop/scripts/generate-docs-bundle-manifest-lib.mjs`), which
// `apps/desktop/src/renderer/components/help/help-slug.ts` also mirrors and
// `apps/desktop/test/docs-slug-parity.test.ts` holds to it.
const SLUG_STRIP_RE = /[^a-z0-9\s-]/g;
const SLUG_SPACE_RE = /\s+/g;
const EXCERPT_CHARS = 140;

/**
 * Production binds this to the web docs generator, the way desktop binds its own
 * to the bundle generator — `slugifyHeading` is a required PROP precisely so
 * each host supplies the algorithm ITS corpus was stamped with.
 *
 * It must therefore agree with the algorithm that produced a hit's
 * `headingSlug`, character for character (whitlockk review). Punctuation is DROPPED,
 * not turned into a separator: the generator gives "Closedloop.ai" the id
 * `closedloopai`, so a `[^a-z0-9]+ -> "-"` spelling emits `closedloop-ai`, misses
 * the rendered id, and `HelpReader` clears the pending anchor with nothing said.
 * Copied rather than imported because the sandbox boundary reaches neither
 * `apps/desktop` nor the generator `.mjs`, and `packages/app` deliberately owns
 * no copy of it.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(SLUG_STRIP_RE, "")
    .trim()
    .replace(SLUG_SPACE_RE, "-");
}

/** The web-shaped docs search this sandbox host stands in for. */
export function searchDocs(query: string): readonly DocsHelpSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [];
  }
  const hits: DocsHelpSearchHit[] = [];
  for (const entry of DOCS_PAGES) {
    // Headings first: a heading hit is the only one that carries an anchor, and
    // the anchor is what makes "deep link to a section" a capability rather than
    // a claim. Without it `pendingHeadingSlug` could never be anything but null.
    const heading = entry.headings.find((item) =>
      item.text.toLowerCase().includes(needle)
    );
    if (heading !== undefined) {
      hits.push({
        excerpt: entry.body.slice(0, EXCERPT_CHARS),
        group: entry.group,
        headingSlug: heading.slug,
        matchField: DocsHelpMatchField.Heading,
        path: entry.path,
        score: 3,
        title: entry.title,
      });
      continue;
    }
    const inTitle = entry.title.toLowerCase().includes(needle);
    const bodyIndex = entry.body.toLowerCase().indexOf(needle);
    if (!(inTitle || bodyIndex >= 0)) {
      continue;
    }
    hits.push({
      excerpt: inTitle
        ? entry.body.slice(0, EXCERPT_CHARS)
        : entry.body.slice(bodyIndex, bodyIndex + EXCERPT_CHARS),
      group: entry.group,
      matchField: inTitle ? DocsHelpMatchField.Title : DocsHelpMatchField.Body,
      path: entry.path,
      score: inTitle ? 2 : 1,
      title: entry.title,
    });
  }
  return hits.sort((left, right) => right.score - left.score);
}
