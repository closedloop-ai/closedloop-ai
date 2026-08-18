/**
 * Shared display labels for the in-app Docs & Help surfaces (PRD-555).
 *
 * The canonical human label for a search hit's `matchField` facet. Kept in one
 * lightweight module (no React, no heavy imports) so every surface that shows a
 * docs hit — the M2 Help view's search results and the M3 command-palette Docs
 * group — reads the same label instead of re-declaring the map and drifting.
 */
import type { DocsHelpMatchField } from "../../../shared/docs-help-contract";

/** Human label for the field a docs search hit matched on. */
export const DOCS_MATCH_FIELD_LABEL: Record<DocsHelpMatchField, string> = {
  title: "Title",
  heading: "Section",
  body: "Body",
  group: "Group",
};
