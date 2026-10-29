/**
 * @file sync-burndown-fixtures.ts
 * @description The shared burn-down test fixtures — the pinned sample instant,
 * the source keys one sample is scoped to, and a fully populated lane row for
 * the suites that call the pure detectors.
 *
 * Extracted (ISS-10060) when `sync-burndown-store.test.ts` reached the 1,000-line
 * ceiling. The source keys and the sample instant are shared rather than copied because a
 * burn-down read that is scoped to a DIFFERENT key than the rows were seeded under
 * silently measures nothing and reports zero, which is the one failure a copied
 * constant would hide.
 */

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY } from "../../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import type { SignedInUserIdentity } from "../../src/main/util/user-identity.js";
import {
  OldestPendingBasis,
  type SyncLaneBurndown,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
  SyncLaneRemainderBasis,
} from "../../src/shared/sync-burndown-contract.js";
import { OutboxStatus } from "../../src/shared/sync-lane-contract.js";

export const COMPUTE_TARGET_ID = "ct-1";
export const SESSION_SOURCE_KEY = "agent_sessions:ct-1";
export const DELIVERY_SOURCE_KEY = `${AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY}:ct-1`;
export const COMPONENT_SOURCE_KEY = "agent_components:v3:ct-1";

/**
 * ISS-5973: the instant every sample is taken at. Pinned rather than read from
 * the wall clock, because `readyPending` is a deadline COMPARISON and a test
 * that straddles the boundary by real time is a flake waiting to happen.
 */
export const SAMPLE_NOW = "2026-08-06T12:00:00.000Z";

/** The one method these seeds need from the libSQL handle. */
export type DbRun = { run(sql: string, ...params: unknown[]): Promise<void> };

/** The query shape one burn-down sample is read with. */
export function burndownQuery(nowIso: string = SAMPLE_NOW) {
  return {
    sessionSourceKey: SESSION_SOURCE_KEY,
    invocationSourceKey: DELIVERY_SOURCE_KEY,
    invocationTemplateSourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    componentSourceKey: COMPONENT_SOURCE_KEY,
    transcriptComputeTargetId: COMPUTE_TARGET_ID,
    identity: null,
    nowIso,
  };
}

/**
 * A drained session-lane row with a written cursor. Shared by
 * `sync-burndown-contract.test.ts` and
 * `sync-burndown-cursor-stall-steady-drain.test.ts` (ISS-10429).
 */
export function burndownLane(
  overrides: Partial<SyncLaneBurndown> = {}
): SyncLaneBurndown {
  return {
    lane: SyncLaneId.SessionMetadata,
    state: SyncLaneDrainState.Drained,
    resumeBlocked: false,
    itemsRemaining: 0,
    itemsRemainingIsLowerBound: false,
    readyItemsRemaining: null,
    unmeasuredRows: 0,
    bytesRemaining: 0,
    chunksRemaining: 0,
    deadLetteredCount: 0,
    deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
    remainderBasis: SyncLaneRemainderBasis.Counted,
    oldestPendingSinceIso: null,
    oldestPendingBasis: OldestPendingBasis.EnqueuedAt,
    oldestPendingAgeMs: null,
    tracksDurableCursor: true,
    durableCursorValue: "2026-08-06T10:00:00.000Z",
    durableCursorWrittenAtIso: "2026-08-06T10:00:01.000Z",
    durableCursorAgeMs: 1000,
    workCompletedSincePrevious: 0,
    bytesSentSincePrevious: 0,
    ...overrides,
  };
}

/**
 * One template-key session that is genuinely owed: a `pending` outbox part plus
 * the cursor row the lane's own pending-template predicate joins against.
 */
export async function seedOwedTemplateSession(
  db: DbRun,
  sessionId: string,
  /** ISS-7096: the local session row's owner pair; omitted leaves it unstamped. */
  owner?: SignedInUserIdentity
): Promise<void> {
  // Owed backlog belongs to a live parent; absent-parent templates are zombies.
  await db.run(
    "INSERT INTO sessions (id, status, user_id, organization_id) VALUES (?, ?, ?, ?)",
    sessionId,
    SESSION_STATUS.INACTIVE,
    owner?.userId ?? null,
    owner?.organizationId ?? null
  );
  await db.run(
    `INSERT INTO agent_component_invocation_sync_outbox
       (source_key, external_session_id, external_generation_id, part_index,
        part_count, part_hash, source_updated_at, data_revision, source_sequence,
        payload, status, attempt_count, next_attempt_at, last_error,
        created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, ?, 1, 1, '{"x":1}', ?, 0, NULL, NULL, ?, ?)`,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    sessionId,
    `${sessionId}-gen`,
    `${"a".repeat(63)}0`,
    "2026-08-01T00:00:00.000Z",
    OutboxStatus.Pending,
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z"
  );
  await db.run(
    `INSERT INTO agent_component_invocation_sync_cursors
       (source_key, external_session_id, external_generation_id,
        source_sequence, updated_at)
     VALUES (?, ?, ?, 1, ?)`,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    sessionId,
    `${sessionId}-gen`,
    "2026-08-01T00:00:00.000Z"
  );
}
