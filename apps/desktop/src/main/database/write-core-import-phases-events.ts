/**
 * @file write-core-import-phases-events.ts
 * @description Record group 2: the event stream and the subagent agent rows interleaved with
 * it. The perf-tuned phase, kept in its own module (ISS-7578) because its
 * buffered chunked-insert path is the largest single phase body.
 */
import { DESKTOP_AGENT_STATUS } from "./db-constants.js";
import { strOf, truncate } from "./db-helpers.js";
import {
  buildEventDedupKey,
  deterministicEventId,
} from "./deterministic-event-id.js";
import type { Prisma } from "./generated/client.js";
import {
  buildSubagentMetadata,
  importToolEventData,
  mintParserSubagentAgentIds,
  subagentName,
  subagentRowSpan,
} from "./import-metadata-builders.js";
import type { ImportSessionContext } from "./import-session-context.js";
import { buildValuesTuples, chunkRowsByParamCap } from "./sql-values-tuples.js";
import { buildSubagentAncestryIndex } from "./subagent-ancestry.js";
import {
  buildSubagentDedupIndex,
  delegationClaimKey,
} from "./subagent-dedup.js";
import { computeSyncedEventRowFingerprint } from "./synced-child-row-fingerprint.js";

/**
 * Record group 2: events (and the subagent agent rows interleaved with them).
 * A single atomic delete-then-reinsert: the FEA-1459 purge of import-derived
 * rows, the post-purge high-water-mark read, and the buffered chunked re-insert
 * all commit together so the events table is never observed mid-rewrite. This
 * is the perf-tuned phase — events are buffered and flushed in chunked multi-row
 * INSERTs rather than one round-trip per row.
 */
