import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "prototypes",
  title: "Prototypes as artifacts",
  summary:
    "A first-class Prototypes artifact list and detail workspace with versioned hosted previews, provenance, collaborator presence, and DOM-anchored review comments.",
  author: "Parker",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-28",
  linearIssue: null,
  closedloopDoc: "PRD-568",
} satisfies PrototypeMeta;
