/**
 * @file turn-buckets.ts
 * @description The `session_turn_bucket` derivation and its single writer,
 * extracted from `write-core.ts` (FEA-3597).
 *
 * The extraction is not cosmetic: this change would otherwise have grown
 * `write-core.ts`. Only the pure derivation and the writer live here.
 * The two boot passes (`backfillSessionTurnBuckets`, `recomputeHeadlessTurnBuckets`)
 * were later moved out of `write-core.ts` into `session-analytics-maintenance.ts`
 * (ISS-4851); they import `rebuildSessionTurnBuckets` from here, so the graph
 * stays one-directional with no cycle.
 *
 * FEA-3597 changed what an AGENT row means. It used to come from `$.messages`
 * rows with `role='assistant'` — one row per JSONL entry, so a single billable
 * round-trip split across text/tool_use/thinking blocks was counted several
 * times, inflating the store ~3x against the canonical rollup. It now comes
 * from `$.tokenSeries`, which IS the billable round-trip series (FEA-3125).
 * HUMAN rows are untouched.
 *
 * ISS-8259 restored the `$.messages` reading as a strictly-disjoint FALLBACK for
 * the one population FEA-3597 left with nothing: a session that synced no
 * round-trip series at all. FEA-3597's inflation argument does not reach it —
 * there is no round-trip to over-count — and the cloud heatmap never stopped
 * counting those rows, so dropping them here was a cross-surface fork, not a
 * correction. ISS-9864 then removed the 100-row window ISS-8259 had put on that
 * fallback to match the cloud's capped read: the predicate now lives in
 * `@repo/lib` and feeds the synced `metadata.agentTurnTimestamps` key the cloud
 * reads instead. See `collectLegacyAgentMessageUnits`.
 *
 * ISS-8398 widened that fallback by one spelling. A ZONE-LESS instant was
 * rejected because `Date.parse` reads it HOST-LOCAL, which would have made
 * output depend on the operator's `TZ` — right about `Date.parse`, but rejection
 * was not the only cure. Naming the omitted zone as UTC removes the host
 * dependence, and UTC is what `toIso` (ISS-6738), `canonicalizeStoredTimestamp`
 * (ISS-5496), `toUtcHumanTurnTimestamp` (ISS-7896) and the cloud's own
 * `(m ->> 'timestamp')::timestamp` + `AT TIME ZONE 'UTC'` already read it as.
 * The OFFSET spelling stays rejected; see `collectLegacyAgentMessageUnits`.
 *
 * ISS-5395 corrected the ATTRIBUTION half of that change. FEA-3597 also began
 * dropping every `$.tokenSeries` entry carrying a `subagentId`, on the reasoning
 * that "a folded subagent's work is NOT an agent turn on the parent's timeline".
 * That reasoning has no other timeline to put the work on: all three folding
 * harnesses (Claude sidecar/sidechain, `foldCodexDescendants`,
 * `foldOpencodeSubagents`) REMOVE the child from the top-level session list and
 * fold it into its root parent, so a subagent has no `sessions` row of its own
 * and the local `sessions` table has no `parent_id`. The excluded round-trips
 * were therefore not re-homed — they were LOST, and a session that delegates
 * most of its work rendered as near-idle on the Insights autonomy trend and
 * activity heatmap. Measured on the live corpus, one produce-loop session had
 * 13,589 of its 14,226 round-trips (95.5%) dropped this way.
 *
 * Agent rows are now derived from EVERY `$.tokenSeries` round-trip, parent- and
 * subagent-attributed alike, which is the only reading under which the bucket
 * total is a true count of the work that session performed. The `subagentId`
 * marker is untouched and still load-bearing for the per-agent consumers that
 * genuinely need to tell parent from child (`events`, activity segments,
 * artifact-ref ownership); it simply stops acting as an EXCLUSION filter here.
 * The invariant this rests on is EXACTLY ONE bucket row per round-trip, and it
 * is not established here: this derivation is per-session and pure, and
 * `mergeFoldedUsage` appends folded series across separate dedup maps with no
 * cross-map key check. The guarantee lives in the collectors, which remove a
 * folded child from the top-level session list so it never gets a `sessions` row
 * of its own — no other bucket row can exist for that round-trip.
 *
 * THE ONE SHAPE WHERE THAT WAS NOT TRUE, and what now makes it true (ISS-5395,
 * whitlockk + closedloop-ai-stage review). On an install that predates the OpenCode
 * fold, revision 62's own correction (ISS-4649 finding 1) records that a
 * standalone `opencode-<childId>` session row SURVIVES beside its now-folded
 * root, because OpenCode is a batch collector and both delete paths are gated on
 * `sessionIdForSource` + `isBurstArtifactSource`. That row carries the same
 * round-trips in its own `metadata.tokenSeries`, unmarked. Under the rule above
 * the root emits an agent unit for each of them AND the child row still emits
 * its own, and `computeAgents` / `computeUtilization` in local-insights.ts GROUP
 * BY day across every session in the window with no dedupe — so the roll-up
 * would have DOUBLED those days rather than corrected them. Revision 69
 * therefore also builds the pruning revision 62 deferred
 * (`pruneFoldedChildRows`), deleting the stale top-level row keyed on the fold's
 * own emitted child set. A fresh install, or one whose OpenCode rows were all
 * imported after the fold, never had the stale row and is unaffected either way.
 * Regression coverage: session-turn-bucket-folded-child-dedup.test.ts.
 */
