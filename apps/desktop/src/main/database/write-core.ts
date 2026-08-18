/**
 * @file write-core.ts
 * @description The desktop SQLite WRITE subsystem, extracted from the sqlite.ts
 * orchestrator — after the decomposition wave, what remains here is: the
 * historical importer (createSqliteImporter + the import phases + the
 * isolated-tx runner) and the shared hook/import helpers
 * (recomputeSessionLastActivityAt — importEventData now
 * lives in ./import-metadata-builders.js, and pull-request persistence in
 * ./write-core-pull-requests.js).
 *
 * Two LEAF siblings that write-core imports FROM: the token-cost write
 * primitives + the token-cost conservation invariant (persistImportedTokenCosts /
 * updateTokenUsageCost / updateTokenEventCost / updateSessionCostRollup /
 * chooseConservedUsageCost / webSearchCostSql) -> ./token-cost-writes.js
 * (ISS-4936, persistImportedTokenCosts in the import phase); and the
 * session-analytics rollup primitives (`upsertSessionAnalyticsRollup` /
 * `upsertSessionAnalyticsRollupBatch` + their metadata-budget chunking) ->
 * ./session-analytics-rollup.js (ISS-4937, upsertSessionAnalyticsRollup in the
 * import phase's derived-rollup step). The other extracted siblings instead
 * import the shared helpers above FROM here: the Claude live-hook lifecycle
 * (createSqliteLifecycle / handleHook + its per-transaction hook primitives)
 * -> ./live-hook.js
 * (ISS-4825); the boot backfill + headless/imported analytics maintenance passes
 * -> ./session-analytics-maintenance.js (ISS-4851); the token-cost reprice +
 * heals -> ./token-cost-maintenance.js (ISS-4852); the import-metadata builders
 * (incl. importEventData) -> ./import-metadata-builders.js (ISS-4853); the
 * turn-bucket derivation -> ./turn-buckets.js (FEA-3597); and the artifact-link
 * persistence subsystem it drives (persistArtifactLinks / buildRepoResolver) ->
 * ./artifact-link-persistence.js (ISS-4628). Every dependency is one-directional,
 * so there is no cycle. `openSqliteAgentDatabase` in `sqlite.ts` wires these into
 * the `SqliteAgentDatabase`. Depends only on leaf modules and the generated
 * Prisma client, never on `sqlite.ts` or `live-hook.ts`, so there is no cycle.
 */
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import {
  DATA_REVISION,
  DATA_REVISION_IMPORT_PENDING,
} from "../collectors/engine/data-revision.js";
import {
  type ActivitySegmentRecord,
  activitySegmentId,
} from "../collectors/parsing/activity-segment-classifier.js";
import { extractWorkItemOccurrences } from "../collectors/parsing/work-item-occurrences.js";
import type { Harness, NormalizedSession } from "../collectors/types.js";
import type {
  Importer,
  ImportResult,
} from "../dashboard/agent-dashboard-db-types.js";
import { CodexOtelTokenUsageSource } from "../otel/codex-otel-contract.js";
import type { PullRequestPreservedFields } from "../pull-requests/pr-store.js";
import { upsertActivityMetricsRollup } from "./activity-metrics.js";
import { persistArtifactLinks } from "./artifact-link-persistence.js";
import { materializeAgentComponentInvocations } from "./component-invocations.js";
import { DESKTOP_AGENT_STATUS, TERMINAL_STATUS_SET } from "./db-constants.js";
import { safe, strOf, truncate } from "./db-helpers.js";
import {
  buildEventDedupKey,
  deterministicEventId,
} from "./deterministic-event-id.js";
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
  buildSubagentMetadata,
  importToolEventData,
  mintParserSubagentAgentIds,
  subagentName,
  subagentRowSpan,
} from "./import-metadata-builders.js";
import {
  buildImportSessionContext,
  type ImportSessionContext,
  type ImportSessionWriteDeps,
} from "./import-session-context.js";
import {
  importedMainAgentStatus,
  resolveImportedEndsWithError,
  resolveImportedSessionStatus,
} from "./imported-session-status.js";
import { COMMIT_SHA_CORRELATION_METHOD } from "./pr-link-maintenance.js";
import type { DesktopPrisma } from "./prisma-client.js";
import type { createSqliteTokenUsageStore } from "./read-stores.js";
import { stampSegmentWorkItemRefs } from "./segment-work-item-stamp.js";
import { upsertSessionAnalyticsRollup } from "./session-analytics-rollup.js";
import { backfillSessionModel } from "./session-model-backfill.js";
import { buildSessionIdentityInsert } from "./session-owner-identity.js";
import { SESSION_LAST_ACTIVITY_AT_VALUE_SQL } from "./session-timestamp-form.js";
import { buildValuesTuples, chunkRowsByParamCap } from "./sql-values-tuples.js";
import {
  buildSubagentDedupIndex,
  delegationClaimKey,
} from "./subagent-dedup.js";
import { persistImportedTokenCosts } from "./token-cost-writes.js";
import { replaceTokenEvents } from "./token-event-contract.js";
import { findUnsafeImportTokenCount } from "./unsafe-import-token-count.js";
import {
  getImportSession,
  upsertImportedMainAgentSpine,
} from "./write-core-main-agent-spine.js";
import { persistNormalizedPullRequests } from "./write-core-pull-requests.js";
import { reconcileTerminalSession } from "./write-core-terminal-end.js";

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
  }
): Importer {
  const attributionCache: SessionAttributionResolverCache = {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
  const cancelInFlightWrite = deps.cancelInFlightWrite;
  return {
    ...(cancelInFlightWrite
      ? {
          cancelInFlightWrite: (sessionId: string, reason?: Error) =>
            cancelInFlightWrite(sessionId, reason),
        }
      : {}),
    async importSession(
      session: NormalizedSession,
      harness: Harness
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
          deps,
          session,
          harness,
          now,
          attributionCache
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
 * Record group 1 (GATING): the session row and its main agent. Every other row
 * is an FK child of these, so the isolated orchestrator aborts the import if
 * this phase fails. Idempotent: existing sessions are COALESCE-updated and the
 * main agent is ON CONFLICT DO NOTHING, so a re-import never clobbers live state.
 * FEA-3578: `name` is the exception — it takes the freshly-parsed value
 * (`COALESCE($1, name)`, latest wins) so a Claude session's harness AI title,
 * which may change across syncs, propagates on re-import/rebuild. `model`/`cwd`/
 * `billing_mode` stay first-wins sticky. The parser always emits a non-empty
 * `name` (AI title → cwd-derived fallback), so the fresh value is never null.
 */
async function importPhaseSessionAndMainAgent(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext,
  // ISS-4572: the `data_revision` value stamped on the session row by this gate.
  // Defaults to the current DATA_REVISION (the atomic rebuild path, which commits
  // the whole import in ONE transaction, so an interruption rolls the gate back
  // too). The ISOLATED import path passes DATA_REVISION_IMPORT_PENDING here and
  // seals the real revision in a final group only after every later group has
  // committed without eviction — so an interrupted isolated import leaves the row
  // at the sentinel and re-heals on the next data-revision-rebuild rather than
  // masquerading as fully imported at the current revision.
  revisionToStamp: number = DATA_REVISION
): Promise<{
  existed: boolean;
  reactivated: boolean;
  sessionDataChanged: boolean;
  // ISS-4572: whether this gate actually WROTE the `data_revision` column (a new
  // row, a content change, or a revision-only heal). The isolated import path
  // seals the real revision afterward ONLY when this is true, so a no-op re-import
  // of an already-current row adds no seal write.
  revisionStamped: boolean;
}> {
  const { session, harness, now, recentlyActive, mainId, detectBillingMode } =
    ctx;
  const existing = await getImportSession(tx, session.sessionId);
  let reactivated = false;
  let sessionDataChanged = true;
  // Set true in every branch that writes the `data_revision` column below.
  let revisionStamped = !existing;
  const billingMode =
    safe(() => detectBillingMode(harness, session.model ?? null)) ?? "unknown";

  if (existing) {
    const newMetadata = ctx.sessionMetadata;
    // FEA-3659: split the change-gate into its two independent signals so a
    // DATA_REVISION bump does not masquerade as a content change.
    //   - contentChanged: the derived metadata blob actually differs, OR the
    //     persisted display name would change. This is the ONLY signal the cloud
    //     sync watermark should track — buildImportMetadata is engineered
    //     byte-stable across revisions that don't touch a session's derived fields
    //     (golden-snapshot-enforced), so a differing blob is a true content change
    //     that must reach the cloud. FEA-3578: `name` (the Claude ai-title) is NOT
    //     part of the metadata blob, yet a changed title is real content that must
    //     sync to Artifact.name — fold it in here so a name-only refresh (and the
    //     one-time ai-title backfill) takes the content path (updated_at bump +
    //     `name = COALESCE($1, name)` fresh-wins) rather than the revision-only
    //     heal below, which keeps the old name via `COALESCE(name, $1)`.
    //   - revisionChanged: the durable data_revision marker is stale. On a bump,
    //     this is true for the WHOLE corpus even where the payload is identical.
    // Only contentChanged is surfaced as `sessionDataChanged`, so the sync
    // watermark bump (updated_at) and the links-only / skip logic downstream stay
    // keyed on real content change. When a revision bump re-derives a byte-identical
    // row we stamp ONLY data_revision (healing the durable marker so the row is not
    // re-rebuilt next boot) WITHOUT touching updated_at — the cloud already has this
    // exact metadata, so the row is a true sync no-op.
    // `nextName` mirrors the content-branch UPDATE's `COALESCE($1, name)` (a parse
    // yielding no name keeps the old one), so the comparison fires exactly when the
    // stored name would actually change.
    const nextName = session.name ?? existing.name;
    // FEA-4376: a fresh REAL assistant model id (not a `/model` display-label
    // fallback) may upgrade a previously-stored fallback label. `model` is
    // COALESCE-sticky, so without this the label the parser wrote when the
    // transcript had only the `/model` echo would persist forever even after
    // assistant records appeared. A real id is authoritative and reparses
    // identically from the same transcript, so it can overwrite unconditionally
    // (the SET below switches from `COALESCE(model, $2)` to `model = $2`).
    // Treat the actual value flip as content so the cloud copy re-syncs (a
    // model-only change is invisible to `buildImportMetadata`, which omits it).
    const freshModelIsRealId =
      session.model != null && session.modelIsFallback !== true;
    const modelUpgrade = freshModelIsRealId && existing.model !== session.model;
    const contentChanged =
      existing.metadata !== newMetadata ||
      nextName !== existing.name ||
      modelUpgrade;
    const revisionChanged = existing.dataRevision !== DATA_REVISION;
    sessionDataChanged = contentChanged;
    // Either branch below writes the `data_revision` column; the no-op else keeps
    // the row untouched, so no seal is needed for it.
    revisionStamped = contentChanged || revisionChanged;
    const modelSetClause = freshModelIsRealId
      ? "model = $2"
      : "model = COALESCE(model, $2)";
    if (contentChanged) {
      await tx.$executeRawUnsafe(
        `UPDATE sessions SET
          name = COALESCE($1, name),
          ${modelSetClause},
          cwd = COALESCE(cwd, $3),
          harness = CASE WHEN COALESCE(harness, '') = '' THEN $4 ELSE harness END,
          billing_mode = CASE WHEN COALESCE(billing_mode, '') IN ('', 'unknown') THEN $5 ELSE billing_mode END,
          metadata = $6,
          data_revision = $7,
          updated_at = $8
         WHERE id = $9`,
        session.name ?? null,
        session.model ?? null,
        session.cwd ?? null,
        harness,
        billingMode,
        newMetadata,
        revisionToStamp,
        now,
        session.sessionId
      );
    } else if (revisionChanged) {
      // Revision-only stamp: heal the durable marker AND run the fill-from-null
      // COALESCE/CASE column heal (name/model/cwd/harness/billing_mode), but
      // leave the sync watermark (updated_at) and the `metadata` blob untouched
      // so a byte-identical re-derivation stays a true sync no-op on a
      // DATA_REVISION bump. The heal is fill-only (COALESCE(name, …) /
      // CASE-empty), so it can only populate a previously-absent value the fresh
      // parse now knows — never overwrite live data and never flip the metadata
      // blob. updated_at is intentionally NOT bumped: these columns rarely go
      // from null→value on a revision bump, and when they do the value reaches
      // the cloud on the next genuine content-change sync of this row; bumping
      // updated_at here would re-enumerate every stale-revision row and defeat
      // the targeted-resync this change exists to enable.
      await tx.$executeRawUnsafe(
        `UPDATE sessions SET
          name = COALESCE(name, $1),
          model = COALESCE(model, $2),
          cwd = COALESCE(cwd, $3),
          harness = CASE WHEN COALESCE(harness, '') = '' THEN $4 ELSE harness END,
          billing_mode = CASE WHEN COALESCE(billing_mode, '') IN ('', 'unknown') THEN $5 ELSE billing_mode END,
          data_revision = $6
         WHERE id = $7`,
        session.name ?? null,
        session.model ?? null,
        session.cwd ?? null,
        harness,
        billingMode,
        revisionToStamp,
        session.sessionId
      );
    }
    const isLive =
      existing.status === SESSION_STATUS.ACTIVE && existing.endedAt == null;
    if (recentlyActive && !isLive) {
      // ISS-4586: refresh ends_with_error from THIS parse as the row reactivates,
      // so a stale terminal flag (e.g. a prior `error`) from before it came back
      // to life cannot later steer the reaper's error-vs-inactive decision.
      const reactivatedEndsWithError = resolveImportedEndsWithError(session)
        ? 1
        : 0;
      await tx.$executeRawUnsafe(
        `UPDATE sessions SET status = '${SESSION_STATUS.ACTIVE}', ended_at = NULL, updated_at = $1, ends_with_error = $2 WHERE id = $3`,
        now,
        reactivatedEndsWithError,
        session.sessionId
      );
      // Gap 7: Stamp awaiting_input_since so the dashboard Kanban board
      // places the session in the Waiting column (matches SessionStart
      // behavior in the live-hook path).
      await tx.$executeRawUnsafe(
        `UPDATE agents SET status = '${DESKTOP_AGENT_STATUS.WAITING}', ended_at = NULL, current_tool = NULL, awaiting_input_since = $1, updated_at = $1 WHERE id = $2`,
        now,
        mainId
      );
      reactivated = true;
    }
    const sessionActiveNow = isLive || reactivated;
    // ISS-4586 (@wongk): refresh the durable ends_with_error flag on EVERY
    // re-import of a still-active row, not only on the terminal→active
    // reactivation above. A live session that re-imports with a fresh trailing
    // unrecovered error (or a recovery) must not keep the stale flag the reaper
    // would later read — otherwise an orphan sweep can publish `inactive` after
    // the newest parse reported `error` (or vice versa). Terminal rows get their
    // flag from the reconciliation below; this covers the active/live path (the
    // reactivation UPDATE already wrote the same value, so this is a harmless
    // no-op in that sub-case).
    if (sessionActiveNow) {
      await tx.$executeRawUnsafe(
        "UPDATE sessions SET ends_with_error = $1 WHERE id = $2",
        resolveImportedEndsWithError(session) ? 1 : 0,
        session.sessionId
      );
    }
    /* ISS-5182 / FEA-4187: an already-terminal row's end-and-status
       reconciliation — advance a frozen `ended_at` the fresh parse outran, then
       heal its failed-vs-completed classification. Body and rationale in
       ./write-core-terminal-end.js. A live/reactivated row is not terminal, so
       it is skipped here and left to its owning paths. */
    const reconciledTerminal = sessionActiveNow
      ? null
      : await reconcileTerminalSession(tx, { existing, mainId, now, session });
    // FEA-1785: Ensure the main agent row exists unconditionally. The rebuild
    // pass deletes all agents rows before re-importing, so a previously-imported
    // session may lack its main agent. ON CONFLICT DO NOTHING is safe when the
    // agent already exists (normal non-rebuild import path).
    // Status must reflect the session's POST-reactivation state: a rebuilt
    // terminal session inside the recent-activity window was just flipped to
    // 'active' above (and the agent UPDATE no-oped on the missing row), so the
    // recreated main agent must be 'waiting', not 'completed'. A terminal
    // session's recreated agent mirrors the reconciled failed-vs-completed
    // status (ERROR or COMPLETED) so a rebuild that dropped the agent row cannot
    // resurrect a failed run's main agent as `completed`.
    const agentStatus =
      reconciledTerminal == null
        ? DESKTOP_AGENT_STATUS.WAITING
        : importedMainAgentStatus(reconciledTerminal.status);
    // ISS-5182: the reconciliation's POST-advance end, not `existing.endedAt` —
    // a recreated agent must not be re-frozen at the end the row carried on
    // entry when the fresh parse just proved a later one.
    const agentEndedAt =
      reconciledTerminal == null ? null : (reconciledTerminal.endedAt ?? now);
    await tx.$executeRawUnsafe(
      `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, current_tool, started_at, updated_at, ended_at, parent_agent_id, metadata)
       VALUES ($1, $2, 'main', 'main', NULL, $3, NULL, NULL, $4, $5, $6, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      mainId,
      session.sessionId,
      agentStatus,
      session.startedAt,
      now,
      agentEndedAt
    );
  } else {
    const status = resolveImportedSessionStatus(session, recentlyActive);
    // INACTIVE and ERROR are both terminal (the run is over); ACTIVE is not.
    // A terminal run stamps ended_at and closes its main agent, so a failed
    // (ERROR) import is recorded as a finished-but-failed run, not a live one.
    const isTerminal = TERMINAL_STATUS_SET.has(status);
    const endedAt = isTerminal ? (session.endedAt ?? now) : null;
    // ISS-4586: persist the durable ends_with_error flag at import for EVERY
    // row, terminal or live. The reaper (`sweepOrphanedSessions`) reads it to
    // declare an orphaned still-`active` row `error` vs `inactive` WITHOUT
    // re-parsing the transcript, so a live row must carry the flag too (it is
    // refreshed on every re-import). Stored as a SQLite boolean 1/0.
    const endsWithError = resolveImportedEndsWithError(session) ? 1 : 0;
    // The `sessions` row is provably absent here: `getImportSession` (findUnique
    // on `sessions.id`) returned null in THIS single-writer transaction, so no
    // concurrent insert can land the PK before this INSERT. A bare INSERT is
    // therefore correct — an `ON CONFLICT` merge arm would be dead code that could
    // only bypass the `if (existing)` reconciliation rules (shafty ISS-4476).
    // ISS-6168: the identity columns are bound from the SAME shared builder the
    // live-hook INSERT uses. Before this, only the live path wrote them, so every
    // imported session persisted a NULL owner and the desktop Owner column was
    // blank for the entire corpus while web resolved it fine.
    const identity = buildSessionIdentityInsert(ctx.getUserIdentity, 13);
    await tx.$executeRawUnsafe(
      `INSERT INTO sessions (id, name, status, cwd, model, started_at, updated_at, ended_at, harness, billing_mode, metadata, data_revision, ends_with_error, ${identity.columns})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ${identity.placeholders})`,
      session.sessionId,
      session.name ?? null,
      status,
      session.cwd ?? null,
      session.model ?? null,
      session.startedAt,
      // ISS-5086: `updated_at` is the local→cloud sync watermark, not the
      // session's activity time. A historical transcript can be discovered long
      // after its ended_at; stamping that old timestamp placed the new row below
      // an already-advanced cursor and made it invisible forever. `last_activity_at`
      // / `ended_at` retain event chronology, while the fresh import wall clock
      // makes this newly-created row observable to incremental sync.
      now,
      isTerminal ? (session.endedAt ?? null) : null,
      harness,
      billingMode,
      ctx.sessionMetadata,
      revisionToStamp,
      endsWithError,
      ...identity.values
    );
    // Gap 7: For recently-active (non-terminal) sessions, stamp
    // awaiting_input_since so the dashboard Kanban board places the session in
    // the Waiting column. A terminal run (completed OR failed) is never waiting.
    const awaitingSince = recentlyActive && !isTerminal ? now : null;
    // ISS-4476: the `sessions` row was absent, but a residual `<id>-main` agent
    // can still hold this PK. Recover it ONLY when it genuinely belongs to this
    // session's canonical main agent; a cross-session / non-main collision fails
    // closed (throws → import `failed`) instead of reparenting another session's
    // row. Full rationale in {@link upsertImportedMainAgentSpine}.
    await upsertImportedMainAgentSpine(tx, {
      mainId,
      sessionId: session.sessionId,
      status: importedMainAgentStatus(status),
      awaitingSince,
      startedAt: session.startedAt,
      now,
      endedAt,
    });
  }

  return {
    existed: existing != null,
    reactivated,
    sessionDataChanged,
    revisionStamped,
  };
}

/**
 * Record group 2: events (and the subagent agent rows interleaved with them).
 * A single atomic delete-then-reinsert: the FEA-1459 purge of import-derived
 * rows, the post-purge high-water-mark read, and the buffered chunked re-insert
 * all commit together so the events table is never observed mid-rewrite. This
 * is the perf-tuned phase — events are buffered and flushed in chunked multi-row
 * INSERTs rather than one round-trip per row.
 */
async function importPhaseEvents(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ inserted: number }> {
  const { session, now, mainId } = ctx;
  // FEA-1459 (PR #1511 review): purge import-derived rows before re-deriving,
  // so a forced reimport (PERSIST_VERSION bump, subagent-mtime change) cannot
  // stack new rows next to stale residue from the v1 pipeline (idx-keyed
  // subagent ids doubling agentCount, per-content-block Stop events inflating
  // heatmaps, 14k+ duplicate tool events).
  // - agents: the `-sub-` id infix is the subagent namespace shared by this
  //   importer and the live-hook spawner. Only terminal rows are purged:
  //   a status='working' hook row must survive so matchSubagent can resolve
  //   the upcoming SubagentStop. Any transient double (working hook row +
  //   completed import row for the same logical subagent) converges on the
  //   next reimport, which the finished subagent's transcript append
  //   guarantees.
  // - events: exactly the types this importer re-derives below. Hook-only
  //   types (Notification, SessionStart/End, UserPromptSubmit, ...) are
  //   untouched. The high-water-mark query below runs AFTER the purge, so the
  //   re-derived events insert with an empty HWM for these types.
  await tx.$executeRawUnsafe(
    `DELETE FROM agents WHERE session_id = $1 AND type = 'subagent'
       AND (id LIKE '%-sub-%' OR id LIKE '%-parser-sub-%') AND status IN ('completed', 'error')`,
    session.sessionId
  );
  await tx.$executeRawUnsafe(
    `DELETE FROM events WHERE session_id = $1 AND event_type IN
       ('Stop', 'PreToolUse', 'PostToolUse', 'TurnDuration', 'APIError', 'ToolError', 'Compaction')`,
    session.sessionId
  );

  const highWater = new Map<string, string>();
  const hwm = await tx.event.groupBy({
    by: ["eventType"],
    where: { sessionId: session.sessionId },
    _max: { createdAt: true },
  });
  for (const row of hwm) {
    if (row._max.createdAt) {
      highWater.set(row.eventType, row._max.createdAt);
    }
  }

  let inserted = 0;
  // FEA-1459 Fix 7: Per-import dedup set to prevent exact (type, ts, toolName)
  // duplicates within a single import run (14,520 were duplicates before fix).
  const importEventSeen = new Set<string>();
  // perf: buffer per-event rows here and flush them in chunked multi-row
  // INSERTs (see flushEventBuffer) instead of one round-trip per event. A
  // large session can carry thousands of events; one INSERT per row inside the
  // transaction was the dominant import cost. Buffering preserves ordering,
  // columns, and the ON CONFLICT (id) DO NOTHING semantics exactly — the same
  // rows are written, just in fewer statements.
  const eventRowBuffer: [
    string, // id
    string, // session_id
    string, // agent_id
    string, // event_type
    string | null, // tool_name
    string | null, // summary
    string | null, // data
    string, // created_at
    string | null, // git_branch (FEA-2990)
  ][] = [];
  const addEvent = (
    eventType: string,
    agentId: string,
    ts: string | null,
    toolName: string | null,
    summary: string | null,
    data: string | null,
    /** FEA-1459 Fix D: Optional discriminator for tool-use dedup (e.g. toolu_* id). */
    discriminator?: string,
    /**
     * FEA-2990: the working git branch this tool ran on, carried straight from
     * NormalizedToolUse.gitBranch. Null for non-tool events, Codex, and any
     * harness that doesn't record per-line branch.
     *
     * SCOPE — best-effort, CWD-derived; NOT authoritative branch attribution.
     * Per the FEA-2531 rule (see artifact-ref-extractor.ts), raw `tu.gitBranch`
     * reports the session CWD's checkout, which is wrong for worktree sessions
     * (a session whose CWD is `main` while it edits a `feat/x` worktree reports
     * `main`). Evidence-first branch resolution lives in `session_artifact_links`;
     * this per-event value is intentionally the coarse fallback, used only to
     * split component-usage rollups by observed working branch. The cloud fold
     * (`getDetailForOrg.branchesTab`) treats the `''` (no-branch) bucket as
     * unattributed and defers to the session-level `SessionBranch` link, so
     * worktree imprecision here never overrides evidence-based attribution.
     */
    gitBranch?: string | null
  ): void => {
    if (!ts) {
      return;
    }
    const prev = highWater.get(eventType);
    if (prev != null && ts <= prev) {
      return;
    }
    // FEA-1459 Fix 7+D: Skip within-import duplicates. Tool-use events include
    // a discriminator (tool_use id or array index) so two same-tool calls in
    // the same ms don't collapse.
    const dedupKey = buildEventDedupKey(eventType, ts, toolName, discriminator);
    if (importEventSeen.has(dedupKey)) {
      return;
    }
    importEventSeen.add(dedupKey);
    eventRowBuffer.push([
      deterministicEventId(
        session.sessionId,
        eventType,
        ts,
        toolName,
        discriminator
      ),
      session.sessionId,
      agentId,
      eventType,
      toolName,
      summary,
      data,
      ts,
      gitBranch ?? null,
    ]);
    inserted++;
  };
  // perf: write the buffered event rows in chunked multi-row INSERTs. Each row
  // binds 8 params; cap rows per statement so the bound-parameter count stays
  // well under the SQLite/libSQL variable limit. ON CONFLICT (id) DO NOTHING is
  // preserved, so a re-import that hits existing ids is still a no-op.
  const flushEventBuffer = async (): Promise<void> => {
    if (eventRowBuffer.length === 0) {
      return;
    }
    // 9 columns per row; chunk so the bound-param count stays under the cap.
    for (const chunk of chunkRowsByParamCap(eventRowBuffer, 9)) {
      const { tuples, params } = buildValuesTuples(chunk);
      await tx.$executeRawUnsafe(
        `INSERT INTO events (id, session_id, agent_id, event_type, tool_name, summary, data, created_at, git_branch) VALUES ${tuples.join(", ")} ON CONFLICT (id) DO NOTHING`,
        ...params
      );
    }
    eventRowBuffer.length = 0;
  };

  const parserSubagents = session.subagents ?? [];
  const subagentIdByNormalizedId = mintParserSubagentAgentIds(session);
  // ISS-4592: retire the duplicate `-sub-<toolUseId>` twin of each parser-lane
  // row, and recover the delegation's real wall clock from the tool use that
  // spawned it — the twin carried it, and a folded sidecar's own record is
  // frequently a single instant.
  const { parserAgentIdBySpawnToolUseId, spawnToolUseBySubagentId } =
    buildSubagentDedupIndex(session, parserSubagents, subagentIdByNormalizedId);
  for (const subagent of parserSubagents) {
    const agentId = subagentIdByNormalizedId.get(subagent.id);
    if (!agentId) {
      continue;
    }
    const parentAgentId =
      subagent.parentId && subagentIdByNormalizedId.has(subagent.parentId)
        ? subagentIdByNormalizedId.get(subagent.parentId)!
        : mainId;
    const metadata = buildSubagentMetadata(subagent);
    const span = subagentRowSpan(
      subagent,
      spawnToolUseBySubagentId.get(subagent.id),
      session,
      now
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, started_at, updated_at, ended_at, parent_agent_id, metadata)
       VALUES ($1, $2, $3, 'subagent', $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      agentId,
      session.sessionId,
      truncate(subagent.name || "Subagent", 200),
      subagent.type ?? null,
      subagent.status === DESKTOP_AGENT_STATUS.ERROR
        ? DESKTOP_AGENT_STATUS.ERROR
        : DESKTOP_AGENT_STATUS.COMPLETED,
      subagent.task ? subagent.task.slice(0, 500) : null,
      span.startedAt,
      now,
      span.endedAt,
      parentAgentId,
      metadata
    );
    for (const [idx, tu] of (subagent.toolUses ?? []).entries()) {
      addEvent(
        "PostToolUse",
        agentId,
        tu.timestamp,
        tu.name,
        null,
        importToolEventData(tu),
        tu.id ?? `${subagent.id}:${idx}`,
        tu.gitBranch ?? null
      );
    }
  }

  for (const ts of session.messageTimestamps ?? []) {
    addEvent("Stop", mainId, ts, null, null, null);
  }
  for (const [idx, tu] of (session.toolUses ?? []).entries()) {
    const linkedAgentId =
      tu.subagentId == null
        ? null
        : subagentIdByNormalizedId.get(tu.subagentId);
    if (linkedAgentId) {
      continue;
    }
    if (tu.name === "Agent" || tu.name === "Task") {
      // ISS-4592: when the parser lane already wrote a row for this exact
      // delegation, do not mint a duplicate. The spawn event still belongs to
      // the surviving row — addEvent's dedup key and deterministic id are
      // computed from (type, ts, tool, discriminator), never the agent id, so
      // re-pointing it moves the row's agent_id without changing event
      // identity or count. Keyed by `delegationClaimKey` — the same
      // provider-first key the invocation lane's pre-pass and tier-0 use — so
      // the two lanes retire/pair the same delegations (ISS-5099 review).
      const twinClaimKey = delegationClaimKey(tu);
      const spawnedParserAgentId = twinClaimKey
        ? parserAgentIdBySpawnToolUseId.get(twinClaimKey)
        : undefined;
      if (spawnedParserAgentId) {
        addEvent(
          "PreToolUse",
          spawnedParserAgentId,
          tu.timestamp,
          tu.name,
          "Spawned subagent",
          importToolEventData(tu),
          tu.id ?? String(idx),
          tu.gitBranch ?? null
        );
        continue;
      }
      // FEA-1459 Fix 8: Use tool_use id (toolu_*) for stable subagent identity;
      // fall back to array index for parsers that don't populate it.
      const subId = `${session.sessionId}-sub-${tu.id ?? idx}`;
      const input = (tu.input ?? {}) as Record<string, unknown>;
      const prompt = strOf(input.prompt);
      // FEA-1459 Fix 8: Use tool_result timestamp for ended_at (real duration).
      const endedAt =
        tu.resultTimestamp ?? tu.timestamp ?? session.endedAt ?? now;
      await tx.$executeRawUnsafe(
        `INSERT INTO agents (id, session_id, name, type, subagent_type, status, task, started_at, updated_at, ended_at, parent_agent_id)
         VALUES ($1, $2, $3, 'subagent', $4, 'completed', $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        subId,
        session.sessionId,
        subagentName(tu),
        strOf(input.subagent_type) ?? null,
        prompt ? prompt.slice(0, 500) : null,
        tu.timestamp ?? session.startedAt,
        now,
        endedAt,
        mainId
      );
      // FEA-1459 Fix D: Include tool_use id in dedup key so two same-tool
      // calls in the same ms don't collapse.
      addEvent(
        "PreToolUse",
        subId,
        tu.timestamp,
        tu.name,
        "Spawned subagent",
        importToolEventData(tu),
        tu.id ?? String(idx),
        tu.gitBranch ?? null
      );
    } else {
      addEvent(
        "PostToolUse",
        linkedAgentId ?? mainId,
        tu.timestamp,
        tu.name,
        null,
        importToolEventData(tu),
        tu.id ?? String(idx),
        tu.gitBranch ?? null
      );
    }
  }
  for (const td of session.turnDurations ?? []) {
    addEvent(
      "TurnDuration",
      mainId,
      td.timestamp,
      null,
      String(td.durationMs),
      null
    );
  }
  for (const err of session.apiErrors ?? []) {
    addEvent(
      "APIError",
      mainId,
      err.timestamp,
      null,
      err.message ?? err.type ?? null,
      null
    );
  }
  for (const err of session.toolResultErrors ?? []) {
    addEvent(
      "ToolError",
      mainId,
      err.timestamp,
      null,
      truncate(err.content, 200),
      null
    );
  }
  // Gap 4: Create Compaction events from session.compactions. Each compaction
  // entry from the Claude parser carries a uuid and transcript timestamp.
  // Use the compaction timestamp (not wall clock) for event ordering.
  if (session.compactions?.length) {
    const compactions = session.compactions as Array<{
      uuid: string | null;
      timestamp: string | null;
    }>;
    for (const c of compactions) {
      if (c.timestamp) {
        addEvent(
          "Compaction",
          mainId,
          c.timestamp,
          null,
          "Context compaction",
          null
        );
      }
    }
  }
  // perf: flush all buffered event rows in chunked multi-row INSERTs before any
  // downstream read of the events table (e.g. upsertSessionAnalyticsRollup).
  await flushEventBuffer();
  return { inserted };
}

/**
 * Record group 3: token usage. Delete-then-reinsert the JSONL-parser-sourced
 * token_usage rows, then backfill session.model from tokensByModel when null.
 */
async function importPhaseTokenUsage(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, now, tokenUsage, earliestTokenTs, tokenSeries } = ctx;
  // FEA-1459 (PR #1511 review): delete+reinsert. The boot importer derives full
  // totals from the entire transcript every run, so the new derivation is
  // authoritative — and overwrite-by-model alone would leave stale rows behind
  // when a model key disappears under the new parser.
  await tx.$executeRawUnsafe(
    "DELETE FROM token_usage WHERE session_id = $1 AND usage_source = $2",
    session.sessionId,
    CodexOtelTokenUsageSource.JsonlParser
  );
  for (const [model, counts] of Object.entries(session.tokensByModel ?? {})) {
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
async function importPhaseTokenEventsAndCosts(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, harness, now, earliestTokenTs, tokenEventsRecords } = ctx;
  const persistedTokenEvents = await replaceTokenEvents(
    tx,
    session.sessionId,
    tokenEventsRecords
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
async function importPhaseActivitySegments(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  const { session, now, activitySegments } = ctx;
  await persistActivitySegments(tx, session.sessionId, activitySegments, now);
}

/**
 * Record group 6: artifact links. Delete-then-reinsert the session↔artifact
 * join rows for consistency with the backfill path.
 *
 * FEA-4379: the delete PRESERVES `commit_sha_correlation` links. That method is
 * minted ONLY by the post-boot maintenance pass (`correlateCommitShaPrLinks`) —
 * the parser/import path never re-derives it — so an unconditional delete would
 * drop an active session's minted session→PR link on every live re-import and
 * strand it until the next boot's maintenance pass.
 *
 * ISS-4651: the other maintenance/import methods do NOT all come back the same
 * way, and this comment used to lump them together as re-created "by the parser
 * refs or the PR phase that runs after this one". The parser refs mint none of
 * them; the PR phase mints exactly one. What actually holds, per method:
 *   - `normalized_pr` — re-created by the PR phase (`importPhasePullRequests` →
 *     `persistNormalizedPullRequests`), which runs after this one. The original
 *     claim, and only for this method.
 *   - `branch_pr_association` — re-created by `propagateBranchPrLinks`, which
 *     runs INSIDE `persistArtifactLinks` below (earlier in this phase, same
 *     transaction), not by anything that runs after it. The re-mint is
 *     CONDITIONAL and deliberately narrower than "whatever was there before":
 *     it needs the session to still hold FEA-4377 authoring evidence for a
 *     branch, a `pull_requests` row mapping that branch to the PR, and a
 *     `pr_art.pr_state` that is not merged/closed. So the delete is not merely
 *     harmless here — a session that lost its authoring evidence SHOULD lose
 *     the association, and re-deriving through the gate is what enforces it.
 *
 *     Wherever that re-mint is NARROWER than the FEA-4377 keep rule
 *     (`removeUnauthoredBranchPrLinks`), this delete destroys a link the rule
 *     says to keep and nothing restores it — the boot sweep
 *     `propagateAllBranchPrLinks` carries the same predicate. Today the only
 *     such gap is the `pr_state` clause, inert because `artifacts.pr_state` has
 *     had no writer since PLN-1535 M5. Give that column a writer, or narrow the
 *     predicate further, and the gap goes live.
 *     `test/branch-pr-association-reimport.test.ts` covers the authored and
 *     unauthored cases for a matching head ref with a NULL `pr_state`; it does
 *     not cover merged/closed, which is unreachable while that column has no
 *     writer.
 *   - `pull_requests_fold` — has NO producer anywhere in the tree; its only
 *     minter was the FEA-1899 Postgres migration, deleted in the pglite→SQLite
 *     squash to `0001_init`. Nothing writes it, so nothing needs to rebuild it.
 */
async function importPhaseArtifactLinks(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ capturedArtifactLinks: number }> {
  const { session, now, linkedArtifactRefs, log } = ctx;
  await tx.$executeRawUnsafe(
    "DELETE FROM session_artifact_links WHERE session_id = $1 AND method != $2",
    session.sessionId,
    COMMIT_SHA_CORRELATION_METHOD
  );
  // The live import re-runs on every real import, so the seen-guard's
  // unresolved-bare-repo deferral (FEA-2875) is a backfill-only concern; here we
  // only need the captured count.
  const { captured: capturedArtifactLinks } = await persistArtifactLinks(
    tx,
    session.sessionId,
    linkedArtifactRefs,
    now,
    log
  );
  return { capturedArtifactLinks };
}

/**
 * Record group 7: pull requests. MUST run after the artifact-links phase — PR
 * artifacts create their own session_artifact_links rows, which that phase's
 * DELETE would otherwise wipe. Referenced (non-created) PRs get a null branch.
 */
async function importPhasePullRequests(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ capturedPullRequests: number }> {
  const { session, harness, now, createdPrHeadBranches, pullRequestPreserved } =
    ctx;
  const capturedPullRequests = await persistNormalizedPullRequests(
    tx,
    session,
    harness,
    now,
    createdPrHeadBranches,
    pullRequestPreserved
  );
  return { capturedPullRequests };
}

/**
 * Record group 7.5: optional work-item linkage (FEA-2272). Runs AFTER both the
 * artifact-links and pull-requests phases so every candidate link exists, and
 * before the derived rollups. A tolerant group in the isolated path: a failure
 * leaves the segments intact and only the optional column unset.
 */
async function importPhaseSegmentWorkItemRefs(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  await stampSegmentWorkItemRefs(
    tx,
    ctx.session.sessionId,
    extractWorkItemOccurrences(ctx.session)
  );
}

/**
 * Record group 7.75: replace the durable per-runtime-invocation source of
 * truth. Events and parser-owned agent rows already exist, while every derived
 * aggregate still follows this phase.
 */
async function importPhaseComponentInvocations(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  await materializeAgentComponentInvocations(
    tx,
    ctx.session,
    ctx.mainId,
    ctx.now,
    ctx.log
  );
}

/**
 * Record group 8: derived rollups. Recompute this session's analytics rollup
 * (FEA-2038) and refresh the denormalized last_activity_at cursor key. Both read
 * the events/token rows written by the phases above, so this runs last; both are
 * recompute-from-source and therefore idempotent.
 */
async function importPhaseDerivedRollups(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext,
  replaceComponentUsage = true
): Promise<void> {
  const { session, now } = ctx;
  await upsertSessionAnalyticsRollup(tx, session.sessionId, now, {
    replaceComponentUsage,
    log: ctx.log,
  });
  await recomputeSessionLastActivityAt(tx, session.sessionId);
}

/**
 * Record group 8.5: FEA-2273 activity-attribution metrics emission. Deliberately
 * ISOLATED from the analytics rollup (group 8) into its OWN transaction: it is a
 * SECONDARY rollup that additionally reads `token_events`, so keeping it out of
 * the analytics group means a metrics failure (e.g. `token_events` unavailable)
 * can never abort the primary analytics rollup, and its best-effort catch wraps a
 * dedicated metrics-only transaction rather than continuing a shared interactive
 * one. Reads the `session_analytics` row group 8 just wrote (for cohorts).
 */
async function importPhaseActivityMetrics(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  await upsertActivityMetricsRollup(tx, ctx.session.sessionId, ctx.now);
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
  pullRequestPreserved?: ReadonlyMap<string, PullRequestPreservedFields>
): Promise<ImportResult> {
  const ctx = buildImportSessionContext(
    tokenUsage,
    deps,
    session,
    harness,
    now,
    attributionCache,
    pullRequestPreserved
  );
  const { existed, reactivated, sessionDataChanged } =
    await importPhaseSessionAndMainAgent(tx, ctx);
  const { inserted } = await importPhaseEvents(tx, ctx);
  await importPhaseTokenUsage(tx, ctx);
  await importPhaseTokenEventsAndCosts(tx, ctx);
  await importPhaseActivitySegments(tx, ctx);
  const { capturedArtifactLinks } = await importPhaseArtifactLinks(tx, ctx);
  const { capturedPullRequests } = await importPhasePullRequests(tx, ctx);
  await importPhaseSegmentWorkItemRefs(tx, ctx);
  await importPhaseComponentInvocations(tx, ctx);
  await importPhaseDerivedRollups(tx, ctx);
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
  deps: ImportSessionWriteDeps,
  session: NormalizedSession,
  harness: Harness,
  now: string,
  attributionCache: SessionAttributionResolverCache
): Promise<ImportResult> {
  const ctx = buildImportSessionContext(
    tokenUsage,
    deps,
    session,
    harness,
    now,
    attributionCache
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

  const eventsResult = await runGroup("events", importPhaseEvents);
  await runGroup("token_usage", importPhaseTokenUsage);
  await runGroup("token_events", importPhaseTokenEventsAndCosts);
  await runGroup("activity_segments", importPhaseActivitySegments);

  // FEA-3227: snapshot link fingerprint before and after the artifact-links
  // and PR phases to detect whether the link set actually changed.
  const snapshotLinks = (label: string) =>
    runGroup(label, (tx) =>
      snapshotSessionArtifactLinks(tx, session.sessionId)
    );
  const linksBefore = await snapshotLinks("link_snapshot_before");

  // SYNC INVARIANT (FEA-2729 / PLN-1296): artifact-link rows (branch/PR/slug
  // refs) are written here, in the same importSession pass that
  // importPhaseSessionAndMainAgent bumps `sessions.updated_at`. The cloud sync
  // driver selects sessions by that `updated_at` watermark (the FEA-1962
  // durable cursor), so a link change propagates to the cloud *because* its
  // session's updated_at advanced in this pass. Do NOT write
  // session_artifact_links outside importSession (e.g. a targeted SQL backfill)
  // without also bumping the parent session's updated_at, or add a per-kind
  // artifact-link cursor — otherwise the new/re-derived refs will never sync.
  await runGroup("artifact_links", importPhaseArtifactLinks);
  await runGroup("pull_requests", importPhasePullRequests);
  // FEA-2272: stamp optional work_item_ref after BOTH links and PRs exist.
  // Tolerant: a failure leaves the tiling intact with the column unset. Writes
  // only session_activity_segments (never session_artifact_links), so it does not
  // affect the link fingerprint compared below.
  await runGroup("segment_work_item_refs", importPhaseSegmentWorkItemRefs);

  // Invocation branch attribution consumes only created write-evidence links,
  // so materialize after the artifact phases have committed in this same pass.
  // This keeps first import byte-identical to a re-import while preserving the
  // isolated events dependency.
  const invocationResult =
    eventsResult === null
      ? null
      : await runGroup(
          "component_invocations",
          importPhaseComponentInvocations
        );

  const linksAfter = await snapshotLinks("link_snapshot_after");
  const linksChanged =
    JSON.stringify(linksBefore ?? []) !== JSON.stringify(linksAfter ?? []);

  // FEA-2729 + FEA-3227: if links changed but the session phase didn't bump
  // updated_at, ensure the sync watermark still advances so the cloud cursor
  // picks up the new/changed refs.
  if (linksChanged && !gate.sessionDataChanged) {
    await runGroup("sync_watermark", async (tx) => {
      await tx.$executeRawUnsafe(
        "UPDATE sessions SET updated_at = $1 WHERE id = $2",
        now,
        session.sessionId
      );
    });
  }

  await runGroup("analytics_rollup", (tx, importContext) =>
    importPhaseDerivedRollups(tx, importContext, invocationResult !== null)
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
    try {
      await timedGroupWrite("activity_metrics", importPhaseActivityMetrics);
    } catch (error) {
      deps.log(
        `${ImportFailureLogPrefix.ActivityMetrics} ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /* ISS-4572: SEAL the real DATA_REVISION now that every group has committed.
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
        DATA_REVISION,
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
  // so their re-derived counts (inserted, capturedPullRequests) are false-positive
  // change signals when the input hasn't changed. The three real change detectors:
  // sessionDataChanged (metadata/revision diff), linksChanged (fingerprint diff),
  // and reactivated (status flip).
  return {
    skipped:
      gate.existed &&
      !gate.sessionDataChanged &&
      !linksChanged &&
      !gate.reactivated,
    reactivated: gate.reactivated,
    // A tolerated group failure leaves the import partial: re-import next pass
    // (idempotent) instead of marking the source seen. Both derive from one list.
    incomplete: failedGroups.length > 0 || undefined,
    ...(failedGroups.length > 0 ? { failedGroups } : {}),
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
  return tx.$queryRawUnsafe<{ artifact_id: string; relation: string }[]>(
    "SELECT artifact_id, relation FROM session_artifact_links WHERE session_id = $1 ORDER BY artifact_id, relation",
    sessionId
  );
}

// ISS-5182: `sweepStaleSessions` lived here as a near-copy of the boot reaper
// and stamped `ended_at` with the sweep wall clock, which FEA-3580 had already
// corrected in the reaper. Both entry points now share one body —
// `sweepStaleActiveSessions` in session-maintenance.ts — called with
// `excludeSessionId` from the live `SessionStart` path.
