import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

/**
 * ISS-12880: this route is the production-bound Sessions list/detail preview.
 * Its component and fixture ownership lives in `@repo/app`; the route carries
 * no local surface implementation.
 */
export const meta = {
  slug: "sessions",
  title: "Sessions",
  summary:
    "The canonical Sessions list and detail surfaces with selection, favorites, typed fields, responsive layouts, pagination, and trace navigation.",
  author: "Pascoe",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-24",
  linearIssue: null,
  closedloopDoc: "PRD-575",
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
