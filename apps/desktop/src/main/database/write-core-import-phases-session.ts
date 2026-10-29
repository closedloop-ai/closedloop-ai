/**
 * @file write-core-import-phases-session.ts
 * @description Record group 1: the gating session-identity write — the session row and its
 * main agent spine. Extracted from write-core.ts (ISS-7578); it is the first of
 * the five write-core-import-phases-* modules the orchestrators call in order.
 */
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { dataRevisionFor } from "../collectors/engine/data-revision.js";
import { DESKTOP_AGENT_STATUS, TERMINAL_STATUS_SET } from "./db-constants.js";
import { safe } from "./db-helpers.js";
import type { Prisma } from "./generated/client.js";
import type { ImportSessionContext } from "./import-session-context.js";
import {
  importedMainAgentStatus,
  resolveImportedEndsWithError,
  resolveImportedSessionStatus,
} from "./imported-session-status.js";
import { buildSessionIdentityInsert } from "./session-owner-identity.js";
import { readSessionSyncWatermarkTarget } from "./session-sync-watermark.js";
import {
  getImportSession,
  upsertImportedMainAgentSpine,
} from "./write-core-main-agent-spine.js";
import {
  importedSessionCreatedAt,
  mergeSessionCreatedAt,
  writeImportedSessionCreatedAt,
} from "./write-core-session-created-at.js";
import { reconcileTerminalSession } from "./write-core-terminal-end.js";

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
export async function importPhaseSessionAndMainAgent(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext,
  // ISS-4572: the `data_revision` value stamped on the session row by this gate.
  // Defaults to the import's revision (the atomic rebuild path, which commits
  // the whole import in ONE transaction, so an interruption rolls the gate back
  // too). The ISOLATED import path passes DATA_REVISION_IMPORT_PENDING here and
  // seals the real revision in a final group only after every later group has
  // committed without eviction — so an interrupted isolated import leaves the row
  // at the sentinel and re-heals on the next data-revision-rebuild rather than
  // masquerading as fully imported at the current revision.
  revisionToStamp: number = dataRevisionFor(ctx.parsePolicy)
): Promise<{
  existed: boolean;
  reactivated: boolean;
  sessionDataChanged: boolean;
  // ISS-12251: an existing row's `created_at` moved (filled or lowered). On its
  // own it leaves `updated_at` alone; the write records an outbox row instead,
  // and the rebuild reports the row in `needsResync`.
  createdAtChanged: boolean;
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
  let createdAtChanged = false;
  // Set true in every branch that writes the `data_revision` column below.
  let revisionStamped = !existing;
  const billingMode =
    safe(() => detectBillingMode(harness, session.model ?? null)) ?? "unknown";
  const incomingCreatedAt = importedSessionCreatedAt(session);

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
    const revisionChanged =
      existing.dataRevision !== dataRevisionFor(ctx.parsePolicy);
    const nextCreatedAt = mergeSessionCreatedAt(
      existing.createdAt,
      incomingCreatedAt
    );
    createdAtChanged =
      nextCreatedAt !== null && nextCreatedAt !== existing.createdAt;
    sessionDataChanged = contentChanged;
    // Either branch below writes the `data_revision` column; the no-op else leaves
    // it untouched, so no seal is needed for it.
    revisionStamped = contentChanged || revisionChanged;
    const modelSetClause = freshModelIsRealId
      ? "model = $2"
      : "model = COALESCE(model, $2)";
    if (contentChanged) {
      // ISS-8741: this branch REPLACES the derived projection (`metadata`), and
      // an ordinary import does not go through the promotion gate — nothing put
      // this candidate to the session view's own validator. So both markers are
      // invalidated here rather than left describing a projection that is no
      // longer the one on the row: a `projection_known_good_revision` left
      // standing would assert a verification this write never performed, and a
      // `projection_candidate_revision` left standing would report a replacement
      // as still in flight on a row a later import has already healed (whitlockk, PR
      // #6507). NULL is the truthful value — the same value every pre-migration
      // row carries, meaning "not known to be validated". The gated rebuild path
      // runs this same phase and then stamps known-good as the LAST statement of
      // its transaction, so it re-earns the stamp it clears here.
      //
      // The `revisionChanged` branch below deliberately does NOT clear: it is
      // fill-only and leaves `metadata` byte-identical, so the standing
      // projection is still the one the stamp was earned for.
      // ISS-8871: strictly forward, never `now` — a stored value already equal
      // to the import clock makes `updated_at = now` a no-op, and the
      // incremental scan excludes an already-observed row at the tied top
      // timestamp, so the content this branch just replaced would never sync.
      const contentWatermark = await readSessionSyncWatermarkTarget(
        tx,
        session.sessionId,
        now
      );
      await tx.$executeRawUnsafe(
        `UPDATE sessions SET
          name = COALESCE($1, name),
          ${modelSetClause},
          cwd = COALESCE(cwd, $3),
          harness = CASE WHEN COALESCE(harness, '') = '' THEN $4 ELSE harness END,
          billing_mode = CASE WHEN COALESCE(billing_mode, '') IN ('', 'unknown') THEN $5 ELSE billing_mode END,
          metadata = $6,
          data_revision = $7,
          updated_at = COALESCE($8, updated_at),
          projection_known_good_revision = NULL,
          projection_candidate_revision = NULL,
          created_at = $9
         WHERE id = $10`,
        session.name ?? null,
        session.model ?? null,
        session.cwd ?? null,
        harness,
        billingMode,
        newMetadata,
        revisionToStamp,
        contentWatermark,
        nextCreatedAt,
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
    if (!contentChanged && createdAtChanged && nextCreatedAt !== null) {
      await writeImportedSessionCreatedAt(tx, {
        sessionId: session.sessionId,
        createdAt: nextCreatedAt,
        now,
      });
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
      // ISS-8871: read AFTER the content branch above, which may already have
      // advanced this row in this same transaction — binding `now` here would
      // write that advance back down and strand the reactivation too.
      const reactivationWatermark = await readSessionSyncWatermarkTarget(
        tx,
        session.sessionId,
        now
      );
      await tx.$executeRawUnsafe(
        `UPDATE sessions SET status = '${SESSION_STATUS.ACTIVE}', ended_at = NULL, updated_at = COALESCE($1, updated_at), ends_with_error = $2 WHERE id = $3`,
        reactivationWatermark,
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
    // ISS-4586 (@whitlockk): refresh the durable ends_with_error flag on EVERY
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
    // pass deletes only the session's `<id>-main` agent row (ISS-4606), so a
    // previously-imported session may lack its main agent. ON CONFLICT DO NOTHING
    // is safe when the agent already exists (normal non-rebuild import path).
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
    const identity = buildSessionIdentityInsert(ctx.getUserIdentity, 14);
    await tx.$executeRawUnsafe(
      `INSERT INTO sessions (id, name, status, cwd, model, started_at, updated_at, ended_at, harness, billing_mode, metadata, data_revision, ends_with_error, created_at, ${identity.columns})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ${identity.placeholders})`,
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
      incomingCreatedAt.value,
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
    createdAtChanged,
    revisionStamped,
  };
}
