import { randomUUID } from "node:crypto";
import type { TransactionClient } from "@repo/database";
import { ChannelKind } from "@repo/realtime-contract/channels";
import {
  parseSignalEnvelope,
  REALTIME_SIGNAL_CHANNEL,
} from "@repo/realtime-contract/signal";
import { CommentSignalType } from "@repo/realtime-contract/signals";
import { describe, expect, it, vi } from "vitest";
import { CommentArtifactType } from "./comment-target";
import {
  emitThreadChangeSignal,
  ThreadChangeKind,
} from "./comment-thread-signal";

const target = {
  organizationId: randomUUID(),
  artifactId: randomUUID(),
  artifactType: CommentArtifactType.Session,
};

function fakeTransaction() {
  const executeRaw = vi.fn((..._args: unknown[]) => Promise.resolve(1));
  return {
    tx: { $executeRaw: executeRaw } as unknown as TransactionClient,
    executeRaw,
  };
}

describe("emitThreadChangeSignal", () => {
  it.each([
    [ThreadChangeKind.Created, CommentSignalType.ThreadCreated, 0],
    [ThreadChangeKind.Updated, CommentSignalType.ThreadUpdated, 3],
  ])(
    "queues a %s change as %s on the artifact's comments channel",
    async (kind, type, threadRevision) => {
      const { tx, executeRaw } = fakeTransaction();
      const threadId = randomUUID();

      await emitThreadChangeSignal(tx, target, kind, {
        threadId,
        threadRevision,
      });

      expect(executeRaw).toHaveBeenCalledTimes(1);
      const [, channelName, payload] = executeRaw.mock.calls[0] ?? [];
      expect(channelName).toBe(REALTIME_SIGNAL_CHANNEL);
      const parsed = parseSignalEnvelope(String(payload));
      expect(parsed.success && parsed.envelope).toMatchObject({
        c: `${ChannelKind.Comments}:${target.organizationId}:${target.artifactId}`,
        t: type,
        d: { threadId, threadRevision },
      });
    }
  );

  it("refuses a thread id that is not a UUID, so the command's transaction rolls back", async () => {
    const { tx, executeRaw } = fakeTransaction();

    await expect(
      emitThreadChangeSignal(tx, target, ThreadChangeKind.Updated, {
        threadId: "thread-1",
        threadRevision: 1,
      })
    ).rejects.toThrow();
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
