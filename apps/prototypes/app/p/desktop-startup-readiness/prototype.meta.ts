import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "desktop-startup-readiness",
  title: "Desktop Startup Readiness",
  summary:
    "A truthful, non-blocking startup sequence that renders the Sessions shell immediately, makes saved sessions available first, and narrates local freshness work without implying a false overall percentage.",
  author: "Codex",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.BugFix, PrototypeTag.Feature],
  createdAt: "2026-08-03",
  linearIssue: null,
  closedloopDoc: "ISS-4715",
} satisfies PrototypeMeta;
