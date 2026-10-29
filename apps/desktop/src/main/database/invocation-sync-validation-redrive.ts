/**
 * @file invocation-sync-validation-redrive.ts
 * @description ISS-6909: the ONE-SHOT re-drive for invocation-sync delivery rows
 * that a PREVIOUS cloud build dead-lettered with `validation_failed`.
 *
 * ## The population, and why it is stranded
 *
 * ISS-6883 (#5205) found the ingest charging its in-flight generation cap BEFORE
 * loading the incoming generation, so an already-admitted generation counted
 * against itself: at the cap, part 0 of a generation was admitted and part 1 of
 * that SAME generation came back `validation_failed`. This lane charges
 * `validation_failed` as permanent, so the part dead-lettered on the fifth
 * attempt. #5205 fixed the ordering; it could not repair the rows the defect
 * already parked, because `loadReadyInvocationSyncOutboxParts` selects
 * `status = pending` only and nothing flips a row back
 * (`main/sync/AGENTS.md` invariant 3's KNOWN EXCEPTION).
 *
 * ## What this pass is NOT
 *
 * It is not the general dead-letter recovery mechanism. That is **ISS-5855**,
 * whose recorded decision — periodic sweep vs operator-initiated vs
 * re-admit-on-next-generation, and the recovery-clock question that gates the
 * first two — is deliberately unmade and needs a human. Nothing here schedules a
 * retry ladder, adds a recovery-cycle counter, redefines what `permanent` means,
 * or touches any dead-letter reason other than `validation_failed`. A row this
 * pass re-drives that fails again dead-letters again, on exactly the budget it
 * had before.
 *
 * ## The clock, which is the whole difficulty
 *
 * `session_missing` is budgeted by ROW AGE from `created_at`
 * (`SESSION_MISSING_MAX_RETRY_AGE_MS`, three days), so flipping an old
 * dead-lettered row back to `pending` in place re-admits a row that is instantly
 * `Outlived` and terminalizes on its very first ack — a no-op dressed as a fix.
 * Rewriting `created_at` to buy an age is forbidden: it fabricates data and
 * destroys the evidence.
 *
 * So this pass writes NO outbox row at all. It re-drives by making the ordinary
 * PROMOTION step re-materialize the affected sessions from their template, which
 * is the one path that legitimately re-bases the horizon — the delivery row is
 * DERIVED from the template row rather than being an old row lying about its own
 * age, exactly as it is on first materialization. Concretely it deletes the
 * TARGET's per-session cursor (so `loadPendingInvocationTemplates` owes the
 * session again) and bumps the template's `__invocation_sync_state__` revision
 * (so `prepareInvocationSyncTarget` does not return at its revision guard).
 * `prepareInvocationSyncTarget` then does the delete-and-re-clone it already does
 * whenever a template legitimately changes.
 *
 * ## Why a mixed session is skipped
 *
 * Promotion re-materializes a session WHOLE — its `DELETE` carries no status
 * predicate. A session that also carries a dead-letter this ticket does not
 * authorize re-driving (`session_missing_horizon_exhausted`, `corrupt_created_at`,
 * `part_conflict`, …) would therefore have that row re-driven too, as a side
 * effect. That is a wider recovery policy than ISS-6909 grants, so such a session
 * is left entirely alone and counted instead.
 *
 * ## Idempotency
 *
 * A sentinel row in `agent_component_invocation_sync_cursors`, alongside the
 * lane's four existing sentinels and for the same reason ISS-6889's repair uses
 * one: that table already IS this lane's durable key/value state, and a migration
 * would add a column no query filters on. It is written in the SAME transaction
 * as the re-drive, so the pass is all-or-nothing and a second run — this tick,
 * this boot, or any later one — costs one indexed primary-key read and returns.
 */

import { AgentComponentInvocationSyncRejectReason } from "@repo/api/src/types/agent-component-invocation";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX,
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
} from "../agent-sync/agent-component-invocation-sync-constants.js";
import { bumpInvocationSyncTemplateRevision } from "./invocation-sync-template-revision.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * The cursor sentinel recording that this re-drive has run for this store.
 *
 * Its `source_key` is the TEMPLATE key, not a delivery key: the pass sweeps every
 * delivery queue in the store at once, so its bookkeeping is lane-wide and must
 * not be re-run per compute target.
 */
export const INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID =
  "__invocation_sync_validation_redrive__" as const;

/**
 * Which re-drive generation this store has had applied, stored in the sentinel's
 * `source_sequence`. A store at or above this value is done; anything lower —
 * including the 0 an absent row reads as — is not.
 *
 * A stamped revision rather than a boolean so that a future one-shot re-drive of a
 * DIFFERENT stranded population is a deliberate bump here, and cannot be confused
 * with re-running this one.
 */
export const INVOCATION_SYNC_VALIDATION_REDRIVE_REVISION = 1;

