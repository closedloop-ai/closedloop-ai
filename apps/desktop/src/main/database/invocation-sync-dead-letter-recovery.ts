/**
 * @file invocation-sync-dead-letter-recovery.ts
 * @description Target-scoped recovery for invocation outbox dead letters whose
 * terminal cause is safe to retry in place.
 */
import {
  AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX,
  AgentComponentInvocationSyncLocalError,
} from "../agent-sync/agent-component-invocation-sync-constants.js";
import type { AgentComponentInvocationSyncDeadLetterRecoveryResult } from "../agent-sync/agent-component-invocation-sync-service.js";
import {
  deadLetterRetryDelayMs,
  SESSION_LANE_STALL_CEILING_MS,
} from "../agent-sync/agent-session-sync-backoff-policy.js";
import {
  INVOCATION_DEAD_LETTER_RECOVERY_CAUSES,
  INVOCATION_DEAD_LETTER_RECOVERY_MAX_CYCLES,
} from "../agent-sync/invocation-sync-rejection-policy.js";
import {
  deadLetteredOutboxWriteWhere,
  outboxPreserveCountersRePendFields,
} from "../sync/durable-outbox.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";

const RECOVERY_SCAN_MULTIPLIER = 5;
const MAX_RECOVERY_SCAN_LIMIT = 100;

type RecoverableInvocationDeadLetterRow = {
  sourceKey: string;
  externalSessionId: string;
  externalGenerationId: string;
  partIndex: number;
  lastError: string | null;
  updatedAt: string;
  deadLetterRecoveryCount: number | null;
};

type RecoveryCandidate = {
  row: RecoverableInvocationDeadLetterRow;
  nextRecoveryCount: number;
};

export function recoverInvocationSyncDeadLetters(
  prisma: Pick<DesktopPrisma, "write">,
  sourceKey: string,
  nowIso: string,
  limit: number
): Promise<AgentComponentInvocationSyncDeadLetterRecoveryResult> {
  const nowMs = Date.parse(nowIso);
  if (
    !(
      sourceKey.startsWith(
        AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX
      ) && Number.isFinite(nowMs)
    )
  ) {
    return Promise.resolve(emptyRecoveryResult());
  }
  const effectiveLimit = Math.max(1, limit);
  const scanLimit = Math.min(
    MAX_RECOVERY_SCAN_LIMIT,
    Math.max(effectiveLimit, effectiveLimit * RECOVERY_SCAN_MULTIPLIER)
  );
  return prisma.write(async (client) => {
    const cappedParts = await client.agentComponentInvocationSyncOutbox.count({
      where: recoverableDeadLetterWhere(sourceKey, {
        deadLetterRecoveryCount: {
          gte: INVOCATION_DEAD_LETTER_RECOVERY_MAX_CYCLES,
        },
      }),
    });
    const rows = await client.agentComponentInvocationSyncOutbox.findMany({
      where: recoverableDeadLetterWhere(sourceKey, {
        OR: [
          { deadLetterRecoveryCount: null },
          {
            deadLetterRecoveryCount: {
              lt: INVOCATION_DEAD_LETTER_RECOVERY_MAX_CYCLES,
            },
          },
        ],
      }),
      select: {
        sourceKey: true,
        externalSessionId: true,
        externalGenerationId: true,
        partIndex: true,
        lastError: true,
        updatedAt: true,
        deadLetterRecoveryCount: true,
      },
      orderBy: [
        { updatedAt: "asc" },
        { externalSessionId: "asc" },
        { externalGenerationId: "asc" },
        { partIndex: "asc" },
      ],
      take: scanLimit,
    });
    const { dueRows, invalidRows } = classifyRecoveryCandidates(
      rows,
      nowMs,
      effectiveLimit
    );
    const quarantinedParts = await quarantineInvalidRecoveryRows(
      client,
      invalidRows,
      nowIso
    );
    let recoveredParts = 0;
    for (const group of candidatesByRecoveryWrite(dueRows, nowMs)) {
      const result = await client.agentComponentInvocationSyncOutbox.updateMany(
        {
          where: deadLetteredOutboxWriteWhere({
            OR: group.candidates.map(({ row }) => ({
              sourceKey: row.sourceKey,
              externalSessionId: row.externalSessionId,
              externalGenerationId: row.externalGenerationId,
              partIndex: row.partIndex,
            })),
          }),
          data: {
            ...outboxPreserveCountersRePendFields(nowIso),
            pendingSince: nowIso,
            laneStalledSince: group.laneStalledSince,
            deadLetterRecoveryCount: group.nextRecoveryCount,
          },
        }
      );
      recoveredParts += result.count;
    }
    return { recoveredParts, cappedParts, quarantinedParts };
  });
}

