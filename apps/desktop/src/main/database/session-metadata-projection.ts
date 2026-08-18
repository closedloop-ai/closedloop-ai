/**
 * @file session-metadata-projection.ts
 * @description ISS-6119: stop hydrating the part of `sessions.metadata` that the
 * caller's own projection is guaranteed to throw away.
 *
 * `assembleSyncedSessions` parses the WHOLE `sessions.metadata` blob for every
 * session in a chunk. The cloud-sync payload builder then reduces that object to
 * a bounded preview (`compactMetadataForPreview`), which drops every key in
 * {@link OMITTED_METADATA_KEYS} outright; the list/analytics folds never read
 * those keys at all. Measured on the real 2.1 GB snapshot (2,972 sessions),
 * `tokenSeries` — the sole member of that set — is **69.6 MB of the corpus's
 * 132.7 MB of metadata (52.5%)**, and 2.59 MB of the heaviest single session's
 * 2.83 MB. Parsing it to discard it is the single clearest waste on the
 * hydration path.
 *
 * The value strip therefore happens in SQL, before the driver materializes the column,
 * for the same reason FEA-2038 nulls `events.data` and ISS-6050 nulls
 * `token_events.cost_summary` in SQL rather than after the fact: the libSQL
 * driver materializes the full result set in memory before any JS-side omit can
 * run, so a JS-side drop saves the parse but not the text.
 *
 * ## Why this cannot change a result
 *
 * The paths that opt in are exactly the paths that provably discard these keys:
 *
 *  - the cloud-sync drain (`hydrateSyncCandidates`), whose every session goes
 *    through `compactSessionMetadataForSync` -> `compactMetadataForPreview`,
 *    which `continue`s past every {@link OMITTED_METADATA_KEYS} member; and
 *  - the list/analytics read (`LIST_LOAD`), which reaches `metadata` only through
 *    `buildTraceTimelineRows` (`messages`, `slashCommands`) and
 *    `buildSessionTraceSyncFields` (`diffStats`, `userMessages`,
 *    `assistantMessages`, `entrypoint`) — none of them a member of
 *    {@link OMITTED_METADATA_KEYS}.
 *
 * `turn-buckets.ts` and `session-analytics-rollup.ts` DO read `$.tokenSeries`,
 * but from their own statements against the stored column, not from a hydrated
 * `SyncedAgentSession` — so they are untouched by this projection.
 *
 * The DETAIL and branch-trace loads, which retain the blob verbatim for the
 * renderer, deliberately do NOT opt in.
 *
 * Neither does the FEA-1834 LIGHTWEIGHT usage load (`loadSqliteUsageSessions`),
 * which builds its own `selectSessionRows` call rather than taking a
 * `SyncedSessionLoadOptions`. Its fold looks equally safe, but "looks safe" is
 * the standard this seam was reverted for last time: opting it in needs its own
 * result-equivalence evidence over the real corpus, so it is deliberately left
 * for a follow-up rather than smuggled in on this one's proof.
 *
 * The key list is read from the shared preview contract rather than re-declared,
 * so a key added to (or removed from) `OMITTED_METADATA_KEYS` moves both halves
 * together and this projection cannot drift into stripping something a consumer
 * still reads. The keys remain in place with a scalar `0` sentinel until the
 * caller's compactor drops them. That preserves `compactMetadataForPreview`'s rule that
 * omitted keys still count toward its first-80-key input window: removing a key
 * here would incorrectly pull the 81st stored key into the preview.
 */
import { OMITTED_METADATA_KEYS } from "@repo/lib/agent-sessions/metadata-preview";

/** The stored column, and the alias every projection of it answers under. */
const METADATA_COLUMN = "metadata";

/**
 * Keys safe to interpolate into a SQL JSON path literal.
 *
 * `OMITTED_METADATA_KEYS` is a repo constant, not runtime input, so this is a
 * code-level invariant rather than a validation boundary — but the expression is
 * built by string interpolation, so an exotic key must degrade to "no strip"
 * instead of emitting a malformed or injectable path. See
 * {@link sessionMetadataSelectExpression}.
 */
const SAFE_JSON_PATH_KEY = /^[A-Za-z0-9_]+$/;

/**
 * The `sessions.metadata` SELECT expression for a hydration, aliased back to
 * `metadata` so `SqliteSessionRow` is unchanged either way.
 *
 * When `omitPreviewStrippedKeys` is false this is the bare column and the read is
 * byte-for-byte what it always was.
 *
 * When true, the {@link OMITTED_METADATA_KEYS} path values are replaced with
 * the scalar `0` by `json_replace`. Four properties make that safe:
 *
 *  1. `json_replace` RAISES on malformed JSON rather than returning NULL, so the
 *     `json_valid` guard is load-bearing: without it one corrupt row would abort
 *     the whole hydration read. A row that is NULL or not valid JSON passes
 *     through untouched — the honest projection of a blob that cannot be
 *     narrowed, and the same value the un-stripped read would have returned.
 *  2. `json_replace` re-serializes, but it preserves number literals verbatim
 *     (`1.50` stays `1.50`, `12345678901234567890` keeps all 20 digits) and
 *     preserves duplicate keys, so the only difference `JSON.parse` can observe
 *     is insignificant whitespace.
 *  3. Replacing an ABSENT path is a no-op on content, so a session that never
 *     carried these keys is unaffected.
 *  4. Replacing rather than removing retains the key's object position. The
 *     downstream compactor therefore slices the same first 80 input keys before
 *     omitting this one, instead of admitting a formerly-81st key.
 *
 * Falls back to the bare column if any key is not a plain identifier, which is
 * the direction that cannot change a result.
 */
export function sessionMetadataSelectExpression(
  omitPreviewStrippedKeys: boolean,
  column: string = METADATA_COLUMN,
  keys: Iterable<string> = OMITTED_METADATA_KEYS
): string {
  if (!omitPreviewStrippedKeys) {
    return column;
  }
  const paths = [...keys];
  if (
    paths.length === 0 ||
    !paths.every((key) => SAFE_JSON_PATH_KEY.test(key))
  ) {
    return column;
  }
  const pathArgs = paths.map((key) => `'$.${key}', 0`).join(", ");
  return `CASE
        WHEN ${column} IS NULL OR json_valid(${column}) = 0 THEN ${column}
        ELSE json_replace(${column}, ${pathArgs})
      END`;
}