/**
 * How many dead-lettered sessions ONE pass takes.
 *
 * The pass runs inside the lane's single write transaction, and an unbounded
 * scan-and-write there is the full-table walk `MAX_PROMOTION_SCAN_PAGES` exists
 * to prevent one module over: ISS-6883 was a systemic ingest defect, so the
 * stranded population is not guaranteed small, and holding the one writer for
 * all of it would wall off every other lane's capture on the first boot after
 * upgrade. So the pass is PAGED and resumable — it drains across successive
 * prepares instead of in one sitting, and each page costs one bounded read plus
 * one delete per delivery queue. Sized to promotion's own candidate page.
 */
export const REDRIVE_SESSION_PAGE = 100;

/** What one re-drive pass did, for the caller's log line. */
export type InvocationSyncValidationRedriveResult = {
  /** Delivery sessions handed back to promotion. */
  redrivenSessions: number;
  /**
   * Delivery sessions that carry a `validation_failed` dead-letter but were left
   * alone because they also carry a dead-letter of another cause — re-driving
   * them would re-drive that one too (see the file header).
   */
  skippedMixedSessions: number;
};

/** One delivery queue's dead-lettered sessions, split by whether they qualify. */
type RedriveSelection = {
  redrivableSessionIdsByKey: Map<string, string[]>;
  redrivenSessions: number;
  skippedMixedSessions: number;
};

/**
 * Re-drive every delivery session whose dead-letters are all `validation_failed`,
 * at most once per store.
 *
 * Idempotent and safe to call on every prepare: the sentinel read is one indexed
 * primary-key lookup and every later call returns `null` without touching a row.
 */
export async function redriveValidationFailedInvocationParts(
  prisma: Pick<DesktopPrisma, "read" | "write">
): Promise<InvocationSyncValidationRedriveResult | null> {
  const state = await readValidationRedriveState(prisma);
  if (state.completed) {
    return null;
  }
  return await applyValidationRedrivePage(prisma, state.cursor);
}

/** How far the paged pass has got, read from its sentinel row. */
type ValidationRedriveState = {
  /** Whether every page has been drained; nothing more will ever be re-driven. */
  completed: boolean;
  /** The last session id a page took, or "" before the first page. */
  cursor: string;
};

async function readValidationRedriveState(
  prisma: Pick<DesktopPrisma, "read">
): Promise<ValidationRedriveState> {
  const rows = await prisma.read((reader) =>
    reader.agentComponentInvocationSyncCursor.findMany({
      where: {
        sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        externalSessionId: INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID,
      },
      select: { sourceSequence: true, externalGenerationId: true },
    })
  );
  const row = rows[0];
  return {
    completed:
      Number(row?.sourceSequence ?? 0) >=
      INVOCATION_SYNC_VALIDATION_REDRIVE_REVISION,
    cursor: row?.externalGenerationId ?? "",
  };
}

/**
 * The eligibility rule, pure so it is testable without a database: a session
 * qualifies when it has at least one `validation_failed` dead-letter and no
 * dead-letter of any other cause.
 *
 * Takes the distinct (queue, session, cause) triples of the dead-lettered
 * population — one row per cause a session carries, in any order.
 */
export function foldRedrivableDeliverySessions(
  groups: readonly {
    sourceKey: string;
    externalSessionId: string;
    lastError: string | null;
  }[]
): RedriveSelection {
  // The joined string only GROUPS; each identity is carried in the value, so a
  // session id containing the delimiter can never be mis-split back out.
  const bySession = new Map<
    string,
    { sourceKey: string; externalSessionId: string; causes: Set<string | null> }
  >();
  for (const group of groups) {
    const key = `${group.sourceKey}|${group.externalSessionId}`;
    const entry = bySession.get(key) ?? {
      sourceKey: group.sourceKey,
      externalSessionId: group.externalSessionId,
      causes: new Set<string | null>(),
    };
    entry.causes.add(group.lastError);
    bySession.set(key, entry);
  }
  const redrivableSessionIdsByKey = new Map<string, string[]>();
  let redrivenSessions = 0;
  let skippedMixedSessions = 0;
  for (const entry of bySession.values()) {
    // A session with no `validation_failed` dead-letter at all is not this
    // ticket's population and is not a skip — counting it would inflate the
    // "left alone because it was mixed" signal with sessions that were never
    // candidates. Only a session that HAS one and also carries another cause is.
    if (
      !entry.causes.has(
        AgentComponentInvocationSyncRejectReason.ValidationFailed
      )
    ) {
      continue;
    }
    if (entry.causes.size > 1) {
      skippedMixedSessions += 1;
      continue;
    }
    const sessionIds = redrivableSessionIdsByKey.get(entry.sourceKey) ?? [];
    sessionIds.push(entry.externalSessionId);
    redrivableSessionIdsByKey.set(entry.sourceKey, sessionIds);
    redrivenSessions += 1;
  }
  return {
    redrivableSessionIdsByKey,
    redrivenSessions,
    skippedMixedSessions,
  };
}

