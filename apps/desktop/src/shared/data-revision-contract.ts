/**
 * @file data-revision-contract.ts
 * @description The node-free `data_revision` vocabulary shared across process
 * boundaries. The sentinel VALUES themselves (`DATA_REVISION_IMPORT_PENDING =
 * -1`, `DATA_REVISION_MAINTENANCE_STALE = 0`) live with their producer in
 * `main/collectors/engine/data-revision.ts`; this module carries only the
 * boundary both sides of the sync lane compare against, because the eager
 * main-process boot path (agent-sync dispositions) may not statically reach
 * `main/collectors/` or `main/database/` (dependency-cruiser
 * `boot-no-design-system-runtime`).
 *
 * ISS-8271: the floor of every REAL (sealed) revision this app has ever
 * stamped — the column DEFAULT is 1 and `DATA_REVISION` only increases, so
 * `data_revision >= MIN_REAL_DATA_REVISION` is exactly "not a sentinel". The
 * sync lane's sentinel hold-back (`deferSentinelRevisionCandidates`) and the
 * dead-letter redrive (`sqliteSelectRedrivableSessionDeadLetters`) both compare
 * against this ONE symbol, the first through the shared
 * {@link isSealedDataRevision} below; a future sentinel value or floor change
 * must not require hunting bare `1` literals across modules.
 */
export const MIN_REAL_DATA_REVISION = 1 as const;

/**
 * ISS-8612: is this session's revision a REAL (sealed) one, i.e. safe to put on
 * a wire payload? The canonical predicate, here rather than at each call site,
 * because the two producers of the session-sync envelope must not drift on the
 * `null` arm: the local column is NOT NULL with DEFAULT 1, so an ABSENT value is
 * a minimal/legacy payload shape and not a sentinel, and a guard that read it as
 * one would strand every legacy shape instead of the mid-derivation rows it is
 * for.
 */
export function isSealedDataRevision(
  revision: number | null | undefined
): boolean {
  return revision == null || revision >= MIN_REAL_DATA_REVISION;
}
