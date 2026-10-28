/**
 * ISS-11212 (PLN-2121 Step 6): the legacy trace-comment routes answer installed
 * desktop builds, so moving them onto the comment service must not change a
 * byte of what they return. This drives every legacy route against a real
 * database and compares each response body, verbatim apart from generated ids
 * and timestamps, with a file captured from the routes before the move.
 */
import { randomUUID } from "node:crypto";
import { CommentSurface, TraceCommentKind } from "@repo/api/src/types/comment";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", organizationId: "" },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context: { params: Promise<unknown> }) =>
      handler(
        { user: { ...mocks.user }, clerkUserId: null },
        request,
        context.params
      ),
}));

vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));

vi.mock("@/app/search/search-index-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/search/search-index-service")>();
  return {
    ...actual,
    searchIndexService: {
      ...actual.searchIndexService,
      indexAfterCommit: vi.fn(),
      removeAfterCommit: vi.fn(),
    },
  };
});

import {
  callLegacyRoute,
  type LegacyRouteFixture,
  legacyTraceAnchor,
  normalizeTranscript,
  seedLegacyRouteFixture,
} from "@/__tests__/support/trace-comments/legacy-route.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { POST as sessionRepliesPost } from "@/app/agent-sessions/[id]/trace-comments/[commentId]/replies/route";
import { POST as sessionRetryPost } from "@/app/agent-sessions/[id]/trace-comments/[commentId]/retry-sync/route";
import {
  DELETE as sessionCommentDelete,
  PATCH as sessionCommentPatch,
} from "@/app/agent-sessions/[id]/trace-comments/[commentId]/route";
import { POST as sessionAbandonPost } from "@/app/agent-sessions/[id]/trace-comments/[commentId]/sync-abandoned/route";
import { GET as sessionByClientIdGet } from "@/app/agent-sessions/[id]/trace-comments/by-client-id/[clientId]/route";
import {
  GET as sessionCollectionGet,
  POST as sessionCollectionPost,
} from "@/app/agent-sessions/[id]/trace-comments/route";
import { POST as branchRepliesPost } from "@/app/branches/[id]/trace-comments/[commentId]/replies/route";
import { POST as branchRetryPost } from "@/app/branches/[id]/trace-comments/[commentId]/retry-sync/route";
import {
  DELETE as branchCommentDelete,
  PATCH as branchCommentPatch,
} from "@/app/branches/[id]/trace-comments/[commentId]/route";
import { POST as branchAbandonPost } from "@/app/branches/[id]/trace-comments/[commentId]/sync-abandoned/route";
import { GET as branchByClientIdGet } from "@/app/branches/[id]/trace-comments/by-client-id/[clientId]/route";
import {
  GET as branchCollectionGet,
  POST as branchCollectionPost,
} from "@/app/branches/[id]/trace-comments/route";
import { GET as aggregateGet } from "@/app/trace-comments/route";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const FIXTURE_PATH = "./__fixtures__/legacy-route-responses.txt";

const tracker = createCommittedTestOrganizationTracker();
const runSuffix = randomUUID().slice(0, 8);

