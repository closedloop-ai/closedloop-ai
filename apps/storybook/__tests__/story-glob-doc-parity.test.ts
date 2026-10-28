/**
 * ISS-9670 — keeps the PROSE description of Storybook's scan globs tied to the
 * `stories` array that actually drives indexing.
 *
 * A story placed outside those globs is silently never collected: Storybook
 * indexes nothing, the Vitest sweep runs nothing, and no red anywhere says the
 * story exists. The only thing standing between an author and that failure is
 * the documented list — so when `main.ts` gained its fifth glob (the
 * versioned-slice case, `packages/app/*<!-- -->/*<!-- -->/components/**`), five
 * separate files went on saying "four" and `agents-md-rule-inventory.json`
 * PINNED the wrong sentence, which meant the rule-inventory gate (since removed
 * by ISS-11612) actively held the error in place. Nothing asserted the real
 * list.
 *
 * Direction matters: the expectation is derived from `main.ts` and asserted
 * against the docs, never the reverse. A guard that read its expected count out
 * of the inventory JSON it polices would agree with whatever that file said.
 *
 * `main.ts` is read through the shared AST reader rather than regex-scanned —
 * it calls `fileURLToPath(import.meta.url)` and throws under Vitest's transform,
 * and `scripts/lint/rules/no-raw-text-source-scan.ts` bans text-scanning
 * implementation source. The DOCS are Markdown, which that rule does not cover
 * and for which no AST is meaningful; prose is exactly what is under test here.
 *
 * Sibling guard: `story-glob-parity.test.ts` asks whether the Vitest sweep globs
 * everything Storybook indexes. This one asks whether the docs describe it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  STORYBOOK_DIR,
  storybookStoryPatterns,
} from "./helpers/storybook-config-source";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const ROOT_AGENTS_MD = path.join(REPO_ROOT, "AGENTS.md");
const STORYBOOK_AGENTS_MD = path.join(REPO_ROOT, "apps/storybook/AGENTS.md");
const APP_AGENTS_MD = path.join(REPO_ROOT, "apps/app/AGENTS.md");
const STORYBOOK_TAILWIND_CSS = path.join(
  REPO_ROOT,
  "packages/design-system/styles/storybook.css"
);
const REVIEW_SOUL = path.join(REPO_ROOT, ".claude/review/soul.md");

/**
 * Every file that states HOW MANY globs Storybook scans. Each must agree with
 * `main.ts`.
 *
 * The last two are here because the count is NOT confined to `AGENTS.md`
 * files, which is what made this drift so durable: `storybook.css` explains its
 * `@source` by counting the globs, and `.claude/review/soul.md` rests an
 * argument on the set being fixed and finite. Each was found only after the
 * previous pass called the list complete — so when a new file states the
 * count, add it here.
 */
const COUNT_STATING_DOCS = [
  ROOT_AGENTS_MD,
  STORYBOOK_AGENTS_MD,
  APP_AGENTS_MD,
  STORYBOOK_TAILWIND_CSS,
  REVIEW_SOUL,
];

