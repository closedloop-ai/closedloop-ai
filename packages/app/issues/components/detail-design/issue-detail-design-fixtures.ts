// gardener-support: test and story data, not shipped
import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import { ISSUE_EXAMPLE_ROWS } from "@repo/app/documents/components/artifact-activity/activity-example-timelines.fixtures";
import {
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "@repo/app/documents/components/artifact-activity/activity-timeline";
import type { DocumentMetadataBarView } from "@repo/app/documents/components/document-metadata-bar";
import type { ExternalSyncRelationship } from "@repo/app/shared/components/comments/external-sync-contract";
import type { GenericCommentRecord } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-rail";
import { ArtifactTypeIcons } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-icons";
import type { LinkedArtifactTableRow } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-linked-artifacts-table";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { ISSUE_STATUS_LABELS } from "@repo/app/shared/lib/artifact-status-labels";
import type { LinkedWorkBranch } from "../linked-work/linked-work-card";
import {
  BRANCH_CLOSED,
  BRANCH_IN_PROGRESS,
  BRANCH_IN_REVIEW,
  BRANCH_MERGED,
  BRANCH_ON_SUB_ISSUE,
} from "../linked-work/linked-work-card.fixtures";

/**
 * ISS-12586 (DI-16) fixtures for the Issue Detail design preview. Every name,
 * id and paragraph is a placeholder: the operator exempted story fixtures of
 * design-only components from the no-placeholder rule (2026-10-15).
 */

/**
 * The issue's history in reading order: the catalog's Issue example, on the
 * issue statuses (Triage to Done), with no versions and no approver, as the
 * Issue details group has none.
 */
const ISSUE_ROWS: readonly ActivityTimelineRow[] = ISSUE_EXAMPLE_ROWS;

export const ISSUE_DESIGN_ARTIFACT: GenericArtifact = {
  id: "issue-design-iss-0005",
  slug: "ISS-0005",
  title: "Fixture: Issue detail page shell",
  summary: "Fixture: the Issue Detail page in the artifact detail shell.",
  kind: ArtifactKind.Issue,
  status: ArtifactStatus.Done,
  owner: "Taylor Morgan",
  ownerInitials: "TM",
  collaborators: ["Taylor Morgan", "Sam Lee"],
  repository: "fixture-org/fixture-repo",
  project: "Fixture: Artifact detail pages",
  tags: ["Design system", "Research"],
  commentCount: 1,
  // GenericArtifact requires one; nothing on the issue page shows it, as
  // issues have no versions (Ottilie, 2026-10-21).
  currentVersion: "1",
  updated: "1h ago",
  updatedAgoMinutes: 60,
  createdAgoDays: 21,
  aiSpend: 0,
  timeToReadyMinutes: 0,
  outcomeScore: 0,
  activityCount: ISSUE_ROWS.length,
  relationshipCount: 5,
};

/**
 * What the canvas toolbar's fields (DI-08) show after the issue's slug: its state,
 * owner, priority and due date. Edits are no-ops in the preview.
 */
export const ISSUE_DESIGN_STATUS_STRIP: {
  metadata: DocumentMetadataBarView;
  dueDate: Date;
} = {
  metadata: {
    assignee: {
      id: "fixture-taylor",
      name: "Taylor Morgan",
      email: "taylor@closedloop.invalid",
    },
    handleAssigneeChange: () => undefined,
    handlePriorityChange: () => undefined,
    handleStatusChange: () => undefined,
    priority: Priority.High,
    repositorySnapshot: { source: "none", repositories: [] },
    status: IssueStatus.Done,
    teamMembers: [
      {
        id: "fixture-taylor",
        name: "Taylor Morgan",
        email: "taylor@closedloop.invalid",
      },
      { id: "fixture-sam", name: "Sam Lee", email: "sam@closedloop.invalid" },
    ],
  },
  dueDate: new Date("2026-10-24T00:00:00.000Z"),
};

/**
 * The issue's description: a paragraph or two, as markdown (ISS-12570: an
 * average issue is a paragraph, M1 14:43).
 */
export const ISSUE_DESIGN_BODY = `Fixture: give the Issue Detail page the same four tabs as every other artifact, with the issue's own card, its metadata and a short activity brief on the Artifact tab.

Fixture: what done looks like:

- The toolbar stays at the top of the issue canvas
- The Branch section shows the branch and its pull request
- The Activity summary folds the event history`;

/** The issue's sub-issues, each with its delivery status. */
export const ISSUE_DESIGN_SUB_ISSUES: readonly LinkedArtifactTableRow[] = [
  {
    key: "sub-issue-strip",
    href: "/issues/ISS-0006",
    icon: ArtifactTypeIcons.Issue,
    slug: "ISS-0006",
    name: "Fixture: Toolbar at the top of the issue canvas",
    status: ISSUE_STATUS_LABELS[IssueStatus.Done],
    relationship: null,
  },
  {
    key: "sub-issue-brief",
    href: "/issues/ISS-0007",
    icon: ArtifactTypeIcons.Issue,
    slug: "ISS-0007",
    name: "Fixture: Activity summary on the Artifact tab",
    status: ISSUE_STATUS_LABELS[IssueStatus.InReview],
    relationship: null,
  },
];

/** The issue an issue is a sub-issue of. */
export const ISSUE_DESIGN_PARENT = {
  slug: "ISS-0004",
  title: "Fixture: Documents and Issues detail pages",
  href: "/issues/ISS-0004",
} as const;

/**
 * The two kinds of comment an issue takes (Ottilie, 2026-10-21): one on a
 * passage of the body, which the body highlights, and one on the issue as a
 * whole, with no anchor.
 */
export const ISSUE_DESIGN_TEXT_COMMENT: GenericCommentRecord = {
  id: "issue-design-comment-1",
  author: "Sam Lee",
  body: "Fixture: the activity brief should end on the latest status change.",
  context: "“a short activity brief on the Artifact tab”",
  anchorPreview: "a short activity brief on the Artifact tab",
  time: "1h ago",
  anchor: {
    documentVersion: 1,
    kind: CommentAnchorKind.Text,
    quote: {
      exact: "a short activity brief on the Artifact tab",
      prefix: "",
      suffix: "",
    },
  },
  source: { provider: "native" },
  status: "open",
};

export const ISSUE_DESIGN_ISSUE_COMMENT: GenericCommentRecord = {
  id: "issue-design-comment-2",
  author: "Taylor Morgan",
  body: "Fixture: can this ship before the Details tab work?",
  context: "Issue comment",
  time: "3h ago",
  anchor: { kind: CommentAnchorKind.Artifact },
  source: { provider: "native" },
  status: "open",
};

/** Both kinds of comment, and one already resolved. */
export const ISSUE_DESIGN_COMMENTS: readonly GenericCommentRecord[] = [
  ISSUE_DESIGN_TEXT_COMMENT,
  ISSUE_DESIGN_ISSUE_COMMENT,
  {
    id: "issue-design-comment-3",
    author: "Sam Lee",
    body: "Fixture: the toolbar keeps the due date.",
    context: "Issue comment",
    time: "5h ago",
    anchor: { kind: CommentAnchorKind.Artifact },
    source: { provider: "native" },
    status: "resolved",
  },
];

/**
 * The passages the open text-anchored comments among `comments` quote: the
 * ones the issue body highlights.
 */
export function issueCommentHighlights(
  comments: readonly GenericCommentRecord[]
): string[] {
  return comments.flatMap((comment) => {
    if (
      comment.status === "resolved" ||
      comment.parentId !== undefined ||
      comment.anchor?.kind !== CommentAnchorKind.Text
    ) {
      return [];
    }
    // A thread posted from the rail carries its quote as the preview.
    const quote = comment.anchor.quote?.exact ?? comment.anchorPreview;
    return quote ? [quote] : [];
  });
}

/**
 * One state of the Issue page (ISS-12576's list of states): everything the
 * page shows that changes from one issue to another.
 */
export type IssueDesignScenario = {
  status: IssueStatus;
  /** The issue's owner; `null` before anyone picks it up. */
  owner: DocumentMetadataBarView["assignee"];
  body: string;
  parent: { slug: string; title: string; href: string | null } | null;
  subIssues: readonly LinkedArtifactTableRow[];
  sync: ExternalSyncRelationship | null;
  branches: readonly LinkedWorkBranch[];
  /**
   * Future state only: prototype and Storybook addresses, as plain text,
   * until they have an artifact type (Ottilie, 2026-10-21).
   */
  otherLinks?: readonly string[];
  comments: readonly GenericCommentRecord[];
};

export const IssueDesignState = {
  /** Done: its branch merged, sub-issues below the body. */
  Default: "default",
  /** Just filed: no owner, no branch, one event. */
  New: "new",
  /** Picked up, nothing pushed yet. */
  InProgressNoBranch: "in-progress-no-branch",
  /** One branch, its pull request in review. */
  OneBranch: "one-branch",
  /** Its own branch and a sub-issue's branch. */
  SeveralBranches: "several-branches",
  /** Closed as done, but its pull request closed without merging (GitHub #112, DOC-47). */
  ClosedNotMerged: "closed-not-merged",
  /** A sub-issue: "Sub-issue of …" above the title. */
  SubIssue: "sub-issue",
  /** Came from GitHub: synced, its GitHub comments in the rail. */
  ImportedFromGitHub: "imported-from-github",
  /** Came from Linear: synced, its Linear thread in the rail. */
  ImportedFromLinear: "imported-from-linear",
  /** One comment, on a passage of the body, which the body highlights. */
  TextComment: "text-comment",
  /** One comment, on the issue as a whole. */
  IssueComment: "issue-comment",
  /** Future state: an Other links section of plain-text addresses. */
  FutureOtherLinks: "future-other-links",
} as const;
export type IssueDesignState =
  (typeof IssueDesignState)[keyof typeof IssueDesignState];

const OWNER = ISSUE_DESIGN_STATUS_STRIP.metadata.assignee;

const DEFAULT_SCENARIO: IssueDesignScenario = {
  status: IssueStatus.Done,
  owner: OWNER,
  body: ISSUE_DESIGN_BODY,
  parent: null,
  subIssues: ISSUE_DESIGN_SUB_ISSUES,
  sync: null,
  // The merged branch that implemented it.
  branches: [BRANCH_MERGED],
  comments: ISSUE_DESIGN_COMMENTS,
};

/**
 * A state's history, in reading order: the example history up to the move
 * into `status`, so the brief and the Activity tab end on the status the
 * strip shows. An issue still in Triage has only been filed.
 */
export function issueDesignHistory(
  status: IssueStatus
): readonly ActivityTimelineRow[] {
  const end = ISSUE_ROWS.findIndex(
    (row) =>
      row.kind === ActivityTimelineRowKind.Activity &&
      row.item.event.action === ArtifactActivityAction.StatusChange &&
      row.item.event.after === status
  );
  return ISSUE_ROWS.slice(0, end + 1 || 1);
}

export const ISSUE_DESIGN_SCENARIOS: Readonly<
  Record<IssueDesignState, IssueDesignScenario>
> = {
  [IssueDesignState.Default]: DEFAULT_SCENARIO,
  [IssueDesignState.New]: {
    ...DEFAULT_SCENARIO,
    status: IssueStatus.Triage,
    owner: null,
    subIssues: [],
    branches: [],
    comments: [],
  },
  [IssueDesignState.InProgressNoBranch]: {
    ...DEFAULT_SCENARIO,
    status: IssueStatus.InProgress,
    subIssues: [],
    branches: [],
  },
  [IssueDesignState.OneBranch]: {
    ...DEFAULT_SCENARIO,
    status: IssueStatus.InReview,
    subIssues: [],
    branches: [BRANCH_IN_REVIEW],
  },
  [IssueDesignState.SeveralBranches]: {
    ...DEFAULT_SCENARIO,
    status: IssueStatus.InProgress,
    branches: [BRANCH_IN_PROGRESS, BRANCH_ON_SUB_ISSUE],
  },
  [IssueDesignState.ClosedNotMerged]: {
    ...DEFAULT_SCENARIO,
    subIssues: [],
    branches: [BRANCH_CLOSED],
  },
  [IssueDesignState.SubIssue]: {
    ...DEFAULT_SCENARIO,
    status: IssueStatus.InReview,
    parent: ISSUE_DESIGN_PARENT,
    subIssues: [],
    branches: [BRANCH_IN_REVIEW],
  },
  [IssueDesignState.ImportedFromGitHub]: {
    ...DEFAULT_SCENARIO,
    status: IssueStatus.InProgress,
    subIssues: [],
    sync: {
      provider: "github",
      label: "GitHub",
      href: "https://closedloop.invalid/issues/57",
    },
    branches: [BRANCH_IN_REVIEW],
    comments: [
      {
        id: "issue-design-github-thread",
        author: "Sam Lee",
        body: "Fixture: a comment written on the GitHub issue.",
        context: "Issue comment",
        time: "2h ago",
        anchor: { kind: CommentAnchorKind.Artifact },
        source: {
          provider: "github",
          externalSync: {
            provider: "github",
            label: "GitHub",
            href: "https://closedloop.invalid/issues/57#issuecomment-1",
          },
        },
        status: "open",
      },
    ],
  },
  [IssueDesignState.ImportedFromLinear]: {
    ...DEFAULT_SCENARIO,
    status: IssueStatus.InProgress,
    subIssues: [],
    sync: {
      provider: "linear",
      label: "Linear",
      href: "https://closedloop.invalid/linear/ENG-42",
    },
    branches: [BRANCH_IN_REVIEW],
    comments: [
      {
        id: "issue-design-linear-thread",
        author: "Sam Lee",
        body: "Fixture: a comment written on the Linear issue.",
        context: "Issue comment",
        time: "2h ago",
        anchor: { kind: CommentAnchorKind.Artifact },
        source: {
          provider: "native",
          externalSync: {
            provider: "linear",
            label: "Linear",
            href: "https://closedloop.invalid/linear/ENG-42#comment-1",
          },
        },
        status: "open",
      },
    ],
  },
  [IssueDesignState.TextComment]: {
    ...DEFAULT_SCENARIO,
    comments: [ISSUE_DESIGN_TEXT_COMMENT],
  },
  [IssueDesignState.IssueComment]: {
    ...DEFAULT_SCENARIO,
    comments: [ISSUE_DESIGN_ISSUE_COMMENT],
  },
  [IssueDesignState.FutureOtherLinks]: {
    ...DEFAULT_SCENARIO,
    status: IssueStatus.InReview,
    branches: [BRANCH_IN_REVIEW],
    otherLinks: [
      "https://closedloop.invalid/prototypes/issue-detail",
      "https://closedloop.invalid/storybook/?path=/story/issue-detail",
    ],
  },
};
