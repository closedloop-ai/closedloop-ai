import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import {
  CommentCapability,
  CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import {
  CommentSyncDirection,
  CommentSyncProvider,
  CommentSyncStatus,
} from "@repo/api/src/types/comment-thread-dto";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("./comment-thread-signal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./comment-thread-signal")>()),
  emitThreadChangeSignal: vi.fn(),
}));

import { getMockWithDb, mockWithDbTx } from "@/__tests__/utils/db-helpers";
import type { CommentLiveState } from "./comment-capabilities";
import {
  COMMENT_OUTBOUND_SYNC_PROVIDERS,
  type CommentCommand,
  runCommentCommand,
} from "./comment-command-pipeline";
import { CommentArtifactType } from "./comment-target";
import {
  emitThreadChangeSignal,
  ThreadChangeKind,
} from "./comment-thread-signal";

const ORG_ID = "org-1";
const target = {
  organizationId: ORG_ID,
  artifactId: "artifact-1",
  artifactType: CommentArtifactType.Session,
};
/** A capability a source denies: native Branch threads grant no resolve. */
const branchResolve = {
  target: { ...target, artifactType: CommentArtifactType.Branch },
  policyKey: CommentPolicyKey.NativeBranch,
  capability: CommentCapability.Resolve,
};
const allowed: CommentLiveState = {
  isStaff: () => Promise.resolve(false),
};
const traceAnchor = {
  kind: CommentAnchorKind.Trace,
  traceId: "trace-1",
  turnId: "turn-1",
  row: 0,
  selectedText: "quote",
  sourceText: "a quote",
  startOffset: 2,
  endOffset: 7,
};

let tx: {
  commentThread: { update: ReturnType<typeof vi.fn> };
  commentSyncState: { upsert: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    commentThread: { update: vi.fn().mockResolvedValue({ revision: 1 }) },
    commentSyncState: { upsert: vi.fn().mockResolvedValue({ id: "sync-1" }) },
  };
  mockWithDbTx(tx);
});

function command(
  overrides: Partial<CommentCommand<string>> = {}
): CommentCommand<string> {
  return {
    target,
    policyKey: CommentPolicyKey.NativeSession,
    liveState: allowed,
    capability: CommentCapability.Reply,
    write: () =>
      Promise.resolve(
        Result.ok({
          changes: [{ threadId: "thread-1", kind: ThreadChangeKind.Updated }],
          present: () => Promise.resolve("presented"),
        })
      ),
    ...overrides,
  };
}

