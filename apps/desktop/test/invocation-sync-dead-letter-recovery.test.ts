import assert from "node:assert/strict";
import { AgentComponentInvocationSyncRejectReason } from "@repo/api/src/types/agent-component-invocation";
import { describe, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AgentComponentInvocationSyncLocalError,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { SESSION_LANE_STALL_CEILING_MS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import {
  INVOCATION_DEAD_LETTER_RECOVERY_MAX_CYCLES,
  InvocationRowRetryDeadLetterCause,
} from "../src/main/agent-sync/invocation-sync-rejection-policy.js";
import { recoverInvocationSyncDeadLetters } from "../src/main/database/invocation-sync-dead-letter-recovery.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";

const NOW = "2026-08-14T16:10:00.000Z";
const DUE_UPDATED_AT = "2026-08-14T16:00:00.000Z";
const NOT_DUE_UPDATED_AT = "2026-08-14T16:08:00.000Z";
const ENVIRONMENTAL_RECOVERY_STALL_ORIGIN = new Date(
  Date.parse(NOW) - SESSION_LANE_STALL_CEILING_MS
).toISOString();
const TARGET_SOURCE_KEY =
  buildAgentComponentInvocationSyncSourceKey("target-1");

type RecoveryHarnessRow = {
  sourceKey: string;
  externalSessionId: string;
  externalGenerationId: string;
  partIndex: number;
  status: string;
  lastError: string | null;
  updatedAt: string;
  attemptCount: number;
  permanentAttemptCount: number | null;
  deadLetterRecoveryCount: number | null;
  nextAttemptAt: string | null;
  laneStalledSince: string | null;
  pendingSince: string | null;
};

describe("invocation sync dead-letter recovery", () => {
  it("re-pends only due recoverable rows for the exact target source key", async () => {
    const recoverable = recoveryRow({
      lastError: AgentComponentInvocationSyncRejectReason.ValidationFailed,
    });
    const environmentalCeiling = recoveryRow({
      partIndex: 1,
      lastError:
        AgentComponentInvocationSyncLocalError.EnvironmentalStallExhausted,
    });
    const ackMismatch = recoveryRow({
      partIndex: 2,
      lastError: InvocationRowRetryDeadLetterCause.AckMismatch,
    });
    const ageBudgeted = recoveryRow({
      partIndex: 3,
      lastError:
        AgentComponentInvocationSyncLocalError.SessionMissingHorizonExhausted,
    });
    const templateScoped = recoveryRow({
      partIndex: 4,
      sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      lastError: AgentComponentInvocationSyncRejectReason.ValidationFailed,
    });
    const harness = recoveryHarness([
      recoverable,
      environmentalCeiling,
      ackMismatch,
      ageBudgeted,
      templateScoped,
    ]);

    const result = await recoverInvocationSyncDeadLetters(
      harness.prisma,
      TARGET_SOURCE_KEY,
      NOW,
      10
    );

    assert.deepEqual(result, {
      recoveredParts: 3,
      cappedParts: 0,
      quarantinedParts: 0,
    });
    assert.equal(recoverable.status, OutboxStatus.Pending);
    assert.equal(recoverable.lastError, null);
    assert.equal(recoverable.nextAttemptAt, null);
    assert.equal(recoverable.laneStalledSince, null);
    assert.equal(recoverable.attemptCount, 9);
    assert.equal(recoverable.permanentAttemptCount, 4);
    assert.equal(recoverable.deadLetterRecoveryCount, 1);
    assert.equal(recoverable.pendingSince, NOW);
    assert.equal(environmentalCeiling.status, OutboxStatus.Pending);
    assert.equal(environmentalCeiling.attemptCount, 9);
    assert.equal(environmentalCeiling.permanentAttemptCount, 4);
    assert.equal(
      environmentalCeiling.laneStalledSince,
      ENVIRONMENTAL_RECOVERY_STALL_ORIGIN
    );
    assert.equal(ackMismatch.status, OutboxStatus.Pending);
    assert.equal(ackMismatch.attemptCount, 9);
    assert.equal(ackMismatch.permanentAttemptCount, 4);
    assert.equal(ageBudgeted.status, OutboxStatus.DeadLettered);
    assert.equal(templateScoped.status, OutboxStatus.DeadLettered);
  });

  it("respects the recovery delay and durable cycle cap", async () => {
    const notDue = recoveryRow({
      lastError: AgentComponentInvocationSyncRejectReason.PartConflict,
      updatedAt: NOT_DUE_UPDATED_AT,
    });
    const capped = recoveryRow({
      partIndex: 1,
      lastError: AgentComponentInvocationSyncRejectReason.GenerationConflict,
      deadLetterRecoveryCount: INVOCATION_DEAD_LETTER_RECOVERY_MAX_CYCLES,
    });
    const harness = recoveryHarness([notDue, capped]);

    const result = await recoverInvocationSyncDeadLetters(
      harness.prisma,
      TARGET_SOURCE_KEY,
      NOW,
      10
    );

    assert.deepEqual(result, {
      recoveredParts: 0,
      cappedParts: 1,
      quarantinedParts: 0,
    });
    assert.equal(notDue.status, OutboxStatus.DeadLettered);
    assert.equal(capped.status, OutboxStatus.DeadLettered);
  });

  it("quarantines malformed recovery bookkeeping instead of letting it starve due rows", async () => {
    const malformedCount = recoveryRow({
      updatedAt: "2026-08-14T15:00:00.000Z",
      deadLetterRecoveryCount: -1,
      lastError: AgentComponentInvocationSyncRejectReason.ValidationFailed,
    });
    const malformedTime = recoveryRow({
      partIndex: 1,
      updatedAt: "!not-an-instant",
      lastError: AgentComponentInvocationSyncRejectReason.GenerationConflict,
    });
    const due = recoveryRow({
      partIndex: 2,
      lastError: AgentComponentInvocationSyncRejectReason.PartConflict,
    });
    const harness = recoveryHarness([malformedCount, malformedTime, due]);

    const result = await recoverInvocationSyncDeadLetters(
      harness.prisma,
      TARGET_SOURCE_KEY,
      NOW,
      1
    );

    assert.deepEqual(result, {
      recoveredParts: 1,
      cappedParts: 0,
      quarantinedParts: 2,
    });
    assert.equal(malformedCount.status, OutboxStatus.DeadLettered);
    assert.equal(
      malformedCount.lastError,
      AgentComponentInvocationSyncLocalError.InvalidPersistedDurabilityState
    );
    assert.equal(malformedCount.updatedAt, NOW);
    assert.equal(malformedTime.status, OutboxStatus.DeadLettered);
    assert.equal(
      malformedTime.lastError,
      AgentComponentInvocationSyncLocalError.InvalidPersistedDurabilityState
    );
    assert.equal(malformedTime.updatedAt, NOW);
    assert.equal(due.status, OutboxStatus.Pending);
    assert.equal(due.lastError, null);
  });
});

function recoveryRow(
  overrides: Partial<RecoveryHarnessRow> = {}
): RecoveryHarnessRow {
  return {
    sourceKey: TARGET_SOURCE_KEY,
    externalSessionId: "session-1",
    externalGenerationId: "generation-1",
    partIndex: 0,
    status: OutboxStatus.DeadLettered,
    lastError: AgentComponentInvocationSyncRejectReason.ValidationFailed,
    updatedAt: DUE_UPDATED_AT,
    attemptCount: 9,
    permanentAttemptCount: 4,
    deadLetterRecoveryCount: null,
    nextAttemptAt: "2026-08-14T17:00:00.000Z",
    laneStalledSince: "2026-08-14T15:00:00.000Z",
    pendingSince: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function recoveryHarness(rows: RecoveryHarnessRow[]): {
  prisma: Pick<DesktopPrisma, "write">;
} {
  const client = {
    agentComponentInvocationSyncOutbox: {
      count: (args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          rows.filter((row) => matchesRecoveryWhere(row, args.where)).length
        ),
      findMany: (args: { where: Record<string, unknown>; take?: number }) =>
        Promise.resolve(
          rows
            .filter((row) => matchesRecoveryWhere(row, args.where))
            .sort(compareRecoveryRows)
            .slice(0, args.take ?? rows.length)
        ),
      updateMany: (args: {
        where: { OR: RecoveryHarnessRow[]; status: string };
        data: Partial<RecoveryHarnessRow>;
      }) => {
        let count = 0;
        for (const row of rows) {
          if (
            row.status === args.where.status &&
            args.where.OR.some((candidate) => sameRecoveryRow(row, candidate))
          ) {
            Object.assign(row, args.data);
            count += 1;
          }
        }
        return Promise.resolve({ count });
      },
    },
  };
  return {
    prisma: {
      write: <T>(fn: (writeClient: never) => Promise<T>): Promise<T> =>
        fn(client as never),
    },
  };
}

function matchesRecoveryWhere(
  row: RecoveryHarnessRow,
  where: Record<string, unknown>
): boolean {
  if (
    row.sourceKey !== where.sourceKey ||
    row.status !== where.status ||
    !lastErrorMatches(row.lastError, where.lastError)
  ) {
    return false;
  }
  if ("deadLetterRecoveryCount" in where) {
    const recoveryCountFilter = where.deadLetterRecoveryCount;
    return (
      isRecord(recoveryCountFilter) &&
      row.deadLetterRecoveryCount !== null &&
      row.deadLetterRecoveryCount >= Number(recoveryCountFilter.gte)
    );
  }
  if (!Array.isArray(where.OR)) {
    return true;
  }
  return where.OR.some((condition) => recoveryCountMatches(row, condition));
}

function lastErrorMatches(value: string | null, condition: unknown): boolean {
  return isRecord(condition) && Array.isArray(condition.in)
    ? condition.in.includes(value)
    : false;
}

function recoveryCountMatches(
  row: RecoveryHarnessRow,
  condition: unknown
): boolean {
  if (!isRecord(condition)) {
    return false;
  }
  if ("deadLetterRecoveryCount" in condition) {
    const expected = condition.deadLetterRecoveryCount;
    if (expected === null) {
      return row.deadLetterRecoveryCount === null;
    }
    return (
      isRecord(expected) &&
      row.deadLetterRecoveryCount !== null &&
      row.deadLetterRecoveryCount < Number(expected.lt)
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compareRecoveryRows(
  left: RecoveryHarnessRow,
  right: RecoveryHarnessRow
): number {
  return (
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.externalSessionId.localeCompare(right.externalSessionId) ||
    left.externalGenerationId.localeCompare(right.externalGenerationId) ||
    left.partIndex - right.partIndex
  );
}

function sameRecoveryRow(
  left: RecoveryHarnessRow,
  right: RecoveryHarnessRow
): boolean {
  return (
    left.sourceKey === right.sourceKey &&
    left.externalSessionId === right.externalSessionId &&
    left.externalGenerationId === right.externalGenerationId &&
    left.partIndex === right.partIndex
  );
}
