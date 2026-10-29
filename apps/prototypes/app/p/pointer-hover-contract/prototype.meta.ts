import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "pointer-hover-contract",
  title: "Pointer, cursor, and hover-state interaction contract",
  summary:
    "The preserved prototype imports the mastered implementation and passes design review against the approved baseline.",
  author: "Pascoe",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-10-19",
  linearIssue: null,
  closedloopDoc: "ISS-9357",
  deliveryMode: PrototypeDeliveryMode.ProductionBound,
} satisfies PrototypeMeta;
