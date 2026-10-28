import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "search-results",
  title: "Search Results",
  summary:
    "The redesigned /search results page (FEA-4031, PLN-1495, ISS-9414), migrated to mount the real, prop-driven SearchSurfaceV2 and SearchTypeControl inside the shared PrototypeShell (ISS-10345, PLN-2026). A query bar, a mouse-first Type control that writes type: tokens into it, and a scannable results surface with rows per entity type. A demo-state switcher exercises every SearchSurfaceReadState the real surface renders: empty on-ramp, loading skeletons, load error + retry, invalid-token filter error, no-results, and a too-many count. Mock data only; the results/states/type-control content is the real production component.",
  author: "Metal Pascoe",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-25",
  linearIssue: null,
  closedloopDoc: "FEA-4031",
  // Every prototype is production-bound.
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
