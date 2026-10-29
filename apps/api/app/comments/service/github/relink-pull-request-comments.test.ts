import { GitHubCommentThreadKind, ThreadSource } from "@repo/database";
import { parseChannelAddress } from "@repo/realtime-contract/channels";
import { parseSignalEnvelope } from "@repo/realtime-contract/signal";
import {
  CommentSignalType,
  commentThreadSignalDataSchema,
} from "@repo/realtime-contract/signals";
import { describe, expect, it, vi } from "vitest";
import { relinkPullRequestBranchInTransaction } from "@/app/branches/pull-request-branch-relink";
import { relinkPullRequestComments } from "./relink-pull-request-comments";

const ORGANIZATION_ID = "019ff900-4000-7000-8000-000000000001";
const SOURCE_PULL_REQUEST_ID = "019ff900-4000-7000-8000-000000000002";
const TARGET_PULL_REQUEST_ID = "019ff900-4000-7000-8000-000000000003";
const SOURCE_BRANCH_ID = "019ff900-4000-7000-8000-000000000004";
const TARGET_BRANCH_ID = "019ff900-4000-7000-8000-000000000005";
const THREAD_ID = "019ff900-4000-7000-8000-000000000006";
const STAGING_THREAD_ID = "019ff900-4000-7000-8000-000000000007";
const MOVED_REVISION = 4;

describe("pull request comment projection relink", () => {
  it("moves the original thread and restores its provider comment children", async () => {
    const childProjection = {
      commentId: "019ff900-4000-7000-8000-000000000008",
      threadId: THREAD_ID,
      externalAuthorId: null,
      githubCommentId: "6980001",
      githubInReplyToCommentId: null,
      githubHtmlUrl: null,
      githubUpdatedAt: null,
      githubDeletedAt: null,
      fetchCredentialType: null,
      fetchCredentialOwnerId: null,
      fetchMechanism: null,
      fetchTrigger: null,
      fetchObservedAt: null,
      fetchResultReason: null,
    };
    const tx = createClient();
    tx.gitHubCommentThreadProjection.findMany
      .mockResolvedValueOnce([
        {
          threadId: THREAD_ID,
          branchArtifactId: SOURCE_BRANCH_ID,
          threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
          rootCommentId: "root-6980",
          reviewThreadId: "review-thread-6980",
        },
      ])
      .mockResolvedValueOnce([]);
    tx.gitHubCommentProjection.findMany.mockResolvedValue([childProjection]);

    await relinkPullRequestComments(tx as never, {
      organizationId: ORGANIZATION_ID,
      sourcePullRequestDetailId: SOURCE_PULL_REQUEST_ID,
      targetPullRequestDetailId: TARGET_PULL_REQUEST_ID,
      targetBranchArtifactId: TARGET_BRANCH_ID,
    });

    expect(tx.gitHubCommentProjection.deleteMany).toHaveBeenCalledWith({
      where: {
        threadId: THREAD_ID,
        threadProjection: {
          pullRequestDetail: { organizationId: ORGANIZATION_ID },
        },
      },
    });
    expect(tx.gitHubCommentThreadProjection.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        where: {
          threadId: THREAD_ID,
          pullRequestDetailId: SOURCE_PULL_REQUEST_ID,
          pullRequestDetail: { organizationId: ORGANIZATION_ID },
        },
        data: {
          threadId: STAGING_THREAD_ID,
          branchArtifactId: TARGET_BRANCH_ID,
          pullRequestDetailId: TARGET_PULL_REQUEST_ID,
        },
      }
    );
    expect(tx.commentThread.updateMany).toHaveBeenCalledWith({
      where: {
        id: THREAD_ID,
        organizationId: ORGANIZATION_ID,
        artifactId: SOURCE_BRANCH_ID,
        source: ThreadSource.GITHUB,
      },
      data: { artifactId: TARGET_BRANCH_ID },
    });
    expect(tx.gitHubCommentThreadProjection.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        where: {
          threadId: STAGING_THREAD_ID,
          pullRequestDetailId: TARGET_PULL_REQUEST_ID,
          pullRequestDetail: { organizationId: ORGANIZATION_ID },
        },
        data: { threadId: THREAD_ID },
      }
    );
    expect(tx.gitHubCommentProjection.createMany).toHaveBeenCalledWith({
      data: [childProjection],
    });
    expect(tx.commentThread.deleteMany).toHaveBeenCalledWith({
      where: { id: STAGING_THREAD_ID, organizationId: ORGANIZATION_ID },
    });
  });

  it("signals a thread moved across branches on both branch channels at one new revision", async () => {
    const tx = createClient();
    tx.gitHubCommentProjection.deleteMany.mockResolvedValue({ count: 0 });
    tx.gitHubCommentThreadProjection.findMany
      .mockResolvedValueOnce([sourceProjection(SOURCE_BRANCH_ID)])
      .mockResolvedValueOnce([]);

    await relinkPullRequestComments(tx as never, relinkInput());

    expect(tx.commentThread.update).toHaveBeenCalledTimes(1);
    expect(tx.commentThread.update).toHaveBeenCalledWith({
      where: { id: THREAD_ID },
      data: { revision: { increment: 1 } },
      select: { revision: true },
    });
    expect(signalledChannels(tx)).toEqual([
      movedSignal(TARGET_BRANCH_ID),
      movedSignal(SOURCE_BRANCH_ID),
    ]);
  });

  it("signals a thread that only changes pull request once, on its branch", async () => {
    const tx = createClient();
    tx.gitHubCommentThreadProjection.findMany
      .mockResolvedValueOnce([sourceProjection(TARGET_BRANCH_ID)])
      .mockResolvedValueOnce([]);

    await relinkPullRequestComments(tx as never, relinkInput());

    expect(signalledChannels(tx)).toEqual([movedSignal(TARGET_BRANCH_ID)]);
  });

  it("moves a thread without a revision or a signal when the move only finishes one already signalled", async () => {
    const tx = createClient();
    tx.gitHubCommentThreadProjection.findMany
      .mockResolvedValueOnce([sourceProjection(TARGET_BRANCH_ID)])
      .mockResolvedValueOnce([]);

    await relinkPullRequestComments(tx as never, {
      ...relinkInput(),
      signalMoves: false,
    });

    expect(tx.gitHubCommentThreadProjection.updateMany).toHaveBeenCalled();
    expect(tx.commentThread.update).not.toHaveBeenCalled();
    expect(signalledChannels(tx)).toEqual([]);
  });

  it("fails closed before mutation when provider thread identities collide", async () => {
    const tx = createClient();
    const projection = {
      threadId: THREAD_ID,
      branchArtifactId: SOURCE_BRANCH_ID,
      threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
      rootCommentId: "root-6980",
      reviewThreadId: "review-thread-6980",
    };
    tx.gitHubCommentThreadProjection.findMany
      .mockResolvedValueOnce([projection])
      .mockResolvedValueOnce([
        {
          ...projection,
          threadId: STAGING_THREAD_ID,
          branchArtifactId: TARGET_BRANCH_ID,
        },
      ]);

    await expect(
      relinkPullRequestComments(tx as never, {
        organizationId: ORGANIZATION_ID,
        sourcePullRequestDetailId: SOURCE_PULL_REQUEST_ID,
        targetPullRequestDetailId: TARGET_PULL_REQUEST_ID,
        targetBranchArtifactId: TARGET_BRANCH_ID,
      })
    ).rejects.toThrow("pull request comment projection identity conflict");
    expect(tx.gitHubCommentThreadProjection.updateMany).not.toHaveBeenCalled();
    expect(tx.commentThread.create).not.toHaveBeenCalled();
  });

  it("stages comment ownership before changing the PR Branch association", async () => {
    const tx = createAssociationClient();

    await expect(
      relinkPullRequestBranchInTransaction(tx as never, {
        organizationId: ORGANIZATION_ID,
        pullRequestDetailId: SOURCE_PULL_REQUEST_ID,
        branchArtifactId: TARGET_BRANCH_ID,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        pullRequestNumber: 6980,
      })
    ).resolves.toBe(true);

    expect(tx.pullRequestDetail.create).toHaveBeenCalledWith({
      data: {
        branchArtifactId: TARGET_BRANCH_ID,
        organizationId: ORGANIZATION_ID,
        number: 6980,
        isCurrent: false,
      },
      select: { id: true },
    });
    expect(tx.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: {
        id: SOURCE_PULL_REQUEST_ID,
        organizationId: ORGANIZATION_ID,
        branchArtifactId: SOURCE_BRANCH_ID,
      },
      data: { branchArtifactId: TARGET_BRANCH_ID, isCurrent: false },
    });
    expect(tx.pullRequestDetail.deleteMany).toHaveBeenCalledWith({
      where: {
        id: TARGET_PULL_REQUEST_ID,
        organizationId: ORGANIZATION_ID,
      },
    });
    expect(tx.gitHubCommentThreadProjection.findMany).toHaveBeenCalledTimes(4);
  });
});

