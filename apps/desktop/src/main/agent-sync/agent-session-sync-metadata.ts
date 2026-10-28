import {
  AGENT_TURN_TIMESTAMPS_METADATA_KEY,
  deriveAgentTurnTimestamps,
} from "@repo/lib/agent-sessions/agent-turn-timestamps";
import {
  deriveHumanTurnTimestamps,
  HUMAN_TURN_TIMESTAMPS_METADATA_KEY,
} from "@repo/lib/agent-sessions/human-turn-timestamps";
import {
  compactMetadataForPreview,
  MAX_METADATA_MESSAGES,
  type MetadataContentPolicy,
} from "@repo/lib/agent-sessions/metadata-preview";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";

/**
 * @file agent-session-sync-metadata.ts
 * @description The session-`metadata` half of the sync payload, split out of
 * `agent-session-sync-payload.ts` (ISS-7896).
 *
 * The split is a size requirement, not a taste call: before it, that file
 * measured 999 logical lines against the repo's hard 1,000-line
 * `noExcessiveLinesPerFile` ceiling and is NOT grandfathered, so the derivation
 * below could not be added there without reddening `pnpm lint`.
 *
 * It deliberately imports `@repo/lib` and nothing from `../database/`. The
 * human-turn predicate lives beside the compaction contract in `@repo/lib`
 * rather than beside the bucket derivation it is shared with, because
 * `agent-session-sync-payload.ts` is reachable from the desktop boot entries and
 * `boot-no-design-system-runtime` (apps/desktop/scripts/dependency-cruiser.config.cjs)
 * forbids a boot-reachable module from transitively reaching `src/main/database/`.
 * That rule is `reachable: true`, so routing the import through this module
 * would NOT have satisfied it — verified by adding the edge and running the gate,
 * which reported four errors against a clean baseline.
 */

/**
 * Reduce a session `metadata` blob to the bounded, content-stripped shape shipped
 * over the sync wire. FEA-3693: delegates to the ONE shared preview contract
 * (`compactMetadataForPreview` in `@repo/lib/agent-sessions/metadata-preview`)
 * that the cloud persist boundary (`sanitizeMetadataForPersist`) also calls, so
 * the desktop producer and the cloud lane emit byte-identical `metadata` for the
 * same normalized transcript — including the per-message preview floor and the
 * `textTruncation` markers. This dropped the hand-duplicated compaction that had
 * drifted from the cloud strip (desktop kept a 160-char floor after the aggregate
 * budget while the cloud dropped later `text` entirely).
 *
 * ISS-7896 made one key asymmetric between the two lanes, and ISS-9864 a
 * second on the same terms: {@link HUMAN_TURN_TIMESTAMPS_METADATA_KEY} and
 * {@link AGENT_TURN_TIMESTAMPS_METADATA_KEY} are DERIVED here, from the full
 * local `messages` array, and the cloud can only pass them through. It has to
 * happen on this side of the wire — the cloud receives `messages` already capped
 * at 100, so the counts it needs are no longer recoverable there. Every other
 * key stays equal by construction.
 *
 * The agent key is derived ONLY when the session synced no token events
 * (`hasTokenEvents` false). The cloud splits its Agent half on
 * `NOT EXISTS (agent_session_token_events)` and reads this key only on the
 * fallback side of that split, so on a round-trip session the key is bytes the
 * reader never consults — replicated into every sync chunk. `session.tokenEvents`
 * is the desktop twin of that table (hydrated whole from `token_events`, and it
 * is what the cloud's rows are made from), so the two sides gate on the same
 * fact. The signal is a session-row fact, not a blob fact, which is why it is
 * threaded in rather than read off `metadata.tokenSeries`: the cloud-sync drain
 * hydrates with `omitPreviewStrippedMetadata`, which replaces `tokenSeries` with
 * a scalar sentinel in SQL, so a blob-side gate would never fire on the real
 * drain while firing on the golden regen path.
 */
export function compactSessionMetadataForSync(
  metadata: SyncedAgentSession["metadata"],
  contentPolicy: MetadataContentPolicy,
  options: { hasTokenEvents: boolean }
): SyncedAgentSession["metadata"] {
  const withHuman = withDerivedTurnTimestamps(
    metadata,
    HUMAN_TURN_TIMESTAMPS_METADATA_KEY,
    deriveHumanTurnTimestamps
  );
  // Appended AFTER the human key, deliberately: `compactMetadataObject` keeps
  // the first `MAX_METADATA_KEYS` entries, so on a blob one short of the window
  // it is this key — not the human one, and never a real key — that falls off.
  const withAgent = withDerivedTurnTimestamps(
    withHuman,
    AGENT_TURN_TIMESTAMPS_METADATA_KEY,
    options.hasTokenEvents ? deriveNothing : deriveAgentTurnTimestamps
  );
  return compactMetadataForPreview(
    withAgent,
    contentPolicy
  ) as SyncedAgentSession["metadata"];
}