import { collectLegacyAgentTurnUnits } from "@repo/lib/agent-sessions/agent-turn-timestamps";
import { collectHumanTurnUnits } from "@repo/lib/agent-sessions/human-turn-timestamps";
import { isHeadlessSession } from "@repo/lib/session-trace/headless";
import { readZoneLessAsUtc, toCanonicalIso, validIso } from "./db-helpers.js";
import type { Prisma } from "./generated/client.js";

export type TurnKind = "human" | "agent";

export type SessionTurnBucketRow = {
  sessionId: string;
  ts: string;
  turnKind: TurnKind;
  turnCount: number;
};

/**
 * FEA-3597: an ISO-8601 timestamp whose instant is fixed independently of the
 * host — either an explicit zone (`Z` or `±HH:MM`) or a date-only form, which
 * the ES spec reads as UTC.
 *
 * This is an AMBIGUITY guard, not a canonical-form guard. `Date.parse` reads a
 * zone-less date-time (`2026-07-01T12:00:00`) and non-ISO forms
 * (`01/02/2026`, `July 1, 2026`) as HOST-LOCAL — and `01/02/2026`'s day/month
 * order is locale-dependent on top. Normalizing those would make the bucket's
 * day and hour differ per machine, which would put a real turn in the wrong
 * heatmap hour AND break the golden corpus's timezone determinism: the UTC and
 * America/Chicago suites would derive different output from the same frozen
 * input, which is exactly the invariance the two-suite design exists to prove.
 *
 * A blacklist cannot enumerate the ambiguous forms, so this is a whitelist of
 * unambiguous ones. Every accepted form is normalized rather than rejected, so
 * offset timestamps are counted at the right instant instead of dropped.
 *
 * The legacy `$.messages` arm reaches a wider set WITHOUT widening this
 * whitelist: {@link toLegacyAgentInstant} supplies a missing `Z` first and then
 * asks this same question of the result.
 */
const ISO_ZONED_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The offset-bearing spelling {@link ISO_ZONED_RE} accepts. Unambiguous, so the
 * `$.tokenSeries` arm counts it — but the ISS-8259 `$.messages` arm must NOT,
 * because that arm's cloud FALLBACK twin discards the offset instead of
 * converting it (the ISS-9864 derived key normalizes it to UTC before the
 * wire, but this arm keeps the ISS-8398 reservation). See
 * {@link collectLegacyAgentMessageUnits}.
 */
const OFFSET_BEARING_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?[+-]\d{2}:\d{2}$/;

function isUnambiguousInstant(value: string): boolean {
  return ISO_ZONED_RE.test(value) || ISO_DATE_ONLY_RE.test(value);
}

