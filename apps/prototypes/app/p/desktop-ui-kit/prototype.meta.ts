import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "desktop-ui-kit",
  title: "Desktop UI Kit",
  summary:
    "Desktop counterpart to the Web UI Kit: a full-viewport Electron frame (macOS stoplights, focus-mode sidebar, Gateway footer) wrapping a flush content area, shown with the Sessions page.",
  author: "Parker",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.UiKit],
  createdAt: "2026-07-15",
  linearIssue: null,
  closedloopDoc: null,
} satisfies PrototypeMeta;
