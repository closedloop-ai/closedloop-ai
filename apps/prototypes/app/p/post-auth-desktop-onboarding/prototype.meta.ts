import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "post-auth-desktop-onboarding",
  title: "Post-Auth Desktop Onboarding",
  summary:
    "Picks up after the web auth handoff: the returning user is acknowledged as authenticated silently in the background, so the app opens straight on a blocking Data & Sync takeover (Full transcripts pre-selected), saves, then lands on Sessions with an invite-your-team pop-up. Whether GitHub CTAs persist is resolved in the background from how they signed in.",
  author: "kaiticarp",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-08-05",
  linearIssue: null,
  closedloopDoc: "ISS-5249",
} satisfies PrototypeMeta;