const CALENDAR_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * ISS-8398: does the DAY this text names exist?
 *
 * `validIso` is only `Number.isFinite(Date.parse(…))`, and `Date.parse` silently
 * ROLLS OVER an out-of-range day — `2026-02-30` becomes March 2 — so without
 * this the arm buckets a cell on a day PostgreSQL's `pg_input_is_valid` refuses
 * to make a row for at all. That is the same "one turn, two different days"
 * failure the OFFSET spelling is rejected for, reached from the other side.
 *
 * Deliberately NARROWER than `isRealCalendarInstant`
 * (`@repo/lib/agent-sessions/human-turn-timestamps`), which compares every field
 * and so also rejects `2026-06-03T24:00:00Z` — a legal ISO end-of-day Postgres
 * accepts and normalizes to the 4th — and every year below 100, because
 * `Date.UTC(1, …)` means 1901. The cloud counts both, so rejecting them would
 * trade one fork for two worse ones. `setUTCFullYear` rather than `Date.UTC` for
 * the probe, for that same two-digit-year reason.
 *
 * Only the calendar DATE is asked about, because it carries both of the two
 * fields where the surfaces actually disagree — each verified against a live
 * PostgreSQL via `pg_input_is_valid(…, 'timestamp')`:
 *  - the DAY, which `Date.parse` rolls over and Postgres refuses (`2026-02-30`);
 *  - YEAR ZERO, which JS represents and Postgres has no such year for — its
 *    proleptic calendar runs 1 BC → 1 AD (`0000-01-01` is invalid, `0001-01-01`
 *    and `0050-03-04` are both valid, so the guard must reject 0 ALONE and not
 *    the sub-100 years around it).
 * Hour 24 and years 1-99 are counted by BOTH surfaces and must stay counted.
 */
function namesARealCalendarDay(value: string): boolean {
  const match = CALENDAR_DAY_RE.exec(value);
  if (!match) {
    return false;
  }
  const [, year, month, day] = match;
  if (Number(year) === 0) {
    return false;
  }
  const probe = new Date(0);
  probe.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  return (
    probe.getUTCFullYear() === Number(year) &&
    probe.getUTCMonth() === Number(month) - 1 &&
    probe.getUTCDate() === Number(day)
  );
}

/**
 * ISS-8398: the canonical instant the legacy `$.messages` Agent arm buckets a
 * raw element at, or `null` to drop the unit.
 *
 * The offset check runs on the RAW value FIRST, reversing the pre-ISS-8398
 * order. That is a deliberate reorder, not a fold: it stops step two from
 * normalizing a spelling step one has already condemned. No value changes answer
 * — `OFFSET_BEARING_INSTANT_RE` and the zone-less grammar are both fully
 * anchored and cannot match the same string.
 *
 * The `typeof value === "string"` guard stays at the call site, where the
 * element's shape is still in view: it is the twin of the cloud's
 * `jsonb_typeof(m -> 'timestamp') = 'string'`.
 */
function toLegacyAgentInstant(value: string): string | null {
  if (OFFSET_BEARING_INSTANT_RE.test(value)) {
    return null;
  }
  const readable = readZoneLessAsUtc(value);
  if (!(isUnambiguousInstant(readable) && validIso(readable))) {
    return null;
  }
  if (!namesARealCalendarDay(readable)) {
    return null;
  }
  return toCanonicalIso(readable);
}

/**
 * FEA-3132 / FEA-3597: PURE per-turn bucket derivation for ONE session, parsed
 * in JS — the json_each-free replacement for the old
 * `INSERT ... SELECT ... json_each`. json_each was both the corpus-scale perf
 * sink AND a native SIGTRAP of the @libsql layer (db-host exit code 5) on large
 * sessions; parsing the already-persisted metadata string in JS is a normal
 * scalar operation with no such failure mode.
 *
 * HUMAN rows — UNCHANGED, and byte-identical to the pre-FEA-3597 output:
 *  - a `$.messages` element that is a JSON object (not array/primitive) whose
 *    `role` is 'human' and whose `timestamp` is a string or number;
 *  - `headless` is the shared `isHeadlessSession` classifier (FEA-3616), the
 *    SAME helper `headlessMetadataSql` is built from, so these buckets and the
 *    `is_human` rollup can never drift;
 *  - a headless session's injected `user` prompts yield NO human row.
 *
 * AGENT rows — FEA-3597, attribution corrected by ISS-5395:
 *  - a `$.tokenSeries` entry that is a JSON object whose `timestamp` is an
 *    unambiguous instant. `subagentId` is NOT consulted: a folded subagent's
 *    round-trip is work this session performed, and the child has no session
 *    row of its own to carry it (see the file header);
 *  - the stored `ts` is NORMALIZED via `toCanonicalIso`. Human `ts` stays
 *    VERBATIM because its output is frozen by the byte-identity requirement;
 *    the asymmetry is deliberate. The two kinds occupy disjoint aggregation key
 *    space, so they can never collide.
 *
 * AGENT rows, legacy `$.messages` fallback — ISS-8259, and STRICTLY DISJOINT
 * from the `$.tokenSeries` arm above: it runs only for a session that synced no
 * round-trip series at all, so a round-trip can never be counted twice. It is
 * the port of the cloud's `agentLegacyMessageRowsSql`
 * (`apps/api/app/insights/lib/activity-heatmap.ts`), which counts
 * `role='assistant'` rows plus, when the session is headless, its injected
 * `role='human'` prompts. Without it a Codex-OTel or pre-FEA-2730 session
 * contributed zero Agent cells HERE while the cloud counted them, so the same
 * corpus rendered a busy day as idle on the desktop and lit on the web
 * (measured: 2026-06-03 agent 0 vs 1, 2026-06-25 agent 326 vs 329 UTC).
 *
 * So the headless classifier's role NARROWED for the `$.tokenSeries` arm but is
 * restored here. On this path Agent cells still come from `$.messages`, which
 * makes the headless→Agent PROMOTION the only thing that homes a headless
 * session's injected prompts: `collectHumanUnits` excludes those same rows. Drop
 * the disjunct and they are counted in NEITHER half. The suppression half is
 * still load-bearing for the human row.
 *
 * Every `$.messages` row of a no-round-trip session therefore lands in EXACTLY
 * one bucket: `human` + not headless ⇒ Human, `human` + headless ⇒ Agent,
 * `assistant` ⇒ Agent.
 *
 * Multiple units sharing (ts, turnKind) collapse into one row with
 * `turnCount = the count`, so `SUM(turnCount)` equals the number of qualifying
 * units — which is the FEA-3597 primary identity, satisfied by construction.
 * Malformed/absent metadata, a non-array source, or zero qualifying units all
 * yield an empty array — never a throw.
 */
