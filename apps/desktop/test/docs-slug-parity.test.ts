/**
 * ISS-5303 — the docs heading slug has two implementations and must not.
 *
 * `slugify` in `scripts/generate-docs-bundle-manifest-lib.mjs` runs at PREBUILD
 * time and its output is PERSISTED into the docs bundle as each heading's
 * `headingSlug`. `slugifyHeading` in
 * `src/renderer/components/help/help-slug.ts` recomputes the same slug at READ
 * time and stamps it as the rendered heading's `id`. Search-jump-to-heading only
 * lands because those two agree.
 *
 * They are byte-identical today, each with its own `SLUG_STRIP_RE` /
 * `SLUG_SPACE_RE`, bound only by cross-reference comments. Edit one and the jump
 * silently lands nowhere with nothing red — no exception, no empty state, just a
 * reader that does not scroll.
 *
 * A single shared module was the stronger fix and was DEFERRED deliberately: the
 * generator runs under plain `node` during prebuild while the renderer is
 * bundled by Vite, so one importable source has a real build cost. This corpus
 * is the agreed fallback — it does not prevent the drift, it makes the drift
 * fail here instead of in the Help reader.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { slugify } from "../scripts/generate-docs-bundle-manifest-lib.mjs";
import { slugifyHeading } from "../src/renderer/components/help/help-slug.js";

const DIVERGENCE_REMEDY = [
  "`slugify` (scripts/generate-docs-bundle-manifest-lib.mjs) and `slugifyHeading`",
  "(src/renderer/components/help/help-slug.ts) are two copies of ONE contract and",
  "must be changed together. The generator persists this slug into the docs bundle",
  "at prebuild time; the Help reader recomputes it at read time and stamps it as the",
  "heading's DOM id. A divergence makes search-jump-to-heading land nowhere, with",
  "nothing else red.",
].join("\n");

/**
 * Inputs chosen for the transformation's four stages — lowercase, strip, trim,
 * hyphenate — plus the shapes real docs headings actually take.
 */
const SLUG_CORPUS: readonly string[] = [
  // Empty and whitespace-only.
  "",
  " ",
  "   \t  ",
  "\n",
  // Plain and mixed case.
  "overview",
  "Overview",
  "OVERVIEW",
  "Getting Started",
  "gEtTiNg StArTeD",
  // Leading, trailing and collapsed whitespace. The strip runs BEFORE the trim,
  // so punctuation at the edges becomes whitespace that the trim then removes —
  // the ordering is the subtle part and both copies must keep it.
  "  Leading spaces",
  "Trailing spaces   ",
  "  Both  ",
  "Collapsed     inner     whitespace",
  "Tab\tseparated",
  "Newline\nseparated",
  "Mixed \t\n whitespace \t run",
  // Punctuation, including edge punctuation that the trim has to absorb.
  "What's new?",
  "Why does this matter!",
  "(Parenthesised)",
  "Colon: and semicolon; here",
  "Quoted \"heading\" and 'single'",
  "Dots.and.periods.",
  "...leading dots",
  "trailing dots...",
  "slash/separated",
  "back\\slash",
  "under_scored",
  "plus+signs",
  "percent%signs",
  "at@signs",
  "hash#marks",
  // Ampersands, called out because docs headings use them constantly.
  "Sessions & Branches",
  "Q&A",
  "&",
  "& leading ampersand",
  "trailing ampersand &",
  "A&B&C",
  // Existing hyphens, which survive the strip and must not be collapsed.
  "already-hyphenated",
  "double--hyphen",
  "-leading-hyphen",
  "trailing-hyphen-",
  "- ",
  "spaced - hyphen",
  // Numbers and version-ish text.
  "1. Install",
  "Step 2",
  "v1.2.3",
  "2026 roadmap",
  "100%",
  // Unicode: dropped rather than transliterated, by both.
  "Café",
  "naïve",
  "日本語",
  "Ünicode Heading",
  "emoji 🚀 heading",
  "en–dash",
  "em—dash",
  "curly ‘quotes’ and “doubles”",
  "ﬁ ligature",
  " non-breaking space",
  "zero​width",
  // Text that survives none of the strip, so both must produce "".
  "###",
  "!!!",
  "🚀",
  "。",
  // Markdown-derived heading text, as `extractHeadings` hands it over after
  // `toPlainText` has flattened the inline markup.
  "Configure the gateway",
  "The `--user-data` flag",
  "Using apps/desktop/scripts",
  "FAQ: why is my session Unknown?",
  "Troubleshooting — no sessions appear",
  "Set up `CSC_LINK` & `APPLE_ID`",
  "Known issues (2026)",
  "API reference: /v1/sessions",
];

describe("ISS-5303: the docs heading slug has one meaning, two implementations", () => {
  for (const input of SLUG_CORPUS) {
    test(`agrees on ${JSON.stringify(input)}`, () => {
      const generated = slugify(input);
      const rendered = slugifyHeading(input);

      assert.equal(
        generated,
        rendered,
        `${JSON.stringify(input)}: slugify -> ${JSON.stringify(generated)}, slugifyHeading -> ${JSON.stringify(rendered)}\n\n${DIVERGENCE_REMEDY}`
      );
    });
  }

  test("the corpus reaches both a non-empty slug and an empty one", () => {
    // Guards the parity sweep from passing vacuously: two implementations that
    // both returned "" for everything would agree on every case above.
    const slugs = SLUG_CORPUS.map((input) => slugify(input));

    assert.ok(
      slugs.some((slug) => slug.length > 0),
      "no corpus entry produces a non-empty slug"
    );
    assert.ok(
      slugs.some((slug) => slug.length === 0),
      "no corpus entry produces an empty slug"
    );
    assert.ok(
      slugs.some((slug) => slug.includes("-")),
      "no corpus entry produces a hyphenated slug"
    );
  });

  test("both produce the shape the Help reader's anchors depend on", () => {
    // Pinned literals, so the parity sweep cannot be satisfied by two copies
    // that drifted the SAME way. These are the slugs the docs bundle carries.
    assert.equal(slugify("Sessions & Branches"), "sessions-branches");
    assert.equal(slugifyHeading("Sessions & Branches"), "sessions-branches");
    assert.equal(slugify("  What's new?  "), "whats-new");
    assert.equal(slugifyHeading("  What's new?  "), "whats-new");
    assert.equal(slugify("already-hyphenated"), "already-hyphenated");
    assert.equal(slugifyHeading("already-hyphenated"), "already-hyphenated");
    assert.equal(slugify("Café"), "caf");
    assert.equal(slugifyHeading("Café"), "caf");
  });
});
