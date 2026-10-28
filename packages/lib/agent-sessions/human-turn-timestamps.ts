import { isHeadlessSession } from "../session-trace/headless";

/**
 * ISS-7896: the ONE human-turn unit list, shared by the desktop bucket derivation
 * and the cloud sync producer.
 *
 * The cloud activity heatmap's HUMAN half read `$.messages`, which both sync
 * lanes compact to the first {@link
 * import("./metadata-preview").MAX_METADATA_MESSAGES} (100) entries — so a
 * session's human tail was never counted. Measured over the 27 frozen golden
 * dossiers the cloud reported 42 human turns against the desktop oracle's 109
 * (2026-06-15: 2 against 9). The AGENT half stopped depending on `$.messages`
 * under ISS-5408; this is the same correction for the human half, carried as an
 * additive metadata key rather than a re-derivation, because no cloud table
 * holds a per-human-turn timestamp (`agent_session_token_events` is assistant
 * round-trips with no role column, and `AgentSessionUsageRollup.humanTurns` is a
 * scalar).
 *
 * This module is the SSOT for the predicate itself. `deriveSessionTurnBuckets`
 * (`apps/desktop/src/main/database/turn-buckets.ts`) calls
 * {@link collectHumanTurnUnits} for its human rows, and the sync producer
 * (`apps/desktop/src/main/agent-sync/agent-session-sync-metadata.ts`) calls
 * {@link deriveHumanTurnTimestamps}, so the two cannot fork. It lives in
 * `@repo/lib` rather than beside the bucket derivation because the desktop's
 * dependency-cruiser gate (`boot-no-design-system-runtime`) forbids any
 * boot-reachable module from transitively reaching `src/main/database/`, and the
 * sync payload module IS boot-reachable — verified by running the gate with that
 * edge in place, which produced four errors against a clean baseline.
 */

export const HUMAN_TURN_TIMESTAMPS_METADATA_KEY = "humanTurnTimestamps";

/**
 * Max entries the key may carry. Sized against
 * `DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES` (262,144), because `metadata`
 * is replicated into EVERY sync chunk: 1000 x (37 + 3) is ~40 KB, roughly 15% of
 * the request budget. The observed corpus maximum is 44 entries (~1.2 KB), so
 * this is ~22x headroom over anything measured.
 *
 * A session with more human turns than this emits NO key at all and the cloud
 * falls back to `$.messages` — see the whole-or-absent rule on
 * {@link deriveHumanTurnTimestamps}.
 */
export const MAX_METADATA_HUMAN_TURN_TIMESTAMPS = 1000;

/**
 * Cheap length pre-filter applied before {@link HUMAN_TURN_TIMESTAMP_PATTERN},
 * so a pathological multi-kilobyte string is rejected without running the
 * regex. It is NOT the binding constraint — the grammar bounds a real match to
 * ~37 chars — so there is no reachable behavior at exactly this boundary.
 */
export const MAX_HUMAN_TURN_TIMESTAMP_CHARS = 40;

/**
 * What this key is allowed to carry, as a FULL-STRING match.
 *
 * The shape check is the whole privacy argument. These entries reach the cloud
 * from a Metadata-tier machine, where `metadata-preview`'s `retainedString` gate
 * denies every string whose path is not declared structural. Rather than declare
 * the path — which would also admit a scalar `humanTurnTimestamps: "<prose>"`,
 * because that gate matches on path alone — an entry is admitted because it
 * VALIDATED as a timestamp. A string constrained to digits, `-`, `:`, `.`, `T`,
 * ` `, `Z` and a sign is structurally incapable of carrying a prompt, a
 * completion, or file contents, which is the ISS-7775 admission rule's clause
 * (a) satisfied by construction instead of by declaration.
 *
 * Deliberately WIDER than the desktop's own `isUnambiguousInstant`: it accepts
 * the space separator, a 2- or 4-digit offset, and up to 12 fractional digits,
 * because Postgres accepts all of those and the pre-existing `$.messages` path
 * counts them today. A form Postgres would accept but this rejects (ISO basic
 * `20260101`, `2026-01-01 12:00:00 UTC`, `July 1 2026`) makes the whole key
 * absent, which degrades to that same pre-existing path — never to a wrong
 * number.
 *
 * An offset-bearing form is ACCEPTED here but never SHIPPED in that spelling:
 * {@link deriveHumanTurnTimestamps} re-expresses it in UTC first. See
 * {@link toUtcHumanTurnTimestamp} for why the wire value must carry no offset.
 */
