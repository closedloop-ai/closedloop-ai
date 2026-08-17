import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "phase-breakdown",
  title: "Cost breakdown: expandable phases",
  summary:
    "The branch Cost breakdown with expandable phase rows (Build / Review / Rework plus an Unattributed residual): each row shows a total and elapsed time, a session count, and a caret that reveals the phase's sessions. Session names open an in-prototype stand-in for the session detail page; in the product the title links straight to the real page.",
  author: "kaiticarp",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-31",
  linearIssue: null,
  closedloopDoc: null,
} satisfies PrototypeMeta;