export function deriveSessionTurnBuckets(
  sessionId: string,
  metadataText: string | null,
  hasTokenEvents: boolean
): SessionTurnBucketRow[] {
  if (!metadataText) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataText);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const meta = parsed as {
    entrypoint?: unknown;
    permissionMode?: unknown;
    messages?: unknown;
    tokenSeries?: unknown;
  };
  const headless = isHeadlessSession({
    entrypoint: typeof meta.entrypoint === "string" ? meta.entrypoint : null,
    permissionMode:
      typeof meta.permissionMode === "string" ? meta.permissionMode : null,
  });
  // Aggregate (ts, turnKind) -> count.
  const counts = new Map<string, SessionTurnBucketRow>();
  const add = (ts: string, turnKind: TurnKind): void => {
    const key = `${ts}\0${turnKind}`;
    const existing = counts.get(key);
    if (existing) {
      existing.turnCount += 1;
    } else {
      counts.set(key, { sessionId, ts, turnKind, turnCount: 1 });
    }
  };

  // The HUMAN half reads `$.messages` and is guarded independently of the agent
  // half: a session with a populated `$.tokenSeries` and absent/malformed
  // `$.messages` must still get its agent rows, and one with messages but no
  // series must still get its human ones.
  collectHumanUnits(meta.messages, headless, add);
  // The AGENT half picks exactly ONE basis, on the SAME condition the cloud
  // splits on. `hasTokenEvents` is the direct twin of the cloud's
  // `NOT EXISTS (… agent_session_token_events …)`: round-trips when the session
  // synced token events, the legacy `$.messages` rows when it did not.
  //
  // Gating the round-trip arm too — rather than running it unconditionally and
  // making only the fallback conditional — is what makes this an if/else and not
  // a pair of guards (ISS-8259 review, davetho). A session with a populated
  // series but no token-event rows is counted by the cloud from `$.messages`;
  // reading its series here would have the two surfaces disagree on exactly the
  // population this ticket exists to reconcile. Being an if/else also makes
  // double-counting structurally impossible rather than conditionally so.
  if (hasTokenEvents) {
    collectAgentUnits(meta.tokenSeries, add);
  } else {
    collectLegacyAgentMessageUnits(meta.messages, headless, add);
  }

  return [...counts.values()];
}

/**
 * Add one human unit per `$.messages` entry, unless the session is headless.
 *
 * ISS-7896 moved the predicate itself to `collectHumanTurnUnits` in
 * `@repo/lib/agent-sessions/human-turn-timestamps` so the desktop sync producer
 * can derive `metadata.humanTurnTimestamps` from the SAME unit list this chart
 * buckets — the cloud activity heatmap reads that key, so a second predicate
 * would let the two surfaces disagree about which turns are human. Output here
 * is unchanged: timestamps stay VERBATIM (`String(...)`, no canonicalization),
 * which FEA-3597 holds byte-identical to the pre-change derivation.
 */
