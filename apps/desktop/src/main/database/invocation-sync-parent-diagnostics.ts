import {
  type InvocationSyncParent,
  InvocationSyncParentStatus,
  invocationSyncParentSchema,
} from "@repo/api/src/types/invocation-sync-diagnostics";
import { z } from "zod";
import type { DesktopPrisma } from "./prisma-client.js";

/** One bounded snapshot of the parents of this tick's rejected parts. */
export function loadInvocationSyncParents(
  prisma: DesktopPrisma,
  sessionSourceKey: string,
  sessionIds: string[]
): Promise<InvocationSyncParent[]> {
  const ids = [...new Set(sessionIds)].slice(0, 10);
  return prisma.read((reader) =>
    reader.$transaction(async (tx) => {
      const [sessions, outbox] = await Promise.all([
        tx.session.findMany({
          where: { id: { in: ids } },
          select: { id: true },
        }),
        tx.agentSessionSyncOutbox.findMany({
          where: {
            sourceKey: sessionSourceKey,
            externalSessionId: { in: ids },
          },
          select: {
            externalSessionId: true,
            status: true,
            attemptCount: true,
            lastError: true,
            nextAttemptAt: true,
          },
        }),
      ]);
      const present = new Set(sessions.map((row) => row.id));
      const rows = new Map(outbox.map((row) => [row.externalSessionId, row]));
      return ids.map((externalSessionId) => {
        const row = rows.get(externalSessionId);
        return invocationSyncParentSchema.parse({
          externalSessionId,
          sessionPresent: present.has(externalSessionId),
          outboxStatus: row?.status ?? InvocationSyncParentStatus.Absent,
          ...(row ? { attemptCount: row.attemptCount } : {}),
          ...(row?.lastError ? { lastError: row.lastError } : {}),
          ...readNextAttemptAt(row?.nextAttemptAt),
        });
      });
    })
  );
}

/**
 * The stored retry deadline, or the flag that says it was unreadable. A single
 * corrupt `next_attempt_at` must not reject the whole bounded read — that would
 * send all ten parents to `parentReadFailed` and lose the evidence for the nine
 * intact ones. Mirrors the part side's `createdAt` / `createdAtInvalid` pair.
 */
function readNextAttemptAt(
  stored: string | null | undefined
):
  | { nextAttemptAt: string }
  | { nextAttemptAtInvalid: true }
  | Record<never, never> {
  if (!stored) {
    return {};
  }
  const parsed = z.iso.datetime().safeParse(stored);
  if (parsed.success) {
    return { nextAttemptAt: parsed.data };
  }
  return { nextAttemptAtInvalid: true };
}
