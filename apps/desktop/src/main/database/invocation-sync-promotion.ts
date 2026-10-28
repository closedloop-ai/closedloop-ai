/**
 * @file invocation-sync-promotion.ts
 * @description The invocation-parts lane's PROMOTION step: the `$transaction` that
 * clones per-session template rows into a target-scoped delivery queue, so the
 * drain has something to send.
 *
 * Extracted from `sync-source.ts` (ISS-5789) because this is its own
 * responsibility with its own failure mode, and because it is where PRD-635's
 * outage lived. It used to abandon the whole pass whenever the delivery queue held
 * ANY pending row, which meant one part the cloud rejects forever stopped every
 * OTHER session from ever being attempted — 225 queued records, 18 of them from 9
 * recent sessions, never tried once. It now bails only on genuine queue DEPTH and
 * skips just the sessions whose own rows are still in flight.
 *
 * Two bounds make that safe, both added in review and both measured on this branch
 * before the fix:
 *
 *  - it PAGES FORWARD past a fully blocked candidate page rather than stopping at
 *    it ({@link scanForPromotableSessions}). Stopping re-read the same blocked page
 *    every tick, so ten blocked sessions starved a healthy one ordered behind them
 *    across five consecutive ticks — the same queue-wide outage, one page deep.
 *  - it ADMITS candidates against the parts they would add, not just the depth
 *    already queued (`selectSessionsWithinPartBudget`). The depth check alone was
 *    pre-insert only: at 499 pending rows a pass could still clone ten 1,000-part
 *    generations and leave 10,499 rows in one transaction.
 *
 * The pending/blocked predicates it reads live next door in
 * `invocation-sync-pending-templates.ts`, which is the single definition of "what
 * does the delivery queue still owe" for both this path and the burn-down reader.
 */

import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID,
  AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
} from "../agent-sync/agent-component-invocation-sync-constants.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import type { Prisma } from "./generated/client.js";
import { repairInvocationSyncCanonicalization } from "./invocation-sync-canonicalization-repair.js";
import { purgeOrphanedInvocationSyncState } from "./invocation-sync-orphan-maintenance.js";
import {
  INVOCATION_ID_BIND_CHUNK_SIZE,
  loadBlockedInvocationDeliverySessionIds,
  loadForeignOwnedInvocationSessionIds,
  loadInvocationTemplatePartCounts,
  loadPendingInvocationTemplates,
  MAX_PENDING_INVOCATION_DELIVERY_PARTS,
  type RawQueryClient,
  selectPromotableInvocationSessions,
  selectSessionsWithinPartBudget,
} from "./invocation-sync-pending-templates.js";
import { redriveValidationFailedInvocationParts } from "./invocation-sync-validation-redrive.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { chunkIds } from "./synced-session-hydration-plan.js";

/**
 * The surface this step needs from the desktop Prisma host. `read` is here for
 * the ISS-6889 repair's sentinel probe and template scan, which must not occupy
 * the single writer connection.
 */
export type InvocationPromotionPrismaHost = Pick<
  DesktopPrisma,
  "read" | "write"
>;

/**
 * ISS-5789 (codex P1 review): how many candidate pages one pass will walk looking
 * for a session it can actually promote.
 *
 * Without a bound the scan is a full-table walk inside the write `$transaction`;
 * without paging AT ALL the pass gives up on the first page, which is the starvation
 * this constant exists to fix. Ten pages of up to 100 sessions covers any realistic
 * run of blocked sessions while keeping the transaction's read cost bounded.
 */
const MAX_PROMOTION_SCAN_PAGES = 10;