describeIfDb("legacy trace-comment routes: response bytes", () => {
  let fixture: LegacyRouteFixture;

  beforeAll(async () => {
    fixture = await seedLegacyRouteFixture(tracker, runSuffix);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it("answers every legacy route with the bytes captured before the service move", async () => {
    const transcript = await runLegacyRouteScript(fixture);
    await expect(normalizeTranscript(transcript)).toMatchFileSnapshot(
      FIXTURE_PATH
    );
  });
});

/** Every legacy route, in the order an installed desktop exercises them. */
async function runLegacyRouteScript(
  fixture: LegacyRouteFixture
): Promise<string[]> {
  const lines: string[] = [];
  const as = (user: { id: string; organizationId: string }) => {
    mocks.user = user;
  };
  const record = async (label: string, response: Promise<Response>) => {
    const resolved = await response;
    const text = await resolved.text();
    lines.push(`${label} ${resolved.status} ${text}`);
    return JSON.parse(text) as { data: unknown };
  };
  const session = { id: fixture.sessionArtifactId };
  const clientId = (name: string) => `${name}-c3fix-${runSuffix}`;

  as(fixture.author);
  const created = await record(
    "session.create",
    callLegacyRoute(sessionCollectionPost, "POST", session, {
      body: {
        anchor: legacyTraceAnchor(1),
        body: "root from author",
        mentions: [fixture.staff.id],
        clientId: clientId("root"),
      },
    })
  );
  const rootId = (created.data as { id: string }).id;
  await record(
    "session.create.replay",
    callLegacyRoute(sessionCollectionPost, "POST", session, {
      body: {
        anchor: legacyTraceAnchor(1),
        body: "root from author",
        clientId: clientId("root"),
      },
    })
  );

  as(fixture.staff);
  const bug = await record(
    "session.create.parsing-bug-by-staff",
    callLegacyRoute(
      sessionCollectionPost,
      "POST",
      { id: fixture.externalSessionId },
      {
        query: `?computeTargetId=${fixture.computeTargetId}`,
        body: {
          anchor: legacyTraceAnchor(2),
          body: "parsing bug from staff",
          kind: TraceCommentKind.ParsingBug,
          clientId: clientId("bug"),
        },
      }
    )
  );
  const bugId = (bug.data as { id: string }).id;
  const reply = await record(
    "session.reply",
    callLegacyRoute(
      sessionRepliesPost,
      "POST",
      { ...session, commentId: rootId },
      {
        body: { body: "reply from staff", clientId: clientId("reply") },
      }
    )
  );
  const replyId = (reply.data as { replies: { id: string }[] }).replies[0]
    ?.id as string;
  await record(
    "session.reply.replay",
    callLegacyRoute(
      sessionRepliesPost,
      "POST",
      { ...session, commentId: rootId },
      {
        body: { body: "reply from staff", clientId: clientId("reply") },
      }
    )
  );
  await record(
    "session.reply.to-a-reply",
    callLegacyRoute(
      sessionRepliesPost,
      "POST",
      { ...session, commentId: replyId },
      {
        body: { body: "nested", clientId: clientId("nested") },
      }
    )
  );

  as(fixture.author);
  await record(
    "session.list",
    callLegacyRoute(sessionCollectionGet, "GET", session)
  );
  await record(
    "session.by-client-id",
    callLegacyRoute(sessionByClientIdGet, "GET", {
      ...session,
      clientId: clientId("root"),
    })
  );
  await record(
    "session.edit.root",
    callLegacyRoute(
      sessionCommentPatch,
      "PATCH",
      { ...session, commentId: rootId },
      {
        body: { body: "root edited" },
      }
    )
  );
  await record(
    "session.edit.other-authors-reply",
    callLegacyRoute(
      sessionCommentPatch,
      "PATCH",
      { ...session, commentId: replyId },
      {
        body: { body: "not mine" },
      }
    )
  );
  await record(
    "session.sync-abandoned",
    callLegacyRoute(sessionAbandonPost, "POST", {
      ...session,
      commentId: rootId,
    })
  );
  await record(
    "session.edit.clears-abandoned",
    callLegacyRoute(
      sessionCommentPatch,
      "PATCH",
      { ...session, commentId: rootId },
      {
        body: { body: "root edited again", mentions: [] },
      }
    )
  );
  await record(
    "session.sync-abandoned.again",
    callLegacyRoute(sessionAbandonPost, "POST", {
      ...session,
      commentId: rootId,
    })
  );
  await record(
    "session.retry-sync",
    callLegacyRoute(sessionRetryPost, "POST", { ...session, commentId: rootId })
  );
  await record(
    "session.retry-sync.on-a-reply",
    callLegacyRoute(sessionRetryPost, "POST", {
      ...session,
      commentId: replyId,
    })
  );
  await record(
    "session.delete.other-authors-root",
    callLegacyRoute(sessionCommentDelete, "DELETE", {
      ...session,
      commentId: bugId,
    })
  );

  as(fixture.staff);
  await record(
    "session.delete.reply",
    callLegacyRoute(sessionCommentDelete, "DELETE", {
      ...session,
      commentId: replyId,
    })
  );
  await record(
    "session.delete.root",
    callLegacyRoute(sessionCommentDelete, "DELETE", {
      ...session,
      commentId: bugId,
    })
  );
  await record(
    "session.list.after-deletes",
    callLegacyRoute(sessionCollectionGet, "GET", session)
  );
  await record(
    "session.list.unknown-target",
    callLegacyRoute(sessionCollectionGet, "GET", { id: randomUUID() })
  );

  const branch = { id: fixture.branchArtifactId };
  const timeline = `?surface=${CommentSurface.BranchTimeline}`;
  const branchRoot = await record(
    "branch.create.timeline",
    callLegacyRoute(branchCollectionPost, "POST", branch, {
      query: timeline,
      body: {
        anchor: legacyTraceAnchor(3),
        body: "branch timeline root",
        clientId: clientId("branch-root"),
      },
    })
  );
  const branchRootId = (branchRoot.data as { id: string }).id;
  await record(
    "branch.create.detail",
    callLegacyRoute(branchCollectionPost, "POST", branch, {
      body: { anchor: legacyTraceAnchor(4), body: "branch detail root" },
    })
  );
  await record(
    "branch.reply.wrong-surface",
    callLegacyRoute(
      branchRepliesPost,
      "POST",
      { ...branch, commentId: branchRootId },
      {
        body: { body: "wrong surface" },
      }
    )
  );
  await record(
    "branch.reply",
    callLegacyRoute(
      branchRepliesPost,
      "POST",
      { ...branch, commentId: branchRootId },
      {
        query: timeline,
        body: { body: "branch reply", mentions: [fixture.author.id] },
      }
    )
  );

  as(fixture.author);
  await record(
    "branch.edit.not-author",
    callLegacyRoute(
      branchCommentPatch,
      "PATCH",
      { ...branch, commentId: branchRootId },
      {
        query: timeline,
        body: { body: "hijack" },
      }
    )
  );

  as(fixture.staff);
  await record(
    "branch.sync-abandoned",
    callLegacyRoute(
      branchAbandonPost,
      "POST",
      { ...branch, commentId: branchRootId },
      {
        query: timeline,
      }
    )
  );
  await record(
    "branch.retry-sync",
    callLegacyRoute(
      branchRetryPost,
      "POST",
      { ...branch, commentId: branchRootId },
      {
        query: timeline,
      }
    )
  );
  await record(
    "branch.list.timeline",
    callLegacyRoute(branchCollectionGet, "GET", branch, { query: timeline })
  );
  await record(
    "branch.list.detail",
    callLegacyRoute(branchCollectionGet, "GET", branch)
  );
  await record(
    "branch.by-client-id",
    callLegacyRoute(
      branchByClientIdGet,
      "GET",
      { ...branch, clientId: clientId("branch-root") },
      { query: timeline }
    )
  );
  await record(
    "branch.delete.root",
    callLegacyRoute(
      branchCommentDelete,
      "DELETE",
      { ...branch, commentId: branchRootId },
      { query: timeline }
    )
  );

  as(fixture.author);
  await record("aggregate.list", callLegacyRoute(aggregateGet, "GET", {}));
  await record(
    "aggregate.list.open-sessions-page",
    callLegacyRoute(
      aggregateGet,
      "GET",
      {},
      {
        query: "?targetType=session&resolved=false&limit=1",
      }
    )
  );

  return lines;
}
