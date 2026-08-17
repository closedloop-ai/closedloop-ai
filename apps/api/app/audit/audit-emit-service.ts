import type { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import { AuditActorType } from "@repo/api/src/types/audit";
import { type Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { auditLedgerService } from "./audit-ledger-service";

/**
 * Async, non-blocking audit emission via a durable outbox (FEA-3862 Slice 1c).
 *
 * The load-bearing contract: emitting an audit event must NEVER block or fail
 * the originating user action. So domain write-paths do not append to the
 * ledger inline — they call {@link emitAuditEvent}, which writes one small row
 * to the `audit_outbox` table and swallows any failure (logging it). The
 * `drain-audit-outbox` cron later claims pending rows and calls
 * `auditLedgerService.append` (which takes the per-org single-writer advisory
 * lock so `seq` stays gap-free). Two properties fall out of this split:
 *
 *   1. Failure isolation. A ledger hiccup — a slow append, a lock wait, a
 *      transient DB error — is off the request's critical path entirely. Even
 *      the outbox insert is best-effort: if it throws, we log and return, and
 *      the user's action still succeeds.
 *   2. Durability. Emission is a real persisted row, not a fire-and-forget
 *      `waitUntil` promise that dies with the serverless function. The cron
 *      drains every enqueued event to the ledger; a row whose append keeps
 *      failing is retried across up to {@link MAX_DRAIN_ATTEMPTS} passes and
 *      then parked as a dead-letter — its `attempts`/`lastError` preserved for
 *      operators — rather than lost or left to block newer events.
 *
 * Emit is deliberately decoupled from the domain transaction: it runs AFTER the
 * domain write, in its own connection, so a ledger failure can never roll back
 * the user's write. The trade-off — a process crash between the committed
 * domain write and the outbox insert loses that one emission — is acceptable
 * for Phase 1 (historical actions are not back-signed; the ledger starts at
 * genesis) and is the correct side to err on: we never fail a real action to
 * record it.
 */

/**
 * The actor that produced an action. Callers build it with {@link userAuditActor}
 * (from the authenticated request's user id) or {@link systemAuditActor}. Phase 1
 * attributes every authenticated write (Clerk / api-key / desktop-session) as a
 * `user`; unattributed internal paths are `system`. Signed `agent` attribution
 * lands in Phase 2.
 */
export type AuditActor = {
  actorType: AuditActorType;
  actorId: string | null;
};

/** The `user`-attributed actor for an authenticated request. */
export function userAuditActor(userId: string): AuditActor {
  return { actorType: AuditActorType.User, actorId: userId };
}

/** The `system`-attributed actor for an unattributed internal path. */
export function systemAuditActor(): AuditActor {
  return { actorType: AuditActorType.System, actorId: null };
}

/** A single audit emission: the actor plus the domain event it describes. */
export type AuditEmitInput = {
  organizationId: string;
  actor: AuditActor;
  action: AuditAction;
  objectType: AuditObjectType;
  objectId: string;
  detail?: Prisma.InputJsonValue;
};

/**
 * Enqueue an audit event onto the durable outbox. Best-effort and
 * non-throwing: any failure is logged and swallowed so the caller's request is
 * never affected. Callers on a hot path should still not `await` this in a way
 * that adds latency to the response; prefer passing the returned promise to
 * `waitUntil` or letting it settle after the response contract is fulfilled.
 */
export async function emitAuditEvent(input: AuditEmitInput): Promise<void> {
  try {
    await withDb((db) =>
      db.auditOutbox.create({
        data: {
          organizationId: input.organizationId,
          action: input.action,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          objectType: input.objectType,
          objectId: input.objectId,
          detail: input.detail ?? {},
        },
      })
    );
  } catch (error) {
    // Failure isolation: a failed enqueue must not surface to the user's
    // action. We drop this one emission and log it for operators.
    log.error("[audit-emit] failed to enqueue audit event", {
      organizationId: input.organizationId,
      action: input.action,
      objectType: input.objectType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Fire-and-forget audit emission for response-path callers. Enqueues the event
 * onto the outbox via `waitUntil` so the insert settles after the response is
 * sent and never adds latency to the user's request (mirrors
 * `dispatchAssignmentNotification`). `emitAuditEvent` is already non-throwing,
 * so this can never surface an error. Returns `void`: the caller must not
 * `await` audit emission on the hot path.
 */
export function dispatchAuditEvent(input: AuditEmitInput): void {
  waitUntil(emitAuditEvent(input));
}

/**
 * Enqueue MANY audit events in a SINGLE bulk outbox insert. Best-effort and
 * non-throwing: any failure is logged and swallowed. A no-op for an empty
 * array. Batch callers (e.g. batch status updates) MUST use this instead of a
 * per-item `dispatchAuditEvent` loop: the per-item form starts one concurrent
 * `withDb(...auditOutbox.create...)` promise per event, so a large batch can
 * exhaust the shared connection pool (see `apps/api/AGENTS.md` — Bounded
 * fan-out). One `createMany` is a single pooled write regardless of batch size.
 */
export async function emitAuditEvents(
  inputs: readonly AuditEmitInput[]
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  try {
    await withDb((db) =>
      db.auditOutbox.createMany({
        data: inputs.map((input) => ({
          organizationId: input.organizationId,
          action: input.action,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          objectType: input.objectType,
          objectId: input.objectId,
          detail: input.detail ?? {},
        })),
      })
    );
  } catch (error) {
    log.error("[audit-emit] failed to enqueue audit event batch", {
      count: inputs.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Fire-and-forget bulk audit emission for response-path callers. Wraps
 * {@link emitAuditEvents} in `waitUntil` so the single bulk insert settles after
 * the response is sent and never adds latency to the user's request. Returns
 * `void`: the caller must not `await` audit emission on the hot path.
 */
export function dispatchAuditEvents(inputs: readonly AuditEmitInput[]): void {
  waitUntil(emitAuditEvents(inputs));
}

/** Summary of one drain pass, returned by the cron for observability. */
export type AuditOutboxDrainSummary = {
  /** Pending rows read from the outbox this pass (bounded by the batch limit). */
  claimed: number;
  /** Rows this pass claimed and appended to the ledger. */
  appended: number;
  /** Rows a concurrent drain had already claimed before this pass reached them. */
  skipped: number;
  /** Rows whose append threw; left pending with a bumped attempt count. */
  failed: number;
  /**
   * Rows read this pass but left unprocessed because the pass-level time budget
   * ({@link DRAIN_PASS_BUDGET_MS}) was exhausted; the next cron pass picks them
   * up. `appended + skipped + failed + remaining === claimed`.
   */
  remaining: number;
};

/** Outcome of settling one pending outbox row. */
const DrainRowOutcome = {
  /** This pass claimed the row and appended it to the ledger. */
  Appended: "appended",
  /** Another concurrent drain already claimed the row; nothing to do. */
  Skipped: "skipped",
  /** The append threw; the row was left pending with a bumped attempt count. */
  Failed: "failed",
} as const;

type DrainRowOutcome = (typeof DrainRowOutcome)[keyof typeof DrainRowOutcome];

/** Max pending rows a single drain pass appends. Keeps the cron bounded. */
const DRAIN_BATCH_LIMIT = 200;

/**
 * Dead-letter cap: a row is claimed for at most this many drain passes. Once its
 * `attempts` reaches the cap it is a poison row — an append that keeps throwing
 * (a malformed payload, a permanently-rejecting ledger invariant) — and is
 * parked: excluded from every future drain batch so it cannot re-fail forever or
 * occupy the front of the queue and starve newer events. Its `attempts` and
 * `lastError` stay on the row for an operator dead-letter view. The value is a
 * balance: high enough that a transient outage (a slow lock, a DB blip) still
 * retries across several cron passes, low enough that a genuine poison row is
 * parked quickly.
 */
export const MAX_DRAIN_ATTEMPTS = 10;

/**
 * Wall-clock budget for one drain pass. A single row's append can block on the
 * per-org advisory lock for up to the append transaction timeout (30s, see
 * `auditLedgerService`), and the batch is processed sequentially, so under
 * persistent lock contention a full 200-row batch could otherwise run for tens
 * of minutes while the cron fires every 2 minutes — passes would pile up on the
 * same rows. This budget bounds a pass instead: the loop stops claiming NEW rows
 * once the budget is spent (an in-flight append is never interrupted), leaving
 * the rest for the next cron pass. Sized to leave ample margin under the 2-min
 * cron even if the final claimed row consumes the full append timeout
 * (60s budget + up to 30s for the last append < 120s).
 */
const DRAIN_PASS_BUDGET_MS = 60_000;

type PendingOutboxRow = {
  id: string;
  organizationId: string;
  action: string;
  actorType: string;
  actorId: string | null;
  objectType: string;
  objectId: string;
  detail: Prisma.JsonValue;
  attempts: number;
};

/**
 * Drain pending outbox rows into the ledger. Reads the oldest pending rows
 * (bounded by {@link DRAIN_BATCH_LIMIT}), then appends each in creation order —
 * per-organization the advisory lock inside `append` serializes writers, so a
 * concurrent overlapping drain cannot create a gap or duplicate `seq`.
 *
 * Each row is claimed and appended atomically in one transaction (the outbox
 * delete and the ledger insert commit together); a row that throws is rolled
 * back and left pending with an incremented `attempts`/`lastError` so it retries
 * next pass. A poison row never blocks newer events: once its `attempts` reaches
 * {@link MAX_DRAIN_ATTEMPTS} it is parked — excluded from the drain batch (the
 * query filters `attempts < MAX_DRAIN_ATTEMPTS`) so it can neither re-fail
 * forever nor monopolize the batch limit and starve rows behind it. A row a
 * concurrent drain already claimed is skipped, not re-appended. Idempotent: a
 * re-drain of an already-appended batch finds no pending rows (they were
 * deleted) and appends nothing.
 *
 * The pass is time-bounded by {@link DRAIN_PASS_BUDGET_MS}: once the budget is
 * spent the loop stops claiming new rows (never interrupting an in-flight
 * append) and leaves the remainder for the next cron pass, reported as
 * `summary.remaining`. This keeps a pass from running for tens of minutes under
 * persistent per-org lock contention (each append can block up to the append
 * transaction timeout) while the cron fires every two minutes.
 */
export async function drainAuditOutbox(
  limit = DRAIN_BATCH_LIMIT,
  passBudgetMs = DRAIN_PASS_BUDGET_MS
): Promise<AuditOutboxDrainSummary> {
  const passStart = Date.now();
  const pending = await withDb((db) =>
    db.auditOutbox.findMany({
      where: { attempts: { lt: MAX_DRAIN_ATTEMPTS } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: {
        id: true,
        organizationId: true,
        action: true,
        actorType: true,
        actorId: true,
        objectType: true,
        objectId: true,
        detail: true,
        attempts: true,
      },
    })
  );

  const summary: AuditOutboxDrainSummary = {
    claimed: pending.length,
    appended: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
  };

  for (let i = 0; i < pending.length; i += 1) {
    // Stop claiming NEW rows once the pass budget is spent. Checked before each
    // append (never mid-append), and only after the first row so a pass always
    // makes progress. Remaining rows are left pending for the next cron pass.
    if (i > 0 && Date.now() - passStart >= passBudgetMs) {
      summary.remaining = pending.length - i;
      break;
    }

    const outcome = await appendPendingRow(pending[i]);
    if (outcome === DrainRowOutcome.Appended) {
      summary.appended += 1;
    } else if (outcome === DrainRowOutcome.Skipped) {
      summary.skipped += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

/**
 * Append one pending outbox row, claiming and deleting it atomically in the same
 * transaction as the ledger insert (see
 * {@link auditLedgerService.appendClaimingOutbox}). Returns:
 *   - `Appended` when this pass claimed the row and appended it;
 *   - `Skipped` when the row could not be claimed — another concurrent drain
 *     already claimed it, or a concurrent pass pushed its `attempts` to
 *     {@link MAX_DRAIN_ATTEMPTS} after this pass read it (the claim re-checks the
 *     cap, so a row past it is never appended); nothing left to do — not a
 *     failure;
 *   - `Failed` when the append threw; the row is then left pending with a bumped
 *     attempt count.
 * Never throws — a single poison row must not abort the whole drain pass.
 *
 * The atomic claim closes the double-append window: previously the append
 * committed and a *separate* delete removed the row, so a crash or a second
 * concurrent drain between the two could re-append the event with a fresh
 * `seq`. Now the delete and the insert commit together, only one worker can
 * delete a given row, and the claim itself carries the `attempts` cap so a stale
 * batch snapshot cannot append a row that has already reached the dead-letter
 * cap.
 */
async function appendPendingRow(
  row: PendingOutboxRow
): Promise<DrainRowOutcome> {
  try {
    const { claimed } = await auditLedgerService.appendClaimingOutbox(
      row.id,
      {
        organizationId: row.organizationId,
        action: row.action,
        actorType: row.actorType as AuditActorType,
        actorId: row.actorId,
        objectType: row.objectType,
        objectId: row.objectId,
        detail: (row.detail ?? {}) as Prisma.InputJsonValue,
      },
      MAX_DRAIN_ATTEMPTS
    );
    return claimed ? DrainRowOutcome.Appended : DrainRowOutcome.Skipped;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("[audit-emit] failed to append outbox row", {
      outboxId: row.id,
      organizationId: row.organizationId,
      action: row.action,
      attempts: row.attempts + 1,
      error: message,
    });
    await recordDrainFailure(row.id, message);
    return DrainRowOutcome.Failed;
  }
}

/**
 * Bump `attempts` and stamp `lastError` on a row whose append failed. The
 * `attempts < MAX_DRAIN_ATTEMPTS` guard settles the failure at the cap: it is an
 * `updateMany` (not `update`) so the increment is a single atomic write that
 * no-ops once the row is already parked, so an overlapping drain that settled
 * the same row cannot push `attempts` past the cap.
 */
async function recordDrainFailure(id: string, message: string): Promise<void> {
  try {
    await withDb((db) =>
      db.auditOutbox.updateMany({
        where: { id, attempts: { lt: MAX_DRAIN_ATTEMPTS } },
        data: { attempts: { increment: 1 }, lastError: message.slice(0, 500) },
      })
    );
  } catch (updateError) {
    log.error("[audit-emit] failed to record outbox drain failure", {
      outboxId: id,
      error:
        updateError instanceof Error
          ? updateError.message
          : String(updateError),
    });
  }
}
