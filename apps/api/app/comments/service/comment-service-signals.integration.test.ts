/**
 * ISS-11212 (PLN-2121 Step 4, acceptance criterion 2): every comment command
 * signals each thread it changed exactly once on commit, and nothing on a
 * rollback or a no-op, observed through a real Postgres `LISTEN`. A sentinel
 * committed after the command arrives after anything the command delivered,
 * because Postgres delivers notifications in commit order, so absence is
 * asserted without a fixed wait.
 */
import { randomUUID } from "node:crypto";
import { CommentAnchorState } from "@repo/api/src/types/comment-anchor";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import {
  parseSignalEnvelope,
  REALTIME_SIGNAL_CHANNEL,
  type SignalEnvelope,
} from "@repo/realtime-contract/signal";
import {
  CommentSignalType,
  commentThreadSignalDataSchema,
} from "@repo/realtime-contract/signals";
import { emitSignal } from "@repo/realtime-server/emit-signal";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
  type CommentTestOrg,
  commentTraceAnchor,
  seedCommentTestOrg,
} from "@/__tests__/support/comments/comment-service.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { commentsService } from "@/app/comments/service";
import {
  type CommentViewer,
  createCommentLiveState,
} from "./comment-capabilities";
import { presentCommentThreadDto } from "./comment-read";
import type { CommentTarget } from "./comment-target";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();
const NOTIFICATION_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 20;
const ROLLBACK = new Error("rollback requested by test");

type Signal = { type: string; threadId: string; threadRevision: number };

