import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "web-ui-kit",
  title: "Web UI Kit",
  summary:
    "Base web prototype that mirrors the live app shell: sidebar navigation plus a main content area, shown with the projects list.",
  author: "Parker",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.UiKit],
  createdAt: "2026-06-30",
  linearIssue: null,
  closedloopDoc: null,
} satisfies PrototypeMeta;
