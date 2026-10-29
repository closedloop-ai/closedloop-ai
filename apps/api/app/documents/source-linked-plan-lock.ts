import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import type { TransactionClient } from "@repo/database";

export type SourceLinkedPlanLockIdentity = {
  organizationId: string;
  sourceId: string;
};

/** Acquire the opt-in source-linked Implementation Plan creation lock. */
export async function acquireSourceLinkedPlanLockInTransaction(
  tx: Pick<TransactionClient, "$executeRaw">,
  identity: SourceLinkedPlanLockIdentity
): Promise<void> {
  const lockKey = sourceLinkedPlanLockKey(identity);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0::bigint))`;
}

export function sourceLinkedPlanLockKey(
  identity: SourceLinkedPlanLockIdentity
): string {
  return `documents:source-linked-plan:${identity.organizationId}:${identity.sourceId}:${DocumentType.ImplementationPlan}:${LinkType.Produces}`;
}
