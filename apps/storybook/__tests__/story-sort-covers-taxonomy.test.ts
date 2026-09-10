/**
 * The sidebar order has to keep up with the story corpus.
 *
 * `storySort.order` in `.storybook/preview.tsx` names every level and group in
 * the reading order the taxonomy intends (see `TAXONOMY.md`). Storybook does
 * not complain about a group missing from that list: it sorts the unlisted ones
 * alphabetically AFTER the listed ones. So a net-new
 * `Composites/<NewDomain>/...` story lands somewhere arbitrary in the nav and
 * nothing says so.
 *
 * There is a second reason this file exists. The nine element kinds are written
 * out TWICE in `preview.tsx`, once under Primitives and once under Composites.
 * They cannot be hoisted into a shared `const`, because Storybook's indexer
 * reads `storySort.order` statically and fails the build with "Unexpected
 * 'ELEMENT_KINDS'. Parameter 'options.storySort'". Two hand-maintained copies
 * of one list drift, so this pins them together.
 *
 * The order array is read from the AST rather than text-scanned, which is the
 * form this repo sanctions for asserting on TypeScript source.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { metaTitleRegex } from "../scripts/sync-component-catalog.mjs";
import {
  type StorySortOrder,
  storybookStorySortOrder,
} from "./helpers/storybook-config-source";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

/**
 * The three roots `.storybook/main.ts` globs. Listed rather than derived,
 * because turning its globs into file lists needs a glob engine for no benefit
 * here; `story-glob-parity.test.ts` is what keeps this list honest against
 * `main.ts`.
 */
const STORY_ROOTS = [
  join(REPO_ROOT, "apps/storybook/stories"),
  join(REPO_ROOT, "packages/app"),
  join(REPO_ROOT, "apps/desktop/src/renderer/components"),
];

function walkStories(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") {
        continue;
      }
      found.push(...walkStories(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".stories.tsx")) {
      found.push(full);
    }
  }
  return found;
}

/** The element kinds, in the reading order the taxonomy fixes. */
const ELEMENT_KINDS = [
  "Actions",
  "Inputs",
  "Data Display",
  "Charts",
  "Content",
  "Layout",
  "Navigation",
  "Overlays",
  "Feedback & Status",
] as const;

const LEVELS = ["Foundations", "Primitives", "Composites", "Surfaces"] as const;

/** Levels whose titles are flat, so their second segment is a name not a group. */
const FLAT_LEVELS = new Set<string>(["Foundations", "Surfaces", "Catalog"]);

function flatten(order: StorySortOrder): string[] {
  return order.flatMap((entry) =>
    typeof entry === "string" ? [entry] : flatten(entry)
  );
}

/** The list that directly follows `parent`, which is how Storybook nests. */
function groupsUnder(order: StorySortOrder, parent: string): string[] {
  const index = order.indexOf(parent);
  const next = index === -1 ? undefined : order[index + 1];
  if (!(next && typeof next !== "string")) {
    return [];
  }
  return next.filter((entry): entry is string => typeof entry === "string");
}

function everyStoryTitle(): { title: string; file: string }[] {
  const titles: { title: string; file: string }[] = [];
  for (const file of STORY_ROOTS.flatMap(walkStories)) {
    const match = readFileSync(file, "utf8").match(metaTitleRegex);
    if (match) {
      titles.push({ title: match[1], file });
    }
  }
  return titles;
}

describe("storySort covers the taxonomy", () => {
  const order = storybookStorySortOrder();
  const listed = new Set(flatten(order));
  const titles = everyStoryTitle();

  it("reads a non-trivial order array and a story corpus", () => {
    expect(listed.size).toBeGreaterThan(20);
    expect(titles.length).toBeGreaterThan(300);
  });

  it("lists the four levels", () => {
    for (const level of LEVELS) {
      expect(
        listed.has(level),
        `${level} is missing from storySort.order`
      ).toBe(true);
    }
  });

  it("gives Primitives the element kinds, in order", () => {
    expect(groupsUnder(order, "Primitives")).toEqual([...ELEMENT_KINDS]);
  });

  it("opens Composites with the same element kinds, in the same order", () => {
    const composites = groupsUnder(order, "Composites");
    expect(
      composites.slice(0, ELEMENT_KINDS.length),
      "The two copies of the element-kind list have drifted. They are written out twice because Storybook's indexer cannot read a shared const."
    ).toEqual([...ELEMENT_KINDS]);
  });

  it("lists every group a story actually uses", () => {
    const used = new Map<string, string>();
    for (const { title } of titles) {
      const segments = title.split("/");
      if (FLAT_LEVELS.has(segments[0]) || segments.length < 3) {
        continue;
      }
      used.set(segments[1], title);
    }

    const missing = [...used]
      .filter(([group]) => !listed.has(group))
      .map(([group, example]) => `${group} (e.g. "${example}")`);

    expect(
      missing,
      "A group with no entry in storySort.order sorts alphabetically after every listed one, so it lands somewhere arbitrary in the sidebar. Add it to preview.tsx and to TAXONOMY.md."
    ).toEqual([]);
  });

  it("does not list a group no story uses", () => {
    const segmentsInUse = new Set<string>();
    for (const { title } of titles) {
      for (const segment of title.split("/")) {
        segmentsInUse.add(segment);
      }
    }

    const stale = [...listed].filter(
      (name) =>
        !(
          LEVELS.includes(name as (typeof LEVELS)[number]) ||
          name === "Catalog" ||
          segmentsInUse.has(name)
        )
    );

    expect(
      stale,
      "storySort.order names something nothing is titled under. It is either a typo or a leftover from a rename."
    ).toEqual([]);
  });
});
