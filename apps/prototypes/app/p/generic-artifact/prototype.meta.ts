import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "generic-artifact",
  title: "Generic Artifact",
  summary:
    "A visual reference for the shared list and detail shells across documents, issues, sessions, branches, and future artifact types.",
  author: "Andrew",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Master, PrototypeTag.Feature],
  createdAt: "2026-07-30",
  linearIssue: null,
  closedloopDoc: "PRD-595",
} satisfies PrototypeMeta;