/**
 * Attach one derived turn-timestamp key, drop it, or leave the blob alone.
 *
 * APPENDED, never prepended. `compactMetadataObject` slices
 * `Object.entries(metadata).slice(0, MAX_METADATA_KEYS)` before it routes any
 * key, so on a blob that already carries 80 keys the appended key is the one that
 * falls off — and the cloud then reads `$.messages` exactly as it does today.
 * Prepending would push a REAL key off that window instead, which is a silent
 * data loss rather than a safe degradation. Real sessions carry ~16 keys.
 *
 * An array ALREADY on the blob is never trusted, and never merged with. Nothing
 * in a `metadata` blob attributes one to this session's own earlier pass:
 * shape validation proves syntax, and a head comparison against this pass's
 * units proves only that the two agree where they overlap — a foreign array can
 * share the real head and diverge in its tail (davetho, #6116). There is no
 * provenance token to check, so the honest options are to derive or to abstain.
 *
 * WHOLE OR ABSENT, applied to that ambiguity:
 *  - `messages` UNDER the compaction cap — this pass read the array whole, so
 *    the derivation is complete by construction and simply replaces whatever was
 *    there.
 *  - `messages` AT the cap AND a key already present — a prior compaction could
 *    have shortened what this pass can see, so neither candidate is provable.
 *    The key is DROPPED and the cloud falls back to `$.messages`, which is the
 *    pre-existing behavior. That is an undercount rather than a wrong number
 *    the cloud would read as authoritative.
 *  - `messages` at the cap with NO key present — the ordinary first pass over a
 *    long session, which is the case these keys exist for. The derivation is
 *    the best available basis and nothing contradicts it.
 *  - `derive` returns `null` — an uncarriable local unit, a count past the
 *    key's bound, or (agent key) a session whose reader never consults it. This
 *    pass has NO candidate of its own, so an existing array is even less
 *    attributable here than above, and it is dropped too. Returning the blob
 *    untouched would leave a stale array for the compactor to preserve and the
 *    cloud to read as authoritative (davetho, #6116) — the exact outcome the
 *    two arms above exist to prevent.
 *
 * The case abstention costs is a second `sanitizeSessionForSync` over one blob,
 * which `prepareAgentSessionPayload` does not do (it sanitizes exactly once).
 */
function withDerivedTurnTimestamps(
  metadata: SyncedAgentSession["metadata"],
  key: string,
  derive: (metadata: unknown) => string[] | null
): SyncedAgentSession["metadata"] {
  if (typeof metadata !== "object" || metadata === null) {
    return metadata;
  }
  const blob = metadata as Record<string, unknown>;
  const derived = derive(metadata);
  if (derived === null || derivationCouldBeShort(blob, key)) {
    return withoutKey(blob, key);
  }
  return {
    ...metadata,
    [key]: derived,
  } as SyncedAgentSession["metadata"];
}

/**
 * Could this pass have derived from an already-shortened `messages` while an
 * unattributable array sits on the blob? Both halves are required: at the cap
 * with no key there is nothing to be ambiguous WITH, and under the cap the
 * derivation is complete however many keys are present.
 */
function derivationCouldBeShort(
  blob: Record<string, unknown>,
  key: string
): boolean {
  return (
    key in blob &&
    Array.isArray(blob.messages) &&
    blob.messages.length >= MAX_METADATA_MESSAGES
  );
}

/**
 * The blob with any pre-existing `key` removed. Identity-preserving when the
 * key is absent, so the ordinary path allocates nothing.
 */
function withoutKey(
  blob: Record<string, unknown>,
  key: string
): SyncedAgentSession["metadata"] {
  if (!(key in blob)) {
    return blob as SyncedAgentSession["metadata"];
  }
  const { [key]: _dropped, ...rest } = blob;
  return rest as SyncedAgentSession["metadata"];
}

