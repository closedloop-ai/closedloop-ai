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

import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { prepareAgentSessionPayload } from "../src/main/agent-sync/agent-session-sync-payload.js";
import type {
  AgentSessionOutboxEntry,
  AgentSessionSyncSource,
  OutboxRetryState,
  PersistedSyncState,
} from "../src/main/agent-sync/agent-session-sync-source.js";

export class FakeSyncSource implements AgentSessionSyncSource {
  private readonly sessions = new Map<string, SyncedAgentSession>();
  /** FEA-1962: in-memory stand-in for the sqlite `sync_state` table. */
  private readonly syncStates = new Map<string, PersistedSyncState>();
  /** FEA-1962: records every advanceSyncState call so tests can assert timing. */
  readonly advanceCalls: Array<{
    sourceKey: string;
    state: PersistedSyncState;
  }> = [];
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
    this.syncStates.set(sourceKey, {
      ...state,
      deadLetteredIds: state.deadLetteredIds ?? [],
    });
  }

  loadSyncState(sourceKey: string): PersistedSyncState | null {
    return this.syncStates.get(sourceKey) ?? null;
  }

  advanceSyncState(sourceKey: string, state: PersistedSyncState): void {
    this.syncStates.set(sourceKey, state);
    this.advanceCalls.push({ sourceKey, state });
  }

  /**
   * FEA-3473: in-memory stand-in for the sqlite `agent_session_sync_outbox`
   * table, keyed `${sourceKey}\0${externalSessionId}`. `status` is
   * `pending` or `dead_lettered`; insertion order is preserved so
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
      nextAttemptAt?: string | null;
    }
  >();

  private outboxKey(sourceKey: string, id: string): string {
    return `${sourceKey}\0${id}`;
  }

  enqueueOutboxEntries(
    sourceKey: string,
    entries: AgentSessionOutboxEntry[]
  ): void {
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

  clearOutboxEntries(sourceKey: string, ids: string[]): void {
    for (const id of ids) {
      this.outbox.delete(this.outboxKey(sourceKey, id));
    }
  }

  markOutboxDeadLettered(
    sourceKey: string,
    id: string,
    reason: string,
    attemptCount = 0
  ): void {
    this.outbox.set(this.outboxKey(sourceKey, id), {
      sourceKey,
      id,
      status: "dead_lettered",
      reason,
      attemptCount,
      nextAttemptAt: null,
    });
  }

  /**
   * FEA-3697 / ISS-4546: in-memory stand-in for the sqlite
   * `reEnqueueRecoveredDeadLetter` — durably flip a `dead_lettered` row back to
   * `pending` and reset the retry budget, so `loadPendingOutboxIds` re-discovers a
   * recovered straggler. A missing/already-pending row is a no-op (mirrors the
   * sqlite `updateMany` `WHERE status = 'dead_lettered'`).
   */
  reEnqueueRecoveredDeadLetter(sourceKey: string, id: string): void {
    const key = this.outboxKey(sourceKey, id);
    const existing = this.outbox.get(key);
    if (existing?.status !== "dead_lettered") {
      return;
    }
    this.outbox.set(key, {
      sourceKey,
      id,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
    });
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
    reason: string
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
      nextAttemptAt,
    });
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
   * FEA-3659: in-memory stand-in for the sqlite `loadPendingOutboxRetryState` —
   * returns the durable retry budget for still-`pending` rows that recorded a
   * transient backoff (`attemptCount > 0`), so a resume test can assert the
   * in-memory counters + `nextRetryAfterMs` are rehydrated from the outbox.
   */
  loadPendingOutboxRetryState(sourceKey: string): OutboxRetryState[] {
    return [...this.outbox.values()]
      .filter(
        (row) =>
          row.sourceKey === sourceKey &&
          row.status === "pending" &&
          (row.attemptCount ?? 0) > 0
      )
      .map((row) => ({
        id: row.id,
        attemptCount: row.attemptCount ?? 0,
        nextAttemptAt: row.nextAttemptAt ?? null,
        lastError: row.reason ?? null,
      }));
  }

  /** Test helper: pre-seed a durable outbox row as if a prior run enqueued it. */
  seedOutbox(sourceKey: string, id: string, status = "pending"): void {
    this.outbox.set(this.outboxKey(sourceKey, id), {
      sourceKey,
      id,
      status,
    });
  }

  listAllSessionCursorRows() {
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
  ) {
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

  findLocallyOversizedSessions(ids: string[], maxBytes: number) {
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
