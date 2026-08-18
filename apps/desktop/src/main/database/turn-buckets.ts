/**
 * @file turn-buckets.ts
 * @description The `session_turn_bucket` derivation and its single writer,
 * extracted from `write-core.ts` (FEA-3597).
 *
 * The extraction is not cosmetic: `write-core.ts` is a grandfathered
 * over-ceiling file under the repo's 1,000-line rule, and this change would
 * otherwise have grown it. Only the pure derivation and the writer live here.
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
 * wongk + closedloop-ai-stage review). On an install that predates the OpenCode
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
import { isHeadlessSession } from "@repo/lib/session-trace/headless";
import { toCanonicalIso, validIso } from "./db-helpers.js";
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
 */
const ISO_ZONED_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isUnambiguousInstant(value: string): boolean {
  return ISO_ZONED_RE.test(value) || ISO_DATE_ONLY_RE.test(value);
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
 * Note the headless classifier's role NARROWS here. It used to both suppress
 * the human row and PROMOTE that turn to an agent row; the promotion is gone,
 * because agent rows no longer come from `$.messages` at all. The suppression
 * half is still load-bearing.
 *
 * Multiple units sharing (ts, turnKind) collapse into one row with
 * `turnCount = the count`, so `SUM(turnCount)` equals the number of qualifying
 * units — which is the FEA-3597 primary identity, satisfied by construction.
 * Malformed/absent metadata, a non-array source, or zero qualifying units all
 * yield an empty array — never a throw.
 */
export function deriveSessionTurnBuckets(
  sessionId: string,
  metadataText: string | null
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

  // The two halves read INDEPENDENT sources and are guarded independently: a
  // session with a populated `$.tokenSeries` and absent/malformed `$.messages`
  // must still get its agent rows, so neither guard may short-circuit the other.
  collectHumanUnits(meta.messages, headless, add);
  collectAgentUnits(meta.tokenSeries, add);

  return [...counts.values()];
}

/** Add one human unit per `$.messages` entry, unless the session is headless. */
function collectHumanUnits(
  messages: unknown,
  headless: boolean,
  add: (ts: string, turnKind: TurnKind) => void
): void {
  if (headless || !Array.isArray(messages)) {
    return;
  }
  for (const el of messages) {
    if (typeof el !== "object" || el === null || Array.isArray(el)) {
      continue;
    }
    const { role, timestamp } = el as { role?: unknown; timestamp?: unknown };
    if (role !== "human") {
      continue;
    }
    if (typeof timestamp !== "string" && typeof timestamp !== "number") {
      continue;
    }
    // Human timestamps stay VERBATIM (`String(...)`, no canonicalization) —
    // FEA-3597 holds this half byte-identical to the pre-change derivation.
    add(String(timestamp), "human");
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
  const bucketRows = rows.flatMap((row) =>
    deriveSessionTurnBuckets(row.id, row.metadata)
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