/**
 * ISS-7997: `metadata` reduced to the leading top-level keys whose serialized
 * form fits `maxBytes`.
 *
 * The compaction contract this module delegates to bounds `metadata` per
 * DIMENSION and never in aggregate, so a blob it admits WHOLE still serializes
 * to megabytes (measured: 4.1 MB from 40 keys of 100 rows, every dimension
 * inside its cap) and dead-letters the session it is replicated into.
 * `MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS` does not cover that: it bounds one
 * `messages` array's `text`, which measures 82 KiB at its worst case.
 *
 * Dropping from the END continues the ordering `compactMetadataObject` already
 * applies with `Object.entries(...).slice(0, MAX_METADATA_KEYS)` — earlier keys
 * win. A key that does not fit is SKIPPED rather than ending the scan, matching
 * `sessionWithBoundedComponentUsage`: breaking would starve every key after the
 * first oversized one.
 */
export function boundSessionMetadataToBytes(
  metadata: SyncedAgentSession["metadata"],
  maxBytes: number
): SyncedAgentSession["metadata"] {
  if (typeof metadata !== "object" || metadata === null) {
    return metadata;
  }
  // ISS-8883: null-prototype accumulator so a key literally named `__proto__`
  // — which both producers deliberately preserve (ISS-8565) — becomes an own
  // property here too instead of hitting the inherited setter, which reparents
  // the accumulator, creates no own key, and still counts the entry's bytes.
  const kept: Record<string, unknown> = Object.create(null);
  let bytes = EMPTY_JSON_OBJECT_BYTES;
  let keptAny = false;
  for (const [key, value] of Object.entries(metadata)) {
    // `JSON.stringify` emits no whitespace, so an object's exact serialized
    // length is `{}` plus each entry's own `"key":value` width plus one comma
    // between entries — the same additivity `appendPaginatedChunks` packs by.
    const entryBytes =
      Buffer.byteLength(JSON.stringify({ [key]: value })) -
      EMPTY_JSON_OBJECT_BYTES;
    const separatorBytes = keptAny ? 1 : 0;
    if (bytes + separatorBytes + entryBytes > maxBytes) {
      continue;
    }
    kept[key] = value;
    bytes += separatorBytes + entryBytes;
    keptAny = true;
  }
  // Spread restores a normal prototype for downstream consumers (object
  // spread defines rather than assigns, so an own `__proto__` key survives).
  return { ...kept } as SyncedAgentSession["metadata"];
}

/** Serialized width of `{}` — the base every bounded blob starts from. */
const EMPTY_JSON_OBJECT_BYTES = 2;

/**
 * ISS-7997: chunk `session` with its `metadata` bounded to the largest budget
 * that yields a part, or null when no non-empty blob does.
 *
 * `chunk` is INJECTED because the chunker lives in
 * `agent-session-sync-payload.ts`, which already imports this module — calling
 * it directly would close an import cycle.
 *
 * EMPTY IS REFUSED, and that is the load-bearing bound (review: synchronizing-
 * susan, review-soul). The cloud replaces `metadata` WHOLESALE —
 * `apps/api/.../service/session-slice-detail-write.ts` writes
 * `metadata: persistedMetadata ?? Prisma.DbNull` in the update arm — and a blob that compacts to nothing lands as SQL NULL,
 * ERASING what an earlier sync stored. Refusing empty is what keeps THAT case at
 * today's dead-letter, which preserves the stored row.
 *
 * THE DEGRADE NAMES WHAT IT WITHHELD (ISS-8641 / ISS-8714). Every candidate is
 * stamped with {@link METADATA_WITHHELD_KEYS_FIELD} listing the top-level keys
 * this function dropped, because the cloud assigns `metadata` WHOLESALE
 * (`session-slice-detail-write.ts`) and without that list a dropped key is
 * indistinguishable on the wire from one the user deleted — so a session that
 * synced whole while it was small lost those keys permanently on its first
 * degraded resync. Naming them lets the receiver reinstate exactly the withheld
 * keys and still honour a real deletion; see `degraded-metadata-merge.ts`.
 *
 * STAMPED BEFORE THE FIT IS MEASURED, following ISS-7265's `sessionWithoutTiling`:
 * the list rides the candidate handed to `chunk`, so its own bytes are counted
 * and a payload can never be accepted at a size that excludes its declaration.
 * It also shrinks monotonically with the budget — dropping a key frees
 * `"k":value` and costs only `"k"` — so the loop's termination is unaffected.
 *
 * The first budget is clamped BELOW the blob's own size because the caller only
 * reaches here after the whole blob failed — starting at or above it would spend
 * a full re-chunk (a gzip pass, on the compressed sizer) re-testing the exact
 * candidate already known to fail.
 *
 * A FAILED CANDIDATE STEPS TO THE NEXT DISTINCT RETAINED SUBSET, not to half the
 * budget (davetho, #6308). `boundSessionMetadataToBytes` SKIPS an unfittable
 * key and keeps scanning, so the retained set is discontinuous in the budget:
 * halving from a budget that retained `{a}` at 902 bytes jumps to 451 and never
 * tries the 501-byte `{b,c}` that both fits under 901 and is strictly more data
 * than the `{c}` it eventually lands on. Stepping to the failed candidate's OWN
 * serialized width minus one is the largest budget that cannot retain that
 * candidate again, so every attempt is a distinct subset, no attempt is a repeat
 * (halving retested identical subsets), and the shipped blob is the largest one
 * the chunker accepts rather than the largest power-of-two slice of it.
 *
 * The step strictly decreases the budget, so the loop still needs no
 * `budget === 0` terminator — the first blob that keeps no key ends it.
 * {@link MAX_DEGRADE_ATTEMPTS_PER_KEY} bounds the worst case anyway: bytes
 * falling by one per round would otherwise spend a gzip pass per byte, and
 * exhausting the cap returns null, which is exactly main's behaviour for this
 * session.
 */
