import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "desktop-onboarding",
  title: "Desktop Onboarding",
  summary:
    "First-launch desktop onboarding: opens to a local-first dashboard, runs a guided tour, then drives GitHub-first account creation, with the team-comparison gate and Full/Partial/Local sync-consent screen.",
  author: "Mike Angstadt",
  status: PrototypeStatus.HandedOff,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-16",
  linearIssue: null,
  closedloopDoc: null,
} satisfies PrototypeMeta;
