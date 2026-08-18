import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "desktop-onboarding-landing",
  title: "Desktop Onboarding Landing",
  summary:
    "Full first-run desktop flow: a marketing landing (know what good looks like), then Get started opens the dashboard as it parses local sessions, a guided tour that ends in an account CTA, and Sign-Up overlays gating Organization scope and Invite-your-team, across Dashboard, Sessions, and Branches.",
  author: "Kaiti Carpenter",
  status: PrototypeStatus.HandedOff,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-28",
  linearIssue: null,
  closedloopDoc: null,
} satisfies PrototypeMeta;
