import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "packs",
  title: "Packs Page",
  summary:
    "Top-level Packs discovery page: a card grid of team packs with filters and sort, a team activity rail, and a full-screen pack detail view.",
  author: "Parker",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-13",
  linearIssue: null,
  closedloopDoc: null,
} satisfies PrototypeMeta;
