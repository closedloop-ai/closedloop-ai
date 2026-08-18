import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "search-results",
  title: "Search Results",
  summary:
    "Redesign of the /search results page (FEA-4031, PLN-1495). A first-class editable JQL-look query bar with filter tokens, operators, and a suggestion popover; a mouse-first Type control that writes type: tokens into the bar (retiring the old kind-pill strip); and a scannable results surface with rows per entity type. All six states: empty on-ramp, loading skeletons, load error + retry, invalid-token filter error on the bar, no-results, and too-many with load-more. Presentational, mock data only.",
  author: "Metal Parker",
  status: PrototypeStatus.Draft,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-25",
  linearIssue: null,
  closedloopDoc: "FEA-4031",
} satisfies PrototypeMeta;
