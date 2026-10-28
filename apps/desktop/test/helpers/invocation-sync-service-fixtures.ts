/**
 * @file invocation-sync-service-fixtures.ts
 * @description Shared in-memory fixtures for the invocation-sync SERVICE suites —
 * a fake {@link AgentComponentInvocationSyncSource} and the one exact part every
 * case drives through it.
 *
 * Extracted (ISS-5789) when the rejection-budget cases moved to their own suite:
 * two suites now drive the same service, and a copied fake would let them disagree
 * about what the source contract is while both stayed green.
 */
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncPart,
} from "@repo/api/src/types/agent-component-invocation";
import type {
  AgentComponentInvocationSyncDeadLetterRecoveryResult,
  AgentComponentInvocationSyncSource,
} from "../../src/main/agent-sync/agent-component-invocation-sync-service.js";
import { SESSION_MISSING_MAX_RETRY_AGE_MS } from "../../src/main/agent-sync/invocation-sync-rejection-policy.js";

/** When every fixture row was written to the outbox. */
export const PART_CREATED_AT = "2026-08-01T00:00:00.000Z";

const PART_CREATED_AT_MS = Date.parse(PART_CREATED_AT);

/**
 * A clock reading at which a fixture row has NOT yet outlived the `session_missing`
 * horizon — one second short of it, so the case sits hard against the boundary
 * rather than comfortably inside it.
 *
 * Both this and {@link SESSION_MISSING_HORIZON_SPENT_AT} are derived from the
 * production constant rather than restated, so retuning the horizon cannot leave a
 * test asserting a threshold the lane no longer uses.
 */
export const SESSION_MISSING_HORIZON_INTACT_AT = new Date(
  PART_CREATED_AT_MS + SESSION_MISSING_MAX_RETRY_AGE_MS - 1000
).toISOString();

/** A clock reading at which a fixture row has exactly outlived the horizon. */
export const SESSION_MISSING_HORIZON_SPENT_AT = new Date(
  PART_CREATED_AT_MS + SESSION_MISSING_MAX_RETRY_AGE_MS
).toISOString();

export class FakeSource implements AgentComponentInvocationSyncSource {
  entries: Array<{
    part: AgentComponentInvocationSyncPart;
    attemptCount: number;
    permanentAttemptCount: number;
    deadLetterRecoveryCount: number;
    laneStalledSince: string | null;
    nextAttemptAt: string | null;
  }>;
  clearCalls = 0;
  deadLetterCalls = 0;
  recoverCalls = 0;
  recoveredSourceKeys: string[] = [];
  readonly callOrder: string[] = [];
  deadLetteredAttemptCount = 0;
  deadLetteredPermanentAttemptCount = 0;
  /**
   * ISS-6209: the `last_error` the lane recorded when it gave up on the row. The
   * ack REASON and the lane's own CAUSE differ for a corrupt `created_at` — the
   * cloud said `session_missing`, the lane quarantined for an unreadable
   * timestamp — so a case that only counts dead-letters cannot tell the two
   * apart.
   */
  deadLetteredError: string | null = null;
  /**
   * ISS-5789: the `created_at` every row this source serves reports. Mutable so a
   * case can age the queue without rebuilding it — `session_missing` is budgeted
   * by row age, so this is the knob that decides whether it defers or is terminal.
   */
  createdAt = PART_CREATED_AT;
  /** ISS-4710 seam: overridable prepare so a test can park it (writer busy). */
  prepareImpl: () => Promise<void> = () => Promise.resolve();
  recoverResult: AgentComponentInvocationSyncDeadLetterRecoveryResult = {
    recoveredParts: 0,
    cappedParts: 0,
    quarantinedParts: 0,
  };
  recoverImpl: (
    sourceKey: string
  ) => Promise<AgentComponentInvocationSyncDeadLetterRecoveryResult> = () =>
    Promise.resolve(this.recoverResult);

  constructor(
    pending: AgentComponentInvocationSyncPart,
    attemptCount = 0,
    ...more: AgentComponentInvocationSyncPart[]
  ) {
    this.entries = [pending, ...more].map((entryPart) => ({
      part: entryPart,
      attemptCount,
      permanentAttemptCount: 0,
      deadLetterRecoveryCount: 0,
      laneStalledSince: null,
      nextAttemptAt: null,
    }));
  }

  withPermanentAttemptCount(permanentAttemptCount: number): this {
    for (const entry of this.entries) {
      entry.permanentAttemptCount = permanentAttemptCount;
    }
    return this;
  }

