/**
 * Builds the Help view's left nav tree from the M1 docs bundle (FEA-3844 /
 * PRD-555 M2). Pure — no Electron, no filesystem — so it is unit-testable and
 * safe to run at service-construction time.
 *
 * The bundle is a flat, already `meta.json`-ordered page list (see
 * `scripts/generate-docs-bundle-manifest.mjs`), each page carrying its
 * `meta.json` navigation `group`. That flat order IS the nav order, so grouping
 * the pages by `group` in encounter order reconstructs the `meta.json`
 * `{ group, pages }` tree without a second bundle scan. Pages the bundle carries
 * but `meta.json` never references (no `group`) fall into a single trailing
 * {@link UNGROUPED_NAV_LABEL} bucket so every bundled page stays reachable.
 */
import type {
  DocsHelpNavGroup,
  DocsHelpNavPage,
} from "../../shared/docs-help-contract.js";

/** Label for pages the bundle carries but `meta.json` never references. */
export const UNGROUPED_NAV_LABEL = "More";

/**
 * Group an already-nav-ordered page list into `{ group, pages }` sections,
 * preserving both the group encounter order and the page order within each
 * group (both are the `meta.json` order the bundle was built in). Ungrouped
 * pages are collected into a single trailing {@link UNGROUPED_NAV_LABEL} bucket.
 */
export function buildDocsNavTree(
  pages: readonly DocsHelpNavPage[]
): DocsHelpNavGroup[] {
  const groupsInOrder: string[] = [];
  const pagesByGroup = new Map<string, DocsHelpNavPage[]>();

  for (const page of pages) {
    const group =
      page.group && page.group.length > 0 ? page.group : UNGROUPED_NAV_LABEL;
    let bucket = pagesByGroup.get(group);
    if (!bucket) {
      bucket = [];
      pagesByGroup.set(group, bucket);
      groupsInOrder.push(group);
    }
    bucket.push(page);
  }

  // Keep the ungrouped "More" bucket last regardless of when its first page was
  // encountered, so the real nav groups always lead.
  const orderedGroups = groupsInOrder.filter(
    (group) => group !== UNGROUPED_NAV_LABEL
  );
  if (pagesByGroup.has(UNGROUPED_NAV_LABEL)) {
    orderedGroups.push(UNGROUPED_NAV_LABEL);
  }

  return orderedGroups.map((group) => {
    const bucket = pagesByGroup.get(group);
    return { group, pages: bucket ?? [] };
  });
}
