/**
 * The DESKTOP boundary of `SearchSurfaceV2` (ISS-9414): local docs hits into the
 * shared result model. Its own module so the both-host contract, whose fixture
 * IS a `SearchSurfaceResult[]`, can stand in for this seam.
 */

import { DOCS_MATCH_FIELD_LABEL } from "@repo/app/help/lib/docs-help-labels";
import type { SearchSurfaceResult } from "@repo/app/search/lib/search-surface-model";
import { BookOpenIcon } from "lucide-react";
import type { DocsHelpSearchHit } from "../../../shared/docs-help-contract";
import { helpPageHref } from "../../navigation/route-table";

/**
 * `kindLabel` carries the matched-field facet the palette rendered as a badge,
 * so mastering the row body does not cost the reader the Title/Heading/Body
 * distinction. A page can match twice under different anchors, so the key
 * carries the heading slug. The local index holds no updated-at, so no `meta`.
 */
export function docsHitsToSurfaceResults(
  hits: readonly DocsHelpSearchHit[]
): SearchSurfaceResult[] {
  return hits.map((hit) => ({
    key: `${hit.path}#${hit.headingSlug ?? ""}`,
    kindLabel: DOCS_MATCH_FIELD_LABEL[hit.matchField],
    title: hit.title,
    snippet: hit.excerpt ?? "",
    destination: helpPageHref(hit.path, hit.headingSlug),
    icon: BookOpenIcon,
  }));
}
