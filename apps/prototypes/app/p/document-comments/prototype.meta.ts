import {
  type PrototypeMeta,
  PrototypeStatus,
  PrototypeTag,
} from "@/lib/registry";

export const meta = {
  slug: "document-comments",
  title: "Document Comments",
  summary:
    "Collaborative comment/thread/mention UI for an evergreen Document body (FEA-4049 Slice C, follow-on to FEA-3950). The comment rail mounts inside the shared FeedRail shell, mirroring the connected DocumentFeedRail. Inline-anchored threads on highlighted text open and scroll their rail card into view (expanding the resolved group when needed); an artifact-level composer posts whole-doc comments. Flat single-level replies, edit/delete on your own comments, and a participant-resolve rule this slice invents (the thread author or any replier may resolve; the raiser reopens) — the domain CommentActionMenu gates only edit/delete, not resolve. @-mention typeahead with keyboard navigation notifies inbox-only; mermaid renders inline, always on. All three seeded threads are yours, so comment, reply, edit, resolve, delete-to-empty-state, and the mention flow are all exercisable locally. Selection-to-new-inline-thread is left to the connected build.",
  author: "Mike Angstadt",
  status: PrototypeStatus.ReadyForReview,
  tags: [PrototypeTag.Feature],
  createdAt: "2026-07-24",
  linearIssue: null,
  closedloopDoc: "FEA-4049",
} satisfies PrototypeMeta;
