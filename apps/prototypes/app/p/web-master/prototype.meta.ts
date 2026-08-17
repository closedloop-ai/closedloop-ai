import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "web-master",
  title: "Web Master",
  summary:
    "Demo master that combines the blessed web prototypes behind one persistent shell. The sidebar's Sessions and Branches items are real links that switch between the handed-off Sessions and Branches surfaces as subpages.",
  author: "Parker",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Master],
  createdAt: "2026-07-29",
  linearIssue: null,
  closedloopDoc: null,
} satisfies PrototypeMeta;
