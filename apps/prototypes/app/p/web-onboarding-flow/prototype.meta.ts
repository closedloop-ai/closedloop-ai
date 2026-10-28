import {
  PrototypeDeliveryMode,
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "web-onboarding-flow",
  title: "Web Onboarding Flow",
  summary:
    "Superseded by web-master, which now owns the onboarding flow. Kept as the reference for the signed-out entry path only: a landing page that explains Closedloop, into the GitHub-first auth page and a social-login handoff placeholder. The create-team, create-project, Complete Your Setup checklist, and invite-team spotlight steps it also shows are superseded by web-master's onboarding gate.",
  author: "kaitoc",
  status: PrototypeStatus.HandedOff,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-08-06",
  linearIssue: null,
  closedloopDoc: "ISS-5490",
  deliveryMode: PrototypeDeliveryMode.DisposableSketch,
} satisfies PrototypeMeta;
