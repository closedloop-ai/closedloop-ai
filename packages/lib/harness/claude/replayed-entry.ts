/**
 * @file replayed-entry.ts
 * @description FEA-3453 — the single test for "this transcript line is a
 * resume/compaction REPLAY of one already seen".
 *
 * On resume or compaction Claude Code re-writes earlier transcript entries
 * VERBATIM — same `uuid`, same `timestamp` — into the continued log. Without a
 * de-duplication every replayed `user`/`assistant` entry pushes a second
 * `NormalizedMessage` (and re-counts its tool uses), so the shared
 * session-detail trace renders the same turn twice and every derived aggregate
 * inflates by the replayed span.
 *
 * Extracted from `parse-claude.ts` (ISS-5426) so the desktop's SIDECAR lane —
 * which streams `subagents/agent-*.jsonl` outside the core parser and therefore
 * never saw this filter — applies the SAME rule rather than a second copy of
 * it. A sidecar transcript is replayed on resume/compaction exactly like its
 * parent, so a replayed sub-agent `Edit` was contributing its lines twice to
 * the ISS-5402 `diffStats` fold.
 *
 * Because a replayed entry is byte-identical to its first occurrence (`uuid` is
 * unique per LINE within a live session — one API turn spans many lines with
 * the SAME `message.id` but DISTINCT `uuid`s, see FEA-1459), the whole entry is
 * skipped once its `uuid` has been seen. Mirrors the FEA-1459 usage-dedup
 * pattern. Entries with no `uuid` are never deduped (they are processed
 * normally), so distinct uuid-less turns are preserved.
 */

/**
 * Whether `entry` repeats a `uuid` already recorded in `seenEntryUuids`, marking
 * the uuid as seen when it does not. Call it BEFORE any accumulation, so a
 * replayed line contributes to no aggregate at all.
 *
 * The caller owns the set, which scopes the dedup to one transcript file: the
 * parent lane keys it off its session accumulator, and the sidecar lane creates
 * one per sidecar file.
 */
export function isReplayedTranscriptEntry(
  seenEntryUuids: Set<string>,
  entry: Record<string, unknown>
): boolean {
  const uuid =
    typeof entry.uuid === "string" && entry.uuid.length > 0 ? entry.uuid : null;
  if (!uuid) {
    return false;
  }
  if (seenEntryUuids.has(uuid)) {
    return true;
  }
  seenEntryUuids.add(uuid);
  return false;
}
