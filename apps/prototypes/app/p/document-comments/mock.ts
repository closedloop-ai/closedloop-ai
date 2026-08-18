// Mock data for the Document Comments prototype (FEA-4049 Slice C).
// Presentational only, no DB/API/Liveblocks. Mirrors the shapes the connected
// CommentsSection (packages/app/documents) reads from its thread store so the
// production build has a faithful reference.

export const CommentAuthorKind = {
  Human: "human",
  Bot: "bot",
} as const;

export type CommentAuthorKind =
  (typeof CommentAuthorKind)[keyof typeof CommentAuthorKind];

export type CommentAuthor = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  kind: CommentAuthorKind;
};

/** A mention chip inside a rendered comment body. */
export type CommentMention = {
  userId: string;
  label: string;
};

export type CommentReply = {
  id: string;
  author: CommentAuthor;
  body: string;
  createdAt: string;
  mentions?: readonly CommentMention[];
};

export const ThreadScope = {
  /** Anchored to a text selection in the document body. */
  Inline: "inline",
  /** Whole-document discussion, not tied to any selection. */
  Artifact: "artifact",
} as const;

export type ThreadScope = (typeof ThreadScope)[keyof typeof ThreadScope];

export type CommentThread = {
  id: string;
  scope: ThreadScope;
  /** The highlighted text this thread anchors to; null for artifact-level. */
  anchorText: string | null;
  author: CommentAuthor;
  body: string;
  createdAt: string;
  resolved: boolean;
  mentions?: readonly CommentMention[];
  replies: readonly CommentReply[];
};

// The signed-in viewer for this prototype. On a review doc the person who
// addressed the feedback usually closes the thread, so resolve is open to the
// author or any participant (see canResolveThread), with reopen kept to the
// raiser.
export const currentUser: CommentAuthor = {
  id: "u-parker",
  name: "Parker Reid",
  email: "parker@closedloop.ai",
  avatarUrl: null,
  kind: CommentAuthorKind.Human,
};

const dana: CommentAuthor = {
  id: "u-dana",
  name: "Dana Cole",
  email: "dana@closedloop.ai",
  avatarUrl: null,
  kind: CommentAuthorKind.Human,
};

const marcus: CommentAuthor = {
  id: "u-marcus",
  name: "Marcus Lee",
  email: "marcus@closedloop.ai",
  avatarUrl: null,
  kind: CommentAuthorKind.Human,
};

const priya: CommentAuthor = {
  id: "u-priya",
  name: "Priya Nair",
  email: "priya@closedloop.ai",
  avatarUrl: null,
  kind: CommentAuthorKind.Human,
};

// Org members for the @-mention typeahead.
export const mentionableUsers: readonly CommentAuthor[] = [
  currentUser,
  dana,
  marcus,
  priya,
  {
    id: "u-alex",
    name: "Alex Tran",
    email: "alex@closedloop.ai",
    avatarUrl: null,
    kind: CommentAuthorKind.Human,
  },
  {
    id: "u-sam",
    name: "Sam Okafor",
    email: "sam@closedloop.ai",
    avatarUrl: null,
    kind: CommentAuthorKind.Human,
  },
];

