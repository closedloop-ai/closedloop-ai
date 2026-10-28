/**
 * @file index-key-projection.ts
 * @description ISS-8069: bound what enters a Postgres BTREE INDEX KEY without
 * ever rejecting the payload that carried it.
 *
 * Postgres refuses any btree index tuple larger than 2704 bytes. A desktop-sync
 * string that lands in an indexed column therefore does not simply store badly —
 * it makes the write THROW (`index row size ... exceeds btree version 4
 * maximum`). On the component fan-out, which is not a transaction, that lands
 * mid-batch: siblings have already committed, the request fails, and the desktop
 * re-sends the identical poison batch forever with nothing on the wire saying
 * why.
 *
 * The remedy is applied at the WRITE, not at the wire. Nothing here validates,
 * and no caller of this module may turn it into a `.max()`: the payload is
 * accepted whole, and only the value about to be handed to an indexed column is
 * projected down to a size the index can physically hold.
 *
 * WHY NOT THE TWO REMEDIES RANKED ABOVE THIS ONE (ISS-8069 lists three):
 *
 *  1. "Index a bounded digest, store the full value in the column" needs a
 *     second, generated column per field plus a rewrite of every reader to
 *     filter on that column instead — the planner will not use an expression
 *     index for `WHERE harness IN (...)`. Across the six indexes involved that
 *     is a schema project, not a fix, and it puts the correctness risk in the
 *     query rewrite.
 *  2. A non-btree index does not fit the shapes involved. A Postgres hash index
 *     is single-column and equality-only, and it cannot back a unique
 *     constraint. Of the six indexes here, four are composite and two of those
 *     are UNIQUE, so a hash index covers exactly one
 *     (`SessionDetail @@index([repositoryFullName])`) and leaves the poison
 *     reachable through the other five.
 *
 * So this is remedy 3, and its condition is that the bound is never silent:
 * every projection is counted and reported by its caller under
 * {@link INDEX_KEY_PROJECTED_METRIC}.
 *
 * NEVER SILENT IS NOT THE SAME AS ONCE PER REQUEST. A caller whose emission an
 * authenticated client can drive must bound it per `apps/api/AGENTS.md`
 * ("Emission and Abuse Control") — the invocation lane does, in
 * `app/agent-sessions/service/invocation-index-key-telemetry.ts` (ISS-8736).
 * Bounding preserves the tally rather than dropping it: a suppressed occurrence
 * is flushed as an aggregate rollup, so the total is eventual, not lossy.
 *
 * DETERMINISTIC AND COLLISION-RESISTANT, which is what makes it safe on an
 * IDENTITY column. A plain truncation would fold two distinct over-long
 * `externalSessionId`s onto one row — two different sessions silently merged.
 * Appending the sha256 of the FULL original keeps distinct inputs distinct, and
 * being a pure function of the input keeps every retry and every later re-sync
 * of the same session landing on the same key, so the upsert stays idempotent.
 *
 * LOSSY, and deliberately so: the tail past the budget is not recoverable from
 * the projected value. That is the trade remedy 3 names. A value big enough to
 * reach it cannot be a real harness, model, repository name, content hash or
 * session id, and the alternatives for it are the row never landing at all
 * (today) or the whole payload being rejected (which ISS-8051 exists to
 * delete).
 */
import { createHash } from "node:crypto";

export const INDEX_KEY_PROJECTED_METRIC = "desktop.sync.index_key_projected";

/**
 * Marker separating the retained head of a projected value from the digest of
 * the original. Present in the stored value on purpose: a projection has to be
 * recognizable as one, both to a human reading the column and to the
 * `projected` tally its caller reports.
 *
 * It is also the RESERVED NAMESPACE (ISS-8254). Any value containing it is
 * projected regardless of length — see {@link isReservedIndexKey}.
 */
export const INDEX_KEY_PROJECTION_MARKER = "~idxsha256:";