export function chunkWithBoundedMetadata(
  session: SyncedAgentSession,
  startingBudget: number,
  chunk: (candidate: SyncedAgentSession) => SyncedAgentSession[]
): SyncedAgentSession[] | null {
  const metadata = session.metadata;
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }
  let budget = Math.max(
    0,
    Math.min(startingBudget, Buffer.byteLength(JSON.stringify(metadata)) - 1)
  );
  let attemptsLeft =
    Object.keys(metadata).length * MAX_DEGRADE_ATTEMPTS_PER_KEY + 1;
  for (;;) {
    const bounded = boundSessionMetadataToBytes(metadata, budget);
    if (Object.keys(bounded ?? {}).length === 0) {
      return null;
    }
    const chunks = chunk(withWithheldMetadataKeys(session, metadata, bounded));
    if (chunks.length > 0) {
      return chunks;
    }
    attemptsLeft -= 1;
    if (attemptsLeft <= 0) {
      return null;
    }
    // The candidate fit `budget`, so its own width is <= budget and this is a
    // strict decrease — the loop cannot stall on a subset it already rejected.
    budget = Buffer.byteLength(JSON.stringify(bounded)) - 1;
  }
}

/**
 * Degrade attempts allowed per top-level `metadata` key.
 *
 * The step in {@link chunkWithBoundedMetadata} sheds a whole key on the ordinary
 * blob, but it is a BYTE step and a pathological size distribution can trade one
 * key for several smaller ones instead, so key count alone does not bound the
 * round count. One is a floor, not the shape to expect; the slack is what keeps
 * a legitimate re-widening (`{a}` failing, `{b,c}` fitting) from being cut off
 * by the cap rather than by the chunker.
 */
const MAX_DEGRADE_ATTEMPTS_PER_KEY = 4;

/**
 * The wire field naming the withheld top-level `metadata` keys.
 *
 * A named constant rather than a literal at the two sites that write it, because
 * it is a cross-repo contract key the cloud ingest schema also spells; the
 * desktop-side spelling has exactly one owner.
 */
export const METADATA_WITHHELD_KEYS_FIELD = "metadataWithheldKeys" as const;

/**
 * The degraded candidate, carrying the top-level keys `bounded` dropped.
 *
 * OMITTED WHEN NOTHING WAS WITHHELD, never sent as `[]` or `null`. An absent
 * field is what every already-installed desktop build sends and what the cloud
 * reads as "no opinion, replace as usual" — so a payload that degraded nothing
 * must be byte-identical to one from a build that cannot degrade at all.
 * (`chunkWithBoundedMetadata` reaches here only after the whole blob failed, so
 * in practice the list is non-empty; the guard exists so the field's meaning does
 * not depend on that.)
 */
function withWithheldMetadataKeys(
  session: SyncedAgentSession,
  original: SyncedAgentSession["metadata"],
  bounded: SyncedAgentSession["metadata"]
): SyncedAgentSession {
  const withheld = withheldMetadataKeys(original, bounded);
  if (withheld.length === 0) {
    return { ...session, metadata: bounded };
  }
  return {
    ...session,
    metadata: bounded,
    [METADATA_WITHHELD_KEYS_FIELD]: withheld,
  };
}

/** Top-level keys present in `original` and absent from `bounded`. */
function withheldMetadataKeys(
  original: SyncedAgentSession["metadata"],
  bounded: SyncedAgentSession["metadata"]
): string[] {
  if (typeof original !== "object" || original === null) {
    return [];
  }
  const kept = new Set(Object.keys(bounded ?? {}));
  return Object.keys(original).filter((key) => !kept.has(key));
}

/** The derivation for a key the reader will never consult on this session. */
function deriveNothing(): null {
  return null;
}
