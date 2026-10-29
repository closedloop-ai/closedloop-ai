/**
 * @file fake-sync-source.ts
 * @description Shared in-memory `AgentSessionSyncSource` fixture for the
 * agent-session sync tests, plus the `SyncedAgentSession` builder that goes with
 * it. Extracted from `agent-session-sync-service.test.ts` (FEA-3781) so a second
 * suite can drive the real `AgentSessionSyncService` without importing another
 * test file — which under `node:test` would re-register that file's whole suite.
 *
 * Lives in a plain module, not a `*.test.ts`, for exactly that reason.
 */

import type { SessionCursorRow } from "../src/main/agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { prepareAgentSessionPayload } from "../src/main/agent-sync/agent-session-sync-payload.js";
import type {
  AgentSessionOutboxEntry,
  AgentSessionSyncSource,
  PersistedSyncState,
  SessionOutboxEngineState,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import type { OutboxClearResult } from "../src/main/agent-sync/outbox-clear-result.js";
import type { PersistedLaneRun } from "../src/main/agent-sync/sync-cursor-state-source.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import { FakeSyncStateTable } from "./fake-sync-state-table.js";

export class FakeSyncSource implements AgentSessionSyncSource {
  private readonly sessions = new Map<string, SyncedAgentSession>();
  /**
   * FEA-1962: in-memory stand-in for the sqlite `sync_state` table, row keying
   * included (PLN-2028) — see `fake-sync-state-table.ts`.
   */
  private readonly syncStateTable = new FakeSyncStateTable();
  /** FEA-1962: records every advanceSyncState call so tests can assert timing. */
  readonly advanceCalls = this.syncStateTable.advanceCalls;
  /**
   * PLN-2028 M4: every lane-run write, in order. A give-up is an ISO instant and
   * a clear is `null`, and the DISTINCTION is the point — an absent write and a
   * cleared one say opposite things about the lane.
   */
  readonly laneRunWrites = this.syncStateTable.laneRunWrites;
  findLocallyOversizedCallCount = 0;
  /** ISS-6031: every id list the local-presence probe was asked about. */
  readonly findExistingSessionIdCalls: string[][] = [];
  listAllCursorCallCount = 0;
  listTopCursorCallCount = 0;
  loadSyncedSessionIds: string[][] = [];
  /**
   * PRD-536 E1: records every incremental read so a test can assert the cursor
   * excludes exactly the observed-id set at the top timestamp (never re-reads the
   * seen top cluster) while still selecting a new lower-id sibling at that
   * timestamp.
   */
  readonly listUpdatedCursorCalls: Array<{
    sinceUpdatedAt: string;
    observedTopIds: readonly string[];
  }> = [];
  /**
   * ISS-7265: the durable tiling-debt ledger, in memory. Sessions the lane
   * recorded as owing the cloud a tiling, those whose debt it settled, and how
   * many times it asked for the whole ledger to be re-delivered.
   */
  readonly tilingDebtOwed: string[] = [];
  readonly tilingDebtSettled: string[] = [];
  tilingRepairSweeps = 0;

  constructor(sessions: SyncedAgentSession[]) {
    for (const session of sessions) {
      this.upsert(session);
    }
  }

  upsert(session: SyncedAgentSession): void {
    this.sessions.set(session.externalSessionId, session);
  }

  /** Test helper: locally delete a session (models a delete-after-enqueue). */
  deleteSession(id: string): void {
    this.sessions.delete(id);
  }

  /**
   * FEA-1962: pre-seed a persisted cursor as if a prior run had synced.
   * `deadLetteredIds` defaults to `[]` so existing tests that predate the
   * dead-letter column stay concise (mirrors the loadSyncState backward-compat
   * default in sync-source.ts).
   */
  seedSyncState(
    sourceKey: string,
    state: Omit<PersistedSyncState, "deadLetteredIds"> & {
      deadLetteredIds?: string[];
    }
  ): void {
    this.syncStateTable.seed(sourceKey, {
      ...state,
      deadLetteredIds: state.deadLetteredIds ?? [],
    });
  }

  /**
   * ISS-8116: widened to the interface's own union so a subclass can DEFER the
   * cursor load — the await a superseded hydration's state application sits
   * behind.
   */
  loadSyncState(
    sourceKey: string
  ): PersistedSyncState | null | Promise<PersistedSyncState | null> {
    return this.persistedSyncState(sourceKey);
  }

  /** Synchronous accessor for assertions; never widened by a subclass. */
  persistedSyncState(sourceKey: string): PersistedSyncState | null {
    return this.syncStateTable.load(sourceKey);
  }

  advanceSyncState(sourceKey: string, state: PersistedSyncState): void {
    this.syncStateTable.advance(sourceKey, state);
  }

  /**
   * ISS-9418: the durable lane give-up stamp — the PLN-2028 compatibility alias.
   * Recorded for assertions AND applied to the stored state, so a later
   * hydration reads back what a previous process wrote.
   */
  recordLaneGiveUp(sourceKey: string, gaveUpAt: string | null): void {
    this.syncStateTable.recordLaneGiveUp(sourceKey, gaveUpAt);
  }

  /** PLN-2028: the whole durable lane run, on the same lane-run row. */
  recordLaneRun(sourceKey: string, run: PersistedLaneRun): void {
    this.syncStateTable.recordLaneRun(sourceKey, run);
  }

  recordActivityTilingDebt(sessionIds: string[]): void {
    this.tilingDebtOwed.push(...sessionIds);
  }

  settleActivityTilingDebt(sessionIds: string[]): void {
    this.tilingDebtSettled.push(...sessionIds);
  }

  requeueOwedActivityTilings(): number {
    this.tilingRepairSweeps += 1;
    return 0;
  }

  /**
   * FEA-3473: in-memory stand-in for the sqlite `agent_session_sync_outbox`
   * table, keyed `${sourceKey}\0${externalSessionId}`. `status` is one of
   * {@link OutboxStatus}; insertion order is preserved so
   * `loadPendingOutboxIds` returns oldest-first like the real `ORDER BY
   * created_at ASC`.
   */
  readonly outbox = new Map<
    string,
    {
      sourceKey: string;
      id: string;
      status: string;
      reason?: string;
      attemptCount?: number;
      permanentAttemptCount?: number;
      deadLetterRecoveryCount?: number;
      nextAttemptAt?: string | null;
      /** ISS-7730: the durable lane-wide stall clock, mirroring the real column. */
      laneStalledSince?: string | null;
    }
  >();

  private outboxKey(sourceKey: string, id: string): string {
    return `${sourceKey}\0${id}`;
  }

  /**
   * ISS-8116: declared with the interface's `void | Promise<void>` (not the
   * synchronous type this body produces) for the same reason
   * {@link listAllSessionCursorRows} is — a subclass that DEFERS the durable
   * seed is the only way to interleave a `stop()`/identity switch INTO the await
   * the post-seed cursor persist sits behind.
   */
  enqueueOutboxEntries(
    sourceKey: string,
    entries: AgentSessionOutboxEntry[]
  ): void | Promise<void> {
    for (const entry of entries) {
      const key = this.outboxKey(sourceKey, entry.externalSessionId);
      // Upsert that never resurrects a dead_lettered row (mirrors the sqlite
      // source's `update` that leaves `status` untouched).
      if (!this.outbox.has(key)) {
        this.outbox.set(key, {
          sourceKey,
          id: entry.externalSessionId,
          status: "pending",
        });
      }
    }
  }

  /**
   * ISS-7957: reports the rows actually removed, mirroring `deleteMany`'s own
   * `count` in `sqliteClearOutboxEntries`. Counting the ids ASKED FOR instead
   * would make this fixture agree with the defect rather than with the store —
   * an id whose row is already gone contributes nothing to a real delete, and
   * that divergence is the whole subject.
   */
  clearOutboxEntries(
    sourceKey: string,
    ids: string[]
  ): OutboxClearResult | undefined | Promise<OutboxClearResult | undefined> {
    let deletedRowCount = 0;
    for (const id of ids) {
      if (this.outbox.delete(this.outboxKey(sourceKey, id))) {
        deletedRowCount += 1;
      }
    }
    return { deletedRowCount };
  }

  markOutboxDeadLettered(
    sourceKey: string,
    id: string,
    reason: string,
    attemptCount = 0,
    permanentAttemptCount: number | null = null,
    deadLetterRecoveryCount: number | null = null
  ): void {
    const key = this.outboxKey(sourceKey, id);
    this.outbox.set(key, {
      sourceKey,
      id,
      status: "dead_lettered",
      reason,
      attemptCount,
      permanentAttemptCount:
        permanentAttemptCount ??
        this.outbox.get(key)?.permanentAttemptCount ??
        0,
      deadLetterRecoveryCount:
        deadLetterRecoveryCount ??
        this.outbox.get(key)?.deadLetterRecoveryCount ??
        0,
      nextAttemptAt: null,
      // ISS-7730: real-source parity — `outboxDeadLetterFields` does not name
      // this column, so the sqlite `update` branch leaves whatever the row had.
      // The stamp is evidence of WHY the row was abandoned; rebuilding the row
      // without it made the fake report `undefined` where sqlite reports the
      // preserved value.
      laneStalledSince: this.outbox.get(key)?.laneStalledSince ?? null,
    });
  }

  /**
   * FEA-3697 / ISS-4546: in-memory stand-in for the sqlite
   * `reEnqueueRecoveredDeadLetter` — durably flip a `dead_lettered` row back to
   * `pending` and reset the retry budget, so `loadPendingOutboxIds` re-discovers a
   * recovered straggler. A missing/already-pending row is a no-op (mirrors the
   * sqlite `updateMany` `WHERE status = 'dead_lettered'`).
   *
   * ISS-7216: returns the same "the row is no longer `dead_lettered`"
   * confirmation the sqlite source does, so a test driving the cap door through
   * this fixture observes the real release condition. Declared with the
   * interface's `boolean | Promise<boolean>` return (not the narrower
   * synchronous one it happens to produce) so a suite can subclass this fixture
   * to model a write that rejects or reports a failed flip.
   */
  reEnqueueRecoveredDeadLetter(
    sourceKey: string,
    id: string
  ): boolean | Promise<boolean> {
    const key = this.outboxKey(sourceKey, id);
    const existing = this.outbox.get(key);
    if (existing?.status !== "dead_lettered") {
      return true;
    }
    this.outbox.set(key, {
      sourceKey,
      id,
      status: "pending",
      attemptCount: 0,
      permanentAttemptCount: existing.permanentAttemptCount ?? 0,
      deadLetterRecoveryCount: existing.deadLetterRecoveryCount ?? 0,
      nextAttemptAt: null,
      // ISS-7730: explicit, mirroring the real store — see rePendWithheldOutbox.
      laneStalledSince: null,
    });
    return true;
  }

  /**
   * FEA-3659: in-memory stand-in for the sqlite `recordOutboxRetry` — stamps the
   * incremented `attemptCount` + `nextAttemptAt` on a still-`pending` row so a
   * test can assert a transient rejection went through the durable backoff path
   * (not straight to dead-letter at attempt 0).
   */
  recordOutboxRetry(
    sourceKey: string,
    id: string,
    attemptCount: number,
    nextAttemptAt: string,
    reason: string,
    laneStalledSince: string | null,
    permanentAttemptCount: number | null = null
  ): void {
    const key = this.outboxKey(sourceKey, id);
    const existing = this.outbox.get(key);
    // Mirror the sqlite source's upsert: the `update` branch leaves `status`
    // untouched, so recording a retry on an existing (esp. dead_lettered) row
    // must not resurrect it as pending — matching this fake's own
    // `enqueueOutboxEntries` guarantee. Only an absent row is created `pending`.
    this.outbox.set(key, {
      sourceKey,
      id,
      status: existing?.status ?? "pending",
      reason,
      attemptCount,
      permanentAttemptCount:
        permanentAttemptCount ?? existing?.permanentAttemptCount ?? 0,
      deadLetterRecoveryCount: existing?.deadLetterRecoveryCount ?? 0,
      nextAttemptAt,
      // ISS-7730: written on EVERY retry, so a row-attributable defer's null
      // clears a stall run exactly as the sqlite `update` branch does. Storing
      // only the truthy value would make the fake unable to reproduce the clear.
      laneStalledSince,
    });
  }

  /**
   * ISS-7730: in-memory stand-in for the sqlite `clearOutboxLaneStall` — a
   * row-attributable rejection ends the durable lane-wide stall run. Scoped to
   * `pending` exactly like the real `updateMany`, so a `dead_lettered` row keeps
   * the stamp that explains why it was abandoned, and touching no other column
   * so it can never reset a live budget.
   */
  clearOutboxLaneStall(sourceKey: string, ids: string[]): void {
    for (const id of ids) {
      const key = this.outboxKey(sourceKey, id);
      const existing = this.outbox.get(key);
      if (existing?.status !== "pending") {
        continue;
      }
      this.outbox.set(key, { ...existing, laneStalledSince: null });
    }
  }

  /**
   * Declared with the interface's `string[] | Promise<string[]>` return (not the
   * narrower synchronous one it happens to produce) so a suite can subclass this
   * fixture to model a source whose read genuinely spans an await — which is the
   * only way to exercise the post-await guards. Use {@link pendingOutboxIds} for
   * a synchronous assertion.
   */
  loadPendingOutboxIds(sourceKey: string): string[] | Promise<string[]> {
    return this.pendingOutboxIds(sourceKey);
  }

  /** Synchronous accessor for assertions; never widened by a subclass. */
  pendingOutboxIds(sourceKey: string): string[] {
    return [...this.outbox.values()]
      .filter((row) => row.sourceKey === sourceKey && row.status === "pending")
      .map((row) => row.id);
  }

  /**
   * FEA-3659: in-memory stand-in for the sqlite `loadPendingSessionOutboxEngineState` —
   * returns the durable engine state for still-`pending` rows, so a resume test
   * can assert the in-memory counters, recovery ladder, and `nextRetryAfterMs`
   * are rehydrated from the outbox.
   */
  loadPendingSessionOutboxEngineState(
    sourceKey: string
  ): SessionOutboxEngineState[] | Promise<SessionOutboxEngineState[]> {
    return [...this.outbox.values()]
      .filter(
        (row) =>
          row.sourceKey === sourceKey &&
          ((row.status === OutboxStatus.Pending &&
            ((row.attemptCount ?? 0) > 0 ||
              (row.permanentAttemptCount ?? 0) > 0 ||
              (row.deadLetterRecoveryCount ?? 0) > 0 ||
              row.laneStalledSince != null)) ||
            (row.status === OutboxStatus.DeadLettered &&
              (row.deadLetterRecoveryCount ?? 0) > 0))
      )
      .map((row) =>
        row.status === OutboxStatus.DeadLettered
          ? {
              id: row.id,
              status: OutboxStatus.DeadLettered,
              attemptCount: 0,
              permanentAttemptCount: 0,
              deadLetterRecoveryCount: row.deadLetterRecoveryCount ?? 0,
              nextAttemptAt: null,
              lastError: null,
              laneStalledSince: null,
            }
          : {
              id: row.id,
              attemptCount: row.attemptCount ?? 0,
              permanentAttemptCount: row.permanentAttemptCount ?? 0,
              deadLetterRecoveryCount: row.deadLetterRecoveryCount ?? 0,
              nextAttemptAt: row.nextAttemptAt ?? null,
              lastError: row.reason ?? null,
              laneStalledSince: row.laneStalledSince ?? null,
            }
      );
  }

  /**
   * ISS-7246: in-memory stand-in for the sqlite `markOutboxWithheld` — move a
   * still-`pending` row to `withheld` (nothing substantive to send yet). Guarded
   * exactly like the real `updateMany WHERE status = 'pending'`: a
   * `dead_lettered` row is never downgraded (that would drop it out of the
   * dead-letter recovery lifecycle) and an absent row creates nothing.
   */
  markOutboxWithheld(sourceKey: string, ids: string[]): void {
    for (const id of ids) {
      const key = this.outboxKey(sourceKey, id);
      const existing = this.outbox.get(key);
      if (existing?.status !== OutboxStatus.Pending) {
        continue;
      }
      this.outbox.set(key, {
        sourceKey,
        id,
        status: OutboxStatus.Withheld,
        attemptCount: 0,
        permanentAttemptCount: 0,
        deadLetterRecoveryCount: 0,
        nextAttemptAt: null,
      });
    }
  }

  /**
   * ISS-7246: in-memory stand-in for the sqlite `rePendWithheldOutbox` — return
   * `withheld` rows to `pending` when their session gains new local activity.
   * Guarded to `withheld` only, so it can neither resurrect a dead-letter nor
   * reset an in-flight pending retry's budget.
   */
  rePendWithheldOutbox(sourceKey: string, ids: string[]): void {
    for (const id of ids) {
      const key = this.outboxKey(sourceKey, id);
      if (this.outbox.get(key)?.status !== OutboxStatus.Withheld) {
        continue;
      }
      this.outbox.set(key, {
        sourceKey,
        id,
        status: OutboxStatus.Pending,
        attemptCount: 0,
        permanentAttemptCount: 0,
        deadLetterRecoveryCount: 0,
        nextAttemptAt: null,
        // ISS-7730: the real store writes `laneStalledSince: null` EXPLICITLY
        // alongside `outboxRePendFields`. Rebuilding the row without the field
        // would clear it unconditionally, so this fake would keep passing even
        // if production dropped that write — the drift that makes a fake worse
        // than no fake.
        laneStalledSince: null,
      });
    }
  }

  /** ISS-7246: synchronous accessor for the withheld set, for assertions. */
  withheldOutboxIds(sourceKey: string): string[] {
    return [...this.outbox.values()]
      .filter(
        (row) =>
          row.sourceKey === sourceKey && row.status === OutboxStatus.Withheld
      )
      .map((row) => row.id);
  }

  /** Test helper: pre-seed a durable outbox row as if a prior run enqueued it. */
  seedOutbox(sourceKey: string, id: string, status = "pending"): void {
    this.outbox.set(this.outboxKey(sourceKey, id), {
      sourceKey,
      id,
      status,
    });
  }

  /**
   * ISS-8116: this read and {@link listUpdatedSessionCursorRows} carry the UNION
   * `AgentSessionSyncSource` already declares (`T | Promise<T>`) rather than the
   * synchronous type their bodies happen to return. A subclass that DEFERS one
   * of them — the only way to interleave an identity switch INTO the await a
   * post-await guard protects — otherwise fails `TS2416` against the narrower
   * inferred base member, and a fixture that cannot defer cannot exercise that
   * guard at all.
   */
  listAllSessionCursorRows(): SessionCursorRow[] | Promise<SessionCursorRow[]> {
    this.listAllCursorCallCount += 1;
    return this.cursorRows();
  }

  listTopSessionCursorRows() {
    this.listTopCursorCallCount += 1;
    const rows = this.cursorRows();
    const topUpdatedAt = rows[0]?.updated_at;
    return topUpdatedAt
      ? rows.filter((row) => row.updated_at === topUpdatedAt)
      : [];
  }

  listUpdatedSessionCursorRows(
    sinceUpdatedAt: string,
    observedTopIds: readonly string[]
  ): SessionCursorRow[] | Promise<SessionCursorRow[]> {
    // PRD-536 E1: mirror the sqlite predicate `updated_at > $1 OR (updated_at =
    // $1 AND id NOT IN (<observedTopIds>))` — everything strictly newer, PLUS the
    // tied-top cluster minus the exact observed-id set. Excluding the SET (not
    // gating by a single `id > maxId` boundary) is what selects a genuinely-new
    // lower-id sibling at the top timestamp while still not re-emitting the seen
    // cluster.
    this.listUpdatedCursorCalls.push({ sinceUpdatedAt, observedTopIds });
    const observed = new Set(observedTopIds);
    return this.cursorRows().filter(
      (row) =>
        row.updated_at > sinceUpdatedAt ||
        (row.updated_at === sinceUpdatedAt && !observed.has(row.id))
    );
  }

  loadSyncedSessions(ids: string[]) {
    this.loadSyncedSessionIds.push(ids);
    return ids
      .map((id) => this.sessions.get(id))
      .filter((session): session is SyncedAgentSession => Boolean(session));
  }

  /**
   * ISS-6031: the local `sessions`-row existence probe. Backed by the same map
   * `deleteSession` mutates, so a fixture that models a REAL delete-after-enqueue
   * still reports the id as absent — while a fixture that only makes hydration
   * come back empty (a read failure) reports it as present, which is the
   * distinction the service must now act on.
   */
  findExistingSessionIds(ids: string[]): string[] | Promise<string[]> {
    this.findExistingSessionIdCalls.push(ids);
    return ids.filter((id) => this.sessions.has(id));
  }

  /**
   * ISS-8116: widened to the interface's own union so a subclass can DEFER the
   * oversize scan — the await `deadLetterOversizedLocalSession` resolves into.
   */
  findLocallyOversizedSessions(
    ids: string[],
    maxBytes: number
  ):
    | { id: string; payloadBytes: number }[]
    | Promise<{ id: string; payloadBytes: number }[]> {
    this.findLocallyOversizedCallCount += 1;
    return ids.flatMap((id) => {
      const session = this.sessions.get(id);
      if (!session) {
        return [];
      }
      const prepared = prepareAgentSessionPayload(session, maxBytes);
      return prepared.kind === "dead-letter"
        ? [{ id, payloadBytes: prepared.payloadBytes }]
        : [];
    });
  }

  private cursorRows() {
    return [...this.sessions.values()]
      .map((session) => ({
        id: session.externalSessionId,
        updated_at: session.updatedAt,
      }))
      .sort(
        (a, b) =>
          b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id)
      );
  }
}

export function makeSyncedSession(
  id: string,
  updatedAt: string,
  events: SyncedAgentSession["events"] = []
): SyncedAgentSession {
  return {
    externalSessionId: id,
    status: "completed",
    harness: "codex",
    cwd: `/workspace/${id}`,
    startedAt: "2026-06-08T12:00:00.000Z",
    updatedAt,
    agents: [],
    events,
    // FEA-3287: the sync path now withholds idle ("phantom") sessions (0-turn /
    // 0-token / no-tool-use) from cloud upload. The default fixture represents a
    // REAL session worth syncing, so give it a token-usage row — otherwise every
    // test that expects this session to upload would be (correctly) deferred as
    // idle. Tests that need an explicitly idle session use `makeIdleSession`.
    tokenUsageByModel: [
      {
        model: "gpt-5",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.001,
      },
    ],
  };
}