/**
 * Per-string byte budget for a value bound for an index key.
 *
 * Sized from the WORST composite this repo indexes rather than from the raw
 * 2704: `AgentComponentVersion @@unique([organizationId, componentKind,
 * componentKey, source, contentHash])` puts a uuid and FOUR strings in one
 * tuple, so a per-string bound only makes the tuple safe if the sum does. Three
 * projected strings at 512 bytes plus a 16-byte uuid plus tuple overhead is
 * ~1.6 KB, comfortably inside 2704 with room for the fourth.
 *
 * BYTES, not characters, and that distinction is the point. The component
 * identity fields used to carry a 512-CHARACTER `.max()` beside this, which is
 * up to 2048 BYTES of multibyte UTF-8 — three of those in the tuple above is
 * 6 KB and still over the limit. A character cap cannot bound an index tuple;
 * only a byte budget can, which is why ISS-8201 deleted those caps rather than
 * keeping a second bound that agreed with this one on ASCII and nothing else.
 *
 * 512 bytes is far above any legitimate value on these columns: a sha256 hex is
 * 64, a GitHub `owner/repo` is at most 140, a harness or model name is a few
 * dozen.
 */
export const INDEX_KEY_MAX_BYTES = 512;

const DIGEST_HEX_LENGTH = 64;

/**
 * The smallest budget a projection can be asked for and still emit a value that
 * carries its own digest: the marker plus the full sha256 hex, with nothing left
 * for a head. A caller asking for less would get a value that is no longer
 * injective, so it is rejected rather than silently truncated.
 */
export const INDEX_KEY_MIN_BYTES =
  INDEX_KEY_PROJECTION_MARKER.length + DIGEST_HEX_LENGTH;

/**
 * The exact tail {@link projectIndexKey} emits. Built from the marker and digest
 * length rather than re-typing them, so a change to either cannot leave this
 * silently matching the old format. The marker carries no regex metacharacter,
 * so it interpolates literally.
 */
const PROJECTED_INDEX_KEY_SHAPE = new RegExp(
  `${INDEX_KEY_PROJECTION_MARKER}[0-9a-f]{${DIGEST_HEX_LENGTH}}$`
);

/** One projected index key plus whether the budget actually bound. */
export type IndexKeyProjection = {
  value: string;
  projected: boolean;
};

/**
 * Project one value down to `maxBytes`, or pass it through untouched when it
 * already fits AND is outside the reserved namespace.
 *
 * `projected` is true whenever a BOUND value is what lands — either because the
 * byte budget bound, or because the input was reserved — so a caller tallying it
 * counts the cases where the stored key is not the input it was given.
 *
 * ISS-8125 (review, whitlockk): `maxBytes` is a parameter rather than always
 * {@link INDEX_KEY_MAX_BYTES} because a column's index tuple is not always the
 * tightest bound on it. The transcript identity derives an S3 OBJECT KEY from
 * two projected strings, and S3 caps a key at 1024 bytes — two 512-byte segments
 * build a 1105-byte key, so the default budget bounds Postgres and overflows S3.
 * Only the string with no cross-table obligation gives way: that caller passes
 * its own budget for `fileKey` alone and leaves `externalSessionId` on the
 * default, because the default IS what `SessionDetail` stores and the two tables
 * are joined on it (see `TRANSCRIPT_FILE_KEY_MAX_BYTES`). Defaulted, so every
 * existing call site keeps the 512-byte budget it was written against. It
 * narrows the pass-through branch only, so the ISS-8254 disjointness argument
 * below is unchanged by it.
 *
 * INJECTIVE, which is the whole point of ISS-8254 and is what "collision-free by
 * construction" means here. The two branches below have DISJOINT output sets: a
 * pass-through result never contains {@link INDEX_KEY_PROJECTION_MARKER} (that is
 * exactly what {@link isReservedIndexKey} excludes) and a projected result always
 * does. Inside the pass-through branch the function is the identity, and inside
 * the projected branch distinct inputs give distinct digests. So no two distinct
 * inputs can share a stored key, and the pre-ISS-8254 attack — feed a long
 * value's projected OUTPUT back in as a short RAW identity and land on its row —
 * no longer has a fixed point to aim at.
 *
 * NOT IDEMPOTENT, and it provably cannot be. A bounding function that is both
 * injective and idempotent is the identity: `f(f(x)) = f(x)` plus injectivity
 * gives `f(x) = x` for every x, which bounds nothing. Collision-freedom is the
 * security property, so idempotence is what gives way. A caller that holds a
 * value READ BACK from an indexed column must therefore not re-project it —
 * resolve it with {@link indexKeyCandidates} / {@link resolveStoredIndexKey}
 * instead, which is what the write paths already do.
 */
