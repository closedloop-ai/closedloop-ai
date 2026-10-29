import type { TransactionClient } from "@repo/database";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import {
  CommentSignalType,
  type CommentThreadSignalData,
} from "@repo/realtime-contract/signals";
import { emitSignal } from "@repo/realtime-server/emit-signal";
import type { CommentTarget } from "./comment-target";

export const ThreadChangeKind = {
  Created: "created",
  Updated: "updated",
} as const;
export type ThreadChangeKind =
  (typeof ThreadChangeKind)[keyof typeof ThreadChangeKind];

/** A created thread names the revision its row was written with. */
export type ThreadChange =
  | {
      threadId: string;
      kind: typeof ThreadChangeKind.Created;
      revision: number;
    }
  | { threadId: string; kind: typeof ThreadChangeKind.Updated };

const SIGNAL_TYPE_BY_CHANGE = {
  [ThreadChangeKind.Created]: CommentSignalType.ThreadCreated,
  [ThreadChangeKind.Updated]: CommentSignalType.ThreadUpdated,
} as const satisfies Record<ThreadChangeKind, CommentSignalType>;

/**
 * Queues one thread's change on its artifact's `comments` channel. It is a
 * `pg_notify` inside the command's transaction, so it is delivered only if
 * that transaction commits.
 */
export function emitThreadChangeSignal(
  tx: Pick<TransactionClient, "$executeRaw">,
  target: CommentTarget,
  kind: ThreadChangeKind,
  data: CommentThreadSignalData
): Promise<void> {
  return emitSignal(
    tx,
    formatChannelAddress(ChannelKind.Comments, target.organizationId, [
      target.artifactId,
    ]),
    { type: SIGNAL_TYPE_BY_CHANGE[kind], data }
  );
}