function createClient() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    commentThread: {
      create: vi.fn().mockResolvedValue({ id: STAGING_THREAD_ID }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({ revision: MOVED_REVISION }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    gitHubCommentProjection: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    gitHubCommentThreadProjection: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ threadId: THREAD_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function sourceProjection(branchArtifactId: string) {
  return {
    threadId: THREAD_ID,
    branchArtifactId,
    threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
    rootCommentId: "root-6980",
    reviewThreadId: "review-thread-6980",
  };
}

function relinkInput() {
  return {
    organizationId: ORGANIZATION_ID,
    sourcePullRequestDetailId: SOURCE_PULL_REQUEST_ID,
    targetPullRequestDetailId: TARGET_PULL_REQUEST_ID,
    targetBranchArtifactId: TARGET_BRANCH_ID,
  };
}

function movedSignal(artifactId: string) {
  return {
    type: CommentSignalType.ThreadUpdated,
    threadId: THREAD_ID,
    artifactId,
    threadRevision: MOVED_REVISION,
  };
}

/** The signal, channel and revision of every `pg_notify` the relink queued. */
function signalledChannels(tx: ReturnType<typeof createClient>) {
  return tx.$executeRaw.mock.calls.map((call) => {
    const envelope = parseSignalEnvelope(String(call[2]));
    if (!envelope.success) {
      throw new Error("relink queued an unparseable signal");
    }
    const data = commentThreadSignalDataSchema.parse(envelope.envelope.d);
    return {
      type: envelope.envelope.t,
      threadId: data.threadId,
      artifactId: parseChannelAddress(envelope.envelope.c)?.scope[0],
      threadRevision: data.threadRevision,
    };
  });
}

function createAssociationClient() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([
        {
          branchArtifactId: SOURCE_BRANCH_ID,
          organizationId: ORGANIZATION_ID,
          repositoryFullName: "closedloop-ai/closedloop-ai",
          number: 6980,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ artifactId: SOURCE_BRANCH_ID }])
      .mockResolvedValueOnce([{ artifactId: TARGET_BRANCH_ID }])
      .mockResolvedValueOnce([]),
    artifactLink: {
      delete: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    branchActivityAtom: {
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
    branchDetail: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    commentThread: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
    gitHubCommentProjection: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    gitHubCommentThreadProjection: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    pullRequestDetail: {
      create: vi.fn().mockResolvedValue({ id: TARGET_PULL_REQUEST_ID }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}