function recoverableDeadLetterWhere(
  sourceKey: string,
  extra: Prisma.AgentComponentInvocationSyncOutboxWhereInput
): Prisma.AgentComponentInvocationSyncOutboxWhereInput {
  return {
    ...deadLetteredOutboxWriteWhere({
      sourceKey,
      lastError: { in: INVOCATION_DEAD_LETTER_RECOVERY_CAUSES },
    }),
    ...extra,
  };
}

function classifyRecoveryCandidates(
  rows: readonly RecoverableInvocationDeadLetterRow[],
  nowMs: number,
  limit: number
): {
  dueRows: RecoveryCandidate[];
  invalidRows: RecoverableInvocationDeadLetterRow[];
} {
  const dueRows: RecoveryCandidate[] = [];
  const invalidRows: RecoverableInvocationDeadLetterRow[] = [];
  for (const row of rows) {
    if (dueRows.length >= limit) {
      return { dueRows, invalidRows };
    }
    const recoveryCount = readRecoveryCount(row.deadLetterRecoveryCount);
    if (recoveryCount === null) {
      invalidRows.push(row);
      continue;
    }
    const parkedAtMs = Date.parse(row.updatedAt);
    if (!Number.isFinite(parkedAtMs)) {
      invalidRows.push(row);
      continue;
    }
    if (nowMs - parkedAtMs < deadLetterRetryDelayMs(recoveryCount + 1)) {
      continue;
    }
    dueRows.push({ row, nextRecoveryCount: recoveryCount + 1 });
  }
  return { dueRows, invalidRows };
}

function readRecoveryCount(value: number | null): number | null {
  if (value === null) {
    return 0;
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

type RecoveryWriteGroup = {
  nextRecoveryCount: number;
  laneStalledSince: string | null;
  candidates: RecoveryCandidate[];
};

function candidatesByRecoveryWrite(
  candidates: readonly RecoveryCandidate[],
  nowMs: number
): RecoveryWriteGroup[] {
  const grouped = new Map<string, RecoveryWriteGroup>();
  for (const candidate of candidates) {
    const laneStalledSince = recoveredLaneStalledSince(candidate.row, nowMs);
    const key = `${candidate.nextRecoveryCount}:${laneStalledSince ?? ""}`;
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.candidates.push(candidate);
    } else {
      grouped.set(key, {
        nextRecoveryCount: candidate.nextRecoveryCount,
        laneStalledSince,
        candidates: [candidate],
      });
    }
  }
  return [...grouped.values()];
}

function recoveredLaneStalledSince(
  row: RecoverableInvocationDeadLetterRow,
  nowMs: number
): string | null {
  if (
    row.lastError !==
    AgentComponentInvocationSyncLocalError.EnvironmentalStallExhausted
  ) {
    return null;
  }
  return new Date(nowMs - SESSION_LANE_STALL_CEILING_MS).toISOString();
}

async function quarantineInvalidRecoveryRows(
  client: Prisma.TransactionClient,
  rows: readonly RecoverableInvocationDeadLetterRow[],
  nowIso: string
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const result = await client.agentComponentInvocationSyncOutbox.updateMany({
    where: deadLetteredOutboxWriteWhere({
      OR: rows.map((row) => ({
        sourceKey: row.sourceKey,
        externalSessionId: row.externalSessionId,
        externalGenerationId: row.externalGenerationId,
        partIndex: row.partIndex,
      })),
    }),
    data: {
      lastError:
        AgentComponentInvocationSyncLocalError.InvalidPersistedDurabilityState,
      laneStalledSince: null,
      nextAttemptAt: null,
      updatedAt: nowIso,
    },
  });
  return result.count;
}

function emptyRecoveryResult(): AgentComponentInvocationSyncDeadLetterRecoveryResult {
  return { recoveredParts: 0, cappedParts: 0, quarantinedParts: 0 };
}
