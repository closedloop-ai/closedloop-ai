import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "lost-work",
  title: "Lost-work analytics",
  summary:
    "Wall-clock lost to sessions that yielded no artifact, sliced by person, repo, project, and cause. Systemic loss (usage limit, provider rate limit, API error) is held in its own column group beside the coachable number and never summed into it, with an explicit unattributed bucket for runs whose outcome was never recorded. Every rate shows its denominator. Use the Preview data state control in the header to see the skeleton, settled-unavailable, and real-zero treatments side by side.",
  author: "Parker",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-08-03",
  linearIssue: null,
  closedloopDoc: "ISS-4935",
} satisfies PrototypeMeta;
