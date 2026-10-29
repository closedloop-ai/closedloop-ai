/**
 * Inbox v2 fixture data and vocabulary.
 *
 * Kept apart from the component so the queue state model (`inbox-v2-model.ts`)
 * and its node-only tests can read the same threads the UI renders.
 */

export const InboxView = {
  Attention: "attention",
  Owned: "owned",
  Mentions: "mentions",
  Updates: "updates",
  All: "all",
  Bookmarks: "bookmarks",
  Archive: "archive",
  Resolved: "resolved",
} as const;
export type InboxView = (typeof InboxView)[keyof typeof InboxView];

export const InboxOrder = {
  Newest: "newest",
  Oldest: "oldest",
} as const;
export type InboxOrder = (typeof InboxOrder)[keyof typeof InboxOrder];

export const Reason = {
  Owner: "Owner",
  Mention: "Mention",
  Reply: "Reply",
  Resolved: "Resolved",
  Reopened: "Reopened",
} as const;
export type Reason = (typeof Reason)[keyof typeof Reason];

export const ArtifactType = {
  Issue: "issue",
  Branch: "branch",
  Document: "document",
  Session: "session",
  Prototype: "prototype",
} as const;
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];

export type ThreadMessage = {
  author: string;
  initials: string;
  body: string;
  time: string;
};

export type Thread = {
  id: string;
  /**
   * Fixture key the anchored preview resolves for this thread's artifact type.
   * Distinct from `artifactId` because the session and prototype fixture sets
   * are keyed by their own ids rather than by the displayed slug.
   */
  previewKey: string;
  /** Session-trace row the preview jumps to. Session threads only. */
  previewTraceRow?: number;
  artifactId: string;
  artifactTitle: string;
  artifactType: ArtifactType;
  anchor: string;
  anchorDetail: string;
  author: string;
  initials: string;
  body: string;
  time: string;
  sort: number;
  reasons: Reason[];
  unread: boolean;
  resolved: boolean;
  synced?: string;
  href: string;
  replies: ThreadMessage[];
};

export const viewLabels: Record<InboxView, string> = {
  [InboxView.Attention]: "Needs attention",
  [InboxView.Owned]: "Owned artifacts",
  [InboxView.Mentions]: "@Mentions",
  [InboxView.Updates]: "Updates",
  [InboxView.All]: "All",
  [InboxView.Bookmarks]: "Bookmarks",
  [InboxView.Archive]: "Archive",
  [InboxView.Resolved]: "Resolved",
};

export const UPDATE_REASONS: readonly Reason[] = [
  Reason.Reply,
  Reason.Resolved,
  Reason.Reopened,
];

