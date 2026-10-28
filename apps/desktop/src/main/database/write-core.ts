/**
 * @file write-core.ts
 * @description The desktop SQLite WRITE subsystem, extracted from the sqlite.ts
 * orchestrator. It owns the importer entry point, the isolated and atomic
 * orchestrators, and shared hook/import helpers. The twelve ordered record-group
 * writers live in the ./write-core-import-phases-*.js siblings (ISS-7578), one
 * module per phase group: -session, -events, -usage, -links, -rollups. Those
 * siblings never import back — the derived-rollup phase takes the last-activity
 * recomputation as a callback, preserving the one-way module graph.
 * `openSqliteAgentDatabase` in `sqlite.ts` wires the subsystem together.
 */
import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import { createLongLivedSessionAttributionCache } from "../agent-sync/session-attribution-cache.js";
import {
  DATA_REVISION_IMPORT_PENDING,
  dataRevisionFor,
} from "../collectors/engine/data-revision.js";
import type { Harness, NormalizedSession } from "../collectors/types.js";
import type {
  Importer,
  ImportResult,
} from "../dashboard/agent-dashboard-db-types.js";
import { effectiveParsePolicy } from "../parse-policy/effective-parse-policy.js";
import type { ParsePolicy } from "../parse-policy/parse-policy.js";
import type { PullRequestPreservedFields } from "../pull-requests/pr-store.js";
import { runOutsideStoreReadCancellation } from "./db-host/store-read-cancellation.js";
import { yieldDbHostLoop } from "./db-host/yield-db-host-loop.js";
import type { Prisma } from "./generated/client.js";
import {
  createImportGroupTimer,
  createImportGroupWriter,
} from "./import-group-telemetry.js";
import {
  ImportFailureLogPrefix,
  importGroupFailedPrefix,
} from "./import-log-messages.js";
import {
  buildImportSessionContext,
  type ImportSessionContext,
  type ImportSessionWriteDeps,
} from "./import-session-context.js";
import { NORMALIZED_PR_LINK_METHOD } from "./pr-link-maintenance.js";
import type { DesktopPrisma } from "./prisma-client.js";
import type { createSqliteTokenUsageStore } from "./read-stores.js";
import { advanceSessionSyncWatermark } from "./session-sync-watermark.js";
import { SESSION_LAST_ACTIVITY_AT_VALUE_SQL } from "./session-timestamp-form.js";
import { findUnsafeImportTokenCount } from "./unsafe-import-token-count.js";
import { importPhaseEvents } from "./write-core-import-phases-events.js";
import {
  importPhaseArtifactLinks,
  importPhaseComponentInvocations,
  importPhasePullRequests,
  importPhaseSegmentWorkItemRefs,
} from "./write-core-import-phases-links.js";
import {
  buildPolicyOperationEvidence,
  importPhaseOperationClaims,
} from "./write-core-import-phases-operation-claims.js";
import {
  importPhaseActivityMetrics,
  importPhaseDerivedRollups,
} from "./write-core-import-phases-rollups.js";
import { importPhaseSessionAndMainAgent } from "./write-core-import-phases-session.js";
import {
  importPhaseActivitySegments,
  importPhaseTokenEventsAndCosts,
  importPhaseTokenUsage,
} from "./write-core-import-phases-usage.js";

