import "server-only";

import type { TransactionClient } from "@repo/database";
import { withDb } from "@repo/database";

async function cleanupExpiredJtis(
  client: TransactionClient,
  now: Date
): Promise<void> {
  await client.localGatewayChallengeJti.deleteMany({
    where: { expiresAt: { lte: now } },
  });
}

export async function registerJti(jti: string, expiresAt: Date): Promise<void> {
  const now = new Date();
  await withDb.tx(async (tx) => {
    await cleanupExpiredJtis(tx, now);
    await tx.localGatewayChallengeJti.create({
      data: { jti, expiresAt },
    });
  });
}

export async function consumeJti(jti: string): Promise<boolean> {
  const now = new Date();
  const { count } = await withDb.tx(async (tx) => {
    await cleanupExpiredJtis(tx, now);
    return tx.localGatewayChallengeJti.deleteMany({
      where: {
        jti,
        expiresAt: { gt: now },
      },
    });
  });

  return count === 1;
}

/** For tests only. */
export async function resetLocalGatewayJtiStoreForTests(): Promise<void> {
  await withDb((db) => db.localGatewayChallengeJti.deleteMany());
}