  prepareInvocationSyncTarget(): Promise<void> {
    return this.prepareImpl();
  }

  loadReadyInvocationSyncParts(
    sourceKey: string,
    now: string
  ): Promise<
    Array<{
      part: AgentComponentInvocationSyncPart;
      attemptCount: number;
      permanentAttemptCount: number;
      laneStalledSince: string | null;
      deadLetterRecoveryCount: number;
      createdAt: string;
    }>
  > {
    this.callOrder.push(`load:${sourceKey}`);
    return Promise.resolve(
      this.entries
        .filter(
          (entry) =>
            entry.nextAttemptAt === null ||
            entry.nextAttemptAt.localeCompare(now) <= 0
        )
        .map(
          ({
            part: pending,
            attemptCount,
            permanentAttemptCount,
            laneStalledSince,
            deadLetterRecoveryCount,
          }) => ({
            part: pending,
            attemptCount,
            permanentAttemptCount,
            laneStalledSince,
            deadLetterRecoveryCount,
            createdAt: this.createdAt,
          })
        )
    );
  }

  recoverInvocationSyncDeadLetters(
    sourceKey: string
  ): Promise<AgentComponentInvocationSyncDeadLetterRecoveryResult> {
    this.recoverCalls += 1;
    this.recoveredSourceKeys.push(sourceKey);
    this.callOrder.push(`recover:${sourceKey}`);
    return this.recoverImpl(sourceKey);
  }

  recordInvocationSyncRetry(
    _sourceKey: string,
    pending: AgentComponentInvocationSyncPart,
    retry: {
      attemptCount: number;
      permanentAttemptCount: number;
      nextAttemptAt: string;
      laneStalledSince: string | null;
    }
  ): Promise<void> {
    const entry = this.entries.find(
      (candidate) => candidate.part.partHash === pending.partHash
    );
    if (entry) {
      entry.attemptCount = retry.attemptCount;
      entry.permanentAttemptCount = retry.permanentAttemptCount;
      entry.nextAttemptAt = retry.nextAttemptAt;
      entry.laneStalledSince = retry.laneStalledSince;
    }
    return Promise.resolve();
  }

  clearAcknowledgedInvocationSyncPart(
    _sourceKey: string,
    ack: {
      externalGenerationId: string;
      partIndex: number;
      partHash: string;
    }
  ): Promise<boolean> {
    this.clearCalls += 1;
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (entry) =>
        entry.part.externalGenerationId !== ack.externalGenerationId ||
        entry.part.partIndex !== ack.partIndex ||
        entry.part.partHash !== ack.partHash
    );
    return Promise.resolve(before !== this.entries.length);
  }

  deadLetterInvocationSyncPart(
    _sourceKey: string,
    pending: AgentComponentInvocationSyncPart,
    deadLetter: {
      attemptCount: number;
      permanentAttemptCount: number;
      error: string;
    }
  ): Promise<boolean> {
    this.deadLetterCalls += 1;
    this.deadLetteredAttemptCount = deadLetter.attemptCount;
    this.deadLetteredPermanentAttemptCount = deadLetter.permanentAttemptCount;
    this.deadLetteredError = deadLetter.error;
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (entry) =>
        entry.part.externalGenerationId !== pending.externalGenerationId ||
        entry.part.partIndex !== pending.partIndex ||
        entry.part.partHash !== pending.partHash
    );
    return Promise.resolve(before !== this.entries.length);
  }
}

export function part(
  partHash = "c".repeat(64)
): AgentComponentInvocationSyncPart {
  return {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    externalSessionId: "session-1",
    externalGenerationId: "a".repeat(64),
    sourceUpdatedAt: "2026-07-22T16:00:00.000Z",
    dataRevision: 35,
    sourceSequence: 1,
    partIndex: 0,
    partCount: 1,
    partHash,
    items: [
      {
        externalInvocationId: "invocation-1",
        sourceSessionId: "session-1",
        kind: AgentComponentInvocationKind.Tool,
        componentKey: "Read",
        relationship: AgentComponentInvocationRelationship.Direct,
        invokedAt: "2026-07-22T16:00:00.000Z",
        sequence: 0,
        anchor: {
          kind: AgentComponentInvocationAnchorKind.Event,
          eventId: "event-1",
        },
        status: AgentComponentInvocationAttributionStatus.Unresolved,
        evidenceClass: AgentComponentInvocationEvidenceClass.None,
      },
    ],
  };
}