// Two inline-anchored threads (one resolved, one open) plus one artifact-level
// thread. All three are authored by the current viewer so the edit/delete
// affordances are live and deleting every thread reaches the empty state.
// Other members appear as reply participants so the participant-resolve rule
// (canResolveThread) is visible: e.g. Marcus can close the queue thread even
// though Dana's reply raised the open question, and Priya confirmed it in
// staging.
export const threads: readonly CommentThread[] = [
  {
    id: "th-inline-1",
    scope: ThreadScope.Inline,
    anchorText: "each write serializes through a single-writer queue",
    author: currentUser,
    body: "Does this hold under a burst of concurrent edits from three agents? @Marcus Lee want to be sure the queue doesn't become the bottleneck at fan-out.",
    createdAt: "2026-07-22T15:04:00Z",
    resolved: false,
    mentions: [{ userId: marcus.id, label: "Marcus Lee" }],
    replies: [
      {
        id: "rp-inline-1a",
        author: marcus,
        body: "It queues per-document, so three agents on the same doc serialize but different docs stay parallel. Benchmarked at ~2k writes/s per queue.",
        createdAt: "2026-07-22T15:31:00Z",
      },
      {
        id: "rp-inline-1b",
        author: priya,
        body: "That matches what I saw in staging. Good to leave as-is.",
        createdAt: "2026-07-22T16:12:00Z",
      },
    ],
  },
  {
    id: "th-inline-2",
    scope: ThreadScope.Inline,
    anchorText: "mermaid diagrams render inline in the body",
    author: currentUser,
    body: "Is inline rendering on by default now, or is there still a per-document toggle to flip?",
    createdAt: "2026-07-21T09:48:00Z",
    resolved: true,
    replies: [
      {
        id: "rp-inline-2a",
        author: priya,
        body: "On by default now, no toggle needed. One less setting to explain.",
        createdAt: "2026-07-21T10:02:00Z",
      },
    ],
  },
  {
    id: "th-artifact-1",
    scope: ThreadScope.Artifact,
    anchorText: null,
    author: currentUser,
    body: "Overall this reads well. @Marcus Lee can you double-check the resolve-permission line before we hand off?",
    createdAt: "2026-07-23T18:20:00Z",
    resolved: false,
    mentions: [{ userId: marcus.id, label: "Marcus Lee" }],
    replies: [
      {
        id: "rp-artifact-1a",
        author: marcus,
        body: "On it. Confirmed the wording. @Parker Reid you're clear.",
        createdAt: "2026-07-23T18:44:00Z",
        mentions: [{ userId: currentUser.id, label: "Parker Reid" }],
      },
    ],
  },
];

// The document being discussed. Body is static prose split into blocks so the
// prototype can render an inline-anchored highlight and a mermaid figure.
export const documentMeta = {
  title: "Evergreen Document: Collaborative Editing Model",
  updatedLabel: "Updated 2 days ago",
  authorName: "Marcus Lee",
};

export const DocBlockKind = {
  Heading: "heading",
  Paragraph: "paragraph",
  Mermaid: "mermaid",
} as const;

export type DocBlockKind = (typeof DocBlockKind)[keyof typeof DocBlockKind];

export type DocBlock =
  | { kind: typeof DocBlockKind.Heading; text: string }
  | {
      kind: typeof DocBlockKind.Paragraph;
      // Optional inline highlight that anchors a thread, split so the prototype
      // can render the highlighted span with a click-to-open affordance.
      before?: string;
      highlightThreadId?: string;
      highlight?: string;
      after?: string;
      text?: string;
    }
  | { kind: typeof DocBlockKind.Mermaid; caption: string };

/**
 * Whether a viewer may resolve a thread. This slice invents the rule (the
 * domain CommentActionMenu gates only edit/delete, not resolve): the thread
 * author or anyone who has replied may close it, since on a review doc the
 * person who addressed the feedback usually wants to close it. Reopening stays
 * with the raiser and is gated separately at the call site.
 */
export function canResolveThread(
  thread: CommentThread,
  viewerId: string
): boolean {
  if (thread.author.id === viewerId) {
    return true;
  }
  return thread.replies.some((reply) => reply.author.id === viewerId);
}

/** Display label for a mention chip, resolved from the mentionable directory. */
export function mentionLabelFor(userId: string): string {
  const user = mentionableUsers.find((candidate) => candidate.id === userId);
  return user ? user.name : "Unknown user";
}

export const docBody: readonly DocBlock[] = [
  {
    kind: DocBlockKind.Heading,
    text: "Write model",
  },
  {
    kind: DocBlockKind.Paragraph,
    before:
      "The editor is collaborative, so multiple people and agents can hold the same document open at once. To keep the body consistent, ",
    highlightThreadId: "th-inline-1",
    highlight: "each write serializes through a single-writer queue",
    after:
      " before it is broadcast to every open client. Reads never block; only the commit step is ordered.",
  },
  {
    kind: DocBlockKind.Paragraph,
    text: "Every committed change stamps an author and a version, so the comment rail can attribute a thread to the version it was raised against and show a small version label when the body has since moved on.",
  },
  {
    kind: DocBlockKind.Heading,
    text: "Commit flow",
  },
  {
    kind: DocBlockKind.Mermaid,
    caption: "Write path: edit to broadcast",
  },
  {
    kind: DocBlockKind.Heading,
    text: "Rendering",
  },
  {
    kind: DocBlockKind.Paragraph,
    before: "Rich text, tables, and ",
    highlightThreadId: "th-inline-2",
    highlight: "mermaid diagrams render inline in the body",
    after:
      ". Mermaid is always on, there is no per-document toggle, so a diagram in the source always paints as a figure rather than a fenced code block.",
  },
];