export const seedThreads: readonly Thread[] = [
  {
    id: "thread-document-1",
    previewKey: "DOC-184",
    artifactId: "DOC-184",
    artifactTitle: "Artifact interaction principles",
    artifactType: ArtifactType.Document,
    anchor: "Selected text",
    anchorDetail: "preserve the semantic anchor",
    author: "Jordan Lee",
    initials: "JL",
    body: "@Ottilie can we preserve the semantic anchor when this paragraph moves across versions?",
    time: "8 min",
    sort: 8,
    reasons: [Reason.Owner, Reason.Mention],
    unread: true,
    resolved: false,
    href: "/p/web-master/documents/artifact-2?tab=artifact&comments=open&comment=document-comment-1",
    replies: [
      {
        author: "Pascoe Birchall",
        initials: "PB",
        body: "The version-safe text identity should cover this case.",
        time: "5 min",
      },
      {
        author: "Ottilie Eastwick",
        initials: "AE",
        body: "Agreed. I also want the highlight to return when this thread is opened from Inbox.",
        time: "2 min",
      },
    ],
  },
  {
    id: "thread-branch-1",
    previewKey: "BR-1284",
    artifactId: "BR-1284",
    artifactTitle: "agent/synthetic-seed-generator",
    artifactType: ArtifactType.Branch,
    anchor: "Inline diff comment",
    anchorDetail: "packages/database/seed/synthetic-generator.ts:88",
    author: "Sam Chen",
    initials: "SC",
    body: "Can we clamp the batch size here? The current loop can overrun the worker heap.",
    time: "1h",
    sort: 7,
    reasons: [Reason.Owner],
    unread: true,
    resolved: false,
    synced: "GitHub PR #1284",
    href: "/p/web-master/branches/br_1284?tab=artifact&comments=open&comment=branch-comment-1",
    replies: [
      {
        author: "Alex Rivera",
        initials: "AR",
        body: "I can add a bounded batch size and keep the default behavior unchanged.",
        time: "42 min",
      },
    ],
  },
  {
    id: "thread-session-1",
    previewKey: "ses_9f31",
    previewTraceRow: 4,
    artifactId: "SES-9F31",
    artifactTitle: "closedloop-electron",
    artifactType: ArtifactType.Session,
    anchor: "Session turn",
    anchorDetail: "Agent turn · 10:27 AM",
    author: "Ottilie Eastwick",
    initials: "AE",
    body: "@Jordan does this idle interval still anchor to the correct turn after scrubbing?",
    time: "2h",
    sort: 6,
    reasons: [Reason.Mention],
    unread: true,
    resolved: false,
    href: "/p/web-master/sessions/ses_9f31?tab=sessions&traceRow=4&comments=open",
    replies: [
      {
        author: "Jordan Lee",
        initials: "JL",
        body: "It does now. The anchor follows the turn identity instead of the rendered row position.",
        time: "1h",
      },
    ],
  },
  {
    id: "thread-prototype-1",
    previewKey: "branches-v2",
    artifactId: "PRT-108",
    artifactTitle: "Hello world app",
    artifactType: ArtifactType.Prototype,
    anchor: "Visual anchor",
    anchorDetail: "Get started button · /hello-world",
    author: "Pascoe Birchall",
    initials: "PB",
    body: "The primary action still reads too loudly beside the secondary action.",
    time: "yesterday",
    sort: 5,
    reasons: [Reason.Owner],
    unread: false,
    resolved: false,
    href: "/p/web-master/prototypes?artifact=branches-v2&tab=artifact&comments=open",
    replies: [
      {
        author: "Ottilie Eastwick",
        initials: "AE",
        body: "Please reduce the emphasis and keep the secondary action visible.",
        time: "yesterday",
      },
      {
        author: "Pascoe Birchall",
        initials: "PB",
        body: "Updated in the latest prototype version.",
        time: "yesterday",
      },
    ],
  },
  {
    id: "thread-issue-update",
    previewKey: "ISS-4382",
    artifactId: "ISS-4382",
    artifactTitle: "Make documents a first-class artifact",
    artifactType: ArtifactType.Issue,
    anchor: "Work definition",
    anchorDetail: "Acceptance criteria · Reply behavior",
    author: "Daveth Oakhurst",
    initials: "DO",
    body: "I applied your suggestion and updated the reply acceptance criteria.",
    time: "2d",
    sort: 4,
    reasons: [Reason.Reply],
    unread: true,
    resolved: false,
    href: "/p/web-master/issues-v2/ISS-4382?tab=artifact&comments=open",
    replies: [],
  },
  {
    id: "thread-document-2",
    previewKey: "DOC-184",
    artifactId: "DOC-184",
    artifactTitle: "Artifact interaction principles",
    artifactType: ArtifactType.Document,
    anchor: "Selected text",
    anchorDetail: "Goals and non-goals",
    author: "Ottilie Eastwick",
    initials: "AE",
    body: "@Pascoe can you confirm this still describes the boundary between shared behavior and specialized canvases?",
    time: "3d",
    sort: 3.9,
    reasons: [Reason.Owner],
    unread: false,
    resolved: false,
    href: "/p/web-master/documents/artifact-2?tab=artifact&comments=open&comment=document-comment-2",
    replies: [
      {
        author: "Pascoe Birchall",
        initials: "PB",
        body: "Yes. I would keep the final sentence because it makes the ownership boundary explicit.",
        time: "2d",
      },
    ],
  },
  {
    id: "thread-branch-2",
    previewKey: "BR-1284",
    artifactId: "BR-1284",
    artifactTitle: "agent/synthetic-seed-generator",
    artifactType: ArtifactType.Branch,
    anchor: "Inline diff comment",
    anchorDetail: "apps/api/lib/fixtures/seed-config.ts:41",
    author: "Pascoe Birchall",
    initials: "PB",
    body: "Could this configuration share the same limit constant as the generator instead of introducing a second default?",
    time: "3d",
    sort: 3.8,
    reasons: [Reason.Mention],
    unread: true,
    resolved: false,
    synced: "GitHub PR #1284",
    href: "/p/web-master/branches/br_1284?tab=artifact&comments=open&comment=branch-comment-2",
    replies: [],
  },
  {
    id: "thread-prototype-2",
    previewKey: "branches-v2",
    artifactId: "PRT-108",
    artifactTitle: "Hello world app",
    artifactType: ArtifactType.Prototype,
    anchor: "Visual anchor",
    anchorDetail: "Navigation · Contact",
    author: "Jordan Lee",
    initials: "JL",
    body: "The active navigation state is difficult to distinguish at this zoom level.",
    time: "4d",
    sort: 3.7,
    reasons: [Reason.Owner],
    unread: true,
    resolved: false,
    href: "/p/web-master/prototypes?artifact=branches-v2&tab=artifact&comments=open",
    replies: [
      {
        author: "Ottilie Eastwick",
        initials: "AE",
        body: "Use the existing selected-nav treatment so it stays consistent with the shell.",
        time: "4d",
      },
    ],
  },
  {
    id: "thread-session-2",
    previewKey: "ses_9f31",
    previewTraceRow: 1,
    artifactId: "SES-9F31",
    artifactTitle: "closedloop-electron",
    artifactType: ArtifactType.Session,
    anchor: "Session turn",
    anchorDetail: "Agent turn · 9:16 AM",
    author: "Jordan Lee",
    initials: "JL",
    body: "The duration displayed here differs from the value in the timeline tooltip by two seconds.",
    time: "4d",
    sort: 3.6,
    reasons: [Reason.Owner],
    unread: false,
    resolved: false,
    href: "/p/web-master/sessions/ses_9f31?tab=sessions&traceRow=1&comments=open",
    replies: [],
  },
  {
    id: "thread-issue-2",
    previewKey: "FEA-2481",
    artifactId: "FEA-2481",
    artifactTitle: "Unified artifact experience",
    artifactType: ArtifactType.Issue,
    anchor: "Activity event",
    anchorDetail: "Implementation plan",
    author: "Sam Chen",
    initials: "SC",
    body: "@Ottilie the implementation plan now links back to the source requirements document.",
    time: "5d",
    sort: 3.5,
    reasons: [Reason.Reply, Reason.Mention],
    unread: true,
    resolved: false,
    href: "/p/web-master/issues-v2/FEA-2481?tab=artifact&comments=open",
    replies: [
      {
        author: "Ottilie Eastwick",
        initials: "AE",
        body: "Great. Keep that relationship visible in the activity stream.",
        time: "5d",
      },
    ],
  },
  {
    id: "thread-document-3",
    previewKey: "DOC-184",
    artifactId: "DOC-184",
    artifactTitle: "Artifact interaction principles",
    artifactType: ArtifactType.Document,
    anchor: "Selected text",
    anchorDetail: "Requirements · linked artifacts",
    author: "Pascoe Birchall",
    initials: "PB",
    body: "Should linked artifacts remain references here, or become a dedicated relationship section?",
    time: "6d",
    sort: 3.4,
    reasons: [Reason.Owner],
    unread: false,
    resolved: false,
    href: "/p/web-master/documents/artifact-2?tab=artifact&comments=open&comment=document-comment-3",
    replies: [],
  },
  {
    id: "thread-prototype-3",
    previewKey: "branches-v2",
    artifactId: "PRT-108",
    artifactTitle: "Hello world app",
    artifactType: ArtifactType.Prototype,
    anchor: "Visual anchor",
    anchorDetail: "Hero support copy",
    author: "Sam Chen",
    initials: "SC",
    body: "This support copy clips in the narrow preview. Can the child preview use its responsive layout here?",
    time: "1w",
    sort: 3.3,
    reasons: [Reason.Owner],
    unread: true,
    resolved: false,
    href: "/p/web-master/prototypes?artifact=branches-v2&tab=artifact&comments=open",
    replies: [],
  },
  {
    id: "thread-branch-3",
    previewKey: "BR-1284",
    artifactId: "BR-1284",
    artifactTitle: "agent/synthetic-seed-generator",
    artifactType: ArtifactType.Branch,
    anchor: "Branch discussion",
    anchorDetail: "Pull request summary",
    author: "Alex Rivera",
    initials: "AR",
    body: "The final check is green. Is this ready to move from review to merge?",
    time: "1w",
    sort: 3.2,
    reasons: [Reason.Owner],
    unread: false,
    resolved: false,
    synced: "GitHub PR #1284",
    href: "/p/web-master/branches/br_1284?tab=artifact&comments=open&comment=branch-comment-3",
    replies: [
      {
        author: "Sam Chen",
        initials: "SC",
        body: "The batch-limit concern is still open, so I would hold the merge.",
        time: "1w",
      },
    ],
  },
  {
    id: "thread-resolved-1",
    previewKey: "FEA-2488",
    artifactId: "FEA-2488",
    artifactTitle: "Unify artifact comments",
    artifactType: ArtifactType.Issue,
    anchor: "Comment thread",
    anchorDetail: "Reply state",
    author: "Daveth Oakhurst",
    initials: "DO",
    body: "Confirmed in production and resolved this thread.",
    time: "5d",
    sort: 3,
    reasons: [Reason.Resolved],
    unread: false,
    resolved: true,
    href: "/p/web-master/issues-v2/FEA-2488?tab=artifact&comments=open",
    replies: [],
  },
];