export function projectIndexKey(
  value: string,
  maxBytes: number = INDEX_KEY_MAX_BYTES
): IndexKeyProjection {
  if (maxBytes < INDEX_KEY_MIN_BYTES) {
    throw new Error(
      `index-key budget ${maxBytes} is below the ${INDEX_KEY_MIN_BYTES} bytes a projected value needs to stay injective`
    );
  }
  if (utf8ByteLength(value) <= maxBytes && !isReservedIndexKey(value)) {
    return { value, projected: false };
  }
  const digest = createHash("sha256")
    .update(toLosslessBytes(value))
    .digest("hex");
  const head = truncateToUtf8Bytes(
    value,
    maxBytes - INDEX_KEY_PROJECTION_MARKER.length - DIGEST_HEX_LENGTH
  );
  return {
    value: `${head}${INDEX_KEY_PROJECTION_MARKER}${digest}`,
    projected: true,
  };
}

/**
 * {@link projectIndexKey} for a nullable column. `null` passes through as `null`
 * and is never counted as a projection — an absent value has no index tuple to
 * overflow.
 */
export function projectNullableIndexKey(value: string | null | undefined): {
  value: string | null;
  projected: boolean;
} {
  if (value == null) {
    return { value: null, projected: false };
  }
  return projectIndexKey(value);
}

/**
 * Count how many of several projections actually bound, for the one-per-batch
 * tally the callers report. Kept here so no call site re-derives "did this
 * bind?" from string shape.
 */
export function countProjected(
  ...projections: readonly { projected: boolean }[]
): number {
  let total = 0;
  for (const projection of projections) {
    if (projection.projected) {
      total += 1;
    }
  }
  return total;
}

/**
 * Every key a row for `value` could ALREADY be stored under, for a lookup whose
 * input came off the wire.
 *
 * ISS-8069 (review, whitlockk): projecting at the write re-keys a session or
 * component that was perfectly storable before — the btree budget is 2704 bytes
 * for the whole tuple, {@link INDEX_KEY_MAX_BYTES} is 512 for one string, so
 * everything between the two stored fine and is sitting in the database under
 * its RAW value right now. A lookup that asks only for the projected key misses
 * that row and the upsert beside it mints a SECOND one: one session split in
 * two, and a component whose usage rows never relink.
 *
 * The same two candidates also cover the opposite miss — a lane still holding
 * the raw wire id looking for a row the ingest wrote projected — so both
 * directions are one mechanism rather than two rules to keep in step.
 *
 * ONE candidate for every value inside the budget, which is all of them in
 * practice, so this degenerates to the plain equality lookup it replaces. The
 * caller writes through {@link resolveStoredIndexKey}, never through this.
 *
 * A value that already LOOKS LIKE a projection gets ONE candidate, and never its
 * own raw form (ISS-8254). Offering the raw form back is precisely how an
 * attacker submitting a long value's projected output would still be routed onto
 * that long value's existing row. Legitimately projected rows are untouched — a
 * stored key contains the marker, but the WIRE value that resolves to it does
 * not, so it still gets both candidates.
 *
 * WHAT SUPPRESSES THE RAW FORM IS THE PROJECTED SHAPE, NOT MERE RESERVATION
 * (ISS-8254 review — codex, whitlockk). {@link isReservedIndexKey} is a deliberately
 * broad CONTAINMENT test, so suppressing on it stranded a legacy id that merely
 * contains the marker somewhere — `foo~idxsha256:bar`. Those were accepted and
 * stored verbatim before this ticket (`transcriptFileIdentitySchema` permits `~`
 * and `:`), and dropping their raw candidate would have made the next sync miss
 * the existing row and mint a second `SessionDetail`, splitting its children
 * mid-rolling-deploy. So the read side narrows to
 * {@link hasProjectedIndexKeyShape}, and the security property survives intact:
 * every value {@link projectIndexKey} emits HAS that shape, so no wire value can
 * project onto a raw candidate this still offers, and the replay attack has no
 * fixed point to aim at. Only the write side stays broad, which is what keeps
 * the disjointness argument in {@link projectIndexKey} unchanged.
 *
 * The residual is a legacy id that coincidentally ends in the marker plus 64 hex
 * characters. It is indistinguishable from a real projection output, so it stays
 * unreachable — the deliberate side of the trade, because that is the exact
 * string an attacker replays.
 */
export function indexKeyCandidates(
  value: string,
  maxBytes: number = INDEX_KEY_MAX_BYTES
): string[] {
  const projection = projectIndexKey(value, maxBytes);
  if (!projection.projected || hasProjectedIndexKeyShape(value)) {
    return [projection.value];
  }
  return [projection.value, value];
}

