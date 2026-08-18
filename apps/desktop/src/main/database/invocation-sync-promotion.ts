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
import {
  loadBlockedInvocationDeliverySessionIds,
  loadInvocationTemplatePartCounts,
  loadPendingInvocationTemplates,
  MAX_PENDING_INVOCATION_DELIVERY_PARTS,
  type RawQueryClient,
  selectPromotableInvocationSessions,
  selectSessionsWithinPartBudget,
} from "./invocation-sync-pending-templates.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** The write surface this step needs from the desktop Prisma host. */
export type InvocationPromotionPrismaHost = Pick<DesktopPrisma, "write">;

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
  sessionLimit: number
): Promise<void> {
  if (sourceKey === templateSourceKey) {
    return;
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
      });
      if (!scan.sawAnyCandidate) {
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
          sourceKey,
          AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
          templateRevision,
          updatedAt
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM agent_component_invocation_sync_cursors
            WHERE source_key = $1 AND external_session_id = $2`,
          sourceKey,
          AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID
        );
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
      // ISS-5789 (@wongk review): admit candidates against the parts they would
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
            next_attempt_at, last_error, created_at, updated_at)
         SELECT $1, outbox.external_session_id,
                outbox.external_generation_id, outbox.part_index,
                outbox.part_count, outbox.part_hash,
                outbox.source_updated_at, outbox.data_revision,
                outbox.source_sequence, outbox.payload, $4, 0,
                NULL, NULL, $3, $3
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
  tx: RawQueryClient;
  sourceKey: string;
  templateSourceKey: string;
  backfillCursor: string;
  boundedLimit: number;
}): Promise<PromotionScanResult> {
  let scanCursor = input.backfillCursor;
  let wrapped = input.backfillCursor === "";
  let sawAnyCandidate = false;
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
        break;
      }
      wrapped = true;
      scanCursor = "";
      continue;
    }
    sawAnyCandidate = true;
    const candidateSessionIds = templates.map(
      (template) => template.external_session_id
    );
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
      return { sawAnyCandidate, promotableSessionIds };
    }
    scanCursor = candidateSessionIds.at(-1) ?? scanCursor;
  }
  return { sawAnyCandidate, promotableSessionIds: [] };
}