export function createSqliteImporter(
  prisma: DesktopPrisma,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: ImportSessionWriteDeps & {
    now: () => string;
    onPostImport?: (cwd: string | null) => void;
    /**
     * ISS-4572: evict the task OWNED by `sessionId` from the shared write queue
     * (see {@link Importer.cancelInFlightWrite}). Supplied by
     * `openSqliteAgentDatabase`, which owns the queue. Absent in tests/paths that
     * don't need eviction — the importer then omits `cancelInFlightWrite`.
     */
    cancelInFlightWrite?: NonNullable<Importer["cancelInFlightWrite"]>;
    /**
     * ISS-7256: read-only "is this session's write still only WAITING?" probe over
     * the same queue. Supplied alongside `cancelInFlightWrite`; absent in
     * tests/paths that don't need it, and the importer then omits the hook.
     */
    hasUndispatchedWrite?: NonNullable<Importer["hasUndispatchedWrite"]>;
  } & ImportGroupYieldDeps
): Importer {
  // ISS-8611: bounded — one importer is built per `openSqliteAgentDatabase`
  // and memoizes every imported session's cwd for the life of the store
  // process, so an uncapped map grows with the corpus and never shrinks.
  const attributionCache: SessionAttributionResolverCache =
    createLongLivedSessionAttributionCache();
  const cancelInFlightWrite = deps.cancelInFlightWrite;
  const hasUndispatchedWrite = deps.hasUndispatchedWrite;
  const importDeps = {
    ...deps,
    yieldBetweenGroups:
      deps.yieldBetweenGroups ??
      serializeImportGroupTurns(yieldImportGroupBoundary),
  };
  return {
    ...(cancelInFlightWrite
      ? {
          cancelInFlightWrite: (sessionId: string, reason?: Error) =>
            cancelInFlightWrite(sessionId, reason),
        }
      : {}),
    ...(hasUndispatchedWrite
      ? {
          hasUndispatchedWrite: (sessionId: string) =>
            hasUndispatchedWrite(sessionId),
        }
      : {}),
    async importSession(
      session: NormalizedSession,
      harness: Harness,
      // ISS-12552: the import gates and stamps under the policy it is given.
      // The collector manager passes the one its parse ran under (through the
      // import-health wrapper, which forwards it), so a flip between a parse
      // and its import cannot seal the session under the wrong revision. A
      // caller that passes none imports under this store's current policy.
      parsePolicy: ParsePolicy = effectiveParsePolicy()
    ): Promise<ImportResult> {
      if (
        typeof session.sessionId !== "string" ||
        session.sessionId.length === 0 ||
        !session.startedAt
      ) {
        return { skipped: true, reactivated: false };
      }
      const now = deps.now();
      // Each record group commits in its own isolated transaction (see
      // importSessionIsolated) — there is no single import-wide transaction.
      // Per-group failures are handled and tolerated inside; this outer try/catch
      // is a backstop for the pre-transaction context build (filesystem reads for
      // launch metadata).
      try {
        const result = await importSessionIsolated(
          prisma,
          tokenUsage,
          importDeps,
          session,
          harness,
          now,
          attributionCache,
          parsePolicy
        );
        if (!result.skipped && deps.onPostImport) {
          deps.onPostImport(session.cwd ?? null);
        }
        return result;
      } catch (error) {
        deps.log(
          `${ImportFailureLogPrefix.ImportSession} ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
        );
        return { skipped: true, reactivated: false, failed: true };
      }
    },
  };
}

/**
 * Run every import phase on a SINGLE caller-supplied transaction. Used by the
 * data-revision rebuild ({@link rebuildSessionFromParse}), which first tears the
 * session's derived rows down and must replace them atomically: a mid-rebuild
 * failure has to roll the whole teardown back rather than leave the session with
 * deleted-but-not-rebuilt data. The normal ingest path uses
 * {@link importSessionIsolated} instead, committing each phase independently.
 */
export async function importSessionWithTx(
  tx: Prisma.TransactionClient,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: ImportSessionWriteDeps,
  session: NormalizedSession,
  harness: Harness,
  now: string,
  attributionCache: SessionAttributionResolverCache,
  parsePolicy: ParsePolicy,
  pullRequestPreserved?: ReadonlyMap<string, PullRequestPreservedFields>
): Promise<ImportResult> {
  const ctx = buildImportSessionContext(
    tokenUsage,
    deps,
    session,
    harness,
    now,
    attributionCache,
    parsePolicy,
    pullRequestPreserved
  );
  const operationEvidence = await buildPolicyOperationEvidence(ctx);
  const { existed, reactivated, sessionDataChanged, createdAtChanged } =
    await importPhaseSessionAndMainAgent(tx, ctx);
  const { inserted } = await importPhaseEvents(tx, ctx);
  await importPhaseTokenUsage(tx, ctx);
  await importPhaseTokenEventsAndCosts(tx, ctx);
  await importPhaseActivitySegments(tx, ctx);
  const { capturedArtifactLinks } = await importPhaseArtifactLinks(tx, ctx);
  const { claimsChanged } = await importPhaseOperationClaims(
    tx,
    session.sessionId,
    operationEvidence,
    now
  );
  // ISS-12552: new claims are owed to the cloud even when nothing else in the
  // synced payload moved.
  if (claimsChanged && !sessionDataChanged) {
    await advanceSessionSyncWatermark(tx, session.sessionId, now);
  }
  const { capturedPullRequests } = await importPhasePullRequests(tx, ctx);
  await importPhaseSegmentWorkItemRefs(tx, ctx);
  await importPhaseComponentInvocations(tx, ctx);
  await importPhaseDerivedRollups(tx, ctx, recomputeSessionLastActivityAt);
  // FEA-2273: the atomic rebuild is all-or-nothing by contract, so the metrics
  // emission runs in the same transaction here — a failure rolls the rebuild back
  // with everything else. (In the normal ingest path it is instead an isolated
  // best-effort group; see importSessionIsolated.)
  await importPhaseActivityMetrics(tx, ctx);
  return {
    skipped:
      existed &&
      inserted === 0 &&
      capturedPullRequests === 0 &&
      capturedArtifactLinks === 0 &&
      !claimsChanged &&
      !reactivated,
    reactivated,
    // FEA-3659: surface the CONTENT-change signal for the data-revision rebuild
    // caller. `skipped` is derived from re-derived child-row counts, which a
    // rebuild always re-inserts (>0) after tearing them down, so it can never
    // report "unchanged" for a rebuild. `sessionDataChanged` reflects whether the
    // session's synced payload (metadata blob) actually changed under the new
    // revision — the precise signal for whether the row's updated_at was bumped
    // and therefore needs to (re-)sync to the cloud.
    sessionDataChanged,
    createdAtChanged,
  };
}

/**
 * Run each import record group in its OWN isolated transaction (through the
 * shared write queue) instead of wrapping the whole import in one transaction.
 * This means: the import never holds a single write
 * connection open for its full duration; each group's rows become visible to the
 * dashboard as soon as that group commits; and one group failing (e.g. a
 * malformed PR) no longer discards the entire import.
 *
 * The session+main-agent group GATES the import — it is the FK parent for every
 * other row, so if it fails there is nothing to attach to and the import is
 * reported failed. Every later group is tolerant: its failure is logged and
 * skipped, and re-import converges because each group is an idempotent
 * delete-then-reinsert (or ON CONFLICT) unit.
 *
 * NOTE: each `prisma.write` below is a separate write-queue task, so this must
 * never be called from inside an outer `prisma.write`/`$transaction` (that would
 * deadlock the queue). The atomic, single-transaction rebuild path uses
 * {@link importSessionWithTx} instead.
 */
async function importSessionIsolated(
  prisma: DesktopPrisma,
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>,
  deps: ImportSessionWriteDeps & Required<ImportGroupYieldDeps>,
  session: NormalizedSession,
  harness: Harness,
  now: string,
  attributionCache: SessionAttributionResolverCache,
  parsePolicy: ParsePolicy
): Promise<ImportResult> {
  const ctx = buildImportSessionContext(
    tokenUsage,
    deps,
    session,
    harness,
    now,
    attributionCache,
    parsePolicy
  );

  // FEA-2027: a session carrying a token counter that cannot be represented
  // exactly is skipped WHOLE — before any group commits — so no corrupt row
  // lands in token_usage OR token_events. Not a failure: the rest of the source
  // keeps importing (the old single-transaction import marked this failed,
  // which halted the source).
  const unsafeTokenCount = findUnsafeImportTokenCount(ctx);
  if (unsafeTokenCount) {
    deps.log(
      `sqlite import: skipping ${session.sessionId} — unsafe token count (${unsafeTokenCount.message}); nothing written`
    );
    return { skipped: true, reactivated: false };
  }

  // ISS-4572: tag every write in THIS import with the session id so the
  // per-session timeout (`cancelInFlightWrite(sessionId)`) evicts only this
  // session's own queued/in-flight task — never an unrelated healthy session's
  // transaction at the queue head.
  const writeToken = session.sessionId;
  // ISS-12552: extracted before any group opens a transaction.
  const operationEvidence = await buildPolicyOperationEvidence(ctx).catch(
    (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      deps.log(
        `sqlite import: operation claims extraction failed for ${session.sessionId}: ${failure.message}`
      );
      return failure;
    }
  );

  // ISS-6003: the ISS-4410 bound reports only the whole-import total, so the
  // group actually responsible for a wedge was invisible in production logs.
  // Built BEFORE the gate because the gate and the activity-metrics rollup carry
  // their own failure contracts and so bypass `runGroup` — yet either can burn
  // the same 120s bound, so both are timed through `timedGroupWrite` too.
  const groupTimer = createImportGroupTimer(deps.log);
  // Starts each group's clock on DISPATCH (never at enqueue, so shared-queue
  // delay is not charged to the group) and attributes an eviction to the group
  // that was holding the writer. Rethrows unchanged — every call site below
  // keeps its own failure contract.
  const timedGroupWrite = createImportGroupWriter({
    timer: groupTimer,
    prisma,
    writeToken,
    ctx,
  });

  // ISS-10401: hand the store thread's loop back BEFORE every group's write is
  // queued. The twelve groups below otherwise chain on microtask continuations
  // alone, and `@libsql/client` is synchronous, so the thread never reached the
  // poll phase where a renderer read's `Execute` is delivered: a Sessions or
  // Branches listing read posted mid-import waited out the WHOLE session (and
  // every sibling harness's session in flight). One turn per group lets it
  // interleave between groups instead. Always outside the group's transaction —
  // #7538 measured a yield INSIDE one charging a foreign op's whole runtime to
  // that transaction's 120 s wall-clock budget — and before the enqueue, so the
  // ISS-6003 per-group clock (which starts on dispatch) never counts the gap.
  // The gap is NOT free for the main-side ISS-4410 bound, whose call-time clock
  // now spans the foreign reads served here; `bounded-import-session.ts` states
  // that exposure. `importSessionWithTx` must never take this: it runs inside
  // one caller transaction, which is exactly the #7538 shape.
  const { yieldBetweenGroups } = deps;

  // Gating group: the FK parent. If it fails, abort — there is nothing the later
  // groups could attach rows to. ISS-4572: stamp the PENDING sentinel revision
  // here (not the real DATA_REVISION); the final seal group promotes it to the
  // real revision only after every later group commits without eviction, so an
  // interrupted import re-heals on the next rebuild instead of being sealed at the
  // current revision with derived rows missing.
  let gate: {
    existed: boolean;
    reactivated: boolean;
    sessionDataChanged: boolean;
    revisionStamped: boolean;
  };
  await yieldBetweenGroups();
  try {
    gate = await timedGroupWrite("session_main_agent", (tx, gateCtx) =>
      importPhaseSessionAndMainAgent(tx, gateCtx, DATA_REVISION_IMPORT_PENDING)
    );
  } catch (error) {
    // ISS-6003: an eviction here abandons the import before any tolerant group
    // runs, so this is the only place the report can still be emitted.
    groupTimer.report(session.sessionId);
    deps.log(
      `${ImportFailureLogPrefix.SessionMainAgent} ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return { skipped: true, reactivated: false, failed: true };
  }

  // Tolerant groups: each commits independently; a failure is logged and the
  // import continues. Returns the group's result, or null when it failed. A
  // failure records the group's label, which makes the import `incomplete` (see
  // the ImportResult.incomplete contract) so the caller re-imports the source
  // next pass; ISS-5103 also surfaces those labels on the result.
  //
  // ISS-4572: a group rejected with WriteQueueCancelledError is the per-session
  // timeout EVICTING this session's own wedged write. That is not an ordinary
  // group failure — the whole import is being abandoned mid-flight — so it also
  // records the eviction on `groupTimer`, whose `evicted()` SUPPRESSES the final
  // revision seal below. The row therefore stays at the PENDING sentinel and
  // re-heals on the next rebuild rather than being sealed at the current
  // revision with rows missing.
  const failedGroups: string[] = [];
  const runGroup = async <T>(
    label: string,
    group: (
      tx: Prisma.TransactionClient,
      ctx: ImportSessionContext
    ) => Promise<T>
  ): Promise<T | null> => {
    // ISS-6003: eviction rejects THIS caller early but leaves the abandoned
    // transaction holding the writer, so queuing another group parks here and
    // the import never reaches the report below — exactly the persistent wedge
    // the report exists for. An abandoned import must not commit anything more
    // anyway, so stop queuing instead. Not a group failure: these groups were
    // never attempted, and the eviction already made the import `incomplete`.
    if (groupTimer.evicted()) {
      return null;
    }
    await yieldBetweenGroups();
    try {
      return await timedGroupWrite(label, group);
    } catch (error) {
      deps.log(
        `${importGroupFailedPrefix(label)} ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
      failedGroups.push(label);
      return null;
    }
  };

  /* FEA-2729 + FEA-3227 + ISS-5801 + ISS-8699 + ISS-8757: links, the invocation
     set, and the event content each move the cloud sync cursor on their own,
     because each can change while the session's synced metadata blob does not
     (`sessionDataChanged` false) — and then only `updated_at` can tell the
     incremental scan there is anything to fetch.

     ISS-8758 (whitlockk on #6383): the bump commits in the SAME transaction as the
     change, never in the tolerant `sync_watermark` group it used to occupy. Each
     of the three signals is a before/after observation of state the pass itself
     committed, so a bump lost to a failed group was lost PERMANENTLY: the retry
     re-read the same durable state, computed `false`, and never re-attempted it.
     Sharing the transaction makes the pair all-or-nothing — a failed group rolls
     its change back too, so the next pass re-observes it and bumps again. */
  /* ISS-8871 KEEPS the `!gate.sessionDataChanged` skip: it was suspect because
     the gate's own write could be a NO-OP on a tie, leaving the later groups
     riding a watermark that had not moved, and the gate's write is strictly
     forward as of this change. Two carve-outs it still does NOT cover, both
     pre-existing and neither a tie:
       - the groups commit in separate transactions, so a sync read can land
         between the gate's commit and a later group's; that group then has no
         step of its own; and
       - `sessionSyncWatermarkTarget` can DECLINE (a stored value with no
         orderable successor), and the skip keys on `sessionDataChanged`, not on
         whether the gate's write actually moved — so a declined gate write
         suppresses the later groups too.
     Closing them means dropping `!gate.sessionDataChanged` so every changed
     group takes a step of its own (davetho on #6582), and that is a follow-up
     rather than a side effect of this fix because of what the extra steps do to
     the CLOCK a changed import lands on — MEASURED, not assumed. `changed` still
     guards, so the byte-identical path is untouched; but a pass in which the
     gate AND n groups changed then lands at `now + n ms` instead of `now`, and a
     FIRST import is exactly that pass. Seeding one live session on
     `12:00:00.000Z` lands it at `12:00:00.003Z` (events, artifact_links,
     invocations each stepping), which reds 13 assertions across the sibling
     ISS-8758 oracle (`sync-watermark-durability.test.ts`,
     `incremental-sync-event-only-append.test.ts`) and drifts `sessions.updated_at`
     in all 33 frozen `test/golden/layer2-snapshots/*.json`, every one of which
     pins the injected clock verbatim. Regenerating that oracle is a reviewed step
     of its own, not a review-thread fix. */
  const advanceWatermarkIfOwed = async (
    tx: Prisma.TransactionClient,
    changed: boolean
  ): Promise<void> => {
    if (changed && !gate.sessionDataChanged) {
      await advanceSessionSyncWatermark(tx, session.sessionId, now);
    }
  };

  // ISS-8757: resolved BEFORE the group opens its transaction — the ISS-4591
  // probe issues its own query, and its contract is that a prepare error can
  // never land mid-write. It memoizes, so this is one query per database, not one
  // per import. Unwired ⇒ the portable checksum over the same projection.
  const hasRowDigest = (await deps.supportsRowDigest?.()) ?? false;
  const eventsResult = await runGroup("events", async (tx, eventsCtx) => {
    const result = await importPhaseEvents(tx, eventsCtx, { hasRowDigest });
    // ISS-8757 widened `eventsChanged` to `boolean | null`: `null` is NOT
    // MEASURED (no content signal supplied), a different claim from "unchanged",
    // and no evidence of change is no bump.
    await advanceWatermarkIfOwed(tx, result.eventsChanged === true);
    return result;
  });
  await runGroup("token_usage", importPhaseTokenUsage);
  await runGroup("token_events", importPhaseTokenEventsAndCosts);
  await runGroup("activity_segments", importPhaseActivitySegments);

  // SYNC INVARIANT (FEA-2729 / PLN-1296): artifact-link rows (branch/PR/slug
  // refs) are written here, in the same importSession pass that
  // importPhaseSessionAndMainAgent bumps `sessions.updated_at`. The cloud sync
  // driver selects sessions by that `updated_at` watermark (the FEA-1962
  // durable cursor), so a link change propagates to the cloud *because* its
  // session's updated_at advanced in this pass. Do NOT write
  // session_artifact_links outside importSession (e.g. a targeted SQL backfill)
  // without also bumping the parent session's updated_at, or add a per-kind
  // artifact-link cursor — otherwise the new/re-derived refs will never sync.
  /* FEA-3227 + ISS-8758: the link fingerprint is bracketed inside each writing
     phase's OWN transaction, not across a pair of separate snapshot groups, so
     the fingerprint, the rows it describes, and the bump it justifies share one
     commit. The two phases jointly own `session_artifact_links` and partition it
     by method: this one owns everything except `normalized_pr`, which is the PR
     phase's. Comparing the full set in either phase would read a byte-identical
     re-import as a link change on every pass.

     ISS-8905: each phase now also TEARS DOWN only its own half, so each snapshots
     at the head of its own transaction and no state has to be handed across the
     group boundary. Before that the artifact-links DELETE took the PR-owned rows
     with it, which is why the PR phase used to need this group's pre-DELETE
     snapshot — and why a failed PR group could leave a durable deletion with no
     bump to describe it. */
  const artifactLinksResult = await runGroup(
    "artifact_links",
    async (tx, linkCtx) => {
      const inherited = await snapshotSessionArtifactLinks(
        tx,
        session.sessionId
      );
      const result = await importPhaseArtifactLinks(tx, linkCtx);
      const linksChanged = await linkSetChanged(tx, session.sessionId, {
        before: inherited,
        ownedByPullRequestPhase: false,
      });
      // ISS-12552: operation claims ride this group's transaction, as the
      // attribution evidence beside the links. A failed extraction is logged
      // and leaves the stored claims as they were.
      const { claimsChanged } =
        operationEvidence instanceof Error
          ? { claimsChanged: false }
          : await importPhaseOperationClaims(
              tx,
              session.sessionId,
              operationEvidence,
              now
            );
      await advanceWatermarkIfOwed(tx, linksChanged || claimsChanged);
      return { ...result, linksChanged, claimsChanged };
    }
  );
  const pullRequestsResult = await runGroup(
    "pull_requests",
    async (tx, prCtx) => {
      // ISS-8905: the PR-owned rows as they stand at the head of THIS
      // transaction, which is now their pre-teardown state whether or not the
      // artifact-links group committed — that phase no longer touches them.
      const inherited = await snapshotSessionArtifactLinks(
        tx,
        session.sessionId
      );
      const result = await importPhasePullRequests(tx, prCtx);
      const linksChanged = await linkSetChanged(tx, session.sessionId, {
        before: inherited,
        ownedByPullRequestPhase: true,
      });
      await advanceWatermarkIfOwed(tx, linksChanged);
      return { ...result, linksChanged };
    }
  );

  // FEA-2272: stamp optional work_item_ref after BOTH links and PRs exist.
  // Tolerant: a failure leaves the tiling intact with the column unset. Writes
  // only session_activity_segments (never session_artifact_links), so it sits
  // outside both link-phase fingerprints above and cannot perturb either.
  await runGroup("segment_work_item_refs", importPhaseSegmentWorkItemRefs);

  // Invocation branch attribution consumes only created write-evidence links,
  // so materialize after the artifact phases have committed in this same pass.
  // This keeps first import byte-identical to a re-import while preserving the
  // isolated events dependency.
  const invocationResult =
    eventsResult === null
      ? null
      : await runGroup("component_invocations", async (tx, invocationCtx) => {
          const result = await importPhaseComponentInvocations(
            tx,
            invocationCtx
          );
          // ISS-5801 (whitlockk on #6166): an invocation-set change is
          // watermark-worthy for the same reason a link change is — AND it is
          // what makes a previously withheld parent substantive. Without this
          // bump, a deriver upgrade that first materializes a
          // slash/skill/subagent/hook-only session's invocations queues the
          // children while the parent stays behind the incremental cursor, and
          // they terminally reject with `session_missing`.
          await advanceWatermarkIfOwed(tx, result.invocationSetChanged);
          return result;
        });

  // `null` = the tolerant group failed or was skipped, so this pass holds no
  // evidence of change — and, since ISS-8758, no bump can have been lost either:
  // a failed group rolled its change back with it.
  const linksChanged =
    artifactLinksResult?.linksChanged === true ||
    pullRequestsResult?.linksChanged === true;
  // ISS-8699 + ISS-8757: watermark-worthy because a durable change to the STORED
  // event content — a new row, or an existing tool row gaining its `tool_result`
  // detail on a later parse — changes no metadata (`events` is not in the blob)
  // and cannot reactivate (reactivation is gated on `!isLive`), so before this
  // the session's `updated_at` never moved and the cursor never re-selected it.
  // The fold is over the rebuild gate's projection, a strict SUPERSET of the five
  // columns FEA-2718 leaves on the wire, so a `summary`/`data`-only change bumps
  // here and then re-uploads an identical payload — see ISS-8876.
  const eventsChanged = eventsResult?.eventsChanged === true;
  const claimsChanged = artifactLinksResult?.claimsChanged === true;

  await runGroup("analytics_rollup", (tx, importContext) =>
    importPhaseDerivedRollups(
      tx,
      importContext,
      recomputeSessionLastActivityAt,
      invocationResult !== null
    )
  );

  // FEA-2273: activity-metrics emission is a SECONDARY rollup with a boot-backfill
  // safety net (backfillActivityMetrics), so it runs in its OWN transaction —
  // never the analytics group's, so it cannot abort the primary rollup — and its
  // failure is logged WITHOUT flipping `incomplete`. A transient metrics failure
  // (e.g. the token_events it reads is briefly unavailable) must not force a
  // whole-session re-import; the version-aware backfill refreshes it instead.
  // ISS-6003: it is timed like every other group (it can burn the same 120s
  // bound), and it is skipped after an eviction for the same reason `runGroup`
  // is — the abandoned transaction still holds the writer.
  if (!groupTimer.evicted()) {
    await yieldBetweenGroups();
    try {
      await timedGroupWrite("activity_metrics", importPhaseActivityMetrics);
    } catch (error) {
      deps.log(
        `${ImportFailureLogPrefix.ActivityMetrics} ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /* ISS-4572: SEAL the real revision now that every group has committed.
     The gate stamped DATA_REVISION_IMPORT_PENDING so an import EVICTED mid-flight
     (a genuinely-wedged write the per-session timeout cancelled) leaves the row at
     the sentinel and re-heals on the next data-revision-rebuild instead of sealing
     at the current revision with derived rows missing (the orphaned-session
     hazard). Seal only when:
       - the gate actually wrote the revision column (`revisionStamped`) — a no-op
         re-import of an already-current row wrote nothing and needs no seal; and
       - no group was CANCELLED — an ordinary tolerated group failure still seals
         (its `incomplete` flag re-imports the source next pass), but a cancellation
         is a true mid-flight abandonment that must fall to the rebuild.
     The seal is itself tolerant: if IT is cancelled/fails the row simply stays at
     the sentinel and re-heals — never worse than the orphan this prevents. */
  if (gate.revisionStamped && !groupTimer.evicted()) {
    const sealed = await runGroup("revision_seal", async (tx) => {
      await tx.$executeRawUnsafe(
        "UPDATE sessions SET data_revision = $1 WHERE id = $2 AND data_revision = $3",
        dataRevisionFor(parsePolicy),
        session.sessionId,
        DATA_REVISION_IMPORT_PENDING
      );
    });
    // An evicted seal is already recorded by `runGroup` (incomplete → re-import
    // next pass) and noted on `groupTimer`; the row stays at the sentinel.
    if (sealed === null) {
      deps.log(
        `${ImportFailureLogPrefix.RevisionSeal} for ${session.sessionId}; row left at pending revision to re-heal on rebuild`
      );
    }
  }

  groupTimer.report(session.sessionId);

  // FEA-3227: `skipped` means "byte-identical re-import — nothing changed."
  // Events and PRs are deterministic derivations of the NormalizedSession input,
  // so their re-derived COUNTS (inserted, capturedPullRequests) are false-positive
  // change signals when the input hasn't changed. The five real change detectors:
  // sessionDataChanged (metadata/revision diff), linksChanged (fingerprint diff),
  // claimsChanged (ISS-12552, the operation-claims digest),
  // eventsChanged (ISS-8699, widened by ISS-8757 — the stored event CONTENT
  // before vs after this pass, which unlike `inserted` survives the
  // purge-and-re-derive and unlike a row count sees an equal-cardinality
  // rewrite), and reactivated (status flip).
  const noOpReimport =
    gate.existed &&
    !gate.sessionDataChanged &&
    !linksChanged &&
    !eventsChanged &&
    !claimsChanged &&
    !gate.reactivated;
  return {
    skipped: noOpReimport,
    reactivated: gate.reactivated,
    // A tolerated group failure leaves the import partial: re-import next pass
    // (idempotent) instead of marking the source seen. Both derive from one list.
    incomplete: failedGroups.length > 0 || undefined,
    ...(failedGroups.length > 0 ? { failedGroups } : {}),
    // ISS-12036: the SAME predicate as `skipped` above, plus the requirement
    // that no tolerated group failed. Read off one local so the two can never
    // disagree about whether this import was a no-op. A partial import is not
    // one: it left a record group unwritten, so it must keep counting toward the
    // wedge even though nothing about the session itself changed.
    ...(noOpReimport && failedGroups.length === 0 ? { unchanged: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// FEA-3294: invocation-backed component usage materialization
// ---------------------------------------------------------------------------

/**
 * (Re)compute and persist `sessions.last_activity_at` — the denormalized cursor
 * sort key the Sessions list orders by — for one session from its current
 * `events` / `started_at` rows, on every ingest write and every live hook event.
 * An already-violating row is repaired by `healSessionLastActivityAtFloor`, the
 * source-independent pre-sweep boot heal, which re-invokes this per discovered
 * session — for CANONICAL-MODE rows; see that heal for the legacy-mode hole it
 * declines by construction. The data-revision rebuild re-invokes this too, but
 * reaches only sessions whose source transcript survives.
 *
 * NOT cheap, and not a MAX-through-index seek: the fold maxes a per-row
 * canonicalizing CASE, which no index ordering can serve, so it visits every
 * event row of the session through the covering `idx_events_session_type_created`
 * — O(events in session), 54.8ms at 10k events (ISS-5497).
 *
 * Exported as the single source of truth for this denormalized-key UPDATE: the
 * live-hook ingest path and the boot heal both call it, and so do test fixtures
 * that write events directly — never a copy.
 */
// ISS-5429 / ISS-5497: the floor expression, the canonical-form pair, and the
// assigned VALUE expression itself moved WHOLE to ./session-timestamp-form.js —
// see that file for the FEA-3591 floor and the ISS-5497 canonicalization, and
// its header for why the whole family lives together.
export async function recomputeSessionLastActivityAt(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE sessions
       SET last_activity_at = ${SESSION_LAST_ACTIVITY_AT_VALUE_SQL}
     WHERE id = $1`,
    sessionId
  );
}

// Per-session aggregate CTEs (agent/event counts + token totals) the detail
// reads LEFT-JOIN onto the filtered/paginated session set in a single query.

function snapshotSessionArtifactLinks(
  tx: Prisma.TransactionClient,
  sessionId: string
) {
  return tx.$queryRawUnsafe<SessionArtifactLinkRow[]>(
    "SELECT artifact_id, relation, method FROM session_artifact_links WHERE session_id = $1 ORDER BY artifact_id, relation",
    sessionId
  );
}

/**
 * Re-snapshot the session's links and report whether the slice owned by the
 * CALLING phase moved away from `before`. The re-read sits inside that phase's
 * own transaction so no concurrent writer can slip between the two — the same
 * bracketing the events phase uses for its stored-count comparison.
 */
async function linkSetChanged(
  tx: Prisma.TransactionClient,
  sessionId: string,
  scope: {
    before: SessionArtifactLinkRow[];
    ownedByPullRequestPhase: boolean;
  }
): Promise<boolean> {
  const after = await snapshotSessionArtifactLinks(tx, sessionId);
  const owned = (rows: SessionArtifactLinkRow[]) =>
    JSON.stringify(
      rows.filter(
        (row) =>
          (row.method === NORMALIZED_PR_LINK_METHOD) ===
          scope.ownedByPullRequestPhase
      )
    );
  return owned(scope.before) !== owned(after);
}

// ISS-5182: `sweepStaleSessions` lived here as a near-copy of the boot reaper
// and stamped `ended_at` with the sweep wall clock, which FEA-3580 had already
// corrected in the reaper. Both entry points now share one body —
// `sweepStaleActiveSessions` in session-maintenance.ts — called with
// `excludeSessionId` from the live `SessionStart` path.

/** One row of the session's artifact-link fingerprint. */
type SessionArtifactLinkRow = {
  artifact_id: string;
  relation: string;
  method: string;
};

/**
 * ISS-10401: the cooperative yield `importSessionIsolated` awaits before each
 * record group's write is queued. Production leaves it unset, and
 * `createSqliteImporter` chains {@link yieldImportGroupBoundary} turns across its
 * imports ({@link serializeImportGroupTurns}). The
 * queued-read harness (`test/import-yield-queued-reads.test.ts`) supplies a
 * microtask-only resolver for its control arm — the shape that reproduces the
 * hang — and ISS-8571 flips the same arm when a reader thread retires the
 * yields. It lives on the importer's own deps rather than
 * `ImportSessionWriteDeps` so the type keeps it away from `importSessionWithTx`.
 */
type ImportGroupYieldDeps = {
  yieldBetweenGroups?: () => Promise<void>;
};

/**
 * ISS-10401: the production between-group yield — `yieldDbHostLoop` (FEA-2264,
 * the store thread's sanctioned interleave) run with NO cancellation scope.
 *
 * `yieldDbHostLoop` is also the ISS-9802 cancellation checkpoint, and every
 * between-group await in `importSessionIsolated` sits OUTSIDE its group's
 * `try`: a throw there skips the tolerant group handling and unwinds the whole
 * import to `failed`. No import runs under a token today
 * (`runWithReadCancellationToken` is entered only by the dashboard read IPC),
 * but `db-host-client.ts` attaches the ambient token to whatever op is going
 * out, by name, so nothing structural keeps it that way. Exiting the scope here
 * makes the throw impossible rather than merely unreached: cancellation may
 * abandon a read; it must never abandon a write — the rule `write-queue.ts`
 * already applies to the task it dispatches (marisolashgrove review, #7553).
 * `test/import-yield-queued-reads.test.ts` runs an import under a cancelled
 * token to pin it.
 */
function yieldImportGroupBoundary(): Promise<void> {
  return runOutsideStoreReadCancellation(yieldDbHostLoop);
}

/**
 * ISS-10911: every import in flight on one store takes its between-group turn
 * from a single chain, so at most ONE import record group runs per loop turn.
 * With a bare yield per import, N concurrent imports each queued a `setImmediate`,
 * all N fired in the same check phase, and N groups ran back to back before the
 * poll phase delivered anything — a read paid N groups at each of its own
 * macrotask boundaries (ISS-10935: `syncSource.aggregateUsage` minutes of wait
 * against ~15 ms of its own SQL). Imports do no extra work: the write queue
 * already ran their groups one at a time; only which loop turn each runs in
 * changes.
 */
function serializeImportGroupTurns(
  yieldTurn: () => Promise<void>
): () => Promise<void> {
  let previousTurn: Promise<void> = Promise.resolve();
  return () => {
    const turn = previousTurn.then(yieldTurn);
    previousTurn = turn.catch(() => undefined);
    return turn;
  };
}