function collectHumanUnits(
  messages: unknown,
  headless: boolean,
  add: (ts: string, turnKind: TurnKind) => void
): void {
  for (const ts of collectHumanTurnUnits(messages, headless)) {
    add(ts, "human");
  }
}

/**
 * Add one agent unit per `$.tokenSeries` round-trip carrying an unambiguous
 * instant (FEA-3597), whether the round-trip is the parent's own or a folded
 * subagent's (ISS-5395 — a folded child has no session row of its own, so
 * excluding it lost the turn rather than re-homing it).
 */
function collectAgentUnits(
  tokenSeries: unknown,
  add: (ts: string, turnKind: TurnKind) => void
): void {
  if (!Array.isArray(tokenSeries)) {
    return;
  }
  for (const el of tokenSeries) {
    if (typeof el !== "object" || el === null || Array.isArray(el)) {
      continue;
    }
    const { timestamp } = el as {
      timestamp?: unknown;
    };
    if (typeof timestamp !== "string") {
      continue;
    }
    if (!(isUnambiguousInstant(timestamp) && validIso(timestamp))) {
      continue;
    }
    add(toCanonicalIso(timestamp), "agent");
  }
}

/**
 * ISS-8259: add one agent unit per `$.messages` row of a session that synced no
 * round-trip series — `role='assistant'`, plus a headless session's injected
 * `role='human'` prompts (the FEA-2641 promotion, which `collectHumanUnits`
 * suppresses on the human side).
 *
 * ISS-9864 moved the predicate itself to `collectLegacyAgentTurnUnits` in
 * `@repo/lib/agent-sessions/agent-turn-timestamps`, so the desktop sync
 * producer can derive `metadata.agentTurnTimestamps` from the SAME unit list
 * this chart buckets — the cloud activity heatmap reads that key on exactly the
 * population this arm serves, so a second predicate would let the two surfaces
 * disagree about which rows are agent turns. That is the route ISS-7896 took
 * for the human half; ISS-7896 ruling A had reserved the cloud's raw
 * `$.messages` reading on the agent arm, and the ISS-9864 ruling (Tamsin,
 * 2026-09-14) amended it for exactly this change. The cloud's SQL spelling of
 * the predicate (`agentLegacyMessageRowsSql`) survives only as the FALLBACK for
 * a session whose producer did not carry the key.
 *
 * THE WHOLE LOCAL ARRAY IS READ. ISS-8259 sliced it to `MAX_METADATA_MESSAGES`
 * (100) to match the cloud, which read synced metadata that
 * `compactMetadataForPreview` had already truncated — two surfaces agreeing on
 * an undercount. The derived key carries every unit up to
 * `MAX_METADATA_AGENT_TURN_TIMESTAMPS` (1000), so the cloud now counts the full
 * array on the same population, and the slice is gone. Already-imported
 * sessions bucketed under the old window are re-derived by
 * `recomputeLegacyMessageAgentTurnBuckets` on the next boot.
 *
 * What still diverges, stated so it is not mistaken for parity:
 *  - A token-event-less session with MORE than 1000 agent units gets no key;
 *    the cloud stays on its capped `$.messages` read (100) while this arm
 *    reports the full local count — the ISS-8259 divergence with its sign
 *    flipped, for that population only. Capping here to match would make the
 *    desktop lie about its own store; the human half carries the identical
 *    residual. Raising the bound is a separate ruling.
 *  - An OFFSET-bearing instant (`…T23:30:00+02:00`) is still REJECTED here by
 *    {@link toLegacyAgentInstant} (ISS-8398 reservation), while the derived key
 *    normalizes it to UTC and the cloud key arm buckets the true instant. The
 *    cloud fallback arm's `::timestamp` cast discards the offset instead. So the
 *    cloud counts one cell and this arm counts none — the same direction and
 *    population as before, with the cloud's instant now correct on the key arm.
 *  - A SPACE-separated form (`… 23:30:00`) is in the key's grammar (Postgres
 *    accepts it) but outside the ECMA-262 Date Time String Format, so this arm
 *    still drops it where the cloud key arm counts it.
 *
 * Timestamp reading is {@link toLegacyAgentInstant}, which is this arm's own and
 * NOT the `$.tokenSeries` arm's. ISS-8398 is why they differ.
 *
 * A ZONE-LESS form (`…T23:30:00`) IS counted, at the UTC instant it names.
 * ISS-8259 rejected it because `Date.parse` reads a zone-less date-time as
 * HOST-LOCAL, which would have made the bucket's day and hour differ per machine
 * and broken the golden corpus's UTC/Chicago determinism. That reasoning was
 * right about `Date.parse` and wrong that rejection was the only cure: naming
 * the omitted zone as UTC removes the host dependence outright, and UTC is what
 * the cloud twin already reads the same text as.
 *
 * `ts` is NORMALIZED via `toCanonicalIso` because these are AGENT rows and must
 * share the aggregation key space of the `$.tokenSeries` arm.
 */
