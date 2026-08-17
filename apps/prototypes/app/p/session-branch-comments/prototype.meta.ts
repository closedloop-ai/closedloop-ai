import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "session-branch-comments",
  title: "Session & Branch Comments",
  summary:
    "The branch detail Sessions & timeline tab with a hover-revealed Add comment affordance in the top-right corner of every message (a persistent count marker when a message already has notes). Clicking it opens a create-comment popover that mirrors the production trace composer, and submitted notes land in the session comments rail with jump-back to the source message.",
  author: "Parker",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-28",
  linearIssue: null,
  closedloopDoc: null,
} satisfies PrototypeMeta;