export async function prepareInvocationSyncTarget(
  prisma: InvocationPromotionPrismaHost,
  sourceKey: string,
  templateSourceKey: string,
  sessionLimit: number,
  identity?: SignedInUserIdentity | null,
  // ISS-6910: the desktop diagnostic sink (`openSqliteAgentDatabase`'s
  // `options.log`, the FEA-3568 channel every other heal pass already reports
  // on). The repair's own tally was previously discarded here, so a generation
  // it could not rehash left no trace anywhere. ISS-9626 found the re-drive
  // below had the identical gap and threaded it onto the same sink.
  log?: (message: string) => void
): Promise<void> {
  const purged = await purgeOrphanedInvocationSyncState(prisma);
  if (purged > 0) {
    log?.(
      `invocation sync maintenance (ISS-12165): purged derived sync state for ${purged} absent local parent(s)`
    );
  }
  // ISS-6889: repair templates a PRE-canonicalization build persisted with a
  // pre-trim `part_hash`, BEFORE anything clones them into a delivery queue and
  // spends their five doomed attempts on a hash the cloud can never match. It
  // rides this step rather than new lifecycle wiring because this step is
  // already the lane's own main-process prepare, which is where invariant 9 puts
  // anything that advances the lane. Sentinel-guarded, so every call after the
  // first costs one indexed cursor read.
  await repairInvocationSyncCanonicalization(prisma, log);
  // ISS-6909: hand the sessions ISS-6883's pre-fix ingest dead-lettered with
  // `validation_failed` back to the sweep below, BEFORE it reads its candidates,
  // so the re-drive lands on this pass rather than the next one. It rides this
  // step for the same reason the repair above does — this is the lane's own
  // main-process prepare, which is where invariant 9 puts anything that advances
  // the lane — and it deliberately re-drives THROUGH promotion rather than
  // flipping a row's status, because the clone is what gives the replacement row
  // a `created_at` it earned instead of one a recovery pass invented.
  // Sentinel-guarded, so every call after the first costs one indexed lookup.
  const redrive = await redriveValidationFailedInvocationParts(prisma);
  // ISS-9626: a declined mixed-cause session is the pass's own statement that it
  // left recoverable rows parked, and it was observable only in tests. Reported
  // together with the re-driven tally so the one-shot leaves a countable trace.
  if (
    redrive &&
    (redrive.redrivenSessions > 0 || redrive.skippedMixedSessions > 0)
  ) {
    log?.(
      `invocation sync validation re-drive (ISS-6909): handed ${redrive.redrivenSessions} session(s) back to promotion, declined ${redrive.skippedMixedSessions} carrying another dead-letter cause`
    );
  }
  if (sourceKey === templateSourceKey) {
    return;
  }
  // ISS-7096: release delivery rows for sessions another identity owns — on a
  // multi-environment device, the other environment's sessions, which this
  // target can never deliver (`session_missing` forever against the wrong
  // cloud). Deleting is safe where it would not be for the session lane:
  // delivery rows are DERIVED artifacts, and clearing the per-session cursor
  // alongside them is the ISS-6909 lever — promotion re-materializes a session
  // whole from its template if this device ever syncs as its owner again.
  if (identity) {
    await releaseForeignOwnedDeliveryRows(prisma, sourceKey, identity);
  }
  const updatedAt = new Date().toISOString();
  await prisma.write((client) =>
    client.$transaction(async (tx) => {
      const stateRows = await tx.$queryRawUnsafe<
        {
          source_key: string;
          external_session_id: string;
          external_generation_id: string;
          source_sequence: number;
        }[]
      >(
        `SELECT source_key, external_session_id, external_generation_id,
                source_sequence
           FROM agent_component_invocation_sync_cursors
          WHERE (external_session_id = $1 AND source_key IN ($2, $3))
             OR (external_session_id = $4 AND source_key = $2)`,
        AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
        sourceKey,
        templateSourceKey,
        AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID
      );
      const templateRevision = Number(
        stateRows.find(
          (row) =>
            row.source_key === templateSourceKey &&
            row.external_session_id ===
              AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID
        )?.source_sequence ?? 0
      );
      const targetRevision = Number(
        stateRows.find(
          (row) =>
            row.source_key === sourceKey &&
            row.external_session_id ===
              AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID
        )?.source_sequence ?? 0
      );
      if (templateRevision === 0 || targetRevision >= templateRevision) {
        return;
      }
      // ISS-5789 (PRD-635 layer 3): this used to `return` whenever the
      // delivery queue held ANY pending row, which is what turned one stuck
      // part into a total outage — an orphaned July-24 part sat `pending`
      // forever, so promotion bailed on every tick and 225 queued records
      // (including all 18 from 9 recent sessions) were never attempted. Bail
      // now only on genuine DEPTH; a single undrainable row no longer speaks
      // for the whole queue. Sessions with in-flight rows are still protected,
      // individually, by the exclusion below.
      const pendingPartCount =
        await tx.agentComponentInvocationSyncOutbox.count({
          where: {
            sourceKey,
            status: OutboxStatus.Pending,
          },
        });
      if (pendingPartCount >= MAX_PENDING_INVOCATION_DELIVERY_PARTS) {
        return;
      }

      const backfillCursor =
        stateRows.find(
          (row) =>
            row.source_key === sourceKey &&
            row.external_session_id ===
              AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID
        )?.external_generation_id ?? "";
      const boundedLimit = Math.max(1, Math.min(sessionLimit, 100));
      const scan = await scanForPromotableSessions({
        tx,
        sourceKey,
        templateSourceKey,
        backfillCursor,
        boundedLimit,
        identity: identity ?? null,
      });
      if (!scan.sawAnyCandidate) {
        await settleCandidatelessScan(tx, {
          sourceKey,
          templateRevision,
          updatedAt,
          scan,
        });
        return;
      }

      if (scan.promotableSessionIds.length === 0) {
        // Every candidate the scan reached is mid-flight. Return WITHOUT
        // advancing either cursor: the `!sawAnyCandidate` branch above means
        // "this revision owes nothing", which is emphatically not true here, and
        // borrowing it would mark the revision complete and strand exactly the
        // sessions being waited on. Liveness is guaranteed from the other
        // side: every pending row now reaches a terminal state on a bounded
        // budget (layer 2), so this can defer but never wedge.
        return;
      }
      // ISS-5789 (@whitlockk review): admit candidates against the parts they would
      // actually ADD, not just against the depth already in the queue. The
      // pre-insert check above bounds the queue before the clone; this bounds it
      // after, which is the difference between a 500-row ceiling and the measured
      // 10,499 rows one pass could otherwise write in a single transaction.
      const sessionIds = selectSessionsWithinPartBudget(
        scan.promotableSessionIds,
        await loadInvocationTemplatePartCounts(
          tx,
          templateSourceKey,
          scan.promotableSessionIds
        ),
        MAX_PENDING_INVOCATION_DELIVERY_PARTS - pendingPartCount
      );
      if (sessionIds.length === 0) {
        return;
      }
      const sessionPlaceholders = sessionIds
        .map((_, index) => `$${index + 2}`)
        .join(", ");
      await tx.$executeRawUnsafe(
        `DELETE FROM agent_component_invocation_sync_outbox
          WHERE source_key = $1
            AND external_session_id IN (${sessionPlaceholders})`,
        sourceKey,
        ...sessionIds
      );
      const clonePlaceholders = sessionIds
        .map((_, index) => `$${index + 5}`)
        .join(", ");
      await tx.$executeRawUnsafe(
        `INSERT INTO agent_component_invocation_sync_outbox
           (source_key, external_session_id, external_generation_id,
            part_index, part_count, part_hash, source_updated_at,
            data_revision, source_sequence, payload, status, attempt_count,
            next_attempt_at, last_error, pending_since, created_at, updated_at)
         SELECT $1, outbox.external_session_id,
                outbox.external_generation_id, outbox.part_index,
                outbox.part_count, outbox.part_hash,
                outbox.source_updated_at, outbox.data_revision,
                outbox.source_sequence, outbox.payload, $4, 0,
                NULL, NULL, $3, $3, $3
           FROM agent_component_invocation_sync_outbox outbox
           JOIN agent_component_invocation_sync_cursors template
             ON template.source_key = $2
            AND template.external_session_id = outbox.external_session_id
            AND template.external_generation_id = outbox.external_generation_id
          WHERE outbox.source_key = $2
            AND outbox.status = $4
            AND outbox.external_session_id IN (${clonePlaceholders})
         ON CONFLICT (source_key, external_session_id,
                      external_generation_id, part_index) DO NOTHING`,
        sourceKey,
        templateSourceKey,
        updatedAt,
        OutboxStatus.Pending,
        ...sessionIds
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO agent_component_invocation_sync_cursors
           (source_key, external_session_id, external_generation_id,
            source_sequence, updated_at)
         SELECT $1, template.external_session_id,
                template.external_generation_id,
                template.source_sequence, $3
           FROM agent_component_invocation_sync_cursors template
          WHERE template.source_key = $2
            AND template.external_session_id IN (${sessionIds
              .map((_, index) => `$${index + 4}`)
              .join(", ")})
         ON CONFLICT (source_key, external_session_id) DO UPDATE SET
           external_generation_id = excluded.external_generation_id,
           source_sequence = excluded.source_sequence,
           updated_at = excluded.updated_at
         WHERE agent_component_invocation_sync_cursors.source_sequence <
               excluded.source_sequence`,
        sourceKey,
        templateSourceKey,
        updatedAt,
        ...sessionIds
      );
      // ISS-5789: the keyset cursor advances to the last session actually
      // PROMOTED, so a session skipped above is jumped over for this sweep
      // rather than lost — its per-session target cursor was never advanced,
      // so `loadPendingInvocationTemplates` still owes it, and the wrap-around
      // re-read (`pendingTemplates.length === 0 && backfillCursor`) brings the
      // sweep back around to it once the sessions ahead of it settle.
      await tx.$executeRawUnsafe(
        `INSERT INTO agent_component_invocation_sync_cursors
           (source_key, external_session_id, external_generation_id,
            source_sequence, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_key, external_session_id) DO UPDATE SET
           external_generation_id = excluded.external_generation_id,
           source_sequence = excluded.source_sequence,
           updated_at = excluded.updated_at`,
        sourceKey,
        AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID,
        sessionIds.at(-1),
        templateRevision,
        updatedAt
      );
    })
  );
}

/** What one promotion pass learned from walking the candidate keyset. */
type PromotionScanResult = {
  /**
   * Whether the sweep found ANY session this revision still owes. False means the
   * revision is genuinely complete; it must never be confused with "everything we
   * found happens to be blocked", which is what {@link promotableSessionIds} being
   * empty means.
   */
  sawAnyCandidate: boolean;
  /** The candidates from the first page that contained at least one promotable session. */
  promotableSessionIds: string[];
  /**
   * cr-81036: true only when the walk ran out of pending templates — an empty
   * page read after the wrap. False when the page cap ended the pass, which
   * proves nothing about the corpus beyond the walked window and must never be
   * read as "this revision owes nothing".
   */
  exhausted: boolean;
  /** Where the walk stopped — the resume point for a cap-ended pass. */
  scanCursor: string;
};

/**
 * ISS-5789 (codex P1 review): walk the candidate keyset until a page yields a
 * session promotion can actually materialize.
 *
 * The pass used to read ONE page and stop. When every session in that page was
 * blocked by its own in-flight delivery rows, it returned without advancing the
 * backfill cursor — so the next tick re-read the identical page, found it blocked
 * again, and healthy sessions ordered AFTER them were never reached. Measured on
 * this branch: ten blocked sessions ahead of one healthy session starved that
 * session across five consecutive ticks, promoting zero rows. Layer 3 exists to
 * stop one undrainable row taking the queue down with it, and stopping at the
 * first fully-blocked page reintroduced exactly that outage one page deep.
 *
 * Paging forward fixes it while keeping the cursor semantics intact: the caller
 * still advances the backfill cursor only to the last session it actually
 * PROMOTED, so the skipped sessions are jumped for this sweep rather than lost and
 * the wrap-around re-read brings the sweep back to them once they settle.
 *
 * The wrap is preserved from the single-page version and happens at most once, so
 * "this revision owes nothing" still means a full sweep from the start found
 * nothing — not merely that nothing remains after the cursor.
 */
async function scanForPromotableSessions(input: {
  tx: RawQueryClient & Pick<Prisma.TransactionClient, "session">;
  sourceKey: string;
  templateSourceKey: string;
  backfillCursor: string;
  boundedLimit: number;
  identity: SignedInUserIdentity | null;
}): Promise<PromotionScanResult> {
  let scanCursor = input.backfillCursor;
  let wrapped = input.backfillCursor === "";
  let sawAnyCandidate = false;
  let exhausted = false;
  for (let page = 0; page < MAX_PROMOTION_SCAN_PAGES; page++) {
    const templates = await loadPendingInvocationTemplates(
      input.tx,
      input.sourceKey,
      input.templateSourceKey,
      scanCursor,
      input.boundedLimit
    );
    if (templates.length === 0) {
      if (wrapped) {
        exhausted = true;
        break;
      }
      wrapped = true;
      scanCursor = "";
      continue;
    }
    const pageSessionIds = templates.map(
      (template) => template.external_session_id
    );
    // ISS-7096: another identity's sessions are permanently not this target's
    // work (a compute target is assigned per authenticated account+machine),
    // so they are not candidates at all: they must not count toward
    // `sawAnyCandidate` — a fully-SWEPT all-foreign corpus completes the
    // revision instead of holding it open and re-walking the same pages on
    // every prepare. A cap-ended walk is different: it proves nothing beyond
    // its window, so the caller advances the backfill cursor and defers
    // rather than stamping completion (cr-81036).
    const foreign = input.identity
      ? new Set(
          await loadForeignOwnedInvocationSessionIds(
            input.tx,
            input.identity,
            pageSessionIds
          )
        )
      : new Set<string>();
    const candidateSessionIds = pageSessionIds.filter(
      (sessionId) => !foreign.has(sessionId)
    );
    if (candidateSessionIds.length === 0) {
      scanCursor = pageSessionIds.at(-1) ?? scanCursor;
      continue;
    }
    sawAnyCandidate = true;
    // ISS-5789 (PRD-635 layer 3): skip the problematic rows, continue with the
    // rest. A session whose delivery rows are still `pending` is the one thing
    // promotion must not touch — re-materializing it DELETEs those rows and
    // discards their in-flight attempt counts and deadlines — but that is a
    // reason to skip THAT session, never a reason to abandon the whole pass. Why
    // each skipped session was skipped is already durable on its own outbox rows
    // (`last_error`, e.g. `session_missing`), so the record survives without this
    // write path taking a logger.
    const promotableSessionIds = selectPromotableInvocationSessions(
      candidateSessionIds,
      await loadBlockedInvocationDeliverySessionIds(
        input.tx,
        input.sourceKey,
        candidateSessionIds
      )
    );
    if (promotableSessionIds.length > 0) {
      return {
        sawAnyCandidate,
        promotableSessionIds,
        exhausted: false,
        scanCursor,
      };
    }
    scanCursor = pageSessionIds.at(-1) ?? scanCursor;
  }
  return { sawAnyCandidate, promotableSessionIds: [], exhausted, scanCursor };
}

/**
 * cr-81036: what a candidate-less scan means depends on WHY it found nothing.
 * A genuinely EXHAUSTED walk completes the revision: stamp the state cursor,
 * drop the backfill cursor. A cap-ended walk — the page cap ran out while only
 * foreign-owned sessions were seen — proves nothing about the corpus beyond
 * the walked window; stamping the revision complete there starved every owned
 * session ordered behind a 100+-row foreign block. Advance only the backfill
 * cursor past the walked block and defer; the wrap brings the sweep back
 * around once the cursor clears the end.
 */
async function settleCandidatelessScan(
  tx: Pick<
    Prisma.TransactionClient,
    "$executeRawUnsafe" | "agentComponentInvocationSyncCursor"
  >,
  input: {
    sourceKey: string;
    templateRevision: number;
    updatedAt: string;
    scan: PromotionScanResult;
  }
): Promise<void> {
  if (input.scan.exhausted) {
    // Raw stays here: the monotone guard (`WHERE source_sequence <
    // excluded.source_sequence`) is a conditional ON CONFLICT update Prisma's
    // `upsert` cannot express, and splitting it into read-then-write would
    // drop the atomicity the guard exists for.
    await tx.$executeRawUnsafe(
      `INSERT INTO agent_component_invocation_sync_cursors
         (source_key, external_session_id, external_generation_id,
          source_sequence, updated_at)
       VALUES ($1, $2, $2, $3, $4)
       ON CONFLICT (source_key, external_session_id) DO UPDATE SET
         source_sequence = excluded.source_sequence,
         updated_at = excluded.updated_at
       WHERE agent_component_invocation_sync_cursors.source_sequence <
             excluded.source_sequence`,
      input.sourceKey,
      AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
      input.templateRevision,
      input.updatedAt
    );
    await tx.agentComponentInvocationSyncCursor.deleteMany({
      where: {
        sourceKey: input.sourceKey,
        externalSessionId: AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID,
      },
    });
    return;
  }
  await tx.agentComponentInvocationSyncCursor.upsert({
    where: {
      sourceKey_externalSessionId: {
        sourceKey: input.sourceKey,
        externalSessionId: AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID,
      },
    },
    create: {
      sourceKey: input.sourceKey,
      externalSessionId: AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID,
      externalGenerationId: input.scan.scanCursor,
      sourceSequence: input.templateRevision,
      updatedAt: input.updatedAt,
    },
    update: {
      externalGenerationId: input.scan.scanCursor,
      sourceSequence: input.templateRevision,
      updatedAt: input.updatedAt,
    },
    select: { sourceKey: true, externalSessionId: true },
  });
}

/**
 * ISS-7096: delete still-`pending` delivery rows (and their per-session
 * cursors) for sessions a DIFFERENT identity pair owns, under one delivery key.
 * Pending only — a dead-letter verdict is a durable record and stays. The
 * sentinel cursor rows can never match: the join requires a real `sessions`
 * row, which no sentinel id has.
 */
async function releaseForeignOwnedDeliveryRows(
  prisma: InvocationPromotionPrismaHost,
  sourceKey: string,
  identity: SignedInUserIdentity
): Promise<void> {
  await prisma.write((client) =>
    client.$transaction(async (tx) => {
      const pendingSessions =
        await tx.agentComponentInvocationSyncOutbox.findMany({
          where: { sourceKey, status: OutboxStatus.Pending },
          select: { externalSessionId: true },
          distinct: ["externalSessionId"],
        });
      const foreign = await loadForeignOwnedInvocationSessionIds(
        tx,
        identity,
        pendingSessions.map((row) => row.externalSessionId)
      );
      if (foreign.length === 0) {
        return;
      }
      for (const chunk of chunkIds(foreign, INVOCATION_ID_BIND_CHUNK_SIZE)) {
        await tx.agentComponentInvocationSyncOutbox.deleteMany({
          where: {
            sourceKey,
            status: OutboxStatus.Pending,
            externalSessionId: { in: chunk },
          },
        });
      }
      for (const chunk of chunkIds(foreign, INVOCATION_ID_BIND_CHUNK_SIZE)) {
        await tx.agentComponentInvocationSyncCursor.deleteMany({
          where: { sourceKey, externalSessionId: { in: chunk } },
        });
      }
    })
  );
}