const HUMAN_TURN_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,12})?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/;

/**
 * The calendar fields of a grammar-valid unit, so {@link isHumanTurnTimestamp}
 * can reject a date the grammar's `\d{2}` runs admit but no calendar has.
 */
const HUMAN_TURN_TIMESTAMP_CALENDAR =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * ISS-9864 (D7): the widest offset PostgreSQL's `timestamp` input accepts is
 * ±15:59:59, so an hour past 15 or a minute past 59 names no zone.
 */
const MAX_TIMESTAMP_OFFSET_HOURS = 15;
const MAX_TIMESTAMP_OFFSET_MINUTES = 59;

export function isHumanTurnTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_HUMAN_TURN_TIMESTAMP_CHARS &&
    HUMAN_TURN_TIMESTAMP_PATTERN.test(value) &&
    isRealCalendarInstant(value)
  );
}

/**
 * Does a grammar-valid unit name a date and time that actually EXIST?
 *
 * The grammar bounds each field to two digits, not to its range, so
 * `2026-02-30T00:00:00.000Z` and `2026-06-15T25:00:00Z` pass it. Admitting one
 * is not a cosmetic slip: PostgreSQL's `pg_input_is_valid` rejects it, so the
 * cloud's derived arm drops that entry while STILL treating the array as
 * authoritative — and a session whose human turns are all spelled that way
 * reports zero rather than falling back to `$.messages`. Rejecting here makes
 * the whole key absent instead, which is the fallback (whitlockk, #6116).
 *
 * `Date.parse` cannot answer this alone: it rejects an out-of-range MONTH or
 * HOUR but silently ROLLS OVER an out-of-range DAY (`2026-02-30` becomes March
 * 2), which would also mis-bucket the turn that
 * {@link toUtcHumanTurnTimestamp} then normalizes. So the parsed instant is
 * compared field-for-field against the text it came from.
 *
 * ISS-9864 (D7): the OFFSET is bounded the same way. `+99:99` passes the
 * grammar's `\d{2}` runs, and {@link toUtcHumanTurnTimestamp} would then apply
 * it by arithmetic and ship a confident wrong instant — four days off — that
 * the cloud's key arm buckets as authoritative. Postgres refuses the spelling
 * (`pg_input_is_valid`), so rejecting it here makes the whole key absent and
 * lands the session on the `$.messages` fallback, which is the honest failure.
 */
function isRealCalendarInstant(value: string): boolean {
  const match = HUMAN_TURN_TIMESTAMP_CALENDAR.exec(value);
  if (!match) {
    return false;
  }
  if (!isRealOffset(value)) {
    return false;
  }
  const [, year, month, day, hour, minute, second] = match;
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0)
  );
  if (!Number.isFinite(utc)) {
    return false;
  }
  const parsed = new Date(utc);
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day) &&
    parsed.getUTCHours() === Number(hour ?? 0) &&
    parsed.getUTCMinutes() === Number(minute ?? 0) &&
    parsed.getUTCSeconds() === Number(second ?? 0)
  );
}

/**
 * Does the unit's offset, if it carries one, name a zone that exists? A
 * zone-less or `Z`-suffixed unit carries none and passes. Read through the same
 * offset grammar {@link toUtcHumanTurnTimestamp} applies, which requires a time
 * part, so a bare date's trailing `-16` is never mistaken for a zone.
 */
function isRealOffset(value: string): boolean {
  const match = OFFSET_BEARING_HUMAN_TURN_TIMESTAMP.exec(value);
  if (!match) {
    return true;
  }
  const [, , , , , offsetHours, offsetMinutes] = match;
  return (
    Number(offsetHours) <= MAX_TIMESTAMP_OFFSET_HOURS &&
    Number(offsetMinutes ?? 0) <= MAX_TIMESTAMP_OFFSET_MINUTES
  );
}

/**
 * The human-turn units of one session's `$.messages`, in traversal order.
 *
 * This IS the desktop activity heatmap's own unit list — `deriveSessionTurnBuckets`
 * emits one `turn_kind='human'` bucket row per entry returned here — so the key
 * this feeds and the desktop chart cannot disagree about WHICH turns count.
 *
 * Timestamps stay VERBATIM (`String(...)`, no canonicalization) and a NUMBER is
 * accepted, because FEA-3597 froze this half byte-identical to its
 * pre-FEA-3597 output. Validation is deliberately NOT applied here: this
 * function answers "which turns are human", and
 * {@link deriveHumanTurnTimestamps} answers "may they be carried over the wire".
 */