describe("storybook glob documentation parity with .storybook/main.ts", () => {
  it("states the real glob count everywhere it is claimed", () => {
    const actual = storybookStoryPatterns().length;
    const expectedWord = numberWord(actual);

    for (const docPath of COUNT_STATING_DOCS) {
      const text = readFileSync(docPath, "utf8");
      const relative = path.relative(REPO_ROOT, docPath);

      expect(
        countPhrasings(expectedWord).some((phrase) => text.includes(phrase)),
        `${relative} does not state "${expectedWord}" globs — \`.storybook/main.ts\` scans ${actual}, and a story outside those globs is silently never collected`
      ).toBe(true);

      for (const wrongWord of NUMBER_WORDS) {
        if (wrongWord === expectedWord) {
          continue;
        }
        const stale = countPhrasings(wrongWord).find((phrase) =>
          text.includes(phrase)
        );
        expect(
          stale,
          `${relative} claims "${stale}" but \`.storybook/main.ts\` scans ${actual}`
        ).toBeUndefined();
      }
    }
  });

  it("enumerates every scanned glob in apps/storybook/AGENTS.md", () => {
    const text = readFileSync(STORYBOOK_AGENTS_MD, "utf8");

    for (const pattern of repoRelativeStoryPatterns()) {
      expect(
        text.includes(`\`${pattern}\``),
        `apps/storybook/AGENTS.md does not list \`${pattern}\`, which \`.storybook/main.ts\` scans — an author reading the documented list would not know a story there is collected`
      ).toBe(true);
    }
  });

  it("documents no glob that main.ts does not scan", () => {
    const text = readFileSync(STORYBOOK_AGENTS_MD, "utf8");
    const scanned = new Set(repoRelativeStoryPatterns());

    // The inverse of the assertion above: a glob deleted from `main.ts` but left
    // in the prose sends authors to a directory nothing indexes, which fails the
    // same way round the other side.
    for (const listed of listedStoryPatterns(text)) {
      expect(
        scanned.has(listed),
        `apps/storybook/AGENTS.md lists \`${listed}\` as a scan glob, but \`.storybook/main.ts\` does not scan it — a story placed there would never be collected`
      ).toBe(true);
    }
  });

  it("reads a non-empty pattern list out of both sides", () => {
    // Guards the guard: if either reader returned nothing, the assertions above
    // would pass vacuously over an empty list. BOTH sides need this, and the
    // doc side needs it more — `storybookStoryPatterns()` reads an AST, whereas
    // `listedStoryPatterns()` is a prose heuristic that a reformat of
    // apps/storybook/AGENTS.md (a table, a bullet list, a changed suffix) could
    // silently reduce to zero matches, disabling the enumeration checks while
    // they still reported green.
    expect(storybookStoryPatterns().length).toBeGreaterThan(0);
    expect(
      listedStoryPatterns(readFileSync(STORYBOOK_AGENTS_MD, "utf8")).length
    ).toBeGreaterThan(0);
  });
});

/** The `stories` array resolved to repo-relative POSIX patterns. */
function repoRelativeStoryPatterns(): string[] {
  return storybookStoryPatterns().map((pattern) =>
    path
      .relative(REPO_ROOT, path.resolve(STORYBOOK_DIR, pattern))
      .split(path.sep)
      .join("/")
  );
}

/**
 * Backtick-quoted spans in the prose that look like a story glob — the ones the
 * document is offering as the scan list. Anything without a `*.stories.` or
 * `*.mdx` tail is ordinary prose (a bare directory, a package name) and is not
 * a claim about what is scanned.
 */
function listedStoryPatterns(text: string): string[] {
  const listed: string[] = [];
  const spans = text.split("`");
  // Odd indices are the insides of backtick pairs.
  for (let index = 1; index < spans.length; index += 2) {
    const span = spans[index];
    if (span?.includes("/*.stories.") || span?.endsWith("/*.mdx")) {
      listed.push(span);
    }
  }
  return listed;
}

/**
 * The ways this repo actually writes the count. Two, because the drift hid in
 * the second: a sweep for `"four globs"` does not see `"four Storybook globs"`,
 * which is how `.claude/review/soul.md` kept the stale number through a pass
 * that reported the repo clean. A file satisfies the check by carrying any of
 * these for the real count, and fails it for carrying any for a wrong one.
 */
function countPhrasings(word: string): string[] {
  return [`${word} globs`, `${word} Storybook globs`];
}

/** English name of a small count, for matching the prose. */
function numberWord(count: number): string {
  const word = NUMBER_WORDS[count];
  if (!word) {
    throw new Error(
      `no number word for ${count} globs — extend NUMBER_WORDS alongside the docs`
    );
  }
  return word;
}

/** Indexed by value, so `NUMBER_WORDS[5] === "five"`. */
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
