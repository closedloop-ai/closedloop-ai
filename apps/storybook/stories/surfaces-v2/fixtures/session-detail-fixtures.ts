import {
  type AgentSessionDetail,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { createAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { liveAppShellRoutes } from "./live-app-fixtures";

// The live Session Detail (`apps/app/.../sessions/[id]/page.tsx`) reads the
// session (`GET /agent-sessions/:id`) and its trace comments
// (`GET /agent-sessions/:id/trace-comments`, a plain array). The session is
// the shared populated detail fixture with the PRs and branch link a shipped
// session carries.

export const sessionDetailFixture: AgentSessionDetail =
  createAgentSessionDetailFixture({
    branchArtifactId: "branch-fea-1707",
    prs: [
      {
        num: 6921,
        status: SessionPrLifecycleStatus.Merged,
        title: "Shared agent sessions detail foundation",
      },
      {
        num: 6934,
        status: SessionPrLifecycleStatus.Open,
        title: "Session detail trace comments",
      },
    ],
    prsMerged: 1,
  });

export const SESSION_DETAIL_ID = sessionDetailFixture.id;

/** The same session while it is still running on the compute target. */
export const runningSessionDetailFixture: AgentSessionDetail = {
  ...sessionDetailFixture,
  endedAt: null,
  status: SESSION_STATUS.ACTIVE,
};

const FIRST_PROMPT = "Please inspect the shared session detail screen.";

function traceComment(
  index: number,
  selectedText: string,
  body: string,
  author: { id: string; name: string }
): TraceComment {
  const createdAt = new Date(Date.UTC(2026, 5, 10, 12, 30 + index));
  const startOffset = FIRST_PROMPT.indexOf(selectedText);
  return {
    anchor: {
      actor: { human: "Ada Lovelace", name: null },
      endOffset: startOffset + selectedText.length,
      row: 0,
      selectedText,
      sessionId: SESSION_DETAIL_ID,
      sourceText: FIRST_PROMPT,
      startOffset,
      traceId: `${SESSION_DETAIL_ID}:row-0`,
      turnId: `${SESSION_DETAIL_ID}:turn-0`,
    },
    artifactId: SESSION_DETAIL_ID,
    authorAvatarUrl: null,
    authorId: author.id,
    authorName: author.name,
    body,
    canDelete: author.id === "user_test",
    canEdit: author.id === "user_test",
    createdAt: createdAt.toISOString(),
    editedAt: null,
    id: `trace-comment-${index}`,
    kind: TraceCommentKind.Comment,
    replies: [],
    resolvedAt: null,
    resolvedByAvatarUrl: null,
    resolvedById: null,
    resolvedByName: null,
    status: ThreadStatus.Open,
    surface: CommentSurface.SessionDetail,
    target: { id: SESSION_DETAIL_ID, type: CommentTargetType.Session },
    threadId: `trace-thread-${index}`,
    updatedAt: createdAt.toISOString(),
  };
}

export const sessionTraceCommentsFixture: TraceComment[] = [
  traceComment(
    1,
    "shared session detail screen",
    "This is the screen the desktop and web shells both mount; check both.",
    { id: "user-priya", name: "Priya Shah" }
  ),
  traceComment(
    2,
    "inspect",
    "Worth adding the trace comments rail to the inspection pass too.",
    { id: "user_test", name: "Dana Reyes" }
  ),
];

/** The reads the live Session Detail makes, answered for `session`. */
export function sessionDetailRoutes(
  session: AgentSessionDetail,
  comments: TraceComment[] = sessionTraceCommentsFixture
): FixtureRoute[] {
  return [
    ...liveAppShellRoutes,
    {
      method: "GET",
      path: `/agent-sessions/${session.id}/trace-comments`,
      respond: () => comments,
    },
    {
      method: "GET",
      path: `/agent-sessions/${session.id}`,
      respond: () => session,
    },
  ];
}

export const sessionDetailApiRoutes = sessionDetailRoutes(sessionDetailFixture);