export function collectHumanTurnUnits(
  messages: unknown,
  headless: boolean
): string[] {
  if (headless || !Array.isArray(messages)) {
    return [];
  }
  const units: string[] = [];
  for (const el of messages) {
    if (typeof el !== "object" || el === null || Array.isArray(el)) {
      continue;
    }
    const { role, timestamp } = el as {
      role?: unknown;
      timestamp?: unknown;
    };
    if (role !== "human") {
      continue;
    }
    // ISS-8659: a Claude `/fork` child keeps the parent's messages so the
    // inherited conversation still renders, but those turns were typed in the
    // PARENT session at the PARENT's timestamps. Bucketing them here credited
    // the child with work it never did, and put it on the wrong days.
    if (isForkReplayedMessage(el)) {
      continue;
    }
    if (typeof timestamp !== "string" && typeof timestamp !== "number") {
      continue;
    }
    units.push(String(timestamp));
  }
  return units;
}

/**
 * The `metadata.humanTurnTimestamps` value for one session's FULL local
 * metadata, or `null` when the key must be omitted entirely.
 *
 * WHOLE OR ABSENT — or, for a session with no human turns at all, an empty
 * array, which is a third and equally honest state (a headless session ships
 * one). The rule is load-bearing rather than fastidious. The
 * cloud reader treats a present array as AUTHORITATIVE and stops consulting
 * `$.messages`, so a partial array would silently report fewer human turns than
 * the pre-existing path already counts — the same undercount this ticket exists
 * to remove, re-introduced through a new door. Emitting nothing instead leaves
 * the reader on its existing basis, which is always at least as correct.
 *
 * So a single unit that cannot be carried (a numeric timestamp, a form outside
 * {@link isHumanTurnTimestamp}, an offset-bearing form naming an impossible
 * date) or a count past {@link MAX_METADATA_HUMAN_TURN_TIMESTAMPS} suppresses
 * the key for the WHOLE session.
 *
 * An empty array is returned as `[]` rather than `null`, and the two are NOT
 * equivalent downstream: the cloud reader treats a present array as
 * authoritative INCLUDING when it is empty, so `[]` reports the zero this
 * session genuinely has (a headless one ships it) and matches the desktop chart,
 * which derives its human rows from the same {@link collectHumanTurnUnits} call.
 *
 * Every carried unit is re-expressed in UTC by {@link toUtcHumanTurnTimestamp}
 * before it goes on the wire.
 */
export function deriveHumanTurnTimestamps(metadata: unknown): string[] | null {
  return deriveTurnTimestamps(
    metadata,
    collectHumanTurnUnits,
    MAX_METADATA_HUMAN_TURN_TIMESTAMPS
  );
}

/**
 * The offset-bearing spelling of {@link HUMAN_TURN_TIMESTAMP_PATTERN}, split
 * into its wall-clock text and its offset.
 *
 * A time part is REQUIRED, so the trailing `-15` of a bare `2026-06-15` can
 * never be misread as a `-15:00` offset.
 */
const OFFSET_BEARING_HUMAN_TURN_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,12}))?([+-])(\d{2}):?(\d{2})?$/;

/**
 * Re-express one carried unit in UTC, or `null` if it names no real instant.
 *
 * The wire value must carry NO offset, because the two readers of this key
 * disagree about one. The cloud casts it with `(t #>> '{}')::timestamp`
 * (`activity-heatmap.ts`), and PostgreSQL DISCARDS an offset on a cast to
 * zone-less `timestamp` rather than converting the instant — so
 * `2026-06-15T23:30:00-05:00` would bucket at 23:00 on the 15th. The desktop
 * chart stores the same unit verbatim and buckets it with SQLite `strftime`,
 * which DOES adjust an offset to UTC, landing it at 04:30 on the 16th. Shipping
 * the offset would therefore put one session's turn on two different days on the
 * two surfaces — the cross-surface inconsistency this ticket exists to remove.
 *
 * A zone-less or `Z`-suffixed unit is returned VERBATIM. Both readers already
 * agree on those (SQLite and `localTsSql` each read a zone-less date-time as
 * UTC — the same reading `canonicalizeStoredTimestamp` pins for ISS-5496), so
 * rewriting them would churn the derived golden sync fixtures for no behavior
 * change. Only the form that actually diverges is normalized.
 *
 * The offset is applied by arithmetic on components this module's own grammar
 * already pinned, rather than by handing the raw string to `Date.parse`: a
 * 2-digit offset (`+05`), a compact one (`+0530`), a space separator, and more
 * than 3 fractional digits are all outside the ECMA-262 Date Time String Format
 * and parse implementation-defined. The probe below is built to be inside it.
 */