/**
 * Take ONE page of stranded sessions, hand the qualifying ones back to
 * promotion, and record how far the pass got — all in ONE write transaction.
 *
 * The selection is INSIDE the transaction on purpose. Reading it on the reader
 * pool first would be cheaper, but the live ack/dead-letter path keeps writing
 * while that snapshot ages, so a session that was `validation_failed`-only when
 * it was read can pick up another terminal cause before the write reaches the
 * queue — and promotion re-materializes a session WHOLE, which would then
 * re-drive that other cause too.
 *
 * The page is keyed on `external_session_id` rather than on the full delivery
 * identity so a session's causes can never be SPLIT across a page boundary: half
 * a session's dead-letters would read as unmixed and re-drive a cause this
 * ticket does not authorize. A short page means the keyset is exhausted, so the
 * pass marks itself complete in the same transaction and never scans again; a
 * full page advances the cursor and the next prepare continues. The cursor is
 * strictly increasing, so a session declined as mixed cannot hold the pass open.
 *
 * No outbox row is written or deleted here — deliberately. Retiring the stranded
 * rows and minting their replacements is `prepareInvocationSyncTarget`'s
 * delete-and-re-clone, which is what gives the replacement a `created_at` it
 * legitimately earned instead of one this pass invented.
 *
 * `startsWith` on the delivery prefix, never a raw `LIKE`: the template key
 * contains `_`, which `LIKE` reads as a single-character wildcard.
 */
async function applyValidationRedrivePage(
  prisma: Pick<DesktopPrisma, "write">,
  cursor: string
): Promise<InvocationSyncValidationRedriveResult> {
  const now = new Date().toISOString();
  let applied: InvocationSyncValidationRedriveResult = {
    redrivenSessions: 0,
    skippedMixedSessions: 0,
  };
  await prisma.write((client) =>
    client.$transaction(async (tx) => {
      const deadLetteredWhere = {
        status: OutboxStatus.DeadLettered,
        sourceKey: {
          startsWith: AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX,
        },
      };
      const pageRows = await tx.agentComponentInvocationSyncOutbox.findMany({
        where: {
          ...deadLetteredWhere,
          ...(cursor ? { externalSessionId: { gt: cursor } } : {}),
        },
        select: { externalSessionId: true },
        distinct: ["externalSessionId"],
        orderBy: { externalSessionId: "asc" },
        take: REDRIVE_SESSION_PAGE,
      });
      const pageSessionIds = pageRows.map((row) => row.externalSessionId);
      const lastSessionId = pageSessionIds.at(-1);
      if (!lastSessionId) {
        await writeValidationRedriveState(tx, cursor, true, now);
        return;
      }
      const selection = foldRedrivableDeliverySessions(
        await tx.agentComponentInvocationSyncOutbox.findMany({
          where: {
            ...deadLetteredWhere,
            externalSessionId: { in: pageSessionIds },
          },
          select: {
            sourceKey: true,
            externalSessionId: true,
            lastError: true,
          },
          // One row per (queue, session, cause) — the fold only needs the SET of
          // causes each session carries, so this is the whole population
          // collapsed to what decides eligibility rather than a row scan.
          distinct: ["sourceKey", "externalSessionId", "lastError"],
        })
      );
      for (const [
        sourceKey,
        sessionIds,
      ] of selection.redrivableSessionIdsByKey) {
        await tx.agentComponentInvocationSyncCursor.deleteMany({
          where: { sourceKey, externalSessionId: { in: sessionIds } },
        });
      }
      if (selection.redrivenSessions > 0) {
        // The template revision every target compares its own against.
        // Promotion returns at `targetRevision >= templateRevision`, so without
        // this bump the cleared per-session cursors are never even looked at.
        await bumpInvocationSyncTemplateRevision(tx, now);
      }
      await writeValidationRedriveState(
        tx,
        lastSessionId,
        pageSessionIds.length < REDRIVE_SESSION_PAGE,
        now
      );
      applied = {
        redrivenSessions: selection.redrivenSessions,
        skippedMixedSessions: selection.skippedMixedSessions,
      };
    })
  );
  return applied;
}

/**
 * Record the pass's position, and whether it is finished, on its sentinel row.
 *
 * Written in the SAME transaction as the page it describes, so a crash cannot
 * leave a page applied without its position recorded (which would re-drive it)
 * or a position recorded without its page (which would skip it).
 */
async function writeValidationRedriveState(
  tx: {
    agentComponentInvocationSyncCursor: {
      upsert(args: unknown): Promise<unknown>;
    };
  },
  cursor: string,
  completed: boolean,
  nowIso: string
): Promise<void> {
  const sourceSequence = completed
    ? INVOCATION_SYNC_VALIDATION_REDRIVE_REVISION
    : 0;
  await tx.agentComponentInvocationSyncCursor.upsert({
    // Both columns of the `@@id`, so the write keeps its single-row semantics
    // without asking for a `RETURNING *` nobody reads.
    select: { sourceKey: true, externalSessionId: true },
    where: {
      sourceKey_externalSessionId: {
        sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        externalSessionId: INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID,
      },
    },
    create: {
      sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      externalSessionId: INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID,
      externalGenerationId: cursor,
      sourceSequence,
      updatedAt: nowIso,
    },
    update: {
      externalGenerationId: cursor,
      sourceSequence,
      updatedAt: nowIso,
    },
  });
}
