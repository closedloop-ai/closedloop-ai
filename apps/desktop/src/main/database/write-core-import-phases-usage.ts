/**
 * @file write-core-import-phases-usage.ts
 * @description Record groups 3-5: the token-accounting substrate — token_usage, token_events
 * with their derived costs, and the activity-segment tiling that joins against
 * them. `persistActivitySegments` is exported here for the backfill path.
 */
import {
  type ActivitySegmentRecord,
  activitySegmentId,
} from "../collectors/parsing/activity-segment-classifier.js";
import { CodexOtelTokenUsageSource } from "../otel/codex-otel-contract.js";
import type { Prisma } from "./generated/client.js";
import type { ImportSessionContext } from "./import-session-context.js";
import { backfillSessionModel } from "./session-model-backfill.js";
import { persistImportedTokenCosts } from "./token-cost-writes.js";
import { replaceTokenEvents } from "./token-event-contract.js";

/**
 * Record group 3: token usage. Delete-then-reinsert the JSONL-parser-sourced
 * token_usage rows, then backfill session.model from tokensByModel when null.
 */
export async function importPhaseTokenUsage(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, now, tokenUsage, earliestTokenTs, tokenSeries } = ctx;
  const parsedModels = Object.entries(session.tokensByModel ?? {});
  // ISS-7736: an EMPTY parse is not an authoritative "this session used nothing".
  // The delete below is deliberate for a non-empty derivation (see FEA-1459), but
  // the delete-then-reinsert shape reads a zero-model re-parse as "the answer is
  // nothing" rather than "the parse produced nothing usable", and wipes the rows a
  // previous good parse wrote. The cloud ingest path already preserves on an empty
  // payload; without this guard the two surfaces disagree and desktop is the wrong
  // one. A parse that yields nothing carries no information, so it overwrites
  // nothing.
  if (parsedModels.length > 0) {
    // FEA-1459 (PR #1511 review): delete+reinsert. The boot importer derives full
    // totals from the entire transcript every run, so the new derivation is
    // authoritative — and overwrite-by-model alone would leave stale rows behind
    // when a model key disappears under the new parser. That wholesale
    // replacement is preserved exactly: the guard above narrows WHEN it runs, not
    // what it does.
    await tx.$executeRawUnsafe(
      "DELETE FROM token_usage WHERE session_id = $1 AND usage_source = $2",
      session.sessionId,
      CodexOtelTokenUsageSource.JsonlParser
    );
    for (const [model, counts] of parsedModels) {
      // FEA-1459 Fix 5: Pass activity timestamp instead of now() for created_at.
      await tokenUsage.replace(
        session.sessionId,
        model,
        counts,
        now,
        tx,
        earliestTokenTs ?? undefined
      );
    }
  }
  // FEA-1459 Fix 9 (ISS-4649 finding 8): backfill session.model when null,
  // picking the latest token record by TIMESTAMP — see ./session-model-backfill.js.
  await backfillSessionModel(tx, session, tokenSeries, now);
}

/**
 * Record group 4: token_events AND their derived cost estimates, in ONE
 * transaction. `persistImportedTokenCosts` annotates the just-inserted
 * token_events rows in place (`updateTokenEventCost` issues
 * `UPDATE token_events SET cost_*`), so the insert and the cost UPDATE are
 * write-coupled and MUST commit together: if they were separate isolated
 * transactions and the insert failed, the UPDATE would silently match zero rows
 * and commit "successfully", leaving cost columns permanently unpopulated.
 * Delete+reinsert is idempotent — the boot importer derives the full record set
 * every call.
 */
export async function importPhaseTokenEventsAndCosts(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, harness, now, earliestTokenTs, tokenEventsRecords } = ctx;
  // ISS-7736: same empty-derivation rule as `importPhaseTokenUsage` above, and it
  // has to be the same or the two token stores disagree. `tokenEventsRecords` is
  // empty exactly when that phase preserves (it is `tokenSeries`, or a fallback
  // synthesized per `tokensByModel` entry — see buildImportSessionContext), so
  // letting `replaceTokenEvents`' unconditional DELETE run here would preserve
  // `token_usage` and empty `token_events` for the same session. That is not the
  // old wipe repeated, it is a NEW divergence: `runTokenParityCheck` joins the
  // two per (session_id, model) and raises `token_store_divergence` on exactly
  // this shape. Preserve both or replace both.
  if (tokenEventsRecords.length === 0) {
    return;
  }
  const persistedTokenEvents = await replaceTokenEvents(
    tx,
    session.sessionId,
    tokenEventsRecords,
    ctx.parsePolicy.attributionEvidence
  );
  await persistImportedTokenCosts(tx, {
    sessionId: session.sessionId,
    harness,
    tokenUsageObservedAt: earliestTokenTs ?? session.startedAt ?? now,
    tokenEvents: persistedTokenEvents,
    tokenEventObservedAtFallback: session.startedAt ?? now,
  });
}

/**
 * FEA-2267: replace a session's activity-segment tiling via delete-then-reinsert.
 * Idempotent — the classifier derives the FULL ordered set from the parsed
 * session every call (like replaceTokenEvents), so a re-import or backfill
 * re-derive overwrites cleanly. Uses the typed `sessionActivitySegment`
 * delegate (deleteMany + createMany); BigInt timing bounds are coerced from the
 * record's JS numbers. Returns the number of segment rows written. Exported so
 * the backfill (activity-segment-backfill.ts) persists through the SAME writer.
 */
export async function persistActivitySegments(
  tx: Prisma.TransactionClient,
  sessionId: string,
  segments: ActivitySegmentRecord[],
  now: string
): Promise<number> {
  await tx.sessionActivitySegment.deleteMany({ where: { sessionId } });
  if (segments.length === 0) {
    return 0;
  }
  await tx.sessionActivitySegment.createMany({
    data: segments.map((seg) => ({
      id: activitySegmentId(sessionId, seg.startMs, seg.version),
      sessionId,
      phase: seg.phase,
      startMs: BigInt(seg.startMs),
      endMs: BigInt(seg.endMs),
      confidence: seg.confidence,
      evidenceLayers: seg.evidenceLayers,
      version: seg.version,
      workItemRef: seg.workItemRef ?? null,
      // FEA-2271: null for main-agent segments; set to the parser-stable local
      // subagent id when the segment's spend was re-filed to a subagent's purpose.
      subagentId: seg.subagentId ?? null,
      observedAt: now,
    })),
  });
  return segments.length;
}

/**
 * Record group: activity segments (FEA-2267). Persist the session's complete
 * activity-phase tiling. ORDERING IS LOAD-BEARING: this MUST run after
 * importPhaseTokenEventsAndCosts so token_events exist for the per-segment spend
 * join (Σ reconciliation). Recompute-from-source ⇒ idempotent.
 */
export async function importPhaseActivitySegments(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, now, activitySegments } = ctx;
  await persistActivitySegments(tx, session.sessionId, activitySegments, now);
}