/**
 * The key to WRITE, given whichever of {@link indexKeyCandidates} actually
 * matched a stored row (`null` when none did).
 *
 * An existing row keeps the key it is already stored under — re-keying it would
 * orphan every child row that references the old value, and the row's existence
 * proves that key fits the index. Only a row that does not exist yet gets the
 * projected key.
 *
 * `projected` stays the tally's single source of truth: it is true only when a
 * BOUND value is what lands, so adopting a legacy raw key reports zero rather
 * than counting a projection that did not happen.
 *
 * `storedKey` is only ever one of {@link indexKeyCandidates}, which is what keeps
 * ISS-8254 closed here: since that list never offers back a value whose own form
 * has the PROJECTED SHAPE, this can no longer adopt a stored key that some other
 * value projects to, and the write cannot be steered onto another identity's row.
 * A legacy key that merely contains the marker IS adoptable, and safely so — no
 * projection can emit it, so no second wire value reaches it.
 */
export function resolveStoredIndexKey(
  value: string,
  storedKey: string | null | undefined
): IndexKeyProjection {
  const projection = projectIndexKey(value);
  if (storedKey == null) {
    return projection;
  }
  return {
    value: storedKey,
    projected: projection.projected && storedKey === projection.value,
  };
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Encode for the DIGEST, and deliberately not as UTF-8.
 *
 * A JS string is UTF-16 code units, and `JSON.parse` accepts a `\uD800` escape,
 * so an accepted `z.string()` can carry an UNPAIRED SURROGATE. Node's UTF-8
 * encoder maps every unpaired surrogate to the same U+FFFD bytes, so hashing as
 * UTF-8 gives `…\uD800` and `…\uD801` one digest — and since the retained head
 * collapses them identically too, the whole projected key collides and the
 * upsert silently MERGES two distinct identities onto one row. UTF-16LE is a
 * bijection on code units, so the digest separates them.
 *
 * Only the digest is lossless; the head is still what Postgres can store, which
 * is why the digest has to carry the distinction on its own.
 */
function toLosslessBytes(value: string): Buffer {
  return Buffer.from(value, "utf16le");
}

/**
 * Truncate on a CODE POINT boundary so the result is never a half-encoded
 * sequence. Slicing the UTF-8 bytes directly would split a multibyte character
 * and decode back to U+FFFD, which is both lossy in a second way and no longer a
 * pure function of the prefix.
 */
function truncateToUtf8Bytes(value: string, maxBytes: number): string {
  let used = 0;
  let out = "";
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (used + size > maxBytes) {
      break;
    }
    used += size;
    out += codePoint;
  }
  return out;
}

/**
 * Whether `value` sits inside the namespace {@link projectIndexKey} emits into.
 *
 * ISS-8254: before this existed, `projectIndexKey` passed ANY value at or below
 * the budget through unchanged, so its own 512-byte output was a valid RAW input
 * that mapped to itself — `projectIndexKey(long) === projectIndexKey(that
 * output)`. Two distinct identities then shared one unique key: one
 * `SessionDetail` row for two sessions. Nothing on the wire stops a caller
 * sending it — `transcriptFileIdentitySchema` constrains only the SHAPE of
 * `externalSessionId` (`PATH_SAFE_SEGMENT = /^[^/]+$/`), which permits `~` and
 * `:`.
 *
 * NOT a shared S3 OBJECT (ISS-8254 review, davetho). The transcript object key
 * is built from the RAW wire `externalSessionId` — `resolveTranscriptObjectKey`
 * in `app/desktop/transcripts/transcript-plan.ts`, called with
 * `request.externalSessionId` at `app/desktop/transcripts/service.ts` — so the
 * long id and its projected form always addressed different objects. What the
 * transcript lane actually inherited from the row collision is a MIS-LINK:
 * `resolveSessionDetailId` resolves `sessionDetailId` through
 * `projectIndexKey(raw)`, which pre-fix sent the replayed session's transcripts
 * to the LONG session's `SessionDetail`. Distinct bytes, wrong parent.
 *
 * Reserving the namespace at the FUNCTION is what makes the fix structural
 * rather than a validation rule. Tightening that regex would be defence in
 * depth at best: the stored population already contains whatever it contains,
 * and this module's contract (ISS-8069, ISS-8051) is that a payload is never
 * rejected for the shape of a value bound for an index key.
 *
 * A CONTAINMENT test, not a shape test, deliberately. It reserves a superset of
 * what {@link projectIndexKey} actually emits, so the disjointness the
 * injectivity argument rests on cannot be narrowed by a later change to the
 * projected format. The marker is an 11-character literal chosen not to occur in
 * a real harness, model, repository name, content hash or session id, so the
 * cost of over-reserving is nil.
 */