describe("runCommentCommand", () => {
  it("refuses a capability the source denies before opening a transaction", async () => {
    const write = vi
      .fn()
      .mockResolvedValue(
        Result.ok({ changes: [], present: () => Promise.resolve("presented") })
      );

    const result = await runCommentCommand(
      command({ ...branchResolve, write })
    );

    expect(result).toEqual({
      ok: false,
      error: CommentErrorCode.CapabilityDenied,
    });
    expect(write).not.toHaveBeenCalled();
    expect(getMockWithDb().tx).not.toHaveBeenCalled();
  });

  it("refuses an anchor of a kind the source does not allow before writing", async () => {
    const write = vi
      .fn()
      .mockResolvedValue(
        Result.ok({ changes: [], present: () => Promise.resolve("presented") })
      );

    const result = await runCommentCommand(
      command({
        anchor: { kind: CommentAnchorKind.Artifact },
        write,
      })
    );

    expect(result).toEqual({
      ok: false,
      error: CommentErrorCode.AnchorKindNotAllowed,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("hands the write the validated anchor", async () => {
    const write = vi
      .fn()
      .mockResolvedValue(
        Result.ok({ changes: [], present: () => Promise.resolve("presented") })
      );

    await runCommentCommand(command({ anchor: traceAnchor, write }));

    expect(write).toHaveBeenCalledWith(tx, { anchor: traceAnchor });
  });

  it("bumps an updated thread's revision once, in the transaction, before presenting", async () => {
    const order: string[] = [];
    tx.commentThread.update.mockImplementation(() => {
      order.push("revision");
      return Promise.resolve({ revision: 1 });
    });

    const result = await runCommentCommand(
      command({
        write: () =>
          Promise.resolve(
            Result.ok({
              changes: [
                { threadId: "thread-1", kind: ThreadChangeKind.Updated },
              ],
              present: () => {
                order.push("present");
                return Promise.resolve("presented");
              },
            })
          ),
      })
    );

    expect(result).toEqual({ ok: true, value: "presented" });
    expect(tx.commentThread.update).toHaveBeenCalledTimes(1);
    expect(tx.commentThread.update).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: { revision: { increment: 1 } },
      select: { revision: true },
    });
    expect(order).toEqual(["revision", "present"]);
  });

  it("leaves a created thread at revision 0 and a replay untouched", async () => {
    await runCommentCommand(
      command({
        write: () =>
          Promise.resolve(
            Result.ok({
              changes: [
                {
                  threadId: "thread-1",
                  kind: ThreadChangeKind.Created,
                  revision: 0,
                },
              ],
              present: () => Promise.resolve("presented"),
            })
          ),
      })
    );
    await runCommentCommand(
      command({
        write: () =>
          Promise.resolve(
            Result.ok({
              changes: [],
              present: () => Promise.resolve("presented"),
            })
          ),
      })
    );

    expect(tx.commentThread.update).not.toHaveBeenCalled();
  });

  it("marks outbound sync PENDING for a source that syncs out, and not otherwise", async () => {
    await runCommentCommand(command());
    expect(tx.commentSyncState.upsert).not.toHaveBeenCalled();

    await runCommentCommand(
      command({
        outboundSyncProviders: {
          ...COMMENT_OUTBOUND_SYNC_PROVIDERS,
          [CommentPolicyKey.NativeSession]: CommentSyncProvider.Liveblocks,
        },
      })
    );

    expect(tx.commentSyncState.upsert).toHaveBeenCalledTimes(1);
    expect(tx.commentSyncState.upsert).toHaveBeenCalledWith({
      where: {
        threadId_provider_direction: {
          threadId: "thread-1",
          provider: CommentSyncProvider.Liveblocks,
          direction: CommentSyncDirection.Outbound,
        },
      },
      create: {
        organizationId: ORG_ID,
        threadId: "thread-1",
        provider: CommentSyncProvider.Liveblocks,
        direction: CommentSyncDirection.Outbound,
        state: CommentSyncStatus.Pending,
      },
      update: { state: CommentSyncStatus.Pending },
      select: { id: true },
    });
  });

  it("runs the after-commit hook only for a write that succeeded and presented", async () => {
    const afterCommit = vi.fn().mockResolvedValue(undefined);

    await runCommentCommand(
      command({
        write: () =>
          Promise.resolve(
            Result.ok({
              changes: [],
              present: () => Promise.resolve(null),
              afterCommit,
            })
          ),
      })
    );
    await runCommentCommand(
      command({
        write: () =>
          Promise.resolve(Result.err(CommentErrorCode.ClientIdConflict)),
      })
    );
    expect(afterCommit).not.toHaveBeenCalled();

    const result = await runCommentCommand(
      command({
        write: () =>
          Promise.resolve(
            Result.ok({
              changes: [],
              present: () => Promise.resolve("presented"),
              afterCommit,
            })
          ),
      })
    );
    expect(result.ok).toBe(true);
    expect(afterCommit).toHaveBeenCalledTimes(1);
  });

  it("signals each changed thread once, with the revision it reached, before presenting", async () => {
    const order: string[] = [];
    vi.mocked(emitThreadChangeSignal).mockImplementation(() => {
      order.push("signal");
      return Promise.resolve();
    });

    await runCommentCommand(
      command({
        write: () =>
          Promise.resolve(
            Result.ok({
              changes: [
                {
                  threadId: "thread-new",
                  kind: ThreadChangeKind.Created,
                  revision: 0,
                },
                { threadId: "thread-1", kind: ThreadChangeKind.Updated },
              ],
              present: () => {
                order.push("present");
                return Promise.resolve("presented");
              },
            })
          ),
      })
    );

    expect(vi.mocked(emitThreadChangeSignal).mock.calls).toEqual([
      [
        tx,
        target,
        ThreadChangeKind.Created,
        { threadId: "thread-new", threadRevision: 0 },
      ],
      [
        tx,
        target,
        ThreadChangeKind.Updated,
        { threadId: "thread-1", threadRevision: 1 },
      ],
    ]);
    expect(order).toEqual(["signal", "signal", "present"]);
  });

  it("signals nothing for a write that changed nothing or was refused", async () => {
    await runCommentCommand(
      command({
        write: () =>
          Promise.resolve(
            Result.ok({
              changes: [],
              present: () => Promise.resolve("presented"),
            })
          ),
      })
    );
    await runCommentCommand(
      command({
        write: () =>
          Promise.resolve(Result.err(CommentErrorCode.StaleRevision)),
      })
    );
    await runCommentCommand(command(branchResolve));

    expect(emitThreadChangeSignal).not.toHaveBeenCalled();
  });

  it("answers not_found when the written result cannot be presented", async () => {
    const result = await runCommentCommand(
      command({
        write: () =>
          Promise.resolve(
            Result.ok({ changes: [], present: () => Promise.resolve(null) })
          ),
      })
    );

    expect(result).toEqual({ ok: false, error: CommentErrorCode.NotFound });
  });
});
