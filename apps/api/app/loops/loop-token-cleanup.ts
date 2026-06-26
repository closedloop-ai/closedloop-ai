import { LoopEventType } from "@closedloop-ai/loops-api/events";
import type { TransactionClient } from "@repo/database";

/**
 * Revoke the active runner token, delete all runner token refresh records for a
 * loop, and insert an audit event recording the cleanup. Designed to run inside
 * a `withDb.tx` transaction so the token wipe is atomic with whatever status
 * transition triggered it.
 *
 * Accepts a plain `string` for `status` so both the API `LoopStatus` const
 * object and the Prisma `LoopStatus` enum can be passed without casting.
 */
export async function clearLoopTokens(
  db: TransactionClient,
  loopId: string,
  organizationId: string,
  status: string
): Promise<void> {
  // Sequential awaits are deliberate: this runs inside `withDb.tx`, and
  // `Promise.all` inside a Prisma interactive transaction can contend for the
  // pooled transaction connection.
  await db.loop.updateMany({
    where: { id: loopId, organizationId },
    data: {
      activeTokenJti: null,
      tokenExpiresAt: null,
    },
  });
  await db.loopTokenRefresh.deleteMany({ where: { loopId } });
  await db.loopEvent.create({
    data: {
      loopId,
      type: LoopEventType.TokensCleared,
      eventSource: "system",
      eventId: `${LoopEventType.TokensCleared}:${status.toLowerCase()}:${loopId}`,
      data: { status, timestamp: new Date().toISOString() },
    },
  });
}
