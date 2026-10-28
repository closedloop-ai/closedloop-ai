/**
 * @file agent-component-dead-letter-persistence.ts
 * @description ISS-8593 — the DURABLE shape of one component-sync dead-letter
 * entry, and the parser that reads it back off the cursor row.
 *
 * PROBLEM: `sync_state.dead_lettered_ids` records only bare ids, so everything a
 * dead-letter entry knows about ITSELF — how many re-attempts it has already
 * burned, and whether anything other than this tracker can ever re-drive it —
 * died with the process. A restart re-seeded every id at attempt 0, due
 * immediately, so a row that had backed off to the 24h ceiling was hammered
 * again on the next launch, and a restart loop pinned it at the base window
 * forever.
 *
 * SHAPE: `sync_state.dead_letter_attempts` (migration 0080) carries
 * `[{ id, attempts, tombstoned }]`. It is ADDITIVE and OPTIONAL by construction:
 * `dead_lettered_ids` remains the MEMBERSHIP record, so a build that predates
 * this column reads exactly the id list it always read, and a cursor written by
 * such a build loads here as `[]` — the entries then seed at attempt 0, which is
 * the pre-ISS-8593 behavior rather than a failure. A record whose id is not in
 * `dead_lettered_ids` is ignored; the two are joined on id, never merged.
 *
 * The array is READ ONLY as far as the tracker's own size cap: entries past it
 * could never have been retained anyway, so parsing them is work a corrupt or
 * version-skewed row could otherwise spend without bound on the main process.
 *
 * A malformed record is DROPPED rather than adopted: the id it names still
 * arrives through `dead_lettered_ids`, so degrading one record costs a reset
 * backoff and never a lost row. `attempts` is validated across its whole
 * impossible set — fractional, negative, non-finite, past-safe-integer, and
 * string-shaped — because each of those would otherwise be handed to the
 * backoff ladder as a measured attempt count.
 */

import { z } from "zod";
import {
  COMPONENT_MAX_DEAD_LETTERED_IDS,
  type ComponentSyncDeadLetterTracker,
} from "./agent-component-sync-dead-letter.js";

/**
 * One dead-lettered component id plus the bookkeeping that must survive a
 * process restart.
 */
export type ComponentDeadLetterRecord = {
  id: string;
  /**
   * Failed re-attempts charged against this id so far. Feeds the doubling
   * retry-after ladder, so restoring it is what preserves the backoff POSITION
   * across a restart rather than resetting it to due-immediately.
   */
  attempts: number;
  /**
   * The local row is TOMBSTONED (`agent_components.uninstalled_at` is set), so
   * this tracker is the ONLY thing that can ever re-drive it.
   *
   * A live component re-enters the keyset lane whenever its `last_seen_at`
   * advances past the cursor. A tombstone gets exactly one such advance, at the
   * moment it is written (`packs/component-tombstone.ts` reserves an ordering
   * key above the table maximum), and never another: every tombstone writer is
   * guarded by `uninstalled_at IS NULL`, and the boot repair
   * (`packs/component-tombstone-repair.ts`) deliberately excludes a
   * correctly-keyed tombstone. So evicting one from the tracker is permanent
   * loss, which is why the cap eviction reads this flag.
   */
  tombstoned: boolean;
  /**
   * Absolute epoch-ms deadline this id may next be re-attempted at, when one was
   * in force at persist time.
   *
   * Without it a resumed backoff restarts its clock at HYDRATION, so time the
   * app spent closed never counts toward the window — and a process whose
   * lifetime is shorter than the resumed window re-drives the entry NEVER, which
   * for a tombstoned row is the permanent stranding this whole field set exists
   * to prevent. Persisting the deadline makes closed time count.
   *
   * Optional because a QUARANTINED entry has no finite deadline to record, and
   * because a record written by a build that predates this field carries none.
   * Both cases fall back to a fresh window computed from `attempts`. The reader
   * clamps at BOTH ends regardless (see `seedDeadLetters`), so a corrupt or
   * far-future value — a backwards clock change, a hand-edited row — can delay
   * an entry by at most one full window and can never strand it.
   */
  retryAfterEpochMs?: number;
};