export async function importPhaseEvents(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext,
  contentSignal?: EventContentSignal
): Promise<{ inserted: number; eventsChanged: boolean | null }> {
  const { session, now, mainId } = ctx;
  // ISS-8699 + ISS-8757: the purge-and-re-derive below makes `inserted` a count of
  // what this pass RE-DERIVED, not of what the table gained, so it cannot answer
  // "did a durable event land". Bracketing the whole phase with the stored
  // CONTENT fingerprint can, and both reads sit inside this phase's own
  // transaction so no concurrent writer can slip between them.
  const storedBefore = await readEventContentFingerprint(
    tx,
    session.sessionId,
    contentSignal
  );
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
  // - events: the types this importer re-derives below. A row of any OTHER type
  //   keyed to a purged subagent is swept at the END of this phase instead —
  //   see {@link sweepDroppedSubagentEvents}.
  //   ISS-5107: the two DELETEs used to carry unrelated predicates, so a
  //   reimport whose re-derivation no longer yields some subagent id dropped
  //   the `agents` row and left that agent's hook-only rows (Notification,
  //   SessionStart/End, UserPromptSubmit, ...) behind, still naming it.
  //   `events.agent_id` is indexed but has no FK, so nothing refuses the strand
  //   and `PRAGMA foreign_key_check` cannot see it.
  //   Reading the purged id set HERE, before the agents DELETE, is what lets
  //   the end-of-phase sweep subtract the ids this pass re-minted. A subagent
  //   whose derived id is STABLE across the reparse is deleted and re-created
  //   by this same phase, and its hook-only rows must survive that: only an id
  //   the new parse does NOT bring back is a dangle. Sweeping at purge time
  //   cannot tell those two cases apart, because nothing has been re-minted
  //   yet, and took both (whitlockk, #7397).
  //   The high-water-mark query below runs AFTER the purge, so the re-derived
  //   events insert with an empty HWM for these types.
  const purgedSubagentIds = (
    await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM agents WHERE ${purgedSubagentPredicate("$1")}`,
      session.sessionId
    )
  ).map((row) => row.id);
  await tx.$executeRawUnsafe(
    `DELETE FROM events WHERE session_id = $1 AND event_type IN
       ('Stop', 'PreToolUse', 'PostToolUse', 'TurnDuration', 'APIError', 'ToolError', 'Compaction')`,
    session.sessionId
  );
  await tx.$executeRawUnsafe(
    `DELETE FROM agents WHERE ${purgedSubagentPredicate("$1")}`,
    session.sessionId
  );
  // The ids this pass actually minted, collected as the re-derivation runs
  // rather than re-derived from `session` a second time. The twin-retirement
  // rules below decide which tool use mints a row; a parallel predicate that
  // had to agree with them is the exact shape ISS-5107 was about.
  const mintedSubagentIds = new Set<string>();

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
  const dedupIndex = buildSubagentDedupIndex(
    session,
    parserSubagents,
    subagentIdByNormalizedId
  );
  const { parserAgentIdBySpawnToolUseId, spawnToolUseBySubagentId } =
    dedupIndex;
  // ISS-10714: the real spawn tree, rebuilt from the delegation evidence the
  // parsers already record. `parent_agent_id` is NOT NULL-able in practice —
  // several rollups read a NULL parent as a session root — so a subagent whose
  // parent could not be reconstructed still writes `mainId` for the FK's sake,
  // and `buildSubagentMetadata` records that it was a fallback so the row never
  // asserts a main-agent parent, or a depth, it does not have.
  const ancestry = buildSubagentAncestryIndex(
    session,
    subagentIdByNormalizedId,
    dedupIndex
  );
  for (const subagent of parserSubagents) {
    const agentId = subagentIdByNormalizedId.get(subagent.id);
    if (!agentId) {
      continue;
    }
    mintedSubagentIds.add(agentId);
    const resolved = ancestry.bySubagentId.get(subagent.id);
    const resolvedParentAgentId =
      resolved?.parentSubagentId == null
        ? null
        : (subagentIdByNormalizedId.get(resolved.parentSubagentId) ?? null);
    const parentAgentId = resolvedParentAgentId ?? mainId;
    const metadata = buildSubagentMetadata(subagent, resolved);
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
      mintedSubagentIds.add(subId);
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
  // ISS-5107: now that every id this pass mints is known, sweep the rows left
  // naming a subagent the purge dropped and the reparse did NOT bring back.
  // Runs before the closing fingerprint read so `eventsChanged` reflects it.
  await sweepDroppedSubagentEvents(
    tx,
    session.sessionId,
    purgedSubagentIds.filter((id) => !mintedSubagentIds.has(id))
  );
  const storedAfter = await readEventContentFingerprint(
    tx,
    session.sessionId,
    contentSignal
  );
  return {
    inserted,
    eventsChanged:
      storedBefore === null || storedAfter === null
        ? null
        : storedAfter !== storedBefore,
  };
}

/**
 * Whether the caller wants the content bracket, and which fold to use.
 *
 * Supplied by the INCREMENTAL ingest path (`importSessionIsolated`), which has no
 * other detector over event rows. Omitted by the atomic rebuild
 * (`importSessionWithTx`), which already brackets EVERY synced child projection —
 * events included — in `rebuild-session-tx`, so computing it a second time here
 * would double the fold over the corpus the DATA_REVISION re-walk visits and buy
 * that path nothing; it destructures only `inserted`.
 */
export type EventContentSignal = {
  /**
   * The ISS-4591 probe's answer for this database, resolved ONCE per open and
   * OUTSIDE any transaction. `false` selects the portable checksum, which still
   * folds every character of this same projection.
   */
  hasRowDigest: boolean;
};

/**
 * The content fingerprint of this session's SYNCED event columns. Read before the
 * purge and after the re-insert so {@link importPhaseEvents} can report whether
 * the pass actually changed the table (ISS-8699, widened by ISS-8757) — the
 * signal `sessions.updated_at`, and therefore the incremental sync cursor, is
 * advanced on. `null` when the caller supplied no signal: NOT MEASURED, which is
 * a different claim from "unchanged" and is why `eventsChanged` is nullable.
 *
 * SCOPE — a CONTENT signal, deliberately, not the population one it replaces.
 * ISS-8699 shipped a row COUNT here, which answers only "were rows appended or
 * removed" and is blind to an equal-cardinality rewrite. The reachable case
 * @whitlockk found on #6383 is a `PostToolUse` row whose `tool_result` lands on a
 * LATER parse: `importToolEventData` writes `isError` / `resultTimestamp` /
 * `detail.tool_response` into `events.data` while `deterministicEventId` — keyed
 * on the tool_USE instant, not the result's — holds the row's id and the count
 * steady. Tool uses are absent from the metadata blob, so no other detector on
 * this path saw that change either.
 *
 * WHAT THAT BUYS, STATED EXACTLY. Not the tool result: `events.data` is NOT on
 * the sync wire — FEA-2718 stripped `summary`/`data` from the drain, the
 * sanitizer and the cloud schema alike, and turn/tool detail reaches the cloud
 * through the FEA-2717 transcript archive, on its own byte-offset cursor that
 * this watermark does not drive. That egress removal is a settled security
 * decision, so for the tool-result case above this bracket bumps the watermark
 * and re-selects the session for a byte-identical event payload; ISS-8876 holds
 * whether that re-selection is worth its cost.
 *
 * What it does buy is ONE reachable defect, and the plural framing of an earlier
 * draft overstated it. Of the five columns FEA-2718 leaves on the wire (`id`,
 * `agent_id`, `event_type`, `tool_name`, `created_at`) only `agent_id` has a
 * single-cause equal-cardinality path on THIS lane: the ISS-4592 delegation
 * re-point below, where a `PreToolUse` row written against the minted
 * `<session>-sub-<toolUseId>` agent is re-pointed to `<session>-parser-sub-<id>`
 * on the pass where the parser subagent first becomes correlatable. Same
 * `(type, ts, tool, discriminator)`, so the same deterministic id and the same
 * row count — and the `-sub-` agents row the cloud still points at is deleted by
 * this phase's own purge. Under the row count that correction NEVER reached the
 * cloud. `event_type` and `tool_name` are parse-invariant, `created_at` can only
 * appear together with a new row (a timestamp-less event has no row at all), and
 * `id` moves only positionally, for a harness that mints no tool_use id.
 *
 * The fold is `computeSyncedEventRowFingerprint` — the SAME `events` projection
 * the DATA_REVISION rebuild gate hashes, reused rather than re-declared, so a
 * column added to the sync payload reaches both gates or neither.
 *
 * It is strictly stronger than the count in BOTH probe branches, so nothing
 * ISS-8699 detected is lost: the row digest moves on any row added or removed,
 * and the portable checksum folds every encoded row explicitly.
 *
 * PERF — the decision ISS-8699 deferred here, now measured. The count was a
 * covering-index read; this is O(events in session). Median of 7, one session,
 * realistic tool `data` payloads: at 1k events the pair of reads costs 8.7ms
 * against the count's 0.4ms, at 5k 42.9ms against 0.8ms, at 10k 87.3ms against
 * 1.1ms. That is the same ORDER as `recomputeSessionLastActivityAt`, the
 * O(events) fold this very path already runs on every ingest write — 54.8ms at
 * 10k events (ISS-5497) — so the phase does not gain a new cost CLASS, and it is
 * paid only on the incremental path (see {@link EventContentSignal}) and only
 * when the events group actually runs. What that cost buys is the `agent_id`
 * correction described above — NOT the tool-result detail, which the FEA-2717
 * transcript archive already carries.
 *
 * What it still does NOT cover, so the next reader does not mistake this for
 * total: `git_branch` is not in the synced projection (FEA-2990 made it a
 * local-only rollup axis), so a re-derivation that moves ONLY that column is
 * invisible here — correctly, since it changes nothing the cloud receives.
 */
function readEventContentFingerprint(
  tx: Prisma.TransactionClient,
  sessionId: string,
  contentSignal: EventContentSignal | undefined
): Promise<string | null> {
  if (!contentSignal) {
    return Promise.resolve(null);
  }
  return computeSyncedEventRowFingerprint(
    tx,
    sessionId,
    contentSignal.hasRowDigest
  );
}

/**
 * The subagent rows this phase owns and therefore purges: the `-sub-` id
 * namespace it shares with the live-hook spawner, terminal status only (a
 * hook's `working` row must survive — see the purge comment above).
 *
 * Spelled once and interpolated into the read that seeds the sweep AND the
 * `agents` DELETE (ISS-5107), because both are scoped to the SAME set. Two
 * predicates that had to agree, and were never derived from each other, is
 * exactly how an `events.agent_id` came to name a row the sibling statement had
 * already deleted.
 *
 * The statuses come from {@link DESKTOP_AGENT_STATUS} for the same reason: the
 * INSERT above writes `status` from those constants, so a raw pair of literals
 * here is a second spelling of the axis this predicate selects on, free to
 * drift from the writer. `live-hook-agent-close.ts` interpolates them into raw
 * SQL the same way (@marisolashgrove, #7397).
 *
 * `sessionParam` is the positional placeholder bound to the session id in the
 * statement this fragment is embedded in — it differs between the two, so it
 * cannot be baked in.
 */
function purgedSubagentPredicate(sessionParam: string): string {
  return `session_id = ${sessionParam} AND type = 'subagent'
       AND (id LIKE '%-sub-%' OR id LIKE '%-parser-sub-%')
       AND status IN ('${DESKTOP_AGENT_STATUS.COMPLETED}', '${DESKTOP_AGENT_STATUS.ERROR}')`;
}

/**
 * Delete this session's events keyed to a subagent the phase purged and the
 * reparse did not re-mint (ISS-5107).
 *
 * `droppedAgentIds` is the purged set MINUS every id the re-derivation actually
 * used, so a stable-id subagent — deleted and immediately re-created by this
 * same phase — is absent from it and keeps the hook-only rows this importer
 * cannot re-derive. Only an id with no `agents` row left to name is swept.
 *
 * What the sweep still costs is those same hook-only rows for a subagent the
 * reparse genuinely dropped — accepted (operator ruling, 2026-09-14) because
 * FEA-3729 turned their only producer off: every build carrying this phase also
 * carries `CLAUDE_LIVE_HOOK_ENABLED = false`. It reaches nothing else: a NULL
 * `agent_id` never matches `IN`, so the collection-mode violation diagnostic is
 * untouched, and a live-hook `status = 'working'` row is spared by
 * {@link purgedSubagentPredicate}, so it is never in this list at all.
 *
 * SCOPE — rows ALREADY orphaned before this build are out of reach by
 * construction: their `agents` row is long gone, so they were never in the
 * purged set this list is derived from. Repairing those needs a pass that finds
 * them from the `events` side, and a `DATA_REVISION` bump to re-walk sealed
 * sessions at all; both are deliberately not this change.
 *
 * Chunked on {@link chunkRowsByParamCap} so a session with many dropped
 * subagents cannot push one statement past the bound-variable cap.
 */
async function sweepDroppedSubagentEvents(
  tx: Prisma.TransactionClient,
  sessionId: string,
  droppedAgentIds: string[]
): Promise<void> {
  if (droppedAgentIds.length === 0) {
    return;
  }
  for (const chunk of chunkRowsByParamCap(
    droppedAgentIds.map((id) => [id]),
    1
  )) {
    const placeholders = chunk.map((_, index) => `$${index + 2}`).join(", ");
    await tx.$executeRawUnsafe(
      `DELETE FROM events WHERE session_id = $1 AND agent_id IN (${placeholders})`,
      sessionId,
      ...chunk.flat()
    );
  }
}
