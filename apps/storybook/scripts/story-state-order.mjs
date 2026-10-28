// The state order check (ISS-12332). Every entry in the page tree lists
// its stories as: the Default story, then the shared states in
// `storybookSharedStateOrder`, then the states only that page has, then
// variants. The order is declared once in story-group-order.ts and explained
// in TAXONOMY.md ("The page tree").
//
// What can be checked from a name alone: where Default sits, and where the
// shared states sit. A page-specific state ("Not Connected") and a variant
// ("Dark") are both names this check does not know, so it cannot tell them
// apart; it only requires that every shared state comes before either of
// them. Placing page-specific states before variants is the author's job.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadCsf } from "storybook/internal/csf-tools";
import {
  storybookDefaultStoryName,
  storybookSharedStateOrder,
  storybookStateOrderRoots,
  storybookStateSynonyms,
} from "../story-group-order.ts";
import { metaTitleRegex } from "./sync-component-catalog.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

// Entries owned by another lane that has not adopted the order yet. Each one
// names who owns it and why it is skipped. An entry whose stories are already
// in order fails the check ("exemption no longer needed"), so the list cannot
// outlive the work it waits for.
export const stateOrderExemptTitles = new Map([]);

/**
 * The shared state a story name belongs to, as its index in
 * `storybookSharedStateOrder`, or -1. "Loading" and "Loading Dark" both
 * belong to Loading; "Loaded" and "Errors Only" belong to none. An older
 * name in `storybookStateSynonyms` ("Permission") belongs to its state.
 */
export function sharedStateRank(name) {
  const matches = (word) => name === word || name.startsWith(`${word} `);
  const direct = storybookSharedStateOrder.findIndex(matches);
  if (direct >= 0) {
    return direct;
  }
  const synonym = Object.keys(storybookStateSynonyms).find(matches);
  return synonym
    ? storybookSharedStateOrder.indexOf(storybookStateSynonyms[synonym])
    : -1;
}

/**
 * The order an entry's stories should be in: its Default story (or, with no
 * story named Default, its first story, which plays that part), then every
 * shared-state story in the fixed order, then everything else as it was.
 */
export function expectedStateOrder(names) {
  if (names.length === 0) {
    return [];
  }
  // With no story named Default, the first story plays Default and stays
  // first, even when its name is a shared state ("Error" then "Loading").
  const named = names.indexOf(storybookDefaultStoryName);
  const leadIndex = named >= 0 ? named : 0;
  const lead = [names[leadIndex]];
  const rest = names.filter((_, index) => index !== leadIndex);
  const states = rest
    .map((name, index) => ({ name, index, rank: sharedStateRank(name) }))
    .filter((story) => story.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((story) => story.name);
  const others = rest.filter((name) => sharedStateRank(name) < 0);
  return [...lead, ...states, ...others];
}

/** The story names of a CSF file, in the order Storybook lists them. */
export function storyNamesInFile(filePath) {
  const source = readFileSync(filePath, "utf8");
  const csf = loadCsf(source, {
    fileName: filePath,
    makeTitle: (title) => title,
  }).parse();
  return csf.stories.map((story) => story.name);
}

/** The meta title of a story file, or undefined. */
export function storyFileTitle(filePath) {
  return readFileSync(filePath, "utf8").match(metaTitleRegex)?.[1];
}

/**
 * Checks every story file whose title is under a state-order root. Returns
 * the number of entries checked and one message per entry out of order.
 */
export function checkStateOrder(files, exemptTitles = stateOrderExemptTitles) {
  const errors = [];
  let checked = 0;
  for (const filePath of files) {
    const title = storyFileTitle(filePath);
    if (
      !(
        title &&
        storybookStateOrderRoots.some((root) => title.startsWith(`${root}/`))
      )
    ) {
      continue;
    }
    const names = storyNamesInFile(filePath);
    const expected = expectedStateOrder(names);
    const inOrder = expected.join("\n") === names.join("\n");
    if (exemptTitles.has(title)) {
      if (inOrder) {
        errors.push(
          `"${title}" is exempt from the state order (${exemptTitles.get(title)}) but its stories are already in order: exemption no longer needed, delete it from stateOrderExemptTitles (apps/storybook/scripts/story-state-order.mjs).`
        );
      }
      continue;
    }
    checked += 1;
    if (!inOrder) {
      errors.push(
        `Story order in "${title}" (${path.relative(repoRoot, filePath)}) breaks the state order (Default, then ${storybookSharedStateOrder.join(", ")}, then page-specific states, then variants; TAXONOMY.md, "The page tree"). Reorder the story exports to:\n  ${expected.join(" | ")}\nfound:\n  ${names.join(" | ")}`
      );
    }
  }
  return { checked, errors };
}