/**
 * Zod shape for one persisted record, and the SINGLE owner of what a valid one
 * looks like: the durable read below and the db-host reply boundary
 * (`persisted-sync-state-reply-boundary.ts`) both validate against THIS schema
 * rather than re-deriving the predicate.
 *
 * `z.int()` is the whole-impossible-set guard for `attempts`: it rejects a
 * fraction, a negative, `Infinity`/`NaN`, a magnitude past the safe-integer
 * range, and a numeric string alike.
 */
export const componentDeadLetterRecordSchema = z.object({
  id: z.string().min(1),
  attempts: z.int().nonnegative(),
  tombstoned: z.boolean(),
  // Same whole-impossible-set guard as `attempts`, for the same reason: a
  // fractional, negative, non-finite, or past-safe-integer deadline would be
  // handed to a clock comparison as if it were a measured instant. `optional()`
  // rather than `nullable()` — an absent deadline is OMITTED, never serialized
  // as null.
  retryAfterEpochMs: z.int().nonnegative().optional(),
});

/**
 * What one read of `sync_state.dead_letter_attempts` established.
 *
 * `droppedCount` is the number of entries that were PRESENT in the persisted
 * array and did not become records — malformed, or past the cap. It is reported
 * rather than inferred because the only other way to notice is to compare this
 * array against `dead_lettered_ids` at a call site, and those two legitimately
 * disagree: an id recorded before migration 0080, or dead-lettered after the
 * last snapshot was written, has no record and never did. A call site cannot
 * tell that id apart from one whose record was destroyed; this counter can,
 * because it counts what the codec itself refused.
 */
export type ComponentDeadLetterReadResult = {
  records: ComponentDeadLetterRecord[];
  droppedCount: number;
};

/**
 * Read `sync_state.dead_letter_attempts` back into records.
 *
 * Anything that is not an array degrades to no records (an absent column, a
 * legacy cursor, a corrupt value) — the ids still load from `dead_lettered_ids`,
 * so the lane loses backoff position, never a row. Records are validated ONE AT
 * A TIME so a single malformed entry cannot discard the bookkeeping of every
 * healthy sibling, and only the first {@link COMPONENT_MAX_DEAD_LETTERED_IDS}
 * are read at all.
 *
 * ISS-8593 (marisolashgrove review): a dropped record is not a neutral loss. The
 * id it named still arrives through `dead_lettered_ids`, but with no record the
 * seed cannot tell whether that row was TOMBSTONED — and a tombstone evicted
 * from the tracker is gone for good, because its ordering key never rises again.
 * So the count travels with the records, and {@link seedDeadLetters} fails
 * CLOSED on it. A non-array degrades to `droppedCount: 0` rather than a guess:
 * nothing establishes how many records such a value was meant to hold, and the
 * ids behind it are in exactly the pre-ISS-8593 position.
 */
export function parseComponentDeadLetterRecords(
  value: unknown
): ComponentDeadLetterReadResult {
  if (!Array.isArray(value)) {
    return { records: [], droppedCount: 0 };
  }
  const records: ComponentDeadLetterRecord[] = [];
  // ISS-8593 (davetho review): bound the INPUT, not the output. The tracker
  // holds at most COMPONENT_MAX_DEAD_LETTERED_IDS entries, so that is also the
  // most a healthy writer can have produced — this is that constant, not a
  // second copy of it. Slicing rather than breaking out of the loop is what
  // makes the work bounded: a break on `records.length` still parses every
  // element of a million-entry array when none of them is valid, which is the
  // shape a corrupt or version-skewed row actually takes.
  for (const entry of value.slice(0, COMPONENT_MAX_DEAD_LETTERED_IDS)) {
    const parsed = componentDeadLetterRecordSchema.safeParse(entry);
    if (parsed.success) {
      records.push(parsed.data);
    }
  }
  // Entries past the cap count as dropped for the same reason a malformed one
  // does: their record was not established, so an id naming one cannot be
  // proven re-drivable. Truncation is not a safer kind of loss.
  return { records, droppedCount: value.length - records.length };
}

