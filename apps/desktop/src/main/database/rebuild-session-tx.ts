/**
 * @file rebuild-session-tx.ts
 * @description The per-session DATA_REVISION rebuild TRANSACTION body, extracted
 * from `sqlite.ts`'s `rebuildSessionFromParse` (ISS-4710). The rebuild re-derives
 * one session from its transcript inside a single writer `$transaction`: it
 * read-before-deletes the non-transcript-owned ledgers it must preserve
 * (`token_usage.baseline_*`, the pull-request enrichment lifecycle), tears down the
 * parser-owned rows, re-imports via {@link importSessionWithTx}, restores the
 * preserved ledgers, and reports whether the re-derived payload actually changed
 * so only genuinely-changed sessions re-sync.
 *
 * Lifted into its own module so `sqlite.ts` stays under the size ceiling and the
 * heavy rebuild logic has one owner. `sqlite.ts` still owns HOW the transaction is
 * scheduled (`prisma.write(cb, undefined, { class: bulk })` — the ISS-4710 writer
 * fairness class); this module owns only WHAT the transaction does, threading the
 * few closed-over dependencies in as {@link RebuildSessionTxDeps} rather than
 * capturing them from a closure.
 */

import type { Harness, NormalizedSession } from "../collectors/types.js";
import { CodexOtelTokenUsageSource } from "../otel/codex-otel-contract.js";
import { TERMINAL_STATUS_SET } from "./db-constants.js";
import type { Prisma } from "./generated/client.js";
import type { createSqliteTokenUsageStore } from "./read-stores.js";
import type { SessionIdentityProvider } from "./session-owner-identity.js";
import { computeSyncedChildRowFingerprint } from "./synced-child-row-fingerprint.js";
import { importSessionWithTx } from "./write-core.js";

/** The result contract `rebuildSessionFromParse` returns. */
export type RebuildSessionResult = {
  rebuilt: boolean;
  activeRace: boolean;
  contentChanged?: boolean;
};

/**
 * The dependencies the rebuild transaction closes over in `sqlite.ts`, passed in
 * explicitly so the body can live outside `openSqliteAgentDatabase`'s closure.
 */
export type RebuildSessionTxDeps = {
  session: NormalizedSession;
  harness: Harness;
  /** Row-digest capability, probed BEFORE the tx opens (see caller). */
  hasRowDigest: boolean;
  tokenUsage: ReturnType<typeof createSqliteTokenUsageStore>;
  detectBillingMode: (harness: string, model?: string | null) => string;
  /**
   * ISS-6168 (PR #4947 review, thadeusb): the signed-in owner provider, threaded
   * so the rebuild's re-INSERT path is self-contained. The rebuild does not
   * delete the `sessions` row today — `importPhaseSessionAndMainAgent` takes its
   * UPDATE arm, which deliberately leaves the identity columns alone — but that
   * is a runtime fact the types do not enforce. Passing it means a future
   * teardown that DOES drop the row re-inserts it with an owner instead of
   * silently blanking one.
   */
  getUserIdentity?: SessionIdentityProvider;
  log: (message: string) => void;
  /** The store's clock (`options.now` or wall clock). */
  now: () => string;
};

/**
 * Run the DATA_REVISION rebuild for one session inside `tx`. The caller wraps this
 * in `prisma.write(..., { class: bulk })`; this function is transport-agnostic and
 * only mutates through `tx`.
 */