export function toUtcHumanTurnTimestamp(value: string): string | null {
  const match = OFFSET_BEARING_HUMAN_TURN_TIMESTAMP.exec(value);
  if (!match) {
    return value;
  }
  const [, date, time, fraction, sign, offsetHours, offsetMinutes] = match;
  const wallClock = Date.parse(
    `${date}T${time}${fraction ? `.${fraction.slice(0, 3)}` : ""}Z`
  );
  if (!Number.isFinite(wallClock)) {
    return null;
  }
  const offsetMs =
    (Number(offsetHours) * 60 + Number(offsetMinutes ?? 0)) *
    60_000 *
    (sign === "-" ? -1 : 1);
  return new Date(wallClock - offsetMs).toISOString();
}

/**
 * ISS-8659: whether a raw `$.messages` element is one a Claude `/fork` child
 * replayed out of its parent.
 *
 * A fork keeps the parent's messages so the inherited conversation still
 * renders, but those turns happened in the PARENT session, at the parent's
 * timestamps, and were already counted there. Anything deriving a COUNT or a
 * TIMELINE from the message array has to skip them or it credits the child with
 * work it never did.
 *
 * Exported for the readers that hold a RAW element — an `unknown` off a
 * persisted blob or a worker payload, where the shape is not guaranteed and the
 * `typeof`/array narrowing above is load-bearing. A reader that already holds a
 * typed `NormalizedMessage` compares `message.isForkReplayed === true` directly
 * and does not detour through here; several do. What every reader shares is not
 * this function but the comparison, and the ticket's own near-miss is why that
 * matters: the human arm of `session_turn_bucket` learned the flag and the
 * agent arm beside it did not, so one array produced a filtered count and an
 * unfiltered one in the same file.
 *
 * Strict `=== true`, so a message from before the field existed, one whose
 * producer omits it, or one carrying a junk value all still count. The flag is
 * written only when it is true.
 *
 * Both SQL twins match that exactly, across the whole value domain rather than
 * the part that is reachable today: Postgres compares jsonb to jsonb
 * (`IS DISTINCT FROM 'true'::jsonb`) and SQLite tests the JSON TYPE
 * (`json_type(...) IS NOT 'true'`). The type test is what makes SQLite agree —
 * `json_extract` collapses JSON `true` and JSON `1` to the same integer, so any
 * predicate written on the extracted VALUE drops a numeric `1` as if it were the
 * flag. A corrupt or version-skewed blob is exactly where that would land, and
 * it is the fallback arm that reads such blobs, so "unreachable today" was not a
 * good enough reason to leave the three surfaces disagreeing.
 */
export function isForkReplayedMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return (value as { isForkReplayed?: unknown }).isForkReplayed === true;
}

/**
 * The whole-or-absent wire form of one derived turn-timestamp key, shared by
 * the human key and the agent key (ISS-9864) so the carry rule cannot fork
 * between them: `collectUnits` names WHICH rows are turns, and this decides
 * whether they MAY be carried. Any unit outside {@link isHumanTurnTimestamp}'s
 * grammar, or a count past `maxEntries`, suppresses the key (`null`); otherwise
 * every unit is re-expressed in UTC by {@link toUtcHumanTurnTimestamp}.
 */
export function deriveTurnTimestamps(
  metadata: unknown,
  collectUnits: (messages: unknown, headless: boolean) => string[],
  maxEntries: number
): string[] | null {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }
  const meta = metadata as {
    entrypoint?: unknown;
    permissionMode?: unknown;
    messages?: unknown;
  };
  const headless = isHeadlessSession({
    entrypoint: typeof meta.entrypoint === "string" ? meta.entrypoint : null,
    permissionMode:
      typeof meta.permissionMode === "string" ? meta.permissionMode : null,
  });
  const units = collectUnits(meta.messages, headless);
  if (units.length > maxEntries) {
    return null;
  }
  const carried: string[] = [];
  for (const unit of units) {
    if (!isHumanTurnTimestamp(unit)) {
      return null;
    }
    const utc = toUtcHumanTurnTimestamp(unit);
    if (utc === null) {
      return null;
    }
    carried.push(utc);
  }
  return carried;
}
