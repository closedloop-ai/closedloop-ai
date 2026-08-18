import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "sessions",
  title: "Sessions",
  summary:
    "Sessions list and production-scale detail views for four representative durations. Demonstrates range-aware metrics, a configurable 24-bucket cost timeline, synchronized trace navigation and scrubber, anchored comments, collapsible properties, and a collapsible comments rail.",
  author: "Parker",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-24",
  linearIssue: null,
  closedloopDoc: "PRD-575",
} satisfies PrototypeMeta;
