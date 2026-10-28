/**
 * ISS-11212 (PLN-2122 Steps 3 and 5): every GitHub write signals each thread it
 * changed exactly once, through a real Postgres `LISTEN` — one per webhook
 * call, one per changed thread per reconcile chunk, none for a write that
 * changed nothing. A sentinel committed after the write arrives after anything
 * the write delivered, since Postgres delivers notifications in commit order.
 */
import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { GitHubProviderResultStatus } from "@repo/github/provider-result";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyInput,
  at,
  externalComment,
  type GitHubCommentScope,
  issueCommentEvent,
  reviewThreadEvent,
  seedGitHubCommentScope,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { backfillFetchProvenance } from "@/lib/github-fetch-provenance";
import { applyExternal } from "./apply-external";
import { reconcilePullRequestComments } from "./github-comment-reconcile";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();
const NOTIFICATION_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 20;

type Signal = { type: string; threadId: string; threadRevision: number };

describeIfDb("applyExternal: realtime signals", () => {
  let scope: GitHubCommentScope;
  let listener: Client;
  const received: SignalEnvelope[] = [];
  const sentinels = new Set<string>();

  beforeAll(async () => {
    scope = await seedGitHubCommentScope(await tracker.create());
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

  /** Every signal on the branch's comments channel since the previous call. */
  async function drainSignals(): Promise<Signal[]> {
    const channel = formatChannelAddress(
      ChannelKind.Comments,
      scope.organizationId,
      [scope.branchArtifactId]
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

  it("signals thread.created once for a new comment and thread.updated once per later change", async () => {
    await drainSignals();

    const created = await applyExternal(
      applyInput(scope, [issueCommentEvent(101, { providerUpdatedAt: at(1) })])
    );
    const threadId = created.changedThreadIds[0] as string;
    expect(await drainSignals()).toEqual([
      { type: CommentSignalType.ThreadCreated, threadId, threadRevision: 0 },
    ]);

    await applyExternal(
      applyInput(scope, [
        issueCommentEvent(101, {
          bodyMarkdown: "edited",
          providerUpdatedAt: at(2),
        }),
      ])
    );
    expect(await drainSignals()).toEqual([
      { type: CommentSignalType.ThreadUpdated, threadId, threadRevision: 1 },
    ]);
  });

  it("signals nothing for a duplicate delivery or one the ordering guard drops", async () => {
    await applyExternal(
      applyInput(scope, [issueCommentEvent(102, { providerUpdatedAt: at(5) })])
    );
    await drainSignals();

    await applyExternal(
      applyInput(scope, [issueCommentEvent(102, { providerUpdatedAt: at(5) })])
    );
    await applyExternal(
      applyInput(scope, [
        issueCommentEvent(102, {
          bodyMarkdown: "older",
          providerUpdatedAt: at(4),
        }),
      ])
    );

    expect(await drainSignals()).toEqual([]);
  });

  it("signals a thread once per call however many of its comments the call writes", async () => {
    await drainSignals();
    const root = externalComment(201, { providerUpdatedAt: at(1) });
    const replyComment = externalComment(202, {
      githubInReplyToCommentId: 201,
      providerUpdatedAt: at(2),
    });

    // Two events land on the one thread: the first creates it, the second
    // writes the reply into it.
    const result = await applyExternal(
      applyInput(scope, [
        reviewThreadEvent(201, { comments: [root] }),
        reviewThreadEvent(201, { comments: [root, replyComment] }),
      ])
    );

    expect(await drainSignals()).toEqual([
      {
        type: CommentSignalType.ThreadCreated,
        threadId: result.changedThreadIds[0],
        threadRevision: 0,
      },
    ]);
  });

  it("signals each changed thread once per reconcile chunk, and the run reports the count", async () => {
    await drainSignals();
    const ids = [301, 302, 303];

    const result = await reconcilePullRequestComments({
      pullRequestDetailId: scope.pullRequestDetailId,
      prefetched: {
        issueComments: successList(
          ids.map((id) => ({
            id,
            node_id: `IC_${id}`,
            user: {
              id: 4242,
              login: "octocat",
              node_id: "U_4242",
              avatar_url: "",
            },
            body: `issue ${id}`,
            author_association: "MEMBER",
            created_at: at(0).toISOString(),
            updated_at: at(0).toISOString(),
            html_url: `https://github.com/acme/web/pull/42#issuecomment-${id}`,
            deleted_at: null,
            is_deleted: false,
            is_updated: false,
          }))
        ),
        reviewComments: successList([]),
        reviews: successList([]),
        listedAt: new Date(),
        fetchProvenance: backfillFetchProvenance(),
      },
    });

    const signals = await drainSignals();
    // The three new issue-comment threads; the complete lists' cleanup also
    // deletes the comments earlier cases stored and this list no longer holds.
    expect(
      signals.filter(
        (signal) => signal.type === CommentSignalType.ThreadCreated
      )
    ).toHaveLength(ids.length);
    expect(new Set(signals.map((signal) => signal.threadId)).size).toBe(
      signals.length
    );
    expect(result.signals).toBe(signals.length);
  });
});

function successList<T>(items: T[]) {
  return {
    status: GitHubProviderResultStatus.Success,
    value: { items, complete: true },
  } as const;
}
