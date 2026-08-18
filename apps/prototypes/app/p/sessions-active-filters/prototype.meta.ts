import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "sessions-active-filters",
  title: "Sessions active-filter chips",
  summary:
    "The Sessions list toolbar gains an active-filter chip row: one removable chip per active facet selection (status / owner / repo / harness / model / autonomy / cost / changes / pr) plus a clear-all, shown above a stand-in session table whose Cost column carries the honest missing-cost '—'. With a Cost = Unknown facet active, the chip row NAMES what is filtering the list so the column of dashes reads as a filtered cohort, not a broken column. Follow-up from the Documents ActiveFiltersBar precedent (ISS-4481). Empty-state note: like the production bar, the chip row renders nothing when no facet is active. Design divergence (deliberate this pass): the chips are remove-only — no click-to-edit dropdown body and no in-row '+' add-filter control (adding is the Filter popover's job); reconciling with Documents' catalog ActiveFiltersBar is out of scope. The 'Sandbox controls' row is reviewer chrome to flip the mock cohort, not part of the surface.",
  author: "Mike",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-31",
  linearIssue: null,
  closedloopDoc: "ISS-4605",
} satisfies PrototypeMeta;
