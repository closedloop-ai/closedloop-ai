import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "web-onboarding-flow",
  title: "Web Onboarding Flow",
  summary:
    "The full new-visitor web onboarding: a landing page that explains Closedloop, into the GitHub-first auth page, a social-login handoff placeholder, then the production create-team and create-project steps, landing on the My Tasks page with the Complete Your Setup checklist and an invite-team spotlight anchored to the checklist.",
  author: "kaiticarp",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-08-06",
  linearIssue: null,
  closedloopDoc: "ISS-5490",
} satisfies PrototypeMeta;
