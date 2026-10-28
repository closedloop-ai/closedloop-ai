/**
 * @file index-key-lookup.ts
 * @description ISS-8200: the ONE ordered probe shared by every lane that
 * RESOLVES an identity stored in a projected index-key column.
 *
 * ISS-8069 applied the bound at the WRITE (`index-key-projection.ts`), which is
 * correct for an attribute. `externalSessionId` and the component identity tuple
 * are not attributes — they are JOIN KEYS, so re-keying them at one write
 * obliges every lane that resolves the same identity to resolve it identically.
 * Most did not: ISS-8200 enumerates the misses, and each one is silent. A
 * projected session resolves to no row, so the invocation lane returns
 * `SessionMissing` and the desktop dead-letters a whole generation; the
 * transcript lane leaves a file permanently unlinked; retention builds a
 * where-clause that matches nothing and leaves the S3 objects behind.
 *
 * WHY A SHARED PROBE RATHER THAN A FALLBACK PER LANE. Four independent
 * fallbacks is the shape this repository tracks as SSOT drift by copy: they
 * agree on the day they land and diverge on the first change to either
 * candidate rule. There is exactly one rule — {@link indexKeyCandidates} for a
 * value off the WIRE, {@link storedIndexKeyCandidates} for one read back OUT of
 * a column — and this module is where a lane consumes it.
 *
 * WHY NOT ONE `in` LIST. The candidates are ORDERED and the order carries
 * meaning: the projected key WINS when a raw and a projected row both somehow
 * exist, because the projected key is what every write since ISS-8069 lands on.
 * A single `findFirst` over an `in` list picks between them unordered, so the
 * same identity could resolve to different rows on consecutive requests. The
 * second probe is reached only when the byte budget actually bound, so ordinary
 * traffic pays exactly the one lookup this replaces.
 *
 * A lane whose read is a SET read rather than a point read (an `in` over many
 * identities at once) cannot use this probe and must union the candidates into
 * its own `in` list instead; {@link indexKeyLookupCandidates} is the same rule
 * for that shape, so the two still share one definition of "which keys could
 * hold this identity".
 */
import {
  hasProjectedIndexKeyShape,
  indexKeyCandidates,
  projectIndexKey,
  storedIndexKeyCandidates,
} from "./index-key-projection";

/**
 * Where the value a lane is resolving came from, which decides its candidate
 * set. The two are NOT interchangeable and neither works for the other: a wire
 * value is projected to find the row, while projecting a value already read out
 * of a column digests the PROJECTION rather than the original and lands on a key
 * no table holds (`projectIndexKey` is deliberately not idempotent — ISS-8254).
 *
 * Explicit rather than sniffed from the value's shape: `indexKeyCandidates`
 * withholds the raw form from a projected-shaped WIRE value on purpose (that is
 * a replayed capture), so shape alone cannot tell the two origins apart and
 * guessing would relax that guard.
 */
export const IndexKeyOrigin = {
  Stored: "stored",
  Wire: "wire",
} as const;
export type IndexKeyOrigin =
  (typeof IndexKeyOrigin)[keyof typeof IndexKeyOrigin];

/** A resolved row plus the key it was actually stored under. */
export type IndexKeyMatch<T> = {
  record: T;
  storedKey: string;
};

/**
 * Every key a row for this identity could already be stored under, in probe
 * order, chosen by where the value came from.
 */
export function indexKeyLookupCandidates(
  value: string,
  origin: IndexKeyOrigin = IndexKeyOrigin.Wire
): string[] {
  if (origin === IndexKeyOrigin.Stored) {
    return storedIndexKeyCandidates(value);
  }
  return indexKeyCandidates(value);
}

/**
 * Probe each candidate in order and return the first row that exists, with the
 * key it matched — `null` when the identity has no row yet.
 *
 * `find` is the lane's own read, so each lane keeps its own `where` extras,
 * `select` and transaction client while sharing this one resolution rule.
 */
export async function resolveByAnyIndexKey<T>(
  value: string,
  find: (candidate: string) => Promise<T | null | undefined>,
  origin: IndexKeyOrigin = IndexKeyOrigin.Wire
): Promise<IndexKeyMatch<T> | null> {
  for (const candidate of indexKeyLookupCandidates(value, origin)) {
    const record = await find(candidate);
    if (record) {
      return { record, storedKey: candidate };
    }
  }
  return null;
}

/**
 * The key a STORED value is indexed under by callers that key their own maps on
 * the projected identity.
 *
 * A set read cannot use the ordered probe: it unions the candidates into one
 * `in` list and gets back rows under whichever key each is stored. Those rows
 * then have to be folded back onto ONE key, or a legacy raw row lands in the
 * map under a key nothing looks up and the widened read buys nothing.
 *
 * Re-projecting unconditionally is the trap: {@link projectIndexKey} is not
 * idempotent (ISS-8254), so a value already carrying the projected shape must be
 * returned as itself — projecting it again digests the projection and yields a
 * third key matching nothing.
 */
export function normalizeStoredIndexKey(storedKey: string): string {
  if (hasProjectedIndexKeyShape(storedKey)) {
    return storedKey;
  }
  return projectIndexKey(storedKey).value;
}
