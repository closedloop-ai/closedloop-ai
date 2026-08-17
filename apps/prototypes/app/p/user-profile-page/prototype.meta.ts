import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "user-profile-page",
  title: "User Profile Page",
  summary:
    "Celebratory personal-metrics profile page for a user. Two views: the in-app profile page (range-scoped headline power numbers, rank vs org and global, current streak, lifetime milestones, a token-breakdown donut, and a year-long contribution graph) and a public, shareable /p/<uuid> card — private by default, with an enable → live → revoke share flow, an embed snippet, and an OG-preview treatment.",
  author: "Mike Angstadt",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-24",
  linearIssue: "FEA-3966",
  closedloopDoc: null,
} satisfies PrototypeMeta;
