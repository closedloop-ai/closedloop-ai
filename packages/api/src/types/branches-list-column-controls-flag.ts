/**
 * ISS-9676 (ISS-4779 closed-by-default policy): the single cross-surface flag
 * key gating the Branches list's column-driven Group and Filter controls.
 *
 * OFF (the default) omits Group and admits every facet its builders produce.
 * ON adds Group and admits only facets declared `isFilterable` by the model.
 * Sort follows the measured layout at either flag state: compact cards offer
 * the folded Sort control, while expanded grids sort through their headers.
 *
 * ONE KEY FOR BOTH SURFACES, and no desktop Labs mirror. The Branches list is
 * rendered from one shared component on web and in the Electron renderer, and
 * the ISS-8024 / ISS-8753 cutover made the desktop renderer resolve PostHog keys
 * from the signed-in account's assignment with no local registry — so this key
 * is the whole gate on both hosts, read once in `packages/app`. It fails closed
 * where no provider answers, which is the default this policy asks for.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) beside the sibling Branches keys, so the literal has
 * one definition rather than one per reader.
 */
export const BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY =
  "branches-list-column-controls" as const;
