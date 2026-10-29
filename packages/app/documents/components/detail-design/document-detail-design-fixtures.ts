// gardener-support: test and story data, not shipped
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { newestFirst } from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import { DOCUMENT_EXAMPLE_ROWS } from "@repo/app/documents/components/artifact-activity/activity-example-timelines.fixtures";
import {
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "@repo/app/documents/components/artifact-activity/activity-timeline";
import type { GenericCommentRecord } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-rail";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";

/**
 * ISS-12586 (DI-16) fixtures for the Document Detail design preview. Every
 * name, id and paragraph is a placeholder: the operator exempted story
 * fixtures of design-only components from the no-placeholder rule
 * (2026-10-15).
 */

export const DOCUMENT_DESIGN_ARTIFACT: GenericArtifact = {
  id: "document-design-doc-0042",
  slug: "DOC-0042",
  title: "Fixture: Artifact detail pages",
  summary: "Fixture: how every artifact detail page is laid out.",
  kind: ArtifactKind.Document,
  status: ArtifactStatus.InReview,
  owner: "Taylor Morgan",
  ownerInitials: "TM",
  collaborators: ["Taylor Morgan", "Sam Lee", "Jordan Kim"],
  repository: null,
  project: "Fixture: Artifact detail pages",
  tags: ["Design system", "Research"],
  commentCount: 2,
  currentVersion: "5",
  updated: "2h ago",
  updatedAgoMinutes: 120,
  createdAgoDays: 6,
  aiSpend: 0,
  timeToReadyMinutes: 0,
  outcomeScore: 0,
  activityCount: 16,
  relationshipCount: 7,
};

/** The version the canvas opens on, and how many there are. */
export const DOCUMENT_DESIGN_VERSIONS = { current: 5, latest: 5 } as const;

/** The canvas body: a heading and its paragraphs, in reading order. */
export const DOCUMENT_DESIGN_BODY: readonly {
  heading: string;
  paragraphs: readonly string[];
}[] = [
  {
    heading: "Fixture: Problem",
    paragraphs: [
      "Fixture: each artifact type draws its detail page its own way, so a reader relearns the page every time they open a different kind of work.",
      "Fixture: comments, sessions and history sit in different places on each page, and some pages have no place for them at all.",
    ],
  },
  {
    heading: "Fixture: Proposal",
    paragraphs: [
      "Fixture: one shell for every artifact, with the same four tabs in the same order: Artifact, Sessions, Details and Activity.",
      "Fixture: the Artifact tab is the artifact itself. Its body grows with its content and the page scrolls, so a long document reads as one column.",
      "Fixture: Details holds every attribute in one place; Activity is the artifact's history, newest first.",
    ],
  },
  {
    heading: "Fixture: Open questions",
    paragraphs: [
      "Fixture: which comments belong beside the Sessions tab, and which only beside the artifact.",
    ],
  },
];

export const DOCUMENT_DESIGN_COMMENTS: readonly GenericCommentRecord[] = [
  {
    id: "document-design-comment-1",
    author: "Sam Lee",
    body: "Fixture: the proposal reads well; can the open questions link their issues?",
    context: "Document comment",
    time: "2h ago",
    anchor: { kind: CommentAnchorKind.Artifact },
    source: { provider: "native" },
    status: "open",
  },
  {
    id: "document-design-comment-2",
    author: "Jordan Kim",
    body: "Fixture: agreed on the tab order.",
    context: "Document comment",
    time: "1h ago",
    anchor: { kind: CommentAnchorKind.Artifact },
    source: { provider: "native" },
    status: "open",
  },
];

/**
 * The Document feed, newest first: the catalog's Document example up to the
 * point it becomes an issue's delivery history (created, versions, fields,
 * comments, tags, project, review, evaluation and a derived link). The
 * Unblocked, In progress and later rows are an issue's statuses, which a
 * document does not have, and the approver row is gone with the approver
 * (PRD-799).
 */
const DOCUMENT_ROW_COUNT = 16;

/** Whether a row sets the approver, which neither page has a field for. */
function setsApprover(row: ActivityTimelineRow): boolean {
  if (row.kind !== ActivityTimelineRowKind.Activity) {
    return false;
  }
  const after = row.item.event.after;
  return (
    typeof after === "object" &&
    after !== null &&
    "field" in after &&
    after.field === "approverId"
  );
}

export const DOCUMENT_DESIGN_ACTIVITY_ROWS: readonly ActivityTimelineRow[] =
  newestFirst(
    DOCUMENT_EXAMPLE_ROWS.slice(0, DOCUMENT_ROW_COUNT).filter(
      (row) => !setsApprover(row)
    )
  );