/**
 * Whether a peer's reported drop count means records were lost.
 *
 * Absent is NOT a fault: the field is optional and additive, so a cursor read by
 * a build that predates it, or one with nothing to report, answers nothing and
 * seeds exactly as it did before ISS-8593.
 *
 * An UNREADABLE count is a fault, and it fails closed with the drops. This value
 * crosses the db-host `utilityProcess` boundary with its type asserted and not
 * checked, so a fractional, negative, non-finite or past-safe-integer count is
 * reachable from a skewed or defective peer — and every one of those would
 * otherwise be read as a measured zero, which is the one answer that says "no
 * record was lost". Not being able to read the count is not evidence that
 * nothing was dropped.
 */
export function componentDeadLetterRecordsWereDropped(
  reported: number | undefined
): boolean {
  if (reported === undefined) {
    return false;
  }
  if (!Number.isSafeInteger(reported) || reported < 0) {
    return true;
  }
  return reported > 0;
}

/** The dead-letter half of a persisted cursor row, as the db host answers it. */
export type PersistedComponentDeadLetterSnapshot = {
  /** The MEMBERSHIP record. Nothing here without it. */
  deadLetteredIds?: readonly string[];
  /** `unknown` on purpose: its type crossed the boundary asserted, not checked. */
  deadLetterAttempts?: unknown;
  deadLetterAttemptsDropped?: number;
};

/**
 * ISS-4542 / ISS-8593: re-seed a tracker from the dead-letter snapshot a cursor
 * row carried, so a poison item the cursor already advanced past is re-driven
 * after a cold restart instead of being permanently stranded.
 *
 * Lives here, with the codec, rather than in the lane that calls it: joining the
 * membership ids to their records and deciding what an unmatched id means is the
 * read half of this file's durable shape, and the lane had no headroom for it
 * (ISS-9418).
 *
 * BOTH codec passes can lose a record, and either loss makes an unmatched id
 * unprovable — the store ran the codec on the way out of SQLite, so its count has
 * to travel with the records and this pass can only lose what a peer put on the
 * wire after it. {@link ComponentSyncDeadLetterTracker.seedDeadLetters} fails
 * CLOSED on that, tombstoning every unmatched id, because a tombstone evicted
 * from the tracker is gone for good; `onRecordsDropped` is how the caller names
 * it. A snapshot with no ids is a no-op — nothing to seed and nothing to say.
 */
export function seedTrackerFromPersistedDeadLetters(input: {
  tracker: Pick<ComponentSyncDeadLetterTracker, "seedDeadLetters">;
  snapshot: PersistedComponentDeadLetterSnapshot;
  nowMs: number;
  onRecordsDropped: (message: string) => void;
}): void {
  const ids = input.snapshot.deadLetteredIds;
  if (!ids?.length) {
    return;
  }
  const { records, droppedCount } = parseComponentDeadLetterRecords(
    input.snapshot.deadLetterAttempts
  );
  const recordsWereDropped =
    componentDeadLetterRecordsWereDropped(
      input.snapshot.deadLetterAttemptsDropped
    ) || droppedCount > 0;
  if (recordsWereDropped) {
    input.onRecordsDropped(
      `durable dead-letter bookkeeping was unreadable for ${ids.length} tracked id(s) (store refused ${input.snapshot.deadLetterAttemptsDropped ?? 0}, this read refused ${droppedCount}); seeding every unmatched id as tombstoned so the cap cannot evict a row nothing else can re-drive`
    );
  }
  input.tracker.seedDeadLetters(ids, input.nowMs, records, recordsWereDropped);
}
