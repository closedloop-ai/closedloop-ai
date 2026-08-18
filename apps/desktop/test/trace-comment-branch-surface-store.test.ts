import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import {
  createLocalTraceComment,
  createLocalTraceCommentReply,
  deleteLocalTraceComment,
  listLocalTraceComments,
  listPendingLocalTraceCommentOperations,
  listPendingLocalTraceCommentTargets,
  updateLocalTraceComment,
  upsertCloudTraceComments,
} from "../src/main/trace-comments/shared-trace-comments-store.js";
import type { SharedTraceCommentStoreTarget } from "../src/shared/shared-trace-comments-contract.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const handles: OpenTestPrisma[] = [];
const BRANCH_ID = "acme%2Fweb::feature%2Fx";
const NOT_FOUND_ERROR = /not found/i;
const branchDetailTarget: SharedTraceCommentStoreTarget = {
  type: TraceCommentTargetType.Branch,
  id: BRANCH_ID,
  surface: TraceCommentSurface.BranchDetail,
};
const branchTimelineTarget: SharedTraceCommentStoreTarget = {
  ...branchDetailTarget,
  surface: TraceCommentSurface.BranchTimeline,
};

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
});

describe("Desktop Branch trace-comment surfaces", () => {
  test("persists and lists Branch detail and timeline comments separately", async () => {
    const { prisma } = await openStore();
    await createLocalTraceComment(
      prisma,
      branchDetailTarget,
      { anchor: anchor("detail"), body: "Detail comment" },
      null
    );
    const timeline = await createLocalTraceComment(
      prisma,
      branchTimelineTarget,
      { anchor: anchor("timeline"), body: "Timeline comment" },
      null
    );

    assert.equal(timeline.surface, TraceCommentSurface.BranchTimeline);
    assert.deepEqual(
      (await listLocalTraceComments(prisma, branchDetailTarget)).map(
        ({ body }) => body
      ),
      ["Detail comment"]
    );
    assert.deepEqual(
      (await listLocalTraceComments(prisma, branchTimelineTarget)).map(
        ({ body }) => body
      ),
      ["Timeline comment"]
    );
  });

  test("pending discovery and upload operations retain the exact Branch surface", async () => {
    const { prisma } = await openStore();
    await createLocalTraceComment(
      prisma,
      branchDetailTarget,
      { anchor: anchor("detail"), body: "Detail pending" },
      null
    );
    await createLocalTraceComment(
      prisma,
      branchTimelineTarget,
      { anchor: anchor("timeline"), body: "Timeline pending" },
      null
    );

    const targets = await listPendingLocalTraceCommentTargets(prisma);
    assert.deepEqual(
      targets.map(
        (target) => (target as SharedTraceCommentStoreTarget).surface
      ),
      [TraceCommentSurface.BranchDetail, TraceCommentSurface.BranchTimeline]
    );
    const [timelineOperation] = await listPendingLocalTraceCommentOperations(
      prisma,
      branchTimelineTarget
    );
    assert.equal(
      timelineOperation.comment.surface,
      TraceCommentSurface.BranchTimeline
    );
  });

  test("rejects an older cloud's wrong-surface response without polluting timeline", async () => {
    const { prisma } = await openStore();
    await upsertCloudTraceComments(
      prisma,
      branchTimelineTarget,
      [cloudBranchComment(TraceCommentSurface.BranchDetail)],
      null
    );

    assert.deepEqual(
      await listLocalTraceComments(prisma, branchTimelineTarget),
      []
    );
  });

  test("does not mutate a timeline row through Branch-detail predicates", async () => {
    const { prisma } = await openStore();
    const timeline = await createLocalTraceComment(
      prisma,
      branchTimelineTarget,
      { anchor: anchor("timeline"), body: "Timeline comment" },
      null
    );

    await assert.rejects(
      createLocalTraceCommentReply(
        prisma,
        branchDetailTarget,
        timeline.id,
        { body: "Wrong-surface reply" },
        null
      ),
      NOT_FOUND_ERROR
    );
    await assert.rejects(
      updateLocalTraceComment(
        prisma,
        branchDetailTarget,
        timeline.id,
        { body: "Wrong-surface edit" },
        null
      ),
      NOT_FOUND_ERROR
    );
    await assert.rejects(
      deleteLocalTraceComment(prisma, branchDetailTarget, timeline.id, null),
      NOT_FOUND_ERROR
    );
    assert.deepEqual(
      (await listLocalTraceComments(prisma, branchTimelineTarget)).map(
        ({ body, replies }) => ({ body, replies })
      ),
      [{ body: "Timeline comment", replies: [] }]
    );
  });
});

async function openStore(): Promise<OpenTestPrisma> {
  const handle = await openTestPrisma();
  handles.push(handle);
  return handle;
}

function anchor(traceId: string) {
  return {
    traceId,
    turnId: `turn-${traceId}`,
    row: 1,
    selectedText: "selected",
    sourceText: "selected text",
    startOffset: 0,
    endOffset: 8,
  };
}

function cloudBranchComment(surface: TraceCommentSurface): TraceComment {
  const createdAt = "2026-08-07T12:00:00.000Z";
  return {
    id: "cloud-1",
    threadId: "thread-1",
    target: { type: TraceCommentTargetType.Branch, id: BRANCH_ID },
    artifactId: BRANCH_ID,
    surface,
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    kind: TraceCommentKind.Comment,
    anchor: anchor("cloud"),
    body: "Cloud detail comment",
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    authorId: "user-1",
    authorName: "User",
    authorAvatarUrl: null,
    canEdit: false,
    canDelete: false,
    replies: [],
  };
}