function collectLegacyAgentMessageUnits(
  messages: unknown,
  headless: boolean,
  add: (ts: string, turnKind: TurnKind) => void
): void {
  for (const timestamp of collectLegacyAgentTurnUnits(messages, headless)) {
    const instant = toLegacyAgentInstant(timestamp);
    if (instant === null) {
      continue;
    }
    add(instant, "agent");
  }
}

/**
 * FEA-3132: (re)materialize `session_turn_bucket` for a batch of sessions so the
 * Insights autonomy trend + activity heatmap read a small indexed GROUP BY.
 * Idempotent DELETE-then-INSERT in the SAME transaction as
 * `upsertSessionAnalyticsRollupBatch`, so buckets never drift from metadata.
 *
 * This write is the SINGLE SOURCE OF TRUTH for the turn-classification
 * predicate: the Insights autonomy trend (`computeAgents`) + activity heatmap
 * (`computeUtilization`) in `local-insights.ts` read `turn_kind` straight from
 * `session_turn_bucket` via a GROUP BY. The predicate itself lives in the pure
 * `deriveSessionTurnBuckets` above.
 *
 * json_each-FREE: metadata is read as a normal scalar TEXT column and parsed
 * per session in JS, which removes the virtual-table expansion that was both
 * the corpus-scale perf sink and the @libsql native SIGTRAP trigger.
 */
export async function rebuildSessionTurnBuckets(
  tx: Prisma.TransactionClient,
  sessionIds: string[]
): Promise<void> {
  if (sessionIds.length === 0) {
    return;
  }
  const placeholders = sessionIds.map((_, i) => `$${i + 1}`).join(", ");
  await tx.$executeRawUnsafe(
    `DELETE FROM session_turn_bucket WHERE session_id IN (${placeholders})`,
    ...sessionIds
  );
  const rows = await tx.$queryRawUnsafe<
    { id: string; metadata: string | null }[]
  >(
    `SELECT id, metadata FROM sessions WHERE id IN (${placeholders})`,
    ...sessionIds
  );
  // ISS-8259: the desktop twin of the cloud's
  // `NOT EXISTS (… agent_session_token_events …)`, read from the table that
  // actually syncs rather than inferred from `$.tokenSeries`. It has to be a
  // query: when the series is empty and `$.tokensByModel` is not, the importer
  // synthesizes one token event per model, and `tokensByModel` is not persisted
  // into `metadata` — so the pure derivation cannot answer this for itself.
  const withTokenEvents = await tx.$queryRawUnsafe<{ session_id: string }[]>(
    `SELECT DISTINCT session_id FROM token_events WHERE session_id IN (${placeholders})`,
    ...sessionIds
  );
  const tokenEventSessions = new Set(
    withTokenEvents.map((row) => row.session_id)
  );
  const bucketRows = rows.flatMap((row) =>
    deriveSessionTurnBuckets(
      row.id,
      row.metadata,
      tokenEventSessions.has(row.id)
    )
  );
  if (bucketRows.length === 0) {
    return;
  }
  // Chunk INSERTs to stay well under SQLite's bound-parameter limit (4 params
  // per row). A single session can produce thousands of buckets, so this is
  // bounded by rows, not by the caller's session batch.
  const INSERT_ROW_CHUNK = 200;
  for (let i = 0; i < bucketRows.length; i += INSERT_ROW_CHUNK) {
    const slice = bucketRows.slice(i, i + INSERT_ROW_CHUNK);
    const valuesSql = slice
      .map((_, j) => {
        const p = j * 4;
        return `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4})`;
      })
      .join(", ");
    const params = slice.flatMap((r) => [
      r.sessionId,
      r.ts,
      r.turnKind,
      r.turnCount,
    ]);
    await tx.$executeRawUnsafe(
      `INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count) VALUES ${valuesSql}`,
      ...params
    );
  }
}
