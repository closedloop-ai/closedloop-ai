import type { AgentComponentInvocationSyncSource } from "../agent-sync/agent-component-invocation-sync-service.js";
import {
  invocationOutboxDeadLetterFields,
  invocationOutboxRetryFields,
  pendingOutboxWriteWhere,
} from "../sync/durable-outbox.js";
import { recoverInvocationSyncDeadLetters } from "./invocation-sync-dead-letter-recovery.js";
import { loadReadyInvocationSyncOutboxParts } from "./invocation-sync-outbox-parts.js";
import { loadInvocationSyncParents } from "./invocation-sync-parent-diagnostics.js";
import { prepareInvocationSyncTarget } from "./invocation-sync-promotion.js";
import type { DesktopPrisma } from "./prisma-client.js";

type InvocationSyncSourceDelegates = Pick<
  AgentComponentInvocationSyncSource,
  | "loadInvocationSyncParents"
  | "prepareInvocationSyncTarget"
  | "loadReadyInvocationSyncParts"
  | "recoverInvocationSyncDeadLetters"
  | "recordInvocationSyncRetry"
  | "clearAcknowledgedInvocationSyncPart"
  | "deadLetterInvocationSyncPart"
>;

export function createInvocationSyncSourceDelegates(
  prisma: DesktopPrisma,
  log: (message: string) => void
): InvocationSyncSourceDelegates {
  return {
    loadInvocationSyncParents: (sourceKey, sessionIds) =>
      loadInvocationSyncParents(prisma, sourceKey, sessionIds),
    prepareInvocationSyncTarget: (
      sourceKey,
      templateSourceKey,
      sessionLimit,
      identity
    ) =>
      prepareInvocationSyncTarget(
        prisma,
        sourceKey,
        templateSourceKey,
        sessionLimit,
        identity,
        log
      ),
    loadReadyInvocationSyncParts: (sourceKey, now, limit) =>
      loadReadyInvocationSyncOutboxParts(prisma, sourceKey, now, limit),
    recoverInvocationSyncDeadLetters: (sourceKey, now, limit) =>
      recoverInvocationSyncDeadLetters(prisma, sourceKey, now, limit),
    async recordInvocationSyncRetry(sourceKey, part, retry): Promise<void> {
      const nowIso = new Date().toISOString();
      await prisma.write((client) =>
        client.agentComponentInvocationSyncOutbox.updateMany({
          where: pendingOutboxWriteWhere({
            sourceKey,
            externalSessionId: part.externalSessionId,
            externalGenerationId: part.externalGenerationId,
            partIndex: part.partIndex,
            partHash: part.partHash,
          }),
          data: invocationOutboxRetryFields({
            attemptCount: retry.attemptCount,
            permanentAttemptCount: retry.permanentAttemptCount,
            nextAttemptAt: retry.nextAttemptAt,
            reason: retry.error,
            laneStalledSince: retry.laneStalledSince,
            nowIso,
          }),
        })
      );
    },
    async clearAcknowledgedInvocationSyncPart(
      sourceKey,
      ack
    ): Promise<boolean> {
      const result = await prisma.write((client) =>
        client.agentComponentInvocationSyncOutbox.deleteMany({
          where: pendingOutboxWriteWhere({
            sourceKey,
            externalGenerationId: ack.externalGenerationId,
            partIndex: ack.partIndex,
            partHash: ack.partHash,
          }),
        })
      );
      return result.count === 1;
    },
    async deadLetterInvocationSyncPart(
      sourceKey,
      part,
      deadLetter
    ): Promise<boolean> {
      const nowIso = new Date().toISOString();
      const result = await prisma.write((client) =>
        client.agentComponentInvocationSyncOutbox.updateMany({
          where: pendingOutboxWriteWhere({
            sourceKey,
            externalSessionId: part.externalSessionId,
            externalGenerationId: part.externalGenerationId,
            partIndex: part.partIndex,
            partHash: part.partHash,
          }),
          data: invocationOutboxDeadLetterFields({
            attemptCount: deadLetter.attemptCount,
            permanentAttemptCount: deadLetter.permanentAttemptCount,
            reason: deadLetter.error,
            nowIso,
          }),
        })
      );
      return result.count === 1;
    },
  };
}
