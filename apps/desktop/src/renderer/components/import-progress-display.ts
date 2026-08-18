import type { CloudSyncLaneRemainder } from "../../shared/cloud-read-readiness-contract";
import type { QuarantinedStageCounts } from "../../shared/ingest-quarantine-contract";
import { SyncLaneId } from "../../shared/sync-burndown-contract";
import type { IngestProgress } from "../hooks/use-ingest-progress";

export type ImportProgressDisplay = {
  processed: number;
  total: number;
  pct: number;
};

/**
 * Normalize imported/total session counts for renderer-only progress displays.
 *
 * The runtime should emit integer counts, but the UI still clamps defensively so
 * transient malformed payloads never show negative sessions, processed > total,
 * or a `NaN` progress value.
 */
export function describeImportProgress(
  processed: number,
  total: number
): ImportProgressDisplay {
  const displayTotal = normalizeCount(total);
  const displayProcessed =
    displayTotal > 0 ? Math.min(normalizeCount(processed), displayTotal) : 0;
  const pct = displayTotal > 0 ? (displayProcessed / displayTotal) * 100 : 0;

  return {
    processed: displayProcessed,
    total: displayTotal,
    pct,
  };
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

/**
 * ISS-4444: how many local SOURCE TRANSCRIPTS the boot import had to quarantine
 * (their parse wedged repeatedly). Clamped to a non-negative integer so a
 * malformed/negative value from a version-skewed main process can never render a
 * nonsense count; `null`/absent → 0.
 *
 * ISS-5281 moved it here, beside the other renderer progress-count normalizers,
 * so the React-free import-splash derivation can share the one clamp instead of
 * re-declaring it. This population is NOT the session count: one poison source
 * (an OpenCode DB) can hold many sessions, and because it never parsed we cannot
 * know how many — which is exactly why the two are counted separately.
 */
export function resolveCouldNotImportCount(
  ingest: IngestProgress | null
): number {
  const raw = ingest?.quarantinedCount;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.floor(raw);
}

/**
 * ISS-6115 (wongk review): the quarantined population SPLIT BY the stage that
 * quarantined it, normalized the same way as the total above.
 *
 * An older main process sends no split. That degrades to the pre-ISS-6115
 * reading — the whole population attributed to `parse` — because before the
 * import bound charged the store, every quarantine WAS a parse wedge. So the copy
 * an old main process produces is the copy it always produced, which is the
 * cross-process rule: an absent field means the prior behaviour, never a guess.
 */
export function resolveQuarantinedStageCounts(
  ingest: IngestProgress | null
): QuarantinedStageCounts {
  const total = resolveCouldNotImportCount(ingest);
  const split = ingest?.quarantinedByStage;
  if (!split) {
    return { parse: total, import: 0 };
  }
  return {
    parse: clampCount(split.parse),
    import: clampCount(split.import),
  };
}

function clampCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * ISS-6115 (wongk review): the ONE phrase describing why quarantined sources are
 * missing, so the four renderer surfaces that report it cannot drift apart.
 *
 * The stages fail at different points and the copy has to say which:
 *   - `parse` — the file itself could not be READ (a CPU-spinning parser);
 *   - `import` — it was read fine and the WRITE did not finish inside its bound,
 *     so "couldn't be read" is simply false;
 *   - both — neither verb covers the mix, so it names the outcome they share.
 *
 * Returns `null` when nothing is quarantined, so a caller renders no caveat at
 * all rather than a zero.
 */
export function describeQuarantinedSources(
  counts: QuarantinedStageCounts,
  noun: string
): string | null {
  const total = counts.parse + counts.import;
  if (total <= 0) {
    return null;
  }
  if (counts.import <= 0) {
    return `${formatCount(total, noun)} couldn't be read`;
  }
  if (counts.parse <= 0) {
    return `${formatCount(total, noun)} couldn't be saved`;
  }
  return `${formatCount(total, noun)} couldn't be imported`;
}

/**
 * ISS-6115 (wongk review): what the app may still claim about ALREADY-IMPORTED
 * sessions once sources have been quarantined.
 *
 * "Existing sessions are unchanged" is only true when nothing got as far as
 * writing. An import stall happens AFTER the parse, and the isolated importer
 * commits its record groups one at a time — so a later group timing out leaves
 * the earlier ones already written. Claiming nothing changed would be the UI
 * lying about its own data, so with any import-stage quarantine it says the
 * weaker thing that is actually true.
 */
export function describeQuarantinedSessionImpact(
  counts: QuarantinedStageCounts
): string {
  return counts.import > 0
    ? "Some sessions may be partly imported."
    : "Existing sessions are unchanged.";
}

/**
 * `"1 session"` / `"2 sessions"` — the shared count-with-noun formatter for
 * renderer progress copy, so a count and its noun are never assembled twice with
 * different pluralization rules.
 */
export function formatCount(count: number, singular: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : `${singular}s`}`;
}

/**
 * ISS-5768: the ONE sentence the app uses to report work that will never reach
 * the cloud, shared by the read-source badge (`cloud-read-cutover-copy.ts`) and
 * the Settings → History Sync cell (`use-ingest-progress.ts`).
 *
 * It was typed out twice and had already begun to diverge — one copy carried a
 * terminal period, the other did not. Two indicators on one screen describing
 * one machine is exactly the shape this ticket exists to stop, so the sentence
 * lives here and both callers import it.
 *
 * It deliberately promises NO recovery. Some lanes have no dead-letter
 * re-admission path at all (ISS-5855), so the copy states what happened and what
 * it costs and stops there; a next step that dead-ends is worse than none.
 */
export function describeUndeliverableItems(count: number): string {
  return `${formatCount(count, "item")} could not be uploaded and will not appear in your workspace.`;
}

/**
 * ISS-5768: the whole-app remainder, worded once for every indicator that
 * reports it — the Settings → History Sync cell and the startup readiness panel.
 *
 * `isLowerBound` is not decoration. A lane whose remainder is a floor, or an
 * initial import still discovering history, means the real number can only be
 * larger; printing it bare would state a total the app cannot stand behind.
 */
export function describeItemsRemaining(
  count: number,
  isLowerBound: boolean
): string {
  const items = formatCount(count, "item");
  return isLowerBound ? `at least ${items}` : items;
}

/**
 * ISS-6206: what each sync lane's items ARE, in the user's words.
 *
 * The lanes count genuinely different things — outbox rows, transcript files,
 * rows past a cursor, comments — which is exactly why their totals were never
 * summable. Naming the unit is what makes a per-lane count readable: "12
 * transcripts" tells someone what is pending in a way "12 items" cannot.
 */
const SYNC_LANE_NOUN: Record<SyncLaneId, string> = {
  [SyncLaneId.SessionMetadata]: "session",
  [SyncLaneId.InvocationParts]: "session detail",
  [SyncLaneId.TranscriptArchive]: "transcript",
  [SyncLaneId.ComponentInventory]: "activity record",
  [SyncLaneId.TraceComments]: "comment",
};

/** How many lanes a single line names before it collapses the rest into a count. */
const MAX_NAMED_LANES = 2;

/**
 * ISS-6206: the outstanding backlog as PER-LANE counts, replacing the
 * cross-lane scalar the burn-down's own lane contract forbids summing.
 *
 * Returns `null` for an empty breakdown so callers keep their existing copy
 * rather than rendering an empty clause — that is the flag-off path, where
 * `laneRemainders` is deliberately empty.
 *
 * Long tails collapse ("2,900 sessions, 12 transcripts and 2 other kinds")
 * because a five-clause sentence in a status cell is unreadable. The breakdown
 * arrives in the burn-down's canonical lane order (see `cloudSyncLaneRemainders`),
 * so the sequence is the same on every sample rather than reshuffling as
 * unrelated counts cross. What the collapse hides is reachable in full from
 * {@link describeAllLaneRemainders}, which names every lane. The ordering is
 * that producer's decision, not one this layer applies.
 *
 * THE TAIL COUNTS KINDS, AND MUST SAY SO (wongk review on #5050). It sat beside
 * clauses that are all ITEM counts, so a bare "and 1 more" read as one more
 * item — while the lane it stood for could owe thousands. Naming its unit is the
 * whole fix: it must never parse as a continuation of the counts next to it.
 */
export function describeLaneRemainders(
  remainders: readonly CloudSyncLaneRemainder[]
): string | null {
  if (remainders.length === 0) {
    return null;
  }
  const named = remainders.slice(0, MAX_NAMED_LANES).map(formatLaneRemainder);
  const rest = remainders.length - named.length;
  if (rest > 0) {
    named.push(formatCount(rest, "other kind"));
  }
  return joinLaneClauses(named);
}

/** One lane's remainder, hedged when the lane's own count is a floor. */
function formatLaneRemainder(remainder: CloudSyncLaneRemainder): string {
  const items = formatCount(
    remainder.itemsRemaining,
    SYNC_LANE_NOUN[remainder.lane]
  );
  return remainder.itemsRemainingIsLowerBound ? `at least ${items}` : items;
}

/** "a", "a and b", "a, b and c" — one comma rule for both breakdowns. */
function joinLaneClauses(clauses: readonly string[]): string {
  if (clauses.length === 1) {
    return clauses[0] ?? "";
  }
  return `${clauses.slice(0, -1).join(", ")} and ${clauses.at(-1)}`;
}

/**
 * ISS-6206 (wongk review on #5050): every lane's remainder, named — the DETAIL
 * behind the collapsed label {@link describeLaneRemainders} produces.
 *
 * The collapse exists because a five-clause sentence is unreadable in a status
 * cell, but applying it to the detail too meant the tail lanes were never
 * reachable anywhere: a third lane owing a million transcripts read as "and 1
 * more" in the label AND in the detail, so the count a reader would act on was
 * not on the screen at all. The label stays short; the detail carries the whole
 * breakdown, in the canonical lane order it arrives in — the same sequence the
 * label names its first lanes from, so the two never disagree about which lane
 * leads.
 */
export function describeAllLaneRemainders(
  remainders: readonly CloudSyncLaneRemainder[]
): string | null {
  if (remainders.length === 0) {
    return null;
  }
  return joinLaneClauses(remainders.map(formatLaneRemainder));
}
