import { type PrototypeMeta, PrototypeStatus } from "@/lib/registry";

export const meta = {
  slug: "pre-auth-desktop-onboarding",
  title: "Pre-Auth Desktop Onboarding",
  summary:
    "Pre-auth desktop onboarding flow end to end: the agent-session analysis hero opens a guided dashboard tour that lands on an account-creation CTA, with a returning-user path into sign-in. Owns the desktop onboarding flow and supersedes the earlier desktop-onboarding-landing (HandedOff); the standalone signed-out auth screen stays owned by the sign-in prototype, which this flow's in-context AuthPanel mirrors rather than re-specifies.",
  author: "kaiticarp",
  status: PrototypeStatus.HandedOff,
  tags: [],
  createdAt: "2026-08-04",
  linearIssue: null,
  closedloopDoc: "ISS-5112",
} satisfies PrototypeMeta;