describeIfDb("comment service: realtime signals", () => {
  let org: CommentTestOrg;
  let listener: Client;
  const received: SignalEnvelope[] = [];
  const sentinels = new Set<string>();

  beforeAll(async () => {
    org = await seedCommentTestOrg(tracker);
    listener = new Client({ connectionString: keys().DATABASE_URL });
    await listener.connect();
    listener.on("notification", (message) => {
      const parsed = parseSignalEnvelope(message.payload ?? "");
      if (parsed.success) {
        received.push(parsed.envelope);
      }
    });
    await listener.query(`LISTEN ${REALTIME_SIGNAL_CHANNEL}`);
  });

  afterAll(async () => {
    await listener?.end();
    await tracker.cleanup();
  });

  function presenter(viewer: CommentViewer, target: CommentTarget) {
    return presentCommentThreadDto({
      viewer,
      target,
      liveState: createCommentLiveState(viewer),
    });
  }

  async function createThread(clientId = randomUUID()) {
    const created = await commentsService.createThread({
      viewer: org.author,
      target: org.session,
      anchor: commentTraceAnchor(1),
      body: "root",
      clientId,
      present: presenter(org.author, org.session),
    });
    if (!created.ok) {
      throw new Error(`expected a thread, got ${created.error}`);
    }
    return created.value;
  }

  /** Every signal on an artifact's channel since the previous call, in order. */
  async function drainSignals(
    artifactId = org.session.artifactId
  ): Promise<Signal[]> {
    const channel = formatChannelAddress(
      ChannelKind.Comments,
      org.organizationId,
      [artifactId]
    );
    const sentinel = randomUUID();
    sentinels.add(sentinel);
    await withDb.tx((tx) =>
      emitSignal(tx, channel, {
        type: CommentSignalType.ThreadUpdated,
        data: { threadId: sentinel, threadRevision: 0 },
      })
    );
    const deadline = Date.now() + NOTIFICATION_WAIT_MS;
    const isSentinel = (envelope: SignalEnvelope) =>
      envelope.c === channel &&
      commentThreadSignalDataSchema.parse(envelope.d).threadId === sentinel;
    while (!received.some(isSentinel)) {
      if (Date.now() > deadline) {
        throw new Error("No sentinel notification arrived");
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    const drained = received.splice(0, received.findIndex(isSentinel) + 1);
    return drained.flatMap((envelope) => {
      if (envelope.c !== channel) {
        return [];
      }
      const data = commentThreadSignalDataSchema.parse(envelope.d);
      return sentinels.has(data.threadId)
        ? []
        : [{ type: envelope.t, ...data }];
    });
  }

  it("signals thread.created at revision 0 for a new thread, and nothing for its replay", async () => {
    await drainSignals();
    const clientId = randomUUID();

    const thread = await createThread(clientId);
    expect(await drainSignals()).toEqual([
      {
        type: CommentSignalType.ThreadCreated,
        threadId: thread.id,
        threadRevision: 0,
      },
    ]);

    await createThread(clientId);
    expect(await drainSignals()).toEqual([]);
  });

  it("signals thread.updated once per reply, edit and delete with the revision each reached", async () => {
    const thread = await createThread();
    await drainSignals();
    const rootId = (thread.comments[0] as CommentThreadDto["comments"][number])
      .id;

    await commentsService.reply({
      viewer: org.other,
      target: org.session,
      thread: { threadId: thread.id },
      body: "reply",
      clientId: randomUUID(),
      present: presenter(org.other, org.session),
    });
    await commentsService.editComment({
      viewer: org.author,
      target: org.session,
      commentId: rootId,
      body: "edited",
      expectedRevision: 0,
      present: presenter(org.author, org.session),
    });
    await commentsService.deleteComment({
      viewer: org.author,
      target: org.session,
      commentId: rootId,
    });

    expect(await drainSignals()).toEqual(
      [1, 2, 3].map((threadRevision) => ({
        type: CommentSignalType.ThreadUpdated,
        threadId: thread.id,
        threadRevision,
      }))
    );
  });

  it("signals the sync-state commands only when they change the thread", async () => {
    const thread = await createThread();
    await drainSignals();
    const syncCommand = { viewer: org.author, target: org.session };
    const locator = { comment: { threadId: thread.id } };
    const present = presenter(org.author, org.session);

    await commentsService.retrySync({ ...syncCommand, ...locator, present });
    expect(await drainSignals()).toEqual([]);

    await commentsService.markSyncAbandoned({
      ...syncCommand,
      ...locator,
      present,
    });
    await commentsService.markSyncAbandoned({
      ...syncCommand,
      ...locator,
      present,
    });
    await commentsService.retrySync({ ...syncCommand, ...locator, present });

    expect(await drainSignals()).toEqual(
      [1, 2].map((threadRevision) => ({
        type: CommentSignalType.ThreadUpdated,
        threadId: thread.id,
        threadRevision,
      }))
    );
  });

  it("signals a reanchor as thread.updated", async () => {
    const thread = await createThread();
    await drainSignals();

    const reanchored = await commentsService.reanchor({
      organizationId: org.organizationId,
      threadId: thread.id,
      anchor: commentTraceAnchor(2),
      anchorState: CommentAnchorState.Moved,
      liveState: createCommentLiveState(org.author),
    });

    expect(reanchored).toEqual({ ok: true, value: { threadId: thread.id } });
    expect(await drainSignals()).toEqual([
      {
        type: CommentSignalType.ThreadUpdated,
        threadId: thread.id,
        threadRevision: 1,
      },
    ]);
  });

  it("signals nothing for a stale edit or a refused resolve", async () => {
    const thread = await createThread();
    const branchThread = await commentsService.createThread({
      viewer: org.author,
      target: org.branch,
      anchor: commentTraceAnchor(1),
      body: "branch root",
      clientId: randomUUID(),
      present: presenter(org.author, org.branch),
    });
    if (!branchThread.ok) {
      throw new Error(`expected a thread, got ${branchThread.error}`);
    }
    await drainSignals();
    await drainSignals(org.branch.artifactId);

    const stale = await commentsService.editComment({
      viewer: org.author,
      target: org.session,
      commentId: thread.comments[0]?.id as string,
      body: "stale",
      expectedRevision: 7,
      present: presenter(org.author, org.session),
    });
    // A native Branch thread grants no resolve.
    const resolved = await commentsService.resolveCommentThread({
      viewer: org.author,
      threadId: branchThread.value.id,
      present: presenter(org.author, org.branch),
    });

    expect(stale).toEqual({ ok: false, error: CommentErrorCode.StaleRevision });
    expect(resolved).toEqual({
      ok: false,
      error: CommentErrorCode.CapabilityDenied,
    });
    expect(await drainSignals()).toEqual([]);
    expect(await drainSignals(org.branch.artifactId)).toEqual([]);
  });

  it("signals a Session resolve and reopen once each, and nothing for a repeat", async () => {
    const thread = await createThread();
    await drainSignals();
    const command = {
      viewer: org.other,
      threadId: thread.id,
      present: presenter(org.other, org.session),
    };

    await commentsService.resolveCommentThread(command);
    await commentsService.resolveCommentThread({
      ...command,
      viewer: org.author,
      present: presenter(org.author, org.session),
    });
    await commentsService.reopenCommentThread(command);
    await commentsService.reopenCommentThread(command);

    expect(await drainSignals()).toEqual(
      [1, 2].map((threadRevision) => ({
        type: CommentSignalType.ThreadUpdated,
        threadId: thread.id,
        threadRevision,
      }))
    );
  });

  it("signals nothing when the command's transaction rolls back after its write", async () => {
    await drainSignals();
    const clientId = randomUUID();

    await expect(
      commentsService.createThread({
        viewer: org.author,
        target: org.session,
        anchor: commentTraceAnchor(1),
        body: "rolled back",
        clientId,
        present: () => Promise.reject(ROLLBACK),
      })
    ).rejects.toBe(ROLLBACK);

    expect(await drainSignals()).toEqual([]);
    const rows = await withDb((db) =>
      db.commentThread.count({
        where: { organizationId: org.organizationId, externalId: clientId },
      })
    );
    expect(rows).toBe(0);
  });
});