export async function runRebuildSessionTransaction(
  tx: Prisma.TransactionClient,
  deps: RebuildSessionTxDeps
): Promise<RebuildSessionResult> {
  const { session, harness, hasRowDigest, tokenUsage, detectBillingMode, log } =
    deps;
  // In-tx re-check: a session that is non-terminal (active, running, etc.) must
  // not be rebuilt — it heals via ordinary reimport.
  const current = await tx.session.findUnique({
    where: { id: session.sessionId },
    select: { status: true },
  });
  if (current && !TERMINAL_STATUS_SET.has(current.status)) {
    return { rebuilt: false, activeRace: true };
  }
  // ISS-4606: read-before-delete for `token_usage.baseline_*`. Those columns are
  // the DURABLE ledger of tokens that rolled out of a COMPACTED transcript —
  // `replace` moves the old totals there when a re-derivation comes back lower,
  // and every read site folds them back into effective totals. The transcript no
  // longer contains that history, so nothing can re-derive them; deleting the row
  // dropped them to 0 and permanently undercounted local and synced usage for
  // every compacted session, on every DATA_REVISION bump. Re-applied after the
  // import below, keyed by model.
  const tokenBaselineRows = await tx.$queryRawUnsafe<
    {
      model: string;
      baseline_input: bigint | number;
      baseline_output: bigint | number;
      baseline_cache_read: bigint | number;
      baseline_cache_write: bigint | number;
    }[]
  >(
    `SELECT model, baseline_input, baseline_output, baseline_cache_read, baseline_cache_write
       FROM token_usage
      WHERE session_id = $1 AND usage_source = $2
        AND (baseline_input > 0 OR baseline_output > 0
             OR baseline_cache_read > 0 OR baseline_cache_write > 0)`,
    session.sessionId,
    CodexOtelTokenUsageSource.JsonlParser
  );
  // ISS-4606: read-before-delete. The teardown below still drops PR rows the
  // re-parse no longer references (deliberate stale-row removal), but a row that
  // comes back must keep its first-observation provenance AND the GitHub-enrichment
  // lifecycle the importer cannot re-derive. Widened from created_at/observed_at to
  // carry state/merged_at/closed_at/opened_at through the re-insert.
  const pullRequestPreservedRows = await tx.$queryRawUnsafe<
    {
      id: string;
      created_at: string | null;
      observed_at: string | null;
      state: string | null;
      merged_at: string | null;
      closed_at: string | null;
      opened_at: string | null;
    }[]
  >(
    `SELECT id, created_at, observed_at, state, merged_at, closed_at, opened_at
       FROM pull_requests WHERE session_id = $1`,
    session.sessionId
  );
  const pullRequestPreserved = new Map(
    pullRequestPreservedRows.map((row) => [
      row.id,
      {
        createdAt: row.created_at,
        observedAt: row.observed_at,
        state: row.state,
        mergedAt: row.merged_at,
        closedAt: row.closed_at,
        openedAt: row.opened_at,
      },
    ])
  );
  // FEA-3659: fingerprint the synced child-row projections BEFORE the teardown so
  // a change in any of them (subagent classification, tool ownership/events,
  // component usage, links, PRs) forces a re-sync even when the `sessions.metadata`
  // blob is byte-identical. Without this, a metadata-stable but projection-changing
  // DATA_REVISION bump would leave `updated_at` unbumped and the id out of the
  // rebuild's changed-set, stranding the corrected rows under the preserved cursor.
  const childFingerprintBefore = await computeSyncedChildRowFingerprint(
    tx,
    session.sessionId,
    hasRowDigest
  );
  // ISS-5497 (review): `sessions.last_activity_at` is in NEITHER of the two
  // fingerprints above — it is not part of the `buildImportMetadata` blob and it
  // is a `sessions` column, not a child row — and until this ticket it could not
  // change on its own during a rebuild, so its absence cost nothing. Now it can:
  // the revision-75 re-derivation corrects the cursor from the same events,
  // leaving every other byte identical. Without this read the rebuild would score
  // that as unchanged, skip the `updated_at` bump, keep the id out of the changed
  // set, and strand the corrected sort key locally under the preserved cursor.
  const lastActivityAtBefore = await readSessionLastActivityAt(
    tx,
    session.sessionId
  );
  // ISS-4606: a re-parse must not clear data whose source is NOT the transcript.
  // This teardown used to delete `events`, `session_artifact_links`, and the
  // `claude_code_*` OTel tables WHOLESALE, which destroyed rows only a
  // non-transcript producer can ever write: hook-stream events (Notification /
  // SessionStart / SessionEnd / UserPromptSubmit), the `commit_sha_correlation` PR
  // link minted by the post-boot maintenance pass (FEA-4379), and the OTel-pushed
  // Claude Code cost/permission/api-request rows. None of it is re-derivable from a
  // transcript re-read, so the rebuild is where it went permanently missing.
  //
  // For `events` and `session_artifact_links` those deletes were also REDUNDANT:
  // `importSessionWithTx` below already tears down exactly what the parser
  // re-derives, and ITS predicates are the ones that encode provenance —
  // `importPhaseEvents` deletes only the event types this importer re-emits, and
  // `importPhaseArtifactLinks` excludes `commit_sha_correlation`. Deleting first ran
  // AHEAD of that scoping and defeated it. Letting the import phases own their own
  // teardown keeps ONE source of truth for "what the parser owns" instead of two
  // that can drift.
  //
  // Still torn down here, deliberately:
  //
  // `agents` — NOT yet narrowed. The delete the import itself runs covers only TERMINAL
  // parser-namespace subagents, and the main-agent spine upsert runs on the
  // new-session branch only, so a session being rebuilt never re-derives its
  // `<id>-main` row. Dropping this delete therefore stops parser-owned main-agent
  // columns (`metadata`, `task`, `parent_agent_id`) from healing on a re-parse — a
  // real regression, caught by the FEA-3659 child-projection test. Doing this
  // properly needs a provenance discriminator so hook-spawned rows can be told
  // apart from parser-derived ones; `agents` has no such column, and the `-sub-` id
  // infix is explicitly SHARED between the importer and the live-hook spawner, so it
  // cannot stand in for one. Tracked as the open `agents` item on ISS-4606.
  //
  // `pull_requests` — dropping rows the re-parse no longer references is deliberate
  // (pinned by `pr-store-write.test.ts`), so the delete stays and the enrichment
  // lifecycle rides across it on the read-before-delete seed above instead.
  //
  // `token_usage` — scoped to the JSONL-parser source, so the OTel-sourced rows
  // survive (mirrors `codex_trace_span`). Its `baseline_*` ledger rides across on
  // the seed read below.
  await tx.$executeRawUnsafe(
    "DELETE FROM agents WHERE session_id = $1",
    session.sessionId
  );
  await tx.$executeRawUnsafe(
    "DELETE FROM pull_requests WHERE session_id = $1",
    session.sessionId
  );
  await tx.$executeRawUnsafe(
    "DELETE FROM token_usage WHERE session_id = $1 AND usage_source = $2",
    session.sessionId,
    CodexOtelTokenUsageSource.JsonlParser
  );
  await tx.$executeRawUnsafe(
    "DELETE FROM artifact_link_backfill_seen WHERE session_id = $1",
    session.sessionId
  );
  // FEA-2267: clear the activity-segment backfill marker too, for symmetry with
  // artifact_link_backfill_seen. The segments themselves are refreshed by
  // importSessionWithTx -> persistActivitySegments below; dropping the marker avoids
  // the backfill re-tiling this rebuilt session a redundant second time after a
  // combined DATA_REVISION + ACTIVITY_CLASSIFIER_VERSION bump.
  await tx.activitySegmentBackfillSeen.deleteMany({
    where: { sessionId: session.sessionId },
  });
  const importResult = await importSessionWithTx(
    tx,
    tokenUsage,
    { detectBillingMode, getUserIdentity: deps.getUserIdentity, log },
    session,
    harness,
    deps.now(),
    {
      attributionByCwd: new Map(),
      launchMetadataRootByCwd: new Map(),
      repoFullNameByPath: new Map(),
    },
    pullRequestPreserved
  );
  // ISS-4606: restore the compaction ledger onto whichever re-derived rows came
  // back for the same model. A model that no longer appears is intentionally NOT
  // resurrected — its row is gone on purpose, and re-inserting it would invent usage
  // the transcript does not claim.
  for (const baseline of tokenBaselineRows) {
    await tx.$executeRawUnsafe(
      `UPDATE token_usage
          SET baseline_input = $1, baseline_output = $2,
              baseline_cache_read = $3, baseline_cache_write = $4
        WHERE session_id = $5 AND model = $6 AND usage_source = $7`,
      baseline.baseline_input,
      baseline.baseline_output,
      baseline.baseline_cache_read,
      baseline.baseline_cache_write,
      session.sessionId,
      baseline.model,
      CodexOtelTokenUsageSource.JsonlParser
    );
  }
  // Rebuilt pull_requests rows may have a missing branch_name. Preserve the
  // artifact's observed head branch as raw evidence; product eligibility is
  // evaluated separately from authoritative repository metadata.
  await tx.$executeRawUnsafe(
    `UPDATE pull_requests SET branch_name = (
       SELECT a.branch_name FROM artifacts a
       WHERE a.kind = 'pull_request'
         AND a.repo_full_name = pull_requests.repo_full_name
         AND a.pr_number = pull_requests.pr_number
         AND a.branch_name IS NOT NULL
       LIMIT 1
     )
     WHERE session_id = $1
       AND branch_name IS NULL
       AND EXISTS (
         SELECT 1 FROM artifacts a
         WHERE a.kind = 'pull_request'
           AND a.repo_full_name = pull_requests.repo_full_name
           AND a.pr_number = pull_requests.pr_number
           AND a.branch_name IS NOT NULL
       )`,
    session.sessionId
  );
  // FEA-3659: surface whether the re-derived payload actually changed (updated_at
  // bumped) so the rebuild enqueues ONLY genuinely-changed rows for cloud sync, not
  // every byte-identical re-derivation. The content signal is the UNION of two
  // independent fingerprints: the `sessions.metadata` blob
  // (importResult.sessionDataChanged) AND the synced child-row projections
  // (agents/events/token_events/links/PRs/component-usage/activity-segments), which
  // the metadata blob does not cover. A change in EITHER must reach the cloud; only
  // when BOTH are byte-identical is this a true sync no-op that stamps data_revision
  // alone.
  const childFingerprintAfter = await computeSyncedChildRowFingerprint(
    tx,
    session.sessionId,
    hasRowDigest
  );
  const childRowsChanged = childFingerprintAfter !== childFingerprintBefore;
  const lastActivityAtChanged =
    (await readSessionLastActivityAt(tx, session.sessionId)) !==
    lastActivityAtBefore;
  const contentChanged =
    importResult.sessionDataChanged === true ||
    childRowsChanged ||
    lastActivityAtChanged;
  // When something OTHER than the metadata blob changed,
  // importPhaseSessionAndMainAgent took the revision-only stamp path and left
  // `updated_at` unbumped — so bump it here to advance the sync watermark for the
  // incremental scan (the explicit enqueue is the belt; this is the suspenders, and
  // keeps the watermark truthful).
  if (contentChanged && importResult.sessionDataChanged !== true) {
    await tx.$executeRawUnsafe(
      "UPDATE sessions SET updated_at = $1 WHERE id = $2",
      deps.now(),
      session.sessionId
    );
  }
  return {
    rebuilt: true,
    activeRace: false,
    contentChanged,
  };
}

/**
 * ISS-5497 (review): the session's stored `last_activity_at`, read on the same
 * `tx` before and after the re-import so the rebuild's change signal covers the
 * cursor column. Returns `null` for a row that is absent on the "before" read —
 * a genuinely new row's value then differs from `null` and scores as changed,
 * which is what the caller wants.
 */
async function readSessionLastActivityAt(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<string | null> {
  const rows = await tx.$queryRawUnsafe<{ last_activity_at: string | null }[]>(
    "SELECT last_activity_at FROM sessions WHERE id = $1",
    sessionId
  );
  return rows[0]?.last_activity_at ?? null;
}