export function isReservedIndexKey(value: string): boolean {
  return value.includes(INDEX_KEY_PROJECTION_MARKER);
}

/**
 * Whether `value` has the exact shape {@link projectIndexKey} EMITS — the marker
 * followed by the digest, at the end of the string.
 *
 * The narrow twin of {@link isReservedIndexKey}, and the two must not be merged.
 * Reservation is a containment test and is deliberately a SUPERSET, because the
 * write side's injectivity argument needs the output namespace closed even if the
 * projected format later changes. This one is the exact set, and it is what the
 * READ side needs: a value outside it cannot be any input's projection, so a row
 * stored under it can only ever have been written by that same value arriving raw
 * — which makes offering it back as a legacy candidate collision-free.
 *
 * Anchored at the end only. A projected value's retained head may itself contain
 * the marker (replaying a captured key projects to
 * `<captured>~idxsha256:<digest>`), so the LAST occurrence is the structural one
 * and a start-anchored or containment test would misread the nested case.
 */
export function hasProjectedIndexKeyShape(value: string): boolean {
  return PROJECTED_INDEX_KEY_SHAPE.test(value);
}

/**
 * Every key a SIBLING table could hold for an identity whose stored key you
 * already read back OUT of an indexed column.
 *
 * The twin of {@link indexKeyCandidates}, and the difference between them is the
 * whole point: that one takes a value off the WIRE, so projecting it is exactly
 * right. This one takes a value that has already BEEN through a column, and
 * projecting that a second time is the hazard ISS-8254 created —
 * {@link projectIndexKey} is deliberately NOT idempotent, so re-applying it to a
 * projected value digests the PROJECTION rather than the original and yields a
 * third key that matches nothing. It does not throw and it does not log; the
 * lookup simply misses.
 *
 * ISS-8125 (operator review): `backfillOrphanTranscriptsBatch` read
 * `SessionTranscript.externalSessionId` and re-projected it to find the
 * `SessionDetail` it belongs to. Correct only while the transcript column was
 * stored RAW — which is what main does today, and what this ticket changes. The
 * orphan then never links, and the run reports it as "awaiting session
 * metadata", which is a lie about a row that will never resolve.
 *
 * So a stored key is offered AS-IS, plus — only when it is not itself a
 * projection — the key it WOULD have projected to, which is what a row written
 * before this repo projected that column needs. A value already carrying the
 * projected shape gets exactly one candidate, itself: it cannot be any other
 * input's raw form (see {@link hasProjectedIndexKeyShape}), and re-projecting it
 * is the bug this exists to stop.
 *
 * Only correct across two tables that project the column at the SAME budget.
 * Two budgets for one logical identity make the sibling key underivable from the
 * stored one, in either direction — which is why `externalSessionId` is
 * projected at {@link INDEX_KEY_MAX_BYTES} everywhere it is stored.
 */
export function storedIndexKeyCandidates(storedKey: string): string[] {
  if (hasProjectedIndexKeyShape(storedKey)) {
    return [storedKey];
  }
  const projection = projectIndexKey(storedKey);
  if (!projection.projected) {
    return [storedKey];
  }
  return [storedKey, projection.value];
}

/**
 * The retained head of a projected value — everything before the marker.
 *
 * A projection cannot be inverted, so this is the ONLY part of the original a
 * reader still holds, and it is byte-identical to the head of the raw value the
 * projection replaced. That makes it the one usable probe for a row written RAW
 * before this repo projected the column: prefix-match on the head to get a small
 * candidate set, then re-project each candidate and compare in full. The head
 * alone is NOT a match — two distinct values share it by construction whenever
 * they agree on their first bytes, which is exactly why the digest tail exists.
 *
 * Returns the value unchanged when it carries no marker, so a caller that has
 * not checked {@link hasProjectedIndexKeyShape} first cannot silently probe on a
 * whole raw key.
 */
export function projectedIndexKeyHead(value: string): string {
  const markerAt = value.lastIndexOf(INDEX_KEY_PROJECTION_MARKER);
  return markerAt === -1 ? value : value.slice(0, markerAt);
}
